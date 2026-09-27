/**
 * Keeper of the keyframes a match leaves for its replay (see LiveKeyframes): whatever steps the simulation copies the
 * state every KEYFRAME_EVERY ticks and hands it over, this packs it and keeps it within the budget - so a replay opened
 * from the match's results jumps anywhere at once, and the ticks never wait on the packing.
 */
import { KeyframeSet, packSnapshot, snapshotBuffers, snapshotBytes } from '@rookfall/sim';
import type { KeyWorkerIn, KeyWorkerOut } from './liveKeyframes';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<KeyWorkerIn>) => void) | null;
  postMessage(m: KeyWorkerOut, transfer?: Transferable[]): void;
};

let keys = new KeyframeSet(0);

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'budget') keys = new KeyframeSet(m.budget);
  else if (m.t === 'add') {
    const snap = packSnapshot(m.snap);
    keys.add({ tick: snap.tick, snap, bytes: snapshotBytes(snap) });
  } else if (m.t === 'take') {
    const all = keys.take();
    ctx.postMessage({ t: 'keys', keys: all }, all.flatMap((k) => snapshotBuffers(k.snap)));
  } else if (m.t === 'at') ctx.postMessage({ t: 'key', key: keys.at(m.tick, true) });
};
