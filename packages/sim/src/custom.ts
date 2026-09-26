import { MINE_SIZE } from './data';
import { hashString } from './hash';
import { MapData, MapDecor, MapMine, MapStart, createMap, isPassableTile } from './map';
import { Rng } from './rng';
import { MAX_PLAYERS, MatchSetup, Tile } from './types';

/**
 * Player-made maps (the map editor). A custom map travels as one compact string - the payload - which is
 * what the server stores, what a room hands to the match in `MatchSetup.map` and what a replay keeps, so a
 * match on a map that was deleted or made private since still plays back. Decoding is integer-only and
 * yields the same MapData on every peer; only the cosmetic decor uses floats.
 *
 * Payload: JSON `{ v, name, w, h, t, m, s }` - `t` is the tile grid run-length encoded (see packRuns) and
 * base64'd, `m` the gold deposits as [x, y, gold], `s` the spawn candidates as [x, y, zone].
 */

export const CUSTOM_MAP_PREFIX = 'c:';
export function isCustomMapId(id: string): boolean { return id.startsWith(CUSTOM_MAP_PREFIX); }
export function customMapId(id: string): string { return CUSTOM_MAP_PREFIX + id; }

export const MAP_SIZE_MIN = 32;
export const MAP_SIZE_MAX = 512;
export const MAP_NAME_MAX = 40;
export const MAP_MINES_MAX = 256;
/** spawn candidates per zone: one is drawn at random per match (see Simulation.pickStarts) */
export const MAP_STARTS_PER_ZONE_MAX = 4;
export const MINE_GOLD_MIN = 500;
export const MINE_GOLD_MAX = 50_000;
export const MINE_GOLD_DEFAULT = 6000;
/** the longest payload accepted: a 512x512 map of pure noise, the worst case, packs to about 350k */
export const CUSTOM_MAP_MAX_CHARS = 600_000;
/** thumbnails are custom maps too, downscaled so their long side is at most this */
export const THUMB_SIZE = 96;
/** a spawn with no deposit this close (cells) gets a warning */
const GOLD_NEAR_START = 16;
/** decor is cosmetic; a map painted solid forest would otherwise ask the renderer for a quarter million trees */
const DECOR_MAX = 40_000;
const TILE_COUNT = 5;

/** what the editor works on and the encoder takes */
export interface CustomMapSource {
  name: string;
  w: number;
  h: number;
  tiles: Uint8Array;
  mines: MapMine[];
  starts: MapStart[];
}

// ------------------------------------------------------------------ base64 (no btoa/Buffer: the sim runs everywhere)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();

function toBase64(b: Uint8Array): string {
  const out: string[] = [];
  let chunk = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    if (chunk.length > 4096) { out.push(chunk); chunk = ''; }
  }
  out.push(chunk);
  return out.join('');
}

function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0) return null;
  let pad = 0;
  if (s.endsWith('==')) pad = 2; else if (s.endsWith('=')) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = s.charCodeAt(i + k);
      if (c === 61 && i + k >= s.length - pad) { n <<= 6; continue; } // '='
      const v = c < 128 ? B64_INV[c] : -1;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ------------------------------------------------------------------ tile runs

/**
 * Run-length code of the tile grid, row-major. A run is a little varint: the first byte holds the tile in
 * bits 0-2 and the low four bits of (length - 1) in bits 3-6, further bytes seven bits each; bit 7 says
 * another byte follows. A run of up to 16 cells is one byte, a whole 512 row two.
 */
function packRuns(tiles: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < tiles.length) {
    const t = tiles[i];
    let j = i + 1;
    while (j < tiles.length && tiles[j] === t) j++;
    let v = j - i - 1;
    let b = (t & 7) | ((v & 15) << 3);
    v >>>= 4;
    if (v) b |= 128;
    out.push(b);
    while (v) { b = v & 127; v >>>= 7; if (v) b |= 128; out.push(b); }
    i = j;
  }
  return Uint8Array.from(out);
}

function unpackRuns(bytes: Uint8Array, n: number): Uint8Array | null {
  const tiles = new Uint8Array(n);
  let o = 0, i = 0;
  while (i < bytes.length) {
    let b = bytes[i++];
    const t = b & 7;
    if (t >= TILE_COUNT) return null;
    let v = (b >> 3) & 15, shift = 4;
    while (b & 128) {
      if (i >= bytes.length || shift > 25) return null;
      b = bytes[i++];
      v += (b & 127) * 2 ** shift;
      shift += 7;
    }
    const len = v + 1;
    if (o + len > n) return null;
    tiles.fill(t, o, o + len);
    o += len;
  }
  return o === n ? tiles : null;
}

// ------------------------------------------------------------------ encode / decode

/** zones renumbered 0..n-1 in their order, so a map never has a gap the lobby would show as an empty slot */
function compactZones(starts: MapStart[]): MapStart[] {
  const used = [...new Set(starts.map((s) => s.zone))].sort((a, b) => a - b);
  return starts.map((s) => ({ x: s.x, y: s.y, zone: used.indexOf(s.zone) }));
}

export function cleanMapName(s: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAP_NAME_MAX);
}

export function encodeCustomMap(src: CustomMapSource): string {
  return JSON.stringify({
    v: 1,
    name: cleanMapName(src.name),
    w: src.w,
    h: src.h,
    t: toBase64(packRuns(src.tiles)),
    m: src.mines.map((m) => [m.x, m.y, m.gold]),
    s: compactZones(src.starts).map((s) => [s.x, s.y, s.zone]),
  });
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * The editor's view of a payload: tiles and objects exactly as stored, no decor. Null for anything that is
 * not a well-formed map - it may come from any browser, so every field is checked for type and range.
 */
export function decodeCustomSource(payload: unknown): CustomMapSource | null {
  if (typeof payload !== 'string' || payload.length > CUSTOM_MAP_MAX_CHARS) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(payload); } catch { return null; }
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  const { w, h } = o;
  if (!isInt(w, 1, MAP_SIZE_MAX) || !isInt(h, 1, MAP_SIZE_MAX) || typeof o.t !== 'string') return null;
  const bytes = fromBase64(o.t);
  const tiles = bytes && unpackRuns(bytes, w * h);
  if (!tiles) return null;
  if (!Array.isArray(o.m) || o.m.length > MAP_MINES_MAX || !Array.isArray(o.s) || o.s.length > MAX_PLAYERS * MAP_STARTS_PER_ZONE_MAX) return null;
  const mines: MapMine[] = [];
  for (const m of o.m as unknown[]) {
    if (!Array.isArray(m) || !isInt(m[0], 0, w - 1) || !isInt(m[1], 0, h - 1) || !isInt(m[2], MINE_GOLD_MIN, MINE_GOLD_MAX)) return null;
    mines.push({ x: m[0], y: m[1], gold: m[2] });
  }
  const starts: MapStart[] = [];
  for (const s of o.s as unknown[]) {
    if (!Array.isArray(s) || !isInt(s[0], 0, w - 1) || !isInt(s[1], 0, h - 1) || !isInt(s[2], 0, MAX_PLAYERS - 1)) return null;
    starts.push({ x: s[0], y: s[1], zone: s[2] });
  }
  return { name: cleanMapName(o.name), w, h, tiles, mines, starts: compactZones(starts) };
}

/** a payload as a playable MapData (see decodeCustomSource for what is refused) */
export function decodeCustomMap(payload: string, id = 'custom'): MapData | null {
  const src = decodeCustomSource(payload);
  return src ? mapFromSource(src, id, hashString(payload)) : null;
}

/** MapData for an editor document: the same thing a match on the saved payload gets */
export function mapFromSource(src: CustomMapSource, id = 'custom', visualSeed = 1): MapData {
  const zones = new Set(src.starts.map((s) => s.zone)).size;
  return {
    id, name: src.name || 'Untitled', w: src.w, h: src.h, maxPlayers: zones, tiles: src.tiles,
    mines: src.mines.map((m) => ({ ...m })), starts: src.starts.map((s) => ({ ...s })),
    decor: decorFor(src.tiles, src.w, src.h, visualSeed), visualSeed: visualSeed | 0,
  };
}

/** trees on forest, the odd boulder on rock - the same look as the official maps, thinned on a huge forest */
function decorFor(tiles: Uint8Array, w: number, h: number, seed: number): MapDecor[] {
  let forest = 0, rock = 0;
  for (let i = 0; i < tiles.length; i++) { if (tiles[i] === Tile.Forest) forest++; else if (tiles[i] === Tile.Rock) rock++; }
  const keep = Math.min(1, DECOR_MAX / Math.max(1, forest + rock * 0.35));
  const rng = new Rng(seed ^ 0x3c6ef372);
  const decor: MapDecor[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = tiles[y * w + x];
    if (t === Tile.Forest) {
      if (keep < 1 && !rng.chance(keep)) continue;
      decor.push({ x: x + 0.5, y: y + 0.5, type: rng.nextInt(3), scale: 0.8 + rng.nextFloat() * 0.5, rot: rng.nextFloat() * 6.283 });
    } else if (t === Tile.Rock && x > 1 && y > 1 && x < w - 2 && y < h - 2 && rng.chance(0.35 * keep)) {
      decor.push({ x: x + 0.5, y: y + 0.5, type: 3 + rng.nextInt(2), scale: 0.9 + rng.nextFloat() * 0.6, rot: rng.nextFloat() * 6.283 });
    }
  }
  return decor;
}

const decoded = new Map<string, MapData | null>();

/**
 * The map a match is played on: the custom payload it carries, else the official (or procedural) map its id
 * names. Every peer calls this with the same setup, so every peer gets the same map. A payload that does not
 * decode falls back to the id like an unknown official map does - identically everywhere.
 */
export function mapForSetup(setup: Pick<MatchSetup, 'mapId' | 'seed' | 'map'>): MapData {
  if (setup.map) {
    let m = decoded.get(setup.map);
    if (m === undefined) {
      m = decodeCustomMap(setup.map, setup.mapId);
      if (decoded.size >= 4) decoded.delete(decoded.keys().next().value!);
      decoded.set(setup.map, m);
    }
    if (m) return m;
  }
  return createMap(setup.mapId, setup.seed);
}

// ------------------------------------------------------------------ validation

export type MapIssueCode =
  | 'size' | 'fewZones' | 'zoneStarts' | 'tooManyMines'
  | 'startEdge' | 'startBlocked' | 'startOverlap'
  | 'mineEdge' | 'mineBlocked' | 'mineOverlap'
  | 'unreachable'
  // warnings
  | 'noName' | 'noGold' | 'mineUnreachable';

export interface MapIssue {
  code: MapIssueCode;
  /** an error keeps the map out of play; a warning is advice */
  error: boolean;
  /** the cell it is about, if any - the editor jumps there */
  x?: number;
  y?: number;
  zone?: number;
}

/** castle footprint: 3x3 centred on the spawn cell (Simulation.spawnMapEntities) */
const CASTLE_HALF = 1;
const MINE_HALF = (MINE_SIZE - 1) >> 1;

/**
 * What stops a map from being played, and what is merely odd. The rules mirror what the simulation needs:
 * the castle and every deposit on open ground inside the build border, no footprints overlapping, every
 * spawn able to walk to every other (there are no boats - an island would never end), two zones at least.
 */
export function validateCustomMap(src: CustomMapSource): MapIssue[] {
  const { w, h, tiles } = src;
  const out: MapIssue[] = [];
  const err = (code: MapIssueCode, x?: number, y?: number, zone?: number) => out.push({ code, error: true, x, y, zone });
  const warn = (code: MapIssueCode, x?: number, y?: number, zone?: number) => out.push({ code, error: false, x, y, zone });
  if (w < MAP_SIZE_MIN || h < MAP_SIZE_MIN || w > MAP_SIZE_MAX || h > MAP_SIZE_MAX) { err('size'); return out; }
  if (!cleanMapName(src.name)) warn('noName');

  const zones = new Map<number, number>();
  for (const s of src.starts) zones.set(s.zone, (zones.get(s.zone) ?? 0) + 1);
  if (zones.size < 2) err('fewZones');
  for (const [zone, n] of zones) if (n > MAP_STARTS_PER_ZONE_MAX) err('zoneStarts', undefined, undefined, zone);
  if (src.mines.length > MAP_MINES_MAX) err('tooManyMines');

  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && isPassableTile(tiles[y * w + x]);
  const areaOpen = (cx: number, cy: number, half: number) => {
    for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) if (!open(x, y)) return false;
    return true;
  };
  const overlap = (ax: number, ay: number, ah: number, bx: number, by: number, bh: number) => Math.abs(ax - bx) <= ah + bh && Math.abs(ay - by) <= ah + bh;

  // the castle must fit the build border canPlaceBuilding keeps (two cells), with a ring around it for the workers
  for (const s of src.starts) {
    if (s.x < 4 || s.y < 4 || s.x > w - 5 || s.y > h - 5) err('startEdge', s.x, s.y, s.zone);
    else if (!areaOpen(s.x, s.y, CASTLE_HALF)) err('startBlocked', s.x, s.y, s.zone);
  }
  for (let i = 0; i < src.starts.length; i++) for (let j = i + 1; j < src.starts.length; j++) {
    const a = src.starts[i], b = src.starts[j];
    // candidates of one zone never stand at once; two zones' castles may
    if (a.zone !== b.zone && overlap(a.x, a.y, CASTLE_HALF, b.x, b.y, CASTLE_HALF)) err('startOverlap', b.x, b.y, b.zone);
  }
  for (const m of src.mines) {
    if (m.x < 2 || m.y < 2 || m.x > w - 3 || m.y > h - 3) err('mineEdge', m.x, m.y);
    else if (!areaOpen(m.x, m.y, MINE_HALF)) err('mineBlocked', m.x, m.y);
    for (const s of src.starts) if (overlap(m.x, m.y, MINE_HALF, s.x, s.y, CASTLE_HALF)) { err('startOverlap', s.x, s.y, s.zone); break; }
  }
  for (let i = 0; i < src.mines.length; i++) for (let j = i + 1; j < src.mines.length; j++) {
    const a = src.mines[i], b = src.mines[j];
    if (overlap(a.x, a.y, MINE_HALF, b.x, b.y, MINE_HALF)) err('mineOverlap', b.x, b.y);
  }

  // ground connectivity: open tiles minus the deposits, flooded from the first spawn
  if (src.starts.length && !out.some((i) => i.error && i.code !== 'unreachable')) {
    const blocked = new Uint8Array(w * h);
    for (let i = 0; i < tiles.length; i++) if (!isPassableTile(tiles[i])) blocked[i] = 1;
    for (const m of src.mines) for (let y = m.y - MINE_HALF; y <= m.y + MINE_HALF; y++) for (let x = m.x - MINE_HALF; x <= m.x + MINE_HALF; x++) blocked[y * w + x] = 1;
    const region = floodRegions(blocked, w, h);
    const home = region[src.starts[0].y * w + src.starts[0].x];
    for (const s of src.starts) if (region[s.y * w + s.x] !== home) err('unreachable', s.x, s.y, s.zone);
    // a deposit is reachable when some cell of the ring around it is
    const starts = new Set(src.starts.map((s) => region[s.y * w + s.x]));
    for (const m of src.mines) {
      let ok = false;
      for (let y = m.y - MINE_HALF - 1; y <= m.y + MINE_HALF + 1 && !ok; y++) for (let x = m.x - MINE_HALF - 1; x <= m.x + MINE_HALF + 1; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h && !blocked[y * w + x] && starts.has(region[y * w + x])) { ok = true; break; }
      }
      if (!ok) warn('mineUnreachable', m.x, m.y);
    }
  }
  for (const s of src.starts) {
    if (!src.mines.some((m) => (m.x - s.x) ** 2 + (m.y - s.y) ** 2 <= GOLD_NEAR_START ** 2)) warn('noGold', s.x, s.y, s.zone);
  }
  return out;
}

/** 4-connected region label per cell (0 = blocked), one queue pass */
function floodRegions(blocked: Uint8Array, w: number, h: number): Int32Array {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let next = 0;
  for (let start = 0; start < label.length; start++) {
    if (blocked[start] || label[start]) continue;
    next++;
    let head = 0, tail = 0;
    queue[tail++] = start; label[start] = next;
    while (head < tail) {
      const c = queue[head++];
      const x = c % w;
      if (x > 0 && !blocked[c - 1] && !label[c - 1]) { label[c - 1] = next; queue[tail++] = c - 1; }
      if (x < w - 1 && !blocked[c + 1] && !label[c + 1]) { label[c + 1] = next; queue[tail++] = c + 1; }
      if (c >= w && !blocked[c - w] && !label[c - w]) { label[c - w] = next; queue[tail++] = c - w; }
      if (c < label.length - w && !blocked[c + w] && !label[c + w]) { label[c + w] = next; queue[tail++] = c + w; }
    }
  }
  return label;
}

export function mapHasErrors(issues: MapIssue[]): boolean { return issues.some((i) => i.error); }

// ------------------------------------------------------------------ thumbnail

/**
 * A small copy of the map for lists and lobby cards: the same payload format, the long side cut down to
 * THUMB_SIZE by taking the commonest tile of every block. Deposits and spawns keep their spots, scaled.
 */
export function customMapThumb(src: CustomMapSource, max = THUMB_SIZE): string {
  const k = Math.max(src.w, src.h) > max ? Math.max(src.w, src.h) / max : 1;
  const tw = Math.max(1, Math.round(src.w / k)), th = Math.max(1, Math.round(src.h / k));
  const tiles = new Uint8Array(tw * th);
  const count = new Int32Array(TILE_COUNT);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const x0 = Math.floor(tx * k), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * k));
    const y0 = Math.floor(ty * k), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * k));
    count.fill(0);
    for (let y = y0; y < y1 && y < src.h; y++) for (let x = x0; x < x1 && x < src.w; x++) count[src.tiles[y * src.w + x]]++;
    let best = 0;
    for (let t = 1; t < TILE_COUNT; t++) if (count[t] > count[best]) best = t;
    tiles[ty * tw + tx] = best;
  }
  const sc = (v: number, n: number) => Math.min(n - 1, Math.floor(v / k));
  return encodeCustomMap({
    name: src.name, w: tw, h: th, tiles,
    mines: src.mines.map((m) => ({ x: sc(m.x, tw), y: sc(m.y, th), gold: m.gold })),
    starts: src.starts.map((s) => ({ x: sc(s.x, tw), y: sc(s.y, th), zone: s.zone })),
  });
}

// ------------------------------------------------------------------ blank maps

/** a new editor document: grass inside the two-cell rock border the official maps have */
export function blankCustomMap(name: string, w: number, h: number): CustomMapSource {
  const tiles = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) tiles[y * w + x] = Tile.Rock;
  return { name, w, h, tiles, mines: [], starts: [] };
}

/** an official map as an editor document, to start from a known-good layout */
export function officialMapSource(id: string, seed = 1): CustomMapSource {
  const m = createMap(id, seed);
  return { name: m.name, w: m.w, h: m.h, tiles: m.tiles.slice(), mines: m.mines.map((x) => ({ ...x })), starts: m.starts.map((s) => ({ ...s })) };
}
