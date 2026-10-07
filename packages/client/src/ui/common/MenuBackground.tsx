import { useEffect, useRef } from 'react';
import { startMenuScene } from '../../game/menuScene';

/**
 * One backdrop scene for all the menus. Every menu screen mounts <MenuBackground/>, but the WebGL canvas and its
 * scene live here, outside React: a screen that unmounts hands the canvas over to the next one, so moving between
 * menus neither flashes nor builds a new WebGL context. The scene stops a moment after the last menu is gone (a
 * match starting). Under reduced motion there is no scene at all: the night table behind the sheets stays still.
 */
const LINGER_MS = 1500;
let shared: { canvas: HTMLCanvasElement; stop: () => void; timer: ReturnType<typeof setTimeout> | undefined } | null = null;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animated background for menus: trees, rocks and catapults tumbling past (see startMenuScene). */
export function MenuBackground() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || reducedMotion()) return;
    if (shared) {
      clearTimeout(shared.timer);
      el.appendChild(shared.canvas);
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'menu-bg-canvas';
      el.appendChild(canvas); // attached first: the scene sizes itself from the canvas box
      shared = { canvas, stop: startMenuScene(canvas), timer: undefined };
    }
    const mine = shared;
    return () => {
      mine.canvas.remove();
      mine.timer = setTimeout(() => {
        if (shared !== mine || mine.canvas.isConnected) return;
        mine.stop();
        shared = null;
      }, LINGER_MS);
    };
  }, []);
  return <div ref={host} className="menu-bg" aria-hidden="true" />;
}
