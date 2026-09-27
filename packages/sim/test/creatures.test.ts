import { describe, expect, it } from 'vitest';
import {
  CREATURE_LEASH, CREATURE_LEASH_PROVOKED, CREATURE_PATROL_RADIUS, CREATURE_TYPES, CommandType, CustomMapSource, EventType, KILL_BOUNTY_DIV, Kind,
  MatchSetup, Order, PLAYER_COLORS, SIM_VERSION, Simulation, Tile, UNITS, UPGRADES, UnitType, UpgradeId, blankCustomMap, customMapId,
  decodeCustomSource, encodeCustomMap, fp, isCreature, mapForSetup, toFloat, validateCustomMap,
} from '../src';

/** an open two-zone field: castles far west and east, a lake in the middle, golems placed by each test */
function field(creatures: CustomMapSource['creatures'] = []): CustomMapSource {
  const w = 80, h = 48;
  const src = blankCustomMap('Golem field', w, h);
  for (let y = 18; y < 30; y++) for (let x = 36; x < 44; x++) src.tiles[y * w + x] = Tile.Water;
  src.starts.push({ x: 8, y: 24, zone: 0 }, { x: w - 9, y: 24, zone: 1 });
  src.mines.push({ x: 4, y: 24, gold: 6000 }, { x: w - 5, y: 24, gold: 6000 });
  src.creatures = creatures;
  return src;
}

function sim(src: CustomMapSource, seed = 7): Simulation {
  const payload = encodeCustomMap(src);
  const setup: MatchSetup = {
    seed, mapId: customMapId('golems'), map: payload, version: SIM_VERSION,
    players: [0, 1].map((i) => ({ slot: i, team: i, name: `P${i}`, isBot: false, color: PLAYER_COLORS[i] })),
  };
  return new Simulation(setup, mapForSetup(setup));
}

function creatures(s: Simulation): number[] {
  const w = s.world, out: number[] = [];
  for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] < 0) out.push(id);
  return out;
}

const cells = (s: Simulation, id: number, x: number, y: number) => toFloat(Math.hypot(s.world.x[id] - fp(x + 0.5), s.world.y[id] - fp(y + 0.5)));

describe('golems on a custom map', () => {
  it('travel in the payload only when there are any, and survive the round trip', () => {
    const plain = encodeCustomMap(field());
    expect(JSON.parse(plain).g).toBeUndefined();
    const src = field([{ x: 40, y: 10, size: 0 }, { x: 40, y: 38, size: 2 }]);
    const back = decodeCustomSource(encodeCustomMap(src))!;
    expect(back.creatures).toEqual(src.creatures);
    // an old payload has no `g` and decodes to no creatures
    expect(decodeCustomSource(plain)!.creatures).toEqual([]);
  });

  it('refuses a malformed creature list', () => {
    const good = JSON.parse(encodeCustomMap(field([{ x: 40, y: 10, size: 1 }])));
    for (const g of [5, [[40, 10, 3]], [[40, 10, -1]], [[80, 10, 0]], [[40, 10]], [['a', 10, 0]], Array.from({ length: 257 }, () => [40, 10, 0])]) {
      expect(decodeCustomSource(JSON.stringify({ ...good, g }))).toBeNull();
    }
  });

  it('must stand on open ground, off the deposits and well clear of the spawns', () => {
    expect(validateCustomMap(field([{ x: 40, y: 10, size: 2 }])).filter((i) => i.error)).toEqual([]);
    const codes = (c: CustomMapSource['creatures']) => validateCustomMap(field(c)).filter((i) => i.error).map((i) => i.code);
    expect(codes([{ x: 40, y: 20, size: 0 }])).toEqual(['creatureBlocked']); // in the lake
    expect(codes([{ x: 4, y: 25, size: 0 }])).toEqual(['creatureBlocked']); // on the deposit
    expect(codes([{ x: 16, y: 24, size: 0 }])).toEqual(['creatureNearStart']); // on the castle's doorstep
  });

  it('spawn ownerless on their lairs, and a map without them plays exactly as before', () => {
    const s = sim(field([{ x: 40, y: 10, size: 0 }, { x: 30, y: 38, size: 1 }, { x: 50, y: 38, size: 2 }]));
    const ids = creatures(s);
    expect(ids.map((id) => s.world.type[id])).toEqual(CREATURE_TYPES);
    for (const id of ids) {
      expect(isCreature(s.world.type[id] as UnitType)).toBe(true);
      expect(s.world.hp[id]).toBe(UNITS[s.world.type[id] as UnitType].hp);
      expect(s.world.order[id]).toBe(Order.Patrol);
    }
    // the players' castles and workers come first, with the ids they always had
    const a = sim(field()), b = sim(field([{ x: 40, y: 10, size: 0 }]));
    expect(b.world.maxId).toBe(a.world.maxId + 1);
    for (let id = 0; id < a.world.maxId; id++) {
      expect([b.world.kind[id], b.world.owner[id], b.world.x[id], b.world.y[id]]).toEqual([a.world.kind[id], a.world.owner[id], a.world.x[id], a.world.y[id]]);
    }
  });

  it('stroll around the lair and leave each other alone', () => {
    const s = sim(field([{ x: 40, y: 10, size: 0 }, { x: 41, y: 11, size: 2 }]));
    const ids = creatures(s);
    const start = ids.map((id) => [s.world.x[id], s.world.y[id]]);
    let far = 0, moved = false;
    for (let t = 0; t < 20 * 90; t++) {
      s.step([]);
      far = Math.max(far, cells(s, ids[0], 40, 10), cells(s, ids[1], 41, 11));
      if (s.world.x[ids[0]] !== start[0][0] || s.world.y[ids[0]] !== start[0][1]) moved = true;
    }
    expect(moved).toBe(true);
    // the patch, plus the push of a big neighbour standing in the way
    expect(far).toBeLessThan(CREATURE_PATROL_RADIUS + 1.5);
    for (const id of ids) expect(s.world.hp[id]).toBe(s.world.maxHp[id]);
  });

  it('run at an enemy that comes into sight and fight it', () => {
    const s = sim(field([{ x: 40, y: 38, size: 1 }]));
    const [g] = creatures(s);
    const soldier = s.spawnUnit(0, UnitType.Soldier, fp(40.5), fp(38.5 - UNITS[UnitType.GolemMedium].vision + 1));
    // a soldier on hold does not start the fight: the golem has to come for him
    s.step([{ type: CommandType.Hold, player: 0, ids: [soldier] }]);
    let hit = false;
    for (let t = 0; t < 20 * 10 && s.world.alive[soldier]; t++) {
      s.step([]);
      if (s.events.some((e) => e.type === EventType.Attack && e.a === g && e.b === soldier)) hit = true;
    }
    expect(hit).toBe(true);
    expect(s.world.alive[soldier] ? s.world.hp[soldier] : 0).toBeLessThan(UNITS[UnitType.Soldier].hp);
  });

  it('give up the chase at the end of the leash and walk home', () => {
    const s = sim(field([{ x: 40, y: 38, size: 0 }]));
    const [g] = creatures(s);
    const soldier = s.spawnUnit(0, UnitType.Soldier, fp(40.5), fp(34.5));
    // wait for the golem to come for him, then run west along the open row
    for (let t = 0; t < 20 * 5 && s.world.target[g] !== soldier; t++) s.step([]);
    expect(s.world.target[g]).toBe(soldier);
    s.step([{ type: CommandType.Move, player: 0, ids: [soldier], x: fp(14.5), y: fp(38.5) }]);
    let far = 0, turned = false;
    for (let t = 0; t < 20 * 40; t++) {
      s.step([]);
      far = Math.max(far, cells(s, g, 40, 38));
      if (s.world.order[g] === Order.Move) turned = true;
    }
    expect(turned).toBe(true);
    expect(far).toBeLessThan(CREATURE_LEASH + 0.5);
    expect(far).toBeGreaterThan(CREATURE_LEASH - 1);
    expect(s.world.order[g]).toBe(Order.Patrol);
    expect(cells(s, g, 40, 38)).toBeLessThan(CREATURE_PATROL_RADIUS + 0.5);
    expect(s.world.alive[soldier]).toBe(1);
  });

  it('pay a bounty to whoever kills them', () => {
    const s = sim(field([{ x: 40, y: 38, size: 0 }]));
    const [g] = creatures(s);
    const squad = [-1, 0, 1].map((k) => s.spawnUnit(1, UnitType.Soldier, fp(40.5 + k), fp(36.5)));
    s.step([{ type: CommandType.Attack, player: 1, ids: squad, target: g }]);
    let bounty = -1;
    for (let t = 0; t < 20 * 30 && s.world.alive[g]; t++) {
      s.step([]);
      const e = s.events.find((x) => x.type === EventType.Bounty && x.a === g);
      if (e) { bounty = e.v; expect(e.owner).toBe(1); }
    }
    expect(s.world.alive[g]).toBe(0);
    expect(bounty).toBe(Math.floor(UNITS[UnitType.GolemSmall].cost / KILL_BOUNTY_DIV));
    expect(s.players[1].unitsKilled).toBe(1);
  });

  it('the great golem fells a catapult in two blows, whatever its armour', () => {
    for (const armor of [0, UPGRADES[UpgradeId.Armor].levels]) {
      const s = sim(field([{ x: 40, y: 38, size: 2 }]));
      const [g] = creatures(s);
      s.players[0].upgrades[UpgradeId.Armor] = armor;
      const cat = s.spawnUnit(0, UnitType.Catapult, fp(40.5), fp(36.5));
      s.step([{ type: CommandType.Hold, player: 0, ids: [cat] }]);
      let blows = 0;
      for (let t = 0; t < 20 * 20 && s.world.alive[cat]; t++) {
        s.step([]);
        blows += s.events.filter((e) => e.type === EventType.Attack && e.a === g && e.b === cat).length;
      }
      expect(s.world.alive[cat], `armour ${armor}`).toBe(0);
      expect(blows, `armour ${armor}`).toBe(2);
    }
  });

  it('hear a catapult that shells them from beyond their sight, and go for it', () => {
    // the medium one: two boulders are the end of a small golem before it gets there
    const s = sim(field([{ x: 40, y: 38, size: 1 }]));
    const [g] = creatures(s);
    s.world.timer[g] = 20 * 600; // standing still on the lair, so the only thing that can move it is the hit
    s.players[0].upgrades[UpgradeId.Range] = UPGRADES[UpgradeId.Range].levels;
    // out of the golem's sight (it would see the catapult's outline within its vision), inside the upgraded reach
    const dist = UNITS[UnitType.GolemMedium].vision + UNITS[UnitType.Catapult].radius + 0.3;
    expect(dist).toBeLessThan(UNITS[UnitType.Catapult].range + UPGRADES[UpgradeId.Range].levels + UNITS[UnitType.Catapult].radius + UNITS[UnitType.GolemMedium].radius);
    const cat = s.spawnUnit(0, UnitType.Catapult, fp(40.5 + dist), fp(38.5));
    s.step([{ type: CommandType.Hold, player: 0, ids: [cat] }]);
    let landed = false, far = 0, struck = false;
    for (let t = 0; t < 20 * 60 && !struck; t++) {
      s.step([]);
      if (s.events.some((e) => e.type === EventType.ProjectileLand)) landed = true;
      if (!landed) expect(s.world.target[g], 'it cannot see the catapult before the first boulder lands').toBe(-1);
      if (s.events.some((e) => e.type === EventType.Attack && e.a === g && e.b === cat)) struck = true;
      far = Math.max(far, cells(s, g, 40, 38));
    }
    expect(landed).toBe(true);
    expect(struck).toBe(true);
    expect(far).toBeLessThan(CREATURE_LEASH_PROVOKED + 0.5);
  });

  it('stay deterministic through a fight', () => {
    const run = () => {
      const s = sim(field([{ x: 22, y: 24, size: 2 }, { x: 58, y: 24, size: 1 }]), 11);
      // a soldier of each side wanders into the golems: a fight on each flank
      const a = s.spawnUnit(0, UnitType.Soldier, fp(22.5), fp(19.5));
      const b = s.spawnUnit(1, UnitType.Archer, fp(58.5), fp(30.5));
      s.step([{ type: CommandType.AttackMove, player: 0, ids: [a], x: fp(22.5), y: fp(24.5) }]);
      s.step([{ type: CommandType.AttackMove, player: 1, ids: [b], x: fp(58.5), y: fp(24.5) }]);
      for (let t = 0; t < 20 * 60; t++) s.step([]);
      return s.hash();
    };
    expect(run()).toBe(run());
  });
});
