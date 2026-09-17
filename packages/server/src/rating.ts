import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LeaderboardEntry, PLACEMENT_GAMES, RANKED_START_RD, RankedProfile, emptyProfile, levelFromXp, xpForMatch,
} from '@rookfall/protocol';


/** Glicko-2 scale factor and the system constant (how fast volatility may move) */
const SCALE = 173.7178;
const TAU = 0.5;
/** one rating period = a week of inactivity; a profile's RD creeps back up towards the default over time */
const PERIOD_MS = 7 * 24 * 3600_000;

interface Glicko { rating: number; rd: number; vol: number }

function g(phi: number): number { return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI)); }

/**
 * One Glicko-2 update against a single opponent (one match = one rating period, the usual simplification
 * for a ladder that publishes the new rating right after the game).
 * `score` is 1 for a win, 0.5 for a draw, 0 for a loss.
 */
export function glickoUpdate(p: Glicko, opp: Glicko, score: number): Glicko {
  const mu = (p.rating - 1500) / SCALE, phi = p.rd / SCALE, sigma = p.vol;
  const muJ = (opp.rating - 1500) / SCALE, phiJ = opp.rd / SCALE;
  const gJ = g(phiJ);
  const e = 1 / (1 + Math.exp(-gJ * (mu - muJ)));
  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (score - e);

  // volatility: Illinois-flavoured regula falsi on f(x), exactly as in the Glicko-2 paper
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x), d2 = delta * delta, ph2 = phi * phi;
    return (ex * (d2 - ph2 - v - ex)) / (2 * (ph2 + v + ex) * (ph2 + v + ex)) - (x - a) / (TAU * TAU);
  };
  let A = a, B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * TAU) < 0 && k < 100) k++; B = a - k * TAU; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gJ * (score - e);
  return {
    rating: Math.round((muNew * SCALE + 1500) * 100) / 100,
    rd: Math.round(Math.min(RANKED_START_RD, phiNew * SCALE) * 100) / 100,
    vol: Math.round(sigmaNew * 1e6) / 1e6,
  };
}

/** RD creeps back towards the default while a player is away, so a returning veteran is placed faster */
export function decayRd(p: RankedProfile, now: number): number {
  const periods = Math.max(0, (now - p.updatedAt) / PERIOD_MS);
  if (periods < 0.02) return p.rd;
  const phi = p.rd / SCALE;
  return Math.min(RANKED_START_RD, Math.round(Math.sqrt(phi * phi + p.vol * p.vol * periods) * SCALE * 100) / 100);
}

export interface MatchOutcome {
  /** result from this profile's point of view */
  result: 'win' | 'loss' | 'draw';
  ratingBefore: number;
  xpGained: number;
  levelBefore: number;
  profile: RankedProfile;
}

/**
 * Ladder storage: profiles keyed by the client's private key (which never leaves the server) and written
 * to one JSON file. The ladder is small enough that a debounced full rewrite is cheaper than any database
 * we would have to run next to it - see TASKS.md on the light stack.
 */
export class RatingStore {
  private byKey = new Map<string, RankedProfile>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  /** `file` is null for an in-memory ladder (tests) */
  constructor(private file: string | null) { this.load(); }

  private load(): void {
    try {
      if (!this.file || !existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { profiles?: Record<string, RankedProfile> };
      for (const [k, p] of Object.entries(raw.profiles ?? {})) this.byKey.set(k, p);
      console.log(`[rating] loaded ${this.byKey.size} ladder profiles`);
    } catch (err) {
      console.error('[rating] could not read profiles, starting empty', err);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 2000);
  }

  flush(): void {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, profiles: Object.fromEntries(this.byKey) }));
      renameSync(tmp, this.file); // atomic: a crash mid-write never truncates the ladder
    } catch (err) {
      console.error('[rating] save failed', err);
    }
  }

  /** the profile behind a client key, created on first sight; the display name follows the client */
  profileFor(key: string, name: string): RankedProfile {
    let p = this.byKey.get(key);
    if (!p) {
      p = emptyProfile(publicId(), name);
      this.byKey.set(key, p);
      this.scheduleSave();
    } else if (name && p.name !== name) {
      p.name = name;
      this.scheduleSave();
    }
    return p;
  }

  get(key: string): RankedProfile | undefined { return this.byKey.get(key); }

  /**
   * Write one finished ladder match down for both sides. Ratings are computed against the opponent as
   * they were before the match, so the order the two updates are written in does not matter.
   */
  applyMatch(a: { key: string; name: string }, b: { key: string; name: string }, scoreA: number, ticks: number): { a: MatchOutcome; b: MatchOutcome } {
    const now = Date.now();
    const snapA = { ...this.profileFor(a.key, a.name) }, snapB = { ...this.profileFor(b.key, b.name) };
    snapA.rd = decayRd(snapA, now); snapB.rd = decayRd(snapB, now);
    const outA = this.applyOne(a.key, snapA, snapB, scoreA, ticks, now);
    const outB = this.applyOne(b.key, snapB, snapA, 1 - scoreA, ticks, now);
    this.scheduleSave();
    return { a: outA, b: outB };
  }

  private applyOne(key: string, self: RankedProfile, opp: RankedProfile, score: number, ticks: number, now: number): MatchOutcome {
    // re-read: identical to the snapshot in a normal match, and keeps the counters straight in the odd
    // case of somebody queuing against themselves from two tabs
    const p = this.byKey.get(key) ?? self;
    const result = score > 0.75 ? 'win' : score < 0.25 ? 'loss' : 'draw';
    const ratingBefore = p.rating;
    const levelBefore = levelFromXp(p.xp);
    const xpGained = xpForMatch(result, ticks);
    const next = glickoUpdate({ rating: p.rating, rd: self.rd, vol: p.vol }, { rating: opp.rating, rd: opp.rd, vol: opp.vol }, score);
    p.rating = next.rating; p.rd = next.rd; p.vol = next.vol;
    p.games++;
    if (result === 'win') { p.wins++; p.streak = p.streak > 0 ? p.streak + 1 : 1; }
    else if (result === 'loss') { p.losses++; p.streak = p.streak < 0 ? p.streak - 1 : -1; }
    else { p.draws++; p.streak = 0; }
    p.xp += xpGained;
    if (p.rating > p.best) p.best = p.rating;
    p.updatedAt = now;
    this.byKey.set(key, p);
    return { result, ratingBefore, xpGained, levelBefore, profile: p };
  }

  /** top of the ladder; profiles still in placement are left out so the board means something */
  top(n = 20): LeaderboardEntry[] {
    return [...this.byKey.values()]
      .filter((p) => p.games >= PLACEMENT_GAMES)
      .sort((a, b) => b.rating - a.rating || b.games - a.games)
      .slice(0, n)
      .map((p) => ({ id: p.id, name: p.name, rating: Math.round(p.rating), games: p.games, wins: p.wins, xp: p.xp }));
  }
}

function publicId(): string {
  return `p${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}
