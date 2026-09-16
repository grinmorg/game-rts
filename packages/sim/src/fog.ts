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

/** Per-player fog maps. vis[p] holds w*h bytes: 0 unexplored, 1 explored, 2 visible. */
export class Fog {
  readonly w: number;
  readonly h: number;
  readonly vis: Uint8Array[];
  readonly playerCount: number;
  /** incremented every recompute so the view knows when to re-upload */
  revision = 0;

  constructor(w: number, h: number, playerCount: number) {
    this.w = w; this.h = h; this.playerCount = playerCount;
    this.vis = [];
    for (let p = 0; p < playerCount; p++) this.vis.push(new Uint8Array(w * h));
  }

  beginUpdate(): void {
    for (let p = 0; p < this.playerCount; p++) {
      const v = this.vis[p];
      for (let i = 0; i < v.length; i++) if (v[i] === FOG_VISIBLE) v[i] = FOG_EXPLORED;
    }
  }

  /** stamp a vision circle at fixed position */
  stamp(player: number, x: number, y: number, radius: number): void {
    const v = this.vis[player];
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
    const c = circle(radius);
    const w = this.w, h = this.h;
    for (let i = 0; i < c.length; i += 2) {
      const px = cx + c[i], py = cy + c[i + 1];
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      v[py * w + px] = FOG_VISIBLE;
    }
  }

  /** share vision among team members: each member's map becomes max over the team */
  shareTeams(teams: number[]): void {
    const n = this.playerCount;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      if (teams[a] !== teams[b]) continue;
      const va = this.vis[a], vb = this.vis[b];
      for (let i = 0; i < va.length; i++) {
        const m = va[i] > vb[i] ? va[i] : vb[i];
        va[i] = m; vb[i] = m;
      }
    }
    this.revision++;
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
  /** visible by any member of team */
  reveal(player: number): void { this.vis[player].fill(FOG_VISIBLE); this.revision++; }
}
