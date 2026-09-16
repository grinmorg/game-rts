import { BUILDER_MULT, BUILDINGS, UNITS, UPGRADES } from '../data';
import { FP_ONE, FP_SHIFT, fp } from '../fixed';
import type { Simulation } from '../sim';
import { BuildingState, BuildingType, EventType, Kind, Order, UnitType, UpgradeId } from '../types';
import { queueItemIsUpgrade, queueItemUpgrade } from './orders';
import { acquireTarget } from './units';

export function updateBuildings(sim: Simulation): void {
  const w = sim.world;
  const max = w.maxId;
  for (let id = 0; id < max; id++) {
    if (!w.alive[id] || w.kind[id] !== Kind.Building) continue;
    if (w.abilityCd[id] > 0) w.abilityCd[id]--;
    if (w.cooldown[id] > 0) w.cooldown[id]--;
    const type = w.type[id] as BuildingType;
    const def = BUILDINGS[type];

    if (w.state[id] === BuildingState.Constructing) {
      const b = w.builders[id];
      w.builders[id] = 0;
      if (b > 0) {
        const mult = BUILDER_MULT[b >= 3 ? 2 : b - 1];
        const total = def.buildTime * 10;
        w.progress[id] += mult;
        const hpGain = Math.floor((w.maxHp[id] * 9 * mult) / (10 * total));
        w.hp[id] += hpGain < 1 ? 1 : hpGain;
        if (w.hp[id] > w.maxHp[id]) w.hp[id] = w.maxHp[id];
        if (w.progress[id] >= total) {
          w.progress[id] = total;
          w.state[id] = BuildingState.Complete;
          if (type === BuildingType.Castle && w.owner[id] >= 0) sim.players[w.owner[id]].castles++;
          sim.emit(EventType.BuildingComplete, id, -1, w.x[id], w.y[id], type, w.owner[id]);
        }
      }
      continue;
    }

    // ---- production
    if (w.queueLen[id] > 0) {
      const item = w.qGet(id, 0);
      const owner = w.owner[id];
      const p = sim.players[owner];
      if (queueItemIsUpgrade(item)) {
        const u = queueItemUpgrade(item);
        const udef = UPGRADES[u];
        const level = p.upgrades[u] + 1;
        const need = udef.time[Math.min(level, udef.levels) - 1];
        w.prodProgress[id]++;
        if (w.prodProgress[id] >= need) {
          p.upgrades[u]++;
          w.qRemove(id, 0);
          sim.emit(EventType.ResearchComplete, id, -1, w.x[id], w.y[id], u, owner);
        }
      } else {
        const ut = item as UnitType;
        const udef = UNITS[ut];
        w.prodProgress[id]++;
        if (w.prodProgress[id] >= udef.trainTime) {
          const cell = sim.freeCellAround(id, 6);
          if (cell >= 0) {
            const cx = cell % sim.map.w, cy = Math.floor(cell / sim.map.w);
            const u = sim.spawnUnit(owner, ut, (cx << FP_SHIFT) + (FP_ONE >> 1), (cy << FP_SHIFT) + (FP_ONE >> 1));
            w.qRemove(id, 0);
            if (u >= 0) {
              p.unitsTrained++;
              sim.emit(EventType.UnitTrained, u, id, w.x[u], w.y[u], ut, owner);
              applyRally(sim, id, u);
            }
          } else {
            // no room: hold progress at complete and retry next tick
            w.prodProgress[id] = udef.trainTime;
          }
        }
      }
    }

    // ---- defensive attack (castle, tower)
    if (def.damage > 0) {
      const range = fp(def.range) + fp(sim.players[w.owner[id]].upgrades[UpgradeId.Range]);
      let t = w.target[id];
      if (t >= 0 && (!w.valid(t, w.targetGen[id]) || w.hp[t] <= 0 || sim.distToEntity(w.x[id], w.y[id], t) > range)) { t = -1; w.target[id] = -1; }
      if (t < 0 && (sim.tick + id) % 2 === 0) {
        t = acquireTarget(sim, id, range, true);
        if (t >= 0) { w.target[id] = t; w.targetGen[id] = w.gen[t]; }
      }
      if (t >= 0 && w.cooldown[id] === 0) {
        const dmg = def.damage + def.upgradeBonus * sim.players[w.owner[id]].upgrades[UpgradeId.RangedAttack];
        sim.dealDamage(t, dmg, def.damageType, id, w.owner[id]);
        sim.emit(EventType.Attack, id, t, w.x[t], w.y[t], 100 + type, w.owner[id]);
        w.cooldown[id] = def.cooldown;
      }
    }
  }
}

function applyRally(sim: Simulation, building: number, unit: number): void {
  const w = sim.world;
  const rx = w.rallyX[building], ry = w.rallyY[building];
  if (rx < 0 || ry < 0) {
    // workers with no rally go mine at the nearest mine automatically
    if (w.type[unit] === UnitType.Worker) {
      const m = sim.nearestMine(w.x[unit], w.y[unit], fp(14));
      if (m >= 0) { w.mineRef[unit] = m; sim.setOrder(unit, Order.Gather, w.x[m], w.y[m], m, 0); }
    }
    return;
  }
  if (w.type[unit] === UnitType.Worker) {
    const m = sim.nearestMine(rx, ry, fp(3));
    if (m >= 0) { w.mineRef[unit] = m; sim.setOrder(unit, Order.Gather, w.x[m], w.y[m], m, 0); return; }
  }
  sim.setOrder(unit, Order.Move, rx, ry, -1, 0);
}
