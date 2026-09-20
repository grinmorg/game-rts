import { describe, expect, it } from 'vitest';
import { Age, BuildingType, Kind, MatchSetup, PLAYER_COLORS, Simulation, UnitType, createMap } from '@rookfall/sim';
import { Bot, Strategy, createBots } from '../src';

function botMatch(seed: number, d0: 0 | 1 | 2, d1: 0 | 1 | 2, mapId = 'duel-valley'): MatchSetup {
  return {
    seed, mapId, version: 1,
    players: [
      { slot: 0, team: 0, name: 'Bot A', isBot: true, difficulty: d0, color: PLAYER_COLORS[0] },
      { slot: 1, team: 1, name: 'Bot B', isBot: true, difficulty: d1, color: PLAYER_COLORS[1] },
    ],
  };
}

function run(setup: MatchSetup, ticks: number, plans?: (Strategy | undefined)[]) {
  const sim = new Simulation(setup, createMap(setup.mapId));
  const bots = plans
    ? setup.players.map((p, i) => new Bot(p.slot, (p.difficulty ?? 1) as 0 | 1 | 2, setup.seed, plans[i]))
    : createBots(sim);
  for (let t = 0; t < ticks && !sim.gameOver; t++) {
    const cmds = bots.flatMap((b) => b.think(sim));
    sim.step(cmds);
  }
  return { sim, bots };
}

/** gates of a team: a gate marks its first cell with slot 1 (a run along x) or 5 (a run along y) */
function gates(sim: Simulation, team: number) {
  let n = 0;
  for (let y = 0; y < sim.map.h; y++) for (let x = 0; x < sim.map.w; x++) {
    const slot = sim.path.gateAt(x, y);
    if ((slot === 1 || slot === 5) && sim.path.gateTeamAt(x, y) === team) n++;
  }
  return n;
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
    const army = count(sim, 0, Kind.Unit, UnitType.Soldier) + count(sim, 0, Kind.Unit, UnitType.Archer) + count(sim, 0, Kind.Unit, UnitType.Catapult) + count(sim, 0, Kind.Unit, UnitType.Cavalry);
    expect(army + sim.players[0].unitsLost).toBeGreaterThanOrEqual(4);
  });

  it('a hard bot reaches the second age and digs a mine of its own within 15 minutes (unless it has already won)', () => {
    const { sim } = run(botMatch(32, 2, 0), 20 * 60 * 15);
    const p = sim.players[0];
    expect(p.age === Age.Second || sim.winnerTeam === 0).toBe(true);
    const mines = count(sim, 0, Kind.Building, BuildingType.Mine);
    expect(mines >= 1 || sim.winnerTeam === 0).toBe(true);
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

  it('bots of one difficulty do not all play the same game', () => {
    const medium = new Set<Strategy>();
    for (let seed = 0; seed < 40; seed++) medium.add(new Bot(0, 1, seed).strategy);
    expect(medium.size).toBe(4);
    // the easy profile has no towers, no expansion and no upgrades, so it only rolls the two plans it could
    // actually carry out - promising an easy bot a fence ring it will never build would be a lie
    const easy = new Set<Strategy>();
    for (let seed = 0; seed < 40; seed++) easy.add(new Bot(0, 0, seed).strategy);
    expect([...easy].sort()).toEqual([Strategy.Rush, Strategy.Boom].sort());
    // and two bots in one match are not clones of each other: the slot goes into the roll
    let differ = 0;
    for (let seed = 0; seed < 40; seed++) if (new Bot(0, 1, seed).strategy !== new Bot(1, 1, seed).strategy) differ++;
    expect(differ).toBeGreaterThan(10);
  });

  it('the fortifying plan rings its base with a fence and towers, and still gets its army out', () => {
    const { sim } = run(botMatch(23, 1, 1), 20 * 60 * 16, [Strategy.Fortify, Strategy.Boom]);
    expect(count(sim, 0, Kind.Building, BuildingType.Wall)).toBeGreaterThanOrEqual(30);
    expect(count(sim, 0, Kind.Building, BuildingType.Tower)).toBeGreaterThanOrEqual(2);
    // a straight run of four sections is a gate, and a bot that fences itself in without one has lost the game
    expect(gates(sim, 0)).toBeGreaterThanOrEqual(1);
    // and it did come out from behind the wall: the other side has paid for it
    expect(sim.players[1].unitsLost).toBeGreaterThan(20);
  });

  it('the plans build visibly different bases', () => {
    for (const seed of [7, 23, 31]) {
      const rush = run(botMatch(seed, 1, 1), 20 * 60 * 6, [Strategy.Rush, Strategy.Boom]).sim;
      const boom = run(botMatch(seed, 1, 1), 20 * 60 * 6, [Strategy.Boom, Strategy.Boom]).sim;
      const fort = run(botMatch(seed, 1, 1), 20 * 60 * 6, [Strategy.Fortify, Strategy.Boom]).sim;
      // by the sixth minute the greedy plan has taken a second castle; the rusher put that gold into men
      expect(count(boom, 0, Kind.Building, BuildingType.Castle), `seed ${seed}`)
        .toBeGreaterThan(count(rush, 0, Kind.Building, BuildingType.Castle));
      // the rusher raises no towers at all, the turtle raises them and the fence they stand behind
      expect(count(rush, 0, Kind.Building, BuildingType.Tower), `seed ${seed}`).toBe(0);
      expect(count(fort, 0, Kind.Building, BuildingType.Wall), `seed ${seed}`).toBeGreaterThan(0);
      expect(count(fort, 0, Kind.Building, BuildingType.Tower), `seed ${seed}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every plan is still playable: none of them collapses against an easy bot', () => {
    for (const plan of [Strategy.Rush, Strategy.Boom, Strategy.Fortify, Strategy.Siege]) {
      const { sim } = run(botMatch(23, 1, 0), 20 * 60 * 10, [plan, undefined]);
      expect(sim.players[0].alive, `plan ${plan}`).toBe(true);
      const army = count(sim, 0, Kind.Unit, UnitType.Soldier) + count(sim, 0, Kind.Unit, UnitType.Archer)
        + count(sim, 0, Kind.Unit, UnitType.Cavalry) + count(sim, 0, Kind.Unit, UnitType.Catapult);
      expect(army + sim.players[0].unitsKilled, `plan ${plan}`).toBeGreaterThanOrEqual(6);
    }
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
