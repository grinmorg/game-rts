import { CSSProperties, useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { GameView } from '../../game/view';
import { buzz } from '../../touch';

/**
 * The minimap in its graduated frame (the border of a map, and only of a map), with a compass needle on the corner that
 * turns with the camera and puts it back to north on a click - the only camera reset a finger has.
 *
 * The canvas is registered with the view once and its backing store follows its on-screen size (HUD scale, phone
 * layout). It answers a finger the way it answers a mouse: a tap or a drag walks the camera around, and the long press
 * that gives orders everywhere else sends the selection to that spot.
 */
export function Minimap({ view, yaw }: { view: GameView; yaw: number }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    view.setMinimapCanvas(c);
    if (!c || typeof ResizeObserver === 'undefined') return () => view.setMinimapCanvas(null);
    const ro = new ResizeObserver((entries) => { for (const e of entries) view.setMinimapSize(e.contentRect.width); });
    ro.observe(c);
    return () => { ro.disconnect(); view.setMinimapCanvas(null); };
  }, [view]);

  const mm = useRef({ timer: 0, x: 0, y: 0, ordered: false, down: false });
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = at(e);
    mm.current = { timer: 0, x: p.x, y: p.y, ordered: false, down: true };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType !== 'touch') { view.minimapClick(p.x, p.y, e.button, e.shiftKey); return; }
    view.minimapClick(p.x, p.y, 0, false);
    mm.current.timer = window.setTimeout(() => {
      mm.current.ordered = true;
      buzz();
      view.minimapOrder(mm.current.x, mm.current.y);
    }, 420);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!mm.current.down) return;
    const p = at(e);
    if (Math.hypot(p.x - mm.current.x, p.y - mm.current.y) > 0.03 && mm.current.timer) { clearTimeout(mm.current.timer); mm.current.timer = 0; }
    mm.current.x = p.x; mm.current.y = p.y;
    if (!mm.current.ordered && (e.pointerType === 'touch' || e.buttons === 1)) view.minimapClick(p.x, p.y, 0, false);
  };
  const up = () => {
    if (mm.current.timer) clearTimeout(mm.current.timer);
    mm.current = { timer: 0, x: 0, y: 0, ordered: false, down: false };
  };

  return (
    <div className="minimap-wrap" onContextMenu={(e) => e.preventDefault()}>
      <div className="graduated hud-mm-frame">
        <canvas ref={ref} width={180} height={180} aria-label={t('hudMinimap')}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
      <button className="hud-north" onClick={() => view.camera('reset')} title={t('hudCompass')} aria-label={t('hudCompass')}>
        <span className="hud-north__needle" style={{ '--yaw': `${yaw}rad` } as CSSProperties} />
      </button>
    </div>
  );
}
