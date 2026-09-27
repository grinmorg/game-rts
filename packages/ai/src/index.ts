import {
  MINE_CAPACITY, TOWER_CAPACITY, buildingLimit, garrisonCapacity,
  AGE_COUNT, AGE_UP, maxUpgradeLevel,
  ABILITIES, AbilityId, BUILDING_TYPE_COUNT, BUILDINGS, BuildingState, BuildingType, Command, CommandType, FP_SHIFT, Kind,
  Order, Rng, Simulation, UNITS, UNIT_TYPE_COUNT, UnitType, UpgradeId, canPlaceBuilding, fp, fpLen, toFloat,
  upgradeCost, UPGRADES, MAX_POP,
} from '@rookfall/sim';
import {
  DIRS, Difficulty, KnownBuilding, MINE_CROWD, MINUTE, PLANS, PROFILES, Plan, Profile, STRATEGY_POOL, Snapshot, Strategy, WORKERS_PER_VEIN, WORKER_POP_PCT,
} from './plans';
import { Commander } from './commander';

export { Strategy, STRATEGY_NAMES } from './plans';
export type { Difficulty } from './plans';


/** gold in hand past which the bot stops the barracks to buy the next age outright */
const AGE_BURST = 650;
/** ticks before a building search that found nothing is tried again */
const SPOT_RETRY = 20 * 3;
/** the fence starts only once there is an army to stand behind it and gold that the army is not waiting on */
const WALL_GOLD_FLOOR = 300;
/** fence sections kept under construction at once: a stretch long enough to read, short enough to finish */
const WALL_SITES = 3;
/** ticks between two fence orders */
const WALL_INTERVAL = 60;
/** gold a narrowed line leaves clear above the savings, so the purse still climbs towards its purchase */
const WALL_SAVING_MARGIN = 120;
/** once the ring stands, it is walked again this often, so a breach gets rebuilt */
const WALL_RESCAN = 45 * 20;
/**
 * Episodes of enemies at the base before a plan that is not built around a fence decides it wants one. Two is
 * "this keeps happening" rather than "someone walked past once", and it is what puts a fence in most games:
 * only one plan in five rings its base on principle, so without this a player rarely saw a fence at all.
 */
const REACTIVE_WALL_ATTACKS = 2;
/** cells of clear ground the ring leaves around the outermost building */
const WALL_MARGIN_MIN = 3, WALL_MARGIN_MAX = 6;
/** half-width limits of the ring: tighter and the base outgrows it, wider and it never gets finished */
const WALL_HALF_MIN = 8, WALL_HALF_MAX = 12;
/** the one purchase the bot is putting gold aside for (see Bot.savingFor) */
type Saving = 'castle' | 'wall' | 'age';
/**
 * Gold the barracks leave alone while the bot is saving for something. Without a reserve the queues spend every
 * coin the tick it lands, and the 1000 for the second age never piles up at all: the bots stayed in the wooden
 * age, with no catapults, cavalry or stone walls outside the rare quiet game. The fence asks for much less - it
 * is bought a section at a time, and a turtle that stops making soldiers to finish a wall has missed the point.
 * A castle is not on this list: it is saved for at its full copy price (see Bot.reserveFor), because a reserve
 * short of the price left the purse hovering just under it, and a bot saving for a castle it never reached
 * also never laid its fence - the fence waits while a castle is being saved for.
 */
const RESERVE: Record<Exclude<Saving, 'castle'>, number> = { wall: 50, age: 260 };
/**
 * What the next copy of a building has to be paid out of. A plan says how many castles, barracks or mines it
 * is willing to own, but the count is not what should stop it - a bot rich enough to hold half the map should
 * hold half the map. What stops it is that each copy asks for more spare gold than the last, so spreading out
 * is something a good economy earns and a bad one cannot fake. Without this the greedy plans bought eight
 * castles and five barracks they had no income to fill, and lost to plans that simply built soldiers.
 */
const COPY_SURCHARGE = 190;
/**
 * Spare gold on top of the copy price before a castle the plan did not ask for. A bot sitting on that much has
 * a treasury its barracks cannot keep up with, and an empty castle slot is the best thing left to spend it on.
 */
const EXTRA_CASTLE_MARGIN = 300;

interface Rect { x0: number; y0: number; x1: number; y1: number }


/** how far out from the enemy's centre the bot feels for a way in */
const PROBE_RADIUS = 11;
/** and how wide a patch each sample stands for */
const PROBE_SPREAD = 8;
/** the probe is redone this often: often enough to notice a new tower, rarely enough not to cost anything */
const PROBE_INTERVAL = 8 * 20;
/** how much better a new way in has to look before the bot abandons the one it is already walking towards */
const PROBE_STICK = 4;
/** cells between two towers of a creeping line - inside the 7-cell reach of the one behind it */
const CREEP_STEP = 5;
/**
 * Half-width of the road a walled bot keeps clear from each gate to the middle of its base. The sim puts the
 * gate in the middle of a finished run, so the road is known before the wall is: two cells either side of that
 * middle, all the way in. Without it the bot fills its own town solid and then has one door per side with a
 * barracks parked in front of it - everything defended and nothing able to leave.
 */
const ROAD_HALF = 1;


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
  /** every enemy building the bot has seen, kept while it has no reason to think it gone */
  readonly known = new Map<number, KnownBuilding>();
  /** the army: defence, attacks, raids, micro and scouting (see Commander) */
  readonly commander: Commander;
  private lastHouseTick = -100000;
  private lastBuildTick = -100000;
  private nextThink = 0;
  private threatTick = -100000;
  /** how many separate times the enemy has turned up at the base (see detectThreat) */
  private threatEpisodes = 0;
  private threatPos: { x: number; y: number } | null = null;
  private rallySet = new Set<number>();
  /** gold mined in the last whole minute, for sizing the halls (see barracksWanted) */
  private income = 0;
  private incomeMark = 0;
  private incomeTick = 0;
  /** building searches that came back empty, and when (see findSpot) */
  private spotFails = new Map<number, number>();
  /** passages through the bot's own gates that buildings keep out of (see refreshDoors) */
  private doorLanes: Rect[] = [];
  private doorScan = -1;
  /** ring cells the bot opened on purpose because its town had sealed itself in, never rebuilt */
  private holes = new Set<number>();
  private sealCheck = -100000;
  /** a cell outside the ring that could be walked to before the fence went up, -1 if none (see planWall) */
  private outside = -1;
  /** workers the economy is short of: the barracks leave that much population free for them */
  private workerShort = 0;
  /** the rectangle the fence follows, and the ring cells in build order (see planWall) */
  private wallRect: Rect | null = null;
  private wallRing: number[] = [];
  /** index just past each side of the ring, in the order the sides are built (see ringCells) */
  private wallSideEnd: number[] = [];
  private wallIdx = 0;
  private wallComplete = false;
  private wallScanTick = -100000;
  private lastWallTick = -100000;
  /** the weak side of the enemy, re-read every PROBE_INTERVAL ticks (see weakApproach) */
  private probe: { x: number; y: number } | null = null;
  private probeScore = 0;
  private probeTick = -100000;

  constructor(player: number, difficulty: Difficulty, seed: number, strategy?: Strategy) {
    this.player = player;
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
    this.rng = new Rng((seed ^ (player * 0x9e3779b9)) | 0);
    const pool = STRATEGY_POOL[difficulty];
    this.strategy = strategy ?? pool[this.rng.nextInt(pool.length)];
    this.plan = PLANS[this.strategy];
    this.nextThink = 20 + player * 3;
    this.commander = new Commander(this);
  }

  /**
   * Halls the bot is willing to run: the plan's number, or more when the income runs ahead of it. A soldier
   * takes twenty seconds whatever the purse holds, so one barracks spends about 215 gold a minute and a bot
   * mining two thousand with four halls banks the rest. Measured over the last minute of mining.
   */
  private barracksWanted(sim: Simulation, s: Snapshot): number {
    const mined = sim.players[this.player].goldMined;
    if (sim.tick - this.incomeTick >= 20 * 60) {
      this.income = mined - this.incomeMark; this.incomeMark = mined; this.incomeTick = sim.tick;
    }
    const plan = this.ambition(this.plan.barracks);
    const byIncome = this.difficulty === 0 ? Math.min(3, (this.income / 400) | 0) : Math.min(8, (this.income / 260) | 0);
    return Math.max(this.difficulty === 0 ? 1 : plan, byIncome);
  }

  /** the gold the next copy of a building asks for: its price, plus a surcharge for every one already up */
  private copyPrice(type: BuildingType, have: number): number {
    // the second of anything is ordinary growth and pays the plain price; it is the sprawl after it that has
    // to be earned, so the surcharge only starts from the third
    return BUILDINGS[type].cost + 60 + COPY_SURCHARGE * (have > 1 ? have - 1 : 0);
  }

  /** is this bot laying a whole ring, as opposed to a line across one approach? */
  private ringing(): boolean { return this.plan.wallSides >= 3; }

  /** how far this bot takes one of its plan's building counts, scaled by what its difficulty can handle */
  private ambition(n: number): number {
    const v = ((n * this.profile.ambitionPct) / 100) | 0;
    return n > 0 && v < 1 ? 1 : v;
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
    // the army's orders go ahead of the queues: a defence that waits for the barracks' orders is a base lost
    this.commander.command(sim, snap, out);
    this.production(sim, snap, out);
    this.commander.details(sim, snap, out);
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
      workers: [], workforce: 0, army: [], byType: perType(), buildings: [], complete: perBuilding(), constructing: perBuilding(),
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
          if (garrisonCapacity(w.type[id] as BuildingType) > 0) s.workforce += w.carry[id];
          if (w.state[id] === BuildingState.Complete) { s.complete[w.type[id]].push(id); if (w.type[id] === BuildingType.Castle) s.castles.push(id); }
          else s.constructing[w.type[id]].push(id);
        }
      } else if (o >= 0 && !sim.sameTeam(me, o)) {
        if (!sim.visibleTo(me, id)) continue;
        if (k === Kind.Unit) { s.enemyUnits.push(id); s.enemyByType[w.type[id]]++; }
        else s.enemyBuildings.push(id);
      }
    }
    s.workforce += s.workers.length;
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
    if (best) {
      // a fresh episode, not the same fight ticking over: this is what tells a plan that is not built around
      // a fence that it keeps being attacked from somewhere and had better close that side off
      if (!this.threatPos && sim.tick - this.threatTick > 20 * 30) this.threatEpisodes++;
      this.threatPos = best; this.threatTick = sim.tick;
    } else if (sim.tick - this.threatTick > 20 * 8) this.threatPos = null;
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
    // every castle has a vein of its own, however far the map put it: a start 14 cells from its gold (six
    // kingdoms, crossroads) used to count no vein at all and stopped at six workers for the whole game
    const own = new Set<number>();
    for (const c of s.castles) {
      let best = -1, bd = fp(20);
      for (let id = 0; id < w.maxId; id++) {
        if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
        const d = fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]);
        if (d < bd) { bd = d; best = id; }
      }
      if (best >= 0) own.add(best);
    }
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine) continue;
      let bd = 0x7fffffff;
      for (const c of s.castles) { const d = fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]); if (d < bd) bd = d; }
      if (bd < fp(13) || own.has(id)) res.push({ id, d: bd });
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
    // An opening that traded diggers for men has to stop trading at some point: past the eighth minute every
    // plan comes back to at least an ordinary worker line. The only ceiling on a bot's numbers is the same
    // MAX_POP the player plays under - what stops it here is the shape of its plan and the work there is to
    // do, not a limit of its own.
    const pct = sim.tick > 8 * MINUTE ? Math.max(this.plan.workerPct, WORKER_POP_PCT) : this.plan.workerPct;
    const line = ((MAX_POP * pct) / 100) | 0;
    const useful = Math.max(14, mines.length * WORKERS_PER_VEIN) + s.complete[BuildingType.Mine].length * MINE_CAPACITY;
    const desiredWorkers = Math.min(line, useful);
    const queuedWorkers = s.castles.reduce((n, c) => n + w.queueLen[c], 0);
    const towerCrews = s.complete[BuildingType.Tower].reduce((n, t) => n + w.carry[t], 0);
    this.workerShort = desiredWorkers - (s.workers.length + garrisoned + towerCrews + queuedWorkers);
    if (s.workers.length + garrisoned + queuedWorkers < desiredWorkers && s.gold >= UNITS[UnitType.Worker].cost && s.popUsed + 1 <= s.popCap) {
      const castle = s.castles.find((c) => w.queueLen[c] === 0);
      if (castle !== undefined) { out.push({ type: CommandType.Train, player: this.player, ids: [castle], v: UnitType.Worker }); s.gold -= 50; s.popUsed += 1; }
    }
  }

  // ------------------------------------------------------------ construction

  /**
   * A bot that lays its town out from the first minute (`wallAfter` of nought) keeps everything but a new
   * castle inside the ring and off the roads: a base that spills over its own wall is the one thing that would
   * make the wall pointless. A plan that only fences later draws its ring round whatever it has by then, so
   * confining it in advance would just cramp a base that was never planned as a town. If nothing fits inside
   * any more, it builds outside rather than not at all.
   */
  /**
   * Room for a building that only has to be somewhere in the bot's own ground: beside the main castle, then
   * beside any other castle, then further out from the main one. A town that has filled the ground round its
   * keep used to stop building houses there, and a bot stuck under its population cap with ten thousand gold
   * in the bank never attacked again.
   */
  private homeSpot(sim: Simulation, s: Snapshot, type: BuildingType, maxR = 9): { x: number; y: number } | null {
    const w = sim.world, main = s.castles[0];
    const first = this.findSpot(sim, type, w.x[main], w.y[main], 4, maxR);
    if (first) return first;
    for (const c of s.castles) {
      if (c === main) continue;
      const spot = this.findSpot(sim, type, w.x[c], w.y[c], 3, 9);
      if (spot) return spot;
    }
    return this.findSpot(sim, type, w.x[main], w.y[main], 10, 15);
  }

  private findSpot(sim: Simulation, type: BuildingType, nx: number, ny: number, minR: number, maxR: number, gap = 1): { x: number; y: number } | null {
    // A search that found nothing is not run again for a few seconds: a full base asked for a house spot every
    // think, walked the same rings of cells each time, and that alone was half of what the bot cost per tick.
    const key = ((((type * 1024 + (nx >> FP_SHIFT)) * 1024 + (ny >> FP_SHIFT)) * 32 + minR) * 32 + maxR);
    const failed = this.spotFails.get(key);
    if (failed !== undefined && sim.tick - failed < SPOT_RETRY) return null;
    const planned = this.plan.wallSides >= 3 && this.plan.wallAfter === 0;
    const ring = planned && type !== BuildingType.Castle ? this.wallRect : null;
    const spot = (ring && this.searchSpot(sim, type, nx, ny, minR, maxR, gap, ring)) || this.searchSpot(sim, type, nx, ny, minR, maxR, gap, null);
    if (spot) this.spotFails.delete(key);
    else {
      if (this.spotFails.size > 256) this.spotFails.clear();
      this.spotFails.set(key, sim.tick);
    }
    return spot;
  }

  /**
   * Does this footprint stand in one of the four roads? Each side's gate lands in the middle of its run, so a
   * lane runs from there to the middle of the base; buildings keep off it. Catapults are the reason it is
   * this wide - a footman squeezes through a one-cell seam, a siege engine does not.
   */
  private onRoad(r: Rect, cx: number, cy: number, size: number): boolean {
    const mx = (r.x0 + r.x1) >> 1, my = (r.y0 + r.y1) >> 1;
    const hitsX = cx <= mx + ROAD_HALF && cx + size > mx - ROAD_HALF;
    const hitsY = cy <= my + ROAD_HALF && cy + size > my - ROAD_HALF;
    return hitsX || hitsY;
  }

  /**
   * The passages through the bot's real gates, read off the sim - which puts a gate at the centre of every
   * finished straight run, not where the bot planned one: a run broken by a vein's lane, a patch of forest or a
   * corner puts its door somewhere else. Each passage is kept four cells wide and three deep on both sides of
   * the line. Re-read whenever the number of fence sections changes.
   */
  private refreshDoors(sim: Simulation, s: Snapshot): void {
    const walls = s.complete[BuildingType.Wall];
    if (walls.length === this.doorScan) return;
    this.doorScan = walls.length;
    this.doorLanes = [];
    const team = sim.team(this.player);
    for (const b of walls) {
      const [x, y] = sim.footprintTopLeft(b);
      if (sim.path.gateTeamAt(x, y) !== team) continue;
      const slot = sim.path.gateAt(x, y);
      // the door is the seam between the gate's second and third cells (slots 2|3 along x, 6|7 along y)
      if (slot === 2) this.doorLanes.push({ x0: x - 1, y0: y - 3, x1: x + 2, y1: y + 3 });
      else if (slot === 6) this.doorLanes.push({ x0: x - 3, y0: y - 1, x1: x + 3, y1: y + 2 });
    }
  }

  private inDoorLane(cx: number, cy: number, size: number): boolean {
    for (const r of this.doorLanes) if (cx <= r.x1 && cx + size - 1 >= r.x0 && cy <= r.y1 && cy + size - 1 >= r.y0) return true;
    return false;
  }

  /**
   * Does this footprint sit on the fence the bot has drawn, or in one of its doorways? The ring and a strip a
   * cell wide either side of it stay clear, and so does a passage five cells wide through the middle of each
   * side, three deep inside and out - the sim puts the gate in the middle of a straight run, so that is where
   * the doors will be. A house on the ring line breaks the run and moves the gate; a forge parked against the
   * inside of a door shuts it: both happened, and a fortified bot sat in its own town with every door blocked.
   */
  private onWallLine(cx: number, cy: number, size: number): boolean {
    if (this.inDoorLane(cx, cy, size)) return true;
    const r = this.wallRect;
    if (!r) return false;
    const ax = cx - 1, ay = cy - 1, bx = cx + size, by = cy + size;
    const hits = (x0: number, y0: number, x1: number, y1: number) => ax <= x1 && bx >= x0 && ay <= y1 && by >= y0;
    if (hits(r.x0, r.y0, r.x1, r.y0) || hits(r.x0, r.y1, r.x1, r.y1) || hits(r.x0, r.y0, r.x0, r.y1) || hits(r.x1, r.y0, r.x1, r.y1)) return true;
    const mx = (r.x0 + r.x1) >> 1, my = (r.y0 + r.y1) >> 1;
    if (hits(mx - 2, r.y0 - 3, mx + 2, r.y0 + 3) || hits(mx - 2, r.y1 - 3, mx + 2, r.y1 + 3)) return true;
    return hits(r.x0 - 3, my - 2, r.x0 + 3, my + 2) || hits(r.x1 - 3, my - 2, r.x1 + 3, my + 2);
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
        if (ring && this.onRoad(ring, cx, cy, size)) continue;
        if (type !== BuildingType.Wall && this.onWallLine(cx, cy, size)) continue;
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
    // a digger on his way into a tower is its crew, and one running from soldiers is not free either
    const cands = s.workers.filter((id) => w.order[id] !== Order.Build && w.order[id] !== Order.Garrison && w.carry[id] < 8 && !this.commander.fleeing.has(id));
    cands.sort((a, b) => fpLen(w.x[a] - w.x[near], w.y[a] - w.y[near]) - fpLen(w.x[b] - w.x[near], w.y[b] - w.y[near]) || a - b);
    return cands.slice(0, count);
  }

  private construction(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    if (s.castles.length === 0 || s.workers.length === 0) return;
    this.refreshDoors(sim, s);
    if (sim.tick - this.lastBuildTick < 20) return;
    const main = s.castles[0];
    const plan = this.plan;
    // "The base is busy" means a real site, not the background work: a fence line always has a section going
    // up somewhere, and a plan that keeps two houses ahead of the cap always has a house going up too. Counting
    // those blocked the second castle forever, and a bot saving for a castle it can never start saves for ever.
    const busy = s.constructing[BuildingType.Castle].length + s.constructing[BuildingType.Mine].length
      + s.constructing[BuildingType.Barracks].length + s.constructing[BuildingType.Forge].length;
    const have = (t: BuildingType) => s.complete[t].length + s.constructing[t].length;
    // While a castle is being saved for, the rest of the building list spends only what is above the savings -
    // otherwise the mines, halls and towers ate the castle money over and over, and the bot got neither the
    // army the barracks were starved of nor the base it was starving them for. Houses are the exception.
    const saving = this.savingFor(sim, s);
    const spare = s.gold - (saving === 'castle' ? this.reserveFor(saving, s) : 0);
    const tryBuild = (type: BuildingType, spot: { x: number; y: number } | null, workers: number) => {
      if (!spot) return false;
      const ids = this.builder(sim, s, main, workers);
      if (ids.length === 0) return false;
      out.push({ type: CommandType.Build, player: this.player, ids, v: type, x: fp(spot.x), y: fp(spot.y) });
      s.gold -= BUILDINGS[type].cost;
      this.lastBuildTick = sim.tick;
      return true;
    };

    // Houses, kept ahead of the cap by as much as the plan asks for. A plan that means to walk out with sixty
    // population cannot start the house when it is already at fifty-six: the house takes fifteen seconds and
    // the barracks would sit idle through all of them, so a greedy plan builds two at a time.
    const popSoon = s.popUsed + plan.popBuffer >= s.popCap;
    // (two at a time only once there are two halls to fill them - the boom plan spent 180 of its first 300
    // gold on three houses at population four)
    const houseSites = plan.popBuffer >= 8 && s.complete[BuildingType.Barracks].length >= 2 ? 2 : 1;
    if (popSoon && s.popCap < MAX_POP && s.constructing[BuildingType.House].length < houseSites && s.gold >= BUILDINGS[BuildingType.House].cost && sim.tick - this.lastHouseTick > 60) {
      if (tryBuild(BuildingType.House, this.homeSpot(sim, s, BuildingType.House), 1)) { this.lastHouseTick = sim.tick; return; }
    }
    // barracks - every plan builds it first, they only differ on how much gold is on legs by then
    if (have(BuildingType.Barracks) === 0 && s.workforce >= plan.barracksWorkers && s.gold >= BUILDINGS[BuildingType.Barracks].cost) {
      if (tryBuild(BuildingType.Barracks, this.homeSpot(sim, s, BuildingType.Barracks, 10), this.difficulty >= 1 ? 2 : 1)) return;
    }
    // A plan built on towers puts its first one up as soon as the barracks stands - before the extra veins and
    // halls, which otherwise always had a claim on the gold first and left a turtle towerless into minute eight
    if (plan.towers > 0 && have(BuildingType.Tower) === 0 && s.complete[BuildingType.Barracks].length > 0 && s.army.length >= 2
      && (this.ringing() || plan.creep) && s.gold >= BUILDINGS[BuildingType.Tower].cost) {
      if (tryBuild(BuildingType.Tower, this.towerSpot(sim, s), 1)) return;
    }
    // the siege plan pays for the forge before a second barracks: rams are what it opens with
    if (plan.siegeFirst && have(BuildingType.Forge) === 0 && s.complete[BuildingType.Barracks].length > 0 && s.workforce >= 7 && spare >= BUILDINGS[BuildingType.Forge].cost) {
      if (tryBuild(BuildingType.Forge, this.homeSpot(sim, s, BuildingType.Forge, 11), 1)) return;
    }
    // Mines are capped per player (BUILDING_LIMIT), and a capped slot left empty is income thrown away, so
    // every plan wants all of them; what differs is when. The boom plan digs early - it is the whole point
    // of playing greedy - the rest once the forge stands. The easy bot gets through only part of that.
    const mineCap = buildingLimit(BuildingType.Mine);
    const wantMines = Math.min(this.ambition(mineCap), mineCap);
    if (this.difficulty >= 1 && plan.mineFirst && have(BuildingType.Mine) < wantMines && s.workforce >= 8 && spare >= this.copyPrice(BuildingType.Mine, have(BuildingType.Mine))) {
      if (tryBuild(BuildingType.Mine, this.mineSpot(sim, s), 1)) return;
    }
    // More barracks while the plan wants them and the treasury is running ahead of them. The second one comes
    // cheap for an aggressive opening; each one after that has to be paid for out of gold that is genuinely
    // spare, which is the honest signal that the halls, not the purse, are holding the army back.
    if ((!plan.siegeFirst || s.complete[BuildingType.Forge].length > 0)
      && have(BuildingType.Barracks) < this.barracksWanted(sim, s) && s.constructing[BuildingType.Barracks].length === 0
      && spare >= (s.complete[BuildingType.Barracks].length === 1 ? plan.barracks2Gold : this.copyPrice(BuildingType.Barracks, have(BuildingType.Barracks)))
      && s.workforce >= (plan.barracks2Gold < 300 ? 6 : 8)) {
      // (anywhere on home ground: a full keep with six castles round the map used to stop at one hall for the
      // whole game and bank thirty thousand gold)
      if (tryBuild(BuildingType.Barracks, this.homeSpot(sim, s, BuildingType.Barracks, 11), 1)) return;
    }
    // forge
    if (s.complete[BuildingType.Barracks].length > 0 && have(BuildingType.Forge) === 0 && s.army.length >= 3 && spare >= BUILDINGS[BuildingType.Forge].cost + 50) {
      if (tryBuild(BuildingType.Forge, this.homeSpot(sim, s, BuildingType.Forge, 11), 1)) return;
    }
    // a mine of our own next to the castle: three workers inside give steady gold without walking
    if (have(BuildingType.Mine) < wantMines && sim.tick >= plan.minesAfter
      && s.complete[BuildingType.Forge].length > 0 && s.workforce >= 6 && spare >= this.copyPrice(BuildingType.Mine, have(BuildingType.Mine))) {
      if (tryBuild(BuildingType.Mine, this.mineSpot(sim, s), 1)) return;
    }
    // The ring is drawn as soon as there is a base worth walling - before the first tower is sited and before
    // the forge picks its spot, because from here on everything a ringing plan builds has to fit inside it.
    if (this.ringing()) this.wallLimit(sim, s);
    // Watchtowers. There is no fixed allowance: the appetite grows with the bases the bot holds, and most of
    // it is spent on the side the enemy comes from - a tower behind the base watches an empty field.
    if (s.complete[BuildingType.Barracks].length > 0
      && have(BuildingType.Tower) < this.wantedTowers(sim, s) && spare >= this.copyPrice(BuildingType.Tower, have(BuildingType.Tower)) && s.army.length >= 3) {
      if (tryBuild(BuildingType.Tower, this.towerSpot(sim, s), 1)) return;
    }
    // Castles: the plan's own number is saved for, and past it the bot keeps taking free veins out of surplus
    // up to the sim's cap - it never asks for a castle the sim would refuse. Sites count towards the cap.
    const castleCap = buildingLimit(BuildingType.Castle);
    const castles = have(BuildingType.Castle);
    const price = this.copyPrice(BuildingType.Castle, castles);
    const wantCastle = castles < Math.min(this.ambition(plan.castles), castleCap)
      ? s.gold >= price
      : castles < Math.min(this.ambition(castleCap), castleCap) && s.gold >= price + EXTRA_CASTLE_MARGIN;
    if (wantCastle && sim.tick >= plan.expandAfter && busy === 0 && s.workforce >= 9) {
      const target = this.findExpansionMine(sim, s);
      if (target >= 0) {
        const spot = this.findSpot(sim, BuildingType.Castle, w.x[target], w.y[target], 3, 5);
        if (spot && tryBuild(BuildingType.Castle, spot, 2)) return;
      }
    }
  }

  /**
   * How many watchtowers the bot wants standing right now. It grows with what there is to defend rather than
   * stopping at a number, and a wall plan paces it against the fence so the stone follows the timber instead
   * of arriving before it.
   */
  private wantedTowers(sim: Simulation, s: Snapshot): number {
    const plan = this.plan;
    let want = this.ambition(plan.towers + plan.frontTowers + plan.towersPerCastle * (s.castles.length - 1));
    if (this.ringing()) want = Math.min(want, 1 + ((s.complete[BuildingType.Wall].length / 8) | 0));
    if (plan.creep) {
      // the line is only ever as long as the walk it has to cover, and once it is there the appetite stops:
      // a bot that went on buying towers it has nowhere to put would never save up the army to finish with
      const w = sim.world, c = this.enemyCentre(sim, s);
      const reach = s.castles.length === 0 ? 0
        : (fpLen(fp(c.x) - w.x[s.castles[0]], fp(c.y) - w.y[s.castles[0]]) >> FP_SHIFT) / CREEP_STEP | 0;
      want = Math.min(want, plan.towers + reach);
      if (sim.tick < 4 * MINUTE) want = Math.min(want, 2);
    }
    return want;
  }

  /**
   * A spot for the next mine building, beside whichever castle has the fewest (the main one on a tie). A mine
   * is the one income that never runs out - three workers inside keep paying long after the veins round the
   * base are empty shells - and there are only BUILDING_LIMIT of them, so spreading them over the bases keeps
   * one raid from taking them all. A castle with no room left round it passes the mine on to the next.
   */
  private mineSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const w = sim.world;
    const sites = s.complete[BuildingType.Mine].concat(s.constructing[BuildingType.Mine]);
    const order = s.castles.map((c, i) => {
      let n = 0;
      for (const m of sites) if (fpLen(w.x[m] - w.x[c], w.y[m] - w.y[c]) < fp(12)) n++;
      return { c, n, i };
    }).sort((a, b) => a.n - b.n || a.i - b.i);
    for (const { c } of order) {
      const spot = this.findSpot(sim, BuildingType.Mine, w.x[c], w.y[c], 3, 9);
      if (spot) return spot;
    }
    return null;
  }

  /** a spot for a tower over a vein with four or more diggers on it and no tower of ours within reach */
  private uncoveredVeinSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const w = sim.world;
    const towers = s.complete[BuildingType.Tower].concat(s.constructing[BuildingType.Tower]);
    for (const m of this.myMines(sim, s)) {
      if (towers.some((t) => fpLen(w.x[t] - w.x[m], w.y[t] - w.y[m]) < fp(8))) continue;
      let diggers = 0;
      for (const wk of s.workers) if (w.order[wk] === Order.Gather && w.orderTarget[wk] === m) diggers++;
      if (diggers < 4) continue;
      const spot = this.findSpot(sim, BuildingType.Tower, w.x[m], w.y[m], 3, 6);
      if (spot) return spot;
    }
    return null;
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
      // the sim refuses a site in the fog, and a bot that saved for a castle it could not place held its gold
      // and its fence back for ten minutes: only veins it has looked at count (the scout visits the rest)
      if (!sim.fog.isExplored(this.player, w.x[id] - fp(3), w.y[id]) || !sim.fog.isExplored(this.player, w.x[id] + fp(3), w.y[id])
        || !sim.fog.isExplored(this.player, w.x[id], w.y[id] - fp(3)) || !sim.fog.isExplored(this.player, w.x[id], w.y[id] + fp(3))) continue;
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

  // ------------------------------------------------------------ reading the enemy

  /** the middle of what the bot knows of the enemy: its buildings if it has seen any, its start if not */
  private enemyCentre(sim: Simulation, s: Snapshot): { x: number; y: number } {
    const w = sim.world;
    let sx = 0, sy = 0, n = 0;
    for (const kb of this.known.values()) {
      if (kb.owner < 0 || sim.sameTeam(this.player, kb.owner) || !sim.players[kb.owner].alive) continue;
      sx += kb.x >> FP_SHIFT; sy += kb.y >> FP_SHIFT; n++;
    }
    if (n > 0) return { x: (sx / n) | 0, y: (sy / n) | 0 };
    const main = s.castles.length ? s.castles[0] : -1;
    let bx = sim.map.w >> 1, by = sim.map.h >> 1, bd = 0x7fffffff;
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (!p.alive || sim.sameTeam(this.player, i)) continue;
      const d = main >= 0 ? fpLen(fp(p.startX) - w.x[main], fp(p.startY) - w.y[main]) : 0;
      if (d < bd) { bd = d; bx = p.startX; by = p.startY; }
    }
    return { x: bx, y: by };
  }

  /**
   * The thinnest way in. The bot stands twelve points round the enemy's centre and scores each by what would
   * shoot at an army arriving there - castles and towers count for most, a fence for little, because a fence
   * is a delay and a castle is a fight. Ground it has never seen scores low on purpose: not knowing what is
   * there is a reason to go and look, which is the only way a bot ever finds the side nobody is guarding.
   * Re-read every PROBE_INTERVAL ticks and cached, since it walks every building the bot remembers.
   */
  private weakApproach(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    if (s.castles.length === 0) return null;
    if (this.probe && sim.tick - this.probeTick < PROBE_INTERVAL) return this.probe;
    const w = sim.world, main = s.castles[0];
    const c = this.enemyCentre(sim, s);
    const team = sim.players[this.player].team;
    const spread = fp(PROBE_SPREAD);
    const exit = sim.path.nearestFree(w.x[main] >> FP_SHIFT, w.y[main] >> FP_SHIFT, 8, false, team);
    let best: { x: number; y: number } | null = null, bestScore = 0x7fffffff;
    for (let i = 0; i < DIRS.length; i++) {
      const cx = c.x + ((DIRS[i][0] * PROBE_RADIUS) / 1000 | 0);
      const cy = c.y + ((DIRS[i][1] * PROBE_RADIUS) / 1000 | 0);
      if (cx < 2 || cy < 2 || cx >= sim.map.w - 2 || cy >= sim.map.h - 2) continue;
      const x = fp(cx + 0.5), y = fp(cy + 0.5);
      let score = 0;
      if (sim.path.isTerrainBlocked(cx, cy)) continue;
      for (const kb of this.known.values()) {
        if (kb.owner < 0 || sim.sameTeam(this.player, kb.owner)) continue;
        if (fpLen(kb.x - x, kb.y - y) > spread) continue;
        score += kb.type === BuildingType.Castle ? 8 : kb.type === BuildingType.Tower ? 7 : kb.type === BuildingType.Wall ? 1 : 2;
      }
      for (const e of s.enemyUnits) {
        if (w.type[e] === UnitType.Worker) continue;
        if (fpLen(w.x[e] - x, w.y[e] - y) <= spread) score += 3;
      }
      // unseen ground is cheap to walk into and is how a hole gets found in the first place
      if (!sim.fog.isExplored(this.player, x, y)) score += 2;
      // a side we cannot walk to at all is worth a detour, but not an infinite one: fences come down
      // (asked from open ground beside the castle: its own centre is a footprint and reaches nothing)
      if (exit < 0 || !sim.path.reachable(exit % sim.map.w, (exit - (exit % sim.map.w)) / sim.map.w, cx, cy, false, team)) score += 25;
      // the walk counts: the emptiest side of a base is often the far one, and marching a wave - or worse, a
      // line of towers - right round the enemy to reach it costs more than the tower it was avoiding
      score += (fpLen(x - w.x[main], y - w.y[main]) >> FP_SHIFT) >> 2;
      // and the side it already chose keeps a small edge, or the probe would swap ends every few seconds and
      // nothing - no wave, no tower line - would ever get anywhere
      if (this.probe && fpLen(this.probe.x - x, this.probe.y - y) < fp(3)) score -= PROBE_STICK;
      if (score < bestScore) { bestScore = score; best = { x, y }; }
    }
    this.probe = best; this.probeScore = best ? bestScore : 0; this.probeTick = sim.tick;
    return best;
  }


  // ------------------------------------------------------------ fortification

  /** where the next watchtower goes: the creeping line, the wall, the front of the base, or the outer vein */
  private towerSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const plan = this.plan;
    const standing = s.complete[BuildingType.Tower].length + s.constructing[BuildingType.Tower].length;
    // the diggers are what a raid goes for: a vein being worked that no tower covers gets the next one
    if (standing > 0) { const cover = this.uncoveredVeinSpot(sim, s); if (cover) return cover; }
    if (plan.creep && standing >= 2) return this.creepSpot(sim, s) ?? this.frontTowerSpot(sim, s);
    if (this.ringing() && standing > 0 && this.wallRect) return this.wallTowerSpot(sim, s) ?? this.frontTowerSpot(sim, s);
    // the first one always goes over the vein the bot is actually digging; after that it faces the enemy
    if (standing === 0) return this.mineTowerSpot(sim, s) ?? this.frontTowerSpot(sim, s) ?? (this.wallRect ? this.wallTowerSpot(sim, s) : null);
    return this.frontTowerSpot(sim, s) ?? this.mineTowerSpot(sim, s);
  }

  /**
   * A tower on the side the enemy comes from. Candidates are taken from a sector facing the weak approach and
   * accepted nearest-first, so repeated calls pack that side and the back of the base stays bare - which is
   * the point: the same gold spread evenly round a base defends nothing in particular.
   */
  private frontTowerSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    if (s.castles.length === 0) return null;
    const w = sim.world, main = s.castles[0];
    const aim = this.weakApproach(sim, s);
    if (!aim) return null;
    const cx = w.x[main] >> FP_SHIFT, cy = w.y[main] >> FP_SHIFT;
    let dx = (aim.x >> FP_SHIFT) - cx, dy = (aim.y >> FP_SHIFT) - cy;
    const len = fpLen(fp(dx), fp(dy)) >> FP_SHIFT;
    if (len === 0) return null;
    for (let r = 5; r <= 10; r++) {
      // the arc at this radius, walked from the middle of the sector outwards to either edge. The step along
      // the arc is the perpendicular of the aim vector, (-dy, dx), which needs no trigonometry.
      for (let k = 0; k <= 6; k++) {
        for (const side of k === 0 ? [0] : [-1, 1]) {
          const px = cx + ((dx * r) / len | 0) + side * ((-dy * k) / len | 0);
          const py = cy + ((dy * r) / len | 0) + side * ((dx * k) / len | 0);
          const x = px - 1, y = py - 1; // 2x2 footprint centred on the candidate
          if (this.onWallLine(x, y, 2)) continue;
          if (!canPlaceBuilding(sim, BuildingType.Tower, x, y, this.player)) continue;
          if (!this.catapultLane(sim, BuildingType.Tower, x, y)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  /**
   * Where the line is walking. The soft side the probe found is the way in, not the destination - a line that
   * stopped there would sit in an empty field forever, which is exactly what it used to do. Once the head has
   * reached the approach, the line carries on into the base itself, and since a watchtower shoots buildings as
   * well as men, a line that gets that far takes the base apart on its own.
   */
  private creepAim(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    const w = sim.world;
    const approach = this.weakApproach(sim, s);
    const c = this.enemyCentre(sim, s);
    const centre = { x: fp(c.x + 0.5), y: fp(c.y + 0.5) };
    if (!approach) return centre;
    let bd = s.castles.length ? fpLen(approach.x - w.x[s.castles[0]], approach.y - w.y[s.castles[0]]) : 0x7fffffff;
    for (const t of s.complete[BuildingType.Tower]) {
      const d = fpLen(approach.x - w.x[t], approach.y - w.y[t]);
      if (d < bd) bd = d;
    }
    return bd <= fp(CREEP_STEP + 1) ? centre : approach;
  }

  /** is this spot inside the guns of a castle or tower the bot has seen? */
  private underCastle(sim: Simulation, x: number, y: number): boolean {
    // a tower's reach too: a line that creeps into the guns of the enemy's towers loses a tower a step
    for (const kb of this.known.values()) {
      if ((kb.type !== BuildingType.Castle && kb.type !== BuildingType.Tower) || sim.sameTeam(this.player, kb.owner)) continue;
      const def = BUILDINGS[kb.type as BuildingType];
      if (fpLen(kb.x - x, kb.y - y) < fp(def.range + def.size / 2 + 1.5)) return true;
    }
    return false;
  }

  /** has the line arrived? once the towers are at the enemy's door, the army goes in through it */
  creepArrived(sim: Simulation, s: Snapshot): boolean {
    const w = sim.world;
    const c = this.enemyCentre(sim, s);
    const cx = fp(c.x + 0.5), cy = fp(c.y + 0.5);
    for (const t of s.complete[BuildingType.Tower]) if (fpLen(cx - w.x[t], cy - w.y[t]) < fp(16)) return true;
    return false;
  }

  /**
   * The next tower of a creeping line: one step further towards the weak approach than the tower that is
   * already furthest that way, and inside its cover (CREEP_STEP is under a tower's 7-cell reach, so the new
   * site is built under the guns of the old one). This is the whole plan - the towers do the advancing, and
   * the army is there to keep workers alive while they go up.
   */
  private creepSpot(sim: Simulation, s: Snapshot): { x: number; y: number } | null {
    if (s.castles.length === 0) return null;
    // not while there is fighting on: a worker sent to raise a tower in the open during an attack is a worker
    // thrown away, and the line goes back up the moment it is quiet again
    if (this.threatPos) return null;
    const w = sim.world, main = s.castles[0];
    const aim = this.creepAim(sim, s);
    if (!aim) return null;
    // the head of the line: whichever of our towers stands nearest the thing we are walking towards
    let head = main, bd = fpLen(aim.x - w.x[main], aim.y - w.y[main]);
    for (const t of s.complete[BuildingType.Tower]) {
      const d = fpLen(aim.x - w.x[t], aim.y - w.y[t]);
      if (d < bd) { bd = d; head = t; }
    }
    // a site already going up ahead of the head means the line is still moving; one at a time is enough
    for (const t of s.constructing[BuildingType.Tower]) if (fpLen(aim.x - w.x[t], aim.y - w.y[t]) <= bd) return null;
    if (bd <= fp(2)) return null; // standing on it: there is nothing left to creep towards
    const hx = w.x[head] >> FP_SHIFT, hy = w.y[head] >> FP_SHIFT;
    const dx = (aim.x >> FP_SHIFT) - hx, dy = (aim.y >> FP_SHIFT) - hy;
    const len = fpLen(fp(dx), fp(dy)) >> FP_SHIFT;
    if (len === 0) return null;
    // step towards it, then settle for the nearest ground that will take a tower
    const tx = hx + ((dx * CREEP_STEP) / len | 0), ty = hy + ((dy * CREEP_STEP) / len | 0);
    for (let r = 0; r <= 3; r++) {
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const x = tx + ox - 1, y = ty + oy - 1;
        if (this.onWallLine(x, y, 2)) continue;
        if (!canPlaceBuilding(sim, BuildingType.Tower, x, y, this.player)) continue;
        if (!this.catapultLane(sim, BuildingType.Tower, x, y)) continue;
        // and never inside a castle's reach: a half-built tower under a keep is a hundred gold handed over.
        // The line claims the ground up to the enemy's door, and the army is what goes through it.
        if (this.underCastle(sim, fp(x + 1), fp(y + 1))) continue;
        return { x, y };
      }
    }
    return null;
  }

  /**
   * The one thing the bot is putting gold aside for right now. It saves for one at a time and in this order,
   * because saving for two meant getting neither: the fence would spend what the castle was waiting on, and a
   * bot that walled its one base while the other took a second one lost the game it was defending.
   */
  private savingFor(sim: Simulation, s: Snapshot): Saving | null {
    const p = sim.players[this.player], plan = this.plan;
    const age = this.difficulty >= 1 && p.age < AGE_COUNT - 1 && sim.tick >= plan.ageAfter && s.complete[BuildingType.Forge].length > 0;
    // a catapult plan in the wooden age is not a plan - but one on a single base cannot pay for the age either:
    // it takes its second castle first (the siege plan used to save for the age with one base for eight minutes)
    if (age && plan.ageFirst && s.castles.length + s.constructing[BuildingType.Castle].length >= 2) return 'age';
    // It saves for the first few castles and takes the rest out of surplus: a plan that means to own eight of
    // them would otherwise be saving for a castle from the fourth minute to the end and never buy anything else.
    // (a site already going up is a castle bought, not one still to save for)
    const wantCastle = s.castles.length + s.constructing[BuildingType.Castle].length < Math.min(this.ambition(plan.castles), 3) && s.workforce >= 9
      && sim.tick >= plan.expandAfter && this.findExpansionMine(sim, s) >= 0;
    // Only the plan that lays its town out from the first minute saves for the fence. For everyone else the
    // ring is something they raise out of surplus in the background: made a savings goal, a sixty-section ring
    // swallowed the whole middle of their game and they never bought the age or the army it was funding.
    const walling = plan.wallAfter === 0 && !this.wallComplete && this.wallLimit(sim, s) > 0;
    // That plan takes its second base first, then finishes the ring, and only then spreads further. Left in
    // plain order it kept saving for a third castle and the fence it is named after never got built.
    if (wantCastle && !(walling && s.castles.length >= 2)) return 'castle';
    if (walling) return 'wall';
    if (wantCastle) return 'castle';
    return age ? 'age' : null;
  }

  /** gold the queues leave alone while saving for `saving` */
  private reserveFor(saving: Saving | null, s: Snapshot): number {
    if (!saving) return 0;
    if (saving === 'castle') return this.copyPrice(BuildingType.Castle, s.complete[BuildingType.Castle].length + s.constructing[BuildingType.Castle].length);
    // The age is saved for a little at a time, then all at once: with the purse past AGE_BURST the barracks stop
    // until it is bought. A flat 260 held against a 1060 price left the purse hovering just under it for minutes.
    if (saving === 'age' && s.gold >= AGE_BURST) return AGE_UP.cost + 60;
    return RESERVE[saving];
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
    // a spot outside the ring that can be walked to now, before any fence stands: the test of whether the town
    // has sealed itself in later (see unseal) - chosen now, so a river or the map's edge is never mistaken for
    // the bot's own wall
    const team = sim.team(this.player), mw = sim.map.w;
    const exit = sim.path.nearestFree(cx, cy, 8, true, team);
    this.outside = -1;
    if (exit >= 0) {
      const ex = exit % mw, ey = (exit - ex) / mw;
      const mx = (rect.x0 + rect.x1) >> 1, my = (rect.y0 + rect.y1) >> 1;
      for (const [ox, oy] of [[mx, rect.y0 - 3], [rect.x1 + 3, my], [mx, rect.y1 + 3], [rect.x0 - 3, my]]) {
        if (ox < 1 || oy < 1 || ox >= mw - 1 || oy >= sim.map.h - 1) continue;
        const c = sim.path.nearestFree(ox, oy, 2, true, team);
        if (c < 0) continue;
        if (sim.path.reachable(ex, ey, c % mw, (c - (c % mw)) / mw, true, team)) { this.outside = c; break; }
      }
    }
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
    // a section with nothing but rock, water or the map's edge outside it closes nothing: it costs gold, and
    // as a finished run it takes a gate that opens onto rock
    const open = (x: number, y: number) => !sim.path.isTerrainBlocked(x, y);
    for (let x = r.x0; x <= r.x1; x++) {
      if (open(x, r.y0 - 1) || (x === r.x0 && open(r.x0 - 1, r.y0)) || (x === r.x1 && open(r.x1 + 1, r.y0))) top.push(r.y0 * mw + x);
      if (open(x, r.y1 + 1) || (x === r.x0 && open(r.x0 - 1, r.y1)) || (x === r.x1 && open(r.x1 + 1, r.y1))) bottom.push(r.y1 * mw + x);
    }
    for (let y = r.y0 + 1; y < r.y1; y++) {
      if (open(r.x0 - 1, y)) left.push(y * mw + r.x0);
      if (open(r.x1 + 1, y)) right.push(y * mw + r.x1);
    }
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
    this.wallSideEnd = [];
    for (const side of sides) {
      for (const c of side.cells) out.push(c);
      this.wallSideEnd.push(out.length);
    }
    return out;
  }

  /**
   * How far round the ring this bot means to build right now, as an index into it - 0 when it does not want a
   * fence at all. A turtle wants the whole ring from the start because that is its plan; every other plan
   * wants the threatened side once the enemy has turned up at its base more than once, which is why a fence
   * now appears in most games instead of only in the one match in five that rolled the turtle.
   */
  private wallLimit(sim: Simulation, s: Snapshot): number {
    const plan = this.plan;
    if (plan.wallSides <= 0) return 0;
    // a plan that fences later still fences now if the enemy has already been here twice
    if (sim.tick < plan.wallAfter && this.threatEpisodes < REACTIVE_WALL_ATTACKS) return 0;
    if (!this.wallRect && s.castles.length > 0 && s.workforce >= 8 && s.complete[BuildingType.Barracks].length > 0) {
      this.planWall(sim, s);
    }
    if (this.wallSideEnd.length === 0) return 0;
    const sides = Math.min(plan.wallSides, this.wallSideEnd.length);
    return this.wallSideEnd[sides - 1];
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
    if (s.castles.length === 0 || s.workforce < 8) return;
    if (s.complete[BuildingType.Barracks].length === 0) return; // men before masonry
    if (sim.tick - this.lastWallTick < WALL_INTERVAL) return;
    const limit = this.wallLimit(sim, s);
    if (limit === 0) return;
    // A base always comes before a fence round the one it already has. While the bot is saving for something
    // else the line does not stop, it narrows: one section at a time, and only above the savings, so the purse
    // still grows. Letting a full gang spend during a save was how the siege plan ended up with a fence and no
    // second age - a siege plan with no siege - and stopping the line dead instead left most bots never
    // fencing at all, which is the thing this is all for.
    if (this.unseal(sim, s, out)) return;
    const saving = this.savingFor(sim, s);
    if (saving === 'castle') return;
    const held = saving && saving !== 'wall' ? RESERVE[saving] + WALL_SAVING_MARGIN : 0;
    if (this.wallComplete) {
      if (sim.tick - this.wallScanTick < WALL_RESCAN) return;
      this.wallComplete = false; this.wallIdx = 0; this.wallScanTick = sim.tick;
    }
    const ring = this.wallRing;
    if (ring.length === 0) return;
    this.lastWallTick = sim.tick;
    if (s.gold < (held > 0 ? held : WALL_GOLD_FLOOR)) return;
    const sites = held > 0 ? 1 : WALL_SITES;
    if (s.constructing[BuildingType.Wall].length >= sites) return;

    const mw = sim.map.w, cost = BUILDINGS[BuildingType.Wall].cost;
    let budget = sites - s.constructing[BuildingType.Wall].length;
    let builder = -1, exit = -1;
    const w = sim.world;
    let placed = 0;
    while (this.wallIdx < limit && budget > 0 && s.gold >= cost) {
      const c = ring[this.wallIdx];
      const x = c % mw, y = (c - x) / mw;
      this.wallIdx++;
      // a cell that already carries masonry, or that terrain closed for us, needs no section of ours; one
      // that refuses a fence today - fog it has not walked into, a vein's lane - is left to the next pass
      if (this.holes.has(c) || sim.path.isFootprint(x, y) || sim.path.isTerrainBlocked(x, y)) continue;
      if (!canPlaceBuilding(sim, BuildingType.Wall, x, y, this.player)) continue;
      // a section a digger cannot walk to (boxed in by forest or buildings) is skipped: the sim keeps sending
      // free workers to an unfinished site, and eleven of them once took turns standing at one for twenty minutes
      if (exit < 0) {
        const m = s.castles[0];
        exit = sim.path.nearestFree(w.x[m] >> FP_SHIFT, w.y[m] >> FP_SHIFT, 8, false, sim.team(this.player));
      }
      if (exit >= 0 && !sim.path.reachable(exit % mw, (exit - (exit % mw)) / mw, x, y, false, sim.team(this.player))) continue;
      if (builder < 0) {
        const b = this.builder(sim, s, s.castles[0], 1);
        if (b.length === 0) { this.wallIdx--; break; }
        builder = b[0];
      }
      out.push({ type: CommandType.Build, player: this.player, ids: [builder], v: BuildingType.Wall, x: fp(x), y: fp(y), queue: placed > 0 });
      s.gold -= cost; budget--; placed++;
    }
    if (this.wallIdx >= limit) { this.wallComplete = true; this.wallScanTick = sim.tick; }
  }

  /**
   * Last resort for a town that has walled itself in: every so often the bot checks that a man - and a catapult
   * - can still walk from beside the castle to open ground outside the ring, through its own gates. If not, a
   * worker takes down the section in the middle of the side facing the enemy, and that cell is never fenced
   * again. A hole in the wall is a weakness; a sealed town with its army inside is a lost game.
   */
  private unseal(sim: Simulation, s: Snapshot, out: Command[]): boolean {
    const r = this.wallRect;
    if (!r || this.outside < 0 || this.holes.size >= 4 || s.complete[BuildingType.Wall].length < 12 || sim.tick - this.sealCheck < 20 * 20) return false;
    this.sealCheck = sim.tick;
    const w = sim.world, team = sim.team(this.player), mw = sim.map.w;
    const main = s.castles[0];
    const cx = w.x[main] >> FP_SHIFT, cy = w.y[main] >> FP_SHIFT;
    const gx = this.outside % mw, gy = (this.outside - gx) / mw;
    // the hole goes on the side facing the enemy, where the army wants to leave by
    const e = this.enemyDir(sim, s);
    const dx = e.x - cx, dy = e.y - cy, len = Math.max(1, fpLen(fp(dx), fp(dy)) >> FP_SHIFT);
    const reachOut = Math.max(r.x1 - r.x0, r.y1 - r.y0) >> 1;
    const tx = cx + ((dx * reachOut) / len | 0), ty = cy + ((dy * reachOut) / len | 0);
    let sealed = false;
    for (const heavy of [false, true]) {
      const from = sim.path.nearestFree(cx, cy, 8, heavy, team);
      if (from < 0) continue;
      if (!sim.path.reachable(from % mw, (from - (from % mw)) / mw, gx, gy, heavy, team)) { sealed = true; break; }
    }
    if (!sealed) return false;
    // the section of our fence nearest where the line to the enemy crosses the ring
    let best = -1, bd = 0x7fffffff;
    for (const b of s.complete[BuildingType.Wall]) {
      const [bx, by] = sim.footprintTopLeft(b);
      if (bx !== r.x0 && bx !== r.x1 && by !== r.y0 && by !== r.y1) continue;
      const d = fpLen(fp(bx - tx), fp(by - ty));
      if (d < bd) { bd = d; best = b; }
    }
    if (best < 0) return false;
    const crew = this.builder(sim, s, best, 1);
    if (crew.length === 0) return false;
    const [hx, hy] = sim.footprintTopLeft(best);
    this.holes.add(hy * mw + hx);
    out.push({ type: CommandType.Dismantle, player: this.player, ids: crew, target: best });
    return true;
  }

  // ------------------------------------------------------------ production

  private desiredComposition(sim: Simulation, s: Snapshot): number[] {
    // counters: soldier beats archer and cavalry, archer beats catapult, catapult beats soldier, cavalry runs down catapults and archers
    const seen = this.commander.enemyMix();
    const eS = seen[UnitType.Soldier] + seen[UnitType.Militia];
    const eA = seen[UnitType.Archer];
    const eC = seen[UnitType.Catapult];
    const eV = seen[UnitType.Cavalry];
    const eR = seen[UnitType.Ram];
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
    const need = Math.max(2 + Math.floor(walls / 8) + towers, this.commander.siegeWanted);
    return need > 4 ? 4 : need;
  }

  private production(sim: Simulation, s: Snapshot, out: Command[]) {
    const w = sim.world;
    const desired = this.desiredComposition(sim, s);
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
    // under attack nothing is saved for: every coin goes into men until the base is safe again
    const held = reserve + (this.commander.underAttack ? 0 : this.reserveFor(saving, s));

    // the next age: as soon as the forge stands and the gold is there - siege and cavalry wait behind it
    const me = sim.players[this.player];
    if (this.difficulty >= 1 && me.age < AGE_COUNT - 1 && s.complete[BuildingType.Forge].length > 0 && !this.commander.underAttack) { // the easy bot stays in wood
      const castle = s.castles.find((c) => w.queueLen[c] === 0);
      if (castle !== undefined && s.gold - reserve >= AGE_UP.cost + 60 && sim.validate({ type: CommandType.AgeUp, player: this.player, ids: [castle] }) === null) {
        out.push({ type: CommandType.AgeUp, player: this.player, ids: [castle] });
        s.gold -= AGE_UP.cost;
      }
    }

    // upgrades - but the forge is also the siege workshop: once catapults are unlocked and short, they come first
    const deficit = (t: UnitType) => desired[t] - counts[t] / total;
    const catapultFirst = me.age >= UNITS[UnitType.Catapult].age && s.gold - held >= UNITS[UnitType.Catapult].cost
      && s.popUsed + UNITS[UnitType.Catapult].pop <= s.popCap
      && (deficit(UnitType.Catapult) > 0.1 || counts[UnitType.Catapult] < this.commander.siegeWanted);
    if (this.profile.upgrades && !catapultFirst && s.complete[BuildingType.Forge].length > 0) {
      const forge = s.complete[BuildingType.Forge][0];
      const p = sim.players[this.player];
      const firstGather = p.upgrades[UpgradeId.Gather] === 0;
      if (w.queueLen[forge] === 0 && s.gold > (firstGather ? 160 : 320)) {
        let order: UpgradeId[] = counts[1] >= counts[2]
          ? [UpgradeId.MeleeAttack, UpgradeId.Armor, UpgradeId.RangedAttack, UpgradeId.Gather, UpgradeId.MoveSpeed, UpgradeId.Range]
          : [UpgradeId.RangedAttack, UpgradeId.Range, UpgradeId.Armor, UpgradeId.Gather, UpgradeId.MeleeAttack, UpgradeId.MoveSpeed];
        // towers to crack: range first - a catapult only out-throws a tower with it, and ties without
        if (this.commander.siegeWanted > 0) order = [UpgradeId.Range, ...order.filter((u) => u !== UpgradeId.Range)];
        // and before any of it, the first level of gathering: a hundred gold that is back in half a minute
        if (firstGather) order = [UpgradeId.Gather, ...order.filter((u) => u !== UpgradeId.Gather)];
        for (const u of order) {
          if (p.upgrades[u] >= maxUpgradeLevel(u, p.age)) continue;
          const cost = upgradeCost(u, p.upgrades[u] + 1);
          if (s.gold - held >= cost + (firstGather ? 20 : 80)) { out.push({ type: CommandType.Research, player: this.player, ids: [forge], v: u }); s.gold -= cost; }
          break;
        }
      }
    }

    // stone-throwers: as many as the commander wants for the towers and castles it has seen, queued like rams
    // outside the deficit maths - a counter-pick share of catapults is about enemy soldiers, not masonry
    if (me.age >= UNITS[UnitType.Catapult].age && this.commander.siegeWanted > 0) {
      const have = counts[UnitType.Catapult] + s.complete[BuildingType.Forge].reduce((n, f) => n + (w.queueLen[f] > 0 ? 1 : 0), 0);
      const cat = UNITS[UnitType.Catapult];
      if (have < this.commander.siegeWanted && s.gold - held >= cat.cost && s.popUsed + cat.pop <= s.popCap && s.army.length >= 4) {
        const forge = s.complete[BuildingType.Forge].find((f) => w.queueLen[f] === 0);
        if (forge !== undefined) {
          out.push({ type: CommandType.Train, player: this.player, ids: [forge], v: UnitType.Catapult });
          s.gold -= cat.cost; s.popUsed += cat.pop; counts[UnitType.Catapult]++;
          return;
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
      // at the population ceiling the barracks leave room for the diggers the economy is missing: an army that
      // fills the last seat while the gold line dies of raids is a maxed army with nothing behind it
      const keep = s.popCap >= MAX_POP - 10 && this.workerShort > 0 ? Math.min(this.workerShort, 20) : 0;
      if (s.popUsed + def.pop + keep > s.popCap) continue;
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


  /**
   * Where the idle army waits. A rusher stands well forward, on the road it is about to take; a turtle waits
   * inside its own gate, which is also what makes its towers and castle part of every fight it takes.
   */
  /** the fence ring's rectangle once most of it stands - the commander defends from inside it */
  walledRect(s: Snapshot): Rect | null {
    if (!this.wallRect || this.wallRing.length === 0) return null;
    return s.complete[BuildingType.Wall].length * 10 >= this.wallRing.length * 6 ? this.wallRect : null;
  }

  rallyPoint(sim: Simulation, s: Snapshot): { x: number; y: number } {
    const w = sim.world;
    // a creeping line has to be escorted or it never gets built: its army waits at the tower nearest the enemy,
    // which is also the one whose workers are about to be shot at
    if (this.plan.creep && s.complete[BuildingType.Tower].length > 0) {
      const aim = this.weakApproach(sim, s);
      if (aim) {
        let head = -1, bd = 0x7fffffff;
        for (const t of s.complete[BuildingType.Tower]) {
          const d = fpLen(aim.x - w.x[t], aim.y - w.y[t]);
          if (d < bd) { bd = d; head = t; }
        }
        if (head >= 0) return { x: w.x[head], y: w.y[head] };
      }
    }
    const c = s.castles[0], pct = this.plan.rallyPct;
    return {
      x: w.x[c] + Math.floor(((fp(sim.map.w / 2) - w.x[c]) * pct) / 100),
      y: w.y[c] + Math.floor(((fp(sim.map.h / 2) - w.y[c]) * pct) / 100),
    };
  }






  // ------------------------------------------------------------ micro



  // ------------------------------------------------------------ scouting

}

export function createBots(sim: Simulation): Bot[] {
  const bots: Bot[] = [];
  for (const p of sim.setup.players) if (p.isBot) bots.push(new Bot(p.slot, (p.difficulty ?? 1) as Difficulty, sim.setup.seed));
  return bots;
}

export const _fmt = toFloat;
