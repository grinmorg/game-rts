import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { GAME_SPEEDS, MAX_PLAYERS, MatchSetup, PLAYER_COLORS, PlayerSetup, SIM_VERSION, customMapId } from '@pocket-of-empire/sim';
import { TKey, useT } from '../i18n';
import { fetchMapData } from '../net/maps';
import { getSettings } from '../settings';
import { MapPicker, PickedMap, mapMeta, officialPick } from './MapPicker';
import { MapPreview } from './MapPreview';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
import { mapErrorKey, sizeLabel } from './mapText';

/* =====================================================================================================
   Parts shared by the match setup screens (skirmish, room, ladder): the sheet header, the scale bar,
   the team picker, the pennant and the line-up text. Styles: styles/screens/setup.css.
   ===================================================================================================== */

export const DIFF_KEYS: TKey[] = ['easy', 'medium', 'hard'];
export const hexColor = (c: number) => '#' + c.toString(16).padStart(6, '0');
/** a team colour as the `--team` custom property (pennants read it) */
export const teamVar = (c: number) => ({ '--team': hexColor(c) }) as CSSProperties;

/** the header row of an inner screen: a quiet back note, the title, an italic line on the right */
export function SheetHead({ onBack, backLabel, title, sub }: { onBack: () => void; backLabel: string; title: ReactNode; sub?: ReactNode }) {
  return (
    <header className="setup-head">
      <button className="btn btn--quiet setup-head__back" onClick={onBack}><Icon name="back" />{backLabel}</button>
      {title}
      {sub && <p className="lede setup-head__sub">{sub}</p>}
    </header>
  );
}

/** Esc goes back from a menu screen - unless a dialog is open or the player is typing */
export function useEscapeBack(back: () => void, enabled = true): void {
  const fn = useRef(back);
  fn.current = back;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (document.querySelector('.overlay, .scrim, [role="dialog"]')) return;
      fn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * The scale bar (segmented choice, SPEC §4) as a radio group: arrows and Home/End move the choice, only the chosen
 * cell is in the tab order. `cellClass` adds a class to every cell (speed cells keep `speed-btn` for the scripts).
 */
export function ScaleBar<T extends string | number>({ options, value, onChange, label, disabled, className = '', cellClass, render }: {
  options: readonly T[]; value: T; onChange: (v: T) => void; label: string; disabled?: boolean;
  className?: string; cellClass?: string; render?: (v: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const at = options.indexOf(value);
  const onKey = (e: ReactKeyboardEvent) => {
    const n = options.length;
    const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + n) % n
        : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    onChange(options[j]);
    (ref.current?.children[j] as HTMLElement | undefined)?.focus();
  };
  return (
    <div ref={ref} className={`scalebar ${className}`} role="radiogroup" aria-label={label} onKeyDown={disabled ? undefined : onKey}>
      {options.map((o, i) => (
        <button
          key={String(o)} type="button" role="radio" aria-checked={o === value} tabIndex={i === Math.max(0, at) ? 0 : -1}
          className={cellClass} disabled={disabled} onClick={() => onChange(o)}
        >{render ? render(o) : String(o)}</button>
      ))}
    </div>
  );
}

/** a slot's team: a scale bar of team numbers on maps of up to four players, a select beyond that */
export function TeamPicker({ value, count, onChange, disabled }: { value: number; count: number; onChange: (team: number) => void; disabled?: boolean }) {
  const t = useT();
  if (count <= 4) {
    const opts = Array.from({ length: count }, (_, k) => k);
    return <ScaleBar className="scalebar--sm slot__team" options={opts} value={value} onChange={onChange} label={t('team')} disabled={disabled} render={(k) => k + 1} />;
  }
  return (
    <select className="select slot__team" aria-label={t('team')} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: count }, (_, k) => <option key={k} value={k}>{k + 1}</option>)}
    </select>
  );
}

/** "1 vs 1", "2 vs 2", or "free for all · 4" from the teams of the filled seats */
export function lineupText(t: (k: TKey) => string, teams: number[]): string {
  const sizes = new Map<number, number>();
  for (const x of teams) sizes.set(x, (sizes.get(x) ?? 0) + 1);
  const list = [...sizes.values()].sort((a, b) => b - a);
  if (list.length > 2 && list.every((n) => n === 1)) return `${t('ffa')} · ${list.length}`;
  return list.join(` ${t('versus')} `);
}

/** the column heads above the slot rows */
export function SlotHead({ host = true }: { host?: boolean }) {
  const t = useT();
  return (
    <div className="slot-head" aria-hidden="true">
      <span>{t('slotColour')}</span><span>{t('slotWho')}</span><span>{host ? t('slotLevel') : ''}</span><span>{t('team')}</span>
    </div>
  );
}

/* ===================================================================================================== */

interface SlotCfg { kind: 'me' | 'bot' | 'closed'; difficulty: 0 | 1 | 2; team: number; /** index into PLAYER_COLORS */ color: number }

/** a map straight from the editor: played from its payload as it is now, saved or not */
export interface TestMap { picked: PickedMap; payload: string }

/** the first twelve colours are the hand-picked ones the colour row offers */
const PICKABLE = 12;

export function Skirmish({ back, start, initialMap, testMap, openEditor }: {
  back: () => void;
  start: (setup: MatchSetup, mySlot: number) => void;
  /** preselected map (the map editor's "play" button) */
  initialMap?: PickedMap;
  /** the editor's test game: this map only */
  testMap?: TestMap;
  openEditor?: () => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<PickedMap>(() => testMap?.picked ?? initialMap ?? officialPick('duel-valley'));
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [colourFor, setColourFor] = useState(-1);
  const [slots, setSlots] = useState<SlotCfg[]>(() => {
    // the editor's test game fills every zone, so the whole map is tried at once
    const all = testMap?.picked.players ?? 2;
    return Array.from({ length: MAX_PLAYERS }, (_, i) => ({ kind: i === 0 ? 'me' : i < all ? 'bot' : 'closed', difficulty: 1, team: i, color: i }) as SlotCfg);
  });
  useEscapeBack(back);
  const maxPlayers = picked.players;
  const visible = slots.slice(0, maxPlayers);
  const setSlot = (i: number, patch: Partial<SlotCfg>) => setSlots((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const filled = visible.filter((s) => s.kind !== 'closed');
  const teams = new Set(filled.map((s) => s.team));
  const canStart = filled.length >= 2 && teams.size >= 2 && !loading;
  const nextClosed = visible.findIndex((s) => s.kind === 'closed');
  const hasHard = filled.some((s) => s.kind === 'bot' && s.difficulty === 2);
  const name = getSettings().name;
  const botName = (i: number) => `${t('bot')} ${i + 1}`;

  const setKind = (i: number, kind: SlotCfg['kind']) => {
    if (kind === 'me') setSlots((all) => all.map((x, k) => (k === i ? { ...x, kind: 'me' } : x.kind === 'me' ? { ...x, kind: 'bot' } : x)));
    else setSlot(i, { kind });
    if (kind === 'closed' && colourFor === i) setColourFor(-1);
  };
  /** take a colour; whoever had it gets this slot's old one, so no two seats ever share a colour */
  const pickColour = (i: number, c: number) => {
    setSlots((all) => {
      const old = all[i].color;
      return all.map((x, k) => (k === i ? { ...x, color: c } : x.color === c ? { ...x, color: old } : x));
    });
    setColourFor(-1);
  };

  const onStart = async () => {
    const players: PlayerSetup[] = [];
    let mySlot = 0;
    visible.forEach((s) => {
      if (s.kind === 'closed') return;
      const idx = players.length;
      if (s.kind === 'me') mySlot = idx;
      players.push({ slot: idx, team: s.team, name: s.kind === 'me' ? name : `${t('bot')} ${idx + 1} (${t(DIFF_KEYS[s.difficulty])})`, isBot: s.kind === 'bot', difficulty: s.difficulty, color: PLAYER_COLORS[s.color] });
    });
    const setup: MatchSetup = { seed: (Math.random() * 0x7fffffff) | 0, mapId: picked.id, players, version: SIM_VERSION, speed };
    if (picked.custom) {
      setLoading(true); setError('');
      try {
        setup.map = testMap?.payload ?? await fetchMapData(picked.id, picked.rev);
        setup.mapId = customMapId(picked.id);
      } catch (e) {
        setError(t(mapErrorKey(e)));
        setLoading(false);
        return;
      }
      setLoading(false);
    }
    start(setup, mySlot);
  };

  // the order card: who stands with me and who against, the map, the line-up, the bots' skill, the speed
  const me = visible.find((s) => s.kind === 'me');
  const label = (s: SlotCfg) => (s.kind === 'me' ? name : botName(visible.indexOf(s)));
  const allies = me ? filled.filter((s) => s.team === me.team) : filled.slice(0, 1);
  const foes = filled.filter((s) => !allies.includes(s));
  const levels = [...new Set(filled.filter((s) => s.kind === 'bot').map((s) => s.difficulty))].sort().map((d) => t(DIFF_KEYS[d]).toLowerCase());
  const lineup = lineupText(t, filled.map((s) => s.team));
  const speedText = speed === 1 ? `1× · ${t('speedNormal').toLowerCase()}` : `${speed}×`;

  return (
    <div className="screen setup-screen">
      <MenuBackground />
      <main className="sheet sheet--framed setup-sheet setup-sheet--full skirmish">
        <SheetHead
          onBack={back} backLabel={t('back')}
          title={<h1 className="setup-head__title">{testMap ? t('testMapTitle') : t('playAI')}</h1>}
          sub={testMap ? t('testMapSub') : t('skirmishSub')}
        />
        <div className="setup-body">
          <section className="setup-main" aria-labelledby="sk-map">
            <div className="legend-head">
              <span className="legend-head__no">I</span>
              <h2 className="legend-head__name" id="sk-map">{t('map')}</h2>
              <span className="legend-head__meta">{t('mapSelectedMeta', { name: picked.name })}</span>
            </div>
            {testMap ? (
              <div className="picked-custom slip">
                <div className="picked-thumb picked-thumb--lg"><MapPreview payload={testMap.picked.thumb} fill zones /></div>
                <div className="picked-custom__text">
                  <div className="picked-custom__name">{testMap.picked.name}</div>
                  <div className="picked-custom__meta">{mapMeta(picked.w, picked.h, picked.players)}</div>
                  <p className="picked-custom__note">{t('testMapNote')}</p>
                </div>
              </div>
            ) : (
              <MapPicker value={picked} onPick={(m) => { setPicked(m); setError(''); setColourFor(-1); }} openEditor={openEditor} />
            )}
          </section>

          <div className="setup-side">
            <section aria-labelledby="sk-players">
              <div className="legend-head">
                <span className="legend-head__no">II</span>
                <h2 className="legend-head__name" id="sk-players">{t('players')}</h2>
                <span className="legend-head__meta">{lineup}</span>
              </div>
              <div className={`slots${visible.length > 12 ? ' many' : ''}${maxPlayers > 2 && maxPlayers <= 4 ? ' slots--team-scale' : ''}`}>
                <SlotHead />
                {visible.map((s, i) => s.kind === 'closed' ? null : (
                  <div key={i} className="slot-wrap">
                    <div className={`slot${s.kind === 'me' ? ' is-me' : ''}`} style={teamVar(PLAYER_COLORS[s.color])}>
                      <button
                        className="slot__flag" aria-label={t('slotColourChange')} aria-expanded={colourFor === i}
                        onClick={() => setColourFor(colourFor === i ? -1 : i)}
                      ><Icon name="flag" /></button>
                      <div className="row slot__who">
                        <select className="select" aria-label={t('slotWho')} value={s.kind} onChange={(e) => setKind(i, e.target.value as SlotCfg['kind'])}>
                          <option value="me">{t('you')}</option>
                          <option value="bot">{t('bot')}</option>
                          <option value="closed">{t('closed')}</option>
                        </select>
                      </div>
                      <div className="slot__level">
                        {s.kind === 'bot' ? (
                          <select className="select" aria-label={t('slotLevel')} value={s.difficulty} onChange={(e) => setSlot(i, { difficulty: Number(e.target.value) as 0 | 1 | 2 })}>
                            {DIFF_KEYS.map((k, d) => <option key={k} value={d}>{t(k)}</option>)}
                          </select>
                        ) : <span className="slot__me">{name}</span>}
                      </div>
                      <TeamPicker value={s.team} count={maxPlayers} onChange={(team) => setSlot(i, { team })} />
                    </div>
                    {colourFor === i && (
                      <div className="slot-colours" role="radiogroup" aria-label={t('slotColour')}>
                        {PLAYER_COLORS.slice(0, PICKABLE).map((c, k) => (
                          <button key={k} role="radio" aria-checked={s.color === k} aria-label={t('colourN', { n: k + 1 })} style={teamVar(c)} onClick={() => pickColour(i, k)}>
                            <Icon name="flag" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="slot-actions">
                <button className="btn btn--quiet btn--compact slot-add" disabled={nextClosed < 0} onClick={() => setSlot(nextClosed, { kind: 'bot' })}>
                  <Icon name="plus" />{t('addBot')}
                </button>
                {maxPlayers > 2 && (
                  <button
                    className="btn btn--quiet btn--compact" disabled={nextClosed < 0}
                    onClick={() => setSlots((all) => all.map((x, k) => (k < maxPlayers && x.kind === 'closed' ? { ...x, kind: 'bot' } : x)))}
                  >{t('fill')}</button>
                )}
              </div>
              {hasHard && <p className="setup-note">{t('hardNote')}</p>}
            </section>

            <section className="setup-speed" aria-labelledby="sk-speed">
              <div className="legend-head">
                <span className="legend-head__no">III</span>
                <h2 className="legend-head__name" id="sk-speed">{t('gameSpeed')}</h2>
              </div>
              <ScaleBar className="speed-scale" cellClass="speed-btn" options={GAME_SPEEDS} value={speed} onChange={setSpeed} label={t('gameSpeed')} render={(v) => `${v}×`} />
              <p className="setup-note">{t('speedHint')}</p>
            </section>
          </div>

          <div className="setup-foot">
            <div className="order">
              <h2 className="order__title">{t('orderTitle')} <small>{t('orderSealed')}</small></h2>
              <p className="order__vs">
                <Pennants list={allies.map((s) => ({ name: label(s), color: PLAYER_COLORS[s.color] }))} />
                <em>{t('against')}</em>
                <Pennants list={foes.map((s) => ({ name: label(s), color: PLAYER_COLORS[s.color] }))} />
              </p>
              <dl className="order__dl">
                <dt>{t('map')}</dt><dd><em>{picked.name}</em> · {sizeLabel(picked.w, picked.h)}</dd>
                <dt>{t('orderLineup')}</dt><dd>{lineup}</dd>
                {levels.length > 0 && <><dt>{t('slotLevel')}</dt><dd>{levels.join(', ')}</dd></>}
                <dt>{t('speedShort')}</dt><dd>{speedText}</dd>
              </dl>
              <p className="order__line">{picked.name} · {lineup} · {speed}×</p>
            </div>
            {(!canStart && !loading) && <p className="setup-alert" role="alert"><Icon name="warning" />{t('needPlayers')}</p>}
            {error && <p className="setup-alert" role="alert"><Icon name="error" />{error}</p>}
            <button className="btn btn--seal btn--block setup-seal" disabled={!canStart} onClick={() => void onStart()}>{loading ? t('loading') : t('start')}</button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** up to three pennants with names, then "+N" */
export function Pennants({ list }: { list: { name: string; color: number }[] }) {
  if (!list.length) return <span className="order__none">—</span>;
  const shown = list.slice(0, 3);
  return (
    <span className="order__side">
      {shown.map((p, k) => <span key={k} className="pennant" style={teamVar(p.color)}><Icon name="flag" /><span className="pennant__name">{p.name}</span></span>)}
      {list.length > shown.length && <span className="order__more">+{list.length - shown.length}</span>}
    </span>
  );
}
