import { useEffect, useState } from 'react';
import { getSettings, subscribeSettings } from './settings';

/**
 * Which set of controls the player is on. The HUD and the input controller both read it: on touch the
 * bottom bar shrinks, a tool column appears and the canvas listens for gestures instead of buttons.
 *
 * `auto` starts from the device's primary pointer and then follows whatever the player actually uses, so a
 * laptop with a touchscreen keeps the desktop HUD until a finger lands on it (and gets it back on the next
 * click of the mouse).
 */
let touch = detect();
const listeners = new Set<(v: boolean) => void>();

function detect(): boolean {
  const pinned = getSettings().touchUI;
  if (pinned === 'on') return true;
  if (pinned === 'off') return false;
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

function set(v: boolean): void {
  if (v === touch) return;
  touch = v;
  for (const l of listeners) l(v);
}

export function isTouchUI(): boolean { return touch; }

export function subscribeTouchUI(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Called from every pointerdown we see: the last device used wins while the setting is on `auto`. */
export function notePointerType(type: string): void {
  if (getSettings().touchUI !== 'auto') return;
  if (type === 'touch') set(true);
  else if (type === 'mouse' || type === 'pen') set(false);
}

/** Re-renders a component when the player switches between a mouse and a finger. */
export function useTouchUI(): boolean {
  const [v, set] = useState(isTouchUI);
  useEffect(() => subscribeTouchUI(set), []);
  return v;
}

/** True while the window is taller than it is wide - the shape Rookfall's HUD is not built for. */
export function usePortrait(): boolean {
  const [v, set] = useState(() => typeof window !== 'undefined' && window.innerHeight > window.innerWidth);
  useEffect(() => {
    const h = () => set(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', h);
    window.addEventListener('orientationchange', h);
    return () => { window.removeEventListener('resize', h); window.removeEventListener('orientationchange', h); };
  }, []);
  return v;
}

/** A short buzz for gestures that fire without a finger lift (long press, group assign). Silent where unsupported. */
export function buzz(ms = 12): void {
  try { navigator.vibrate?.(ms); } catch { /* ignore */ }
}

if (typeof window !== 'undefined') {
  subscribeSettings(() => set(detect()));
  window.addEventListener('pointerdown', (e) => notePointerType(e.pointerType), { capture: true, passive: true });
  window.matchMedia?.('(pointer: coarse)').addEventListener?.('change', () => set(detect()));
  document.documentElement.classList.toggle('touch-ui', touch);
  listeners.add((v) => document.documentElement.classList.toggle('touch-ui', v));
}
