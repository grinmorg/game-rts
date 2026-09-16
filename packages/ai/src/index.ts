import {
  ABILITIES, AbilityId, BUILDING_TYPE_COUNT, BUILDINGS, BuildingState, BuildingType, Command, CommandType, FP_SHIFT, Kind,
  MINE_MAX_WORKERS, Order, Rng, Simulation, UNITS, UNIT_TYPE_COUNT, UnitType, UpgradeId, canPlaceBuilding, fp, fpLen, toFloat,
  upgradeCost, UPGRADES, MAX_POP,
} from '@warlets/sim';

export type Difficulty = 0 | 1 | 2;

interface Profile {
  thinkInterval: number;
  apm: number;
  maxWorkers: number;
  attackPop: number;
  attackPopGrowth: number;
  micro: boolean;
  expand: boolean;
  upgrades: boolean;
  scout: boolean;
  towers: boolean;
  retreatHpPct: number;
  reactionTicks: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  0: { thinkInterval: 30, apm: 3, maxWorkers: 10, attackPop: 18, attackPopGrowth: 4, micro: false, expand: false, upgrades: false, scout: false, towers: false, retreatHpPct: 0, reactionTicks: 60 },
  1: { thinkInterval: 15, apm: 6, maxWorkers: 16, attackPop: 22, attackPopGrowth: 4, micro: true, expand: true, upgrades: true, scout: true, towers: true, retreatHpPct: 25, reactionTicks: 30 },
  2: { thinkInterval: 8, apm: 12, maxWorkers: 22, attackPop: 20, attackPopGrowth: 6, micro: true, expand: true, upgrades: true, scout: true, towers: true, retreatHpPct: 30, reactionTicks: 10 },
};

interface KnownBuilding { id: number; gen: number; x: number; y: number; type: number; owner: number; lastSeen: number }

interface Snapshot {
  workers: number[];
  army: number[];
  byType: number[][];
  buildings: number[];
  complete: number[][];
  constructing: number[][];
  castles: number[];
  enemyUnits: number[];
  enemyByType: number[];
  enemyBuildings: number[];
  idleWorkers: number[];
  gold: number;
  popUsed: number;
  popCap: number;
}

/**
 * Rule-based RTS bot. Runs on the shared simulation state (respecting fog for enemy info)
 * and emits regular commands; the same code runs in the browser (skirmish) and on the server (lobby bots).
 */
export class Bot {
  readonly player: number;
  readonly difficulty: Difficulty;
  readonly profile: Profile;
  private rng: Rng;
  private known = new Map<number, KnownBuilding>();
  private attackWave = 0;
  private attacking = false;
  private attackStartValue = 0;
  private attackTarget: { x: number; y: number } | null = null;
  private lastScoutTick = -100000;
  private scoutUnit = -1;
  private lastHouseTick = -100000;
  private lastBuildTick = -100000;
  private nextThink = 0;
  private threatTick = -100000;
  private threatPos: { x: number; y: number } | null = null;
  private kiting = new Map<number, number>();
  private fleeing = new Map<number, number>();
  private rallySet = new Set<number>();
  private lastMilitia = -100000;

  constructor(player: number, difficulty: Difficulty, seed: number) {
    this.player = player;
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
    this.rng = new Rng((seed ^ (player * 0x9e3779b9)) | 0);
    this.nextThink = 20 + player * 3;
  }

  /** Call once per tick; returns commands (possibly empty). */
  think(sim: Simulation): Command[] {
    if (sim.tick < this.nextThink || sim.gameOver) return [];
    const p = sim.players[this.player];
    if (!p.alive) return [];
    this.nextThink = sim.tick + this.profile.thinkInterval;
    const out: Command[] = [];
    const snap = this.snapshot(sim);
    this.updateKnowledge(sim, snap);
    this.detectThreat(sim, snap);
    this.economy(sim, snap, out);
    this.construction(sim, snap, out);
    this.production(sim, snap, out);
    this.military(sim, snap, out);
    if (this.profile.micro) this.micro(sim, snap, out);
    if (this.profile.scout) this.scouting(sim, snap, out);
    // APM cap: keep the first N commands (they're roughly priority-ordered)
    if (out.length > this.profile.apm) out.length = this.profile.apm;
    return out;
  }

  // ------------------------------------------------------------ perception

  private snapshot(sim: Simulation): Snapshot {
    const perType = () => Array.from({ length: UNIT_TYPE_COUNT }, () => [] as number[]);
    const perBuilding = () => Array.from({ length: BUILDING_TYPE_COUNT }, () => [] as number[]);
    const w = sim.world;
    const me = this.player;
    const s: Snapshot = {
      workers: [], army: [], byType: perType(), buildings: [], complete: perBuilding(), constructing: perBuilding(),
      castles: [], enemyUnits: [], enemyByType: new Array<number>(UNIT_TYPE_COUNT).fill(0), enemyBuildings: [], idleWorkers: [],
      gold: sim.players[me].gold, popUsed: sim.players[me].popUsed, popCap: sim.players[me].popCap,
    };
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      if (k !== Kind.Unit && k !== Kind.Building) continue;
      const o = w.owner[id];
      if (o === me) {
        if (k === Kind.Unit) {
          const t = w.type[id];
          s.byType[t].push(id);
          if (t === UnitType.Worker) { s.workers.push(id); if (w.order[id] === Order.None) s.idleWorkers.push(id); }
          else if (t !== UnitType.Militia) s.army.push(id);
        } else {
          s.buildings.push(id);
          if (w.state[id] === BuildingState.Complete) { s.complete[w.type[id]].push(id); if (w.type[id] === BuildingType.Castle) s.castles.push(id); }
          else s.constructing[w.type[id]].push(id);
        }
      } else if (o >= 0 && !sim.sameTeam(me, o)) {
        if (!sim.visibleTo(me, id)) continue;
        if (k === Kind.Unit) { s.enemyUnits.push(id); s.enemyByType[w.type[id]]++; }
        else s.enemyBuildings.push(id);
      }
    }
    // the sim counts population when a unit steps out; for planning the bot still counts what it has queued
    for (const b of s.buildings) for (let i = 0; i < w.queueLen[b]; i++) {
      const item = w.qGet(b, i);
      if (item >= 0 && item < UNIT_TYPE_COUNT) s.popUsed += UNITS[item as UnitType].pop;
    }
    return s;
  }

  private updateKnowledge(sim: Simulation, s: Snapshot) {
    const w = sim.world;
    for (const id of s.enemyBuildings) {
      this.known.set(id, { id, gen: w.gen[id], x: w.x[id], y: w.y[id], type: w.type[id], owner: w.owner[id], lastSeen: sim.tick });
    }
    for (const [id, kb] of this.known) {
      const gone = !w.alive[id] || w.gen[id] !== kb.gen || w.kind[id] !== Kind.Building;
      if (gone && sim.fog.isVisible(this.player, kb.x, kb.y)) this.known.delete(id);
      else if (gone && sim.tick - kb.lastSeen > 20 * 60 * 6) this.known.delete(id);
      else if (!gone && !sim.players[kb.owner].alive) this.known.delete(id);
    }
  }

  private detectThreat(sim: Simulation, s: Snapshot) {
    const w = sim.world;
    let best: { x: number; y: number } | null = null;
    let bestD = fp(16);
    for (const e of s.enemyUnits) {
      if (w.type[e] === UnitType.Worker) continue;
      for (const b of s.buildings) {
        const d = fpLen(w.x[e] - w.x[b], w.y[e] - w.y[b]);
        if (d < bestD) { bestD = d; best = { x: w.x[e], y: w.y[e] }; }
      }
    }
    if (best) { this.threatPos = best; this.threatTick = sim.tick; }
    else if (sim.tick - this.threatTick > 20 * 8) this.threatPos = null;
  }

  // ------------------------------------------------------------ economy

  private mineWorkerCount(sim: Simulation, mine: number): number {
    const w = sim.world;
    let n = 0;
    for (let id = 0; id < w.maxId; id++) {
      if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === this.player && w.type[id] === UnitType.Worker && w.order[id] === Order.Gather && w.orderTarget[id] === mine) n++;
    }
    return n;
  }

  /** mines within reach of my castles, sorted by distance to the first castle */
  private myMines(sim: Simulation, s: Snapshot): number[] {
    const w = sim.world;
    const res: { id: number; d: number }[] = [];
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
      let bd = 0x7fffffff;
      for (const c of s.castles) { const d = fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]); if (d < bd) bd = d; }
      if (bd < fp(13)) res.push({ id, d: bd });
    }
    res.sort((a, b) => a.d - b.d || a.id - b.id);
    return res.map((r) => r.id);
  }

  private economy(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    const mines = this.myMines(sim, s);
    // idle workers -> least crowded mine
    if (s.idleWorkers.length > 0 && mines.length > 0) {
      let bestMine = -1, bestN = 1e9;
      for (const m of mines) { const n = this.mineWorkerCount(sim, m); if (n < bestN) { bestN = n; bestMine = m; } }
      if (bestMine >= 0) out.push({ type: CommandType.Gather, player: this.player, ids: s.idleWorkers.slice(0, 6), target: bestMine });
    }
    // rebalance: if a mine is over capacity, move extras
    if (mines.length > 1 && sim.tick % 100 < this.profile.thinkInterval) {
      for (const m of mines) {
        const n = this.mineWorkerCount(sim, m);
        if (n <= MINE_MAX_WORKERS) continue;
        const other = mines.find((o) => o !== m && this.mineWorkerCount(sim, o) < MINE_MAX_WORKERS - 1);
        if (other === undefined) break;
        const extras: number[] = [];
        for (const wk of s.workers) if (w.orderTarget[wk] === m && w.order[wk] === Order.Gather) { extras.push(wk); if (extras.length >= n - MINE_MAX_WORKERS) break; }
        if (extras.length) out.push({ type: CommandType.Gather, player: this.player, ids: extras, target: other });
        break;
      }
    }
    // train workers
    const desiredWorkers = Math.min(this.profile.maxWorkers, Math.max(6, mines.length * MINE_MAX_WORKERS));
    const queuedWorkers = s.castles.reduce((n, c) => n + w.queueLen[c], 0);
    if (s.workers.length + queuedWorkers < desiredWorkers && s.gold >= UNITS[UnitType.Worker].cost && s.popUsed + 1 <= s.popCap) {
      const castle = s.castles.find((c) => w.queueLen[c] === 0);
      if (castle !== undefined) { out.push({ type: CommandType.Train, player: this.player, ids: [castle], v: UnitType.Worker }); s.gold -= 50; s.popUsed += 1; }
    }
  }

  // ------------------------------------------------------------ construction

  private findSpot(sim: Simulation, type: BuildingType, nx: number, ny: number, minR: number, maxR: number, gap = 1): { x: number; y: number } | null {
    const size = BUILDINGS[type].size;
    const path = sim.path;
    const cx0 = nx >> FP_SHIFT, cy0 = ny >> FP_SHIFT;
    for (let r = minR; r <= maxR; r++) {
      // walk the ring in a deterministic order starting from a seeded angle
      const cells: [number, number][] = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        cells.push([cx0 + dx - (size >> 1), cy0 + dy - (size >> 1)]);
      }
      const start = this.rng.nextInt(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const [cx, cy] = cells[(start + i) % cells.length];
        if (!canPlaceBuilding(sim, type, cx, cy, this.player)) continue;
        // leave walking gaps around other buildings
        let ok = true;
        for (let y = cy - gap; y < cy + size + gap && ok; y++) for (let x = cx - gap; x < cx + size + gap; x++) {
          if (x >= cx && x < cx + size && y >= cy && y < cy + size) continue;
          if (path.inBounds(x, y) && path.blocked[y * path.w + x] === 2) { ok = false; break; }
        }
        if (!ok) continue;
        // must not stand on a unit-crowded spot: fine, units are pushed out
        return { x: cx, y: cy };
      }
    }
    return null;
  }

  private builder(sim: Simulation, s: Snapshot, near: number, count = 1): number[] {
    const w = sim.world;
    const cands = s.workers.filter((id) => w.order[id] !== Order.Build && w.carry[id] < 8);
    cands.sort((a, b) => fpLen(w.x[a] - w.x[near], w.y[a] - w.y[near]) - fpLen(w.x[b] - w.x[near], w.y[b] - w.y[near]) || a - b);
    return cands.slice(0, count);
  }

  private construction(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    if (s.castles.length === 0 || s.workers.length === 0) return;
    if (sim.tick - this.lastBuildTick < 20) return;
    const main = s.castles[0];
    const anyConstructing = s.constructing.reduce((n, a) => n + a.length, 0);
    const tryBuild = (type: BuildingType, spot: { x: number; y: number } | null, workers: number) => {
      if (!spot) return false;
      const ids = this.builder(sim, s, main, workers);
      if (ids.length === 0) return false;
      out.push({ type: CommandType.Build, player: this.player, ids, v: type, x: fp(spot.x), y: fp(spot.y) });
      s.gold -= BUILDINGS[type].cost;
      this.lastBuildTick = sim.tick;
      return true;
    };

    // houses
    const popSoon = s.popUsed + 4 >= s.popCap;
    if (popSoon && s.popCap < MAX_POP && s.constructing[BuildingType.House].length === 0 && s.gold >= BUILDINGS[BuildingType.House].cost && sim.tick - this.lastHouseTick > 60) {
      if (tryBuild(BuildingType.House, this.findSpot(sim, BuildingType.House, w.x[main], w.y[main], 4, 9), 1)) { this.lastHouseTick = sim.tick; return; }
    }
    // barracks
    if (s.complete[BuildingType.Barracks].length === 0 && s.constructing[BuildingType.Barracks].length === 0 && s.workers.length >= 4 && s.gold >= BUILDINGS[BuildingType.Barracks].cost) {
      if (tryBuild(BuildingType.Barracks, this.findSpot(sim, BuildingType.Barracks, w.x[main], w.y[main], 4, 10), this.difficulty >= 1 ? 2 : 1)) return;
    }
    // second barracks on medium/hard when rich
    if (this.difficulty >= 1 && s.complete[BuildingType.Barracks].length === 1 && s.constructing[BuildingType.Barracks].length === 0 && s.gold >= 300 && s.workers.length >= 10) {
      if (tryBuild(BuildingType.Barracks, this.findSpot(sim, BuildingType.Barracks, w.x[main], w.y[main], 4, 11), 1)) return;
    }
    // forge
    if (s.complete[BuildingType.Barracks].length > 0 && s.complete[BuildingType.Forge].length === 0 && s.constructing[BuildingType.Forge].length === 0 && s.army.length >= 3 && s.gold >= BUILDINGS[BuildingType.Forge].cost + 50) {
      if (tryBuild(BuildingType.Forge, this.findSpot(sim, BuildingType.Forge, w.x[main], w.y[main], 4, 11), 1)) return;
    }
    // tower near the main mine
    if (this.profile.towers && s.complete[BuildingType.Barracks].length > 0 && s.complete[BuildingType.Tower].length + s.constructing[BuildingType.Tower].length < s.castles.length && s.gold >= 260 && s.army.length >= 4) {
      const mines = this.myMines(sim, s);
      if (mines.length > 0) {
        const m = mines[mines.length - 1];
        if (tryBuild(BuildingType.Tower, this.findSpot(sim, BuildingType.Tower, w.x[m], w.y[m], 3, 6), 1)) return;
      }
    }
    // expansion castle at a free mine
    if (this.profile.expand && anyConstructing === 0 && s.workers.length >= 9 && s.gold >= BUILDINGS[BuildingType.Castle].cost + 60) {
      const mines = this.myMines(sim, s);
      const totalGold = mines.reduce((g, m) => g + w.hp[m], 0);
      if (mines.length === 0 || totalGold < 3000 || (this.difficulty === 2 && s.castles.length < 2 && sim.tick > 20 * 60 * 4)) {
        const target = this.findExpansionMine(sim, s);
        if (target >= 0) {
          const spot = this.findSpot(sim, BuildingType.Castle, w.x[target], w.y[target], 3, 5);
          if (spot && tryBuild(BuildingType.Castle, spot, 2)) return;
        }
      }
    }
  }

  private findExpansionMine(sim: Simulation, s: Snapshot): number {
    const w = sim.world;
    const main = s.castles[0];
    let best = -1, bd = 0x7fffffff;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine || w.hp[id] < 2500) continue;
      // skip mines already next to one of my castles or close to known enemy buildings
      let mine = false;
      for (const c of s.castles) if (fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]) < fp(12)) mine = true;
      if (mine) continue;
      let enemyNear = false;
      for (const kb of this.known.values()) if (fpLen(kb.x - w.x[id], kb.y - w.y[id]) < fp(18)) enemyNear = true;
      if (enemyNear) continue;
      const d = fpLen(w.x[id] - w.x[main], w.y[id] - w.y[main]);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // ------------------------------------------------------------ production

  private desiredComposition(s: Snapshot): number[] {
    // counters: soldier beats archer, archer beats catapult, catapult beats soldier
    const eS = s.enemyByType[UnitType.Soldier] + s.enemyByType[UnitType.Militia];
    const eA = s.enemyByType[UnitType.Archer];
    const eC = s.enemyByType[UnitType.Catapult];
    const total = eS + eA + eC;
    let dS = 0.5, dA = 0.5, dC = 0;
    if (total >= 3) {
      const sS = eS / total, sA = eA / total, sC = eC / total;
      dS = 0.3 + 0.7 * sA;      // soldiers counter archers
      dA = 0.3 + 0.7 * sC;      // archers counter catapults
      dC = 0.05 + 0.7 * sS;     // catapults counter soldiers
      const sum = dS + dA + dC;
      dS /= sum; dA /= sum; dC /= sum;
    } else if (this.difficulty === 0) {
      dS = 0.65; dA = 0.35; dC = 0;
    }
    if (this.difficulty === 0) dC = Math.min(dC, 0.1);
    return [0, dS, dA, dC, 0];
  }

  private production(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    const desired = this.desiredComposition(s);
    const counts = [0, s.byType[1].length, s.byType[2].length, s.byType[3].length, 0];
    const total = counts[1] + counts[2] + counts[3] + 1;
    // reserve gold for pending buildings on higher difficulties
    let reserve = 0;
    if (s.complete[BuildingType.Barracks].length === 0) reserve = BUILDINGS[BuildingType.Barracks].cost;
    else if (s.popUsed + 4 >= s.popCap && s.popCap < MAX_POP) reserve = BUILDINGS[BuildingType.House].cost;

    // upgrades
    if (this.profile.upgrades && s.complete[BuildingType.Forge].length > 0) {
      const forge = s.complete[BuildingType.Forge][0];
      if (w.queueLen[forge] === 0 && s.gold > 320) {
        const p = sim.players[this.player];
        const order: UpgradeId[] = counts[1] >= counts[2]
          ? [UpgradeId.MeleeAttack, UpgradeId.Armor, UpgradeId.RangedAttack, UpgradeId.Gather, UpgradeId.MoveSpeed, UpgradeId.Range]
          : [UpgradeId.RangedAttack, UpgradeId.Range, UpgradeId.Armor, UpgradeId.Gather, UpgradeId.MeleeAttack, UpgradeId.MoveSpeed];
        for (const u of order) {
          if (p.upgrades[u] >= UPGRADES[u].levels) continue;
          const cost = upgradeCost(u, p.upgrades[u] + 1);
          if (s.gold - reserve >= cost + 80) { out.push({ type: CommandType.Research, player: this.player, ids: [forge], v: u }); s.gold -= cost; }
          break;
        }
      }
    }

    // army
    const producers: [number, UnitType][] = [];
    for (const b of s.complete[BuildingType.Barracks]) if (w.queueLen[b] < 2) { producers.push([b, UnitType.Soldier]); producers.push([b, UnitType.Archer]); }
    for (const f of s.complete[BuildingType.Forge]) if (w.queueLen[f] < 1) producers.push([f, UnitType.Catapult]);
    if (producers.length === 0) return;
    // pick the unit type with the largest deficit that we can afford
    const deficit = (t: UnitType) => desired[t] - counts[t] / total;
    const types = [UnitType.Soldier, UnitType.Archer, UnitType.Catapult].filter((t) => producers.some((p) => p[1] === t));
    types.sort((a, b) => deficit(b) - deficit(a) || a - b);
    for (const t of types) {
      const def = UNITS[t];
      if (s.gold - reserve < def.cost) continue;
      if (s.popUsed + def.pop > s.popCap) continue;
      const prod = producers.find((p) => p[1] === t)!;
      out.push({ type: CommandType.Train, player: this.player, ids: [prod[0]], v: t });
      s.gold -= def.cost; s.popUsed += def.pop; counts[t]++;
      // rally point for the producer: between castle and map centre
      if (!this.rallySet.has(prod[0]) && s.castles.length > 0) {
        const c = s.castles[0];
        const rx = w.x[c] + Math.floor((fp(sim.map.w / 2) - w.x[c]) * 0.22), ry = w.y[c] + Math.floor((fp(sim.map.h / 2) - w.y[c]) * 0.22);
        out.push({ type: CommandType.SetRally, player: this.player, ids: [prod[0]], x: rx, y: ry });
        this.rallySet.add(prod[0]);
      }
      break;
    }
  }

  // ------------------------------------------------------------ military

  private armyValue(sim: Simulation, s: Snapshot): number {
    return s.army.reduce((v, id) => v + UNITS[sim.world.type[id] as UnitType].cost, 0);
  }

  private rallyPoint(sim: Simulation, s: Snapshot): { x: number; y: number } {
    const w = sim.world;
    const c = s.castles[0];
    return { x: w.x[c] + Math.floor((fp(sim.map.w / 2) - w.x[c]) * 0.22), y: w.y[c] + Math.floor((fp(sim.map.h / 2) - w.y[c]) * 0.22) };
  }

  private military(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    if (s.castles.length === 0) return;
    const armyPop = s.army.reduce((n, id) => n + UNITS[w.type[id] as UnitType].pop, 0);

    // defence has priority
    if (this.threatPos) {
      const defenders = s.army.filter((id) => !this.fleeing.has(id));
      if (defenders.length > 0 && sim.tick % (this.profile.reactionTicks * 2) < this.profile.thinkInterval) {
        out.push({ type: CommandType.AttackMove, player: this.player, ids: defenders, x: this.threatPos.x, y: this.threatPos.y });
      }
      // militia when outnumbered near a castle
      const attackers = s.enemyUnits.filter((e) => w.type[e] !== UnitType.Worker).length;
      if (attackers > defenders.length && sim.tick - this.lastMilitia > ABILITIES[AbilityId.Militia].cooldown) {
        for (const c of s.castles) {
          if (w.abilityCd[c] > 0) continue;
          const near = s.enemyUnits.some((e) => fpLen(w.x[e] - w.x[c], w.y[e] - w.y[c]) < fp(12));
          if (near) { out.push({ type: CommandType.Ability, player: this.player, ids: [c], v: AbilityId.Militia }); this.lastMilitia = sim.tick; break; }
        }
      }
      // workers flee when the enemy army is at the mine (medium/hard)
      if (this.profile.micro) {
        const flee: number[] = [];
        for (const wk of s.workers) {
          if (this.fleeing.has(wk)) continue;
          const danger = s.enemyUnits.some((e) => w.type[e] !== UnitType.Worker && fpLen(w.x[e] - w.x[wk], w.y[e] - w.y[wk]) < fp(4.5));
          if (danger) flee.push(wk);
        }
        if (flee.length > 0 && defenders.length < 3) {
          const c = s.castles[0];
          out.push({ type: CommandType.Move, player: this.player, ids: flee, x: w.x[c] - fp(3), y: w.y[c] - fp(3) });
          for (const f of flee) this.fleeing.set(f, sim.tick + 20 * 12);
        }
      }
      this.attacking = false;
      return;
    }
    // fleeing workers return to work
    for (const [id, until] of this.fleeing) {
      if (sim.tick >= until || !w.alive[id]) { this.fleeing.delete(id); if (w.alive[id] && w.kind[id] === Kind.Unit && w.type[id] === UnitType.Worker && w.order[id] !== Order.Gather) out.push({ type: CommandType.Stop, player: this.player, ids: [id] }); }
    }

    const threshold = this.profile.attackPop + this.attackWave * this.profile.attackPopGrowth;
    if (!this.attacking) {
      if (armyPop >= Math.min(threshold, 56) && s.army.length >= 4) {
        const target = this.pickAttackTarget(sim, s);
        if (target) {
          this.attacking = true; this.attackTarget = target; this.attackStartValue = this.armyValue(sim, s);
          out.push({ type: CommandType.AttackMove, player: this.player, ids: s.army.filter((id) => !this.fleeing.has(id)), x: target.x, y: target.y });
        }
      } else if (sim.tick % 200 < this.profile.thinkInterval) {
        // keep idle army gathered at the rally point
        const rp = this.rallyPoint(sim, s);
        const idle = s.army.filter((id) => w.order[id] === Order.None && fpLen(w.x[id] - rp.x, w.y[id] - rp.y) > fp(6) && !this.fleeing.has(id));
        if (idle.length > 0) out.push({ type: CommandType.AttackMove, player: this.player, ids: idle, x: rp.x, y: rp.y });
      }
      return;
    }
    // attacking: retreat if the wave collapsed, re-target when the target is gone
    const value = this.armyValue(sim, s);
    if (this.profile.retreatHpPct > 0 && value < this.attackStartValue * 0.4) {
      const rp = this.rallyPoint(sim, s);
      out.push({ type: CommandType.Move, player: this.player, ids: s.army, x: rp.x, y: rp.y });
      this.attacking = false; this.attackWave++;
      return;
    }
    const idle = s.army.filter((id) => w.order[id] === Order.None);
    if (idle.length >= Math.max(2, s.army.length >> 1) || sim.tick % 300 < this.profile.thinkInterval) {
      const target = this.pickAttackTarget(sim, s);
      if (!target) { this.attacking = false; this.attackWave++; return; }
      this.attackTarget = target;
      out.push({ type: CommandType.AttackMove, player: this.player, ids: s.army, x: target.x, y: target.y });
    }
  }

  private pickAttackTarget(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const w = sim.world;
    const main = s.castles[0];
    // visible enemy army first (if not too far from us), then known buildings (castles preferred), then enemy start positions
    let best: { x: number; y: number } | null = null, bd = 0x7fffffff;
    for (const kb of this.known.values()) {
      if (!sim.players[kb.owner].alive) continue;
      const d = fpLen(kb.x - w.x[main], kb.y - w.y[main]) - (kb.type === BuildingType.Castle ? fp(8) : 0);
      if (d < bd) { bd = d; best = { x: kb.x, y: kb.y }; }
    }
    if (best) return best;
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (!p.alive || sim.sameTeam(this.player, i)) continue;
      const pos = { x: fp(p.startX + 0.5), y: fp(p.startY + 0.5) };
      const explored = sim.fog.isExplored(this.player, pos.x, pos.y) && !this.known.size;
      const d = fpLen(pos.x - w.x[main], pos.y - w.y[main]) + (explored ? fp(100) : 0);
      if (d < bd) { bd = d; best = pos; }
    }
    return best;
  }

  // ------------------------------------------------------------ micro

  private micro(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    if (s.enemyUnits.length === 0) { this.kiting.clear(); return; }
    const rp = s.castles.length ? this.rallyPoint(sim, s) : null;
    let budget = 4;
    const nearestEnemy = (id: number, pred: (e: number) => boolean, maxD: number) => {
      let best = -1, bd = maxD;
      for (const e of s.enemyUnits) {
        if (!pred(e)) continue;
        const d = fpLen(w.x[e] - w.x[id], w.y[e] - w.y[id]);
        if (d < bd) { bd = d; best = e; }
      }
      return best;
    };
    const awayFrom = (id: number, e: number, dist: number) => {
      const dx = w.x[id] - w.x[e], dy = w.y[id] - w.y[e];
      const l = fpLen(dx, dy) || 1;
      let x = w.x[id] + Math.floor((dx * dist) / l), y = w.y[id] + Math.floor((dy * dist) / l);
      const lim = fp(2), maxX = fp(sim.map.w - 2), maxY = fp(sim.map.h - 2);
      if (x < lim) x = lim; if (y < lim) y = lim; if (x > maxX) x = maxX; if (y > maxY) y = maxY;
      return { x, y };
    };
    const isMelee = (e: number) => w.type[e] === UnitType.Soldier || w.type[e] === UnitType.Militia;

    // wounded retreat
    if (this.profile.retreatHpPct > 0 && rp) {
      const wounded = s.army.filter((id) => w.hp[id] * 100 < w.maxHp[id] * this.profile.retreatHpPct && !this.fleeing.has(id) && nearestEnemy(id, () => true, fp(7)) >= 0);
      if (wounded.length > 0 && budget > 0) {
        out.push({ type: CommandType.Move, player: this.player, ids: wounded, x: rp.x, y: rp.y });
        for (const id of wounded) this.fleeing.set(id, sim.tick + 20 * 25);
        budget--;
      }
    }
    // archers kite melee
    const kiters: number[] = [];
    let kiteFrom = -1;
    for (const a of s.byType[UnitType.Archer]) {
      if (this.fleeing.has(a)) continue;
      const e = nearestEnemy(a, isMelee, fp(1.8));
      if (e >= 0 && w.hp[a] > 0) { kiters.push(a); kiteFrom = e; }
    }
    if (kiters.length > 0 && kiteFrom >= 0 && budget > 0) {
      const p = awayFrom(kiters[0], kiteFrom, fp(3));
      out.push({ type: CommandType.Move, player: this.player, ids: kiters, x: p.x, y: p.y });
      for (const k of kiters) this.kiting.set(k, sim.tick);
      budget--;
    }
    // kiting archers resume fighting once clear
    const resume = s.byType[UnitType.Archer].filter((a) => this.kiting.has(a) && !kiters.includes(a) && w.order[a] !== Order.AttackMove);
    if (resume.length > 0 && budget > 0) {
      const e = nearestEnemy(resume[0], () => true, fp(12));
      if (e >= 0) out.push({ type: CommandType.AttackMove, player: this.player, ids: resume, x: w.x[e], y: w.y[e] });
      for (const a of resume) this.kiting.delete(a);
      budget--;
    }
    // catapults keep min range and use incendiary on clumps
    for (const c of s.byType[UnitType.Catapult]) {
      if (budget <= 0) break;
      const e = nearestEnemy(c, (x) => w.type[x] !== UnitType.Worker, fp(2.4));
      if (e >= 0) { const p = awayFrom(c, e, fp(3.5)); out.push({ type: CommandType.Move, player: this.player, ids: [c], x: p.x, y: p.y }); budget--; continue; }
      if (w.abilityCd[c] === 0) {
        const clump = this.findClump(sim, s, w.x[c], w.y[c], fp(ABILITIES[AbilityId.Incendiary].range), fp(2), 3);
        if (clump) { out.push({ type: CommandType.Ability, player: this.player, ids: [c], v: AbilityId.Incendiary, x: clump.x, y: clump.y }); budget--; }
      }
    }
    // archers volley on clumps or catapults
    const readyArchers = s.byType[UnitType.Archer].filter((a) => w.abilityCd[a] === 0 && w.order[a] !== Order.Move);
    if (readyArchers.length > 0 && budget > 0) {
      const a = readyArchers[0];
      const range = fp(ABILITIES[AbilityId.Volley].range + sim.players[this.player].upgrades[UpgradeId.Range]);
      const cat = nearestEnemy(a, (e) => w.type[e] === UnitType.Catapult, range);
      const clump = cat >= 0 ? { x: w.x[cat], y: w.y[cat] } : this.findClump(sim, s, w.x[a], w.y[a], range, fp(1.5), 3);
      if (clump) {
        const ids = readyArchers.filter((x) => fpLen(w.x[x] - clump.x, w.y[x] - clump.y) <= range);
        if (ids.length) { out.push({ type: CommandType.Ability, player: this.player, ids, v: AbilityId.Volley, x: clump.x, y: clump.y }); budget--; }
      }
    }
    // soldiers shield stance when engaged
    const soldiers = s.byType[UnitType.Soldier].filter((sid) => w.abilityCd[sid] === 0 && w.buff[sid] === 0 && nearestEnemy(sid, (e) => w.type[e] !== UnitType.Worker, fp(4)) >= 0);
    if (soldiers.length >= 2 && budget > 0) {
      const enemiesNear = s.enemyUnits.filter((e) => w.type[e] !== UnitType.Worker && fpLen(w.x[e] - w.x[soldiers[0]], w.y[e] - w.y[soldiers[0]]) < fp(6)).length;
      const cat = s.enemyByType[UnitType.Catapult] > 0;
      if (cat || enemiesNear >= 3) { out.push({ type: CommandType.Ability, player: this.player, ids: soldiers, v: AbilityId.ShieldStance }); budget--; }
    }
  }

  private findClump(sim: Simulation, s: Snapshot, x: number, y: number, range: number, radius: number, min: number): { x: number; y: number } | null {
    const w = sim.world;
    let best: { x: number; y: number } | null = null, bestN = min - 1;
    for (const e of s.enemyUnits) {
      if (w.type[e] === UnitType.Worker) continue;
      if (fpLen(w.x[e] - x, w.y[e] - y) > range) continue;
      let n = 0;
      for (const o of s.enemyUnits) if (fpLen(w.x[o] - w.x[e], w.y[o] - w.y[e]) <= radius) n++;
      if (n > bestN) { bestN = n; best = { x: w.x[e], y: w.y[e] }; }
    }
    return best;
  }

  // ------------------------------------------------------------ scouting

  private scouting(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    if (s.castles.length === 0) return;
    if (this.scoutUnit >= 0 && (!w.alive[this.scoutUnit] || w.owner[this.scoutUnit] !== this.player)) this.scoutUnit = -1;
    const interval = this.difficulty === 2 ? 20 * 75 : 20 * 120;
    if (sim.tick - this.lastScoutTick < interval) return;
    if (sim.tick < 20 * 90) return;
    // prefer a soldier, otherwise a worker
    let scout = s.byType[UnitType.Soldier].find((id) => w.order[id] === Order.None) ?? -1;
    if (scout < 0 && s.workers.length > 6) scout = s.workers[s.workers.length - 1];
    if (scout < 0) return;
    this.scoutUnit = scout;
    this.lastScoutTick = sim.tick;
    // visit enemy starts then expansions, queued
    const targets: { x: number; y: number }[] = [];
    for (let i = 0; i < sim.players.length; i++) {
      const ep = sim.players[i];
      if (!ep.alive || sim.sameTeam(this.player, i)) continue;
      targets.push({ x: fp(ep.startX + 0.5), y: fp(ep.startY + 0.5) });
    }
    const main = s.castles[0];
    const exp: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Mine && fpLen(w.x[id] - w.x[main], w.y[id] - w.y[main]) > fp(14)) exp.push(id);
    exp.sort((a, b) => fpLen(w.x[a] - w.x[main], w.y[a] - w.y[main]) - fpLen(w.x[b] - w.x[main], w.y[b] - w.y[main]));
    for (const m of exp.slice(0, 2)) targets.push({ x: w.x[m] + fp(2.5), y: w.y[m] });
    let first = true;
    for (const t of targets) {
      out.push({ type: CommandType.Move, player: this.player, ids: [scout], x: t.x, y: t.y, queue: !first });
      first = false;
    }
    // come back home
    out.push({ type: CommandType.Move, player: this.player, ids: [scout], x: w.x[main] + fp(3), y: w.y[main], queue: true });
  }
}

export function createBots(sim: Simulation): Bot[] {
  const bots: Bot[] = [];
  for (const p of sim.setup.players) if (p.isBot) bots.push(new Bot(p.slot, (p.difficulty ?? 1) as Difficulty, sim.setup.seed));
  return bots;
}

export const _fmt = toFloat;
