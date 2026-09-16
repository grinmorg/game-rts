import type { WebSocket } from 'ws';
import { ClientMessage, RoomState, RoomSlot, RoomSummary, ServerMessage, decodeFrame, encodeJson, FRAME_COMMANDS } from '@warlets/protocol';
import { MAX_PLAYERS, MatchSetup, OFFICIAL_MAPS, PLAYER_COLORS, PlayerSetup, ReplayData, SIM_VERSION } from '@warlets/sim';
import { Match } from './match';

export interface ClientConn {
  id: string;
  token: string;
  name: string;
  ws: WebSocket | null;
  room: Room | null;
  /** room slot index (0..5) or -1 */
  roomSlot: number;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
function randomId(): string { return randomCode(12).toLowerCase(); }

export class Room {
  code: string;
  name: string;
  hostId: string;
  mapId = 'duel-valley';
  slots: RoomSlot[] = [];
  started = false;
  match: Match | null = null;
  /** room slot -> player index in MatchSetup */
  slotToPlayer = new Map<number, number>();
  clients = new Set<ClientConn>();
  createdAt = Date.now();

  constructor(code: string, name: string, host: ClientConn) {
    this.code = code; this.name = name; this.hostId = host.id;
    for (let i = 0; i < MAX_PLAYERS; i++) this.slots.push({ index: i, kind: i === 0 ? 'human' : i < 2 ? 'open' : 'closed', team: i });
    this.slots[0].name = host.name; this.slots[0].clientId = host.id; this.slots[0].connected = true;
  }

  get maxPlayers(): number { return OFFICIAL_MAPS.find((m) => m.id === this.mapId)?.maxPlayers ?? 2; }

  state(): RoomState {
    return { code: this.code, name: this.name, hostId: this.hostId, mapId: this.mapId, slots: this.slots.map((s) => ({ ...s })), started: this.started };
  }
  summary(): RoomSummary {
    return { code: this.code, name: this.name, mapId: this.mapId, players: this.slots.filter((s) => s.kind === 'human' || s.kind === 'bot').length, max: this.maxPlayers, started: this.started };
  }

  setMap(mapId: string) {
    if (!OFFICIAL_MAPS.some((m) => m.id === mapId)) return;
    this.mapId = mapId;
    const max = this.maxPlayers;
    for (const s of this.slots) {
      if (s.index >= max) {
        if (s.kind === 'human') {
          const free = this.slots.find((o) => o.index < max && o.kind === 'open');
          if (free) { Object.assign(free, { kind: 'human', name: s.name, clientId: s.clientId, connected: s.connected }); const c = [...this.clients].find((x) => x.id === s.clientId); if (c) c.roomSlot = free.index; }
        }
        this.slots[s.index] = { index: s.index, kind: 'closed', team: s.index };
      } else if (s.kind === 'closed') s.kind = 'open';
    }
  }

  buildSetup(): MatchSetup {
    const players: PlayerSetup[] = [];
    this.slotToPlayer.clear();
    let idx = 0;
    for (const s of this.slots) {
      if (s.kind !== 'human' && s.kind !== 'bot') continue;
      this.slotToPlayer.set(s.index, idx);
      players.push({ slot: idx, team: s.team, name: s.name ?? (s.kind === 'bot' ? `Bot ${idx + 1}` : `Player ${idx + 1}`), isBot: s.kind === 'bot', difficulty: s.difficulty ?? 1, color: PLAYER_COLORS[s.index % PLAYER_COLORS.length] });
      idx++;
    }
    return { seed: (Math.random() * 0x7fffffff) | 0, mapId: this.mapId, players, version: SIM_VERSION };
  }
}

export interface LobbyHooks { saveReplay(replay: ReplayData): string }

export class Lobby {
  clients = new Map<string, ClientConn>(); // by token
  rooms = new Map<string, Room>();
  constructor(private hooks: LobbyHooks) {
    setInterval(() => this.gc(), 60_000);
  }

  // -------------------------------------------------------------- transport

  handleConnection(ws: WebSocket): void {
    let client: ClientConn | null = null;
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          if (!client) return;
          this.onBinary(client, data as Buffer);
        } else {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          if (!client) {
            if (msg.t !== 'hello') { ws.close(); return; }
            client = this.hello(ws, msg.name, msg.token);
          } else this.onMessage(client, msg);
        }
      } catch (err) {
        console.error('[lobby] message error', err);
      }
    });
    ws.on('close', () => { if (client) this.onClose(client); });
    ws.on('error', () => { /* handled by close */ });
  }

  private send(c: ClientConn, msg: ServerMessage) {
    if (c.ws && c.ws.readyState === 1) c.ws.send(encodeJson(msg));
  }
  private sendBinary(c: ClientConn, data: Uint8Array) {
    if (c.ws && c.ws.readyState === 1) c.ws.send(data, { binary: true });
  }
  private broadcast(room: Room, msg: ServerMessage) { for (const c of room.clients) this.send(c, msg); }
  private broadcastRoom(room: Room) { this.broadcast(room, { t: 'room', room: room.state() }); }

  // -------------------------------------------------------------- handlers

  private hello(ws: WebSocket, name: string, token?: string): ClientConn {
    const safeName = sanitizeName(name);
    let c = token ? this.clients.get(token) : undefined;
    if (c) {
      if (c.ws && c.ws !== ws && c.ws.readyState === 1) { try { c.ws.close(); } catch { /* ignore */ } }
      c.ws = ws;
      if (safeName) c.name = safeName;
    } else {
      c = { id: randomId(), token: randomId() + randomId(), name: safeName || `Guest${1000 + Math.floor(Math.random() * 9000)}`, ws, room: null, roomSlot: -1 };
      this.clients.set(c.token, c);
    }
    this.send(c, { t: 'welcome', clientId: c.id, token: c.token, name: c.name });
    // resume
    const room = c.room;
    if (room) {
      room.clients.add(c);
      const slot = room.slots[c.roomSlot];
      if (slot && slot.clientId === c.id) { slot.connected = true; slot.name = c.name; }
      if (room.started && room.match) {
        const pi = room.slotToPlayer.get(c.roomSlot);
        if (pi !== undefined) {
          this.send(c, { t: 'start', setup: room.match.setup, mySlot: pi, roomCode: room.code, resumeTick: room.match.tick });
          const batch = room.match.playerReconnected(pi);
          this.sendBinary(c, batch);
        }
      }
      this.broadcastRoom(room);
    }
    return c;
  }

  private onMessage(c: ClientConn, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello': break;
      case 'setName': {
        c.name = sanitizeName(msg.name) || c.name;
        if (c.room && c.roomSlot >= 0) { c.room.slots[c.roomSlot].name = c.name; this.broadcastRoom(c.room); }
        break;
      }
      case 'ping': this.send(c, { t: 'pong', ts: msg.ts, serverTick: c.room?.match?.tick ?? 0 }); break;
      case 'listRooms': this.send(c, { t: 'rooms', rooms: [...this.rooms.values()].filter((r) => !r.started).map((r) => r.summary()) }); break;
      case 'create': {
        this.leaveRoom(c);
        let code = randomCode(5);
        while (this.rooms.has(code)) code = randomCode(5);
        const room = new Room(code, sanitizeName(msg.name ?? '') || `${c.name}'s game`, c);
        if (msg.mapId) room.setMap(msg.mapId);
        room.clients.add(c);
        c.room = room; c.roomSlot = 0;
        this.rooms.set(code, room);
        this.broadcastRoom(room);
        break;
      }
      case 'join': {
        const room = this.rooms.get((msg.code || '').toUpperCase().trim());
        if (!room) { this.send(c, { t: 'error', code: 'noRoom' }); return; }
        if (c.room === room) { this.broadcastRoom(room); return; }
        this.leaveRoom(c);
        const free = room.started ? undefined : room.slots.find((s) => s.kind === 'open');
        if (!free) { this.send(c, { t: 'error', code: room.started ? 'started' : 'full' }); return; }
        free.kind = 'human'; free.name = c.name; free.clientId = c.id; free.connected = true;
        room.clients.add(c); c.room = room; c.roomSlot = free.index;
        this.broadcastRoom(room);
        break;
      }
      case 'leave': this.leaveRoom(c); this.send(c, { t: 'left' }); break;
      case 'slot': {
        const room = c.room;
        if (!room || room.hostId !== c.id || room.started) return;
        const s = room.slots[msg.slot];
        if (!s || s.kind === 'human' || msg.slot >= room.maxPlayers) return;
        s.kind = msg.kind;
        if (msg.kind === 'bot') { s.difficulty = msg.difficulty ?? 1; s.name = `Bot (${['easy', 'medium', 'hard'][s.difficulty]})`; }
        else { delete s.name; delete s.difficulty; }
        this.broadcastRoom(room);
        break;
      }
      case 'pick': {
        const room = c.room;
        if (!room || room.started) return;
        const s = room.slots[msg.slot];
        if (!s || s.kind !== 'open') return;
        const old = room.slots[c.roomSlot];
        if (old) { room.slots[c.roomSlot] = { index: old.index, kind: 'open', team: old.team }; }
        s.kind = 'human'; s.name = c.name; s.clientId = c.id; s.connected = true;
        c.roomSlot = s.index;
        this.broadcastRoom(room);
        break;
      }
      case 'team': {
        const room = c.room;
        if (!room || room.started) return;
        const s = room.slots[msg.slot];
        if (!s) return;
        if (room.hostId !== c.id && s.clientId !== c.id) return;
        if (msg.team < 0 || msg.team >= MAX_PLAYERS) return;
        s.team = msg.team;
        this.broadcastRoom(room);
        break;
      }
      case 'map': {
        const room = c.room;
        if (!room || room.hostId !== c.id || room.started) return;
        room.setMap(msg.mapId);
        this.broadcastRoom(room);
        break;
      }
      case 'start': this.startGame(c); break;
      case 'chat': {
        const room = c.room;
        if (!room) return;
        const text = String(msg.text ?? '').slice(0, 200);
        if (!text.trim()) return;
        const pi = room.slotToPlayer.get(c.roomSlot) ?? c.roomSlot;
        this.broadcast(room, { t: 'chat', from: pi, name: c.name, text });
        break;
      }
      case 'hash': {
        const room = c.room;
        if (!room?.match) return;
        const pi = room.slotToPlayer.get(c.roomSlot);
        if (pi !== undefined) room.match.onHash(pi, msg.tick, msg.hash);
        break;
      }
    }
  }

  private onBinary(c: ClientConn, data: Buffer): void {
    const room = c.room;
    if (!room?.match) return;
    const pi = room.slotToPlayer.get(c.roomSlot);
    if (pi === undefined) return;
    const frame = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (frame.kind !== FRAME_COMMANDS) return;
    room.match.submit(pi, frame.frames[0].cmds);
  }

  private startGame(c: ClientConn): void {
    const room = c.room;
    if (!room || room.hostId !== c.id || room.started) return;
    const filled = room.slots.filter((s) => s.kind === 'human' || s.kind === 'bot');
    if (filled.length < 2) { this.send(c, { t: 'error', code: 'needPlayers' }); return; }
    const teams = new Set(filled.map((s) => s.team));
    if (teams.size < 2) { this.send(c, { t: 'error', code: 'needTeams' }); return; }
    const setup = room.buildSetup();
    room.started = true;
    const match = new Match(setup, {
      broadcast: (m) => this.broadcast(room, m),
      broadcastBinary: (d) => { for (const cl of room.clients) this.sendBinary(cl, d); },
      onGameOver: (replay) => {
        const id = this.hooks.saveReplay(replay);
        this.broadcast(room, { t: 'gameOver', winnerTeam: replay.result?.winnerTeam ?? -1, replayId: id });
        room.started = false; room.match = null;
        // drop clients that are no longer connected
        for (const cl of [...room.clients]) if (!cl.ws || cl.ws.readyState !== 1) this.leaveRoom(cl);
        this.broadcastRoom(room);
      },
      onAbandoned: () => {
        console.log(`[lobby] room ${room.code} abandoned, closing match`);
        room.started = false; room.match = null;
        for (const cl of [...room.clients]) this.leaveRoom(cl);
        this.rooms.delete(room.code);
      },
    });
    room.match = match;
    for (const cl of room.clients) {
      const pi = room.slotToPlayer.get(cl.roomSlot);
      if (pi !== undefined) this.send(cl, { t: 'start', setup, mySlot: pi, roomCode: room.code });
    }
    const connected = [...room.clients].filter((cl) => cl.ws && cl.ws.readyState === 1).map((cl) => room.slotToPlayer.get(cl.roomSlot)!).filter((v) => v !== undefined);
    match.start(connected);
    this.broadcastRoom(room);
    console.log(`[lobby] match started in room ${room.code}: ${setup.players.map((p) => p.name).join(', ')} on ${setup.mapId}`);
  }

  private leaveRoom(c: ClientConn): void {
    const room = c.room;
    if (!room) return;
    room.clients.delete(c);
    const slot = room.slots[c.roomSlot];
    if (slot && slot.clientId === c.id) {
      if (room.started && room.match) {
        // leaving mid-game = surrender handled by disconnect timer / bot takeover
        slot.connected = false;
        const pi = room.slotToPlayer.get(c.roomSlot);
        if (pi !== undefined) room.match.playerDisconnected(pi);
      } else {
        room.slots[c.roomSlot] = { index: slot.index, kind: 'open', team: slot.team };
      }
    }
    c.room = null; c.roomSlot = -1;
    if (room.hostId === c.id) {
      const next = [...room.clients][0];
      if (next) room.hostId = next.id;
    }
    if (room.clients.size === 0 && !room.started) { this.rooms.delete(room.code); if (room.match) room.match.stop(); }
    else this.broadcastRoom(room);
  }

  private onClose(c: ClientConn): void {
    c.ws = null;
    const room = c.room;
    if (!room) return;
    const slot = room.slots[c.roomSlot];
    if (slot) slot.connected = false;
    if (room.started && room.match) {
      const pi = room.slotToPlayer.get(c.roomSlot);
      if (pi !== undefined) room.match.playerDisconnected(pi);
      this.broadcastRoom(room);
    } else {
      // in lobby: free the slot after a short grace period for page reloads
      setTimeout(() => { if (!c.ws && c.room === room) { this.leaveRoom(c); } }, 15_000);
      this.broadcastRoom(room);
    }
  }

  private gc(): void {
    const now = Date.now();
    for (const [token, c] of this.clients) {
      if (!c.ws && !c.room) this.clients.delete(token);
    }
    for (const [code, r] of this.rooms) {
      if (!r.started && r.clients.size === 0 && now - r.createdAt > 60_000) this.rooms.delete(code);
    }
  }

  publicRooms(): RoomSummary[] { return [...this.rooms.values()].filter((r) => !r.started).map((r) => r.summary()); }
}

function sanitizeName(s: string): string {
  return String(s ?? '').replace(/[^\p{L}\p{N} _\-.'!]/gu, '').trim().slice(0, 20);
}
