import { describe, expect, it } from 'vitest';
import {
  BuildingType, Command, CommandType, EventType, Kind, MatchSetup, Order, PLAYER_COLORS, ReplayPlayer, ReplayRecorder, Rng,
  Simulation, UnitType, createMap, fp, FP_SHIFT,
} from '../src';

function setup(seed: number, mapId = 'duel-valley', players = 2): MatchSetup {
  return {
    seed, mapId, version: 1,
    players: Array.from({ length: players }, (_, i) => ({ slot: i, team: i, name: `P${i}`, isBot: false, color: PLAYER_COLORS[i] })),
  };
}

/** Scripted pseudo-random command stream to exercise most systems. */
function scriptedCommands(sim: Simulation, rng: Rng, tick: number): Command[] {
  const out: Command[] = [];
  const w = sim.world;
  for (let p = 0; p < sim.players.length; p++) {
    if (!sim.players[p].alive) continue;
    const units: number[] = [], workers: number[] = [], buildings: number[] = [];
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.owner[id] !== p) continue;
      if (w.kind[id] === Kind.Unit) { units.push(id); if (w.type[id] === UnitType.Worker) workers.push(id); }
      else if (w.kind[id] === Kind.Building) buildings.push(id);
    }
    const castle = buildings.find((b) => w.type[b] === BuildingType.Castle);
    if (castle !== undefined && tick % 40 === 0) out.push({ type: CommandType.Train, player: p, ids: [castle], v: UnitType.Worker });
    if (tick === 60 && workers.length > 0 && castle !== undefined) {
      const cx = (w.x[castle] >> FP_SHIFT) + 3, cy = (w.y[castle] >> FP_SHIFT) + 3;
      out.push({ type: CommandType.Build, player: p, ids: [workers[0]], v: BuildingType.Barracks, x: fp(cx), y: fp(cy) });
    }
    if (tick === 200 && workers.length > 1 && castle !== undefined) {
      const cx = (w.x[castle] >> FP_SHIFT) - 5, cy = (w.y[castle] >> FP_SHIFT) - 5;
      out.push({ type: CommandType.Build, player: p, ids: [workers[1]], v: BuildingType.House, x: fp(cx), y: fp(cy) });
    }
    const barracks = buildings.find((b) => w.type[b] === BuildingType.Barracks);
    if (barracks !== undefined && tick % 50 === 10) out.push({ type: CommandType.Train, player: p, ids: [barracks], v: rng.chance(0.5) ? UnitType.Soldier : UnitType.Archer });
    const army = units.filter((u) => w.type[u] !== UnitType.Worker);
    if (army.length > 0 && tick % 100 === 20) {
      const enemyStart = sim.map.starts[(p + 1) % sim.map.starts.length];
      out.push({ type: CommandType.AttackMove, player: p, ids: army, x: fp(enemyStart.x + rng.range(-3, 3)), y: fp(enemyStart.y + rng.range(-3, 3)) });
    }
    if (army.length > 0 && tick % 90 === 45) {
      out.push({ type: CommandType.Move, player: p, ids: army.slice(0, 3), x: fp(rng.range(5, sim.map.w - 6)), y: fp(rng.range(5, sim.map.h - 6)), queue: rng.chance(0.3) });
    }
  }
  return out;
}

function runScripted(seed: number, ticks: number, recorder?: ReplayRecorder): { sim: Simulation; hashes: number[] } {
  const st = setup(seed);
  const sim = new Simulation(st, createMap(st.mapId));
  const rng = new Rng(seed ^ 0x5bd1e995);
  const hashes: number[] = [];
  for (let t = 1; t <= ticks; t++) {
    const cmds = scriptedCommands(sim, rng, t);
    recorder?.record(t, cmds);
    sim.step(cmds);
    if (t % 50 === 0) hashes.push(sim.hash());
    if (sim.gameOver) break;
  }
  return { sim, hashes };
}

describe('simulation determinism', () => {
  it('two instances with the same seed and commands produce identical hashes over 3000 ticks', () => {
    const a = runScripted(12345, 3000);
    const b = runScripted(12345, 3000);
    expect(a.hashes.length).toBeGreaterThan(10);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.sim.hash()).toBe(b.sim.hash());
  });

  it('different seeds diverge (sanity check that the hash actually covers state)', () => {
    const a = runScripted(1, 400);
    const b = runScripted(2, 400);
    expect(a.sim.hash()).not.toBe(b.sim.hash());
  });

  it('replay playback reproduces the recorded hashes', () => {
    const st = setup(777);
    const rec = new ReplayRecorder(st, 'Duel Valley');
    const live = runScripted(777, 1500, rec);
    const data = rec.finish(live.sim.winnerTeam, live.sim.tick, 0);
    const json = JSON.parse(JSON.stringify(data));
    const player = new ReplayPlayer(json);
    const sim2 = new Simulation(json.setup, createMap(json.setup.mapId));
    const hashes: number[] = [];
    for (let t = 1; t <= live.sim.tick; t++) {
      sim2.step(player.commandsFor(t));
      if (t % 50 === 0) hashes.push(sim2.hash());
    }
    expect(hashes).toEqual(live.hashes);
  });
});

describe('economy & production', () => {
  it('workers mine gold and deposit it at the castle', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const start = sim.players[0].gold;
    let deposits = 0;
    for (let t = 0; t < 600; t++) {
      sim.step([]);
      for (const e of sim.events) if (e.type === EventType.Deposit && e.owner === 0) deposits++;
    }
    expect(deposits).toBeGreaterThan(5);
    expect(sim.players[0].gold).toBeGreaterThan(start);
  });

  it('training a worker costs gold and spawns a unit that goes mining', () => {
    const st = setup(9);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    let castle = -1;
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === 0) castle = id;
    const goldBefore = sim.players[0].gold;
    sim.step([{ type: CommandType.Train, player: 0, ids: [castle], v: UnitType.Worker }]);
    expect(sim.players[0].gold).toBe(goldBefore - 50);
    let trained = -1;
    for (let t = 0; t < 400 && trained < 0; t++) {
      sim.step([]);
      for (const e of sim.events) if (e.type === EventType.UnitTrained) trained = e.a;
    }
    expect(trained).toBeGreaterThanOrEqual(0);
    expect(w.order[trained]).toBe(Order.Gather);
  });

  it('building placement is validated and construction completes', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const workers: number[] = [];
    let castle = -1;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.owner[id] !== 0) continue;
      if (w.kind[id] === Kind.Unit) workers.push(id); else castle = id;
    }
    // overlapping the castle must be rejected
    const bad: Command = { type: CommandType.Build, player: 0, ids: workers, v: BuildingType.House, x: w.x[castle], y: w.y[castle] };
    expect(sim.validate(bad)).toBe('blocked');
    const cx = (w.x[castle] >> FP_SHIFT) + 4, cy = (w.y[castle] >> FP_SHIFT) - 4;
    const good: Command = { type: CommandType.Build, player: 0, ids: workers, v: BuildingType.House, x: fp(cx), y: fp(cy) };
    expect(sim.validate(good)).toBeNull();
    sim.step([good]);
    let completed = false;
    for (let t = 0; t < 900 && !completed; t++) {
      sim.step([]);
      for (const e of sim.events) if (e.type === EventType.BuildingComplete && e.v === BuildingType.House) completed = true;
    }
    expect(completed).toBe(true);
    expect(sim.players[0].popCap).toBe(15);
  });
});

describe('victory', () => {
  it('surrender eliminates the player and ends a 1v1', () => {
    const st = setup(11);
    const sim = new Simulation(st, createMap(st.mapId));
    sim.step([{ type: CommandType.Surrender, player: 1 }]);
    expect(sim.players[1].alive).toBe(false);
    expect(sim.gameOver).toBe(true);
    expect(sim.winnerTeam).toBe(0);
  });
});
