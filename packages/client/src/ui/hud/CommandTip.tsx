import { Fragment } from 'react';
import { TICK_RATE } from '@pocket-of-empire/sim';
import { useT } from '../../i18n';
import { PanelButton } from '../../game/view';
import { Icon } from '../icons/Icon';
import { keyCap } from './CmdButton';

/**
 * The card above the command grid: the name and its key, what it costs (gold, time, population), then what it needs -
 * the unmet lines first, in madder, because they are why a tile is grey - then the numbers and what the thing does.
 * A met price is not repeated: the cost line already says it. On touch the card is a popover a tap puts away.
 */
export function CommandTip({ tip, onClose }: { tip: PanelButton; onClose?: () => void }) {
  const t = useT();
  const reqs = (tip.reqs ?? []).filter((r) => !(r.ok && r.gold)).sort((a, b) => Number(a.ok) - Number(b.ok));
  const hasCost = tip.cost !== undefined || !!tip.time || !!tip.pop;
  return (
    <div className={`tip hud-tip${onClose ? ' is-pop' : ''}`} role="tooltip" onClick={onClose}>
      <div className="tip__head">
        <span className="tip__name">{tip.title ?? tip.label}</span>
        {tip.key && !onClose && <kbd className="keycap">{keyCap(tip.key)}</kbd>}
        {onClose && <span className="hud-tip__x" aria-hidden="true"><Icon name="close" /></span>}
      </div>
      {hasCost && (
        <div className="tip__cost">
          {tip.cost !== undefined && <span className={`tip__gold${tip.costOk === false ? ' is-short' : ''}`}><Icon name="gold" />{tip.cost}</span>}
          {tip.time ? <span><Icon name="timer" />{Math.round(tip.time / TICK_RATE)} {t('sec')}</span> : null}
          {tip.pop ? <span title={t('hudPopulation')}><Icon name="population" />{tip.pop}</span> : null}
        </div>
      )}
      {reqs.length > 0 && (
        <ul className="tip__req">
          {reqs.map((r, i) => <li key={i} className={r.ok ? undefined : 'no'}><Icon name={r.ok ? 'check' : 'cross'} />{r.text}</li>)}
        </ul>
      )}
      {tip.stats && tip.stats.length > 0 && (
        <dl className="tip__stats">
          {tip.stats.map((s) => (
            <Fragment key={s.k}>
              <dt>{s.k}</dt>
              <dd>{s.v}{s.note && <small> {s.note}</small>}{s.icon && <Icon name={s.icon} />}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {tip.desc && <p className="tip__desc">{tip.desc}</p>}
    </div>
  );
}
