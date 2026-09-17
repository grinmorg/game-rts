/**
 * Ladder types shared by the server and the client: the profile record, the rank tiers and the level
 * curve. Everything here is pure arithmetic so both sides show the same numbers - the Glicko-2 update
 * itself lives on the server (rating.ts), which is the only place ratings are ever written.
 */

/** the ladder is 1v1 on a freshly rolled 64x64 map */
export const RANKED_MAP_ID = 'random-duel';
/** speeds the ladder runs at: normal and turbo. Each is its own queue - both players must want the same. */
export const RANKED_SPEEDS = [1, 3] as const;
export type RankedSpeed = (typeof RANKED_SPEEDS)[number];

export const RANKED_START_RATING = 1500;
export const RANKED_START_RD = 350;
export const RANKED_START_VOL = 0.06;
/** games before a tier is shown; until then the profile is in placement */
export const PLACEMENT_GAMES = 5;

/**
 * One ladder profile. `id` is a public handle safe to show to other players - the secret key the client
 * keeps in localStorage is what the server looks the profile up by and it never leaves the server.
 */
export interface RankedProfile {
  id: string;
  name: string;
  /** Glicko-2 rating, shown as-is */
  rating: number;
  /** rating deviation: how unsure the ladder is about the rating */
  rd: number;
  /** Glicko-2 volatility */
  vol: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** positive = wins in a row, negative = losses in a row */
  streak: number;
  /** peak rating reached */
  best: number;
  xp: number;
  updatedAt: number;
}

export function emptyProfile(id: string, name: string): RankedProfile {
  return {
    id, name, rating: RANKED_START_RATING, rd: RANKED_START_RD, vol: RANKED_START_VOL,
    games: 0, wins: 0, losses: 0, draws: 0, streak: 0, best: RANKED_START_RATING, xp: 0, updatedAt: Date.now(),
  };
}

// ------------------------------------------------------------------ tiers

export interface RankTier {
  /** i18n key, also the css modifier */
  key: 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'master' | 'grandmaster';
  min: number;
  icon: string;
}

/** thresholds sit around the 1500 start, so a fresh account lands in the middle of the ladder */
export const RANK_TIERS: RankTier[] = [
  { key: 'bronze', min: 0, icon: '🥉' },
  { key: 'silver', min: 1300, icon: '🥈' },
  { key: 'gold', min: 1450, icon: '🥇' },
  { key: 'platinum', min: 1600, icon: '💠' },
  { key: 'diamond', min: 1750, icon: '💎' },
  { key: 'master', min: 1900, icon: '👑' },
  { key: 'grandmaster', min: 2100, icon: '🐉' },
];

export const UNRANKED_TIER: RankTier = { key: 'unranked', min: 0, icon: '❔' };

export function tierFor(rating: number, games = PLACEMENT_GAMES): RankTier {
  if (games < PLACEMENT_GAMES) return UNRANKED_TIER;
  let t = RANK_TIERS[0];
  for (const x of RANK_TIERS) if (rating >= x.min) t = x;
  return t;
}

/** how far into the current tier the rating sits (0..1); the top tier is always full */
export function tierProgress(rating: number): { tier: RankTier; next: RankTier | null; pct: number } {
  const tier = tierFor(rating);
  const i = RANK_TIERS.indexOf(tier);
  const next = i >= 0 && i < RANK_TIERS.length - 1 ? RANK_TIERS[i + 1] : null;
  const pct = next ? Math.max(0, Math.min(1, (rating - tier.min) / (next.min - tier.min))) : 1;
  return { tier, next, pct };
}

// ------------------------------------------------------------------ levels

/** total xp needed to reach a level: 0, 40, 120, 240, 400, 600 ... (quadratic, so it never plateaus) */
export function xpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return 20 * (n - 1) * n;
}

export function levelFromXp(xp: number): number {
  let level = 1;
  while (xp >= xpForLevel(level + 1) && level < 999) level++;
  return level;
}

export function levelProgress(xp: number): { level: number; into: number; need: number; pct: number } {
  const level = levelFromXp(xp);
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  const into = xp - base, need = next - base;
  return { level, into, need, pct: need > 0 ? into / need : 1 };
}

/** xp for one ladder match: a flat purse by result plus a minute of play, capped so long games do not farm */
export function xpForMatch(result: 'win' | 'loss' | 'draw', ticks: number): number {
  const base = result === 'win' ? 30 : result === 'draw' ? 18 : 12;
  return base + Math.min(12, Math.floor(ticks / (20 * 60)));
}

// ------------------------------------------------------------------ queue & results

export interface QueueState {
  speed: number;
  /** seconds spent in the queue */
  waiting: number;
  /** players queued at this speed, the caller included */
  size: number;
  /** current rating window the matchmaker will accept */
  range: number;
}

/** what the loser/winner sees on the results screen once the ladder has written the match down */
export interface RankedResult {
  result: 'win' | 'loss' | 'draw';
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  xpGained: number;
  levelBefore: number;
  profile: RankedProfile;
  opponent: { name: string; rating: number };
  /** true while the profile is still playing its placement games */
  placement: boolean;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  rating: number;
  games: number;
  wins: number;
  xp: number;
}
