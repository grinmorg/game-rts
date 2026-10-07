import { CSSProperties, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { keyFromEvent } from '../game/keys';
import { TKey, useT } from '../i18n';
import { DEFAULT_HOTKEYS, Settings, getSettings, resetHotkeys, subscribeSettings, updateSettings } from '../settings';
import { useTouchUI } from '../touch';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
import { LeafHead, keyLabel } from './MainMenu';

/** every rebindable action under the context it works in (the order the command panel shows them) */
const GROUPS: { title: TKey; keys: string[] }[] = [
  { title: 'hkGroupUnits', keys: ['attackMove', 'stop', 'hold', 'patrol', 'ability'] },
  { title: 'hkGroupWorkers', keys: ['buildMenu', 'dismantle'] },
  { title: 'hkGroupBuild', keys: ['castle', 'house', 'barracks', 'forge', 'tower', 'wall', 'goldMine'] },
  { title: 'castle', keys: ['worker', 'ageUp', 'militia'] },
  { title: 'barracks', keys: ['soldier', 'archer', 'cavalry'] },
  { title: 'forge', keys: ['ram', 'catapult', 'upgMelee', 'upgRanged', 'upgArmor', 'upgSpeed', 'upgRange', 'upgGather'] },
  { title: 'hkGroupBuildings', keys: ['rally', 'eject'] },
  { title: 'hkGroupCamera', keys: ['selectArmy', 'idleWorker', 'rotateLeft', 'rotateRight', 'resetCamera', 'scrollUp', 'scrollDown', 'scrollLeft', 'scrollRight'] },
];
const LABELS: Record<string, TKey> = {
  attackMove: 'attackMove', stop: 'stop', hold: 'hold', patrol: 'patrol', ability: 'hkAbility', buildMenu: 'build', dismantle: 'dismantle',
  castle: 'castle', house: 'house', barracks: 'barracks', forge: 'forge', tower: 'tower', wall: 'wall', goldMine: 'goldMine',
  worker: 'worker', ageUp: 'ageUp', militia: 'militiaCall', soldier: 'soldier', archer: 'archer', cavalry: 'cavalry', ram: 'ram', catapult: 'catapult',
  upgMelee: 'meleeAttack', upgRanged: 'rangedAttack', upgArmor: 'armor', upgSpeed: 'moveSpeed', upgRange: 'range', upgGather: 'gatherSpeed',
  rally: 'rally', eject: 'eject', selectArmy: 'ctlArmy', idleWorker: 'ctlIdle', rotateLeft: 'hkRotateLeft', rotateRight: 'hkRotateRight',
  resetCamera: 'ctlResetCam', scrollUp: 'hkScrollUp', scrollDown: 'hkScrollDown', scrollLeft: 'hkScrollLeft', scrollRight: 'hkScrollRight',
};
/** `cancel` is not listed: Esc leaves a mode whatever the setting says */
const HIDDEN = new Set(['cancel']);
/** the bindings that answer at the same moment (one selection, one panel): two of them on one key is a conflict */
const CONTEXTS: string[][] = [
  ['attackMove', 'stop', 'hold', 'patrol', 'buildMenu', 'dismantle', 'ability'],
  ['castle', 'house', 'barracks', 'forge', 'tower', 'wall', 'goldMine'],
  ['worker', 'ageUp', 'militia', 'rally'],
  ['soldier', 'archer', 'cavalry', 'rally'],
  ['ram', 'catapult', 'upgMelee', 'upgRanged', 'upgArmor', 'upgSpeed', 'upgRange', 'upgGather', 'rally'],
  ['scrollUp', 'scrollDown', 'scrollLeft', 'scrollRight'],
];
/** checked before any command, so they take their key away from every other binding */
const GLOBAL = ['selectArmy', 'idleWorker', 'rotateLeft', 'rotateRight', 'resetCamera'];
/** keys the game keeps: Esc (menu, cancel), Enter (chat), Tab, digits (control groups) */
const RESERVED = /^(Escape|Enter|Tab|[0-9])$/;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** action → what it collides with: another action, or '' for a key the game keeps for itself */
function findConflicts(hk: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const mark = (a: string, b: string) => { if (!out.has(a)) out.set(a, b); };
  for (const ctx of CONTEXTS) {
    for (let i = 0; i < ctx.length; i++) for (let j = i + 1; j < ctx.length; j++) {
      if (same(hk[ctx[i]], hk[ctx[j]])) { mark(ctx[i], ctx[j]); mark(ctx[j], ctx[i]); }
    }
  }
  const all = Object.keys(hk).filter((k) => !HIDDEN.has(k));
  for (const g of GLOBAL) for (const o of all) if (o !== g && same(hk[g], hk[o])) { mark(g, o); mark(o, g); }
  for (const a of all) if (RESERVED.test(hk[a] ?? '')) mark(a, '');
  return out;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** a settings line: the name (with an optional hint under it), a dotted leader, the control */
function Row({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`ledger__row set-row${wide ? ' set-row--wide' : ''}`}>
      <label className="ledger__name set-row__name" htmlFor={id}>
        {label}
        {hint && <span className="set-row__hint">{hint}</span>}
      </label>
      <span className="ledger__dots" />
      <span className="ledger__value set-row__ctl">{children}</span>
    </div>
  );
}

function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <input id={id} type="checkbox" className="toggle" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

function Ruler({ id, min, max, step, value, text, onChange }: { id: string; min: number; max: number; step?: number; value: number; text: string; onChange: (v: number) => void }) {
  return (
    <span className="ruler-row set-ruler">
      <input
        id={id} type="range" className="ruler" min={min} max={max} step={step} value={value} aria-valuetext={text}
        style={{ '--v': (value - min) / (max - min) } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))}
      />
      <output className="ruler__value" htmlFor={id}>{text}</output>
    </span>
  );
}

function Section({ title, meta, className, children }: { title: string; meta?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`set-sec${className ? ` ${className}` : ''}`}>
      <div className="legend-head"><h2 className="legend-head__name">{title}</h2>{meta && <span className="legend-head__meta">{meta}</span>}</div>
      {children}
    </section>
  );
}

function Hotkeys({ s }: { s: Settings }) {
  const t = useT();
  const [listening, setListening] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [askReset, setAskReset] = useState(false);
  /** when the last key was taken: the Space that was just bound must not click the button into listening again */
  const boundAt = useRef(0);
  const label = (k: string) => (LABELS[k] ? t(LABELS[k]) : k);

  useEffect(() => {
    if (!listening) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Tab') { setListening(null); return; } // focus moves on: give up quietly
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(null); return; }
      if (MODIFIERS.has(e.key)) return; // a modifier alone is not a binding: wait for the key
      const key = keyFromEvent(e); // physical key, so a binding made on a Russian layout still reads as the Latin letter
      if (RESERVED.test(key)) { setRefused(true); return; }
      updateSettings({ hotkeys: { ...getSettings().hotkeys, [listening]: key } });
      boundAt.current = performance.now();
      setListening(null);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [listening]);
  useEffect(() => { setRefused(false); }, [listening]);

  const conflicts = findConflicts(s.hotkeys);
  const listed = new Set(GROUPS.flatMap((g) => g.keys));
  const extra = Object.keys(DEFAULT_HOTKEYS).filter((k) => !listed.has(k) && !HIDDEN.has(k));
  const groups = extra.length ? [...GROUPS, { title: 'more' as TKey, keys: extra }] : GROUPS;
  const isDefault = Object.keys(DEFAULT_HOTKEYS).every((k) => s.hotkeys[k] === DEFAULT_HOTKEYS[k]);

  const reset = askReset ? (
    <span className="hk-reset" role="group" aria-label={t('resetHotkeys')}>
      <span className="hk-reset__q">{t('hkResetAsk')}</span>
      <button type="button" className="btn btn--quiet btn--small" onClick={() => setAskReset(false)}>{t('cancel')}</button>
      <button type="button" className="btn btn--secondary btn--small" onClick={() => { resetHotkeys(); setAskReset(false); }}>{t('hkResetYes')}</button>
    </span>
  ) : (
    <button type="button" className="btn btn--quiet btn--small" disabled={isDefault} onClick={() => setAskReset(true)}><Icon name="undo" />{t('resetHotkeys')}</button>
  );

  return (
    <Section title={t('hotkeys')} meta={reset} className="set-sec--hotkeys">
      <p className="hk-hint">{t('setHotkeysHint')}</p>
      <div className="hk-groups">
        {groups.map((g) => (
          <div key={g.title} className="hk-group">
            <h3 className="hk-group__title">{t(g.title)}</h3>
            <div className="ledger ledger--dense">
              {g.keys.map((k) => {
                const on = listening === k;
                const clash = conflicts.get(k);
                const note = on && refused ? t('hkTakenNote') : clash === undefined ? '' : clash ? t('hkSameAs', { name: label(clash) }) : t('hkTaken');
                return (
                  <div key={k} className={`ledger__row hk-row${clash !== undefined ? ' is-conflict' : ''}`}>
                    <span className="ledger__name hk-row__name">
                      {label(k)}
                      {note && <span className="hk-row__note">{note}</span>}
                    </span>
                    <span className="ledger__dots" />
                    <button
                      type="button" className={`btn btn--quiet btn--small hk-key${on ? ' is-listening' : ''}`}
                      aria-label={`${t('hkChange', { name: label(k) })}: ${keyLabel(s.hotkeys[k], t)}`}
                      onClick={() => { if (performance.now() - boundAt.current > 400) setListening(on ? null : k); }} onBlur={() => { if (on) setListening(null); }}
                    >
                      {on ? <span className="hk-key__wait">{t('pressKey')}</span> : <kbd className="keycap">{keyLabel(s.hotkeys[k], t)}</kbd>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function SettingsScreen({ back }: { back: () => void }) {
  const t = useT();
  const touch = useTouchUI();
  const ids = useId();
  const titleId = `${ids}-title`;
  const [, force] = useState(0);
  useEffect(() => subscribeSettings(() => force((n) => n + 1)), []);
  const s = getSettings();
  const id = (k: string) => `${ids}-${k}`;

  return (
    <div className="screen leaf-screen">
      <MenuBackground />
      <section className="sheet sheet--framed leaf settings" aria-labelledby={titleId}>
        <LeafHead title={t('settings')} sub={t('setSub')} back={back} titleId={titleId} />
        <div className="leaf__body">
          <div className="set-grid">
            <Section title={t('setSecGame')}>
              <div className="ledger ledger--dense">
                <Row id={id('lang')} label={t('language')} wide>
                  <select id={id('lang')} className="select" value={s.lang} onChange={(e) => updateSettings({ lang: e.target.value as 'en' | 'ru' })}>
                    <option value="en" lang="en">English</option><option value="ru" lang="ru">Русский</option>
                  </select>
                </Row>
                <Row id={id('hp')} label={t('healthBars')} wide>
                  <select id={id('hp')} className="select" value={s.showHealthBars} onChange={(e) => updateSettings({ showHealthBars: e.target.value as Settings['showHealthBars'] })}>
                    <option value="damaged">{cap(t('damaged'))}</option><option value="always">{cap(t('always'))}</option><option value="selected">{cap(t('selected'))}</option>
                  </select>
                </Row>
                <Row id={id('cb')} label={t('setColorblind')} hint={t('setColorblindHint')}>
                  <Toggle id={id('cb')} checked={s.colorblind} onChange={(v) => updateSettings({ colorblind: v })} />
                </Row>
              </div>
            </Section>

            <Section title={t('setSecControls')}>
              <div className="ledger ledger--dense">
                <Row id={id('touch')} label={t('touchControls')} wide>
                  <select id={id('touch')} className="select" value={s.touchUI} onChange={(e) => updateSettings({ touchUI: e.target.value as Settings['touchUI'] })}>
                    <option value="auto">{cap(t('touchAuto'))}</option><option value="on">{cap(t('touchOn'))}</option><option value="off">{cap(t('touchOff'))}</option>
                  </select>
                </Row>
                <Row id={id('scroll')} label={t('scrollSpeed')} wide>
                  <Ruler id={id('scroll')} min={15} max={90} value={s.scrollSpeed} text={String(s.scrollSpeed)} onChange={(v) => updateSettings({ scrollSpeed: v })} />
                </Row>
                <Row id={id('edge')} label={t('edgeScroll')}>
                  <Toggle id={id('edge')} checked={s.edgeScroll} onChange={(v) => updateSettings({ edgeScroll: v })} />
                </Row>
                <Row id={id('rmb')} label={t('rmbPan')}>
                  <Toggle id={id('rmb')} checked={s.rmbPan} onChange={(v) => updateSettings({ rmbPan: v })} />
                </Row>
              </div>
            </Section>

            <Section title={t('setSecScreen')}>
              <div className="ledger ledger--dense">
                <Row id={id('hud')} label={t('hudScale')} wide>
                  <Ruler id={id('hud')} min={0.8} max={1.4} step={0.05} value={s.hudScale} text={`${Math.round(s.hudScale * 100)}%`} onChange={(v) => updateSettings({ hudScale: v })} />
                </Row>
                <Row id={id('shadows')} label={t('shadows')}>
                  <Toggle id={id('shadows')} checked={s.shadows} onChange={(v) => updateSettings({ shadows: v })} />
                </Row>
              </div>
            </Section>

            <Section title={t('setSecSound')}>
              <div className="ledger ledger--dense">
                <Row id={id('vol')} label={t('volume')} wide>
                  <Ruler id={id('vol')} min={0} max={1} step={0.05} value={s.volume} text={`${Math.round(s.volume * 100)}%`} onChange={(v) => updateSettings({ volume: v })} />
                </Row>
              </div>
            </Section>
          </div>

          {/* a keyboard is what these are for: the touch UI has no use for them */}
          {!touch && <Hotkeys s={s} />}
        </div>
      </section>
    </div>
  );
}
