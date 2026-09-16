import { Command, MatchSetup } from '@warlets/sim';

// ------------------------------------------------------------------ lobby (JSON, text frames)

export type SlotKind = 'open' | 'closed' | 'bot' | 'human';

export interface RoomSlot {
  index: number;
  kind: SlotKind;
  team: number;
  name?: string;
  clientId?: string;
  difficulty?: 0 | 1 | 2;
  connected?: boolean;
}

export interface RoomState {
  code: string;
  name: string;
  hostId: string;
  mapId: string;
  /** match speed multiplier picked by the host (GAME_SPEEDS) */
  speed: number;
  slots: RoomSlot[];
  started: boolean;
}

export interface RoomSummary { code: string; name: string; mapId: string; players: number; max: number; started: boolean }

export type ClientMessage =
  | { t: 'hello'; name: string; token?: string }
  | { t: 'setName'; name: string }
  | { t: 'create'; name?: string; mapId?: string }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'slot'; slot: number; kind: 'open' | 'closed' | 'bot'; difficulty?: 0 | 1 | 2 }
  | { t: 'pick'; slot: number }
  | { t: 'team'; slot: number; team: number }
  | { t: 'map'; mapId: string }
  | { t: 'speed'; speed: number }
  | { t: 'start' }
  | { t: 'chat'; text: string }
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'ping'; ts: number }
  | { t: 'listRooms' };

export type ServerMessage =
  | { t: 'welcome'; clientId: string; token: string; name: string }
  | { t: 'room'; room: RoomState }
  | { t: 'left' }
  | { t: 'error'; code: string; msg?: string }
  | { t: 'start'; setup: MatchSetup; mySlot: number; roomCode: string; resumeTick?: number }
  | { t: 'chat'; from: number; name: string; text: string; system?: boolean }
  | { t: 'pong'; ts: number; serverTick: number }
  | { t: 'playerStatus'; slot: number; status: 'connected' | 'disconnected' | 'eliminated'; secondsLeft?: number }
  | { t: 'desync'; tick: number; slot: number }
  | { t: 'gameOver'; winnerTeam: number; replayId?: string }
  | { t: 'rooms'; rooms: RoomSummary[] };

// ------------------------------------------------------------------ binary frames

export const FRAME_COMMANDS = 1; // client -> server: [u8 kind][u32 clientTick][u16 count][commands]
export const FRAME_TICK = 2; // server -> client: [u8 kind][u32 tick][u16 count][commands]
export const FRAME_BATCH = 3; // server -> client: [u8 kind][u32 frames] then frames*( [u32 tick][u16 count][commands] )

export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 0;
  constructor(cap = 256) { this.buf = new ArrayBuffer(cap); this.view = new DataView(this.buf); }
  private ensure(n: number) {
    if (this.pos + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = nb; this.view = new DataView(nb);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.pos).slice(); }
}

export class ByteReader {
  private view: DataView;
  pos = 0;
  constructor(data: ArrayBuffer | Uint8Array) {
    this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }
  get remaining() { return this.view.byteLength - this.pos; }
  u8() { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8() { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
}

const F_IDS = 1, F_TARGET = 2, F_XY = 4, F_V = 8, F_QUEUE = 16;

export function writeCommand(w: ByteWriter, c: Command): void {
  let flags = 0;
  if (c.ids && c.ids.length) flags |= F_IDS;
  if (c.target !== undefined && c.target >= 0) flags |= F_TARGET;
  if (c.x !== undefined && c.y !== undefined) flags |= F_XY;
  if (c.v !== undefined) flags |= F_V;
  if (c.queue) flags |= F_QUEUE;
  w.u8(c.type); w.i8(c.player); w.u8(flags);
  if (flags & F_IDS) { const ids = c.ids!; w.u16(ids.length); for (const id of ids) w.u16(id); }
  if (flags & F_TARGET) w.i32(c.target!);
  if (flags & F_XY) { w.i32(c.x!); w.i32(c.y!); }
  if (flags & F_V) w.i32(c.v!);
}

export function readCommand(r: ByteReader): Command {
  const type = r.u8(), player = r.i8(), flags = r.u8();
  const c: Command = { type, player };
  if (flags & F_IDS) { const n = r.u16(); const ids = new Array<number>(n); for (let i = 0; i < n; i++) ids[i] = r.u16(); c.ids = ids; }
  if (flags & F_TARGET) c.target = r.i32();
  if (flags & F_XY) { c.x = r.i32(); c.y = r.i32(); }
  if (flags & F_V) c.v = r.i32();
  if (flags & F_QUEUE) c.queue = true;
  return c;
}

export function encodeCommandsFrame(clientTick: number, cmds: readonly Command[]): Uint8Array {
  const w = new ByteWriter();
  w.u8(FRAME_COMMANDS); w.u32(clientTick); w.u16(cmds.length);
  for (const c of cmds) writeCommand(w, c);
  return w.bytes();
}

export function encodeTickFrame(tick: number, cmds: readonly Command[]): Uint8Array {
  const w = new ByteWriter(64);
  w.u8(FRAME_TICK); w.u32(tick); w.u16(cmds.length);
  for (const c of cmds) writeCommand(w, c);
  return w.bytes();
}

export function encodeBatch(frames: { tick: number; cmds: readonly Command[] }[]): Uint8Array {
  const w = new ByteWriter(1024);
  w.u8(FRAME_BATCH); w.u32(frames.length);
  for (const f of frames) { w.u32(f.tick); w.u16(f.cmds.length); for (const c of f.cmds) writeCommand(w, c); }
  return w.bytes();
}

export interface TickFrame { tick: number; cmds: Command[] }

export function decodeFrame(data: ArrayBuffer | Uint8Array): { kind: number; clientTick?: number; frames: TickFrame[] } {
  const r = new ByteReader(data);
  const kind = r.u8();
  if (kind === FRAME_COMMANDS || kind === FRAME_TICK) {
    const tick = r.u32(); const n = r.u16();
    const cmds: Command[] = [];
    for (let i = 0; i < n; i++) cmds.push(readCommand(r));
    return kind === FRAME_COMMANDS ? { kind, clientTick: tick, frames: [{ tick, cmds }] } : { kind, frames: [{ tick, cmds }] };
  }
  if (kind === FRAME_BATCH) {
    const count = r.u32();
    const frames: TickFrame[] = [];
    for (let i = 0; i < count; i++) {
      const tick = r.u32(); const n = r.u16();
      const cmds: Command[] = [];
      for (let k = 0; k < n; k++) cmds.push(readCommand(r));
      frames.push({ tick, cmds });
    }
    return { kind, frames };
  }
  throw new Error(`unknown frame kind ${kind}`);
}

export function encodeJson(m: ClientMessage | ServerMessage): string { return JSON.stringify(m); }
export function decodeJson<T = ClientMessage | ServerMessage>(s: string): T { return JSON.parse(s) as T; }
