import { describe, expect, it } from 'vitest';
import { Age, BuildingType, CommandType, EventType, FP_SHIFT, Kind, MatchSetup, PLAYER_COLORS, REJECT, Simulation, UnitType, buildingLimit, createMap } from '@rookfall/sim';
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

  // castles and mines are capped per player; a bot never asks for one past the cap (a refused order still
  // costs it an order), and with gold to spare it fills every slot rather than stopping at its plan's number
  it('a rich bot fills the castle and mine caps exactly and never runs into them', () => {
    const setup = botMatch(5, 1, 0, 'six-kingdoms');
    const sim = new Simulation(setup, createMap(setup.mapId));
    const bot = new Bot(0, 1, setup.seed, Strategy.Creep);
    const w = sim.world;
    let most = 0, refused = 0;
    for (let t = 0; t < 20 * 60 * 20; t++) {
      sim.players[0].gold = 20000;
      // the other side stands still and cannot fall, so the match runs long enough to spread out
      for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.owner[id] === 1 && w.kind[id] === Kind.Building) w.hp[id] = w.maxHp[id];
      sim.step(bot.think(sim));
      for (const e of sim.events) if (e.type === EventType.Rejected && e.owner === 0 && e.v === REJECT.limit) refused++;
      most = Math.max(most, count(sim, 0, Kind.Building, BuildingType.Castle));
    }
    expect(refused).toBe(0);
    expect(most).toBe(buildingLimit(BuildingType.Castle));
    expect(count(sim, 0, Kind.Building, BuildingType.Castle)).toBe(buildingLimit(BuildingType.Castle));
    expect(count(sim, 0, Kind.Building, BuildingType.Mine)).toBe(buildingLimit(BuildingType.Mine));
  });

  it('bots of one difficulty do not all play the same game', () => {
    const medium = new Set<Strategy>();
    for (let seed = 0; seed < 40; seed++) medium.add(new Bot(0, 1, seed).strategy);
    expect(medium.size).toBe(5);
    // and every plan is on every difficulty: the level decides how well a bot plays, not what it is allowed
    // to build, so an easy bot can be the one that fences itself in or walks towers at you
    const easy = new Set<Strategy>();
    for (let seed = 0; seed < 40; seed++) easy.add(new Bot(0, 0, seed).strategy);
    expect(easy.size).toBe(5);
    // and two bots in one match are not clones of each other: the slot goes into the roll
    let differ = 0;
    for (let seed = 0; seed < 40; seed++) if (new Bot(0, 1, seed).strategy !== new Bot(1, 1, seed).strategy) differ++;
    expect(differ).toBeGreaterThan(10);
  });

  it('the fortifying plan rings its base with a fence and towers, and still gets its army out', () => {
    // Not every game gives it the room: on some starts it is fighting from the fourth minute and the ring
    // never gets past a corner. The claim is that ringing the base is what this plan normally does, so it is
    // measured over several starts rather than pinned to one.
    let ringed = 0;
    for (const seed of [1, 2, 3, 7, 13]) {
      const { sim } = run(botMatch(seed, 1, 1), 20 * 60 * 16, [Strategy.Fortify, Strategy.Boom]);
      const wall = count(sim, 0, Kind.Building, BuildingType.Wall);
      // a straight run of four sections is a gate, and a bot that fences itself in without one has lost the game
      if (wall >= 25 && gates(sim, 0) >= 1 && count(sim, 0, Kind.Building, BuildingType.Tower) >= 2) ringed++;
      // and it does come out from behind the wall: the other side pays for it either way
      expect(sim.players[1].unitsLost, `seed ${seed}`).toBeGreaterThan(20);
    }
    expect(ringed).toBeGreaterThanOrEqual(4);
  }, 15000);

  it('the plans build visibly different bases', () => {
    const holdings = (sim: Simulation) =>
      count(sim, 0, Kind.Building, BuildingType.Castle) + count(sim, 0, Kind.Building, BuildingType.Mine);
    let greedy = 0, aggressive = 0;
    for (const seed of [7, 31, 11]) {
      const rush = run(botMatch(seed, 1, 1), 20 * 60 * 8, [Strategy.Rush, Strategy.Boom]).sim;
      const boom = run(botMatch(seed, 1, 1), 20 * 60 * 8, [Strategy.Boom, Strategy.Boom]).sim;
      const fort = run(botMatch(seed, 1, 1), 20 * 60 * 8, [Strategy.Fortify, Strategy.Boom]).sim;
      greedy += holdings(boom); aggressive += holdings(rush);
      // the rusher raises no towers at all: the plan has no appetite for them whatever the game does, while
      // the turtle already has one up (its ring, which takes longer, is checked where it has time to exist)
      expect(count(rush, 0, Kind.Building, BuildingType.Tower), `seed ${seed}`).toBe(0);
      expect(count(fort, 0, Kind.Building, BuildingType.Tower), `seed ${seed}`).toBeGreaterThanOrEqual(1);
    }
    // and by the eighth minute the greedy plan is holding more ground than the aggressive one, which put that
    // gold into men - true of the three starts together rather than of every single one
    expect(greedy).toBeGreaterThan(aggressive);
  }, 15000);

  it('every plan fences when it keeps being attacked, not just the one built around a wall', () => {
    // one plan in five rings its base on principle; the rest put a line across the side they are being hit
    // from once it has happened twice, which is what puts a fence in most games rather than one in five
    let fencing = 0;
    for (let seed = 0; seed < 6; seed++) {
      const { sim, bots } = run(botMatch(seed, 1, 1), 20 * 60 * 18);
      for (const b of bots) {
        if (b.strategy === Strategy.Fortify) continue; // this one would have fenced anyway
        if (count(sim, b.player, Kind.Building, BuildingType.Wall) > 0) fencing++;
      }
    }
    expect(fencing).toBeGreaterThanOrEqual(4);
  }, 15000);

  it('a walled town is still a town its own army can walk out of', () => {
    // Everything enclosed is only half the job: the gates have to be reachable from inside, which is why the
    // bot keeps a road clear from the middle of each side to the middle of its base. The catapult is the real
    // test - a footman squeezes through the seam between two buildings and a siege engine does not.
    let walled = 0, footOut = 0, siegeOut = 0;
    for (let seed = 0; seed < 10; seed++) {
      const { sim, bots } = run(botMatch(seed, 1, 1), 20 * 60 * 18);
      for (const b of bots) {
        const p = b.player;
        if (count(sim, p, Kind.Building, BuildingType.Wall) < 15) continue;
        const w = sim.world;
        let castle = -1;
        for (let id = 0; id < w.maxId; id++) {
          if (w.alive[id] && w.owner[id] === p && w.kind[id] === Kind.Building && w.type[id] === BuildingType.Castle) { castle = id; break; }
        }
        if (castle < 0) continue;
        walled++;
        const team = sim.players[p].team;
        const cx = w.x[castle] >> FP_SHIFT, cy = w.y[castle] >> FP_SHIFT;
        const mx = sim.map.w >> 1, my = sim.map.h >> 1;
        // from open ground beside the castle: the castle's own cells are footprint and never passable
        for (const heavy of [false, true]) {
          const free = sim.path.nearestFree(cx, cy, 8, heavy, team);
          if (free < 0) continue;
          const fx = free % sim.map.w, fy = (free / sim.map.w) | 0;
          if (sim.path.reachable(fx, fy, mx, my, heavy, team)) { if (heavy) siegeOut++; else footOut++; }
        }
      }
    }
    expect(walled).toBeGreaterThanOrEqual(3);
    expect(footOut).toBe(walled);
    expect(siegeOut).toBe(walled);
  }, 15000);

  it('a plan is carried out at every difficulty, not only by the good bots', () => {
    // the level decides how well a bot plays, not what it is allowed to build, so a turtle is a turtle at
    // every level and an easy one really does put up its fence and its towers
    for (const d of [0, 1, 2] as const) {
      const { sim } = run(botMatch(7, d, d), 20 * 60 * 16, [Strategy.Fortify, Strategy.Boom]);
      expect(count(sim, 0, Kind.Building, BuildingType.Wall), `difficulty ${d}`).toBeGreaterThan(0);
      expect(count(sim, 0, Kind.Building, BuildingType.Tower), `difficulty ${d}`).toBeGreaterThan(0);
    }
  }, 15000);

  it('a wave cuts a hole in a fence instead of demolishing it', () => {
    // Read from the orders the attacker gives rather than from the rubble: sections destroyed counts the ones
    // the turtle rebuilt and the ones catapults splashed, neither of which says anything about intent. What
    // the bot means to do is one section at a time, and only as a door - so in any tick it aims at no more
    // than one, and over the match the fence takes fewer of its orders than the buildings behind it.
    let atFenceAll = 0, atBuildingsAll = 0;
    for (const seed of [7, 14, 31, 1]) {
      const setup = botMatch(seed, 1, 1);
      const sim = new Simulation(setup, createMap(setup.mapId));
      const bots = [new Bot(0, 1, seed, Strategy.Fortify), new Bot(1, 1, seed, Strategy.Boom)];
      const w = sim.world;
      let atFence = 0, atBuildings = 0;
      for (let t = 0; t < 20 * 60 * 20 && !sim.gameOver; t++) {
        const cmds = bots.flatMap((b) => b.think(sim));
        const thisTick = new Set<number>();
        for (const c of cmds) {
          const target = c.target ?? -1;
          if (c.player !== 1 || c.type !== CommandType.Attack) continue;
          if (target < 0 || !w.alive[target] || w.kind[target] !== Kind.Building) continue;
          if (w.type[target] === BuildingType.Wall) { atFence++; thisTick.add(target); } else atBuildings++;
        }
        expect(thisTick.size, `seed ${seed} tick ${t}`).toBeLessThanOrEqual(1);
        sim.step(cmds);
      }
      atFenceAll += atFence; atBuildingsAll += atBuildings;
    }
    // over the starts together the fence takes fewer of the attacker's orders than the buildings behind it;
    // per start it is too small a number to mean anything - one siege can be two orders and no more
    expect(atFenceAll).toBeLessThan(atBuildingsAll);
  }, 15000);

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
