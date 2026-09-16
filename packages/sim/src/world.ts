import { MAX_ORDER_QUEUE, MAX_QUEUE } from './data';
import { Kind, MAX_ENTITIES } from './types';

/**
 * Flat-array ECS storage. One slot per entity id; no per-entity objects.
 * Semantics of the generic slots depend on `kind`:
 *  - Unit:       hp, order*, target, cooldown, abilityCd, buff, lifetime(militia), carry, timer, mineRef
 *  - Building:   hp, size, state(BuildingState), progress(0..PROGRESS_MAX), queue, prodProgress, rally, cooldown(tower), abilityCd(castle)
 *  - Mine:       hp = gold left, size, timer = workers inside this tick
 *  - Projectile: orderX/orderY = landing point, orderV = damage, lifetime = ticks left, timer = total ticks
 *  - Zone(fire): lifetime, orderV = radius (fixed), timer = tick counter
 */
export class World {
  readonly cap = MAX_ENTITIES;
  alive = new Uint8Array(this.cap);
  gen = new Uint16Array(this.cap);
  kind = new Uint8Array(this.cap);
  type = new Uint8Array(this.cap);
  owner = new Int8Array(this.cap);
  x = new Int32Array(this.cap);
  y = new Int32Array(this.cap);
  /** previous tick position, view-only interpolation */
  px = new Int32Array(this.cap);
  py = new Int32Array(this.cap);
  hp = new Int32Array(this.cap);
  maxHp = new Int32Array(this.cap);
  state = new Uint8Array(this.cap);
  size = new Uint8Array(this.cap);

  order = new Uint8Array(this.cap);
  orderX = new Int32Array(this.cap);
  orderY = new Int32Array(this.cap);
  orderTarget = new Int32Array(this.cap);
  orderTargetGen = new Uint16Array(this.cap);
  orderV = new Int32Array(this.cap);
  patrolX = new Int32Array(this.cap);
  patrolY = new Int32Array(this.cap);

  target = new Int32Array(this.cap);
  targetGen = new Uint16Array(this.cap);
  cooldown = new Int32Array(this.cap);
  abilityCd = new Int32Array(this.cap);
  buff = new Int32Array(this.cap);
  lifetime = new Int32Array(this.cap);
  carry = new Int32Array(this.cap);
  timer = new Int32Array(this.cap);
  mineRef = new Int32Array(this.cap);
  stuck = new Uint8Array(this.cap);
  /** facing direction (fixed unit vector) - view hint, not hashed */
  fx = new Int32Array(this.cap);
  fy = new Int32Array(this.cap);
  /** movement delta this tick (fixed) - for view anim state */
  moved = new Uint8Array(this.cap);

  progress = new Int32Array(this.cap);
  builders = new Uint8Array(this.cap);
  queue = new Int8Array(this.cap * MAX_QUEUE);
  queueLen = new Uint8Array(this.cap);
  prodProgress = new Int32Array(this.cap);
  rallyX = new Int32Array(this.cap);
  rallyY = new Int32Array(this.cap);

  oq = new Int32Array(this.cap * MAX_ORDER_QUEUE * 5);
  oqLen = new Uint8Array(this.cap);

  /** highest id ever allocated + 1 */
  maxId = 0;
  count = 0;
  private free: number[] = [];

  alloc(kind: Kind, type: number, owner: number, x: number, y: number): number {
    let id: number;
    if (this.free.length > 0) id = this.free.pop()!;
    else {
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
    this.progress[id] = 0; this.builders[id] = 0; this.queueLen[id] = 0; this.prodProgress[id] = 0;
    this.rallyX[id] = -1; this.rallyY[id] = -1; this.oqLen[id] = 0;
    this.count++;
    return id;
  }

  release(id: number): void {
    if (!this.alive[id]) return;
    this.alive[id] = 0;
    this.kind[id] = Kind.None;
    this.count--;
    this.free.push(id);
    // keep free list sorted descending so pop() returns the smallest id -> deterministic & compact
    if (this.free.length > 1) this.free.sort((a, b) => b - a);
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
