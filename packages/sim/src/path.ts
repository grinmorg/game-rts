import { FP_ONE, FP_SHIFT } from './fixed';
import { MapData, isPassableTile } from './map';

export const UNREACHABLE = 0x7fffffff;
/**
 * The path grid is finer than the map: SUB×SUB "fine" cells per map cell. Two buildings placed flush leave a
 * seam one fine cell wide on each side (a whole map cell together) that footmen walk through; the heavy layer
 * (catapults, rams) keeps the full footprints, so for them the seam does not exist. A fence standing in the way of
 * such a seam is tunnelled through rather than sealing it (see SEAM_TUNNEL).
 */
export const SUB = 2;
export const SUB_SHIFT = 1;
/** fixed-point coordinate → fine cell */
export const FINE_SHIFT = FP_SHIFT - SUB_SHIFT;
const FINE_HALF = FP_ONE >> (SUB_SHIFT + 1);
const COST_STRAIGHT = 10;
const COST_DIAG = 14;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
/** a blocked destination (click on a forest, a pond, a building) flows toward the nearest passable ring within this many fine cells */
const DEST_SEED_RADIUS = 12 * SUB;
/**
 * Span of the bucket queue (Dial's algorithm over A* keys, see FlowField.hx0). Every open key lies within this many
 * units of the key being settled: ring seeds spread over at most ~350 in cost and ~700 in heuristic (see seedCells),
 * and with a consistent heuristic an edge adds at most 2 * COST_DIAG.
 */
const BUCKETS = 2048;
const BUCKET_MASK = BUCKETS - 1;
/**
 * Flow fields are stored in tiles of TILE×TILE fine cells, taken only when the run reaches them (see FlowField.tiles),
 * so a field costs what it covers: the way from a deposit to its castle a few kilobytes, a march across a 512 map
 * four megabytes. The tiles come out of one slab per pathfinder.
 */
const TILE_SHIFT = 4;
const TILE = 1 << TILE_SHIFT;
const TILE_MASK = TILE - 1;
const TILE_CELLS = TILE * TILE;
/** a cell of a held tile the run has not touched; every other value is `dist << 1 | settled` */
const UNTOUCHED = -2;
/** step k in slab offsets, for a cell whose eight neighbours lie in its own tile */
const TILE_STEP = [1, -1, TILE, -TILE, 1 + TILE, 1 - TILE, -1 + TILE, -1 - TILE];
/** memory the flow-field tiles may take per pathfinder before the least recently used fields are thrown out */
const FIELD_MEMORY_BUDGET = 64 << 20;
/** fields kept at most, however small: each has a tile table of its own (16 KB on a 512 map) */
const MAX_FIELDS = 1024;
/**
 * Fewest cells a request from the backlog is given per turn (see Pathfinder.beginTick). The tick's work is shared
 * out evenly between everyone waiting, but not in slices so thin that nobody gets anywhere.
 */
const BACKLOG_MIN_SLICE = 2048;
/** ticks a group's aim waits for its field to be seeded before it is forgotten (see Pathfinder.aim) */
const AIM_TTL = 40;
/**
 * Fence cells in a straight line that make a gate: towers on the two end cells, the door on the seam between the
 * two middle ones. The owner's team walks through the door, everyone else meets a wall (see Simulation.updateGates).
 */
export const GATE_LENGTH = 4;
/**
 * First of the slots given to a fence cell that a gate's corridor passes through without carrying the gatehouse
 * itself: the rows of a thick wall behind the gate. Encoded as `GATE_TUNNEL + dir * 2 + side`, where side 0 is the
 * cell on the low side of the seam the corridor runs along and 1 the cell on the high side.
 *
 * The side matters to the renderer: such a cell keeps the half of its panel that faces away from the doorway, so
 * the row reads as a wall with a passage through it rather than as a fence with a piece missing.
 * See Pathfinder.gateAt.
 */
export const GATE_TUNNEL = 9;
/**
 * How far a seam may tunnel along its corridor, in map cells. A fence opens no seam of its own, so a fence row laid
 * flush against two flush buildings used to cap the seam between them and leave a blind pocket behind it; the
 * corridor now carries on through the footprint pairs standing in its way, up to this many cells - enough for any
 * wall a gate fits through (see GATE_LENGTH), and short enough that a seam cannot unzip a long double fence line
 * lengthwise. See Pathfinder.seamOpen.
 */
const SEAM_TUNNEL = GATE_LENGTH;

/**
 * One gate: GATE_LENGTH consecutive fence cells along `dir` (0 = along x, 1 = along y), as packed map cell indices
 * in run order, and the team whose door it is. The gatehouse spans `cells[1]` and `cells[2]`, and the corridor runs
 * along the seam between them, one map cell wide.
 *
 * A wall is not always one fence thick, so the corridor is a list rather than that single pair: `doorLow` holds the
 * cells on the low side of the seam and `doorHigh` those on the high side, one pair per layer of the wall, starting
 * with `cells[1]`/`cells[2]` themselves. Each of them opens the half of its cell that touches the seam, so together
 * they are a straight channel through however many rows of fence stand there. See Pathfinder.setGates.
 */
export interface Gate { cells: [number, number, number, number]; dir: 0 | 1; team: number; doorLow: number[]; doorHigh: number[] }

/**
 * A flow field is a Dijkstra run from the destination that is only advanced as far as somebody needs it: a unit asks
 * for its own fine cell to be settled (see Pathfinder.fieldFor), the frontier is parked between requests. Settled
 * cells hold their final distance, so every step read off a settled cell is exactly what a full run would give.
 */
export interface FlowField {
  /** destination map cell (coarse index) */
  dest: number;
  /**
   * Per tile of the grid (TILE×TILE fine cells, row-major): where its cells start in the pathfinder's slab, -1 while
   * the run has not reached it. A cell holds UNTOUCHED, or `dist << 1` while it waits on the frontier with a tentative
   * distance, or `dist << 1 | 1` once settled. Read it through Pathfinder.distAt, never directly.
   */
  tiles: Int32Array;
  /** the tiles held, as indices into `tiles`, so that giving them back does not walk the whole table */
  held: number[];
  /**
   * Parked frontier: pairs of (cell, key) waiting to be settled, `openLen` pairs. The key comes along so that handing
   * the workspace over does not have to work out every cell's heuristic again; an entry that has gone stale in the
   * meantime is simply skipped when it comes up (see expand).
   */
  open: Int32Array;
  openLen: number;
  /** key being settled (distance + heuristic): every cell whose key is below it is settled */
  cur: number;
  /**
   * What the run is aimed at, in fine cells, inclusive: the units that asked for the field when it was seeded. The
   * frontier is settled in order of distance plus the octile distance to this box (A*), not by distance alone, so a
   * march across the map settles a corridor instead of a disc as wide as the route is long - dozens of times fewer
   * cells. The octile distance is consistent with the 10/14 step costs, so a settled cell still holds its exact
   * distance, and a unit anywhere else is served too: its cell just takes longer to reach. Fixed for the whole run.
   */
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
  /** the frontier ran dry - every reachable cell is settled, everything else is truly unreachable */
  done: boolean;
  /** a passability change touched cells this field relies on; it is re-seeded on the next request */
  stale: boolean;
  /** radius (fine cells) of the seed ring, 0 when the destination cell itself is passable - see seedCells */
  seedR: number;
  lastUsed: number;
  /** computed on the heavy layer (catapults): full footprints, no seams */
  heavy: boolean;
  /** the team whose gates stand open in this field, -1 when it was computed on the shared base layers */
  team: number;
  /** the layer it was computed on (see Pathfinder.layerIndex): passability changes are tracked per layer */
  layerIdx: number;
}

/** a fieldFor request turned away for want of budget, waiting in Pathfinder.backlog */
interface PendingRequest {
  dcx: number;
  dcy: number;
  /** the fine cell of the unit that asked last */
  fx: number;
  fy: number;
  /** box around every unit that asked while it waited: what the field is aimed at once seeded (see FlowField.hx0) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  heavy: boolean;
  team: number;
  /** the tick it was last asked for; a request nobody repeats is dropped */
  asked: number;
}

/** connected regions of one base layer (see Pathfinder.baseRegions) */
interface RegionSet {
  /** per fine cell: region label, -1 where blocked */
  labels: Int32Array;
  /** a change could not be patched in: rebuilt on the next query */
  dirty: boolean;
  /** next unused label */
  next: number;
  /** bumped whenever labels change, so what is derived from them knows to redo it */
  epoch: number;
}

/**
 * A team's regions: the base regions of its weight class, joined wherever its own doors connect them. The doors are
 * all that differ, so this is a handful of entries rather than a label per cell of the map.
 */
interface DoorRegions {
  /** RegionSet.epoch it was worked out for */
  epoch: number;
  /** base label -> the label it is merged into, for the base regions a door touches */
  alias: Map<number, number>;
  /** fine cells that only the team's doors make passable -> their label */
  doorOnly: Map<number, number>;
}

/** a field as it stands in a snapshot: its tiles' cells packed in `held` order, the slab offsets are not kept */
interface FieldSnapshot {
  key: number;
  dest: number;
  held: number[];
  data: Int32Array;
  open: Int32Array;
  openLen: number;
  cur: number;
  hx0: number; hy0: number; hx1: number; hy1: number;
  done: boolean;
  stale: boolean;
  seedR: number;
  lastUsed: number;
  heavy: boolean;
  team: number;
  layerIdx: number;
}

/**
 * Everything of a Pathfinder that decides what happens next (see snapshot.ts): the layers and gates, and the whole
 * flow-field cache - which fields exist, how far each has got, the queue that is running, the backlog, the aims and
 * the budgets, because which unit gets its route on which tick hangs on them. Region labels are left out: they are
 * rebuilt on demand, and only whether two cells share a label is ever looked at, never its value.
 */
export interface PathSnapshot {
  layers: { blocked: Uint8Array; blockedHeavy: Uint8Array; terrain: Uint8Array; foot: Int32Array; seam: Uint8Array;
    gateCell: Uint8Array; gateTeam: Int8Array; gateOpen: Int8Array; door: Int8Array };
  gateTeams: number[];
  doorCells: [number, number[]][];
  version: number;
  useCounter: number;
  tilesMade: number;
  freeTiles: number;
  budgetPerTick: number;
  usedThisTick: number;
  tickNo: number;
  workPerTick: number;
  workLeft: number;
  backlog: [number, PendingRequest][];
  aims: [number, { x0: number; y0: number; x1: number; y1: number; tick: number }][];
  fields: FieldSnapshot[];
  /** the bucket queue: per non-empty bucket its index and entries in order, and whose frontier it holds (field key) */
  buckets: { b: number; items: Int32Array }[];
  queued: number;
  bucketOwner: number;
}

/**
 * The passability layers a view keeps in step with (see Pathfinder.takeLayerDelta): the rectangles of map cells
 * redone since the last delta, each with what the layers hold there now.
 */
export interface LayerDelta {
  version: number;
  gateTeams: number[];
  doorCells: [number, number[]][];
  rects: {
    x: number; y: number; w: number; h: number;
    /** per map cell of the rectangle */
    terrain: Uint8Array; foot: Int32Array; seam: Uint8Array; gateCell: Uint8Array; gateTeam: Int8Array;
    /** per fine cell of the rectangle */
    blocked: Uint8Array; blockedHeavy: Uint8Array; gateOpen: Int8Array; door: Int8Array;
  }[];
}
/** past this many rectangles a delta sends their bounding box instead */
const DELTA_MAX_RECTS = 48;

/** fine cells around what changed that patchRegions relabels: at least one, so the window's rim itself did not change */
const PATCH_MARGIN = 2;
/** larger windows are not worth patching; the layer's regions are rebuilt instead */
const PATCH_MAX_AREA = 1 << 16;

/**
 * Flow-field pathfinder on a fine grid (see SUB). Two vocabularies are used in the API:
 *  - "cell" (cx, cy) = a map cell, what buildings, placement and destinations are expressed in;
 *  - "fine" (fx, fy) = a fine cell, what unit positions resolve to (`x >> FINE_SHIFT`) and what movement checks.
 */
export class Pathfinder {
  /** map size in cells */
  readonly mapW: number;
  readonly mapH: number;
  /** grid size in fine cells */
  readonly w: number;
  readonly h: number;
  /** per fine cell: 0 passable, 1 static blocked (terrain), 2 footprint - what ordinary units can walk (seams open) */
  blocked: Uint8Array;
  /** per fine cell: the same with full footprints - what catapults can walk */
  blockedHeavy: Uint8Array;
  /**
   * Gates. Per map cell: the gate slot (0 = none, else 1 + dir * 4 + position 0..3 along the run) and the team it
   * belongs to; per fine cell: the team that may pass here although it is a footprint (the door), -1 otherwise.
   */
  private gateCell: Uint8Array;
  private gateTeam: Int8Array;
  private gateOpen: Int8Array;
  private gateCellNext: Uint8Array;
  private gateTeamNext: Int8Array;
  /**
   * Per fine cell: the team whose door stands open here, -1 if none - the door cells of `gateOpen` that are on
   * passable ground (a door on water is no door). A team walks the base layers with its own doors open, so its
   * passability is `base == 0 || door == team` (see passable): one byte per cell for all teams together, where a
   * copy of both layers per team with a gate cost 2 MB each on a 512 map.
   */
  private door: Int8Array;
  /** teams with at least one gate: they alone walk layers, and need fields, of their own (see layerKey) */
  private gateTeams = new Set<number>();
  /** per team: the fine cells of its doors, whatever the ground under them (see setGates) */
  private doorCells = new Map<number, number[]>();
  /** per map cell: 1 if the terrain is impassable */
  private terrain: Uint8Array;
  /** per map cell: 0 free, otherwise a key identifying the building/mine standing there (id + 2) */
  private foot: Int32Array;
  /** per map cell: 1 if that footprint opens seams towards other seam-opening footprints (every building but a fence) */
  private seam: Uint8Array;
  /**
   * Connected passable regions of the base layers [light, heavy]: a label per fine cell, -1 where blocked. Kept up to
   * date as buildings come and go by relabelling just the window around what changed (see patchRegions), and
   * rebuilt from scratch only when that cannot tell whether a region split or two merged.
   */
  private baseRegions: (RegionSet | null)[] = [null, null];
  /** per team with gates and weight class (key team * 2 + heavy): how its doors join the base regions */
  private doorRegions = new Map<number, DoorRegions>();
  private regionQueue: Int32Array;
  /** bumps on every passability change: regions and per-unit substitute destinations are cached against it */
  version = 1;
  private fields = new Map<number, FlowField>();
  private useCounter = 0;
  readonly maxFields: number;
  /** grid size in tiles (see FlowField.tiles) */
  readonly tilesW: number;
  readonly tilesH: number;
  /** cells of every tile handed out, TILE_CELLS per tile; grows by doubling up to the memory budget */
  private slab = new Int32Array(0);
  /** tiles carved out of the slab so far, whether held by a field now or back on `freeTiles` */
  private tilesMade = 0;
  /** slab offsets of tiles no field holds */
  private freeTiles: number[] = [];
  /** tiles the budget allows before fields are evicted to make room (see takeTile) */
  private readonly maxTiles: number;
  /**
   * Flow fields (re)seeded per tick before movers fall back to waiting. A seed costs little now that a field takes
   * only the tiles it reaches - the cells it settles are what workPerTick caps.
   */
  budgetPerTick = 32;
  usedThisTick = 0;
  /** beginTick calls so far: stamps the backlog */
  private tickNo = 0;
  /**
   * Requests turned away for want of budget, oldest first. They are served at the head of the next tick, before
   * anybody else asks (see beginTick). Without it the budget went to whoever came first in the units' order every
   * tick, and on a big map with more destinations than the cache held, a unit late in that order never got a field.
   */
  private backlog = new Map<number, PendingRequest>();
  /**
   * Where the units of a group order stand, per field key, until that field is seeded (see aim). A field is aimed at
   * whoever asks first; told about the whole group, it runs a corridor to all of them at once instead of widening
   * towards each in turn - a few times fewer cells for an army.
   */
  private aims = new Map<number, { x0: number; y0: number; x1: number; y1: number; tick: number }>();
  /**
   * Fine cells settled per tick before movers fall back to waiting. This is what caps the worst tick: a frontier
   * that runs out simply resumes next tick, so a unit asking for a long new route starts walking a tick or two
   * later instead of everyone stalling for the length of a full search. It is spent only while somebody waits, so
   * it sets the cost of a burst of orders (a hundred armies sent off at once on a 512 map: ~5 ms a tick), not of an
   * ordinary tick; at 60k such a burst left half the armies standing for five seconds.
   */
  workPerTick = 120_000;
  workLeft = 0;
  /**
   * Bucket-queue workspace. One field at a time owns it and keeps it between expansions: reloading a frontier
   * costs a pass over every open cell, and units mostly walk towards a handful of shared destinations, so the
   * owner rarely changes. It is parked back into the owner's `open` only when somebody else needs it.
   */
  private buckets: Int32Array[] = [];
  private bucketLen = new Int32Array(BUCKETS);
  private queued = 0;
  private bucketOwner: FlowField | null = null;
  // scratch for seeding and change tracking
  private seedCellScratch: number[] = [];
  private seedCostScratch: number[] = [];
  /**
   * Map-cell rectangles (x0, y0, x1, y1 quads) refresh() has redone since the last takeLayerDelta - kept only once
   * somebody has asked for deltas (trackLayers), a simulation nobody watches pays nothing for it.
   */
  private dirty: number[] | null = null;
  private snapLight = new Uint8Array(0);
  private snapHeavy = new Uint8Array(0);
  private snapDoor = new Int8Array(0);
  // scratch for patchRegions: window component per cell, and per component what it touches
  private winComp = new Int32Array(0);
  private winQueue = new Int32Array(0);

  constructor(map: MapData, maxFields = 0) {
    this.mapW = map.w; this.mapH = map.h;
    this.w = map.w * SUB; this.h = map.h * SUB;
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.blockedHeavy = new Uint8Array(n);
    this.terrain = new Uint8Array(map.w * map.h);
    this.foot = new Int32Array(map.w * map.h);
    this.seam = new Uint8Array(map.w * map.h);
    for (let i = 0; i < this.terrain.length; i++) this.terrain[i] = isPassableTile(map.tiles[i]) ? 0 : 1;
    this.gateCell = new Uint8Array(map.w * map.h);
    this.gateTeam = new Int8Array(map.w * map.h).fill(-1);
    this.gateOpen = new Int8Array(n).fill(-1);
    this.door = new Int8Array(n).fill(-1);
    this.gateCellNext = new Uint8Array(map.w * map.h);
    this.gateTeamNext = new Int8Array(map.w * map.h);
    this.refresh(0, 0, map.w, map.h);
    this.regionQueue = new Int32Array(n);
    this.maxFields = maxFields > 0 ? maxFields : MAX_FIELDS;
    this.tilesW = (this.w + TILE_MASK) >> TILE_SHIFT;
    this.tilesH = (this.h + TILE_MASK) >> TILE_SHIFT;
    // 4 bytes per cell of a tile; always room for one field over the whole grid
    this.maxTiles = Math.max(this.tilesW * this.tilesH, Math.floor(FIELD_MEMORY_BUDGET / (TILE_CELLS * 4)));
    for (let b = 0; b < BUCKETS; b++) this.buckets.push(new Int32Array(64));
    this.workLeft = this.workPerTick;
  }

  /**
   * Start a tick's budget, and spend it on the backlog first: every request turned away and asked for again since
   * gets an even slice of the tick's work, in turn. One that is still not done goes to the back of the line, so a
   * march across the map keeps going without holding up the short trips queued behind it - those finish at once.
   * What is left goes to the units in their usual order.
   */
  beginTick() {
    this.tickNo++;
    this.usedThisTick = 0; this.workLeft = this.workPerTick;
    if (this.aims.size > 0 && this.tickNo % AIM_TTL === 0) {
      for (const [key, a] of this.aims) if (a.tick < this.tickNo - AIM_TTL) this.aims.delete(key);
    }
    if (this.backlog.size === 0) return;
    const slice = Math.max(BACKLOG_MIN_SLICE, Math.floor(this.workPerTick / this.backlog.size));
    for (const key of [...this.backlog.keys()]) {
      const p = this.backlog.get(key)!;
      // nobody asked last tick: the unit got there, died or was given something else to do
      if (p.asked < this.tickNo - 1) { this.backlog.delete(key); continue; }
      if (this.workLeft <= 0) break;
      this.backlog.delete(key);
      if (!this.serve(p.dcx, p.dcy, p.fx, p.fy, p.heavy, p.team, false, slice, p.x0, p.y0, p.x1, p.y1)) this.backlog.set(key, p);
    }
  }

  /**
   * Take every passability layer from another pathfinder over the same map (the renderer keeps its own copy so
   * drawing routes never eats the simulation's per-tick budget). The layers are replaced wholesale rather than
   * cell by cell, so every cached field is dropped instead of being checked against the change.
   */
  copyFrom(o: Pathfinder): void {
    this.blocked.set(o.blocked); this.blockedHeavy.set(o.blockedHeavy);
    this.terrain.set(o.terrain); this.foot.set(o.foot); this.seam.set(o.seam);
    this.gateCell.set(o.gateCell); this.gateTeam.set(o.gateTeam); this.gateOpen.set(o.gateOpen); this.door.set(o.door);
    this.gateTeams = new Set(o.gateTeams);
    this.doorCells = new Map([...o.doorCells].map(([t, cells]) => [t, cells.slice()]));
    this.version = o.version;
    this.dropBuckets();
    for (const f of this.fields.values()) this.release(f);
    this.fields.clear();
    this.backlog.clear();
    this.aims.clear();
    this.baseRegions = [null, null];
    this.doorRegions.clear();
  }

  /**
   * Can a unit of this weight class and team stand on fine cell `i`? The base layer, with the team's own doors open.
   * The hot loops inline the same test: `base[i] === 0 || door[i] === doorTeam(team)`.
   */
  private passable(i: number, heavy: boolean, team: number): boolean {
    return (heavy ? this.blockedHeavy : this.blocked)[i] === 0 || (team >= 0 && this.door[i] === team);
  }
  /** what `door` is compared with for a team: never matches for "no team" (-1 is what a cell without a door holds) */
  private doorTeam(team: number): number { return team >= 0 ? team : -2; }
  /** which layer variant a team walks: 0 for the shared base layers, team + 1 for a team with gates of its own */
  private layerKey(team: number): number { return team >= 0 && this.gateTeams.has(team) ? team + 1 : 0; }
  /** one index over every layer, base and per team, light and heavy: fields and change tracking are kept per index */
  private layerIndex(heavy: boolean, key: number): number { return key * 2 + (heavy ? 1 : 0); }
  /** cache key of a field: destination and weight class within a layer, so any team id stays collision-free */
  private fieldKey(dest: number, heavy: boolean, key: number): number { return key * this.mapW * this.mapH * 2 + dest * 2 + (heavy ? 1 : 0); }

  // ------------------------------------------------------------------ snapshots

  snapshot(): PathSnapshot {
    const fields: FieldSnapshot[] = [];
    let ownerKey = -1;
    for (const [key, f] of this.fields) {
      // a stale field is re-seeded before anybody reads it again: what its tiles hold does not matter, only how many
      // it keeps from the free list (that decides when the next eviction comes)
      const data = new Int32Array(f.stale ? 0 : f.held.length * TILE_CELLS);
      if (!f.stale) for (let i = 0; i < f.held.length; i++) {
        const off = f.tiles[f.held[i]];
        data.set(this.slab.subarray(off, off + TILE_CELLS), i * TILE_CELLS);
      }
      if (f === this.bucketOwner) ownerKey = key;
      fields.push({
        key, dest: f.dest, held: f.held.slice(), data, open: f.open.slice(0, f.openLen * 2), openLen: f.openLen, cur: f.cur,
        hx0: f.hx0, hy0: f.hy0, hx1: f.hx1, hy1: f.hy1, done: f.done, stale: f.stale, seedR: f.seedR, lastUsed: f.lastUsed,
        heavy: f.heavy, team: f.team, layerIdx: f.layerIdx,
      });
    }
    const buckets: { b: number; items: Int32Array }[] = [];
    for (let b = 0; b < BUCKETS; b++) if (this.bucketLen[b] > 0) buckets.push({ b, items: this.buckets[b].slice(0, this.bucketLen[b]) });
    return {
      layers: {
        blocked: this.blocked.slice(), blockedHeavy: this.blockedHeavy.slice(), terrain: this.terrain.slice(), foot: this.foot.slice(),
        seam: this.seam.slice(), gateCell: this.gateCell.slice(), gateTeam: this.gateTeam.slice(), gateOpen: this.gateOpen.slice(), door: this.door.slice(),
      },
      gateTeams: [...this.gateTeams],
      doorCells: [...this.doorCells].map(([t, c]) => [t, c.slice()]),
      version: this.version, useCounter: this.useCounter, tilesMade: this.tilesMade, freeTiles: this.freeTiles.length,
      budgetPerTick: this.budgetPerTick, usedThisTick: this.usedThisTick, tickNo: this.tickNo,
      workPerTick: this.workPerTick, workLeft: this.workLeft,
      backlog: [...this.backlog].map(([k, p]) => [k, { ...p }]),
      aims: [...this.aims].map(([k, a]) => [k, { ...a }]),
      fields, buckets, queued: this.queued, bucketOwner: ownerKey,
    };
  }

  /**
   * Put a snapshot back. The fields' tiles are laid out afresh at the start of a new slab - where a tile sits
   * changes nothing - and the rest of what the run had carved out goes on the free list, so the next eviction under
   * the memory budget comes exactly when it would have.
   */
  restore(s: PathSnapshot): void {
    const L = s.layers;
    this.blocked.set(L.blocked); this.blockedHeavy.set(L.blockedHeavy); this.terrain.set(L.terrain); this.foot.set(L.foot);
    this.seam.set(L.seam); this.gateCell.set(L.gateCell); this.gateTeam.set(L.gateTeam); this.gateOpen.set(L.gateOpen); this.door.set(L.door);
    this.gateTeams = new Set(s.gateTeams);
    this.doorCells = new Map(s.doorCells.map(([t, c]) => [t, c.slice()]));
    this.version = s.version; this.useCounter = s.useCounter;
    this.budgetPerTick = s.budgetPerTick; this.usedThisTick = s.usedThisTick; this.tickNo = s.tickNo;
    this.workPerTick = s.workPerTick; this.workLeft = s.workLeft;
    this.backlog = new Map(s.backlog.map(([k, p]) => [k, { ...p }]));
    this.aims = new Map(s.aims.map(([k, a]) => [k, { ...a }]));
    let held = 0;
    for (const fs of s.fields) held += fs.held.length;
    this.tilesMade = Math.max(s.tilesMade, held);
    this.slab = new Int32Array(Math.max(64, this.tilesMade) * TILE_CELLS);
    this.freeTiles = [];
    for (let t = this.tilesMade - 1; t >= held; t--) this.freeTiles.push(t * TILE_CELLS);
    this.fields = new Map();
    let next = 0;
    for (const fs of s.fields) {
      const f: FlowField = {
        dest: fs.dest, tiles: new Int32Array(this.tilesW * this.tilesH).fill(-1), held: fs.held.slice(),
        open: new Int32Array(Math.max(256, fs.open.length)), openLen: fs.openLen, cur: fs.cur,
        hx0: fs.hx0, hy0: fs.hy0, hx1: fs.hx1, hy1: fs.hy1, done: fs.done, stale: fs.stale, seedR: fs.seedR, lastUsed: fs.lastUsed,
        heavy: fs.heavy, team: fs.team, layerIdx: fs.layerIdx,
      };
      f.open.set(fs.open);
      for (let i = 0; i < fs.held.length; i++) {
        const off = next++ * TILE_CELLS;
        f.tiles[fs.held[i]] = off;
        if (fs.stale) this.slab.fill(UNTOUCHED, off, off + TILE_CELLS);
        else this.slab.set(fs.data.subarray(i * TILE_CELLS, (i + 1) * TILE_CELLS), off);
      }
      this.fields.set(fs.key, f);
    }
    this.bucketLen.fill(0);
    for (const { b, items } of s.buckets) {
      if (this.buckets[b].length < items.length) this.buckets[b] = new Int32Array(Math.max(64, items.length));
      this.buckets[b].set(items);
      this.bucketLen[b] = items.length;
    }
    this.queued = s.queued;
    this.bucketOwner = s.bucketOwner >= 0 ? this.fields.get(s.bucketOwner) ?? null : null;
    this.baseRegions = [null, null];
    this.doorRegions.clear();
  }

  // ------------------------------------------------------------------ view deltas

  /** start keeping the rectangles a view needs (see takeLayerDelta) */
  trackLayers(): void { this.dirty ??= []; }
  /** the next delta carries the whole map: the layers were replaced without refresh() seeing it (a restore) */
  markAllDirty(): void { if (this.dirty) { this.dirty.length = 0; this.dirty.push(0, 0, this.mapW, this.mapH); } }
  /**
   * What changed in the layers since the last call, for a view's copy of this pathfinder (applyLayerDelta); null
   * when nothing did. Many small rectangles collapse into their bounding box.
   */
  takeLayerDelta(): LayerDelta | null {
    const d = this.dirty;
    if (!d || d.length === 0) return null;
    let quads = d.slice();
    d.length = 0;
    if (quads.length > DELTA_MAX_RECTS * 4) {
      let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
      for (let i = 0; i < quads.length; i += 4) {
        x0 = Math.min(x0, quads[i]); y0 = Math.min(y0, quads[i + 1]); x1 = Math.max(x1, quads[i + 2]); y1 = Math.max(y1, quads[i + 3]);
      }
      quads = [x0, y0, x1, y1];
    }
    const mw = this.mapW, W = this.w;
    const rects: LayerDelta['rects'] = [];
    for (let i = 0; i < quads.length; i += 4) {
      const x = quads[i], y = quads[i + 1], w = quads[i + 2] - x, h = quads[i + 3] - y;
      const cut = <T extends Uint8Array | Int8Array | Int32Array>(a: T, stride: number, rx: number, ry: number, rw: number, rh: number): T => {
        const out = new (a.constructor as new (n: number) => T)(rw * rh);
        for (let yy = 0; yy < rh; yy++) out.set(a.subarray((ry + yy) * stride + rx, (ry + yy) * stride + rx + rw), yy * rw);
        return out;
      };
      const fx = x * SUB, fy = y * SUB, fw = w * SUB, fh = h * SUB;
      rects.push({
        x, y, w, h,
        terrain: cut(this.terrain, mw, x, y, w, h), foot: cut(this.foot, mw, x, y, w, h), seam: cut(this.seam, mw, x, y, w, h),
        gateCell: cut(this.gateCell, mw, x, y, w, h), gateTeam: cut(this.gateTeam, mw, x, y, w, h),
        blocked: cut(this.blocked, W, fx, fy, fw, fh), blockedHeavy: cut(this.blockedHeavy, W, fx, fy, fw, fh),
        gateOpen: cut(this.gateOpen, W, fx, fy, fw, fh), door: cut(this.door, W, fx, fy, fw, fh),
      });
    }
    return { version: this.version, gateTeams: [...this.gateTeams], doorCells: [...this.doorCells].map(([t, c]) => [t, c.slice()]), rects };
  }
  /**
   * Bring these layers to what a delta from another pathfinder over the same map says. Only for a view's copy:
   * its flow fields and region labels are dropped, they belonged to the layers as they were.
   */
  applyLayerDelta(dl: LayerDelta): void {
    const mw = this.mapW, W = this.w;
    for (const r of dl.rects) {
      const put = (dst: Uint8Array | Int8Array | Int32Array, src: Uint8Array | Int8Array | Int32Array, stride: number, rx: number, ry: number, rw: number, rh: number) => {
        for (let yy = 0; yy < rh; yy++) dst.set(src.subarray(yy * rw, (yy + 1) * rw), (ry + yy) * stride + rx);
      };
      put(this.terrain, r.terrain, mw, r.x, r.y, r.w, r.h); put(this.foot, r.foot, mw, r.x, r.y, r.w, r.h); put(this.seam, r.seam, mw, r.x, r.y, r.w, r.h);
      put(this.gateCell, r.gateCell, mw, r.x, r.y, r.w, r.h); put(this.gateTeam, r.gateTeam, mw, r.x, r.y, r.w, r.h);
      const fx = r.x * SUB, fy = r.y * SUB, fw = r.w * SUB, fh = r.h * SUB;
      put(this.blocked, r.blocked, W, fx, fy, fw, fh); put(this.blockedHeavy, r.blockedHeavy, W, fx, fy, fw, fh);
      put(this.gateOpen, r.gateOpen, W, fx, fy, fw, fh); put(this.door, r.door, W, fx, fy, fw, fh);
    }
    this.gateTeams = new Set(dl.gateTeams);
    this.doorCells = new Map(dl.doorCells.map(([t, c]) => [t, c.slice()]));
    this.version = dl.version;
    this.dropBuckets();
    for (const f of this.fields.values()) this.release(f);
    this.fields.clear();
    this.backlog.clear();
    this.aims.clear();
    this.baseRegions = [null, null];
    this.doorRegions.clear();
  }

  // ------------------------------------------------------------------ static layers

  /** two different footprints meet across this edge, so a corridor may run along it */
  private pairMeets(a: number, b: number): boolean {
    const fa = this.foot[a];
    return fa !== 0 && this.foot[b] !== 0 && this.foot[b] !== fa;
  }
  /**
   * Is the pair of fine cells straddling the edge between map cells `a` and `a + across` open? Directly when the two
   * footprints open seams towards each other, and otherwise when such a seam stands within SEAM_TUNNEL cells along
   * the corridor with nothing but other footprint pairs in between - the rows of a wall the corridor tunnels through,
   * which is what keeps a fence laid flush against two flush buildings from sealing the seam between them.
   * `along` is the stride from one pair to the next along the corridor, `pos` and `len` the coordinate that stride
   * runs over and its bound.
   */
  private seamOpen(a: number, across: number, along: number, pos: number, len: number): boolean {
    if (!this.pairMeets(a, a + across)) return false;
    if (this.seam[a] !== 0 && this.seam[a + across] !== 0) return true;
    for (let s = -1; s <= 1; s += 2) {
      for (let d = 1; d <= SEAM_TUNNEL; d++) {
        const p = pos + s * d;
        if (p < 0 || p >= len) break;
        const q = a + s * d * along;
        if (!this.pairMeets(q, q + across)) break;
        if (this.seam[q] !== 0 && this.seam[q + across] !== 0) return true;
      }
    }
    return false;
  }

  /** recompute the fine cells of a rectangle of map cells from terrain + footprints */
  private refresh(cx0: number, cy0: number, sw: number, sh: number): void {
    const mw = this.mapW, mh = this.mapH, w = this.w;
    const x0 = cx0 < 0 ? 0 : cx0, y0 = cy0 < 0 ? 0 : cy0;
    const x1 = cx0 + sw > mw ? mw : cx0 + sw, y1 = cy0 + sh > mh ? mh : cy0 + sh;
    if (this.dirty && x1 > x0 && y1 > y0) this.dirty.push(x0, y0, x1, y1);
    for (let cy = y0; cy < y1; cy++) for (let cx = x0; cx < x1; cx++) {
      const c = cy * mw + cx;
      const f = this.foot[c];
      for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
        const fi = (cy * SUB + sy) * w + cx * SUB + sx;
        let light: number, heavy: number;
        if (this.terrain[c] !== 0) { light = 1; heavy = 1; }
        else if (f === 0) { light = 0; heavy = 0; }
        else {
          heavy = 2;
          // the outer half of a footprint cell opens when the corridor of a seam runs along that edge
          const ex = sx === 0 ? cx : cx + 1;
          let open = ex > 0 && ex < mw && this.seamOpen(cy * mw + ex - 1, 1, mw, cy, mh);
          const ey = sy === 0 ? cy : cy + 1;
          if (!open && ey > 0 && ey < mh) open = this.seamOpen((ey - 1) * mw + cx, mw, 1, cx, mw);
          light = open ? 0 : 2;
        }
        this.blocked[fi] = light; this.blockedHeavy[fi] = heavy;
        // a team walks the base with one difference: the doors of its own gates stand open to it
        this.door[fi] = this.terrain[c] === 0 ? this.gateOpen[fi] : -1;
      }
    }
  }

  /**
   * refresh() a rectangle and tell the cached fields which fine cells actually flipped, so only the fields that
   * depend on those cells are thrown away (a fence going up in one corner leaves the routes in the other alone).
   * The region labels are patched around the same cells (see patchRegions).
   */
  private refreshTracked(cx0: number, cy0: number, sw: number, sh: number): void {
    const mw = this.mapW, mh = this.mapH, w = this.w;
    const x0 = (cx0 < 0 ? 0 : cx0) * SUB, y0 = (cy0 < 0 ? 0 : cy0) * SUB;
    const x1 = (cx0 + sw > mw ? mw : cx0 + sw) * SUB, y1 = (cy0 + sh > mh ? mh : cy0 + sh) * SUB;
    const rw = x1 - x0, rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return;
    const live = (r: RegionSet | null) => r !== null && !r.dirty;
    if (this.fields.size === 0 && !live(this.baseRegions[0]) && !live(this.baseRegions[1])) {
      this.refresh(cx0, cy0, sw, sh);
      this.doorRegions.clear();
      return;
    }
    // what the rectangle held before: both base layers and the doors (a team walks the base with its doors open)
    const n = rw * rh;
    if (this.snapLight.length < n) { this.snapLight = new Uint8Array(n); this.snapHeavy = new Uint8Array(n); this.snapDoor = new Int8Array(n); }
    const sL = this.snapLight, sH = this.snapHeavy, sD = this.snapDoor;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const fi = (y0 + y) * w + x0 + x, k = y * rw + x;
      sL[k] = this.blocked[fi]; sH[k] = this.blockedHeavy[fi]; sD[k] = this.door[fi];
    }
    this.refresh(cx0, cy0, sw, sh);
    // cells whose passability flipped, per weight class, and doors that changed hands (with the teams involved)
    let flipL: number[] | null = null, flipH: number[] | null = null, doors: number[] | null = null;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const fi = (y0 + y) * w + x0 + x, k = y * rw + x;
      if ((sL[k] === 0) !== (this.blocked[fi] === 0)) (flipL ??= []).push(fi);
      if ((sH[k] === 0) !== (this.blockedHeavy[fi] === 0)) (flipH ??= []).push(fi);
      if (sD[k] !== this.door[fi]) (doors ??= []).push(fi, sD[k], this.door[fi]);
    }
    if (!flipL && !flipH && !doors) return;
    for (const f of this.fields.values()) {
      if (f.stale) continue;
      const list = f.heavy ? flipH : flipL;
      if (list) for (let i = 0; i < list.length && !f.stale; i++) if (this.dependsOn(f, list[i])) f.stale = true;
      if (!f.stale && doors && f.team >= 0) {
        for (let i = 0; i < doors.length && !f.stale; i += 3) {
          if ((doors[i + 1] === f.team || doors[i + 2] === f.team) && this.dependsOn(f, doors[i])) f.stale = true;
        }
      }
    }
    if (flipL) this.patchOrRebuild(0, flipL);
    if (flipH) this.patchOrRebuild(1, flipH);
    if (doors) this.doorRegions.clear();
  }

  /**
   * Does a flipped fine cell invalidate the field? Yes when it lies where the seeds are picked, or when it or one of
   * its eight neighbours is settled: a settled distance may have flowed through it (blocked now) or could be shortened
   * by it (open now), and a diagonal step next to it may have lost or gained its corner. A flip beyond the frontier
   * changes nothing that has been settled - Dijkstra will simply meet the new layout when it gets there.
   */
  private dependsOn(f: FlowField, c: number): boolean {
    const w = this.w, h = this.h;
    const cx = c % w, cy = (c - cx) / w;
    const dcx = f.dest % this.mapW, dcy = (f.dest - dcx) / this.mapW;
    const cfx = dcx * SUB + (SUB >> 1), cfy = dcy * SUB + (SUB >> 1);
    if (Math.max(Math.abs(cx - cfx), Math.abs(cy - cfy)) <= f.seedR + 1) return true;
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = cx - 1; x <= cx + 1; x++) if (x >= 0 && x < w && (this.valueAt(f, x, y) & 1) === 1) return true;
    }
    return false;
  }

  /** terrain of one map cell changed (forest burnt down) */
  setTerrain(cx: number, cy: number, passable: boolean): void {
    if (!this.inBounds(cx, cy)) return;
    this.terrain[cy * this.mapW + cx] = passable ? 0 : 1;
    this.refreshTracked(cx, cy, 1, 1);
    this.version++;
  }

  /**
   * Mark a footprint as blocked/unblocked (buildings, mines). `id` identifies the building so two flush
   * footprints are told apart; `seams` says whether footmen may squeeze along its edge past another such building.
   */
  setFootprint(cx0: number, cy0: number, size: number, block: boolean, id = -1, seams = false): void {
    const key = id + 2;
    for (let y = cy0; y < cy0 + size; y++) for (let x = cx0; x < cx0 + size; x++) {
      if (!this.inBounds(x, y)) continue;
      const c = y * this.mapW + x;
      if (block) { this.foot[c] = key; this.seam[c] = seams ? 1 : 0; }
      else { this.foot[c] = 0; this.seam[c] = 0; }
    }
    // neighbours' seams depend on us, and a seam we open or close carries that far along its corridor
    const r = SEAM_TUNNEL + 1;
    this.refreshTracked(cx0 - r, cy0 - r, size + 2 * r, size + 2 * r);
    this.version++;
  }
  /**
   * Replace the set of gates. Only the cells whose gate changed are refreshed, so fields elsewhere survive. A team
   * that has just got its first gate starts walking - and computing fields on - the base with its doors open, a team
   * that has lost its last one goes back to the shared base fields and its own are dropped.
   */
  setGates(gates: readonly Gate[]): void {
    const mw = this.mapW, mh = this.mapH, w = this.w;
    const cell = this.gateCellNext, team = this.gateTeamNext;
    cell.fill(0); team.fill(-1);
    for (const g of gates) {
      for (let i = 0; i < GATE_LENGTH; i++) { cell[g.cells[i]] = 1 + g.dir * 4 + i; team[g.cells[i]] = g.team; }
      // the rows of a thicker wall the corridor runs through: no gatehouse of their own, but the same passage
      for (const c of g.doorLow) if (cell[c] === 0) { cell[c] = GATE_TUNNEL + g.dir * 2; team[c] = g.team; }
      for (const c of g.doorHigh) if (cell[c] === 0) { cell[c] = GATE_TUNNEL + g.dir * 2 + 1; team[c] = g.team; }
    }
    const changedCells: number[] = [];
    for (let c = 0; c < mw * mh; c++) if (cell[c] !== this.gateCell[c] || team[c] !== this.gateTeam[c]) changedCells.push(c);
    if (changedCells.length === 0) return;
    this.gateCell.set(cell); this.gateTeam.set(team);
    // the door: the half of each corridor cell that touches the seam, which makes a channel one map cell wide
    // through the whole thickness of the wall
    this.gateOpen.fill(-1);
    const doorCells = new Map<number, number[]>();
    const openHalf = (c: number, dir: 0 | 1, high: boolean, t: number) => {
      const cx = c % mw, cy = (c - cx) / mw;
      let list = doorCells.get(t);
      if (!list) doorCells.set(t, list = []);
      for (let s = 0; s < SUB; s++) {
        const fi = dir === 0 ? (cy * SUB + s) * w + cx * SUB + (high ? 0 : SUB - 1) : (cy * SUB + (high ? 0 : SUB - 1)) * w + cx * SUB + s;
        if (this.gateOpen[fi] !== t) list.push(fi);
        this.gateOpen[fi] = t;
      }
    };
    for (const g of gates) {
      for (const c of g.doorLow) openHalf(c, g.dir, false, g.team);
      for (const c of g.doorHigh) openHalf(c, g.dir, true, g.team);
    }
    this.doorCells = doorCells;
    // a team that has lost its last gate walks the shared base layers again: its own fields go
    const teams = new Set<number>();
    for (const g of gates) teams.add(g.team);
    for (const t of this.gateTeams) {
      if (teams.has(t)) continue;
      for (const [k, f] of [...this.fields]) if (f.team === t) this.dropField(k, f);
    }
    this.gateTeams = teams;
    // the doors flip at the changed cells, and the fields that ran through them go stale
    for (const c of changedCells) this.refreshTracked(c % mw, (c - (c % mw)) / mw, 1, 1);
    this.doorRegions.clear();
    this.version++;
  }

  /** gate slot of a map cell: 0 = not part of a gate, else 1 + dir * 4 + position along the run (see Gate) */
  gateAt(cx: number, cy: number): number { return this.inBounds(cx, cy) ? this.gateCell[cy * this.mapW + cx] : 0; }
  /** the team whose gate stands on this map cell, -1 if none */
  gateTeamAt(cx: number, cy: number): number { return this.inBounds(cx, cy) ? this.gateTeam[cy * this.mapW + cx] : -1; }

  /** is the terrain of this map cell impassable (water, forest, rock) */
  isTerrainBlocked(cx: number, cy: number): boolean { return !this.inBounds(cx, cy) || this.terrain[cy * this.mapW + cx] !== 0; }
  /** is a building or mine standing on this map cell */
  isFootprint(cx: number, cy: number): boolean { return this.inBounds(cx, cy) && this.foot[cy * this.mapW + cx] !== 0; }
  /** the entity whose footprint covers this map cell (id passed to setFootprint), -1 if none or anonymous */
  footprintOwner(cx: number, cy: number): number {
    if (!this.inBounds(cx, cy)) return -1;
    const k = this.foot[cy * this.mapW + cx];
    return k >= 2 ? k - 2 : -1;
  }
  /** every map cell of the footprint free of terrain obstacles and other footprints */
  footprintFree(cx0: number, cy0: number, size: number): boolean {
    for (let y = cy0; y < cy0 + size; y++) for (let x = cx0; x < cx0 + size; x++) {
      if (!this.inBounds(x, y)) return false;
      const c = y * this.mapW + x;
      if (this.terrain[c] !== 0 || this.foot[c] !== 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ queries

  inBounds(cx: number, cy: number): boolean { return cx >= 0 && cy >= 0 && cx < this.mapW && cy < this.mapH; }
  inBoundsFine(fx: number, fy: number): boolean { return fx >= 0 && fy >= 0 && fx < this.w && fy < this.h; }
  /** a map cell counts as blocked when any of its fine cells is */
  isBlockedCell(cx: number, cy: number, heavy = false, team = -1): boolean {
    if (!this.inBounds(cx, cy)) return true;
    const w = this.w;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) if (!this.passable((cy * SUB + sy) * w + cx * SUB + sx, heavy, team)) return true;
    return false;
  }
  isBlockedFine(fx: number, fy: number, heavy = false, team = -1): boolean {
    if (!this.inBoundsFine(fx, fy)) return true;
    return !this.passable(fy * this.w + fx, heavy, team);
  }
  isBlockedFP(x: number, y: number, heavy = false, team = -1): boolean { return this.isBlockedFine(x >> FINE_SHIFT, y >> FINE_SHIFT, heavy, team); }
  /** fixed-point centre of a fine cell coordinate */
  fineCenter(f: number): number { return (f << FINE_SHIFT) + FINE_HALF; }

  // ------------------------------------------------------------------ regions

  /** label every 4-connected passable component of a base layer from scratch; returns how many there are */
  private rebuildRegions(r: Int32Array, b: Uint8Array): number {
    const w = this.w, n = w * this.h, q = this.regionQueue;
    r.fill(-1);
    let label = 0;
    for (let start = 0; start < n; start++) {
      if (b[start] !== 0 || r[start] !== -1) continue;
      let head = 0, tail = 0;
      q[tail++] = start; r[start] = label;
      while (head < tail) {
        const c = q[head++];
        const cx = c % w;
        if (cx > 0 && b[c - 1] === 0 && r[c - 1] === -1) { r[c - 1] = label; q[tail++] = c - 1; }
        if (cx < w - 1 && b[c + 1] === 0 && r[c + 1] === -1) { r[c + 1] = label; q[tail++] = c + 1; }
        if (c >= w && b[c - w] === 0 && r[c - w] === -1) { r[c - w] = label; q[tail++] = c - w; }
        if (c + w < n && b[c + w] === 0 && r[c + w] === -1) { r[c + w] = label; q[tail++] = c + w; }
      }
      label++;
    }
    return label;
  }

  /** the regions of a base layer, rebuilt first if a change could not be patched in */
  private base(heavy: boolean): RegionSet {
    const idx = heavy ? 1 : 0;
    let r = this.baseRegions[idx];
    if (!r) { r = { labels: new Int32Array(this.w * this.h), dirty: true, next: 0, epoch: 0 }; this.baseRegions[idx] = r; }
    if (r.dirty) {
      r.next = this.rebuildRegions(r.labels, heavy ? this.blockedHeavy : this.blocked);
      r.dirty = false; r.epoch++;
    }
    return r;
  }
  /** a base layer's passability flipped at `flips`: patch its regions, or have them rebuilt when next asked for */
  private patchOrRebuild(idx: number, flips: number[]): void {
    const r = this.baseRegions[idx];
    if (!r || r.dirty) return;
    r.epoch++;
    if (!this.patchRegions(r, idx === 1 ? this.blockedHeavy : this.blocked, flips)) r.dirty = true;
  }
  /**
   * Relabel the window around `flips` (fine cells whose passability flipped) instead of the whole layer. The window's
   * passable cells are split into their components within it. The window reaches PATCH_MARGIN cells past every
   * flip, so its rim did not change, and a region that reaches past the window reaches its rim. So:
   *  - a component holding two old labels joins two regions: not patched;
   *  - a region with one component touching the rim stays connected - any old path through the window can be
   *    rerouted between its rim cells inside that component - and keeps its label;
   *  - a region with two components touching the rim may or may not still be one outside the window: not patched;
   *  - a component that does not touch the rim is sealed off inside the window (a pocket a new wall closed, or ground
   *    a demolished building freed): a region of its own, with a new label.
   * Returns false when not patched; the caller has the layer rebuilt.
   */
  private patchRegions(set: RegionSet, b: Uint8Array, flips: number[]): boolean {
    const w = this.w, h = this.h, L = set.labels;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 0; i < flips.length; i++) {
      const x = flips[i] % w, y = (flips[i] - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    x0 = Math.max(0, x0 - PATCH_MARGIN); y0 = Math.max(0, y0 - PATCH_MARGIN);
    x1 = Math.min(w - 1, x1 + PATCH_MARGIN); y1 = Math.min(h - 1, y1 + PATCH_MARGIN);
    const ww = x1 - x0 + 1, wh = y1 - y0 + 1, area = ww * wh;
    if (area > PATCH_MAX_AREA) return false;
    if (this.winComp.length < area) { this.winComp = new Int32Array(area); this.winQueue = new Int32Array(area); }
    const comp = this.winComp, q = this.winQueue;
    comp.fill(-1, 0, area);
    // a window side on the edge of the map has nothing beyond it, so it is no rim
    const rimL = x0 > 0, rimR = x1 < w - 1, rimT = y0 > 0, rimB = y1 < h - 1;
    const compOld: number[] = [], compRim: boolean[] = [];
    for (let k0 = 0; k0 < area; k0++) {
      if (comp[k0] >= 0) continue;
      const wx0 = k0 % ww, wy0 = (k0 - wx0) / ww;
      if (b[(y0 + wy0) * w + x0 + wx0] !== 0) continue;
      const id = compOld.length;
      let old = -1, rim = false, head = 0, tail = 0;
      q[tail++] = k0; comp[k0] = id;
      while (head < tail) {
        const k = q[head++];
        const cx = k % ww, cy = (k - cx) / ww;
        const gi = (y0 + cy) * w + x0 + cx;
        // the label it had: -1 for a cell that has just become passable
        const l = L[gi];
        if (l >= 0) { if (old < 0) old = l; else if (old !== l) return false; }
        if ((cx === 0 && rimL) || (cx === ww - 1 && rimR) || (cy === 0 && rimT) || (cy === wh - 1 && rimB)) rim = true;
        if (cx > 0 && comp[k - 1] < 0 && b[gi - 1] === 0) { comp[k - 1] = id; q[tail++] = k - 1; }
        if (cx < ww - 1 && comp[k + 1] < 0 && b[gi + 1] === 0) { comp[k + 1] = id; q[tail++] = k + 1; }
        if (cy > 0 && comp[k - ww] < 0 && b[gi - w] === 0) { comp[k - ww] = id; q[tail++] = k - ww; }
        if (cy < wh - 1 && comp[k + ww] < 0 && b[gi + w] === 0) { comp[k + ww] = id; q[tail++] = k + ww; }
      }
      compOld.push(old); compRim.push(rim);
    }
    const onRim = new Set<number>();
    const label = new Int32Array(compOld.length);
    for (let c = 0; c < compOld.length; c++) {
      if (!compRim[c]) continue;
      // the rim did not change, so a passable rim cell had a label
      if (compOld[c] < 0 || onRim.has(compOld[c])) return false;
      onRim.add(compOld[c]);
      label[c] = compOld[c];
    }
    for (let c = 0; c < compOld.length; c++) if (!compRim[c]) label[c] = set.next++;
    for (let wy = 0; wy < wh; wy++) for (let wx = 0; wx < ww; wx++) {
      const c = comp[wy * ww + wx];
      L[(y0 + wy) * w + x0 + wx] = c >= 0 ? label[c] : -1;
    }
    return true;
  }

  /** how a team's doors join the base regions of a weight class; null for a team without gates (it walks the base) */
  private doors(heavy: boolean, team: number): DoorRegions | null {
    if (team < 0 || !this.gateTeams.has(team)) return null;
    const base = this.base(heavy);
    const key = team * 2 + (heavy ? 1 : 0);
    let d = this.doorRegions.get(key);
    if (!d || d.epoch !== base.epoch) { d = this.joinDoors(base, heavy, team); this.doorRegions.set(key, d); }
    return d;
  }
  /**
   * Work out DoorRegions: the door cells the base blocks are grouped into runs, and every base region a run touches
   * is merged into one (union-find over the few labels involved). A run touching none is a region of its own.
   */
  private joinDoors(base: RegionSet, heavy: boolean, team: number): DoorRegions {
    const w = this.w, h = this.h, b = heavy ? this.blockedHeavy : this.blocked, L = base.labels;
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      for (let p = parent.get(r); p !== undefined && p !== r; p = parent.get(r)) r = p;
      return r;
    };
    const union = (a: number, c: number) => { const ra = find(a), rc = find(c); if (ra !== rc) parent.set(Math.max(ra, rc), Math.min(ra, rc)); };
    const only = new Set<number>();
    for (const c of this.doorCells.get(team) ?? []) if (b[c] !== 0 && this.door[c] === team) only.add(c);
    const run = new Map<number, number>();
    const runs: number[] = [];
    let fresh = base.next;
    for (const start of only) {
      if (run.has(start)) continue;
      const id = runs.length;
      let touched = -1;
      const q = [start];
      run.set(start, id);
      while (q.length) {
        const c = q.pop()!;
        const cx = c % w, cy = (c - cx) / w;
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX[k], ny = cy + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nb = ny * w + nx;
          if (only.has(nb)) { if (!run.has(nb)) { run.set(nb, id); q.push(nb); } continue; }
          if (b[nb] !== 0) continue;
          if (touched < 0) touched = L[nb]; else union(touched, L[nb]);
        }
      }
      runs.push(touched < 0 ? fresh++ : touched);
    }
    const alias = new Map<number, number>();
    for (const l of parent.keys()) alias.set(l, find(l));
    const doorOnly = new Map<number, number>();
    for (const [c, id] of run) doorOnly.set(c, find(runs[id]));
    return { epoch: base.epoch, alias, doorOnly };
  }
  /** region label of fine cell `i` for a weight class and team, -1 where it cannot stand */
  private labelAt(i: number, heavy: boolean, team: number): number {
    const base = this.base(heavy);
    const d = this.doors(heavy, team);
    if (!d) return base.labels[i];
    const o = d.doorOnly.get(i);
    if (o !== undefined) return o;
    const l = base.labels[i];
    if (l < 0) return -1;
    const a = d.alias.get(l);
    return a === undefined ? l : a;
  }
  /** region label of a passable fine cell, -1 for a blocked one */
  regionOf(fx: number, fy: number, heavy = false, team = -1): number {
    if (!this.inBoundsFine(fx, fy)) return -1;
    return this.labelAt(fy * this.w + fx, heavy, team);
  }
  /**
   * The passable fine cell in the same region as (fromFx,fromFy) that lies closest to map cell (toCx,toCy) - where a
   * unit ends up when its destination is across water, inside a forest or behind a wall. -1 if `from` is blocked.
   */
  nearestReachable(fromFx: number, fromFy: number, toCx: number, toCy: number, heavy = false, team = -1): number {
    const reg = this.inBoundsFine(fromFx, fromFy) ? this.labelAt(fromFy * this.w + fromFx, heavy, team) : -1;
    if (reg < 0) return -1;
    const base = this.base(heavy), L = base.labels, d = this.doors(heavy, team);
    // the base labels that make up the region: just `reg` itself, unless the team's doors merged several into it
    let mine: Uint8Array | null = null;
    if (d && d.alias.size > 0) {
      mine = new Uint8Array(Math.max(base.next, reg + 1));
      if (reg < mine.length) mine[reg] = 1;
      for (const [l, a] of d.alias) if (a === reg) mine[l] = 1;
    }
    const w = this.w, h = this.h;
    // doubled fine coordinates so that map-cell and fine-cell centres are both integers
    const tx2 = toCx * SUB * 2 + SUB, ty2 = toCy * SUB * 2 + SUB;
    let best = -1, bestD = 0x7fffffff;
    const consider = (i: number) => {
      const x = i % w, y = (i - x) / w;
      const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
      const dd = ex * ex + ey * ey;
      if (dd < bestD || (dd === bestD && i < best)) { bestD = dd; best = i; }
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l = L[y * w + x];
      if (l < 0 || (mine ? l >= mine.length || mine[l] === 0 : l !== reg)) continue;
      const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
      const dd = ex * ex + ey * ey;
      if (dd < bestD) { bestD = dd; best = y * w + x; }
    }
    if (d) for (const [c, l] of d.doorOnly) if (l === reg) consider(c);
    return best;
  }

  // ------------------------------------------------------------------ flow fields

  /**
   * The flow field towards a destination map cell, advanced until the fine cell (fx,fy) is settled - a unit standing
   * there then reads its exact distance, and among its neighbours at least the one it came by (settled before it), so
   * the lowest neighbour is always a step closer. Returns null when this tick's
   * budget (fields seeded or cells settled) is spent; the caller waits a tick and the frontier resumes where it stopped.
   * Such a request goes on the backlog and is served first thing next tick (see beginTick). `force` ignores both budgets.
   */
  fieldFor(destCx: number, destCy: number, fx: number, fy: number, heavy = false, team = -1, force = false): FlowField | null {
    if (destCx < 0) destCx = 0; if (destCy < 0) destCy = 0;
    if (destCx >= this.mapW) destCx = this.mapW - 1; if (destCy >= this.mapH) destCy = this.mapH - 1;
    if (fx < 0) fx = 0; else if (fx >= this.w) fx = this.w - 1;
    if (fy < 0) fy = 0; else if (fy >= this.h) fy = this.h - 1;
    const f = this.serve(destCx, destCy, fx, fy, heavy, team, force, -1, fx, fy, fx, fy);
    if (!f && !force) {
      const key = this.fieldKey(destCy * this.mapW + destCx, heavy, this.layerKey(team));
      const p = this.backlog.get(key);
      if (p) {
        p.fx = fx; p.fy = fy; p.asked = this.tickNo;
        if (fx < p.x0) p.x0 = fx; if (fx > p.x1) p.x1 = fx;
        if (fy < p.y0) p.y0 = fy; if (fy > p.y1) p.y1 = fy;
      } else this.backlog.set(key, { dcx: destCx, dcy: destCy, fx, fy, x0: fx, y0: fy, x1: fx, y1: fy, heavy, team, asked: this.tickNo });
    }
    return f;
  }

  /**
   * A group has just been ordered to map cell (destCx,destCy): its units of one weight class stand within the fine
   * box (x0,y0)-(x1,y1). If the field towards it still has to be seeded, it will be aimed at the whole box (see
   * FlowField.hx0) rather than at whichever of them asks first. Only a hint - a field that already exists keeps its
   * aim, and nothing changes but how many cells it takes to reach them.
   */
  aim(destCx: number, destCy: number, heavy: boolean, team: number, x0: number, y0: number, x1: number, y1: number): void {
    if (!this.inBounds(destCx, destCy)) return;
    const key = this.fieldKey(destCy * this.mapW + destCx, heavy, this.layerKey(team));
    const f = this.fields.get(key);
    if (f && !f.stale) return;
    const a = this.aims.get(key);
    if (!a) { this.aims.set(key, { x0, y0, x1, y1, tick: this.tickNo }); return; }
    if (x0 < a.x0) a.x0 = x0; if (y0 < a.y0) a.y0 = y0;
    if (x1 > a.x1) a.x1 = x1; if (y1 > a.y1) a.y1 = y1;
    a.tick = this.tickNo;
  }

  /**
   * fieldFor without the bookkeeping: seed the field if it has to be, aimed at the box (tx0,ty0)-(tx1,ty1), then
   * expand it until (fx,fy) is settled. `quota` caps the cells this call may settle (-1 = whatever is left of the
   * tick's work).
   */
  private serve(
    destCx: number, destCy: number, fx: number, fy: number, heavy: boolean, team: number, force: boolean, quota: number,
    tx0: number, ty0: number, tx1: number, ty1: number,
  ): FlowField | null {
    // a team without gates of its own walks the base layers, and shares their fields (see layerKey)
    const lk = this.layerKey(team);
    const key = this.fieldKey(destCy * this.mapW + destCx, heavy, lk);
    let f = this.fields.get(key);
    if (!f || f.stale) {
      if (!force && this.usedThisTick >= this.budgetPerTick) return null;
      this.usedThisTick++;
      if (!f) {
        if (this.fields.size >= this.maxFields) this.evict(null);
        f = {
          dest: destCy * this.mapW + destCx, tiles: new Int32Array(this.tilesW * this.tilesH).fill(-1), held: [],
          open: new Int32Array(256), openLen: 0, cur: 0, hx0: 0, hy0: 0, hx1: 0, hy1: 0, done: false, stale: false, seedR: 0, lastUsed: 0,
          heavy, team: lk === 0 ? -1 : team, layerIdx: this.layerIndex(heavy, lk),
        };
        this.fields.set(key, f);
      }
      const a = this.aims.get(key);
      if (a) {
        this.aims.delete(key);
        if (a.x0 < tx0) tx0 = a.x0; if (a.y0 < ty0) ty0 = a.y0;
        if (a.x1 > tx1) tx1 = a.x1; if (a.y1 > ty1) ty1 = a.y1;
      }
      f.hx0 = tx0; f.hy0 = ty0; f.hx1 = tx1; f.hy1 = ty1;
      this.seed(f, destCx, destCy);
    }
    f.lastUsed = ++this.useCounter;
    if (f.done || (this.valueAt(f, fx, fy) & 1) === 1) return f;
    return this.expand(f, fy * this.w + fx, force, quota) ? f : null;
  }

  /** the cached field for a destination, if there is one - read only, for drawing routes; never seeds or expands */
  peekField(destCx: number, destCy: number, heavy = false, team = -1): FlowField | null {
    if (!this.inBounds(destCx, destCy)) return null;
    const f = this.fields.get(this.fieldKey(destCy * this.mapW + destCx, heavy, this.layerKey(team)));
    return f && !f.stale ? f : null;
  }

  /** throw out the least recently used field other than `keep`; false when there is none */
  private evict(keep: FlowField | null): boolean {
    let oldestKey = -1, oldest: FlowField | null = null;
    for (const [k, f] of this.fields) if (f !== keep && (!oldest || f.lastUsed < oldest.lastUsed)) { oldest = f; oldestKey = k; }
    if (!oldest) return false;
    this.dropField(oldestKey, oldest);
    return true;
  }
  private dropField(key: number, f: FlowField): void {
    if (this.bucketOwner === f) this.dropBuckets();
    this.release(f);
    this.fields.delete(key);
  }

  // ------------------------------------------------------------------ field tiles

  /**
   * Give tile `t` of the grid to field `f`, every cell UNTOUCHED, and return its slab offset. Over the memory budget
   * the least recently used other fields go first; the slab grows past the budget only when `f` is the last field
   * left, so a single march across the whole map always fits.
   */
  private takeTile(f: FlowField, t: number): number {
    while (this.freeTiles.length === 0 && this.tilesMade >= this.maxTiles && this.evict(f)) { /* until a tile comes free */ }
    let off: number;
    if (this.freeTiles.length > 0) off = this.freeTiles.pop()!;
    else {
      if ((this.tilesMade + 1) * TILE_CELLS > this.slab.length) {
        const grown = new Int32Array(Math.max(this.slab.length * 2, 64 * TILE_CELLS));
        grown.set(this.slab);
        this.slab = grown;
      }
      off = this.tilesMade++ * TILE_CELLS;
    }
    this.slab.fill(UNTOUCHED, off, off + TILE_CELLS);
    f.tiles[t] = off; f.held.push(t);
    return off;
  }
  /** hand every tile of a field back */
  private release(f: FlowField): void {
    const tiles = f.tiles, held = f.held;
    for (let i = 0; i < held.length; i++) { this.freeTiles.push(tiles[held[i]]); tiles[held[i]] = -1; }
    held.length = 0;
  }
  /** raw value of fine cell (fx,fy) in a field: UNTOUCHED, or `dist << 1 | settled` (see FlowField.tiles) */
  private valueAt(f: FlowField, fx: number, fy: number): number {
    const off = f.tiles[(fy >> TILE_SHIFT) * this.tilesW + (fx >> TILE_SHIFT)];
    return off < 0 ? UNTOUCHED : this.slab[off + ((fy & TILE_MASK) << TILE_SHIFT) + (fx & TILE_MASK)];
  }
  /** the A* heuristic of a field at fine cell (x,y): octile distance to the box it is aimed at (see FlowField.hx0) */
  private heur(f: FlowField, x: number, y: number): number {
    const ex = x < f.hx0 ? f.hx0 - x : x > f.hx1 ? x - f.hx1 : 0;
    const ey = y < f.hy0 ? f.hy0 - y : y > f.hy1 ? y - f.hy1 : 0;
    return ex > ey ? COST_STRAIGHT * ex + (COST_DIAG - COST_STRAIGHT) * ey : COST_STRAIGHT * ey + (COST_DIAG - COST_STRAIGHT) * ex;
  }
  /** memory the field tiles take right now, in bytes (tiles on the free list included: the slab never shrinks) */
  fieldMemory(): number { return this.slab.byteLength; }

  /**
   * Seeds of a field towards map cell (dcx,dcy): every passable fine cell of it at cost 0. A destination inside an
   * obstacle (forest, pond, building) seeds the nearest ring of passable cells around it instead, each at a cost that
   * grows with the true distance to the target (sqrt is IEEE-exact, so this stays deterministic), so a unit drifts
   * along the ring to the point closest to what was clicked. With nothing passable within DEST_SEED_RADIUS the
   * centre cell itself is seeded, blocked as it is. Fills `cells`/`costs`, returns the ring radius (0 without a ring).
   */
  private seedCells(dcx: number, dcy: number, heavy: boolean, team: number, cells: number[], costs: number[]): number {
    const w = this.w, h = this.h;
    cells.length = 0; costs.length = 0;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      const i = (dcy * SUB + sy) * w + dcx * SUB + sx;
      if (this.passable(i, heavy, team)) { cells.push(i); costs.push(0); }
    }
    if (cells.length > 0) return 0;
    const cfx = dcx * SUB + (SUB >> 1), cfy = dcy * SUB + (SUB >> 1);
    const tx2 = dcx * SUB * 2 + SUB, ty2 = dcy * SUB * 2 + SUB;
    for (let r = 1; r <= DEST_SEED_RADIUS; r++) {
      for (let y = cfy - r; y <= cfy + r; y++) for (let x = cfx - r; x <= cfx + r; x++) {
        if (Math.max(Math.abs(x - cfx), Math.abs(y - cfy)) !== r) continue;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (!this.passable(y * w + x, heavy, team)) continue;
        const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
        cells.push(y * w + x); costs.push(Math.floor((Math.sqrt(ex * ex + ey * ey) * COST_STRAIGHT) / 2));
      }
      if (cells.length > 0) return r;
    }
    cells.push(cfy * w + cfx); costs.push(0);
    return DEST_SEED_RADIUS;
  }

  /**
   * (re)start a field: give back whatever tiles the last run took and park the seeds as its frontier. The run starts
   * at the lowest seed key, which with the heuristic is far above zero - see BUCKETS for why it must not start below.
   */
  private seed(f: FlowField, dcx: number, dcy: number): void {
    if (this.bucketOwner === f) this.dropBuckets();
    this.release(f);
    f.openLen = 0; f.done = false; f.stale = false;
    const cells = this.seedCellScratch, costs = this.seedCostScratch;
    f.seedR = this.seedCells(dcx, dcy, f.heavy, f.team, cells, costs);
    const w = this.w, tiles = f.tiles;
    let lowest = 0x7fffffff;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const cx = c % w, cy = (c - cx) / w;
      const t = (cy >> TILE_SHIFT) * this.tilesW + (cx >> TILE_SHIFT);
      const off = tiles[t] >= 0 ? tiles[t] : this.takeTile(f, t);
      const at = off + ((cy & TILE_MASK) << TILE_SHIFT) + (cx & TILE_MASK);
      const v = this.slab[at];
      if (v < 0 || costs[i] < v >> 1) {
        this.slab[at] = costs[i] << 1;
        const key = costs[i] + this.heur(f, cx, cy);
        this.park(f, c, key);
        if (key < lowest) lowest = key;
      }
    }
    f.cur = lowest === 0x7fffffff ? 0 : lowest;
  }

  /** Distance to the destination from a fine cell, UNREACHABLE where this run has not reached (see FlowField.tiles). */
  distAt(f: FlowField, cell: number): number {
    const fx = cell % this.w;
    const v = this.valueAt(f, fx, (cell - fx) / this.w);
    return v < 0 ? UNREACHABLE : v >> 1;
  }
  /** has this cell been popped with its final distance? */
  isSettled(f: FlowField, cell: number): boolean {
    const fx = cell % this.w;
    return (this.valueAt(f, fx, (cell - fx) / this.w) & 1) === 1;
  }

  private push(c: number, d: number): void {
    const b = d & BUCKET_MASK;
    let arr = this.buckets[b];
    const n = this.bucketLen[b];
    if (n >= arr.length) { const na = new Int32Array(arr.length * 2); na.set(arr); this.buckets[b] = arr = na; }
    arr[n] = c; this.bucketLen[b] = n + 1;
    this.queued++;
  }

  /** hand the workspace back: live entries return to the owner's frontier, the buckets are emptied */
  private parkBuckets(): void {
    const f = this.bucketOwner;
    if (!f) { this.dropBuckets(); return; }
    const w = this.w;
    f.openLen = 0;
    for (let o = 0; o < BUCKETS && this.queued > 0; o++) {
      const d = f.cur + o, b = d & BUCKET_MASK;
      const n = this.bucketLen[b];
      if (n === 0) continue;
      const arr = this.buckets[b];
      for (let i = 0; i < n; i++) {
        const c = arr[i], cx = c % w;
        // settled already: a leftover duplicate (one with a better distance since is dropped when it comes up)
        if ((this.valueAt(f, cx, (c - cx) / w) & 1) === 1) continue;
        this.park(f, c, d);
      }
      this.bucketLen[b] = 0; this.queued -= n;
    }
    this.dropBuckets();
  }
  /** add (cell, key) to a field's parked frontier */
  private park(f: FlowField, c: number, key: number): void {
    const i = f.openLen << 1;
    if (i + 2 > f.open.length) { const na = new Int32Array(f.open.length * 2); na.set(f.open); f.open = na; }
    f.open[i] = c; f.open[i + 1] = key;
    f.openLen++;
  }
  /** empty the workspace without saving anything (the owner is being re-seeded or thrown away) */
  private dropBuckets(): void {
    if (this.queued > 0) this.bucketLen.fill(0);
    this.queued = 0;
    this.bucketOwner = null;
  }
  /** give the workspace to `f`, loading its parked frontier if it does not already hold it */
  private loadBuckets(f: FlowField): void {
    if (this.bucketOwner === f) return;
    this.parkBuckets();
    const open = f.open;
    for (let i = 0, n = f.openLen << 1; i < n; i += 2) this.push(open[i], open[i + 1]);
    this.bucketOwner = f;
  }

  /**
   * Run A* from the parked frontier (keyed by distance plus FlowField.hx0's heuristic) until `cell` is settled, the
   * frontier runs dry, or (without `force`) the tick's work budget - or `quota` of it, when that is not -1 - is
   * spent. Returns whether the cell is covered.
   * The bucket queue holds duplicates: an entry whose key no longer matches the cell's is a stale one and skipped.
   */
  private expand(f: FlowField, cell: number, force: boolean, quota: number): boolean {
    const stopAt = quota >= 0 && quota < this.workLeft ? this.workLeft - quota : 0;
    // out of work: say no before taking the workspace, whose hand-over costs a pass over two frontiers
    if (!force && this.workLeft <= stopAt) return false;
    const w = this.w, h = this.h, tw = this.tilesW, tiles = f.tiles;
    // the base layer of its weight class, and the team whose doors stand open in it
    const blocked = f.heavy ? this.blockedHeavy : this.blocked, door = this.door, dt = this.doorTeam(f.team);
    const hx0 = f.hx0, hy0 = f.hy0, hx1 = f.hx1, hy1 = f.hy1;
    const DIAG_EXTRA = COST_DIAG - COST_STRAIGHT;
    this.loadBuckets(f);
    let slab = this.slab;
    let cur = f.cur;
    let ok = false;
    while (this.queued > 0) {
      if (!force && this.workLeft <= stopAt) break;
      const b = cur & BUCKET_MASK;
      let n = this.bucketLen[b];
      if (n === 0) { cur++; continue; }
      // one entry at a time, off the top: a neighbour's key may equal the one being settled (a step straight at the
      // target), so settling refills the very bucket it takes from - and a push may swap in a bigger array
      const c = this.buckets[b][--n];
      this.bucketLen[b] = n; this.queued--;
      const cx = c % w, cy = (c - cx) / w;
      const lx = cx & TILE_MASK, ly = cy & TILE_MASK;
      const at = tiles[(cy >> TILE_SHIFT) * tw + (cx >> TILE_SHIFT)] + (ly << TILE_SHIFT) + lx;
      let ex = cx < hx0 ? hx0 - cx : cx > hx1 ? cx - hx1 : 0, ey = cy < hy0 ? hy0 - cy : cy > hy1 ? cy - hy1 : 0;
      const g = cur - (ex > ey ? COST_STRAIGHT * ex + DIAG_EXTRA * ey : COST_STRAIGHT * ey + DIAG_EXTRA * ex);
      // a duplicate left in the queue by a later, shorter route, or a cell already settled
      if (slab[at] !== g << 1) continue;
      slab[at] = (g << 1) | 1; this.workLeft--;
      // away from the tile's rim all eight neighbours share its tile: step by offset, no table lookup
      const inner = lx > 0 && lx < TILE_MASK && ly > 0 && ly < TILE_MASK;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nb = ny * w + nx;
        if (blocked[nb] !== 0 && door[nb] !== dt) continue;
        // no corner cutting through blocked cells
        if (k >= 4) {
          const a = cy * w + nx, c2 = ny * w + cx;
          if ((blocked[a] !== 0 && door[a] !== dt) || (blocked[c2] !== 0 && door[c2] !== dt)) continue;
        }
        let nAt: number;
        if (inner) nAt = at + TILE_STEP[k];
        else {
          const t = (ny >> TILE_SHIFT) * tw + (nx >> TILE_SHIFT);
          let off = tiles[t];
          if (off < 0) { off = this.takeTile(f, t); slab = this.slab; }
          nAt = off + ((ny & TILE_MASK) << TILE_SHIFT) + (nx & TILE_MASK);
        }
        const nv = slab[nAt];
        if ((nv & 1) === 1) continue;
        const nd = g + (k < 4 ? COST_STRAIGHT : COST_DIAG);
        if (nv < 0 || nd < nv >> 1) {
          slab[nAt] = nd << 1;
          ex = nx < hx0 ? hx0 - nx : nx > hx1 ? nx - hx1 : 0; ey = ny < hy0 ? hy0 - ny : ny > hy1 ? ny - hy1 : 0;
          this.push(nb, nd + (ex > ey ? COST_STRAIGHT * ex + DIAG_EXTRA * ey : COST_STRAIGHT * ey + DIAG_EXTRA * ex));
        }
      }
      // the asking cell is settled and its edges relaxed (a settled cell must never skip that): done
      if (c === cell) { ok = true; break; }
    }
    f.cur = cur;
    // the frontier stays in the workspace for the next caller; it is parked only when another field wants it
    if (this.queued === 0) { f.done = true; f.openLen = 0; this.dropBuckets(); return true; }
    return ok;
  }

  /**
   * Pick the neighbouring fine cell with the lowest distance. Returns a step index for stepDX/stepDY, or -1 at the
   * destination / in a local minimum / unreachable. Exact on a settled cell whose bucket has been passed (see fieldFor).
   */
  flowStep(f: FlowField, fx: number, fy: number): number {
    const w = this.w, h = this.h, blocked = f.heavy ? this.blockedHeavy : this.blocked, door = this.door, dt = this.doorTeam(f.team);
    const hv = this.valueAt(f, fx, fy);
    let best = hv < 0 ? UNREACHABLE : hv >> 1, bk = -1;
    for (let k = 0; k < 8; k++) {
      const nx = fx + DX[k], ny = fy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (k >= 4) {
        const a = fy * w + nx, c2 = ny * w + fx;
        if ((blocked[a] !== 0 && door[a] !== dt) || (blocked[c2] !== 0 && door[c2] !== dt)) continue;
      }
      const v = this.valueAt(f, nx, ny);
      const d = v < 0 ? UNREACHABLE : v >> 1;
      if (d < best) { best = d; bk = k; }
    }
    if (bk < 0) return -1;
    return bk;
  }
  stepDX(k: number) { return DX[k]; }
  stepDY(k: number) { return DY[k]; }

  /** Straight line (fixed-point endpoints) free of blocked fine cells (Bresenham). */
  lineFree(x0: number, y0: number, x1: number, y1: number, heavy = false, team = -1): boolean {
    let cx = x0 >> FINE_SHIFT, cy = y0 >> FINE_SHIFT;
    const tx = x1 >> FINE_SHIFT, ty = y1 >> FINE_SHIFT;
    const dx = Math.abs(tx - cx), dy = Math.abs(ty - cy);
    const sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1;
    let err = dx - dy;
    let guard = dx + dy + 2;
    // one layer lookup for the whole line: it is asked for by every mover every tick
    const b = heavy ? this.blockedHeavy : this.blocked, door = this.door, dt = this.doorTeam(team), w = this.w, h = this.h;
    while (guard-- > 0) {
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return false;
      const i = cy * w + cx;
      if (b[i] !== 0 && door[i] !== dt) return false;
      if (cx === tx && cy === ty) return true;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
    return true;
  }

  /**
   * Is fine cell (fx,fy) connected to what a field towards map cell (bx,by) would seed? Answered from the region
   * labels: a diagonal step needs both corner cells free, so the eight-way flow with that rule reaches exactly the
   * four-connected component - no field has to be computed to know whether a destination can be walked to.
   */
  private connectedToDest(fx: number, fy: number, bx: number, by: number, heavy: boolean, team: number): boolean {
    if (!this.inBoundsFine(fx, fy) || !this.inBounds(bx, by)) return false;
    const w = this.w, h = this.h;
    const reg = this.labelAt(fy * w + fx, heavy, team);
    if (reg < 0) return false;
    const cells = this.seedCellScratch, costs = this.seedCostScratch;
    this.seedCells(bx, by, heavy, team, cells, costs);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (this.passable(c, heavy, team)) { if (this.labelAt(c, heavy, team) === reg) return true; continue; }
      // the blocked centre seed: the flow leaves it through its passable orthogonal neighbours
      const cx = c % w, cy = (c - cx) / w;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (this.labelAt(ny * w + nx, heavy, team) === reg) return true;
      }
    }
    return false;
  }

  /** Can map cell b be reached from map cell a (from any of a's fine cells)? b may be a blocked footprint, see seedCells. */
  reachable(ax: number, ay: number, bx: number, by: number, heavy = false, team = -1): boolean {
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      if (this.connectedToDest(ax * SUB + sx, ay * SUB + sy, bx, by, heavy, team)) return true;
    }
    return false;
  }
  /** is the fine cell under a fixed-point position connected to map cell (bx,by)? */
  reachableFP(x: number, y: number, bx: number, by: number, heavy = false, team = -1): boolean {
    return this.connectedToDest(x >> FINE_SHIFT, y >> FINE_SHIFT, bx, by, heavy, team);
  }

  /** Nearest fully passable map cell to (cx,cy) within radius r cells (deterministic spiral); packed map index or -1. */
  nearestFree(cx: number, cy: number, r = 6, heavy = false, team = -1): number {
    if (!this.isBlockedCell(cx, cy, heavy, team)) return cy * this.mapW + cx;
    for (let d = 1; d <= r; d++) {
      for (let y = cy - d; y <= cy + d; y++) for (let x = cx - d; x <= cx + d; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== d) continue;
        if (!this.isBlockedCell(x, y, heavy, team)) return y * this.mapW + x;
      }
    }
    return -1;
  }
  /** Nearest passable fine cell to (fx,fy) within radius r fine cells; packed fine index or -1. */
  nearestFreeFine(fx: number, fy: number, r = 12, heavy = false, team = -1): number {
    if (!this.isBlockedFine(fx, fy, heavy, team)) return fy * this.w + fx;
    for (let d = 1; d <= r; d++) {
      for (let y = fy - d; y <= fy + d; y++) for (let x = fx - d; x <= fx + d; x++) {
        if (Math.max(Math.abs(x - fx), Math.abs(y - fy)) !== d) continue;
        if (!this.isBlockedFine(x, y, heavy, team)) return y * this.w + x;
      }
    }
    return -1;
  }
}

export const CELL_FP = FP_ONE;
