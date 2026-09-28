import { KEYFRAME_EVERY, Keyframe, KeyframeSet, SimSnapshot, Simulation, snapshotBuffers, takeKeyframe } from '@pocket-of-empire/sim';

/** messages to the keeper of a match's keyframes (keyframeWorker.ts) */
export type KeyWorkerIn = { t: 'budget'; budget: number } | { t: 'add'; snap: SimSnapshot } | { t: 'take' } | { t: 'at'; tick: number };
/** and back, one answer per 'take' or 'at', in order */
export type KeyWorkerOut = { t: 'keys'; keys: Keyframe[] } | { t: 'key'; key: Keyframe | null };

/**
 * The keyframes a match leaves for its replay as it is played - every KEYFRAME_EVERY ticks the state is copied and
 * handed to a worker (keyframeWorker.ts) that packs and keeps it. Whatever steps the simulation - the page for
 * LocalSession and NetSession, the simulation worker for WorkerSession - pays for the copy alone, a millisecond on a
 * six-player map and a few on a hundred-player one, where the packing would stall the ticks for thirty. Where no
 * worker can be started they are packed and kept right here.
 */
export class LiveKeyframes {
  private worker: Worker | null = null;
  private here: KeyframeSet | null = null;
  private taking: ((keys: Keyframe[]) => void)[] = [];
  private finding: ((key: Keyframe | null) => void)[] = [];

  constructor(budget: number) {
    if (typeof Worker !== 'undefined') {
      try { this.worker = new Worker(new URL('./keyframeWorker.ts', import.meta.url), { type: 'module' }); } catch { this.worker = null; }
    }
    if (!this.worker) { this.here = new KeyframeSet(budget); return; }
    this.worker.onmessage = (e: MessageEvent<KeyWorkerOut>) => {
      if (e.data.t === 'keys') this.taking.shift()?.(e.data.keys);
      else this.finding.shift()?.(e.data.key);
    };
    // a keeper that fails only costs the replay its head start
    this.worker.onerror = () => this.dispose();
    this.worker.postMessage({ t: 'budget', budget } satisfies KeyWorkerIn);
  }

  /** the simulation has just stepped: keep the moment if it is one to keep */
  observe(sim: Simulation): void {
    if (sim.tick % KEYFRAME_EVERY !== 0) return;
    if (this.here) { this.here.add(takeKeyframe(sim)); return; }
    if (!this.worker) return;
    const snap = sim.snapshot();
    this.worker.postMessage({ t: 'add', snap } satisfies KeyWorkerIn, snapshotBuffers(snap));
  }

  /** every keyframe so far, handed over: none are kept after */
  take(): Promise<Keyframe[]> {
    if (this.here) return Promise.resolve(this.here.take());
    const w = this.worker;
    if (!w) return Promise.resolve([]);
    return new Promise((r) => { this.taking.push(r); w.postMessage({ t: 'take' } satisfies KeyWorkerIn); });
  }

  /** a copy of the latest keyframe at or before `tick` on a tick the recording has a hash for */
  at(tick: number): Promise<Keyframe | null> {
    if (this.here) return Promise.resolve(this.here.at(tick, true));
    const w = this.worker;
    if (!w) return Promise.resolve(null);
    return new Promise((r) => { this.finding.push(r); w.postMessage({ t: 'at', tick } satisfies KeyWorkerIn); });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const r of this.taking.splice(0)) r([]);
    for (const r of this.finding.splice(0)) r(null);
  }
}
