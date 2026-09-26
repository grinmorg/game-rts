import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMUNITY_PAGE, MAPS_PER_PLAYER, MapErrorCode, MapMeta, MapSort, RoomMapInfo } from '@rookfall/protocol';
import { CUSTOM_MAP_MAX_CHARS, MAP_SIZE_MIN, customMapThumb, decodeCustomSource, encodeCustomMap, mapHasErrors, validateCustomMap } from '@rookfall/sim';

export interface MapRecord {
  id: string;
  /** the author's ladder key (never sent to anyone) */
  owner: string;
  author: string;
  name: string;
  w: number;
  h: number;
  players: number;
  public: boolean;
  valid: boolean;
  /** ladder keys of everyone who liked it: the count is public, who is not */
  likes: string[];
  createdAt: number;
  updatedAt: number;
  rev: number;
  thumb: string;
  bytes: number;
}

export type MapResult = { map: MapRecord } | { error: MapErrorCode };

/** the longest search a community list takes */
const QUERY_MAX = 40;
/** payloads kept in memory on a disk store: the maps being opened and played right now */
const PAYLOAD_CACHE = 16;
const ID_LEN = 10;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^[a-z0-9]{10}$/;

/** what a community search matches on: trimmed, capped, case-folded */
export function mapQuery(q: unknown): string {
  return typeof q === 'string' ? q.trim().slice(0, QUERY_MAX) : '';
}

/**
 * Player-made maps. The records live in one index file (`index.json`, a debounced full rewrite like the
 * accounts), each payload in a file of its own (`<id>.map`), since a payload can be half a megabyte and
 * only the one being edited or played is ever needed. `dir` is null for an in-memory store (tests).
 */
export class MapStore {
  private byId = new Map<string, MapRecord>();
  private byOwner = new Map<string, Set<MapRecord>>();
  /** in memory: every payload; on disk: the few read or written last */
  private payloads = new Map<string, string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private dir: string | null) { this.load(); }

  get size(): number { return this.byId.size; }

  private get indexFile(): string { return join(this.dir!, 'index.json'); }
  private payloadFile(id: string): string { return join(this.dir!, `${id}.map`); }

  private load(): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const file = this.indexFile;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { maps?: MapRecord[] };
      let lost = 0;
      for (const r of raw.maps ?? []) {
        if (!r || typeof r.id !== 'string' || !ID_RE.test(r.id)) continue;
        // deleted, but the index was not rewritten before the process died
        if (!existsSync(this.payloadFile(r.id))) { lost++; continue; }
        this.index(r);
      }
      if (lost) { console.warn(`[maps] ${lost} maps had no payload file, dropped`); this.scheduleSave(); }
      console.log(`[maps] loaded ${this.byId.size} maps`);
    } catch (err) {
      // keep the unreadable index for a manual look: the next save would otherwise overwrite every owner and like
      const aside = `${file}.${Date.now()}.bad`;
      try { renameSync(file, aside); } catch { /* nothing more to do */ }
      console.error(`[maps] could not read the map index (kept as ${aside}), starting empty`, err);
    }
  }

  private index(r: MapRecord): void {
    this.byId.set(r.id, r);
    let own = this.byOwner.get(r.owner);
    if (!own) this.byOwner.set(r.owner, (own = new Set()));
    own.add(r);
  }

  private unindex(r: MapRecord): void {
    this.byId.delete(r.id);
    const own = this.byOwner.get(r.owner);
    own?.delete(r);
    if (own && !own.size) this.byOwner.delete(r.owner);
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 2000);
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty || !this.dir) return;
    this.dirty = false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.indexFile}.tmp`;
      // the owners and likers are ladder keys, which sign a guest in: not for other users of the box
      writeFileSync(tmp, JSON.stringify({ version: 1, maps: [...this.byId.values()] }), { mode: 0o600 });
      renameSync(tmp, this.indexFile);
    } catch (err) {
      console.error('[maps] save failed', err);
    }
  }

  private remember(id: string, payload: string): void {
    this.payloads.delete(id);
    this.payloads.set(id, payload);
    if (this.dir && this.payloads.size > PAYLOAD_CACHE) this.payloads.delete(this.payloads.keys().next().value!);
  }

  get(id: string): MapRecord | undefined { return typeof id === 'string' ? this.byId.get(id) : undefined; }

  /** the map itself, as saved */
  payload(id: string): string | null {
    const rec = this.get(id);
    if (!rec) return null;
    const cached = this.payloads.get(rec.id);
    if (cached !== undefined) { this.remember(rec.id, cached); return cached; }
    if (!this.dir) return null;
    try {
      const p = readFileSync(this.payloadFile(rec.id), 'utf8');
      this.remember(rec.id, p);
      return p;
    } catch {
      return null;
    }
  }

  /**
   * A new map (no `id`) or a new revision of the owner's map. The payload is decoded and encoded again,
   * so what is stored and handed to every peer is exactly what the sim reads - nothing extra the browser
   * put in. A map saved with errors stays a draft: it cannot be public, so an update that breaks a
   * published map hides it.
   */
  save(owner: string, author: string, id: string | undefined, payload: unknown): MapResult {
    if (typeof payload !== 'string') return { error: 'invalid' };
    if (payload.length > CUSTOM_MAP_MAX_CHARS) return { error: 'tooBig' };
    const src = decodeCustomSource(payload);
    if (!src || src.w < MAP_SIZE_MIN || src.h < MAP_SIZE_MIN) return { error: 'invalid' };
    let rec: MapRecord | undefined;
    if (id !== undefined) {
      rec = this.get(id);
      if (!rec) return { error: 'notFound' };
      if (rec.owner !== owner) return { error: 'notOwner' };
    } else if ((this.byOwner.get(owner)?.size ?? 0) >= MAPS_PER_PLAYER) return { error: 'tooMany' };

    const data = encodeCustomMap(src);
    const derived = {
      author, name: src.name || 'Untitled', w: src.w, h: src.h, players: new Set(src.starts.map((s) => s.zone)).size,
      valid: !mapHasErrors(validateCustomMap(src)), thumb: customMapThumb(src), bytes: Buffer.byteLength(data),
    };
    const now = Date.now();
    if (!rec) {
      let newId = randomId();
      while (this.byId.has(newId)) newId = randomId();
      this.writePayload(newId, data);
      rec = { id: newId, owner, ...derived, public: false, likes: [], createdAt: now, updatedAt: now, rev: 1 };
      this.index(rec);
    } else {
      this.writePayload(rec.id, data);
      Object.assign(rec, derived, { updatedAt: now, rev: rec.rev + 1 });
      if (!rec.valid) rec.public = false;
    }
    this.remember(rec.id, data);
    this.scheduleSave();
    return { map: rec };
  }

  /** written at once, and before the record changes: a save the client was told about is on disk */
  private writePayload(id: string, data: string): void {
    if (!this.dir) return;
    const file = this.payloadFile(id);
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
  }

  remove(owner: string, id: string): MapErrorCode | null {
    const rec = this.get(id);
    if (!rec) return 'notFound';
    if (rec.owner !== owner) return 'notOwner';
    this.unindex(rec);
    this.payloads.delete(rec.id);
    if (this.dir) { try { unlinkSync(this.payloadFile(rec.id)); } catch { /* already gone */ } }
    this.scheduleSave();
    return null;
  }

  setPublic(owner: string, id: string, pub: boolean): MapResult {
    const rec = this.get(id);
    if (!rec) return { error: 'notFound' };
    if (rec.owner !== owner) return { error: 'notOwner' };
    if (pub && !rec.valid) return { error: 'notValid' };
    if (rec.public !== pub) { rec.public = pub; this.scheduleSave(); }
    return { map: rec };
  }

  /** likes rank the community list; a hidden map keeps its likes for when it is published again */
  like(key: string, id: string, like: boolean): MapResult {
    const rec = this.get(id);
    if (!rec || !rec.public) return { error: 'notFound' };
    if (rec.owner === key) return { error: 'ownMap' };
    const i = rec.likes.indexOf(key);
    if (like && i < 0) rec.likes.push(key);
    else if (!like && i >= 0) rec.likes.splice(i, 1);
    else return { map: rec };
    this.scheduleSave();
    return { map: rec };
  }

  /** the owner's maps, last edited first */
  mine(owner: string): MapRecord[] {
    return [...(this.byOwner.get(owner) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * One page of the published maps: 'top' by likes, 'new' by first save. The list is walked newest first,
   * so ties (and maps saved in the same millisecond) come out newest first under either order.
   */
  community(sort: MapSort, q: unknown, offset: unknown, limit = COMMUNITY_PAGE): { maps: MapRecord[]; total: number; offset: number } {
    const needle = mapQuery(q).toLowerCase();
    const list = [...this.byId.values()].reverse()
      .filter((r) => r.public && r.valid && (!needle || r.name.toLowerCase().includes(needle) || r.author.toLowerCase().includes(needle)));
    if (sort === 'new') list.sort((a, b) => b.createdAt - a.createdAt);
    else list.sort((a, b) => b.likes.length - a.likes.length || b.updatedAt - a.updatedAt);
    const from = Math.max(0, Math.min(list.length, typeof offset === 'number' && Number.isFinite(offset) ? Math.floor(offset) : 0));
    return { maps: list.slice(from, from + limit), total: list.length, offset: from };
  }

  /** a record as `viewer` may see it: counts, never the keys behind them */
  meta(r: MapRecord, viewer: string | null): MapMeta {
    const m: MapMeta = {
      id: r.id, name: r.name, author: r.author, w: r.w, h: r.h, players: r.players, likes: r.likes.length,
      public: r.public, valid: r.valid, createdAt: r.createdAt, updatedAt: r.updatedAt, rev: r.rev, thumb: r.thumb,
    };
    if (viewer && r.likes.includes(viewer)) m.liked = true;
    if (viewer && r.owner === viewer) m.mine = true;
    return m;
  }

  /** what a room shows about the map it is set to */
  roomInfo(r: MapRecord): RoomMapInfo {
    return { id: r.id, name: r.name, author: r.author, w: r.w, h: r.h, players: r.players, thumb: r.thumb };
  }

  /**
   * A guest signed up: their maps and likes move to the account's key, like their ladder profile. A like
   * the account would now hold on its own map is dropped.
   */
  rekey(from: string, to: string): void {
    if (from === to) return;
    let changed = false;
    const own = this.byOwner.get(from);
    if (own) {
      this.byOwner.delete(from);
      for (const r of own) { r.owner = to; this.index(r); }
      changed = true;
    }
    for (const r of this.byId.values()) {
      const had = r.likes.includes(from);
      const likes = r.likes.filter((k) => k !== from && !(k === to && r.owner === to));
      if (had && r.owner !== to && !likes.includes(to)) likes.push(to);
      if (likes.length !== r.likes.length || had) { r.likes = likes; changed = true; }
    }
    if (changed) this.scheduleSave();
  }

  /** the author's name on their maps follows their nickname */
  renameAuthor(owner: string, name: string): void {
    let changed = false;
    for (const r of this.byOwner.get(owner) ?? []) if (r.author !== name) { r.author = name; changed = true; }
    if (changed) this.scheduleSave();
  }
}

function randomId(): string {
  let s = '';
  for (const b of randomBytes(ID_LEN)) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}
