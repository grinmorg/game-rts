import { garrisonCapacity, GATHER_TICKS, GOLD_PER_TRIP, MINE_MAX_WORKERS, REPAIR_HP_PER_SEC_PCT, UNITS, isHeavy } from '../data';
import { FP_ONE, FP_SHIFT, fp, fpLen } from '../fixed';
import { FINE_SHIFT, SUB_SHIFT, UNREACHABLE } from '../path';
import type { Simulation } from '../sim';
import { BuildingState, BuildingType, EventType, Kind, Order, UnitState, UnitType, UpgradeId } from '../types';
import { afterJob, dispatchWorkers, garrisonWorker } from './workers';

const ARRIVE_MOVE = fp(0.35);
const ARRIVE_ATTACKMOVE = fp(0.6);
const GROUP_ARRIVE_DIST = fp(3);
const STUCK_GROUP = 8;
const STUCK_GIVEUP = 50;
const DIRECT_STEER_DIST = fp(14);
const AGGRO_INTERVAL = 4;
const CHASE_DROP_EXTRA = fp(4);

/** Main per-unit decision pass. Fills sim.mvx/mvy for the movement pass. */
export function updateUnits(sim: Simulation): void {
  const w = sim.world;
  const max = w.maxId;
  // reset per-tick mine occupancy counters
  for (let id = 0; id < max; id++) if (w.alive[id] && w.kind[id] === Kind.Mine) w.timer[id] = 0;
  // free workers pick up building and repair work before anyone goes back to gold
  dispatchWorkers(sim);

  for (let id = 0; id < max; id++) {
    if (!w.alive[id] || w.kind[id] !== Kind.Unit) continue;
    sim.wantMove[id] = 0;
    if (w.cooldown[id] > 0) w.cooldown[id]--;
    if (w.abilityCd[id] > 0) w.abilityCd[id]--;
    if (w.buff[id] > 0) w.buff[id]--;
    if (w.type[id] === UnitType.Militia) w.lifetime[id]--;
    w.state[id] = UnitState.Idle;

    switch (w.order[id] as Order) {
      case Order.None: idleOrder(sim, id); break;
      case Order.Move: moveOrder(sim, id); break;
      case Order.AttackMove: attackMoveOrder(sim, id, false); break;
      case Order.Patrol: attackMoveOrder(sim, id, true); break;
      case Order.Attack: attackOrder(sim, id); break;
      case Order.Hold: holdOrder(sim, id); break;
      case Order.Gather: gatherOrder(sim, id); break;
      case Order.Build: buildOrder(sim, id); break;
      case Order.Repair: repairOrder(sim, id); break;
      case Order.Garrison: garrisonOrder(sim, id); break;
      case Order.Dismantle: dismantleOrder(sim, id); break;
      default: sim.nextOrder(id); break;
    }
  }
}

// ---------------------------------------------------------------- movement request

/**
 * Request movement toward (tx,ty). arriveDist < 0 disables the arrival check.
 * Returns 1 when arrived (or as close as the map allows), 0 when moving, -1 when the destination
 * cannot be reached and the unit is already at the nearest point, or when hopelessly stuck.
 */
export function moveTowards(sim: Simulation, id: number, tx: number, ty: number, arriveDist: number, depth = 0): number {
  const w = sim.world;
  const x = w.x[id], y = w.y[id];
  const dx = tx - x, dy = ty - y;
  const d = fpLen(dx, dy);
  if (arriveDist >= 0) {
    if (d <= arriveDist) return 1;
    if (w.stuck[id] >= STUCK_GROUP && d <= GROUP_ARRIVE_DIST) return 1;
    if (w.stuck[id] >= STUCK_GIVEUP) return -1;
  } else if (w.stuck[id] >= STUCK_GIVEUP * 2) {
    return -1;
  }
  const speed = sim.unitSpeed(id);
  const heavy = isHeavy(w.type[id] as UnitType);
  let dirx = dx, diry = dy;
  const path = sim.path;
  // the unit lives on the fine grid, the destination is a map cell (flow fields are keyed per map cell)
  const fx = x >> FINE_SHIFT, fy = y >> FINE_SHIFT;
  const tcx = tx >> FP_SHIFT, tcy = ty >> FP_SHIFT;
  const sameCell = (fx >> SUB_SHIFT) === tcx && (fy >> SUB_SHIFT) === tcy;
  if (!sameCell && !(d < DIRECT_STEER_DIST && path.lineFree(x, y, tx, ty, heavy))) {
    // the field is advanced until our own fine cell is settled, so `here` and every neighbour are exact
    const field = path.fieldFor(tcx, tcy, fx, fy, heavy);
    if (!field) {
      // pathing budget spent this tick: wait a tick rather than walk straight into whatever is in the way
      if (!path.lineFree(x, y, tx, ty, heavy)) { w.state[id] = UnitState.Moving; return 0; }
    } else {
      const here = path.distAt(field, fy * path.w + fx);
      if (here === UNREACHABLE && path.isBlockedFine(fx, fy, heavy)) {
        // we are standing inside an obstacle (spawned there, or a building just finished around us):
        // the movement pass pushes us out; keep the order and nudge straight at the target meanwhile
      } else if (here === UNREACHABLE) {
        // destination lies in another region (across water, inside a forest, behind a fence):
        // head for the reachable cell closest to it and treat that as the destination
        if (depth > 0) return -1; // the substitute itself came back unreachable: give up cleanly
        const alt = resolveAltTarget(sim, id, tcx, tcy, heavy);
        if (alt < 0) return -1;
        const ax = alt % path.w, ay = (alt - ax) / path.w;
        if (ax === fx && ay === fy) return arriveDist >= 0 ? 1 : -1;
        return moveTowards(sim, id, path.fineCenter(ax), path.fineCenter(ay), arriveDist >= 0 ? arriveDist : ARRIVE_MOVE, depth + 1);
      }
      const k = here === UNREACHABLE ? -1 : path.flowStep(field, fx, fy);
      if (k < 0) {
        // a local minimum away from the destination: the passable ring around a blocked target. A plain move
        // is done here; a chase (attack, gather, build) keeps nudging straight at the target and lets the
        // caller's own reach check decide, exactly as before.
        if (here !== UNREACHABLE && here > 0 && arriveDist >= 0) return 1;
      } else {
        const nfx = fx + path.stepDX(k), nfy = fy + path.stepDY(k);
        if (!((nfx >> SUB_SHIFT) === tcx && (nfy >> SUB_SHIFT) === tcy)) {
          dirx = path.fineCenter(nfx) - x;
          diry = path.fineCenter(nfy) - y;
        }
      }
    }
  }
  const len = fpLen(dirx, diry);
  if (len === 0) return 1;
  const step = speed < d ? speed : d;
  sim.mvx[id] = Math.floor((dirx * step) / len) | 0;
  sim.mvy[id] = Math.floor((diry * step) / len) | 0;
  sim.mvSpeed[id] = speed;
  sim.wantMove[id] = 1;
  w.state[id] = UnitState.Moving;
  return 0;
}

/** cached per unit: the reachable fine cell closest to an unreachable destination map cell (see Pathfinder.nearestReachable) */
function resolveAltTarget(sim: Simulation, id: number, tcx: number, tcy: number, heavy: boolean): number {
  const w = sim.world, path = sim.path;
  const key = tcy * path.mapW + tcx;
  if (w.altTarget[id] === key && w.altVersion[id] === path.version) return w.altCell[id];
  let fx = w.x[id] >> FINE_SHIFT, fy = w.y[id] >> FINE_SHIFT;
  if (path.isBlockedFine(fx, fy, heavy)) {
    // standing inside a footprint (got pushed there): measure from the nearest free cell instead
    const free = path.nearestFreeFine(fx, fy, 6, heavy);
    if (free < 0) return -1;
    fx = free % path.w; fy = (free - fx) / path.w;
  }
  const alt = path.nearestReachable(fx, fy, tcx, tcy, heavy);
  w.altTarget[id] = key; w.altCell[id] = alt; w.altVersion[id] = path.version;
  return alt;
}

// ---------------------------------------------------------------- targeting

function targetValid(sim: Simulation, id: number): boolean {
  const w = sim.world;
  const t = w.target[id];
  if (t < 0 || !w.valid(t, w.targetGen[id])) { w.target[id] = -1; return false; }
  const k = w.kind[t];
  if ((k !== Kind.Unit && k !== Kind.Building) || w.hp[t] <= 0 || !sim.isEnemy(id, t)) { w.target[id] = -1; return false; }
  return true;
}

/**
 * Find the closest enemy within radius (units preferred over buildings). For a building attacker the
 * radius is measured from its walls (`distFromBuilding`), for a unit from its centre.
 */
export function acquireTarget(sim: Simulation, id: number, radius: number, includeBuildings: boolean): number {
  const w = sim.world;
  const x = w.x[id], y = w.y[id];
  const fromBuilding = w.kind[id] === Kind.Building;
  const half = fromBuilding ? (w.size[id] * FP_ONE) >> 1 : 0;
  let best = -1;
  let bestScore = 0x7fffffff;
  sim.grid.query(x, y, radius + half + fp(2), (o) => {
    if (o === id || !w.alive[o] || w.hp[o] <= 0) return;
    const k = w.kind[o];
    if (k !== Kind.Unit && !(includeBuildings && k === Kind.Building)) return;
    if (!sim.isEnemy(id, o)) return;
    const d = fromBuilding ? sim.distFromBuilding(id, o) : sim.distToEntity(x, y, o);
    if (d > radius) return;
    const score = d + (k === Kind.Building ? fp(50) : 0);
    if (score < bestScore || (score === bestScore && o < best)) { bestScore = score; best = o; }
  });
  return best;
}

function setTarget(sim: Simulation, id: number, t: number) {
  const w = sim.world;
  w.target[id] = t; w.targetGen[id] = t >= 0 ? w.gen[t] : 0;
}

/**
 * Attack the current target: fire if in range, otherwise chase (if chase=true).
 * Returns true when the unit attacked or is chasing; false when it can't (too close for min range).
 */
function engageTarget(sim: Simulation, id: number, chase: boolean): boolean {
  const w = sim.world;
  const t = w.target[id];
  const def = UNITS[w.type[id] as UnitType];
  const range = sim.unitRange(id);
  const myR = fp(def.radius);
  const d = sim.distToEntity(w.x[id], w.y[id], t);
  const inRange = d <= range + myR;
  const minRange = fp(def.minRange);
  if (inRange) {
    if (d < minRange) { w.state[id] = UnitState.Idle; return false; }
    w.state[id] = UnitState.Attacking;
    w.fx[id] = w.x[t] - w.x[id]; w.fy[id] = w.y[t] - w.y[id];
    if (w.cooldown[id] === 0) {
      performAttack(sim, id, t);
      w.cooldown[id] = def.cooldown;
    }
    return true;
  }
  if (!chase) return false;
  moveTowards(sim, id, w.x[t], w.y[t], -1);
  return true;
}

export function performAttack(sim: Simulation, id: number, t: number): void {
  const w = sim.world;
  const def = UNITS[w.type[id] as UnitType];
  const dmg = sim.unitDamage(id);
  if (def.projectileSpeed > 0) {
    const p = w.alloc(Kind.Projectile, w.type[id], w.owner[id], w.x[id], w.y[id]);
    if (p < 0) return;
    // lead the target slightly along its last movement to make dodging meaningful but not trivial
    const tx = w.x[t] + ((w.x[t] - w.px[t]) * 3), ty = w.y[t] + ((w.y[t] - w.py[t]) * 3);
    w.orderX[p] = tx; w.orderY[p] = ty;
    w.patrolX[p] = w.x[id]; w.patrolY[p] = w.y[id];
    w.orderV[p] = dmg;
    w.hp[p] = fp(def.aoe);
    const dist = fpLen(tx - w.x[id], ty - w.y[id]);
    const perTick = fp(def.projectileSpeed / 20);
    let travel = Math.ceil(dist / perTick);
    if (travel < 4) travel = 4;
    w.lifetime[p] = travel; w.timer[p] = travel;
    sim.emit(EventType.ProjectileLaunch, id, p, w.x[id], w.y[id], w.type[id], w.owner[id]);
  } else {
    sim.dealDamage(t, dmg, def.damageType, id, w.owner[id]);
    sim.emit(EventType.Attack, id, t, w.x[t], w.y[t], w.type[id], w.owner[id]);
  }
}

// ---------------------------------------------------------------- orders

function idleOrder(sim: Simulation, id: number) {
  const w = sim.world;
  if (w.type[id] === UnitType.Worker) return;
  const def = UNITS[w.type[id] as UnitType];
  const vision = fp(def.vision);
  if (targetValid(sim, id)) {
    const t = w.target[id];
    const d = sim.distToEntity(w.x[id], w.y[id], t);
    if (d > vision + CHASE_DROP_EXTRA) { setTarget(sim, id, -1); return; }
    engageTarget(sim, id, true);
    return;
  }
  if ((sim.tick + id) % AGGRO_INTERVAL === 0) {
    const t = acquireTarget(sim, id, vision, false);
    if (t >= 0) { setTarget(sim, id, t); engageTarget(sim, id, true); }
  }
}

function moveOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const r = moveTowards(sim, id, w.orderX[id], w.orderY[id], ARRIVE_MOVE);
  if (r !== 0) sim.nextOrder(id);
}

function attackMoveOrder(sim: Simulation, id: number, patrol: boolean) {
  const w = sim.world;
  const def = UNITS[w.type[id] as UnitType];
  if (targetValid(sim, id)) {
    const t = w.target[id];
    const d = sim.distToEntity(w.x[id], w.y[id], t);
    if (d > fp(def.vision) + CHASE_DROP_EXTRA) setTarget(sim, id, -1);
    else { engageTarget(sim, id, true); return; }
  }
  if ((sim.tick + id) % AGGRO_INTERVAL === 0) {
    const t = acquireTarget(sim, id, fp(def.vision), true);
    if (t >= 0) { setTarget(sim, id, t); engageTarget(sim, id, true); return; }
  }
  const r = moveTowards(sim, id, w.orderX[id], w.orderY[id], ARRIVE_ATTACKMOVE);
  if (r !== 0) {
    if (patrol && r === 1) {
      // swap ends
      const ox = w.orderX[id], oy = w.orderY[id];
      w.orderX[id] = w.patrolX[id]; w.orderY[id] = w.patrolY[id];
      w.patrolX[id] = ox; w.patrolY[id] = oy;
      w.stuck[id] = 0;
    } else sim.nextOrder(id);
  }
}

function attackOrder(sim: Simulation, id: number) {
  const w = sim.world;
  // the explicit target lives in orderTarget; mirror into target
  const t = w.orderTarget[id];
  if (t < 0 || !w.valid(t, w.orderTargetGen[id]) || w.hp[t] <= 0) { sim.nextOrder(id); return; }
  if (w.target[id] !== t) setTarget(sim, id, t);
  if (!engageTarget(sim, id, true)) {
    // too close for min range: back off a little
    const def = UNITS[w.type[id] as UnitType];
    if (def.minRange > 0) {
      const dx = w.x[id] - w.x[t], dy = w.y[id] - w.y[t];
      const len = fpLen(dx, dy) || FP_ONE;
      moveTowards(sim, id, w.x[id] + Math.floor((dx * fp(1.5)) / len), w.y[id] + Math.floor((dy * fp(1.5)) / len), -1);
    }
  }
}

function holdOrder(sim: Simulation, id: number) {
  const w = sim.world;
  if (w.type[id] === UnitType.Worker) return;
  const range = sim.unitRange(id) + fp(UNITS[w.type[id] as UnitType].radius);
  if (targetValid(sim, id)) {
    const d = sim.distToEntity(w.x[id], w.y[id], w.target[id]);
    if (d <= range) { engageTarget(sim, id, false); return; }
    setTarget(sim, id, -1);
  }
  if ((sim.tick + id) % 2 === 0) {
    const t = acquireTarget(sim, id, range, true);
    if (t >= 0) { setTarget(sim, id, t); engageTarget(sim, id, false); }
  }
}

function gatherOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const def = UNITS[UnitType.Worker];
  const owner = w.owner[id];
  const p = sim.players[owner];
  const myR = fp(def.radius);

  if (w.carry[id] >= GOLD_PER_TRIP) {
    // return gold to the nearest complete castle
    let castle = w.target[id];
    if (castle < 0 || !w.valid(castle, w.targetGen[id]) || w.state[castle] !== BuildingState.Complete || w.type[castle] !== BuildingType.Castle || w.owner[castle] !== owner) {
      castle = sim.nearestOwnBuilding(owner, BuildingType.Castle, w.x[id], w.y[id], true);
      if (castle < 0) { w.state[id] = UnitState.Idle; return; }
      w.target[id] = castle; w.targetGen[id] = w.gen[castle];
    }
    const d = sim.distToEntity(w.x[id], w.y[id], castle);
    if (d <= myR + fp(0.45)) {
      p.gold += w.carry[id];
      p.goldMined += w.carry[id];
      sim.emit(EventType.Deposit, id, castle, w.x[id], w.y[id], w.carry[id], owner);
      w.carry[id] = 0;
      w.target[id] = -1;
      w.stuck[id] = 0;
      // continue to the remembered mine
      const mine = w.orderTarget[id];
      if (mine < 0 || !w.valid(mine, w.orderTargetGen[id])) {
        const nm = sim.nearestMine(w.x[id], w.y[id], fp(30), id);
        if (nm < 0) { w.mineRef[id] = -1; afterJob(sim, id); return; }
        w.orderTarget[id] = nm; w.orderTargetGen[id] = w.gen[nm]; w.mineRef[id] = nm;
      }
    } else if (moveTowards(sim, id, w.x[castle], w.y[castle], -1) < 0) {
      // no way to that castle: drop the trip, the job picker finds something reachable
      w.target[id] = -1; w.mineRef[id] = -1;
      afterJob(sim, id);
    }
    return;
  }

  let mine = w.orderTarget[id];
  if (mine < 0 || !w.valid(mine, w.orderTargetGen[id]) || w.kind[mine] !== Kind.Mine) {
    mine = sim.nearestMine(w.x[id], w.y[id], fp(30), id);
    if (mine < 0) { w.mineRef[id] = -1; afterJob(sim, id); return; }
    w.orderTarget[id] = mine; w.orderTargetGen[id] = w.gen[mine]; w.mineRef[id] = mine;
    w.stuck[id] = 0;
  }
  const d = sim.distToEntity(w.x[id], w.y[id], mine);
  if (d <= myR + fp(0.4)) {
    w.fx[id] = w.x[mine] - w.x[id]; w.fy[id] = w.y[mine] - w.y[id];
    if (w.timer[mine] < MINE_MAX_WORKERS) {
      w.timer[mine]++;
      w.state[id] = UnitState.Gathering;
      const bonus = 100 + p.gatherBonusPct + 15 * p.upgrades[UpgradeId.Gather];
      const need = Math.floor((GATHER_TICKS * 100) / bonus);
      w.timer[id]++;
      if (w.timer[id] >= need) {
        w.timer[id] = 0;
        let take = GOLD_PER_TRIP;
        if (w.hp[mine] < take) take = w.hp[mine];
        w.hp[mine] -= take;
        w.carry[id] = take;
        if (take === 0) { w.mineRef[id] = -1; afterJob(sim, id); }
      }
    } else {
      w.state[id] = UnitState.Idle; // waiting for a free spot
    }
  } else if (moveTowards(sim, id, w.x[mine], w.y[mine], -1) < 0) {
    // deposit is unreachable (fenced off, across water): stop trying, pick another job
    w.mineRef[id] = -1;
    afterJob(sim, id);
  }
}

/** worker walks up to a friendly building and takes it apart (see buildings.ts for the rate) */
function dismantleOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const b = w.orderTarget[id];
  if (b < 0 || !w.valid(b, w.orderTargetGen[id]) || w.kind[b] !== Kind.Building || w.state[b] !== BuildingState.Complete) { afterJob(sim, id); return; }
  const d = sim.distToEntity(w.x[id], w.y[id], b);
  if (d <= fp(UNITS[UnitType.Worker].radius) + fp(0.5)) {
    w.state[id] = UnitState.Building;
    w.dismantlers[b]++;
    w.fx[id] = w.x[b] - w.x[id]; w.fy[id] = w.y[b] - w.y[id];
  } else if (moveTowards(sim, id, w.x[b], w.y[b], -1) < 0) afterJob(sim, id);
}

/** worker walks into a mine (BuildingType.Mine) and disappears inside */
function garrisonOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const b = w.orderTarget[id];
  const ok = b >= 0 && w.valid(b, w.orderTargetGen[id]) && w.kind[b] === Kind.Building && garrisonCapacity(w.type[b] as BuildingType) > 0
    && w.state[b] === BuildingState.Complete && w.owner[b] === w.owner[id];
  if (!ok) { afterJob(sim, id); return; }
  const d = sim.distToEntity(w.x[id], w.y[id], b);
  if (d <= fp(UNITS[UnitType.Worker].radius) + fp(0.5)) {
    if (!garrisonWorker(sim, id, b)) afterJob(sim, id); // full after all: find something else to do
    return;
  }
  const r = moveTowards(sim, id, w.x[b], w.y[b], -1);
  if (r < 0) afterJob(sim, id);
}

function buildOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const site = w.orderTarget[id];
  if (site < 0 || !w.valid(site, w.orderTargetGen[id]) || w.kind[site] !== Kind.Building || w.state[site] !== BuildingState.Constructing) {
    afterJob(sim, id);
    return;
  }
  const d = sim.distToEntity(w.x[id], w.y[id], site);
  if (d <= fp(UNITS[UnitType.Worker].radius) + fp(0.5)) {
    w.state[id] = UnitState.Building;
    w.builders[site]++;
    w.fx[id] = w.x[site] - w.x[id]; w.fy[id] = w.y[site] - w.y[id];
  } else {
    const r = moveTowards(sim, id, w.x[site], w.y[site], -1);
    if (r < 0) afterJob(sim, id);
  }
}

function repairOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const b = w.orderTarget[id];
  if (b < 0 || !w.valid(b, w.orderTargetGen[id]) || w.kind[b] !== Kind.Building || w.hp[b] >= w.maxHp[b]) { afterJob(sim, id); return; }
  if (w.state[b] === BuildingState.Constructing) { w.order[id] = Order.Build; return; }
  const d = sim.distToEntity(w.x[id], w.y[id], b);
  if (d <= fp(UNITS[UnitType.Worker].radius) + fp(0.5)) {
    w.state[id] = UnitState.Building;
    let heal = Math.floor((w.maxHp[b] * REPAIR_HP_PER_SEC_PCT) / 100 / 20);
    if (heal < 1) heal = 1;
    w.hp[b] += heal;
    if (w.hp[b] > w.maxHp[b]) w.hp[b] = w.maxHp[b];
  } else {
    const r = moveTowards(sim, id, w.x[b], w.y[b], -1);
    if (r < 0) afterJob(sim, id);
  }
}
