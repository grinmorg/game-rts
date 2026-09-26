import { MatchSummary, ReplayData, ReplayPlayer, Simulation, SummaryRecorder, TICK_RATE, mapForSetup } from '@rookfall/sim';
import { isTouchUI } from '../touch';

/**
 * A link to a replay on the server: `/?replay=<id>` plays the match from the start, `&m=<n>` opens its
 * n-th battle (MatchSummary.battles) and `&t=<s>` a moment on the match clock - the one the HUD shows,
 * which counts real seconds whatever the match speed.
 */
export interface ReplayLink { id: string; m?: number; t?: number }

/** how a replay is opened: where it starts, what the camera looks at, what the banner says */
export interface ReplayLaunch {
  /** start playing at this tick */
  from?: number;
  /** centre the camera here (map cells) */
  focus?: { x: number; y: number };
  /** the battle being shown (index into summary.battles): the banner names it and offers to watch it again */
  battle?: number;
  /** the server's copy, so a share needs no upload */
  serverId?: string;
  /** the copy in this browser's saved replays, to remember an upload against */
  localId?: string;
  /** opened from a shared link: the banner offers the game itself */
  fromLink?: boolean;
  /** playback speed and point of view, carried over when a jump back restarts the replay */
  speed?: number;
  perspective?: number;
}

export function parseReplayLink(search: string): ReplayLink | null {
  const q = new URLSearchParams(search);
  const id = (q.get('replay') ?? '').replace(/[^a-z0-9-]/gi, '');
  if (!id) return null;
  const link: ReplayLink = { id };
  const m = Number(q.get('m')), t = Number(q.get('t'));
  if (q.has('m') && Number.isInteger(m) && m >= 0) link.m = m;
  else if (q.has('t') && Number.isFinite(t) && t >= 0) link.t = Math.floor(t);
  return link;
}

export function replayLink(link: ReplayLink): string {
  const q = new URLSearchParams({ replay: link.id });
  if (link.m !== undefined) q.set('m', String(link.m));
  else if (link.t !== undefined) q.set('t', String(Math.floor(link.t)));
  return `${location.origin}/?${q}`;
}

/** the match clock (seconds) at a tick, and back */
export const clockSeconds = (tick: number, speed = 1) => Math.floor(tick / (TICK_RATE * (speed || 1)));
export const clockTick = (seconds: number, speed = 1) => Math.floor(seconds * TICK_RATE * (speed || 1));

/** drop ?replay=… from the address bar once the viewer has left it, so a reload lands in the menu */
export function forgetReplayLink(): void {
  const q = new URLSearchParams(location.search);
  if (!q.has('replay')) return;
  for (const k of ['replay', 'm', 't']) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
}

export type FetchError = 'notFound' | 'network';

export async function fetchReplay(id: string): Promise<ReplayData | FetchError> {
  try {
    const r = await fetch(`/api/replays/${encodeURIComponent(id)}`);
    if (r.status === 404) return 'notFound';
    if (!r.ok) return 'network';
    return (await r.json()) as ReplayData;
  } catch { return 'network'; }
}

export type UploadError = 'tooMany' | 'tooBig' | 'invalid' | 'network';

/** send a replay the server does not have (a skirmish) and get the id a link can point at */
export async function uploadReplay(data: ReplayData): Promise<{ id: string } | { error: UploadError }> {
  try {
    const r = await fetch('/api/replays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = (await r.json().catch(() => ({}))) as { id?: string; error?: UploadError };
    if (r.ok && body.id) return { id: body.id };
    return { error: body.error ?? (r.status === 429 ? 'tooMany' : r.status === 413 ? 'tooBig' : 'network') };
  } catch { return { error: 'network' }; }
}

/**
 * Hand a link over: the share sheet on a phone, where it goes straight to a messenger, the clipboard
 * elsewhere. 'manual' means neither worked (an http page has no clipboard) and the link has to be shown.
 */
export async function shareUrl(url: string, title: string): Promise<'shared' | 'copied' | 'manual'> {
  const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
  if (isTouchUI() && nav.share) {
    try { await nav.share({ title, url }); return 'shared'; } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return 'shared'; // the player closed the sheet: nothing to report
    }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return 'manual'; }
}

/**
 * The summary of a recording that came without one (made before summaries existed): the whole match is
 * played through headless, a slice at a time so the page can show progress. Only for a replay this build
 * can play back - on other rules the numbers would describe a different match.
 */
export async function computeSummary(data: ReplayData, onProgress?: (done: number) => void): Promise<MatchSummary> {
  const sim = new Simulation(data.setup, mapForSetup(data.setup));
  const rec = new SummaryRecorder(sim);
  const player = new ReplayPlayer(data);
  while (sim.tick < data.tickCount && !sim.gameOver) {
    const t0 = performance.now();
    while (sim.tick < data.tickCount && !sim.gameOver && performance.now() - t0 < 24) {
      sim.step(player.commandsFor(sim.tick + 1));
      rec.observe(sim);
    }
    onProgress?.(sim.tick / Math.max(1, data.tickCount));
    await new Promise((r) => setTimeout(r, 0));
  }
  return rec.finish(sim);
}
