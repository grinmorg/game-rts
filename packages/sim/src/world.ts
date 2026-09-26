import { MAX_ORDER_QUEUE, MAX_QUEUE } from './data';
import { TypedArray, isTypedArray } from './snapshot';
import { Kind, MAX_ENTITIES } from './types';

export interface WorldSnapshot {
  maxId: number;
  count: number;
  free: number[];
  freeDirty: boolean;
  /** each per-entity array cut at maxId, by field name */
  arrays: Record<string, TypedArray>;
}

/**
 * Flat-array ECS storage. One slot per entity id; no per-entity objects.
 * Semantics of the generic slots depend on `kind`:
 *  - Unit:       hp, order*, target, cooldown, abilityCd, buff, lifetime(militia), carry, timer, mineRef,
 *                orderV = GATHER_AUTO on a Gather the worker picked itself (the dispatcher may re-task those only)
 *  - Building:   hp, size, state(BuildingState), progress(0..PROGRESS_MAX), queue, prodProgress, rally, cooldown(tower), abilityCd(castle),
 *                buff = ticks the builders stay slowed after the site was hit,
 *                carry = workers garrisoned (BuildingType.Mine), timer = income tick counter (BuildingType.Mine),
 *                lifetime = 1 while a trained unit waits inside because the population cap is full,
 *                progress < buildTime*10 on a Complete building = it is being dismantled
 *  - Mine:       hp = gold left, size, timer = workers inside this tick  (the neutral gold deposit)
 *  - Projectile: orderX/orderY = landing point, orderV = damage, lifetime = ticks left, timer = total ticks,
 *                carry = launch delay ticks left (held in the bucket), buff = 1 for an incendiary shot, mineRef = launcher
 *  - Zone(fire): lifetime, orderV = radius (fixed), timer = tick counter
 */
export class World {
  /** entity slots: ids run from 0 to cap - 1 (see entityCap) */
  readonly cap: number;
  alive: Uint8Array;
  gen: Uint16Array;
  kind: Uint8Array;
  type: Uint8Array;
  owner: Int8Array;
  x: Int32Array;
  y: Int32Array;
  /** previous tick position, view-only interpolation */
  px: Int32Array;
  py: Int32Array;
  hp: Int32Array;
  maxHp: Int32Array;
  state: Uint8Array;
  size: Uint8Array;

  order: Uint8Array;
  orderX: Int32Array;
  orderY: Int32Array;
  orderTarget: Int32Array;
  orderTargetGen: Uint16Array;
  orderV: Int32Array;
  patrolX: Int32Array;
  patrolY: Int32Array;

  target: Int32Array;
  targetGen: Uint16Array;
  cooldown: Int32Array;
  abilityCd: Int32Array;
  buff: Int32Array;
  lifetime: Int32Array;
  carry: Int32Array;
  timer: Int32Array;
  mineRef: Int32Array;
  stuck: Uint8Array;
  /** facing direction (fixed unit vector) - view hint, not hashed */
  fx: Int32Array;
  fy: Int32Array;
  /** movement delta this tick (fixed) - for view anim state */
  moved: Uint8Array;

  /** unreachable-destination fallback (units): dest cell it was resolved for, the substitute cell, path version */
  altTarget: Int32Array;
  altCell: Int32Array;
  altVersion: Int32Array;

  progress: Int32Array;
  builders: Uint8Array;
  /** workers taking the building apart this tick (Order.Dismantle), reset every tick like builders */
  dismantlers: Uint8Array;
  queue: Int8Array;
  queueLen: Uint8Array;
  prodProgress: Int32Array;
  rallyX: Int32Array;
  rallyY: Int32Array;

  oq: Int32Array;
  oqLen: Uint8Array;

  /** highest id ever allocated + 1 */
  maxId = 0;
  count = 0;
  private free: number[] = [];
  /** the free list has unsorted ids at its end (see release) */
  private freeDirty = false;

  constructor(cap = MAX_ENTITIES) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.gen = new Uint16Array(cap);
    this.kind = new Uint8Array(cap);
    this.type = new Uint8Array(cap);
    this.owner = new Int8Array(cap);
    this.x = new Int32Array(cap);
    this.y = new Int32Array(cap);
    this.px = new Int32Array(cap);
    this.py = new Int32Array(cap);
    this.hp = new Int32Array(cap);
    this.maxHp = new Int32Array(cap);
    this.state = new Uint8Array(cap);
    this.size = new Uint8Array(cap);
    this.order = new Uint8Array(cap);
    this.orderX = new Int32Array(cap);
    this.orderY = new Int32Array(cap);
    this.orderTarget = new Int32Array(cap);
    this.orderTargetGen = new Uint16Array(cap);
    this.orderV = new Int32Array(cap);
    this.patrolX = new Int32Array(cap);
    this.patrolY = new Int32Array(cap);
    this.target = new Int32Array(cap);
    this.targetGen = new Uint16Array(cap);
    this.cooldown = new Int32Array(cap);
    this.abilityCd = new Int32Array(cap);
    this.buff = new Int32Array(cap);
    this.lifetime = new Int32Array(cap);
    this.carry = new Int32Array(cap);
    this.timer = new Int32Array(cap);
    this.mineRef = new Int32Array(cap);
    this.stuck = new Uint8Array(cap);
    this.fx = new Int32Array(cap);
    this.fy = new Int32Array(cap);
    this.moved = new Uint8Array(cap);
    this.altTarget = new Int32Array(cap);
    this.altCell = new Int32Array(cap);
    this.altVersion = new Int32Array(cap);
    this.progress = new Int32Array(cap);
    this.builders = new Uint8Array(cap);
    this.dismantlers = new Uint8Array(cap);
    this.queue = new Int8Array(cap * MAX_QUEUE);
    this.queueLen = new Uint8Array(cap);
    this.prodProgress = new Int32Array(cap);
    this.rallyX = new Int32Array(cap);
    this.rallyY = new Int32Array(cap);
    this.oq = new Int32Array(cap * MAX_ORDER_QUEUE * 5);
    this.oqLen = new Uint8Array(cap);
  }

  alloc(kind: Kind, type: number, owner: number, x: number, y: number): number {
    let id: number;
    if (this.free.length > 0) {
      // descending, so pop() hands out the smallest id -> deterministic & compact
      if (this.freeDirty) { this.free.sort((a, b) => b - a); this.freeDirty = false; }
      id = this.free.pop()!;
    } else {
      if (this.maxId >= this.cap) return -1;
      id = this.maxId++;
    }
    this.alive[id] = 1;
    this.gen[id] = (this.gen[id] + 1) & 0xffff;
    this.kind[id] = kind;
    this.type[id] = type;
    this.owner[id] = owner;
    this.x[id] = x; this.y[id] = y; this.px[id] = x; this.py[id] = y;
    this.hp[id] = 0; this.maxHp[id] = 0; this.state[id] = 0; this.size[id] = 0;
    this.order[id] = 0; this.orderX[id] = 0; this.orderY[id] = 0; this.orderTarget[id] = -1; this.orderTargetGen[id] = 0; this.orderV[id] = 0;
    this.patrolX[id] = 0; this.patrolY[id] = 0;
    this.target[id] = -1; this.targetGen[id] = 0; this.cooldown[id] = 0; this.abilityCd[id] = 0; this.buff[id] = 0;
    this.lifetime[id] = 0; this.carry[id] = 0; this.timer[id] = 0; this.mineRef[id] = -1; this.stuck[id] = 0;
    this.fx[id] = 0; this.fy[id] = 65536; this.moved[id] = 0;
    this.altTarget[id] = -1; this.altCell[id] = -1; this.altVersion[id] = -1;
    this.progress[id] = 0; this.builders[id] = 0; this.dismantlers[id] = 0; this.queueLen[id] = 0; this.prodProgress[id] = 0;
    this.rallyX[id] = -1; this.rallyY[id] = -1; this.oqLen[id] = 0;
    this.count++;
    return id;
  }

  release(id: number): void {
    if (!this.alive[id]) return;
    this.alive[id] = 0;
    this.kind[id] = Kind.None;
    this.count--;
    // deaths come in bursts: sort once when the next alloc asks, not on every release
    this.free.push(id);
    this.freeDirty = true;
  }

  /** valid handle check: entity alive and generation matches */
  valid(id: number, gen: number): boolean {
    return id >= 0 && this.alive[id] === 1 && this.gen[id] === gen;
  }

  // ---- order queue helpers (5 ints per entry: type, x, y, target, v)
  oqPush(id: number, type: number, x: number, y: number, target: number, v: number): boolean {
    const n = this.oqLen[id];
    if (n >= MAX_ORDER_QUEUE) return false;
    const b = (id * MAX_ORDER_QUEUE + n) * 5;
    this.oq[b] = type; this.oq[b + 1] = x; this.oq[b + 2] = y; this.oq[b + 3] = target; this.oq[b + 4] = v;
    this.oqLen[id] = n + 1;
    return true;
  }
  oqClear(id: number): void { this.oqLen[id] = 0; }
  /** pops the first queued order into out[], returns false if empty */
  oqShift(id: number, out: Int32Array): boolean {
    const n = this.oqLen[id];
    if (n === 0) return false;
    const base = id * MAX_ORDER_QUEUE * 5;
    for (let k = 0; k < 5; k++) out[k] = this.oq[base + k];
    for (let i = 1; i < n; i++) for (let k = 0; k < 5; k++) this.oq[base + (i - 1) * 5 + k] = this.oq[base + i * 5 + k];
    this.oqLen[id] = n - 1;
    return true;
  }

  // ---- production queue helpers
  qPush(id: number, item: number): boolean {
    const n = this.queueLen[id];
    if (n >= MAX_QUEUE) return false;
    this.queue[id * MAX_QUEUE + n] = item;
    this.queueLen[id] = n + 1;
    return true;
  }
  // ---- snapshots (see snapshot.ts)
  /** every per-entity array up to `maxId` (a slot past it has never been handed out, so it is all zeros) */
  /** `skip`: arrays left out - a view frame has no use for the order queues */
  snapshot(skip?: ReadonlySet<string>): WorldSnapshot {
    const arrays: Record<string, TypedArray> = {};
    for (const [k, v] of Object.entries(this)) {
      if (!isTypedArray(v) || skip?.has(k)) continue;
      const stride = v.length / this.cap;
      arrays[k] = v.slice(0, this.maxId * stride);
    }
    return { maxId: this.maxId, count: this.count, free: this.free.slice(), freeDirty: this.freeDirty, arrays };
  }
  /** put a snapshot back into these very arrays (the view holds on to them) */
  restore(s: WorldSnapshot): void {
    const end = Math.max(this.maxId, s.maxId);
    for (const [k, v] of Object.entries(this)) {
      if (!isTypedArray(v)) continue;
      const stride = v.length / this.cap;
      const src = s.arrays[k];
      if (!src) continue; // left out of this snapshot (see snapshot's skip)
      v.set(src);
      v.fill(0, src.length, end * stride);
    }
    this.maxId = s.maxId; this.count = s.count;
    this.free = s.free.slice(); this.freeDirty = s.freeDirty;
  }

  qGet(id: number, i: number): number { return this.queue[id * MAX_QUEUE + i]; }
  qRemove(id: number, i: number): number {
    const n = this.queueLen[id];
    if (i < 0 || i >= n) return -1;
    const b = id * MAX_QUEUE;
    const item = this.queue[b + i];
    for (let k = i + 1; k < n; k++) this.queue[b + k - 1] = this.queue[b + k];
    this.queueLen[id] = n - 1;
    if (i === 0) this.prodProgress[id] = 0;
    return item;
  }
}
