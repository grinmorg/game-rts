import { describe, expect, it } from 'vitest';
import {
  BUILDINGS, BUILDING_TYPE_COUNT, BuildingType, CommandType, EventType, Kind, MatchSetup, PLAYER_COLORS, SIM_VERSION, Simulation, UNITS,
  UNIT_TYPE_COUNT, UPGRADES, UnitType, UpgradeId, createMap, fp,
} from '../src';

function duel(seed = 3): Simulation {
  const setup: MatchSetup = {
    seed, mapId: 'duel-valley', version: SIM_VERSION,
    players: [0, 1].map((i) => ({ slot: i, team: i, name: `P${i}`, isBot: false, color: PLAYER_COLORS[i] })),
  };
  return new Simulation(setup, createMap(setup.mapId));
}
const castleOf = (s: Simulation, p: number) => {
  const w = s.world;
  for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === p && w.type[id] === BuildingType.Castle) return id;
  return -1;
};

describe('nothing fires into the fog', () => {
  it('sight always covers the reach, a cell past it, at every range upgrade', () => {
    const s = duel();
    for (let up = 0; up <= UPGRADES[UpgradeId.Range].levels; up++) {
      s.players[0].upgrades[UpgradeId.Range] = up;
      for (let t = 0; t < UNIT_TYPE_COUNT; t++) {
        const u = s.spawnUnit(0, t as UnitType, fp(20.5), fp(20.5));
        const reach = UNITS[t as UnitType].range + (UNITS[t as UnitType].range > 1 ? up : 0);
        expect(s.unitVision(u), `${UNITS[t as UnitType].name} +${up}`).toBeGreaterThanOrEqual(reach + 1);
        s.world.release(u);
      }
      for (let b = 0; b < BUILDING_TYPE_COUNT; b++) {
        const def = BUILDINGS[b as BuildingType];
        if (def.range <= 0) continue;
        const id = s.spawnBuilding(0, b as BuildingType, 20, 20, true);
        // measured from the footprint edge, seen from the centre
        expect(s.buildingVision(id), `${def.name} +${up}`).toBeGreaterThanOrEqual(def.range + up + Math.ceil(def.size / 2));
        s.destroyBuilding(id, false);
      }
    }
  });

  it('a castle with both range upgrades hits what stands at the far end of its reach', () => {
    const s = duel();
    s.players[0].upgrades[UpgradeId.Range] = UPGRADES[UpgradeId.Range].levels;
    const c = castleOf(s, 0), w = s.world;
    const dir = w.x[c] < fp(s.map.w / 2) ? 1 : -1;
    const reach = BUILDINGS[BuildingType.Castle].range + UPGRADES[UpgradeId.Range].levels;
    const a = s.spawnUnit(1, UnitType.Archer, w.x[c] + dir * fp(1.5 + reach + UNITS[UnitType.Archer].radius - 0.2), w.y[c]);
    s.step([{ type: CommandType.Hold, player: 1, ids: [a] }]);
    expect(s.distFromBuilding(c, a)).toBeLessThanOrEqual(s.buildingRange(c));
    let hit = false;
    for (let t = 0; t < 20 * 5 && !hit; t++) { s.step([]); hit = s.events.some((e) => e.type === EventType.Attack && e.a === c && e.b === a); }
    expect(hit).toBe(true);
  });

  it('a catapult holds its fire at a man it cannot see, and fires the moment someone spots him', () => {
    const s = duel(), w = s.world;
    const c = castleOf(s, 0);
    // open ground halfway between the castles, well away from both
    const mx = (w.x[c] + w.x[castleOf(s, 1)]) >> 1, my = (w.y[c] + w.y[castleOf(s, 1)]) >> 1;
    const cat = s.spawnUnit(1, UnitType.Catapult, mx, my);
    const man = s.spawnUnit(0, UnitType.Soldier, mx + fp(5), my);
    // a short-sighted catapult: the soldier stands well within its reach but out of its sight
    const sight = s.unitVision.bind(s);
    s.unitVision = (id: number) => (id === cat ? 3 : sight(id));
    s.step([{ type: CommandType.Hold, player: 1, ids: [cat] }, { type: CommandType.Hold, player: 0, ids: [man] }]);
    const fired = () => s.events.some((e) => e.type === EventType.ProjectileLaunch && e.a === cat);
    for (let t = 0; t < 20 * 4; t++) { s.step([]); expect(fired()).toBe(false); }
    // a scout of the catapult's side walks up: now the team sees the soldier
    s.spawnUnit(1, UnitType.Worker, mx + fp(7), my + fp(2));
    let shot = false;
    for (let t = 0; t < 20 * 4 && !shot; t++) { s.step([]); shot = fired(); }
    expect(shot).toBe(true);
  });
});
