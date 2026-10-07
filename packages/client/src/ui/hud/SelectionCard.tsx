import { CSSProperties } from 'react';
import { TICK_RATE } from '@pocket-of-empire/sim';
import { useT } from '../../i18n';
import { GameView, HudState } from '../../game/view';
import { Icon } from '../icons/Icon';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const ROMAN = ['I', 'II', 'III'];
/** the HP bar's colour band: the same thresholds as the bars over the units */
const band = (f: number) => (f < 0.3 ? ' crit' : f < 0.6 ? ' low' : '');

/**
 * The card of what is selected, drawn only when something is. One thing: its portrait (the unit's own picture or the
 * building's sign) with the owner's pennant, the name, health on a graduated bar, the numbers that matter with their legend
 * signs, then whatever it is doing - its queue (a click cancels an order), construction, the workers inside, the forge's
 * levels - and a hint when the player has to act. Several units: the whole group's health, and one tile per kind with its
 * count and health (a click keeps only that kind).
 */
export function SelectionCard({ sel, view }: { sel: NonNullable<HudState['selection']>; view: GameView }) {
  const t = useT();
  const p = sel.primary;
  const multi = !!sel.total;
  const mixed = sel.groups.length > 1;
  const hp = sel.total ? sel.total.hp : p.hp;
  const maxHp = sel.total ? sel.total.maxHp : p.maxHp;
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const owned = p.owner >= 0;
  const queue = p.queue ?? [];
  const showQueue = !!p.queueMax && p.progress === undefined && (queue.length > 0 || !sel.foreign);
  const sub = p.kind === 'building' ? t('hudBuildingAge', { age: ROMAN[p.age ?? 0] ?? 'I' })
    : p.kind === 'mine' ? t('goldLeft')
    : p.kind === 'unit' && !owned ? p.ownerName : '';
  const owner = owned && (sel.foreign || !multi) ? (
    <span className="sel-owner" style={{ '--team': hex(p.color) } as CSSProperties}><span className="hud-pennant" aria-hidden="true" /><span className="sel-owner__name">{p.ownerName}</span></span>
  ) : null;

  const stats = mixed ? [] : (p.stats ?? []);
  const cls = `sel-panel hud-card${multi ? ' is-multi' : ''}${mixed ? ' is-mixed' : ''}${showQueue && queue.length ? ' has-queue' : ''}${p.hint ? ' has-hint' : ''}`;
  return (
    <section className={cls} aria-label={t('hudSelected')}>
      {!mixed && (
        <div className="sel-portrait" style={{ '--team': hex(p.color) } as CSSProperties}>
          {p.art ? <span className="art" style={{ backgroundImage: `url(${p.art})` }} /> : <Icon name={p.icon} />}
          {owner}
        </div>
      )}
      <div className="sel-info">
        <div className="sel-title">
          <h4>{mixed ? t('hudSquad') : p.name}</h4>
          {multi && <b className="sel-count">×{sel.total!.count}</b>}
          {sub && <span className="sel-sub">{sub}</span>}
          {sel.foreign && owner && <span className="sel-owner-inline">{owner}</span>}
        </div>

        {p.kind === 'mine' ? (
          <div className="sel-hp is-gold" title={t('goldLeft')}>
            <div className="hpbar"><div style={{ width: `${frac * 100}%` }} /></div>
            <b className="sel-num">{p.goldLeft}<small> / {p.maxHp}</small></b>
          </div>
        ) : (
          <div className="sel-hp" title={t('hp')}>
            <div className={`hpbar${band(frac)}`}><div style={{ width: `${frac * 100}%` }} /></div>
            <b className="sel-num">{hp}<small> / {maxHp}</small></b>
          </div>
        )}

        {p.progress !== undefined && (
          <div className="sel-prog">
            <span>{p.dismantling ? t('dismantling') : t('constructing')}</span>
            <div className="bar"><div style={{ width: `${Math.round(p.progress * 100)}%` }} /></div>
            <b className="sel-num">{Math.round(p.progress * 100)}%</b>
          </div>
        )}

        {(stats.length > 0 || p.carry || p.garrison || (p.abilityName && !multi) || p.buff) ? (
          <div className="sel-stats">
            {stats.map((s) => (
              <span key={s.k}>{s.lead && <Icon name={s.lead} />}{s.k} <b>{s.v}</b>{s.note && <small>{s.note}</small>}</span>
            ))}
            {!multi && p.carry ? <span><Icon name="gold" />{t('carrying')} <b>{p.carry}</b></span> : null}
            {p.garrison && <span><Icon name="unit-worker" />{t('workersInside')} <b>{p.garrison.n}/{p.garrison.max}</b></span>}
            {!multi && p.abilityName && p.abilityCd !== undefined && (
              <span><Icon name={p.abilityCd > 0 ? 'timer' : 'check'} />{p.abilityName} <b>{p.abilityCd > 0 ? `${Math.ceil(p.abilityCd / TICK_RATE)} ${t('sec')}` : t('hudReady')}</b></span>
            )}
            {p.buff ? (
              <span className={p.kind === 'building' ? 'is-warn' : undefined}>
                <Icon name={p.kind === 'building' ? 'warning' : 'abl-shield'} />
                {p.kind === 'building' ? t('siteSlowed') : p.abilityName} <b>{Math.ceil(p.buff / TICK_RATE)} {t('sec')}</b>
              </span>
            ) : null}
          </div>
        ) : null}

        {p.upgrades && (
          <div className="sel-upg">
            {p.upgrades.map((u, i) => <span key={i} title={`${u.name}: ${u.level}`}><Icon name={u.icon} /><b>{u.level}</b></span>)}
          </div>
        )}

        {showQueue && (
          <div className="sel-queue">
            <span className="sel-lbl">{t('hudQueue')}</span>
            {Array.from({ length: p.queueMax! }, (_, i) => {
              const q = queue[i];
              if (!q) return <span key={i} className="queue-item is-ghost" aria-hidden="true" />;
              return (
                <button key={i} className={`queue-item${i > 0 ? ' is-wait' : ''}`} title={t('hudCancelOrder', { name: q.label })} aria-label={t('hudCancelOrder', { name: q.label })}
                  onClick={() => view.panelAction(`cancelQueue:${i}`)}>
                  {q.art ? <span className="art" style={{ backgroundImage: `url(${q.art})` }} /> : <Icon name={q.icon} />}
                  {i === 0 && <span className="prog" style={{ width: `${Math.round(q.progress * 100)}%` }} />}
                  <span className="queue-x" aria-hidden="true"><Icon name="close" /></span>
                </button>
              );
            })}
            {queue[0]?.left !== undefined && <b className="sel-eta">{Math.max(1, Math.ceil(queue[0].left / TICK_RATE))}<small> {t('sec')}</small></b>}
          </div>
        )}

        {mixed && (
          <div className="sel-units">
            {sel.groups.map((g) => (
              <button key={g.type} className="sel-unit" title={`${g.label} ×${g.count}`} aria-label={`${g.label} ×${g.count}`} onClick={() => view.selectGroup(g.ids)}>
                {g.art ? <span className="art" style={{ backgroundImage: `url(${g.art})` }} /> : <Icon name={g.icon} />}
                <span className="n">{g.count}</span>
                <span className={`hp${band(g.hp)}`} style={{ width: `${Math.round(g.hp * 100)}%` }} />
              </button>
            ))}
          </div>
        )}

        {p.hint && <p className="sel-hint">{p.hint}</p>}
      </div>
    </section>
  );
}
