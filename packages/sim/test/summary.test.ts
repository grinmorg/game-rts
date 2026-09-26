import { describe, expect, it } from 'vitest';
import {
  CommandType, EventType, FP_ONE, MatchSetup, PLAYER_COLORS, ReplayPlayer, ReplayRecorder, SUMMARY_SAMPLE_TICKS, Simulation, SummaryRecorder,
  UNITS, UnitType, battlePlayFrom, createMap, findBattles, fp, replayPlayable, SIM_VERSION, TICK_RATE,
} from '../src';

function setup(seed: number): MatchSetup {
  return {
    seed, mapId: 'duel-valley', version: 1,
    players: [0, 1].map((i) => ({ slot: i, team: i, name: `P${i}`, isBot: false, color: PLAYER_COLORS[i] })),
  };
}

/** a death at cell (x, y), `s` seconds in */
function death(s: number, x: number, y: number, owner: number, value = 70) {
  return { t: s * TICK_RATE, x: x * FP_ONE, y: y * FP_ONE, value, owner };
}

/** two armies of soldiers and archers a few cells apart in front of player 0's castle, told to walk into each other */
function brawl(sim: Simulation, perSide: number): { x: number; y: number; dir: number } {
  const s = sim.players[0];
  const dir = s.startY < sim.map.h / 2 ? 1 : -1; // towards the middle of the map
  const ids: number[][] = [[], []];
  for (let p = 0; p < 2; p++) {
    for (let i = 0; i < perSide; i++) {
      const x = s.startX + (i % 5) - 2 + 0.5, y = s.startY + 0.5 + dir * (6 + p * 5 + Math.floor(i / 5) * 0.8);
      ids[p].push(sim.spawnUnit(p, i % 3 === 0 ? UnitType.Archer : UnitType.Soldier, fp(x), fp(y)));
    }
  }
  sim.step([
    { type: CommandType.AttackMove, player: 0, ids: ids[0], x: fp(s.startX + 0.5), y: fp(s.startY + 0.5 + dir * 14) },
    { type: CommandType.AttackMove, player: 1, ids: ids[1], x: fp(s.startX + 0.5), y: fp(s.startY + 0.5 + dir * 4) },
  ]);
  return { x: s.startX + 0.5, y: s.startY + 0.5 + dir * 9, dir };
}

describe('battles', () => {
  it('the biggest fight comes first, with its span, centre and losses', () => {
    const deaths = [
      // a skirmish at 1:00 - four soldiers
      ...[0, 1, 2, 3].map((i) => death(60 + i, 10, 10, i % 2)),
      // the big one at 5:00 around (30, 40): twelve deaths over 40 s
      ...Array.from({ length: 12 }, (_, i) => death(300 + i * 3.5, 30 + (i % 3) - 1, 40 + (i % 2), i < 8 ? 1 : 0)),
      // a smaller fight at 9:00 elsewhere
      ...Array.from({ length: 6 }, (_, i) => death(540 + i * 2, 50, 12, i % 2, 80)),
    ];
    const b = findBattles(deaths, 2);
    expect(b).toHaveLength(2);
    expect(b[0].deaths).toBe(12);
    expect(b[0].start).toBe(300 * TICK_RATE);
    expect(b[0].end).toBe(Math.round((300 + 11 * 3.5) * TICK_RATE));
    expect(b[0].losses).toEqual([4, 8]);
    expect(b[0].x).toBeCloseTo(30, 0);
    expect(b[0].y).toBeCloseTo(40.5, 0);
    expect(b[1].deaths).toBe(6);
    expect(b[1].value).toBe(480);
    expect(b[0].value).toBeGreaterThan(b[1].value);
    // the four-soldier skirmish is below the bar
    expect(b.some((x) => x.start === 60 * TICK_RATE)).toBe(false);
    expect(battlePlayFrom(b[0])).toBe(290 * TICK_RATE);
  });

  it('a lull longer than the gap splits one place into two fights', () => {
    const deaths = [
      ...Array.from({ length: 6 }, (_, i) => death(100 + i, 20, 20, i % 2)),
      ...Array.from({ length: 6 }, (_, i) => death(200 + i, 20, 20, i % 2)),
    ];
    const b = findBattles(deaths, 2);
    expect(b).toHaveLength(2);
    expect(b.map((x) => x.deaths)).toEqual([6, 6]);
  });

  it('a second fight at the same time elsewhere is not a second moment', () => {
    const deaths = [
      ...Array.from({ length: 10 }, (_, i) => death(100 + i, 10, 10, i % 2)),
      ...Array.from({ length: 6 }, (_, i) => death(102 + i, 50, 50, i % 2)),
    ];
    const b = findBattles(deaths, 2);
    expect(b).toHaveLength(1);
    expect(b[0].x).toBeCloseTo(10, 0);
  });

  it('nothing to show in a match without fights', () => {
    expect(findBattles([], 2)).toEqual([]);
    expect(findBattles([death(10, 5, 5, 0), death(11, 5, 5, 1)], 2)).toEqual([]);
  });
});

describe('summary recorder', () => {
  it('samples the charts and finds the fight a real clash leaves behind', () => {
    const sim = new Simulation(setup(5), createMap('duel-valley'));
    const rec = new SummaryRecorder(sim);
    const where = brawl(sim, 15);
    rec.observe(sim);
    const start = sim.tick;
    for (let i = 0; i < 90 * TICK_RATE && !sim.gameOver; i++) { sim.step([]); rec.observe(sim); }
    const s = rec.finish(sim);

    expect(s.end).toBe(sim.tick);
    const samples = Math.floor(sim.tick / SUMMARY_SAMPLE_TICKS) + (sim.tick % SUMMARY_SAMPLE_TICKS ? 2 : 1);
    for (const m of ['army', 'workers', 'mined', 'kills'] as const) for (const p of [0, 1]) expect(s.series[m][p]).toHaveLength(samples);
    // the start: four workers each, no army; the armies appear at the brawl and shrink as it goes
    expect(s.series.workers[0][0]).toBe(4);
    expect(s.series.army[0][0]).toBe(0);
    const armyAt = (p: number, i: number) => s.series.army[p][i];
    expect(armyAt(0, 1) + armyAt(1, 1)).toBeLessThanOrEqual(15 * 2 * UNITS[UnitType.Soldier].cost + 10 * (UNITS[UnitType.Archer].cost - UNITS[UnitType.Soldier].cost));
    expect(armyAt(0, samples - 1) + armyAt(1, samples - 1)).toBeLessThan(armyAt(0, 1) + armyAt(1, 1));
    expect(s.series.kills[0][samples - 1] + s.series.kills[1][samples - 1]).toBe(sim.players[0].unitsKilled + sim.players[1].unitsKilled);

    expect(s.battles.length).toBeGreaterThanOrEqual(1);
    const b = s.battles[0];
    expect(b.start).toBeGreaterThanOrEqual(start);
    expect(b.deaths).toBeGreaterThanOrEqual(5);
    expect(b.losses[0]).toBeGreaterThan(0);
    expect(b.losses[1]).toBeGreaterThan(0);
    // the fight happened where the two lines met, in front of player 0's castle
    expect(Math.abs(b.x - where.x)).toBeLessThan(6);
    expect(Math.abs(b.y - where.y)).toBeLessThan(7);
    expect(s.totals[0].killed).toBe(sim.players[0].unitsKilled);
    expect(s.out).toEqual([-1, -1]);
  });

  it('an army that vanishes with a surrender is not a battle', () => {
    const sim = new Simulation(setup(6), createMap('duel-valley'));
    const rec = new SummaryRecorder(sim);
    const s0 = sim.players[1];
    const ids = Array.from({ length: 20 }, (_, i) => sim.spawnUnit(1, UnitType.Soldier, fp(s0.startX + (i % 5) - 2 + 0.5), fp(s0.startY - 5 - Math.floor(i / 5))));
    expect(ids.every((id) => id >= 0)).toBe(true);
    sim.step([{ type: CommandType.Surrender, player: 1 }]);
    rec.observe(sim);
    const s = rec.finish(sim);
    expect(sim.gameOver).toBe(true);
    expect(s.battles).toEqual([]);
    expect(s.out[1]).toBe(sim.tick);
  });

  it('asking mid-match leaves the recorder as it was', () => {
    const sim = new Simulation(setup(7), createMap('duel-valley'));
    const rec = new SummaryRecorder(sim);
    for (let i = 0; i < 250; i++) { sim.step([]); rec.observe(sim); }
    const a = rec.finish(sim);
    const b = rec.finish(sim);
    expect(b).toEqual(a);
    expect(a.series.workers[0]).toHaveLength(3); // ticks 0 and 200, then "now" at 250
    for (let i = 0; i < 150; i++) { sim.step([]); rec.observe(sim); }
    const c = rec.finish(sim);
    expect(c.series.workers[0]).toHaveLength(3); // 0, 200, 400 - and 400 is now
    expect(c.end).toBe(400);
  });

  it('the same ticks build the same summary', () => {
    const run = () => {
      const sim = new Simulation(setup(8), createMap('duel-valley'));
      const rec = new SummaryRecorder(sim);
      brawl(sim, 10);
      rec.observe(sim);
      for (let i = 0; i < 60 * TICK_RATE; i++) { sim.step([]); rec.observe(sim); }
      return rec.finish(sim);
    };
    const a = run();
    expect(a.battles.length).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  });
});

describe('replay checks', () => {
  it('only the current simulation plays a replay back', () => {
    const r = new ReplayRecorder(setup(1));
    expect(replayPlayable(r.data)).toBe(true);
    expect(replayPlayable({ ...r.data, version: SIM_VERSION - 1 })).toBe(false);
  });

  it('hands out the recorded hash of a tick, in order', () => {
    const r = new ReplayRecorder(setup(1));
    r.hash(50, 111); r.hash(100, 222); r.hash(150, 333);
    const p = new ReplayPlayer(r.data);
    expect(p.expectedHash(49)).toBeUndefined();
    expect(p.expectedHash(50)).toBe(111);
    expect(p.expectedHash(120)).toBeUndefined();
    expect(p.expectedHash(150)).toBe(333);
    p.reset();
    expect(p.expectedHash(100)).toBe(222);
  });

  it('a unit killed in a fight is flagged, one removed with its player is not', () => {
    const sim = new Simulation(setup(9), createMap('duel-valley'));
    const home = sim.players[0];
    const victim = sim.spawnUnit(1, UnitType.Worker, fp(home.startX + 3.5), fp(home.startY + 3.5));
    sim.world.hp[victim] = 0;
    sim.step([]);
    const killed = sim.events.find((e) => e.a === victim);
    expect(killed?.b).toBe(1);
    sim.step([{ type: CommandType.Surrender, player: 1 }]);
    const removed = sim.events.filter((e) => e.owner === 1 && e.type === EventType.Death);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((e) => e.b === -1)).toBe(true);
  });
});
