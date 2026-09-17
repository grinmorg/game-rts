import {
  CommandType, Kind, MatchSetup, PLAYER_COLORS, PlayerSetup, SIM_VERSION, UnitType, fp, stressMapId,
} from '@rookfall/sim';
import { LocalSession } from './session';
import type { GameView } from './view';

/**
 * Load-test harness, reached through `?stress=<players>,<units per player>,<map size>[,bots]`.
 * Starts a local match on a `stress:` map, hands every player an army next to its castle and sends all of
 * them at the middle of the map. `window.__stress` exposes the view and rolling frame/tick statistics so a
 * script (or the console) can read them - the HUD's fps counter averages over half a second and hides hitches.
 */
export interface StressParams { players: number; units: number; size: number; bots: boolean }

export function parseStressParam(raw: string | null): StressParams | null {
  if (!raw) return null;
  const parts = raw.split(',');
  const players = Math.max(2, Number(parts[0]) || 6);
  const units = Math.max(0, Number(parts[1]) || 60);
  const size = Math.max(48, Number(parts[2]) || 128);
  return { players, units, size, bots: parts[3] === 'bots' };
}

export function startStress(p: StressParams): LocalSession {
  const players: PlayerSetup[] = [];
  for (let i = 0; i < p.players; i++) {
    players.push({ slot: i, team: i % 2, name: i === 0 ? 'You' : `P${i + 1}`, isBot: p.bots && i > 0, difficulty: 2, color: PLAYER_COLORS[i % PLAYER_COLORS.length] });
  }
  const setup: MatchSetup = { seed: 12345, mapId: stressMapId(p.players, p.size), players, version: SIM_VERSION, speed: 1 };
  const session = new LocalSession(setup, 0);
  const sim = session.sim, w = sim.world;
  // an army per player in a block beside the castle, spread over free cells
  const side = Math.ceil(Math.sqrt(p.units)) + 2;
  for (let pl = 0; pl < p.players; pl++) {
    const s = sim.players[pl];
    const toCx = Math.sign(sim.map.w / 2 - s.startX) || 1, toCy = Math.sign(sim.map.h / 2 - s.startY) || 1;
    let n = 0;
    for (let r = 2; r < side + 8 && n < p.units; r++) {
      for (let dy = -r; dy <= r && n < p.units; dy++) for (let dx = -r; dx <= r && n < p.units; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = s.startX + dx * toCx + toCx * 2, cy = s.startY + dy * toCy + toCy * 2;
        if (cx < 3 || cy < 3 || cx >= sim.map.w - 3 || cy >= sim.map.h - 3 || sim.path.isBlockedCell(cx, cy)) continue;
        const type = n % 4 === 0 ? UnitType.Archer : n % 9 === 0 ? UnitType.Catapult : n % 6 === 0 ? UnitType.Cavalry : UnitType.Soldier;
        if (sim.spawnUnit(pl, type, fp(cx + 0.5), fp(cy + 0.5)) >= 0) n++;
      }
    }
  }
  // everyone marches on the centre (the order is delayed two ticks like any other)
  const mx = fp(sim.map.w / 2), my = fp(sim.map.h / 2);
  for (let pl = 0; pl < p.players; pl++) {
    const ids: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === pl && w.type[id] !== UnitType.Worker) ids.push(id);
    for (let i = 0; i < ids.length; i += 200) session.submit({ type: CommandType.AttackMove, player: pl, ids: ids.slice(i, i + 200), x: mx, y: my });
  }
  return session;
}

export interface PerfStats {
  fps: number;
  frame: { p50: number; p95: number; max: number; n: number };
  tick: { p50: number; p95: number; max: number; n: number };
  entities: number; units: number; drawCalls: number; tick_: number;
}

/** percentiles over a ring buffer of samples (ms) */
export function summarize(buf: Float32Array, n: number): { p50: number; p95: number; max: number; n: number } {
  const len = Math.min(n, buf.length);
  if (len === 0) return { p50: 0, p95: 0, max: 0, n: 0 };
  const a = Array.from(buf.subarray(0, len)).sort((x, y) => x - y);
  return { p50: a[len >> 1], p95: a[Math.min(len - 1, Math.floor(len * 0.95))], max: a[len - 1], n: len };
}

export function installStressHook(view: GameView, session: LocalSession): void {
  const sim = view.sim, w = sim.world;
  // nobody dies: the armies keep fighting at full strength, so the load stays what was asked for
  const prev = session.onStep;
  session.onStep = (events) => {
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit) w.hp[id] = w.maxHp[id];
    prev?.(events);
  };
  (window as unknown as { __stress: unknown }).__stress = {
    view, sim, session,
    /** clear the rolling buffers, then read after a while */
    reset: () => { view.perfReset(); session.perfReset(); },
    stats: (): PerfStats => {
      let entities = 0, units = 0;
      for (let id = 0; id < w.maxId; id++) if (w.alive[id]) { entities++; if (w.kind[id] === Kind.Unit) units++; }
      const frame = summarize(view.frameMs, view.frameN);
      return { fps: frame.p50 > 0 ? Math.round(1000 / frame.p50) : 0, frame, tick: summarize(session.stepMs, session.stepN), entities, units, drawCalls: view.renderer.drawCalls, tick_: sim.tick };
    },
    /** select up to `n` own units (the box-select case the HUD is slow on) */
    selectMany: (n = 120) => {
      const ids: number[] = [];
      for (let id = 0; id < w.maxId && ids.length < n; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === view.mySlot) ids.push(id);
      view.input.setSelection(ids);
      return ids.length;
    },
    /** send every own unit somewhere fresh: forces new flow fields */
    marchTo: (cx: number, cy: number) => {
      const ids: number[] = [];
      for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === view.mySlot && w.type[id] !== UnitType.Worker) ids.push(id);
      for (let i = 0; i < ids.length; i += 200) session.submit({ type: CommandType.AttackMove, player: view.mySlot, ids: ids.slice(i, i + 200), x: fp(cx), y: fp(cy) });
    },
  };
}
