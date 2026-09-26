import { FP_SHIFT } from './fixed';
import { World } from './world';
import { Kind } from './types';

export interface GridSnapshot { cellStart: Int32Array; cellCount: Int32Array; items: Int32Array; cellOf: Int32Array }

/** Uniform grid rebuilt every tick by counting sort over alive units/buildings/mines (ascending id). */
export class SpatialGrid {
  readonly cellShift: number; // cell size = 2^cellShift map cells
  readonly gw: number;
  readonly gh: number;
  private cellStart: Int32Array;
  private cellCount: Int32Array;
  private items: Int32Array;
  private cellOf: Int32Array;

  constructor(mapW: number, mapH: number, cap: number, cellSizeCells = 2) {
    this.cellShift = Math.log2(cellSizeCells) | 0;
    this.gw = Math.ceil(mapW / cellSizeCells);
    this.gh = Math.ceil(mapH / cellSizeCells);
    const n = this.gw * this.gh;
    this.cellStart = new Int32Array(n + 1);
    this.cellCount = new Int32Array(n);
    this.items = new Int32Array(cap);
    this.cellOf = new Int32Array(cap);
  }

  private cellIndex(x: number, y: number): number {
    let cx = (x >> FP_SHIFT) >> this.cellShift;
    let cy = (y >> FP_SHIFT) >> this.cellShift;
    if (cx < 0) cx = 0; else if (cx >= this.gw) cx = this.gw - 1;
    if (cy < 0) cy = 0; else if (cy >= this.gh) cy = this.gh - 1;
    return cy * this.gw + cx;
  }

  rebuild(w: World): void {
    const n = this.gw * this.gh;
    this.cellCount.fill(0);
    const max = w.maxId;
    for (let id = 0; id < max; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      if (k !== Kind.Unit && k !== Kind.Building && k !== Kind.Mine) { this.cellOf[id] = -1; continue; }
      const c = this.cellIndex(w.x[id], w.y[id]);
      this.cellOf[id] = c;
      this.cellCount[c]++;
    }
    let acc = 0;
    for (let c = 0; c < n; c++) { this.cellStart[c] = acc; acc += this.cellCount[c]; }
    this.cellStart[n] = acc;
    // fill (ascending id order within each cell)
    this.cellCount.fill(0);
    for (let id = 0; id < max; id++) {
      if (!w.alive[id]) continue;
      const c = this.cellOf[id];
      if (c < 0) continue;
      this.items[this.cellStart[c] + this.cellCount[c]] = id;
      this.cellCount[c]++;
    }
  }

  snapshot(): GridSnapshot {
    return { cellStart: this.cellStart.slice(), cellCount: this.cellCount.slice(), items: this.items.slice(), cellOf: this.cellOf.slice() };
  }
  restore(s: GridSnapshot): void {
    this.cellStart.set(s.cellStart); this.cellCount.set(s.cellCount); this.items.set(s.items); this.cellOf.set(s.cellOf);
  }

  /**
   * Visit all indexed entities whose grid cell intersects the circle (x,y,r) [fixed].
   * Callback order is deterministic (cell-major, then ascending id). Return true from cb to stop.
   */
  query(x: number, y: number, r: number, cb: (id: number) => boolean | void): void {
    const cs = this.cellShift;
    let x0 = ((x - r) >> FP_SHIFT) >> cs, x1 = ((x + r) >> FP_SHIFT) >> cs;
    let y0 = ((y - r) >> FP_SHIFT) >> cs, y1 = ((y + r) >> FP_SHIFT) >> cs;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 >= this.gw) x1 = this.gw - 1; if (y1 >= this.gh) y1 = this.gh - 1;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.gw + cx;
        const s = this.cellStart[c], e = this.cellStart[c + 1];
        for (let i = s; i < e; i++) if (cb(this.items[i])) return;
      }
    }
  }
}
