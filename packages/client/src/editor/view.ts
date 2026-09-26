import { MapIssue, PLAYER_COLORS, Tile } from '@rookfall/sim';
import { EditorDoc, FOOT_HALF, Objects, Symmetry } from './doc';

/**
 * The editor's canvas: the map drawn from a one-pixel-per-cell bitmap scaled up, objects and tool previews
 * on top, and every pointer gesture turned into document edits. Mouse: left button uses the tool, right or
 * middle button (or Space) pans, the wheel zooms. Touch, as in the game: one finger uses the tool, two fingers
 * pan and pinch-zoom.
 */

export type Tool = 'brush' | 'line' | 'rect' | 'fill' | 'pick' | 'mine' | 'start' | 'select' | 'pan';

export interface ToolOptions {
  tool: Tool;
  terrain: number;
  /** brush diameter in cells */
  size: number;
  square: boolean;
  symmetry: Symmetry;
  gold: number;
  zone: number;
}

export interface Selection { kind: 'mine' | 'start'; index: number }

export interface ViewCallbacks {
  /** the cell under the pointer (null when it left the map) */
  onHover(cell: { x: number; y: number } | null): void;
  onSelect(sel: Selection | null): void;
  /** the eyedropper picked a terrain */
  onPick(tile: number): void;
  /** an action was refused (limit reached): a message key for the status line */
  onRefused(reason: 'mines' | 'starts'): void;
}

export interface Camera { zoom: number; ox: number; oy: number }

export const TILE_RGB: Record<number, [number, number, number]> = {
  [Tile.Grass]: [96, 150, 74], [Tile.Water]: [58, 111, 158], [Tile.Rock]: [110, 112, 108], [Tile.Forest]: [44, 96, 38], [Tile.Dirt]: [150, 125, 85],
};
const ZOOM_MIN = 0.5, ZOOM_MAX = 48;
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

export class EditorView {
  private g: CanvasRenderingContext2D;
  private base = document.createElement('canvas');
  private bg: CanvasRenderingContext2D;
  private img!: ImageData;
  cam: Camera;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private frame = 0;
  private hover: { x: number; y: number } | null = null;
  private sel: Selection | null = null;
  private issues: MapIssue[] = [];
  private offDoc: () => void;
  private ro: ResizeObserver;
  private spaceDown = false;
  /** the gesture in progress */
  private drag:
    | { kind: 'pan'; px: number; py: number; ox: number; oy: number }
    | { kind: 'paint'; lx: number; ly: number; startedAt: number }
    | { kind: 'shape'; x0: number; y0: number }
    | { kind: 'move'; sel: Selection; before: Objects; dx: number; dy: number }
    | null = null;
  private pointerId = -1;
  /** touch points by pointer id, for the two-finger pan/zoom */
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; cy: number; zoom: number; ox: number; oy: number } | null = null;

  constructor(private canvas: HTMLCanvasElement, private doc: EditorDoc, private opts: () => ToolOptions, private cb: ViewCallbacks, cam?: Camera) {
    this.g = canvas.getContext('2d')!;
    this.bg = this.base.getContext('2d')!;
    this.cam = cam ?? { zoom: 1, ox: 0, oy: 0 };
    this.rebuildBase();
    this.offDoc = doc.onChange((c) => {
      if (c.whole) this.rebuildBase();
      else if (c.rect) this.paintBase(c.rect.x0, c.rect.y0, c.rect.x1, c.rect.y1);
      if (this.sel && !(this.sel.kind === 'mine' ? doc.mines : doc.starts)[this.sel.index]) this.select(null);
      this.invalidate();
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    if (!cam) this.fit();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.offDoc();
    this.ro.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onCancel);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
  }

  // -------------------------------------------------------------- state from outside

  setIssues(issues: MapIssue[]): void { this.issues = issues; this.invalidate(); }
  select(sel: Selection | null): void {
    const same = sel === this.sel || (!!sel && !!this.sel && sel.kind === this.sel.kind && sel.index === this.sel.index);
    this.sel = sel;
    if (!same) this.cb.onSelect(sel);
    this.invalidate();
  }
  get selection(): Selection | null { return this.sel; }
  /** tool options changed: the preview follows */
  refresh(): void { this.invalidate(); }

  /** the whole map in view, with a margin */
  fit(): void {
    const { w, h } = this.doc;
    if (!this.cssW || !this.cssH) return;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min((this.cssW - 40) / w, (this.cssH - 40) / h)));
    this.cam = { zoom, ox: (this.cssW - w * zoom) / 2, oy: (this.cssH - h * zoom) / 2 };
    this.invalidate();
  }

  /** zoom by `f` keeping the screen point (default: the centre) still */
  zoomBy(f: number, sx = this.cssW / 2, sy = this.cssH / 2): void {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.cam.zoom * f));
    const k = z / this.cam.zoom;
    this.cam = { zoom: z, ox: sx - (sx - this.cam.ox) * k, oy: sy - (sy - this.cam.oy) * k };
    this.invalidate();
  }

  centerOn(x: number, y: number): void {
    const zoom = Math.max(this.cam.zoom, 8);
    this.cam = { zoom, ox: this.cssW / 2 - (x + 0.5) * zoom, oy: this.cssH / 2 - (y + 0.5) * zoom };
    this.invalidate();
  }

  // -------------------------------------------------------------- the map bitmap

  private rebuildBase(): void {
    const { w, h } = this.doc;
    this.base.width = w; this.base.height = h;
    this.img = this.bg.createImageData(w, h);
    this.paintBase(0, 0, w - 1, h - 1);
  }

  /** recolour a block of cells; a per-cell hash shades the colour so large areas are not flat */
  private paintBase(x0: number, y0: number, x1: number, y1: number): void {
    const { w, tiles } = this.doc;
    const d = this.img.data;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = tiles[y * w + x];
      const rgb = TILE_RGB[t] ?? TILE_RGB[0];
      let hsh = Math.imul(x * 374761393 + y * 668265263, 1274126177);
      hsh = (hsh ^ (hsh >>> 15)) >>> 0;
      const amp = t === Tile.Forest ? 22 : t === Tile.Rock ? 16 : 9;
      const j = ((hsh & 255) / 255 - 0.5) * amp;
      const o = (y * w + x) * 4;
      d[o] = rgb[0] + j; d[o + 1] = rgb[1] + j; d[o + 2] = rgb[2] + j; d[o + 3] = 255;
    }
    this.bg.putImageData(this.img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  // -------------------------------------------------------------- drawing

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const first = !this.cssW;
    this.cssW = r.width; this.cssH = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    if (first && this.cam.zoom === 1 && this.cam.ox === 0) this.fit();
    this.draw();
  }

  private invalidate(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  private draw(): void {
    const g = this.g, { zoom: z, ox, oy } = this.cam, { w, h } = this.doc;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#0b0807';
    g.fillRect(0, 0, this.cssW, this.cssH);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.base, ox, oy, w * z, h * z);
    g.strokeStyle = 'rgba(217, 182, 98, 0.6)';
    g.lineWidth = 1;
    g.strokeRect(ox - 0.5, oy - 0.5, w * z + 1, h * z + 1);

    // cell grid once cells are big enough to aim at
    if (z >= 10) {
      const cx0 = Math.max(0, Math.floor(-ox / z)), cx1 = Math.min(w, Math.ceil((this.cssW - ox) / z));
      const cy0 = Math.max(0, Math.floor(-oy / z)), cy1 = Math.min(h, Math.ceil((this.cssH - oy) / z));
      for (const major of [false, true]) {
        g.beginPath();
        for (let x = cx0; x <= cx1; x++) if ((x % 8 === 0) === major) { g.moveTo(Math.round(ox + x * z) + 0.5, oy + cy0 * z); g.lineTo(Math.round(ox + x * z) + 0.5, oy + cy1 * z); }
        for (let y = cy0; y <= cy1; y++) if ((y % 8 === 0) === major) { g.moveTo(ox + cx0 * z, Math.round(oy + y * z) + 0.5); g.lineTo(ox + cx1 * z, Math.round(oy + y * z) + 0.5); }
        g.strokeStyle = major ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.12)';
        g.stroke();
      }
    }
    // the build border: nothing can be built within two cells of the edge
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(251, 240, 198, 0.35)';
    g.strokeRect(ox + 2 * z, oy + 2 * z, (w - 4) * z, (h - 4) * z);
    this.drawSymmetry();
    g.setLineDash([]);

    this.drawObjects();
    this.drawIssues();
    this.drawPreview();
  }

  private drawSymmetry(): void {
    const sym = this.opts().symmetry;
    if (sym === 'none') return;
    const g = this.g, { zoom: z, ox, oy } = this.cam, { w, h } = this.doc;
    g.strokeStyle = 'rgba(120, 200, 255, 0.55)';
    g.beginPath();
    if (sym === 'x' || sym === 'xy') { g.moveTo(ox + (w / 2) * z, oy); g.lineTo(ox + (w / 2) * z, oy + h * z); }
    if (sym === 'y' || sym === 'xy') { g.moveTo(ox, oy + (h / 2) * z); g.lineTo(ox + w * z, oy + (h / 2) * z); }
    if (sym === 'rot' || sym === 'rot4') {
      const r = Math.max(10, Math.min(w, h) * z * 0.06);
      g.moveTo(ox + (w / 2) * z + r, oy + (h / 2) * z);
      g.arc(ox + (w / 2) * z, oy + (h / 2) * z, r, 0, Math.PI * 1.6);
    }
    g.stroke();
  }

  /** screen rectangle of the 3x3 footprint around a cell */
  private footRect(x: number, y: number): [number, number, number, number] {
    const { zoom: z, ox, oy } = this.cam;
    const size = Math.max(6, (FOOT_HALF * 2 + 1) * z);
    const cx = ox + (x + 0.5) * z, cy = oy + (y + 0.5) * z;
    return [cx - size / 2, cy - size / 2, size, size];
  }

  private drawObjects(): void {
    const g = this.g, z = this.cam.zoom;
    const label = (text: string, x: number, y: number, size: number, color: string) => {
      g.font = `700 ${size}px ${getComputedStyle(document.body).getPropertyValue('--font-display') || 'serif'}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = Math.max(2, size / 5); g.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      g.strokeText(text, x, y); g.fillStyle = color; g.fillText(text, x, y);
    };
    this.doc.mines.forEach((m, i) => {
      const [x, y, s] = this.footRect(m.x, m.y);
      g.fillStyle = 'rgba(224, 181, 58, 0.9)';
      g.strokeStyle = '#3a2a08';
      g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(x, y, s, s, s * 0.25); g.fill(); g.stroke();
      if (z >= 5) label(m.gold >= 1000 ? `${Math.round(m.gold / 100) / 10}k` : String(m.gold), x + s / 2, y + s / 2, Math.min(18, s * 0.38), '#fff6d8');
      if (this.sel?.kind === 'mine' && this.sel.index === i) this.drawSelected(x, y, s);
    });
    this.doc.starts.forEach((st, i) => {
      const [x, y, s] = this.footRect(st.x, st.y);
      g.fillStyle = hex(PLAYER_COLORS[st.zone % PLAYER_COLORS.length]);
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.globalAlpha = 0.92;
      g.fillRect(x, y, s, s);
      g.globalAlpha = 1;
      g.strokeRect(x, y, s, s);
      if (s >= 12) label(String(st.zone + 1), x + s / 2, y + s / 2 + 1, Math.min(20, s * 0.55), '#fff');
      if (this.sel?.kind === 'start' && this.sel.index === i) this.drawSelected(x, y, s);
    });
  }

  private drawSelected(x: number, y: number, s: number): void {
    const g = this.g;
    g.setLineDash([4, 3]);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.strokeRect(x - 4, y - 4, s + 8, s + 8);
    g.setLineDash([]);
  }

  private drawIssues(): void {
    const g = this.g, { zoom: z, ox, oy } = this.cam;
    for (const is of this.issues) {
      if (is.x === undefined || is.y === undefined) continue;
      const r = Math.max(9, 2.6 * z);
      g.strokeStyle = is.error ? 'rgba(255, 90, 80, 0.95)' : 'rgba(255, 210, 90, 0.9)';
      g.lineWidth = 2.5;
      g.beginPath(); g.arc(ox + (is.x + 0.5) * z, oy + (is.y + 0.5) * z, r, 0, Math.PI * 2); g.stroke();
    }
  }

  /** what the tool would do at the pointer: stamp outline, shape, ghost footprint */
  private drawPreview(): void {
    const hv = this.hover;
    if (!hv) return;
    const g = this.g, { zoom: z, ox, oy } = this.cam, o = this.opts(), doc = this.doc;
    const tool = this.spaceDown ? 'pan' : o.tool;
    const cellRect = (x: number, y: number, w = 1, h = 1) => g.strokeRect(ox + x * z + 0.5, oy + y * z + 0.5, Math.max(1, w * z - 1), Math.max(1, h * z - 1));
    g.lineWidth = 1.5;
    if (tool === 'brush' || tool === 'line') {
      const pts = this.drag?.kind === 'shape' && tool === 'line' ? [] : doc.mirrors(hv.x, hv.y, o.symmetry);
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      for (const [x, y] of pts) this.stampOutline(x, y, o.size, o.square);
      if (this.drag?.kind === 'shape' && tool === 'line') {
        const d = this.drag;
        const [r, gg, b] = TILE_RGB[o.terrain];
        g.strokeStyle = `rgba(${r}, ${gg}, ${b}, 0.75)`;
        g.lineWidth = Math.max(2, o.size * z);
        g.lineCap = o.square ? 'square' : 'round';
        g.beginPath();
        for (const [[ax, ay], [bx, by]] of zip(doc.mirrors(d.x0, d.y0, o.symmetry), doc.mirrors(hv.x, hv.y, o.symmetry))) {
          g.moveTo(ox + (ax + 0.5) * z, oy + (ay + 0.5) * z); g.lineTo(ox + (bx + 0.5) * z, oy + (by + 0.5) * z);
        }
        g.stroke();
        g.lineCap = 'butt';
      }
    } else if (tool === 'rect') {
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      if (this.drag?.kind === 'shape') {
        const d = this.drag;
        const [r, gg, b] = TILE_RGB[o.terrain];
        g.fillStyle = `rgba(${r}, ${gg}, ${b}, 0.55)`;
        for (const [[ax, ay], [bx, by]] of zip(doc.mirrors(d.x0, d.y0, o.symmetry), doc.mirrors(hv.x, hv.y, o.symmetry))) {
          const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax) + 1, h = Math.abs(by - ay) + 1;
          g.fillRect(ox + x * z, oy + y * z, w * z, h * z);
          cellRect(x, y, w, h);
        }
      } else cellRect(hv.x, hv.y);
    } else if (tool === 'fill' || tool === 'pick') {
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      for (const [x, y] of tool === 'fill' ? doc.mirrors(hv.x, hv.y, o.symmetry) : [[hv.x, hv.y]]) cellRect(x, y);
    } else if ((tool === 'mine' || tool === 'start') && !this.drag && !doc.objectAt(hv.x, hv.y)) {
      doc.mirrors(hv.x, hv.y, o.symmetry).forEach(([x, y], k) => {
        const [rx, ry, s] = this.footRect(x, y);
        g.globalAlpha = 0.55;
        g.fillStyle = tool === 'mine' ? 'rgb(224, 181, 58)' : hex(PLAYER_COLORS[(o.zone + k) % PLAYER_COLORS.length]);
        g.fillRect(rx, ry, s, s);
        g.globalAlpha = 1;
        g.strokeStyle = '#fff';
        g.strokeRect(rx, ry, s, s);
      });
    } else if (tool === 'select' || tool === 'mine' || tool === 'start') {
      const obj = doc.objectAt(hv.x, hv.y);
      if (obj) {
        const p = obj.kind === 'mine' ? doc.mines[obj.index] : doc.starts[obj.index];
        const [rx, ry, s] = this.footRect(p.x, p.y);
        g.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        g.strokeRect(rx - 2, ry - 2, s + 4, s + 4);
      }
    }
  }

  private stampOutline(cx: number, cy: number, size: number, square: boolean): void {
    const g = this.g, { zoom: z, ox, oy } = this.cam;
    const lo = -Math.floor((size - 1) / 2);
    const x = ox + (cx + lo) * z, y = oy + (cy + lo) * z;
    if (square || size <= 2) { g.strokeRect(x, y, size * z, size * z); return; }
    g.beginPath();
    g.arc(x + (size * z) / 2, y + (size * z) / 2, (size * z) / 2, 0, Math.PI * 2);
    g.stroke();
  }

  // -------------------------------------------------------------- input

  private cellAt(e: { clientX: number; clientY: number }): { x: number; y: number; sx: number; sy: number } {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { x: Math.floor((sx - this.cam.ox) / this.cam.zoom), y: Math.floor((sy - this.cam.oy) / this.cam.zoom), sx, sy };
  }

  private setHover(x: number, y: number): void {
    const inside = this.doc.inside(x, y);
    const next = inside ? { x, y } : null;
    if (next?.x === this.hover?.x && next?.y === this.hover?.y) return;
    this.hover = next;
    this.cb.onHover(next);
    this.invalidate();
  }

  private onDown = (e: PointerEvent) => {
    const p = this.cellAt(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: p.sx, y: p.sy });
      if (this.touches.size === 2) { this.startPinch(); return; }
      if (this.touches.size > 2) return;
    } else if (this.drag) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    const o = this.opts();
    const tool = this.spaceDown ? 'pan' : o.tool;
    if (e.button === 1 || e.button === 2 || tool === 'pan') {
      this.drag = { kind: 'pan', px: p.sx, py: p.sy, ox: this.cam.ox, oy: this.cam.oy };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    this.setHover(p.x, p.y);
    const doc = this.doc;
    const terrainTool = tool === 'brush' || tool === 'line' || tool === 'rect' || tool === 'fill';
    if ((terrainTool && e.altKey) || tool === 'pick') {
      if (doc.inside(p.x, p.y)) this.cb.onPick(doc.tileAt(p.x, p.y));
      return;
    }
    switch (tool) {
      case 'brush':
        doc.beginStroke();
        doc.stamp(p.x, p.y, o.size, o.square, o.terrain, o.symmetry);
        doc.flushStroke();
        this.drag = { kind: 'paint', lx: p.x, ly: p.y, startedAt: performance.now() };
        break;
      case 'line': case 'rect':
        if (doc.inside(p.x, p.y)) this.drag = { kind: 'shape', x0: p.x, y0: p.y };
        break;
      case 'fill':
        doc.floodFill(p.x, p.y, o.terrain, o.symmetry);
        break;
      case 'mine': case 'start': case 'select': {
        const obj = doc.objectAt(p.x, p.y);
        if (obj) {
          this.select(obj);
          const at = obj.kind === 'mine' ? doc.mines[obj.index] : doc.starts[obj.index];
          this.drag = { kind: 'move', sel: obj, before: doc.snapshotObjects(), dx: at.x - p.x, dy: at.y - p.y };
        } else if (tool === 'select' || !doc.inside(p.x, p.y)) {
          this.select(null);
        } else if (tool === 'mine') {
          const n = doc.mines.length;
          if (doc.addMine(p.x, p.y, o.gold, o.symmetry)) this.select({ kind: 'mine', index: n }); else this.cb.onRefused('mines');
        } else {
          const n = doc.starts.length;
          if (doc.addStart(p.x, p.y, o.zone, o.symmetry)) this.select({ kind: 'start', index: n }); else this.cb.onRefused('starts');
        }
        break;
      }
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.cellAt(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: p.sx, y: p.sy });
      if (this.pinch) { this.movePinch(); return; }
    }
    if (this.drag && e.pointerId !== this.pointerId) return;
    this.setHover(p.x, p.y);
    const d = this.drag;
    if (!d) return;
    const o = this.opts();
    if (d.kind === 'pan') {
      this.cam = { ...this.cam, ox: d.ox + p.sx - d.px, oy: d.oy + p.sy - d.py };
      this.invalidate();
    } else if (d.kind === 'paint') {
      if (p.x === d.lx && p.y === d.ly) return;
      this.doc.stampLine(d.lx, d.ly, p.x, p.y, o.size, o.square, o.terrain, o.symmetry);
      this.doc.flushStroke();
      d.lx = p.x; d.ly = p.y;
    } else if (d.kind === 'move') {
      const doc = this.doc;
      const x = Math.max(0, Math.min(doc.w - 1, p.x + d.dx)), y = Math.max(0, Math.min(doc.h - 1, p.y + d.dy));
      doc.dragObject(d.sel.kind, d.sel.index, x, y);
    } else this.invalidate();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch) { if (this.touches.size < 2) this.pinch = null; return; }
    }
    if (e.pointerId !== this.pointerId) return;
    this.finish(true, e);
  };

  private onCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    if (e.pointerId === this.pointerId) this.finish(false, e);
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' && !this.drag) { this.hover = null; this.cb.onHover(null); this.invalidate(); }
  };

  /** end the gesture: commit it, or (cancelled) take it back */
  private finish(commit: boolean, e?: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.pointerId = -1;
    this.canvas.style.cursor = '';
    if (!d) return;
    const doc = this.doc, o = this.opts();
    if (d.kind === 'paint') {
      if (commit) doc.endStroke(); else doc.cancelStroke();
    } else if (d.kind === 'shape' && commit && e) {
      const p = this.cellAt(e);
      const x = Math.max(0, Math.min(doc.w - 1, p.x)), y = Math.max(0, Math.min(doc.h - 1, p.y));
      if (o.tool === 'rect') doc.fillRect(d.x0, d.y0, x, y, o.terrain, o.symmetry);
      else { doc.beginStroke(); doc.stampLine(d.x0, d.y0, x, y, o.size, o.square, o.terrain, o.symmetry); doc.endStroke(); }
    } else if (d.kind === 'move') {
      const was = (d.sel.kind === 'mine' ? d.before.mines : d.before.starts)[d.sel.index];
      if (commit) doc.commitMove(d.before);
      else if (was) doc.dragObject(d.sel.kind, d.sel.index, was.x, was.y);
    }
    this.invalidate();
  }

  /** a second finger: whatever the first one started is taken back, the two now pan and zoom */
  private startPinch(): void {
    if (this.drag && this.drag.kind !== 'pan') this.finish(false);
    this.drag = null;
    const [a, b] = [...this.touches.values()];
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, ...this.cam };
  }

  private movePinch(): void {
    const pc = this.pinch!;
    const [a, b] = [...this.touches.values()];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pc.zoom * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pc.dist)));
    const k = zoom / pc.zoom;
    this.cam = { zoom, ox: cx - (pc.cx - pc.ox) * k, oy: cy - (pc.cy - pc.oy) * k };
    this.invalidate();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.cellAt(e);
    // pinch on a trackpad arrives as ctrl+wheel with small deltas; a mouse wheel notch is ~100
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    this.zoomBy(f, p.sx, p.sy);
  };

  private onContext = (e: Event) => e.preventDefault();

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    const down = e.type === 'keydown';
    if (down) e.preventDefault();
    if (down === this.spaceDown) return;
    this.spaceDown = down;
    this.canvas.style.cursor = down ? 'grab' : '';
    this.invalidate();
  };
}

function zip<A, B>(a: A[], b: B[]): [A, B][] {
  return a.slice(0, b.length).map((x, i) => [x, b[i]]);
}
