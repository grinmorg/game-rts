import { describe, expect, it } from 'vitest';
import {
  AbilityId, BUILDER_MULT, BUILDINGS, BUILDING_TYPE_COUNT, BuildingState, BuildingType, Command, CommandType, DamageType, EventType,
  FOG_EXPLORED, FOG_VISIBLE, FOREST_BURN_TICKS, INCENDIARY_DELAY_TICKS, Kind, KILL_BOUNTY_DIV, MINE_CAPACITY, MINE_GOLD_PER_WORKER,
  GOLD_PER_TRIP, LOADED_SLOW_PCT,
  MINE_INCOME_TICKS, MatchSetup, Pathfinder, SUB, UNREACHABLE, garrisonWorker, buildingDamage, TOWER_GARRISON_DAMAGE, UpgradeId, AGE_UP, Age, buildingMaxHp, OFFICIAL_MAPS, Order, PLAYER_COLORS, RANDOM_MAP_ID, ReplayPlayer, ReplayRecorder, Rng, SITE_HIT_SLOW_PCT,
  DISMANTLE_REFUND_PCT, dismantleRefund, hitsBuildingsOnly, UNIT_TYPE_COUNT, UPGRADES, UnitState, BUILDING_LIMIT, buildingLimit,
  SITE_HIT_SLOW_TICKS, Simulation, Tile, UNITS, UnitType, WORKER_DISPATCH_INTERVAL, afterJob, canPlaceBuilding, createMap, fp, FP_SHIFT, GATE_LENGTH, GATE_TUNNEL,
  toFloat,
} from '../src';

/** own alive entities of one kind (and optionally type) */
function own(sim: Simulation, owner: number, kind: Kind, type = -1): number[] {
  const w = sim.world, out: number[] = [];
  for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === kind && w.owner[id] === owner && (type < 0 || w.type[id] === type)) out.push(id);
  return out;
}
/** first free footprint for `type` within a ring around the player's spawn */
function spotNear(sim: Simulation, owner: number, type: BuildingType): [number, number] {
  const p = sim.players[owner];
  for (let r = 3; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    if (canPlaceBuilding(sim, type, p.startX + dx, p.startY + dy, owner)) return [p.startX + dx, p.startY + dy];
  }
  throw new Error('no spot');
}

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
      const enemy = sim.players[(p + 1) % sim.players.length];
      out.push({ type: CommandType.AttackMove, player: p, ids: army, x: fp(enemy.startX + rng.range(-3, 3)), y: fp(enemy.startY + rng.range(-3, 3)) });
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

  it('a worker hauling a full load walks slower, and speeds up again once he drops it', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const empty = sim.unitSpeed(worker);
    w.carry[worker] = GOLD_PER_TRIP;
    const loaded = sim.unitSpeed(worker);
    expect(loaded).toBe(Math.floor((empty * (100 - LOADED_SLOW_PCT)) / 100));
    // the scrapings of an emptied mine are light enough to run with
    w.carry[worker] = GOLD_PER_TRIP - 1;
    expect(sim.unitSpeed(worker)).toBe(empty);
    // and the penalty is the worker's alone - `carry` means something else on every other unit
    const soldier = sim.spawnUnit(0, UnitType.Soldier, w.x[worker], w.y[worker]);
    const marching = sim.unitSpeed(soldier);
    w.carry[soldier] = GOLD_PER_TRIP;
    expect(sim.unitSpeed(soldier)).toBe(marching);
  });

  it('a worker with gold in his hands delivers it before he starts any other job', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    w.hp[castle] = Math.floor(w.maxHp[castle] / 2);
    w.carry[worker] = GOLD_PER_TRIP;
    const gold = sim.players[0].gold;

    sim.setOrder(worker, Order.Repair, w.x[castle], w.y[castle], castle, 0);
    expect(w.order[worker]).toBe(Order.Gather);   // the trip home comes first
    expect(w.oqLen[worker]).toBe(1);              // and the repair waits its turn

    for (let t = 0; t < 600 && w.carry[worker] > 0; t++) sim.step([]);
    expect(w.carry[worker]).toBe(0);
    expect(sim.players[0].gold).toBeGreaterThan(gold);
    expect(w.order[worker]).toBe(Order.Repair);   // ... and starts the moment his hands are free

    // a stop is the player calling him off, not another job: it is obeyed at once, gold and all
    w.carry[worker] = GOLD_PER_TRIP;
    sim.setOrder(worker, Order.None, 0, 0, -1, 0);
    expect(w.order[worker]).toBe(Order.None);
    expect(w.oqLen[worker]).toBe(0);
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
    const house = [...Array(w.maxId).keys()].find((id) => w.alive[id] && w.kind[id] === Kind.Building && w.type[id] === BuildingType.House)!;
    expect(w.hp[house]).toBe(w.maxHp[house]);
  });

  it('every building type is at full hp the moment it is finished', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    for (let type = 0; type < BUILDING_TYPE_COUNT; type++) {
      const def = BUILDINGS[type as BuildingType];
      const id = sim.spawnBuilding(0, type as BuildingType, 4, 4 + type * 4, false);
      expect(w.hp[id]).toBeLessThan(w.maxHp[id]);
      // one builder on the site every tick, the same way a worker with Order.Build drives it
      for (let t = 0; t < def.buildTime + 5 && w.state[id] === BuildingState.Constructing; t++) {
        w.builders[id] = 1;
        sim.step([]);
      }
      expect(w.state[id]).toBe(BuildingState.Complete);
      expect(w.hp[id]).toBe(w.maxHp[id]);
    }
  });

  it('a fence blocks its cell and finishes fast', () => {
    const st = setup(6);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const castle = [...Array(w.maxId).keys()].find((id) => w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === 0)!;
    const cx = (w.x[castle] >> FP_SHIFT) + 5, cy = w.y[castle] >> FP_SHIFT;
    const workers: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === 0) workers.push(id);
    const cmd: Command = { type: CommandType.Build, player: 0, ids: workers, v: BuildingType.Wall, x: fp(cx), y: fp(cy) };
    expect(sim.validate(cmd)).toBeNull();
    sim.step([cmd]);
    expect(sim.path.isBlockedCell(cx, cy)).toBe(false); // a site is walkable until it is finished
    let done = false;
    for (let t = 0; t < 600 && !done; t++) {
      sim.step([]);
      for (const e of sim.events) if (e.type === EventType.BuildingComplete && e.v === BuildingType.Wall) done = true;
    }
    expect(done).toBe(true);
    expect(sim.path.isBlockedCell(cx, cy)).toBe(true);
    expect(sim.players[0].popCap).toBe(10); // a fence adds no population
  });
});

describe('construction under fire', () => {
  it('a hit knocks the site progress back and slows the builders for a while', () => {
    const st = setup(12);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const id = sim.spawnBuilding(0, BuildingType.Barracks, 6, 6, false);
    const total = BUILDINGS[BuildingType.Barracks].buildTime * 10;
    while (w.progress[id] < total / 2) { w.builders[id] = 1; sim.step([]); }
    const p0 = w.progress[id], hp0 = w.hp[id];
    sim.dealDamage(id, 100, DamageType.Siege, -1, 1);
    expect(w.hp[id]).toBeLessThan(hp0);
    expect(w.progress[id]).toBeLessThan(p0);
    expect(w.buff[id]).toBe(SITE_HIT_SLOW_TICKS);
    // one builder normally adds BUILDER_MULT[0] per tick; rattled builders add 35% less
    const p1 = w.progress[id];
    w.builders[id] = 1; sim.step([]);
    expect(w.progress[id] - p1).toBe(Math.floor((BUILDER_MULT[0] * (100 - SITE_HIT_SLOW_PCT)) / 100));
    for (let t = 0; t < SITE_HIT_SLOW_TICKS; t++) sim.step([]);
    const p2 = w.progress[id];
    w.builders[id] = 1; sim.step([]);
    expect(w.progress[id] - p2).toBe(BUILDER_MULT[0]);
  });
});

describe('spawns', () => {
  it('every map has two candidates per zone; players land in distinct zones and layouts vary by seed', () => {
    for (const info of OFFICIAL_MAPS) {
      const map = createMap(info.id);
      expect(map.starts.length).toBe(info.maxPlayers * 2);
      const layouts = new Set<string>();
      for (let seed = 1; seed <= 12; seed++) {
        const sim = new Simulation(setup(seed, info.id, info.maxPlayers), map);
        const zones = sim.players.map((p) => map.starts.find((s) => s.x === p.startX && s.y === p.startY)!.zone);
        expect(new Set(zones).size).toBe(info.maxPlayers);
        expect(sim.players.every((p) => p.castles === 1)).toBe(true);
        layouts.add(zones.join(','));
      }
      expect(layouts.size).toBeGreaterThan(1);
    }
  });
});

describe('fog of war', () => {
  it('no building on unexplored ground, and a fresh site reveals nothing until someone works on it', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const workers: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === 0) workers.push(id);
    const enemy = sim.players[1];
    const cx = enemy.startX + 4, cy = enemy.startY;
    const cmd: Command = { type: CommandType.Build, player: 0, ids: workers, v: BuildingType.Wall, x: fp(cx), y: fp(cy) };
    expect(sim.validate(cmd)).toBe('unexplored');
    // explored earlier but dark now: allowed, yet placing the site must not light the area up
    sim.fog.vis[0][cy * sim.map.w + cx] = FOG_EXPLORED;
    expect(sim.validate(cmd)).toBeNull();
    const visible = () => sim.fog.vis[0].reduce((n, v) => n + (v === FOG_VISIBLE ? 1 : 0), 0);
    const before = visible();
    sim.step([cmd]); sim.step([]); sim.step([]);
    expect(visible()).toBe(before);
    expect(sim.fog.isVisible(0, fp(cx + 0.5), fp(cy + 0.5))).toBe(false);
    const site = [...Array(w.maxId).keys()].find((id) => w.alive[id] && w.kind[id] === Kind.Building && w.type[id] === BuildingType.Wall)!;
    w.builders[site] = 1; sim.step([]); sim.step([]);
    expect(sim.fog.isVisible(0, fp(cx + 0.5), fp(cy + 0.5))).toBe(true);
  });
});

describe('worker jobs', () => {
  it('a free worker builds first, repairs second and only then goes for gold', () => {
    const st = setup(21);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const [sx, sy] = spotNear(sim, 0, BuildingType.House);
    const site = sim.spawnBuilding(0, BuildingType.House, sx, sy, false);
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    const house = sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    w.hp[house] -= 50;
    afterJob(sim, worker);
    expect(w.order[worker]).toBe(Order.Build);
    expect(w.orderTarget[worker]).toBe(site);
    // site finished: the damaged house is next
    w.state[site] = BuildingState.Complete; w.hp[site] = w.maxHp[site];
    afterJob(sim, worker);
    expect(w.order[worker]).toBe(Order.Repair);
    expect(w.orderTarget[worker]).toBe(house);
    // nothing left to do: back to the deposit
    w.hp[house] = w.maxHp[house];
    afterJob(sim, worker);
    expect(w.order[worker]).toBe(Order.Gather);
  });

  it('an unattended site pulls a gatherer off the gold, a damaged building gets a repairer', () => {
    const st = setup(22);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const workers = own(sim, 0, Kind.Unit, UnitType.Worker);
    expect(workers.every((id) => w.order[id] === Order.Gather)).toBe(true);
    const [sx, sy] = spotNear(sim, 0, BuildingType.Barracks);
    const site = sim.spawnBuilding(0, BuildingType.Barracks, sx, sy, false);
    for (let t = 0; t <= WORKER_DISPATCH_INTERVAL; t++) sim.step([]);
    const builders = workers.filter((id) => w.alive[id] && w.order[id] === Order.Build && w.orderTarget[id] === site);
    expect(builders.length).toBe(1); // one is enough to start, the rest keep mining
    // castle takes damage: a second worker leaves the gold to patch it up
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    w.hp[castle] -= 200;
    for (let t = 0; t <= WORKER_DISPATCH_INTERVAL; t++) sim.step([]);
    expect(workers.some((id) => w.alive[id] && w.order[id] === Order.Repair && w.orderTarget[id] === castle)).toBe(true);
  });
});

describe('kill bounty', () => {
  it('pays a tenth of the victim cost, nothing for militia or friends', () => {
    const st = setup(23);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const p0 = sim.players[0];
    const archer = sim.spawnUnit(1, UnitType.Archer, fp(20), fp(20));
    const g0 = p0.gold;
    sim.dealDamage(archer, 1000, DamageType.Slash, -1, 0);
    expect(p0.gold - g0).toBe(Math.floor(UNITS[UnitType.Archer].cost / KILL_BOUNTY_DIV));
    expect(sim.events.some((e) => e.type === EventType.Bounty && e.owner === 0)).toBe(true);
    const militia = sim.spawnUnit(1, UnitType.Militia, fp(20), fp(21));
    const g1 = p0.gold;
    sim.dealDamage(militia, 1000, DamageType.Slash, -1, 0);
    expect(p0.gold).toBe(g1);
    const ownWorker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    sim.dealDamage(ownWorker, 1000, DamageType.Slash, -1, 0);
    expect(p0.gold).toBe(g1);
    expect(w.hp[ownWorker]).toBeLessThanOrEqual(0);
  });
});

describe('mine building', () => {
  it('holds three workers, pays by headcount, keeps them in the population and lets them out again', () => {
    const st = setup(24);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const p0 = sim.players[0];
    const workers = own(sim, 0, Kind.Unit, UnitType.Worker);
    const [mx, my] = spotNear(sim, 0, BuildingType.Mine);
    const mine = sim.spawnBuilding(0, BuildingType.Mine, mx, my, true);
    // the fourth worker stands still so mining does not blur the income numbers
    sim.step([{ type: CommandType.Stop, player: 0, ids: [workers[3]] }]);
    const cmd: Command = { type: CommandType.Garrison, player: 0, ids: workers.slice(0, 3), target: mine };
    expect(sim.validate(cmd)).toBeNull();
    sim.step([cmd]);
    for (let t = 0; t < 600 && w.carry[mine] < MINE_CAPACITY; t++) sim.step([]);
    expect(w.carry[mine]).toBe(MINE_CAPACITY);
    expect(own(sim, 0, Kind.Unit, UnitType.Worker).length).toBe(1);
    expect(p0.popUsed).toBe(4); // three inside still count
    expect(sim.validate({ type: CommandType.Garrison, player: 0, ids: [workers[3]], target: mine })).toBe('mineFull');
    const g0 = p0.gold;
    for (let t = 0; t < MINE_INCOME_TICKS * 4; t++) sim.step([]);
    const perPayout = MINE_CAPACITY * MINE_GOLD_PER_WORKER;
    expect(p0.gold - g0).toBeGreaterThanOrEqual(perPayout * 3);
    expect(p0.gold - g0).toBeLessThanOrEqual(perPayout * 5);
    // everyone out
    expect(sim.validate({ type: CommandType.Ungarrison, player: 0, ids: [mine] })).toBeNull();
    sim.step([{ type: CommandType.Ungarrison, player: 0, ids: [mine] }]);
    expect(w.carry[mine]).toBe(0);
    expect(own(sim, 0, Kind.Unit, UnitType.Worker).length).toBe(4);
    expect(p0.popUsed).toBe(4);
  });

  it('a mine destroyed with workers inside loses them', () => {
    const st = setup(25);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const [mx, my] = spotNear(sim, 0, BuildingType.Mine);
    const mine = sim.spawnBuilding(0, BuildingType.Mine, mx, my, true);
    w.carry[mine] = 2;
    sim.recountPop();
    expect(sim.players[0].popUsed).toBe(6);
    sim.dealDamage(mine, 100000, DamageType.Siege, -1, 1);
    sim.step([]);
    expect(w.alive[mine]).toBe(0);
    expect(sim.players[0].unitsLost).toBe(2);
    expect(sim.players[0].popUsed).toBe(4);
  });
});

describe('incendiary shot', () => {
  it('waits in the bucket, then flies and lights the ground where it lands', () => {
    const st = setup(26);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const p = sim.players[0];
    const cat = sim.spawnUnit(0, UnitType.Catapult, fp(p.startX + 0.5), fp(p.startY + 6.5));
    const tx = fp(p.startX + 4.5), ty = fp(p.startY + 6.5);
    const cmd: Command = { type: CommandType.Ability, player: 0, ids: [cat], v: AbilityId.Incendiary, x: tx, y: ty };
    expect(sim.validate(cmd)).toBeNull();
    sim.step([cmd]);
    const zones = () => own(sim, 0, Kind.Zone).length;
    const shots = own(sim, 0, Kind.Projectile);
    expect(shots.length).toBe(1);
    expect(zones()).toBe(0);
    expect(w.carry[shots[0]]).toBe(INCENDIARY_DELAY_TICKS - 1); // one tick already elapsed
    let launchedAt = -1, litAt = -1;
    for (let t = 0; t < 200 && litAt < 0; t++) {
      sim.step([]);
      for (const e of sim.events) {
        if (e.type === EventType.ProjectileLaunch && e.a === cat) launchedAt = sim.tick;
        if (e.type === EventType.Fire && e.a === cat) litAt = sim.tick;
      }
    }
    expect(launchedAt).toBeGreaterThan(0);
    expect(litAt).toBeGreaterThan(launchedAt);
    expect(zones()).toBe(1);
    const z = own(sim, 0, Kind.Zone)[0];
    expect(Math.abs(w.x[z] - tx)).toBeLessThan(fp(0.1));
    expect(Math.abs(w.y[z] - ty)).toBeLessThan(fp(0.1));
  });
});

describe('population', () => {
  it('a trained unit joins the population when it steps out and waits inside while the cap is full', () => {
    const st = setup(27);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const p = sim.players[0];
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    // fill the cap (10) with six extra workers
    for (let i = 0; i < 6; i++) sim.spawnUnit(0, UnitType.Worker, fp(p.startX + 3.5 + i * 0.3), fp(p.startY + 3.5));
    sim.step([]);
    expect(p.popUsed).toBe(10);
    expect(p.popCap).toBe(10);
    // queuing at the cap is allowed and does not reserve population
    const cmd: Command = { type: CommandType.Train, player: 0, ids: [castle], v: UnitType.Worker };
    expect(sim.validate(cmd)).toBeNull();
    sim.step([cmd]);
    expect(p.popUsed).toBe(10);
    for (let t = 0; t < UNITS[UnitType.Worker].trainTime + 5; t++) sim.step([]);
    expect(own(sim, 0, Kind.Unit, UnitType.Worker).length).toBe(10);
    expect(w.queueLen[castle]).toBe(1);
    expect(w.lifetime[castle]).toBe(1); // waiting badge
    // a house goes up: the worker steps out at once
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    sim.step([]); sim.step([]);
    expect(own(sim, 0, Kind.Unit, UnitType.Worker).length).toBe(11);
    expect(p.popUsed).toBe(11);
    expect(w.queueLen[castle]).toBe(0);
    expect(w.lifetime[castle]).toBe(0);
  });
});

describe('pathing', () => {
  const dist = (sim: Simulation, id: number, cx: number, cy: number) => Math.hypot(toFloat(sim.world.x[id]) - cx - 0.5, toFloat(sim.world.y[id]) - cy - 0.5);
  const runUntilIdle = (sim: Simulation, id: number, max: number) => { for (let t = 0; t < max && sim.world.order[id] !== Order.None; t++) sim.step([]); };

  it('a move into water ends at the shore, without grinding against it', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, m = sim.map, p = sim.players[0];
    let wx = -1, wy = -1;
    for (let y = 4; y < m.h && wx < 0; y++) for (let x = 4; x < m.w; x++) if (m.tiles[y * m.w + x] === Tile.Water) { wx = x; wy = y; break; }
    const u = sim.spawnUnit(0, UnitType.Soldier, fp(p.startX + 0.5), fp(p.startY + 4.5));
    sim.step([{ type: CommandType.Move, player: 0, ids: [u], x: fp(wx + 0.5), y: fp(wy + 0.5) }]);
    runUntilIdle(sim, u, 1500);
    expect(w.order[u]).toBe(Order.None);
    // it stands on the bank: its own cell is passable and water is one step away on the side it came from
    const cx = w.x[u] >> FP_SHIFT, cy = w.y[u] >> FP_SHIFT;
    expect(sim.path.isBlockedCell(cx, cy)).toBe(false);
    let waterNextDoor = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (m.tiles[(cy + dy) * m.w + cx + dx] === Tile.Water) waterNextDoor = true;
    expect(waterNextDoor).toBe(true);
    expect(dist(sim, u, wx, wy)).toBeLessThan(7);
    expect(w.stuck[u]).toBeLessThan(8); // it walked up and stopped, it did not push into the water for seconds
  });

  it('a move into the middle of a forest ends at its edge', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, m = sim.map, p = sim.players[0];
    let fx = -1, fy = -1, best = -1;
    for (let y = 4; y < m.h - 4; y++) for (let x = 4; x < m.w - 4; x++) {
      if (m.tiles[y * m.w + x] !== Tile.Forest) continue;
      let deep = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (m.tiles[(y + dy) * m.w + x + dx] === Tile.Forest) deep++;
      const far = Math.hypot(x - p.startX, y - p.startY);
      if (deep >= 9 && far > best && Math.hypot(x - sim.players[1].startX, y - sim.players[1].startY) > 12) { best = far; fx = x; fy = y; }
    }
    expect(fx).toBeGreaterThan(0);
    const u = sim.spawnUnit(0, UnitType.Soldier, fp(p.startX + 0.5), fp(p.startY + 4.5));
    sim.step([{ type: CommandType.Move, player: 0, ids: [u], x: fp(fx + 0.5), y: fp(fy + 0.5) }]);
    runUntilIdle(sim, u, 1500);
    expect(w.order[u]).toBe(Order.None);
    expect(dist(sim, u, fx, fy)).toBeLessThan(6);
    expect(w.stuck[u]).toBeLessThan(8);
  });

  it('a worker sent to a fenced-off deposit gives up instead of pushing at the fence forever', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const mine = sim.nearestMine(fp(p.startX), fp(p.startY));
    const [mx, my] = sim.footprintTopLeft(mine);
    for (let y = my - 2; y <= my + 4; y++) for (let x = mx - 2; x <= mx + 4; x++) {
      if (y === my - 2 || y === my + 4 || x === mx - 2 || x === mx + 4) sim.path.setFootprint(x, y, 1, true);
    }
    sim.step([{ type: CommandType.Gather, player: 0, ids: [worker], target: mine }]);
    for (let t = 0; t < 300; t++) sim.step([]);
    expect(w.order[worker] === Order.Gather && w.orderTarget[worker] === mine).toBe(false);
    expect(w.stuck[worker]).toBeLessThan(100);
  });

  it('a one-cell gap between obstacles lets everyone through, the catapult included', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    const bx = p.startX - 8, hole = p.startY;
    for (let y = 2; y < sim.map.h - 2; y++) if (y !== hole) sim.path.setFootprint(bx, y, 1, true);
    const soldier = sim.spawnUnit(0, UnitType.Soldier, fp(p.startX - 3.5), fp(hole + 0.5));
    const cat = sim.spawnUnit(0, UnitType.Catapult, fp(p.startX - 3.5), fp(hole + 3.5));
    const tx = bx - 5;
    sim.step([{ type: CommandType.Move, player: 0, ids: [soldier, cat], x: fp(tx + 0.5), y: fp(hole + 0.5) }]);
    for (let t = 0; t < 900; t++) sim.step([]);
    expect(toFloat(w.x[soldier])).toBeLessThan(bx); // through the gap and beyond
    expect(toFloat(w.x[cat])).toBeLessThan(bx); // the catapult too
    expect(w.order[cat]).toBe(Order.None);
  });

  // a big map with many players asks for more new fields per tick than the budget allows, every tick; the units
  // early in the order used to take all of it, and a unit trained later stood still for the rest of the match
  it('a unit late in the order still gets its route when the budget runs out every tick', () => {
    const st = setup(5, 'six-kingdoms');
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    // a wall with one gap between everybody and where they are sent: nobody can walk straight without a field
    const wallY = p.startY - 8;
    for (let x = 2; x < sim.map.w - 2; x++) if (x !== 6) sim.path.setFootprint(x, wallY, 1, true);
    const early: number[] = [];
    for (let i = 0; i < 8; i++) early.push(sim.spawnUnit(0, UnitType.Soldier, fp(p.startX + 3.5 + i), fp(p.startY + 4.5)));
    const late = sim.spawnUnit(0, UnitType.Soldier, fp(p.startX - 3.5), fp(p.startY + 4.5));
    sim.path.budgetPerTick = 1;
    const x0 = w.x[late], y0 = w.y[late];
    for (let t = 0; t < 100; t++) {
      // the early units want a destination nobody asked for before, every tick: every tick they need new fields
      const cmds: Command[] = early.map((id, i) => {
        const k = t * early.length + i;
        return { type: CommandType.Move, player: 0, ids: [id], x: fp(8 + (k % 112) + 0.5), y: fp(8 + Math.floor(k / 112) + 0.5) };
      });
      if (t === 0) cmds.push({ type: CommandType.Move, player: 0, ids: [late], x: fp(100.5), y: fp(20.5) });
      sim.step(cmds);
    }
    expect(Math.hypot(toFloat(w.x[late] - x0), toFloat(w.y[late] - y0))).toBeGreaterThan(5);
  });

  it('a field takes only the tiles its run reaches', () => {
    const st = setup(5, 'six-kingdoms');
    const sim = new Simulation(st, createMap(st.mapId));
    const p = sim.players[0], path = sim.path;
    const f = path.fieldFor(p.startX + 6, p.startY + 4, (p.startX + 3) * SUB, (p.startY + 4) * SUB)!;
    expect(f).not.toBeNull();
    expect(f.held.length).toBeGreaterThan(0);
    expect(f.held.length).toBeLessThan((path.tilesW * path.tilesH) / 16);
  });

  it('fields thrown out of a full cache leave nothing behind in the tiles they give back', () => {
    const map = createMap('six-kingdoms');
    const small = new Pathfinder(map, 2);
    const dests = [[20, 20], [100, 30], [64, 64], [30, 100], [110, 110]];
    const from = [[40, 40], [90, 90], [20, 110], [110, 20]];
    let compared = 0;
    for (let round = 0; round < 3; round++) for (let i = 0; i < dests.length; i++) {
      const [dx, dy] = dests[i], [fx, fy] = from[(i + round) % from.length];
      const f = small.fieldFor(dx, dy, fx * SUB, fy * SUB, false, -1, true)!;
      const ref = new Pathfinder(map);
      const g = ref.fieldFor(dx, dy, fx * SUB, fy * SUB, false, -1, true)!;
      for (let c = 0; c < small.w * small.h; c += 3) {
        if (!small.isSettled(f, c) || !ref.isSettled(g, c)) continue;
        expect(small.distAt(f, c)).toBe(ref.distAt(g, c));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  // the region labels are patched around every change instead of rebuilt; whatever gets built, burnt or torn down,
  // and whichever team asks (its own gates open), they must split the map exactly like a fresh flood fill does
  it('patched region labels always split the map like a fresh flood fill', () => {
    const map = createMap('six-kingdoms');
    const pf = new Pathfinder(map);
    const rng = new Rng(77);
    const W = pf.w, H = pf.h;
    const same = (heavy: boolean, team: number) => {
      const ref = new Int32Array(W * H).fill(-1);
      let next = 0;
      for (let s0 = 0; s0 < W * H; s0++) {
        if (ref[s0] >= 0 || pf.isBlockedFine(s0 % W, Math.floor(s0 / W), heavy, team)) continue;
        const q = [s0]; ref[s0] = next;
        while (q.length) {
          const c = q.pop()!, cx = c % W, cy = (c - cx) / W;
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || ref[ny * W + nx] >= 0 || pf.isBlockedFine(nx, ny, heavy, team)) continue;
            ref[ny * W + nx] = next; q.push(ny * W + nx);
          }
        }
        next++;
      }
      // the two labellings must be the same partition: a one-to-one map between their labels
      const ab = new Map<number, number>(), ba = new Map<number, number>();
      for (let c = 0; c < W * H; c++) {
        const a = pf.regionOf(c % W, Math.floor(c / W), heavy, team), b = ref[c];
        if ((a < 0) !== (b < 0)) return false;
        if (a < 0) continue;
        if ((ab.get(a) ?? b) !== b || (ba.get(b) ?? a) !== a) return false;
        ab.set(a, b); ba.set(b, a);
      }
      return true;
    };
    const check = () => { for (const heavy of [false, true]) for (const team of [-1, 0, 1]) expect(same(heavy, team)).toBe(true); };
    // a wall across the whole map splits it in two, a gap merges the halves again, closing it splits them once more
    check();
    for (let y = 2; y < map.h - 2; y++) pf.setFootprint(40, y, 1, true, 900 + y, false);
    check();
    pf.setFootprint(40, 60, 1, false);
    check();
    pf.setFootprint(40, 60, 1, true, 960, false);
    check();
    const placed: [number, number, number, number][] = [];
    const fences: number[] = [];
    let id = 1000;
    for (let step = 0; step < 80; step++) {
      const roll = rng.nextInt(10);
      if (roll < 5) {
        // a building somewhere, often flush against another so that seams open
        const size = 1 + rng.nextInt(3);
        const near = placed.length > 0 && rng.chance(0.6) ? placed[rng.nextInt(placed.length)] : null;
        const x = near ? near[0] + near[2] : 4 + rng.nextInt(map.w - 12), y = near ? near[1] + rng.nextInt(2) : 4 + rng.nextInt(map.h - 12);
        if (pf.footprintFree(x, y, size)) { pf.setFootprint(x, y, size, true, id, true); placed.push([x, y, size, id++]); }
      } else if (roll < 7 && placed.length > 0) {
        const [x, y, size] = placed.splice(rng.nextInt(placed.length), 1)[0];
        pf.setFootprint(x, y, size, false);
      } else if (roll < 8) {
        pf.setTerrain(4 + rng.nextInt(map.w - 8), 4 + rng.nextInt(map.h - 8), rng.chance(0.7));
      } else {
        // a fence line of four with a gate for team 0 or 1 in it, or a lone fence cell
        const x = 6 + rng.nextInt(map.w - 16), y = 6 + rng.nextInt(map.h - 16);
        let ok = true;
        for (let i = 0; i < 4; i++) if (!pf.footprintFree(x + i, y, 1)) ok = false;
        if (ok) for (let i = 0; i < 4; i++) { pf.setFootprint(x + i, y, 1, true, id++, false); fences.push(y * map.w + x + i); }
        const gates = [];
        for (let i = 0; i + 3 < fences.length; i += 4) {
          const c = fences.slice(i, i + 4) as [number, number, number, number];
          if (c[3] - c[0] === 3) gates.push({ cells: c, dir: 0 as const, team: (i >> 2) % 2, doorLow: [c[1]], doorHigh: [c[2]] });
        }
        pf.setGates(gates);
      }
      check();
    }
  });

  // fields are run as A* aimed at whoever asked; every cell they settle must still hold the true distance
  it('a field aimed at one unit holds the exact distances a full Dijkstra gives', () => {
    const map = createMap('six-kingdoms');
    const pf = new Pathfinder(map);
    const W = pf.w, H = pf.h, B = pf.blocked;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
    const reference = (dcx: number, dcy: number) => {
      const dist = new Int32Array(W * H).fill(UNREACHABLE), done = new Uint8Array(W * H);
      const open: number[] = [];
      for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
        const c = (dcy * SUB + sy) * W + dcx * SUB + sx;
        if (!B[c]) { dist[c] = 0; open.push(c); }
      }
      while (open.length) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[bi]]) bi = i;
        const c = open[bi]; open[bi] = open[open.length - 1]; open.pop();
        if (done[c]) continue;
        done[c] = 1;
        const cx = c % W, cy = (c - cx) / W;
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX[k], ny = cy + DY[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || B[ny * W + nx]) continue;
          if (k >= 4 && (B[cy * W + nx] || B[ny * W + cx])) continue;
          const nd = dist[c] + (k < 4 ? 10 : 14);
          if (nd < dist[ny * W + nx]) { dist[ny * W + nx] = nd; open.push(ny * W + nx); }
        }
      }
      return dist;
    };
    let settled = 0;
    for (const [dx, dy, ux, uy] of [[20, 20, 100, 90], [64, 64, 10, 118], [110, 30, 30, 100]]) {
      if (pf.isBlockedCell(dx, dy)) continue;
      const ref = reference(dx, dy);
      const f = pf.fieldFor(dx, dy, ux * SUB, uy * SUB, false, -1, true)!;
      expect(pf.isSettled(f, uy * SUB * W + ux * SUB) || ref[uy * SUB * W + ux * SUB] === UNREACHABLE).toBe(true);
      for (let c = 0; c < W * H; c++) {
        if (!pf.isSettled(f, c)) continue;
        expect(pf.distAt(f, c)).toBe(ref[c]);
        settled++;
      }
    }
    expect(settled).toBeGreaterThan(500);
  });
});

describe('flush buildings', () => {
  /** two houses side by side with open ground above and below the seam between them */
  function flushPair(sim: Simulation): [number, number] {
    const p = sim.players[0];
    for (let r = 4; r < 20; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const hx = p.startX + dx, hy = p.startY + dy;
      if (!canPlaceBuilding(sim, BuildingType.House, hx, hy, 0) || !canPlaceBuilding(sim, BuildingType.House, hx + 2, hy, 0)) continue;
      let clear = true;
      for (let y = hy - 3; y <= hy + 4 && clear; y++) for (let x = hx - 1; x <= hx + 4; x++) {
        if ((y >= hy && y < hy + 2) || !sim.path.inBounds(x, y) || sim.path.isBlockedCell(x, y)) { if (!(y >= hy && y < hy + 2)) clear = false; }
      }
      if (clear) return [hx, hy];
    }
    throw new Error('no room for two flush houses');
  }

  it('may be placed flush; footmen slip through the seam between them, a catapult cannot', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    const [cx, cy] = sim.footprintTopLeft(castle);
    // castle footprint is 3x3 at (cx,cy): a house directly east of it now touches it legally, so does a fence
    expect(canPlaceBuilding(sim, BuildingType.House, cx + 3, cy, 0)).toBe(true);
    expect(canPlaceBuilding(sim, BuildingType.Wall, cx + 3, cy, 0)).toBe(true);
    const [hx, hy] = flushPair(sim);
    sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    sim.spawnBuilding(0, BuildingType.House, hx + 2, hy, true);
    // the seam runs along x = hx + 2: half a cell of each house is open for footmen, closed for catapults
    const seamL = (hx + 2) * SUB - 1, seamR = (hx + 2) * SUB, row = hy * SUB;
    expect(sim.path.isBlockedFine(seamL, row, false)).toBe(false);
    expect(sim.path.isBlockedFine(seamR, row, false)).toBe(false);
    expect(sim.path.isBlockedFine(seamL - 1, row, false)).toBe(true); // the rest of the house is still solid
    expect(sim.path.isBlockedFine(seamL, row, true)).toBe(true);
    expect(sim.path.isBlockedFine(seamR, row, true)).toBe(true);
    expect(sim.path.isBlockedCell(hx, hy)).toBe(true); // and the map cell as a whole counts as built on
    // a soldier north of the seam walks straight through it to the south side
    const soldier = sim.spawnUnit(0, UnitType.Soldier, fp(hx + 2), fp(hy - 1.5));
    sim.step([{ type: CommandType.Move, player: 0, ids: [soldier], x: fp(hx + 2), y: fp(hy + 3.5) }]);
    let inSeam = false;
    for (let t = 0; t < 200 && w.order[soldier] !== Order.None; t++) {
      sim.step([]);
      const ux = toFloat(w.x[soldier]), uy = toFloat(w.y[soldier]);
      if (Math.abs(ux - (hx + 2)) < 0.5 && uy > hy && uy < hy + 2) inSeam = true;
    }
    expect(w.order[soldier]).toBe(Order.None);
    expect(toFloat(w.y[soldier])).toBeGreaterThan(hy + 2.5);
    expect(inSeam).toBe(true);
    // the heavy flow field never enters the seam
    // fields are advanced on demand: ask for the seam cells themselves so their distances are final
    const field = sim.path.fieldFor(hx + 2, hy + 3, seamL, row, true, true)!;
    sim.path.fieldFor(hx + 2, hy + 3, seamR, row, true, true);
    expect(sim.path.distAt(field, row * sim.path.w + seamL)).toBe(UNREACHABLE);
    expect(sim.path.distAt(field, row * sim.path.w + seamR)).toBe(UNREACHABLE);
    const light = sim.path.fieldFor(hx + 2, hy + 3, seamL, row, false, true)!;
    sim.path.fieldFor(hx + 2, hy + 3, seamR, row, false, true);
    expect(sim.path.distAt(light, row * sim.path.w + seamL)).not.toBe(UNREACHABLE);
  });

  it('a fence standing in front of a seam is tunnelled through, not sealed', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const [hx, hy] = flushPair(sim);
    sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    sim.spawnBuilding(0, BuildingType.House, hx + 2, hy, true);
    // two rows of fence laid flush against the pair, right across the mouth of their seam
    for (let dy = 1; dy <= 2; dy++) for (let x = hx; x <= hx + 2; x++) sim.spawnBuilding(0, BuildingType.Wall, x, hy - dy, true);
    const seamL = (hx + 2) * SUB - 1, seamR = (hx + 2) * SUB;
    for (let dy = 1; dy <= 2; dy++) for (let sy = 0; sy < SUB; sy++) {
      const row = (hy - dy) * SUB + sy;
      expect(sim.path.isBlockedFine(seamL, row, false)).toBe(false); // the corridor carries on through the wall
      expect(sim.path.isBlockedFine(seamR, row, false)).toBe(false);
      expect(sim.path.isBlockedFine(seamL - 1, row, false)).toBe(true); // the rest of the fence still stands
      expect(sim.path.isBlockedFine(seamR + 1, row, false)).toBe(true);
      expect(sim.path.isBlockedFine(seamL, row, true)).toBe(true); // and a catapult still gets nowhere near it
    }
    // a soldier north of the fence walks through it and the seam behind it in one go
    const soldier = sim.spawnUnit(0, UnitType.Soldier, fp(hx + 2), fp(hy - 2.5));
    sim.step([{ type: CommandType.Move, player: 0, ids: [soldier], x: fp(hx + 2), y: fp(hy + 3.5) }]);
    for (let t = 0; t < 300 && sim.world.order[soldier] !== Order.None; t++) sim.step([]);
    expect(toFloat(sim.world.y[soldier])).toBeGreaterThan(hy + 2.5);
  });

  it('a fence flush with a house seals the seam', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const [hx, hy] = flushPair(sim);
    sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    sim.spawnBuilding(0, BuildingType.Wall, hx + 2, hy, true);
    sim.spawnBuilding(0, BuildingType.Wall, hx + 2, hy + 1, true);
    const seamL = (hx + 2) * SUB - 1, seamR = (hx + 2) * SUB, row = hy * SUB;
    expect(sim.path.isBlockedFine(seamL, row, false)).toBe(true);
    expect(sim.path.isBlockedFine(seamR, row, false)).toBe(true);
  });
});

describe('worker mine duty', () => {
  it('a free worker staffs a mine with room before going for gold, but not a full one', () => {
    const st = setup(28);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const [mx, my] = spotNear(sim, 0, BuildingType.Mine);
    const mine = sim.spawnBuilding(0, BuildingType.Mine, mx, my, true);
    afterJob(sim, worker);
    expect(w.order[worker]).toBe(Order.Garrison);
    expect(w.orderTarget[worker]).toBe(mine);
    w.carry[mine] = MINE_CAPACITY;
    afterJob(sim, worker);
    expect(w.order[worker]).toBe(Order.Gather);
  });
});

describe('cavalry', () => {
  it('trains at the barracks and outruns a soldier', () => {
    const st = setup(29);
    const sim = new Simulation(st, createMap(st.mapId));
    sim.players[0].age = Age.Second; // cavalry is a second-age unit
    const p = sim.players[0];
    const [bx, by] = spotNear(sim, 0, BuildingType.Barracks);
    const barracks = sim.spawnBuilding(0, BuildingType.Barracks, bx, by, true);
    expect(sim.validate({ type: CommandType.Train, player: 0, ids: [barracks], v: UnitType.Cavalry })).toBeNull();
    const cav = sim.spawnUnit(0, UnitType.Cavalry, fp(p.startX + 0.5), fp(p.startY + 5.5));
    const sol = sim.spawnUnit(0, UnitType.Soldier, fp(p.startX + 1.5), fp(p.startY + 5.5));
    expect(sim.unitSpeed(cav)).toBeGreaterThan(sim.unitSpeed(sol) * 1.4);
    expect(UNITS[UnitType.Cavalry].trainedAt).toBe(BuildingType.Barracks);
  });
});

describe('random map', () => {
  it('is the same for the same seed, different for another, and every start reaches the centre', () => {
    const a = createMap(RANDOM_MAP_ID, 42), b = createMap(RANDOM_MAP_ID, 42), c = createMap(RANDOM_MAP_ID, 43);
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(a.tiles.some((t, i) => t !== c.tiles[i])).toBe(true);
    expect(a.starts.length).toBe(8);
    expect(a.mines.length).toBeGreaterThanOrEqual(9);
    const sim = new Simulation(setup(42, RANDOM_MAP_ID, 4), a);
    for (const st of a.starts) {
      // the chosen spawns carry a castle now, so measure from the free cell next to each start
      const cell = sim.path.nearestFree(st.x, st.y, 3);
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(sim.path.reachable(cell % a.w, Math.floor(cell / a.w), a.w >> 1, a.h >> 1)).toBe(true);
    }
    expect(sim.players.every((p) => p.castles === 1)).toBe(true);
    // two full matches from the same seed stay in lockstep
    const s1 = new Simulation(setup(42, RANDOM_MAP_ID, 4), createMap(RANDOM_MAP_ID, 42));
    const s2 = new Simulation(setup(42, RANDOM_MAP_ID, 4), createMap(RANDOM_MAP_ID, 42));
    for (let t = 0; t < 200; t++) { s1.step([]); s2.step([]); }
    expect(s1.hash()).toBe(s2.hash());
  });
});

describe('orders vs automation', () => {
  it('a worker mining on the player\'s order stays on gold; a self-chosen gatherer may be pulled to a site', () => {
    const st = setup(30);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    const workers = own(sim, 0, Kind.Unit, UnitType.Worker);
    const mine = sim.nearestMine(fp(p.startX), fp(p.startY));
    sim.step([{ type: CommandType.Gather, player: 0, ids: [workers[0]], target: mine }]);
    expect(w.orderV[workers[0]]).toBe(0);
    const [sx, sy] = spotNear(sim, 0, BuildingType.Barracks);
    sim.spawnBuilding(0, BuildingType.Barracks, sx, sy, false);
    for (let t = 0; t <= WORKER_DISPATCH_INTERVAL * 3; t++) sim.step([]);
    expect(w.order[workers[0]]).toBe(Order.Gather);
    expect(workers.slice(1).some((id) => w.order[id] === Order.Build)).toBe(true);
  });
});

describe('construction sites', () => {
  it('do not block movement until finished, but nothing can be placed on top of them', () => {
    const st = setup(31);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const [sx, sy] = spotNear(sim, 0, BuildingType.House);
    const site = sim.spawnBuilding(0, BuildingType.House, sx, sy, false);
    expect(sim.path.isBlockedCell(sx, sy)).toBe(false);
    expect(canPlaceBuilding(sim, BuildingType.Wall, sx, sy, 0)).toBe(false);
    while (w.state[site] === BuildingState.Constructing) { w.builders[site] = 1; sim.step([]); }
    expect(sim.path.isBlockedCell(sx, sy)).toBe(true);
  });
});

describe('forest fire', () => {
  it('an incendiary shot sets the forest alight; it burns down to passable dirt after eight seconds', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, m = sim.map, p = sim.players[0];
    // a forest cell far from the enemy, and a passable cell about five cells away to shoot from
    let fx = -1, fy = -1, best = 1e9;
    for (let y = 4; y < m.h - 4; y++) for (let x = 4; x < m.w - 4; x++) {
      if (m.tiles[y * m.w + x] !== Tile.Forest) continue;
      const dHome = Math.hypot(x - p.startX, y - p.startY), dEnemy = Math.hypot(x - sim.players[1].startX, y - sim.players[1].startY);
      if (dEnemy > 15 && dHome < best) { best = dHome; fx = x; fy = y; }
    }
    expect(fx).toBeGreaterThan(0);
    let cx = -1, cy = -1;
    for (let r = 4; r <= 6 && cx < 0; r++) for (let dy = -r; dy <= r && cx < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (!sim.path.isBlockedCell(fx + dx, fy + dy) && Math.hypot(dx, dy) <= 6.5) { cx = fx + dx; cy = fy + dy; break; }
    }
    expect(cx).toBeGreaterThan(0);
    const cat = sim.spawnUnit(0, UnitType.Catapult, fp(cx + 0.5), fp(cy + 0.5));
    const cmd: Command = { type: CommandType.Ability, player: 0, ids: [cat], v: AbilityId.Incendiary, x: fp(fx + 0.5), y: fp(fy + 0.5) };
    expect(sim.validate(cmd)).toBeNull();
    sim.step([cmd]);
    let lit = false;
    for (let t = 0; t < 120 && !lit; t++) { sim.step([]); lit = sim.burning.length > 0; }
    expect(lit).toBe(true);
    expect(m.tiles[fy * m.w + fx]).toBe(Tile.Forest);
    expect(sim.path.isBlockedCell(fx, fy)).toBe(true);
    let burnt = 0;
    for (let t = 0; t < FOREST_BURN_TICKS + 3; t++) { sim.step([]); for (const e of sim.events) if (e.type === EventType.ForestBurnt) burnt++; }
    expect(burnt).toBeGreaterThan(0);
    expect(m.tiles[fy * m.w + fx]).toBe(Tile.Dirt);
    expect(sim.path.isBlockedCell(fx, fy)).toBe(false);
    expect(sim.burning.length).toBe(0);
    // the shared official map data is untouched
    expect(createMap(st.mapId).tiles[fy * m.w + fx]).toBe(Tile.Forest);
    expect(w.alive[cat]).toBe(1);
  });
});

describe('crowds', () => {
  it('two units meeting head-on in a one-cell corridor pass each other', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    const y0 = p.startY + 6, x0 = p.startX - 16, x1 = p.startX - 3;
    for (let x = x0 - 1; x <= x1 + 1; x++) { sim.path.setFootprint(x, y0 - 1, 1, true); sim.path.setFootprint(x, y0 + 1, 1, true); }
    const a = sim.spawnUnit(0, UnitType.Soldier, fp(x0 + 1.5), fp(y0 + 0.5));
    const b = sim.spawnUnit(0, UnitType.Soldier, fp(x1 - 0.5), fp(y0 + 0.5));
    sim.step([
      { type: CommandType.Move, player: 0, ids: [a], x: fp(x1 - 0.5), y: fp(y0 + 0.5) },
      { type: CommandType.Move, player: 0, ids: [b], x: fp(x0 + 1.5), y: fp(y0 + 0.5) },
    ]);
    for (let t = 0; t < 600 && (w.order[a] !== Order.None || w.order[b] !== Order.None); t++) sim.step([]);
    expect(w.order[a]).toBe(Order.None);
    expect(w.order[b]).toBe(Order.None);
    expect(Math.abs(toFloat(w.x[a]) - (x1 - 0.5))).toBeLessThan(2);
    expect(Math.abs(toFloat(w.x[b]) - (x0 + 1.5))).toBeLessThan(2);
  });
});

describe('units inside a finished footprint', () => {
  it('keep their orders and walk out instead of cancelling', () => {
    const st = setup(32);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    const [sx, sy] = spotNear(sim, 0, BuildingType.Barracks);
    sim.spawnBuilding(0, BuildingType.Barracks, sx, sy, true);
    // a soldier that ends up in the middle of the finished footprint (a wall closed around it), ordered far away
    const u = sim.spawnUnit(0, UnitType.Soldier, fp(sx + 1.5), fp(sy + 1.5));
    expect(sim.path.isBlockedCell(w.x[u] >> FP_SHIFT, w.y[u] >> FP_SHIFT)).toBe(true);
    const tx = p.startX + 12, ty = p.startY + 12;
    sim.step([{ type: CommandType.Move, player: 0, ids: [u], x: fp(tx + 0.5), y: fp(ty + 0.5) }]);
    for (let t = 0; t < 40; t++) sim.step([]);
    expect(sim.path.isBlockedCell(w.x[u] >> FP_SHIFT, w.y[u] >> FP_SHIFT)).toBe(false); // pushed out
    expect(w.order[u]).toBe(Order.Move); // and still going
  });
});

describe('building limits', () => {
  it('a player owns at most six castles and three mines, sites and the starting castle included', () => {
    expect(BUILDING_LIMIT[BuildingType.Castle]).toBe(6);
    expect(BUILDING_LIMIT[BuildingType.Mine]).toBe(3);
    expect(buildingLimit(BuildingType.House)).toBe(Infinity);
    const st = setup(41, 'six-kingdoms');
    const sim = new Simulation(st, createMap(st.mapId));
    sim.fog.vis[0].fill(FOG_EXPLORED); // room for six castles needs more than the start area
    const w = sim.world;
    const p0 = sim.players[0];
    p0.gold = 100000;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const build = (type: BuildingType): Command => {
      const [x, y] = spotNear(sim, 0, type);
      return { type: CommandType.Build, player: 0, ids: [worker], v: type, x: fp(x), y: fp(y) };
    };
    // the starting castle is the first of six; four finished ones and a site make six
    for (let i = 0; i < 4; i++) { const [x, y] = spotNear(sim, 0, BuildingType.Castle); sim.spawnBuilding(0, BuildingType.Castle, x, y, true); }
    const site = build(BuildingType.Castle);
    expect(sim.validate(site)).toBeNull();
    sim.step([site]);
    expect(sim.buildingCount(0, BuildingType.Castle)).toBe(6);
    expect(sim.validate(build(BuildingType.Castle))).toBe('limit');
    // a lost castle frees its slot
    const lost = own(sim, 0, Kind.Building, BuildingType.Castle)[1];
    sim.destroyBuilding(lost, true);
    expect(sim.validate(build(BuildingType.Castle))).toBeNull();
    // the other player has slots of their own
    expect(sim.buildingCount(1, BuildingType.Castle)).toBe(1);

    // mines: two finished and one site are the cap
    for (let i = 0; i < 2; i++) { const [x, y] = spotNear(sim, 0, BuildingType.Mine); sim.spawnBuilding(0, BuildingType.Mine, x, y, true); }
    const mineSite = build(BuildingType.Mine);
    sim.step([mineSite]);
    expect(own(sim, 0, Kind.Building, BuildingType.Mine).length).toBe(3);
    const gold = p0.gold;
    const extra = build(BuildingType.Mine);
    expect(sim.validate(extra)).toBe('limit');
    sim.step([extra]);
    expect(own(sim, 0, Kind.Building, BuildingType.Mine).length).toBe(3);
    expect(p0.gold).toBeGreaterThanOrEqual(gold - 1); // nothing was charged
    expect(sim.events.some((e) => e.type === EventType.Rejected && e.owner === 0)).toBe(true);
    // cancelling the site gives the slot back
    const pending = own(sim, 0, Kind.Building, BuildingType.Mine).find((m) => w.state[m] === BuildingState.Constructing)!;
    sim.step([{ type: CommandType.CancelBuilding, player: 0, ids: [pending] }]);
    expect(sim.validate(build(BuildingType.Mine))).toBeNull();
    // other buildings stay unlimited
    for (let i = 0; i < 8; i++) { const [x, y] = spotNear(sim, 0, BuildingType.House); sim.spawnBuilding(0, BuildingType.House, x, y, true); }
    expect(sim.validate(build(BuildingType.House))).toBeNull();
  });
});

describe('dismantling', () => {
  it('a worker takes an own building apart half again as fast as it was built; the last castle is protected', () => {
    const st = setup(33);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    const house = sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    expect(sim.validate({ type: CommandType.Dismantle, player: 0, ids: [worker], target: castle })).toBe('lastCastle');
    expect(sim.validate({ type: CommandType.Dismantle, player: 0, ids: [worker], target: house })).toBeNull();
    sim.step([{ type: CommandType.Dismantle, player: 0, ids: [worker], target: house }]);
    // wait until the worker is at work, then measure one tick of progress
    let t = 0;
    while (t < 400 && w.alive[house] && w.progress[house] === BUILDINGS[BuildingType.House].buildTime * 10) { sim.step([]); t++; }
    const before = w.progress[house];
    sim.step([]);
    expect(before - w.progress[house]).toBe(Math.floor((BUILDER_MULT[0] * 150) / 100));
    let gone = false;
    for (let k = 0; k < 400 && !gone; k++) { sim.step([]); gone = !w.alive[house]; }
    expect(gone).toBe(true);
    expect(sim.players[0].buildingsLost).toBe(0); // taken apart, not lost in combat
    sim.step([]); // the worker notices next tick
    expect(w.order[worker]).not.toBe(Order.Dismantle); // moved on to the next job
  });
});

/**
 * A match on a freshly rolled map. The official maps come out of a cache that every test shares, and a
 * test that burns forest edits its tiles for everyone after it - so anything that cares about the terrain
 * around a chosen spot rolls its own map instead.
 */
function freshMatch(seed: number): Simulation {
  const st: MatchSetup = { ...setup(seed), mapId: RANDOM_MAP_ID };
  return new Simulation(st, createMap(RANDOM_MAP_ID, seed));
}

/** a free footprint well away from every castle, so nothing under test gets shot at by a building */
function openGround(sim: Simulation, type: BuildingType): [number, number] {
  const w = sim.world;
  const castles: [number, number][] = [];
  for (let id = 0; id < w.maxId; id++) {
    if (w.alive[id] && w.kind[id] === Kind.Building && w.type[id] === BuildingType.Castle) castles.push([toFloat(w.x[id]), toFloat(w.y[id])]);
  }
  const cx = Math.floor(sim.map.w / 2), cy = Math.floor(sim.map.h / 2);
  for (let r = 0; r < 24; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = cx + dx, y = cy + dy;
    if (!canPlaceBuilding(sim, type, x, y)) continue; // no player: the fog rule is not what is under test
    // clear of every castle's reach, and of the neutral vein sitting in the middle of most maps
    if (castles.some(([bx, by]) => Math.hypot(bx - x, by - y) < 16)) continue;
    if (sim.nearestMine(fp(x + 0.5), fp(y + 0.5), fp(6)) >= 0) continue;
    return [x, y];
  }
  throw new Error('no open ground');
}

describe('salvage', () => {
  it('a building taken apart pays back DISMANTLE_REFUND_PCT of its cost', () => {
    const st = setup(71);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    const house = sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    const p = sim.players[0];
    p.gold = 0;
    const minedBefore = p.goldMined;
    sim.step([{ type: CommandType.Dismantle, player: 0, ids: [worker], target: house }]);
    for (let k = 0; k < 900 && w.alive[house]; k++) sim.step([]);
    expect(w.alive[house]).toBeFalsy();
    // salvage is not mined gold, so netting the worker's deliveries out leaves exactly the refund
    expect(p.gold - (p.goldMined - minedBefore)).toBe(dismantleRefund(BuildingType.House));
    expect(dismantleRefund(BuildingType.House)).toBe(Math.floor((BUILDINGS[BuildingType.House].cost * DISMANTLE_REFUND_PCT) / 100));
  });

  it('a building destroyed in combat pays nothing', () => {
    const st = setup(72);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    const house = sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    sim.players[0].gold = 0;
    sim.dealDamage(house, 100000, DamageType.Siege, -1, 1);
    for (let k = 0; k < 5; k++) sim.step([]);
    expect(w.alive[house]).toBeFalsy();
    expect(sim.players[0].gold).toBe(0);
  });
});

describe('a gold vein takes any number of diggers', () => {
  it('a dozen workers dig the same vein at once - there is no seat limit', () => {
    const st = setup(73);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const p = sim.players[0];
    const vein = sim.nearestMine(fp(p.startX + 0.5), fp(p.startY + 0.5));
    expect(vein).toBeGreaterThanOrEqual(0);
    const crowd = [...own(sim, 0, Kind.Unit, UnitType.Worker)];
    for (let i = crowd.length; i < 12; i++) {
      const u = sim.spawnUnit(0, UnitType.Worker, w.x[vein] + fp(2.5 + (i % 3) * 0.7), w.y[vein] + fp((i % 4) * 0.7 - 1));
      if (u >= 0) crowd.push(u);
    }
    expect(crowd.length).toBe(12);
    sim.step([{ type: CommandType.Gather, player: 0, ids: crowd, target: vein }]);
    let peak = 0;
    for (let t = 0; t < 20 * 60; t++) {
      sim.step([]);
      let n = 0;
      for (const id of crowd) if (w.alive[id] && w.state[id] === UnitState.Gathering) n++;
      if (n > peak) peak = n;
    }
    // the old rule stopped at eight; the walk home is now the only thing that thins a crowded vein
    expect(peak).toBeGreaterThan(8);
  });
});

describe('the fence hardens with the age', () => {
  it('180 in wood, 300 in stone - a bigger jump than the flat age bonus', () => {
    expect(buildingMaxHp(BuildingType.Wall, Age.First)).toBe(180);
    expect(buildingMaxHp(BuildingType.Wall, Age.Second)).toBe(300);
    expect(buildingMaxHp(BuildingType.House, Age.Second)).toBe(Math.floor(BUILDINGS[BuildingType.House].hp * 1.3));
  });
});

describe('the ram', () => {
  it('is a first-age forge unit', () => {
    expect(UNITS[UnitType.Ram].age).toBe(Age.First);
    expect(UNITS[UnitType.Ram].trainedAt).toBe(BuildingType.Forge);
    expect(BUILDINGS[BuildingType.Forge].trains).toContain(UnitType.Ram);
    expect(hitsBuildingsOnly(UnitType.Ram)).toBe(true);
    expect(hitsBuildingsOnly(UnitType.Catapult)).toBe(false);
  });

  it('only ever swings at masonry: a man is neither taken as an order nor picked up on its own', () => {
    const sim = freshMatch(74);
    const w = sim.world;
    const [ox, oy] = openGround(sim, BuildingType.House);
    const ram = sim.spawnUnit(0, UnitType.Ram, fp(ox + 0.5), fp(oy + 0.5));
    const victim = sim.spawnUnit(1, UnitType.Soldier, fp(ox + 1.5), fp(oy + 0.5));
    expect(ram).toBeGreaterThanOrEqual(0);
    expect(victim).toBeGreaterThanOrEqual(0);
    const hp = w.hp[victim];
    sim.step([{ type: CommandType.Attack, player: 0, ids: [ram], target: victim }]);
    for (let t = 0; t < 20 * 20; t++) sim.step([]);
    expect(w.hp[victim]).toBe(hp); // the soldier was never touched
    expect(w.order[ram]).not.toBe(Order.Attack); // the order was dropped, not carried around
    expect(w.target[ram]).toBe(-1); // and nothing latched on by itself
  });

  it('brings a fence down faster than a soldier does', () => {
    const knock = (type: UnitType) => {
      const sim = freshMatch(75);
      const w = sim.world;
      const [fx, fy] = openGround(sim, BuildingType.Wall);
      const fence = sim.spawnBuilding(1, BuildingType.Wall, fx, fy, true);
      expect(fence).toBeGreaterThanOrEqual(0);
      const u = sim.spawnUnit(0, type, fp(fx + 2.5), fp(fy + 0.5));
      expect(u).toBeGreaterThanOrEqual(0);
      sim.step([{ type: CommandType.Attack, player: 0, ids: [u], target: fence }]);
      let t = 1;
      for (; t < 20 * 120 && w.alive[fence]; t++) sim.step([]);
      return w.alive[fence] ? Infinity : t;
    };
    const ram = knock(UnitType.Ram), soldier = knock(UnitType.Soldier);
    expect(ram).toBeLessThan(Infinity);
    expect(soldier).toBeLessThan(Infinity);
    expect(ram).toBeLessThan(soldier);
  });
});

describe('nothing reaches further than it can see', () => {
  it('every unit and defensive building sees at least as far as it shoots, at every range upgrade', () => {
    const st = setup(76);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const p = sim.players[0];
    const tower = sim.spawnBuilding(0, BuildingType.Tower, ...spotNear(sim, 0, BuildingType.Tower), true);
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    for (let lvl = 0; lvl <= UPGRADES[UpgradeId.Range].levels; lvl++) {
      p.upgrades[UpgradeId.Range] = lvl;
      for (let t = 0; t < UNIT_TYPE_COUNT; t++) {
        const id = sim.spawnUnit(0, t as UnitType, fp(p.startX + 0.5), fp(p.startY + 6.5));
        expect(id).toBeGreaterThanOrEqual(0);
        expect(sim.unitVision(id)).toBeGreaterThanOrEqual(toFloat(sim.unitRange(id)));
        w.release(id);
      }
      for (const b of [castle, tower]) {
        expect(b).toBeGreaterThanOrEqual(0);
        expect(sim.buildingVision(b)).toBeGreaterThanOrEqual(toFloat(sim.buildingRange(b)));
      }
    }
  });
});

describe('rally point as the first job', () => {
  /** train one worker at the castle and return it once it steps out */
  function trainWorker(sim: Simulation, castle: number): number {
    const w = sim.world;
    const before = new Set(own(sim, 0, Kind.Unit, UnitType.Worker));
    sim.step([{ type: CommandType.Train, player: 0, ids: [castle], v: UnitType.Worker }]);
    for (let t = 0; t < UNITS[UnitType.Worker].trainTime + 40; t++) {
      sim.step([]);
      for (const id of own(sim, 0, Kind.Unit, UnitType.Worker)) if (!before.has(id)) return id;
    }
    throw new Error('no worker trained');
  }

  it('a rally on a construction site sends new workers to build it, on a mine to staff it', () => {
    const st = setup(34);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    sim.players[0].gold = 5000;
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    const site = sim.spawnBuilding(0, BuildingType.House, hx, hy, false);
    expect(sim.validate({ type: CommandType.SetRally, player: 0, ids: [castle], x: w.x[site], y: w.y[site] })).toBeNull();
    sim.step([{ type: CommandType.SetRally, player: 0, ids: [castle], x: w.x[site], y: w.y[site] }]);
    const a = trainWorker(sim, castle);
    expect(w.order[a]).toBe(Order.Build);
    expect(w.orderTarget[a]).toBe(site);
    // now a mine with room
    const [mx, my] = spotNear(sim, 0, BuildingType.Mine);
    const mine = sim.spawnBuilding(0, BuildingType.Mine, mx, my, true);
    // explicit gather orders for everyone already around, so the dispatcher does not staff the mine on its own
    const vein = sim.nearestMine(w.x[castle], w.y[castle]);
    sim.step([{ type: CommandType.Gather, player: 0, ids: own(sim, 0, Kind.Unit, UnitType.Worker), target: vein }]);
    sim.step([{ type: CommandType.SetRally, player: 0, ids: [castle], x: w.x[mine], y: w.y[mine] }]);
    // the new worker may step out right next to the mine and vanish inside the very next tick, so watch the mine
    sim.step([{ type: CommandType.Train, player: 0, ids: [castle], v: UnitType.Worker }]);
    let staffed = false;
    for (let t = 0; t < UNITS[UnitType.Worker].trainTime + 200 && !staffed; t++) { sim.step([]); staffed = w.carry[mine] === 1; }
    expect(staffed).toBe(true);
  });
});

describe('ages', () => {
  it('the second age is researched at the castle behind a forge; it unlocks siege, deeper upgrades and stone-hard buildings', () => {
    const st = setup(35);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    p.gold = 5000;
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    const [fx, fy] = spotNear(sim, 0, BuildingType.Forge);
    const forge = sim.spawnBuilding(0, BuildingType.Forge, fx, fy, true);
    const [bx, by] = spotNear(sim, 0, BuildingType.Barracks);
    const barracks = sim.spawnBuilding(0, BuildingType.Barracks, bx, by, true);
    // first age: no siege, no cavalry, upgrades stop at level 1
    expect(sim.validate({ type: CommandType.Train, player: 0, ids: [forge], v: UnitType.Catapult })).toBe('age');
    expect(sim.validate({ type: CommandType.Train, player: 0, ids: [barracks], v: UnitType.Cavalry })).toBe('age');
    expect(sim.validate({ type: CommandType.Train, player: 0, ids: [barracks], v: UnitType.Soldier })).toBeNull();
    p.upgrades[UpgradeId.Armor] = 1;
    expect(sim.validate({ type: CommandType.Research, player: 0, ids: [forge], v: UpgradeId.Armor })).toBe('age');
    expect(sim.validate({ type: CommandType.AgeUp, player: 0, ids: [barracks] })).toBe('notOwner');
    const ageUp: Command = { type: CommandType.AgeUp, player: 0, ids: [castle] };
    expect(sim.validate(ageUp)).toBeNull();
    // cancelling refunds the whole price
    sim.step([ageUp]);
    expect(p.gold).toBe(5000 - AGE_UP.cost);
    expect(sim.validate(ageUp)).toBe('alreadyQueued');
    sim.step([{ type: CommandType.CancelQueue, player: 0, ids: [castle], v: 0 }]);
    expect(p.gold).toBe(5000);
    // research it for real
    const castleHp = w.maxHp[castle];
    sim.step([ageUp]);
    let events = 0;
    for (let t = 0; t < AGE_UP.time + 3 && p.age === Age.First; t++) { sim.step([]); for (const e of sim.events) if (e.type === EventType.AgeUp && e.owner === 0) events++; }
    expect(p.age).toBe(Age.Second);
    expect(events).toBe(1);
    expect(w.maxHp[castle]).toBe(buildingMaxHp(BuildingType.Castle, Age.Second));
    expect(w.maxHp[castle]).toBeGreaterThan(castleHp);
    expect(w.hp[castle]).toBe(w.maxHp[castle]); // it was whole before, it is whole after
    expect(sim.validate({ type: CommandType.Train, player: 0, ids: [forge], v: UnitType.Catapult })).toBeNull();
    expect(sim.validate({ type: CommandType.Research, player: 0, ids: [forge], v: UpgradeId.Armor })).toBeNull();
    expect(sim.validate(ageUp)).toBe('maxLevel');
    // a house built in the second age is born stone-hard
    const [hx, hy] = spotNear(sim, 0, BuildingType.House);
    const house = sim.spawnBuilding(0, BuildingType.House, hx, hy, true);
    expect(w.maxHp[house]).toBe(buildingMaxHp(BuildingType.House, Age.Second));
    // the other player is still in the first age
    expect(sim.players[1].age).toBe(Age.First);
  });

  it('entering the age keeps the damage share of every building', () => {
    const st = setup(36);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    w.hp[castle] = Math.floor(w.maxHp[castle] / 2);
    sim.ageUp(0, castle);
    expect(sim.players[0].age).toBe(Age.Second);
    expect(w.maxHp[castle]).toBe(buildingMaxHp(BuildingType.Castle, Age.Second));
    expect(Math.abs(w.hp[castle] / w.maxHp[castle] - 0.5)).toBeLessThan(0.01);
    expect(sim.events.some((e) => e.type === EventType.AgeUp && e.owner === 0 && e.v === Age.Second)).toBe(true);
  });

  it('the age is part of the state hash', () => {
    const st = setup(36);
    const a = new Simulation(st, createMap(st.mapId)), b = new Simulation(st, createMap(st.mapId));
    expect(a.hash()).toBe(b.hash());
    a.players[0].age = Age.Second;
    expect(a.hash()).not.toBe(b.hash());
  });
});

describe('tower garrison', () => {
  /** a finished tower well outside the castle's reach, an enemy soldier holding in its range, `garrison` workers inside */
  function towerScene(seed: number, garrison: number) {
    const st = setup(seed);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    let spot: [number, number] | null = null;
    for (let r = 11; r < 20 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = p.startX + dx, ty = p.startY + dy;
      if (!canPlaceBuilding(sim, BuildingType.Tower, tx, ty, -1)) continue; // -1: no fog check, the spot is far out
      if (sim.path.isBlockedCell(tx + 4, ty) || sim.path.isBlockedCell(tx + 4, ty + 1) || sim.path.isBlockedCell(tx + 3, ty + 3)) continue;
      if (Math.hypot(tx + 1 - (p.startX + 0.5), ty + 1 - (p.startY + 0.5)) < 11) continue;
      if (Math.hypot(tx - sim.players[1].startX, ty - sim.players[1].startY) < 14) continue;
      spot = [tx, ty]; break;
    }
    if (!spot) throw new Error('no tower spot');
    const [tx, ty] = spot;
    const tower = sim.spawnBuilding(0, BuildingType.Tower, tx, ty, true);
    for (let i = 0; i < garrison; i++) { const u = sim.spawnUnit(0, UnitType.Worker, fp(tx + 3.5), fp(ty + 3.5)); expect(garrisonWorker(sim, u, tower)).toBe(true); }
    const enemy = sim.spawnUnit(1, UnitType.Soldier, fp(tx + 4.5), fp(ty + 1));
    sim.step([{ type: CommandType.Hold, player: 1, ids: [enemy] }]);
    const hp0 = w.hp[enemy];
    for (let t = 0; t < 60 && w.hp[enemy] === hp0; t++) sim.step([]);
    return { sim, tower, enemy, lost: hp0 - w.hp[enemy] };
  }

  it('workers inside add damage to every shot and count as population', () => {
    const empty = towerScene(37, 0), full = towerScene(37, 3);
    expect(full.sim.world.carry[full.tower]).toBe(3);
    expect(empty.lost).toBeGreaterThan(0);
    expect(full.lost).toBeGreaterThan(empty.lost);
    expect(buildingDamage(BuildingType.Tower, 0, Age.First, 3)).toBe(BUILDINGS[BuildingType.Tower].damage + 3 * TOWER_GARRISON_DAMAGE);
    expect(full.sim.players[0].popUsed - empty.sim.players[0].popUsed).toBe(3 * UNITS[UnitType.Worker].pop);
    expect(full.sim.validate({ type: CommandType.Garrison, player: 0, ids: [own(full.sim, 0, Kind.Unit, UnitType.Worker)[0]], target: full.tower })).toBe('mineFull');
  });

  it('when the tower falls the garrison jumps clear and about half of them die', () => {
    let died = 0, survived = 0;
    for (const seed of [40, 41, 42, 43, 44, 45, 46, 47]) {
      const { sim, tower } = towerScene(seed, 3);
      const w = sim.world;
      const before = own(sim, 0, Kind.Unit, UnitType.Worker).length, lostBefore = sim.players[0].unitsLost;
      w.hp[tower] = 0;
      sim.step([]); sim.step([]);
      const d = sim.players[0].unitsLost - lostBefore, alive = own(sim, 0, Kind.Unit, UnitType.Worker).length - before;
      expect(d + alive).toBe(3);
      died += d; survived += alive;
    }
    expect(died).toBeGreaterThan(3);
    expect(survived).toBeGreaterThan(3);
  });

  it('dismantling a tower lets everyone out unharmed', () => {
    const { sim, tower } = towerScene(48, 3);
    const w = sim.world;
    const before = own(sim, 0, Kind.Unit, UnitType.Worker).length, lostBefore = sim.players[0].unitsLost;
    w.progress[tower] = 1; w.dismantlers[tower] = 1; // last blow of a dismantling crew
    sim.step([]);
    expect(w.alive[tower]).toBe(0);
    expect(own(sim, 0, Kind.Unit, UnitType.Worker).length - before).toBe(3);
    expect(sim.players[0].unitsLost).toBe(lostBefore);
  });
});

describe('tower on a fence', () => {
  it('may be raised over the player\'s own fence cells, which it absorbs; not over anything else', () => {
    const st = setup(39);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    let strip: [number, number] | null = null;
    for (let r = 4; r < 14 && !strip; r++) for (let dy = -r; dy <= r && !strip; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x0 = p.startX + dx, y0 = p.startY + dy;
      let ok = canPlaceBuilding(sim, BuildingType.House, x0 + 1, y0, 0) && canPlaceBuilding(sim, BuildingType.House, x0, y0, 0) && canPlaceBuilding(sim, BuildingType.House, x0 + 2, y0, 0);
      for (let i = 0; i < 4 && ok; i++) ok = canPlaceBuilding(sim, BuildingType.Wall, x0 + i, y0, 0);
      if (ok) { strip = [x0, y0]; break; }
    }
    if (!strip) throw new Error('no strip');
    const [x0, y0] = strip;
    const [bx, by] = spotNear(sim, 0, BuildingType.Barracks); // towers need a barracks
    if (!(bx + 3 <= x0 || bx >= x0 + 4 || by + 3 <= y0 || by >= y0 + 2)) throw new Error('barracks spot overlaps the strip');
    sim.spawnBuilding(0, BuildingType.Barracks, bx, by, true);
    const walls = [0, 1, 2, 3].map((i) => sim.spawnBuilding(0, BuildingType.Wall, x0 + i, y0, true));
    expect(canPlaceBuilding(sim, BuildingType.Tower, x0 + 1, y0, 0)).toBe(true); // two fence cells + two free ones
    expect(canPlaceBuilding(sim, BuildingType.Tower, x0 + 1, y0, 1)).toBe(false); // not on someone else's fence
    expect(canPlaceBuilding(sim, BuildingType.House, x0 + 1, y0, 0)).toBe(false); // only towers do this
    const worker = own(sim, 0, Kind.Unit, UnitType.Worker)[0];
    p.gold = 1000;
    const cmd: Command = { type: CommandType.Build, player: 0, ids: [worker], v: BuildingType.Tower, x: fp(x0 + 1), y: fp(y0) };
    expect(sim.validate(cmd)).toBeNull();
    const wallsBefore = own(sim, 0, Kind.Building, BuildingType.Wall).length;
    sim.step([cmd]);
    // ids get recycled, so look at what stands where: the two fence cells under the tower are gone, the ends remain
    expect(own(sim, 0, Kind.Building, BuildingType.Wall).length).toBe(wallsBefore - 2);
    expect(w.type[sim.buildingAt(fp(x0 + 0.5), fp(y0 + 0.5))]).toBe(BuildingType.Wall);
    expect(w.type[sim.buildingAt(fp(x0 + 3.5), fp(y0 + 0.5))]).toBe(BuildingType.Wall);
    const tower = sim.buildingAt(fp(x0 + 1.5), fp(y0 + 0.5));
    expect(tower).toBeGreaterThanOrEqual(0);
    expect(w.type[tower]).toBe(BuildingType.Tower);
    expect(sim.buildingAt(fp(x0 + 2.5), fp(y0 + 0.5))).toBe(tower);
    expect(walls.length).toBe(4);
  });
});

describe('age damage bonus', () => {
  it('stone castles hit for +10, stone towers a little harder', () => {
    expect(buildingDamage(BuildingType.Castle, 0, Age.Second, 0)).toBe(BUILDINGS[BuildingType.Castle].damage + 10);
    expect(buildingDamage(BuildingType.Tower, 0, Age.Second, 0)).toBeGreaterThan(BUILDINGS[BuildingType.Tower].damage);
    expect(buildingDamage(BuildingType.Tower, 1, Age.Second, 2)).toBe(BUILDINGS[BuildingType.Tower].damage + BUILDINGS[BuildingType.Tower].upgradeBonus + BUILDINGS[BuildingType.Tower].ageDamage + 2 * TOWER_GARRISON_DAMAGE);
  });
});

describe('castle defence', () => {
  it('a castle out-ranges a catapult', () => {
    const st = setup(8);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const castle = [...Array(w.maxId).keys()].find((id) => w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === 0)!;
    const cat = UNITS[UnitType.Catapult];
    // both measure from the castle wall to the catapult's outline, so the numbers compare directly
    expect(toFloat(sim.buildingRange(castle))).toBeGreaterThanOrEqual(cat.range);
    // and the two sides use the same metric: sweep a catapult along a diagonal across the range
    // boundary - wherever it can hit the castle, the castle can hit it back (and vice versa)
    const w2 = sim.world;
    const c = sim.spawnUnit(1, UnitType.Catapult, w2.x[castle], w2.y[castle]);
    let flips = 0;
    for (let k = 4.8; k <= 6.2; k += 0.01) {
      w2.x[c] = w2.x[castle] + fp(1.5 + k); w2.y[c] = w2.y[castle] + fp(1.5 + k);
      const catCanHit = sim.distToEntity(w2.x[c], w2.y[c], castle) <= fp(cat.range) + fp(cat.radius);
      const castleCanHit = sim.distFromBuilding(castle, c) <= sim.buildingRange(castle);
      expect(castleCanHit).toBe(catCanHit);
      if (!catCanHit) flips++;
    }
    expect(flips).toBeGreaterThan(0); // the sweep really crossed the boundary
  });

  it('a castle kills a lone catapult that comes to siege it', () => {
    const st = setup(9);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const castle = [...Array(w.maxId).keys()].find((id) => w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === 0)!;
    // spawns are random, so approach from the side that faces the map centre: every start has a carved corridor there
    const cx0 = w.x[castle] >> FP_SHIFT, cy0 = w.y[castle] >> FP_SHIFT;
    const mx = sim.map.w / 2, my = sim.map.h / 2;
    const len = Math.hypot(mx - cx0, my - cy0) || 1;
    const cell = sim.path.nearestFree(Math.round(cx0 + ((mx - cx0) / len) * 11), Math.round(cy0 + ((my - cy0) / len) * 11), 8);
    expect(cell).toBeGreaterThanOrEqual(0);
    const catGen = w.gen[castle];
    const cat = sim.spawnUnit(1, UnitType.Catapult, fp((cell % sim.map.w) + 0.5), fp(Math.floor(cell / sim.map.w) + 0.5));
    expect(cat).toBeGreaterThanOrEqual(0);
    const gen = w.gen[cat];
    sim.step([{ type: CommandType.Attack, player: 1, ids: [cat], target: castle }]);
    for (let t = 0; t < 20 * 90 && w.valid(cat, gen); t++) sim.step([]);
    expect(w.valid(cat, gen)).toBe(false); // catapult dead
    expect(w.valid(castle, catGen)).toBe(true); // castle still standing
    expect(w.hp[castle]).toBeGreaterThan(0);
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

describe('gates', () => {
  /**
   * A clear square of `size` cells, far enough from either spawn that nothing else stands in it.
   * Returns its top-left map cell.
   */
  function clearArea(sim: Simulation, size: number): [number, number] {
    const m = sim.map, p = sim.players[0];
    for (let r = 4; r < 24; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x0 = p.startX + dx, y0 = p.startY + dy;
      if (x0 < 3 || y0 < 3 || x0 + size >= m.w - 3 || y0 + size >= m.h - 3) continue;
      let ok = true;
      for (let y = y0 - 1; y <= y0 + size && ok; y++) for (let x = x0 - 1; x <= x0 + size; x++) {
        if (sim.path.isBlockedCell(x, y) || sim.path.isFootprint(x, y)) { ok = false; break; }
      }
      if (ok) return [x0, y0];
    }
    throw new Error('no clear area');
  }
  /** finished fence cells for `owner`, then one tick so the gates are laid */
  function fence(sim: Simulation, owner: number, cells: [number, number][]): void {
    for (const [x, y] of cells) expect(sim.spawnBuilding(owner, BuildingType.Wall, x, y, true)).toBeGreaterThanOrEqual(0);
    sim.step([]);
  }
  const row = (x0: number, y: number, n: number): [number, number][] => Array.from({ length: n }, (_, i) => [x0 + i, y] as [number, number]);
  /**
   * The fine cells of the door of a horizontal gate whose run starts at (x0,y): the inner half of each of the two
   * middle cells, so the corridor is one map cell wide and centred on the seam between them (Pathfinder.setGates).
   * A whole map cell is never freed, which is why isBlockedCell still reports both of them as occupied.
   */
  const doorFine = (x0: number, y: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let sy = 0; sy < SUB; sy++) out.push([(x0 + 1) * SUB + SUB - 1, y * SUB + sy], [(x0 + 2) * SUB, y * SUB + sy]);
    return out;
  };
  /** the start of the gate on a horizontal run, as an offset from x0 */
  const gateStartOn = (sim: Simulation, x0: number, y: number, len: number): number => {
    for (let i = 0; i + GATE_LENGTH <= len; i++) if (sim.path.gateAt(x0 + i, y) === 1) return i;
    return -1;
  };

  it('four fence cells in a line open a door for their own team and stay a wall for everyone else', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const [x0, y0] = clearArea(sim, GATE_LENGTH + 2);
    fence(sim, 0, row(x0, y0, GATE_LENGTH));
    // the door sits on the seam between the two middle cells, so both of them let the owner through
    const mine = sim.team(0), theirs = sim.team(1);
    expect(mine).not.toBe(theirs);
    for (let i = 0; i < GATE_LENGTH; i++) {
      expect(sim.path.gateAt(x0 + i, y0)).toBe(1 + i); // dir 0, position i along the run
      expect(sim.path.gateTeamAt(x0 + i, y0)).toBe(mine);
    }
    for (const [fx, fy] of doorFine(x0, y0)) {
      expect(sim.path.isBlockedFine(fx, fy, false, mine)).toBe(false); // ours walk in
      expect(sim.path.isBlockedFine(fx, fy, false, theirs)).toBe(true); // theirs meet a wall
      expect(sim.path.isBlockedFine(fx, fy, true, mine)).toBe(false); // wide enough for a catapult
      expect(sim.path.isBlockedFine(fx, fy, false)).toBe(true); // and for anyone with no team at all
    }
    // the outer half of each middle cell stays solid: the doorway is one cell wide, not two
    for (const fx of [(x0 + 1) * SUB, (x0 + 2) * SUB + SUB - 1]) {
      expect(sim.path.isBlockedFine(fx, y0 * SUB, false, mine)).toBe(true);
    }
    // the two cells the gatehouse towers stand on are solid for everybody
    for (const i of [0, GATE_LENGTH - 1]) {
      expect(sim.path.isBlockedCell(x0 + i, y0, false, mine)).toBe(true);
      expect(sim.path.isBlockedCell(x0 + i, y0, false, theirs)).toBe(true);
    }
  });

  it('three in a line are just a fence', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const [x0, y0] = clearArea(sim, GATE_LENGTH + 2);
    fence(sim, 0, row(x0, y0, GATE_LENGTH - 1));
    for (let i = 0; i < GATE_LENGTH - 1; i++) {
      expect(sim.path.gateAt(x0 + i, y0)).toBe(0);
      expect(sim.path.isBlockedCell(x0 + i, y0, false, sim.team(0))).toBe(true);
    }
  });

  it('losing one cell of the run shuts the gate again', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const [x0, y0] = clearArea(sim, GATE_LENGTH + 2);
    fence(sim, 0, row(x0, y0, GATE_LENGTH));
    const mine = sim.team(0);
    const [dfx, dfy] = doorFine(x0, y0)[0];
    expect(sim.path.isBlockedFine(dfx, dfy, false, mine)).toBe(false);
    const end = sim.buildingAt(fp(x0 + 0.5), fp(y0 + 0.5));
    expect(sim.world.type[end]).toBe(BuildingType.Wall);
    sim.destroyBuilding(end, true);
    sim.step([]);
    expect(sim.path.gateAt(x0 + 1, y0)).toBe(0);
    expect(sim.path.isBlockedFine(dfx, dfy, false, mine)).toBe(true);
  });

  it('a fence joining the run at the door pushes the gate along it', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const [x0, y0] = clearArea(sim, GATE_LENGTH + 4);
    // six in a row would take the middle four; a stub hanging off cell 2 makes that spot unusable
    fence(sim, 0, [...row(x0, y0, GATE_LENGTH + 2), [x0 + 2, y0 + 1]]);
    const gateStart = [...Array(GATE_LENGTH + 2).keys()].find((i) => sim.path.gateAt(x0 + i, y0) === 1);
    expect(gateStart).toBeDefined();
    // whichever way it slid, neither door cell may carry the stub
    for (const i of [gateStart! + 1, gateStart! + 2]) expect(i).not.toBe(2);
  });

  it('a second row laid flush against the first keeps the gate, and the door tunnels through both', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const [x0, y0] = clearArea(sim, GATE_LENGTH + 4);
    // exactly what a player does when a single fence feels too thin: drag a second line right behind the first
    fence(sim, 0, [...row(x0, y0, 6), ...row(x0, y0 + 1, 6)]);
    const mine = sim.team(0), theirs = sim.team(1);
    const g = gateStartOn(sim, x0, y0, 6);
    expect(g).toBeGreaterThanOrEqual(0); // the gate is still there - this is what a flush second row used to kill
    // the row behind carries no gatehouse of its own; its two middle cells are the rest of the corridor, one on
    // each side of the seam (GATE_TUNNEL + dir * 2 + side), which is how the renderer knows which half to keep
    expect(sim.path.gateAt(x0 + g + 1, y0 + 1)).toBe(GATE_TUNNEL);
    expect(sim.path.gateAt(x0 + g + 2, y0 + 1)).toBe(GATE_TUNNEL + 1);
    expect(gateStartOn(sim, x0, y0 + 1, 6)).toBe(-1); // and no second gatehouse in the wall
    // the channel is open to its owner through both rows, and to nobody else
    for (const y of [y0, y0 + 1]) for (const [fx, fy] of doorFine(x0 + g, y)) {
      expect(sim.path.isBlockedFine(fx, fy, false, mine)).toBe(false);
      expect(sim.path.isBlockedFine(fx, fy, false, theirs)).toBe(true);
      expect(sim.path.isBlockedFine(fx, fy, true, mine)).toBe(false); // a catapult still fits
    }
  });

  it('a block of fence deeper than a gate could tunnel gets none at all', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const side = GATE_LENGTH + 2;
    const [x0, y0] = clearArea(sim, side + 2);
    const cells: [number, number][] = [];
    for (let dy = 0; dy < side; dy++) cells.push(...row(x0, y0 + dy, side));
    fence(sim, 0, cells);
    for (let dy = 0; dy < side; dy++) for (let dx = 0; dx < side; dx++) {
      expect(sim.path.gateAt(x0 + dx, y0 + dy)).toBe(0); // no door through a bunker, and no stray tunnels either
    }
  });

  it('a walled courtyard lets its owner in and keeps the enemy out', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const size = 6;
    const [x0, y0] = clearArea(sim, size);
    const ring: [number, number][] = [];
    for (let i = 0; i < size; i++) {
      ring.push([x0 + i, y0], [x0 + i, y0 + size - 1]);
      if (i > 0 && i < size - 1) ring.push([x0, y0 + i], [x0 + size - 1, y0 + i]);
    }
    fence(sim, 0, ring);
    const inside: [number, number] = [x0 + size / 2, y0 + size / 2];
    // the courtyard has a gate, and only its owner may use it
    expect(sim.path.reachable(x0 - 2, y0 - 2, inside[0], inside[1], false, sim.team(0))).toBe(true);
    expect(sim.path.reachable(x0 - 2, y0 - 2, inside[0], inside[1], false, sim.team(1))).toBe(false);
    expect(sim.path.reachable(x0 - 2, y0 - 2, inside[0], inside[1], false)).toBe(false);

    const ally = sim.spawnUnit(0, UnitType.Soldier, fp(x0 - 2.5), fp(y0 - 2.5));
    const foe = sim.spawnUnit(1, UnitType.Soldier, fp(x0 - 2.5), fp(y0 + size + 1.5));
    const target = { x: fp(inside[0] + 0.5), y: fp(inside[1] + 0.5) };
    sim.step([{ type: CommandType.Move, player: 0, ids: [ally], ...target }]);
    sim.step([{ type: CommandType.Move, player: 1, ids: [foe], ...target }]);
    for (let t = 0; t < 1200; t++) sim.step([]);
    const within = (id: number) => toFloat(w.x[id]) > x0 && toFloat(w.x[id]) < x0 + size && toFloat(w.y[id]) > y0 && toFloat(w.y[id]) < y0 + size;
    expect(within(ally)).toBe(true); // walked in through its own gate
    expect(within(foe)).toBe(false); // the same gate is a wall to it
    expect(w.order[foe]).toBe(Order.None); // and it gave up rather than grinding at the fence
  });

  it('a courtyard walled two rows thick behaves the same', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const size = 8;
    const [x0, y0] = clearArea(sim, size);
    const ring: [number, number][] = [];
    for (let k = 0; k < 2; k++) {
      const a = x0 + k, b = y0 + k, n = size - 2 * k;
      for (let i = 0; i < n; i++) {
        ring.push([a + i, b], [a + i, b + n - 1]);
        if (i > 0 && i < n - 1) ring.push([a, b + i], [a + n - 1, b + i]);
      }
    }
    fence(sim, 0, ring);
    const inside: [number, number] = [x0 + size / 2, y0 + size / 2];
    expect(sim.path.reachable(x0 - 2, y0 - 2, inside[0], inside[1], false, sim.team(0))).toBe(true);
    expect(sim.path.reachable(x0 - 2, y0 - 2, inside[0], inside[1], false, sim.team(1))).toBe(false);
    const ally = sim.spawnUnit(0, UnitType.Soldier, fp(x0 - 2.5), fp(y0 - 2.5));
    sim.step([{ type: CommandType.Move, player: 0, ids: [ally], x: fp(inside[0] + 0.5), y: fp(inside[1] + 0.5) }]);
    for (let t = 0; t < 1500; t++) sim.step([]);
    expect(toFloat(w.x[ally])).toBeGreaterThan(x0 + 1);
    expect(toFloat(w.x[ally])).toBeLessThan(x0 + size - 1);
    expect(toFloat(w.y[ally])).toBeGreaterThan(y0 + 1);
    expect(toFloat(w.y[ally])).toBeLessThan(y0 + size - 1);
  });

  it('siege engines drive through their own gate although no seam is open to them', () => {
    const st = setup(3);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world;
    const len = 8;
    const [x0, y0] = clearArea(sim, len);
    const wallY = y0 + 3;
    fence(sim, 0, row(x0, wallY, len));
    const g = gateStartOn(sim, x0, wallY, len);
    expect(g).toBeGreaterThanOrEqual(0);
    for (const [fx, fy] of doorFine(x0 + g, wallY)) {
      expect(sim.path.isBlockedFine(fx, fy, true, sim.team(0))).toBe(false); // the door is a door for a catapult too
      expect(sim.path.isBlockedFine(fx, fy, true, sim.team(1))).toBe(true); // and a wall to everybody else
    }
    // both siege engines walk the whole way through, one after the other
    const doorX = x0 + g + 2;
    for (const type of [UnitType.Catapult, UnitType.Ram]) {
      const u = sim.spawnUnit(0, type, fp(doorX), fp(wallY - 1.5));
      sim.step([{ type: CommandType.Move, player: 0, ids: [u], x: fp(doorX), y: fp(wallY + 2.5) }]);
      for (let t = 0; t < 600 && w.order[u] !== Order.None; t++) sim.step([]);
      expect(toFloat(w.y[u])).toBeGreaterThan(wallY + 1.5);
    }
  });
});
