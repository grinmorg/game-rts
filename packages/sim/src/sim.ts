import {
  garrisonCapacity,
  buildingMaxHp,
  BUILDINGS, DAMAGE_MATRIX, FOREST_BURN_TICKS, GATHER_AUTO, GOLD_PER_TRIP, HARD_AI_GATHER_BONUS_PCT, KILL_BOUNTY_DIV,
  LAST_CASTLE_WARNING_PCT, LOADED_SLOW_PCT, MINE_SIZE,
  SHIELD_STANCE_REDUCTION_PCT, SITE_HIT_SLOW_TICKS, START_GOLD, START_WORKERS, UNITS, constructionProgressForHp, constructionStartHp, hitsBuildingsOnly, isHeavy,
} from './data';
import { FP_ONE, FP_SHIFT, fp, fpLen } from './fixed';
import { Fog, FogSnapshot } from './fog';
import { Fnv1a } from './hash';
import { MapData, MapStart } from './map';
import { Pathfinder, Gate, GATE_LENGTH, PathSnapshot } from './path';
import { dropGarrison } from './systems/workers';
import { Rng } from './rng';
import { GridSnapshot, SpatialGrid } from './spatial';
import {
  AGE_COUNT, Age,
  ArmorType, BuildingState, BuildingType, Command, CommandType, DamageType, EventType, Kind, MAX_POP, MatchSetup, Order, SimEvent,
  Tile, UnitState, UnitType, UpgradeId, entityCap,
} from './types';
import { World, WorldSnapshot } from './world';
import type { ViewFrame } from './viewframe';
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
  /** technological age (Age enum): gates units, buildings and upgrade levels; stone buildings are sturdier */
  age: Age;
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

/** the whole state of a Simulation (see snapshot.ts) */
export interface SimSnapshot {
  tick: number;
  gameOver: boolean;
  winnerTeam: number;
  gatesDirty: boolean;
  /** the map's tiles: fire turns forest into grass */
  tiles: Uint8Array;
  burnUntil: Int32Array;
  burning: number[];
  players: Player[];
  rng: [number, number, number, number];
  world: WorldSnapshot;
  fog: FogSnapshot;
  path: PathSnapshot;
  grid: GridSnapshot;
  /** the movement requests of the last tick, cut at maxId */
  mvx: Int32Array;
  mvy: Int32Array;
  mvSpeed: Int32Array;
  wantMove: Uint8Array;
}

export class Simulation {
  readonly setup: MatchSetup;
  readonly map: MapData;
  readonly world: World;
  readonly players: Player[] = [];
  readonly grid: SpatialGrid;
  readonly path: Pathfinder;
  readonly fog: Fog;
  readonly rng: Rng;
  tick = 0;
  events: SimEvent[] = [];
  gameOver = false;
  winnerTeam = -1;
  /** forest cells on fire: tick at which each burns down (0 = not burning), plus the list of burning cells */
  readonly burnUntil: Int32Array;
  readonly burning: number[] = [];
  /** bumps whenever tiles change (forest burnt down) so the view can refresh terrain and decor */
  terrainRevision = 0;
  /** team per player id, flat for the hot neighbour queries (see isEnemy) */
  private readonly teamOf: Int8Array;
  /**
   * A finished fence appeared or went this tick: the gates are recomputed once, at the end of the tick (see
   * updateGates). Raised by the building system too, when a fence under construction is completed.
   */
  gatesDirty = false;
  private gateOwnerScratch: Int8Array;
  private gateTakenScratch: Uint8Array;
  /** desired-move scratch (filled by units system, consumed by movement system) */
  readonly mvx: Int32Array;
  readonly mvy: Int32Array;
  readonly mvSpeed: Int32Array;
  readonly wantMove: Uint8Array;
  private scratchOrder = new Int32Array(5);

  constructor(setup: MatchSetup, map: MapData) {
    this.setup = setup;
    this.world = new World(entityCap(setup.players.length));
    // own copy of the tiles: fire changes them, and official maps are shared through a cache
    this.map = { ...map, tiles: map.tiles.slice() };
    map = this.map;
    this.rng = new Rng(setup.seed);
    // one grid cell per map cell: separation queries (radius ~1.4) then look at about a third of the
    // candidates a two-cell grid handed them, which is the bulk of the work in a big melee
    this.grid = new SpatialGrid(map.w, map.h, this.world.cap, 1);
    this.path = new Pathfinder(map);
    this.burnUntil = new Int32Array(map.w * map.h);
    this.fog = new Fog(map.w, map.h, setup.players.map((p) => p.team));
    this.teamOf = Int8Array.from(setup.players.map((p) => p.team));
    this.gateOwnerScratch = new Int8Array(map.w * map.h);
    this.gateTakenScratch = new Uint8Array(map.w * map.h);
    this.mvx = new Int32Array(this.world.cap);
    this.mvy = new Int32Array(this.world.cap);
    this.mvSpeed = new Int32Array(this.world.cap);
    this.wantMove = new Uint8Array(this.world.cap);

    for (const ps of setup.players) {
      this.players.push({
        id: ps.slot, team: ps.team, name: ps.name, isBot: ps.isBot, difficulty: ps.difficulty ?? 1, color: ps.color,
        gold: START_GOLD, popUsed: 0, popCap: 0, upgrades: new Int32Array(6), age: Age.First, alive: true, eliminatedTick: -1,
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
          this.setOrder(wid, Order.Gather, this.world.x[mine], this.world.y[mine], mine, GATHER_AUTO);
        }
      }
    }
  }

  spawnMine(cx: number, cy: number, gold: number): number {
    const w = this.world;
    const id = w.alloc(Kind.Mine, 0, -1, fp(cx + 0.5), fp(cy + 0.5));
    if (id < 0) return -1;
    w.hp[id] = gold; w.maxHp[id] = gold; w.size[id] = MINE_SIZE;
    this.path.setFootprint(cx - 1, cy - 1, MINE_SIZE, true, id, false);
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
    w.maxHp[id] = buildingMaxHp(type, this.players[owner]?.age ?? Age.First); // stone-age buildings are sturdier
    if (complete) { w.hp[id] = w.maxHp[id]; w.state[id] = BuildingState.Complete; w.progress[id] = def.buildTime * 10; }
    else { w.hp[id] = constructionStartHp(w.maxHp[id]); w.state[id] = BuildingState.Constructing; w.progress[id] = 0; }
    // a construction site does not block anyone; the footprint closes when the building is finished (buildings.ts)
    if (complete) this.path.setFootprint(cx, cy, def.size, true, id, type !== BuildingType.Wall);
    if (complete && type === BuildingType.Wall) this.gatesDirty = true;
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

  /**
   * Gates. GATE_LENGTH fence cells in a straight line are a gate: towers on the two end cells, the door on the seam
   * between the two middle ones - a one-cell corridor the owner's team walks through, and a wall to everyone else
   * (Pathfinder.setGates). Every maximal straight run of finished fence held by one team gets one gate, at its
   * centre, provided it is long enough; if a side fence joins the run right at the door, the gate slides along the
   * run to the nearest clear spot. Runs along x are laid first, so a corner cell shared with a run along y belongs
   * to one gate at most. Rebuilt from scratch whenever a fence is finished or lost (gatesDirty), integer-only and
   * in a fixed scan order, so every peer lays the same gates.
   */
  private updateGates(): void {
    const w = this.world, mw = this.map.w, mh = this.map.h;
    const owner = this.gateOwnerScratch, taken = this.gateTakenScratch;
    owner.fill(-1); taken.fill(0);
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Building || w.type[id] !== BuildingType.Wall || w.state[id] !== BuildingState.Complete) continue;
      const t = this.team(w.owner[id]);
      if (t >= 0) owner[(w.y[id] >> FP_SHIFT) * mw + (w.x[id] >> FP_SHIFT)] = t;
    }
    const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= mw || y >= mh ? -1 : owner[y * mw + x]);
    const gates: Gate[] = [];
    for (const dir of [0, 1] as const) {
      // every line parallel to `dir`: (l, s) is (y, x) along x and (x, y) along y
      const lines = dir === 0 ? mh : mw, len = dir === 0 ? mw : mh;
      const cellAt = (l: number, s: number) => (dir === 0 ? l * mw + s : s * mw + l);
      const teamAt = (l: number, s: number) => (dir === 0 ? at(s, l) : at(l, s));
      /**
       * The corridor for a door at `st`: the two middle cells of the run, plus every consecutive fence cell of the
       * same team directly behind them - the thickness of the wall, which a second row laid flush against the first
       * is. Null when the wall is deeper than GATE_LENGTH, which is what keeps gates out of a solid block of fence
       * and out of the short ends of a thick one.
       */
      const corridorAt = (l: number, st: number, t: number): { low: number[]; high: number[] } | null => {
        const low = [cellAt(l, st + 1)], high = [cellAt(l, st + 2)];
        let layers = 1;
        for (const step of [1, -1]) {
          for (let d = step; ; d += step) {
            const ll = l + d;
            if (ll < 0 || ll >= lines) break;
            const a = teamAt(ll, st + 1) === t, b = teamAt(ll, st + 2) === t;
            if (!a && !b) break;
            if (a) low.push(cellAt(ll, st + 1));
            if (b) high.push(cellAt(ll, st + 2));
            if (++layers > GATE_LENGTH) return null;
          }
        }
        return { low, high };
      };
      for (let l = 0; l < lines; l++) {
        for (let s = 0; s < len;) {
          const t = teamAt(l, s);
          if (t < 0) { s++; continue; }
          let e = s;
          while (e + 1 < len && teamAt(l, e + 1) === t) e++;
          const n = e - s + 1;
          // a run another gate's corridor already crosses has its hole; a second one would be a second gate in
          // the same wall. This is what stops the row behind a thick wall from asking for one of its own.
          let crossed = false;
          for (let i = s; i <= e && !crossed; i++) if (taken[cellAt(l, i)]) crossed = true;
          if (!crossed && n >= GATE_LENGTH) {
            // centred on the run, then sliding outwards one cell at a time. The first pass only takes a spot where
            // the wall is a single fence thick, which is what the gatehouse is drawn for; the second accepts one
            // that has to tunnel, which is how a wall laid two or more rows deep still gets its gate.
            const centre = s + ((n - GATE_LENGTH) >> 1);
            let placed = false;
            for (let pass = 0; pass < 2 && !placed; pass++) {
              for (let k = 0; k <= 2 * (n - GATE_LENGTH); k++) {
                const st = centre + ((k & 1) ? -((k + 1) >> 1) : (k >> 1));
                if (st < s || st + GATE_LENGTH - 1 > e) continue;
                const cor = corridorAt(l, st, t);
                if (!cor) continue;
                if (pass === 0 && (cor.low.length > 1 || cor.high.length > 1)) continue;
                const cells: Gate['cells'] = [cellAt(l, st), cellAt(l, st + 1), cellAt(l, st + 2), cellAt(l, st + 3)];
                for (const c of cells) taken[c] = 1;
                for (const c of cor.low) taken[c] = 1;
                for (const c of cor.high) taken[c] = 1;
                gates.push({ cells, dir, team: t, doorLow: cor.low, doorHigh: cor.high });
                placed = true;
                break;
              }
            }
          }
          s = e + 1;
        }
      }
    }
    this.path.setGates(gates);
  }

  // ------------------------------------------------------------------ fire

  /** Set every forest cell within `radius` (fixed) of (x,y) on fire; it burns down FOREST_BURN_TICKS later. */
  igniteForest(x: number, y: number, radius: number): void {
    const w = this.map.w, h = this.map.h, tiles = this.map.tiles;
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT, r = (radius + FP_ONE - 1) >> FP_SHIFT;
    for (let ty = cy - r; ty <= cy + r; ty++) for (let tx = cx - r; tx <= cx + r; tx++) {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const i = ty * w + tx;
      if (tiles[i] !== Tile.Forest || this.burnUntil[i] !== 0) continue;
      const dx = fp(tx + 0.5) - x, dy = fp(ty + 0.5) - y;
      if (fpLen(dx, dy) > radius) continue;
      this.burnUntil[i] = this.tick + FOREST_BURN_TICKS;
      this.burning.push(i);
    }
  }

  private updateFires(): void {
    if (this.burning.length === 0) return;
    const w = this.map.w, tiles = this.map.tiles;
    let changed = false;
    for (let k = this.burning.length - 1; k >= 0; k--) {
      const i = this.burning[k];
      if (this.burnUntil[i] > this.tick) continue;
      // burnt out: scorched ground, passable from now on
      tiles[i] = Tile.Dirt;
      this.burnUntil[i] = 0;
      this.path.setTerrain(i % w, Math.floor(i / w), true);
      this.burning[k] = this.burning[this.burning.length - 1]; this.burning.pop();
      this.emit(EventType.ForestBurnt, -1, -1, fp((i % w) + 0.5), fp(Math.floor(i / w) + 0.5), 0, -1);
      changed = true;
    }
    if (changed) this.terrainRevision++;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * A player enters the next age (researched at `castle`): every building they own, finished or not, is rebuilt in
   * stone - max HP scales to the new age's value and current HP keeps its share of it.
   */
  ageUp(player: number, castle: number): void {
    const p = this.players[player];
    if (p.age >= AGE_COUNT - 1) return;
    p.age = (p.age + 1) as Age;
    const w = this.world;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Building || w.owner[id] !== player) continue;
      const nm = buildingMaxHp(w.type[id] as BuildingType, p.age), om = w.maxHp[id];
      if (nm === om || om <= 0) continue;
      w.hp[id] = Math.max(1, Math.floor((w.hp[id] * nm) / om));
      w.maxHp[id] = nm;
    }
    this.emit(EventType.AgeUp, castle, -1, w.x[castle], w.y[castle], p.age, player);
  }

  /** the building whose footprint contains the point (fixed-point), -1 if none */
  buildingAt(x: number, y: number): number {
    const w = this.world;
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Building) continue;
      const [tx, ty] = this.footprintTopLeft(id);
      const sz = w.size[id];
      if (cx >= tx && cx < tx + sz && cy >= ty && cy < ty + sz) return id;
    }
    return -1;
  }

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

  /** nearest gold deposit; with `forUnit` set, only deposits that unit can actually walk to */
  nearestMine(x: number, y: number, maxDist = fp(60), forUnit = -1): number {
    const w = this.world;
    let best = -1, bd = maxDist;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
      const d = fpLen(w.x[id] - x, w.y[id] - y);
      if (d >= bd) continue;
      if (forUnit >= 0 && !this.path.reachableFP(w.x[forUnit], w.y[forUnit], w.x[id] >> FP_SHIFT, w.y[id] >> FP_SHIFT, isHeavy(w.type[forUnit] as UnitType), this.team(w.owner[forUnit]))) continue;
      bd = d; best = id;
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

  /** buildings of `type` the player owns, construction sites included - what BUILDING_LIMIT is checked against */
  buildingCount(owner: number, type: BuildingType): number {
    const w = this.world;
    let n = 0;
    for (let id = 0; id < w.maxId; id++) {
      if (w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === owner && w.type[id] === type) n++;
    }
    return n;
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
    // flat lookup: this runs for every candidate of every neighbour query
    return this.teamOf[oa] !== this.teamOf[ob];
  }
  sameTeam(pa: number, pb: number): boolean {
    return pa >= 0 && pb >= 0 && this.teamOf[pa] === this.teamOf[pb];
  }
  /** the team a player is on, -1 for nobody (neutral, or no such player) */
  team(player: number): number { return player >= 0 && player < this.teamOf.length ? this.teamOf[player] : -1; }

  /**
   * Give a unit an order. A worker with gold in his hands finishes the trip first: the new order waits in
   * his queue while he walks the load to the castle, and starts the moment he drops it (see `gatherOrder`).
   * `Stop` and `Hold` are exempt - those are the player calling him off, not another job - and so is a
   * gather order, which already means "take this to the castle" for a loaded worker. Queue pops go through
   * `applyOrder`, so an order that is already waiting cannot be made to wait again.
   */
  setOrder(id: number, order: Order, x: number, y: number, target: number, v: number): void {
    const w = this.world;
    if (w.kind[id] === Kind.Unit && w.type[id] === UnitType.Worker && w.carry[id] > 0
      && order !== Order.None && order !== Order.Hold && order !== Order.Gather
      && this.nearestOwnBuilding(w.owner[id], BuildingType.Castle, w.x[id], w.y[id], true) >= 0
      && w.oqPush(id, order, x, y, target, v)) {
      // keep the mine he came from, so an empty queue later sends him back to it
      const mine = w.order[id] === Order.Gather ? w.orderTarget[id] : -1;
      this.applyOrder(id, Order.Gather, w.x[id], w.y[id], mine, GATHER_AUTO);
      return;
    }
    this.applyOrder(id, order, x, y, target, v);
  }

  private applyOrder(id: number, order: Order, x: number, y: number, target: number, v: number): void {
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
    if (w.oqShift(id, o)) this.applyOrder(id, o[0] as Order, o[1], o[2], o[3], o[4]);
    else this.applyOrder(id, Order.None, 0, 0, -1, 0);
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
    // retaliation: idle non-worker units fight back - except a ram, which has no answer to a man
    if (attacker >= 0 && w.alive[attacker] && w.kind[target] === Kind.Unit && w.order[target] === Order.None && w.type[target] !== UnitType.Worker && w.target[target] < 0
      && !(w.kind[attacker] !== Kind.Building && hitsBuildingsOnly(w.type[target] as UnitType))) {
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
  /**
   * Sight of a unit, in whole cells. Never shorter than how far it can actually shoot: the range upgrade
   * lengthens the reach and the sight together, so nothing in the game ever hits what it cannot see.
   */
  unitVision(id: number): number {
    const w = this.world;
    const def = UNITS[w.type[id] as UnitType];
    const owner = w.owner[id];
    const up = def.range > 1 && owner >= 0 ? this.players[owner].upgrades[UpgradeId.Range] : 0;
    const reach = def.range + up;
    return def.vision > reach ? def.vision : reach;
  }
  /** the same rule for a defensive building: a tower or castle never outshoots its own sight */
  buildingVision(id: number): number {
    const w = this.world;
    const def = BUILDINGS[w.type[id] as BuildingType];
    const owner = w.owner[id];
    const up = def.range > 0 && owner >= 0 ? this.players[owner].upgrades[UpgradeId.Range] : 0;
    const reach = def.range + up;
    return def.vision > reach ? def.vision : reach;
  }
  unitSpeed(id: number): number {
    const w = this.world;
    const def = UNITS[w.type[id] as UnitType];
    const p = this.players[w.owner[id]];
    const speed = Math.floor((fp(def.speed / 20) * (100 + 10 * p.upgrades[UpgradeId.MoveSpeed])) / 100);
    // a full load of gold slows the walk home; a part load (the last scrapings of a mine) is carried freely
    if (w.type[id] === UnitType.Worker && w.carry[id] >= GOLD_PER_TRIP) return Math.floor((speed * (100 - LOADED_SLOW_PCT)) / 100);
    return speed;
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
    this.updateFires();
    updateBuildings(this);
    this.processDeaths();
    if (this.gatesDirty) { this.gatesDirty = false; this.updateGates(); }
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
          this.emit(EventType.Death, id, w.hp[id] <= 0 ? 1 : -1, w.x[id], w.y[id], w.type[id], w.owner[id]);
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
    if (type === BuildingType.Wall && wasComplete) this.gatesDirty = true;
    if (byCombat) this.emit(EventType.BuildingDestroyed, id, -1, w.x[id], w.y[id], type, o);
    if (o >= 0) {
      if (byCombat) this.players[o].buildingsLost++;
      if (type === BuildingType.Castle && wasComplete) this.players[o].castles--;
      // a mine goes down with the workers inside it; a tower's garrison jumps clear (and half of them break their necks)
      if (type === BuildingType.Mine && byCombat) this.players[o].unitsLost += w.carry[id];
      if (type === BuildingType.Tower && w.carry[id] > 0) dropGarrison(this, id, byCombat);
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
        if (w.type[id] === BuildingType.Wall) this.gatesDirty = true;
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
        // workers inside a mine or a tower are no longer entities but still count as population
        if (garrisonCapacity(w.type[id] as BuildingType) > 0) p.popUsed += w.carry[id] * UNITS[UnitType.Worker].pop;
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
      if (k === Kind.Unit) fog.stamp(o, w.x[id], w.y[id], this.unitVision(id));
      else if (k === Kind.Building) {
        // A construction site sees only once someone has actually worked on it. Placing one is
        // instant and costs a few gold, so a site that reveals ground on placement would be a
        // cheaper scout than any unit.
        const r = w.state[id] === BuildingState.Complete ? this.buildingVision(id) : (w.progress[id] > 0 ? 4 : 0);
        if (r > 0) fog.stamp(o, w.x[id], w.y[id], r);
      }
    }
    fog.endUpdate();
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
    for (const p of this.players) { f.int(p.gold); f.int(p.alive ? 1 : 0); f.int(p.popUsed); f.int(p.age); for (let i = 0; i < 6; i++) f.int(p.upgrades[i]); }
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

  // ------------------------------------------------------------------ snapshots

  /** the whole state, copied (see snapshot.ts); the simulation itself is left exactly as it was */
  snapshot(): SimSnapshot {
    const n = this.world.maxId;
    return {
      tick: this.tick, gameOver: this.gameOver, winnerTeam: this.winnerTeam, gatesDirty: this.gatesDirty,
      tiles: this.map.tiles.slice(), burnUntil: this.burnUntil.slice(), burning: this.burning.slice(),
      players: this.players.map((p) => ({ ...p, upgrades: p.upgrades.slice() })),
      rng: this.rng.state(),
      world: this.world.snapshot(), fog: this.fog.snapshot(), path: this.path.snapshot(), grid: this.grid.snapshot(),
      mvx: this.mvx.slice(0, n), mvy: this.mvy.slice(0, n), mvSpeed: this.mvSpeed.slice(0, n), wantMove: this.wantMove.slice(0, n),
    };
  }

  /**
   * Become the simulation a snapshot was taken of, in place: the view keeps its references to the world, the fog
   * and the players, and simply sees another moment of the match. The last tick's events are dropped - they
   * belonged to the moment left behind.
   */
  restore(s: SimSnapshot): void {
    const end = Math.max(this.world.maxId, s.world.maxId);
    this.tick = s.tick; this.gameOver = s.gameOver; this.winnerTeam = s.winnerTeam; this.gatesDirty = s.gatesDirty;
    this.events = [];
    this.map.tiles.set(s.tiles);
    this.burnUntil.set(s.burnUntil);
    this.burning.length = 0; this.burning.push(...s.burning);
    for (let i = 0; i < this.players.length; i++) {
      const up = this.players[i].upgrades;
      Object.assign(this.players[i], s.players[i], { upgrades: up });
      up.set(s.players[i].upgrades);
    }
    this.rng.setState([...s.rng] as [number, number, number, number]);
    this.world.restore(s.world);
    this.fog.restore(s.fog);
    this.path.restore(s.path);
    this.grid.restore(s.grid);
    for (const [dst, src] of [[this.mvx, s.mvx], [this.mvy, s.mvy], [this.mvSpeed, s.mvSpeed], [this.wantMove, s.wantMove]] as const) {
      dst.set(src); dst.fill(0, src.length, end);
    }
    // the tiles may be another moment's: the view rebuilds the ground and the trees
    this.terrainRevision++;
  }

  /**
   * Show what a frame from the simulation that really runs this match says (see viewframe.ts). Only for a view's
   * copy, which is never stepped: the world, players and events are replaced, the fog, layers and ground updated
   * where the frame carries them, and the spatial grid rebuilt for the view's own queries (hover, gates).
   */
  applyViewFrame(f: ViewFrame): void {
    this.tick = f.tick; this.gameOver = f.gameOver; this.winnerTeam = f.winnerTeam;
    this.events = f.events;
    for (let i = 0; i < this.players.length; i++) {
      const up = this.players[i].upgrades;
      Object.assign(this.players[i], f.players[i], { upgrades: up });
      up.set(f.players[i].upgrades);
    }
    this.world.restore(f.world);
    // the view uploads its fog texture when the revision changes: count what arrives here, a buffer that comes in
    // for a newly watched team carries the source's revision unchanged
    if (f.fog) { for (const [bi, data] of f.fog.buffers) this.fog.setBuffer(bi, data); this.fog.revision++; }
    if (f.layers) this.path.applyLayerDelta(f.layers);
    if (f.tiles) this.map.tiles.set(f.tiles);
    this.terrainRevision = f.terrainRevision;
    this.burning.length = 0; this.burning.push(...f.burning);
    this.grid.rebuild(this.world);
  }

  /** Is entity visible to player p (team vision)? Own/allied entities always. */
  visibleTo(p: number, id: number): boolean {
    const w = this.world;
    if (w.owner[id] >= 0 && this.sameTeam(p, w.owner[id])) return true;
    return this.fog.isVisible(p, w.x[id], w.y[id]);
  }

  cellOf(x: number, y: number): number { return (y >> FP_SHIFT) * this.map.w + (x >> FP_SHIFT); }
}
