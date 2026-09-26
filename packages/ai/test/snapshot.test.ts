import { describe, expect, it } from 'vitest';
import {
  Command, FP_ONE, MatchSetup, PLAYER_COLORS, SimEvent, SimSnapshot, Simulation, Tile, ViewFrameWriter, createMap, fp, isTypedArray, packSnapshot,
  snapshotBytes, unpackSnapshot,
} from '@rookfall/sim';
import { Bot, Strategy, createBots } from '../src';

function botMatch(seed: number, mapId: string, players: number): MatchSetup {
  return {
    seed, mapId, version: 1,
    players: Array.from({ length: players }, (_, i) => ({ slot: i, team: i, name: `Bot ${i}`, isBot: true, difficulty: 2 as const, color: PLAYER_COLORS[i] })),
  };
}

/** where two snapshots first differ, '' when they are the same */
function diff(a: unknown, b: unknown, path = ''): string {
  if (isTypedArray(a) || isTypedArray(b)) {
    if (!isTypedArray(a) || !isTypedArray(b) || a.constructor !== b.constructor || a.length !== b.length) return `${path}: shape`;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `${path}[${i}]: ${a[i]} vs ${b[i]}`;
    return '';
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) ? '' : `${path}: ${String(a)} vs ${String(b)}`;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return `${path}: keys ${ka.length} vs ${kb.length}`;
  for (const k of ka) {
    const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return '';
}

/**
 * A bot match with a snapshot every `every` ticks. Then every snapshot is put back - into a fresh simulation and
 * into the finished one (a jump back in a replay) - and the recorded commands are played on from there: each must
 * end in the very same state, down to the pathfinder's caches.
 */
function roundTrip(
  setup: MatchSetup, ticks: number, every: number, plans?: Strategy[], hook?: (sim: Simulation, t: number) => void,
  when?: (sim: Simulation) => boolean,
) {
  const map = createMap(setup.mapId, setup.seed);
  const sim = new Simulation(setup, map);
  const bots = plans ? plans.map((p, i) => new Bot(i, 2, setup.seed, p)) : createBots(sim);
  const frames: Command[][] = [[]];
  const snaps: SimSnapshot[] = [];
  // what is not a command (a fire set by hand) has to happen again on every run that plays the tick
  const step = (target: Simulation, t: number) => { hook?.(target, t); target.step(frames[t]); };
  for (let t = 1; t <= ticks && !sim.gameOver; t++) {
    frames[t] = bots.flatMap((b) => b.think(sim));
    step(sim, t);
    const last = snaps.length ? snaps[snaps.length - 1].tick : 0;
    if (when ? t - last >= every && when(sim) : t % every === 0) snaps.push(sim.snapshot());
  }
  const end = sim.tick;
  const final = sim.snapshot();
  // taking snapshots must not have changed the match
  const plain = new Simulation(setup, map);
  for (let t = 1; t <= end; t++) step(plain, t);
  expect(plain.hash()).toBe(sim.hash());
  expect(diff(plain.snapshot(), final)).toBe('');
  // packed keyframes come back exactly, and take a fraction of the room
  for (const s of [...snaps, final]) {
    const packed = packSnapshot(s);
    expect(diff(unpackSnapshot(packed), s)).toBe('');
    expect(snapshotBytes(packed)).toBeLessThan(snapshotBytes(s) / 2);
  }
  const fresh = new Simulation(setup, map);
  for (const s of snaps) {
    for (const target of [fresh, sim]) {
      target.restore(s);
      expect(diff(target.snapshot(), s)).toBe('');
      for (let t = s.tick + 1; t <= end; t++) step(target, t);
      expect(diff(target.snapshot(), final)).toBe('');
    }
  }
  return { snaps, final, end };
}

describe('snapshots', () => {
  it('a duel carries on bit for bit from any snapshot, into a fresh simulation or back in time', () => {
    const { snaps, end } = roundTrip(botMatch(7, 'duel-valley', 2), 20 * 60 * 12, 1000);
    expect(snaps.length).toBeGreaterThan(8);
    expect(end).toBeGreaterThan(8000);
  }, 120_000);

  // a pathfinder starved of budget keeps a backlog and pending aims at every moment: they have to come back too
  it('a match on a starved pathfinder carries on bit for bit, backlog and all', () => {
    const backlog = (sim: Simulation) => (sim.path as unknown as { backlog: Map<number, unknown> }).backlog.size;
    const { snaps } = roundTrip(botMatch(5, 'crossroads', 4), 20 * 60 * 6, 400, undefined, (sim, t) => {
      if (t === 1) { sim.path.budgetPerTick = 1; sim.path.workPerTick = 300; }
    }, (sim) => backlog(sim) > 0);
    // snapshots are taken only while requests wait
    expect(snaps.length).toBeGreaterThan(4);
    for (const s of snaps) expect(s.path.backlog.length).toBeGreaterThan(0);
  }, 120_000);

  it('four bots walling themselves in, with a forest fire, carry on bit for bit too', () => {
    const plans = [Strategy.Fortify, Strategy.Fortify, Strategy.Boom, Strategy.Siege];
    const { final } = roundTrip(botMatch(3, 'six-kingdoms', 4), 20 * 60 * 14, 1500, plans, (sim, t) => {
      if (t % 1000 !== 500) return;
      // set a patch of forest alight near the middle every so often, so fires overlap the snapshots
      const m = sim.map;
      for (let r = 0; r < m.w / 2; r++) for (let y = (m.h >> 1) - r; y <= (m.h >> 1) + r; y++) for (let x = (m.w >> 1) - r; x <= (m.w >> 1) + r; x++) {
        if (m.tiles[y * m.w + x] !== Tile.Forest || sim.burnUntil[y * m.w + x] !== 0) continue;
        sim.igniteForest(fp(x + 0.5), fp(y + 0.5), 2 * FP_ONE);
        return;
      }
    });
    const forest = (tiles: Uint8Array) => tiles.reduce((n, v) => n + (v === Tile.Forest ? 1 : 0), 0);
    // the match got far enough to have something in every part of the state: routes, gates, burnt-down forest
    expect(final.path.fields.length).toBeGreaterThan(10);
    expect(final.path.gateTeams.length).toBeGreaterThan(0);
    expect(forest(final.tiles)).toBeLessThan(forest(createMap('six-kingdoms', 3).tiles));
    expect(snapshotBytes(final)).toBeGreaterThan(0);
  }, 180_000);
});

describe('view frames', () => {
  // the view of a match run elsewhere is a copy that is never stepped: it must show exactly what the real one holds
  it('keep a copy of the simulation in step, frame by frame or a few ticks at a time', () => {
    const setup = botMatch(3, 'six-kingdoms', 4);
    const map = createMap(setup.mapId, setup.seed);
    const sim = new Simulation(setup, map);
    const plans = [Strategy.Fortify, Strategy.Siege, Strategy.Boom, Strategy.Rush];
    const bots = plans.map((p, i) => new Bot(i, 2, setup.seed, p));
    const view = new Simulation(setup, map);
    const writer = new ViewFrameWriter(sim);
    const watch = [0, 2];
    let events: SimEvent[] = [];
    let compared = 0;
    for (let t = 1; t <= 20 * 60 * 10 && !sim.gameOver; t++) {
      if (t % 1000 === 500) {
        const m = sim.map;
        for (let i = 0; i < m.tiles.length; i++) if (m.tiles[i] === Tile.Forest) { sim.igniteForest(fp((i % m.w) + 0.5), fp(Math.floor(i / m.w) + 0.5), 2 * FP_ONE); break; }
      }
      sim.step(bots.flatMap((b) => b.think(sim)));
      events = events.concat(sim.events);
      // frames every tick early on, then every few ticks, as a view that falls behind would get them
      if (t < 2000 || t % 7 === 0) {
        view.applyViewFrame(writer.frame(events, watch));
        events = [];
        if (t % 350 === 0) {
          const a = sim.snapshot(), b = view.snapshot();
          const w = { ...a.world.arrays }, wv = { ...b.world.arrays };
          delete w.oq; delete wv.oq;
          expect(diff(wv, w)).toBe('');
          expect(diff(b.players, a.players)).toBe('');
          expect(diff(b.path.layers, a.path.layers)).toBe('');
          expect(diff(b.tiles, a.tiles)).toBe('');
          expect(b.burning).toEqual(a.burning);
          for (const p of watch) expect(diff(view.fog.vis[p], sim.fog.vis[p])).toBe('');
          expect(view.tick).toBe(sim.tick);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20);
  }, 120_000);
});
