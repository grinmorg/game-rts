import { describe, expect, it } from 'vitest';
import {
  AbilityId, BUILDER_MULT, BUILDINGS, BUILDING_TYPE_COUNT, BuildingState, BuildingType, Command, CommandType, DamageType, EventType,
  FOG_EXPLORED, FOG_VISIBLE, FOREST_BURN_TICKS, INCENDIARY_DELAY_TICKS, Kind, KILL_BOUNTY_DIV, MINE_CAPACITY, MINE_GOLD_PER_WORKER,
  MINE_INCOME_TICKS, MatchSetup, OFFICIAL_MAPS, Order, PLAYER_COLORS, RANDOM_MAP_ID, ReplayPlayer, ReplayRecorder, Rng, SITE_HIT_SLOW_PCT,
  SITE_HIT_SLOW_TICKS, Simulation, Tile, UNITS, UnitType, WORKER_DISPATCH_INTERVAL, afterJob, canPlaceBuilding, createMap, fp, FP_SHIFT,
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

  it('footmen pass a one-cell gap between obstacles, a catapult does not', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const w = sim.world, p = sim.players[0];
    const bx = p.startX - 8, hole = p.startY;
    for (let y = 2; y < sim.map.h - 2; y++) if (y !== hole) sim.path.setFootprint(bx, y, 1, true);
    const soldier = sim.spawnUnit(0, UnitType.Soldier, fp(p.startX - 3.5), fp(hole + 0.5));
    const cat = sim.spawnUnit(0, UnitType.Catapult, fp(p.startX - 3.5), fp(hole + 3.5));
    const tx = bx - 5;
    sim.step([{ type: CommandType.Move, player: 0, ids: [soldier, cat], x: fp(tx + 0.5), y: fp(hole + 0.5) }]);
    for (let t = 0; t < 700; t++) sim.step([]);
    expect(toFloat(w.x[soldier])).toBeLessThan(bx); // through the gap and beyond
    expect(toFloat(w.x[cat])).toBeGreaterThan(bx + 0.5); // parked on the near side
    expect(w.order[cat]).toBe(Order.None); // and not grinding at the gap
  });
});

describe('placement lanes', () => {
  it('buildings keep a one-cell lane between them, fences may touch anything', () => {
    const st = setup(5);
    const sim = new Simulation(st, createMap(st.mapId));
    const p = sim.players[0];
    const castle = own(sim, 0, Kind.Building, BuildingType.Castle)[0];
    const [cx, cy] = sim.footprintTopLeft(castle);
    // castle footprint is 3x3 at (cx,cy): a house directly east of it touches, one cell further leaves a lane
    expect(canPlaceBuilding(sim, BuildingType.House, cx + 3, cy, 0)).toBe(false);
    expect(canPlaceBuilding(sim, BuildingType.House, cx + 4, cy, 0)).toBe(true);
    expect(canPlaceBuilding(sim, BuildingType.Wall, cx + 3, cy, 0)).toBe(true);
    expect(p.startX).toBe(cx + 1);
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
