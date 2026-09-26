/**
 * Snapshots: the whole state of a Simulation as plain objects and typed arrays, taken without disturbing it and put
 * back so exactly that the match carries on bit for bit as if it had never been interrupted - the pathfinder's
 * caches included, since which unit gets a route on which tick depends on them. Plain data, so a snapshot crosses
 * a postMessage (its arrays can be transferred) and a structured clone unchanged.
 *
 * What they are for: jumping around a replay without playing it from the start (a keyframe every few seconds),
 * and later handing a joining client the state of a match in progress.
 */

export type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

export function isTypedArray(v: unknown): v is TypedArray {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** bytes a snapshot's arrays take (what keyframe budgets are counted in) */
export function snapshotBytes(s: unknown): number {
  const seen = new Set<unknown>();
  const walk = (v: unknown): number => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return 0;
    seen.add(v);
    if (isTypedArray(v)) return v.byteLength;
    let n = 0;
    if (Array.isArray(v)) for (const x of v) n += walk(x);
    else for (const x of Object.values(v)) n += walk(x);
    return n;
  };
  return walk(s);
}

/** every typed array of a snapshot, for a postMessage transfer list */
export function snapshotBuffers(s: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (isTypedArray(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer); return; }
    if (Array.isArray(v)) for (const x of v) walk(x);
    else for (const x of Object.values(v)) walk(x);
  };
  walk(s);
  return [...out];
}

// ------------------------------------------------------------------ packing

/**
 * A typed array in a packed snapshot: `c` is how it was coded - 0 as it was, 1 byte runs (value, LEB128 length),
 * 2 zigzag LEB128 deltas from the previous value - `t` the array type and `n` the element count.
 */
interface PackedArray { $p: 0 | 1 | 2; t: string; n: number; d: TypedArray }

const ARRAY_TYPES: Record<string, new (n: number) => TypedArray> = {
  Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
};

/** a byte sink that grows; `limit` gives up (returns null) once the output is no longer worth having */
class Bytes {
  buf: Uint8Array;
  n = 0;
  constructor(size: number, private limit: number) { this.buf = new Uint8Array(Math.max(64, size)); }
  put(b: number): boolean {
    if (this.n >= this.buf.length) {
      if (this.n >= this.limit) return false;
      const g = new Uint8Array(Math.min(this.limit + 8, this.buf.length * 2)); g.set(this.buf); this.buf = g;
    }
    this.buf[this.n++] = b;
    return true;
  }
  varint(v: number): boolean {
    while (v >= 0x80) { if (!this.put((v & 0x7f) | 0x80)) return false; v >>>= 7; }
    return this.put(v);
  }
  done(): Uint8Array { return this.buf.slice(0, this.n); }
}

function runs8(a: Int8Array | Uint8Array): Uint8Array | null {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.length);
  const limit = a.length >> 1;
  const out = new Bytes(a.length >> 3, limit);
  for (let i = 0; i < u.length;) {
    const v = u[i];
    let j = i + 1;
    while (j < u.length && u[j] === v) j++;
    if (!out.put(v) || !out.varint(j - i)) return null;
    i = j;
  }
  return out.n <= limit ? out.done() : null;
}
function unruns8(d: Uint8Array, out: Int8Array | Uint8Array): void {
  const u = new Uint8Array(out.buffer, out.byteOffset, out.length);
  let o = 0;
  for (let i = 0; i < d.length;) {
    const v = d[i++];
    let n = 0, shift = 0, b: number;
    do { b = d[i++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    u.fill(v, o, o + n);
    o += n;
  }
}

function deltas(a: Int16Array | Uint16Array | Int32Array | Uint32Array): Uint8Array | null {
  const limit = Math.floor(a.byteLength * 0.7);
  const out = new Bytes(a.length, limit);
  let prev = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] | 0;
    const d = (v - prev) | 0;
    if (!out.varint(((d << 1) ^ (d >> 31)) >>> 0)) return null;
    prev = v;
  }
  return out.n <= limit ? out.done() : null;
}
function undeltas(d: Uint8Array, out: Int16Array | Uint16Array | Int32Array | Uint32Array): void {
  let prev = 0, o = 0;
  for (let i = 0; i < d.length;) {
    let z = 0, shift = 0, b: number;
    do { b = d[i++]; z += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    const delta = (z >>> 1) ^ -(z & 1);
    prev = (prev + delta) | 0;
    out[o++] = prev;
  }
}

/**
 * The same snapshot, its arrays coded compactly - for keeping many of them around (replay keyframes). Byte arrays
 * (passability, fog, tiles) mostly come in long runs; flow distances and positions change little from one cell to
 * the next. Whatever does not shrink by a good margin stays as it was. See unpackSnapshot.
 */
export function packSnapshot<T>(s: T): T {
  const walk = (v: unknown): unknown => {
    if (isTypedArray(v)) {
      const t = v.constructor.name;
      let d: Uint8Array | null = null, c: 0 | 1 | 2 = 0;
      if (v instanceof Int8Array || v instanceof Uint8Array) { d = runs8(v); c = 1; }
      else if (v instanceof Int16Array || v instanceof Uint16Array || v instanceof Int32Array || v instanceof Uint32Array) { d = deltas(v); c = 2; }
      return d ? { $p: c, t, n: v.length, d } : { $p: 0, t, n: v.length, d: v.slice() };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(s) as T;
}

/** a snapshot from packSnapshot, with every array as it was */
export function unpackSnapshot<T>(p: T): T {
  const walk = (v: unknown): unknown => {
    if (v !== null && typeof v === 'object' && !isTypedArray(v) && '$p' in v) {
      const a = v as PackedArray;
      if (a.$p === 0) return a.d.slice();
      const out = new ARRAY_TYPES[a.t](a.n);
      if (a.$p === 1) unruns8(a.d as Uint8Array, out as Uint8Array);
      else undeltas(a.d as Uint8Array, out as Int32Array);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object' && !isTypedArray(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(p) as T;
}
