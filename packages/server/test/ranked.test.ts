import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientMessage, PLACEMENT_GAMES, RANKED_MAP_ID, ServerMessage, encodeCommandsFrame, levelFromXp, tierFor, xpForLevel } from '@rookfall/protocol';
import { CommandType, ReplayData } from '@rookfall/sim';
import { Lobby } from '../src/lobby';
import { RatingStore, glickoUpdate } from '../src/rating';
import { Matchmaker, searchWindow } from '../src/matchmaking';

class TestClient {
  ws!: WebSocket;
  msgs: ServerMessage[] = [];
  constructor(readonly url: string) {}
  connect(name: string, playerKey?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.on('open', () => { this.send({ t: 'hello', name, playerKey }); resolve(); });
      this.ws.on('error', reject);
      this.ws.on('message', (data, isBinary) => { if (!isBinary) this.msgs.push(JSON.parse(data.toString())); });
    });
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMessage['t']>(type: T, timeout = 5000): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = this.msgs.findIndex((m) => m.t === type);
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  close() { this.ws.close(); }
}

describe('glicko-2', () => {
  it('moves the rating the right way and sharpens the deviation', () => {
    const fresh = { rating: 1500, rd: 350, vol: 0.06 };
    const win = glickoUpdate(fresh, fresh, 1);
    const loss = glickoUpdate(fresh, fresh, 0);
    const draw = glickoUpdate(fresh, fresh, 0.5);
    expect(win.rating).toBeGreaterThan(1500);
    expect(loss.rating).toBeLessThan(1500);
    expect(draw.rating).toBeCloseTo(1500, 0);
    // equal and opposite around a symmetric match, and the ladder is surer than before
    expect(win.rating - 1500).toBeCloseTo(1500 - loss.rating, 4);
    expect(win.rd).toBeLessThan(350);

    // beating a favourite pays more than beating an underdog; a settled rating moves in smaller steps
    const settled = { rating: 1500, rd: 60, vol: 0.06 };
    const overUnderdog = glickoUpdate(settled, { rating: 1200, rd: 60, vol: 0.06 }, 1).rating - 1500;
    const overFavourite = glickoUpdate(settled, { rating: 1900, rd: 60, vol: 0.06 }, 1).rating - 1500;
    expect(overFavourite).toBeGreaterThan(overUnderdog);
    expect(overUnderdog).toBeLessThan(win.rating - 1500);
  });

  it('keeps wins and losses balanced over a run of matches', () => {
    const store = new RatingStore(null);
    store.profileFor('key-a', 'A');
    store.profileFor('key-b', 'B');
    for (let i = 0; i < 6; i++) store.applyMatch({ key: 'key-a', name: 'A' }, { key: 'key-b', name: 'B' }, 1, 20 * 60 * 5);
    const a = store.get('key-a')!, b = store.get('key-b')!;
    expect(a.wins).toBe(6);
    expect(b.losses).toBe(6);
    expect(a.streak).toBe(6);
    expect(b.streak).toBe(-6);
    expect(a.rating).toBeGreaterThan(1500);
    expect(b.rating).toBeLessThan(1500);
    expect(a.best).toBe(a.rating); // peak follows a rating on the way up, including during placement
    expect(b.best).toBe(1500);
    expect(a.xp).toBe(6 * (30 + 5));
    expect(levelFromXp(a.xp)).toBe(3); // 210 xp: level 3 starts at 120, level 4 at 240
    expect(xpForLevel(4)).toBe(240);
    expect(a.games).toBeGreaterThanOrEqual(PLACEMENT_GAMES);
    expect(tierFor(a.rating, a.games).key).not.toBe('unranked');
    expect(store.top(10).map((e) => e.name)).toEqual(['A', 'B']);
  });

  it('widens the search window over time and never past the cap', () => {
    expect(searchWindow(0, 50)).toBe(50);
    expect(searchWindow(19, 50)).toBe(50);
    expect(searchWindow(30, 50)).toBe(75);
    expect(searchWindow(600, 50)).toBe(400);
    expect(searchWindow(0, 350)).toBeGreaterThan(searchWindow(0, 50)); // placement pairs widely
  });

  it('never pairs a profile with itself and prefers the closest rating', () => {
    const mm = new Matchmaker<string>();
    const now = Date.now();
    mm.join({ client: 'a1', key: 'k-a', rating: 1500, rd: 50, speed: 1, since: now });
    mm.join({ client: 'a2', key: 'k-a', rating: 1500, rd: 50, speed: 1, since: now });
    expect(mm.pop(now)).toHaveLength(0);
    mm.join({ client: 'b', key: 'k-b', rating: 1490, rd: 50, speed: 1, since: now + 5 });
    mm.join({ client: 'c', key: 'k-c', rating: 1700, rd: 50, speed: 3, since: now + 5 });
    const pairs = mm.pop(now + 10);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((t) => t.client).sort()).toEqual(['a1', 'b']);
    expect(mm.size).toBe(2); // the other tab and the turbo player are still waiting
  });
});

describe('ranked ladder over the wire', () => {
  let http: Server;
  let url: string;
  const replays: ReplayData[] = [];

  beforeAll(async () => {
    const lobby = new Lobby({ saveReplay: (r) => { replays.push(r); return 'r1'; } });
    http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/ws' });
    wss.on('connection', (ws) => lobby.handleConnection(ws));
    await new Promise<void>((r) => http.listen(0, r));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
  });
  afterAll(() => { http.close(); });

  it('queues two players into a 1v1 on a fresh 64x64 map and rates the result', async () => {
    const a = new TestClient(url), b = new TestClient(url);
    await a.connect('Alice', 'ladderkey-alice');
    await b.connect('Bob', 'ladderkey-bob');
    const pa = await a.wait('profile');
    expect(pa.profile.rating).toBe(1500);
    expect(pa.profile.games).toBe(0);
    await b.wait('profile');

    a.send({ t: 'queue', speed: 3 });
    const q = await a.wait('queued');
    expect(q.state.speed).toBe(3);
    expect(q.state.size).toBe(1);
    b.send({ t: 'queue', speed: 3 });

    const sa = await a.wait('start'), sb = await b.wait('start');
    expect(sa.ranked).toBe(true);
    expect(sa.setup.mapId).toBe(RANKED_MAP_ID);
    expect(sa.setup.speed).toBe(3);
    expect(sa.setup.players).toHaveLength(2);
    expect(sa.setup.players.every((p) => !p.isBot)).toBe(true);
    expect(sa.setup.players.map((p) => p.team).sort()).toEqual([0, 1]);
    expect(sa.mySlot).not.toBe(sb.mySlot);

    // Alice surrenders: Bob takes the win, both get their rating change
    a.ws.send(encodeCommandsFrame(0, [{ type: CommandType.Surrender, player: sa.mySlot }]));
    const ra = await a.wait('rankedResult'), rb = await b.wait('rankedResult');
    expect(ra.result.result).toBe('loss');
    expect(rb.result.result).toBe('win');
    expect(ra.result.delta).toBeLessThan(0);
    expect(rb.result.delta).toBeGreaterThan(0);
    expect(ra.result.ratingBefore).toBe(1500);
    expect(ra.result.opponent.name).toBe('Bob');
    expect(ra.result.placement).toBe(true);
    expect(ra.result.profile.games).toBe(1);
    expect(ra.result.profile.losses).toBe(1);
    expect(ra.result.xpGained).toBeGreaterThan(0);
    // the ladder room is gone, so both are free to queue again
    a.send({ t: 'listRooms' });
    expect((await a.wait('rooms')).rooms).toHaveLength(0);
    a.close(); b.close();
  }, 20000);

  it('keeps private rooms out of the room list but joinable by code', async () => {
    const host = new TestClient(url), other = new TestClient(url);
    await host.connect('Host', 'ladderkey-host');
    await other.connect('Other', 'ladderkey-other');
    host.send({ t: 'create', name: 'Secret', private: true });
    const room = (await host.wait('room')).room;
    expect(room.private).toBe(true);

    other.send({ t: 'listRooms' });
    expect((await other.wait('rooms')).rooms.find((r) => r.code === room.code)).toBeUndefined();
    other.send({ t: 'join', code: room.code });
    const joined = (await other.wait('room')).room;
    expect(joined.code).toBe(room.code);
    expect(joined.slots.filter((s) => s.kind === 'human')).toHaveLength(2);

    // the host can open it up again and it shows up in the list
    host.send({ t: 'privacy', private: false });
    for (let i = 0; i < 50; i++) { if (host.msgs.some((m) => m.t === 'room' && !m.room.private)) break; await new Promise((r) => setTimeout(r, 20)); }
    other.send({ t: 'listRooms' });
    expect((await other.wait('rooms')).rooms.some((r) => r.code === room.code)).toBe(true);
    host.close(); other.close();
  }, 15000);
});
