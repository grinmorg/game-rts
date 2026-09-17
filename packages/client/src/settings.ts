export type Lang = 'en' | 'ru';

export interface Settings {
  lang: Lang;
  name: string;
  scrollSpeed: number;
  hudScale: number;
  colorblind: boolean;
  volume: number;
  shadows: boolean;
  edgeScroll: boolean;
  rmbRotate: boolean;
  showHealthBars: 'damaged' | 'always' | 'selected';
  hotkeys: Record<string, string>;
}

export const DEFAULT_HOTKEYS: Record<string, string> = {
  attackMove: 'a', stop: 's', hold: 'h', patrol: 'p',
  buildMenu: 'b', castle: 'c', house: 'h', barracks: 'b', forge: 'f', tower: 't', wall: 'l', goldMine: 'm', eject: 'u', dismantle: 'x', ageUp: 'i',
  worker: 'w', soldier: 's', archer: 'r', catapult: 'c', cavalry: 'v', rally: 'r', ability: 'd', militia: 'm', cancel: 'Escape',
  selectArmy: 'F1', idleWorker: 'F2', rotateLeft: 'q', rotateRight: 'e', resetCamera: 'Backspace',
  scrollUp: 'w', scrollDown: 's', scrollLeft: 'a', scrollRight: 'd',
  upgMelee: 'z', upgRanged: 'x', upgArmor: 'v', upgSpeed: 'n', upgRange: 'g', upgGather: 'j',
};

const KEY = 'rookfall.settings';

function detectLang(): Lang {
  const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
  return l.startsWith('ru') ? 'ru' : 'en';
}

function defaults(): Settings {
  return {
    lang: detectLang(),
    name: `Guest${1000 + Math.floor(Math.random() * 9000)}`,
    scrollSpeed: 40,
    hudScale: 1,
    colorblind: false,
    volume: 0.5,
    shadows: true,
    edgeScroll: true,
    rmbRotate: true,
    showHealthBars: 'damaged',
    hotkeys: { ...DEFAULT_HOTKEYS },
  };
}

let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    return { ...d, ...s, hotkeys: { ...d.hotkeys, ...(s.hotkeys ?? {}) } };
  } catch {
    return d;
  }
}

export function getSettings(): Settings { return current; }

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* ignore */ }
  document.documentElement.style.setProperty('--hud-scale', String(current.hudScale));
  for (const l of listeners) l();
}

export function resetHotkeys(): void { updateSettings({ hotkeys: { ...DEFAULT_HOTKEYS } }); }

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

if (typeof document !== 'undefined') document.documentElement.style.setProperty('--hud-scale', String(current.hudScale));

/**
 * Reconnect token. Kept in sessionStorage so it survives a page reload in the same tab but two tabs
 * of the same browser get separate identities (otherwise a second tab would hijack the first one).
 */

/**
 * Ladder identity. Unlike the reconnect token this lives in localStorage, so the rating follows the
 * browser across tabs and sessions - it is the only thing tying a guest to their ranked profile, and it
 * never leaves this browser except as the `playerKey` of the hello message.
 *
 * `?profile=<name>` keeps a separate key under the same browser, which is how you get two ladder accounts
 * for a local 1v1 test (the matchmaker refuses to pair a profile with itself).
 */
export function getPlayerKey(): string {
  const suffix = new URLSearchParams(location.search).get('profile')?.replace(/[^a-z0-9]/gi, '').slice(0, 12) ?? '';
  const key = `rookfall.playerKey${suffix ? `.${suffix}` : ''}`;
  try {
    let v = localStorage.getItem(key);
    if (!v) {
      v = `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      localStorage.setItem(key, v);
    }
    return v;
  } catch {
    // private mode without storage: a throwaway key, so the session simply plays unranked-but-rated-once
    return `temp${Math.random().toString(36).slice(2, 14)}`;
  }
}

export function getToken(): string | undefined {
  try { return sessionStorage.getItem('rookfall.token') ?? undefined; } catch { return undefined; }
}
export function setToken(t: string): void {
  try { sessionStorage.setItem('rookfall.token', t); } catch { /* ignore */ }
}
