import { Bot, createBots } from '@warlets/ai';
import { TickFrame, encodeCommandsFrame } from '@warlets/protocol';
import {
  COMMAND_DELAY_TICKS, Command, HASH_INTERVAL, MatchSetup, ReplayData, ReplayPlayer, ReplayRecorder, SimEvent, Simulation, TICK_MS, createMap, tickMsFor,
} from '@warlets/sim';
import { NetClient } from '../net/client';

export type SessionKind = 'local' | 'net' | 'replay';

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
  /** replay data produced so far (local & net) */
  replay(): ReplayData | null;
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

  constructor(setup: MatchSetup, mySlot: number) {
    this.setup = setup;
    this.sim = new Simulation(setup, createMap(setup.mapId, setup.seed));
    this.bots = createBots(this.sim);
    this.mySlot = mySlot;
    this.speed = TICK_MS / tickMsFor(setup.speed); // match speed chosen in the skirmish setup
    this.recorder = new ReplayRecorder(setup, createMap(setup.mapId, setup.seed).name);
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
    for (const b of this.bots) cmds.push(...b.think(this.sim));
    this.recorder.record(tick, cmds);
    this.sim.step(cmds);
    if (tick % HASH_INTERVAL === 0) this.recorder.hash(tick, this.sim.hash());
    this.onStep?.(this.sim.events);
  }

  replay(): ReplayData {
    return this.recorder.finish(this.sim.winnerTeam, this.sim.tick, Date.now());
  }
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

  constructor(readonly data: ReplayData) {
    this.setup = data.setup;
    this.sim = new Simulation(data.setup, createMap(data.setup.mapId, data.setup.seed));
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
      const tick = this.sim.tick + 1;
      this.sim.step(this.player.commandsFor(tick));
      this.onStep?.(this.sim.events);
      steps++;
    }
    if (steps >= max) this.acc = 0;
    this.alpha = Math.min(1, this.acc / TICK_MS);
  }
  /** jump forward quickly (no rendering of intermediate ticks) */
  seek(tick: number): void {
    while (this.sim.tick < Math.min(tick, this.totalTicks) && !this.sim.gameOver) {
      const t = this.sim.tick + 1;
      this.sim.step(this.player.commandsFor(t));
    }
  }
  replay(): ReplayData { return this.data; }
  dispose(): void { /* nothing */ }
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
  /** ticks we are behind the server's latest frame */
  behind = 0;
  /** real time per tick: the server runs the match at the speed the host picked */
  private readonly tickMs: number;

  constructor(private net: NetClient, setup: MatchSetup, mySlot: number) {
    this.setup = setup;
    this.tickMs = tickMsFor(setup.speed);
    this.sim = new Simulation(setup, createMap(setup.mapId, setup.seed));
    this.mySlot = mySlot;
    this.recorder = new ReplayRecorder(setup, createMap(setup.mapId, setup.seed).name);
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
      // catch-up mode after reconnect: run many ticks per frame without animation
      this.catchingUp = true;
      let n = 0;
      while (this.behind > 2 && n < 200 && this.stepIfAvailable()) { n++; this.behind = this.latest - this.sim.tick; }
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
    if (tick % HASH_INTERVAL === 0) {
      const h = this.sim.hash();
      this.recorder.hash(tick, h);
      this.net.send({ t: 'hash', tick, hash: h });
    }
    this.onStep?.(this.sim.events);
    return true;
  }

  replay(): ReplayData { return this.recorder.finish(this.sim.winnerTeam, this.sim.tick, Date.now()); }
  dispose(): void { for (const u of this.unsub) u(); }
}
