import { ABILITIES, BUILDINGS, MAX_QUEUE, MINE_CAPACITY, UNITS, UPGRADES, upgradeCost } from '../data';
import { FP_ONE, FP_SHIFT, fp, fpLen } from '../fixed';
import type { Simulation } from '../sim';
import {
  AbilityId, BuildingState, BuildingType, Command, CommandType, EventType, Kind, Order, UnitType, UpgradeId,
} from '../types';
import { castAbility } from './abilities';
import { ejectWorkers } from './workers';

export const REJECT = {
  gameOver: 1, badPlayer: 2, noUnits: 3, notOwner: 4, noGold: 5, noPop: 6, requires: 7, blocked: 8,
  badTarget: 9, queueFull: 10, maxLevel: 11, alreadyQueued: 12, cooldown: 13, range: 14, notBuilder: 15, badType: 16, dead: 17,
  unexplored: 18, mineFull: 19, lastCastle: 20,
} as const;
export const REJECT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(REJECT).map(([k, v]) => [v, k]));

const QUEUE_UPGRADE_BASE = 16;
export function queueItemIsUpgrade(item: number): boolean { return item >= QUEUE_UPGRADE_BASE; }
export function queueItemUpgrade(item: number): UpgradeId { return (item - QUEUE_UPGRADE_BASE) as UpgradeId; }
export function queueItemForUpgrade(u: UpgradeId): number { return QUEUE_UPGRADE_BASE + u; }

function ownedUnits(sim: Simulation, cmd: Command, workersOnly = false): number[] {
  const w = sim.world;
  const out: number[] = [];
  if (!cmd.ids) return out;
  for (const id of cmd.ids) {
    if (id < 0 || id >= w.cap || !w.alive[id] || w.kind[id] !== Kind.Unit || w.owner[id] !== cmd.player) continue;
    if (workersOnly && w.type[id] !== UnitType.Worker) continue;
    out.push(id);
  }
  return out;
}
function ownedBuilding(sim: Simulation, cmd: Command, completeOnly = true): number {
  const w = sim.world;
  if (!cmd.ids || cmd.ids.length === 0) return -1;
  const id = cmd.ids[0];
  if (id < 0 || id >= w.cap || !w.alive[id] || w.kind[id] !== Kind.Building || w.owner[id] !== cmd.player) return -1;
  if (completeOnly && w.state[id] !== BuildingState.Complete) return -1;
  return id;
}

/**
 * Check whether a building footprint can be placed. cx,cy = top-left cell.
 * Pass `player` to also require the footprint to be explored by them: a construction site has vision,
 * so allowing one in unexplored fog would turn building placement into a free scout.
 */
export function footprintExplored(sim: Simulation, type: BuildingType, cx: number, cy: number, player: number): boolean {
  const def = BUILDINGS[type];
  if (!def || player < 0 || player >= sim.fog.playerCount) return true;
  for (let y = cy; y < cy + def.size; y++) {
    for (let x = cx; x < cx + def.size; x++) if (!sim.fog.isExplored(player, fp(x + 0.5), fp(y + 0.5))) return false;
  }
  return true;
}

export function canPlaceBuilding(sim: Simulation, type: BuildingType, cx: number, cy: number, player = -1): boolean {
  const def = BUILDINGS[type];
  if (!def) return false;
  const w = sim.map.w, h = sim.map.h;
  if (cx < 2 || cy < 2 || cx + def.size > w - 2 || cy + def.size > h - 2) return false;
  if (!footprintExplored(sim, type, cx, cy, player)) return false;
  if (!sim.path.footprintFree(cx, cy, def.size)) return false;
  // Buildings may stand flush against each other: footmen squeeze through the seam between two footprints,
  // only catapults cannot (see Pathfinder). Gold deposits keep a one-cell lane so workers can reach them.
  const world = sim.world;
  for (let id = 0; id < world.maxId; id++) {
    if (!world.alive[id]) continue;
    const k = world.kind[id];
    if (k !== Kind.Mine && k !== Kind.Building) continue;
    const [mx, my] = sim.footprintTopLeft(id);
    const ms = world.size[id];
    // construction sites are not in the path map yet, so overlap has to be ruled out here for everything
    if (cx < mx + ms && cx + def.size > mx && cy < my + ms && cy + def.size > my) return false;
    if (k !== Kind.Mine) continue;
    if (cx < mx + ms + 1 && cx + def.size > mx - 1 && cy < my + ms + 1 && cy + def.size > my - 1) return false;
  }
  return true;
}

/** Returns null if the command is acceptable, otherwise a reject code (see REJECT). */
export function validateCommand(sim: Simulation, cmd: Command): string | null {
  if (sim.gameOver) return 'gameOver';
  if (cmd.type === CommandType.Eliminate) return null;
  if (cmd.player < 0 || cmd.player >= sim.players.length) return 'badPlayer';
  const p = sim.players[cmd.player];
  if (!p.alive) return 'dead';
  const w = sim.world;
  switch (cmd.type) {
    case CommandType.Move:
    case CommandType.AttackMove:
    case CommandType.Patrol:
    case CommandType.Stop:
    case CommandType.Hold:
      return ownedUnits(sim, cmd).length > 0 ? null : 'noUnits';
    case CommandType.Attack: {
      if (ownedUnits(sim, cmd).length === 0) return 'noUnits';
      const t = cmd.target ?? -1;
      if (t < 0 || !w.alive[t] || (w.kind[t] !== Kind.Unit && w.kind[t] !== Kind.Building)) return 'badTarget';
      if (w.owner[t] >= 0 && sim.sameTeam(cmd.player, w.owner[t])) return 'badTarget';
      return null;
    }
    case CommandType.Gather: {
      if (ownedUnits(sim, cmd, true).length === 0) return 'notBuilder';
      const t = cmd.target ?? -1;
      if (t < 0 || !w.alive[t] || w.kind[t] !== Kind.Mine) return 'badTarget';
      return null;
    }
    case CommandType.Repair: {
      if (ownedUnits(sim, cmd, true).length === 0) return 'notBuilder';
      const t = cmd.target ?? -1;
      if (t < 0 || !w.alive[t] || w.kind[t] !== Kind.Building) return 'badTarget';
      if (!sim.sameTeam(cmd.player, w.owner[t])) return 'badTarget';
      return null;
    }
    case CommandType.Build: {
      if (ownedUnits(sim, cmd, true).length === 0) return 'notBuilder';
      const type = cmd.v as BuildingType;
      const def = BUILDINGS[type];
      if (!def) return 'badType';
      if (p.gold < def.cost) return 'noGold';
      if (def.requires >= 0 && !sim.hasBuilding(cmd.player, def.requires as BuildingType)) return 'requires';
      const cx = (cmd.x ?? 0) >> FP_SHIFT, cy = (cmd.y ?? 0) >> FP_SHIFT;
      if (!footprintExplored(sim, type, cx, cy, cmd.player)) return 'unexplored';
      if (!canPlaceBuilding(sim, type, cx, cy, cmd.player)) return 'blocked';
      return null;
    }
    case CommandType.Train: {
      const b = ownedBuilding(sim, cmd);
      if (b < 0) return 'notOwner';
      const ut = cmd.v as UnitType;
      const def = UNITS[ut];
      if (!def || def.trainedAt !== w.type[b]) return 'badType';
      if (w.queueLen[b] >= MAX_QUEUE) return 'queueFull';
      if (p.gold < def.cost) return 'noGold';
      // no population check here: the unit counts when it walks out, and waits inside if the cap is full
      return null;
    }
    case CommandType.Research: {
      const b = ownedBuilding(sim, cmd);
      if (b < 0 || w.type[b] !== BuildingType.Forge) return 'notOwner';
      const u = cmd.v as UpgradeId;
      const def = UPGRADES[u];
      if (!def) return 'badType';
      if (w.queueLen[b] >= MAX_QUEUE) return 'queueFull';
      if (p.upgrades[u] >= def.levels) return 'maxLevel';
      // already queued anywhere?
      for (let id = 0; id < w.maxId; id++) {
        if (!w.alive[id] || w.kind[id] !== Kind.Building || w.owner[id] !== cmd.player) continue;
        for (let i = 0; i < w.queueLen[id]; i++) if (w.qGet(id, i) === queueItemForUpgrade(u)) return 'alreadyQueued';
      }
      if (p.gold < upgradeCost(u, p.upgrades[u] + 1)) return 'noGold';
      return null;
    }
    case CommandType.CancelQueue: {
      const b = ownedBuilding(sim, cmd);
      if (b < 0) return 'notOwner';
      const i = cmd.v ?? 0;
      if (i < 0 || i >= w.queueLen[b]) return 'badTarget';
      return null;
    }
    case CommandType.SetRally:
      return ownedBuilding(sim, cmd, false) >= 0 ? null : 'notOwner';
    case CommandType.CancelBuilding: {
      const b = ownedBuilding(sim, cmd, false);
      if (b < 0 || w.state[b] !== BuildingState.Constructing) return 'notOwner';
      return null;
    }
    case CommandType.Ability: {
      const ab = cmd.v as AbilityId;
      const adef = ABILITIES[ab];
      if (!adef) return 'badType';
      if (ab === AbilityId.Militia) {
        const b = ownedBuilding(sim, cmd);
        if (b < 0 || w.type[b] !== BuildingType.Castle) return 'notOwner';
        if (w.abilityCd[b] > 0) return 'cooldown';
        return null;
      }
      const units = ownedUnits(sim, cmd);
      if (units.length === 0) return 'noUnits';
      let any = false, anyReady = false, anyInRange = false;
      for (const id of units) {
        if (UNITS[w.type[id] as UnitType].ability !== ab) continue;
        any = true;
        if (w.abilityCd[id] > 0) continue;
        anyReady = true;
        if (adef.targeted) {
          const d = fpLen((cmd.x ?? 0) - w.x[id], (cmd.y ?? 0) - w.y[id]);
          if (d > fp(adef.range) + (ab === AbilityId.Volley ? fp(sim.players[cmd.player].upgrades[UpgradeId.Range]) : 0)) continue;
        }
        anyInRange = true;
      }
      if (!any) return 'badType';
      if (!anyReady) return 'cooldown';
      if (!anyInRange) return 'range';
      return null;
    }
    case CommandType.Garrison: {
      if (ownedUnits(sim, cmd, true).length === 0) return 'notBuilder';
      const t = cmd.target ?? -1;
      if (t < 0 || !w.alive[t] || w.kind[t] !== Kind.Building || w.type[t] !== BuildingType.Mine || w.owner[t] !== cmd.player) return 'badTarget';
      if (w.state[t] !== BuildingState.Complete) return 'badTarget';
      if (w.carry[t] >= MINE_CAPACITY) return 'mineFull';
      return null;
    }
    case CommandType.Ungarrison: {
      const b = ownedBuilding(sim, cmd);
      if (b < 0 || w.type[b] !== BuildingType.Mine) return 'notOwner';
      if (w.carry[b] <= 0) return 'badTarget';
      return null;
    }
    case CommandType.Dismantle: {
      if (ownedUnits(sim, cmd, true).length === 0) return 'notBuilder';
      const t = cmd.target ?? -1;
      if (t < 0 || !w.alive[t] || w.kind[t] !== Kind.Building || w.owner[t] < 0 || !sim.sameTeam(cmd.player, w.owner[t])) return 'badTarget';
      if (w.state[t] !== BuildingState.Complete) return 'badTarget'; // a site is cancelled through its own button
      // taking down someone's last castle would eliminate them - not by a worker's hand
      if (w.type[t] === BuildingType.Castle && sim.players[w.owner[t]].castles <= 1) return 'lastCastle';
      return null;
    }
    case CommandType.Surrender:
    case CommandType.VoteDraw:
      return null;
    default:
      return 'badType';
  }
}

function giveOrder(sim: Simulation, id: number, order: Order, x: number, y: number, target: number, v: number, queue: boolean | undefined) {
  const w = sim.world;
  if (queue && w.order[id] !== Order.None) {
    w.oqPush(id, order, x, y, target, v);
  } else {
    w.oqClear(id);
    sim.setOrder(id, order, x, y, target, v);
  }
}

/** Apply a validated command. Individual invalid ids are skipped silently. */
export function applyCommand(sim: Simulation, cmd: Command): void {
  const reason = validateCommand(sim, cmd);
  if (reason) {
    if (cmd.player >= 0) sim.emit(EventType.Rejected, -1, -1, cmd.x ?? 0, cmd.y ?? 0, (REJECT as Record<string, number>)[reason] ?? 0, cmd.player);
    return;
  }
  const w = sim.world;
  const p = cmd.type === CommandType.Eliminate ? null : sim.players[cmd.player];
  switch (cmd.type) {
    case CommandType.Move:
      for (const id of ownedUnits(sim, cmd)) giveOrder(sim, id, Order.Move, cmd.x!, cmd.y!, -1, 0, cmd.queue);
      break;
    case CommandType.AttackMove:
      for (const id of ownedUnits(sim, cmd)) giveOrder(sim, id, w.type[id] === UnitType.Worker ? Order.Move : Order.AttackMove, cmd.x!, cmd.y!, -1, 0, cmd.queue);
      break;
    case CommandType.Patrol:
      for (const id of ownedUnits(sim, cmd)) giveOrder(sim, id, Order.Patrol, cmd.x!, cmd.y!, -1, 0, cmd.queue);
      break;
    case CommandType.Stop:
      for (const id of ownedUnits(sim, cmd)) { w.oqClear(id); sim.setOrder(id, Order.None, 0, 0, -1, 0); }
      break;
    case CommandType.Hold:
      for (const id of ownedUnits(sim, cmd)) { w.oqClear(id); sim.setOrder(id, Order.Hold, w.x[id], w.y[id], -1, 0); }
      break;
    case CommandType.Attack: {
      const t = cmd.target!;
      for (const id of ownedUnits(sim, cmd)) giveOrder(sim, id, Order.Attack, w.x[t], w.y[t], t, 0, cmd.queue);
      break;
    }
    case CommandType.Gather: {
      const t = cmd.target!;
      for (const id of ownedUnits(sim, cmd, true)) {
        w.mineRef[id] = t;
        giveOrder(sim, id, Order.Gather, w.x[t], w.y[t], t, 0, cmd.queue);
      }
      break;
    }
    case CommandType.Repair: {
      const t = cmd.target!;
      const order = w.state[t] === BuildingState.Constructing ? Order.Build : Order.Repair;
      for (const id of ownedUnits(sim, cmd, true)) giveOrder(sim, id, order, w.x[t], w.y[t], t, 0, cmd.queue);
      break;
    }
    case CommandType.Build: {
      const type = cmd.v as BuildingType;
      const def = BUILDINGS[type];
      const cx = cmd.x! >> FP_SHIFT, cy = cmd.y! >> FP_SHIFT;
      p!.gold -= def.cost;
      const site = sim.spawnBuilding(cmd.player, type, cx, cy, false);
      if (site < 0) { p!.gold += def.cost; return; }
      sim.emit(EventType.BuildingPlaced, site, -1, w.x[site], w.y[site], type, cmd.player);
      for (const id of ownedUnits(sim, cmd, true)) giveOrder(sim, id, Order.Build, w.x[site], w.y[site], site, type, cmd.queue);
      break;
    }
    case CommandType.Train: {
      const b = cmd.ids![0];
      const ut = cmd.v as UnitType;
      const def = UNITS[ut];
      p!.gold -= def.cost;
      w.qPush(b, ut);
      break;
    }
    case CommandType.Research: {
      const b = cmd.ids![0];
      const u = cmd.v as UpgradeId;
      p!.gold -= upgradeCost(u, p!.upgrades[u] + 1);
      w.qPush(b, queueItemForUpgrade(u));
      break;
    }
    case CommandType.CancelQueue: {
      const b = cmd.ids![0];
      const item = w.qRemove(b, cmd.v ?? 0);
      if (item < 0) break;
      if (queueItemIsUpgrade(item)) {
        const u = queueItemUpgrade(item);
        p!.gold += upgradeCost(u, p!.upgrades[u] + 1);
      } else {
        p!.gold += UNITS[item as UnitType].cost;
      }
      break;
    }
    case CommandType.SetRally: {
      for (const id of cmd.ids!) {
        if (id < 0 || !w.alive[id] || w.kind[id] !== Kind.Building || w.owner[id] !== cmd.player) continue;
        w.rallyX[id] = cmd.x!; w.rallyY[id] = cmd.y!;
      }
      break;
    }
    case CommandType.CancelBuilding: {
      const b = cmd.ids![0];
      const def = BUILDINGS[w.type[b] as BuildingType];
      const total = def.buildTime * 10;
      const refund = Math.floor((def.cost * (total - w.progress[b])) / total);
      p!.gold += refund;
      // builders lose their target; they will fall through to next order
      sim.destroyBuilding(b, false);
      break;
    }
    case CommandType.Ability: {
      const ab = cmd.v as AbilityId;
      if (ab === AbilityId.Militia) {
        castAbility(sim, cmd.ids![0], ab, cmd.x ?? 0, cmd.y ?? 0);
      } else {
        for (const id of ownedUnits(sim, cmd)) castAbility(sim, id, ab, cmd.x ?? 0, cmd.y ?? 0);
      }
      break;
    }
    case CommandType.Garrison: {
      const t = cmd.target!;
      for (const id of ownedUnits(sim, cmd, true)) giveOrder(sim, id, Order.Garrison, w.x[t], w.y[t], t, 0, cmd.queue);
      break;
    }
    case CommandType.Ungarrison:
      ejectWorkers(sim, cmd.ids![0]);
      break;
    case CommandType.Dismantle: {
      const t = cmd.target!;
      for (const id of ownedUnits(sim, cmd, true)) giveOrder(sim, id, Order.Dismantle, w.x[t], w.y[t], t, 0, cmd.queue);
      break;
    }
    case CommandType.Surrender:
      p!.surrendered = true;
      sim.eliminate(cmd.player);
      break;
    case CommandType.VoteDraw:
      p!.votedDraw = !p!.votedDraw;
      break;
    case CommandType.Eliminate: {
      const target = cmd.v ?? -1;
      if (target >= 0 && target < sim.players.length) sim.eliminate(target);
      break;
    }
  }
}

/** Convenience for AI/UI: cost of a queue item */
export function queueItemCost(sim: Simulation, player: number, item: number): number {
  if (queueItemIsUpgrade(item)) { const u = queueItemUpgrade(item); return upgradeCost(u, sim.players[player].upgrades[u] + 1); }
  return UNITS[item as UnitType].cost;
}

export const CELL = FP_ONE;
