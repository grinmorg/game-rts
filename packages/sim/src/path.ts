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
 * Span of the bucket queue (Dial's algorithm). Every open distance lies within this many units of the distance being
 * settled: ring seeds spread over at most ~350 (see seedCells), and an edge adds at most COST_DIAG.
 */
const BUCKETS = 512;
const BUCKET_MASK = BUCKETS - 1;
/** memory the flow-field cache may take per pathfinder; caps the number of fields on big maps */
const FIELD_MEMORY_BUDGET = 48 << 20;
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
   * Per fine cell, valid only while `state` stamps it for the current `gen`: the final distance once settled, a
   * tentative one while on the frontier. Read it through Pathfinder.distAt, never directly - a cell this run has
   * not touched still holds whatever the previous run left there.
   */
  dist: Int32Array;
  /**
   * Per fine cell: `gen << 1` once touched, `(gen << 1) | 1` once settled, anything else = untouched this run.
   * Re-seeding a field is then a single counter bump instead of clearing two arrays over the whole grid, which is
   * what used to make fields on a big map expensive to start.
   */
  state: Int32Array;
  /** bumped on every (re)seed; stamps in `state` from earlier runs stop matching */
  gen: number;
  /** parked frontier: cells with a tentative distance, waiting to be settled */
  open: Int32Array;
  openLen: number;
  /** distance bucket being settled: every cell whose final distance is below it is settled */
  cur: number;
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
   * Passability with a team's own gates open, [light, heavy], kept only for teams that have a gate right now.
   * Everyone else walks the base layers: a team without gates has nothing to see differently, so its fields are
   * shared with the rest (see layerKey).
   */
  private teamLayers = new Map<number, [Uint8Array, Uint8Array]>();
  /** per map cell: 1 if the terrain is impassable */
  private terrain: Uint8Array;
  /** per map cell: 0 free, otherwise a key identifying the building/mine standing there (id + 2) */
  private foot: Int32Array;
  /** per map cell: 1 if that footprint opens seams towards other seam-opening footprints (every building but a fence) */
  private seam: Uint8Array;
  /** connected passable regions, label per fine cell (-1 blocked), one set per layer, rebuilt lazily per version */
  private regionLabels = new Map<number, { labels: Int32Array; version: number }>();
  private regionQueue: Int32Array;
  /** bumps on every passability change: regions and per-unit substitute destinations are cached against it */
  version = 1;
  private fields = new Map<number, FlowField>();
  private useCounter = 0;
  readonly maxFields: number;
  /** flow fields (re)seeded per tick before movers fall back to waiting */
  budgetPerTick = 12;
  usedThisTick = 0;
  /**
   * Fine cells settled per tick before movers fall back to waiting. This is what caps the worst tick: a frontier
   * that runs out simply resumes next tick, so a unit asking for a long new route starts walking a tick or two
   * later instead of everyone stalling for the length of a full Dijkstra.
   */
  workPerTick = 60_000;
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
  private snaps: Uint8Array[] = [];
  private changed = new Map<number, number[]>();

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
    this.gateCellNext = new Uint8Array(map.w * map.h);
    this.gateTeamNext = new Int8Array(map.w * map.h);
    this.refresh(0, 0, map.w, map.h);
    this.regionQueue = new Int32Array(n);
    // dist (4 bytes) + state (4 bytes) per fine cell and field
    this.maxFields = maxFields > 0 ? maxFields : Math.max(24, Math.min(128, Math.floor(FIELD_MEMORY_BUDGET / (n * 8))));
    for (let b = 0; b < BUCKETS; b++) this.buckets.push(new Int32Array(64));
    this.workLeft = this.workPerTick;
  }

  beginTick() { this.usedThisTick = 0; this.workLeft = this.workPerTick; }

  /**
   * Take every passability layer from another pathfinder over the same map (the renderer keeps its own copy so
   * drawing routes never eats the simulation's per-tick budget). The layers are replaced wholesale rather than
   * cell by cell, so every cached field is dropped instead of being checked against the change.
   */
  copyFrom(o: Pathfinder): void {
    this.blocked.set(o.blocked); this.blockedHeavy.set(o.blockedHeavy);
    this.terrain.set(o.terrain); this.foot.set(o.foot); this.seam.set(o.seam);
    this.gateCell.set(o.gateCell); this.gateTeam.set(o.gateTeam); this.gateOpen.set(o.gateOpen);
    this.teamLayers.clear();
    for (const [t, tl] of o.teamLayers) this.teamLayers.set(t, [tl[0].slice(), tl[1].slice()]);
    this.version = o.version;
    this.dropBuckets();
    this.fields.clear();
    this.regionLabels.clear();
  }

  /** the passability layer a unit uses: its weight class, with its own team's gates open */
  layer(heavy: boolean, team = -1): Uint8Array {
    const tl = team >= 0 ? this.teamLayers.get(team) : undefined;
    return tl ? tl[heavy ? 1 : 0] : heavy ? this.blockedHeavy : this.blocked;
  }
  /** which layer variant a team walks: 0 for the shared base layers, team + 1 for a team with gates of its own */
  private layerKey(team: number): number { return team >= 0 && this.teamLayers.has(team) ? team + 1 : 0; }
  /** one index over every layer, base and per team, light and heavy: fields and change tracking are kept per index */
  private layerIndex(heavy: boolean, key: number): number { return key * 2 + (heavy ? 1 : 0); }
  /** cache key of a field: destination and weight class within a layer, so any team id stays collision-free */
  private fieldKey(dest: number, heavy: boolean, key: number): number { return key * this.mapW * this.mapH * 2 + dest * 2 + (heavy ? 1 : 0); }
  /** every layer that exists right now, with its index */
  private allLayers(): { idx: number; arr: Uint8Array }[] {
    const out = [{ idx: 0, arr: this.blocked }, { idx: 1, arr: this.blockedHeavy }];
    for (const [t, tl] of this.teamLayers) out.push({ idx: this.layerIndex(false, t + 1), arr: tl[0] }, { idx: this.layerIndex(true, t + 1), arr: tl[1] });
    return out;
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
    const tls = this.teamLayers.size > 0 ? [...this.teamLayers] : null;
    const x0 = cx0 < 0 ? 0 : cx0, y0 = cy0 < 0 ? 0 : cy0;
    const x1 = cx0 + sw > mw ? mw : cx0 + sw, y1 = cy0 + sh > mh ? mh : cy0 + sh;
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
        // a team's own layers differ from the base in one place: the door of its gates stands open to it
        if (tls) {
          const door = this.gateOpen[fi];
          for (let i = 0; i < tls.length; i++) {
            const [t, tl] = tls[i];
            const pass = door === t && this.terrain[c] === 0;
            tl[0][fi] = pass ? 0 : light; tl[1][fi] = pass ? 0 : heavy;
          }
        }
      }
    }
  }

  /**
   * refresh() a rectangle and tell the cached fields which fine cells actually flipped, so only the fields that
   * depend on those cells are thrown away (a fence going up in one corner leaves the routes in the other alone).
   */
  private refreshTracked(cx0: number, cy0: number, sw: number, sh: number): void {
    const mw = this.mapW, mh = this.mapH, w = this.w;
    const x0 = (cx0 < 0 ? 0 : cx0) * SUB, y0 = (cy0 < 0 ? 0 : cy0) * SUB;
    const x1 = (cx0 + sw > mw ? mw : cx0 + sw) * SUB, y1 = (cy0 + sh > mh ? mh : cy0 + sh) * SUB;
    const rw = x1 - x0, rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return;
    if (this.fields.size === 0) { this.refresh(cx0, cy0, sw, sh); return; }
    // one snapshot per layer, base and per team alike: a door opening flips a team layer where the base stays put
    const layers = this.allLayers();
    while (this.snaps.length < layers.length) this.snaps.push(new Uint8Array(0));
    for (let l = 0; l < layers.length; l++) {
      if (this.snaps[l].length < rw * rh) this.snaps[l] = new Uint8Array(rw * rh);
      const snap = this.snaps[l], arr = layers[l].arr;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) snap[y * rw + x] = arr[(y0 + y) * w + x0 + x];
    }
    this.refresh(cx0, cy0, sw, sh);
    const changed = this.changed;
    changed.clear();
    for (let l = 0; l < layers.length; l++) {
      const snap = this.snaps[l], arr = layers[l].arr;
      let list: number[] | null = null;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const fi = (y0 + y) * w + x0 + x;
        if (snap[y * rw + x] !== arr[fi]) (list ??= []).push(fi);
      }
      if (list) changed.set(layers[l].idx, list);
    }
    if (changed.size === 0) return;
    for (const f of this.fields.values()) {
      if (f.stale) continue;
      const list = changed.get(f.layerIdx);
      if (!list) continue;
      for (let i = 0; i < list.length; i++) if (this.dependsOn(f, list[i])) { f.stale = true; break; }
    }
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
    const settledStamp = (f.gen << 1) | 1;
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = cx - 1; x <= cx + 1; x++) if (x >= 0 && x < w && f.state[y * w + x] === settledStamp) return true;
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
   * that has just got its first gate receives layers of its own (filled by a full refresh - it has no fields yet
   * that could go stale), a team that has lost its last one goes back to the shared base layers and its fields
   * are dropped.
   */
  setGates(gates: readonly Gate[]): void {
    const mw = this.mapW, mh = this.mapH, w = this.w, n = w * this.h;
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
    const openHalf = (c: number, dir: 0 | 1, high: boolean, t: number) => {
      const cx = c % mw, cy = (c - cx) / mw;
      for (let s = 0; s < SUB; s++) {
        if (dir === 0) this.gateOpen[(cy * SUB + s) * w + cx * SUB + (high ? 0 : SUB - 1)] = t;
        else this.gateOpen[(cy * SUB + (high ? 0 : SUB - 1)) * w + cx * SUB + s] = t;
      }
    };
    for (const g of gates) {
      for (const c of g.doorLow) openHalf(c, g.dir, false, g.team);
      for (const c of g.doorHigh) openHalf(c, g.dir, true, g.team);
    }
    // the layers that already exist flip at the changed cells, and the fields that ran through them go stale
    for (const c of changedCells) this.refreshTracked(c % mw, (c - (c % mw)) / mw, 1, 1);
    const teams = new Set<number>();
    for (const g of gates) teams.add(g.team);
    for (const t of [...this.teamLayers.keys()]) {
      if (teams.has(t)) continue;
      this.teamLayers.delete(t);
      this.regionLabels.delete(this.layerIndex(false, t + 1)); this.regionLabels.delete(this.layerIndex(true, t + 1));
      for (const [k, f] of [...this.fields]) if (f.team === t) { if (this.bucketOwner === f) this.dropBuckets(); this.fields.delete(k); }
    }
    for (const t of teams) {
      if (this.teamLayers.has(t)) continue;
      const tl: [Uint8Array, Uint8Array] = [new Uint8Array(n), new Uint8Array(n)];
      this.teamLayers.set(t, tl);
      this.fillTeamLayer(t, tl);
    }
    this.version++;
  }
  /**
   * Build a team's layers from scratch: they are the base layers with that team's own doors punched out, so a copy
   * and a handful of cells does it. Recomputing the whole map instead would cost a tick spike at the moment a team
   * finishes its first gate, which is exactly when several players tend to finish theirs.
   */
  private fillTeamLayer(team: number, tl: [Uint8Array, Uint8Array]): void {
    tl[0].set(this.blocked); tl[1].set(this.blockedHeavy);
    const w = this.w, mw = this.mapW;
    for (let fi = 0; fi < this.gateOpen.length; fi++) {
      if (this.gateOpen[fi] !== team) continue;
      const fx = fi % w, fy = (fi - fx) / w;
      if (this.terrain[(fy >> SUB_SHIFT) * mw + (fx >> SUB_SHIFT)] !== 0) continue; // a door on water is no door
      tl[0][fi] = 0; tl[1][fi] = 0;
    }
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
    const b = this.layer(heavy, team), w = this.w;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) if (b[(cy * SUB + sy) * w + cx * SUB + sx] !== 0) return true;
    return false;
  }
  isBlockedFine(fx: number, fy: number, heavy = false, team = -1): boolean {
    if (!this.inBoundsFine(fx, fy)) return true;
    return this.layer(heavy, team)[fy * this.w + fx] !== 0;
  }
  isBlockedFP(x: number, y: number, heavy = false, team = -1): boolean { return this.isBlockedFine(x >> FINE_SHIFT, y >> FINE_SHIFT, heavy, team); }
  /** fixed-point centre of a fine cell coordinate */
  fineCenter(f: number): number { return (f << FINE_SHIFT) + FINE_HALF; }

  private rebuildRegions(r: Int32Array, b: Uint8Array): void {
    const w = this.w, h = this.h, q = this.regionQueue;
    r.fill(-1);
    let label = 0;
    for (let start = 0; start < w * h; start++) {
      if (b[start] !== 0 || r[start] !== -1) continue;
      let head = 0, tail = 0;
      q[tail++] = start; r[start] = label;
      while (head < tail) {
        const c = q[head++];
        const cx = c % w, cy = (c - cx) / w;
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX[k], ny = cy + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (b[n] !== 0 || r[n] !== -1) continue;
          r[n] = label; q[tail++] = n;
        }
      }
      label++;
    }
  }
  private regions(heavy: boolean, team: number): Int32Array {
    const idx = this.layerIndex(heavy, this.layerKey(team));
    let r = this.regionLabels.get(idx);
    if (!r) { r = { labels: new Int32Array(this.w * this.h), version: -1 }; this.regionLabels.set(idx, r); }
    if (r.version !== this.version) { this.rebuildRegions(r.labels, this.layer(heavy, team)); r.version = this.version; }
    return r.labels;
  }
  /** region label of a passable fine cell, -1 for a blocked one */
  regionOf(fx: number, fy: number, heavy = false, team = -1): number {
    if (!this.inBoundsFine(fx, fy)) return -1;
    return this.regions(heavy, team)[fy * this.w + fx];
  }
  /**
   * The passable fine cell in the same region as (fromFx,fromFy) that lies closest to map cell (toCx,toCy) - where a
   * unit ends up when its destination is across water, inside a forest or behind a wall. -1 if `from` is blocked.
   */
  nearestReachable(fromFx: number, fromFy: number, toCx: number, toCy: number, heavy = false, team = -1): number {
    const r = this.regions(heavy, team);
    const reg = this.inBoundsFine(fromFx, fromFy) ? r[fromFy * this.w + fromFx] : -1;
    if (reg < 0) return -1;
    const w = this.w, h = this.h;
    // doubled fine coordinates so that map-cell and fine-cell centres are both integers
    const tx2 = toCx * SUB * 2 + SUB, ty2 = toCy * SUB * 2 + SUB;
    let best = -1, bestD = 0x7fffffff;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (r[y * w + x] !== reg) continue;
      const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
      const d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = y * w + x; }
    }
    return best;
  }

  // ------------------------------------------------------------------ flow fields

  /**
   * The flow field towards a destination map cell, advanced until the fine cell (fx,fy) is settled - a unit standing
   * there then reads exact distances for itself and every neighbour it could step to. Returns null when this tick's
   * budget (fields seeded or cells settled) is spent; the caller waits a tick and the frontier resumes where it stopped.
   * `force` ignores both budgets.
   */
  fieldFor(destCx: number, destCy: number, fx: number, fy: number, heavy = false, team = -1, force = false): FlowField | null {
    if (destCx < 0) destCx = 0; if (destCy < 0) destCy = 0;
    if (destCx >= this.mapW) destCx = this.mapW - 1; if (destCy >= this.mapH) destCy = this.mapH - 1;
    const dest = destCy * this.mapW + destCx;
    // a team without gates of its own walks the base layers, and shares their fields (see layerKey)
    const lk = this.layerKey(team);
    const key = this.fieldKey(dest, heavy, lk);
    let f = this.fields.get(key);
    if (!f || f.stale) {
      if (!force && this.usedThisTick >= this.budgetPerTick) return null;
      this.usedThisTick++;
      if (!f) {
        if (this.fields.size >= this.maxFields) this.evict();
        const n = this.w * this.h;
        f = { dest, dist: new Int32Array(n), state: new Int32Array(n), gen: 0, open: new Int32Array(1024), openLen: 0, cur: 0, done: false, stale: false, seedR: 0, lastUsed: 0, heavy, team: lk === 0 ? -1 : team, layerIdx: this.layerIndex(heavy, lk) };
        this.fields.set(key, f);
      }
      this.seed(f, destCx, destCy);
    }
    f.lastUsed = ++this.useCounter;
    if (fx < 0) fx = 0; else if (fx >= this.w) fx = this.w - 1;
    if (fy < 0) fy = 0; else if (fy >= this.h) fy = this.h - 1;
    const cell = fy * this.w + fx;
    if (f.done || (this.isSettled(f, cell) && f.cur > f.dist[cell])) return f;
    return this.expand(f, cell, force) ? f : null;
  }

  /** the cached field for a destination, if there is one - read only, for drawing routes; never seeds or expands */
  peekField(destCx: number, destCy: number, heavy = false, team = -1): FlowField | null {
    if (!this.inBounds(destCx, destCy)) return null;
    const f = this.fields.get(this.fieldKey(destCy * this.mapW + destCx, heavy, this.layerKey(team)));
    return f && !f.stale ? f : null;
  }

  private evict() {
    let oldestKey = -1, oldest: FlowField | null = null;
    for (const [k, f] of this.fields) if (!oldest || f.lastUsed < oldest.lastUsed) { oldest = f; oldestKey = k; }
    if (oldestKey >= 0) {
      if (this.bucketOwner === oldest) this.dropBuckets();
      this.fields.delete(oldestKey);
    }
  }

  /**
   * Seeds of a field towards map cell (dcx,dcy): every passable fine cell of it at cost 0. A destination inside an
   * obstacle (forest, pond, building) seeds the nearest ring of passable cells around it instead, each at a cost that
   * grows with the true distance to the target (sqrt is IEEE-exact, so this stays deterministic), so a unit drifts
   * along the ring to the point closest to what was clicked. With nothing passable within DEST_SEED_RADIUS the
   * centre cell itself is seeded, blocked as it is. Fills `cells`/`costs`, returns the ring radius (0 without a ring).
   */
  private seedCells(dcx: number, dcy: number, heavy: boolean, team: number, cells: number[], costs: number[]): number {
    const w = this.w, h = this.h, blocked = this.layer(heavy, team);
    cells.length = 0; costs.length = 0;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      const i = (dcy * SUB + sy) * w + dcx * SUB + sx;
      if (blocked[i] === 0) { cells.push(i); costs.push(0); }
    }
    if (cells.length > 0) return 0;
    const cfx = dcx * SUB + (SUB >> 1), cfy = dcy * SUB + (SUB >> 1);
    const tx2 = dcx * SUB * 2 + SUB, ty2 = dcy * SUB * 2 + SUB;
    for (let r = 1; r <= DEST_SEED_RADIUS; r++) {
      for (let y = cfy - r; y <= cfy + r; y++) for (let x = cfx - r; x <= cfx + r; x++) {
        if (Math.max(Math.abs(x - cfx), Math.abs(y - cfy)) !== r) continue;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (blocked[y * w + x] !== 0) continue;
        const ex = x * 2 + 1 - tx2, ey = y * 2 + 1 - ty2;
        cells.push(y * w + x); costs.push(Math.floor((Math.sqrt(ex * ex + ey * ey) * COST_STRAIGHT) / 2));
      }
      if (cells.length > 0) return r;
    }
    cells.push(cfy * w + cfx); costs.push(0);
    return DEST_SEED_RADIUS;
  }

  /** (re)start a field: bump its generation (which invalidates every stamp) and park the seeds as its frontier */
  private seed(f: FlowField, dcx: number, dcy: number): void {
    if (this.bucketOwner === f) this.dropBuckets();
    f.gen++;
    f.openLen = 0; f.cur = 0; f.done = false; f.stale = false;
    const touched = f.gen << 1;
    const cells = this.seedCellScratch, costs = this.seedCostScratch;
    f.seedR = this.seedCells(dcx, dcy, f.heavy, f.team, cells, costs);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (f.state[c] !== touched || costs[i] < f.dist[c]) { f.state[c] = touched; f.dist[c] = costs[i]; f.open[f.openLen++] = c; }
    }
  }

  /** Distance to the destination from a fine cell, UNREACHABLE where this run has not reached (see FlowField.dist). */
  distAt(f: FlowField, cell: number): number {
    return (f.state[cell] >> 1) === f.gen ? f.dist[cell] : UNREACHABLE;
  }
  /** has this cell been popped with its final distance? */
  isSettled(f: FlowField, cell: number): boolean { return f.state[cell] === ((f.gen << 1) | 1); }

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
    const touched = f.gen << 1;
    f.openLen = 0;
    for (let o = 0; o < BUCKETS && this.queued > 0; o++) {
      const d = f.cur + o, b = d & BUCKET_MASK;
      const n = this.bucketLen[b];
      if (n === 0) continue;
      const arr = this.buckets[b];
      for (let i = 0; i < n; i++) {
        const c = arr[i];
        if (f.state[c] !== touched || f.dist[c] !== d) continue;
        if (f.openLen >= f.open.length) { const na = new Int32Array(f.open.length * 2); na.set(f.open); f.open = na; }
        f.open[f.openLen++] = c;
      }
      this.bucketLen[b] = 0; this.queued -= n;
    }
    this.dropBuckets();
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
    for (let i = 0; i < f.openLen; i++) this.push(f.open[i], f.dist[f.open[i]]);
    this.bucketOwner = f;
  }

  /**
   * Run Dijkstra from the parked frontier until `cell` and everything it could step to are settled (cur > dist[cell]),
   * the frontier runs dry, or (without `force`) the tick's work budget is spent. Returns whether the cell is covered.
   * The bucket queue holds duplicates: an entry whose distance no longer matches the cell's is a stale one and skipped.
   */
  private expand(f: FlowField, cell: number, force: boolean): boolean {
    const w = this.w, h = this.h, dist = f.dist, state = f.state, blocked = this.layer(f.heavy, f.team);
    const touched = f.gen << 1, done = touched | 1;
    this.loadBuckets(f);
    let cur = f.cur;
    let ok = false;
    while (this.queued > 0) {
      if (state[cell] === done && cur > dist[cell]) { ok = true; break; }
      if (!force && this.workLeft <= 0) break;
      const b = cur & BUCKET_MASK;
      const n = this.bucketLen[b];
      if (n === 0) { cur++; continue; }
      const arr = this.buckets[b];
      this.bucketLen[b] = 0; this.queued -= n;
      for (let i = 0; i < n; i++) {
        const c = arr[i];
        // a duplicate left in the queue by a later, shorter route, or a cell already settled
        if (state[c] !== touched || dist[c] !== cur) continue;
        state[c] = done; this.workLeft--;
        const cx = c % w, cy = (c - cx) / w;
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX[k], ny = cy + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nb = ny * w + nx;
          if (blocked[nb] !== 0) continue;
          // no corner cutting through blocked cells
          if (k >= 4 && (blocked[cy * w + nx] !== 0 || blocked[ny * w + cx] !== 0)) continue;
          const nd = cur + (k < 4 ? COST_STRAIGHT : COST_DIAG);
          if (state[nb] === done) continue;
          if (state[nb] !== touched || nd < dist[nb]) { state[nb] = touched; dist[nb] = nd; this.push(nb, nd); }
        }
      }
      cur++;
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
    const w = this.w, h = this.h, blocked = this.layer(f.heavy, f.team);
    const here = this.distAt(f, fy * w + fx);
    let best = here, bk = -1;
    for (let k = 0; k < 8; k++) {
      const nx = fx + DX[k], ny = fy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (k >= 4 && (blocked[fy * w + nx] !== 0 || blocked[ny * w + fx] !== 0)) continue;
      const d = this.distAt(f, ny * w + nx);
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
    while (guard-- > 0) {
      if (this.isBlockedFine(cx, cy, heavy, team)) return false;
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
    const r = this.regions(heavy, team), w = this.w, h = this.h;
    const reg = r[fy * w + fx];
    if (reg < 0) return false;
    const cells = this.seedCellScratch, costs = this.seedCostScratch;
    this.seedCells(bx, by, heavy, team, cells, costs);
    const blocked = this.layer(heavy, team);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (blocked[c] === 0) { if (r[c] === reg) return true; continue; }
      // the blocked centre seed: the flow leaves it through its passable orthogonal neighbours
      const cx = c % w, cy = (c - cx) / w;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (r[ny * w + nx] === reg) return true;
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
