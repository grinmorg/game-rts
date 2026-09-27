import { mapForSetup } from './custom';
import type { ReplayData } from './replay';
import { Simulation, type SimSnapshot } from './sim';
import { type TypedArray, isTypedArray, packSnapshot, snapshotBytes, unpackSnapshot } from './snapshot';
import { HASH_INTERVAL, SIM_VERSION } from './types';

/**
 * Keyframes: snapshots of a match (snapshot.ts) taken every so often, so that a replay jumps to any moment by
 * putting the one before it back and playing the few seconds left, instead of playing the match from its start.
 * A match leaves them as it is played - the tab that plays it hands them to its replay - the background run of a
 * replay leaves them as it goes, and the one of a moment shared by a link travels through the server in the binary
 * form below.
 */

/** a keyframe as kept: packed (packSnapshot), unpacked only when it is put back */
export interface Keyframe { tick: number; snap: SimSnapshot; bytes: number }

/**
 * Ticks between the keyframes a match leaves as it is played: ten seconds at 1x, a few dozen milliseconds to play
 * from one to the next on a six-player map. A multiple of HASH_INTERVAL, so the recording's hashes vouch for each.
 */
export const KEYFRAME_EVERY = 200;

/** the moment `sim` is at, as a keyframe */
export function takeKeyframe(sim: Simulation): Keyframe {
  const snap = packSnapshot(sim.snapshot());
  return { tick: snap.tick, snap, bytes: snapshotBytes(snap) };
}

/**
 * Keyframes of one match in tick order, within a memory budget: past it the one whose loss leaves the shortest gap
 * goes - never the first, the newest or a pinned one - so however long the match they stay spread over all of it.
 */
export class KeyframeSet {
  readonly keys: Keyframe[] = [];
  bytes = 0;
  private pinned = new Set<Keyframe>();
  constructor(readonly budget: number) {}

  /** keep `k`; `pin`: never thin it out (a keyframe fetched for a jump that is about to use it) */
  add(k: Keyframe, pin = false): void {
    const keys = this.keys;
    let i = keys.length;
    while (i > 0 && keys[i - 1].tick > k.tick) i--;
    if (i > 0 && keys[i - 1].tick === k.tick) return;
    keys.splice(i, 0, k);
    this.bytes += k.bytes;
    if (pin) this.pinned.add(k);
    while (this.bytes > this.budget && keys.length > 2) {
      let drop = -1, gap = Infinity;
      for (let j = 1; j < keys.length - 1; j++) {
        const g = keys[j + 1].tick - keys[j - 1].tick;
        if (g < gap && !this.pinned.has(keys[j])) { gap = g; drop = j; }
      }
      if (drop < 0) break;
      this.bytes -= keys[drop].bytes;
      keys.splice(drop, 1);
    }
  }

  /** the latest keyframe at or before `tick`; `checkable`: the latest on a tick the recording holds a hash for */
  at(tick: number, checkable = false): Keyframe | null {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.keys[mid].tick <= tick) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0; i--) if (!checkable || this.keys[i].tick % HASH_INTERVAL === 0) return this.keys[i];
    return null;
  }

  /** every keyframe, handed over: the set is left empty */
  take(): Keyframe[] {
    this.bytes = 0;
    this.pinned.clear();
    return this.keys.splice(0);
  }
}

// ------------------------------------------------------------------ checking one that came from elsewhere

/** the hash the recording holds for `tick`, if it sampled one there */
export function recordedHash(data: ReplayData, tick: number): number | undefined {
  const hs = data.hashes;
  let lo = 0, hi = hs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hs[mid][0] < tick) lo = mid + 1; else hi = mid; }
  return lo < hs.length && hs[lo][0] === tick ? hs[lo][1] : undefined;
}

/**
 * Whether a keyframe from somewhere else (the server) really is a moment of this recording: put back into a
 * simulation of its own it must hash to what the recording holds for its tick. One made up, taken from another
 * match or cut to the wrong shape fails - and so does one on a tick the recording has no hash for.
 */
export function keyframeMatches(data: ReplayData, k: Keyframe): boolean {
  const want = k.tick > 0 && k.tick <= data.tickCount ? recordedHash(data, k.tick) : undefined;
  if (want === undefined || k.snap.tick !== k.tick) return false;
  try {
    const sim = new Simulation(data.setup, mapForSetup(data.setup));
    const s = unpackSnapshot(k.snap);
    // what restore sizes its work by: a snapshot of another shape could have it loop or allocate without end
    if (s.players.length !== sim.players.length || !(s.world.maxId >= 0 && s.world.maxId <= sim.world.cap)) return false;
    if (s.path.fields.length > 1024 || !(s.path.tilesMade >= 0 && s.path.tilesMade <= 1 << 17)) return false;
    sim.restore(s);
    return sim.tick === k.tick && sim.hash() === want;
  } catch { return false; }
}

// ------------------------------------------------------------------ the binary form

/** "RKF1", little-endian */
const MAGIC = 0x31464b52;
const HEADER_BYTES = 16;
/** the most one keyframe may unpack to: a hundred-player match takes about fifty megabytes */
const MAX_UNPACKED_BYTES = 256 << 20;

type ArrayType = { new (b: ArrayBuffer): TypedArray; BYTES_PER_ELEMENT: number };
const ARRAY_TYPES: Record<string, ArrayType> = {
  Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
};

const align8 = (n: number) => (n + 7) & ~7;

// every runtime the simulation runs in has these; its own lib settings (ES2022, no DOM) only do not declare them
declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(b: Uint8Array): string } };

/**
 * A keyframe as bytes, the way it goes to the server and back: "RKF1", the simulation version, the tick and the length
 * of a JSON outline of the packed snapshot; the outline, each typed array in it replaced by a marker with its type,
 * length and place among the bytes after the outline; then those bytes, every array on an 8-byte boundary. What JSON
 * cannot carry - NaN, the infinities, -0, undefined - is marked as well, so the snapshot comes back as it went in.
 */
export function encodeKeyframe(k: Keyframe): Uint8Array {
  const arrays: TypedArray[] = [];
  let rel = 0;
  const outline = JSON.stringify(k.snap, (_key, v: unknown) => {
    if (isTypedArray(v)) {
      const m = { $a: rel, t: v.constructor.name, n: v.length };
      arrays.push(v);
      rel = align8(rel + v.byteLength);
      return m;
    }
    if (v === undefined) return { $u: 1 };
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return { $n: Object.is(v, -0) ? '-0' : String(v) };
    return v;
  });
  const text = new TextEncoder().encode(outline);
  const base = align8(HEADER_BYTES + text.length);
  const out = new Uint8Array(base + rel);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, SIM_VERSION, true);
  dv.setUint32(8, k.tick, true);
  dv.setUint32(12, text.length, true);
  out.set(text, HEADER_BYTES);
  let at = base;
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
    at = align8(at + a.byteLength);
  }
  return out;
}

/** the tick in a keyframe's bytes, if they are a keyframe this version of the simulation made */
export function keyframeTickOf(bytes: Uint8Array): number | undefined {
  if (bytes.length < HEADER_BYTES) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== SIM_VERSION) return undefined;
  return dv.getUint32(8, true);
}

/**
 * The keyframe in `bytes` (encodeKeyframe), or null when they are not one this version of the simulation made, or do
 * not hold together: an array of an unknown type or running past the end, more than any match unpacks to.
 */
export function decodeKeyframe(bytes: Uint8Array): Keyframe | null {
  const tick = keyframeTickOf(bytes);
  if (tick === undefined) return null;
  try {
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
    if (HEADER_BYTES + len > bytes.length) return null;
    const outline = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + len))) as unknown;
    const base = align8(HEADER_BYTES + len);
    let unpacked = 0;
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
      if (v === null || typeof v !== 'object') return v;
      const o = v as Record<string, unknown>;
      if (typeof o.$a === 'number') {
        const T = ARRAY_TYPES[o.t as string];
        const n = o.n as number;
        if (!T || !Number.isInteger(n) || n < 0 || !Number.isInteger(o.$a) || o.$a < 0) throw new Error('array');
        const start = base + o.$a, end = start + n * T.BYTES_PER_ELEMENT;
        if (end > bytes.length) throw new Error('past the end');
        return new T(bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end) as ArrayBuffer);
      }
      if (o.$u === 1 && Object.keys(o).length === 1) return undefined;
      if (typeof o.$n === 'string' && Object.keys(o).length === 1) return o.$n === '-0' ? -0 : Number(o.$n);
      for (const key of Object.keys(o)) o[key] = walk(o[key]);
      // a packed array (packSnapshot) says how long it unpacks to, and that is what the limit is counted in
      if (typeof o.$p === 'number') {
        const T = ARRAY_TYPES[o.t as string];
        const n = o.n as number;
        if (!T || !Number.isInteger(n) || n < 0) throw new Error('packed array');
        unpacked += n * T.BYTES_PER_ELEMENT;
        if (unpacked > MAX_UNPACKED_BYTES) throw new Error('too big');
      }
      return o;
    };
    const snap = walk(outline) as SimSnapshot;
    if (!snap || typeof snap !== 'object' || snap.tick !== tick) return null;
    return { tick, snap, bytes: snapshotBytes(snap) };
  } catch { return null; }
}
