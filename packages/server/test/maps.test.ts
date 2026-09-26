import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientMessage, MAPS_PER_PLAYER, ServerMessage, encodeCommandsFrame } from '@rookfall/protocol';
import {
  CUSTOM_MAP_MAX_CHARS, CommandType, CustomMapSource, MatchSetup, PLAYER_COLORS, ReplayData, ReplayRecorder, SIM_VERSION, Simulation,
  blankCustomMap, decodeCustomSource, encodeCustomMap, mapForSetup, mapHasErrors, validateCustomMap,
} from '@rookfall/sim';
import { Lobby } from '../src/lobby';
import { MapRecord, MapStore } from '../src/maps';
import { sanitizeReplay } from '../src/replays';

/** 64x48 grass in a rock border, a castle and a deposit on each side; a third zone at the bottom if asked */
function mapSource(name = 'Test Map', zones = 2): CustomMapSource {
  const src = blankCustomMap(name, 64, 48);
  src.starts = [{ x: 10, y: 24, zone: 0 }, { x: 53, y: 24, zone: 1 }];
  src.mines = [{ x: 5, y: 24, gold: 6000 }, { x: 58, y: 24, gold: 6000 }];
  if (zones > 2) { src.starts.push({ x: 32, y: 38, zone: 2 }); src.mines.push({ x: 32, y: 43, gold: 6000 }); }
  return src;
}
const payload = (name?: string, zones?: number) => encodeCustomMap(mapSource(name, zones));
/** decodes fine, but has one spawn zone: a draft that cannot be played */
function draftPayload(name = 'Draft'): string {
  const src = mapSource(name);
  src.starts = src.starts.slice(0, 1);
  return encodeCustomMap(src);
}

function saved(out: ReturnType<MapStore['save']>): MapRecord {
  if ('error' in out) throw new Error(`save refused: ${out.error}`);
  return out.map;
}

describe('map store', () => {
  it('the test maps are what they claim to be', () => {
    expect(mapHasErrors(validateCustomMap(mapSource()))).toBe(false);
    expect(mapHasErrors(validateCustomMap(mapSource('Three', 3)))).toBe(false);
    expect(mapHasErrors(validateCustomMap(decodeCustomSource(draftPayload())!))).toBe(true);
  });

  it('saves a map, then new revisions of it - only for its owner', () => {
    const s = new MapStore(null);
    const a = saved(s.save('key-alice', 'Alice', undefined, payload('Valley')));
    expect(a.id).toMatch(/^[a-z0-9]{10}$/);
    expect(a).toMatchObject({ owner: 'key-alice', author: 'Alice', name: 'Valley', w: 64, h: 48, players: 2, valid: true, public: false, rev: 1, likes: [] });
    expect(s.payload(a.id)).toBe(payload('Valley'));
    expect(decodeCustomSource(a.thumb)).not.toBeNull();
    expect(a.bytes).toBe(payload('Valley').length);

    const u = saved(s.save('key-alice', 'Alice B', a.id, payload('Valley II', 3)));
    expect(u).toBe(a);
    expect(u).toMatchObject({ name: 'Valley II', author: 'Alice B', players: 3, rev: 2 });
    expect(u.updatedAt).toBeGreaterThanOrEqual(u.createdAt);
    expect(s.payload(a.id)).toBe(payload('Valley II', 3));

    expect(s.save('key-bob', 'Bob', a.id, payload())).toEqual({ error: 'notOwner' });
    expect(s.save('key-alice', 'Alice', 'nosuchmap0', payload())).toEqual({ error: 'notFound' });
    expect(s.remove('key-bob', a.id)).toBe('notOwner');
    expect(s.setPublic('key-bob', a.id, true)).toEqual({ error: 'notOwner' });
    expect(s.remove('key-alice', a.id)).toBeNull();
    expect(s.get(a.id)).toBeUndefined();
    expect(s.payload(a.id)).toBeNull();
    expect(s.remove('key-alice', a.id)).toBe('notFound');
  });

  it('refuses what is not a map, and a map too small to play', () => {
    const s = new MapStore(null);
    expect(s.save('k', 'A', undefined, 42)).toEqual({ error: 'invalid' });
    expect(s.save('k', 'A', undefined, 'not json')).toEqual({ error: 'invalid' });
    expect(s.save('k', 'A', undefined, JSON.stringify({ v: 1, w: 64, h: 48, t: 'AAAA', m: [], s: [] }))).toEqual({ error: 'invalid' });
    expect(s.save('k', 'A', undefined, 'x'.repeat(CUSTOM_MAP_MAX_CHARS + 1))).toEqual({ error: 'tooBig' });
    expect(s.save('k', 'A', undefined, encodeCustomMap(blankCustomMap('Tiny', 16, 16)))).toEqual({ error: 'invalid' });
    expect(s.size).toBe(0);
    // a draft with errors is kept, just not playable
    expect(saved(s.save('k', 'A', undefined, draftPayload())).valid).toBe(false);
  });

  it('stores the payload as the sim reads it, without anything extra the browser added', () => {
    const s = new MapStore(null);
    const raw = JSON.parse(payload('Clean')) as Record<string, unknown>;
    const m = saved(s.save('k', 'A', undefined, JSON.stringify({ ...raw, evil: 'x'.repeat(1000), name: '  <b>Clean</b>  ' })));
    expect(s.payload(m.id)).toBe(payload('bClean/b'));
    expect(m.name).toBe('bClean/b');
  });

  it('caps the maps per player', () => {
    const s = new MapStore(null);
    const ids: string[] = [];
    for (let i = 0; i < MAPS_PER_PLAYER; i++) ids.push(saved(s.save('k', 'A', undefined, payload(`Map ${i}`))).id);
    expect(s.save('k', 'A', undefined, payload())).toEqual({ error: 'tooMany' });
    // updating one of them is still fine, and so is another player's first
    expect(saved(s.save('k', 'A', ids[0], payload('Renamed'))).rev).toBe(2);
    expect(saved(s.save('other', 'B', undefined, payload())).rev).toBe(1);
    s.remove('k', ids[1]);
    expect(saved(s.save('k', 'A', undefined, payload())).rev).toBe(1);
    expect(s.mine('k')).toHaveLength(MAPS_PER_PLAYER);
  });

  it('publishes only a valid map, and an update that breaks a published map hides it', () => {
    const s = new MapStore(null);
    const d = saved(s.save('k', 'A', undefined, draftPayload()));
    expect(s.setPublic('k', d.id, true)).toEqual({ error: 'notValid' });
    saved(s.save('k', 'A', d.id, payload('Fixed')));
    expect(saved(s.setPublic('k', d.id, true)).public).toBe(true);
    expect(s.community('top', '', 0).total).toBe(1);
    const broken = saved(s.save('k', 'A', d.id, draftPayload('Broken')));
    expect(broken).toMatchObject({ valid: false, public: false, rev: 3 });
    expect(s.community('top', '', 0).total).toBe(0);
    // hiding a valid map is always allowed
    saved(s.save('k', 'A', d.id, payload()));
    saved(s.setPublic('k', d.id, true));
    expect(saved(s.setPublic('k', d.id, false)).public).toBe(false);
  });

  it('counts likes once per player, never your own or on a private map, and ranks and searches the list', () => {
    const s = new MapStore(null);
    const forest = saved(s.save('key-alice', 'Alice', undefined, payload('Forest Duel')));
    const desert = saved(s.save('key-bob', 'Bob', undefined, payload('Desert Duel')));
    const secret = saved(s.save('key-carol', 'Carol', undefined, payload('Secret Forest')));
    saved(s.setPublic('key-alice', forest.id, true));
    saved(s.setPublic('key-bob', desert.id, true));

    saved(s.like('key-carol', forest.id, true));
    saved(s.like('key-carol', forest.id, true));
    saved(s.like('key-dave', forest.id, true));
    expect(forest.likes).toEqual(['key-carol', 'key-dave']);
    expect(s.like('key-alice', forest.id, true)).toEqual({ error: 'ownMap' });
    expect(s.like('key-alice', secret.id, true)).toEqual({ error: 'notFound' });
    expect(s.like('key-alice', 'nosuchmap0', true)).toEqual({ error: 'notFound' });
    saved(s.like('key-dave', forest.id, false));
    saved(s.like('key-dave', forest.id, false));
    expect(forest.likes).toEqual(['key-carol']);

    const ids = (p: { maps: MapRecord[] }) => p.maps.map((m) => m.id);
    expect(ids(s.community('top', '', 0))).toEqual([forest.id, desert.id]);
    expect(ids(s.community('new', '', 0))).toEqual([desert.id, forest.id]);
    expect(ids(s.community('top', ' desert ', 0))).toEqual([desert.id]);
    expect(ids(s.community('top', 'ALICE', 0))).toEqual([forest.id]);
    expect(s.community('top', 'forest', 0).total).toBe(1); // the private one is not listed
    expect(s.community('top', '', 99)).toMatchObject({ maps: [], total: 2, offset: 2 });
    expect(s.community('top', '', -5).offset).toBe(0);
    expect(ids(s.community('top', '', 1, 1))).toEqual([desert.id]);

    const seen = s.meta(forest, 'key-carol');
    expect(seen).toMatchObject({ likes: 1, liked: true, public: true, valid: true });
    expect(seen).not.toHaveProperty('mine');
    expect(s.meta(forest, 'key-alice')).toMatchObject({ mine: true, likes: 1 });
    expect(s.meta(forest, null)).not.toHaveProperty('liked');
    expect(JSON.stringify(seen)).not.toContain('key-');
  });

  it('moves a guest\'s maps and likes to their account, dropping likes on what is now their own', () => {
    const s = new MapStore(null);
    const guestMap = saved(s.save('k-guest', 'Guest', undefined, payload('Guest Map')));
    const acctMap = saved(s.save('k-acct', 'Acct', undefined, payload('Acct Map')));
    const bobMap = saved(s.save('k-bob', 'Bob', undefined, payload('Bob Map')));
    for (const [k, m] of [['k-guest', guestMap], ['k-acct', acctMap], ['k-bob', bobMap]] as const) saved(s.setPublic(k, m.id, true));
    saved(s.like('k-guest', acctMap.id, true));
    saved(s.like('k-acct', guestMap.id, true));
    saved(s.like('k-guest', bobMap.id, true));
    saved(s.like('k-acct', bobMap.id, true));
    saved(s.like('k-other', guestMap.id, true));

    s.rekey('k-guest', 'k-acct');
    expect(s.mine('k-guest')).toEqual([]);
    expect(s.mine('k-acct').map((m) => m.id).sort()).toEqual([guestMap.id, acctMap.id].sort());
    expect(guestMap.likes).toEqual(['k-other']);
    expect(acctMap.likes).toEqual([]);
    expect(bobMap.likes).toEqual(['k-acct']);
    expect(s.save('k-guest', 'Guest', guestMap.id, payload())).toEqual({ error: 'notOwner' });
    expect(saved(s.save('k-acct', 'Acct', guestMap.id, payload())).rev).toBe(2);

    s.renameAuthor('k-acct', 'Renamed');
    expect(s.mine('k-acct').every((m) => m.author === 'Renamed')).toBe(true);
    expect(bobMap.author).toBe('Bob');
  });

  describe('on disk', () => {
    const dirs: string[] = [];
    const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rookfall-maps-')); dirs.push(d); return d; };
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    it('keeps the index and one file per payload, and survives a restart', () => {
      const dir = tmp();
      const s = new MapStore(dir);
      const a = saved(s.save('key-alice', 'Alice', undefined, payload('Kept')));
      const b = saved(s.save('key-alice', 'Alice', undefined, payload('Deleted')));
      saved(s.setPublic('key-alice', a.id, true));
      saved(s.like('key-bob', a.id, true));
      // the payload is on disk the moment the save is answered; the index follows on flush
      expect(readFileSync(join(dir, `${a.id}.map`), 'utf8')).toBe(payload('Kept'));
      s.flush();
      expect(statSync(join(dir, 'index.json')).mode & 0o777).toBe(0o600);

      const again = new MapStore(dir);
      expect(again.size).toBe(2);
      expect(again.get(a.id)).toMatchObject({ owner: 'key-alice', public: true, likes: ['key-bob'], rev: 1, name: 'Kept' });
      expect(again.payload(a.id)).toBe(payload('Kept'));
      expect(again.remove('key-alice', b.id)).toBeNull();
      expect(existsSync(join(dir, `${b.id}.map`))).toBe(false);
      saved(again.save('key-alice', 'Alice', a.id, payload('Kept v2')));
      again.flush();

      const third = new MapStore(dir);
      expect(third.size).toBe(1);
      expect(third.get(b.id)).toBeUndefined();
      expect(third.get(a.id)?.rev).toBe(2);
      expect(third.payload(a.id)).toBe(payload('Kept v2'));
    });

    it('reads payloads back past its cache, and drops a record whose payload file is gone', () => {
      const dir = tmp();
      const s = new MapStore(dir);
      const ids = Array.from({ length: 20 }, (_, i) => saved(s.save('k', 'A', undefined, payload(`Map ${i}`))).id);
      s.flush();
      const again = new MapStore(dir);
      ids.forEach((id, i) => expect(again.payload(id)).toBe(payload(`Map ${i}`)));
      ids.forEach((id, i) => expect(again.payload(id)).toBe(payload(`Map ${i}`)));
      unlinkSync(join(dir, `${ids[3]}.map`));
      const third = new MapStore(dir);
      expect(third.size).toBe(19);
      expect(third.get(ids[3])).toBeUndefined();
      third.flush();
    });
  });
});

// ------------------------------------------------------------------ over the lobby socket

class TestClient {
  ws!: WebSocket;
  msgs: ServerMessage[] = [];
  constructor(readonly url: string) {}
  connect(hello: Omit<Extract<ClientMessage, { t: 'hello' }>, 't'>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => { this.send({ t: 'hello', ...hello }); resolve(); });
      this.ws.on('error', reject);
      this.ws.on('message', (data, isBinary) => { if (!isBinary) this.msgs.push(JSON.parse(data.toString())); });
    });
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  /** the first message of the type (that passes `pred`), taken off the queue */
  async wait<T extends ServerMessage['t']>(type: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeout = 5000): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = this.msgs.findIndex((m) => m.t === type && pred(m as Extract<ServerMessage, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  close() { this.ws.close(); }
}

describe('maps over the lobby socket', () => {
  let http: Server;
  let url: string;
  let lobby: Lobby;
  const replays: ReplayData[] = [];
  const clients: TestClient[] = [];

  beforeAll(async () => {
    lobby = new Lobby({ saveReplay: (r) => { replays.push(r); return 'r1'; } });
    http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1024 * 1024 });
    wss.on('connection', (ws, req) => lobby.handleConnection(ws, req));
    await new Promise<void>((r) => http.listen(0, r));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
  });
  afterAll(() => { for (const c of clients) c.close(); http.close(); });

  async function join(name: string, playerKey?: string): Promise<TestClient> {
    const c = new TestClient(url);
    clients.push(c);
    await c.connect({ name, playerKey });
    await c.wait('welcome');
    return c;
  }

  it('saves, lists, shares by publishing, and likes', async () => {
    const a = await join('Alice', 'maps-alice-key'), b = await join('Bob', 'maps-bob-key');
    a.send({ t: 'mapSave', req: 1, data: payload('Alice Map') });
    const { req, map } = await a.wait('mapSaved');
    expect(req).toBe(1);
    expect(map).toMatchObject({ name: 'Alice Map', author: 'Alice', mine: true, public: false, valid: true, rev: 1, likes: 0 });
    expect(JSON.stringify(map)).not.toContain('maps-alice-key');
    const id = map.id;

    a.send({ t: 'myMaps' });
    expect((await a.wait('myMaps')).maps.map((m) => m.id)).toEqual([id]);
    b.send({ t: 'myMaps' });
    expect((await b.wait('myMaps')).maps).toEqual([]);

    // private: the owner can open it, nobody else can, or even tell it exists
    a.send({ t: 'mapGet', id });
    expect(await a.wait('mapData')).toEqual({ t: 'mapData', id, rev: 1, data: payload('Alice Map') });
    b.send({ t: 'mapGet', id });
    expect(await b.wait('mapError')).toMatchObject({ code: 'notFound', id });
    b.send({ t: 'mapPublish', id, public: true });
    expect(await b.wait('mapError')).toMatchObject({ code: 'notOwner', id });
    b.send({ t: 'mapSave', req: 7, id, data: payload('Stolen') });
    expect(await b.wait('mapError')).toMatchObject({ code: 'notOwner', id, req: 7 });

    a.send({ t: 'mapPublish', id, public: true });
    expect((await a.wait('mapUpdated')).map).toMatchObject({ id, public: true, mine: true });
    b.send({ t: 'mapGet', id });
    expect((await b.wait('mapData')).data).toBe(payload('Alice Map'));
    b.send({ t: 'communityMaps', sort: 'top', q: '  alice ', offset: 0 });
    const page = await b.wait('communityMaps');
    expect(page).toMatchObject({ total: 1, offset: 0, sort: 'top', q: 'alice' });
    expect(page.maps[0]).toMatchObject({ id, likes: 0 });
    expect(page.maps[0]).not.toHaveProperty('mine');

    b.send({ t: 'mapLike', id, like: true });
    expect((await b.wait('mapUpdated')).map).toMatchObject({ id, likes: 1, liked: true });
    a.send({ t: 'mapLike', id, like: true });
    expect(await a.wait('mapError')).toMatchObject({ code: 'ownMap', id });
    b.send({ t: 'communityMaps', sort: 'bogus' as never });
    expect(await b.wait('communityMaps')).toMatchObject({ sort: 'top', q: '', offset: 0, total: 1 });

    // a new revision; then gone
    a.send({ t: 'mapSave', req: 2, id, data: payload('Alice Map II') });
    expect((await a.wait('mapSaved')).map).toMatchObject({ id, rev: 2, name: 'Alice Map II', likes: 1, public: true });
    b.send({ t: 'mapDelete', id });
    expect(await b.wait('mapError')).toMatchObject({ code: 'notOwner', id });
    a.send({ t: 'mapDelete', id });
    expect(await a.wait('mapDeleted')).toEqual({ t: 'mapDeleted', id });
    b.send({ t: 'mapGet', id });
    expect(await b.wait('mapError')).toMatchObject({ code: 'notFound' });

    a.send({ t: 'mapSave', req: 3, data: 'garbage' });
    expect(await a.wait('mapError')).toMatchObject({ code: 'invalid', req: 3 });
  });

  it('asks a connection without a player key for one', async () => {
    const anon = await join('Anon');
    anon.send({ t: 'mapSave', req: 9, data: payload() });
    expect(await anon.wait('mapError')).toMatchObject({ code: 'noProfile', req: 9 });
    anon.send({ t: 'myMaps' });
    expect(await anon.wait('mapError')).toMatchObject({ code: 'noProfile' });
  });

  it('plays a private map in its author\'s room: the room shows it, its guests may open it, the match carries it', async () => {
    const host = await join('Host', 'maps-host-key'), guest = await join('Guest', 'maps-guest-key'), outsider = await join('Outsider', 'maps-out-key');
    host.send({ t: 'mapSave', req: 1, data: payload('Three Kingdoms', 3) });
    const id = (await host.wait('mapSaved')).map.id;
    const mapId = `c:${id}`;

    host.send({ t: 'create', name: 'Custom', mapId });
    let room = (await host.wait('room')).room;
    expect(room.mapId).toBe(mapId);
    expect(room.map).toMatchObject({ id, name: 'Three Kingdoms', author: 'Host', w: 64, h: 48, players: 3 });
    expect(room.slots.slice(0, 4).map((s) => s.kind)).toEqual(['human', 'open', 'open', 'closed']);
    expect(lobby.publicRooms().find((r) => r.code === room.code)).toMatchObject({ max: 3, mapName: 'Three Kingdoms', mapId });

    // somebody else's private map is not theirs to pick: the room is made on the default map instead
    outsider.send({ t: 'create', name: 'Nope', mapId });
    expect(await outsider.wait('error')).toMatchObject({ code: 'mapUnavailable' });
    const outRoom = (await outsider.wait('room')).room;
    expect(outRoom.mapId).toBe('duel-valley');
    expect(outRoom.map).toBeUndefined();
    outsider.send({ t: 'map', mapId });
    expect(await outsider.wait('error')).toMatchObject({ code: 'mapUnavailable' });
    outsider.send({ t: 'mapGet', id });
    expect(await outsider.wait('mapError')).toMatchObject({ code: 'notFound', id });

    guest.send({ t: 'join', code: room.code });
    await guest.wait('room');
    guest.send({ t: 'mapGet', id });
    expect(await guest.wait('mapData')).toEqual({ t: 'mapData', id, rev: 1, data: payload('Three Kingdoms', 3) });

    // back to an official map and over again
    host.msgs.length = 0;
    host.send({ t: 'map', mapId: 'duel-valley' });
    room = (await host.wait('room', (m) => m.room.mapId === 'duel-valley')).room;
    expect(room.map).toBeUndefined();
    expect(lobby.publicRooms().find((r) => r.code === room.code)).toMatchObject({ max: 2, mapName: 'Duel Valley' });
    host.msgs.length = 0;
    host.send({ t: 'map', mapId });
    room = (await host.wait('room', (m) => m.room.mapId === mapId)).room;
    expect(room.map?.players).toBe(3);

    host.send({ t: 'start' });
    const start = await host.wait('start');
    expect(start.setup.mapId).toBe(mapId);
    expect(start.setup.map).toBe(payload('Three Kingdoms', 3));
    expect((await guest.wait('start')).setup.map).toBe(start.setup.map);
    host.ws.send(encodeCommandsFrame(0, [{ type: CommandType.Surrender, player: start.mySlot }]));
    await host.wait('gameOver');
    expect(replays.at(-1)?.setup.map).toBe(payload('Three Kingdoms', 3));
    expect(replays.at(-1)?.mapName).toBe('Three Kingdoms');
  }, 15000);

  it('a guest who signs up keeps their maps', async () => {
    const g = await join('Gina', 'maps-gina-key');
    expect((await g.wait('account')).account).toBeNull();
    g.send({ t: 'mapSave', req: 1, data: payload('Gina Map') });
    const id = (await g.wait('mapSaved')).map.id;
    g.send({ t: 'register', email: 'gina-maps@example.com', password: 'hunter2hunter2', name: 'Gina Maps' });
    expect((await g.wait('account')).account?.name).toBe('Gina Maps');
    g.send({ t: 'myMaps' });
    expect((await g.wait('myMaps')).maps).toMatchObject([{ id, mine: true, author: 'Gina Maps' }]);

    // the browser's guest key no longer owns them
    const old = await join('Gina', 'maps-gina-key');
    old.send({ t: 'myMaps' });
    expect((await old.wait('myMaps')).maps).toEqual([]);
    old.send({ t: 'mapPublish', id, public: true });
    expect(await old.wait('mapError')).toMatchObject({ code: 'notOwner' });

    g.send({ t: 'setName', name: 'Gina Again' });
    await g.wait('account', (m) => m.account?.name === 'Gina Again');
    g.send({ t: 'myMaps' });
    expect((await g.wait('myMaps')).maps[0].author).toBe('Gina Again');
  });
});

// ------------------------------------------------------------------ replays of custom-map matches

describe('replay upload with a custom map', () => {
  function customReplay(): ReplayData {
    const setup: MatchSetup = {
      seed: 5, mapId: 'c:abcdefghij', map: payload('Replay Map'), version: SIM_VERSION,
      players: ['Alice', 'Bot'].map((name, i) => ({ slot: i, team: i, name, isBot: i > 0, color: PLAYER_COLORS[i] })),
    };
    const sim = new Simulation(setup, mapForSetup(setup));
    const rec = new ReplayRecorder(setup, sim.map.name);
    for (let t = 1; t <= 60; t++) {
      rec.record(t, []);
      sim.step([]);
      if (t % 50 === 0) rec.hash(t, sim.hash());
    }
    return rec.finish(-1, sim.tick, Date.now());
  }

  it('keeps the map the replay was played on', () => {
    const r = customReplay();
    const out = sanitizeReplay(JSON.parse(JSON.stringify(r)))!;
    expect(out.setup.map).toBe(payload('Replay Map'));
    expect(out.setup.mapId).toBe('c:abcdefghij');
    expect(mapForSetup(out.setup).name).toBe('Replay Map');
  });

  it('refuses a replay whose map is broken or missing', () => {
    const r = customReplay();
    expect(sanitizeReplay(JSON.parse(JSON.stringify({ ...r, setup: { ...r.setup, map: 'garbage' } })))).toBeNull();
    expect(sanitizeReplay(JSON.parse(JSON.stringify({ ...r, setup: { ...r.setup, map: 42 } })))).toBeNull();
    expect(sanitizeReplay(JSON.parse(JSON.stringify({ ...r, setup: { ...r.setup, map: undefined } })))).toBeNull();
  });
});
