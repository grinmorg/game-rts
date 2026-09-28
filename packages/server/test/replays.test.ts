import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandType, MatchSetup, PLAYER_COLORS, ReplayData, ReplayPlayer, ReplayRecorder, SIM_VERSION, Simulation, SummaryRecorder, createMap,
  decodeKeyframe, encodeKeyframe, takeKeyframe,
} from '@pocket-of-empire/sim';
import { linkPreview } from '../src/preview';
import { MAX_KEYS_PER_REPLAY, ReplayStore, sanitizeReplay } from '../src/replays';

const dirs: string[] = [];
function store(max?: number, maxKeyBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-of-empire-replays-'));
  dirs.push(dir);
  return { dir, store: new ReplayStore(dir, max, maxKeyBytes) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** the keyframe of `tick` of a recording, as a browser sends it: encoded and gzipped */
function keyframe(data: ReplayData, tick: number, gzip = true): Buffer {
  const sim = new Simulation(data.setup, createMap(data.setup.mapId));
  const player = new ReplayPlayer(data);
  while (sim.tick < tick) sim.step(player.commandsFor(sim.tick + 1));
  const bytes = Buffer.from(encodeKeyframe(takeKeyframe(sim)));
  return gzip ? gzipSync(bytes) : bytes;
}

/** a short real match: a few ticks of commands, a hash every 50, a summary */
function replay(seed = 3, names = ['Alice', 'Bot 2 (hard)'], ticks = 120): ReplayData {
  const setup: MatchSetup = {
    seed, mapId: 'duel-valley', version: SIM_VERSION, speed: 2,
    players: names.map((name, i) => ({ slot: i, team: i, name, isBot: i > 0, difficulty: i > 0 ? 2 : undefined, color: PLAYER_COLORS[i] })),
  };
  const sim = new Simulation(setup, createMap(setup.mapId));
  const rec = new ReplayRecorder(setup, sim.map.name);
  const sum = new SummaryRecorder(sim);
  for (let t = 1; t <= ticks; t++) {
    const cmds = t === 5 ? [{ type: CommandType.Stop, player: 0, ids: [1, 2] }] : [];
    rec.record(t, cmds);
    sim.step(cmds);
    sum.observe(sim);
    if (t % 50 === 0) rec.hash(t, sim.hash());
  }
  const data = rec.finish(-1, sim.tick, Date.now());
  data.summary = sum.finish(sim);
  return data;
}

describe('replay store', () => {
  it('an uploaded skirmish is reachable by its id and never listed', () => {
    const { store: s } = store();
    const online = s.save(replay(1));
    const up = s.upload(JSON.stringify(replay(2)));
    expect('id' in up).toBe(true);
    const id = (up as { id: string }).id;
    expect(s.list().map((m) => m.id)).toEqual([online]);
    const back = JSON.parse(s.read(id)!.toString()) as ReplayData;
    expect(back.id).toBe(id);
    expect(back.setup.players[1].name).toBe('Bot 2 (hard)');
    expect(back.summary?.series.workers[0][0]).toBe(4);
    expect(s.meta(id)?.unlisted).toBe(true);
  });

  it('the same match uploaded twice keeps one copy', () => {
    const { store: s, dir } = store();
    const data = replay(4);
    const a = s.upload(JSON.stringify(data)) as { id: string };
    const b = s.upload(JSON.stringify({ ...data, recordedAt: data.recordedAt + 5000 })) as { id: string };
    expect(b.id).toBe(a.id);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('a copy of an online match the server already saved links to the saved one', () => {
    const { store: s } = store();
    const data = replay(5);
    const id = s.save(data);
    expect(s.upload(JSON.stringify(data))).toEqual({ id });
  });

  it('the index is rebuilt from disk on restart', () => {
    const { store: s, dir } = store();
    const id = (s.upload(JSON.stringify(replay(6))) as { id: string }).id;
    const again = new ReplayStore(dir);
    expect(again.meta(id)?.unlisted).toBe(true);
    expect(again.meta(id)?.players).toEqual(['Alice', 'Bot 2 (hard)']);
    expect(again.list()).toEqual([]);
  });

  it('the oldest uploads go once there are too many', () => {
    const { store: s } = store(2);
    const ids = [7, 8, 9].map((seed) => (s.upload(JSON.stringify(replay(seed))) as { id: string }).id);
    expect(s.meta(ids[0])).toBeUndefined();
    expect(s.read(ids[0])).toBeNull();
    expect(s.meta(ids[2])).toBeDefined();
  });

  it('refuses what is not a replay', () => {
    const { store: s } = store();
    expect(s.upload('not json')).toEqual({ error: 'invalid' });
    expect(s.upload(JSON.stringify({ version: 1 }))).toEqual({ error: 'invalid' });
    expect(s.upload('x'.repeat(5 * 1024 * 1024))).toEqual({ error: 'tooBig' });
    const r = replay(10);
    expect(s.upload(JSON.stringify({ ...r, version: SIM_VERSION + 1 }))).toEqual({ error: 'invalid' });
    expect(s.upload(JSON.stringify({ ...r, frames: [{ t: 3, c: [{ type: 'boom', player: 0 }] }] }))).toEqual({ error: 'invalid' });
    expect(s.upload(JSON.stringify({ ...r, setup: { ...r.setup, players: [r.setup.players[0]] } }))).toEqual({ error: 'invalid' });
  });
});

describe('keyframes of shared moments', () => {
  it('are kept gzipped next to their replay and served as they came', () => {
    const { store: s, dir } = store();
    const data = replay(20);
    const id = s.save(data);
    expect(s.keyTicks(id)).toEqual([]);
    expect(s.saveKey(id, 100, keyframe(data, 100), true)).toBe('ok');
    // a browser without CompressionStream sends it plain: it is gzipped here
    expect(s.saveKey(id, 50, keyframe(data, 50, false), false)).toBe('ok');
    expect(s.keyTicks(id)).toEqual([50, 100]);
    for (const t of [50, 100]) expect(decodeKeyframe(gunzipSync(s.readKey(id, t)!))?.tick).toBe(t);
    // the first one for a tick stays; the rebuilt index finds them all on disk
    expect(s.saveKey(id, 100, keyframe(data, 100), true)).toBe('ok');
    expect(new ReplayStore(dir).keyTicks(id)).toEqual([50, 100]);
    expect(s.readKey(id, 150)).toBeNull();
    expect(s.readKey('nope', 100)).toBeNull();
  });

  it('are refused unless they are a keyframe of a hashed tick of a replay this version plays', () => {
    const { store: s } = store();
    const data = replay(21);
    const id = s.save(data);
    const k100 = keyframe(data, 100);
    expect(s.saveKey('nope', 100, k100, true)).toBe('notFound');
    expect(s.saveKey(id, 50, k100, true)).toBe('invalid');
    expect(s.saveKey(id, 60, k100, true)).toBe('invalid');
    expect(s.saveKey(id, 150, k100, true)).toBe('invalid');
    expect(s.saveKey(id, 100, Buffer.from('not a keyframe'), false)).toBe('invalid');
    expect(s.saveKey(id, 100, Buffer.from('not gzip'), true)).toBe('invalid');
    const old = s.save({ ...data, version: SIM_VERSION - 1 });
    expect(s.saveKey(old, 100, k100, true)).toBe('invalid');
    expect(s.keyTicks(id)).toEqual([]);
  });

  it('are held a few per replay', () => {
    const data = replay(22, undefined, 50 * (MAX_KEYS_PER_REPLAY + 1));
    const { store: s } = store();
    const id = s.save(data);
    const ticks = Array.from({ length: MAX_KEYS_PER_REPLAY + 1 }, (_, i) => 50 * (i + 1));
    const sent = ticks.map((t) => s.saveKey(id, t, keyframe(data, t), true));
    expect(sent.slice(0, MAX_KEYS_PER_REPLAY).every((r) => r === 'ok')).toBe(true);
    expect(sent[MAX_KEYS_PER_REPLAY]).toBe('full');
    expect(s.keyTicks(id)).toEqual(ticks.slice(0, MAX_KEYS_PER_REPLAY));
  });

  it('go oldest first past the total, and all of a replay\'s go with it', () => {
    const data = replay(24, undefined, 250);
    const keys = new Map([50, 100, 150, 200, 250].map((t) => [t, keyframe(data, t)]));
    const room = keys.get(150)!.length + keys.get(200)!.length + keys.get(250)!.length;
    const { store: s, dir } = store(1, room);
    const id = (s.upload(JSON.stringify(data)) as { id: string }).id;
    for (const [t, k] of keys) expect(s.saveKey(id, t, k, true)).toBe('ok');
    expect(s.keyTicks(id)).toEqual([150, 200, 250]);
    expect(readdirSync(join(dir, 'keys', id)).sort()).toEqual(['150.rkf.gz', '200.rkf.gz', '250.rkf.gz']);
    // another upload pushes this one out, keyframes and all
    s.upload(JSON.stringify(replay(25)));
    expect(s.meta(id)).toBeUndefined();
    expect(s.keyTicks(id)).toEqual([]);
    expect(existsSync(join(dir, 'keys', id))).toBe(false);
  });
});

describe('upload sanitising', () => {
  it('keeps the fields a replay has and nothing else', () => {
    const r = replay(11) as ReplayData & { evil?: string };
    r.evil = '<script>';
    (r.setup.players[0] as { name: string }).name = 'Eve\u0000\u0007 the Great';
    (r.frames[0].c[0] as unknown as Record<string, unknown>).extra = 1;
    const out = sanitizeReplay(JSON.parse(JSON.stringify(r)))!;
    expect(out).not.toHaveProperty('evil');
    expect(out.setup.players[0].name).toBe('Eve the Great');
    expect(out.frames[0].c[0]).toEqual({ type: CommandType.Stop, player: 0, ids: [1, 2] });
    expect(out.summary).toEqual(r.summary);
  });

  it('drops a summary that does not hold together but keeps the replay', () => {
    const r = replay(12);
    const broken = { ...r, summary: { ...r.summary, series: { army: [[1]] } } };
    const out = sanitizeReplay(JSON.parse(JSON.stringify(broken)))!;
    expect(out.frames).toEqual(r.frames);
    expect(out.summary).toBeUndefined();
  });
});

describe('link preview', () => {
  const html = '<html><head><title>Pocket of Empire</title></head><body></body></html>';
  const req = (lang?: string) => ({ headers: { host: 'pocket-of-empire.example', 'x-forwarded-proto': 'https', 'accept-language': lang }, socket: {} }) as unknown as IncomingMessage;

  it('names the players and the battle the link points at', () => {
    const { store: s } = store();
    const meta = { ...s.meta(s.save(replay(13, ['Ann', '<b>Bob</b>'])))!, battles: [{ start: 20 * 60 * 7 * 2, deaths: 19 }] };
    const page = linkPreview(html, meta, new URL(`https://pocket-of-empire.example/?replay=${meta.id}&m=0`), req('en-US,en'));
    expect(page).toContain('<title>Ann vs &lt;b&gt;Bob&lt;/b&gt; · Pocket of Empire</title>');
    expect(page).toContain('Battle at 7:00: 19 units fell.');
    expect(page).toContain('content="https://pocket-of-empire.example/og.jpg"');
    expect(page).not.toContain('<b>Bob</b>');
    const ru = linkPreview(html, meta, new URL(`https://pocket-of-empire.example/?replay=${meta.id}&t=90`), req('ru-RU,ru;q=0.9'));
    expect(ru).toContain('Момент на 1:30.');
  });
});
