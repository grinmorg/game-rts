import { CSSProperties, useEffect, useRef } from 'react';
import { TICK_RATE } from '@pocket-of-empire/sim';
import { PanelButton } from '../../game/view';
import { buzz } from '../../touch';
import { Icon } from '../icons/Icon';

/** the label a key cap shows: one letter in capitals, a named key spelled the short way */
export function keyCap(key: string): string {
  if (key === 'Escape') return 'Esc';
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * One tile of the command grid. The tile says as much as a glance can take: the key (mouse only), the price in gold - madder
 * with a lock when the purse is short - or a lock when something else is missing, the sign or the unit itself, and a short
 * name that always fits (the card keeps the full one).
 *
 * With a mouse the card follows the cursor; with a finger there is no hover, so the card comes up on a press-and-hold - and
 * immediately on a greyed-out tile, where "why can't I press this?" is the only thing the player wants to know.
 */
export function CmdButton({ b, touch, showKey, onTip, onAction }: { b: PanelButton; touch: boolean; showKey: boolean; onTip: (id: string | null) => void; onAction: () => void }) {
  // greyed out, but never `disabled`: a disabled button swallows hover, and its card - the one that says what is
  // missing - is exactly the one the player needs
  const off = !!b.disabled && !b.cooldown;
  const short = b.costOk === false;
  const hold = useRef({ timer: 0, fired: false });
  const stopHold = () => { if (hold.current.timer) { clearTimeout(hold.current.timer); hold.current.timer = 0; } };
  useEffect(() => stopHold, []);

  const down = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    hold.current.fired = false;
    hold.current.timer = window.setTimeout(() => { hold.current.timer = 0; hold.current.fired = true; buzz(); onTip(b.id); }, 320);
  };
  const click = () => {
    stopHold();
    if (hold.current.fired) return; // the hold already showed the card; do not also fire the order
    if (off) { onTip(b.id); return; }
    if (touch) onTip(null);
    onAction();
  };

  const cd = b.cooldown && b.cooldown > 0 ? b.cooldown : 0;
  const cls = `cmd-btn${b.art ? ' has-art' : ''}${b.active ? ' is-active' : ''}${off ? ' off' : ''}${short ? ' is-short' : ''}${b.locked ? ' is-locked' : ''}${cd ? ' is-cd' : ''}`;
  return (
    <button className={cls} aria-disabled={off || undefined} aria-label={b.title ?? b.label}
      aria-keyshortcuts={showKey && b.key ? b.key : undefined}
      onMouseEnter={() => { if (!touch) onTip(b.id); }}
      onFocus={() => { if (!touch) onTip(b.id); }}
      onPointerDown={down} onPointerUp={stopHold} onPointerCancel={stopHold} onPointerLeave={stopHold}
      onContextMenu={(e) => e.preventDefault()}
      onClick={click}>
      {showKey && b.key && <kbd className="cmd-key keycap">{keyCap(b.key)}</kbd>}
      {b.cost !== undefined
        ? <span className="cmd-cost">{(short || b.locked) && <Icon name="lock" />}{b.cost}</span>
        : b.locked && <span className="cmd-cost"><Icon name="lock" /></span>}
      {b.art ? <span className="art cmd-art" style={{ backgroundImage: `url(${b.art})` }} /> : <Icon name={b.icon} className="cmd-ico" />}
      <span className="label">{b.label}</span>
      {/* a forge line: its levels as a little scale bar along the foot of the tile */}
      {b.level && <span className="cmd-level" style={{ '--n': b.level.n, '--max': b.level.max } as CSSProperties} />}
      {cd > 0 && <span className="cmd-cd" style={{ '--cd': cd } as CSSProperties}>{b.cdLeft ? Math.ceil(b.cdLeft / TICK_RATE) : ''}</span>}
    </button>
  );
}
