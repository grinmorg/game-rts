/**
 * Background run of a replay (see ReplaySession): plays the recording from the first tick to the last as fast as
 * the core allows and posts a snapshot of the simulation every so often, packed (packSnapshot) - the keyframes a
 * jump anywhere in the match starts from. Spacing follows the size of a keyframe, so a whole match fits the budget
 * it is given; a tick the page asks for ("want") gets a keyframe of its own, for a jump ahead of where this run has
 * got.
 */
import { HASH_INTERVAL, ReplayData, ReplayPlayer, Simulation, mapForSetup, packSnapshot, snapshotBuffers, snapshotBytes } from '@rookfall/sim';
import type { ReplayWorkerIn, ReplayWorkerOut } from './session';

/** closest two regular keyframes ever get, in ticks */
const KEYFRAME_MIN = 200;
/** work between two looks at the message queue */
const SLICE_MS = 30;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ReplayWorkerIn>) => void) | null;
  postMessage(m: ReplayWorkerOut, transfer?: Transferable[]): void;
};
const wants = new Set<number>();

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'start') void run(m.data, m.budget);
  else if (m.t === 'want') wants.add(m.tick);
};

async function run(data: ReplayData, budget: number): Promise<void> {
  const sim = new Simulation(data.setup, mapForSetup(data.setup));
  const player = new ReplayPlayer(data);
  const total = data.tickCount;
  let interval = KEYFRAME_MIN, lastKey = 0, desync = -1;
  while (sim.tick < total && !sim.gameOver) {
    const t0 = performance.now();
    while (sim.tick < total && !sim.gameOver && performance.now() - t0 < SLICE_MS) {
      const tick = sim.tick + 1;
      sim.step(player.commandsFor(tick));
      if (tick % HASH_INTERVAL === 0 && desync < 0) {
        const want = player.expectedHash(tick);
        if (want !== undefined && want !== sim.hash()) { desync = tick; ctx.postMessage({ t: 'desync', tick }); }
      }
      const wanted = wants.delete(tick);
      if (wanted || tick - lastKey >= interval) {
        const snap = packSnapshot(sim.snapshot());
        const bytes = snapshotBytes(snap);
        if (!wanted) {
          lastKey = tick;
          // as far apart as it takes for the whole match to fit, at what a keyframe weighs by now
          interval = Math.max(KEYFRAME_MIN, Math.ceil((total * bytes) / budget));
        }
        ctx.postMessage({ t: 'keyframe', snap, bytes }, snapshotBuffers(snap));
      }
    }
    ctx.postMessage({ t: 'progress', tick: sim.tick });
    // let the page's "want" messages in
    await new Promise((r) => setTimeout(r, 0));
  }
  ctx.postMessage({ t: 'done', tick: sim.tick });
}
