import type { MatchSummary } from './summary';
import { Command, MatchSetup, SIM_VERSION } from './types';

/** Replay = seed + setup + commands per tick + version. */
export interface ReplayData {
  version: number;
  setup: MatchSetup;
  /** sparse: tick -> commands executed on that tick */
  frames: { t: number; c: Command[] }[];
  tickCount: number;
  /** hashes sampled every HASH_INTERVAL ticks for verification: [tick, hash] */
  hashes: [number, number][];
  result?: { winnerTeam: number; endedAtTick: number };
  recordedAt: number;
  mapName?: string;
  id?: string;
  /**
   * Charts and battles of the match, worked out while it was played. They are kept with the commands
   * because they stay readable after the simulation has moved on and the commands no longer replay.
   */
  summary?: MatchSummary;
}

/**
 * A replay plays back only on the simulation it was recorded with: any change to the rules makes the
 * same commands lead somewhere else. The version says so up front; the recorded hashes catch a change
 * that forgot to bump it (ReplayPlayer.expectedHash).
 */
export function replayPlayable(data: ReplayData): boolean {
  return data.version === SIM_VERSION;
}

export class ReplayRecorder {
  readonly data: ReplayData;
  constructor(setup: MatchSetup, mapName?: string) {
    this.data = { version: SIM_VERSION, setup, frames: [], tickCount: 0, hashes: [], recordedAt: 0, mapName };
  }
  record(tick: number, commands: readonly Command[]): void {
    if (commands.length > 0) this.data.frames.push({ t: tick, c: commands.map(compactCommand) });
    this.data.tickCount = tick;
  }
  hash(tick: number, hash: number): void {
    this.data.hashes.push([tick, hash]);
  }
  finish(winnerTeam: number, endedAtTick: number, now: number): ReplayData {
    this.data.result = { winnerTeam, endedAtTick };
    this.data.recordedAt = now;
    this.data.tickCount = endedAtTick;
    return this.data;
  }
}

function compactCommand(c: Command): Command {
  const o: Command = { type: c.type, player: c.player };
  if (c.ids && c.ids.length) o.ids = c.ids.slice();
  if (c.target !== undefined && c.target >= 0) o.target = c.target;
  if (c.x !== undefined) o.x = c.x;
  if (c.y !== undefined) o.y = c.y;
  if (c.v !== undefined) o.v = c.v;
  if (c.queue) o.queue = true;
  return o;
}

/** Iterate replay frames in tick order. */
export class ReplayPlayer {
  private idx = 0;
  private hashIdx = 0;
  constructor(readonly data: ReplayData) {}
  /** the state hash recorded for `tick`, if the recording sampled one there (ticks asked for in order) */
  expectedHash(tick: number): number | undefined {
    const hs = this.data.hashes;
    while (this.hashIdx < hs.length && hs[this.hashIdx][0] < tick) this.hashIdx++;
    return this.hashIdx < hs.length && hs[this.hashIdx][0] === tick ? hs[this.hashIdx][1] : undefined;
  }
  commandsFor(tick: number): Command[] {
    const frames = this.data.frames;
    const out: Command[] = [];
    while (this.idx < frames.length && frames[this.idx].t < tick) this.idx++;
    while (this.idx < frames.length && frames[this.idx].t === tick) { out.push(...frames[this.idx].c); this.idx++; }
    return out;
  }
  get finished(): boolean { return false; }
  reset() { this.idx = 0; this.hashIdx = 0; }
  /** the simulation now stands at `tick` (a snapshot was put back): the next commands and hashes asked for are the ones after it */
  seek(tick: number): void {
    const after = <T>(list: T[], at: (x: T) => number) => {
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (at(list[mid]) <= tick) lo = mid + 1; else hi = mid; }
      return lo;
    };
    this.idx = after(this.data.frames, (f) => f.t);
    this.hashIdx = after(this.data.hashes, (h) => h[0]);
  }
}
