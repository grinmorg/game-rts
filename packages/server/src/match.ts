import { Bot, createBots } from '@rookfall/ai';
import { encodeBatch, encodeTickFrame, ServerMessage } from '@rookfall/protocol';
import {
  Command, CommandType, DISCONNECT_TIMEOUT_TICKS, EventType, HASH_INTERVAL, MatchSetup, ReplayData, ReplayRecorder, Simulation,
  SummaryRecorder, TICK_MS, createMap, tickMsFor,
} from '@rookfall/sim';

export interface MatchHooks {
  broadcast(msg: ServerMessage): void;
  broadcastBinary(data: Uint8Array): void;
  onGameOver(replay: ReplayData): void;
  /** called when nobody human is connected any more for a while */
  onAbandoned(): void;
}

interface Takeover { bot: Bot; since: number; lastNotice: number }

/**
 * Server-side lockstep authority for one match: assigns commands to ticks, validates them
 * against a headless simulation, drives bots (including disconnected players), checks hashes
 * and records the replay.
 */
export class Match {
  readonly sim: Simulation;
  readonly setup: MatchSetup;
  readonly frames: { tick: number; cmds: Command[] }[] = [];
  private pending: Command[] = [];
  private bots: Bot[];
  private takeovers = new Map<number, Takeover>();
  private recorder: ReplayRecorder;
  /** charts and battles for the results screen of whoever opens the replay later */
  private summary: SummaryRecorder;
  private serverHashes = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private connected = new Set<number>();
  private abandonedSince = -1;
  private desyncReported = false;
  running = false;
  /** real time per tick - the host's match speed (1x..5x) */
  private readonly tickMs: number;

  constructor(setup: MatchSetup, private hooks: MatchHooks) {
    this.setup = setup;
    this.tickMs = tickMsFor(setup.speed);
    this.sim = new Simulation(setup, createMap(setup.mapId, setup.seed));
    this.bots = createBots(this.sim);
    this.recorder = new ReplayRecorder(setup, createMap(setup.mapId, setup.seed).name);
    this.summary = new SummaryRecorder(this.sim);
  }

  start(connectedSlots: number[]): void {
    for (const s of connectedSlots) this.connected.add(s);
    this.startedAt = Date.now();
    this.running = true;
    this.timer = setInterval(() => this.loop(), this.tickMs / 2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  get tick(): number { return this.sim.tick; }

  /** Commands from a client: only its own player id is accepted. */
  submit(slot: number, cmds: Command[]): void {
    if (!this.running) return;
    for (const c of cmds) {
      if (c.player !== slot) continue;
      if (c.type === CommandType.Eliminate) continue;
      if (c.ids && c.ids.length > 200) c.ids.length = 200;
      this.pending.push(c);
    }
  }

  onHash(slot: number, tick: number, hash: number): void {
    const mine = this.serverHashes.get(tick);
    if (mine === undefined) return;
    if (mine !== hash && !this.desyncReported) {
      this.desyncReported = true;
      console.warn(`[match] DESYNC at tick ${tick}: slot ${slot} sent ${hash.toString(16)}, server ${mine.toString(16)}`);
      this.hooks.broadcast({ t: 'desync', tick, slot });
    }
  }

  playerDisconnected(slot: number): void {
    this.connected.delete(slot);
    const p = this.sim.players[slot];
    if (!p || !p.alive || p.isBot) return;
    if (!this.takeovers.has(slot)) {
      const bot = new Bot(slot, 0, this.setup.seed + slot * 7);
      this.takeovers.set(slot, { bot, since: this.sim.tick, lastNotice: this.sim.tick });
      this.hooks.broadcast({ t: 'playerStatus', slot, status: 'disconnected', secondsLeft: DISCONNECT_TIMEOUT_TICKS / 20 });
      this.hooks.broadcast({ t: 'chat', from: -1, name: 'system', text: `disconnected:${slot}:${Math.round(DISCONNECT_TIMEOUT_TICKS / 20)}`, system: true });
    }
  }

  /** Returns the batch of all frames so far for catch-up. */
  playerReconnected(slot: number): Uint8Array {
    this.connected.add(slot);
    this.abandonedSince = -1;
    if (this.takeovers.delete(slot)) {
      this.hooks.broadcast({ t: 'playerStatus', slot, status: 'connected' });
      this.hooks.broadcast({ t: 'chat', from: -1, name: 'system', text: `reconnected:${slot}`, system: true });
    }
    return encodeBatch(this.frames);
  }

  private loop(): void {
    if (!this.running) return;
    const expected = Math.floor((Date.now() - this.startedAt) / this.tickMs);
    const burst = Math.ceil((TICK_MS / this.tickMs) * 5);
    let n = 0;
    while (this.sim.tick < expected && n < burst && this.running) { this.step(); n++; }
    // abandoned match watchdog
    const humansAlive = this.sim.players.some((p) => p.alive && !p.isBot);
    if (this.connected.size === 0 && humansAlive) {
      if (this.abandonedSince < 0) this.abandonedSince = Date.now();
      else if (Date.now() - this.abandonedSince > 90_000) { this.stop(); this.hooks.onAbandoned(); }
    } else this.abandonedSince = -1;
  }

  private step(): void {
    const sim = this.sim;
    const cmds = this.pending;
    this.pending = [];
    for (const b of this.bots) cmds.push(...b.think(sim));
    for (const [slot, t] of this.takeovers) {
      cmds.push(...t.bot.think(sim));
      const elapsed = sim.tick - t.since;
      if (elapsed >= DISCONNECT_TIMEOUT_TICKS) {
        cmds.push({ type: CommandType.Eliminate, player: -1, v: slot });
        this.takeovers.delete(slot);
      } else if (sim.tick - t.lastNotice >= 1200) {
        t.lastNotice = sim.tick;
        // in real seconds: an accelerated match burns the grace period that many times faster
        const left = Math.round(((DISCONNECT_TIMEOUT_TICKS - elapsed) * this.tickMs) / 1000);
        this.hooks.broadcast({ t: 'playerStatus', slot, status: 'disconnected', secondsLeft: left });
        this.hooks.broadcast({ t: 'chat', from: -1, name: 'system', text: `disconnected:${slot}:${left}`, system: true });
      }
    }
    const accepted: Command[] = [];
    for (const c of cmds) if (sim.validate(c) === null) accepted.push(c);
    const tick = sim.tick + 1;
    this.frames.push({ tick, cmds: accepted });
    this.recorder.record(tick, accepted);
    this.hooks.broadcastBinary(encodeTickFrame(tick, accepted));
    sim.step(accepted);
    this.summary.observe(sim);
    if (tick % HASH_INTERVAL === 0) {
      const h = sim.hash();
      this.serverHashes.set(tick, h);
      this.recorder.hash(tick, h);
      if (this.serverHashes.size > 60) {
        const oldest = tick - HASH_INTERVAL * 60;
        for (const k of this.serverHashes.keys()) if (k <= oldest) this.serverHashes.delete(k);
      }
    }
    for (const e of sim.events) {
      if (e.type === EventType.PlayerEliminated) {
        this.hooks.broadcast({ t: 'playerStatus', slot: e.v, status: 'eliminated' });
        this.takeovers.delete(e.v);
      }
    }
    if (sim.gameOver) {
      this.stop();
      const replay = this.recorder.finish(sim.winnerTeam, sim.tick, Date.now());
      replay.summary = this.summary.finish(sim);
      this.hooks.onGameOver(replay);
    }
  }
}
