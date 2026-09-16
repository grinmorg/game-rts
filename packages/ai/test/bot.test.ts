import { describe, expect, it } from 'vitest';
import { BuildingType, Kind, MatchSetup, PLAYER_COLORS, Simulation, UnitType, createMap } from '@warlets/sim';
import { Bot, createBots } from '../src';

function botMatch(seed: number, d0: 0 | 1 | 2, d1: 0 | 1 | 2, mapId = 'duel-valley'): MatchSetup {
  return {
    seed, mapId, version: 1,
    players: [
      { slot: 0, team: 0, name: 'Bot A', isBot: true, difficulty: d0, color: PLAYER_COLORS[0] },
      { slot: 1, team: 1, name: 'Bot B', isBot: true, difficulty: d1, color: PLAYER_COLORS[1] },
    ],
  };
}

function run(setup: MatchSetup, ticks: number) {
  const sim = new Simulation(setup, createMap(setup.mapId));
  const bots = createBots(sim);
  for (let t = 0; t < ticks && !sim.gameOver; t++) {
    const cmds = bots.flatMap((b) => b.think(sim));
    sim.step(cmds);
  }
  return { sim, bots };
}

function count(sim: Simulation, owner: number, kind: Kind, type?: number) {
  const w = sim.world;
  let n = 0;
  for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.owner[id] === owner && w.kind[id] === kind && (type === undefined || w.type[id] === type)) n++;
  return n;
}

describe('bots', () => {
  it('a hard bot builds an economy and an army within 5 minutes', () => {
    const { sim } = run(botMatch(31, 2, 0), 20 * 60 * 5);
    expect(count(sim, 0, Kind.Unit, UnitType.Worker)).toBeGreaterThanOrEqual(8);
    expect(count(sim, 0, Kind.Building, BuildingType.Barracks)).toBeGreaterThanOrEqual(1);
    const army = count(sim, 0, Kind.Unit, UnitType.Soldier) + count(sim, 0, Kind.Unit, UnitType.Archer) + count(sim, 0, Kind.Unit, UnitType.Catapult);
    expect(army + sim.players[0].unitsLost).toBeGreaterThanOrEqual(4);
  });

  // castles cover their full advertised range (BUILDINGS[Castle].range measured from the walls), so
  // cracking a base takes noticeably longer than it used to: bot matches land around 20-30 minutes.
  it('bot vs bot match ends with a winner within 35 minutes and stays deterministic', () => {
    const a = run(botMatch(7, 2, 1), 20 * 60 * 35);
    const b = run(botMatch(7, 2, 1), 20 * 60 * 35);
    expect(a.sim.hash()).toBe(b.sim.hash());
    expect(a.sim.gameOver).toBe(true);
    expect(a.sim.winnerTeam).toBeGreaterThanOrEqual(0);
  });

  it('bot commands pass validation almost always', () => {
    const setup = botMatch(99, 1, 1);
    const sim = new Simulation(setup, createMap(setup.mapId));
    const bots = createBots(sim);
    let total = 0, rejected = 0;
    for (let t = 0; t < 20 * 60 * 4 && !sim.gameOver; t++) {
      const cmds = bots.flatMap((b: Bot) => b.think(sim));
      for (const c of cmds) { total++; if (sim.validate(c)) rejected++; }
      sim.step(cmds);
    }
    expect(total).toBeGreaterThan(50);
    expect(rejected / total).toBeLessThan(0.15);
  });
});
