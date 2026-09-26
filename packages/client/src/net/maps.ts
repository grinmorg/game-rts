import { useSyncExternalStore } from 'react';
import { MapErrorCode, MapMeta, MapSort, ServerMessage } from '@rookfall/protocol';
import { net } from './client';

/**
 * Player-made maps on the server, as request/response promises over the lobby socket, plus the player's own
 * list kept in one place so the map editor home and every map picker show the same thing.
 */

/** why a map request failed: the server's code, or no answer at all */
export type MapFailure = MapErrorCode | 'offline' | 'timeout';

export class MapRequestError extends Error {
  constructor(readonly code: MapFailure) { super(code); }
}

const TIMEOUT_MS = 20_000;

type MapReply = Extract<ServerMessage, { t: 'mapSaved' | 'mapUpdated' | 'mapDeleted' | 'mapData' | 'myMaps' | 'communityMaps' | 'mapError' }>;

/**
 * Send a message and wait for the first reply `pick` recognises (a value) or refuses (a MapRequestError).
 * The reply types are known up front, so only those events are listened to.
 */
function ask<T>(send: () => void, events: MapReply['t'][], pick: (m: MapReply) => T | MapRequestError | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!net.connected) { reject(new MapRequestError('offline')); return; }
    const offs: (() => void)[] = [];
    const done = () => { offs.forEach((f) => f()); clearTimeout(timer); };
    const timer = setTimeout(() => { done(); reject(new MapRequestError('timeout')); }, TIMEOUT_MS);
    for (const ev of events) {
      offs.push(net.on(ev, (m) => {
        const r = pick(m as MapReply);
        if (r === undefined) return;
        done();
        if (r instanceof MapRequestError) reject(r); else resolve(r);
      }));
    }
    offs.push(net.on('close', () => { done(); reject(new MapRequestError('offline')); }));
    send();
  });
}

const failed = (code: MapErrorCode) => new MapRequestError(code);

// ---------------------------------------------------------------- payloads

/** payloads fetched this session: a map is only fetched again after its author saved a newer revision */
const payloads = new Map<string, { rev: number; data: string }>();

export function fetchMapData(id: string, rev?: number): Promise<string> {
  const cached = payloads.get(id);
  if (cached && (rev === undefined || cached.rev >= rev)) return Promise.resolve(cached.data);
  return ask(() => net.send({ t: 'mapGet', id }), ['mapData', 'mapError'], (m) => {
    if (m.t === 'mapData' && m.id === id) { payloads.set(id, { rev: m.rev, data: m.data }); return m.data; }
    if (m.t === 'mapError' && m.id === id) return failed(m.code);
    return undefined;
  });
}

let reqSeq = 0;

/** create (no id) or update a map; the answer is its new listing */
export function saveMap(id: string | undefined, data: string): Promise<MapMeta> {
  const req = ++reqSeq;
  return ask(() => net.send({ t: 'mapSave', req, id, data }), ['mapSaved', 'mapError'], (m) => {
    if (m.t === 'mapSaved' && m.req === req) { payloads.set(m.map.id, { rev: m.map.rev, data }); upsertMine(m.map); return m.map; }
    if (m.t === 'mapError' && m.req === req) return failed(m.code);
    return undefined;
  });
}

export function publishMap(id: string, pub: boolean): Promise<MapMeta> {
  return ask(() => net.send({ t: 'mapPublish', id, public: pub }), ['mapUpdated', 'mapError'], (m) => {
    if (m.t === 'mapUpdated' && m.map.id === id) { upsertMine(m.map); return m.map; }
    if (m.t === 'mapError' && m.id === id) return failed(m.code);
    return undefined;
  });
}

export function likeMap(id: string, like: boolean): Promise<MapMeta> {
  return ask(() => net.send({ t: 'mapLike', id, like }), ['mapUpdated', 'mapError'], (m) => {
    if (m.t === 'mapUpdated' && m.map.id === id) return m.map;
    if (m.t === 'mapError' && m.id === id) return failed(m.code);
    return undefined;
  });
}

export function deleteMap(id: string): Promise<void> {
  return ask(() => net.send({ t: 'mapDelete', id }), ['mapDeleted', 'mapError'], (m) => {
    if (m.t === 'mapDeleted' && m.id === id) {
      payloads.delete(id);
      setMine((mine.maps ?? []).filter((x) => x.id !== id));
      return true as const;
    }
    if (m.t === 'mapError' && m.id === id) return failed(m.code);
    return undefined;
  }).then(() => undefined);
}

export interface CommunityPage { maps: MapMeta[]; total: number; offset: number }

export function fetchCommunity(sort: MapSort, q: string, offset = 0): Promise<CommunityPage> {
  return ask(() => net.send({ t: 'communityMaps', sort, q, offset }), ['communityMaps', 'mapError'], (m) => {
    if (m.t === 'communityMaps' && m.sort === sort && m.q === q && m.offset === offset) return { maps: m.maps, total: m.total, offset: m.offset };
    if (m.t === 'mapError' && m.id === undefined && m.req === undefined) return failed(m.code);
    return undefined;
  });
}

// ---------------------------------------------------------------- the player's own maps

interface MineState {
  /** null until the server has answered once */
  maps: MapMeta[] | null;
  loading: boolean;
  error: MapFailure | null;
}

let mine: MineState = { maps: null, loading: false, error: null };
const subs = new Set<() => void>();
const emit = () => { for (const s of subs) s(); };
function setMine(maps: MapMeta[]) { mine = { maps, loading: false, error: null }; emit(); }
function upsertMine(m: MapMeta) {
  if (!m.mine || !mine.maps) return;
  const rest = mine.maps.filter((x) => x.id !== m.id);
  setMine([m, ...rest].sort((a, b) => b.updatedAt - a.updatedAt));
}

/** ask the server for the player's maps again (screens call it when they open) */
export function refreshMyMaps(): void {
  if (mine.loading) return;
  mine = { ...mine, loading: true, error: null };
  emit();
  ask(() => net.send({ t: 'myMaps' }), ['myMaps', 'mapError'], (m) => {
    if (m.t === 'myMaps') return m.maps;
    if (m.t === 'mapError' && m.id === undefined && m.req === undefined) return failed(m.code);
    return undefined;
  }).then(setMine, (e: MapRequestError) => { mine = { ...mine, loading: false, error: e.code }; emit(); });
}

// a sign-in or sign-out changes whose maps these are; a reconnect may have missed changes
net.on('account', () => { if (mine.maps) refreshMyMaps(); });
net.on('open', () => { if (mine.maps || mine.error) refreshMyMaps(); });

export function useMyMaps(): MineState {
  return useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => mine, () => mine);
}

export function myMapById(id: string): MapMeta | undefined { return mine.maps?.find((m) => m.id === id); }
