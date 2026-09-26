import { Bot, createBots } from '@rookfall/ai';
import { TickFrame, encodeCommandsFrame } from '@rookfall/protocol';
import {
  COMMAND_DELAY_TICKS, Command, HASH_INTERVAL, MatchSetup, MatchSummary, ReplayData, ReplayPlayer, ReplayRecorder, SimEvent, SimSnapshot, Simulation,
  SummaryRecorder, TICK_MS, ViewFrame, mapForSetup, packSnapshot, snapshotBytes, tickMsFor, unpackSnapshot,
} from '@rookfall/sim';
import { NetClient } from '../net/client';

export type SessionKind = 'local' | 'net' | 'replay';

/** main-thread time a lagging online client spends catching up per frame, leaving the rest to draw it */
const CATCH_UP_MS_PER_FRAME = 10;

export interface Session {
  readonly kind: SessionKind;
  readonly sim: Simulation;
  readonly setup: MatchSetup;
  /** player index controlled by this client, -1 for spectators */
  mySlot: number;
  /** interpolation factor between previous and current tick positions */
  alpha: number;
  speed: number;
  paused: boolean;
  /** invoked after every simulation step with that tick's events */
  onStep: ((events: SimEvent[]) => void) | null;
  submit(cmd: Command): void;
  update(dtMs: number): void;
  dispose(): void;
  /** replay data produced so far (local & net), with the summary of the match so far */
  replay(): ReplayData | null;
  /** charts and battles of the match so far - of the whole match once it is over */
  summary(): MatchSummary | null;
  readonly catchingUp: boolean;
  /** the players whose fog the view looks through, for a session whose simulation runs elsewhere (WorkerSession) */
  setWatch?(players: number[]): void;
}

/** Skirmish: simulation + bots run in this browser tab. Commands are delayed 2 ticks like online. */
export class LocalSession implements Session {
  readonly kind = 'local' as const;
  readonly sim: Simulation;
  readonly setup: MatchSetup;
  mySlot: number;
  alpha = 0;
  speed = 1;
  paused = false;
  onStep: ((events: SimEvent[]) => void) | null = null;
  catchingUp = false;
  private bots: Bot[];
  private acc = 0;
  private scheduled = new Map<number, Command[]>();
  private recorder: ReplayRecorder;
  private summaryRec: SummaryRecorder;
  /** rolling simulation step times (ms), read by the stress harness */
  readonly stepMs = new Float32Array(2048);
  stepN = 0;

  constructor(setup: MatchSetup, mySlot: number) {
    this.setup = setup;
    this.sim = new Simulation(setup, mapForSetup(setup));
    this.bots = createBots(this.sim);
    this.mySlot = mySlot;
    this.speed = TICK_MS / tickMsFor(setup.speed); // match speed chosen in the skirmish setup
    this.recorder = new ReplayRecorder(setup, mapForSetup(setup).name);
    this.summaryRec = new SummaryRecorder(this.sim);
  }

  submit(cmd: Command): void {
    const t = this.sim.tick + COMMAND_DELAY_TICKS;
    let list = this.scheduled.get(t);
    if (!list) { list = []; this.scheduled.set(t, list); }
    list.push(cmd);
  }

  update(dtMs: number): void {
    if (this.paused || this.sim.gameOver) { this.alpha = 1; return; }
    this.acc += dtMs * this.speed;
    let steps = 0;
    const max = Math.max(8, Math.ceil(this.speed) * 4);
    while (this.acc >= TICK_MS && steps < max) {
      this.acc -= TICK_MS;
      this.step();
      steps++;
    }
    if (steps >= max) this.acc = 0;
    this.alpha = Math.min(1, this.acc / TICK_MS);
  }

  private step(): void {
    const tick = this.sim.tick + 1;
    const cmds = this.scheduled.get(tick) ?? [];
    this.scheduled.delete(tick);
    const t0 = performance.now();
    for (const b of this.bots) cmds.push(...b.think(this.sim));
    this.recorder.record(tick, cmds);
    this.sim.step(cmds);
    this.summaryRec.observe(this.sim);
    this.stepMs[this.stepN++ % this.stepMs.length] = performance.now() - t0;
    if (tick % HASH_INTERVAL === 0) this.recorder.hash(tick, this.sim.hash());
    this.onStep?.(this.sim.events);
  }
  perfReset(): void { this.stepN = 0; }

  replay(): ReplayData {
    const data = this.recorder.finish(this.sim.winnerTeam, this.sim.tick, Date.now());
    data.summary = this.summaryRec.finish(this.sim);
    return data;
  }
  summary(): MatchSummary { return this.summaryRec.finish(this.sim); }
  dispose(): void { /* nothing */ }
}

/** messages to a skirmish's simulation worker (simWorker.ts) */
export type SimWorkerIn =
  | { t: 'start'; setup: MatchSetup }
  | { t: 'replay'; data: ReplayData }
  | { t: 'cmd'; cmd: Command }
  | { t: 'step'; n: number; watch: number[] }
  | { t: 'seek'; snap: SimSnapshot | null; target: number; watch: number[] }
  | { t: 'summary' }
  /** debug / e2e hook: put a unit into the real simulation (see WorkerSession.debugSpawn) */
  | { t: 'spawn'; owner: number; type: number; x: number; y: number };
/** and back: one frame per step or seek request (`seek` says which), progress while a seek plays on */
export type SimWorkerOut =
  | {
    t: 'frame'; frame: ViewFrame; ticks: { t: number; c: Command[] }[]; hashes: [number, number][]; summary: MatchSummary | null;
    /** a replay: the first tick that did not match its hashes, -1 while all did */
    desync?: number; seek?: boolean;
  }
  | { t: 'progress'; done: number }
  | { t: 'summary'; summary: MatchSummary }
  | { t: 'spawned'; id: number };

/** step requests in flight at once: one being worked on, one queued behind it */
const MAX_IN_FLIGHT = 2;

/**
 * Skirmish with the simulation and the bots in a worker (simWorker.ts): this tab only draws. `sim` is the view's
 * copy, never stepped, brought up to date by the frames the worker sends back (Simulation.applyViewFrame). The
 * page keeps the clock, as LocalSession does: as ticks fall due they are asked for, and until their frame is in
 * the view holds the tick it has - `acc` still counts them, so the interpolation waits at the end of the tick
 * instead of snapping back to its start. The replay is recorded here from the commands each frame reports.
 */
export class WorkerSession implements Session {
  readonly kind = 'local' as const;
  readonly sim: Simulation;
  readonly setup: MatchSetup;
  mySlot: number;
  alpha = 0;
  speed = 1;
  paused = false;
  onStep: ((events: SimEvent[]) => void) | null = null;
  catchingUp = false;
  private worker: Worker;
  /** real time since the tick on show */
  private acc = 0;
  /** ticks asked for whose frames have not come back */
  private requested = 0;
  private inFlight = 0;
  private watch: number[];
  private recorder: ReplayRecorder;
  private lastSummary: MatchSummary | null = null;

  constructor(setup: MatchSetup, mySlot: number) {
    this.setup = setup;
    this.sim = new Simulation(setup, mapForSetup(setup));
    this.mySlot = mySlot;
    this.watch = [mySlot];
    this.speed = TICK_MS / tickMsFor(setup.speed);
    this.recorder = new ReplayRecorder(setup, mapForSetup(setup).name);
    this.worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<SimWorkerOut>) => this.onMessage(e.data);
    this.worker.postMessage({ t: 'start', setup } satisfies SimWorkerIn);
  }

  setWatch(players: number[]): void { this.watch = players.filter((p) => p >= 0); }

  submit(cmd: Command): void { this.worker.postMessage({ t: 'cmd', cmd } satisfies SimWorkerIn); }

  update(dtMs: number): void {
    if (this.paused || this.sim.gameOver) { this.alpha = 1; return; }
    this.acc += dtMs * this.speed;
    // behind by more than this (the worker cannot keep up, or the tab was away): let the time go, as LocalSession does
    const max = Math.max(8, Math.ceil(this.speed) * 4);
    if (this.acc > (max + this.requested) * TICK_MS) this.acc = (max + this.requested) * TICK_MS;
    const due = Math.floor(this.acc / TICK_MS) - this.requested;
    if (due > 0 && this.inFlight < MAX_IN_FLIGHT) {
      this.worker.postMessage({ t: 'step', n: due, watch: this.watch } satisfies SimWorkerIn);
      this.requested += due;
      this.inFlight++;
    }
    this.alpha = Math.min(1, this.acc / TICK_MS);
  }

  private spawned: ((id: number) => void)[] = [];
  /**
   * Debug / e2e hook: `sim` is only the view's copy, so a unit spawned on it is gone with the next frame - this puts
   * one into the simulation the worker runs, and resolves with its id.
   */
  debugSpawn(owner: number, type: number, x: number, y: number): Promise<number> {
    return new Promise((r) => { this.spawned.push(r); this.worker.postMessage({ t: 'spawn', owner, type, x, y } satisfies SimWorkerIn); });
  }

  private onMessage(m: SimWorkerOut): void {
    if (m.t === 'summary') { this.lastSummary = m.summary; return; }
    if (m.t === 'spawned') { this.spawned.shift()?.(m.id); return; }
    if (m.t === 'progress') return;
    this.inFlight--;
    const n = m.ticks.length;
    this.requested = Math.max(0, this.requested - n);
    this.acc = Math.max(0, this.acc - n * TICK_MS);
    // a request cut short (the match ended, or the worker's own cap) leaves nothing owed
    if (this.inFlight === 0) this.requested = 0;
    for (const t of m.ticks) this.recorder.record(t.t, t.c);
    for (const [tick, h] of m.hashes) this.recorder.hash(tick, h);
    if (m.summary) this.lastSummary = m.summary;
    this.sim.applyViewFrame(m.frame);
    this.alpha = Math.min(1, this.acc / TICK_MS);
    this.onStep?.(this.sim.events);
  }

  replay(): ReplayData {
    const data = this.recorder.finish(this.sim.winnerTeam, this.sim.tick, Date.now());
    if (this.lastSummary) data.summary = this.lastSummary;
    // the next copy asked for gets a fresher one
    this.worker.postMessage({ t: 'summary' } satisfies SimWorkerIn);
    return data;
  }
  summary(): MatchSummary | null { return this.lastSummary; }
  dispose(): void { this.worker.terminate(); }
}

/** messages to the background replay run (replayWorker.ts) */
export type ReplayWorkerIn = { t: 'start'; data: ReplayData; budget: number } | { t: 'want'; tick: number };
/** and back */
export type ReplayWorkerOut =
  | { t: 'keyframe'; snap: SimSnapshot; bytes: number }
  | { t: 'progress'; tick: number }
  | { t: 'desync'; tick: number }
  | { t: 'done'; tick: number };

/** memory the keyframes of one replay may take; past it the closest ones are thinned out */
const KEYFRAME_BUDGET = 160 << 20;
/**
 * A jump this close (in ticks) to somewhere the simulation can start from - where it stands, or a keyframe - is
 * simply played through here; further, and the background run is asked for a keyframe right at the target.
 */
const NEAR_TICKS = 400;

/** a keyframe as kept: packed (packSnapshot), unpacked only when it is put back */
interface Keyframe { tick: number; snap: SimSnapshot; bytes: number }

/**
 * Replay playback with speed control, and jumps to any moment without playing the match from its start.
 *
 * As soon as the replay is open a worker (replayWorker.ts) runs through the whole recording in the background and
 * posts keyframes - snapshots of the simulation - spaced so all of them fit KEYFRAME_BUDGET. A jump puts the
 * nearest keyframe before the target back and plays the few seconds from there; a jump beyond what the background
 * run has reached waits for it, which asks it for a keyframe right at the target. Without workers (tests) jumps
 * are played through here, as they always used to be.
 */
export class ReplaySession implements Session {
  readonly kind = 'replay' as const;
  readonly sim: Simulation;
  readonly setup: MatchSetup;
  mySlot = -1;
  alpha = 0;
  speed = 1;
  paused = false;
  onStep: ((events: SimEvent[]) => void) | null = null;
  catchingUp = false;
  private player: ReplayPlayer;
  private acc = 0;
  readonly totalTicks: number;
  /**
   * First tick whose state differs from the recording, -1 while they agree. A recording made on other rules
   * than this build's plays on regardless and shows a match that never happened; the hashes say when.
   */
  desyncTick = -1;
  private disposed = false;
  /** sorted by tick; the first is the start of the match */
  private keys: Keyframe[] = [];
  private keyBytes = 0;
  private worker: Worker | null = null;
  /** how far the background run has got (ticks) */
  frontier = 0;
  private wake: (() => void)[] = [];
  /**
   * The playback itself, off this thread (simWorker.ts in replay mode): `sim` is then the view's copy, kept up to
   * date by its frames, and ticks are asked for as the clock runs - see WorkerSession, which this follows. Null
   * without workers: the replay is then played here, on `sim` itself.
   */
  private play: Worker | null = null;
  private requested = 0;
  private inFlight = 0;
  private watch: number[] = [];
  /** a jump the playback worker is working on: how to report its progress, and what to call when it is done */
  private seeking: { progress?: (done: number) => void; done: () => void } | null = null;

  constructor(readonly data: ReplayData) {
    this.setup = data.setup;
    this.sim = new Simulation(data.setup, mapForSetup(data.setup));
    this.player = new ReplayPlayer(data);
    this.totalTicks = data.tickCount;
    this.addKey(packSnapshot(this.sim.snapshot()));
    this.startWorker();
    this.startPlayback();
  }
  submit(): void { /* spectators can't command */ }
  setWatch(players: number[]): void { this.watch = players.filter((p) => p >= 0); }

  private startPlayback(): void {
    if (typeof Worker === 'undefined') return;
    try {
      this.play = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
    } catch { this.play = null; return; }
    this.play.onmessage = (e: MessageEvent<SimWorkerOut>) => this.onPlay(e.data);
    this.play.postMessage({ t: 'replay', data: this.data } satisfies SimWorkerIn);
  }
  private onPlay(m: SimWorkerOut): void {
    if (m.t === 'progress') { this.seeking?.progress?.(m.done); return; }
    if (m.t !== 'frame') return;
    if (m.desync !== undefined && m.desync >= 0 && (this.desyncTick < 0 || m.desync < this.desyncTick)) this.desyncTick = m.desync;
    this.inFlight--;
    if (m.seek) {
      // a jump: whatever was owed belonged to the moment left behind
      this.requested = 0; this.acc = 0;
      this.sim.applyViewFrame(m.frame);
      this.alpha = 1;
      const s = this.seeking; this.seeking = null;
      s?.done();
      return;
    }
    const n = m.ticks.length;
    this.requested = Math.max(0, this.requested - n);
    this.acc = Math.max(0, this.acc - n * TICK_MS);
    if (this.inFlight === 0) this.requested = 0;
    this.sim.applyViewFrame(m.frame);
    this.alpha = Math.min(1, this.acc / TICK_MS);
    this.onStep?.(this.sim.events);
  }

  update(dtMs: number): void {
    if (this.paused || this.sim.gameOver || this.sim.tick >= this.totalTicks) { this.alpha = 1; return; }
    if (this.play) {
      if (this.seeking) return;
      this.acc += dtMs * this.speed;
      const max = Math.max(8, this.speed * 4);
      if (this.acc > (max + this.requested) * TICK_MS) this.acc = (max + this.requested) * TICK_MS;
      const due = Math.min(Math.floor(this.acc / TICK_MS) - this.requested, this.totalTicks - this.sim.tick - this.requested);
      if (due > 0 && this.inFlight < MAX_IN_FLIGHT) {
        this.play.postMessage({ t: 'step', n: due, watch: this.watch } satisfies SimWorkerIn);
        this.requested += due;
        this.inFlight++;
      }
      this.alpha = Math.min(1, this.acc / TICK_MS);
      return;
    }
    this.acc += dtMs * this.speed;
    let steps = 0;
    const max = Math.max(8, this.speed * 4);
    while (this.acc >= TICK_MS && steps < max && this.sim.tick < this.totalTicks) {
      this.acc -= TICK_MS;
      this.stepOne();
      this.onStep?.(this.sim.events);
      steps++;
    }
    if (steps >= max) this.acc = 0;
    this.alpha = Math.min(1, this.acc / TICK_MS);
  }
  /** one tick of the recording, checked against its hash where it has one */
  private stepOne(): void {
    const tick = this.sim.tick + 1;
    this.sim.step(this.player.commandsFor(tick));
    if (tick % HASH_INTERVAL === 0 && this.desyncTick < 0) {
      const want = this.player.expectedHash(tick);
      if (want !== undefined && want !== this.sim.hash()) this.desyncTick = tick;
    }
  }

  // ------------------------------------------------------------------ keyframes

  private startWorker(): void {
    if (typeof Worker === 'undefined' || this.totalTicks <= NEAR_TICKS) { this.frontier = this.totalTicks; return; }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./replayWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.frontier = this.totalTicks;
      return;
    }
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<ReplayWorkerOut>) => {
      const m = e.data;
      if (m.t === 'keyframe') { this.addKey(m.snap, m.bytes); this.frontier = Math.max(this.frontier, m.snap.tick); }
      else if (m.t === 'desync') { if (this.desyncTick < 0 || m.tick < this.desyncTick) this.desyncTick = m.tick; }
      else this.frontier = Math.max(this.frontier, m.tick);
      if (m.t === 'done') this.stopWorker(this.totalTicks);
      this.wakeUp();
    };
    // a worker that fails leaves the jumps to be played through here
    worker.onerror = () => this.stopWorker(this.totalTicks);
    worker.postMessage({ t: 'start', data: this.data, budget: KEYFRAME_BUDGET } satisfies ReplayWorkerIn);
  }
  private stopWorker(frontier: number): void {
    this.worker?.terminate();
    this.worker = null;
    this.frontier = Math.max(this.frontier, frontier);
    this.wakeUp();
  }
  private wakeUp(): void { const w = this.wake; this.wake = []; for (const f of w) f(); }
  private next(): Promise<void> { return new Promise((r) => this.wake.push(r)); }

  /** keep a keyframe; over the budget, drop the one whose loss leaves the shortest gap (never the first or the newest) */
  private addKey(snap: SimSnapshot, bytes = snapshotBytes(snap)): void {
    const keys = this.keys;
    let i = keys.length;
    while (i > 0 && keys[i - 1].tick > snap.tick) i--;
    if (i > 0 && keys[i - 1].tick === snap.tick) return;
    keys.splice(i, 0, { tick: snap.tick, snap, bytes });
    this.keyBytes += bytes;
    while (this.keyBytes > KEYFRAME_BUDGET && keys.length > 2) {
      let drop = -1, gap = Infinity;
      for (let k = 1; k < keys.length - 1; k++) {
        const g = keys[k + 1].tick - keys[k - 1].tick;
        if (g < gap) { gap = g; drop = k; }
      }
      if (drop < 0) break;
      this.keyBytes -= keys[drop].bytes;
      keys.splice(drop, 1);
    }
  }
  /** the latest keyframe at or before `tick` */
  private keyAt(tick: number): Keyframe | null {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.keys[mid].tick <= tick) lo = mid + 1; else hi = mid; }
    return lo > 0 ? this.keys[lo - 1] : null;
  }

  /**
   * Go to `tick`, forward or back. From the nearest keyframe before it, or from where the simulation stands if that
   * is nearer; a target the background run has not reached yet is waited for. `onProgress` gets the share done
   * (0..1) while there is anything to wait for. Returns whether the state was replaced by a keyframe - the view
   * then forgets what it had remembered of the moment it left.
   */
  async seekTo(tick: number, onProgress?: (done: number) => void, sliceMs = 24): Promise<boolean> {
    const target = Math.max(0, Math.min(tick, this.totalTicks));
    const startFrom = () => Math.max(this.sim.tick <= target ? this.sim.tick : -1, this.keyAt(target)?.tick ?? -1);
    if (this.worker && this.frontier < target && target - startFrom() > NEAR_TICKS) {
      this.worker.postMessage({ t: 'want', tick: target } satisfies ReplayWorkerIn);
      const from = this.frontier;
      while (this.worker && this.frontier < target && !this.disposed) {
        onProgress?.((this.frontier - from) / Math.max(1, target - from));
        await this.next();
      }
    }
    if (this.disposed) return false;
    let jumped = false;
    const key = this.keyAt(target);
    const restore = !!key && (this.sim.tick > target || key.tick > this.sim.tick);
    if (this.play) {
      // the playback worker puts the keyframe back and plays on to the target; frames for ticks asked for before
      // come back first, the jump's own frame last
      if (!restore && this.sim.tick === target) return false;
      await new Promise<void>((done) => {
        this.seeking = { progress: onProgress, done };
        this.inFlight++;
        this.play!.postMessage({ t: 'seek', snap: restore ? key!.snap : null, target, watch: this.watch } satisfies SimWorkerIn);
      });
      return restore;
    }
    if (restore) {
      this.sim.restore(unpackSnapshot(key!.snap));
      this.player.seek(key!.tick);
      this.acc = 0;
      jumped = true;
    }
    // what is left - a few seconds at most once the keyframes are in - is played here, handing the page back
    // between slices so it can paint
    const from = this.sim.tick;
    while (this.sim.tick < target && !this.sim.gameOver && !this.disposed) {
      const t0 = performance.now();
      while (this.sim.tick < target && !this.sim.gameOver && performance.now() - t0 < sliceMs) this.stepOne();
      if (this.sim.tick >= target) break;
      onProgress?.((this.sim.tick - from) / Math.max(1, target - from));
      await new Promise((r) => setTimeout(r, 0));
    }
    return jumped;
  }
  replay(): ReplayData { return this.data; }
  summary(): MatchSummary | null { return this.data.summary ?? null; }
  dispose(): void {
    this.disposed = true;
    this.stopWorker(this.frontier);
    this.play?.terminate(); this.play = null;
    const s = this.seeking; this.seeking = null; s?.done();
    this.keys = []; this.keyBytes = 0;
  }
}

/** Online lockstep: the server owns the tick clock; we execute frames as they arrive. */
export class NetSession implements Session {
  readonly kind = 'net' as const;
  readonly sim: Simulation;
  readonly setup: MatchSetup;
  mySlot: number;
  alpha = 0;
  speed = 1;
  paused = false;
  onStep: ((events: SimEvent[]) => void) | null = null;
  catchingUp = false;
  private frames = new Map<number, Command[]>();
  private latest = 0;
  private acc = 0;
  private outbox: Command[] = [];
  private unsub: (() => void)[] = [];
  private recorder: ReplayRecorder;
  private summaryRec: SummaryRecorder;
  /** ticks we are behind the server's latest frame */
  behind = 0;
  /** real time per tick: the server runs the match at the speed the host picked */
  private readonly tickMs: number;

  constructor(private net: NetClient, setup: MatchSetup, mySlot: number) {
    this.setup = setup;
    this.tickMs = tickMsFor(setup.speed);
    this.sim = new Simulation(setup, mapForSetup(setup));
    this.mySlot = mySlot;
    this.recorder = new ReplayRecorder(setup, mapForSetup(setup).name);
    this.summaryRec = new SummaryRecorder(this.sim);
    this.unsub.push(net.on('frames', (frames: TickFrame[]) => this.onFrames(frames)));
    this.onFrames(net.takePendingFrames());
  }

  private onFrames(frames: TickFrame[]): void {
    for (const f of frames) {
      if (f.tick <= this.sim.tick) continue;
      this.frames.set(f.tick, f.cmds);
      if (f.tick > this.latest) this.latest = f.tick;
    }
    if (frames.length > 20) this.catchingUp = true;
  }

  submit(cmd: Command): void {
    this.outbox.push(cmd);
  }

  update(dtMs: number): void {
    // flush commands immediately (server assigns them to the next tick)
    if (this.outbox.length > 0) {
      this.net.sendBinary(encodeCommandsFrame(this.sim.tick, this.outbox));
      this.outbox.length = 0;
    }
    if (this.sim.gameOver) { this.alpha = 1; return; }
    this.behind = this.latest - this.sim.tick;
    if (this.behind > 40) {
      // catch-up mode after reconnect or a stall: as many ticks as fit in a frame, without animation. A cap on the
      // tick count alone let one frame run 200 of them - a 200-400 ms freeze mid-fight (docs/PERF.md §6)
      this.catchingUp = true;
      const t0 = performance.now();
      while (this.behind > 2 && performance.now() - t0 < CATCH_UP_MS_PER_FRAME && this.stepIfAvailable()) this.behind = this.latest - this.sim.tick;
      this.acc = 0; this.alpha = 1;
      return;
    }
    this.catchingUp = false;
    // pace at the match tick rate, speeding up slightly when the buffer grows
    const rate = this.behind > 4 ? 1.25 : this.behind > 2 ? 1.1 : 1;
    this.acc += dtMs * rate;
    let steps = 0;
    const max = Math.max(4, Math.ceil((TICK_MS / this.tickMs) * 4));
    while (this.acc >= this.tickMs && steps < max) {
      if (!this.stepIfAvailable()) { this.acc = Math.min(this.acc, this.tickMs); break; }
      this.acc -= this.tickMs;
      steps++;
    }
    this.alpha = Math.min(1, this.acc / this.tickMs);
  }

  private stepIfAvailable(): boolean {
    const tick = this.sim.tick + 1;
    const cmds = this.frames.get(tick);
    if (!cmds) return false;
    this.frames.delete(tick);
    this.recorder.record(tick, cmds);
    this.sim.step(cmds);
    this.summaryRec.observe(this.sim);
    if (tick % HASH_INTERVAL === 0) {
      const h = this.sim.hash();
      this.recorder.hash(tick, h);
      this.net.send({ t: 'hash', tick, hash: h });
    }
    this.onStep?.(this.sim.events);
    return true;
  }

  replay(): ReplayData {
    const data = this.recorder.finish(this.sim.winnerTeam, this.sim.tick, Date.now());
    data.summary = this.summaryRec.finish(this.sim);
    return data;
  }
  summary(): MatchSummary { return this.summaryRec.finish(this.sim); }
  dispose(): void { for (const u of this.unsub) u(); }
}
