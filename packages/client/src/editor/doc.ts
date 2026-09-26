import {
  CustomMapSource, MAP_MINES_MAX, MAP_SIZE_MAX, MAP_SIZE_MIN, MAP_STARTS_PER_ZONE_MAX, MAX_PLAYERS, MapMine, MapStart, Rng, Tile,
} from '@rookfall/sim';

/**
 * The map editor's document: tiles, gold deposits and spawn candidates, with undo/redo. Pure logic - the
 * canvas and the panels only call into it and redraw what `onChange` reports.
 */

export type Symmetry = 'none' | 'x' | 'y' | 'xy' | 'rot' | 'rot4';
export const SYMMETRIES: Symmetry[] = ['none', 'x', 'y', 'xy', 'rot', 'rot4'];

export interface Objects { mines: MapMine[]; starts: MapStart[] }

interface CellEdit { idx: Int32Array; before: Uint8Array; after: Uint8Array }
interface Snapshot { w: number; h: number; tiles: Uint8Array; mines: MapMine[]; starts: MapStart[] }
interface Edit {
  cells?: CellEdit;
  objs?: { before: Objects; after: Objects };
  /** resize and anything else that swaps the whole map */
  whole?: { before: Snapshot; after: Snapshot };
}

/** what changed, so the view repaints only that */
export interface Change {
  /** changed cell bounds, inclusive; absent when only objects changed */
  rect?: { x0: number; y0: number; x1: number; y1: number };
  /** the map was replaced (size may differ) */
  whole?: boolean;
  objects?: boolean;
}

const HISTORY_MAX = 120;
/** a mine or a castle covers the 3x3 block around its cell */
export const FOOT_HALF = 1;

const cloneObjs = (o: Objects): Objects => ({ mines: o.mines.map((m) => ({ ...m })), starts: o.starts.map((s) => ({ ...s })) });

export class EditorDoc {
  /** server id and revision once saved */
  id: string | undefined;
  rev = 0;
  name: string;
  w: number;
  h: number;
  tiles: Uint8Array;
  mines: MapMine[];
  starts: MapStart[];
  /** unsaved changes */
  dirty = false;
  /** bumps on every change (React keys its re-renders on it) */
  version = 0;

  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  private listeners = new Set<(c: Change) => void>();
  /** open stroke: cells touched so far and their values before it */
  private stroke: { idx: number[]; before: number[]; mark: Uint8Array; x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(src: CustomMapSource, id?: string, rev = 0) {
    this.id = id;
    this.rev = rev;
    this.name = src.name;
    this.w = src.w; this.h = src.h;
    this.tiles = src.tiles.slice();
    this.mines = src.mines.map((m) => ({ ...m }));
    this.starts = src.starts.map((s) => ({ ...s }));
  }

  toSource(): CustomMapSource {
    return { name: this.name, w: this.w, h: this.h, tiles: this.tiles.slice(), mines: this.mines.map((m) => ({ ...m })), starts: this.starts.map((s) => ({ ...s })) };
  }

  onChange(fn: (c: Change) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed(c: Change): void {
    this.dirty = true;
    this.version++;
    for (const l of this.listeners) l(c);
  }
  /** after a save: the document matches the server copy */
  markSaved(id: string, rev: number): void { this.id = id; this.rev = rev; this.dirty = false; this.version++; for (const l of this.listeners) l({}); }
  rename(name: string): void { if (name !== this.name) { this.name = name; this.changed({}); } }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  inside(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  tileAt(x: number, y: number): number { return this.inside(x, y) ? this.tiles[y * this.w + x] : Tile.Rock; }

  // -------------------------------------------------------------- symmetry

  /** the cell and its mirror images (deduplicated), first entry the cell itself */
  mirrors(x: number, y: number, sym: Symmetry): [number, number][] {
    const { w, h } = this;
    let pts: [number, number][];
    switch (sym) {
      case 'x': pts = [[x, y], [w - 1 - x, y]]; break;
      case 'y': pts = [[x, y], [x, h - 1 - y]]; break;
      case 'xy': pts = [[x, y], [w - 1 - x, y], [x, h - 1 - y], [w - 1 - x, h - 1 - y]]; break;
      case 'rot': pts = [[x, y], [w - 1 - x, h - 1 - y]]; break;
      // a quarter turn only maps a square map onto itself
      case 'rot4': pts = w === h ? [[x, y], [w - 1 - y, x], [w - 1 - x, h - 1 - y], [y, h - 1 - x]] : [[x, y], [w - 1 - x, h - 1 - y]]; break;
      default: pts = [[x, y]];
    }
    const seen = new Set<number>();
    return pts.filter(([px, py]) => { const k = py * 65536 + px; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // -------------------------------------------------------------- terrain strokes

  beginStroke(): void {
    if (this.stroke) this.endStroke();
    this.stroke = { idx: [], before: [], mark: new Uint8Array(this.w * this.h), x0: this.w, y0: this.h, x1: -1, y1: -1 };
  }

  /** paint one cell inside an open stroke (outside one it opens and closes its own) */
  setTile(x: number, y: number, t: number): void {
    if (!this.inside(x, y)) return;
    const own = !this.stroke;
    if (own) this.beginStroke();
    const s = this.stroke!;
    const i = y * this.w + x;
    if (this.tiles[i] !== t) {
      if (!s.mark[i]) { s.mark[i] = 1; s.idx.push(i); s.before.push(this.tiles[i]); }
      this.tiles[i] = t;
      if (x < s.x0) s.x0 = x; if (y < s.y0) s.y0 = y; if (x > s.x1) s.x1 = x; if (y > s.y1) s.y1 = y;
    }
    if (own) this.endStroke();
  }

  /** cells painted since the last flush are reported; call once per pointer move */
  flushStroke(): void {
    const s = this.stroke;
    if (!s || s.x1 < 0) return;
    const rect = { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 };
    s.x0 = this.w; s.y0 = this.h; s.x1 = -1; s.y1 = -1;
    this.changed({ rect });
  }

  endStroke(): void {
    const s = this.stroke;
    if (!s) return;
    this.flushStroke();
    this.stroke = null;
    // cells painted and painted back to what they were are no change at all
    const idx: number[] = [], before: number[] = [], after: number[] = [];
    for (let k = 0; k < s.idx.length; k++) {
      const i = s.idx[k];
      if (this.tiles[i] !== s.before[k]) { idx.push(i); before.push(s.before[k]); after.push(this.tiles[i]); }
    }
    if (idx.length) this.push({ cells: { idx: Int32Array.from(idx), before: Uint8Array.from(before), after: Uint8Array.from(after) } });
  }

  /** a stroke the player did not mean (a second finger arrived): put every cell back, record nothing */
  cancelStroke(): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    if (!s.idx.length) return;
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let k = 0; k < s.idx.length; k++) {
      const i = s.idx[k], x = i % this.w, y = (i / this.w) | 0;
      this.tiles[i] = s.before[k];
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    this.changed({ rect: { x0, y0, x1, y1 } });
  }

  get stroking(): boolean { return !!this.stroke; }

  /** a round (or square) stamp of `size` cells across, centred on the cell, with its mirror images */
  stamp(cx: number, cy: number, size: number, square: boolean, t: number, sym: Symmetry): void {
    const r = size / 2;
    const lo = -Math.floor((size - 1) / 2), hi = Math.floor(size / 2);
    for (const [mx, my] of this.mirrors(cx, cy, sym)) {
      for (let dy = lo; dy <= hi; dy++) for (let dx = lo; dx <= hi; dx++) {
        if (!square && size > 2) {
          // distance from the stamp centre, which sits between cells for an even size
          const ox = dx - (size % 2 === 0 ? 0.5 : 0), oy = dy - (size % 2 === 0 ? 0.5 : 0);
          if (ox * ox + oy * oy > r * r) continue;
        }
        this.setTile(mx + dx, my + dy, t);
      }
    }
  }

  /** stamps every cell along a segment, so a fast drag leaves no gaps */
  stampLine(x0: number, y0: number, x1: number, y1: number, size: number, square: boolean, t: number, sym: Symmetry): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const x = steps ? Math.round(x0 + ((x1 - x0) * i) / steps) : x0;
      const y = steps ? Math.round(y0 + ((y1 - y0) * i) / steps) : y0;
      this.stamp(x, y, size, square, t, sym);
    }
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, t: number, sym: Symmetry): void {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    this.beginStroke();
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) for (const [mx, my] of this.mirrors(x, y, sym)) this.setTile(mx, my, t);
    this.endStroke();
  }

  /** flood the 4-connected area of the clicked tile (and of its mirror images) with `t` */
  floodFill(x: number, y: number, t: number, sym: Symmetry): void {
    if (!this.inside(x, y)) return;
    this.beginStroke();
    const { w, h } = this;
    const queue = new Int32Array(w * h);
    for (const [sx, sy] of this.mirrors(x, y, sym)) {
      const from = this.tiles[sy * w + sx];
      if (from === t) continue;
      let head = 0, tail = 0;
      queue[tail++] = sy * w + sx;
      this.setTile(sx, sy, t);
      while (head < tail) {
        const c = queue[head++], cx = c % w, cy = (c / w) | 0;
        const tryCell = (nx: number, ny: number) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
          const n = ny * w + nx;
          if (this.tiles[n] !== from) return;
          this.setTile(nx, ny, t);
          queue[tail++] = n;
        };
        tryCell(cx - 1, cy); tryCell(cx + 1, cy); tryCell(cx, cy - 1); tryCell(cx, cy + 1);
      }
    }
    this.endStroke();
  }

  // -------------------------------------------------------------- objects

  /** the deposit or spawn whose 3x3 footprint covers the cell (spawns win: they are drawn on top) */
  objectAt(x: number, y: number): { kind: 'mine' | 'start'; index: number } | null {
    for (let i = this.starts.length - 1; i >= 0; i--) {
      const s = this.starts[i];
      if (Math.abs(s.x - x) <= FOOT_HALF && Math.abs(s.y - y) <= FOOT_HALF) return { kind: 'start', index: i };
    }
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (Math.abs(m.x - x) <= FOOT_HALF && Math.abs(m.y - y) <= FOOT_HALF) return { kind: 'mine', index: i };
    }
    return null;
  }

  /** replace the objects as one undoable step */
  setObjects(next: Objects): void {
    const before = cloneObjs(this);
    this.mines = next.mines; this.starts = next.starts;
    this.push({ objs: { before, after: cloneObjs(next) } });
    this.changed({ objects: true });
  }

  /** a deposit here and at the mirror images; false when the map already has as many as it may */
  addMine(x: number, y: number, gold: number, sym: Symmetry): boolean {
    const pts = this.mirrors(x, y, sym);
    if (this.mines.length + pts.length > MAP_MINES_MAX) return false;
    const o = cloneObjs(this);
    for (const [mx, my] of pts) o.mines.push({ x: mx, y: my, gold });
    this.setObjects(o);
    return true;
  }

  /**
   * A spawn candidate for `zone` here; each mirror image goes to the next zone, so one click with four-way
   * symmetry lays out a whole four-player map. False when a zone would get more candidates than it may.
   */
  addStart(x: number, y: number, zone: number, sym: Symmetry): boolean {
    const pts = this.mirrors(x, y, sym);
    const o = cloneObjs(this);
    for (let k = 0; k < pts.length; k++) {
      const z = zone + k;
      if (z >= MAX_PLAYERS) return false;
      if (o.starts.filter((s) => s.zone === z).length >= MAP_STARTS_PER_ZONE_MAX) return false;
      o.starts.push({ x: pts[k][0], y: pts[k][1], zone: z });
    }
    this.setObjects(o);
    return true;
  }

  removeObject(kind: 'mine' | 'start', index: number): void {
    const o = cloneObjs(this);
    if (kind === 'mine') o.mines.splice(index, 1); else o.starts.splice(index, 1);
    this.setObjects(o);
  }

  /** move without recording (while dragging); `commitMove` records the whole drag as one step */
  dragObject(kind: 'mine' | 'start', index: number, x: number, y: number): void {
    const list = kind === 'mine' ? this.mines : this.starts;
    const o = list[index];
    if (!o || !this.inside(x, y) || (o.x === x && o.y === y)) return;
    o.x = x; o.y = y;
    this.version++;
    for (const l of this.listeners) l({ objects: true });
  }
  commitMove(before: Objects): void {
    const same = JSON.stringify(before) === JSON.stringify({ mines: this.mines, starts: this.starts });
    if (same) return;
    this.push({ objs: { before, after: cloneObjs(this) } });
    this.changed({ objects: true });
  }
  snapshotObjects(): Objects { return cloneObjs(this); }

  updateMine(index: number, gold: number): void {
    const o = cloneObjs(this);
    if (!o.mines[index]) return;
    o.mines[index].gold = gold;
    this.setObjects(o);
  }
  updateStartZone(index: number, zone: number): void {
    const o = cloneObjs(this);
    if (!o.starts[index]) return;
    o.starts[index].zone = zone;
    this.setObjects(o);
  }

  // -------------------------------------------------------------- whole map

  private snapshot(): Snapshot { return { w: this.w, h: this.h, tiles: this.tiles.slice(), mines: this.mines.map((m) => ({ ...m })), starts: this.starts.map((s) => ({ ...s })) }; }
  private restore(s: Snapshot): void {
    this.w = s.w; this.h = s.h; this.tiles = s.tiles.slice();
    this.mines = s.mines.map((m) => ({ ...m })); this.starts = s.starts.map((x) => ({ ...x }));
  }

  /**
   * New size, the old map anchored at (ax, ay) in {0, 0.5, 1} of the free space (0.5 = centred). New ground is
   * grass inside a rock border; objects that fall off the edge go.
   */
  resize(w: number, h: number, ax = 0.5, ay = 0.5): void {
    w = Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, Math.round(w)));
    h = Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, Math.round(h)));
    if (w === this.w && h === this.h) return;
    const before = this.snapshot();
    const dx = Math.round((w - this.w) * ax), dy = Math.round((h - this.h) * ay);
    const tiles = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x - dx, sy = y - dy;
      tiles[y * w + x] = sx >= 0 && sy >= 0 && sx < this.w && sy < this.h ? this.tiles[sy * this.w + sx] : (x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? Tile.Rock : Tile.Grass);
    }
    const inside = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
    this.mines = this.mines.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy })).filter(inside);
    this.starts = this.starts.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })).filter(inside);
    this.w = w; this.h = h; this.tiles = tiles;
    this.push({ whole: { before, after: this.snapshot() } });
    this.changed({ whole: true });
  }

  /**
   * Scatter forests, rocks and ponds over the open ground, mirrored by the current symmetry, then clear the
   * ground around every spawn and deposit so the result stays playable. One undoable step.
   */
  scatter(sym: Symmetry, density: number, seed: number): void {
    const before = this.snapshot();
    const rng = new Rng(seed);
    const { w, h } = this;
    const blobs = Math.round((w * h) / 900 * density);
    for (let i = 0; i < blobs; i++) {
      const bx = rng.range(3, w - 4), by = rng.range(3, h - 4), r = rng.range(2, 4 + Math.round(Math.min(w, h) / 64));
      const roll = rng.nextInt(10);
      const t = roll < 6 ? Tile.Forest : roll < 8 ? Tile.Rock : Tile.Water;
      for (let y = by - r; y <= by + r; y++) for (let x = bx - r; x <= bx + r; x++) {
        if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
        const d2 = (x - bx) * (x - bx) + (y - by) * (y - by);
        if (d2 > r * r || (d2 > (r - 1) * (r - 1) && t !== Tile.Water && rng.chance(0.5))) continue;
        for (const [mx, my] of this.mirrors(x, y, sym)) if (this.tiles[my * w + mx] === Tile.Grass) this.tiles[my * w + mx] = t;
      }
    }
    const clear = (cx: number, cy: number, r: number) => {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) this.tiles[y * w + x] = Tile.Grass;
      }
    };
    for (const s of this.starts) clear(s.x, s.y, 6);
    for (const m of this.mines) clear(m.x, m.y, 3);
    this.push({ whole: { before, after: this.snapshot() } });
    this.changed({ whole: true });
  }

  /** everything back to grass inside the rock border, objects kept */
  clearTerrain(): void {
    const before = this.snapshot();
    const { w, h } = this;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.tiles[y * w + x] = x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? Tile.Rock : Tile.Grass;
    this.push({ whole: { before, after: this.snapshot() } });
    this.changed({ whole: true });
  }

  // -------------------------------------------------------------- history

  private push(e: Edit): void {
    this.undoStack.push(e);
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): void { this.step(this.undoStack, this.redoStack, true); }
  redo(): void { this.step(this.redoStack, this.undoStack, false); }

  private step(from: Edit[], to: Edit[], back: boolean): void {
    if (this.stroke) this.endStroke();
    const e = from.pop();
    if (!e) return;
    to.push(e);
    if (e.whole) { this.restore(back ? e.whole.before : e.whole.after); this.changed({ whole: true }); return; }
    if (e.objs) {
      const o = cloneObjs(back ? e.objs.before : e.objs.after);
      this.mines = o.mines; this.starts = o.starts;
      this.changed({ objects: true });
    }
    if (e.cells) {
      const { idx } = e.cells, vals = back ? e.cells.before : e.cells.after;
      let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k], x = i % this.w, y = (i / this.w) | 0;
        this.tiles[i] = vals[k];
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
      this.changed({ rect: { x0, y0, x1, y1 } });
    }
  }
}
