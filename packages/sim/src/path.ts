import { FP_ONE, FP_SHIFT } from './fixed';
import { MapData, isPassableTile } from './map';

export const UNREACHABLE = 0x7fffffff;
const COST_STRAIGHT = 10;
const COST_DIAG = 14;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export interface FlowField {
  dest: number;
  version: number;
  dist: Int32Array;
  lastUsed: number;
}

/** Binary min-heap on (cost, cell) pairs packed in two arrays. */
class Heap {
  cost: number[] = [];
  cell: number[] = [];
  get size() { return this.cost.length; }
  push(c: number, cell: number) {
    this.cost.push(c); this.cell.push(cell);
    let i = this.cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] < this.cost[i] || (this.cost[p] === this.cost[i] && this.cell[p] <= this.cell[i])) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.cell[0];
    const lc = this.cost.pop()!, lcell = this.cell.pop()!;
    if (this.cost.length > 0) {
      this.cost[0] = lc; this.cell[0] = lcell;
      let i = 0; const n = this.cost.length;
      for (;;) {
        let l = i * 2 + 1, r = l + 1, m = i;
        if (l < n && (this.cost[l] < this.cost[m] || (this.cost[l] === this.cost[m] && this.cell[l] < this.cell[m]))) m = l;
        if (r < n && (this.cost[r] < this.cost[m] || (this.cost[r] === this.cost[m] && this.cell[r] < this.cell[m]))) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    const tc = this.cost[a]; this.cost[a] = this.cost[b]; this.cost[b] = tc;
    const tl = this.cell[a]; this.cell[a] = this.cell[b]; this.cell[b] = tl;
  }
  clear() { this.cost.length = 0; this.cell.length = 0; }
}

export class Pathfinder {
  readonly w: number;
  readonly h: number;
  /** 0 passable, 1 static blocked, 2 dynamic blocked (building/mine) */
  blocked: Uint8Array;
  version = 1;
  private fields = new Map<number, FlowField>();
  private heap = new Heap();
  private useCounter = 0;
  readonly maxFields: number;
  /** BFS budget per tick */
  budgetPerTick = 6;
  usedThisTick = 0;

  constructor(map: MapData, maxFields = 64) {
    this.w = map.w; this.h = map.h;
    this.blocked = new Uint8Array(map.w * map.h);
    for (let i = 0; i < this.blocked.length; i++) this.blocked[i] = isPassableTile(map.tiles[i]) ? 0 : 1;
    this.maxFields = maxFields;
  }

  beginTick() { this.usedThisTick = 0; }

  inBounds(cx: number, cy: number): boolean { return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h; }
  isBlockedCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return true;
    return this.blocked[cy * this.w + cx] !== 0;
  }
  isBlockedFP(x: number, y: number): boolean { return this.isBlockedCell(x >> FP_SHIFT, y >> FP_SHIFT); }

  /** Mark a footprint as dynamically blocked/unblocked (buildings, mines). */
  setFootprint(cx0: number, cy0: number, size: number, block: boolean): void {
    for (let y = cy0; y < cy0 + size; y++) for (let x = cx0; x < cx0 + size; x++) {
      if (!this.inBounds(x, y)) continue;
      const i = y * this.w + x;
      if (block) { if (this.blocked[i] === 0) this.blocked[i] = 2; }
      else if (this.blocked[i] === 2) this.blocked[i] = 0;
    }
    this.version++;
  }
  footprintFree(cx0: number, cy0: number, size: number): boolean {
    for (let y = cy0; y < cy0 + size; y++) for (let x = cx0; x < cx0 + size; x++) {
      if (!this.inBounds(x, y) || this.blocked[y * this.w + x] !== 0) return false;
    }
    return true;
  }

  /**
   * Get (or compute) the flow field towards a destination cell. Returns null if the
   * per-tick BFS budget is exhausted (caller falls back to direct steering).
   */
  getField(destCx: number, destCy: number, force = false): FlowField | null {
    if (destCx < 0) destCx = 0; if (destCy < 0) destCy = 0;
    if (destCx >= this.w) destCx = this.w - 1; if (destCy >= this.h) destCy = this.h - 1;
    const dest = destCy * this.w + destCx;
    let f = this.fields.get(dest);
    if (f && f.version === this.version) { f.lastUsed = ++this.useCounter; return f; }
    if (!force && this.usedThisTick >= this.budgetPerTick) return null;
    this.usedThisTick++;
    if (!f) {
      if (this.fields.size >= this.maxFields) this.evict();
      f = { dest, version: this.version, dist: new Int32Array(this.w * this.h), lastUsed: 0 };
      this.fields.set(dest, f);
    }
    f.version = this.version;
    f.lastUsed = ++this.useCounter;
    this.computeField(f, destCx, destCy);
    return f;
  }

  private evict() {
    let oldest: FlowField | null = null;
    for (const f of this.fields.values()) if (!oldest || f.lastUsed < oldest.lastUsed) oldest = f;
    if (oldest) this.fields.delete(oldest.dest);
  }

  private computeField(f: FlowField, dcx: number, dcy: number) {
    const w = this.w, h = this.h, dist = f.dist, blocked = this.blocked;
    dist.fill(UNREACHABLE);
    const heap = this.heap; heap.clear();
    const destBlocked = blocked[dcy * w + dcx] !== 0;
    if (!destBlocked) {
      dist[dcy * w + dcx] = 0; heap.push(0, dcy * w + dcx);
    } else {
      // Destination inside an obstacle (building/mine): flood out from it through blocked
      // cells of the same footprint region up to radius 2, seeding passable neighbours.
      // Simple approach: seed all passable cells within Chebyshev distance <= 3 that are adjacent to a blocked cell,
      // with cost proportional to distance from dest.
      for (let y = dcy - 3; y <= dcy + 3; y++) for (let x = dcx - 3; x <= dcx + 3; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (blocked[y * w + x] !== 0) continue;
        const dd = Math.max(Math.abs(x - dcx), Math.abs(y - dcy)) * COST_STRAIGHT;
        if (dd < dist[y * w + x]) { dist[y * w + x] = dd; heap.push(dd, y * w + x); }
      }
      if (heap.size === 0) { dist[dcy * w + dcx] = 0; heap.push(0, dcy * w + dcx); }
    }
    while (heap.size > 0) {
      const c = heap.pop();
      const cd = dist[c];
      const cx = c % w, cy = (c - cx) / w;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (blocked[n] !== 0) continue;
        if (k >= 4) {
          // no corner cutting through blocked cells
          if (blocked[cy * w + nx] !== 0 || blocked[ny * w + cx] !== 0) continue;
        }
        const nd = cd + (k < 4 ? COST_STRAIGHT : COST_DIAG);
        if (nd < dist[n]) { dist[n] = nd; heap.push(nd, n); }
      }
    }
  }

  /**
   * Pick the neighbour (or current) cell with lowest distance. Returns packed (dx+1)*3+(dy+1) or -1 if at dest/unreachable.
   */
  flowStep(f: FlowField, cx: number, cy: number): number {
    const w = this.w, h = this.h, dist = f.dist;
    const here = dist[cy * w + cx];
    let best = here, bk = -1;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (k >= 4 && (this.blocked[cy * w + nx] !== 0 || this.blocked[ny * w + cx] !== 0)) continue;
      const d = dist[ny * w + nx];
      if (d < best) { best = d; bk = k; }
    }
    if (bk < 0) return -1;
    return bk;
  }
  stepDX(k: number) { return DX[k]; }
  stepDY(k: number) { return DY[k]; }

  /** Straight line free of blocked cells (Bresenham on cell grid). */
  lineFree(x0: number, y0: number, x1: number, y1: number): boolean {
    let cx = x0 >> FP_SHIFT, cy = y0 >> FP_SHIFT;
    const tx = x1 >> FP_SHIFT, ty = y1 >> FP_SHIFT;
    const dx = Math.abs(tx - cx), dy = Math.abs(ty - cy);
    const sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1;
    let err = dx - dy;
    let guard = dx + dy + 2;
    while (guard-- > 0) {
      if (this.isBlockedCell(cx, cy)) return false;
      if (cx === tx && cy === ty) return true;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
    return true;
  }

  /** Is cell b reachable from cell a? Uses a forced flow field (counts against nothing). */
  reachable(ax: number, ay: number, bx: number, by: number): boolean {
    const f = this.getField(bx, by, true);
    if (!f) return false;
    return f.dist[ay * this.w + ax] !== UNREACHABLE;
  }

  /** Find nearest passable cell to (cx,cy) within radius r (deterministic spiral). */
  nearestFree(cx: number, cy: number, r = 6): number {
    if (!this.isBlockedCell(cx, cy)) return cy * this.w + cx;
    for (let d = 1; d <= r; d++) {
      for (let y = cy - d; y <= cy + d; y++) for (let x = cx - d; x <= cx + d; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== d) continue;
        if (!this.isBlockedCell(x, y)) return y * this.w + x;
      }
    }
    return -1;
  }
}

export const CELL_FP = FP_ONE;
