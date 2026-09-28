import {
  ABILITIES, AbilityId, BUILDINGS, BuildingState, BuildingType, Command, CommandType, FP_SHIFT, Kind, MAX_POP, Order,
  Simulation, TOWER_CAPACITY, Tile, UNITS, UnitType, UpgradeId, buildingMaxHp, fp, fpLen, garrisonCapacity,
} from '@pocket-of-empire/sim';
import { Force, fightRatio } from './intel';
import { MINUTE, type Difficulty, type KnownBuilding, type Plan, type Profile, type Snapshot } from './plans';
import { Route, Threat, cellCentre, planRoute, waypoints } from './route';

/** What the commander needs from the bot that owns it: who it is, how well it plays, what it has seen. */
export interface BotCtx {
  readonly player: number;
  readonly difficulty: Difficulty;
  readonly profile: Profile;
  readonly plan: Plan;
  readonly known: ReadonlyMap<number, KnownBuilding>;
  rallyPoint(sim: Simulation, s: Snapshot): { x: number; y: number };
  creepArrived(sim: Simulation, s: Snapshot): boolean;
  /** the rectangle of the bot's fence ring once most of it stands, null otherwise */
  walledRect(s: Snapshot): { x0: number; y0: number; x1: number; y1: number } | null;
}

interface Pt { x: number; y: number }

/** an enemy unit the bot has laid eyes on, remembered after it walks back into the fog */
interface Seen { gen: number; type: UnitType; owner: number; x: number; y: number; hp: number; seen: number }

/**
 * A knot of enemy buildings: a castle and everything within reach of it, or a lone outpost. This is the unit a
 * bot thinks about when it attacks - "their second base", "the mine out east" - and each one carries what
 * defends it, so the bot can ask the one question that matters before walking in: do I win this fight?
 */
interface Cluster { x: number; y: number; owner: number; value: number; towers: number; castles: number; anchor: number; seen: number }

const enum Role { Main, Flank, Raid }
const enum Phase { March, Burn, Breach, Stage, Engage, Retreat }
const enum Stop { Stage, Burn, Breach }

interface Squad {
  role: Role;
  phase: Phase;
  since: number;
  units: number[];
  gens: number[];
  /** what it is going for */
  goal: Pt;
  cluster: Cluster | null;
  /** the real objective, while the squad clears a tower that stands on its way there */
  final: { goal: Pt; cluster: Cluster | null } | null;
  route: Route | null;
  /** turn points of the leg it is walking, as map cells, and how far along it is */
  legs: number[];
  leg: number;
  /** what the current leg ends at */
  stop: Stop;
  /** index in route.cells of the fence section or first forest cell the leg ends at */
  stopAt: number;
  stage: Pt | null;
  focus: number;
  focusGen: number;
  orderTick: number;
  orderX: number;
  orderY: number;
  startValue: number;
  /** last tick the squad got measurably closer to its next point, and how close it was */
  progressTick: number;
  progressD: number;
  baits: number;
  baitUntil: number;
  /** incendiary shots on their way, as map cells, with the tick they were thrown */
  shots: number[];
  shotTicks: number[];
  /** retreating, it has turned to fight whatever followed it out */
  turned: boolean;
}

/** the attack a bot has under way: the army's main body, and the party sent round the side */
interface Operation {
  cluster: Cluster; main: Squad; flank: Squad | null; started: number;
  /** the fight ratio the bot launched on: at the staging point it turns back only if what it sees is worse */
  ratio: number;
}

/** enemies this close to one of our buildings (cells) are an attack on the base */
const DEF_RADIUS = 12;
/** cells round a castle that are home ground: enemies here are an attack, defenders never go past it */
const HOME_RADIUS = 16;
/** remembered enemy fighters this close to a castle (and not in their own town) are an attack on its way */
const ALARM_RADIUS = 26;
/** a reserve man further than this from every castle, with no operation to be on, is walked home */
const LEASH = 22;
/** how long an attack on the base has to be over before the defenders stand down */
const DEF_CALM = 20 * 8;
/** how often the bot weighs up whether to attack, in ticks */
const EVAL_TICKS = 20 * 4;
/**
 * The fight ratio (square-law strength, see fightRatio) a bot wants before it walks into a base. A good player
 * does not attack an even fight at the enemy's door - the defender has the towers, the reinforcements and the
 * repair crews - so the harder bots want a clear margin, and the easy one goes on much less.
 */
const LAUNCH_MARGIN = [1.0, 1.3, 1.45];
/** at the staging point, with the defences in plain sight: below this it turns round instead of going in */
const ABORT_MARGIN = [0.55, 0.75, 0.85];
/** mid-fight, below this the squad pulls out rather than dying to the last man */
const RETREAT_RATIO = 0.6;
/** how long a squad waits at its staging point for the rest of the army and for the flank, in ticks */
const STAGE_WAIT = 20 * 30;
/** a squad that has not got closer to its next point for this long plans its way again */
const STUCK_TICKS = 20 * 20;
/** price of a forest cell for a squad that can burn it (open ground is 10 a step) */
const FOREST_COST = 70;
/** price of a fence section for a squad with rams or catapults, and for one without */
const WALL_COST_SIEGE = 25, WALL_COST_FOOT = 45;
/** side of the squares the map is cut into when the bot has to hunt for buildings it has never seen */
const HUNT_BLOCK = 8;
/** a target's record of turning the bot back is forgotten after this long */
const FAIL_MEMORY = 20 * 60 * 4;
/** remembered enemy units are forgotten after this long out of sight */
const MEMORY_TICKS = 20 * 150;
/** the bot has no raids in it before this and no more often than every RAID_EVERY */
const RAID_EVERY = 20 * 150;
/** the smallest army a flank is split off from, in population */
const FLANK_MIN_POP = 24;
/** share of the army's population the flank takes */
const FLANK_PCT = 35;
/** re-issue a squad's movement order at most this often, in ticks */
const REORDER = 60;

const HOLD_TICKS_SHOT = 20 * 3;

export class Commander {
  private readonly ctx: BotCtx;
  private seen = new Map<number, Seen>();
  private op: Operation | null = null;
  private raid: Squad | null = null;
  private lastEval = -100000;
  /** enemies whose start the bot went to and found nothing at */
  private checkedStart = new Set<number>();
  /** per HUNT_BLOCK square of the map: the last tick it was in sight */
  private blockSeen = new Int32Array(0);
  private lastLook = -100000;
  /** targets the route planner found no way to, and when */
  private unreachable = new Map<number, number>();
  /** targets that turned the bot back, how often lately, and when last */
  private failures = new Map<number, { n: number; tick: number }>();
  private lastRaid = -100000;
  /** waves that ended badly: each one makes the next wait for a bigger army */
  attackWave = 0;
  /**
   * Siege engines the army should have with it: stone-throwers in the second age, rams in the first. Buildings
   * are what men are worst at - an archer does half damage to masonry - so the count follows the towers and
   * castles the bot knows of, and goes up when there is nothing it can take without them.
   */
  siegeWanted = 0;
  private blocked = 0;
  /** when the last wave went wrong: the next one waits a while, whatever the arithmetic says */
  private lastFail = -100000;
  // defence
  defending = false;
  /** a real attack on the base, not a scout walking past: production stops saving while this is on */
  underAttack = false;
  private incursionStart = -100000;
  private incursionTick = -100000;
  private lastDefOrder = -100000;
  private lastMilitia = -100000;
  private lastAlarm = -100000;
  private lastLeash = -100000;
  /** an enemy army is on its way (see alarm): tower crews stay in */
  private incoming = false;
  /** after a held attack, the next wave may go before the plan's size to punish a broken enemy */
  private punishUntil = -100000;
  /** the most (in gold) that stood in the base at once during the current attack on it */
  private incursionPeak = 0;
  private manned = new Set<number>();
  private breach = -1;
  private breachGen = 0;
  // micro
  private kiting = new Map<number, number>();
  readonly fleeing = new Map<number, number>();
  // scouting
  private lastScoutTick = -100000;
  private scoutUnit = -1;
  private scoutUntil = 0;
  // per think
  private inSquad = new Set<number>();
  private threatCache: Threat[] = [];
  private rally: Pt = { x: 0, y: 0 };

  /** a harness can listen to the commander's reasoning; nothing in the game sets it */
  debug: ((msg: string) => void) | null = null;

  constructor(ctx: BotCtx) { this.ctx = ctx; }

  /** the one fence section the bot is cutting through, if any: rams are allowed at that one and no other */
  breachTarget(): number { return this.breach; }

  /** defence, the operation under way, the decision to start one, and the reserve at home */
  command(sim: Simulation, s: Snapshot, out: Command[]): void {
    if (s.castles.length === 0) return;
    this.rally = this.ctx.rallyPoint(sim, s);
    this.perceive(sim, s);
    this.threatCache = this.staticThreats(sim);
    this.lookAround(sim);
    this.siegeWanted = this.siegeNeed(sim);
    this.prune(sim);
    const underAttack = this.defend(sim, s, out);
    this.underAttack = underAttack;
    if (this.op) this.runOp(sim, s, out, underAttack);
    if (this.raid) { this.runSquad(sim, s, this.raid, out); if (this.raid && this.raid.units.length === 0) this.raid = null; }
    if (!underAttack) {
      this.considerAttack(sim, s, out);
      this.considerRaid(sim, s, out);
      this.gatherReserve(sim, s, out);
    }
  }

  /** the small stuff, after everything that decides a game has had its orders */
  details(sim: Simulation, s: Snapshot, out: Command[]): void {
    if (s.castles.length === 0) return;
    if (this.ctx.profile.micro) this.micro(sim, s, out);
    if (this.ctx.profile.scout) this.scouting(sim, s, out);
  }

  // ------------------------------------------------------------ what the bot knows

  private perceive(sim: Simulation, s: Snapshot): void {
    const w = sim.world, tick = sim.tick;
    for (const e of s.enemyUnits) {
      this.seen.set(e, { gen: w.gen[e], type: w.type[e] as UnitType, owner: w.owner[e], x: w.x[e], y: w.y[e], hp: w.hp[e], seen: tick });
    }
    for (const [id, u] of this.seen) {
      if (!w.alive[id] || w.gen[id] !== u.gen || w.kind[id] !== Kind.Unit || tick - u.seen > MEMORY_TICKS) this.seen.delete(id);
    }
  }

  /** squads lose the men who died, and the bot's list of who is spoken for is rebuilt */
  private prune(sim: Simulation): void {
    const w = sim.world;
    this.inSquad.clear();
    const keep = (sq: Squad | null) => {
      if (!sq) return;
      let n = 0;
      for (let i = 0; i < sq.units.length; i++) {
        const id = sq.units[i];
        if (!w.alive[id] || w.gen[id] !== sq.gens[i] || w.owner[id] !== this.ctx.player || w.kind[id] !== Kind.Unit) continue;
        sq.units[n] = id; sq.gens[n] = sq.gens[i]; n++;
        this.inSquad.add(id);
      }
      sq.units.length = n; sq.gens.length = n;
    };
    if (this.op) { keep(this.op.main); keep(this.op.flank); }
    keep(this.raid);
    if (this.scoutUnit >= 0 && (!w.alive[this.scoutUnit] || w.owner[this.scoutUnit] !== this.ctx.player)) this.scoutUnit = -1;
  }

  /** the army that is not out on an operation - the home guard, and what the next wave is made from */
  private reserve(s: Snapshot): number[] {
    return s.army.filter((id) => !this.inSquad.has(id) && id !== this.scoutUnit);
  }

  private dmgUp(sim: Simulation, owner: number, type: UnitType): number {
    const p = sim.players[owner];
    return UNITS[type].range > 1 ? p.upgrades[UpgradeId.RangedAttack] : p.upgrades[UpgradeId.MeleeAttack];
  }

  private forceOf(sim: Simulation, ids: readonly number[], f = new Force()): Force {
    const w = sim.world;
    for (const id of ids) f.addUnit(w.type[id] as UnitType, w.hp[id], this.dmgUp(sim, w.owner[id], w.type[id] as UnitType));
    return f;
  }

  private popOf(sim: Simulation, ids: readonly number[]): number {
    let n = 0;
    for (const id of ids) n += UNITS[sim.world.type[id] as UnitType].pop;
    return n;
  }

  /** the reach of a known tower or castle, from its centre, in fixed point */
  private reach(type: number): number {
    const def = BUILDINGS[type as BuildingType];
    return fp(def.range + def.size / 2 + 1);
  }

  private isDefence(type: number): boolean { return type === BuildingType.Tower || type === BuildingType.Castle; }

  /** is this remembered building an enemy's and still worth thinking about */
  private hostile(sim: Simulation, kb: KnownBuilding): boolean {
    return kb.owner >= 0 && !sim.sameTeam(this.ctx.player, kb.owner) && sim.players[kb.owner].alive;
  }

  /** a known tower or castle as a fighter, with what the bot can see of it or has to assume */
  private addDefence(sim: Simulation, kb: KnownBuilding, f: Force, dpsPct = 100): void {
    const w = sim.world;
    const p = sim.players[kb.owner];
    const visible = sim.fog.isVisible(this.ctx.player, kb.x, kb.y) && w.alive[kb.id] && w.gen[kb.id] === kb.gen;
    const hp = visible ? w.hp[kb.id] : buildingMaxHp(kb.type as BuildingType, p.age);
    // a player mans a tower the moment an army turns up, so an unseen one is assumed half manned
    const crew = kb.type === BuildingType.Tower ? (visible ? w.carry[kb.id] : 2) : 0;
    if (visible && w.state[kb.id] !== BuildingState.Complete) { f.addStructure(kb.type as BuildingType, p.age); return; }
    f.addDefence(kb.type as BuildingType, hp, p.upgrades[UpgradeId.RangedAttack], p.age, crew, dpsPct);
  }

  /**
   * Can these units take towers apart from outside their reach? Stone-throwers with the range upgrade out-throw
   * a tower and a castle, so against a force that brings enough of them the enemy's masonry is a target and not
   * a fighter - it has to be knocked down, but it barely shoots back. Two engines at least, or it is one lucky
   * shot at a time.
   */
  private outranges(sim: Simulation, ids: readonly number[]): boolean {
    if (sim.players[this.ctx.player].upgrades[UpgradeId.Range] < 1) return false;
    let cats = 0;
    for (const id of ids) if (sim.world.type[id] === UnitType.Catapult) cats++;
    return cats >= 2;
  }

  /** every tower and castle the bot knows of, as ground to keep out of when planning a route */
  private staticThreats(sim: Simulation): Threat[] {
    const out: Threat[] = [];
    for (const kb of this.ctx.known.values()) {
      if (!this.isDefence(kb.type) || !this.hostile(sim, kb)) continue;
      const def = BUILDINGS[kb.type as BuildingType];
      out.push({ x: kb.x >> FP_SHIFT, y: kb.y >> FP_SHIFT, r: def.range + (def.size >> 1) + 2, w: kb.type === BuildingType.Castle ? 30 : 22 });
    }
    return out;
  }

  private siegeNeed(sim: Simulation): number {
    if (this.ctx.difficulty === 0) return 0;
    // a castle alone asks for one engine; every three towers ask for another
    let towers = 0, castles = 0;
    for (const t of this.threatCache) { if (t.w >= 30) castles++; else towers++; }
    if (towers + castles === 0) return 0;
    const want = 1 + ((towers / 3) | 0) + this.blocked + (this.ctx.plan.siegeFirst ? 1 : 0);
    return want > 4 ? 4 : want;
  }

  /** the enemy's army as last seen, as blobs a raid or a flank walks round */
  private armyThreats(): Threat[] {
    const out: Threat[] = [];
    for (const u of this.seen.values()) {
      if (u.type === UnitType.Worker) continue;
      out.push({ x: u.x >> FP_SHIFT, y: u.y >> FP_SHIFT, r: 7, w: 4 });
    }
    return out;
  }

  /** remembered enemy fighters within `r` of a point, added to `f` */
  private enemyArmyNear(x: number, y: number, r: number, f: Force, sim: Simulation): Force {
    for (const u of this.seen.values()) {
      if (u.type === UnitType.Worker) continue;
      if (fpLen(u.x - x, u.y - y) > r) continue;
      f.addUnit(u.type, u.hp, this.dmgUp(sim, u.owner, u.type));
    }
    return f;
  }

  /** towers and castles whose guns reach a point, added to `f`; returns how many */
  private defencesCovering(sim: Simulation, x: number, y: number, f: Force, slack = 0): number {
    let n = 0;
    for (const kb of this.ctx.known.values()) {
      if (!this.isDefence(kb.type) || !this.hostile(sim, kb)) continue;
      if (fpLen(kb.x - x, kb.y - y) > this.reach(kb.type) + slack) continue;
      this.addDefence(sim, kb, f); n++;
    }
    return n;
  }

  /** towers and castles whose guns reach any of these points, each counted once, added to `f` */
  private defencesCoveringAny(sim: Simulation, pts: readonly Pt[], f: Force, slack = 0): number {
    let n = 0;
    for (const kb of this.ctx.known.values()) {
      if (!this.isDefence(kb.type) || !this.hostile(sim, kb)) continue;
      const r = this.reach(kb.type) + slack;
      if (!pts.some((p) => fpLen(kb.x - p.x, kb.y - p.y) <= r)) continue;
      this.addDefence(sim, kb, f); n++;
    }
    return n;
  }

  /** the enemy's buildings grouped into bases and outposts */
  private clusters(sim: Simulation, s: Snapshot): Cluster[] {
    const out: Cluster[] = [];
    const castles: KnownBuilding[] = [], rest: KnownBuilding[] = [];
    const w0 = sim.world;
    for (const kb of this.ctx.known.values()) {
      if (!this.hostile(sim, kb)) continue;
      // a building already knocked down is no target, even before the bot has walked back to see the rubble
      if (!w0.alive[kb.id] || w0.gen[kb.id] !== kb.gen || w0.kind[kb.id] !== Kind.Building) continue;
      if (kb.type === BuildingType.Castle) castles.push(kb); else if (kb.type !== BuildingType.Wall) rest.push(kb);
    }
    castles.sort((a, b) => a.id - b.id);
    rest.sort((a, b) => a.id - b.id);
    for (const c of castles) out.push({ x: c.x, y: c.y, owner: c.owner, value: 900, towers: 0, castles: 1, anchor: c.id, seen: c.lastSeen });
    for (const kb of rest) {
      let best: Cluster | null = null, bd = fp(14);
      for (const c of out) { const d = fpLen(c.x - kb.x, c.y - kb.y); if (d < bd) { bd = d; best = c; } }
      if (!best) { best = { x: kb.x, y: kb.y, owner: kb.owner, value: 0, towers: 0, castles: 0, anchor: kb.id, seen: kb.lastSeen }; out.push(best); }
      if (kb.lastSeen > best.seen) best.seen = kb.lastSeen;
      best.value += kb.type === BuildingType.Mine ? 300 : kb.type === BuildingType.Barracks || kb.type === BuildingType.Forge ? 200 : kb.type === BuildingType.Tower ? 100 : 60;
      if (kb.type === BuildingType.Tower) best.towers++;
    }
    if (out.length > 0) return out;
    // nothing seen yet: every enemy started with a castle where the setup put them
    const w = sim.world, main = s.castles[0];
    let bp = -1, bd = 0x7fffffff;
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (!p.alive || sim.sameTeam(this.ctx.player, i) || this.checkedStart.has(i)) continue;
      const d = fpLen(fp(p.startX) - w.x[main], fp(p.startY) - w.y[main]);
      if (d < bd) { bd = d; bp = i; }
    }
    if (bp >= 0) { out.push({ x: fp(sim.players[bp].startX + 0.5), y: fp(sim.players[bp].startY + 0.5), owner: bp, value: 900, towers: 0, castles: 1, anchor: -1, seen: -100000 }); return out; }
    // Every start has been looked at and still somebody is alive: they have built somewhere the bot has not
    // seen. It goes hunting - the patch of map it has had no eyes on for longest, nearest first on a tie - rather
    // than walking to the same empty start until the match runs out.
    let enemy = -1;
    for (let i = 0; i < sim.players.length; i++) if (sim.players[i].alive && !sim.sameTeam(this.ctx.player, i)) { enemy = i; break; }
    if (enemy < 0) return out;
    this.lookAround(sim, true);
    const bw = (sim.map.w + HUNT_BLOCK - 1) / HUNT_BLOCK | 0, bh = (sim.map.h + HUNT_BLOCK - 1) / HUNT_BLOCK | 0;
    let bb = -1, bt = 0x7fffffff, bdv = 0x7fffffff;
    for (let b = 0; b < bw * bh; b++) {
      const t = this.blockSeen[b];
      const bx = b % bw, by = (b - bx) / bw;
      const cx = Math.min(sim.map.w - 1, bx * HUNT_BLOCK + (HUNT_BLOCK >> 1)), cy = Math.min(sim.map.h - 1, by * HUNT_BLOCK + (HUNT_BLOCK >> 1));
      if (sim.path.nearestFree(cx, cy, HUNT_BLOCK >> 1) < 0) continue; // all rock and water: nothing can stand there
      const d = fpLen(fp(cx) - w.x[main], fp(cy) - w.y[main]);
      if (t < bt || (t === bt && d < bdv)) { bt = t; bdv = d; bb = b; }
    }
    if (bb >= 0) {
      const bx = bb % bw, by = (bb - bx) / bw;
      const cx = Math.min(sim.map.w - 1, bx * HUNT_BLOCK + (HUNT_BLOCK >> 1)), cy = Math.min(sim.map.h - 1, by * HUNT_BLOCK + (HUNT_BLOCK >> 1));
      out.push({ x: fp(cx + 0.5), y: fp(cy + 0.5), owner: enemy, value: 200, towers: 0, castles: 0, anchor: -2 - bb, seen: -100000 });
    }
    return out;
  }

  /** when each patch of the map was last in sight: where the bot has not looked lately is where to hunt */
  private lookAround(sim: Simulation, force = false): void {
    if (!force && (sim.tick - this.lastLook < 40 || this.checkedStart.size === 0)) return;
    if (sim.tick === this.lastLook) return;
    this.lastLook = sim.tick;
    const bw = (sim.map.w + HUNT_BLOCK - 1) / HUNT_BLOCK | 0, bh = (sim.map.h + HUNT_BLOCK - 1) / HUNT_BLOCK | 0;
    if (this.blockSeen.length !== bw * bh) this.blockSeen = new Int32Array(bw * bh).fill(-100000);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const x = fp(Math.min(sim.map.w - 1, bx * HUNT_BLOCK + (HUNT_BLOCK >> 1)) + 0.5), y = fp(Math.min(sim.map.h - 1, by * HUNT_BLOCK + (HUNT_BLOCK >> 1)) + 0.5);
      if (sim.fog.isVisible(this.ctx.player, x, y)) this.blockSeen[by * bw + bx] = sim.tick;
    }
  }

  /**
   * What stands between an army and a cluster: its towers and castle, the enemy soldiers seen round it, and half
   * of any seen further out - those walk over to help.
   */
  private clusterDefence(sim: Simulation, c: Cluster, outranged = false): Force {
    const f = new Force();
    let statics = 0;
    // towers and a castle that the siege out-throws still have to be cut through, but hardly shoot back
    const pct = outranged ? 25 : 100;
    for (const kb of this.ctx.known.values()) {
      if (!this.isDefence(kb.type) || !this.hostile(sim, kb)) continue;
      if (fpLen(kb.x - c.x, kb.y - c.y) > fp(12)) continue;
      this.addDefence(sim, kb, f, pct); statics++;
    }
    // a start nobody has looked at yet still has its castle
    if (statics === 0 && c.anchor < 0) f.addDefence(BuildingType.Castle, buildingMaxHp(BuildingType.Castle, sim.players[c.owner].age), 0, sim.players[c.owner].age, 0);
    // an army the bot has not seen is still there: every hall it knows of stands for a few men at home
    for (const kb of this.ctx.known.values()) {
      if (kb.type !== BuildingType.Barracks || !this.hostile(sim, kb) || fpLen(kb.x - c.x, kb.y - c.y) > fp(16)) continue;
      const up = this.dmgUp(sim, kb.owner, UnitType.Soldier);
      f.addUnit(UnitType.Soldier, UNITS[UnitType.Soldier].hp, up); f.addUnit(UnitType.Soldier, UNITS[UnitType.Soldier].hp, up);
      f.addUnit(UnitType.Archer, UNITS[UnitType.Archer].hp, up); f.addUnit(UnitType.Archer, UNITS[UnitType.Archer].hp, up);
    }
    const near = new Force(), far = new Force();
    for (const u of this.seen.values()) {
      if (u.type === UnitType.Worker) continue;
      const d = fpLen(u.x - c.x, u.y - c.y);
      if (d <= fp(18)) near.addUnit(u.type, u.hp, this.dmgUp(sim, u.owner, u.type));
      else if (d <= fp(45)) far.addUnit(u.type, u.hp >> 1, this.dmgUp(sim, u.owner, u.type));
    }
    f.add(near); f.add(far);
    return f;
  }

  // ------------------------------------------------------------ defence

  /**
   * An attack on the base. The bot weighs what came against what it has at home - the reserve, plus the towers
   * and castle that reach the fight - and either meets it or falls back under the castle's guns and lets the
   * attacker walk into them, calling the army home and arming the towers while it does. It does not chase: once
   * the enemy is off its ground, the defenders go back to their post.
   */
  private defend(sim: Simulation, s: Snapshot, out: Command[]): boolean {
    const w = sim.world, me = this.ctx.player, tick = sim.tick;
    const raiders: number[] = [];
    let sx = 0, sy = 0;
    for (const e of s.enemyUnits) {
      const t = w.type[e];
      // a worker is only an attack when it is building something at our door (a tower rush)
      if (t === UnitType.Worker && w.order[e] !== Order.Build) continue;
      // an enemy standing in its own town, under its own guns, is not attacking anyone
      if (this.underGuns(w.x[e], w.y[e], 0)) continue;
      // a stone-thrower or a ram within reach of anything of ours - the fence and the towers included - is a
      // siege, however far from the castle it stands: that is exactly where it stands to take the walls apart
      const siege = t === UnitType.Catapult || t === UnitType.Ram;
      if (!this.atHome(sim, s, w.x[e], w.y[e]) && !(siege && this.nearAnyBuilding(sim, s, w.x[e], w.y[e], 10))) continue;
      raiders.push(e); sx += w.x[e]; sy += w.y[e];
    }
    // enemy towers going up in our base are knocked down before they are finished
    const sites: number[] = [];
    for (const b of s.enemyBuildings) {
      if (w.type[b] !== BuildingType.Tower && w.type[b] !== BuildingType.Castle) continue;
      for (const c of s.castles) if (fpLen(w.x[b] - w.x[c], w.y[b] - w.y[c]) < fp(15)) { sites.push(b); break; }
    }
    this.alarm(sim, s, out);
    this.leash(sim, s, out);
    if (raiders.length === 0 && sites.length === 0) {
      if (this.defending && tick - this.incursionTick > DEF_CALM) {
        this.defending = false;
        // held: if what came is broken and ours is standing, go and make them pay for it while they are weak
        const mine = this.forceOf(sim, this.reserve(s));
        const theirs = this.enemyArmyNear(this.rally.x, this.rally.y, fp(60), new Force(), sim);
        // (only after a real attack: a scout walking past is not an army broken on our walls)
        if (this.ctx.difficulty >= 1 && this.incursionPeak >= 400 && mine.pop >= 12 && fightRatio(mine, theirs) >= 1.5) this.punishUntil = tick + 20 * 30;
        this.incursionPeak = 0;
        const back = this.reserve(s).filter((id) => !this.fleeing.has(id));
        if (back.length) out.push({ type: CommandType.AttackMove, player: me, ids: back, x: this.rally.x, y: this.rally.y });
      }
      this.releaseCrews(sim, out);
      this.returnWorkers(sim, s, out);
      return false;
    }
    if (!this.defending) { this.defending = true; this.incursionStart = tick; this.incursionPeak = 0; }
    this.incursionTick = tick;
    const came = this.valueOf(sim, raiders);
    if (came > this.incursionPeak) this.incursionPeak = came;
    let cx = raiders.length ? (sx / raiders.length) | 0 : w.x[sites[0]];
    let cy = raiders.length ? (sy / raiders.length) | 0 : w.y[sites[0]];

    const enemy = this.forceOf(sim, raiders);
    // a ram has no answer to a man: it stays home and out of the way while the others fight
    const reserve = this.reserve(s).filter((id) => !this.fleeing.has(id) && w.type[id] !== UnitType.Ram);
    const home = this.forceOf(sim, reserve.filter((id) => fpLen(w.x[id] - cx, w.y[id] - cy) < fp(30)));
    const ownDefence = this.ownDefencesCovering(sim, s, cx, cy, home);
    const ratio = fightRatio(home, enemy);

    // The army out on an operation comes back only for a real attack: one soldier at the gate is the towers'
    // and the militia's business, not a reason to walk a wave home from the enemy's door. It stays out, too,
    // when it is about to take the enemy's last castle - a base for a base is a trade worth making.
    const castleHit = raiders.some((e) => s.castles.some((c) => fpLen(w.x[e] - w.x[c], w.y[e] - w.y[c]) < fp(10)));
    if (this.op && !this.nearlyWon(sim, this.op)) {
      const opValue = this.valueOf(sim, this.op.main.units) + (this.op.flank ? this.valueOf(sim, this.op.flank.units) : 0);
      const serious = this.valueOf(sim, raiders) * 100 >= opValue * 30 || castleHit && ratio < 1;
      if (serious && (ratio < 0.9 || (castleHit && ratio < 1.3))) {
        this.recall(sim, this.op.main, cx, cy, out);
        if (this.op.flank) this.recall(sim, this.op.flank, cx, cy, out);
        this.op = null; this.attackWave++;
      }
    }
    if (this.raid && ratio < 1 && enemy.count >= 2) { this.recall(sim, this.raid, cx, cy, out); this.raid = null; }

    // the reserve: meet it when that is a fight it wins, otherwise wait for it under its own guns
    const react = tick - this.incursionStart >= this.ctx.profile.reactionTicks;
    if (react && reserve.length > 0 && tick - this.lastDefOrder >= Math.max(this.ctx.profile.reactionTicks, 30)) {
      this.lastDefOrder = tick;
      if (sites.length > 0 && raiders.length < 3) {
        out.push({ type: CommandType.Attack, player: me, ids: reserve, target: sites[0] });
      } else {
        let tx = cx, ty = cy;
        if (ownDefence === 0 && ratio < 1.25) {
          // Not a fight it clearly wins out in the open: it waits where its own guns join in, which is the
          // whole point of having built them - the nearest tower between it and the attack, or the castle -
          // and lets the attacker come to it. Walking out to an even fight threw away a turtle's army.
          const anchor = this.nearestDefence(sim, s, cx, cy);
          const dx = cx - w.x[anchor], dy = cy - w.y[anchor], l = fpLen(dx, dy) || 1;
          tx = w.x[anchor] + Math.floor((dx * fp(2)) / l); ty = w.y[anchor] + Math.floor((dy * fp(2)) / l);
        } else {
          // siege engines first: a catapult in the base is worth more than three men
          let bd = 0x7fffffff;
          for (const e of raiders) {
            const t = w.type[e];
            if (t !== UnitType.Catapult && t !== UnitType.Ram) continue;
            const d = fpLen(w.x[e] - cx, w.y[e] - cy);
            if (d < bd) { bd = d; tx = w.x[e]; ty = w.y[e]; }
          }
        }
        // A walled town fights from behind its fence: the attackers have to cut through it, and the archers
        // inside shoot over it the whole time. The point is pulled inside the ring - never out through the gate,
        // except to go for siege engines working on the wall from outside, when that is a fight it wins.
        const ring = this.ctx.walledRect(s);
        const sally = ratio >= 0.9 && raiders.some((e) => w.type[e] === UnitType.Catapult || w.type[e] === UnitType.Ram);
        if (ring && !sally) {
          const inx0 = fp(ring.x0 + 2), iny0 = fp(ring.y0 + 2), inx1 = fp(ring.x1 - 1), iny1 = fp(ring.y1 - 1);
          if (tx < inx0) tx = inx0; if (tx > inx1) tx = inx1; if (ty < iny0) ty = iny0; if (ty > iny1) ty = iny1;
        }
        // never further out than home: the point is clamped to the ground the castles hold (a little further
        // when it is siege engines being gone after)
        const c = this.nearestCastle(sim, s, tx, ty);
        const dx = tx - w.x[c], dy = ty - w.y[c], l = fpLen(dx, dy);
        const lim = fp(sally ? HOME_RADIUS + 6 : HOME_RADIUS);
        if (l > lim) { tx = w.x[c] + Math.floor((dx * lim) / l); ty = w.y[c] + Math.floor((dy * lim) / l); }
        cx = tx; cy = ty;
        out.push({ type: CommandType.AttackMove, player: me, ids: reserve, x: tx, y: ty });
      }
    }
    // no army to speak of and a tower going up: the workers pull it down while it is still a frame
    if (sites.length > 0 && reserve.length < 3) {
      const site = sites[0];
      if (w.state[site] !== BuildingState.Complete) {
        const crew = s.workers.filter((id) => fpLen(w.x[id] - w.x[site], w.y[id] - w.y[site]) < fp(20)).slice(0, 6);
        if (crew.length >= 2 && tick % 60 < this.ctx.profile.thinkInterval) out.push({ type: CommandType.Attack, player: me, ids: crew, target: site });
      }
    }
    // Militia costs nothing, so the only question is whether this castle is in a fight it is losing: more of
    // them than of us within a few cells of the walls
    if (tick - this.lastMilitia > 20 * 5) {
      for (const c of s.castles) {
        if (w.abilityCd[c] > 0 || w.state[c] !== BuildingState.Complete) continue;
        let foes = 0, friends = 0;
        for (const e of raiders) if (fpLen(w.x[e] - w.x[c], w.y[e] - w.y[c]) < fp(9)) foes++;
        if (foes < 2) continue;
        for (const id of s.army) if (fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]) < fp(9)) friends++;
        if (foes > friends) { out.push({ type: CommandType.Ability, player: me, ids: [c], v: AbilityId.Militia }); this.lastMilitia = tick; break; }
      }
    }
    this.manTowers(sim, s, raiders, out);
    this.fleeWorkers(sim, s, raiders, out);
    // a lone scout at the edge of town does not call the whole army home or stop the next wave
    return sites.length > 0 || enemy.count >= 3 || ratio < 1.5;
  }

  private nearAnyBuilding(sim: Simulation, s: Snapshot, x: number, y: number, r: number): boolean {
    const w = sim.world;
    for (const b of s.buildings) if (fpLen(x - w.x[b], y - w.y[b]) < fp(r)) return true;
    return false;
  }

  /** is a point inside the bot's home ground: near a castle, or near a building that is part of a base? */
  private atHome(sim: Simulation, s: Snapshot, x: number, y: number): boolean {
    const w = sim.world;
    for (const c of s.castles) if (fpLen(x - w.x[c], y - w.y[c]) < fp(HOME_RADIUS)) return true;
    for (const b of s.buildings) {
      // a fence line or a tower out at the front is not the base: enemies walking past those, or standing in
      // their own town next to our forward tower, must not call the army home
      const bt = w.type[b];
      if (bt === BuildingType.Wall || bt === BuildingType.Tower) continue;
      if (fpLen(x - w.x[b], y - w.y[b]) < fp(DEF_RADIUS)) return true;
    }
    return false;
  }

  /**
   * An army on its way. The bot remembers what it has seen, so a wave walking across the middle of the map is
   * known about before it reaches the gate: the towers on that side are manned, and an operation that left the
   * base with nobody to hold it is called home if what is coming would win there.
   */
  private alarm(sim: Simulation, s: Snapshot, out: Command[]): void {
    const w = sim.world, tick = sim.tick;
    if (tick - this.lastAlarm < 20 * 2) return;
    this.lastAlarm = tick;
    const coming = new Force();
    let cx = 0, cy = 0, n = 0;
    for (const u of this.seen.values()) {
      if (u.type === UnitType.Worker || tick - u.seen > 20 * 6) continue;
      if (this.underGuns(u.x, u.y, 0)) continue;
      let near = false;
      for (const c of s.castles) if (fpLen(u.x - w.x[c], u.y - w.y[c]) < fp(ALARM_RADIUS)) { near = true; break; }
      if (!near) continue;
      coming.addUnit(u.type, u.hp, this.dmgUp(sim, u.owner, u.type));
      cx += u.x; cy += u.y; n++;
    }
    this.incoming = n >= 4;
    if (n < 4) return;
    cx = (cx / n) | 0; cy = (cy / n) | 0;
    const home = this.forceOf(sim, this.reserve(s));
    const c = this.nearestCastle(sim, s, cx, cy);
    this.ownDefencesCovering(sim, s, w.x[c], w.y[c], home);
    if (this.op && !this.nearlyWon(sim, this.op) && fightRatio(home, coming) < 1) {
      this.recall(sim, this.op.main, w.x[c], w.y[c], out);
      if (this.op.flank) this.recall(sim, this.op.flank, w.x[c], w.y[c], out);
      this.op = null; this.attackWave++;
    }
    // crews into the towers facing it before it arrives, not when it is already shooting
    const near: number[] = [];
    for (const t of s.complete[BuildingType.Tower]) if (fpLen(w.x[t] - cx, w.y[t] - cy) < fp(18)) near.push(t);
    if (near.length) this.crew(sim, s, near, out);
  }

  /**
   * The home guard does not chase. A reserve man more than LEASH cells from every castle, with no operation to
   * be on, walks back - with a move, not an attack-move, or he stops for the first fight on the way and stays.
   */
  private leash(sim: Simulation, s: Snapshot, out: Command[]): void {
    if (sim.tick - this.lastLeash < 40) return;
    this.lastLeash = sim.tick;
    const w = sim.world;
    const far = this.reserve(s).filter((id) => {
      if (this.fleeing.has(id)) return false;
      for (const c of s.castles) if (fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]) < fp(LEASH)) return false;
      return true;
    });
    if (far.length) out.push({ type: CommandType.Move, player: this.ctx.player, ids: far, x: this.rally.x, y: this.rally.y });
  }

  /** our own towers and castles that reach a point, added to `f`; returns how many */
  private ownDefencesCovering(sim: Simulation, s: Snapshot, x: number, y: number, f: Force): number {
    const w = sim.world, p = sim.players[this.ctx.player];
    let n = 0;
    for (const type of [BuildingType.Tower, BuildingType.Castle]) {
      for (const b of s.complete[type]) {
        if (fpLen(w.x[b] - x, w.y[b] - y) > this.reach(type) + fp(1)) continue;
        f.addDefence(type, w.hp[b], p.upgrades[UpgradeId.RangedAttack], p.age, type === BuildingType.Tower ? w.carry[b] : 0);
        n++;
      }
    }
    return n;
  }

  /** our tower or castle closest to a point: where the reserve stands to meet an attack under its own guns */
  private nearestDefence(sim: Simulation, s: Snapshot, x: number, y: number): number {
    const w = sim.world;
    let best = this.nearestCastle(sim, s, x, y), bd = fpLen(w.x[best] - x, w.y[best] - y);
    for (const t of s.complete[BuildingType.Tower]) {
      const d = fpLen(w.x[t] - x, w.y[t] - y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  private nearestCastle(sim: Simulation, s: Snapshot, x: number, y: number): number {
    const w = sim.world;
    let best = s.castles[0], bd = 0x7fffffff;
    for (const c of s.castles) { const d = fpLen(w.x[c] - x, w.y[c] - y); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  /** is the operation about to take the enemy's last castle? then it is worth a base of ours */
  private nearlyWon(sim: Simulation, op: Operation): boolean {
    const w = sim.world;
    if (op.main.phase !== Phase.Engage) return false;
    const c = op.cluster.anchor;
    if (c < 0 || !w.alive[c] || w.kind[c] !== Kind.Building) return false;
    return sim.players[op.cluster.owner].castles <= 1 && w.hp[c] * 100 < w.maxHp[c] * 35;
  }

  /**
   * Three workers inside take a tower from 15 damage a shot to 39 - the difference between a tower that annoys
   * an army and one that beats it. Any bot with towers mans the ones the attack is walking into.
   */
  private manTowers(sim: Simulation, s: Snapshot, raiders: number[], out: Command[]): void {
    const w = sim.world;
    const threatened = s.complete[BuildingType.Tower].filter((t) => raiders.some((e) => fpLen(w.x[e] - w.x[t], w.y[e] - w.y[t]) < fp(11)));
    if (threatened.length) this.crew(sim, s, threatened, out);
  }

  /**
   * Send the nearest free diggers into these towers, two towers per think at most - and never more than a third
   * of the workforce in towers altogether: a turtle with six towers under steady pressure once had eighteen
   * diggers inside and three at the gold, and lost the game on income rather than on its walls.
   */
  private crew(sim: Simulation, s: Snapshot, towers: number[], out: Command[]): void {
    const w = sim.world;
    let crews = 0, inside = 0;
    for (const t of s.complete[BuildingType.Tower]) inside += w.carry[t];
    let room = Math.max(3, ((s.workforce * 30) / 100) | 0) - inside;
    const taken = new Set<number>();
    for (const t of towers) {
      if (crews >= 2 || room <= 0) break;
      if (w.carry[t] >= TOWER_CAPACITY) continue;
      const cands = s.workers.filter((id) => !taken.has(id) && w.order[id] !== Order.Build && w.order[id] !== Order.Garrison && fpLen(w.x[id] - w.x[t], w.y[id] - w.y[t]) < fp(18));
      cands.sort((a, b) => fpLen(w.x[a] - w.x[t], w.y[a] - w.y[t]) - fpLen(w.x[b] - w.x[t], w.y[b] - w.y[t]) || a - b);
      const crew = cands.slice(0, Math.min(TOWER_CAPACITY - w.carry[t], room));
      if (crew.length === 0) continue;
      room -= crew.length;
      for (const id of crew) { taken.add(id); this.fleeing.delete(id); }
      out.push({ type: CommandType.Garrison, player: this.ctx.player, ids: crew, target: t });
      this.manned.add(t);
      crews++;
    }
  }

  /** crews come out once it has been quiet for a while and nothing the bot has seen is on its way */
  private releaseCrews(sim: Simulation, out: Command[]): void {
    const w = sim.world;
    if (this.manned.size === 0 || sim.tick - this.incursionTick < 20 * 10 || this.incoming) return;
    for (const t of this.manned) if (w.alive[t] && w.kind[t] === Kind.Building && w.carry[t] > 0) out.push({ type: CommandType.Ungarrison, player: this.ctx.player, ids: [t] });
    this.manned.clear();
  }

  /**
   * A digger runs when soldiers are on top of him and none of ours are - decided man by man where he stands, not
   * from how big the army is somewhere else on the map. He goes into a tower or a mine close by if one has room,
   * and otherwise away from the enemy rather than to the castle, which is usually where the attack is.
   */
  private fleeWorkers(sim: Simulation, s: Snapshot, raiders: number[], out: Command[]): void {
    if (!this.ctx.profile.micro) return;
    const w = sim.world, me = this.ctx.player;
    const away: number[] = [];
    let ax = 0, ay = 0;
    const shelters = s.complete[BuildingType.Tower].concat(s.complete[BuildingType.Mine]);
    const room = new Map<number, number>();
    for (const b of shelters) room.set(b, garrisonCapacity(w.type[b] as BuildingType) - w.carry[b]);
    for (const wk of s.workers) {
      if (this.fleeing.has(wk) || w.order[wk] === Order.Garrison || w.order[wk] === Order.Attack) continue;
      // one sent to mend a wall or finish a site where the enemy stands is sent to die: the sim hands out those
      // jobs on its own, so the bot pulls him back while soldiers are within reach of the job, guard or no guard
      const job = w.order[wk] === Order.Repair || w.order[wk] === Order.Build;
      let threat = -1, td = fp(job ? 7 : 5);
      for (const e of raiders) {
        if (w.type[e] === UnitType.Worker) continue;
        const d = fpLen(w.x[e] - w.x[wk], w.y[e] - w.y[wk]);
        if (d < td) { td = d; threat = e; }
      }
      if (threat < 0) continue;
      if (!job && s.army.some((id) => fpLen(w.x[id] - w.x[wk], w.y[id] - w.y[wk]) < fp(6))) continue;
      let shelter = -1, sd = fp(8);
      for (const b of shelters) {
        if ((room.get(b) ?? 0) <= 0) continue;
        const d = fpLen(w.x[b] - w.x[wk], w.y[b] - w.y[wk]);
        if (d < sd) { sd = d; shelter = b; }
      }
      this.fleeing.set(wk, sim.tick + 20 * 10);
      if (shelter >= 0) {
        room.set(shelter, (room.get(shelter) ?? 0) - 1);
        out.push({ type: CommandType.Garrison, player: me, ids: [wk], target: shelter });
        if (w.type[shelter] === BuildingType.Tower) this.manned.add(shelter);
        continue;
      }
      away.push(wk); ax += w.x[threat]; ay += w.y[threat];
    }
    if (away.length === 0) return;
    // one order for the lot: away from where the threats stand, eight cells out, kept on the map
    let mx = 0, my = 0;
    for (const id of away) { mx += w.x[id]; my += w.y[id]; }
    mx = (mx / away.length) | 0; my = (my / away.length) | 0;
    ax = (ax / away.length) | 0; ay = (ay / away.length) | 0;
    const dx = mx - ax, dy = my - ay, l = fpLen(dx, dy) || 1;
    const lim = fp(2), maxX = fp(sim.map.w - 2), maxY = fp(sim.map.h - 2);
    let x = mx + Math.floor((dx * fp(8)) / l), y = my + Math.floor((dy * fp(8)) / l);
    if (x < lim) x = lim; if (y < lim) y = lim; if (x > maxX) x = maxX; if (y > maxY) y = maxY;
    out.push({ type: CommandType.Move, player: me, ids: away, x, y });
  }

  /** a digger who ran goes back to work once no enemy is near him - not on a fixed timer */
  private returnWorkers(sim: Simulation, s: Snapshot, out: Command[]): void {
    const w = sim.world;
    const back: number[] = [];
    for (const [id, until] of this.fleeing) {
      if (!w.alive[id] || w.kind[id] !== Kind.Unit || w.type[id] !== UnitType.Worker) { if (!w.alive[id]) this.fleeing.delete(id); continue; }
      if (sim.tick < until) continue;
      if (s.enemyUnits.some((e) => w.type[e] !== UnitType.Worker && fpLen(w.x[e] - w.x[id], w.y[e] - w.y[id]) < fp(8))) { this.fleeing.set(id, sim.tick + 20 * 4); continue; }
      this.fleeing.delete(id);
      if (w.order[id] !== Order.Gather && w.order[id] !== Order.Garrison) back.push(id);
    }
    if (back.length) out.push({ type: CommandType.Stop, player: this.ctx.player, ids: back });
  }

  private recall(sim: Simulation, sq: Squad, x: number, y: number, out: Command[]): void {
    const ids = sq.units.filter((id) => !this.fleeing.has(id));
    if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x, y });
    if (this.breach >= 0) this.breach = -1;
  }

  // ------------------------------------------------------------ the decision to attack

  /** the wave the plan wants before it walks out, in population */
  private waveTarget(sim: Simulation, s: Snapshot): number {
    const plan = this.ctx.plan, prof = this.ctx.profile;
    const wave = (this.attackWave * prof.attackPopGrowth * plan.wavePct) / 100 | 0;
    const base = ((prof.attackPop * plan.attackPopPct) / 100) | 0;
    const mass = ((MAX_POP * plan.wavePopPct) / 100) | 0;
    let threshold = Math.max(base, mass) + wave;
    if (sim.tick > plan.pushAfter) threshold = Math.min(threshold, Math.max(prof.attackPop, mass >> 1) + wave);
    if (plan.creep && this.ctx.creepArrived(sim, s)) threshold = Math.min(threshold, prof.attackPop + wave);
    if (sim.tick > plan.pushAfter + 6 * MINUTE) threshold = Math.min(threshold, 14 + wave);
    return Math.min(threshold, ((MAX_POP * 70) / 100) | 0);
  }

  /**
   * Every few seconds of quiet the bot looks at every enemy base it knows and asks whether its army at home
   * wins there - army against towers, castle and the soldiers seen round it, by the square law. It goes for the
   * best prize it can actually take. When nothing is takeable it does not walk in anyway: it keeps building,
   * asks the forge for siege, and sends raiders at whatever the enemy left outside its guns. Only an army that
   * has nowhere left to grow goes in against the odds, and it still picks the softest target.
   */
  private considerAttack(sim: Simulation, s: Snapshot, out: Command[]): void {
    if (this.op || sim.tick - this.lastEval < EVAL_TICKS) return;
    this.lastEval = sim.tick;
    const reserve = this.reserve(s);
    const pop = this.popOf(sim, reserve);
    if (reserve.length < 4) return;
    const mine = this.forceOf(sim, reserve);
    // what leaves is the army less its home guard: a square-law strength scales with the share of the force
    const leaving = (100 - this.ctx.plan.homeGuardPct) / 100;
    const outranged = this.outranges(sim, reserve);
    const d = this.ctx.difficulty;
    const target = this.waveTarget(sim, s);
    let best: Cluster | null = null, bestScore = -1, bestRatio = 0, bestFresh = false;
    let soft: Cluster | null = null, softRatio = 0;
    for (const c of this.clusters(sim, s)) {
      const blocked = this.unreachable.get(c.anchor);
      if (blocked !== undefined && sim.tick - blocked < 20 * 60) continue;
      // a base that has already turned the bot back needs a clearly bigger army before it is tried again -
      // otherwise the same force walks to the same fortress and loses the same twenty men every two minutes
      const ratio = fightRatio(mine, this.clusterDefence(sim, c, outranged)) * leaving / this.failPenalty(sim, c);
      const dist = fpLen(c.x - this.rally.x, c.y - this.rally.y) >> FP_SHIFT;
      const score = (c.value * Math.min(ratio, 2.5)) / (dist + 30);
      if (ratio >= LAUNCH_MARGIN[d] && score > bestScore) { bestScore = score; best = c; bestRatio = ratio; bestFresh = sim.tick - c.seen < 20 * 60; }
      if (ratio > softRatio) { softRatio = ratio; soft = c; }
    }
    // a walkover goes now whatever the plan was waiting for; a fair fight waits for the plan's wave
    let go: Cluster | null = null;
    const cooling = sim.tick - this.lastFail < 20 * 40;
    // (a walkover has to be one the bot has actually looked at lately: an unscouted base only ever looks empty)
    // and only a plan that is out to fight early takes one before its push: a turtle that walks out at minute six
    // because the enemy looked thin through the fog is not a turtle any more, and loses its army and its wall
    const early = this.ctx.plan.attackPopPct < 100 || sim.tick > this.ctx.plan.pushAfter;
    if (best && (pop >= target && !cooling || bestRatio >= 2.5 && bestFresh && early) && pop >= 6) go = best;
    // just beaten off an attack and standing over what is left of it: go now, before they rebuild
    if (!go && best && sim.tick < this.punishUntil && pop >= 10) { go = best; this.punishUntil = 0; }
    // an army that cannot grow any more goes against the softest target it knows, even at poor odds
    // "cannot grow": at the population ceiling, or at a cap it is not raising while gold piles up
    const capped = s.popUsed >= MAX_POP - 6 || (s.popUsed >= s.popCap - 3 && s.gold >= 1200) || pop >= ((MAX_POP * 60) / 100 | 0);
    if (!go && capped && soft && softRatio >= 0.75) go = soft;
    if (this.debug && sim.tick % 1200 < EVAL_TICKS) this.debug(`eval pop ${pop}/${target} best ${best ? bestRatio.toFixed(2) : '-'} soft ${softRatio.toFixed(2)} capped ${capped} cooling ${cooling} outranged ${outranged} go ${go !== null}`);
    if (!go) {
      // a wave's worth of men and nothing it can take: what is missing is siege
      if (soft && pop >= target) this.blocked = Math.min(2, this.blocked + 1);
      return;
    }
    this.blocked = 0;
    this.debug?.(`launch ratio ${fightRatio(mine, this.clusterDefence(sim, go, outranged)).toFixed(2)} at ${go.x >> FP_SHIFT},${go.y >> FP_SHIFT} pop ${pop}`);
    this.launch(sim, s, go, reserve, out, fightRatio(mine, this.clusterDefence(sim, go, outranged)) * (100 - this.ctx.plan.homeGuardPct) / 100);
  }

  private newSquad(sim: Simulation, role: Role, ids: number[], goal: Pt, cluster: Cluster | null): Squad {
    const w = sim.world;
    return {
      role, phase: Phase.March, since: sim.tick, units: ids.slice(), gens: ids.map((id) => w.gen[id]), goal, cluster, final: null, route: null,
      legs: [], leg: 0, stop: Stop.Stage, stopAt: -1, stage: null, focus: -1, focusGen: 0, orderTick: -100000, orderX: 0, orderY: 0,
      startValue: this.valueOf(sim, ids), progressTick: sim.tick, progressD: 0x7fffffff, baits: 0, baitUntil: 0, shots: [], shotTicks: [], turned: false,
    };
  }

  private valueOf(sim: Simulation, ids: readonly number[]): number {
    let v = 0;
    for (const id of ids) v += UNITS[sim.world.type[id] as UnitType].cost;
    return v;
  }

  /**
   * Send the reserve at a cluster. A big enough army splits: the main body - siege and all - takes the cheapest
   * way in, and a fast party goes round to a second side that the route planner is told to keep well away from
   * the first. Both wait at their staging points outside the guns, and go in together.
   */
  private launch(sim: Simulation, s: Snapshot, c: Cluster, reserveAll: number[], out: Command[], ratio: number): void {
    const w = sim.world;
    const goal = { x: c.x, y: c.y };
    // the home guard stays behind: archers first (they shoot over a fence), then soldiers
    const guardPop = (this.popOf(sim, reserveAll) * this.ctx.plan.homeGuardPct / 100) | 0;
    const guard = new Set<number>();
    if (guardPop > 0) {
      let gp = 0;
      const order = reserveAll.filter((id) => w.type[id] === UnitType.Archer).concat(reserveAll.filter((id) => w.type[id] === UnitType.Soldier));
      for (const id of order) { if (gp >= guardPop) break; guard.add(id); gp += UNITS[w.type[id] as UnitType].pop; }
    }
    const reserve = reserveAll.filter((id) => !guard.has(id));
    let mainIds = reserve.slice(), flankIds: number[] = [];
    const pop = this.popOf(sim, reserve);
    if (this.ctx.difficulty >= 1 && pop >= FLANK_MIN_POP && (c.towers + c.castles) > 0) {
      const fast = reserve.filter((id) => w.type[id] === UnitType.Cavalry)
        .concat(reserve.filter((id) => w.type[id] === UnitType.Soldier))
        .concat(reserve.filter((id) => w.type[id] === UnitType.Archer));
      let fp_ = 0;
      for (const id of fast) {
        if (fp_ * 100 >= pop * FLANK_PCT) break;
        flankIds.push(id); fp_ += UNITS[w.type[id] as UnitType].pop;
      }
      const taken = new Set(flankIds);
      mainIds = reserve.filter((id) => !taken.has(id));
    }
    const main = this.newSquad(sim, Role.Main, mainIds, goal, c);
    if (!this.plan(sim, main)) {
      // no way there at all: this target is off the list for a minute rather than tried again every think
      this.unreachable.set(c.anchor, sim.tick);
      this.debug?.(`no route to ${c.x >> FP_SHIFT},${c.y >> FP_SHIFT}`);
      return;
    }
    let flank: Squad | null = null;
    if (flankIds.length > 0) {
      flank = this.newSquad(sim, Role.Flank, flankIds, goal, c);
      if (!this.plan(sim, flank, main) || !this.distinctSide(sim, c, main, flank)) {
        for (const id of flankIds) { main.units.push(id); main.gens.push(w.gen[id]); }
        main.startValue = this.valueOf(sim, main.units);
        flank = null;
      }
    }
    this.op = { cluster: c, main, flank, started: sim.tick, ratio };
    this.inSquad.clear();
    for (const id of main.units) this.inSquad.add(id);
    if (flank) for (const id of flank.units) this.inSquad.add(id);
    this.orderLeg(sim, main, out);
    if (flank) this.orderLeg(sim, flank, out);
  }

  /** does the flank really come in from another side - at least sixty degrees round from the main body? */
  private distinctSide(sim: Simulation, c: Cluster, main: Squad, flank: Squad): boolean {
    if (!main.stage || !flank.stage || !main.route || !flank.route) return false;
    const ax = (main.stage.x - c.x) >> 8, ay = (main.stage.y - c.y) >> 8;
    const bx = (flank.stage.x - c.x) >> 8, by = (flank.stage.y - c.y) >> 8;
    const dot = ax * bx + ay * by;
    const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
    if (la === 0 || lb === 0) return false;
    if (dot / (la * lb) > 0.5) return false;
    return flank.route.cost <= main.route.cost * 2 + 400;
  }

  // ------------------------------------------------------------ routes

  /**
   * Plan the squad's way to its goal and set up its first leg: to the staging point outside the guns, or to
   * the edge of the forest it means to burn through, or to the fence it means to cut, whichever comes first.
   * A flank is told to keep clear of the main body's approach, so it really does come in from another side.
   */
  private plan(sim: Simulation, sq: Squad, avoidFrom?: Squad): boolean {
    const w = sim.world;
    const c = this.centre(sim, sq);
    if (!c) return false;
    let cats = 0, rams = 0;
    for (const id of sq.units) { const t = w.type[id]; if (t === UnitType.Catapult) cats++; else if (t === UnitType.Ram) rams++; }
    const burn = cats > 0 && this.ctx.difficulty >= 1;
    const threats = sq.role === Role.Main ? this.threatCache : this.threatCache.concat(this.armyThreats());
    if (avoidFrom && avoidFrom.stage && avoidFrom.route) {
      // the main body's last stretch is ground the flank must not share
      const cells = avoidFrom.route.cells;
      for (let i = Math.max(0, cells.length - 14); i < cells.length; i += 3) {
        const x = cells[i] % sim.map.w;
        threats.push({ x, y: (cells[i] - x) / sim.map.w, r: 7, w: 40 });
      }
    }
    const route = planRoute(sim, c.x >> FP_SHIFT, c.y >> FP_SHIFT, sq.goal.x >> FP_SHIFT, sq.goal.y >> FP_SHIFT, sq.role === Role.Raid ? 3 : 6, threats, {
      player: this.ctx.player,
      heavy: cats + rams > 0,
      forestCost: burn ? FOREST_COST : 0,
      wallCost: sq.role === Role.Main ? (cats + rams > 0 ? WALL_COST_SIEGE : WALL_COST_FOOT) : 0,
      dangerPct: sq.role === Role.Main ? 100 : 350,
      margin: 24,
    });
    if (!route) return false;
    sq.route = route;
    const n = route.cells.length;
    // A tower standing on the way, well short of the objective, is not something to sneak past - the route
    // only goes under its guns because every way round is longer. It becomes the objective for now: the squad
    // stages short of it, knocks it down, and plans on from there.
    if (sq.role === Role.Main && route.exposed >= 0 && !sq.final) {
      const ec = route.cells[route.exposed], ex = ec % sim.map.w, ey = (ec - ex) / sim.map.w;
      if (fpLen(fp(ex) - sq.goal.x, fp(ey) - sq.goal.y) > fp(16)) {
        let best: KnownBuilding | null = null, bd = 0x7fffffff;
        for (const kb of this.ctx.known.values()) {
          if (!this.isDefence(kb.type) || !this.hostile(sim, kb)) continue;
          const d = fpLen(kb.x - fp(ex + 0.5), kb.y - fp(ey + 0.5));
          if (d < bd && d <= this.reach(kb.type) + fp(3)) { bd = d; best = kb; }
        }
        if (best) {
          sq.final = { goal: sq.goal, cluster: sq.cluster };
          sq.goal = { x: best.x, y: best.y };
          sq.cluster = { x: best.x, y: best.y, owner: best.owner, value: 100, towers: best.type === BuildingType.Tower ? 1 : 0, castles: best.type === BuildingType.Castle ? 1 : 0, anchor: best.id, seen: best.lastSeen };
        }
      }
    }
    let stopAt = route.exposed >= 0 ? Math.max(0, route.exposed - 2) : Math.max(0, n - 3);
    // a hunt for buildings nobody has seen walks all the way there: there is no defence to stage outside of,
    // and a stale tower near the start made it stage where it stood, over and over
    if (sq.cluster && sq.cluster.anchor < 0 || stopAt < 3 && route.exposed >= 0 && route.exposed < 3) stopAt = n - 1;
    let stop = Stop.Stage;
    const firstForest = route.forest.length ? route.forest[0] : -1;
    const firstWall = route.walls.length ? route.walls[0] : -1;
    if (firstForest >= 0 && firstForest - 2 <= stopAt) { stop = Stop.Burn; stopAt = Math.max(0, firstForest - 2); }
    if (firstWall >= 0 && firstWall - 1 <= stopAt) { stop = Stop.Breach; stopAt = Math.max(0, firstWall - 1); }
    sq.stop = stop;
    sq.stopAt = stop === Stop.Breach ? firstWall : stop === Stop.Burn ? firstForest : stopAt;
    sq.legs = stopAt > 0 ? waypoints(sim, route, threats, 0, stopAt) : [];
    if (sq.legs.length === 0) sq.legs = [route.cells[stopAt]];
    sq.leg = 0;
    if (stop === Stop.Stage) sq.stage = cellCentre(sim, route.cells[stopAt]);
    else if (!sq.stage) {
      // where it would have staged had the way been open, so the flank check has something to compare
      const e = route.exposed >= 0 ? Math.max(0, route.exposed - 2) : Math.max(0, n - 3);
      sq.stage = cellCentre(sim, route.cells[e]);
    }
    sq.phase = Phase.March; sq.since = sim.tick;
    sq.progressTick = sim.tick; sq.progressD = 0x7fffffff;
    sq.orderTick = -100000;
    return true;
  }

  private centre(sim: Simulation, sq: Squad): Pt | null {
    const w = sim.world;
    let sx = 0, sy = 0, n = 0;
    for (const id of sq.units) { sx += w.x[id]; sy += w.y[id]; n++; }
    return n === 0 ? null : { x: (sx / n) | 0, y: (sy / n) | 0 };
  }

  /** units of the squad free to take an order (the wounded running home are left alone) */
  private able(sq: Squad): number[] { return sq.units.filter((id) => !this.fleeing.has(id)); }

  private orderLeg(sim: Simulation, sq: Squad, out: Command[]): void {
    if (sq.leg >= sq.legs.length) return;
    const p = cellCentre(sim, sq.legs[sq.leg]);
    const ids = this.able(sq);
    if (ids.length === 0) return;
    // close to the guns the squad walks rather than attack-moves, so nobody peels off after a defender
    const type = this.underGuns(p.x, p.y, 5) ? CommandType.Move : CommandType.AttackMove;
    out.push({ type, player: this.ctx.player, ids, x: p.x, y: p.y });
    sq.orderTick = sim.tick; sq.orderX = p.x; sq.orderY = p.y;
  }

  // ------------------------------------------------------------ running an operation

  private runOp(sim: Simulation, s: Snapshot, out: Command[], underAttack: boolean): void {
    const op = this.op!;
    if (op.flank && op.flank.units.length === 0) op.flank = null;
    if (op.main.units.length === 0) {
      // walked home (it dissolved into the reserve) or died where it stood
      if (op.main.phase !== Phase.Retreat) { this.attackWave++; this.lastFail = sim.tick; }
      if (op.flank && !this.raid) this.raid = op.flank; // what is left of the flank finishes on its own
      this.op = null; this.breach = -1;
      return;
    }
    if (underAttack && op.main.phase === Phase.Retreat) return;
    this.runSquad(sim, s, op.main, out);
    if (this.op && op.flank) this.runSquad(sim, s, op.flank, out);
  }

  private runSquad(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    if (sq.units.length === 0) return;
    switch (sq.phase) {
      case Phase.March: this.march(sim, s, sq, out); break;
      case Phase.Burn: this.burn(sim, s, sq, out); break;
      case Phase.Breach: this.breachStep(sim, s, sq, out); break;
      case Phase.Stage: this.stage(sim, s, sq, out); break;
      case Phase.Engage: this.engage(sim, s, sq, out); break;
      case Phase.Retreat: this.retreatStep(sim, s, sq, out); break;
    }
  }

  /** visible enemy fighters within `r` cells of a point */
  private enemiesNear(sim: Simulation, s: Snapshot, x: number, y: number, r: number, workers = false): number[] {
    const w = sim.world;
    return s.enemyUnits.filter((e) => (workers || w.type[e] !== UnitType.Worker) && fpLen(w.x[e] - x, w.y[e] - y) <= fp(r));
  }

  /**
   * Met on the way: fight it if that is a fight the squad wins where it stands (their towers counted if they
   * reach), run if it is not. Returns true when the squad has its orders for this think.
   */
  private skirmish(sim: Simulation, s: Snapshot, sq: Squad, c: Pt, out: Command[]): boolean {
    const w = sim.world;
    const all = this.enemiesNear(sim, s, c.x, c.y, 9);
    if (all.length === 0) return false;
    // defenders standing under their own guns are bait: the squad fights what comes out, never walks in after
    // them (a unit on attack-move chases four cells past its sight, which is exactly into a tower's reach)
    const foes = all.filter((e) => !this.underGuns(w.x[e], w.y[e], 1));
    if (foes.length === 0) {
      if (!this.underGuns(c.x, c.y, 0)) return false;
      // back to the last point that was out of reach: the previous turn of the route, or the staging point
      const back = sq.phase === Phase.March && sq.leg > 0 ? cellCentre(sim, sq.legs[sq.leg - 1]) : sq.phase === Phase.Stage && sq.stage ? sq.stage : this.rally;
      if (sim.tick - sq.orderTick >= 40) {
        const ids = this.able(sq);
        if (ids.length) out.push({ type: CommandType.Move, player: this.ctx.player, ids, x: back.x, y: back.y });
        sq.orderTick = sim.tick; sq.orderX = back.x; sq.orderY = back.y;
      }
      return true;
    }
    const them = this.forceOf(sim, foes);
    this.defencesCovering(sim, c.x, c.y, them);
    const r = fightRatio(this.forceOf(sim, sq.units), them);
    // a raid is there to kill diggers, not to trade with an army
    if (r < (sq.role === Role.Raid ? 1 : RETREAT_RATIO)) { this.fail(sim, sq, out); return true; }
    let sx = 0, sy = 0;
    for (const e of foes) { sx += w.x[e]; sy += w.y[e]; }
    const tx = (sx / foes.length) | 0, ty = (sy / foes.length) | 0;
    if (sim.tick - sq.orderTick >= 40 || fpLen(tx - sq.orderX, ty - sq.orderY) > fp(4)) {
      const ids = this.able(sq);
      if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x: tx, y: ty });
      sq.orderTick = sim.tick; sq.orderX = tx; sq.orderY = ty;
    }
    return true;
  }

  private march(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    const w = sim.world;
    const c = this.centre(sim, sq)!;
    if (this.skirmish(sim, s, sq, c, out)) { sq.progressTick = sim.tick; return; }
    if (!sq.route || sq.leg >= sq.legs.length) { this.arrive(sim, s, sq, out); return; }
    const p = cellCentre(sim, sq.legs[sq.leg]);
    let near = 0;
    for (const id of sq.units) if (fpLen(w.x[id] - p.x, w.y[id] - p.y) <= fp(4.5)) near++;
    const d = fpLen(c.x - p.x, c.y - p.y);
    if (near * 10 >= sq.units.length * 6 || d <= fp(3)) {
      sq.leg++;
      sq.progressTick = sim.tick; sq.progressD = 0x7fffffff;
      if (sq.leg >= sq.legs.length) { this.arrive(sim, s, sq, out); return; }
      this.orderLeg(sim, sq, out);
      return;
    }
    if (d + fp(1) < sq.progressD) { sq.progressD = d; sq.progressTick = sim.tick; }
    if (sim.tick - sq.progressTick > STUCK_TICKS) {
      if (!this.plan(sim, sq)) { this.fail(sim, sq, out); return; }
      this.orderLeg(sim, sq, out);
      return;
    }
    // stragglers and units that dropped the order after a scrap get it again
    if (sim.tick - sq.orderTick >= REORDER * 3 || sq.units.some((id) => w.order[id] === Order.None && !this.fleeing.has(id)) && sim.tick - sq.orderTick >= REORDER) this.orderLeg(sim, sq, out);
  }

  /** the leg is walked: on to what it was walking to */
  private arrive(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    sq.since = sim.tick;
    if (sq.stop === Stop.Burn) sq.phase = Phase.Burn;
    else if (sq.stop === Stop.Breach) sq.phase = Phase.Breach;
    else sq.phase = sq.role === Role.Raid ? Phase.Engage : Phase.Stage;
    sq.orderTick = -100000;
    this.runSquad(sim, s, sq, out);
  }

  /**
   * Burning a way through a wood. The catapults stand at the edge of the forest the route crosses and put fire
   * bombs into it along the route, each one further in; the rest of the squad guards them. A cell that has burnt
   * down is open ground, so the catapults walk up the new gap for the next shot, and once the route has no
   * forest left on it the squad plans again and marches through - usually onto the side of a base with no towers
   * on it, because that is why the planner chose the wood in the first place.
   */
  private burn(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    const w = sim.world, me = this.ctx.player, tiles = sim.map.tiles;
    const c = this.centre(sim, sq)!;
    if (this.skirmish(sim, s, sq, c, out)) return;
    const cats = sq.units.filter((id) => w.type[id] === UnitType.Catapult);
    const route = sq.route;
    if (cats.length === 0 || !route || sim.tick - sq.since > 20 * 120) {
      // nothing left to burn with, or it is taking too long: find a way that does not need it
      this.replanWithout(sim, sq, out);
      return;
    }
    // forest still standing on the route, in walking order, and whether any of it is already alight
    const standing: number[] = [];
    let alight = false;
    for (const i of route.forest) {
      const cell = route.cells[i];
      if (tiles[cell] !== Tile.Forest) continue;
      if (sim.burnUntil[cell] > 0) { alight = true; continue; }
      standing.push(i);
    }
    // old shots have landed by now
    for (let k = sq.shots.length - 1; k >= 0; k--) if (sim.tick - sq.shotTicks[k] > HOLD_TICKS_SHOT) { sq.shots.splice(k, 1); sq.shotTicks.splice(k, 1); }
    if (standing.length === 0) {
      if (alight || sq.shots.length > 0) { this.guard(sim, sq, c, out); return; }
      if (!this.plan(sim, sq)) { this.fail(sim, sq, out); return; }
      this.orderLeg(sim, sq, out);
      return;
    }
    const range = fp(ABILITIES[AbilityId.Incendiary].range) - fp(0.5);
    let fired = false;
    for (const cat of cats) {
      if (w.abilityCd[cat] > 0 || this.fleeing.has(cat)) continue;
      // the first standing cell in reach that no bomb in the air is already going to light
      for (const i of standing) {
        const cell = route.cells[i];
        const p = cellCentre(sim, cell);
        if (fpLen(p.x - w.x[cat], p.y - w.y[cat]) > range) continue;
        let covered = false;
        const cx = cell % sim.map.w, cy = (cell - cx) / sim.map.w;
        for (const sh of sq.shots) { const sx = sh % sim.map.w, sy = (sh - sx) / sim.map.w; if (Math.abs(sx - cx) <= 2 && Math.abs(sy - cy) <= 2) { covered = true; break; } }
        if (covered) continue;
        out.push({ type: CommandType.Ability, player: me, ids: [cat], v: AbilityId.Incendiary, x: p.x, y: p.y });
        sq.shots.push(cell); sq.shotTicks.push(sim.tick);
        fired = true;
        break;
      }
    }
    if (fired) return;
    // nobody is in reach of the next standing cell: walk up to three cells short of it, which the fire has
    // either opened already or which was open ground to begin with
    const next = standing[0];
    const standAt = route.cells[Math.max(0, next - 3)];
    const p = cellCentre(sim, standAt);
    const ready = cats.some((cat) => w.abilityCd[cat] === 0);
    const inReach = cats.some((cat) => fpLen(cellCentre(sim, route.cells[next]).x - w.x[cat], cellCentre(sim, route.cells[next]).y - w.y[cat]) <= range);
    if (!inReach && (sim.tick - sq.orderTick >= REORDER || fpLen(p.x - sq.orderX, p.y - sq.orderY) > fp(1))) {
      const ids = this.able(sq);
      if (ids.length) out.push({ type: CommandType.Move, player: me, ids, x: p.x, y: p.y });
      sq.orderTick = sim.tick; sq.orderX = p.x; sq.orderY = p.y;
    } else if (!ready) this.guard(sim, sq, c, out);
  }

  /** is a point inside the reach of a tower or castle the bot knows of (plus `slack` cells)? */
  private underGuns(x: number, y: number, slack: number): boolean {
    const cx = x >> FP_SHIFT, cy = y >> FP_SHIFT;
    for (const t of this.threatCache) {
      // threat radii carry two cells of margin over the real reach (see staticThreats)
      const r = t.r - 2 + slack, dx = cx - t.x, dy = cy - t.y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  /** hold the ground round the squad's centre, fighting anything that comes */
  private guard(sim: Simulation, sq: Squad, c: Pt, out: Command[]): void {
    if (sim.tick - sq.orderTick < REORDER * 2) return;
    const ids = this.able(sq).filter((id) => sim.world.order[id] === Order.None);
    if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x: c.x, y: c.y });
    sq.orderTick = sim.tick;
  }

  private replanWithout(sim: Simulation, sq: Squad, out: Command[]): void {
    // the burn is off: plan as if the squad had no catapults' fire to spend
    const saved = sq.units.slice(), savedGens = sq.gens.slice();
    const w = sim.world;
    const keep = sq.units.map((id, i) => i).filter((i) => w.type[sq.units[i]] !== UnitType.Catapult);
    if (keep.length === 0) { this.fail(sim, sq, out); return; }
    sq.units = keep.map((i) => saved[i]); sq.gens = keep.map((i) => savedGens[i]);
    const ok = this.plan(sim, sq);
    sq.units = saved; sq.gens = savedGens;
    if (!ok) { this.fail(sim, sq, out); return; }
    this.orderLeg(sim, sq, out);
  }

  /**
   * A fence across the route: one section, the one the route runs through, gets everything that can hurt
   * masonry, and the moment it is down the squad plans again and walks through the hole.
   */
  private breachStep(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    const w = sim.world;
    const c = this.centre(sim, sq)!;
    if (this.skirmish(sim, s, sq, c, out)) return;
    const route = sq.route;
    let wall = -1;
    if (route && sq.stopAt >= 0 && sq.stopAt < route.cells.length) {
      const cell = route.cells[sq.stopAt], x = cell % sim.map.w;
      const e = sim.path.footprintOwner(x, (cell - x) / sim.map.w);
      if (e >= 0 && w.alive[e] && w.kind[e] === Kind.Building && w.type[e] === BuildingType.Wall && !sim.sameTeam(this.ctx.player, w.owner[e])) wall = e;
    }
    if (wall < 0 || sim.tick - sq.since > 20 * 60) {
      if (this.breach >= 0) this.breach = -1;
      if (!this.plan(sim, sq)) { this.fail(sim, sq, out); return; }
      this.orderLeg(sim, sq, out);
      return;
    }
    // one section at a time for the whole bot: a second squad at a second section waits its turn
    if (this.breach >= 0 && this.breach !== wall && w.alive[this.breach] && w.gen[this.breach] === this.breachGen) { this.guard(sim, sq, c, out); return; }
    if (this.breach !== wall) { this.breach = wall; this.breachGen = w.gen[wall]; sq.orderTick = -100000; }
    if (sim.tick - sq.orderTick < 40) return;
    const ids = this.able(sq);
    if (ids.length) out.push({ type: CommandType.Attack, player: this.ctx.player, ids, target: wall });
    sq.orderTick = sim.tick;
  }

  /**
   * Outside the guns, waiting for the stragglers and for the flank. Once everyone is there the bot takes a fresh
   * look - from here it can see the towers it was only guessing at - and goes in only if the fight is still one
   * it wins. Turning round at the door costs a walk; going in against the odds costs the army.
   */
  private stage(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    const w = sim.world;
    const c = this.centre(sim, sq)!;
    if (this.skirmish(sim, s, sq, c, out)) return;
    const at = sq.stage ?? c;
    let near = 0;
    for (const id of sq.units) if (fpLen(w.x[id] - at.x, w.y[id] - at.y) <= fp(6)) near++;
    if (near * 10 < sq.units.length * 7 && (sim.tick - sq.orderTick >= REORDER * 2 || fpLen(at.x - sq.orderX, at.y - sq.orderY) > fp(2))) {
      const ids = this.able(sq);
      if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x: at.x, y: at.y });
      sq.orderTick = sim.tick; sq.orderX = at.x; sq.orderY = at.y;
    }
    const ready = near * 10 >= sq.units.length * 7;
    // everyone there: stand fast rather than stand idle - an idle man walks off after the first enemy he sees
    if (ready && sq.stage && sq.baits === 0 && sq.orderX !== -1) {
      const ids = this.able(sq).filter((id) => w.order[id] !== Order.Hold);
      if (ids.length) out.push({ type: CommandType.Hold, player: this.ctx.player, ids });
      sq.orderX = -1;
    }
    const op = this.op;
    if (!op || sq.role === Role.Raid) { sq.phase = Phase.Engage; return; }
    if (sq !== op.main) return; // the flank waits for the main body's word
    const flankReady = !op.flank || sq.final !== null || op.flank.phase === Phase.Stage && sim.tick - op.flank.since > 20 * 2;
    if (!(ready && flankReady) && sim.tick - sq.since < STAGE_WAIT) return;
    // clearing a tower on the way is the main body's job alone; the flank waits for the real thing
    const outpost = sq.final !== null;
    const ours = this.forceOf(sim, op.main.units);
    if (op.flank && !outpost) this.forceOf(sim, op.flank.units, ours);
    const outranged = this.outranges(sim, op.main.units);
    const ratio = fightRatio(ours, this.clusterDefence(sim, sq.cluster ?? op.cluster, outranged));
    this.debug?.(`stage ratio ${ratio.toFixed(2)} (launched on ${op.ratio.toFixed(2)})${outpost ? ' outpost' : ''}`);
    // It turns round only when the look from the door is worse than what it launched on - and bad in itself.
    // An army sent in at poor odds because it could not grow any more knew the odds when it left; turning it
    // back at the door for them walked it round the enemy's base ten times over.
    if (ratio < Math.min(ABORT_MARGIN[this.ctx.difficulty], op.ratio * 0.85)) {
      this.lastFail = sim.tick;
      this.noteFailure(sim, op.cluster);
      this.retreat(sim, op.main, out);
      if (op.flank) this.retreat(sim, op.flank, out);
      this.attackWave++;
      return;
    }
    this.goIn(sim, op.main);
    if (op.flank && !outpost) this.goIn(sim, op.flank);
  }

  private goIn(sim: Simulation, sq: Squad): void {
    sq.phase = Phase.Engage; sq.since = sim.tick; sq.orderTick = -100000; sq.focus = -1;
    sq.startValue = this.valueOf(sim, sq.units);
  }

  /**
   * In the fight. Enemy soldiers come first while there are any, but only in a fight the squad wins with their
   * towers counted: when it is the towers that make the difference, the squad steps back out of their reach and
   * lets the defenders follow it into the open, twice at most before it either commits or leaves. With the
   * defenders gone it takes the base apart in order - towers, the castle, the halls - everything that can hurt
   * masonry on one building at a time. The flank does the same on the side it came in from, and it goes for the
   * diggers and mines first: every one it kills is gold the defender never gets.
   */
  private engage(sim: Simulation, s: Snapshot, sq: Squad, out: Command[]): void {
    const w = sim.world, me = this.ctx.player;
    const c = this.centre(sim, sq)!;
    const ours = this.forceOf(sim, sq.units);
    if (sq.baitUntil > sim.tick) {
      // stepping back: fight whatever followed us out, otherwise keep walking
      const foes = this.enemiesNear(sim, s, c.x, c.y, 7);
      if (foes.length > 0) {
        const them = this.forceOf(sim, foes);
        const covered = this.defencesCovering(sim, c.x, c.y, them);
        if (covered === 0 && fightRatio(ours, them) >= 0.9) { sq.baitUntil = 0; sq.orderTick = -100000; }
      }
      if (sq.baitUntil > sim.tick) return;
    }
    const foes = this.enemiesNear(sim, s, c.x, c.y, 11);
    if (foes.length > 0) {
      const army = this.forceOf(sim, foes);
      const all = this.forceOf(sim, foes);
      // the guns that cover the fight: over our men, and over theirs - chasing defenders who stand under their
      // own towers is walking into those towers, whatever covers the ground we stand on now
      let fx = 0, fy = 0;
      for (const e of foes) { fx += w.x[e]; fy += w.y[e]; }
      fx = (fx / foes.length) | 0; fy = (fy / foes.length) | 0;
      this.defencesCoveringAny(sim, [c, { x: fx, y: fy }], all, fp(1));
      const rAll = fightRatio(ours, all);
      if (sq.role === Role.Raid && rAll < 1) { this.retreat(sim, sq, out); return; }
      const canBait = sq.role !== Role.Raid && sq.baits < 2 && fightRatio(ours, army) >= 1.1 && sq.stage !== null;
      if (rAll >= 0.85 || (!canBait && rAll >= 0.7)) {
        let sx = 0, sy = 0;
        for (const e of foes) { sx += w.x[e]; sy += w.y[e]; }
        const tx = (sx / foes.length) | 0, ty = (sy / foes.length) | 0;
        if (sim.tick - sq.orderTick >= 40 || fpLen(tx - sq.orderX, ty - sq.orderY) > fp(4)) {
          const ids = this.able(sq);
          if (ids.length) out.push({ type: CommandType.AttackMove, player: me, ids, x: tx, y: ty });
          sq.orderTick = sim.tick; sq.orderX = tx; sq.orderY = ty;
        }
        if (this.losing(sim, sq, rAll)) this.fail(sim, sq, out);
        return;
      }
      if (canBait && sq.stage) {
        sq.baits++; sq.baitUntil = sim.tick + 20 * 12;
        const ids = this.able(sq);
        if (ids.length) out.push({ type: CommandType.Move, player: me, ids, x: sq.stage.x, y: sq.stage.y });
        sq.orderTick = sim.tick; sq.orderX = sq.stage.x; sq.orderY = sq.stage.y;
        return;
      }
      this.fail(sim, sq, out);
      return;
    }
    if (sq.role === Role.Raid) { this.raidStep(sim, s, sq, c, out); return; }
    // the flank goes for the economy while it is there to be had
    if (sq.role === Role.Flank) {
      const diggers = this.enemiesNear(sim, s, c.x, c.y, 10, true).filter((e) => w.type[e] === UnitType.Worker);
      if (diggers.length > 0) {
        const e = diggers[0];
        if (sim.tick - sq.orderTick >= 40) {
          const ids = this.able(sq);
          if (ids.length) out.push({ type: CommandType.AttackMove, player: me, ids, x: w.x[e], y: w.y[e] });
          sq.orderTick = sim.tick; sq.orderX = w.x[e]; sq.orderY = w.y[e];
        }
        return;
      }
    }
    const focus = this.pickFocus(sim, sq, c);
    if (focus < 0 && sq.final) {
      // the tower on the way is down: on to the real objective
      sq.goal = sq.final.goal; sq.cluster = sq.final.cluster; sq.final = null;
      if (this.plan(sim, sq)) { this.orderLeg(sim, sq, out); return; }
    }
    if (focus < 0) {
      // Nothing it can walk to - but if buildings still stand behind a fence, the base is not done: plan a way
      // in through the fence and cut it. (It used to call the base finished, walk home, launch again at twenty
      // to one, and do that until the match timed out.)
      const walledIn = this.nearestWalledIn(sim, sq, c);
      const cl0 = sq.cluster;
      if (walledIn) {
        sq.goal = walledIn;
        const role = sq.role;
        sq.role = Role.Main; // a flank that has to breach breaches like the main body
        const ok = this.plan(sim, sq);
        sq.role = role;
        this.debug?.(`walled-in target at ${walledIn.x >> FP_SHIFT},${walledIn.y >> FP_SHIFT}: route ${ok ? sq.route!.cells.length + ' cells, ' + sq.route!.walls.length + ' fence' : 'none'}`);
        if (ok && sq.route && sq.route.walls.length > 0) { this.orderLeg(sim, sq, out); return; }
      } else if (cl0 && fpLen(c.x - cl0.x, c.y - cl0.y) > fp(5) && sim.tick - sq.since < 20 * 40) {
        // not there yet: walk up to the place itself and look, rather than calling it empty from the edge
        if (sim.tick - sq.orderTick >= REORDER) {
          const ids = this.able(sq);
          if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x: cl0.x, y: cl0.y });
          sq.orderTick = sim.tick; sq.orderX = cl0.x; sq.orderY = cl0.y;
        }
        return;
      } else if (cl0 && cl0.anchor < 0) {
        // an empty start, or a vein with nobody at it: crossed off, and the hunt goes on to the next place
        if (cl0.anchor === -1) this.checkedStart.add(cl0.owner);
        else if (-2 - cl0.anchor < this.blockSeen.length) this.blockSeen[-2 - cl0.anchor] = sim.tick;
        this.debug?.(`nothing at ${c.x >> FP_SHIFT},${c.y >> FP_SHIFT}: hunting on`);
      }
      // this base is done: the next one the squad can take, or home
      const next = this.nextCluster(sim, s, sq, ours);
      if (next) {
        this.debug?.(`next target ${next.x >> FP_SHIFT},${next.y >> FP_SHIFT} anchor ${next.anchor}`);
        sq.cluster = next; sq.goal = { x: next.x, y: next.y };
        if (this.op && sq === this.op.main) this.op.cluster = next;
        if (this.plan(sim, sq)) { this.orderLeg(sim, sq, out); return; }
      }
      this.retreat(sim, sq, out);
      return;
    }
    if (this.standoff(sim, s, sq, c, focus, out)) return;
    if (focus !== sq.focus || w.gen[focus] !== sq.focusGen || sim.tick - sq.orderTick >= 80 || sq.units.some((id) => w.order[id] === Order.None && !this.fleeing.has(id))) {
      if (focus === sq.focus && sim.tick - sq.orderTick < 30) return;
      sq.focus = focus; sq.focusGen = w.gen[focus];
      const ids = this.able(sq);
      if (ids.length) out.push({ type: CommandType.Attack, player: me, ids, target: focus });
      sq.orderTick = sim.tick; sq.orderX = w.x[focus]; sq.orderY = w.y[focus];
    }
    if (this.losing(sim, sq, 1)) this.fail(sim, sq, out);
  }

  /**
   * A tower inside a cluster of towers is not stormed: that is how whole waves died without scratching one.
   * The catapults take it from as far as they throw - with the range upgrade they out-reach a tower, without it
   * they only tie - and the rest of the squad stands just outside the towers' reach on attack-move, where it
   * catches anyone who sallies out to go for the catapults. Returns true when it has given the squad's orders.
   */
  private standoff(sim: Simulation, s: Snapshot, sq: Squad, c: Pt, focus: number, out: Command[]): boolean {
    const w = sim.world, me = this.ctx.player;
    const ft = w.type[focus];
    if (ft !== BuildingType.Tower && ft !== BuildingType.Castle) return false;
    const cats = sq.units.filter((id) => w.type[id] === UnitType.Catapult && !this.fleeing.has(id));
    const ranged = sim.players[me].upgrades[UpgradeId.Range] > 0;
    if (cats.length < (ranged ? 1 : 2)) return false;
    // a lone tower is simply rushed; it is two or more guns covering the same ground that make it a standoff
    if (this.defencesCovering(sim, w.x[focus], w.y[focus], new Force(), fp(2)) < 2) return false;
    if (focus === sq.focus && w.gen[focus] === sq.focusGen && sim.tick - sq.orderTick < 60) return true;
    sq.focus = focus; sq.focusGen = w.gen[focus]; sq.orderTick = sim.tick;
    out.push({ type: CommandType.Attack, player: me, ids: cats, target: focus });
    const escort = this.able(sq).filter((id) => w.type[id] !== UnitType.Catapult);
    if (escort.length > 0) {
      const dx = c.x - w.x[focus], dy = c.y - w.y[focus], l = fpLen(dx, dy) || 1;
      // just outside this tower's reach, stepping further back while a neighbour's guns still cover the spot
      let hold = this.reach(ft) + fp(2), x = 0, y = 0;
      for (let k = 0; k < 7; k++, hold += fp(1)) {
        x = w.x[focus] + Math.floor((dx * hold) / l); y = w.y[focus] + Math.floor((dy * hold) / l);
        if (!this.underGuns(x, y, 0)) break;
      }
      out.push({ type: CommandType.AttackMove, player: me, ids: escort, x, y });
      sq.orderX = x; sq.orderY = y;
    }
    return true;
  }

  /** has this squad bled enough that it should cut its losses? */
  private losing(sim: Simulation, sq: Squad, ratio: number): boolean {
    if (this.ctx.profile.retreatHpPct <= 0) return false; // the easy bot fights to the last man
    return this.valueOf(sim, sq.units) * 100 < sq.startValue * 40 && ratio < 1.3;
  }

  /**
   * The next building to knock down: the tower whose guns cover the squad (the weakest first), then any tower
   * of the base, then the castle, then the halls that make soldiers, then the rest. The flank starts with mines.
   * A building the squad cannot walk to (behind the enemy's inner fence) is skipped while a reachable one is left.
   */
  private pickFocus(sim: Simulation, sq: Squad, c: Pt): number {
    const w = sim.world;
    const team = sim.team(this.ctx.player);
    const heavy = sq.units.some((id) => w.type[id] === UnitType.Catapult || w.type[id] === UnitType.Ram);
    const cl = sq.cluster;
    // reachability is asked from a man standing on open ground - the middle of a squad can be inside a house
    let from = sq.units[0], fd = 0x7fffffff;
    for (const id of sq.units) { const d = fpLen(w.x[id] - c.x, w.y[id] - c.y); if (d < fd) { fd = d; from = id; } }
    const fx = w.x[from], fy = w.y[from];
    let best = -1, bestScore = 0x7fffffff;
    for (const kb of this.ctx.known.values()) {
      if (!this.hostile(sim, kb) || kb.type === BuildingType.Wall) continue;
      if (!w.alive[kb.id] || w.gen[kb.id] !== kb.gen || w.kind[kb.id] !== Kind.Building) continue;
      const d = fpLen(kb.x - c.x, kb.y - c.y);
      const inCluster = cl ? fpLen(kb.x - cl.x, kb.y - cl.y) < fp(15) : false;
      if (d > fp(14) && !inCluster) continue;
      let rank: number;
      if (kb.type === BuildingType.Tower) rank = d <= this.reach(kb.type) ? 0 : 1;
      else if (kb.type === BuildingType.Castle) rank = 2;
      else if (kb.type === BuildingType.Barracks || kb.type === BuildingType.Forge) rank = 3;
      else if (kb.type === BuildingType.Mine) rank = sq.role === Role.Flank ? -1 : 4;
      else rank = 5;
      const visible = sim.fog.isVisible(this.ctx.player, kb.x, kb.y);
      const hpPct = visible ? (w.hp[kb.id] * 100 / Math.max(1, w.maxHp[kb.id])) | 0 : 100;
      const score = rank * 100000 + (rank <= 1 ? hpPct * 200 : 0) + (d >> 10);
      if (score >= bestScore) continue;
      if (!sim.path.reachableFP(fx, fy, kb.x >> FP_SHIFT, kb.y >> FP_SHIFT, heavy, team) && !sim.path.reachableFP(fx, fy, kb.x >> FP_SHIFT, kb.y >> FP_SHIFT, false, team)) continue;
      bestScore = score; best = kb.id;
    }
    return best;
  }

  private hostileKnown(sim: Simulation): boolean {
    const w = sim.world;
    for (const kb of this.ctx.known.values()) {
      if (kb.type === BuildingType.Wall || !this.hostile(sim, kb)) continue;
      if (w.alive[kb.id] && w.gen[kb.id] === kb.gen && w.kind[kb.id] === Kind.Building) return true;
    }
    return false;
  }

  /** the nearest enemy building of the squad's target that it cannot walk to, as a point to plan a breach at */
  private nearestWalledIn(sim: Simulation, sq: Squad, c: Pt): Pt | null {
    const w = sim.world, cl = sq.cluster;
    let best: Pt | null = null, bd = fp(18);
    for (const kb of this.ctx.known.values()) {
      if (!this.hostile(sim, kb) || kb.type === BuildingType.Wall) continue;
      if (!w.alive[kb.id] || w.gen[kb.id] !== kb.gen || w.kind[kb.id] !== Kind.Building) continue;
      if (cl && fpLen(kb.x - cl.x, kb.y - cl.y) > fp(15) && fpLen(kb.x - c.x, kb.y - c.y) > fp(14)) continue;
      const d = fpLen(kb.x - c.x, kb.y - c.y);
      if (d < bd) { bd = d; best = { x: kb.x, y: kb.y }; }
    }
    return best;
  }

  private nextCluster(sim: Simulation, s: Snapshot, sq: Squad, ours: Force): Cluster | null {
    let best: Cluster | null = null, bestScore = -1;
    const c = this.centre(sim, sq)!;
    for (const cl of this.clusters(sim, s)) {
      // a start or a vein to look at is only worth going on to when the bot knows of nothing real
      if (cl.anchor < 0 && this.hostileKnown(sim)) continue;
      const ratio = fightRatio(ours, this.clusterDefence(sim, cl, this.outranges(sim, sq.units)));
      if (ratio < LAUNCH_MARGIN[this.ctx.difficulty] * 0.9) continue;
      const dist = fpLen(cl.x - c.x, cl.y - c.y) >> FP_SHIFT;
      const score = (cl.value * Math.min(ratio, 2.5)) / (dist + 20);
      if (score > bestScore) { bestScore = score; best = cl; }
    }
    return best;
  }

  /** how much harder a target has become to justify: 1.3x for each time it turned the bot back lately */
  private failPenalty(sim: Simulation, c: Cluster): number {
    const f = this.failures.get(c.anchor);
    if (!f || sim.tick - f.tick > FAIL_MEMORY) return 1;
    return 1 + 0.3 * f.n;
  }

  private noteFailure(sim: Simulation, c: Cluster | null): void {
    if (!c) return;
    const f = this.failures.get(c.anchor);
    const n = f && sim.tick - f.tick <= FAIL_MEMORY ? f.n + 1 : 1;
    this.failures.set(c.anchor, { n: Math.min(n, 4), tick: sim.tick });
  }

  /** the squad has lost this one: everyone in the operation goes home and the next wave waits for more */
  private fail(sim: Simulation, sq: Squad, out: Command[]): void {
    this.lastFail = sim.tick;
    if (this.op) this.noteFailure(sim, this.op.cluster);
    if (this.op && (sq === this.op.main || sq === this.op.flank)) {
      this.retreat(sim, this.op.main, out);
      if (this.op.flank) this.retreat(sim, this.op.flank, out);
      this.attackWave++;
      return;
    }
    this.retreat(sim, sq, out);
  }

  private retreat(sim: Simulation, sq: Squad, out: Command[]): void {
    if (sq.phase === Phase.Retreat) return;
    sq.phase = Phase.Retreat; sq.since = sim.tick; sq.orderTick = -100000;
    if (this.breach >= 0) this.breach = -1;
    this.retreatStep(sim, null, sq, out);
  }

  /**
   * Walking home; back at the rally point the squad dissolves into the reserve. A retreat is not a rout: turning
   * your back on an army that is chasing you is how a whole wave dies without landing a blow, so whatever follows
   * the squad out from under its towers gets fought - out here, where the towers do not reach.
   */
  private retreatStep(sim: Simulation, s: Snapshot | null, sq: Squad, out: Command[]): void {
    const c = this.centre(sim, sq);
    if (!c) return;
    if (s && !this.underGuns(c.x, c.y, 0)) {
      const w = sim.world;
      const chasers = this.enemiesNear(sim, s, c.x, c.y, 7).filter((e) => !this.underGuns(w.x[e], w.y[e], 0));
      if (chasers.length > 0) {
        const them = this.forceOf(sim, chasers);
        this.defencesCovering(sim, c.x, c.y, them);
        if (fightRatio(this.forceOf(sim, sq.units), them) >= 0.7) {
          let sx = 0, sy = 0;
          for (const e of chasers) { sx += w.x[e]; sy += w.y[e]; }
          const tx = (sx / chasers.length) | 0, ty = (sy / chasers.length) | 0;
          if (!sq.turned || sim.tick - sq.orderTick >= 40 || fpLen(tx - sq.orderX, ty - sq.orderY) > fp(4)) {
            const ids = this.able(sq);
            if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x: tx, y: ty });
            sq.orderTick = sim.tick; sq.orderX = tx; sq.orderY = ty; sq.turned = true;
          }
          return;
        }
      }
    }
    if (fpLen(c.x - this.rally.x, c.y - this.rally.y) <= fp(8) || sim.tick - sq.since > 20 * 90) {
      // home: the squad dissolves into the reserve (the operation notices its empty squads and ends)
      sq.units.length = 0; sq.gens.length = 0;
      return;
    }
    // straight back to walking home once whatever followed has been dealt with
    if (!sq.turned && sim.tick - sq.orderTick < REORDER * 2) return;
    sq.turned = false;
    const ids = this.able(sq);
    if (ids.length) out.push({ type: CommandType.Move, player: this.ctx.player, ids, x: this.rally.x, y: this.rally.y });
    sq.orderTick = sim.tick;
  }

  // ------------------------------------------------------------ raids

  /**
   * A handful of fast men sent at what the enemy could not fit behind its towers: the diggers at an outer vein,
   * a mine built out in the open. The route planner walks them round every tower it knows of and round the
   * enemy army as last seen; a target that cannot be reached without walking under the guns is not a raid.
   */
  private considerRaid(sim: Simulation, s: Snapshot, out: Command[]): void {
    const plan = this.ctx.plan, d = this.ctx.difficulty;
    if (this.raid || d === 0 || plan.creep) return;
    const after = plan.attackPopPct < 80 ? 4 * MINUTE : plan.siegeFirst ? 8 * MINUTE : 10 * MINUTE;
    if (sim.tick < after || sim.tick - this.lastRaid < RAID_EVERY) return;
    const w = sim.world;
    const reserve = this.reserve(s);
    const fast = reserve.filter((id) => w.type[id] === UnitType.Cavalry);
    const pool = fast.length >= 3 ? fast : reserve.filter((id) => w.type[id] === UnitType.Soldier);
    if (pool.length < 3 || this.popOf(sim, reserve) < 16) return;
    const ids = pool.slice(0, Math.min(6, pool.length));
    const target = this.raidTarget(sim, s);
    if (!target) return;
    this.lastRaid = sim.tick;
    const sq = this.newSquad(sim, Role.Raid, ids, target, null);
    if (!this.plan(sim, sq) || !sq.route || sq.route.exposed >= 0) return;
    this.raid = sq;
    for (const id of ids) this.inSquad.add(id);
    this.orderLeg(sim, sq, out);
  }

  /** an enemy vein or mine that no known tower or castle covers, nearest first */
  private raidTarget(sim: Simulation, s: Snapshot): Pt | null {
    const w = sim.world;
    const home = s.castles[0];
    let best: Pt | null = null, bd = 0x7fffffff;
    const covered = (x: number, y: number) => {
      for (const kb of this.ctx.known.values()) {
        if (!this.isDefence(kb.type) || !this.hostile(sim, kb)) continue;
        if (fpLen(kb.x - x, kb.y - y) <= this.reach(kb.type) + fp(2)) return true;
      }
      return false;
    };
    for (const kb of this.ctx.known.values()) {
      if (kb.type !== BuildingType.Mine || !this.hostile(sim, kb) || covered(kb.x, kb.y)) continue;
      const d = fpLen(kb.x - w.x[home], kb.y - w.y[home]);
      if (d < bd) { bd = d; best = { x: kb.x, y: kb.y }; }
    }
    // enemy diggers the bot has seen at a vein
    for (const u of this.seen.values()) {
      if (u.type !== UnitType.Worker || sim.tick - u.seen > 20 * 60) continue;
      let ours = false;
      for (const c of s.castles) if (fpLen(u.x - w.x[c], u.y - w.y[c]) < fp(16)) { ours = true; break; }
      if (ours || covered(u.x, u.y)) continue;
      const d = fpLen(u.x - w.x[home], u.y - w.y[home]);
      if (d < bd) { bd = d; best = { x: u.x, y: u.y }; }
    }
    return best;
  }

  private raidStep(sim: Simulation, s: Snapshot, sq: Squad, c: Pt, out: Command[]): void {
    const w = sim.world;
    if (sim.tick - sq.since > 20 * 45 || this.valueOf(sim, sq.units) * 2 < sq.startValue) { this.retreat(sim, sq, out); return; }
    // anything of theirs worth killing here: diggers first, then a mine or house
    const prey = this.enemiesNear(sim, s, c.x, c.y, 9, true);
    if (prey.length > 0) {
      if (sim.tick - sq.orderTick >= 40) {
        const e = prey[0];
        const ids = this.able(sq);
        if (ids.length) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids, x: w.x[e], y: w.y[e] });
        sq.orderTick = sim.tick;
      }
      return;
    }
    const focus = this.pickFocus(sim, sq, c);
    if (focus >= 0 && fpLen(w.x[focus] - c.x, w.y[focus] - c.y) < fp(9)) {
      const kbCovered = this.defencesCovering(sim, w.x[focus], w.y[focus], new Force()) > 0;
      if (!kbCovered) {
        if (focus !== sq.focus || sim.tick - sq.orderTick >= 80) {
          sq.focus = focus; sq.focusGen = w.gen[focus];
          const ids = this.able(sq);
          if (ids.length) out.push({ type: CommandType.Attack, player: this.ctx.player, ids, target: focus });
          sq.orderTick = sim.tick;
        }
        return;
      }
    }
    if (sim.tick - sq.since > 20 * 12) this.retreat(sim, sq, out);
  }

  // ------------------------------------------------------------ the reserve at home

  private gatherReserve(sim: Simulation, s: Snapshot, out: Command[]): void {
    if (sim.tick % 200 >= this.ctx.profile.thinkInterval) return;
    const w = sim.world, rp = this.rally;
    const idle = this.reserve(s).filter((id) => w.order[id] === Order.None && fpLen(w.x[id] - rp.x, w.y[id] - rp.y) > fp(6) && !this.fleeing.has(id));
    if (idle.length > 0) out.push({ type: CommandType.AttackMove, player: this.ctx.player, ids: idle, x: rp.x, y: rp.y });
  }

  // ------------------------------------------------------------ micro

  private micro(sim: Simulation, s: Snapshot, out: Command[]): void {
    const w = sim.world, me = this.ctx.player;
    if (s.enemyUnits.length === 0) { this.kiting.clear(); return; }
    const rp = this.rally;
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
    const isMelee = (e: number) => w.type[e] === UnitType.Soldier || w.type[e] === UnitType.Militia || w.type[e] === UnitType.Cavalry;

    // (no wounded running home: nothing in the game heals a unit, so a man sent back at a fifth of his health
    // stops hitting, is shot in the back half the time, and is still at a fifth if he makes it - the squad
    // decides retreats as a whole instead)
    // the wounded are back in the line once their time is up (fleeing workers are let go by returnWorkers)
    for (const [id, until] of this.fleeing) {
      if (!w.alive[id] || w.kind[id] !== Kind.Unit) this.fleeing.delete(id);
      else if (sim.tick >= until && w.type[id] !== UnitType.Worker) this.fleeing.delete(id);
    }
    // archers step back from melee
    const kiters: number[] = [];
    let kiteFrom = -1;
    for (const a of s.byType[UnitType.Archer]) {
      if (this.fleeing.has(a)) continue;
      const e = nearestEnemy(a, isMelee, fp(1.8));
      if (e >= 0 && w.hp[a] > 0) { kiters.push(a); kiteFrom = e; }
    }
    if (kiters.length > 0 && kiteFrom >= 0 && budget > 0) {
      const p = awayFrom(kiters[0], kiteFrom, fp(3));
      out.push({ type: CommandType.Move, player: me, ids: kiters, x: p.x, y: p.y });
      for (const k of kiters) this.kiting.set(k, sim.tick);
      budget--;
    }
    const resume = s.byType[UnitType.Archer].filter((a) => this.kiting.has(a) && !kiters.includes(a) && w.order[a] !== Order.AttackMove && w.order[a] !== Order.Attack);
    if (resume.length > 0 && budget > 0) {
      const e = nearestEnemy(resume[0], () => true, fp(12));
      if (e >= 0) out.push({ type: CommandType.AttackMove, player: me, ids: resume, x: w.x[e], y: w.y[e] });
      for (const a of resume) this.kiting.delete(a);
      budget--;
    }
    // catapults keep their minimum range and throw fire on clumps - unless they are busy burning a wood
    const burning = new Set<number>();
    for (const sq of [this.op?.main, this.op?.flank]) if (sq && sq.phase === Phase.Burn) for (const id of sq.units) burning.add(id);
    for (const c of s.byType[UnitType.Catapult]) {
      if (budget <= 0) break;
      const e = nearestEnemy(c, (x) => w.type[x] !== UnitType.Worker, fp(2.4));
      if (e >= 0) { const p = awayFrom(c, e, fp(3.5)); out.push({ type: CommandType.Move, player: me, ids: [c], x: p.x, y: p.y }); budget--; continue; }
      if (w.abilityCd[c] === 0 && !burning.has(c)) {
        const clump = this.findClump(sim, s, w.x[c], w.y[c], fp(ABILITIES[AbilityId.Incendiary].range), fp(2), 3);
        if (clump) { out.push({ type: CommandType.Ability, player: me, ids: [c], v: AbilityId.Incendiary, x: clump.x, y: clump.y }); budget--; }
      }
    }
    // rams go for masonry, never for the fence - except the one section being cut through
    for (const r of s.byType[UnitType.Ram]) {
      if (budget <= 0) break;
      if (w.order[r] === Order.Attack && w.kind[w.orderTarget[r]] === Kind.Building) continue;
      let best = -1, bestD = fp(14);
      for (const kb of this.ctx.known.values()) {
        if (kb.owner < 0 || sim.sameTeam(me, kb.owner)) continue;
        if (kb.type === BuildingType.Wall && kb.id !== this.breach) continue;
        if (!w.alive[kb.id] || w.gen[kb.id] !== kb.gen || w.kind[kb.id] !== Kind.Building) continue;
        const d = fpLen(w.x[kb.id] - w.x[r], w.y[kb.id] - w.y[r]);
        if (d < bestD) { bestD = d; best = kb.id; }
      }
      if (best >= 0) { out.push({ type: CommandType.Attack, player: me, ids: [r], target: best }); budget--; }
    }
    // archers volley on clumps or catapults
    const readyArchers = s.byType[UnitType.Archer].filter((a) => w.abilityCd[a] === 0 && w.order[a] !== Order.Move);
    if (readyArchers.length > 0 && budget > 0) {
      const a = readyArchers[0];
      const range = fp(ABILITIES[AbilityId.Volley].range + sim.players[me].upgrades[UpgradeId.Range]);
      const cat = nearestEnemy(a, (e) => w.type[e] === UnitType.Catapult || w.type[e] === UnitType.Ram, range);
      const clump = cat >= 0 ? { x: w.x[cat], y: w.y[cat] } : this.findClump(sim, s, w.x[a], w.y[a], range, fp(1.5), 3);
      if (clump) {
        const ids = readyArchers.filter((x) => fpLen(w.x[x] - clump.x, w.y[x] - clump.y) <= range);
        if (ids.length) { out.push({ type: CommandType.Ability, player: me, ids, v: AbilityId.Volley, x: clump.x, y: clump.y }); budget--; }
      }
    }
    // soldiers raise shields when engaged
    const soldiers = s.byType[UnitType.Soldier].filter((sid) => w.abilityCd[sid] === 0 && w.buff[sid] === 0 && nearestEnemy(sid, (e) => w.type[e] !== UnitType.Worker, fp(4)) >= 0);
    if (soldiers.length >= 2 && budget > 0) {
      const enemiesNear = s.enemyUnits.filter((e) => w.type[e] !== UnitType.Worker && fpLen(w.x[e] - w.x[soldiers[0]], w.y[e] - w.y[soldiers[0]]) < fp(6)).length;
      const cat = s.enemyByType[UnitType.Catapult] > 0;
      if (cat || enemiesNear >= 3) { out.push({ type: CommandType.Ability, player: me, ids: soldiers, v: AbilityId.ShieldStance }); budget--; }
    }
  }

  private findClump(sim: Simulation, s: Snapshot, x: number, y: number, range: number, radius: number, min: number): Pt | null {
    const w = sim.world;
    let best: Pt | null = null, bestN = min - 1;
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

  /**
   * Now and then one rider (or a footman, or a spare digger early on) goes to look. Everything above runs on what
   * the bot has seen, so a bot that never looks attacks the base it remembers from minute three. A base it knows
   * is looked at from outside the reach of its towers, not walked into - the old scout marched into the enemy's
   * town every 75 seconds, died every time, and led the enemy's army back home behind it. The scout turns for
   * home the moment soldiers or a tower are close.
   */
  private scouting(sim: Simulation, s: Snapshot, out: Command[]): void {
    const w = sim.world, me = this.ctx.player;
    if (this.scoutUnit >= 0 && sim.tick < this.scoutUntil) {
      const id = this.scoutUnit;
      const danger = s.enemyUnits.some((e) => w.type[e] !== UnitType.Worker && fpLen(w.x[e] - w.x[id], w.y[e] - w.y[id]) < fp(7))
        || this.threatCache.some((t) => { const dx = t.x - (w.x[id] >> FP_SHIFT), dy = t.y - (w.y[id] >> FP_SHIFT); return dx * dx + dy * dy <= (t.r - 1) * (t.r - 1); });
      if (danger) {
        out.push({ type: CommandType.Move, player: me, ids: [id], x: this.rally.x, y: this.rally.y });
        this.scoutUntil = 0;
      }
      return;
    }
    // the trip is over: the scout is an ordinary soldier of the reserve again
    this.scoutUnit = -1;
    const interval = this.ctx.difficulty === 2 ? 20 * 75 : 20 * 120;
    if (sim.tick - this.lastScoutTick < interval || sim.tick < 20 * 90) return;
    const reserve = this.reserve(s);
    let scout = reserve.find((id) => w.type[id] === UnitType.Cavalry && w.order[id] === Order.None)
      ?? reserve.find((id) => w.type[id] === UnitType.Soldier && w.order[id] === Order.None) ?? -1;
    if (scout < 0 && s.workers.length > 6 && sim.tick < 6 * MINUTE) scout = s.workers[s.workers.length - 1];
    if (scout < 0) return;
    this.scoutUnit = scout;
    this.lastScoutTick = sim.tick;
    this.scoutUntil = sim.tick + 20 * 60;
    const main = s.castles[0];
    const targets: Pt[] = [];
    // first the nearest veins it has never seen: a castle cannot be placed in the fog, so an expansion waits on
    // a look at the ground more than on anything the enemy is doing
    const unseen: number[] = [];
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Mine || sim.fog.isExplored(me, w.x[id], w.y[id])) continue;
      if (s.castles.some((c) => fpLen(w.x[id] - w.x[c], w.y[id] - w.y[c]) < fp(12))) continue;
      unseen.push(id);
    }
    unseen.sort((a, b) => fpLen(w.x[a] - w.x[main], w.y[a] - w.y[main]) - fpLen(w.x[b] - w.x[main], w.y[b] - w.y[main]) || a - b);
    for (const m of unseen.slice(0, 2)) targets.push({ x: w.x[m], y: w.y[m] + fp(2.5) });
    for (let i = 0; i < sim.players.length; i++) {
      const ep = sim.players[i];
      if (!ep.alive || sim.sameTeam(me, i)) continue;
      const ex = fp(ep.startX + 0.5), ey = fp(ep.startY + 0.5);
      let knownBase = false;
      for (const kb of this.ctx.known.values()) if (kb.owner === i && fpLen(kb.x - ex, kb.y - ey) < fp(14)) { knownBase = true; break; }
      if (!knownBase) { targets.push({ x: ex, y: ey }); continue; }
      // a known base is watched from outside its guns, on the side facing home
      const dx = w.x[main] - ex, dy = w.y[main] - ey, l = fpLen(dx, dy) || 1;
      targets.push({ x: ex + Math.floor((dx * fp(12)) / l), y: ey + Math.floor((dy * fp(12)) / l) });
    }
    const exp: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Mine && fpLen(w.x[id] - w.x[main], w.y[id] - w.y[main]) > fp(14)) exp.push(id);
    exp.sort((a, b) => fpLen(w.x[a] - w.x[main], w.y[a] - w.y[main]) - fpLen(w.x[b] - w.x[main], w.y[b] - w.y[main]) || a - b);
    for (const m of exp.slice(0, 2)) targets.push({ x: w.x[m] + fp(2.5), y: w.y[m] });
    let first = true;
    for (const t of targets.slice(0, 14)) {
      out.push({ type: CommandType.Move, player: me, ids: [scout], x: t.x, y: t.y, queue: !first });
      first = false;
    }
    out.push({ type: CommandType.Move, player: me, ids: [scout], x: this.rally.x, y: this.rally.y, queue: true });
  }

  /**
   * The enemy's army as the bot remembers it, counted by unit type - not just what is on screen this second,
   * which after a fight is often nothing at all and would have the barracks forget what they are countering.
   */
  enemyMix(): number[] {
    const out = new Array<number>(8).fill(0);
    for (const u of this.seen.values()) out[u.type]++;
    return out;
  }

  /** for the tournament harness: the squads in detail */
  debugSquads(sim: Simulation): string {
    const names = ['march', 'burn', 'breach', 'stage', 'engage', 'retreat'];
    const one = (tag: string, sq: Squad | null) => {
      if (!sq) return '';
      const c = this.centre(sim, sq);
      const leg = sq.leg < sq.legs.length ? sq.legs[sq.leg] : -1;
      return `${tag}[${names[sq.phase]} n${sq.units.length} at ${c ? (c.x >> FP_SHIFT) + ',' + (c.y >> FP_SHIFT) : '-'} leg ${sq.leg}/${sq.legs.length}${leg >= 0 ? '@' + (leg % sim.map.w) + ',' + ((leg / sim.map.w) | 0) : ''} goal ${sq.goal.x >> FP_SHIFT},${sq.goal.y >> FP_SHIFT} stop ${sq.stop} since ${((sim.tick - sq.since) / 20) | 0}s prog ${((sim.tick - sq.progressTick) / 20) | 0}s] `;
    };
    return (this.op ? one('main', this.op.main) + one('flank', this.op.flank) : '') + one('raid', this.raid);
  }

  /** for tests and the tournament harness: what the army is doing */
  debugState(): { op: string; wave: number; raid: boolean } {
    const names = ['march', 'burn', 'breach', 'stage', 'engage', 'retreat'];
    return {
      op: this.op ? `${names[this.op.main.phase]}${this.op.flank ? '+flank:' + names[this.op.flank.phase] : ''}` : 'none',
      wave: this.attackWave,
      raid: this.raid !== null,
    };
  }
}

