import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientMessage, ServerMessage, decodeFrame, encodeCommandsFrame, FRAME_TICK, FRAME_BATCH } from '@warlets/protocol';
import { CommandType, Kind, ReplayData, Simulation, createMap, UnitType } from '@warlets/sim';
import { Lobby } from '../src/lobby';

class TestClient {
  ws!: WebSocket;
  msgs: ServerMessage[] = [];
  frames: { tick: number; cmds: unknown[] }[] = [];
  batches = 0;
  constructor(readonly url: string) {}
  connect(name: string, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.on('open', () => { this.send({ t: 'hello', name, token }); resolve(); });
      this.ws.on('error', reject);
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const f = decodeFrame(new Uint8Array(data as ArrayBuffer));
          if (f.kind === FRAME_BATCH) this.batches++;
          if (f.kind === FRAME_TICK || f.kind === FRAME_BATCH) this.frames.push(...f.frames);
        } else this.msgs.push(JSON.parse(data.toString()));
      });
    });
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMessage['t']>(type: T, timeout = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = this.msgs.findIndex((m) => m.t === type);
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.msgs].reverse().find((m) => m.t === type) as Extract<ServerMessage, { t: T }> | undefined;
  }
  close() { this.ws.close(); }
}

describe('lobby & lockstep server', () => {
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

  it('two players create/join a room, start a match and receive identical tick frames', async () => {
    const a = new TestClient(url), b = new TestClient(url);
    await a.connect('Alice'); await b.connect('Bob');
    const wa = await a.wait('welcome'); const wb = await b.wait('welcome');
    expect(wa.token.length).toBeGreaterThan(10);
    a.send({ t: 'create', name: 'Test room' });
    const room = (await a.wait('room')).room;
    expect(room.code).toHaveLength(5);
    b.send({ t: 'join', code: room.code });
    await b.wait('room');
    // wait until both slots are humans
    let state = room;
    for (let i = 0; i < 50 && state.slots.filter((s) => s.kind === 'human').length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      state = a.last('room')?.room ?? state;
    }
    expect(state.slots.filter((s) => s.kind === 'human')).toHaveLength(2);
    a.send({ t: 'start' });
    const sa = await a.wait('start'), sb = await b.wait('start');
    expect(sa.setup.players).toHaveLength(2);
    expect(sa.mySlot).not.toBe(sb.mySlot);
    // Alice orders her workers to move; frames must contain the accepted command for both clients
    const sim = new Simulation(sa.setup, createMap(sa.setup.mapId));
    const w = sim.world;
    const ids: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === sa.mySlot && w.type[id] === UnitType.Worker) ids.push(id);
    a.ws.send(encodeCommandsFrame(0, [{ type: CommandType.Move, player: sa.mySlot, ids, x: 20 << 16, y: 20 << 16 }]));
    // a forged command for the other player must be dropped
    a.ws.send(encodeCommandsFrame(0, [{ type: CommandType.Surrender, player: sb.mySlot }]));
    await new Promise((r) => setTimeout(r, 700));
    expect(a.frames.length).toBeGreaterThan(5);
    const withCmd = a.frames.filter((f) => f.cmds.length > 0);
    expect(withCmd.length).toBe(1);
    expect((withCmd[0].cmds[0] as { type: number }).type).toBe(CommandType.Move);
    const n = Math.min(a.frames.length, b.frames.length);
    expect(JSON.stringify(a.frames.slice(0, n))).toBe(JSON.stringify(b.frames.slice(0, n)));
    // apply frames locally: state must advance deterministically (same as server would)
    for (const f of a.frames.slice(0, n)) sim.step(f.cmds as never);
    expect(sim.tick).toBe(n);

    // Bob disconnects: bot takes over and Alice is notified; Bob reconnects with his token and gets a catch-up batch
    b.close();
    const st = await a.wait('playerStatus', 3000);
    expect(st.status).toBe('disconnected');
    const b2 = new TestClient(url);
    await b2.connect('Bob', wb.token);
    await b2.wait('welcome');
    const restart = await b2.wait('start');
    expect(restart.resumeTick).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(b2.batches).toBe(1);
    expect(b2.frames[0].tick).toBe(1);
    const st2 = await a.wait('playerStatus', 3000);
    expect(st2.status).toBe('connected');

    // Alice surrenders -> game over, replay saved, room back in lobby
    a.ws.send(encodeCommandsFrame(0, [{ type: CommandType.Surrender, player: sa.mySlot }]));
    const over = await a.wait('gameOver', 3000);
    expect(over.winnerTeam).toBe(sb.mySlot === 0 ? sa.setup.players[0].team : sa.setup.players[sb.mySlot].team);
    expect(replays).toHaveLength(1);
    expect(replays[0].frames.some((f) => f.c.some((c) => c.type === CommandType.Surrender))).toBe(true);
    a.close(); b2.close();
  }, 15000);
});
