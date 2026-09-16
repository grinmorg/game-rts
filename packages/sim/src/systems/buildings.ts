import { AGE_UP, BUILDER_MULT, BUILDINGS, DISMANTLE_SPEED_PCT, MINE_CAPACITY, MINE_GOLD_PER_WORKER, MINE_INCOME_TICKS, SITE_HIT_SLOW_PCT, UNITS, UPGRADES, constructionHp } from '../data';
import { FP_ONE, FP_SHIFT, fp } from '../fixed';
import type { Simulation } from '../sim';
import { BuildingState, BuildingType, EventType, Kind, Order, UnitType, UpgradeId } from '../types';
import { queueItemIsAgeUp, queueItemIsUpgrade, queueItemUpgrade } from './orders';
import { acquireTarget } from './units';
import { afterJob, ejectWorkers } from './workers';

export function updateBuildings(sim: Simulation): void {
  const w = sim.world;
  const max = w.maxId;
  for (let id = 0; id < max; id++) {
    if (!w.alive[id] || w.kind[id] !== Kind.Building) continue;
    if (w.abilityCd[id] > 0) w.abilityCd[id]--;
    if (w.cooldown[id] > 0) w.cooldown[id]--;
    if (w.buff[id] > 0) w.buff[id]--;
    const type = w.type[id] as BuildingType;
    const def = BUILDINGS[type];

    if (w.state[id] === BuildingState.Constructing) {
      const b = w.builders[id];
      w.builders[id] = 0;
      if (b > 0) {
        let mult = BUILDER_MULT[b >= 3 ? 2 : b - 1];
        // recently hit: builders keep their heads down (set in dealDamage)
        if (w.buff[id] > 0) mult = Math.floor((mult * (100 - SITE_HIT_SLOW_PCT)) / 100);
        const total = def.buildTime * 10;
        const prev = w.progress[id];
        const next = prev + mult >= total ? total : prev + mult;
        w.progress[id] = next;
        // hp tracks progress as a delta (so damage taken mid-build sticks) and lands exactly on maxHp
        w.hp[id] += constructionHp(w.maxHp[id], next, total) - constructionHp(w.maxHp[id], prev, total);
        if (w.hp[id] > w.maxHp[id]) w.hp[id] = w.maxHp[id];
        if (next >= total) {
          w.state[id] = BuildingState.Complete;
          // only now does the footprint block the way (units caught inside are pushed out by the movement pass)
          const [tlx, tly] = sim.footprintTopLeft(id);
          sim.path.setFootprint(tlx, tly, w.size[id], true, id, type !== BuildingType.Wall);
          if (type === BuildingType.Castle && w.owner[id] >= 0) sim.players[w.owner[id]].castles++;
          sim.emit(EventType.BuildingComplete, id, -1, w.x[id], w.y[id], type, w.owner[id]);
        }
      }
      continue;
    }

    // ---- dismantling: workers on Order.Dismantle wind the build progress back, half again as fast as building
    const dm = w.dismantlers[id];
    w.dismantlers[id] = 0;
    if (dm > 0) {
      const mult = BUILDER_MULT[dm >= 3 ? 2 : dm - 1];
      w.progress[id] -= Math.floor((mult * DISMANTLE_SPEED_PCT) / 100);
      if (w.progress[id] <= 0) {
        if (type === BuildingType.Mine) ejectWorkers(sim, id); // nobody gets buried in their own mine
        sim.emit(EventType.BuildingDestroyed, id, -1, w.x[id], w.y[id], type, w.owner[id]);
        sim.destroyBuilding(id, false);
        continue;
      }
    }

    // ---- mine: passive gold from the workers inside, linear in how many there are
    if (type === BuildingType.Mine && w.carry[id] > 0 && w.owner[id] >= 0) {
      w.timer[id]++;
      if (w.timer[id] >= MINE_INCOME_TICKS) {
        w.timer[id] = 0;
        const g = w.carry[id] * MINE_GOLD_PER_WORKER;
        const p = sim.players[w.owner[id]];
        p.gold += g; p.goldMined += g;
        sim.emit(EventType.Deposit, id, -1, w.x[id], w.y[id], g, w.owner[id]);
      }
    }

    // ---- production
    w.lifetime[id] = 0; // "waiting for population room" flag, recomputed every tick
    if (w.queueLen[id] > 0) {
      const item = w.qGet(id, 0);
      const owner = w.owner[id];
      const p = sim.players[owner];
      if (queueItemIsAgeUp(item)) {
        w.prodProgress[id]++;
        if (w.prodProgress[id] >= AGE_UP.time) {
          w.qRemove(id, 0);
          sim.ageUp(owner, id);
        }
      } else if (queueItemIsUpgrade(item)) {
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
          if (p.popUsed + udef.pop > p.popCap) {
            // trained but no room in the population: wait inside, the view shows a red badge
            w.prodProgress[id] = udef.trainTime;
            w.lifetime[id] = 1;
          } else {
            const cell = sim.freeCellAround(id, 6);
            if (cell >= 0) {
              const cx = cell % sim.map.w, cy = Math.floor(cell / sim.map.w);
              const u = sim.spawnUnit(owner, ut, (cx << FP_SHIFT) + (FP_ONE >> 1), (cy << FP_SHIFT) + (FP_ONE >> 1));
              w.qRemove(id, 0);
              if (u >= 0) {
                p.unitsTrained++;
                p.popUsed += udef.pop; // counted from the moment it steps out (recountPop confirms at end of tick)
                sim.emit(EventType.UnitTrained, u, id, w.x[u], w.y[u], ut, owner);
                applyRally(sim, id, u);
              }
            } else {
              // no free cell around: hold progress at complete and retry next tick
              w.prodProgress[id] = udef.trainTime;
            }
          }
        }
      }
    }

    // ---- defensive attack (castle, tower)
    if (def.damage > 0) {
      const range = sim.buildingRange(id);
      let t = w.target[id];
      if (t >= 0 && (!w.valid(t, w.targetGen[id]) || w.hp[t] <= 0 || sim.distFromBuilding(id, t) > range)) { t = -1; w.target[id] = -1; }
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
    // workers with no rally pick their own job: unfinished building, repair, a mine with room, then gold
    if (w.type[unit] === UnitType.Worker) afterJob(sim, unit);
    return;
  }
  if (w.type[unit] === UnitType.Worker) {
    // a rally point placed on something is the new worker's first job: a site to build, a mine to staff,
    // a damaged building to repair, a gold vein to work
    const b = sim.buildingAt(rx, ry);
    if (b >= 0 && w.owner[b] >= 0 && sim.sameTeam(w.owner[b], w.owner[unit])) {
      if (w.state[b] === BuildingState.Constructing) { sim.setOrder(unit, Order.Build, w.x[b], w.y[b], b, w.type[b]); return; }
      if (w.type[b] === BuildingType.Mine && w.carry[b] < MINE_CAPACITY) { sim.setOrder(unit, Order.Garrison, w.x[b], w.y[b], b, 0); return; }
      if (w.hp[b] < w.maxHp[b]) { sim.setOrder(unit, Order.Repair, w.x[b], w.y[b], b, 0); return; }
      afterJob(sim, unit); // finished, full or healthy by now: the worker finds its own job instead
      return;
    }
    const m = sim.nearestMine(rx, ry, fp(3));
    if (m >= 0) { w.mineRef[unit] = m; sim.setOrder(unit, Order.Gather, w.x[m], w.y[m], m, 0); return; }
  }
  sim.setOrder(unit, Order.Move, rx, ry, -1, 0);
}
