import {
  BUILDINGS, DAMAGE_MATRIX, HARD_AI_GATHER_BONUS_PCT, KILL_BOUNTY_DIV, LAST_CASTLE_WARNING_PCT, MINE_SIZE, SHIELD_STANCE_REDUCTION_PCT,
  SITE_HIT_SLOW_TICKS, START_GOLD, START_WORKERS, UNITS, constructionProgressForHp, constructionStartHp,
} from './data';
import { FP_ONE, FP_SHIFT, fp, fpLen } from './fixed';
import { Fog } from './fog';
import { Fnv1a } from './hash';
import { MapData, MapStart } from './map';
import { Pathfinder } from './path';
import { Rng } from './rng';
import { SpatialGrid } from './spatial';
import {
  ArmorType, BuildingState, BuildingType, Command, CommandType, DamageType, EventType, Kind, MAX_POP, MatchSetup, Order, SimEvent,
  UnitState, UnitType, UpgradeId,
} from './types';
import { World } from './world';
import { applyCommand, validateCommand } from './systems/orders';
import { updateUnits } from './systems/units';
import { resolveMovement } from './systems/movement';
import { updateBuildings } from './systems/buildings';
import { updateProjectilesAndZones } from './systems/projectiles';

export interface Player {
  id: number;
  team: number;
  name: string;
  isBot: boolean;
  difficulty: number;
  color: number;
  gold: number;
  popUsed: number;
  popCap: number;
  upgrades: Int32Array;
  alive: boolean;
  eliminatedTick: number;
  surrendered: boolean;
  votedDraw: boolean;
  gatherBonusPct: number;
  castles: number;
  /** stats */
  unitsTrained: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsLost: number;
  buildingsRazed: number;
  goldMined: number;
  lastWarningTick: number;
  /** cell this player's first castle was placed on (spawns are randomised, so this is the only record) */
  startX: number;
  startY: number;
}

export class Simulation {
  readonly setup: MatchSetup;
  readonly map: MapData;
  readonly world = new World();
  readonly players: Player[] = [];
  readonly grid: SpatialGrid;
  readonly path: Pathfinder;
  readonly fog: Fog;
  readonly rng: Rng;
  tick = 0;
  events: SimEvent[] = [];
  gameOver = false;
  winnerTeam = -1;
  /** desired-move scratch (filled by units system, consumed by movement system) */
  readonly mvx: Int32Array;
  readonly mvy: Int32Array;
  readonly mvSpeed: Int32Array;
  readonly wantMove: Uint8Array;
  private scratchOrder = new Int32Array(5);

  constructor(setup: MatchSetup, map: MapData) {
    this.setup = setup;
    this.map = map;
    this.rng = new Rng(setup.seed);
    this.grid = new SpatialGrid(map.w, map.h, this.world.cap, 2);
    this.path = new Pathfinder(map);
    this.fog = new Fog(map.w, map.h, setup.players.length);
    this.mvx = new Int32Array(this.world.cap);
    this.mvy = new Int32Array(this.world.cap);
    this.mvSpeed = new Int32Array(this.world.cap);
    this.wantMove = new Uint8Array(this.world.cap);

    for (const ps of setup.players) {
      this.players.push({
        id: ps.slot, team: ps.team, name: ps.name, isBot: ps.isBot, difficulty: ps.difficulty ?? 1, color: ps.color,
        gold: START_GOLD, popUsed: 0, popCap: 0, upgrades: new Int32Array(6), alive: true, eliminatedTick: -1,
        surrendered: false, votedDraw: false, gatherBonusPct: ps.isBot && ps.difficulty === 2 ? HARD_AI_GATHER_BONUS_PCT : 0,
        castles: 0, unitsTrained: 0, unitsLost: 0, unitsKilled: 0, buildingsLost: 0, buildingsRazed: 0, goldMined: 0, lastWarningTick: -1000,
        startX: 0, startY: 0,
      });
    }
    this.spawnMapEntities();
    this.grid.rebuild(this.world);
    this.recountPop();
    this.updateFog();
  }

  // ------------------------------------------------------------------ setup

  /**
   * Pick one spawn per player: shuffle the map's zones, then take a random candidate out of each.
   * Uses the match rng, so every peer (and every replay) lands on the same layout, while two matches
   * on the same map start differently. See `MapStart`.
   */
  private pickStarts(): MapStart[] {
    const byZone: MapStart[][] = [];
    for (const s of this.map.starts) {
      const z = s.zone ?? 0;
      (byZone[z] ??= []).push(s);
    }
    const zones = byZone.map((_, z) => z).filter((z) => byZone[z]?.length);
    for (let i = zones.length - 1; i > 0; i--) {
      const j = this.rng.nextInt(i + 1);
      const t = zones[i]; zones[i] = zones[j]; zones[j] = t;
    }
    const out: MapStart[] = [];
    for (let i = 0; i < this.players.length; i++) {
      const cand = byZone[zones[i % zones.length]];
      // more players than zones (not reachable through the lobby): offset so they at least don't
      // land on the very same cell, which would leave the second one without a castle
      out.push(cand[(this.rng.nextInt(cand.length) + Math.floor(i / zones.length)) % cand.length]);
    }
    return out;
  }

  private spawnMapEntities() {
    for (const m of this.map.mines) this.spawnMine(m.x, m.y, m.gold);
    const picked = this.pickStarts();
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const s = picked[i];
      p.startX = s.x; p.startY = s.y;
      // castle footprint is 3x3 centred on the start cell
      this.spawnBuilding(p.id, BuildingType.Castle, s.x - 1, s.y - 1, true);
      const mine = this.nearestMine(fp(s.x + 0.5), fp(s.y + 0.5));
      const mx = mine >= 0 ? this.world.x[mine] : fp(s.x + 6);
      const my = mine >= 0 ? this.world.y[mine] : fp(s.y);
      // spawn workers between castle and mine
      const dx = mx - fp(s.x + 0.5), dy = my - fp(s.y + 0.5);
      const len = fpLen(dx, dy) || FP_ONE;
      for (let k = 0; k < START_WORKERS; k++) {
        const t = 2.5 + (k % 2) * 0.9;
        const side = (k >> 1) === 0 ? -0.8 : 0.8;
        const px = s.x + 0.5 + (dx / len) * t + (-dy / len) * side;
        const py = s.y + 0.5 + (dy / len) * t + (dx / len) * side;
        const cell = this.path.nearestFree(Math.floor(px), Math.floor(py), 5);
        const cx = cell >= 0 ? cell % this.map.w : Math.floor(px);
        const cy = cell >= 0 ? Math.floor(cell / this.map.w) : Math.floor(py);
        const wid = this.spawnUnit(p.id, UnitType.Worker, fp(cx + 0.5), fp(cy + 0.5));
        if (mine >= 0 && wid >= 0) {
          this.world.mineRef[wid] = mine;
          this.setOrder(wid, Order.Gather, this.world.x[mine], this.world.y[mine], mine, 0);
        }
      }
    }
  }

  spawnMine(cx: number, cy: number, gold: number): number {
    const w = this.world;
    const id = w.alloc(Kind.Mine, 0, -1, fp(cx + 0.5), fp(cy + 0.5));
    if (id < 0) return -1;
    w.hp[id] = gold; w.maxHp[id] = gold; w.size[id] = MINE_SIZE;
    this.path.setFootprint(cx - 1, cy - 1, MINE_SIZE, true);
    return id;
  }

  /** cx,cy = top-left cell of footprint */
  spawnBuilding(owner: number, type: BuildingType, cx: number, cy: number, complete: boolean): number {
    const def = BUILDINGS[type];
    const w = this.world;
    const half = def.size / 2;
    const id = w.alloc(Kind.Building, type, owner, fp(cx + half), fp(cy + half));
    if (id < 0) return -1;
    w.size[id] = def.size;
    w.maxHp[id] = def.hp;
    if (complete) { w.hp[id] = def.hp; w.state[id] = BuildingState.Complete; w.progress[id] = def.buildTime * 10; }
    else { w.hp[id] = constructionStartHp(def.hp); w.state[id] = BuildingState.Constructing; w.progress[id] = 0; }
    this.path.setFootprint(cx, cy, def.size, true);
    if (complete && type === BuildingType.Castle) this.players[owner].castles++;
    return id;
  }

  spawnUnit(owner: number, type: UnitType, x: number, y: number): number {
    const def = UNITS[type];
    const w = this.world;
    const id = w.alloc(Kind.Unit, type, owner, x, y);
    if (id < 0) return -1;
    w.hp[id] = def.hp; w.maxHp[id] = def.hp; w.state[id] = UnitState.Idle;
    return id;
  }

  /** Find a free cell around a footprint (spiral, deterministic) and return packed cell index or -1. */
  freeCellAround(id: number, maxR = 6): number {
    const w = this.world;
    const size = w.size[id];
    const [tx, ty] = this.footprintTopLeft(id);
    for (let r = 1; r <= maxR; r++) {
      for (let y = ty - r; y < ty + size + r; y++) for (let x = tx - r; x < tx + size + r; x++) {
        const onRing = x === tx - r || y === ty - r || x === tx + size + r - 1 || y === ty + size + r - 1;
        if (!onRing) continue;
        if (!this.path.isBlockedCell(x, y)) return y * this.map.w + x;
      }
    }
    return -1;
  }

  // ------------------------------------------------------------------ helpers

  footprintTopLeft(id: number): [number, number] {
    const size = this.world.size[id];
    const cx = Math.round((this.world.x[id] - (size * FP_ONE) / 2) / FP_ONE);
    const cy = Math.round((this.world.y[id] - (size * FP_ONE) / 2) / FP_ONE);
    return [cx, cy];
  }

  /** distance (fixed) from a point to the edge of an entity (circle for units, square for buildings/mines) */
  distToEntity(x: number, y: number, id: number): number {
    const w = this.world;
    const k = w.kind[id];
    if (k === Kind.Unit) {
      const d = fpLen(w.x[id] - x, w.y[id] - y) - fp(UNITS[w.type[id] as UnitType].radius);
      return d < 0 ? 0 : d;
    }
    const half = (w.size[id] * FP_ONE) >> 1;
    let dx = Math.abs(w.x[id] - x) - half; if (dx < 0) dx = 0;
    let dy = Math.abs(w.y[id] - y) - half; if (dy < 0) dy = 0;
    return fpLen(dx, dy);
  }

  nearestMine(x: number, y: number, maxDist = fp(60)): number {
    const w = this.world;
    let best = -1, bd = maxDist;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
      const d = fpLen(w.x[id] - x, w.y[id] - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  nearestOwnBuilding(owner: number, type: BuildingType, x: number, y: number, completeOnly = true): number {
    const w = this.world;
    let best = -1, bd = 0x7fffffff;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Building || w.owner[id] !== owner || w.type[id] !== type) continue;
      if (completeOnly && w.state[id] !== BuildingState.Complete) continue;
      const d = fpLen(w.x[id] - x, w.y[id] - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  hasBuilding(owner: number, type: BuildingType): boolean {
    const w = this.world;
    for (let id = 0; id < w.maxId; id++) {
      if (w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === owner && w.type[id] === type && w.state[id] === BuildingState.Complete) return true;
    }
    return false;
  }

  isEnemy(a: number, b: number): boolean {
    const oa = this.world.owner[a], ob = this.world.owner[b];
    if (oa < 0 || ob < 0) return false;
    return this.players[oa].team !== this.players[ob].team;
  }
  sameTeam(pa: number, pb: number): boolean {
    return pa >= 0 && pb >= 0 && this.players[pa].team === this.players[pb].team;
  }

  setOrder(id: number, order: Order, x: number, y: number, target: number, v: number): void {
    const w = this.world;
    w.order[id] = order; w.orderX[id] = x; w.orderY[id] = y;
    w.orderTarget[id] = target; w.orderTargetGen[id] = target >= 0 ? w.gen[target] : 0; w.orderV[id] = v;
    if (order === Order.Attack && target >= 0) { w.target[id] = target; w.targetGen[id] = w.gen[target]; }
    else w.target[id] = -1;
    w.stuck[id] = 0;
    w.timer[id] = 0;
    if (order === Order.Patrol) { w.patrolX[id] = w.x[id]; w.patrolY[id] = w.y[id]; }
    if (w.state[id] !== UnitState.Dead) w.state[id] = UnitState.Idle;
  }

  /** advance to the next queued order or idle */
  nextOrder(id: number): void {
    const w = this.world;
    const o = this.scratchOrder;
    if (w.oqShift(id, o)) this.setOrder(id, o[0] as Order, o[1], o[2], o[3], o[4]);
    else this.setOrder(id, Order.None, 0, 0, -1, 0);
  }

  emit(type: EventType, a: number, b: number, x: number, y: number, v: number, owner: number): void {
    this.events.push({ type, tick: this.tick, a, b, x, y, v, owner });
  }

  armorOf(id: number): ArmorType {
    const w = this.world;
    if (w.kind[id] === Kind.Unit) return UNITS[w.type[id] as UnitType].armor;
    return ArmorType.Building;
  }

  /** Apply damage from attacker (may be -1 for zones) to target. */
  dealDamage(target: number, base: number, dtype: DamageType, attacker: number, attackerOwner: number, ignoreArmor = false, extraMultPct = 100): void {
    const w = this.world;
    if (!w.alive[target] || w.hp[target] <= 0) return;
    let dmg = base;
    if (!ignoreArmor) {
      dmg = Math.floor((dmg * DAMAGE_MATRIX[dtype][this.armorOf(target)]) / 100);
      if (w.kind[target] === Kind.Unit) {
        const o = w.owner[target];
        if (o >= 0) dmg -= this.players[o].upgrades[UpgradeId.Armor];
      }
      // shield stance (units only - on a building `buff` is the builder slow after a hit)
      if (w.kind[target] === Kind.Unit && w.buff[target] > 0) dmg = Math.floor((dmg * (100 - SHIELD_STANCE_REDUCTION_PCT)) / 100);
    }
    dmg = Math.floor((dmg * extraMultPct) / 100);
    if (dmg < 1) dmg = 1;
    w.hp[target] -= dmg;
    if (w.kind[target] === Kind.Building && w.state[target] === BuildingState.Constructing) {
      // a hit on a construction site knocks its progress back to match the hp and rattles the builders
      const total = BUILDINGS[w.type[target] as BuildingType].buildTime * 10;
      const pr = constructionProgressForHp(w.maxHp[target], w.hp[target], total);
      if (pr < w.progress[target]) w.progress[target] = pr;
      w.buff[target] = SITE_HIT_SLOW_TICKS;
    }
    // retaliation: idle non-worker units fight back
    if (attacker >= 0 && w.alive[attacker] && w.kind[target] === Kind.Unit && w.order[target] === Order.None && w.type[target] !== UnitType.Worker && w.target[target] < 0) {
      w.target[target] = attacker; w.targetGen[target] = w.gen[attacker];
    }
    if (w.hp[target] <= 0 && attackerOwner >= 0) {
      const p = this.players[attackerOwner];
      if (w.kind[target] === Kind.Unit) {
        p.unitsKilled++;
        // a kill pays a tenth of the victim's cost (militia are free, so nothing for them)
        const bounty = Math.floor(UNITS[w.type[target] as UnitType].cost / KILL_BOUNTY_DIV);
        if (bounty > 0 && w.owner[target] >= 0 && !this.sameTeam(attackerOwner, w.owner[target])) {
          p.gold += bounty;
          this.emit(EventType.Bounty, target, -1, w.x[target], w.y[target], bounty, attackerOwner);
        }
      } else if (w.kind[target] === Kind.Building) p.buildingsRazed++;
    }
    if (w.kind[target] === Kind.Building && w.type[target] === BuildingType.Castle) this.checkCastleWarning(target);
  }

  private checkCastleWarning(castle: number) {
    const w = this.world;
    const o = w.owner[castle];
    if (o < 0) return;
    const p = this.players[o];
    if (p.castles > 1 || w.state[castle] !== BuildingState.Complete) return;
    if (w.hp[castle] * 100 <= w.maxHp[castle] * LAST_CASTLE_WARNING_PCT && this.tick - p.lastWarningTick > 200) {
      p.lastWarningTick = this.tick;
      this.emit(EventType.LastCastleWarning, castle, -1, w.x[castle], w.y[castle], 0, o);
    }
  }

  unitDamage(id: number): number {
    const w = this.world;
    const def = UNITS[w.type[id] as UnitType];
    const p = this.players[w.owner[id]];
    const up = def.range > 1 ? p.upgrades[UpgradeId.RangedAttack] : p.upgrades[UpgradeId.MeleeAttack];
    return def.damage + up * 2;
  }
  unitRange(id: number): number {
    const w = this.world;
    const def = UNITS[w.type[id] as UnitType];
    if (def.range <= 1) return fp(def.range);
    return fp(def.range + this.players[w.owner[id]].upgrades[UpgradeId.Range]);
  }
  unitSpeed(id: number): number {
    const w = this.world;
    const def = UNITS[w.type[id] as UnitType];
    const p = this.players[w.owner[id]];
    return Math.floor((fp(def.speed / 20) * (100 + 10 * p.upgrades[UpgradeId.MoveSpeed])) / 100);
  }
  /**
   * Defensive reach of a building (fixed), measured from the edge of its footprint - compare with
   * `distFromBuilding`. Attackers measure their range to the edge of the building, so measuring the
   * building's own range the same way makes "catapult range <= castle range" mean exactly what it says.
   */
  buildingRange(id: number): number {
    const w = this.world;
    const def = BUILDINGS[w.type[id] as BuildingType];
    if (def.range <= 0) return 0;
    const owner = w.owner[id];
    const up = owner >= 0 ? this.players[owner].upgrades[UpgradeId.Range] : 0;
    return fp(def.range + up);
  }

  /**
   * Distance (fixed) from the footprint edge of building `b` to the edge of entity `t`. Mirrors
   * `distToEntity` seen from the building's side: a point on the wall to the target's outline.
   */
  distFromBuilding(b: number, t: number): number {
    const w = this.world;
    const half = (w.size[b] * FP_ONE) >> 1;
    let dx = Math.abs(w.x[t] - w.x[b]) - half; if (dx < 0) dx = 0;
    let dy = Math.abs(w.y[t] - w.y[b]) - half; if (dy < 0) dy = 0;
    let d = fpLen(dx, dy);
    if (w.kind[t] === Kind.Unit) d -= fp(UNITS[w.type[t] as UnitType].radius);
    else d -= (w.size[t] * FP_ONE) >> 1;
    return d < 0 ? 0 : d;
  }

  // ------------------------------------------------------------------ tick

  /** Validate a command against the current state; returns null when OK or a reason code. */
  validate(cmd: Command): string | null {
    return validateCommand(this, cmd);
  }

  /** Apply a batch of commands scheduled for this tick, then advance one tick. */
  step(commands: readonly Command[]): void {
    if (this.gameOver) return;
    this.tick++;
    this.events.length = 0;
    const w = this.world;
    w.px.set(w.x); w.py.set(w.y);
    w.moved.fill(0);
    for (const c of commands) {
      if (c.type !== CommandType.Eliminate && (c.player < 0 || c.player >= this.players.length || !this.players[c.player].alive)) continue;
      applyCommand(this, c);
    }
    this.grid.rebuild(w);
    this.path.beginTick();
    updateUnits(this);
    resolveMovement(this);
    updateProjectilesAndZones(this);
    updateBuildings(this);
    this.processDeaths();
    this.recountPop();
    if (this.tick % 2 === 0) this.updateFog();
    this.checkVictory();
  }

  private processDeaths(): void {
    const w = this.world;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      if (k === Kind.Unit) {
        if (w.hp[id] <= 0 || (w.type[id] === UnitType.Militia && w.lifetime[id] <= 0)) {
          this.emit(EventType.Death, id, -1, w.x[id], w.y[id], w.type[id], w.owner[id]);
          if (w.owner[id] >= 0 && w.hp[id] <= 0) this.players[w.owner[id]].unitsLost++;
          w.state[id] = UnitState.Dead;
          w.release(id);
        }
      } else if (k === Kind.Building) {
        if (w.hp[id] <= 0) this.destroyBuilding(id, true);
      } else if (k === Kind.Mine) {
        if (w.hp[id] <= 0) {
          this.emit(EventType.MineDepleted, id, -1, w.x[id], w.y[id], 0, -1);
          const [cx, cy] = this.footprintTopLeft(id);
          this.path.setFootprint(cx, cy, w.size[id], false);
          w.release(id);
        }
      }
    }
  }

  destroyBuilding(id: number, byCombat: boolean): void {
    const w = this.world;
    const o = w.owner[id];
    const type = w.type[id];
    const wasComplete = w.state[id] === BuildingState.Complete;
    const [cx, cy] = this.footprintTopLeft(id);
    this.path.setFootprint(cx, cy, w.size[id], false);
    if (byCombat) this.emit(EventType.BuildingDestroyed, id, -1, w.x[id], w.y[id], type, o);
    if (o >= 0) {
      if (byCombat) this.players[o].buildingsLost++;
      if (type === BuildingType.Castle && wasComplete) this.players[o].castles--;
      // a mine goes down with the workers inside it
      if (type === BuildingType.Mine && byCombat) this.players[o].unitsLost += w.carry[id];
    }
    w.release(id);
    if (o >= 0 && this.players[o].alive && type === BuildingType.Castle && this.players[o].castles <= 0) {
      this.eliminate(o);
    }
  }

  eliminate(playerId: number): void {
    const p = this.players[playerId];
    if (!p.alive) return;
    p.alive = false;
    p.eliminatedTick = this.tick;
    const w = this.world;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.owner[id] !== playerId) continue;
      const k = w.kind[id];
      if (k === Kind.Building) {
        const [cx, cy] = this.footprintTopLeft(id);
        this.path.setFootprint(cx, cy, w.size[id], false);
        this.emit(EventType.BuildingDestroyed, id, -1, w.x[id], w.y[id], w.type[id], playerId);
        w.release(id);
      } else if (k === Kind.Unit) {
        this.emit(EventType.Death, id, -1, w.x[id], w.y[id], w.type[id], playerId);
        w.release(id);
      } else if (k === Kind.Projectile || k === Kind.Zone) {
        w.release(id);
      }
    }
    p.castles = 0;
    this.emit(EventType.PlayerEliminated, -1, -1, 0, 0, playerId, playerId);
  }

  recountPop(): void {
    const w = this.world;
    for (const p of this.players) { p.popUsed = 0; p.popCap = 0; }
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const o = w.owner[id];
      if (o < 0) continue;
      const p = this.players[o];
      if (w.kind[id] === Kind.Unit) p.popUsed += UNITS[w.type[id] as UnitType].pop;
      else if (w.kind[id] === Kind.Building) {
        if (w.state[id] === BuildingState.Complete) p.popCap += BUILDINGS[w.type[id] as BuildingType].popCap;
        // workers inside a mine are no longer entities but still count as population
        if (w.type[id] === BuildingType.Mine) p.popUsed += w.carry[id] * UNITS[UnitType.Worker].pop;
        // queued units are not counted: they join the population the moment they step out (buildings.ts)
      }
    }
    for (const p of this.players) if (p.popCap > MAX_POP) p.popCap = MAX_POP;
  }

  updateFog(): void {
    const w = this.world;
    const fog = this.fog;
    fog.beginUpdate();
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const o = w.owner[id];
      if (o < 0) continue;
      const k = w.kind[id];
      if (k === Kind.Unit) fog.stamp(o, w.x[id], w.y[id], UNITS[w.type[id] as UnitType].vision);
      else if (k === Kind.Building) {
        // A construction site sees only once someone has actually worked on it. Placing one is
        // instant and costs a few gold, so a site that reveals ground on placement would be a
        // cheaper scout than any unit.
        const r = w.state[id] === BuildingState.Complete ? BUILDINGS[w.type[id] as BuildingType].vision : (w.progress[id] > 0 ? 4 : 0);
        if (r > 0) fog.stamp(o, w.x[id], w.y[id], r);
      }
    }
    fog.shareTeams(this.players.map((p) => p.team));
  }

  private checkVictory(): void {
    if (this.gameOver) return;
    const teams = new Set<number>();
    let aliveHumans = 0, votes = 0;
    for (const p of this.players) {
      if (!p.alive) continue;
      teams.add(p.team);
      if (!p.isBot) { aliveHumans++; if (p.votedDraw) votes++; }
    }
    if (teams.size <= 1) {
      this.gameOver = true;
      this.winnerTeam = teams.size === 1 ? [...teams][0] : -1;
      this.emit(EventType.GameOver, -1, -1, 0, 0, this.winnerTeam, -1);
    } else if (aliveHumans >= 1 && votes === aliveHumans) {
      const hasBots = this.players.some((p) => p.alive && p.isBot);
      // vs bots only a single human can't "draw"; with 2+ humans unanimous vote ends the game
      if (!hasBots || aliveHumans >= 2) {
        this.gameOver = true; this.winnerTeam = -1;
        this.emit(EventType.GameOver, -1, -1, 0, 0, -1, -1);
      }
    }
  }

  /** FNV-1a over the authoritative state (positions, hp, resources). */
  hash(): number {
    const f = new Fnv1a();
    const w = this.world;
    f.int(this.tick);
    for (const p of this.players) { f.int(p.gold); f.int(p.alive ? 1 : 0); f.int(p.popUsed); for (let i = 0; i < 6; i++) f.int(p.upgrades[i]); }
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      f.int(id); f.int(w.kind[id] | (w.type[id] << 8) | ((w.owner[id] & 0xff) << 16));
      f.int(w.x[id]); f.int(w.y[id]); f.int(w.hp[id]); f.int(w.state[id] | (w.order[id] << 8)); f.int(w.target[id]);
      f.int(w.cooldown[id]); f.int(w.progress[id]); f.int(w.carry[id]);
    }
    const s = this.rng.state();
    f.int(s[0]); f.int(s[1]);
    return f.value();
  }

  /** Is entity visible to player p (team vision)? Own/allied entities always. */
  visibleTo(p: number, id: number): boolean {
    const w = this.world;
    if (w.owner[id] >= 0 && this.sameTeam(p, w.owner[id])) return true;
    return this.fog.isVisible(p, w.x[id], w.y[id]);
  }

  cellOf(x: number, y: number): number { return (y >> FP_SHIFT) * this.map.w + (x >> FP_SHIFT); }
}
