import {
  MINE_CAPACITY, TOWER_CAPACITY,
  AGE_COUNT, AGE_UP, maxUpgradeLevel,
  ABILITIES, AbilityId, BUILDING_TYPE_COUNT, BUILDINGS, BuildingState, BuildingType, Command, CommandType, FP_SHIFT, Kind,
  Order, Rng, Simulation, UNITS, UNIT_TYPE_COUNT, UnitType, UpgradeId, canPlaceBuilding, fp, fpLen, toFloat,
  upgradeCost, UPGRADES, MAX_POP,
} from '@rookfall/sim';

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

/**
 * How many diggers the bot is willing to put on one vein before it starts sending the rest to another
 * deposit. The vein itself takes any number; this is only the point past which spreading out shortens
 * more walks than it lengthens.
 */
const MINE_CROWD = 8;
/**
 * How many workers one vein is worth hiring for. Higher than MINE_CROWD because a crowded deposit is a
 * longer queue of walkers, not a closed door - the marginal digger is worth less, never nothing.
 */
const WORKERS_PER_VEIN = 10;

const PROFILES: Record<Difficulty, Profile> = {
  0: { thinkInterval: 30, apm: 3, maxWorkers: 10, attackPop: 18, attackPopGrowth: 4, micro: false, expand: false, upgrades: false, scout: false, towers: false, retreatHpPct: 0, reactionTicks: 60 },
  1: { thinkInterval: 15, apm: 6, maxWorkers: 16, attackPop: 22, attackPopGrowth: 4, micro: true, expand: true, upgrades: true, scout: true, towers: true, retreatHpPct: 25, reactionTicks: 30 },
  2: { thinkInterval: 8, apm: 12, maxWorkers: 22, attackPop: 20, attackPopGrowth: 6, micro: true, expand: true, upgrades: true, scout: true, towers: true, retreatHpPct: 30, reactionTicks: 10 },
};

/** ticks in a minute of match time */
const MINUTE = 20 * 60;

/**
 * What a bot is playing *for*. The difficulty says how well it plays - how often it thinks, how many orders it
 * gets out, whether it micros at all. The strategy says what it does with that skill, and it is rolled per bot
 * from the match seed, so two medium bots in the same game open differently and end up with bases that read
 * differently from across the map: a rusher with two barracks and nothing behind them, a turtle inside a fence
 * ring with towers beside its gates.
 */
export enum Strategy {
  /** barracks first, walks out with the first handful of men and keeps coming */
  Rush = 0,
  /** workers, its own mine and a second castle first; leaves home late and with everything */
  Boom = 1,
  /** fences the base in, mans the towers when pressed, and only marches once the wall stands */
  Fortify = 2,
  /** forge before the second barracks: rams early, catapults later, and it aims at masonry */
  Siege = 3,
}

export const STRATEGY_NAMES: Record<Strategy, string> = {
  [Strategy.Rush]: 'rush', [Strategy.Boom]: 'boom', [Strategy.Fortify]: 'fortify', [Strategy.Siege]: 'siege',
};

interface Plan {
  /** percent of the difficulty's attack threshold: 60 walks out on half an army, 150 sits on a big one */
  attackPopPct: number;
  /** percent of the difficulty's per-wave growth: how much bigger the next wave has to be after a beating */
  wavePct: number;
  /** percent of the difficulty's worker target */
  workerPct: number;
  /** workers on gold before the first barracks goes down */
  barracksWorkers: number;
  /** gold in hand before a second barracks: an aggressive opening wants the second one much sooner */
  barracks2Gold: number;
  /** watchtowers it wants standing */
  towers: number;
  /** ring the base with a fence, and man the towers when the enemy reaches it */
  wall: boolean;
  /** dig its own mine before it spends on a second barracks or a forge */
  mineFirst: boolean;
  /** the forge comes before the second barracks, and rams come with the first wave */
  siegeFirst: boolean;
  /** first tick it will even consider a second castle */
  expandAfter: number;
  /** first tick it starts holding gold back for the second age (catapults, cavalry, stone walls) */
  ageAfter: number;
  /** the age is bought before a second castle, not after it - a catapult plan is nothing in the wooden age */
  ageFirst: boolean;
  /** from this tick the plan stops holding it home - no strategy is an excuse to never attack */
  pushAfter: number;
  /** where the idle army waits, in percent of the way from the castle to the map centre */
  rallyPct: number;
  /** percent weights on the counter-pick shares: soldier, archer, catapult, cavalry */
  mixPct: [number, number, number, number];
}

const PLANS: Record<Strategy, Plan> = {
  [Strategy.Rush]: {
    attackPopPct: 65, wavePct: 180, workerPct: 85, barracksWorkers: 4, barracks2Gold: 180, towers: 0, wall: false, mineFirst: false, siegeFirst: false,
    expandAfter: 7 * MINUTE, ageAfter: 10 * MINUTE, ageFirst: false, pushAfter: 0, rallyPct: 32, mixPct: [130, 90, 40, 120],
  },
  [Strategy.Boom]: {
    attackPopPct: 130, wavePct: 100, workerPct: 115, barracksWorkers: 6, barracks2Gold: 300, towers: 1, wall: false, mineFirst: true, siegeFirst: false,
    expandAfter: 4 * MINUTE, ageAfter: 6 * MINUTE, ageFirst: false, pushAfter: 9 * MINUTE, rallyPct: 22, mixPct: [100, 100, 100, 100],
  },
  [Strategy.Fortify]: {
    attackPopPct: 130, wavePct: 100, workerPct: 120, barracksWorkers: 5, barracks2Gold: 300, towers: 3, wall: true, mineFirst: true, siegeFirst: false,
    expandAfter: 6 * MINUTE, ageAfter: 7 * MINUTE, ageFirst: false, pushAfter: 10 * MINUTE, rallyPct: 6, mixPct: [105, 130, 120, 60],
  },
  [Strategy.Siege]: {
    attackPopPct: 120, wavePct: 130, workerPct: 110, barracksWorkers: 5, barracks2Gold: 300, towers: 1, wall: false, mineFirst: false, siegeFirst: true,
    expandAfter: 8 * MINUTE, ageAfter: 4 * MINUTE, ageFirst: true, pushAfter: 7 * MINUTE, rallyPct: 22, mixPct: [100, 90, 170, 90],
  },
};

/**
 * Which plans a difficulty may roll, with repeats for weight. The easy bot has no towers, no expansion and no
 * upgrades in its profile, so the only two plans it could actually carry out are the two simple ones; from
 * medium up every plan is on the table.
 */
const STRATEGY_POOL: Record<Difficulty, Strategy[]> = {
  0: [Strategy.Rush, Strategy.Rush, Strategy.Boom],
  1: [Strategy.Rush, Strategy.Rush, Strategy.Boom, Strategy.Boom, Strategy.Fortify, Strategy.Fortify, Strategy.Siege, Strategy.Siege],
  2: [Strategy.Rush, Strategy.Boom, Strategy.Boom, Strategy.Fortify, Strategy.Fortify, Strategy.Siege],
};

/** the fence starts only once there is an army to stand behind it and gold that the army is not waiting on */
const WALL_GOLD_FLOOR = 260;
/** fence sections kept under construction at once: a stretch long enough to read, short enough to finish */
const WALL_SITES = 3;
/** ticks between two fence orders */
const WALL_INTERVAL = 60;
/** once the ring stands, it is walked again this often, so a breach gets rebuilt */
const WALL_RESCAN = 45 * 20;
/** cells of clear ground the ring leaves around the outermost building */
const WALL_MARGIN_MIN = 3, WALL_MARGIN_MAX = 6;
/** half-width limits of the ring: tighter and the base outgrows it, wider and it never gets finished */
const WALL_HALF_MIN = 8, WALL_HALF_MAX = 12;
/**
 * Gold the barracks leave alone while the bot is saving for something (see Bot.savingFor). Without a reserve the
 * queues spend every coin the tick it lands, and the 450 for a second castle or the 500 for the second age never
 * pile up at all: the bots stayed on one base, in the wooden age, with no catapults, cavalry or stone walls
 * outside the rare quiet game. The fence asks for much less than the two big purchases - it is bought a section
 * at a time, and a turtle that stops making soldiers to finish a wall has missed the point of the wall.
 */
const RESERVE = { castle: 280, wall: 60, age: 260 };

interface Rect { x0: number; y0: number; x1: number; y1: number }

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
  /** what this bot is playing for; rolled from the match seed unless the caller pinned one */
  readonly strategy: Strategy;
  readonly plan: Plan;
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
  /** the rectangle the fence follows, and the ring cells in build order (see planWall) */
  private wallRect: Rect | null = null;
  private wallRing: number[] = [];
  private wallIdx = 0;
  private wallComplete = false;
  private wallScanTick = -100000;
  private lastWallTick = -100000;
  /** towers a worker crew was sent into, so they are let back out once it is quiet */
  private manned = new Set<number>();

  constructor(player: number, difficulty: Difficulty, seed: number, strategy?: Strategy) {
    this.player = player;
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
    this.rng = new Rng((seed ^ (player * 0x9e3779b9)) | 0);
    const pool = STRATEGY_POOL[difficulty];
    this.strategy = strategy ?? pool[this.rng.nextInt(pool.length)];
    this.plan = PLANS[this.strategy];
    this.nextThink = 20 + player * 3;
  }

  /** Call once per tick; returns commands (possibly empty). */
  think(sim: Simulation): Command[] {
    if (sim.tick < this.nextThink || sim.gameOver) return [];
    const p = sim.players[this.player];
    if (!p.alive) return [];
    this.nextThink = sim.tick + this.profile.thinkInterval;
    const out: Command[] = [];
    // A fence line is one gesture for a player - press, drag, release - and comes out of the sim as one Build
    // per cell queued on a single worker. It is kept out of the APM budget for the same reason: charging a
    // turtle four orders a section would mean it could never lay a wall and fight in the same minute.
    const fence: Command[] = [];
    const snap = this.snapshot(sim);
    this.updateKnowledge(sim, snap);
    this.detectThreat(sim, snap);
    this.economy(sim, snap, out);
    this.construction(sim, snap, out);
    this.fortify(sim, snap, fence);
    this.production(sim, snap, out);
    this.military(sim, snap, out);
    if (this.profile.micro) this.micro(sim, snap, out);
    if (this.profile.scout) this.scouting(sim, snap, out);
    // APM cap: keep the first N commands (they're roughly priority-ordered)
    if (out.length > this.profile.apm) out.length = this.profile.apm;
    for (const c of fence) out.push(c);
    return out;
  }

  /**
   * The sim only forces a one-cell lane between buildings, and catapults do not fit through one. A bot
   * that packs its base that tightly walls its own siege engines in, so it keeps two cells clear of any
   * other non-fence building (a fence is meant to close gaps).
   */
  private catapultLane(sim: Simulation, type: BuildingType, cx: number, cy: number): boolean {
    if (type === BuildingType.Wall) return true;
    const w = sim.world, size = BUILDINGS[type].size, gap = 1;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Building || w.type[id] === BuildingType.Wall) continue;
      const [bx, by] = sim.footprintTopLeft(id);
      const bs = w.size[id];
      if (cx < bx + bs + gap && cx + size > bx - gap && cy < by + bs + gap && cy + size > by - gap) return false;
    }
    return true;
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
    // idle workers first fill our own mines (passive gold), then go to the least crowded vein
    const roomy = s.complete[BuildingType.Mine].filter((m) => w.carry[m] < MINE_CAPACITY);
    if (s.idleWorkers.length > 0 && roomy.length > 0) {
      const m = roomy[0];
      const n = Math.min(MINE_CAPACITY - w.carry[m], s.idleWorkers.length);
      out.push({ type: CommandType.Garrison, player: this.player, ids: s.idleWorkers.slice(0, n), target: m });
      s.idleWorkers = s.idleWorkers.slice(n);
    }
    if (s.idleWorkers.length > 0 && mines.length > 0) {
      let bestMine = -1, bestN = 1e9;
      for (const m of mines) { const n = this.mineWorkerCount(sim, m); if (n < bestN) { bestN = n; bestMine = m; } }
      if (bestMine >= 0) out.push({ type: CommandType.Gather, player: this.player, ids: s.idleWorkers.slice(0, 6), target: bestMine });
    }
    // rebalance: if a mine is over capacity, move extras
    if (mines.length > 1 && sim.tick % 100 < this.profile.thinkInterval) {
      for (const m of mines) {
        const n = this.mineWorkerCount(sim, m);
        if (n <= MINE_CROWD) continue;
        const other = mines.find((o) => o !== m && this.mineWorkerCount(sim, o) < MINE_CROWD - 1);
        const extras: number[] = [];
        for (const wk of s.workers) if (w.orderTarget[wk] === m && w.order[wk] === Order.Gather) { extras.push(wk); if (extras.length >= n - MINE_CROWD) break; }
        if (other !== undefined) { if (extras.length) out.push({ type: CommandType.Gather, player: this.player, ids: extras, target: other }); }
        else if (roomy.length > 0 && extras.length) out.push({ type: CommandType.Garrison, player: this.player, ids: extras.slice(0, MINE_CAPACITY - w.carry[roomy[0]]), target: roomy[0] });
        break;
      }
    }
    // train workers
    // workers inside our mines are released entities, so they are counted through the mines themselves
    const garrisoned = s.complete[BuildingType.Mine].reduce((n, m) => n + w.carry[m], 0);
    // an opening that traded diggers for men has to stop trading at some point: past the eighth minute
    // every plan wants at least the worker line its difficulty would have run on its own
    const pct = sim.tick > 8 * MINUTE ? Math.max(this.plan.workerPct, 100) : this.plan.workerPct;
    const maxWorkers = ((this.profile.maxWorkers * pct) / 100) | 0;
    const desiredWorkers = Math.min(maxWorkers, Math.max(6, mines.length * WORKERS_PER_VEIN) + s.complete[BuildingType.Mine].length * MINE_CAPACITY);
    const queuedWorkers = s.castles.reduce((n, c) => n + w.queueLen[c], 0);
    if (s.workers.length + garrisoned + queuedWorkers < desiredWorkers && s.gold >= UNITS[UnitType.Worker].cost && s.popUsed + 1 <= s.popCap) {
      const castle = s.castles.find((c) => w.queueLen[c] === 0);
      if (castle !== undefined) { out.push({ type: CommandType.Train, player: this.player, ids: [castle], v: UnitType.Worker }); s.gold -= 50; s.popUsed += 1; }
    }
  }

  // ------------------------------------------------------------ construction

  /**
   * Once a bot has drawn its ring, everything but a new castle goes up inside it, one cell clear of the fence
   * line: a base that spills over its own wall is the one thing that would make the wall pointless. If nothing
   * fits in there any more, it builds outside rather than not at all.
   */
  private findSpot(sim: Simulation, type: BuildingType, nx: number, ny: number, minR: number, maxR: number, gap = 1): { x: number; y: number } | null {
    const ring = this.plan.wall && type !== BuildingType.Castle ? this.wallRect : null;
    return (ring && this.searchSpot(sim, type, nx, ny, minR, maxR, gap, ring)) || this.searchSpot(sim, type, nx, ny, minR, maxR, gap, null);
  }

  private searchSpot(sim: Simulation, type: BuildingType, nx: number, ny: number, minR: number, maxR: number, gap: number, ring: Rect | null): { x: number; y: number } | null {
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
        if (ring && (cx <= ring.x0 || cy <= ring.y0 || cx + size > ring.x1 || cy + size > ring.y1)) continue;
        if (!canPlaceBuilding(sim, type, cx, cy, this.player)) continue;
        if (!this.catapultLane(sim, type, cx, cy)) continue;
        // leave walking gaps around other buildings
        let ok = true;
        for (let y = cy - gap; y < cy + size + gap && ok; y++) for (let x = cx - gap; x < cx + size + gap; x++) {
          if (x >= cx && x < cx + size && y >= cy && y < cy + size) continue;
          if (path.isFootprint(x, y)) { ok = false; break; }
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
    const plan = this.plan;
    // a fence line is always under construction somewhere, so it must not count as "the base is busy"
    const anyConstructing = s.constructing.reduce((n, a, t) => n + (t === BuildingType.Wall ? 0 : a.length), 0);
    const have = (t: BuildingType) => s.complete[t].length + s.constructing[t].length;
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
    // barracks - every plan builds it first, they only differ on how much gold is on legs by then
    if (have(BuildingType.Barracks) === 0 && s.workers.length >= plan.barracksWorkers && s.gold >= BUILDINGS[BuildingType.Barracks].cost) {
      if (tryBuild(BuildingType.Barracks, this.findSpot(sim, BuildingType.Barracks, w.x[main], w.y[main], 4, 10), this.difficulty >= 1 ? 2 : 1)) return;
    }
    // the siege plan pays for the forge before a second barracks: rams are what it opens with
    if (plan.siegeFirst && have(BuildingType.Forge) === 0 && s.complete[BuildingType.Barracks].length > 0 && s.workers.length >= 7 && s.gold >= BUILDINGS[BuildingType.Forge].cost) {
      if (tryBuild(BuildingType.Forge, this.findSpot(sim, BuildingType.Forge, w.x[main], w.y[main], 4, 11), 1)) return;
    }
    // the boom plan digs its own mine early - it is the whole point of playing greedy
    if (this.difficulty >= 1 && plan.mineFirst && have(BuildingType.Mine) < 1 && s.workers.length >= 8 && s.gold >= BUILDINGS[BuildingType.Mine].cost + 80) {
      if (tryBuild(BuildingType.Mine, this.findSpot(sim, BuildingType.Mine, w.x[main], w.y[main], 4, 9), 1)) return;
    }
    // second barracks when rich (the siege plan pays for its forge first and only then comes back to this)
    if (this.difficulty >= 1 && (!plan.siegeFirst || s.complete[BuildingType.Forge].length > 0)
      && s.complete[BuildingType.Barracks].length === 1 && s.constructing[BuildingType.Barracks].length === 0
      && s.gold >= plan.barracks2Gold && s.workers.length >= (plan.barracks2Gold < 300 ? 6 : 8)) {
      if (tryBuild(BuildingType.Barracks, this.findSpot(sim, BuildingType.Barracks, w.x[main], w.y[main], 4, 11), 1)) return;
    }
    // forge
    if (s.complete[BuildingType.Barracks].length > 0 && have(BuildingType.Forge) === 0 && s.army.length >= 3 && s.gold >= BUILDINGS[BuildingType.Forge].cost + 50) {
      if (tryBuild(BuildingType.Forge, this.findSpot(sim, BuildingType.Forge, w.x[main], w.y[main], 4, 11), 1)) return;
    }
    // a mine of our own next to the castle: three workers inside give steady gold without walking
    if (this.difficulty >= 1 && have(BuildingType.Mine) < 1
      && s.complete[BuildingType.Forge].length > 0 && s.workers.length >= 6 && s.gold >= BUILDINGS[BuildingType.Mine].cost + 100) {
      if (tryBuild(BuildingType.Mine, this.findSpot(sim, BuildingType.Mine, w.x[main], w.y[main], 4, 9), 1)) return;
    }
    // The ring is drawn as soon as there is a base worth walling - before the first tower is sited and before
    // the forge picks its spot, because from here on everything this bot builds has to fit inside it.
    if (plan.wall && this.profile.towers && !this.wallRect && s.complete[BuildingType.Barracks].length > 0 && s.workers.length >= 8) {
      this.planWall(sim, s);
    }
    // Watchtowers: the first guards the vein the bot works, the rest stand beside the gates of the wall - and
    // they keep pace with it, so the wall is what goes up first and the towers read as part of it.
    const towerCap = plan.wall ? 1 + Math.min(plan.towers - 1, (s.complete[BuildingType.Wall].length / 10) | 0) : plan.towers;
    if (this.profile.towers && towerCap > 0 && s.complete[BuildingType.Barracks].length > 0
      && have(BuildingType.Tower) < towerCap && s.gold >= BUILDINGS[BuildingType.Tower].cost + 160 && s.army.length >= 3) {
      const onWall = plan.wall && have(BuildingType.Tower) > 0 ? this.wallTowerSpot(sim, s) : null;
      if (tryBuild(BuildingType.Tower, onWall ?? this.mineTowerSpot(sim, s), 1)) return;
    }
    // expansion castle at a free mine
    if (this.profile.expand && sim.tick >= plan.expandAfter && anyConstructing === 0 && s.workers.length >= 9 && s.gold >= BUILDINGS[BuildingType.Castle].cost + 60) {
      const mines = this.myMines(sim, s);
      const totalGold = mines.reduce((g, m) => g + w.hp[m], 0);
      if (mines.length === 0 || totalGold < 3000 || s.castles.length < 2) {
        const target = this.findExpansionMine(sim, s);
        if (target >= 0) {
          const spot = this.findSpot(sim, BuildingType.Castle, w.x[target], w.y[target], 3, 5);
          if (spot && tryBuild(BuildingType.Castle, spot, 2)) return;
        }
      }
    }
  }

  /** the outermost vein the bot works, which is the one a lone watchtower is worth putting over */
  private mineTowerSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const mines = this.myMines(sim, s);
    if (mines.length === 0) return null;
    const m = mines[mines.length - 1];
    return this.findSpot(sim, BuildingType.Tower, sim.world.x[m], sim.world.y[m], 3, 6);
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

  // ------------------------------------------------------------ fortification

  /**
   * The one thing the bot is putting gold aside for right now. It saves for one at a time and in this order,
   * because saving for two meant getting neither: the fence would spend what the castle was waiting on, and a
   * bot that walled its one base while the other took a second one lost the game it was defending.
   */
  private savingFor(sim: Simulation, s: Snapshot): keyof typeof RESERVE | null {
    const p = sim.players[this.player], plan = this.plan;
    const age = this.difficulty >= 1 && p.age < AGE_COUNT - 1 && sim.tick >= plan.ageAfter && s.complete[BuildingType.Forge].length > 0;
    if (age && plan.ageFirst) return 'age'; // a catapult plan in the wooden age is not a plan
    if (this.profile.expand && s.castles.length < 2 && s.workers.length >= 9 && sim.tick >= plan.expandAfter
      && this.findExpansionMine(sim, s) >= 0) return 'castle';
    if (plan.wall && !this.wallComplete && this.wallRing.length > 0) return 'wall';
    return age ? 'age' : null;
  }

  /** the cell of the nearest living enemy's start position - the direction the wall has to face */
  private enemyDir(sim: Simulation, s: Snapshot): { x: number; y: number } {
    const w = sim.world, main = s.castles[0];
    let ex = sim.map.w >> 1, ey = sim.map.h >> 1, bd = 0x7fffffff;
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (!p.alive || sim.sameTeam(this.player, i)) continue;
      const d = fpLen(fp(p.startX) - w.x[main], fp(p.startY) - w.y[main]);
      if (d < bd) { bd = d; ex = p.startX; ey = p.startY; }
    }
    return { x: ex, y: ey };
  }

  /**
   * The rectangle the fence will follow. Drawn once, around everything the base has at the time plus room to
   * grow into, and pushed outwards until no side runs alongside a gold vein: a deposit keeps a one-cell lane
   * that refuses a fence, and a hole in the ring is worse than a ring one cell wider.
   */
  private planWall(sim: Simulation, s: Snapshot): void {
    const w = sim.world, main = s.castles[0];
    const cx = w.x[main] >> FP_SHIFT, cy = w.y[main] >> FP_SHIFT;
    let x0 = cx, y0 = cy, x1 = cx, y1 = cy;
    const add = (ax: number, ay: number, bx: number, by: number) => {
      if (ax < x0) x0 = ax; if (ay < y0) y0 = ay; if (bx > x1) x1 = bx; if (by > y1) y1 = by;
    };
    for (const b of s.buildings) {
      const [bx, by] = sim.footprintTopLeft(b);
      // an outpost across the map is not part of this base and must not drag the ring out to it
      if (Math.abs(bx - cx) > 10 || Math.abs(by - cy) > 10) continue;
      add(bx, by, bx + w.size[b] - 1, by + w.size[b] - 1);
    }
    for (const m of this.myMines(sim, s)) {
      const [bx, by] = sim.footprintTopLeft(m);
      if (Math.abs(bx - cx) > 8 || Math.abs(by - cy) > 8) continue; // a far vein is left outside the wall
      add(bx - 1, by - 1, bx + w.size[m], by + w.size[m]);          // with the lane it keeps
    }
    let rect = this.clampRect(sim, cx, cy, x0 - WALL_MARGIN_MIN, y0 - WALL_MARGIN_MIN, x1 + WALL_MARGIN_MIN, y1 + WALL_MARGIN_MIN);
    for (let margin = WALL_MARGIN_MIN; margin <= WALL_MARGIN_MAX; margin++) {
      rect = this.clampRect(sim, cx, cy, x0 - margin, y0 - margin, x1 + margin, y1 + margin);
      if (this.ringClearOfVeins(sim, rect)) break;
    }
    this.wallRect = rect;
    this.wallRing = this.ringCells(sim, s, rect);
    this.wallIdx = 0;
  }

  private clampRect(sim: Simulation, cx: number, cy: number, x0: number, y0: number, x1: number, y1: number): Rect {
    if (x0 > cx - WALL_HALF_MIN) x0 = cx - WALL_HALF_MIN;
    if (y0 > cy - WALL_HALF_MIN) y0 = cy - WALL_HALF_MIN;
    if (x1 < cx + WALL_HALF_MIN) x1 = cx + WALL_HALF_MIN;
    if (y1 < cy + WALL_HALF_MIN) y1 = cy + WALL_HALF_MIN;
    if (cx - x0 > WALL_HALF_MAX) x0 = cx - WALL_HALF_MAX;
    if (cy - y0 > WALL_HALF_MAX) y0 = cy - WALL_HALF_MAX;
    if (x1 - cx > WALL_HALF_MAX) x1 = cx + WALL_HALF_MAX;
    if (y1 - cy > WALL_HALF_MAX) y1 = cy + WALL_HALF_MAX;
    if (x0 < 2) x0 = 2; if (y0 < 2) y0 = 2;
    if (x1 > sim.map.w - 3) x1 = sim.map.w - 3;
    if (y1 > sim.map.h - 3) y1 = sim.map.h - 3;
    return { x0, y0, x1, y1 };
  }

  /** true when no gold vein's lane crosses one of the four sides, so every side can be fenced end to end */
  private ringClearOfVeins(sim: Simulation, r: Rect): boolean {
    const w = sim.world;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
      const [mx, my] = sim.footprintTopLeft(id), ms = w.size[id];
      const ax = mx - 1, ay = my - 1, bx = mx + ms, by = my + ms;
      if (bx < r.x0 || ax > r.x1 || by < r.y0 || ay > r.y1) continue; // nowhere near the ring
      if ((ax <= r.x0 && bx >= r.x0) || (ax <= r.x1 && bx >= r.x1)) return false;
      if ((ay <= r.y0 && by >= r.y0) || (ay <= r.y1 && by >= r.y1)) return false;
    }
    return true;
  }

  /**
   * The ring's cells as packed map indices, in build order: the side the enemy lives on first, then the flanks,
   * then the back. Each side is laid end to end so it grows as one line - and a straight run of four finished
   * sections is what the sim turns into a gate, which is how the bot keeps a way out of its own wall.
   */
  private ringCells(sim: Simulation, s: Snapshot, r: Rect): number[] {
    const mw = sim.map.w;
    const top: number[] = [], bottom: number[] = [], left: number[] = [], right: number[] = [];
    for (let x = r.x0; x <= r.x1; x++) { top.push(r.y0 * mw + x); bottom.push(r.y1 * mw + x); }
    for (let y = r.y0 + 1; y < r.y1; y++) { left.push(y * mw + r.x0); right.push(y * mw + r.x1); }
    const e = this.enemyDir(sim, s);
    const mx = (r.x0 + r.x1) >> 1, my = (r.y0 + r.y1) >> 1;
    const sides = [
      { cells: top, d: fpLen(fp(mx - e.x), fp(r.y0 - e.y)), i: 0 },
      { cells: right, d: fpLen(fp(r.x1 - e.x), fp(my - e.y)), i: 1 },
      { cells: bottom, d: fpLen(fp(mx - e.x), fp(r.y1 - e.y)), i: 2 },
      { cells: left, d: fpLen(fp(r.x0 - e.x), fp(my - e.y)), i: 3 },
    ];
    sides.sort((a, b) => a.d - b.d || a.i - b.i);
    const out: number[] = [];
    for (const side of sides) for (const c of side.cells) out.push(c);
    return out;
  }

  /**
   * A spot for a watchtower behind the wall: one cell inside, a few cells to the side of the middle of the
   * run. The middle is where the sim puts the gate, and a tower parked behind the door would be a plug
   * rather than a guard - off to one side it covers the door, the wall and the ground in front of both.
   */
  private wallTowerSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const r = this.wallRect;
    if (!r) return null;
    const e = this.enemyDir(sim, s);
    const mx = (r.x0 + r.x1) >> 1, my = (r.y0 + r.y1) >> 1;
    const sides = [
      { d: fpLen(fp(mx - e.x), fp(r.y0 - e.y)), i: 0 },
      { d: fpLen(fp(r.x1 - e.x), fp(my - e.y)), i: 1 },
      { d: fpLen(fp(mx - e.x), fp(r.y1 - e.y)), i: 2 },
      { d: fpLen(fp(r.x0 - e.x), fp(my - e.y)), i: 3 },
    ];
    sides.sort((a, b) => a.d - b.d || a.i - b.i);
    for (const side of sides) {
      for (const off of [-5, 4, -8, 7]) {
        let x: number, y: number;
        if (side.i === 0) { x = mx + off; y = r.y0 + 1; }
        else if (side.i === 1) { x = r.x1 - 2; y = my + off; }
        else if (side.i === 2) { x = mx + off; y = r.y1 - 2; }
        else { x = r.x0 + 1; y = my + off; }
        if (x < r.x0 + 1 || y < r.y0 + 1 || x + 1 > r.x1 - 1 || y + 1 > r.y1 - 1) continue;
        if (!canPlaceBuilding(sim, BuildingType.Tower, x, y, this.player)) continue;
        if (!this.catapultLane(sim, BuildingType.Tower, x, y)) continue;
        return { x, y };
      }
    }
    return null;
  }

  /**
   * Lay the next stretch of fence. The ring is walked in order with a cursor, so the wall grows as a line a
   * player could have dragged, and the sections go on one worker's order queue exactly as a dragged line does.
   * Once the cursor reaches the end the ring is standing; it is walked again every WALL_RESCAN ticks, which
   * is what closes a breach after siege has been through it.
   */
  private fortify(sim: Simulation, s: Snapshot, out: Command[]): void {
    const plan = this.plan;
    if (!plan.wall || !this.profile.towers) return;
    if (s.castles.length === 0 || s.workers.length < 10) return;
    if (s.complete[BuildingType.Barracks].length === 0) return; // men before masonry
    if (sim.tick - this.lastWallTick < WALL_INTERVAL) return;
    if (this.savingFor(sim, s) !== 'wall') return; // the second castle comes first; the rest of the ring waits
    if (this.wallComplete) {
      if (sim.tick - this.wallScanTick < WALL_RESCAN) return;
      this.wallComplete = false; this.wallIdx = 0; this.wallScanTick = sim.tick;
    }
    if (!this.wallRect) this.planWall(sim, s);
    const ring = this.wallRing;
    if (ring.length === 0) return;
    this.lastWallTick = sim.tick;
    if (s.gold < WALL_GOLD_FLOOR) return;
    if (s.constructing[BuildingType.Wall].length >= WALL_SITES) return;

    const mw = sim.map.w, cost = BUILDINGS[BuildingType.Wall].cost;
    let budget = WALL_SITES - s.constructing[BuildingType.Wall].length;
    let builder = -1;
    let placed = 0;
    while (this.wallIdx < ring.length && budget > 0 && s.gold >= cost) {
      const c = ring[this.wallIdx];
      const x = c % mw, y = (c - x) / mw;
      this.wallIdx++;
      // a cell that already carries masonry, or that terrain closed for us, needs no section of ours; one
      // that refuses a fence today - fog it has not walked into, a vein's lane - is left to the next pass
      if (sim.path.isFootprint(x, y) || sim.path.isTerrainBlocked(x, y)) continue;
      if (!canPlaceBuilding(sim, BuildingType.Wall, x, y, this.player)) continue;
      if (builder < 0) {
        const b = this.builder(sim, s, s.castles[0], 1);
        if (b.length === 0) { this.wallIdx--; break; }
        builder = b[0];
      }
      out.push({ type: CommandType.Build, player: this.player, ids: [builder], v: BuildingType.Wall, x: fp(x), y: fp(y), queue: placed > 0 });
      s.gold -= cost; budget--; placed++;
    }
    if (this.wallIdx >= ring.length) { this.wallComplete = true; this.wallScanTick = sim.tick; }
  }

  // ------------------------------------------------------------ production

  private desiredComposition(s: Snapshot): number[] {
    // counters: soldier beats archer and cavalry, archer beats catapult, catapult beats soldier, cavalry runs down catapults and archers
    const eS = s.enemyByType[UnitType.Soldier] + s.enemyByType[UnitType.Militia];
    const eA = s.enemyByType[UnitType.Archer];
    const eC = s.enemyByType[UnitType.Catapult];
    const eV = s.enemyByType[UnitType.Cavalry];
    const eR = s.enemyByType[UnitType.Ram];
    const total = eS + eA + eC + eV + eR;
    let dS = 0.5, dA = 0.5, dC = 0, dV = 0;
    if (total >= 3) {
      const sS = eS / total, sA = eA / total, sC = (eC + eR) / total, sV = eV / total;
      dS = 0.3 + 0.7 * sA + 0.5 * sV;  // soldiers counter archers and cavalry
      dA = 0.3 + 0.7 * sC;             // archers counter siege, rams included
      dC = 0.05 + 0.7 * sS;            // catapults counter soldiers
      dV = 0.05 + 0.6 * sC + 0.3 * sA; // cavalry counters siege and archers
      const sum = dS + dA + dC + dV;
      dS /= sum; dA /= sum; dC /= sum; dV /= sum;
    } else if (this.difficulty === 0) {
      dS = 0.65; dA = 0.35; dC = 0;
    }
    if (this.difficulty === 0) { dC = Math.min(dC, 0.1); dV = 0; } // the easy bot keeps to the basics
    // the plan leans the counter-picks without overruling them: a turtle still builds soldiers when cavalry
    // shows up, it just builds fewer of them than a rusher would
    const mix = this.plan.mixPct;
    dS = (dS * mix[0]) / 100; dA = (dA * mix[1]) / 100; dC = (dC * mix[2]) / 100; dV = (dV * mix[3]) / 100;
    const norm = dS + dA + dC + dV || 1;
    dS /= norm; dA /= norm; dC /= norm; dV /= norm;
    const out = new Array<number>(UNIT_TYPE_COUNT).fill(0);
    out[UnitType.Soldier] = dS; out[UnitType.Archer] = dA; out[UnitType.Catapult] = dC; out[UnitType.Cavalry] = dV;
    // The ram is a tool, not a share of the army: it is wanted only for what stands in the way, so it is
    // sized off the enemy's walls and towers rather than off their troops (see `wantedRams`).
    out[UnitType.Ram] = 0;
    return out;
  }

  /**
   * How many rams the bot would like standing. A ram exists to open a way in, so the number follows what it
   * has actually scouted rather than the enemy's troop mix: a fence line or a watchtower is worth one, a
   * real fortification two or three. Catapults do the job better, so the count drops to zero in the second age.
   */
  private wantedRams(sim: Simulation, s: Snapshot): number {
    if (this.difficulty === 0) return 0; // the easy bot keeps to the basics
    const siege = this.plan.siegeFirst;
    // the siege plan keeps one ram around even in the stone age, to walk in front of the catapults
    if (sim.players[this.player].age >= UNITS[UnitType.Catapult].age) return siege ? 1 : 0;
    if (s.army.length < 4) return 0; // a ram without an escort is a gift
    // Every enemy has a castle, and a castle is what a ram is for - so two are wanted as soon as there is
    // an army to walk them in. Anything else it has scouted (a fence line, a watchtower) asks for one more.
    let walls = 0, towers = 0;
    for (const kb of this.known.values()) {
      if (kb.owner < 0 || sim.sameTeam(this.player, kb.owner)) continue;
      if (kb.type === BuildingType.Wall) walls++;
      else if (kb.type === BuildingType.Tower) towers++;
    }
    const need = 2 + Math.floor(walls / 8) + towers;
    return need > 4 ? 4 : need;
  }

  private production(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    const desired = this.desiredComposition(s);
    const counts = s.byType.map((ids) => ids.length);
    const total = counts[UnitType.Soldier] + counts[UnitType.Archer] + counts[UnitType.Catapult] + counts[UnitType.Cavalry] + 1;
    // reserve gold for pending buildings on higher difficulties
    let reserve = 0;
    if (s.complete[BuildingType.Barracks].length === 0) reserve = BUILDINGS[BuildingType.Barracks].cost;
    else if (s.popUsed + 4 >= s.popCap && s.popCap < MAX_POP) reserve = BUILDINGS[BuildingType.House].cost;
    // an unfinished ring keeps a slice back, or the barracks would eat every coin and the wall would
    // never get past the first corner
    const saving = this.savingFor(sim, s);
    // the purse the queues may not touch; the purchase being saved for spends out of `reserve` alone, or the
    // bot would be waiting for its own savings on top of the price
    const held = reserve + (saving ? RESERVE[saving] : 0);

    // the next age: as soon as the forge stands and the gold is there - siege and cavalry wait behind it
    const me = sim.players[this.player];
    if (this.difficulty >= 1 && me.age < AGE_COUNT - 1 && s.complete[BuildingType.Forge].length > 0) { // the easy bot stays in wood
      const castle = s.castles.find((c) => w.queueLen[c] === 0);
      if (castle !== undefined && s.gold - reserve >= AGE_UP.cost + 60 && sim.validate({ type: CommandType.AgeUp, player: this.player, ids: [castle] }) === null) {
        out.push({ type: CommandType.AgeUp, player: this.player, ids: [castle] });
        s.gold -= AGE_UP.cost;
      }
    }

    // upgrades - but the forge is also the siege workshop: once catapults are unlocked and short, they come first
    const deficit = (t: UnitType) => desired[t] - counts[t] / total;
    const catapultFirst = me.age >= UNITS[UnitType.Catapult].age && deficit(UnitType.Catapult) > 0.1 && s.gold - held >= UNITS[UnitType.Catapult].cost;
    if (this.profile.upgrades && !catapultFirst && s.complete[BuildingType.Forge].length > 0) {
      const forge = s.complete[BuildingType.Forge][0];
      if (w.queueLen[forge] === 0 && s.gold > 320) {
        const p = sim.players[this.player];
        const order: UpgradeId[] = counts[1] >= counts[2]
          ? [UpgradeId.MeleeAttack, UpgradeId.Armor, UpgradeId.RangedAttack, UpgradeId.Gather, UpgradeId.MoveSpeed, UpgradeId.Range]
          : [UpgradeId.RangedAttack, UpgradeId.Range, UpgradeId.Armor, UpgradeId.Gather, UpgradeId.MeleeAttack, UpgradeId.MoveSpeed];
        for (const u of order) {
          if (p.upgrades[u] >= maxUpgradeLevel(u, p.age)) continue;
          const cost = upgradeCost(u, p.upgrades[u] + 1);
          if (s.gold - held >= cost + 80) { out.push({ type: CommandType.Research, player: this.player, ids: [forge], v: u }); s.gold -= cost; }
          break;
        }
      }
    }

    // rams: sized by what stands in the way, so they are queued outside the army's deficit maths
    const ramsWanted = this.wantedRams(sim, s);
    if (ramsWanted > 0) {
      const have = counts[UnitType.Ram] + s.complete[BuildingType.Forge].reduce((n, f) => n + w.queueLen[f], 0);
      const ram = UNITS[UnitType.Ram];
      if (have < ramsWanted && s.gold - held >= ram.cost && s.popUsed + ram.pop <= s.popCap) {
        const forge = s.complete[BuildingType.Forge].find((f) => w.queueLen[f] === 0);
        if (forge !== undefined) {
          out.push({ type: CommandType.Train, player: this.player, ids: [forge], v: UnitType.Ram });
          s.gold -= ram.cost; s.popUsed += ram.pop;
          return;
        }
      }
    }

    // army
    const producers: [number, UnitType][] = [];
    for (const b of s.complete[BuildingType.Barracks]) if (w.queueLen[b] < 2) {
      producers.push([b, UnitType.Soldier]); producers.push([b, UnitType.Archer]);
      if (me.age >= UNITS[UnitType.Cavalry].age) producers.push([b, UnitType.Cavalry]);
    }
    if (me.age >= UNITS[UnitType.Catapult].age) for (const f of s.complete[BuildingType.Forge]) if (w.queueLen[f] < 1) producers.push([f, UnitType.Catapult]);
    if (producers.length === 0) return;
    // pick the unit type with the largest deficit that we can afford
    const types = [UnitType.Soldier, UnitType.Archer, UnitType.Catapult, UnitType.Cavalry].filter((t) => producers.some((p) => p[1] === t));
    types.sort((a, b) => deficit(b) - deficit(a) || a - b);
    for (const t of types) {
      const def = UNITS[t];
      if (s.gold - held < def.cost) continue;
      if (s.popUsed + def.pop > s.popCap) continue;
      const prod = producers.find((p) => p[1] === t)!;
      out.push({ type: CommandType.Train, player: this.player, ids: [prod[0]], v: t });
      s.gold -= def.cost; s.popUsed += def.pop; counts[t]++;
      // rally point for the producer: between castle and map centre
      if (!this.rallySet.has(prod[0]) && s.castles.length > 0) {
        const rp = this.rallyPoint(sim, s);
        out.push({ type: CommandType.SetRally, player: this.player, ids: [prod[0]], x: rp.x, y: rp.y });
        this.rallySet.add(prod[0]);
      }
      break;
    }
  }

  // ------------------------------------------------------------ military

  private armyValue(sim: Simulation, s: Snapshot): number {
    return s.army.reduce((v, id) => v + UNITS[sim.world.type[id] as UnitType].cost, 0);
  }

  /**
   * Where the idle army waits. A rusher stands well forward, on the road it is about to take; a turtle waits
   * inside its own gate, which is also what makes its towers and castle part of every fight it takes.
   */
  private rallyPoint(sim: Simulation, s: Snapshot): { x: number; y: number } {
    const w = sim.world;
    const c = s.castles[0], pct = this.plan.rallyPct;
    return {
      x: w.x[c] + Math.floor(((fp(sim.map.w / 2) - w.x[c]) * pct) / 100),
      y: w.y[c] + Math.floor(((fp(sim.map.h / 2) - w.y[c]) * pct) / 100),
    };
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
      // a fortified bot mans its towers: three workers inside take a tower from 15 damage a shot to 39
      if (this.plan.wall) {
        for (const t of s.complete[BuildingType.Tower]) {
          if (w.carry[t] >= TOWER_CAPACITY) continue;
          if (!s.enemyUnits.some((e) => fpLen(w.x[e] - w.x[t], w.y[e] - w.y[t]) < fp(11))) continue;
          const crew = this.builder(sim, s, t, TOWER_CAPACITY - w.carry[t]);
          if (crew.length === 0) break;
          out.push({ type: CommandType.Garrison, player: this.player, ids: crew, target: t });
          this.manned.add(t);
          break;
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
    // the tower crews go back to gold once it has been quiet for a while
    if (this.manned.size > 0 && sim.tick - this.threatTick > 20 * 20) {
      for (const t of this.manned) if (w.alive[t] && w.kind[t] === Kind.Building && w.carry[t] > 0) out.push({ type: CommandType.Ungarrison, player: this.player, ids: [t] });
      this.manned.clear();
    }
    // fleeing workers return to work
    for (const [id, until] of this.fleeing) {
      if (sim.tick >= until || !w.alive[id]) { this.fleeing.delete(id); if (w.alive[id] && w.kind[id] === Kind.Unit && w.type[id] === UnitType.Worker && w.order[id] !== Order.Gather) out.push({ type: CommandType.Stop, player: this.player, ids: [id] }); }
    }

    // The plan decides how big a wave has to be before the bot walks out with it - but only for a while. Past
    // its push tick it falls back to the plain threshold of its difficulty, and later still to whatever it has:
    // a turtle that never leaves its wall is not a strategy, it is a stalemate.
    const wave = (this.attackWave * this.profile.attackPopGrowth * this.plan.wavePct) / 100 | 0;
    let threshold = (((this.profile.attackPop * this.plan.attackPopPct) / 100) | 0) + wave;
    if (sim.tick > this.plan.pushAfter) threshold = Math.min(threshold, this.profile.attackPop + wave);
    if (sim.tick > this.plan.pushAfter + 6 * MINUTE) threshold = Math.min(threshold, 14 + wave);
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
    /**
     * A small aggressive wave is not trying to crack a keep - a castle shoots for 30 and five men in front of
     * one simply die. It goes for what a base cannot defend everywhere: the diggers on the outer vein, and
     * whatever masonry stands away from the castle's cover.
     */
    const armyPop = s.army.reduce((n, id) => n + UNITS[w.type[id] as UnitType].pop, 0);
    const raid = this.plan.attackPopPct < 80 && armyPop < 24;
    let best: { x: number; y: number } | null = null, bd = 0x7fffffff;
    if (raid) {
      for (const e of s.enemyUnits) {
        if (w.type[e] !== UnitType.Worker) continue;
        const d = fpLen(w.x[e] - w.x[main], w.y[e] - w.y[main]);
        if (d < bd) { bd = d; best = { x: w.x[e], y: w.y[e] }; }
      }
      if (best) return best;
      const vein = this.raidVein(sim, s);
      if (vein) return vein;
    }
    // then known buildings (a raid steers around the castle, a real wave heads for it), then enemy starts
    const castleBias = raid ? -fp(10) : fp(8);
    for (const kb of this.known.values()) {
      if (!sim.players[kb.owner].alive) continue;
      const d = fpLen(kb.x - w.x[main], kb.y - w.y[main]) - (kb.type === BuildingType.Castle ? castleBias : 0);
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

  /**
   * A deposit the enemy is digging that its castle does not cover. This is where a small wave can actually
   * win something: diggers have 40 hit points and no answer to a soldier, and every one killed is gold that
   * never arrives. Walking the same wave into the keep instead just feeds it.
   */
  private raidVein(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const w = sim.world, main = s.castles[0];
    let best: { x: number; y: number } | null = null, bd = 0x7fffffff;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
      if (!sim.fog.isExplored(this.player, w.x[id], w.y[id])) continue;
      const mine = fpLen(w.x[id] - w.x[main], w.y[id] - w.y[main]);
      let theirs = 0x7fffffff, covered = false;
      for (let i = 0; i < sim.players.length; i++) {
        const p = sim.players[i];
        if (!p.alive || sim.sameTeam(this.player, i)) continue;
        const d = fpLen(fp(p.startX) - w.x[id], fp(p.startY) - w.y[id]);
        if (d < theirs) theirs = d;
      }
      if (theirs >= mine) continue;                 // closer to us than to them: not their gold
      for (const kb of this.known.values()) {
        if (kb.type !== BuildingType.Castle || sim.sameTeam(this.player, kb.owner)) continue;
        if (fpLen(kb.x - w.x[id], kb.y - w.y[id]) < fp(10)) covered = true;
      }
      if (covered) continue;                        // under the castle's guns, which is the thing to avoid
      if (mine < bd) { bd = mine; best = { x: w.x[id], y: w.y[id] }; }
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
    // rams go for masonry: left alone they would plod after a soldier they can never catch
    for (const r of s.byType[UnitType.Ram]) {
      if (budget <= 0) break;
      if (w.order[r] === Order.Attack && w.kind[w.orderTarget[r]] === Kind.Building) continue;
      let best = -1, bestD = fp(14);
      for (const kb of this.known.values()) {
        if (kb.owner < 0 || sim.sameTeam(this.player, kb.owner)) continue;
        if (!w.alive[kb.id] || w.gen[kb.id] !== kb.gen || w.kind[kb.id] !== Kind.Building) continue;
        const d = fpLen(w.x[kb.id] - w.x[r], w.y[kb.id] - w.y[r]);
        if (d < bestD) { bestD = d; best = kb.id; }
      }
      if (best >= 0) { out.push({ type: CommandType.Attack, player: this.player, ids: [r], target: best }); budget--; }
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
