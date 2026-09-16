import { FP_ONE, FP_SHIFT } from './fixed';
import { MapData, isPassableTile } from './map';

export const UNREACHABLE = 0x7fffffff;
const COST_STRAIGHT = 10;
const COST_DIAG = 14;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
/** a blocked destination (click on a forest, a pond, a building) flows toward the nearest passable ring within this many cells */
const DEST_SEED_RADIUS = 12;

export interface FlowField {
  dest: number;
  version: number;
  dist: Int32Array;
  lastUsed: number;
  /** computed on the dilated map (catapults) */
  heavy: boolean;
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
  /** 0 passable, 1 static blocked, 2 dynamic blocked (building/mine) - what ordinary units can walk */
  blocked: Uint8Array;
  /**
   * The same map dilated by one cell: a cell is blocked if it or any 4-neighbour is blocked. Catapults
   * path on this, so they cannot squeeze through one-cell gaps between buildings the way footmen can.
   */
  blockedHeavy: Uint8Array;
  private heavyVersion = -1;
  /** connected passable regions per layer, label per cell (-1 blocked); rebuilt lazily per version */
  private region: Int32Array;
  private regionVersion = -1;
  private regionHeavy: Int32Array;
  private regionHeavyVersion = -1;
  private regionQueue: Int32Array;
  version = 1;
  private fields = new Map<number, FlowField>();
  private heap = new Heap();
  private useCounter = 0;
  readonly maxFields: number;
  /** flow fields computed per tick before movers fall back to waiting */
  budgetPerTick = 12;
  usedThisTick = 0;

  constructor(map: MapData, maxFields = 128) {
    this.w = map.w; this.h = map.h;
    this.blocked = new Uint8Array(map.w * map.h);
    for (let i = 0; i < this.blocked.length; i++) this.blocked[i] = isPassableTile(map.tiles[i]) ? 0 : 1;
    this.blockedHeavy = new Uint8Array(map.w * map.h);
    this.region = new Int32Array(map.w * map.h);
    this.regionHeavy = new Int32Array(map.w * map.h);
    this.regionQueue = new Int32Array(map.w * map.h);
    this.maxFields = maxFields;
  }

  beginTick() { this.usedThisTick = 0; }

  /** the passability layer a unit uses */
  layer(heavy: boolean): Uint8Array {
    if (!heavy) return this.blocked;
    if (this.heavyVersion !== this.version) this.rebuildHeavy();
    return this.blockedHeavy;
  }
  private rebuildHeavy(): void {
    const w = this.w, h = this.h, b = this.blocked, out = this.blockedHeavy;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = (b[i] !== 0 || x === 0 || y === 0 || x === w - 1 || y === h - 1
        || b[i - 1] !== 0 || b[i + 1] !== 0 || b[i - w] !== 0 || b[i + w] !== 0) ? 1 : 0;
    }
    this.heavyVersion = this.version;
  }
  private rebuildRegions(heavy: boolean): void {
    const w = this.w, h = this.h, b = this.layer(heavy), r = heavy ? this.regionHeavy : this.region, q = this.regionQueue;
    r.fill(-1);
    let label = 0;
    for (let start = 0; start < w * h; start++) {
      if (b[start] !== 0 || r[start] !== -1) continue;
      let head = 0, tail = 0;
      q[tail++] = start; r[start] = label;
      while (head < tail) {
        const c = q[head++];
        const cx = c % w, cy = (c - cx) / w;
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX[k], ny = cy + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (b[n] !== 0 || r[n] !== -1) continue;
          r[n] = label; q[tail++] = n;
        }
      }
      label++;
    }
    if (heavy) this.regionHeavyVersion = this.version; else this.regionVersion = this.version;
  }
  private regions(heavy: boolean): Int32Array {
    if (heavy) { if (this.regionHeavyVersion !== this.version) this.rebuildRegions(true); return this.regionHeavy; }
    if (this.regionVersion !== this.version) this.rebuildRegions(false);
    return this.region;
  }
  /** region label of a passable cell, -1 for a blocked one */
  regionOf(cx: number, cy: number, heavy = false): number {
    if (!this.inBounds(cx, cy)) return -1;
    return this.regions(heavy)[cy * this.w + cx];
  }
  /**
   * The passable cell in the same region as (fromCx,fromCy) that lies closest to (toCx,toCy) - where a unit
   * ends up when its destination is across water, inside a forest or behind a wall. -1 if `from` is blocked.
   */
  nearestReachable(fromCx: number, fromCy: number, toCx: number, toCy: number, heavy = false): number {
    const r = this.regions(heavy);
    const reg = this.inBounds(fromCx, fromCy) ? r[fromCy * this.w + fromCx] : -1;
    if (reg < 0) return -1;
    const w = this.w, h = this.h;
    let best = -1, bestD = 0x7fffffff;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (r[y * w + x] !== reg) continue;
      const d = (x - toCx) * (x - toCx) + (y - toCy) * (y - toCy);
      if (d < bestD) { bestD = d; best = y * w + x; }
    }
    return best;
  }

  inBounds(cx: number, cy: number): boolean { return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h; }
  isBlockedCell(cx: number, cy: number, heavy = false): boolean {
    if (!this.inBounds(cx, cy)) return true;
    return this.layer(heavy)[cy * this.w + cx] !== 0;
  }
  isBlockedFP(x: number, y: number, heavy = false): boolean { return this.isBlockedCell(x >> FP_SHIFT, y >> FP_SHIFT, heavy); }

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
  getField(destCx: number, destCy: number, force = false, heavy = false): FlowField | null {
    if (destCx < 0) destCx = 0; if (destCy < 0) destCy = 0;
    if (destCx >= this.w) destCx = this.w - 1; if (destCy >= this.h) destCy = this.h - 1;
    const dest = destCy * this.w + destCx;
    const key = dest * 2 + (heavy ? 1 : 0);
    let f = this.fields.get(key);
    if (f && f.version === this.version) { f.lastUsed = ++this.useCounter; return f; }
    if (!force && this.usedThisTick >= this.budgetPerTick) return null;
    this.usedThisTick++;
    if (!f) {
      if (this.fields.size >= this.maxFields) this.evict();
      f = { dest, version: this.version, dist: new Int32Array(this.w * this.h), lastUsed: 0, heavy };
      this.fields.set(key, f);
    }
    f.version = this.version;
    f.lastUsed = ++this.useCounter;
    this.computeField(f, destCx, destCy);
    return f;
  }

  private evict() {
    let oldestKey = -1, oldest: FlowField | null = null;
    for (const [k, f] of this.fields) if (!oldest || f.lastUsed < oldest.lastUsed) { oldest = f; oldestKey = k; }
    if (oldestKey >= 0) this.fields.delete(oldestKey);
  }

  private computeField(f: FlowField, dcx: number, dcy: number) {
    const w = this.w, h = this.h, dist = f.dist, blocked = this.layer(f.heavy);
    dist.fill(UNREACHABLE);
    const heap = this.heap; heap.clear();
    const destBlocked = blocked[dcy * w + dcx] !== 0;
    if (!destBlocked) {
      dist[dcy * w + dcx] = 0; heap.push(0, dcy * w + dcx);
    } else {
      // Destination inside an obstacle (forest, pond, building): seed the nearest ring of passable cells
      // around it. Seed cost grows with the true distance to the target (sqrt is IEEE-exact, so this stays
      // deterministic), so a unit drifts along the ring to the point closest to what was clicked.
      for (let r = 1; r <= DEST_SEED_RADIUS && heap.size === 0; r++) {
        for (let y = dcy - r; y <= dcy + r; y++) for (let x = dcx - r; x <= dcx + r; x++) {
          if (Math.max(Math.abs(x - dcx), Math.abs(y - dcy)) !== r) continue;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (blocked[y * w + x] !== 0) continue;
          const ex = x - dcx, ey = y - dcy;
          const dd = Math.floor(Math.sqrt(ex * ex + ey * ey) * COST_STRAIGHT);
          if (dd < dist[y * w + x]) { dist[y * w + x] = dd; heap.push(dd, y * w + x); }
        }
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
    const w = this.w, h = this.h, dist = f.dist, blocked = this.layer(f.heavy);
    const here = dist[cy * w + cx];
    let best = here, bk = -1;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (k >= 4 && (blocked[cy * w + nx] !== 0 || blocked[ny * w + cx] !== 0)) continue;
      const d = dist[ny * w + nx];
      if (d < best) { best = d; bk = k; }
    }
    if (bk < 0) return -1;
    return bk;
  }
  stepDX(k: number) { return DX[k]; }
  stepDY(k: number) { return DY[k]; }

  /** Straight line free of blocked cells (Bresenham on cell grid). */
  lineFree(x0: number, y0: number, x1: number, y1: number, heavy = false): boolean {
    let cx = x0 >> FP_SHIFT, cy = y0 >> FP_SHIFT;
    const tx = x1 >> FP_SHIFT, ty = y1 >> FP_SHIFT;
    const dx = Math.abs(tx - cx), dy = Math.abs(ty - cy);
    const sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1;
    let err = dx - dy;
    let guard = dx + dy + 2;
    while (guard-- > 0) {
      if (this.isBlockedCell(cx, cy, heavy)) return false;
      if (cx === tx && cy === ty) return true;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
    return true;
  }

  /** Is cell b reachable from cell a? Uses a forced flow field (b may be a blocked footprint, see computeField). */
  reachable(ax: number, ay: number, bx: number, by: number, heavy = false): boolean {
    const f = this.getField(bx, by, true, heavy);
    if (!f) return false;
    return f.dist[ay * this.w + ax] !== UNREACHABLE;
  }

  /** Find nearest passable cell to (cx,cy) within radius r (deterministic spiral). */
  nearestFree(cx: number, cy: number, r = 6, heavy = false): number {
    if (!this.isBlockedCell(cx, cy, heavy)) return cy * this.w + cx;
    for (let d = 1; d <= r; d++) {
      for (let y = cy - d; y <= cy + d; y++) for (let x = cx - d; x <= cx + d; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== d) continue;
        if (!this.isBlockedCell(x, y, heavy)) return y * this.w + x;
      }
    }
    return -1;
  }
}

export const CELL_FP = FP_ONE;
