import {
  GOLD_PER_TRIP, MAX_ORDER_QUEUE, MINE_CAPACITY, UNITS, WORKER_DISPATCH_INTERVAL, WORKER_JOB_RADIUS, WORKER_MIN_GATHER_PCT,
  WORKER_PULLS_PER_DISPATCH,
} from '../data';
import { fp, fpLen } from '../fixed';
import type { Simulation } from '../sim';
import { BuildingState, BuildingType, EventType, Kind, Order, UnitType } from '../types';

/**
 * Automatic worker jobs. A worker with nothing better to do finishes unfinished buildings first, then
 * repairs damaged ones, and only then goes for gold. Explicit orders always win: the dispatcher only
 * touches idle workers and, for a site or a wound nobody is attending, pulls the nearest gatherer.
 */

/** how many workers are currently ordered to build / repair each building (indexed by building id) */
export interface HelperCounts { build: Uint8Array; repair: Uint8Array }

export function countHelpers(sim: Simulation, owner: number): HelperCounts {
  const w = sim.world;
  const build = new Uint8Array(w.maxId), repair = new Uint8Array(w.maxId);
  for (let id = 0; id < w.maxId; id++) {
    if (!w.alive[id] || w.kind[id] !== Kind.Unit || w.owner[id] !== owner || w.type[id] !== UnitType.Worker) continue;
    const t = w.orderTarget[id];
    if (t >= 0 && t < w.maxId) {
      if (w.order[id] === Order.Build) build[t]++;
      else if (w.order[id] === Order.Repair) repair[t]++;
    }
    // queued orders count as well, or a fence line placed in one drag would look unattended
    for (let i = 0; i < w.oqLen[id]; i++) {
      const base = (id * MAX_ORDER_QUEUE + i) * 5;
      const type = w.oq[base], target = w.oq[base + 3];
      if (target < 0 || target >= w.maxId) continue;
      if (type === Order.Build) build[target]++;
      else if (type === Order.Repair) repair[target]++;
    }
  }
  return { build, repair };
}

/**
 * Give worker `id` the best automatic job within WORKER_JOB_RADIUS: the nearest own construction site
 * that has fewer than three builders, else the nearest damaged own building nobody is repairing.
 * Returns false when there is neither - the caller falls back to gold.
 */
export function pickWorkerJob(sim: Simulation, id: number, counts?: HelperCounts): boolean {
  const w = sim.world;
  const owner = w.owner[id];
  const c = counts ?? countHelpers(sim, owner);
  const R = fp(WORKER_JOB_RADIUS);
  let site = -1, siteD = R + 1, fix = -1, fixD = R + 1;
  for (let b = 0; b < w.maxId; b++) {
    if (!w.alive[b] || w.kind[b] !== Kind.Building || w.owner[b] !== owner) continue;
    const d = fpLen(w.x[b] - w.x[id], w.y[b] - w.y[id]);
    if (d > R) continue;
    if (w.state[b] === BuildingState.Constructing) {
      if (d < siteD && c.build[b] < 3) { siteD = d; site = b; }
    } else if (w.hp[b] < w.maxHp[b]) {
      if (d < fixD && c.repair[b] === 0) { fixD = d; fix = b; }
    }
  }
  if (site >= 0) { sim.setOrder(id, Order.Build, w.x[site], w.y[site], site, w.type[site]); c.build[site]++; return true; }
  if (fix >= 0) { sim.setOrder(id, Order.Repair, w.x[fix], w.y[fix], fix, 0); c.repair[fix]++; return true; }
  return false;
}

/** nearest own worker that is mining and not carrying a full load (so no gold is wasted by pulling it) */
function nearestGatherer(sim: Simulation, owner: number, x: number, y: number): number {
  const w = sim.world;
  let best = -1, bestD = 0x7fffffff;
  for (let id = 0; id < w.maxId; id++) {
    if (!w.alive[id] || w.kind[id] !== Kind.Unit || w.owner[id] !== owner || w.type[id] !== UnitType.Worker) continue;
    if (w.order[id] !== Order.Gather || w.carry[id] >= GOLD_PER_TRIP || w.oqLen[id] > 0) continue;
    const d = fpLen(w.x[id] - x, w.y[id] - y);
    if (d < bestD) { bestD = d; best = id; }
  }
  return bestD <= fp(WORKER_JOB_RADIUS) ? best : -1;
}

/** Every WORKER_DISPATCH_INTERVAL ticks: idle workers take jobs, unattended sites and damage pull gatherers. */
export function dispatchWorkers(sim: Simulation): void {
  if (sim.tick % WORKER_DISPATCH_INTERVAL !== 0) return;
  const w = sim.world;
  for (const p of sim.players) {
    if (!p.alive) continue;
    let anything = false;
    for (let b = 0; b < w.maxId && !anything; b++) {
      if (!w.alive[b] || w.kind[b] !== Kind.Building || w.owner[b] !== p.id) continue;
      if (w.state[b] === BuildingState.Constructing || w.hp[b] < w.maxHp[b]) anything = true;
    }
    if (!anything) continue;
    const counts = countHelpers(sim, p.id);
    // 1. idle workers (not the ones mining - a Stop/Hold is the player's call, gold only comes after a job)
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Unit || w.owner[id] !== p.id || w.type[id] !== UnitType.Worker) continue;
      if (w.order[id] !== Order.None) continue;
      pickWorkerJob(sim, id, counts);
    }
    // 2. a site nobody builds or a damaged building nobody repairs pulls the nearest gatherer - but never so
    //    many that fewer than WORKER_MIN_GATHER_PCT of the workers are left on gold (think: a 30-cell fence)
    let total = 0, gathering = 0;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Unit || w.owner[id] !== p.id || w.type[id] !== UnitType.Worker) continue;
      total++;
      if (w.order[id] === Order.Gather) gathering++;
    }
    const keep = Math.floor((total * WORKER_MIN_GATHER_PCT) / 100);
    let pulls = 0;
    for (let b = 0; b < w.maxId && pulls < WORKER_PULLS_PER_DISPATCH && gathering > keep; b++) {
      if (!w.alive[b] || w.kind[b] !== Kind.Building || w.owner[b] !== p.id) continue;
      if (w.state[b] === BuildingState.Constructing) {
        if (counts.build[b] > 0) continue;
        const g = nearestGatherer(sim, p.id, w.x[b], w.y[b]);
        if (g < 0) continue;
        sim.setOrder(g, Order.Build, w.x[b], w.y[b], b, w.type[b]); counts.build[b]++; pulls++; gathering--;
      } else if (w.hp[b] < w.maxHp[b]) {
        if (counts.repair[b] > 0) continue;
        const g = nearestGatherer(sim, p.id, w.x[b], w.y[b]);
        if (g < 0) continue;
        sim.setOrder(g, Order.Repair, w.x[b], w.y[b], b, 0); counts.repair[b]++; pulls++; gathering--;
      }
    }
  }
}

/**
 * Worker `id` has finished (or lost) its job: queued orders first, then the next build/repair job,
 * then back to its deposit or the nearest one, else idle.
 */
export function afterJob(sim: Simulation, id: number): void {
  const w = sim.world;
  if (w.oqLen[id] > 0) { sim.nextOrder(id); return; }
  if (pickWorkerJob(sim, id)) return;
  let mine = w.mineRef[id];
  if (mine < 0 || !w.alive[mine] || w.kind[mine] !== Kind.Mine || w.hp[mine] <= 0) mine = sim.nearestMine(w.x[id], w.y[id], fp(WORKER_JOB_RADIUS));
  if (mine >= 0) { w.mineRef[id] = mine; sim.setOrder(id, Order.Gather, w.x[mine], w.y[mine], mine, 0); return; }
  sim.nextOrder(id);
}

/** Worker `id` steps into mine `b`: it leaves the world, its gold is banked, the mine counts one more head. */
export function garrisonWorker(sim: Simulation, id: number, b: number): boolean {
  const w = sim.world;
  if (w.carry[b] >= MINE_CAPACITY) return false;
  const p = sim.players[w.owner[id]];
  if (w.carry[id] > 0) { p.gold += w.carry[id]; p.goldMined += w.carry[id]; }
  w.carry[b]++;
  sim.emit(EventType.Garrison, b, id, w.x[b], w.y[b], w.carry[b], w.owner[b]);
  w.release(id);
  return true;
}

/** Everyone leaves mine `b`; they come out around it and pick up work like any freed worker. */
export function ejectWorkers(sim: Simulation, b: number): void {
  const w = sim.world;
  const owner = w.owner[b];
  let i = 0;
  while (w.carry[b] > 0) {
    const cell = sim.freeCellAround(b, 5);
    if (cell < 0) break;
    const cx = cell % sim.map.w, cy = Math.floor(cell / sim.map.w);
    const u = sim.spawnUnit(owner, UnitType.Worker, fp(cx + 0.5) + (i % 3 - 1) * fp(0.15), fp(cy + 0.5));
    if (u < 0) break;
    w.carry[b]--; i++;
    afterJob(sim, u);
  }
  sim.emit(EventType.Garrison, b, -1, w.x[b], w.y[b], w.carry[b], owner);
}

export const MINE_BUILDING = BuildingType.Mine;
export const WORKER_DEF = UNITS[UnitType.Worker];
