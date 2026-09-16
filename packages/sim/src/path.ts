import { FP_ONE, FP_SHIFT } from './fixed';
import { MapData, isPassableTile } from './map';

export const UNREACHABLE = 0x7fffffff;
/**
 * The path grid is finer than the map: SUB×SUB "fine" cells per map cell. Two buildings placed flush leave a
 * seam one fine cell wide on each side (a whole map cell together) that footmen walk through; the heavy layer
 * (catapults) keeps the full footprints, so for them the seam does not exist.
 */
export const SUB = 2;
export const SUB_SHIFT = 1;
/** fixed-point coordinate → fine cell */
export const FINE_SHIFT = FP_SHIFT - SUB_SHIFT;
const FINE_HALF = FP_ONE >> (SUB_SHIFT + 1);
const COST_STRAIGHT = 10;
const COST_DIAG = 14;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
/** a blocked destination (click on a forest, a pond, a building) flows toward the nearest passable ring within this many fine cells */
const DEST_SEED_RADIUS = 12 * SUB;

export interface FlowField {
  /** destination map cell (coarse index) */
  dest: number;
  version: number;
  /** per fine cell */
  dist: Int32Array;
  lastUsed: number;
  /** computed on the heavy layer (catapults): full footprints, no seams */
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

/**
 * Flow-field pathfinder on a fine grid (see SUB). Two vocabularies are used in the API:
 *  - "cell" (cx, cy) = a map cell, what buildings, placement and destinations are expressed in;
 *  - "fine" (fx, fy) = a fine cell, what unit positions resolve to (`x >> FINE_SHIFT`) and what movement checks.
 */
export class Pathfinder {
  /** map size in cells */
  readonly mapW: number;
  readonly mapH: number;
  /** grid size in fine cells */
  readonly w: number;
  readonly h: number;
  /** per fine cell: 0 passable, 1 static blocked (terrain), 2 footprint - what ordinary units can walk (seams open) */
  blocked: Uint8Array;
  /** per fine cell: the same with full footprints - what catapults can walk */
  blockedHeavy: Uint8Array;
  /** per map cell: 1 if the terrain is impassable */
  private terrain: Uint8Array;
  /** per map cell: 0 free, otherwise a key identifying the building/mine standing there (id + 2) */
  private foot: Int32Array;
  /** per map cell: 1 if that footprint opens seams towards other seam-opening footprints (every building but a fence) */
  private seam: Uint8Array;
  /** connected passable regions per layer, label per fine cell (-1 blocked); rebuilt lazily per version */
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
    this.mapW = map.w; this.mapH = map.h;
    this.w = map.w * SUB; this.h = map.h * SUB;
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.blockedHeavy = new Uint8Array(n);
    this.terrain = new Uint8Array(map.w * map.h);
    this.foot = new Int32Array(map.w * map.h);
    this.seam = new Uint8Array(map.w * map.h);
    for (let i = 0; i < this.terrain.length; i++) this.terrain[i] = isPassableTile(map.tiles[i]) ? 0 : 1;
    this.refresh(0, 0, map.w, map.h);
    this.region = new Int32Array(n);
    this.regionHeavy = new Int32Array(n);
    this.regionQueue = new Int32Array(n);
    this.maxFields = maxFields;
  }

  beginTick() { this.usedThisTick = 0; }

  /** take every layer from another pathfinder over the same map (the renderer keeps its own copy) */
  copyFrom(o: Pathfinder): void {
    this.blocked.set(o.blocked); this.blockedHeavy.set(o.blockedHeavy);
    this.terrain.set(o.terrain); this.foot.set(o.foot); this.seam.set(o.seam);
    this.version = o.version;
  }

  /** the passability layer a unit uses */
  layer(heavy: boolean): Uint8Array { return heavy ? this.blockedHeavy : this.blocked; }

  // ------------------------------------------------------------------ static layers

  /** recompute the fine cells of a rectangle of map cells from terrain + footprints */
  private refresh(cx0: number, cy0: number, sw: number, sh: number): void {
    const mw = this.mapW, mh = this.mapH, w = this.w;
    const x0 = cx0 < 0 ? 0 : cx0, y0 = cy0 < 0 ? 0 : cy0;
    const x1 = cx0 + sw > mw ? mw : cx0 + sw, y1 = cy0 + sh > mh ? mh : cy0 + sh;
    for (let cy = y0; cy < y1; cy++) for (let cx = x0; cx < x1; cx++) {
      const c = cy * mw + cx;
      const f = this.foot[c];
      for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
        const fi = (cy * SUB + sy) * w + cx * SUB + sx;
        if (this.terrain[c] !== 0) { this.blocked[fi] = 1; this.blockedHeavy[fi] = 1; continue; }
        if (f === 0) { this.blocked[fi] = 0; this.blockedHeavy[fi] = 0; continue; }
        this.blockedHeavy[fi] = 2;
        // the outer half of a footprint cell opens when the map cell beyond it belongs to another seam-opening building
        let open = false;
        if (this.seam[c] !== 0) {
          const nx = sx === 0 ? cx - 1 : cx + 1;
          if (nx >= 0 && nx < mw) { const n = cy * mw + nx; if (this.foot[n] !== 0 && this.foot[n] !== f && this.seam[n] !== 0) open = true; }
          const ny = sy === 0 ? cy - 1 : cy + 1;
          if (!open && ny >= 0 && ny < mh) { const n = ny * mw + cx; if (this.foot[n] !== 0 && this.foot[n] !== f && this.seam[n] !== 0) open = true; }
        }
        this.blocked[fi] = open ? 0 : 2;
      }
    }
  }

  /** terrain of one map cell changed (forest burnt down) */
  setTerrain(cx: number, cy: number, passable: boolean): void {
    if (!this.inBounds(cx, cy)) return;
    this.terrain[cy * this.mapW + cx] = passable ? 0 : 1;
    this.refresh(cx, cy, 1, 1);
    this.version++;
  }

  /**
   * Mark a footprint as blocked/unblocked (buildings, mines). `id` identifies the building so two flush
   * footprints are told apart; `seams` says whether footmen may squeeze along its edge past another such building.
   */
  setFootprint(cx0: number, cy0: number, size: number, block: boolean, id = -1, seams = false): void {
    const key = id + 2;
    for (let y = cy0; y < cy0 + size; y++) for (let x = cx0; x < cx0 + size; x++) {
      if (!this.inBounds(x, y)) continue;
      const c = y * this.mapW + x;
      if (block) { this.foot[c] = key; this.seam[c] = seams ? 1 : 0; }
      else { this.foot[c] = 0; this.seam[c] = 0; }
    }
    // neighbours' seams depend on us, so refresh one cell further out
    this.refresh(cx0 - 1, cy0 - 1, size + 2, size + 2);
    this.version++;
  }
  /** is a building or mine standing on this map cell */
  isFootprint(cx: number, cy: number): boolean { return this.inBounds(cx, cy) && this.foot[cy * this.mapW + cx] !== 0; }
  /** every map cell of the footprint free of terrain obstacles and other footprints */
  footprintFree(cx0: number, cy0: number, size: number): boolean {
    for (let y = cy0; y < cy0 + size; y++) for (let x = cx0; x < cx0 + size; x++) {
      if (!this.inBounds(x, y)) return false;
      const c = y * this.mapW + x;
      if (this.terrain[c] !== 0 || this.foot[c] !== 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ queries

  inBounds(cx: number, cy: number): boolean { return cx >= 0 && cy >= 0 && cx < this.mapW && cy < this.mapH; }
  inBoundsFine(fx: number, fy: number): boolean { return fx >= 0 && fy >= 0 && fx < this.w && fy < this.h; }
  /** a map cell counts as blocked when any of its fine cells is */
  isBlockedCell(cx: number, cy: number, heavy = false): boolean {
    if (!this.inBounds(cx, cy)) return true;
    const b = this.layer(heavy), w = this.w;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) if (b[(cy * SUB + sy) * w + cx * SUB + sx] !== 0) return true;
    return false;
  }
  isBlockedFine(fx: number, fy: number, heavy = false): boolean {
    if (!this.inBoundsFine(fx, fy)) return true;
    return this.layer(heavy)[fy * this.w + fx] !== 0;
  }
  isBlockedFP(x: number, y: number, heavy = false): boolean { return this.isBlockedFine(x >> FINE_SHIFT, y >> FINE_SHIFT, heavy); }
  /** fixed-point centre of a fine cell coordinate */
  fineCenter(f: number): number { return (f << FINE_SHIFT) + FINE_HALF; }

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
  /** region label of a passable fine cell, -1 for a blocked one */
  regionOf(fx: number, fy: number, heavy = false): number {
    if (!this.inBoundsFine(fx, fy)) return -1;
    return this.regions(heavy)[fy * this.w + fx];
  }
  /**
   * The passable fine cell in the same region as (fromFx,fromFy) that lies closest to map cell (toCx,toCy) - where a
   * unit ends up when its destination is across water, inside a forest or behind a wall. -1 if `from` is blocked.
   */
  nearestReachable(fromFx: number, fromFy: number, toCx: number, toCy: number, heavy = false): number {
    const r = this.regions(heavy);
    const reg = this.inBoundsFine(fromFx, fromFy) ? r[fromFy * this.w + fromFx] : -1;
    if (reg < 0) return -1;
    const w = this.w, h = this.h;
    // doubled fine coordinates so that map-cell and fine-cell centres are both integers
    const tx2 = toCx * SUB * 2 + SUB, ty2 = toCy * SUB * 2 + SUB;
    let best = -1, bestD = 0x7fffffff;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (r[y * w + x] !== reg) continue;
      const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
      const d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = y * w + x; }
    }
    return best;
  }

  /**
   * Get (or compute) the flow field towards a destination map cell. Returns null if the
   * per-tick budget is exhausted (caller falls back to direct steering).
   */
  getField(destCx: number, destCy: number, force = false, heavy = false): FlowField | null {
    if (destCx < 0) destCx = 0; if (destCy < 0) destCy = 0;
    if (destCx >= this.mapW) destCx = this.mapW - 1; if (destCy >= this.mapH) destCy = this.mapH - 1;
    const dest = destCy * this.mapW + destCx;
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
    // every passable fine cell of the destination map cell is a goal
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      const i = (dcy * SUB + sy) * w + dcx * SUB + sx;
      if (blocked[i] === 0) { dist[i] = 0; heap.push(0, i); }
    }
    if (heap.size === 0) {
      // Destination inside an obstacle (forest, pond, building): seed the nearest ring of passable cells
      // around it. Seed cost grows with the true distance to the target (sqrt is IEEE-exact, so this stays
      // deterministic), so a unit drifts along the ring to the point closest to what was clicked.
      const cfx = dcx * SUB + (SUB >> 1), cfy = dcy * SUB + (SUB >> 1);
      const tx2 = dcx * SUB * 2 + SUB, ty2 = dcy * SUB * 2 + SUB;
      for (let r = 1; r <= DEST_SEED_RADIUS && heap.size === 0; r++) {
        for (let y = cfy - r; y <= cfy + r; y++) for (let x = cfx - r; x <= cfx + r; x++) {
          if (Math.max(Math.abs(x - cfx), Math.abs(y - cfy)) !== r) continue;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (blocked[y * w + x] !== 0) continue;
          const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
          const dd = Math.floor((Math.sqrt(ex * ex + ey * ey) * COST_STRAIGHT) / 2);
          if (dd < dist[y * w + x]) { dist[y * w + x] = dd; heap.push(dd, y * w + x); }
        }
      }
      if (heap.size === 0) { const i = cfy * w + cfx; dist[i] = 0; heap.push(0, i); }
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
   * Pick the neighbouring fine cell with the lowest distance. Returns a step index for stepDX/stepDY, or -1 at the
   * destination / in a local minimum / unreachable.
   */
  flowStep(f: FlowField, fx: number, fy: number): number {
    const w = this.w, h = this.h, dist = f.dist, blocked = this.layer(f.heavy);
    const here = dist[fy * w + fx];
    let best = here, bk = -1;
    for (let k = 0; k < 8; k++) {
      const nx = fx + DX[k], ny = fy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (k >= 4 && (blocked[fy * w + nx] !== 0 || blocked[ny * w + fx] !== 0)) continue;
      const d = dist[ny * w + nx];
      if (d < best) { best = d; bk = k; }
    }
    if (bk < 0) return -1;
    return bk;
  }
  stepDX(k: number) { return DX[k]; }
  stepDY(k: number) { return DY[k]; }

  /** Straight line (fixed-point endpoints) free of blocked fine cells (Bresenham). */
  lineFree(x0: number, y0: number, x1: number, y1: number, heavy = false): boolean {
    let cx = x0 >> FINE_SHIFT, cy = y0 >> FINE_SHIFT;
    const tx = x1 >> FINE_SHIFT, ty = y1 >> FINE_SHIFT;
    const dx = Math.abs(tx - cx), dy = Math.abs(ty - cy);
    const sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1;
    let err = dx - dy;
    let guard = dx + dy + 2;
    while (guard-- > 0) {
      if (this.isBlockedFine(cx, cy, heavy)) return false;
      if (cx === tx && cy === ty) return true;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
    return true;
  }

  /** Can map cell b be reached from map cell a (from any of a's fine cells)? b may be a blocked footprint, see computeField. */
  reachable(ax: number, ay: number, bx: number, by: number, heavy = false): boolean {
    const f = this.getField(bx, by, true, heavy);
    if (!f) return false;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      if (f.dist[(ay * SUB + sy) * this.w + ax * SUB + sx] !== UNREACHABLE) return true;
    }
    return false;
  }
  /** is the fine cell under a fixed-point position connected to map cell (bx,by)? */
  reachableFP(x: number, y: number, bx: number, by: number, heavy = false): boolean {
    const f = this.getField(bx, by, true, heavy);
    if (!f) return false;
    return f.dist[(y >> FINE_SHIFT) * this.w + (x >> FINE_SHIFT)] !== UNREACHABLE;
  }

  /** Nearest fully passable map cell to (cx,cy) within radius r cells (deterministic spiral); packed map index or -1. */
  nearestFree(cx: number, cy: number, r = 6, heavy = false): number {
    if (!this.isBlockedCell(cx, cy, heavy)) return cy * this.mapW + cx;
    for (let d = 1; d <= r; d++) {
      for (let y = cy - d; y <= cy + d; y++) for (let x = cx - d; x <= cx + d; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== d) continue;
        if (!this.isBlockedCell(x, y, heavy)) return y * this.mapW + x;
      }
    }
    return -1;
  }
  /** Nearest passable fine cell to (fx,fy) within radius r fine cells; packed fine index or -1. */
  nearestFreeFine(fx: number, fy: number, r = 12, heavy = false): number {
    if (!this.isBlockedFine(fx, fy, heavy)) return fy * this.w + fx;
    for (let d = 1; d <= r; d++) {
      for (let y = fy - d; y <= fy + d; y++) for (let x = fx - d; x <= fx + d; x++) {
        if (Math.max(Math.abs(x - fx), Math.abs(y - fy)) !== d) continue;
        if (!this.isBlockedFine(x, y, heavy)) return y * this.w + x;
      }
    }
    return -1;
  }
}

export const CELL_FP = FP_ONE;
