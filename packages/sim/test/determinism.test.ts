import { describe, expect, it } from 'vitest';
import {
  AbilityId, BUILDER_MULT, BUILDINGS, BUILDING_TYPE_COUNT, BuildingState, BuildingType, Command, CommandType, DamageType, EventType,
  FOG_EXPLORED, FOG_VISIBLE, INCENDIARY_DELAY_TICKS, Kind, KILL_BOUNTY_DIV, MINE_CAPACITY, MINE_GOLD_PER_WORKER, MINE_INCOME_TICKS,
  MatchSetup, OFFICIAL_MAPS, Order, PLAYER_COLORS, ReplayPlayer, ReplayRecorder, Rng, SITE_HIT_SLOW_PCT, SITE_HIT_SLOW_TICKS,
  Simulation, UNITS, UnitType, WORKER_DISPATCH_INTERVAL, afterJob, canPlaceBuilding, createMap, fp, FP_SHIFT, toFloat,
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
    expect(sim.path.isBlockedCell(cx, cy)).toBe(true);
    let done = false;
    for (let t = 0; t < 600 && !done; t++) {
      sim.step([]);
      for (const e of sim.events) if (e.type === EventType.BuildingComplete && e.v === BuildingType.Wall) done = true;
    }
    expect(done).toBe(true);
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
