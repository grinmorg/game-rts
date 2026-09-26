import { Rng } from './rng';
import { Tile } from './types';
import { GENERATED_MAPS } from './maps.generated';

export interface MapMine { x: number; y: number; gold: number }
/**
 * A candidate spawn. Every map offers two candidates per `zone`; a zone is one of the `maxPlayers`
 * symmetric corners/sides of the map. The simulation shuffles the zones and picks one candidate from
 * each, so spawns are random from match to match without players ever ending up next to each other.
 */
export interface MapStart { x: number; y: number; zone: number }
export interface MapDecor { x: number; y: number; type: number; scale: number; rot: number }

export interface MapData {
  id: string;
  name: string;
  w: number;
  h: number;
  maxPlayers: number;
  /** Tile per cell */
  tiles: Uint8Array;
  mines: MapMine[];
  /** candidate spawns, two per zone - see MapStart */
  starts: MapStart[];
  /** view-only decor (trees, rocks) - forest tiles are impassable; decor entries are cosmetic */
  decor: MapDecor[];
  /** seed used for visual heightmap */
  visualSeed: number;
}

export interface MapInfo { id: string; name: string; size: number; maxPlayers: number }

/** the procedural map: rolled from the match seed on every peer, never pre-generated */
export const RANDOM_MAP_ID = 'random';
/** the procedural 1v1 map used by the ranked ladder: 64x64, two zones, rolled from the match seed */
export const RANDOM_DUEL_MAP_ID = 'random-duel';
export function isRandomMapId(id: string): boolean { return id === RANDOM_MAP_ID || id === RANDOM_DUEL_MAP_ID; }
/**
 * Load-test map: `stress:<players>:<size>` - an open field with that many spawn zones on a ring, scattered
 * obstacles and plenty of gold. Only the stress harness (`?stress=` in the client) asks for it; it is never
 * offered in a lobby, so it may use cos/sin for the ring (see generateRandomMap for why online maps do not).
 */
export const STRESS_MAP_PREFIX = 'stress:';
export function stressMapId(players: number, size: number): string { return `${STRESS_MAP_PREFIX}${players}:${size}`; }
/** the hundred-player map: generated on every peer (integer-only, see generateGridMap), never pre-generated */
export const HUNDRED_MAP_ID = 'hundred-kingdoms';

export const OFFICIAL_MAPS: MapInfo[] = [
  { id: 'duel-valley', name: 'Duel Valley', size: 64, maxPlayers: 2 },
  { id: 'twin-rivers', name: 'Twin Rivers', size: 64, maxPlayers: 2 },
  { id: 'crossroads', name: 'Crossroads', size: 96, maxPlayers: 4 },
  { id: 'battle-arena', name: 'Battle Arena', size: 96, maxPlayers: 6 },
  { id: 'six-kingdoms', name: 'Six Kingdoms', size: 128, maxPlayers: 6 },
  { id: HUNDRED_MAP_ID, name: 'Hundred Kingdoms', size: 512, maxPlayers: 100 },
  { id: RANDOM_DUEL_MAP_ID, name: 'Random Duel', size: 64, maxPlayers: 2 },
  { id: RANDOM_MAP_ID, name: 'Random', size: 96, maxPlayers: 4 },
];

export function isPassableTile(t: number): boolean {
  return t === Tile.Grass || t === Tile.Dirt;
}

const mapCache = new Map<string, MapData>();

/**
 * Load an official map. Maps are pre-generated into maps.generated.ts so every client and the
 * server share bit-identical tile data (the generator uses Math.sin/hypot which are not
 * guaranteed to be identical across JS engines).
 */
export function createMap(id: string, seed = 1): MapData {
  if (id === RANDOM_MAP_ID) return generateRandomMap(seed);
  if (id === RANDOM_DUEL_MAP_ID) return generateRandomMap(seed, 64, 2);
  if (id.startsWith(STRESS_MAP_PREFIX)) {
    const [, p, sz] = id.split(':');
    return generateStressMap(Number(p) || 6, Number(sz) || 128, seed);
  }
  const cached = mapCache.get(id);
  if (cached) return cached;
  if (id === HUNDRED_MAP_ID) { const g = generateGridMap(id, 'Hundred Kingdoms', 10, 50, 1009); mapCache.set(id, g); return g; }
  const src = GENERATED_MAPS[id] ?? GENERATED_MAPS['duel-valley'];
  const m = src ? deserializeMap(src) : generateMap(id);
  mapCache.set(id, m);
  return m;
}

/** Procedural generator - used only by scripts/gen-maps.ts (and as a fallback). */
export function generateMap(id: string): MapData {
  switch (id) {
    case 'duel-valley': return genMap(id, 'Duel Valley', 64, 2, 101, 'vertical');
    case 'twin-rivers': return genMap(id, 'Twin Rivers', 64, 2, 202, 'rivers');
    case 'crossroads': return genMap(id, 'Crossroads', 96, 4, 303, 'quad');
    case 'battle-arena': return genMap(id, 'Battle Arena', 96, 6, 404, 'ring');
    case 'six-kingdoms': return genMap(id, 'Six Kingdoms', 128, 6, 505, 'ring');
    default: return genMap('duel-valley', 'Duel Valley', 64, 2, 101, 'vertical');
  }
}


export function generateStressMap(players: number, size: number, seed: number): MapData {
  const w = size, h = size;
  const rng = new Rng((seed ^ 0x51ed270b) | 0);
  const tiles = new Uint8Array(w * h);
  const mines: MapMine[] = [];
  const starts: MapStart[] = [];
  const decor: MapDecor[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) tiles[y * w + x] = Tile.Rock;
  const cx = w >> 1, cy = h >> 1;
  // spawn zones on a ring, two candidates each, a couple of deposits next to every one of them
  const ring = Math.floor(size * 0.38);
  const anchors: { x: number; y: number }[] = [];
  for (let z = 0; z < players; z++) {
    const a = (z / players) * Math.PI * 2 - Math.PI / 2;
    const ax = clampI(Math.round(cx + Math.cos(a) * ring), 8, w - 9), ay = clampI(Math.round(cy + Math.sin(a) * ring), 8, h - 9);
    anchors.push({ x: ax, y: ay });
    starts.push({ x: ax, y: ay, zone: z }, { x: clampI(ax + 4, 8, w - 9), y: clampI(ay - 4, 8, h - 9), zone: z });
    mines.push({ x: clampI(ax + 6, 4, w - 5), y: clampI(ay + 1, 4, h - 5), gold: 6000 }, { x: clampI(ax - 2, 4, w - 5), y: clampI(ay + 6, 4, h - 5), gold: 6000 });
  }
  mines.push({ x: cx, y: cy, gold: 12000 });
  // obstacles: forests, rocks and ponds scattered over the field, kept clear of the spawns and the middle
  const blobs = Math.round((size * size) / 700);
  for (let i = 0; i < blobs; i++) {
    const bx = rng.range(6, w - 7), by = rng.range(6, h - 7), r = rng.range(2, 4);
    let near = (bx - cx) * (bx - cx) + (by - cy) * (by - cy) < 100;
    for (const an of anchors) if ((bx - an.x) * (bx - an.x) + (by - an.y) * (by - an.y) < 196) near = true;
    if (near) continue;
    const roll = rng.nextInt(10);
    const t = roll < 6 ? Tile.Forest : roll < 8 ? Tile.Rock : Tile.Water;
    for (let y = by - r; y <= by + r; y++) for (let x = bx - r; x <= bx + r; x++) {
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
      const d2 = (x - bx) * (x - bx) + (y - by) * (y - by);
      if (d2 <= r * r && tiles[y * w + x] === Tile.Grass) tiles[y * w + x] = t;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (tiles[y * w + x] !== Tile.Forest) continue;
    decor.push({ x: x + 0.5, y: y + 0.5, type: rng.nextInt(3), scale: 0.85 + rng.nextInt(30) / 100, rot: rng.nextInt(628) / 100 });
  }
  return { id: stressMapId(players, size), name: `Stress ${players}p ${size}`, w, h, maxPlayers: players, tiles, mines, starts, decor, visualSeed: seed | 0 };
}

type Layout = 'vertical' | 'rivers' | 'quad' | 'ring';

/**
 * Procedural map generated at match start from the seed. Unlike the official maps it runs on
 * every peer, so it uses only integer arithmetic, the seeded PRNG and squared-distance tests - no sin/cos/
 * hypot, whose last bits differ between JS engines and would desync the lockstep. Layout: one corner zone
 * per player, a base deposit per zone, mirrored expansion deposits, a rich centre, random ponds, forests
 * and rocks, and carved corridors so every start reaches the middle.
 *
 * Four players (96x96, the `random` map) mirror across both axes; two players (64x64, the `random-duel`
 * map the ranked ladder runs on) mirror by a 180 degrees turn around the centre, which puts the two bases
 * in opposite corners and gives both sides the same terrain on the way in.
 */
export function generateRandomMap(seed: number, size = 96, players = 4): MapData {
  const w = size, h = size;
  const duel = players === 2;
  const rng = new Rng((seed ^ 0x2545f491) | 0);
  const tiles = new Uint8Array(w * h);
  const mines: MapMine[] = [];
  const starts: MapStart[] = [];
  const decor: MapDecor[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) tiles[y * w + x] = Tile.Rock;
  // 4p: mirrored across both axes. 2p: rotated half a turn, so the sampled half covers the whole map.
  const mirror = (x: number, y: number): [number, number][] => (duel
    ? [[x, y], [w - 1 - x, h - 1 - y]]
    : [[x, y], [w - 1 - x, y], [x, h - 1 - y], [w - 1 - x, h - 1 - y]]);
  const cx = w >> 1, cy = h >> 1;

  // zones in the corners; the two candidates sit along the two edges next to the corner
  const margin = duel ? rng.range(13, 17) : rng.range(12, 16);
  const off = rng.range(4, 7);
  const anchors = mirror(margin, margin);
  /** the half (2p) or quadrant (4p) features are rolled in before being mirrored into place */
  const sampleW = duel ? w - 8 : cx;
  for (let z = 0; z < anchors.length; z++) {
    const [ax, ay] = anchors[z];
    const sx = ax < cx ? 1 : -1, sy = ay < cy ? 1 : -1;
    starts.push({ x: ax + sx * off, y: ay, zone: z });
    starts.push({ x: ax, y: ay + sy * off, zone: z });
    // base deposit toward the corner, away from the centre
    mines.push({ x: clampI(ax - sx * 6, 4, w - 5), y: clampI(ay - sy * 6, 4, h - 5), gold: 6000 });
  }
  // expansion deposits: two random spots in the sampled region, mirrored
  for (let i = 0; i < 2; i++) {
    for (let tries = 0; tries < 40; tries++) {
      const x = rng.range(8, sampleW - 6), y = rng.range(8, cy - 6);
      if (nearAnchor(anchors, x, y, 12)) continue; // not on top of a base
      if (mines.some((m) => (m.x - x) * (m.x - x) + (m.y - y) * (m.y - y) < 10 * 10)) continue;
      for (const [mx, my] of mirror(x, y)) mines.push({ x: mx, y: my, gold: 6000 });
      break;
    }
  }
  mines.push({ x: cx, y: cy, gold: duel ? 8000 : 10000 });

  // ponds: mirrored circles, kept off the corner bases
  const ponds = rng.range(2, 4);
  for (let i = 0; i < ponds; i++) {
    const px = rng.range(10, sampleW - 4), py = rng.range(10, cy - 4), r = rng.range(2, 4);
    if (nearAnchor(anchors, px, py, 14)) continue;
    for (const [mx, my] of mirror(px, py)) paintCircleInt(tiles, w, h, mx, my, r, Tile.Water);
  }
  // forests and rocks
  const blobs = duel ? rng.range(8, 12) : rng.range(10, 16);
  for (let i = 0; i < blobs; i++) {
    const bx = rng.range(4, sampleW), by = rng.range(4, cy), r = rng.range(2, 4);
    const t = rng.chance(0.72) ? Tile.Forest : Tile.Rock;
    for (const [mx, my] of mirror(bx, by)) paintBlobInt(tiles, w, h, mx, my, r, t, rng);
  }
  // breathing room and guaranteed routes
  for (const s2 of starts) clearAreaInt(tiles, w, h, s2.x, s2.y, 7);
  for (const m of mines) clearAreaInt(tiles, w, h, m.x, m.y, 4);
  for (const s2 of starts) carve(tiles, w, h, s2.x, s2.y, cx, cy);
  for (const m of mines) carve(tiles, w, h, m.x, m.y, cx, cy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = tiles[y * w + x];
    if (t === Tile.Forest) decor.push({ x: x + 0.5, y: y + 0.5, type: rng.nextInt(3), scale: 0.8 + rng.nextFloat() * 0.5, rot: rng.nextFloat() * 6.283 });
    else if (t === Tile.Rock && x > 1 && y > 1 && x < w - 2 && y < h - 2 && rng.chance(0.35)) decor.push({ x: x + 0.5, y: y + 0.5, type: 3 + rng.nextInt(2), scale: 0.9 + rng.nextFloat() * 0.6, rot: rng.nextFloat() * 6.283 });
  }
  return { id: duel ? RANDOM_DUEL_MAP_ID : RANDOM_MAP_ID, name: duel ? 'Random Duel' : 'Random', w, h, maxPlayers: players, tiles, mines, starts, decor, visualSeed: seed | 0 };
}

/** squared-distance test against every zone anchor (integer only, like the rest of the generator) */
function nearAnchor(anchors: [number, number][], x: number, y: number, r: number): boolean {
  for (const [ax, ay] of anchors) if ((ax - x) * (ax - x) + (ay - y) * (ay - y) < r * r) return true;
  return false;
}

/** integer-only blob: solid inside r-0.5, ragged edge to r+0.3 (compared as scaled squares) */
function paintBlobInt(tiles: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, t: number, rng: Rng) {
  const inner = (2 * r - 1) * (2 * r - 1), outer = (10 * r + 3) * (10 * r + 3);
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (4 * d2 <= inner || (100 * d2 <= outer && rng.chance(0.5))) {
      if (tiles[y * w + x] === Tile.Grass) tiles[y * w + x] = t;
    }
  }
}
function paintCircleInt(tiles: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, t: number) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) tiles[y * w + x] = t;
  }
}
function clearAreaInt(tiles: Uint8Array, w: number, h: number, cx: number, cy: number, r: number) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) tiles[y * w + x] = Tile.Grass;
  }
}

/** how far (radians around the map centre) the two candidates of a zone sit from its anchor */
const SPAWN_SPREAD = 0.2;

function genMap(id: string, name: string, size: number, players: number, seed: number, layout: Layout): MapData {
  const w = size, h = size;
  const rng = new Rng(seed);
  const tiles = new Uint8Array(w * h);
  const mines: MapMine[] = [];
  const starts: MapStart[] = [];
  const decor: MapDecor[] = [];

  // Border of rock
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) tiles[y * w + x] = Tile.Rock;
  }

  // Zone anchors: one per player slot, laid out symmetrically as before
  const margin = Math.round(size * 0.16);
  const cx = w / 2, cy = h / 2;
  const anchors: { x: number; y: number }[] = [];
  if (layout === 'vertical' || layout === 'rivers') {
    anchors.push({ x: margin + 2, y: Math.round(cy) });
    anchors.push({ x: w - margin - 3, y: Math.round(cy) });
  } else if (layout === 'quad') {
    anchors.push({ x: margin, y: margin });
    anchors.push({ x: w - margin - 1, y: h - margin - 1 });
    anchors.push({ x: w - margin - 1, y: margin });
    anchors.push({ x: margin, y: h - margin - 1 });
  } else {
    const r = size / 2 - margin;
    for (let i = 0; i < players; i++) {
      const a = (i / players) * Math.PI * 2 - Math.PI / 2;
      anchors.push({ x: Math.round(cx + Math.cos(a) * r), y: Math.round(cy + Math.sin(a) * r) });
    }
  }

  // Two spawn candidates per zone, the anchor swung around the map centre by +-SPAWN_SPREAD.
  // Rotating around the centre keeps every candidate the same distance from the middle of the map,
  // so which one a player draws never changes how exposed their base is.
  for (let z = 0; z < anchors.length; z++) {
    const an = anchors[z];
    const a0 = Math.atan2(an.y - cy, an.x - cx);
    const r = Math.hypot(an.x - cx, an.y - cy);
    for (const d of [-SPAWN_SPREAD, SPAWN_SPREAD]) {
      starts.push({
        x: clampI(Math.round(cx + Math.cos(a0 + d) * r), 5, w - 6),
        y: clampI(Math.round(cy + Math.sin(a0 + d) * r), 5, h - 6),
        zone: z,
      });
    }
  }

  // Base mines: one per zone (at the anchor, so both candidates of that zone are equally close),
  // offset toward the map edge, plus expansion mines
  for (const s of anchors) {
    const dx = Math.sign(cx - s.x) || 0;
    const dy = Math.sign(cy - s.y) || 0;
    // mine placed 6 cells away from the anchor, away from center
    let mx = s.x - dx * 6, my = s.y - dy * 6;
    if (dx === 0 && dy === 0) mx = s.x + 6;
    mines.push({ x: clampI(mx, 4, w - 5), y: clampI(my, 4, h - 5), gold: 6000 });
  }
  // Expansion mines - symmetric: mirrored copies of a few random picks
  const expCount = layout === 'ring' ? players : players;
  for (let i = 0; i < expCount; i++) {
    if (layout === 'vertical' || layout === 'rivers') {
      const yy = i % 2 === 0 ? Math.round(h * 0.2) : Math.round(h * 0.8);
      const xx = Math.round(w * (0.3 + 0.1 * (i >> 1)));
      mines.push({ x: xx, y: yy, gold: 6000 });
      mines.push({ x: w - 1 - xx, y: yy, gold: 6000 });
      if (i >= 1) break;
    } else if (layout === 'quad') {
      // mid-edge mines
      const m = [
        { x: Math.round(cx), y: margin - 4 }, { x: Math.round(cx), y: h - margin + 3 },
        { x: margin - 4, y: Math.round(cy) }, { x: w - margin + 3, y: Math.round(cy) },
      ][i];
      mines.push({ x: clampI(m.x, 4, w - 5), y: clampI(m.y, 4, h - 5), gold: 6000 });
    } else {
      const a = ((i + 0.5) / players) * Math.PI * 2 - Math.PI / 2;
      const r = size / 2 - margin - 6;
      mines.push({ x: Math.round(cx + Math.cos(a) * r * 0.55), y: Math.round(cy + Math.sin(a) * r * 0.55), gold: 6000 });
    }
  }
  // Center mine(s)
  if (layout !== 'ring') mines.push({ x: Math.round(cx), y: Math.round(cy), gold: 8000 });
  else mines.push({ x: Math.round(cx), y: Math.round(cy), gold: 10000 });

  // Water features
  if (layout === 'rivers') {
    // two rivers with gaps
    for (let y = 2; y < h - 2; y++) {
      const wob = Math.round(Math.sin(y * 0.25) * 2);
      for (const rx of [Math.round(w * 0.36), Math.round(w * 0.64)]) {
        for (let k = -1; k <= 1; k++) {
          const x = rx + k + wob;
          const gap = (y > h * 0.42 && y < h * 0.58) || y < h * 0.12 || y > h * 0.88;
          if (!gap) tiles[y * w + x] = Tile.Water;
        }
      }
    }
  } else if (layout === 'ring') {
    // central lake ring with 4 bridges
    const rIn = size * 0.09, rOut = size * 0.13;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > rIn && d < rOut) {
        const a = Math.atan2(y - cy, x - cx);
        const bridge = Math.abs(Math.sin(a * 2)) < 0.18;
        if (!bridge) tiles[y * w + x] = Tile.Water;
      }
    }
  } else if (layout === 'quad') {
    // diagonal ponds
    for (const [px, py] of [[cx * 0.5, cy], [cx * 1.5, cy], [cx, cy * 0.5], [cx, cy * 1.5]]) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (Math.hypot(x - px, y - py) < size * 0.04) tiles[y * w + x] = Tile.Water;
      }
    }
  } else {
    // vertical: a couple of ponds top and bottom center
    for (const [px, py] of [[cx, cy * 0.35], [cx, cy * 1.65]]) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (Math.hypot(x - px, (y - py) * 1.6) < size * 0.06) tiles[y * w + x] = Tile.Water;
      }
    }
  }

  // Forests & rocks: symmetric blobs. Generate on one half and mirror (for 2p) or rotate (for ring/quad).
  const blobs = Math.round(size * size / 900);
  for (let i = 0; i < blobs; i++) {
    const bx = rng.range(4, w - 5), by = rng.range(4, h - 5);
    const r = rng.range(2, 4);
    const t = rng.chance(0.7) ? Tile.Forest : Tile.Rock;
    const pts = symmetricPoints(bx, by, w, h, layout, players);
    for (const p of pts) paintBlob(tiles, w, h, p.x, p.y, r, t, rng);
  }

  // Keep starts and mines clear
  for (const s of starts) clearArea(tiles, w, h, s.x, s.y, 7);
  for (const m of mines) clearArea(tiles, w, h, m.x, m.y, 4);
  // Corridor between each start and the center is guaranteed clear-ish
  for (const s of starts) carve(tiles, w, h, s.x, s.y, Math.round(cx), Math.round(cy));
  for (const m of mines) carve(tiles, w, h, m.x, m.y, Math.round(cx), Math.round(cy));

  // Decor from forest tiles: trees; rocks from rock tiles (thinned)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = tiles[y * w + x];
    if (t === Tile.Forest) {
      decor.push({ x: x + 0.5, y: y + 0.5, type: rng.nextInt(3), scale: 0.8 + rng.nextFloat() * 0.5, rot: rng.nextFloat() * 6.283 });
    } else if (t === Tile.Rock && x > 1 && y > 1 && x < w - 2 && y < h - 2 && rng.chance(0.35)) {
      decor.push({ x: x + 0.5, y: y + 0.5, type: 3 + rng.nextInt(2), scale: 0.9 + rng.nextFloat() * 0.6, rot: rng.nextFloat() * 6.283 });
    }
  }

  return { id, name, w, h, maxPlayers: players, tiles, mines, starts, decor, visualSeed: seed * 7919 };
}

function symmetricPoints(x: number, y: number, w: number, h: number, layout: Layout, players: number) {
  const pts = [{ x, y }];
  if (layout === 'vertical' || layout === 'rivers') pts.push({ x: w - 1 - x, y });
  else if (layout === 'quad') { pts.push({ x: w - 1 - x, y }, { x, y: h - 1 - y }, { x: w - 1 - x, y: h - 1 - y }); }
  else {
    const cx = w / 2, cy = h / 2;
    const a0 = Math.atan2(y - cy, x - cx), r = Math.hypot(x - cx, y - cy);
    for (let i = 1; i < players; i++) {
      const a = a0 + (i / players) * Math.PI * 2;
      pts.push({ x: Math.round(cx + Math.cos(a) * r), y: Math.round(cy + Math.sin(a) * r) });
    }
  }
  return pts;
}

function paintBlob(tiles: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, t: number, rng: Rng) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (d <= r - 0.5 || (d <= r + 0.3 && rng.chance(0.5))) {
      if (tiles[y * w + x] === Tile.Grass) tiles[y * w + x] = t;
    }
  }
}
function clearArea(tiles: Uint8Array, w: number, h: number, cx: number, cy: number, r: number) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    if (Math.hypot(x - cx, y - cy) <= r) tiles[y * w + x] = Tile.Grass;
  }
}
function carve(tiles: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps), y = Math.round(y0 + ((y1 - y0) * i) / steps);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 2 || yy < 2 || xx >= w - 2 || yy >= h - 2) continue;
      const t = tiles[yy * w + xx];
      if (t === Tile.Forest || t === Tile.Rock) tiles[yy * w + xx] = Tile.Grass;
      if (t === Tile.Water) tiles[yy * w + xx] = Tile.Dirt; // bridge
    }
  }
}
function clampI(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * A map for a hundred players (or any n x n): kingdoms on a square grid, `pitch` cells apart. Every kingdom sits in
 * the same square of ground - one pattern of forest, rock and water rolled once and laid into every square, mirrored
 * by the square's parity - so no start is better than another but for being on the edge of the map. Between
 * neighbours the ground stays open along the lines joining their castles, and where four squares meet there is a
 * contested deposit. Integer-only like generateRandomMap, so it is generated on every peer instead of shipped;
 * only the decor uses floats.
 */
export function generateGridMap(id: string, name: string, n: number, pitch: number, seed: number): MapData {
  const size = n * pitch + 12;
  const w = size, h = size, margin = 6;
  const rng = new Rng(seed);
  const tiles = new Uint8Array(w * h);
  const mines: MapMine[] = [];
  const starts: MapStart[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) tiles[y * w + x] = Tile.Rock;
  // one square's obstacles, in local coordinates, kept off the castle, the lanes to the neighbours and the corners
  const c = pitch >> 1;
  const pattern = new Uint8Array(pitch * pitch);
  const keepClear = (x: number, y: number) => {
    if (Math.abs(x - c) <= 12 && Math.abs(y - c) <= 12) return true; // the town
    if (Math.abs(x - c) <= 3 || Math.abs(y - c) <= 3) return true; // lanes to the four neighbours
    const ex = Math.min(x, pitch - 1 - x), ey = Math.min(y, pitch - 1 - y);
    return ex * ex + ey * ey <= 64; // the deposit where four squares meet
  };
  for (let b = 0; b < 12; b++) {
    const bx = rng.range(3, pitch - 4), by = rng.range(3, pitch - 4), r = rng.range(2, 5);
    const roll = rng.nextInt(20);
    const t = roll < 12 ? Tile.Forest : roll < 17 ? Tile.Rock : Tile.Water;
    for (let y = by - r; y <= by + r; y++) for (let x = bx - r; x <= bx + r; x++) {
      if (x < 0 || y < 0 || x >= pitch || y >= pitch || keepClear(x, y)) continue;
      if ((x - bx) * (x - bx) + (y - by) * (y - by) <= r * r + r) pattern[y * pitch + x] = t;
    }
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const ox = margin + i * pitch, oy = margin + j * pitch;
    for (let y = 0; y < pitch; y++) for (let x = 0; x < pitch; x++) {
      const t = pattern[((j & 1) ? pitch - 1 - y : y) * pitch + ((i & 1) ? pitch - 1 - x : x)];
      if (t) tiles[(oy + y) * w + ox + x] = t;
    }
    // two spawn candidates either side of the square's centre, the square's own deposit below or above it
    const cx = ox + c, cy = oy + c, zone = j * n + i;
    starts.push({ x: cx - 4, y: cy, zone }, { x: cx + 4, y: cy, zone });
    mines.push({ x: cx, y: (j & 1) ? cy - 8 : cy + 8, gold: 6000 });
  }
  for (let j = 1; j < n; j++) for (let i = 1; i < n; i++) mines.push({ x: margin + i * pitch, y: margin + j * pitch, gold: 8000 });
  const decor: MapDecor[] = [];
  const drng = new Rng(seed ^ 0x3c6ef372);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = tiles[y * w + x];
    if (t === Tile.Forest) decor.push({ x: x + 0.5, y: y + 0.5, type: drng.nextInt(3), scale: 0.8 + drng.nextFloat() * 0.5, rot: drng.nextFloat() * 6.283 });
    else if (t === Tile.Rock && x > 1 && y > 1 && x < w - 2 && y < h - 2 && drng.chance(0.35)) decor.push({ x: x + 0.5, y: y + 0.5, type: 3 + drng.nextInt(2), scale: 0.9 + drng.nextFloat() * 0.6, rot: drng.nextFloat() * 6.283 });
  }
  return { id, name, w, h, maxPlayers: n * n, tiles, mines, starts, decor, visualSeed: seed };
}

/** Serialize map to compact JSON (RLE tiles) */
export function serializeMap(m: MapData): string {
  const rle: number[] = [];
  let cur = m.tiles[0], n = 0;
  for (let i = 0; i < m.tiles.length; i++) {
    if (m.tiles[i] === cur && n < 65535) n++;
    else { rle.push(cur, n); cur = m.tiles[i]; n = 1; }
  }
  rle.push(cur, n);
  return JSON.stringify({ ...m, tiles: rle });
}
export function deserializeMap(s: string): MapData {
  const o = JSON.parse(s);
  const tiles = new Uint8Array(o.w * o.h);
  let i = 0;
  for (let k = 0; k < o.tiles.length; k += 2) {
    const t = o.tiles[k], n = o.tiles[k + 1];
    for (let j = 0; j < n; j++) tiles[i++] = t;
  }
  return { ...o, tiles };
}
