import { GATHER_TICKS, GOLD_PER_TRIP, MINE_MAX_WORKERS, REPAIR_HP_PER_SEC_PCT, UNITS } from '../data';
import { FP_ONE, FP_SHIFT, fp, fpLen } from '../fixed';
import { UNREACHABLE } from '../path';
import type { Simulation } from '../sim';
import { BuildingState, BuildingType, EventType, Kind, Order, UnitState, UnitType, UpgradeId } from '../types';

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
      default: sim.nextOrder(id); break;
    }
  }
}

// ---------------------------------------------------------------- movement request

/**
 * Request movement toward (tx,ty). arriveDist < 0 disables the arrival check.
 * Returns 1 when arrived, 0 when moving, -1 when hopelessly stuck.
 */
export function moveTowards(sim: Simulation, id: number, tx: number, ty: number, arriveDist: number): number {
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
  let dirx = dx, diry = dy;
  const path = sim.path;
  const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
  const tcx = tx >> FP_SHIFT, tcy = ty >> FP_SHIFT;
  const sameCell = cx === tcx && cy === tcy;
  if (!sameCell && !(d < DIRECT_STEER_DIST && path.lineFree(x, y, tx, ty))) {
    const field = path.getField(tcx, tcy);
    if (field) {
      const here = field.dist[cy * path.w + cx];
      if (here !== UNREACHABLE) {
        const k = path.flowStep(field, cx, cy);
        if (k >= 0) {
          const ncx = cx + path.stepDX(k), ncy = cy + path.stepDY(k);
          if (!(ncx === tcx && ncy === tcy)) {
            dirx = ((ncx << FP_SHIFT) + (FP_ONE >> 1)) - x;
            diry = ((ncy << FP_SHIFT) + (FP_ONE >> 1)) - y;
          }
        }
      } else if (arriveDist >= 0 && w.stuck[id] > STUCK_GROUP) {
        return -1; // unreachable destination: give up
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

// ---------------------------------------------------------------- targeting

function targetValid(sim: Simulation, id: number): boolean {
  const w = sim.world;
  const t = w.target[id];
  if (t < 0 || !w.valid(t, w.targetGen[id])) { w.target[id] = -1; return false; }
  const k = w.kind[t];
  if ((k !== Kind.Unit && k !== Kind.Building) || w.hp[t] <= 0 || !sim.isEnemy(id, t)) { w.target[id] = -1; return false; }
  return true;
}

/** Find the closest enemy within radius (units preferred over buildings). */
export function acquireTarget(sim: Simulation, id: number, radius: number, includeBuildings: boolean): number {
  const w = sim.world;
  const x = w.x[id], y = w.y[id];
  let best = -1;
  let bestScore = 0x7fffffff;
  sim.grid.query(x, y, radius + fp(2), (o) => {
    if (o === id || !w.alive[o] || w.hp[o] <= 0) return;
    const k = w.kind[o];
    if (k !== Kind.Unit && !(includeBuildings && k === Kind.Building)) return;
    if (!sim.isEnemy(id, o)) return;
    const d = sim.distToEntity(x, y, o);
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
        const nm = sim.nearestMine(w.x[id], w.y[id], fp(30));
        if (nm < 0) { sim.nextOrder(id); return; }
        w.orderTarget[id] = nm; w.orderTargetGen[id] = w.gen[nm]; w.mineRef[id] = nm;
      }
    } else {
      moveTowards(sim, id, w.x[castle], w.y[castle], -1);
    }
    return;
  }

  let mine = w.orderTarget[id];
  if (mine < 0 || !w.valid(mine, w.orderTargetGen[id]) || w.kind[mine] !== Kind.Mine) {
    mine = sim.nearestMine(w.x[id], w.y[id], fp(30));
    if (mine < 0) { sim.nextOrder(id); return; }
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
        if (take === 0) { sim.nextOrder(id); }
      }
    } else {
      w.state[id] = UnitState.Idle; // waiting for a free spot
    }
  } else {
    moveTowards(sim, id, w.x[mine], w.y[mine], -1);
  }
}

function afterBuild(sim: Simulation, id: number) {
  const w = sim.world;
  if (w.oqLen[id] > 0) { sim.nextOrder(id); return; }
  const mine = w.mineRef[id];
  if (mine >= 0 && w.alive[mine] && w.kind[mine] === Kind.Mine) {
    sim.setOrder(id, Order.Gather, w.x[mine], w.y[mine], mine, 0);
  } else sim.nextOrder(id);
}

function buildOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const site = w.orderTarget[id];
  if (site < 0 || !w.valid(site, w.orderTargetGen[id]) || w.kind[site] !== Kind.Building || w.state[site] !== BuildingState.Constructing) {
    afterBuild(sim, id);
    return;
  }
  const d = sim.distToEntity(w.x[id], w.y[id], site);
  if (d <= fp(UNITS[UnitType.Worker].radius) + fp(0.5)) {
    w.state[id] = UnitState.Building;
    w.builders[site]++;
    w.fx[id] = w.x[site] - w.x[id]; w.fy[id] = w.y[site] - w.y[id];
  } else {
    const r = moveTowards(sim, id, w.x[site], w.y[site], -1);
    if (r < 0) afterBuild(sim, id);
  }
}

function repairOrder(sim: Simulation, id: number) {
  const w = sim.world;
  const b = w.orderTarget[id];
  if (b < 0 || !w.valid(b, w.orderTargetGen[id]) || w.kind[b] !== Kind.Building || w.hp[b] >= w.maxHp[b]) { afterBuild(sim, id); return; }
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
    if (r < 0) afterBuild(sim, id);
  }
}
