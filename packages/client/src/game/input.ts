import { keyFromEvent } from './keys';
import {
  garrisonCapacity,
  ABILITIES, AbilityId, BUILDINGS, BuildingState, BuildingType, Command, CommandType, Kind, MINE_CAPACITY, UNITS, UnitType, canPlaceBuilding, fp, toFloat,
} from '@rookfall/sim';
import { getSettings } from '../settings';
import { buzz, isTouchUI, notePointerType, subscribeTouchUI } from '../touch';
import { enterGameFullscreen, isSmallScreen } from '../ui/fullscreen';
import type { GameView } from './view';

export type InputMode = 'normal' | 'attackMove' | 'patrol' | 'build' | 'ability' | 'rally' | 'dismantle';

export interface DragBox { x0: number; y0: number; x1: number; y1: number }

/** what a click handler needs; a touch gesture synthesises one of these instead of forging a PointerEvent */
export interface ClickLike { clientX: number; clientY: number; shiftKey: boolean }

/**
 * What the finger currently on the glass is doing. It is decided on the first few pixels of movement and
 * then stays put, so a gesture never changes meaning halfway through.
 */
type Gesture = 'none' | 'tap' | 'pan' | 'hold' | 'box' | 'place' | 'pinch' | 'done';
interface TouchPt { id: number; x: number; y: number; x0: number; y0: number; panX: number; panY: number }

/** Mouse & keyboard handling: selection, smart orders, hotkeys, camera scrolling. */
export class InputController {
  selected: number[] = [];
  groups: number[][] = Array.from({ length: 10 }, () => []);
  mode: InputMode = 'normal';
  buildType: BuildingType | -1 = -1;
  abilityId: AbilityId | -1 = -1;
  buildMenu = false;
  hoverId = -1;
  hoverGround: { x: number; y: number } | null = null;
  drag: DragBox | null = null;
  chatOpen = false;
  private keys = new Set<string>();
  /** a targeting mode entered from a key that also scrolls the camera: held long enough, it was a scroll, not an order */
  private modeKey: { key: string; t: number } | null = null;
  private mouse = { x: 0, y: 0, inside: false };
  private lmbDown: { x: number; y: number; t: number } | null = null;
  private rmbDown: { x: number; y: number; panned: boolean } | null = null;
  private mmbDown: { x: number; y: number } | null = null;
  /** both mouse buttons held: fast camera pan; neither click fires on release */
  private bothPan: { x: number; y: number } | null = null;
  private lastClick = { t: 0, id: -1 };
  private lastGroupKey = { k: -1, t: 0 };
  private unsub: (() => void)[] = [];
  private placeOk = false;
  /** fence drag: cell where the button went down, and the current line of ghost cells */
  private buildLine: { cx: number; cy: number } | null = null;
  private buildLineCells: { cx: number; cy: number; ok: boolean }[] = [];
  /** fingers on the canvas, in the order they landed */
  private touches: TouchPt[] = [];
  private gesture: Gesture = 'none';
  private longPressTimer = 0;
  /** two-finger baseline: finger spread, twist angle and midpoint, refreshed every move */
  private pinch: { dist: number; angle: number; cx: number; cy: number; twisting: boolean; twist: number; t0: number; moved: number; tapped: boolean } | null = null;
  private lastTap = { t: 0, id: -1 };
  private askedFullscreen = false;
  onSelectionChanged: (() => void) | null = null;
  onToggleChat: ((open: boolean) => void) | null = null;
  onEscapeMenu: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, private view: GameView) {}

  attach(): void {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window | Document, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type as string, fn as EventListener, opts);
      this.unsub.push(() => el.removeEventListener(type as string, fn as EventListener, opts));
    };
    on(c, 'pointerdown', (e: PointerEvent) => this.pointerDown(e));
    on(window, 'pointermove', (e: PointerEvent) => this.pointerMove(e));
    on(window, 'pointerup', (e: PointerEvent) => this.pointerUp(e));
    on(window, 'pointercancel', (e: PointerEvent) => this.pointerCancel(e));
    on(c, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(c, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(c, 'pointerleave', () => { this.mouse.inside = false; });
    on(c, 'pointerenter', () => { this.mouse.inside = true; });
    on(window, 'keydown', (e: KeyboardEvent) => this.keyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => { const k = keyFromEvent(e); this.keys.delete(k); if (this.modeKey?.key === k) this.modeKey = null; });
    on(window, 'blur', () => this.keys.clear());
    // fingers may zoom in past the desktop minimum: at the closest desktop step a unit on a phone is still
    // too small to tap, so the extra steps open whenever the touch HUD is on
    const cam = this.view.renderer.cam;
    cam.closeZoom = isTouchUI();
    this.unsub.push(subscribeTouchUI((v) => { cam.closeZoom = v; }));
  }
  detach(): void {
    // a hold still counting down would fire an order into a disposed view
    this.cancelLongPress();
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const s = getSettings();
    const cam = this.view.renderer.cam;
    const speed = s.scrollSpeed * dt * (cam.distance / 45);
    let dx = 0, dz = 0;
    const hk = s.hotkeys;
    if (this.modeKey && this.mode !== 'normal' && this.keys.has(this.modeKey.key) && performance.now() - this.modeKey.t >= MODE_KEY_HOLD_MS) {
      // "A" held for two seconds is somebody panning the camera, not lining up an attack-move
      this.modeKey = null;
      this.setMode('normal');
      this.onSelectionChanged?.();
    }
    if (!this.chatOpen) {
      if (this.keys.has(hk.scrollUp) || this.keys.has('arrowup')) dz += 1;
      if (this.keys.has(hk.scrollDown) || this.keys.has('arrowdown')) dz -= 1;
      if (this.keys.has(hk.scrollLeft) || this.keys.has('arrowleft')) dx -= 1;
      if (this.keys.has(hk.scrollRight) || this.keys.has('arrowright')) dx += 1;
    }
    if (s.edgeScroll && !isTouchUI() && this.mouse.inside && !this.drag && document.hasFocus()) {
      const r = this.canvas.getBoundingClientRect();
      const m = 14;
      if (this.mouse.x < r.left + m) dx -= 1; else if (this.mouse.x > r.right - m) dx += 1;
      if (this.mouse.y < r.top + m) dz += 1; else if (this.mouse.y > r.bottom - m) dz -= 1;
    }
    if (dx || dz) cam.pan(dx * speed, dz * speed);
    // hover
    this.updateHover();
  }

  private updateHover(): void {
    if (!this.mouse.inside) { this.hoverId = -1; return; }
    const g = this.view.renderer.screenToGround(this.mouse.x, this.mouse.y);
    this.hoverGround = g;
    this.hoverId = g ? this.pickEntity(this.mouse.x, this.mouse.y, false) : -1;
    if (this.buildLine && g) {
      this.updateBuildLine(g);
    } else if (this.mode === 'build' && this.buildType >= 0 && g) {
      const size = BUILDINGS[this.buildType as BuildingType].size;
      const cx = Math.floor(g.x - size / 2 + 0.5), cy = Math.floor(g.y - size / 2 + 0.5);
      this.placeOk = canPlaceBuilding(this.view.sim, this.buildType as BuildingType, cx, cy, this.view.mySlot);
      const rangeBonus = this.view.mySlot >= 0 ? this.view.sim.players[this.view.mySlot].upgrades[4] : 0;
      this.view.renderer.setPlacement(this.buildType, cx, cy, this.placeOk, rangeBonus);
    } else this.view.renderer.setPlacement(-1, 0, 0, false);
    const c = this.canvas;
    if (this.mode !== 'normal') c.style.cursor = 'crosshair';
    else if (this.hoverId >= 0) c.style.cursor = 'pointer';
    else c.style.cursor = 'default';
  }

  // ---------------------------------------------------------------- picking

  /** Nearest pickable entity under the cursor (screen-space test). */
  pickEntity(clientX: number, clientY: number, ownOnly: boolean): number {
    const sim = this.view.sim, w = sim.world, r = this.view.renderer;
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    const upp = r.cam.unitsPerPixel(rect.height);
    const out = { sx: 0, sy: 0, visible: false };
    let best = -1, bestD = 1e9;
    const persp = this.view.perspective;
    // a fingertip is a blunter pointer than a cursor: on touch everything answers from further away
    const minR = isTouchUI() ? TOUCH_PICK_RADIUS : 10;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      if (k !== Kind.Unit && k !== Kind.Building && k !== Kind.Mine) continue;
      if (ownOnly && w.owner[id] !== persp) continue;
      if (!r.revealAll && persp >= 0 && !sim.visibleTo(persp, id) && !(k !== Kind.Unit && sim.fog.isExplored(persp, w.x[id], w.y[id]))) continue;
      const x = toFloat(w.x[id]), z = toFloat(w.y[id]);
      let radiusPx: number, hPx: number;
      if (k === Kind.Unit) { radiusPx = Math.max(minR, (UNITS[w.type[id] as UnitType].radius * 1.6) / upp); hPx = (0.45) / upp; }
      else { radiusPx = Math.max(minR, (w.size[id] * 0.55) / upp); hPx = (k === Kind.Mine ? 0.5 : 1.0) / upp; }
      r.worldToScreen(x, z, r.heightAt(x, z) + (k === Kind.Unit ? 0.4 : 0.8), out);
      if (!out.visible) continue;
      const dx = out.sx - sx, dy = (out.sy - sy) * (k === Kind.Unit ? 0.8 : 1);
      const d = Math.hypot(dx, dy);
      // prefer units over buildings, lower y (closer to camera) wins ties
      const score = d - (k === Kind.Unit ? 6 : 0);
      if (d <= radiusPx + hPx * 0.3 && score < bestD) { bestD = score; best = id; }
    }
    return best;
  }

  private unitsInBox(box: DragBox): number[] {
    const sim = this.view.sim, w = sim.world, r = this.view.renderer;
    const rect = this.canvas.getBoundingClientRect();
    const x0 = Math.min(box.x0, box.x1) - rect.left, x1 = Math.max(box.x0, box.x1) - rect.left;
    const y0 = Math.min(box.y0, box.y1) - rect.top, y1 = Math.max(box.y0, box.y1) - rect.top;
    const out = { sx: 0, sy: 0, visible: false };
    const res: number[] = [];
    const persp = this.view.perspective;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Unit || w.owner[id] !== persp) continue;
      const x = toFloat(w.x[id]), z = toFloat(w.y[id]);
      r.worldToScreen(x, z, r.heightAt(x, z) + 0.4, out);
      if (out.visible && out.sx >= x0 && out.sx <= x1 && out.sy >= y0 && out.sy <= y1) res.push(id);
    }
    return res;
  }

  // ---------------------------------------------------------------- selection

  setSelection(ids: number[], additive = false): void {
    const w = this.view.sim.world;
    let next = additive ? [...this.selected] : [];
    for (const id of ids) {
      if (!w.alive[id]) continue;
      if (additive && next.includes(id)) { next = next.filter((x) => x !== id); continue; }
      next.push(id);
    }
    // a building or foreign entity can only be selected alone
    const own = next.filter((id) => w.owner[id] === this.view.perspective && w.kind[id] === Kind.Unit);
    if (own.length > 0) next = own;
    else if (next.length > 1) next = [next[next.length - 1]];
    this.selected = next.slice(0, 120);
    this.buildMenu = false;
    if (this.mode !== 'normal') this.setMode('normal');
    this.onSelectionChanged?.();
  }

  /** drop dead entities */
  pruneSelection(): void {
    const w = this.view.sim.world;
    const before = this.selected.length;
    this.selected = this.selected.filter((id) => w.alive[id]);
    for (const g of this.groups) for (let i = g.length - 1; i >= 0; i--) if (!w.alive[g[i]]) g.splice(i, 1);
    if (this.selected.length !== before) this.onSelectionChanged?.();
  }

  selectedUnits(): number[] {
    const w = this.view.sim.world;
    return this.selected.filter((id) => w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === this.view.perspective);
  }
  selectedBuilding(): number {
    const w = this.view.sim.world;
    const id = this.selected[0];
    return id !== undefined && w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === this.view.perspective ? id : -1;
  }
  selectedWorkers(): number[] {
    const w = this.view.sim.world;
    return this.selectedUnits().filter((id) => w.type[id] === UnitType.Worker);
  }

  selectAllOfTypeOnScreen(id: number): void {
    const sim = this.view.sim, w = sim.world, r = this.view.renderer;
    const type = w.type[id];
    const out = { sx: 0, sy: 0, visible: false };
    const res: number[] = [];
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    for (let o = 0; o < w.maxId; o++) {
      if (!w.alive[o] || w.kind[o] !== Kind.Unit || w.owner[o] !== this.view.perspective || w.type[o] !== type) continue;
      r.worldToScreen(toFloat(w.x[o]), toFloat(w.y[o]), 0.4, out);
      if (out.visible && out.sx >= 0 && out.sx <= cw && out.sy >= 0 && out.sy <= ch) res.push(o);
    }
    this.setSelection(res);
  }

  selectArmy(): void {
    const w = this.view.sim.world;
    const res: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === this.view.perspective && w.type[id] !== UnitType.Worker) res.push(id);
    this.setSelection(res);
    if (res.length) this.view.audio.play('select');
  }

  selectIdleWorker(): void {
    const w = this.view.sim.world;
    const idle: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === this.view.perspective && w.type[id] === UnitType.Worker && w.order[id] === 0) idle.push(id);
    if (idle.length === 0) return;
    const cur = this.selected.length === 1 ? idle.indexOf(this.selected[0]) : -1;
    const pick = idle[(cur + 1) % idle.length];
    this.setSelection([pick]);
    this.view.centerOn(toFloat(w.x[pick]), toFloat(w.y[pick]));
    this.view.audio.play('select');
  }

  setMode(mode: InputMode, buildType: BuildingType | -1 = -1, ability: AbilityId | -1 = -1): void {
    this.mode = mode;
    this.buildType = buildType;
    this.abilityId = ability;
    this.buildLine = null; this.buildLineCells = [];
    if (mode !== 'build') this.view.renderer.setPlacement(-1, 0, 0, false);
    this.onSelectionChanged?.();
  }

  // ---------------------------------------------------------------- pointer

  private pointerDown(e: PointerEvent): void {
    this.view.audio.unlock();
    notePointerType(e.pointerType);
    this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true;
    if (e.pointerType === 'touch') { this.touchDown(e); return; }
    if (this.chatOpen) return;
    // second button while the first is held: from here on the drag pans the camera (fast look-around),
    // no rotation, no selection box, no order on release
    if ((e.button === 0 && this.rmbDown) || (e.button === 2 && this.lmbDown)) {
      this.bothPan = { x: e.clientX, y: e.clientY };
      this.lmbDown = null; this.rmbDown = null; this.drag = null;
      this.buildLine = null; this.buildLineCells = [];
      return;
    }
    if (e.button === 0) {
      this.lmbDown = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.drag = null;
      // fences are laid in lines: remember where the drag starts
      if (this.mode === 'build' && this.buildType === BuildingType.Wall) {
        const g = this.view.renderer.screenToGround(e.clientX, e.clientY);
        if (g) { this.buildLine = { cx: Math.floor(g.x), cy: Math.floor(g.y) }; this.updateBuildLine(g); }
      }
    } else if (e.button === 2) {
      this.rmbDown = { x: e.clientX, y: e.clientY, panned: false };
    } else if (e.button === 1) {
      this.mmbDown = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  }

  private pointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') { this.touchMove(e); return; }
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    const cam = this.view.renderer.cam;
    if (this.bothPan) {
      const upp = cam.unitsPerPixel(this.canvas.clientHeight) * BOTH_BUTTON_PAN_SPEED;
      cam.pan(-(e.clientX - this.bothPan.x) * upp, (e.clientY - this.bothPan.y) * upp);
      this.bothPan = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.lmbDown && this.mode === 'normal') {
      if (this.drag || Math.hypot(e.clientX - this.lmbDown.x, e.clientY - this.lmbDown.y) > 6) {
        this.drag = { x0: this.lmbDown.x, y0: this.lmbDown.y, x1: e.clientX, y1: e.clientY };
      }
    }
    // right-drag walks the camera over the map, the same grab as the middle button; past the threshold the
    // press stops being an order, so a plain right-click still gives one
    if (this.rmbDown && getSettings().rmbPan) {
      const dx = e.clientX - this.rmbDown.x, dy = e.clientY - this.rmbDown.y;
      if (this.rmbDown.panned || Math.hypot(dx, dy) > RMB_PAN_THRESHOLD) {
        if (!this.rmbDown.panned) { this.rmbDown.panned = true; this.rmbDown.x = e.clientX; this.rmbDown.y = e.clientY; return; }
        const upp = cam.unitsPerPixel(this.canvas.clientHeight);
        cam.pan(-dx * upp, dy * upp);
        this.rmbDown.x = e.clientX; this.rmbDown.y = e.clientY;
      }
    }
    if (this.mmbDown) {
      const upp = cam.unitsPerPixel(this.canvas.clientHeight);
      cam.pan(-(e.clientX - this.mmbDown.x) * upp, (e.clientY - this.mmbDown.y) * upp);
      this.mmbDown = { x: e.clientX, y: e.clientY };
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') { this.touchUp(e); return; }
    if (this.bothPan && (e.button === 0 || e.button === 2)) {
      // letting go of either button ends the pan; the other one does nothing until pressed again
      this.bothPan = null;
      return;
    }
    if (e.button === 0 && this.lmbDown) {
      const down = this.lmbDown; this.lmbDown = null;
      const inside = this.isInsideCanvas(e.clientX, e.clientY);
      if (this.buildLine) { this.finishBuildLine(e); return; }
      if (this.drag) {
        const box = this.drag; this.drag = null;
        if (this.mode === 'normal') {
          const ids = this.unitsInBox(box);
          if (ids.length > 0) { this.setSelection(ids, e.shiftKey); this.view.audio.play('select'); }
          else if (!e.shiftKey && inside) this.setSelection([]);
        }
        return;
      }
      if (!inside) return;
      this.leftClick(e, performance.now() - down.t < 400);
    } else if (e.button === 2 && this.rmbDown) {
      const panned = this.rmbDown.panned; this.rmbDown = null;
      if (!panned && this.isInsideCanvas(e.clientX, e.clientY)) this.rightClick(e);
    } else if (e.button === 1) {
      this.mmbDown = null;
    }
  }

  // ---------------------------------------------------------------- touch

  /**
   * The finger vocabulary. There are no touch-only buttons on the HUD: every modifier a keyboard holds
   * down is a gesture instead, and each one is disambiguated by what the hand does next, never by a mode
   * the player has to remember they are in.
   *
   *   tap            your own unit or building -> select it; anywhere else -> the order the right button
   *                  would give (move, attack, gather, repair, rally)
   *   double tap     a unit -> every unit of its kind on screen
   *   drag           move the camera
   *   press and hold -> then drag  -> drag out a selection box
   *                  -> then lift  -> the order, on whatever is under the finger: this is how you repair
   *                     or garrison your own building, which a plain tap would have selected
   *   two fingers    pinch to zoom (about the point between the fingers), twist to rotate, slide to move the camera
   *   two-finger tap the same order, queued behind the current one - waypoints, without a Shift key
   *
   * The two selection shortcuts that used to need F1/F2 hang off HUD counters that were already there:
   * the population badge selects the army, the idle-worker badge cycles idle workers.
   */
  private touchDown(e: PointerEvent): void {
    if (!this.askedFullscreen) { this.askedFullscreen = true; if (isSmallScreen()) enterGameFullscreen(); }
    if (this.chatOpen) return;
    const pt: TouchPt = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, panX: e.clientX, panY: e.clientY };
    this.touches.push(pt);
    if (this.touches.length === 2) {
      // a second finger is always the camera: whatever the first one had started is abandoned, unfinished
      this.cancelLongPress();
      this.drag = null;
      this.clearBuildLine();
      this.gesture = 'pinch';
      this.startPinch();
      return;
    }
    if (this.touches.length > 2) { this.cancelLongPress(); return; }
    if (this.mode === 'build' && this.buildType >= 0) {
      this.gesture = 'place';
      const g = this.view.renderer.screenToGround(pt.x, pt.y);
      if (g && this.buildType === BuildingType.Wall) { this.buildLine = { cx: Math.floor(g.x), cy: Math.floor(g.y) }; this.updateBuildLine(g); }
      this.updateHover(); // the ghost appears under the finger before it is lifted
      return;
    }
    this.gesture = 'tap';
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = 0;
      if (this.gesture !== 'tap') return;
      // The hold is now armed but nothing has happened yet: a drag from here draws a box, a lift gives the
      // order. The buzz and the ring on the ground are what say the finger has been felt.
      this.gesture = 'hold';
      buzz();
      const g = this.view.renderer.screenToGround(pt.x, pt.y);
      if (g) this.view.renderer.addMarker(g.x, g.y, 0xd9b662);
    }, LONG_PRESS_MS);
  }

  private touchMove(e: PointerEvent): void {
    const pt = this.touches.find((t) => t.id === e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    if (this.gesture === 'pinch') { this.updatePinch(); return; }
    if (this.touches.length !== 1) return;
    const cam = this.view.renderer.cam;
    const far = Math.hypot(pt.x - pt.x0, pt.y - pt.y0) > TOUCH_SLOP;
    if (far && this.gesture === 'tap') {
      this.cancelLongPress();
      this.gesture = 'pan';
      pt.panX = pt.x; pt.panY = pt.y;
    } else if (far && this.gesture === 'hold') {
      this.gesture = 'box';
    }
    if (this.gesture === 'pan') {
      const upp = cam.unitsPerPixel(this.canvas.clientHeight);
      cam.pan(-(pt.x - pt.panX) * upp, (pt.y - pt.panY) * upp);
      pt.panX = pt.x; pt.panY = pt.y;
    } else if (this.gesture === 'box') {
      this.drag = { x0: pt.x0, y0: pt.y0, x1: pt.x, y1: pt.y };
    } else if (this.gesture === 'place' && this.buildLine) {
      const g = this.view.renderer.screenToGround(pt.x, pt.y);
      if (g) this.updateBuildLine(g);
    }
  }

  private touchUp(e: PointerEvent): void {
    const i = this.touches.findIndex((t) => t.id === e.pointerId);
    if (i < 0) return;
    const pt = this.touches[i];
    this.touches.splice(i, 1);
    this.cancelLongPress();
    if (this.gesture === 'pinch') {
      const p = this.pinch;
      // both fingers down and straight back up, with the camera barely touched: a queued order
      if (p && !p.tapped && this.touches.length === 1 && performance.now() - p.t0 < TWO_FINGER_TAP_MS && p.moved < TOUCH_SLOP) {
        p.tapped = true;
        this.rightClick({ clientX: p.cx, clientY: p.cy, shiftKey: true });
      }
      if (this.touches.length === 1) {
        // one finger left over from a pinch keeps moving the camera rather than becoming a stray tap
        const rest = this.touches[0];
        rest.panX = rest.x; rest.panY = rest.y;
        this.gesture = 'pan';
        this.pinch = null;
      } else if (this.touches.length === 0) { this.gesture = 'none'; this.pinch = null; }
      return;
    }
    if (this.touches.length > 0) return;
    const g = this.gesture;
    this.gesture = 'none';
    this.mouse.inside = false;
    const ev: ClickLike = { clientX: pt.x, clientY: pt.y, shiftKey: false };
    const inside = this.isInsideCanvas(pt.x, pt.y);
    if (g === 'box') {
      const box = this.drag; this.drag = null;
      if (box && this.mode === 'normal') {
        const ids = this.unitsInBox(box);
        if (ids.length > 0) { this.setSelection(ids); this.view.audio.play('select'); }
        else this.setSelection([]);
      }
      this.onSelectionChanged?.();
      return;
    }
    if (g === 'place') {
      if (this.buildLine) this.finishBuildLine(ev);
      else if (inside) this.leftClick(ev, true);
      else this.clearBuildLine();
      return;
    }
    // held still and lifted: the order goes where the finger was, whatever is standing there
    if (g === 'hold' && inside) { this.rightClick(ev); return; }
    if (g === 'tap' && inside) this.handleTap(ev);
  }

  private pointerCancel(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    const i = this.touches.findIndex((t) => t.id === e.pointerId);
    if (i >= 0) this.touches.splice(i, 1);
    this.cancelLongPress();
    if (this.touches.length === 0) { this.gesture = 'none'; this.drag = null; this.pinch = null; this.mouse.inside = false; }
  }

  /** A tap in the normal mode: own things get selected, everything else gets the smart order. */
  private handleTap(ev: ClickLike): void {
    if (this.mode !== 'normal') { this.leftClick(ev, true); return; }
    const w = this.view.sim.world;
    const id = this.pickEntity(ev.clientX, ev.clientY, false);
    const own = id >= 0 && w.owner[id] === this.view.perspective && (w.kind[id] === Kind.Unit || w.kind[id] === Kind.Building);
    const now = performance.now();
    if (own) {
      if (this.lastTap.id === id && now - this.lastTap.t < DOUBLE_TAP_MS && w.kind[id] === Kind.Unit) this.selectAllOfTypeOnScreen(id);
      else this.setSelection([id]);
      this.view.audio.play('select');
    } else if (this.selectedUnits().length > 0 || this.selectedBuilding() >= 0) {
      // an army is out and the finger landed on open ground or on someone else's: that is an order
      this.rightClick(ev);
    } else if (id >= 0) {
      this.setSelection([id]);
      this.view.audio.play('select');
    } else this.setSelection([]);
    this.lastTap = { t: now, id };
  }

  private startPinch(): void {
    const [a, b] = this.touches;
    this.pinch = {
      dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x),
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, twisting: false, twist: 0,
      t0: performance.now(), moved: 0, tapped: false,
    };
  }

  /** Two fingers do all three camera moves at once: spread zooms, twist rotates, sliding pans. */
  private updatePinch(): void {
    const p = this.pinch;
    if (!p || this.touches.length < 2) return;
    const [a, b] = this.touches;
    p.moved = Math.max(p.moved, Math.hypot(a.x - a.x0, a.y - a.y0), Math.hypot(b.x - b.x0, b.y - b.y0));
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const cam = this.view.renderer.cam;
    const upp = cam.unitsPerPixel(this.canvas.clientHeight);
    cam.pan(-(cx - p.cx) * upp, (cy - p.cy) * upp);
    if (dist > 20 && p.dist > 20) {
      // zoom about the midpoint of the fingers, so the spot being zoomed onto does not slide away
      const rect = this.canvas.getBoundingClientRect();
      cam.zoomAt(p.dist / dist, ((cx - rect.left) / rect.width) * 2 - 1, 1 - ((cy - rect.top) / rect.height) * 2);
    }
    // A twist only starts once the hands clearly mean it, or every pinch would shake the compass. The
    // deadzone is on the turn accumulated since the fingers landed, never on one frame's delta - fingers
    // move a fraction of a degree per frame and would never cross a per-frame threshold.
    let d = angle - p.angle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    p.twist += d;
    if (!p.twisting && Math.abs(p.twist) > TWIST_DEADZONE) {
      p.twisting = true;
      cam.rotate(p.twist - Math.sign(p.twist) * TWIST_DEADZONE); // pick up where the deadzone left off
    } else if (p.twisting) cam.rotate(d);
    p.dist = dist; p.angle = angle; p.cx = cx; p.cy = cy;
  }

  private cancelLongPress(): void {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = 0; }
  }

  private clearBuildLine(): void {
    this.buildLine = null; this.buildLineCells = [];
    this.view.renderer.setPlacementLine(BuildingType.Wall, []);
  }

  // ---------------------------------------------------------------- fence lines

  /** Cells from the drag start to `g`, snapped to the longer axis so the fence comes out straight. */
  private updateBuildLine(g: { x: number; y: number }): void {
    const a = this.buildLine!;
    const ex = Math.floor(g.x), ey = Math.floor(g.y);
    const dx = ex - a.cx, dy = ey - a.cy;
    const cells: { cx: number; cy: number; ok: boolean }[] = [];
    const n = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), FENCE_LINE_MAX);
    const sx = Math.sign(dx), sy = Math.sign(dy);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    for (let i = 0; i <= n; i++) {
      const cx = horizontal ? a.cx + sx * i : a.cx, cy = horizontal ? a.cy : a.cy + sy * i;
      cells.push({ cx, cy, ok: canPlaceBuilding(this.view.sim, BuildingType.Wall, cx, cy, this.view.mySlot) });
    }
    this.buildLineCells = cells;
    this.view.renderer.setPlacementLine(BuildingType.Wall, cells);
  }

  /** Order every placeable cell of the line, as many as the gold allows; the first is immediate, the rest queue. */
  private finishBuildLine(e: ClickLike): void {
    const cells = this.buildLineCells.filter((c) => c.ok);
    this.buildLine = null; this.buildLineCells = [];
    const workers = this.selectedWorkers();
    if (workers.length === 0 || this.view.mySlot < 0) { this.setMode('normal'); return; }
    const cost = BUILDINGS[BuildingType.Wall].cost;
    let budget = Math.floor(this.view.sim.players[this.view.mySlot].gold / cost);
    let issued = 0;
    for (const c of cells) {
      if (budget <= 0) break;
      const ok = this.view.issue({ type: CommandType.Build, player: this.view.mySlot, ids: workers, v: BuildingType.Wall, x: fp(c.cx), y: fp(c.cy), queue: e.shiftKey || issued > 0 });
      if (!ok) continue;
      budget--; issued++;
      this.view.renderer.addMarker(c.cx + 0.5, c.cy + 0.5, 0x7fe08a);
    }
    if (issued > 0) this.view.audio.play('build');
    if (!e.shiftKey) this.setMode('normal');
    else this.view.renderer.setPlacement(-1, 0, 0, false);
  }

  private isInsideCanvas(x: number, y: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  private leftClick(e: ClickLike, _quick: boolean): void {
    const g = this.view.renderer.screenToGround(e.clientX, e.clientY);
    const sim = this.view.sim, w = sim.world;
    if (this.mode === 'build' && this.buildType >= 0) {
      if (!g) return;
      const size = BUILDINGS[this.buildType as BuildingType].size;
      const cx = Math.floor(g.x - size / 2 + 0.5), cy = Math.floor(g.y - size / 2 + 0.5);
      const workers = this.selectedWorkers();
      if (workers.length === 0) { this.setMode('normal'); return; }
      const ok = this.view.issue({ type: CommandType.Build, player: this.view.mySlot, ids: workers, v: this.buildType, x: fp(cx), y: fp(cy), queue: e.shiftKey });
      if (ok) { this.view.renderer.addMarker(cx + size / 2, cy + size / 2, 0x7fe08a); this.view.audio.play('build'); }
      if (!e.shiftKey) this.setMode('normal');
      return;
    }
    if (this.mode === 'attackMove') {
      const target = this.pickEntity(e.clientX, e.clientY, false);
      const units = this.selectedUnits();
      if (target >= 0 && w.owner[target] >= 0 && !sim.sameTeam(w.owner[target], this.view.mySlot)) this.view.issue({ type: CommandType.Attack, player: this.view.mySlot, ids: units, target, queue: e.shiftKey });
      else if (g) { this.view.issue({ type: CommandType.AttackMove, player: this.view.mySlot, ids: units, x: fp(g.x), y: fp(g.y), queue: e.shiftKey }); this.view.renderer.addMarker(g.x, g.y, 0xff6b6b); }
      this.view.audio.play('order');
      if (!e.shiftKey) this.setMode('normal');
      return;
    }
    if (this.mode === 'patrol') {
      if (g) { this.view.issue({ type: CommandType.Patrol, player: this.view.mySlot, ids: this.selectedUnits(), x: fp(g.x), y: fp(g.y), queue: e.shiftKey }); this.view.renderer.addMarker(g.x, g.y, 0x7fb8ff); this.view.audio.play('order'); }
      if (!e.shiftKey) this.setMode('normal');
      return;
    }
    if (this.mode === 'ability' && this.abilityId >= 0) {
      if (g) {
        const target = this.pickEntity(e.clientX, e.clientY, false);
        const tx = target >= 0 ? toFloat(w.x[target]) : g.x, ty = target >= 0 ? toFloat(w.y[target]) : g.y;
        const ok = this.view.issue({ type: CommandType.Ability, player: this.view.mySlot, ids: this.selectedUnits(), v: this.abilityId, x: fp(tx), y: fp(ty) });
        if (ok) this.view.renderer.addMarker(tx, ty, 0xa0d8ff);
      }
      this.setMode('normal');
      return;
    }
    if (this.mode === 'dismantle') {
      const target = this.pickEntity(e.clientX, e.clientY, false);
      const workers = this.selectedWorkers();
      if (target >= 0 && w.kind[target] === Kind.Building && w.owner[target] >= 0 && sim.sameTeam(w.owner[target], this.view.mySlot) && workers.length) {
        const ok = this.view.issue({ type: CommandType.Dismantle, player: this.view.mySlot, ids: workers, target, queue: e.shiftKey });
        if (ok) { this.view.renderer.addMarker(toFloat(w.x[target]), toFloat(w.y[target]), 0xffb060); this.view.audio.play('order'); }
      }
      if (!e.shiftKey) this.setMode('normal');
      return;
    }
    if (this.mode === 'rally') {
      const b = this.selectedBuilding();
      const rg = this.rallyPoint(e);
      if (rg && b >= 0) { this.view.issue({ type: CommandType.SetRally, player: this.view.mySlot, ids: [b], x: fp(rg.x), y: fp(rg.y) }); this.view.renderer.addMarker(rg.x, rg.y, 0xffe08a); }
      this.setMode('normal');
      return;
    }
    // normal: select
    const id = this.pickEntity(e.clientX, e.clientY, false);
    const now = performance.now();
    if (id >= 0) {
      if (this.lastClick.id === id && now - this.lastClick.t < 350 && w.kind[id] === Kind.Unit && w.owner[id] === this.view.perspective) {
        this.selectAllOfTypeOnScreen(id);
      } else this.setSelection([id], e.shiftKey);
      this.view.audio.play('select');
    } else if (!e.shiftKey) this.setSelection([]);
    this.lastClick = { t: now, id };
  }

  /**
   * The rally point under the cursor, snapped onto a friendly building or a gold vein when one is clicked:
   * a rally on a site, a mine, a damaged building or a vein is the first job of every worker trained there.
   */
  private rallyPoint(e: ClickLike): { x: number; y: number } | null {
    const sim = this.view.sim, w = sim.world;
    const id = this.pickEntity(e.clientX, e.clientY, false);
    if (id >= 0 && (w.kind[id] === Kind.Mine || (w.kind[id] === Kind.Building && w.owner[id] >= 0 && sim.sameTeam(w.owner[id], this.view.mySlot)))) {
      return { x: toFloat(w.x[id]), y: toFloat(w.y[id]) };
    }
    return this.view.renderer.screenToGround(e.clientX, e.clientY);
  }

  private rightClick(e: ClickLike): void {
    if (this.mode !== 'normal') { this.setMode('normal'); this.buildMenu = false; this.onSelectionChanged?.(); return; }
    const sim = this.view.sim, w = sim.world;
    const me = this.view.mySlot;
    const g = this.view.renderer.screenToGround(e.clientX, e.clientY);
    const units = this.selectedUnits();
    const building = this.selectedBuilding();
    if (units.length === 0 && building >= 0) {
      const rg = this.rallyPoint(e);
      if (rg) { this.view.issue({ type: CommandType.SetRally, player: me, ids: [building], x: fp(rg.x), y: fp(rg.y) }); this.view.renderer.addMarker(rg.x, rg.y, 0xffe08a); this.view.audio.play('order'); }
      return;
    }
    if (units.length === 0) return;
    const target = this.pickEntity(e.clientX, e.clientY, false);
    const queue = e.shiftKey;
    let cmd: Command | null = null;
    let marker = 0x7fe08a;
    if (target >= 0 && target !== undefined) {
      const k = w.kind[target], owner = w.owner[target];
      const workers = units.filter((u) => w.type[u] === UnitType.Worker);
      if (k === Kind.Mine) { if (workers.length) cmd = { type: CommandType.Gather, player: me, ids: workers, target, queue }; marker = 0xffe08a; }
      else if (owner >= 0 && !sim.sameTeam(owner, me)) { cmd = { type: CommandType.Attack, player: me, ids: units, target, queue }; marker = 0xff6b6b; }
      else if (k === Kind.Building && owner === me && workers.length && garrisonCapacity(w.type[target] as BuildingType) > 0 && w.state[target] === BuildingState.Complete && w.carry[target] < garrisonCapacity(w.type[target] as BuildingType)) {
        cmd = { type: CommandType.Garrison, player: me, ids: workers, target, queue }; marker = 0xffe08a;
      }
      else if (k === Kind.Building && owner >= 0 && sim.sameTeam(owner, me) && workers.length && (w.hp[target] < w.maxHp[target] || w.state[target] === BuildingState.Constructing)) {
        cmd = { type: CommandType.Repair, player: me, ids: workers, target, queue }; marker = 0xffe08a;
      }
    }
    if (!cmd && g) cmd = { type: CommandType.Move, player: me, ids: units, x: fp(g.x), y: fp(g.y), queue };
    if (cmd) {
      const ok = this.view.issue(cmd);
      if (ok) {
        const mx = cmd.x !== undefined ? toFloat(cmd.x) : toFloat(w.x[target]), my = cmd.y !== undefined ? toFloat(cmd.y) : toFloat(w.y[target]);
        this.view.renderer.addMarker(mx, my, marker);
        this.view.audio.play('order');
      }
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const cam = this.view.renderer.cam;
    if (e.ctrlKey) cam.tiltBy(e.deltaY > 0 ? 5 : -5);
    else cam.zoom(e.deltaY > 0 ? 1 : -1);
  }

  // ---------------------------------------------------------------- keyboard

  private keyDown(e: KeyboardEvent): void {
    const key = keyFromEvent(e); // physical key: the same bindings on every keyboard layout
    if (this.chatOpen) {
      if (e.key === 'Escape') { this.chatOpen = false; this.onToggleChat?.(false); }
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (e.key === 'Enter') { this.chatOpen = true; this.onToggleChat?.(true); e.preventDefault(); return; }
    this.keys.add(key);
    const hk = getSettings().hotkeys;
    const cam = this.view.renderer.cam;
    if (e.key === 'Escape') {
      if (this.mode !== 'normal' || this.buildMenu) { this.setMode('normal'); this.buildMenu = false; this.onSelectionChanged?.(); }
      else this.onEscapeMenu?.();
      e.preventDefault(); return;
    }
    if (key === hk.rotateLeft) { cam.rotate(THREE_DEG15); return; }
    if (key === hk.rotateRight) { cam.rotate(-THREE_DEG15); return; }
    // auto-repeat of a held key scrolls the camera (see update) but must not re-fire orders or re-enter modes
    if (e.repeat) { if (isScrollKey(key, hk)) e.preventDefault(); return; }
    if (key === hk.resetCamera) { cam.reset(); e.preventDefault(); return; }
    if (key === hk.selectArmy) { this.selectArmy(); e.preventDefault(); return; }
    if (key === hk.idleWorker) { this.selectIdleWorker(); e.preventDefault(); return; }
    // control groups
    if (/^[0-9]$/.test(key)) {
      const n = Number(key);
      if (e.ctrlKey || e.metaKey) { this.groups[n] = this.selectedUnits().length ? this.selectedUnits() : this.selected.slice(); e.preventDefault(); return; }
      if (e.shiftKey) { for (const id of this.selectedUnits()) if (!this.groups[n].includes(id)) this.groups[n].push(id); return; }
      const g = this.groups[n].filter((id) => this.view.sim.world.alive[id]);
      if (g.length) {
        const now = performance.now();
        if (this.lastGroupKey.k === n && now - this.lastGroupKey.t < 350) {
          const w = this.view.sim.world;
          let sx = 0, sy = 0; for (const id of g) { sx += toFloat(w.x[id]); sy += toFloat(w.y[id]); }
          this.view.centerOn(sx / g.length, sy / g.length);
        } else this.setSelection(g);
        this.lastGroupKey = { k: n, t: now };
      }
      return;
    }
    if (this.view.mySlot < 0) return;
    // panel hotkeys: delegate to the view's panel (context-aware)
    const handled = this.view.panelHotkey(key);
    if (handled) e.preventDefault();
    // a mode entered from a camera key (A = attack-move but also scroll-left) is provisional while the key is held
    this.modeKey = handled && this.mode !== 'normal' && isScrollKey(key, hk) ? { key, t: performance.now() } : null;
  }
}

function isScrollKey(key: string, hk: Record<string, string>): boolean {
  return key === hk.scrollUp || key === hk.scrollDown || key === hk.scrollLeft || key === hk.scrollRight || key.startsWith('arrow');
}

const THREE_DEG15 = (15 * Math.PI) / 180;
/** a finger has to travel this far before a tap turns into a drag */
const TOUCH_SLOP = 10;
/** a tap this many pixels from a unit still lands on it (a fingertip, not a cursor) */
const TOUCH_PICK_RADIUS = 22;
/** hold this long without moving and the finger gives the order the right button would */
const LONG_PRESS_MS = 420;
/** two taps inside this window: all units of that kind on screen, or the camera on that group */
const DOUBLE_TAP_MS = 400;
/** a two-finger twist under this much is treated as an unsteady pinch, not an attempt to rotate */
const TWIST_DEADZONE = 0.14;
/** two fingers down and back up inside this window, having barely moved, queue an order */
const TWO_FINGER_TAP_MS = 300;
/** holding a mode key this long means the player is scrolling the camera, and the mode is dropped */
const MODE_KEY_HOLD_MS = 2000;
/** longest fence line one drag can lay */
const FENCE_LINE_MAX = 40;
/** both-button drag pans this much faster than a middle-button drag (world units per pixel multiplier) */
const BOTH_BUTTON_PAN_SPEED = 2;
/** pixels a right-drag has to travel before it becomes a camera pan instead of an order on release */
const RMB_PAN_THRESHOLD = 8;

export const ABILITY_TARGETED = (a: AbilityId) => ABILITIES[a].targeted;
export const UNIT_NAMES = Object.values(UNITS).map((u) => u.name);
