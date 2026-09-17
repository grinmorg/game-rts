import { FP_SHIFT } from './fixed';

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
  /**
   * Per team buffer: which update last stamped a circle from each cell, and how wide it was. An army standing
   * shoulder to shoulder puts dozens of units on one cell, and their circles are identical - the first one is
   * painted and the rest are waved through.
   */
  private readonly stampSeq: Int32Array[] = [];
  private readonly stampRad: Uint8Array[] = [];
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
        this.stampSeq.push(new Int32Array(w * h));
        this.stampRad.push(new Uint8Array(w * h));
      }
      this.bufOf.push(bi);
      this.vis.push(this.buffers[bi]);
    }
  }

  beginUpdate(): void {
    this.seq++;
    for (const v of this.buffers) {
      for (let i = 0; i < v.length; i++) if (v[i] === FOG_VISIBLE) v[i] = FOG_EXPLORED;
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
    const key = cy * w + cx;
    const sq = this.stampSeq[bi], sr = this.stampRad[bi];
    // an identical or wider circle was already painted from this cell this update
    if (sq[key] === this.seq && sr[key] >= radius) return;
    sq[key] = this.seq; sr[key] = radius < 255 ? radius : 255;
    const v = this.buffers[bi];
    const c = circle(radius);
    for (let i = 0; i < c.length; i += 2) {
      const px = cx + c[i], py = cy + c[i + 1];
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      v[py * w + px] = FOG_VISIBLE;
    }
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
  /** the whole map visible to the player's team */
  reveal(player: number): void { this.vis[player].fill(FOG_VISIBLE); this.revision++; }
}
