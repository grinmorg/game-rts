import { CSSProperties, KeyboardEvent, ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Keyframe, MatchSummary, ReplayData, SUMMARY_METRICS, SummaryMetric, sampleTick } from '@pocket-of-empire/sim';
import { TKey, formatTime, useT } from '../i18n';
import { ReplayLink, UploadError, momentTick, replayLink, shareKeyframe, shareUrl, uploadReplay } from '../game/replayLinks';
import { getSettings } from '../settings';
import { useTouchUI } from '../touch';
import { Icon, SvgIcon } from './icons/Icon';

/** a player as the report shows them: index = player id, the same order as the summary's series */
export interface ReportPlayer { name: string; color: number; team: number }
export interface ResultRow { name: string; color: number; team: number; alive: boolean; trained: number; lost: number; killed: number; razed: number; gold: number }

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
/** a team colour goes in as a custom property, never as an inline colour (SPEC §8) */
export const teamStyle = (c: number): CSSProperties => ({ '--team': hex(c) }) as CSSProperties;
const METRIC_KEYS: Record<SummaryMetric, [TKey, TKey]> = {
  army: ['metricArmy', 'metricArmyDesc'], workers: ['metricWorkers', 'metricWorkersDesc'],
  mined: ['metricMined', 'metricMinedDesc'], kills: ['metricKills', 'metricKillsDesc'],
};
/**
 * The ring around dots and markers: the chart's own surface (the night sheet, --paper), so they stay legible
 * where lines cross. `.chart-wrap` has no fill of its own and sits on the sheet.
 */
const SURFACE = '#221b15';
/** line patterns for the colour-blind setting: the lines differ by more than their colour */
const DASHES = ['', '7 4', '2 3', '10 3 2 3', '4 4', '1 3', '12 4', '6 2 2 2'];
const numFmt = (v: number) => Math.round(v).toLocaleString(getSettings().lang);

/** "Бот 2 (Средний)" → the name and the part in brackets, which reads as a caption beside it */
export function splitName(name: string): [string, string | null] {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(name);
  return m ? [m[1], m[2]] : [name, null];
}

/** a player chip: the flag in their colour and the name (SPEC §4 `.pennant`); without a colour the flag is plain ink */
export function Pennant({ name, color, split = false, className, children }: {
  name: string; color?: number; split?: boolean; className?: string; children?: ReactNode;
}) {
  const [main, sub] = split ? splitName(name) : [name, null];
  return (
    <span className={className ? `pennant ${className}` : 'pennant'} style={color !== undefined ? teamStyle(color) : undefined}>
      <Icon name="flag" />
      <span className="pennant__name">{main}</span>
      {sub && <span className="pennant__sub">{sub}</span>}
      {children}
    </span>
  );
}

/** a small status slip under the thing it is about: busy (compass needle), done, failed, or a plain note */
export function Slip({ kind, children, role }: { kind: 'busy' | 'ok' | 'error' | 'info'; children: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className={`slip status-slip status-slip--${kind}`} role={role ?? (kind === 'error' ? 'alert' : 'status')}>
      {kind === 'busy' ? <span className="spinner" aria-hidden /> : <Icon name={kind === 'ok' ? 'check' : kind === 'error' ? 'error' : 'info'} />}
      <div className="status-slip__text">{children}</div>
    </div>
  );
}

/** the results table read from a summary, for a match there is no live simulation of */
export function rowsFromSummary(summary: MatchSummary, players: ReportPlayer[]): ResultRow[] {
  return players.map((p, i) => {
    const s = summary.totals[i];
    return { name: p.name, color: p.color, team: p.team, alive: summary.out[i] < 0, trained: s?.trained ?? 0, lost: s?.lost ?? 0, killed: s?.killed ?? 0, razed: s?.razed ?? 0, gold: s?.mined ?? 0 };
  });
}

const COLS = ['trained', 'lost', 'killed', 'razed', 'gold'] as const;
const COL_KEYS: Record<(typeof COLS)[number], TKey> = { trained: 'unitsTrained', lost: 'unitsLost', killed: 'unitsKilled', razed: 'buildingsRazed', gold: 'goldMined' };

/**
 * The ledger of the match: one row per player, figures in tabular Ysabeau. Your own row carries the verdigris rule,
 * the winners a badge; the best figure of a column is set bold and a zero is dimmed, so the eye finds what mattered.
 * A big match (more than a dozen rows) scrolls under its own sticky header instead of stretching the sheet.
 */
export function ResultsTable({ rows, me = -1, winnerTeam = -1 }: { rows: ResultRow[]; me?: number; winnerTeam?: number }) {
  const t = useT();
  const best = COLS.map((c) => (rows.length > 1 ? Math.max(0, ...rows.map((r) => r[c])) : 0));
  return (
    <div className={`results-table rs-table${rows.length > 12 ? ' many' : ''}`}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('players')}</th><th scope="col">{t('team')}</th>
            {COLS.map((c) => <th key={c} scope="col">{t(COL_KEYS[c])}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i === me ? 'is-me' : undefined}>
              <td className="rs-table__who">
                <Pennant name={r.name} color={r.color} split />
                {i === me && <span className="badge">{t('youBadge')}</span>}
                {winnerTeam >= 0 && r.team === winnerTeam && <span className="badge badge--ok">{t('winnerBadge')}</span>}
                {winnerTeam < 0 && !r.alive && <span className="badge">{t('outBadge')}</span>}
              </td>
              <td>{r.team + 1}</td>
              {COLS.map((c, k) => <td key={c} className={r[c] === 0 ? 'dim' : r[c] === best[k] ? 'best' : undefined}>{numFmt(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ sharing

export type ShareState =
  | { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string } | { kind: 'manual'; url: string };

const UPLOAD_ERRORS: Record<UploadError, TKey> = { tooMany: 'uploadTooMany', tooBig: 'uploadTooBig', invalid: 'uploadInvalid', network: 'uploadFailed' };

/**
 * Links to a match. A match the server already has (played online, or opened from the server) links
 * straight away; a skirmish is uploaded on the first share and its id kept for the next ones. A link to a
 * moment sends the keyframe it starts from along (`keyframeAt`, see shareKeyframe), so whoever opens it is
 * there at once rather than after the match has been played up to it.
 */
export function useReplayShare(
  getData: () => ReplayData | null, knownId?: string, onUploaded?: (id: string) => void, keyframeAt?: (tick: number) => Promise<Keyframe | null>,
) {
  const t = useT();
  const [id, setId] = useState(knownId);
  useEffect(() => { if (knownId) setId(knownId); }, [knownId]);
  const [state, setState] = useState<ShareState>({ kind: 'idle' });
  const busy = state.kind === 'busy';
  const share = async (at: Omit<ReplayLink, 'id'>, title: string) => {
    if (busy) return;
    setState({ kind: 'busy' });
    let sid = id;
    let data: ReplayData | null = null;
    if (!sid) {
      data = getData();
      const r = data ? await uploadReplay(data) : { error: 'invalid' as const };
      if ('error' in r) { setState({ kind: 'error', text: t(UPLOAD_ERRORS[r.error]) }); return; }
      sid = r.id;
      setId(sid);
      onUploaded?.(sid);
    }
    // on its way while the link is handed out: a share sheet has to open from the tap, not seconds after it
    if (keyframeAt && (at.m !== undefined || at.t !== undefined)) {
      data ??= getData();
      const tick = data ? momentTick(data, at) : undefined;
      if (tick) void shareKeyframe(sid, tick, keyframeAt);
    }
    const url = replayLink({ id: sid, ...at });
    const how = await shareUrl(url, title);
    setState(how === 'manual' ? { kind: 'manual', url } : { kind: 'ok', text: t(how === 'copied' ? 'linkCopied' : 'linkShared') });
  };
  return { id, setId, state, busy, share };
}

/** how the last share went, as a small slip: uploading, copied / sent, failed, or the link to copy by hand */
export function ShareStatus({ state }: { state: ShareState }) {
  const t = useT();
  if (state.kind === 'idle') return null;
  if (state.kind === 'busy') return <div className="share-status"><Slip kind="busy">{t('uploading')}</Slip></div>;
  if (state.kind === 'manual') {
    return (
      <div className="share-status">
        <Slip kind="info">
          <label className="status-slip__copy">
            <span>{t('linkManual')}</span>
            <input className="text" readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} autoFocus />
          </label>
        </Slip>
      </div>
    );
  }
  return <div className="share-status"><Slip kind={state.kind === 'error' ? 'error' : 'ok'}>{state.text}</Slip></div>;
}

export function shareTitle(players: ReportPlayer[]): string {
  return `${players.map((p) => p.name).join(players.length === 2 ? ' vs ' : ', ')} · Pocket of Empire`;
}

// ------------------------------------------------------------------ battles

/** minute marks along the match clock, not more than about six of them */
function timeTicks(endTick: number, speed: number): number[] {
  const perSec = 20 * (speed || 1);
  const total = endTick / perSec;
  const step = [30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => total / s <= 6) ?? 3600;
  const out: number[] = [];
  for (let s = 0; s <= total; s += step) out.push(s * perSec);
  return out;
}

/** the battles a match had, as the legend signs of a scale bar from the first tick to the last */
function MatchTimeline({ summary, speed, onWatch }: { summary: MatchSummary; speed: number; onWatch?: (battle: number) => void }) {
  const t = useT();
  const end = summary.end > 0 ? summary.end : 1;
  const pct = (tick: number) => `${Math.min(100, Math.max(0, (tick / end) * 100))}%`;
  // minute labels stay clear of the end label, which always shows the full length
  const ticks = timeTicks(end, speed).filter((tk) => tk / end <= 0.86);
  return (
    <div className="rs-timeline">
      <div className="rs-timeline__bar" aria-hidden>
        {Array.from({ length: 12 }, (_, i) => <i key={i} />)}
        {summary.battles.map((b, i) => (
          <span key={i} className="rs-timeline__band" style={{ left: pct(b.start), width: `max(3px, ${((Math.max(b.end, b.start) - b.start) / end) * 100}%)` }} />
        ))}
      </div>
      {ticks.map((tk) => <span key={tk} className={`rs-timeline__tick${tk === 0 ? ' is-start' : ''}`} style={{ left: pct(tk) }}>{formatTime(tk, speed)}</span>)}
      <span className="rs-timeline__tick is-end">{formatTime(end, speed)}</span>
      {summary.battles.map((b, i) => {
        const label = `${t(i === 0 ? 'battleBiggest' : 'battleOther')} · ${formatTime(b.start, speed)}`;
        const cls = `rs-timeline__mark${i === 0 ? ' is-big' : ''}`;
        return onWatch
          ? <button key={i} type="button" className={cls} style={{ left: pct(b.start) }} onClick={() => onWatch(i)} aria-label={`${t('watch')}: ${label}`} title={label}><Icon name="battle" /></button>
          : <span key={i} className={cls} style={{ left: pct(b.start) }} role="img" aria-label={label} title={label}><Icon name="battle" /></span>;
      })}
    </div>
  );
}

/** losses of one battle: the players who lost most first, the rest summed up, so a hundred-player brawl stays one line */
const LOSS_CHIPS = 6;

/**
 * The moments worth a link: every battle on the match's scale bar and as a row with what it cost each side.
 * `onWatch` opens the battle, `onShare` hands out a link to it; either is left out where it cannot be done (an old
 * recording plays no more, a match still running has no replay to link to yet).
 */
export function BattleList({ summary, players, speed, onWatch, onShare, shareBusy }: {
  summary: MatchSummary; players: ReportPlayer[]; speed: number;
  onWatch?: (battle: number) => void; onShare?: (battle: number) => void; shareBusy?: boolean;
}) {
  const t = useT();
  const headId = `moments-${useId().replace(/[^\w-]/g, '')}`;
  const any = summary.battles.length > 0;
  return (
    <section className="moments rs-moments" aria-labelledby={headId}>
      <div className="legend-head">
        <h3 className="legend-head__name" id={headId}>{t('moments')}</h3>
        {any && onWatch && <span className="legend-head__meta">{t('momentsHint')}</span>}
      </div>
      {!any ? <p className="rs-moments__none">{t('noBattles')}</p> : (
        <>
          <MatchTimeline summary={summary} speed={speed} onWatch={onWatch} />
          <ul className="rs-moment-list">
            {summary.battles.map((b, i) => {
              const lost = b.losses.map((n, p) => ({ n, p })).filter((x) => x.n > 0 && players[x.p]).sort((a, c) => c.n - a.n);
              const rest = lost.slice(LOSS_CHIPS).reduce((s, x) => s + x.n, 0);
              return (
                <li key={i} className="rs-moment">
                  <span className="rs-moment__sign" aria-hidden><Icon name="battle" /></span>
                  <div className="rs-moment__main">
                    <div className="rs-moment__title">
                      <span>{t(i === 0 ? 'battleBiggest' : 'battleOther')}</span>
                      <span className="rs-moment__when">{t('battleLine', { time: formatTime(b.start, speed), n: b.deaths })}</span>
                    </div>
                    {lost.length > 0 && (
                      <div className="rs-moment__losses">
                        {lost.slice(0, LOSS_CHIPS).map(({ n, p }) => (
                          <Pennant key={p} name={players[p].name} color={players[p].color} className="pennant--sm"><span className="rs-moment__loss">−{n}</span></Pennant>
                        ))}
                        {rest > 0 && <span className="rs-moment__loss">+{lost.length - LOSS_CHIPS} · −{rest}</span>}
                      </div>
                    )}
                  </div>
                  {(onWatch || onShare) && (
                    <div className="rs-moment__actions">
                      {onWatch && <button type="button" className="btn btn--secondary btn--small" onClick={() => onWatch(i)}><Icon name="play" />{t('watch')}</button>}
                      {onShare && <button type="button" className="btn btn--quiet btn--small" onClick={() => onShare(i)} disabled={shareBusy}><Icon name="link" />{t('shareMoment')}</button>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ charts

/** round axis ticks: 0 and three or four clean steps up to at least `max` */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // every series counts whole things (units, gold, kills): a step under 1 would print the same label twice
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag);
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** arrow keys move the choice of a radio group / tab row (the scale bar and the bookmarks leave that to the screen) */
function arrowPick<T>(e: KeyboardEvent, list: readonly T[], current: T, pick: (v: T) => void): void {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = list[(list.indexOf(current) + step + list.length) % list.length];
  pick(next);
  const group = (e.currentTarget as HTMLElement).parentElement;
  requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]')?.focus());
}

/** the tooltip lists this many players, the strongest first */
const TIP_ROWS = 10;

/**
 * The match over time: one thin line per player in their own colour, one metric at a time on one axis, on the
 * night sheet with a hairline grid. Battles are hatched bands across the time they took, the second age a diamond on
 * the line of whoever reached it. The crosshair snaps to a sample and the card beside it lists the players there;
 * `onWatch` makes a click (or the card's button, on touch) open the replay at that moment. The legend pins a line;
 * a table view carries the same numbers for anyone the lines do not work for.
 */
export function MatchCharts({ summary, players, speed, onWatch, me = -1 }: {
  summary: MatchSummary; players: ReportPlayer[]; speed: number; onWatch?: (tick: number) => void; me?: number;
}) {
  const t = useT();
  const touch = useTouchUI();
  const hatchId = `hatch-${useId().replace(/[^\w-]/g, '')}`;
  const [metric, setMetric] = useState<SummaryMetric>('army');
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const colorblind = getSettings().colorblind;
  const dash = (p: number) => (colorblind ? DASHES[p % DASHES.length] || undefined : undefined);
  const emphasis = focus ?? pinned;
  const series = summary.series[metric];
  const n = series[0]?.length ?? 0;

  const H = typeof window !== 'undefined' && window.innerHeight < 560 ? 150 : 200;
  const endLabelsFit = players.length <= 4 && width >= 460;
  const geo = useMemo(() => {
    const max = Math.max(1, ...series.flat());
    const yt = niceTicks(max);
    const top = yt[yt.length - 1];
    const ml = 44, mt = 14, mb = 22;
    const ph = H - mt - mb;
    const y = (v: number) => mt + ph - (v / top) * ph;
    // names at the line ends while they have room and do not collide - nudging them apart would detach them
    // from their lines, so then the legend carries identity alone
    const ends = series.map((s) => y(s[s.length - 1] ?? 0)).sort((a, b) => a - b);
    let labels = endLabelsFit;
    for (let i = 1; i < ends.length; i++) if (ends[i] - ends[i - 1] < 13) labels = false;
    const mr = labels ? 96 : 14;
    const pw = Math.max(10, width - ml - mr);
    const x = (tick: number) => ml + (summary.end > 0 ? (tick / summary.end) * pw : 0);
    return { yt, ml, mt, pw, ph, x, y, labels };
  }, [series, width, H, endLabelsFit, summary.end]);

  const points = (s: number[]) => s.map((v, i) => `${i ? 'L' : 'M'}${geo.x(sampleTick(summary, i)).toFixed(1)},${geo.y(v).toFixed(1)}`).join('');
  /** a value between samples, for markers that fall between them */
  const valueAt = (s: number[], tick: number) => {
    const i = Math.min(n - 1, Math.floor(tick / summary.every));
    const t0 = sampleTick(summary, i), t1 = sampleTick(summary, Math.min(n - 1, i + 1));
    const f = t1 > t0 ? (tick - t0) / (t1 - t0) : 0;
    return s[i] + ((s[Math.min(n - 1, i + 1)] ?? s[i]) - s[i]) * f;
  };
  /** the sample under a pointer, found by x alone: the reader aims at a time, never at a 2px line */
  const nearest = (e: React.PointerEvent<SVGRectElement> | React.MouseEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const tick = ((e.clientX - rect.left - geo.ml) / geo.pw) * summary.end;
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(sampleTick(summary, i) - tick) < Math.abs(sampleTick(summary, best) - tick)) best = i;
    return best;
  };
  const order = players.map((_, p) => p).sort((a, b) => (a === me ? 1 : 0) - (b === me ? 1 : 0)); // own line on top

  const hoverTick = hover !== null ? sampleTick(summary, hover) : 0;
  const prevTick = hover !== null && hover > 0 ? sampleTick(summary, hover - 1) : -1;
  const hoverBattle = hover !== null ? summary.battles.findIndex((b) => hoverTick >= b.start - summary.every / 2 && hoverTick <= b.end + summary.every / 2) : -1;
  const agedHere = hover !== null ? players.map((_, p) => p).filter((p) => summary.ageUp[p] > prevTick && summary.ageUp[p] <= hoverTick) : [];
  const tipLeft = hover !== null ? geo.x(hoverTick) : 0;
  const tipFlip = tipLeft > width * 0.6;
  const tipRows = hover !== null ? order.slice().sort((a, b) => (series[b][hover] ?? 0) - (series[a][hover] ?? 0)) : [];

  const minuteRows = useMemo(() => {
    const rows: number[] = [];
    const perMin = 60 * 20 * (speed || 1);
    for (let i = 0; i < n; i++) {
      const tk = sampleTick(summary, i);
      if (i === n - 1 || tk % perMin === 0) rows.push(i);
    }
    return rows;
  }, [summary, n, speed]);

  const pickMetric = (m: SummaryMetric) => { setMetric(m); setHover(null); };

  return (
    <div className="charts rs-charts">
      <div className="rs-charts__bar">
        <div className="scalebar scalebar--words rs-metrics" role="radiogroup" aria-label={t('chartMetric')}>
          {SUMMARY_METRICS.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={metric === m} tabIndex={metric === m ? 0 : -1}
              onClick={() => pickMetric(m)} onKeyDown={(e) => arrowPick(e, SUMMARY_METRICS, metric, pickMetric)}>{t(METRIC_KEYS[m][0])}</button>
          ))}
        </div>
        <button type="button" className="btn btn--quiet btn--small rs-charts__view" onClick={() => setAsTable((v) => !v)}>
          <Icon name={asTable ? 'chart' : 'menu'} />{asTable ? t('chartGraph') : t('chartTable')}
        </button>
      </div>
      <p className="rs-charts__sub">{t(METRIC_KEYS[metric][1])}</p>

      <div className="rs-legend" role="group" aria-label={t('players')} onMouseLeave={() => setFocus(null)}>
        {players.map((p, i) => (
          <button key={i} type="button" style={teamStyle(p.color)} aria-pressed={pinned === i}
            className={`rs-legend__item${emphasis === i ? ' is-on' : ''}${emphasis !== null && emphasis !== i ? ' is-dim' : ''}`}
            onMouseEnter={() => !touch && setFocus(i)} onClick={() => setPinned((v) => (v === i ? null : i))}>
            {colorblind
              ? <svg className="rs-legend__line" viewBox="0 0 24 6" aria-hidden><line x1="1" y1="3" x2="23" y2="3" strokeDasharray={dash(i)} /></svg>
              : <Icon name="flag" />}
            <span className="rs-legend__name">{p.name}</span>
          </button>
        ))}
      </div>

      {asTable ? (
        <div className="rs-chart-table">
          <table className="table">
            <thead><tr><th scope="col">{t('chartTime')}</th>{players.map((p, i) => <th key={i} scope="col"><Pennant name={p.name} color={p.color} className="pennant--sm" /></th>)}</tr></thead>
            <tbody>
              {minuteRows.map((i) => (
                <tr key={i}><td>{formatTime(sampleTick(summary, i), speed)}</td>{series.map((s, p) => <td key={p}>{numFmt(s[i] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className="chart-wrap" tabIndex={0} aria-label={`${t(METRIC_KEYS[metric][0])} - ${t('chartsTab')}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); e.preventDefault(); }
            else if (e.key === 'ArrowLeft') { setHover((h) => Math.max(0, (h ?? n) - 1)); e.preventDefault(); }
            else if (e.key === 'Enter' && hover !== null && onWatch) onWatch(sampleTick(summary, hover));
            else if (e.key === 'Escape') setHover(null);
          }}>
          {width > 0 && (
            <svg width={width} height={H} className="chart-svg">
              <defs>
                <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" className="rs-hatch" />
                </pattern>
              </defs>
              {geo.yt.map((v, i) => (
                <g key={v}>
                  <line x1={geo.ml} x2={geo.ml + geo.pw} y1={geo.y(v)} y2={geo.y(v)} className={i === 0 ? 'grid base' : 'grid'} />
                  <text x={geo.ml - 7} y={geo.y(v) + 4} className="tick" textAnchor="end">{v >= 10000 ? `${Math.round(v / 1000)}k` : numFmt(v)}</text>
                </g>
              ))}
              {timeTicks(summary.end, speed).map((tk) => (
                <text key={tk} x={geo.x(tk)} y={H - 5} className="tick" textAnchor="middle">{formatTime(tk, speed)}</text>
              ))}
              {summary.battles.map((b, i) => {
                const x0 = geo.x(b.start), x1 = Math.max(x0 + 4, geo.x(b.end));
                return (
                  <g key={i} className="battle-band">
                    <rect x={x0} y={geo.mt} width={x1 - x0} height={geo.ph} fill={`url(#${hatchId})`} />
                    <SvgIcon name="battle" className="battle-icon" x={(x0 + x1) / 2 - 6} y={geo.mt - 13} size={12} />
                  </g>
                );
              })}
              {order.map((p) => (
                <path key={p} d={points(series[p])} className={`series${p === me ? ' is-me' : ''}`} stroke={hex(players[p].color)} strokeDasharray={dash(p)}
                  opacity={emphasis !== null && emphasis !== p ? 0.18 : 1} />
              ))}
              {order.map((p) => summary.ageUp[p] >= 0 && (emphasis === null || emphasis === p) && (() => {
                const cx = geo.x(summary.ageUp[p]), cy = geo.y(valueAt(series[p], summary.ageUp[p]));
                return <path key={`a${p}`} d={`M${cx},${cy - 5}L${cx + 5},${cy}L${cx},${cy + 5}L${cx - 5},${cy}Z`} fill={hex(players[p].color)} stroke={SURFACE} strokeWidth={2} />;
              })())}
              {order.map((p) => {
                const s = series[p];
                if (!s.length || (emphasis !== null && emphasis !== p)) return null;
                return <circle key={`e${p}`} cx={geo.x(summary.end)} cy={geo.y(s[s.length - 1])} r={3.5} fill={hex(players[p].color)} stroke={SURFACE} strokeWidth={2} />;
              })}
              {geo.labels && order.map((p) => {
                const s = series[p];
                return <text key={`l${p}`} x={geo.x(summary.end) + 9} y={geo.y(s[s.length - 1] ?? 0) + 4} className="end-label">{splitName(players[p].name)[0].slice(0, 13)}</text>;
              })}
              {hover !== null && (
                <g>
                  <line x1={geo.x(hoverTick)} x2={geo.x(hoverTick)} y1={geo.mt} y2={geo.mt + geo.ph} className="crosshair" />
                  {order.map((p) => (emphasis === null || emphasis === p) && (
                    <circle key={`h${p}`} cx={geo.x(hoverTick)} cy={geo.y(series[p][hover] ?? 0)} r={3.5} fill={hex(players[p].color)} stroke={SURFACE} strokeWidth={2} />
                  ))}
                </g>
              )}
              <rect x={geo.ml} y={0} width={geo.pw} height={H} fill="transparent" className={onWatch && !touch ? 'hit pick' : 'hit'}
                onPointerMove={(e) => setHover(nearest(e))}
                onPointerDown={(e) => { if (e.pointerType === 'touch') setHover(nearest(e)); }}
                onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHover(null); }}
                onClick={(e) => { if (!touch && onWatch) onWatch(sampleTick(summary, nearest(e))); }} />
            </svg>
          )}
          {hover !== null && (
            <div className={`tip chart-tip rs-chart-tip${tipFlip ? ' flip' : ''}`} style={{ left: tipLeft }}>
              <div className="tip__head"><span className="tip__name rs-chart-tip__time">{formatTime(hoverTick, speed)}</span></div>
              <ul className="rs-chart-tip__rows">
                {tipRows.slice(0, TIP_ROWS).map((p) => (
                  <li key={p} style={teamStyle(players[p].color)}><Icon name="flag" /><b>{numFmt(series[p][hover] ?? 0)}</b><span>{players[p].name}</span></li>
                ))}
                {tipRows.length > TIP_ROWS && <li className="rs-chart-tip__more">+{tipRows.length - TIP_ROWS}</li>}
              </ul>
              {hoverBattle >= 0 && <div className="tip-note"><Icon name="battle" />{t(hoverBattle === 0 ? 'battleBiggest' : 'battleOther')}</div>}
              {agedHere.map((p) => <div key={p} className="tip-note"><Icon name="age-marker" />{players[p].name}: {t('secondAge')}</div>)}
              {touch && onWatch && <button type="button" className="btn btn--secondary btn--small" onClick={() => onWatch(hoverTick)}><Icon name="play" />{t('watchFrom', { time: formatTime(hoverTick, speed) })}</button>}
            </div>
          )}
        </div>
      )}
      {!asTable && onWatch && <p className="chart-hint">{t(touch ? 'chartHintTouch' : 'chartHint')}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ the whole report

type ReportTab = 'table' | 'charts';
const TABS: readonly ReportTab[] = ['table', 'charts'];

/**
 * What the results screen, the replay's summary card and a shared link show about a match: the ledger table and
 * the charts behind two bookmark tabs, the battles under both. Watching and sharing are offered where they work.
 */
export function MatchReport({ summary, players, speed, rows, me, winnerTeam, onWatchTick, onWatchBattle, onShareBattle, shareBusy }: {
  summary: MatchSummary | null; players: ReportPlayer[]; speed: number; rows: ResultRow[]; me?: number; winnerTeam?: number;
  onWatchTick?: (tick: number) => void; onWatchBattle?: (battle: number) => void; onShareBattle?: (battle: number) => void; shareBusy?: boolean;
}) {
  const t = useT();
  const [tab, setTab] = useState<ReportTab>('table');
  const uid = useId().replace(/[^\w-]/g, '');
  const table = <ResultsTable rows={rows} me={me} winnerTeam={winnerTeam} />;
  return (
    <div className="report">
      {summary ? (
        <>
          <div className="tabs report-tabs" role="tablist" aria-label={t('matchSummary')}>
            {TABS.map((k) => (
              <button key={k} type="button" role="tab" id={`${uid}-${k}`} className="tab" aria-selected={tab === k} aria-controls={`${uid}-panel`}
                tabIndex={tab === k ? 0 : -1} onClick={() => setTab(k)} onKeyDown={(e) => arrowPick(e, TABS, tab, setTab)}>
                {k === 'charts' && <Icon name="chart" />}{t(k === 'table' ? 'summaryTab' : 'chartsTab')}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-${tab}`} className="report__panel">
            {tab === 'charts' ? <MatchCharts summary={summary} players={players} speed={speed} onWatch={onWatchTick} me={me} /> : table}
          </div>
          <BattleList summary={summary} players={players} speed={speed} onWatch={onWatchBattle} onShare={onShareBattle} shareBusy={shareBusy} />
        </>
      ) : table}
    </div>
  );
}
