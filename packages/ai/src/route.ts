import { BuildingType, FP_SHIFT, Kind, Simulation, Tile, fp } from '@rookfall/sim';

/**
 * Something that shoots at whoever walks past: a watchtower or a castle the bot has seen, or a knot of enemy
 * soldiers. `r` is how far out it reaches, in cells from its centre, and `w` how much it hurts to walk through.
 */
export interface Threat { x: number; y: number; r: number; w: number }

export interface RouteOpts {
  /** the player asking: its own and its allies' buildings are solid, its team's gates are open */
  player: number;
  /** a catapult or a ram goes along: the one-cell seams between buildings are closed to it */
  heavy: boolean;
  /**
   * Price of one forest cell, in the same units as a step of open ground (10), or 0 when the squad cannot burn
   * its way through and forest is as solid as rock. A catapult's fire bomb clears a patch four cells across,
   * so a forest belt is a wait for the fire rather than a wall.
   */
  forestCost: number;
  /** price of one enemy fence section (0: solid); a squad with rams or catapults cuts through for much less */
  wallCost: number;
  /** percent weight on the danger of a cell: a raid walks round a tower's reach, an assault less so */
  dangerPct: number;
  /** cells of slack around the straight line's box that the search may use to go round something */
  margin: number;
}

export interface Route {
  /** map cells, packed y * w + x, from the start to the first cell of the goal area */
  cells: number[];
  /** indices into `cells` of the forest cells on the way, in walking order */
  forest: number[];
  /** indices into `cells` of the enemy fence sections on the way */
  walls: number[];
  /** index of the first cell under fire, -1 if the whole route stays out of it */
  exposed: number;
  /** summed danger of every cell on the route (before dangerPct) */
  danger: number;
  cost: number;
}

/** step prices: open ground straight and diagonal, 10 and 14 so the maths stays in integers */
const STEP = 10, DIAG = 14;
const BLOCKED = -1;
/** the eight neighbours, straight ones first */
const NX = [1, -1, 0, 0, 1, -1, 1, -1], NY = [0, 0, 1, -1, 1, 1, -1, -1];

// Scratch shared by every search. The bots run one after another on one thread, so one set is enough, and
// reusing it keeps a route plan from allocating anything past the first large box it meets.
let cap = 0;
let costOf = new Int32Array(0);   // per box cell: BLOCKED, or the extra price of entering it
let danger = new Int32Array(0);   // per box cell: summed threat weight
let kindOf = new Uint8Array(0);   // 0 open, 1 forest, 2 enemy fence
let gScore = new Int32Array(0);
let parent = new Int32Array(0);
let stamp = new Int32Array(0);    // search generation a cell's g/parent belong to
let closed = new Int32Array(0);
let heapF = new Int32Array(0), heapN = new Int32Array(0);
let generation = 0;

function ensure(n: number): void {
  if (n <= cap) return;
  cap = n;
  costOf = new Int32Array(n); danger = new Int32Array(n); kindOf = new Uint8Array(n);
  gScore = new Int32Array(n); parent = new Int32Array(n); stamp = new Int32Array(n); closed = new Int32Array(n);
  if (heapF.length < n * 2) { heapF = new Int32Array(n * 2); heapN = new Int32Array(n * 2); }
  generation = 0;
}

/**
 * A walking route from one map cell to within `goalR` cells of another, priced by what stands in the way: the
 * reach of towers and castles, enemy fences, forest. This is how a bot decides *which way* to go rather than
 * letting the flow field take the shortest line past every tower on the road - the answer is the side nobody
 * guards, a gap burnt through a wood, or the front door when that really is cheapest.
 *
 * Plain A* over map cells inside the box round the two ends (plus `margin`), eight-way, no corner cutting.
 * Everything is integer and every tie is broken by cell index, so every peer gets the same route.
 */
export function planRoute(sim: Simulation, fx: number, fy: number, tx: number, ty: number, goalR: number, threats: readonly Threat[], opts: RouteOpts): Route | null {
  const W = sim.map.w, H = sim.map.h;
  const x0 = Math.max(0, Math.min(fx, tx) - opts.margin), y0 = Math.max(0, Math.min(fy, ty) - opts.margin);
  const x1 = Math.min(W - 1, Math.max(fx, tx) + opts.margin), y1 = Math.min(H - 1, Math.max(fy, ty) + opts.margin);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = bw * bh;
  ensure(n);
  classify(sim, x0, y0, bw, bh, opts);
  paintThreats(threats, x0, y0, bw, bh);

  // a start inside something solid (a unit hugging a wall) walks from the nearest open cell instead
  let start = (fy - y0) * bw + (fx - x0);
  if (fx < x0 || fy < y0 || fx > x1 || fy > y1 || costOf[start] === BLOCKED) {
    start = nearestOpen(fx - x0, fy - y0, bw, bh);
    if (start < 0) return null;
  }
  const lx = tx - x0, ly = ty - y0, r2 = goalR * goalR;
  const inGoal = (i: number) => { const x = i % bw, y = (i - x) / bw; const dx = x - lx, dy = y - ly; return dx * dx + dy * dy <= r2; };
  const h = (i: number) => {
    const x = i % bw, y = (i - x) / bw;
    let dx = Math.abs(x - lx), dy = Math.abs(y - ly);
    // octile distance to the edge of the goal disc, never over-estimated
    const d = dx > dy ? dx * STEP + dy * (DIAG - STEP) : dy * STEP + dx * (DIAG - STEP);
    const cut = goalR * STEP;
    return d > cut ? d - cut : 0;
  };

  generation++;
  if (generation >= 0x3fffffff) { stamp.fill(0); closed.fill(0); generation = 1; }
  const gen = generation;
  let size = 0;
  const push = (f: number, node: number) => {
    // the heap grows rather than giving up: a route must never depend on how big a box some earlier search
    // happened to allocate, or two peers with different histories would plan different routes
    if (size >= heapF.length) {
      const nf = new Int32Array(heapF.length * 2), nn = new Int32Array(heapN.length * 2);
      nf.set(heapF); nn.set(heapN); heapF = nf; heapN = nn;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] < f || (heapF[p] === f && heapN[p] <= node)) break;
      heapF[i] = heapF[p]; heapN[i] = heapN[p]; i = p;
    }
    heapF[i] = f; heapN[i] = node;
  };
  const pop = (): number => {
    const top = heapN[0];
    const f = heapF[--size], node = heapN[size];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= size) break;
      if (c + 1 < size && (heapF[c + 1] < heapF[c] || (heapF[c + 1] === heapF[c] && heapN[c + 1] < heapN[c]))) c++;
      if (heapF[c] > f || (heapF[c] === f && heapN[c] >= node)) break;
      heapF[i] = heapF[c]; heapN[i] = heapN[c]; i = c;
    }
    heapF[i] = f; heapN[i] = node;
    return top;
  };

  stamp[start] = gen; gScore[start] = 0; parent[start] = -1;
  push(h(start), start);
  let goal = -1;
  while (size > 0) {
    const cur = pop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (inGoal(cur)) { goal = cur; break; }
    const cx = cur % bw, cy = (cur - cx) / bw, g = gScore[cur];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k], ny = cy + NY[k];
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const nb = ny * bw + nx;
      if (costOf[nb] === BLOCKED || closed[nb] === gen) continue;
      // no squeezing diagonally past a corner: both side cells must be walkable ground (not wood, not fence)
      if (k >= 4 && (costOf[cy * bw + nx] === BLOCKED || costOf[ny * bw + cx] === BLOCKED || kindOf[cy * bw + nx] !== 0 || kindOf[ny * bw + cx] !== 0)) continue;
      const step = (k < 4 ? STEP : DIAG) + costOf[nb] + ((danger[nb] * opts.dangerPct) / 100 | 0);
      const ng = g + step;
      if (stamp[nb] === gen && gScore[nb] <= ng) continue;
      stamp[nb] = gen; gScore[nb] = ng; parent[nb] = cur;
      push(ng + h(nb), nb);
    }
  }
  if (goal < 0) return null;

  const rev: number[] = [];
  for (let c = goal; c >= 0; c = parent[c]) rev.push(c);
  const cells: number[] = [], forest: number[] = [], walls: number[] = [];
  let exposed = -1, sum = 0;
  for (let i = rev.length - 1; i >= 0; i--) {
    const c = rev[i];
    const x = c % bw, y = (c - x) / bw;
    const idx = cells.length;
    cells.push((y + y0) * W + (x + x0));
    if (kindOf[c] === 1) forest.push(idx);
    else if (kindOf[c] === 2) walls.push(idx);
    if (danger[c] > 0 && exposed < 0) exposed = idx;
    sum += danger[c];
  }
  return { cells, forest, walls, exposed, danger: sum, cost: gScore[goal] };
}

/** what every box cell costs to enter, and whether it is forest or an enemy fence */
function classify(sim: Simulation, x0: number, y0: number, bw: number, bh: number, opts: RouteOpts): void {
  const path = sim.path, w = sim.world, tiles = sim.map.tiles, W = sim.map.w;
  const team = sim.team(opts.player);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x, cx = x + x0, cy = y + y0, m = cy * W + cx;
    danger[i] = 0; kindOf[i] = 0;
    if (path.isTerrainBlocked(cx, cy)) {
      if (tiles[m] === Tile.Forest && opts.forestCost > 0) {
        kindOf[i] = 1;
        // a cell already alight is passable in a few seconds and costs nothing more to wait out
        costOf[i] = sim.burnUntil[m] > 0 ? STEP : opts.forestCost;
      } else costOf[i] = BLOCKED;
      continue;
    }
    if (!path.isFootprint(cx, cy)) { costOf[i] = 0; continue; }
    const e = path.footprintOwner(cx, cy);
    if (e < 0 || !w.alive[e] || w.kind[e] !== Kind.Building) { costOf[i] = BLOCKED; continue; }
    const o = w.owner[e];
    if (o >= 0 && sim.sameTeam(opts.player, o)) {
      // Our own town: solid, except where it lets us through - a gate's door, or (for a man on foot) the seam
      // between two flush buildings. Both are half a cell wide, so a map cell counts as open when any of its
      // four fine cells is: asking whether the whole cell is clear shut the bot inside its own gates.
      const fx = cx * 2, fy = cy * 2;
      const open = !path.isBlockedFine(fx, fy, opts.heavy, team) || !path.isBlockedFine(fx + 1, fy, opts.heavy, team)
        || !path.isBlockedFine(fx, fy + 1, opts.heavy, team) || !path.isBlockedFine(fx + 1, fy + 1, opts.heavy, team);
      costOf[i] = open ? 0 : BLOCKED;
      continue;
    }
    if (w.type[e] === BuildingType.Wall && opts.wallCost > 0) { kindOf[i] = 2; costOf[i] = opts.wallCost; continue; }
    costOf[i] = BLOCKED;
  }
}

function paintThreats(threats: readonly Threat[], x0: number, y0: number, bw: number, bh: number): void {
  for (const t of threats) {
    const r = t.r, r2 = r * r;
    const ax = Math.max(0, t.x - r - x0), ay = Math.max(0, t.y - r - y0);
    const bx = Math.min(bw - 1, t.x + r - x0), by = Math.min(bh - 1, t.y + r - y0);
    for (let y = ay; y <= by; y++) {
      const dy = y + y0 - t.y;
      for (let x = ax; x <= bx; x++) {
        const dx = x + x0 - t.x;
        if (dx * dx + dy * dy <= r2) danger[y * bw + x] += t.w;
      }
    }
  }
}

function nearestOpen(lx: number, ly: number, bw: number, bh: number): number {
  for (let r = 0; r <= 6; r++) {
    for (let y = ly - r; y <= ly + r; y++) for (let x = lx - r; x <= lx + r; x++) {
      if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) !== r) continue;
      if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
      const i = y * bw + x;
      if (costOf[i] !== BLOCKED && kindOf[i] === 0) return i;
    }
  }
  return -1;
}

/** the fixed-point centre of a packed map cell */
export function cellCentre(sim: Simulation, c: number): { x: number; y: number } {
  const x = c % sim.map.w;
  return { x: fp(x + 0.5), y: fp((c - x) / sim.map.w + 0.5) };
}

/**
 * Turn points along a route, for a squad to be walked through one at a time. Between two points the sim's own
 * flow field takes over, and that takes the shortest line - so a point is placed wherever the straight line to
 * the next one would leave the route's corridor: through something solid, into forest or fence the route only
 * meant to cut at one spot, or into more danger than the route itself took on. `until` stops the walk early
 * (at the forest edge, at the fence), and a point is never more than `maxGap` cells from the last.
 */
export function waypoints(sim: Simulation, route: Route, threats: readonly Threat[], from: number, until: number, maxGap = 10): number[] {
  const cells = route.cells, W = sim.map.w, path = sim.path;
  const end = Math.min(until, cells.length - 1);
  const out: number[] = [];
  let a = from;
  const dangerAt = (c: number) => {
    const x = c % W, y = (c - x) / W;
    let d = 0;
    for (const t of threats) { const dx = x - t.x, dy = y - t.y; if (dx * dx + dy * dy <= t.r * t.r) d += t.w; }
    return d;
  };
  while (a < end) {
    let best = Math.min(end, a + 1);
    let worst = dangerAt(cells[a]);
    for (let b = a + 1; b <= end && b - a <= maxGap; b++) {
      const d = dangerAt(cells[b]);
      if (d > worst) worst = d;
      if (!straightClear(path, W, cells[a], cells[b], worst, dangerAt)) break;
      best = b;
    }
    out.push(cells[best]);
    a = best;
  }
  return out;
}

/** a straight walk between two cells that meets nothing solid and no more danger than `limit` */
function straightClear(path: Simulation['path'], W: number, from: number, to: number, limit: number, dangerAt: (c: number) => number): boolean {
  let x = from % W, y = (from - x) / W;
  const tx = to % W, ty = (to - tx) / W;
  const dx = Math.abs(tx - x), dy = Math.abs(ty - y), sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
  let err = dx - dy;
  for (let guard = dx + dy + 2; guard > 0; guard--) {
    if (path.isTerrainBlocked(x, y) || path.isFootprint(x, y)) return false;
    if (dangerAt(y * W + x) > limit) return false;
    if (x === tx && y === ty) return true;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return true;
}

/** the map cell under a fixed-point position */
export function cellAt(sim: Simulation, x: number, y: number): number {
  return (y >> FP_SHIFT) * sim.map.w + (x >> FP_SHIFT);
}
