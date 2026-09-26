import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BattleMoment, CUSTOM_MAP_MAX_CHARS, Command, GAME_SPEEDS, HASH_INTERVAL, MAX_PLAYERS, MatchSummary, PlayerSetup, ReplayData, SIM_VERSION,
  SUMMARY_METRICS, SUMMARY_VERSION, SummaryTotals, decodeCustomSource, isCustomMapId,
} from '@rookfall/sim';

/** what the replay list and link previews need, kept in memory so neither has to open a file */
export interface ReplayMeta {
  id: string;
  mapId: string;
  mapName?: string;
  players: string[];
  ticks: number;
  winnerTeam: number;
  recordedAt: number;
  speed?: number;
  /** simulation version it was recorded on: a different one no longer plays it back */
  version: number;
  /** the biggest battles, for the text of a link preview */
  battles: { start: number; deaths: number }[];
  /** a skirmish uploaded for a link: reachable by id, never listed */
  unlisted?: boolean;
  /** same match, same key: an upload of a replay the server already has returns the one it has */
  key: string;
  savedAt: number;
}

/** the biggest replay a browser may upload: a six-player hour is well under a megabyte */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** three hours of match; longer is not a real recording */
const MAX_TICKS = 20 * 60 * 180;
const MAX_COMMANDS_PER_TICK = 400;
const NAME_MAX = 32;
/** uploaded skirmishes kept on disk; past this the oldest go first (matches played online are never evicted) */
export const MAX_UPLOADS = 5000;

export type UploadError = 'invalid' | 'tooBig';

/**
 * Replays on disk (`data/replays/<id>.json`) with an in-memory index. Online matches are saved by the
 * lobby and listed; skirmishes arrive by upload when a player shares one and stay unlisted - the link is
 * the only way to them.
 */
export class ReplayStore {
  private readonly index = new Map<string, ReplayMeta>();
  private readonly byKey = new Map<string, string>();

  constructor(private readonly dir: string, private readonly maxUploads = MAX_UPLOADS) {
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const file = join(dir, f);
        const d = JSON.parse(readFileSync(file, 'utf8')) as ReplayData & { unlisted?: boolean };
        this.remember(d.id ?? f.slice(0, -5), d, !!d.unlisted, statSync(file).mtimeMs);
      } catch { /* a broken file is skipped, not fatal */ }
    }
    if (this.index.size) console.log(`[replay] indexed ${this.index.size} replays in ${Date.now() - t0} ms`);
  }

  get size(): number { return this.index.size; }
  meta(id: string): ReplayMeta | undefined { return this.index.get(cleanId(id)); }

  /** the newest listed replays */
  list(limit = 100): Omit<ReplayMeta, 'key' | 'savedAt' | 'unlisted'>[] {
    return [...this.index.values()].filter((m) => !m.unlisted).sort((a, b) => b.recordedAt - a.recordedAt).slice(0, limit)
      .map(({ key: _k, savedAt: _s, unlisted: _u, ...m }) => m);
  }

  /** the file itself, as served */
  read(id: string): Buffer | null {
    const m = this.meta(id);
    const file = m && join(this.dir, `${m.id}.json`);
    return file && existsSync(file) ? readFileSync(file) : null;
  }

  /** a finished online match */
  save(replay: ReplayData): string {
    return this.write(replay, false);
  }

  /** a replay a browser sent in to share; returns the id to link to */
  upload(body: string): { id: string } | { error: UploadError } {
    if (body.length > UPLOAD_MAX_BYTES) return { error: 'tooBig' };
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { return { error: 'invalid' }; }
    const replay = sanitizeReplay(raw);
    if (!replay) return { error: 'invalid' };
    const known = this.byKey.get(replayKey(replay));
    if (known) return { id: known };
    const id = this.write(replay, true);
    this.evictUploads();
    return { id };
  }

  private write(replay: ReplayData, unlisted: boolean): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const out: ReplayData & { unlisted?: boolean } = { ...replay, id };
    if (unlisted) out.unlisted = true;
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(out));
    this.remember(id, out, unlisted, Date.now());
    console.log(`[replay] saved ${id} (${replay.tickCount} ticks${unlisted ? ', uploaded' : ''})`);
    return id;
  }

  private remember(id: string, d: ReplayData, unlisted: boolean, savedAt: number): void {
    const key = replayKey(d);
    const speed = d.setup.speed;
    this.index.set(id, {
      id, mapId: d.setup.mapId, mapName: d.mapName, players: d.setup.players.map((p) => p.name), ticks: d.tickCount,
      winnerTeam: d.result?.winnerTeam ?? -1, recordedAt: d.recordedAt, speed, version: d.version,
      battles: (d.summary?.battles ?? []).map((b) => ({ start: b.start, deaths: b.deaths })),
      unlisted: unlisted || undefined, key, savedAt,
    });
    if (!this.byKey.has(key)) this.byKey.set(key, id);
  }

  private evictUploads(): void {
    const uploads = [...this.index.values()].filter((m) => m.unlisted);
    if (uploads.length <= this.maxUploads) return;
    uploads.sort((a, b) => a.savedAt - b.savedAt);
    for (const m of uploads.slice(0, uploads.length - this.maxUploads)) {
      try { unlinkSync(join(this.dir, `${m.id}.json`)); } catch { /* already gone */ }
      this.index.delete(m.id);
      if (this.byKey.get(m.key) === m.id) this.byKey.delete(m.key);
    }
  }
}

export function cleanId(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, '').slice(0, 40);
}

/** one match, one key: the setup and every command, so a copy recorded by a player's tab matches the server's own */
function replayKey(d: ReplayData): string {
  return createHash('sha1').update(JSON.stringify([d.setup.seed, d.setup.mapId, d.setup.players.map((p) => [p.slot, p.team, p.isBot]), d.tickCount, d.frames])).digest('hex').slice(0, 20);
}

// ------------------------------------------------------------------ upload validation

const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const I32 = 0x7fffffff;
function text(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * Rebuild an uploaded replay from the fields a replay has, each checked for type and range - nothing the
 * browser sent is stored as it came. A summary that does not hold together is dropped rather than failing
 * the upload: the commands are the replay, the summary only describes it.
 */
export function sanitizeReplay(raw: unknown): ReplayData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!int(r.version, 1, SIM_VERSION) || !int(r.tickCount, 1, MAX_TICKS)) return null;
  const tickCount = r.tickCount;
  const s = r.setup as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object' || !int(s.seed, -I32 - 1, I32) || typeof s.mapId !== 'string' || !/^[a-z0-9:-]{1,40}$/.test(s.mapId)) return null;
  if (!Array.isArray(s.players) || s.players.length < 2 || s.players.length > MAX_PLAYERS) return null;
  const players: PlayerSetup[] = [];
  for (const p of s.players as Record<string, unknown>[]) {
    if (!p || !int(p.slot, 0, MAX_PLAYERS - 1) || !int(p.team, 0, MAX_PLAYERS - 1) || !int(p.color, 0, 0xffffff)) return null;
    const ps: PlayerSetup = { slot: p.slot, team: p.team, name: text(p.name, NAME_MAX) || `P${p.slot + 1}`, isBot: p.isBot === true, color: p.color };
    if (p.difficulty === 0 || p.difficulty === 1 || p.difficulty === 2) ps.difficulty = p.difficulty;
    players.push(ps);
  }
  const setup: ReplayData['setup'] = { seed: s.seed, mapId: s.mapId, players, version: int(s.version, 0, 1_000_000) ? s.version : r.version };
  if (typeof s.speed === 'number' && GAME_SPEEDS.includes(s.speed)) setup.speed = s.speed;
  // a match on a player-made map carries the map: without it (or with a broken one) the replay cannot play back
  if (s.map != null || isCustomMapId(s.mapId)) {
    if (typeof s.map !== 'string' || s.map.length > CUSTOM_MAP_MAX_CHARS || !decodeCustomSource(s.map)) return null;
    setup.map = s.map;
  }

  if (!Array.isArray(r.frames) || r.frames.length > tickCount) return null;
  const frames: ReplayData['frames'] = [];
  let last = 0;
  for (const f of r.frames as Record<string, unknown>[]) {
    if (!f || !int(f.t, last, tickCount) || !Array.isArray(f.c) || f.c.length > MAX_COMMANDS_PER_TICK) return null;
    const c: Command[] = [];
    for (const x of f.c as Record<string, unknown>[]) {
      const cmd = sanitizeCommand(x);
      if (!cmd) return null;
      c.push(cmd);
    }
    frames.push({ t: f.t, c });
    last = f.t;
  }
  if (!Array.isArray(r.hashes) || r.hashes.length > tickCount / HASH_INTERVAL + 2) return null;
  const hashes: [number, number][] = [];
  for (const h of r.hashes as unknown[]) {
    if (!Array.isArray(h) || !int(h[0], 0, tickCount) || !int(h[1], 0, 0xffffffff)) return null;
    hashes.push([h[0], h[1]]);
  }
  const out: ReplayData = { version: r.version, setup, frames, tickCount, hashes, recordedAt: Date.now() };
  const now = Date.now();
  if (num(r.recordedAt, Date.UTC(2024, 0, 1), now + 86_400_000)) out.recordedAt = r.recordedAt;
  const res = r.result as Record<string, unknown> | undefined;
  if (res && int(res.winnerTeam, -1, MAX_PLAYERS - 1) && int(res.endedAtTick, 0, tickCount)) out.result = { winnerTeam: res.winnerTeam, endedAtTick: res.endedAtTick };
  if (typeof r.mapName === 'string') out.mapName = text(r.mapName, 60);
  const summary = sanitizeSummary(r.summary, players.length, tickCount);
  if (summary) out.summary = summary;
  return out;
}

function sanitizeCommand(x: Record<string, unknown>): Command | null {
  if (!x || !int(x.type, 1, 64) || !int(x.player, -1, MAX_PLAYERS - 1)) return null;
  const c: Command = { type: x.type, player: x.player };
  if (x.ids !== undefined) {
    if (!Array.isArray(x.ids) || x.ids.length > 200 || !x.ids.every((id) => int(id, 0, 1 << 20))) return null;
    c.ids = x.ids.slice() as number[];
  }
  for (const k of ['target', 'x', 'y', 'v'] as const) {
    if (x[k] === undefined) continue;
    if (!int(x[k], -I32 - 1, I32)) return null;
    c[k] = x[k] as number;
  }
  if (x.queue === true) c.queue = true;
  return c;
}

function sanitizeSummary(raw: unknown, players: number, tickCount: number): MatchSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (s.v !== SUMMARY_VERSION || !int(s.every, 1, MAX_TICKS) || !int(s.end, 0, tickCount)) return undefined;
  const samples = Math.floor(s.end / s.every) + 2;
  const series = {} as MatchSummary['series'];
  const src = s.series as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') return undefined;
  for (const m of SUMMARY_METRICS) {
    const rows = src[m];
    if (!Array.isArray(rows) || rows.length !== players) return undefined;
    series[m] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length > samples || !row.every((v) => num(v, 0, 1e9))) return undefined;
      series[m].push(row.slice() as number[]);
    }
  }
  const ticks = (a: unknown): a is number[] => Array.isArray(a) && a.length === players && a.every((v) => int(v, -1, tickCount));
  if (!ticks(s.ageUp) || !ticks(s.out)) return undefined;
  if (!Array.isArray(s.totals) || s.totals.length !== players) return undefined;
  const totals: SummaryTotals[] = [];
  for (const t of s.totals as Record<string, unknown>[]) {
    if (!t || ![t.trained, t.lost, t.killed, t.razed, t.mined].every((v) => int(v, 0, 1e9))) return undefined;
    totals.push({ trained: t.trained as number, lost: t.lost as number, killed: t.killed as number, razed: t.razed as number, mined: t.mined as number });
  }
  if (!Array.isArray(s.battles) || s.battles.length > 5) return undefined;
  const battles: BattleMoment[] = [];
  for (const b of s.battles as Record<string, unknown>[]) {
    if (!b || !int(b.start, 0, tickCount) || !int(b.end, 0, tickCount) || !num(b.x, 0, 1024) || !num(b.y, 0, 1024)
      || !int(b.value, 0, 1e9) || !int(b.deaths, 0, 1e6) || !Array.isArray(b.losses) || b.losses.length !== players || !b.losses.every((v) => int(v, 0, 1e6))) return undefined;
    battles.push({ start: b.start, end: b.end, x: b.x, y: b.y, value: b.value, deaths: b.deaths, losses: (b.losses as number[]).slice() });
  }
  return { v: SUMMARY_VERSION, every: s.every, end: s.end, series, ageUp: (s.ageUp as number[]).slice(), out: (s.out as number[]).slice(), totals, battles };
}
