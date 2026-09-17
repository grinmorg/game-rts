import type { WebSocket } from 'ws';
import {
  ClientMessage, PLACEMENT_GAMES, RANKED_MAP_ID, RANKED_SPEEDS, RoomState, RoomSlot, RoomSummary, ServerMessage,
  decodeFrame, encodeJson, FRAME_COMMANDS,
} from '@rookfall/protocol';
import { MAX_PLAYERS, MatchSetup, OFFICIAL_MAPS, PLAYER_COLORS, PlayerSetup, ReplayData, SIM_VERSION, GAME_SPEEDS } from '@rookfall/sim';
import { Match } from './match';
import { Matchmaker, Ticket } from './matchmaking';
import { RatingStore, decayRd } from './rating';

export interface ClientConn {
  id: string;
  token: string;
  name: string;
  ws: WebSocket | null;
  room: Room | null;
  /** room slot index (0..5) or -1 */
  roomSlot: number;
  /** long-lived ladder key from the client's localStorage (never shown to anyone else) */
  playerKey: string | null;
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
  speed = 1;
  slots: RoomSlot[] = [];
  started = false;
  /** private rooms are joinable by code or invite link only and never appear in the room list */
  isPrivate = false;
  /** ladder match: built by the matchmaker, torn down as soon as it is over */
  ranked = false;
  /** ladder keys of player 0 and player 1, kept so the result can be written down after the match */
  rankedKeys: [string, string] | null = null;
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
    return {
      code: this.code, name: this.name, hostId: this.hostId, mapId: this.mapId, speed: this.speed,
      slots: this.slots.map((s) => ({ ...s })), started: this.started, private: this.isPrivate, ranked: this.ranked || undefined,
    };
  }
  summary(): RoomSummary {
    return { code: this.code, name: this.name, mapId: this.mapId, players: this.slots.filter((s) => s.kind === 'human' || s.kind === 'bot').length, max: this.maxPlayers, started: this.started };
  }

  setSpeed(speed: number) {
    if (GAME_SPEEDS.includes(speed)) this.speed = speed;
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
    return { seed: (Math.random() * 0x7fffffff) | 0, mapId: this.mapId, players, version: SIM_VERSION, speed: this.speed };
  }
}

export interface LobbyHooks {
  saveReplay(replay: ReplayData): string;
  /** where ladder profiles are stored; omitted in tests, which keep the ladder in memory */
  profilesFile?: string;
}

export class Lobby {
  clients = new Map<string, ClientConn>(); // by token
  rooms = new Map<string, Room>();
  readonly ratings: RatingStore;
  private mm = new Matchmaker<ClientConn>();
  constructor(private hooks: LobbyHooks) {
    this.ratings = new RatingStore(hooks.profilesFile ?? null);
    setInterval(() => this.gc(), 60_000);
    setInterval(() => this.matchmakerTick(), 1000);
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
            client = this.hello(ws, msg.name, msg.token, msg.playerKey);
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

  private hello(ws: WebSocket, name: string, token?: string, playerKey?: string): ClientConn {
    const safeName = sanitizeName(name);
    let c = token ? this.clients.get(token) : undefined;
    if (c) {
      if (c.ws && c.ws !== ws && c.ws.readyState === 1) { try { c.ws.close(); } catch { /* ignore */ } }
      c.ws = ws;
      if (safeName) c.name = safeName;
    } else {
      c = { id: randomId(), token: randomId() + randomId(), name: safeName || `Guest${1000 + Math.floor(Math.random() * 9000)}`, ws, room: null, roomSlot: -1, playerKey: null };
      this.clients.set(c.token, c);
    }
    const key = sanitizeKey(playerKey);
    if (key) c.playerKey = key;
    this.send(c, { t: 'welcome', clientId: c.id, token: c.token, name: c.name });
    if (c.playerKey) this.send(c, { t: 'profile', profile: this.ratings.profileFor(c.playerKey, c.name) });
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
        if (c.playerKey) this.ratings.profileFor(c.playerKey, c.name);
        if (c.room && c.roomSlot >= 0) { c.room.slots[c.roomSlot].name = c.name; this.broadcastRoom(c.room); }
        break;
      }
      case 'ping': this.send(c, { t: 'pong', ts: msg.ts, serverTick: c.room?.match?.tick ?? 0 }); break;
      case 'listRooms': this.send(c, { t: 'rooms', rooms: this.publicRooms() }); break;
      case 'create': {
        this.leaveRoom(c);
        let code = randomCode(5);
        while (this.rooms.has(code)) code = randomCode(5);
        const room = new Room(code, sanitizeName(msg.name ?? '') || `${c.name}'s game`, c);
        room.isPrivate = !!msg.private;
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
      case 'speed': {
        const room = c.room;
        if (!room || room.hostId !== c.id || room.started) return;
        room.setSpeed(msg.speed);
        this.broadcastRoom(room);
        break;
      }
      case 'privacy': {
        const room = c.room;
        if (!room || room.hostId !== c.id || room.ranked) return;
        room.isPrivate = !!msg.private;
        this.broadcastRoom(room);
        break;
      }
      case 'profile': {
        if (c.playerKey) this.send(c, { t: 'profile', profile: this.ratings.profileFor(c.playerKey, c.name) });
        break;
      }
      case 'leaderboard': this.send(c, { t: 'leaderboard', entries: this.ratings.top(20) }); break;
      case 'queue': this.enqueue(c, msg.speed); break;
      case 'dequeue': {
        this.mm.leave(c);
        this.send(c, { t: 'dequeued' });
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
    this.launch(room);
  }

  /** build the setup, spin up the authority and put every client in the room into the match */
  private launch(room: Room): void {
    const setup = room.buildSetup();
    room.started = true;
    const match = new Match(setup, {
      broadcast: (m) => this.broadcast(room, m),
      broadcastBinary: (d) => { for (const cl of room.clients) this.sendBinary(cl, d); },
      onGameOver: (replay) => {
        const id = this.hooks.saveReplay(replay);
        this.broadcast(room, { t: 'gameOver', winnerTeam: replay.result?.winnerTeam ?? -1, replayId: id });
        room.started = false; room.match = null;
        // a ladder match is over for good: hand out the rating changes and close the room
        if (room.ranked) { this.finishRanked(room, replay); this.closeRoom(room); return; }
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
      if (pi !== undefined) this.send(cl, { t: 'start', setup, mySlot: pi, roomCode: room.code, ranked: room.ranked || undefined });
    }
    const connected = [...room.clients].filter((cl) => cl.ws && cl.ws.readyState === 1).map((cl) => room.slotToPlayer.get(cl.roomSlot)!).filter((v) => v !== undefined);
    match.start(connected);
    this.broadcastRoom(room);
    console.log(`[lobby] ${room.ranked ? 'ranked match' : 'match'} started in room ${room.code}: ${setup.players.map((p) => p.name).join(', ')} on ${setup.mapId}`);
  }

  // -------------------------------------------------------------- ranked ladder

  private enqueue(c: ClientConn, speed: number): void {
    if (!c.playerKey) { this.send(c, { t: 'error', code: 'noProfile' }); return; }
    if (c.room?.started) { this.send(c, { t: 'error', code: 'inMatch' }); return; }
    if (!RANKED_SPEEDS.includes(speed as never)) { this.send(c, { t: 'error', code: 'badSpeed' }); return; }
    this.leaveRoom(c); // the ladder builds its own room
    const p = this.ratings.profileFor(c.playerKey, c.name);
    this.mm.join({ client: c, key: c.playerKey, rating: p.rating, rd: decayRd(p, Date.now()), speed, since: Date.now() });
    const st = this.mm.state(c);
    if (st) this.send(c, { t: 'queued', state: st });
  }

  /** one pass of the matchmaker: pair everyone who fits, then refresh the wait counters */
  private matchmakerTick(): void {
    for (const [a, b] of this.mm.pop()) this.startRanked(a, b);
    if (!this.mm.size) return;
    for (const c of this.clients.values()) {
      const st = this.mm.state(c);
      if (st) this.send(c, { t: 'queued', state: st });
    }
  }

  private startRanked(ta: Ticket<ClientConn>, tb: Ticket<ClientConn>): void {
    const live = (c: ClientConn) => !!c.ws && c.ws.readyState === 1;
    // somebody may have closed the tab between joining the queue and being paired: put the other back in
    if (!live(ta.client) || !live(tb.client)) {
      for (const t of [ta, tb]) if (live(t.client)) { this.mm.join({ ...t }); this.send(t.client, { t: 'queued', state: this.mm.state(t.client)! }); }
      return;
    }
    const [ca, cb] = [ta.client, tb.client];
    let code = randomCode(5);
    while (this.rooms.has(code)) code = randomCode(5);
    const room = new Room(code, `${ca.name} vs ${cb.name}`, ca);
    room.isPrivate = true;
    room.ranked = true;
    room.rankedKeys = [ta.key, tb.key];
    room.setSpeed(ta.speed);
    room.setMap(RANKED_MAP_ID); // procedural: buildSetup rolls the seed, every peer generates the same map from it
    room.slots[1] = { index: 1, kind: 'human', team: 1, name: cb.name, clientId: cb.id, connected: true };
    room.clients.add(ca); room.clients.add(cb);
    ca.room = room; ca.roomSlot = 0;
    cb.room = room; cb.roomSlot = 1;
    this.rooms.set(code, room);
    this.launch(room);
  }

  /** write a finished ladder match into the ratings and tell both players what it cost them */
  private finishRanked(room: Room, replay: ReplayData): void {
    const keys = room.rankedKeys;
    if (!keys) return;
    room.rankedKeys = null; // never score the same match twice
    const names = [room.slots[0].name ?? 'Player 1', room.slots[1].name ?? 'Player 2'];
    const winnerTeam = replay.result?.winnerTeam ?? -1;
    // player 0 is always team 0 and player 1 always team 1 in a ladder room
    const scoreA = winnerTeam < 0 ? 0.5 : winnerTeam === 0 ? 1 : 0;
    const out = this.ratings.applyMatch({ key: keys[0], name: names[0] }, { key: keys[1], name: names[1] }, scoreA, replay.tickCount);
    this.ratings.flush();
    console.log(`[ladder] ${names[0]} ${out.a.result} vs ${names[1]}: ${Math.round(out.a.profile.rating)} / ${Math.round(out.b.profile.rating)}`);
    for (const cl of room.clients) {
      const pi = room.slotToPlayer.get(cl.roomSlot);
      if (pi !== 0 && pi !== 1) continue;
      const mine = pi === 0 ? out.a : out.b, other = pi === 0 ? out.b : out.a;
      const ratingBefore = Math.round(mine.ratingBefore), ratingAfter = Math.round(mine.profile.rating);
      this.send(cl, {
        t: 'rankedResult',
        result: {
          result: mine.result, ratingBefore, ratingAfter, delta: ratingAfter - ratingBefore,
          xpGained: mine.xpGained, levelBefore: mine.levelBefore, profile: mine.profile,
          opponent: { name: other.profile.name, rating: Math.round(other.ratingBefore) },
          placement: mine.profile.games < PLACEMENT_GAMES,
        },
      });
      this.send(cl, { t: 'profile', profile: mine.profile });
    }
  }

  /** detach every client and forget the room (ladder rooms are never reused) */
  private closeRoom(room: Room): void {
    for (const cl of [...room.clients]) {
      room.clients.delete(cl);
      if (cl.room === room) { cl.room = null; cl.roomSlot = -1; }
    }
    if (room.match) room.match.stop();
    room.match = null;
    this.rooms.delete(room.code);
  }

  private leaveRoom(c: ClientConn): void {
    this.mm.leave(c);
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
    this.mm.leave(c);
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

  publicRooms(): RoomSummary[] { return [...this.rooms.values()].filter((r) => !r.started && !r.isPrivate).map((r) => r.summary()); }
}

/** the ladder key is opaque to us - accept only what we handed out shape-wise, never echo it back */
function sanitizeKey(s: string | undefined): string | null {
  const v = String(s ?? '').replace(/[^a-z0-9_-]/gi, '');
  return v.length >= 8 && v.length <= 64 ? v : null;
}

function sanitizeName(s: string): string {
  return String(s ?? '').replace(/[^\p{L}\p{N} _\-.'!]/gu, '').trim().slice(0, 20);
}
