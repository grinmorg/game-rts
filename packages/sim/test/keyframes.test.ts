import { describe, expect, it } from 'vitest';
import {
  CommandType, HASH_INTERVAL, KEYFRAME_EVERY, Keyframe, KeyframeSet, MatchSetup, PLAYER_COLORS, ReplayRecorder, SimSnapshot, Simulation, createMap,
  decodeKeyframe, encodeKeyframe, isTypedArray, keyframeMatches, keyframeTickOf, recordedHash, takeKeyframe, unpackSnapshot,
} from '../src';

const fake = (tick: number, bytes = 10): Keyframe => ({ tick, snap: { tick } as SimSnapshot, bytes });

/** where two values first differ, '' when they are the same (typed arrays by type and content) */
function diff(a: unknown, b: unknown, path = ''): string {
  if (isTypedArray(a) || isTypedArray(b)) {
    if (!isTypedArray(a) || !isTypedArray(b) || a.constructor !== b.constructor || a.length !== b.length) return `${path}: shape`;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `${path}[${i}]`;
    return '';
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) ? '' : `${path}: ${String(a)} vs ${String(b)}`;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
  for (const k of ka) {
    const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return '';
}

/** a short duel with some orders in it, recorded with its hashes */
function recorded(ticks: number) {
  const setup: MatchSetup = {
    seed: 9, mapId: 'duel-valley', version: 1,
    players: [0, 1].map((i) => ({ slot: i, team: i, name: i ? 'Боб' : 'Alice', isBot: false, color: PLAYER_COLORS[i] })),
  };
  const sim = new Simulation(setup, createMap(setup.mapId));
  const rec = new ReplayRecorder(setup, sim.map.name);
  const keys: Keyframe[] = [];
  for (let t = 1; t <= ticks; t++) {
    const cmds = t % 97 === 3 ? [{ type: CommandType.Move, player: t % 2, ids: [t % 2 ? 2 : 1], x: (20 + (t % 17)) << 16, y: (30 + (t % 11)) << 16 }] : [];
    rec.record(t, cmds);
    sim.step(cmds);
    if (t % HASH_INTERVAL === 0) rec.hash(t, sim.hash());
    if (t % KEYFRAME_EVERY === 0) keys.push(takeKeyframe(sim));
  }
  return { data: rec.finish(-1, sim.tick, Date.now()), keys, sim };
}

describe('keyframe set', () => {
  it('keeps them in tick order and finds the latest at or before a tick', () => {
    const set = new KeyframeSet(1000);
    for (const t of [400, 0, 200, 600, 200]) set.add(fake(t));
    expect(set.keys.map((k) => k.tick)).toEqual([0, 200, 400, 600]);
    expect(set.at(399)?.tick).toBe(200);
    expect(set.at(600)?.tick).toBe(600);
    expect(set.at(-1)).toBeNull();
    // only the ones on a hashed tick, when asked for those
    set.add(fake(630));
    expect(set.at(640)?.tick).toBe(630);
    expect(set.at(640, true)?.tick).toBe(600);
  });

  it('over the budget thins out the closest, never the first, the newest or a pinned one', () => {
    const set = new KeyframeSet(50);
    for (let t = 0; t <= 1000; t += 100) set.add(fake(t));
    expect(set.bytes).toBeLessThanOrEqual(50);
    expect(set.keys[0].tick).toBe(0);
    expect(set.keys[set.keys.length - 1].tick).toBe(1000);
    // spread over the whole match: no gap more than twice what an even spacing would leave
    const gaps = set.keys.slice(1).map((k, i) => k.tick - set.keys[i].tick);
    expect(Math.max(...gaps)).toBeLessThanOrEqual((2 * 1000) / (set.keys.length - 1));
    // a keyframe fetched for a jump squeezed in between two others: the first to go, were it not pinned
    set.add(fake(450), true);
    expect(set.keys.some((k) => k.tick === 450)).toBe(true);
    expect(set.bytes).toBeLessThanOrEqual(50);
  });

  it('hands every keyframe over and is left empty', () => {
    const set = new KeyframeSet(1000);
    for (const t of [0, 200, 400]) set.add(fake(t));
    expect(set.take().map((k) => k.tick)).toEqual([0, 200, 400]);
    expect(set.keys).toEqual([]);
    expect(set.bytes).toBe(0);
  });
});

describe('keyframes on the way to the server and back', () => {
  it('come back exactly as they went, and the recording vouches for them', () => {
    const { data, keys, sim } = recorded(1200);
    expect(keys.length).toBe(6);
    for (const k of keys) {
      const bytes = encodeKeyframe(k);
      expect(keyframeTickOf(bytes)).toBe(k.tick);
      const back = decodeKeyframe(bytes)!;
      expect(back.tick).toBe(k.tick);
      expect(diff(back.snap, k.snap)).toBe('');
      expect(back.bytes).toBe(k.bytes);
      expect(keyframeMatches(data, back)).toBe(true);
    }
    // put back into a fresh simulation, the last one is the state the match ended in
    const fresh = new Simulation(data.setup, createMap(data.setup.mapId));
    fresh.restore(unpackSnapshot(decodeKeyframe(encodeKeyframe(keys[keys.length - 1]))!.snap));
    expect(fresh.hash()).toBe(sim.hash());
    expect(recordedHash(data, 1200)).toBe(sim.hash());
  });

  it('carry what JSON cannot: undefined, NaN, the infinities and -0', () => {
    const snap = { tick: 50, a: undefined, list: [undefined, NaN, Infinity, -Infinity, -0, 0, 'é'], nested: { b: new Int16Array([-3, 7]) } };
    const back = decodeKeyframe(encodeKeyframe({ tick: 50, snap: snap as unknown as SimSnapshot, bytes: 4 }))!;
    expect(diff(back.snap, snap)).toBe('');
    expect('a' in back.snap).toBe(true);
  });

  it('are refused when made up, cut short, from another tick or another version', () => {
    const { data, keys } = recorded(600);
    const k = keys[1];
    const bytes = encodeKeyframe(k);
    expect(decodeKeyframe(bytes.subarray(0, bytes.length - 16))).toBeNull();
    expect(decodeKeyframe(bytes.subarray(0, 40))).toBeNull();
    const otherVersion = bytes.slice();
    new DataView(otherVersion.buffer).setUint32(4, 999, true);
    expect(keyframeTickOf(otherVersion)).toBeUndefined();
    expect(decodeKeyframe(otherVersion)).toBeNull();
    // the state is not the match's: a hundred gold more is enough
    const rich = decodeKeyframe(bytes)!;
    rich.snap.players[0].gold += 100;
    expect(keyframeMatches(data, rich)).toBe(false);
    // right state, wrong tick, and a tick with no hash
    expect(keyframeMatches(data, { ...k, tick: k.tick + HASH_INTERVAL })).toBe(false);
    expect(keyframeMatches(data, keys[0])).toBe(true);
    expect(keyframeMatches({ ...data, hashes: data.hashes.filter(([t]) => t !== k.tick) }, k)).toBe(false);
  });
});
