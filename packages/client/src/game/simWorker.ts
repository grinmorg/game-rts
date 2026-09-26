/**
 * A match's simulation run off the page's thread: a skirmish with its bots (WorkerSession), or the playback of a
 * replay (ReplaySession). The page asks for ticks as its clock runs and gets back one ViewFrame per request - the
 * state after them, their events, the commands they carried (for the replay a skirmish records) and now and then
 * the match summary. A replay also jumps here: the page hands over a keyframe, this puts it back and plays on to the
 * target. A hundred bots and their world cost the drawing nothing this way.
 */
import { Bot, createBots } from '@rookfall/ai';
import {
  COMMAND_DELAY_TICKS, Command, HASH_INTERVAL, ReplayPlayer, SUMMARY_SAMPLE_TICKS, SimEvent, Simulation, SummaryRecorder, ViewFrameWriter,
  mapForSetup, snapshotBuffers, unpackSnapshot,
} from '@rookfall/sim';
import type { SimWorkerIn, SimWorkerOut } from './session';

/** most ticks one request may ask for: a page that was away comes back without a long stall here */
const MAX_TICKS_PER_STEP = 40;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SimWorkerIn>) => void) | null;
  postMessage(m: SimWorkerOut, transfer?: Transferable[]): void;
};

let sim: Simulation | null = null;
let bots: Bot[] = [];
let writer: ViewFrameWriter | null = null;
let summary: SummaryRecorder | null = null;
const scheduled = new Map<number, Command[]>();
/** a replay being played: its commands, how long it is, the first tick that did not match its hashes */
let player: ReplayPlayer | null = null;
let total = Infinity;
let desync = -1;
/** progress reports while a jump plays on */
const PROGRESS_MS = 80;

/** one tick: the replay's commands, or the scheduled ones and the bots' */
function stepOne(ticks: { t: number; c: Command[] }[], hashes: [number, number][]): void {
  const s = sim!;
  const tick = s.tick + 1;
  let cmds: Command[];
  if (player) cmds = player.commandsFor(tick);
  else {
    cmds = scheduled.get(tick) ?? [];
    scheduled.delete(tick);
    for (const b of bots) cmds.push(...b.think(s));
  }
  ticks.push({ t: tick, c: cmds });
  s.step(cmds);
  summary?.observe(s);
  if (tick % HASH_INTERVAL === 0) {
    const h = s.hash();
    hashes.push([tick, h]);
    if (player && desync < 0) { const want = player.expectedHash(tick); if (want !== undefined && want !== h) desync = tick; }
  }
}

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'start') {
    sim = new Simulation(m.setup, mapForSetup(m.setup));
    bots = createBots(sim);
    writer = new ViewFrameWriter(sim);
    summary = new SummaryRecorder(sim);
    return;
  }
  if (m.t === 'replay') {
    // no bots and no summary of its own: the recording carries both
    sim = new Simulation(m.data.setup, mapForSetup(m.data.setup));
    player = new ReplayPlayer(m.data);
    total = m.data.tickCount;
    writer = new ViewFrameWriter(sim);
    return;
  }
  if (!sim || !writer) return;
  if (m.t === 'cmd') {
    // delayed like online, counted from the tick the simulation is at here
    const t = sim.tick + COMMAND_DELAY_TICKS;
    let list = scheduled.get(t);
    if (!list) scheduled.set(t, list = []);
    list.push(m.cmd);
  } else if (m.t === 'step') {
    const ticks: { t: number; c: Command[] }[] = [];
    const hashes: [number, number][] = [];
    let events: SimEvent[] = [];
    let sampled = false;
    for (let i = 0; i < Math.min(m.n, MAX_TICKS_PER_STEP) && !sim.gameOver && sim.tick < total; i++) {
      stepOne(ticks, hashes);
      if (sim.tick % SUMMARY_SAMPLE_TICKS === 0) sampled = true;
      events = events.length ? events.concat(sim.events) : sim.events.slice();
    }
    const frame = writer.frame(events, m.watch);
    // the summary rides along every sample, and at the end: the result screen reads it from the page
    const out: SimWorkerOut = {
      t: 'frame', frame, ticks, hashes, desync, seek: false,
      summary: summary && (sampled || sim.gameOver) ? summary.finish(sim) : null,
    };
    ctx.postMessage(out, snapshotBuffers(frame));
  } else if (m.t === 'seek') {
    // a replay jumps: back to a keyframe first if the page sent one, then played on to the target, reporting how
    // far it has got; the frame that answers carries everything, and no events - they belong to the ticks skipped
    if (m.snap) { sim.restore(unpackSnapshot(m.snap)); player?.seek(sim.tick); }
    writer.resync();
    const from = sim.tick, target = Math.min(m.target, total);
    const ticks: { t: number; c: Command[] }[] = [], hashes: [number, number][] = [];
    let last = performance.now();
    while (sim.tick < target && !sim.gameOver) {
      stepOne(ticks, hashes);
      if (performance.now() - last > PROGRESS_MS) { last = performance.now(); ctx.postMessage({ t: 'progress', done: (sim.tick - from) / Math.max(1, target - from) }); }
    }
    const frame = writer.frame([], m.watch);
    ctx.postMessage({ t: 'frame', frame, ticks: [], hashes: [], desync, seek: true, summary: null }, snapshotBuffers(frame));
  } else if (m.t === 'summary') {
    if (summary) ctx.postMessage({ t: 'summary', summary: summary.finish(sim) });
  } else if (m.t === 'spawn') {
    ctx.postMessage({ t: 'spawned', id: sim.spawnUnit(m.owner, m.type, m.x, m.y) });
  }
};
