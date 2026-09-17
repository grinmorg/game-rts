import { ClientMessage, ServerMessage, TickFrame, decodeFrame, encodeJson } from '@rookfall/protocol';
import { getPlayerKey, getSettings, getToken, setToken } from '../settings';

type Handler<T> = (payload: T) => void;

export interface NetEvents {
  open: void;
  close: void;
  welcome: Extract<ServerMessage, { t: 'welcome' }>;
  room: Extract<ServerMessage, { t: 'room' }>;
  left: void;
  error: Extract<ServerMessage, { t: 'error' }>;
  start: Extract<ServerMessage, { t: 'start' }>;
  chat: Extract<ServerMessage, { t: 'chat' }>;
  pong: Extract<ServerMessage, { t: 'pong' }>;
  playerStatus: Extract<ServerMessage, { t: 'playerStatus' }>;
  desync: Extract<ServerMessage, { t: 'desync' }>;
  gameOver: Extract<ServerMessage, { t: 'gameOver' }>;
  rooms: Extract<ServerMessage, { t: 'rooms' }>;
  profile: Extract<ServerMessage, { t: 'profile' }>;
  queued: Extract<ServerMessage, { t: 'queued' }>;
  dequeued: void;
  rankedResult: Extract<ServerMessage, { t: 'rankedResult' }>;
  leaderboard: Extract<ServerMessage, { t: 'leaderboard' }>;
  frames: TickFrame[];
}

/** WebSocket client with auto-reconnect and a typed event bus. */
export class NetClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<keyof NetEvents, Set<Handler<unknown>>>();
  private wanted = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  clientId = '';
  name = '';
  connected = false;
  ping = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pendingFrames: TickFrame[] = [];

  /** Frames received before any session subscribed (drained by NetSession on construction). */
  takePendingFrames(): TickFrame[] {
    const f = this.pendingFrames;
    this.pendingFrames = [];
    return f;
  }
  clearPendingFrames(): void { this.pendingFrames = []; }

  get url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const override = (import.meta as unknown as { env: Record<string, string | undefined> }).env?.VITE_WS_URL;
    return override ?? `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.wanted = true;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.send({ t: 'hello', name: getSettings().name, token: getToken(), playerKey: getPlayerKey() });
      this.emit('open', undefined);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 3000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.t === 'welcome') { this.clientId = msg.clientId; this.name = msg.name; setToken(msg.token); }
        if (msg.t === 'pong') this.ping = Math.round(performance.now() - msg.ts);
        this.emit(msg.t as keyof NetEvents, msg.t === 'left' || msg.t === 'dequeued' ? undefined : msg);
      } else {
        const f = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
        // no session listening yet (models still loading): buffer so the first ticks aren't lost
        if (!this.handlers.get('frames')?.size) this.pendingFrames.push(...f.frames);
        else this.emit('frames', f.frames);
      }
    };
    ws.onclose = () => {
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.emit('close', undefined);
      if (this.wanted) this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleRetry(): void {
    if (this.timer) return;
    const delay = Math.min(8000, 500 * Math.pow(2, this.retry++));
    this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.open(); }, delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeJson(msg));
  }
  sendBinary(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  on<K extends keyof NetEvents>(type: K, fn: Handler<NetEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn as Handler<unknown>);
    return () => { set!.delete(fn as Handler<unknown>); };
  }
  private emit<K extends keyof NetEvents>(type: K, payload: NetEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of [...set]) h(payload);
  }
}

export const net = new NetClient();
