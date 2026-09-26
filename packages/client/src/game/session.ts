import { Bot, createBots } from '@rookfall/ai';
import { TickFrame, encodeCommandsFrame } from '@rookfall/protocol';
import {
  COMMAND_DELAY_TICKS, Command, HASH_INTERVAL, MatchSetup, MatchSummary, ReplayData, ReplayPlayer, ReplayRecorder, SimEvent, Simulation,
  SummaryRecorder, TICK_MS, mapForSetup, tickMsFor,
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

/** Replay playback with speed control. */
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

  constructor(readonly data: ReplayData) {
    this.setup = data.setup;
    this.sim = new Simulation(data.setup, mapForSetup(data.setup));
    this.player = new ReplayPlayer(data);
    this.totalTicks = data.tickCount;
  }
  submit(): void { /* spectators can't command */ }
  update(dtMs: number): void {
    if (this.paused || this.sim.gameOver || this.sim.tick >= this.totalTicks) { this.alpha = 1; return; }
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
  /** jump forward quickly (no rendering of intermediate ticks) */
  seek(tick: number): void {
    while (this.sim.tick < Math.min(tick, this.totalTicks) && !this.sim.gameOver) this.stepOne();
  }
  /**
   * The same jump a slice at a time, handing the page back between slices so it can paint a progress bar
   * (and the view keeps drawing the match as it rushes by). `onProgress` gets the share done, 0..1.
   */
  async seekTo(tick: number, onProgress?: (done: number) => void, sliceMs = 24): Promise<void> {
    const target = Math.min(tick, this.totalTicks);
    const from = this.sim.tick;
    while (this.sim.tick < target && !this.sim.gameOver && !this.disposed) {
      const t0 = performance.now();
      while (this.sim.tick < target && !this.sim.gameOver && performance.now() - t0 < sliceMs) this.stepOne();
      onProgress?.((this.sim.tick - from) / Math.max(1, target - from));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  replay(): ReplayData { return this.data; }
  summary(): MatchSummary | null { return this.data.summary ?? null; }
  dispose(): void { this.disposed = true; }
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
