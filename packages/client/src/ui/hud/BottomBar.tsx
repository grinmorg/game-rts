import { useT } from '../../i18n';
import { GameView, HudState, PanelButton } from '../../game/view';
import { getSettings } from '../../settings';
import { Icon } from '../icons/Icon';
import { CmdButton } from './CmdButton';
import { CommandTip } from './CommandTip';
import { Minimap } from './Minimap';
import { SelectionCard } from './SelectionCard';

const COLS = 5;
/** the way out of a mode or a site always sits in the same corner socket */
const PINNED_LAST = new Set(['cancel', 'cancelBuild']);

/**
 * The command grid's sockets: 5 columns, always whole (an empty socket is drawn, not left blank), the cancel order pinned
 * to the bottom-right one. With a mouse the grid keeps two rows and fills from the top-left, the way hotkeys are learnt.
 * On touch the last row is pushed to the right - into the thumb - and on a phone held sideways the grid has only the rows
 * it needs, hugging the bottom edge.
 */
function arrange(panel: PanelButton[], touch: boolean, phone: boolean): (PanelButton | null)[] {
  const pinned = panel.filter((b) => PINNED_LAST.has(b.id));
  const rest = panel.filter((b) => !PINNED_LAST.has(b.id));
  const rows = Math.max(phone ? 1 : 2, Math.ceil(panel.length / COLS));
  const cells: (PanelButton | null)[] = new Array(rows * COLS).fill(null);
  let end = cells.length;
  for (let i = pinned.length - 1; i >= 0; i--) cells[--end] = pinned[i];
  if (!touch) { rest.forEach((b, i) => { cells[i] = b; }); return cells; }
  const above = Math.min(rest.length, (rows - 1) * COLS);
  rest.slice(0, above).forEach((b, i) => { cells[i] = b; });
  const tail = rest.slice(above);
  tail.forEach((b, i) => { cells[end - tail.length + i] = b; });
  return cells;
}

/**
 * The two bottom corners: the minimap bottom-left; bottom-right the selection card (only when something is selected) and
 * the command grid with its card above it. `tip` is the command whose card is up, `onTip` names a new one.
 */
export function BottomBar({ hud, view, touch, isReplay, tip, onTip }: {
  hud: HudState; view: GameView; touch: boolean; isReplay: boolean; tip: PanelButton | null; onTip: (id: string | null) => void;
}) {
  const t = useT();
  const sel = hud.selection;
  const spectator = hud.mySlot < 0 || isReplay;
  const hk = getSettings().hotkeys;
  // the phone layout (hud-touch.css, max-height 560): innerHeight needs no layout, and the HUD re-renders 10 times a second
  const phone = touch && window.innerHeight <= 560;
  return (
    <>
      <div className="hud-bl">
        <Minimap view={view} yaw={hud.camYaw} />
      </div>
      <div className="hud-br">
        {sel && <SelectionCard sel={sel} view={view} />}
        {!sel && !touch && (spectator
          ? <p className="hud-note"><Icon name="eye" />{t('hudSpectatorNote')}</p>
          : !hud.panel.length && <p className="hud-note">{t('hudIdleHint', { army: hk.selectArmy, idle: hk.idleWorker })}</p>)}
        {hud.panel.length > 0 && (
          <div className="hud-cmds">
            {tip && <CommandTip tip={tip} onClose={touch ? () => onTip(null) : undefined} />}
            <div className="cmd-panel" role="toolbar" aria-label={t('hudCommands')} onMouseLeave={() => { if (!touch) onTip(null); }}
              onBlur={(e) => { if (!touch && !e.currentTarget.contains(e.relatedTarget as Node | null)) onTip(null); }}>
              {arrange(hud.panel, touch, phone).map((b, i) => (b
                ? <CmdButton key={b.id} b={b} touch={touch} showKey={!touch} onTip={onTip} onAction={() => view.panelAction(b.id)} />
                : <span key={`socket-${i}`} className="cmd-socket" aria-hidden="true" />))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
