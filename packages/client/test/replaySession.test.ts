/**
 * Jumps in a replay. In Node there are no workers, so ReplaySession plays every jump here, on its own simulation -
 * which lets a test count the ticks a jump had to play: with the keyframes a match left, never more than the ten
 * seconds from one to the next.
 */
import { describe, expect, it } from 'vitest';
import { createBots } from '@rookfall/ai';
import {
  HASH_INTERVAL, KEYFRAME_EVERY, Keyframe, MatchSetup, PLAYER_COLORS, ReplayRecorder, Simulation, TICK_MS, createMap, recordedHash, takeKeyframe,
} from '@rookfall/sim';
import { LocalSession, RemoteKeys, ReplaySession } from '../src/game/session';

function setup(bots: number): MatchSetup {
  return {
    seed: 5, mapId: 'crossroads', version: 1,
    players: Array.from({ length: bots }, (_, i) => ({ slot: i, team: i, name: `Bot ${i}`, isBot: true, difficulty: 2 as const, color: PLAYER_COLORS[i] })),
  };
}

/** a bot match recorded the way a skirmish tab records it, with the keyframes it leaves as it is played */
function played(ticks: number) {
  const s = setup(4);
  const sim = new Simulation(s, createMap(s.mapId, s.seed));
  const bots = createBots(sim);
  const rec = new ReplayRecorder(s, sim.map.name);
  const keys: Keyframe[] = [];
  for (let t = 1; t <= ticks && !sim.gameOver; t++) {
    const cmds = bots.flatMap((b) => b.think(sim));
    rec.record(t, cmds);
    sim.step(cmds);
    if (t % HASH_INTERVAL === 0) rec.hash(t, sim.hash());
    if (t % KEYFRAME_EVERY === 0) keys.push(takeKeyframe(sim));
  }
  return { data: rec.finish(sim.winnerTeam, sim.tick, Date.now()), keys };
}

/** jump, and count the ticks it took */
async function jump(session: ReplaySession, tick: number): Promise<number> {
  const step = session.sim.step.bind(session.sim);
  let n = 0;
  session.sim.step = (cmds) => { n++; step(cmds); };
  try { await session.seekTo(tick); } finally { session.sim.step = step; }
  return n;
}

describe('replay jumps', () => {
  const { data, keys } = played(20 * 60 * 4);

  it('with the keyframes the match left go anywhere at once, back and forth', async () => {
    const s = new ReplaySession(data, { keys });
    // nothing to run through in the background: the keyframes reach the end
    expect(s.frontier).toBe(data.tickCount);
    for (const target of [4000, 1250, data.tickCount - 1, 150, 3000, 3001]) {
      expect(await jump(s, target)).toBeLessThan(KEYFRAME_EVERY);
      expect(s.sim.tick).toBe(target);
      if (target % HASH_INTERVAL === 0) expect(s.sim.hash()).toBe(recordedHash(data, target));
    }
    s.dispose();
  });

  it('without them a jump far ahead plays the match up to it', async () => {
    const s = new ReplaySession(data);
    expect(await jump(s, 4000)).toBe(4000);
    expect(s.sim.hash()).toBe(recordedHash(data, 4000));
    s.dispose();
  });

  it('take the server\'s keyframe of a shared moment - once the recording vouches for it', async () => {
    const k = keys.find((x) => x.tick === 3800)!;
    const server = (key: Keyframe) => {
      const asked: number[] = [];
      const remote: RemoteKeys = { list: async () => [200, 3800, 4600], fetch: async (t) => { asked.push(t); return t === key.tick ? key : null; } };
      return { remote, asked };
    };
    const good = server(k);
    const s = new ReplaySession(data, { remote: good.remote });
    expect(await jump(s, 3900)).toBe(100);
    expect(good.asked).toEqual([3800]);
    expect(s.sim.hash()).toBe(recordedHash(data, 3900));
    // near enough to the one it has now: the server is not asked again
    expect(await jump(s, 3850)).toBe(50);
    expect(good.asked).toEqual([3800]);
    s.dispose();

    // the same moment with a little more gold: refused, and the jump plays its way there
    const rich = { ...k, snap: { ...k.snap, players: k.snap.players.map((p, i) => (i ? p : { ...p, gold: p.gold + 50 })) } };
    const bad = server(rich);
    const s2 = new ReplaySession(data, { remote: bad.remote });
    expect(await jump(s2, 3900)).toBe(3900);
    expect(bad.asked).toEqual([3800]);
    expect(s2.sim.hash()).toBe(recordedHash(data, 3900));
    s2.dispose();
  });

  it('hand a link the keyframe its moment starts from', async () => {
    const s = new ReplaySession(data, { keys });
    expect((await s.keyframeAt(3950))?.tick).toBe(3800);
    expect((await s.keyframeAt(10))?.tick).toBe(0);
    s.dispose();
  });
});

describe('a skirmish played in this tab', () => {
  it('leaves keyframes its replay opens with, and one for a link to any moment', async () => {
    const session = new LocalSession(setup(3), 0);
    while (session.sim.tick < 1000) session.update(TICK_MS * 8);
    expect((await session.keyframeAt(950))?.tick).toBe(800);
    const keys = await session.takeKeyframes();
    expect(keys.map((k) => k.tick)).toEqual([200, 400, 600, 800, 1000]);
    // handed over: the session keeps none
    expect(await session.takeKeyframes()).toEqual([]);
    const data = session.replay();
    const r = new ReplaySession(data, { keys });
    expect(await jump(r, 990)).toBe(190);
    expect(await jump(r, 1000)).toBe(0);
    expect(r.sim.hash()).toBe(recordedHash(data, 1000));
    r.dispose();
    session.dispose();
  });
});
