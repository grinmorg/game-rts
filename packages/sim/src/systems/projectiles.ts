import { FIRE_DPS, FIRE_TICK_INTERVAL, UNITS } from '../data';
import { fp } from '../fixed';
import type { Simulation } from '../sim';
import { DamageType, EventType, Kind, UnitType } from '../types';

/** Catapult boulders in flight and burning ground zones. */
export function updateProjectilesAndZones(sim: Simulation): void {
  const w = sim.world;
  const max = w.maxId;
  const hits: number[] = [];
  for (let id = 0; id < max; id++) {
    if (!w.alive[id]) continue;
    const k = w.kind[id];
    if (k === Kind.Projectile) {
      w.lifetime[id]--;
      const total = w.timer[id];
      const left = w.lifetime[id];
      // linear flight from launch point to landing point (view adds the arc)
      const t = total > 0 ? (total - left) : 1;
      w.x[id] = w.patrolX[id] + Math.floor(((w.orderX[id] - w.patrolX[id]) * t) / (total || 1));
      w.y[id] = w.patrolY[id] + Math.floor(((w.orderY[id] - w.patrolY[id]) * t) / (total || 1));
      if (left <= 0) {
        const lx = w.orderX[id], ly = w.orderY[id];
        const radius = w.hp[id];
        const dmg = w.orderV[id];
        const owner = w.owner[id];
        const dtype = UNITS[w.type[id] as UnitType].damageType;
        hits.length = 0;
        sim.grid.query(lx, ly, radius + fp(2), (o) => {
          if (!w.alive[o] || w.hp[o] <= 0) return;
          const ok = w.kind[o];
          if (ok !== Kind.Unit && ok !== Kind.Building) return;
          if (w.owner[o] < 0 || sim.sameTeam(owner, w.owner[o])) return;
          if (sim.distToEntity(lx, ly, o) <= radius) hits.push(o);
        });
        for (const o of hits) sim.dealDamage(o, dmg, dtype, -1, owner);
        sim.emit(EventType.ProjectileLand, id, -1, lx, ly, w.type[id], owner);
        w.release(id);
      }
    } else if (k === Kind.Zone) {
      w.lifetime[id]--;
      w.timer[id]++;
      if (w.timer[id] % FIRE_TICK_INTERVAL === 0) {
        const radius = w.orderV[id];
        const owner = w.owner[id];
        const dmg = Math.max(1, Math.floor((FIRE_DPS * FIRE_TICK_INTERVAL) / 20));
        hits.length = 0;
        sim.grid.query(w.x[id], w.y[id], radius + fp(2), (o) => {
          if (!w.alive[o] || w.hp[o] <= 0) return;
          const ok = w.kind[o];
          if (ok !== Kind.Unit && ok !== Kind.Building) return;
          if (w.owner[o] < 0 || sim.sameTeam(owner, w.owner[o])) return;
          if (sim.distToEntity(w.x[id], w.y[id], o) <= radius) hits.push(o);
        });
        for (const o of hits) sim.dealDamage(o, dmg, DamageType.Siege, -1, owner, true);
      }
      if (w.lifetime[id] <= 0) w.release(id);
    }
  }
}
