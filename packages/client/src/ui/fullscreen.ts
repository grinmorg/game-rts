/** Toggle browser fullscreen for the whole page (the canvas resizes with the window). */
export function toggleFullscreen(): void {
  const d = document;
  if (d.fullscreenElement) { d.exitFullscreen().catch(() => { /* ignore */ }); return; }
  d.documentElement.requestFullscreen?.().catch(() => { /* ignore */ });
}

/**
 * Phones only: go fullscreen and ask for landscape on the first touch of a match. Browser chrome costs
 * about a fifth of a phone screen, which is the difference between a readable command panel and a cramped
 * one. Both calls need a user gesture and both are absent on iOS Safari, so every failure is ignored.
 */
export function enterGameFullscreen(): void {
  if (document.fullscreenElement) { lockLandscape(); return; }
  const p = document.documentElement.requestFullscreen?.();
  if (p) p.then(lockLandscape).catch(() => { /* not allowed here */ });
}

function lockLandscape(): void {
  const o = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
  try { o?.lock?.('landscape').catch(() => { /* desktop, or the browser says no */ }); } catch { /* ignore */ }
}

/** true on a phone-sized screen, where the fullscreen grab above is worth making */
export function isSmallScreen(): boolean {
  return Math.max(window.innerWidth, window.innerHeight) < 1180;
}
