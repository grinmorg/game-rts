/** Toggle browser fullscreen for the whole page (the canvas resizes with the window). */
export function toggleFullscreen(): void {
  const d = document;
  if (d.fullscreenElement) { d.exitFullscreen().catch(() => { /* ignore */ }); return; }
  d.documentElement.requestFullscreen?.().catch(() => { /* ignore */ });
}
