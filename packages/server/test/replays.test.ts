import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandType, MatchSetup, PLAYER_COLORS, ReplayData, ReplayRecorder, SIM_VERSION, Simulation, SummaryRecorder, createMap } from '@rookfall/sim';
import { linkPreview } from '../src/preview';
import { ReplayStore, sanitizeReplay } from '../src/replays';

const dirs: string[] = [];
function store(max?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'rookfall-replays-'));
  dirs.push(dir);
  return { dir, store: new ReplayStore(dir, max) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** a short real match: a few ticks of commands, a hash, a summary */
function replay(seed = 3, names = ['Alice', 'Bot 2 (hard)']): ReplayData {
  const setup: MatchSetup = {
    seed, mapId: 'duel-valley', version: SIM_VERSION, speed: 2,
    players: names.map((name, i) => ({ slot: i, team: i, name, isBot: i > 0, difficulty: i > 0 ? 2 : undefined, color: PLAYER_COLORS[i] })),
  };
  const sim = new Simulation(setup, createMap(setup.mapId));
  const rec = new ReplayRecorder(setup, sim.map.name);
  const sum = new SummaryRecorder(sim);
  for (let t = 1; t <= 120; t++) {
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
  const html = '<html><head><title>Rookfall</title></head><body></body></html>';
  const req = (lang?: string) => ({ headers: { host: 'rookfall.example', 'x-forwarded-proto': 'https', 'accept-language': lang }, socket: {} }) as unknown as IncomingMessage;

  it('names the players and the battle the link points at', () => {
    const { store: s } = store();
    const meta = { ...s.meta(s.save(replay(13, ['Ann', '<b>Bob</b>'])))!, battles: [{ start: 20 * 60 * 7 * 2, deaths: 19 }] };
    const page = linkPreview(html, meta, new URL(`https://rookfall.example/?replay=${meta.id}&m=0`), req('en-US,en'));
    expect(page).toContain('<title>Ann vs &lt;b&gt;Bob&lt;/b&gt; · Rookfall</title>');
    expect(page).toContain('Battle at 7:00: 19 units fell.');
    expect(page).toContain('content="https://rookfall.example/og.jpg"');
    expect(page).not.toContain('<b>Bob</b>');
    const ru = linkPreview(html, meta, new URL(`https://rookfall.example/?replay=${meta.id}&t=90`), req('ru-RU,ru;q=0.9'));
    expect(ru).toContain('Момент на 1:30.');
  });
});
