import { useSyncExternalStore } from 'react';
import { ReplayData } from '@rookfall/sim';

/** Minimal external store for small client-wide state. */
export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch: Partial<T> | ((s: T) => Partial<T>)) => {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const s of subs) s();
    },
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    use: <R,>(sel: (s: T) => R): R => useSyncExternalStore(subs.add.bind(subs) && ((fn) => { subs.add(fn); return () => subs.delete(fn); }), () => sel(state), () => sel(state)),
  };
}

// ---------------------------------------------------------------- local replays (localStorage)

const REPLAYS_KEY = 'rookfall.replays';
export interface LocalReplayMeta {
  id: string; mapId: string; players: string[]; ticks: number; winnerTeam: number; recordedAt: number; speed?: number;
  /** the map's name as recorded - the only name a player-made map has here */
  mapName?: string;
  /** simulation version it was recorded on */
  version?: number;
  /** the server's copy, once it has one (an online match, or a skirmish uploaded for a link) */
  serverId?: string;
}

export function listLocalReplays(): LocalReplayMeta[] {
  try {
    const raw = localStorage.getItem(REPLAYS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as { meta: LocalReplayMeta; data?: ReplayData }[];
    return arr.map((r) => ({ ...r.meta, version: r.meta.version ?? r.data?.version })).sort((a, b) => b.recordedAt - a.recordedAt);
  } catch { return []; }
}
export function loadLocalReplay(id: string): ReplayData | null {
  try {
    const arr = JSON.parse(localStorage.getItem(REPLAYS_KEY) ?? '[]') as { meta: LocalReplayMeta; data: ReplayData }[];
    return arr.find((r) => r.meta.id === id)?.data ?? null;
  } catch { return null; }
}
export function saveLocalReplay(data: ReplayData, serverId?: string): LocalReplayMeta {
  const id = data.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  data.id = id;
  const meta: LocalReplayMeta = { id, mapId: data.setup.mapId, mapName: data.mapName, players: data.setup.players.map((p) => p.name), ticks: data.tickCount, winnerTeam: data.result?.winnerTeam ?? -1, recordedAt: data.recordedAt || Date.now(), speed: data.setup.speed, version: data.version, serverId };
  try {
    const arr = JSON.parse(localStorage.getItem(REPLAYS_KEY) ?? '[]') as { meta: LocalReplayMeta; data: ReplayData }[];
    arr.unshift({ meta, data });
    // keep storage bounded (~3 MB)
    let json = JSON.stringify(arr);
    while (json.length > 3_000_000 && arr.length > 1) { arr.pop(); json = JSON.stringify(arr); }
    localStorage.setItem(REPLAYS_KEY, json);
  } catch { /* quota */ }
  return meta;
}
/** remember the server copy of a saved replay, so sharing it again reuses the link */
export function setLocalReplayServerId(id: string, serverId: string): void {
  try {
    const arr = JSON.parse(localStorage.getItem(REPLAYS_KEY) ?? '[]') as { meta: LocalReplayMeta }[];
    const r = arr.find((x) => x.meta.id === id);
    if (!r) return;
    r.meta.serverId = serverId;
    localStorage.setItem(REPLAYS_KEY, JSON.stringify(arr));
  } catch { /* quota */ }
}
export function deleteLocalReplay(id: string): void {
  try {
    const arr = JSON.parse(localStorage.getItem(REPLAYS_KEY) ?? '[]') as { meta: LocalReplayMeta }[];
    localStorage.setItem(REPLAYS_KEY, JSON.stringify(arr.filter((r) => r.meta.id !== id)));
  } catch { /* ignore */ }
}
export function downloadReplay(data: ReplayData): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rookfall-${data.setup.mapId}-${data.id ?? Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
