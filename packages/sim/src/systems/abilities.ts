import { ABILITIES, MILITIA_COUNT, UNITS, VOLLEY_SIEGE_MULT } from '../data';
import { FP_ONE, fp, fpLen } from '../fixed';
import type { Simulation } from '../sim';
import { AbilityId, ArmorType, BuildingState, BuildingType, EventType, Kind, UnitType, UpgradeId } from '../types';

/** Cast an ability for one entity. Returns true if it fired. */
export function castAbility(sim: Simulation, id: number, ability: AbilityId, x: number, y: number): boolean {
  const w = sim.world;
  if (!w.alive[id]) return false;
  const def = ABILITIES[ability];
  const owner = w.owner[id];
  if (owner < 0) return false;
  if (w.abilityCd[id] > 0) return false;

  if (ability === AbilityId.Militia) {
    if (w.kind[id] !== Kind.Building || w.type[id] !== BuildingType.Castle || w.state[id] !== BuildingState.Complete) return false;
    for (let i = 0; i < MILITIA_COUNT; i++) {
      const cell = sim.freeCellAround(id, 5);
      if (cell < 0) break;
      const cx = cell % sim.map.w, cy = Math.floor(cell / sim.map.w);
      // jitter inside the cell so they don't stack exactly
      const m = sim.spawnUnit(owner, UnitType.Militia, fp(cx + 0.5) + (i - 1) * fp(0.15), fp(cy + 0.5));
      if (m >= 0) w.lifetime[m] = def.duration;
    }
    w.abilityCd[id] = def.cooldown;
    sim.emit(EventType.Ability, id, -1, w.x[id], w.y[id], ability, owner);
    return true;
  }

  if (w.kind[id] !== Kind.Unit) return false;
  const udef = UNITS[w.type[id] as UnitType];
  if (udef.ability !== ability) return false;

  switch (ability) {
    case AbilityId.ShieldStance: {
      w.buff[id] = def.duration;
      w.abilityCd[id] = def.cooldown;
      sim.emit(EventType.Ability, id, -1, w.x[id], w.y[id], ability, owner);
      return true;
    }
    case AbilityId.Volley: {
      const range = fp(def.range + sim.players[owner].upgrades[UpgradeId.Range]);
      if (fpLen(x - w.x[id], y - w.y[id]) > range) return false;
      const dmg = sim.unitDamage(id);
      const r = fp(def.radius);
      const hits: number[] = [];
      sim.grid.query(x, y, r + fp(2), (o) => {
        if (!w.alive[o] || (w.kind[o] !== Kind.Unit && w.kind[o] !== Kind.Building)) return;
        if (!sim.isEnemy(id, o)) return;
        if (sim.distToEntity(x, y, o) <= r) hits.push(o);
      });
      for (const o of hits) {
        const mult = sim.armorOf(o) === ArmorType.Siege ? VOLLEY_SIEGE_MULT * 100 : 100;
        sim.dealDamage(o, dmg, udef.damageType, id, owner, false, mult);
      }
      w.abilityCd[id] = def.cooldown;
      w.cooldown[id] = Math.max(w.cooldown[id], udef.cooldown >> 1);
      sim.emit(EventType.Ability, id, -1, x, y, ability, owner);
      return true;
    }
    case AbilityId.Incendiary: {
      if (fpLen(x - w.x[id], y - w.y[id]) > fp(def.range)) return false;
      const z = w.alloc(Kind.Zone, 0, owner, x, y);
      if (z < 0) return false;
      w.lifetime[z] = def.duration;
      w.orderV[z] = fp(def.radius);
      w.timer[z] = 0;
      w.abilityCd[id] = def.cooldown;
      sim.emit(EventType.Fire, id, z, x, y, ability, owner);
      return true;
    }
  }
  return false;
}

export const ONE = FP_ONE;
