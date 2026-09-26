import { FP_SHIFT } from './fixed';

export interface FogSnapshot {
  seq: number;
  /** per team buffer: the bytes, the cells the last update lit, whether reveal() lit it */
  buffers: Uint8Array[];
  lit: Int32Array[];
  sweep: boolean[];
}

export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1;
export const FOG_VISIBLE = 2;

/** Precomputed circle offsets per integer radius */
const circleCache = new Map<number, Int16Array>();
function circle(r: number): Int16Array {
  let c = circleCache.get(r);
  if (c) return c;
  const pts: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy <= r * r + r) pts.push(dx, dy);
  }
  c = Int16Array.from(pts);
  circleCache.set(r, c);
  return c;
}

/**
 * Fog maps. vis[p] holds w*h bytes: 0 unexplored, 1 explored, 2 visible. Vision is shared within a team, so all
 * players of one team point at the same buffer: a stamp by any of them lands in it directly, and there is nothing
 * to merge afterwards (the old per-player maps plus an all-pairs max gave the very same bytes at O(players²) cost).
 *
 * An update costs what the units see, not teams × map area: every cell a stamp turns visible is listed, and the
 * next update dims exactly those. Anything that writes FOG_VISIBLE into `vis` other than `stamp` has to go through
 * `reveal`, or the cell stays lit for good.
 */
export class Fog {
  readonly w: number;
  readonly h: number;
  readonly vis: Uint8Array[];
  readonly playerCount: number;
  /** one entry per team buffer */
  private readonly buffers: Uint8Array[] = [];
  /** team buffer index per player */
  private readonly bufOf: number[] = [];
  /** per team buffer: the cells stamps turned visible since the last update began, and how many */
  private readonly lit: Int32Array[] = [];
  private readonly litLen: number[] = [];
  /** per team buffer: lit by `reveal`, not by stamps - the next update dims the whole buffer */
  private readonly sweep: boolean[] = [];
  /**
   * Which (update, team) last stamped a circle from each cell - `seq * teams + buffer` - and how wide it was. An army
   * standing shoulder to shoulder puts dozens of units on one cell, and their circles are identical: the first one
   * is painted and the rest are waved through. One array serves every team; two teams stamping from the same cell
   * in one update just paint a circle twice.
   */
  private readonly stampKey: Int32Array;
  private readonly stampRad: Uint8Array;
  private seq = 0;
  /** incremented every recompute so the view knows when to re-upload */
  revision = 0;

  constructor(w: number, h: number, teams: number[]) {
    this.w = w; this.h = h; this.playerCount = teams.length;
    this.vis = [];
    const byTeam = new Map<number, number>();
    for (let p = 0; p < teams.length; p++) {
      let bi = byTeam.get(teams[p]);
      if (bi === undefined) {
        bi = this.buffers.length;
        byTeam.set(teams[p], bi);
        this.buffers.push(new Uint8Array(w * h));
        this.lit.push(new Int32Array(256));
        this.litLen.push(0);
        this.sweep.push(false);
      }
      this.bufOf.push(bi);
      this.vis.push(this.buffers[bi]);
    }
    this.stampKey = new Int32Array(w * h).fill(-1);
    this.stampRad = new Uint8Array(w * h);
  }

  beginUpdate(): void {
    this.seq++;
    for (let bi = 0; bi < this.buffers.length; bi++) {
      const v = this.buffers[bi];
      if (this.sweep[bi]) {
        for (let i = 0; i < v.length; i++) if (v[i] === FOG_VISIBLE) v[i] = FOG_EXPLORED;
        this.sweep[bi] = false;
      } else {
        const lit = this.lit[bi];
        for (let i = 0, n = this.litLen[bi]; i < n; i++) if (v[lit[i]] === FOG_VISIBLE) v[lit[i]] = FOG_EXPLORED;
      }
      this.litLen[bi] = 0;
    }
  }
  /** all stamps of this update are in */
  endUpdate(): void { this.revision++; }

  /** stamp a vision circle at fixed position */
  stamp(player: number, x: number, y: number, radius: number): void {
    const w = this.w, h = this.h;
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
    const bi = this.bufOf[player];
    const at = cy * w + cx;
    const key = this.seq * this.buffers.length + bi;
    // an identical or wider circle was already painted from this cell this update
    if (this.stampKey[at] === key && this.stampRad[at] >= radius) return;
    this.stampKey[at] = key; this.stampRad[at] = radius < 255 ? radius : 255;
    const v = this.buffers[bi];
    const c = circle(radius);
    let lit = this.lit[bi], n = this.litLen[bi];
    // every cell this can light, listed or not, must fit
    if (n + (c.length >> 1) > lit.length) {
      const grown = new Int32Array(Math.max(lit.length * 2, n + (c.length >> 1)));
      grown.set(lit.subarray(0, n));
      this.lit[bi] = lit = grown;
    }
    for (let i = 0; i < c.length; i += 2) {
      const px = cx + c[i], py = cy + c[i + 1];
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const cell = py * w + px;
      if (v[cell] === FOG_VISIBLE) continue;
      v[cell] = FOG_VISIBLE;
      lit[n++] = cell;
    }
    this.litLen[bi] = n;
  }

  isVisible(player: number, x: number, y: number): boolean {
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    return this.vis[player][cy * this.w + cx] === FOG_VISIBLE;
  }
  isExplored(player: number, x: number, y: number): boolean {
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    return this.vis[player][cy * this.w + cx] !== FOG_UNEXPLORED;
  }
  // ---- a view's copy (see viewframe.ts): the buffers of the teams it looks through, and when they moved on
  /** the team buffer a player's vision lands in */
  bufferOf(player: number): number { return this.bufOf[player]; }
  copyBuffer(bi: number): Uint8Array { return this.buffers[bi].slice(); }
  setBuffer(bi: number, data: Uint8Array): void { this.buffers[bi].set(data); }

  snapshot(): FogSnapshot {
    return {
      seq: this.seq,
      buffers: this.buffers.map((b) => b.slice()),
      lit: this.lit.map((l, i) => l.slice(0, this.litLen[i])),
      sweep: this.sweep.slice(),
    };
  }
  /** into these very buffers (the view holds on to them); the stamp dedup starts over, it only saves repainting */
  restore(s: FogSnapshot): void {
    this.seq = s.seq;
    for (let bi = 0; bi < this.buffers.length; bi++) {
      this.buffers[bi].set(s.buffers[bi]);
      const src = s.lit[bi];
      if (this.lit[bi].length < src.length) this.lit[bi] = new Int32Array(Math.max(256, src.length));
      this.lit[bi].set(src);
      this.litLen[bi] = src.length;
      this.sweep[bi] = s.sweep[bi];
    }
    this.stampKey.fill(-1);
    this.revision++;
  }

  /** the whole map visible to the player's team */
  reveal(player: number): void { this.vis[player].fill(FOG_VISIBLE); this.sweep[this.bufOf[player]] = true; this.revision++; }
}
