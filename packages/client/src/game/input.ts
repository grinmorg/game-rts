import {
  ABILITIES, AbilityId, BUILDINGS, BuildingState, BuildingType, Command, CommandType, Kind, MINE_CAPACITY, UNITS, UnitType, canPlaceBuilding, fp, toFloat,
} from '@warlets/sim';
import { getSettings } from '../settings';
import type { GameView } from './view';

export type InputMode = 'normal' | 'attackMove' | 'patrol' | 'build' | 'ability' | 'rally';

export interface DragBox { x0: number; y0: number; x1: number; y1: number }

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
  private mouse = { x: 0, y: 0, inside: false };
  private lmbDown: { x: number; y: number; t: number } | null = null;
  private rmbDown: { x: number; y: number; rotated: boolean } | null = null;
  private mmbDown: { x: number; y: number } | null = null;
  private lastClick = { t: 0, id: -1 };
  private lastGroupKey = { k: -1, t: 0 };
  private unsub: (() => void)[] = [];
  private placeOk = false;
  /** fence drag: cell where the button went down, and the current line of ghost cells */
  private buildLine: { cx: number; cy: number } | null = null;
  private buildLineCells: { cx: number; cy: number; ok: boolean }[] = [];
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
    on(c, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(c, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(c, 'pointerleave', () => { this.mouse.inside = false; });
    on(c, 'pointerenter', () => { this.mouse.inside = true; });
    on(window, 'keydown', (e: KeyboardEvent) => this.keyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); });
    on(window, 'blur', () => this.keys.clear());
  }
  detach(): void { for (const u of this.unsub) u(); this.unsub = []; }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const s = getSettings();
    const cam = this.view.renderer.cam;
    const speed = s.scrollSpeed * dt * (cam.distance / 45);
    let dx = 0, dz = 0;
    const hk = s.hotkeys;
    if (!this.chatOpen) {
      if (this.keys.has(hk.scrollUp) || this.keys.has('arrowup')) dz += 1;
      if (this.keys.has(hk.scrollDown) || this.keys.has('arrowdown')) dz -= 1;
      if (this.keys.has(hk.scrollLeft) || this.keys.has('arrowleft')) dx -= 1;
      if (this.keys.has(hk.scrollRight) || this.keys.has('arrowright')) dx += 1;
    }
    if (s.edgeScroll && this.mouse.inside && !this.drag && document.hasFocus()) {
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
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      if (k !== Kind.Unit && k !== Kind.Building && k !== Kind.Mine) continue;
      if (ownOnly && w.owner[id] !== persp) continue;
      if (!r.revealAll && persp >= 0 && !sim.visibleTo(persp, id) && !(k !== Kind.Unit && sim.fog.isExplored(persp, w.x[id], w.y[id]))) continue;
      const x = toFloat(w.x[id]), z = toFloat(w.y[id]);
      let radiusPx: number, hPx: number;
      if (k === Kind.Unit) { radiusPx = Math.max(10, (UNITS[w.type[id] as UnitType].radius * 1.6) / upp); hPx = (0.45) / upp; }
      else { radiusPx = (w.size[id] * 0.55) / upp; hPx = (k === Kind.Mine ? 0.5 : 1.0) / upp; }
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
    this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true;
    if (this.chatOpen) return;
    if (e.button === 0) {
      this.lmbDown = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.drag = null;
      // fences are laid in lines: remember where the drag starts
      if (this.mode === 'build' && this.buildType === BuildingType.Wall) {
        const g = this.view.renderer.screenToGround(e.clientX, e.clientY);
        if (g) { this.buildLine = { cx: Math.floor(g.x), cy: Math.floor(g.y) }; this.updateBuildLine(g); }
      }
    } else if (e.button === 2) {
      this.rmbDown = { x: e.clientX, y: e.clientY, rotated: false };
    } else if (e.button === 1) {
      this.mmbDown = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  }

  private pointerMove(e: PointerEvent): void {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    const cam = this.view.renderer.cam;
    if (this.lmbDown && this.mode === 'normal') {
      if (this.drag || Math.hypot(e.clientX - this.lmbDown.x, e.clientY - this.lmbDown.y) > 6) {
        this.drag = { x0: this.lmbDown.x, y0: this.lmbDown.y, x1: e.clientX, y1: e.clientY };
      }
    }
    if (this.rmbDown && getSettings().rmbRotate) {
      const dx = e.clientX - this.rmbDown.x;
      if (this.rmbDown.rotated || Math.abs(dx) > 8) {
        if (!this.rmbDown.rotated) { this.rmbDown.rotated = true; this.rmbDown.x = e.clientX; return; }
        cam.rotate(-dx * 0.006);
        this.rmbDown.x = e.clientX;
      }
    }
    if (this.mmbDown) {
      const upp = cam.unitsPerPixel(this.canvas.clientHeight);
      cam.pan(-(e.clientX - this.mmbDown.x) * upp, (e.clientY - this.mmbDown.y) * upp);
      this.mmbDown = { x: e.clientX, y: e.clientY };
    }
  }

  private pointerUp(e: PointerEvent): void {
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
      const rotated = this.rmbDown.rotated; this.rmbDown = null;
      if (!rotated && this.isInsideCanvas(e.clientX, e.clientY)) this.rightClick(e);
    } else if (e.button === 1) {
      this.mmbDown = null;
    }
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
  private finishBuildLine(e: PointerEvent): void {
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

  private leftClick(e: PointerEvent, _quick: boolean): void {
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
    if (this.mode === 'rally') {
      const b = this.selectedBuilding();
      if (g && b >= 0) { this.view.issue({ type: CommandType.SetRally, player: this.view.mySlot, ids: [b], x: fp(g.x), y: fp(g.y) }); this.view.renderer.addMarker(g.x, g.y, 0xffe08a); }
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

  private rightClick(e: PointerEvent): void {
    if (this.mode !== 'normal') { this.setMode('normal'); this.buildMenu = false; this.onSelectionChanged?.(); return; }
    const sim = this.view.sim, w = sim.world;
    const me = this.view.mySlot;
    const g = this.view.renderer.screenToGround(e.clientX, e.clientY);
    const units = this.selectedUnits();
    const building = this.selectedBuilding();
    if (units.length === 0 && building >= 0) {
      if (g) { this.view.issue({ type: CommandType.SetRally, player: me, ids: [building], x: fp(g.x), y: fp(g.y) }); this.view.renderer.addMarker(g.x, g.y, 0xffe08a); this.view.audio.play('order'); }
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
      else if (k === Kind.Building && owner === me && workers.length && w.type[target] === BuildingType.Mine && w.state[target] === BuildingState.Complete && w.carry[target] < MINE_CAPACITY) {
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
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
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
    if (e.key === hk.resetCamera) { cam.reset(); e.preventDefault(); return; }
    if (e.key === hk.selectArmy) { this.selectArmy(); e.preventDefault(); return; }
    if (e.key === hk.idleWorker) { this.selectIdleWorker(); e.preventDefault(); return; }
    // control groups
    if (/^[0-9]$/.test(e.key)) {
      const n = Number(e.key);
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
  }
}

const THREE_DEG15 = (15 * Math.PI) / 180;
/** longest fence line one drag can lay */
const FENCE_LINE_MAX = 40;

export const ABILITY_TARGETED = (a: AbilityId) => ABILITIES[a].targeted;
export const UNIT_NAMES = Object.values(UNITS).map((u) => u.name);
