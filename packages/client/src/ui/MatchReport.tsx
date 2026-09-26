import { useEffect, useMemo, useRef, useState } from 'react';
import { MatchSummary, ReplayData, SUMMARY_METRICS, SummaryMetric, sampleTick } from '@rookfall/sim';
import { TKey, formatTime, useT } from '../i18n';
import { ReplayLink, UploadError, replayLink, shareUrl, uploadReplay } from '../game/replayLinks';
import { useTouchUI } from '../touch';

/** a player as the report shows them: index = player id, the same order as the summary's series */
export interface ReportPlayer { name: string; color: number; team: number }
export interface ResultRow { name: string; color: number; team: number; alive: boolean; trained: number; lost: number; killed: number; razed: number; gold: number }

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const METRIC_KEYS: Record<SummaryMetric, [TKey, TKey]> = {
  army: ['metricArmy', 'metricArmyDesc'], workers: ['metricWorkers', 'metricWorkersDesc'],
  mined: ['metricMined', 'metricMinedDesc'], kills: ['metricKills', 'metricKillsDesc'],
};
/** the ring around dots and markers: the chart's own surface, so they stay legible where lines cross */
const SURFACE = '#160f0d';

/** the results table read from a summary, for a match there is no live simulation of */
export function rowsFromSummary(summary: MatchSummary, players: ReportPlayer[]): ResultRow[] {
  return players.map((p, i) => {
    const s = summary.totals[i];
    return { name: p.name, color: p.color, team: p.team, alive: summary.out[i] < 0, trained: s?.trained ?? 0, lost: s?.lost ?? 0, killed: s?.killed ?? 0, razed: s?.razed ?? 0, gold: s?.mined ?? 0 };
  });
}

export function ResultsTable({ rows }: { rows: ResultRow[] }) {
  const t = useT();
  return (
    <div className={`results-table${rows.length > 12 ? ' many' : ''}`}>
      <table>
        <thead><tr><th>{t('players')}</th><th>{t('team')}</th><th>{t('unitsTrained')}</th><th>{t('unitsLost')}</th><th>{t('unitsKilled')}</th><th>{t('buildingsRazed')}</th><th>{t('goldMined')}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ opacity: r.alive ? 1 : 0.6 }}>
              <td><span className="dot" style={{ background: hex(r.color) }} />{r.name}</td>
              <td>{r.team + 1}</td><td>{r.trained}</td><td>{r.lost}</td><td>{r.killed}</td><td>{r.razed}</td><td>{r.gold}</td>
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
 * straight away; a skirmish is uploaded on the first share and its id kept for the next ones.
 */
export function useReplayShare(getData: () => ReplayData | null, knownId?: string, onUploaded?: (id: string) => void) {
  const t = useT();
  const [id, setId] = useState(knownId);
  useEffect(() => { if (knownId) setId(knownId); }, [knownId]);
  const [state, setState] = useState<ShareState>({ kind: 'idle' });
  const busy = state.kind === 'busy';
  const share = async (at: Omit<ReplayLink, 'id'>, title: string) => {
    if (busy) return;
    setState({ kind: 'busy' });
    let sid = id;
    if (!sid) {
      const data = getData();
      const r = data ? await uploadReplay(data) : { error: 'invalid' as const };
      if ('error' in r) { setState({ kind: 'error', text: t(UPLOAD_ERRORS[r.error]) }); return; }
      sid = r.id;
      setId(sid);
      onUploaded?.(sid);
    }
    const url = replayLink({ id: sid, ...at });
    const how = await shareUrl(url, title);
    setState(how === 'manual' ? { kind: 'manual', url } : { kind: 'ok', text: t(how === 'copied' ? 'linkCopied' : 'linkShared') });
  };
  return { id, setId, state, busy, share };
}

export function ShareStatus({ state }: { state: ShareState }) {
  const t = useT();
  if (state.kind === 'idle') return null;
  if (state.kind === 'busy') return <div className="share-status muted small" role="status">{t('uploading')}</div>;
  if (state.kind === 'manual') {
    return (
      <div className="share-status small" role="status">
        {t('linkManual')} <input readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} autoFocus />
      </div>
    );
  }
  return <div className={`share-status small ${state.kind === 'error' ? 'error' : 'good'}`} role="status">{state.text}</div>;
}

export function shareTitle(players: ReportPlayer[]): string {
  return `${players.map((p) => p.name).join(players.length === 2 ? ' vs ' : ', ')} · Rookfall`;
}

// ------------------------------------------------------------------ battles

/**
 * The moments worth a link: every battle with what it cost each side. `onWatch` opens the battle,
 * `onShare` hands out a link to it; either is left out where it cannot be done (an old recording plays no
 * more, a match still running has no replay to link to yet).
 */
export function BattleList({ summary, players, speed, onWatch, onShare, shareBusy }: {
  summary: MatchSummary; players: ReportPlayer[]; speed: number;
  onWatch?: (battle: number) => void; onShare?: (battle: number) => void; shareBusy?: boolean;
}) {
  const t = useT();
  return (
    <div className="moments">
      <h3>{t('moments')}</h3>
      {summary.battles.length === 0 && <div className="muted small">{t('noBattles')}</div>}
      {summary.battles.map((b, i) => (
        <div key={i} className="moment">
          <span className="moment-icon" aria-hidden>⚔️</span>
          <div className="grow">
            <b>{t(i === 0 ? 'battleBiggest' : 'battleOther')}</b>
            <div className="small muted">{t('battleLine', { time: formatTime(b.start, speed), n: b.deaths })}</div>
            <div className="losses small">
              {b.losses.map((n, p) => (n > 0 && players[p] ? <span key={p}><i style={{ background: hex(players[p].color) }} />{players[p].name} −{n}</span> : null))}
            </div>
          </div>
          {onWatch && <button className="primary" onClick={() => onWatch(i)}>▶ {t('watch')}</button>}
          {onShare && <button onClick={() => onShare(i)} disabled={shareBusy} title={t('shareMoment')} aria-label={t('shareMoment')}>🔗</button>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ charts

/** round axis ticks: 0 and three or four clean steps up to at least `max` */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/** minute marks along the match clock, not more than about six of them */
function timeTicks(endTick: number, speed: number): number[] {
  const perSec = 20 * (speed || 1);
  const total = endTick / perSec;
  const step = [30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => total / s <= 6) ?? 3600;
  const out: number[] = [];
  for (let s = 0; s <= total; s += step) out.push(s * perSec);
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

/**
 * The match over time: one line per player in their own colour, one metric at a time on one axis.
 * Battles are washes across the time they took, the second age a diamond on the line of whoever reached
 * it. The crosshair snaps to a sample and the card beside it lists every player there; `onWatch` makes a
 * click (or the card's button, on touch) open the replay at that moment. A table view carries the same
 * numbers for anyone the lines do not work for.
 */
export function MatchCharts({ summary, players, speed, onWatch, me = -1 }: {
  summary: MatchSummary; players: ReportPlayer[]; speed: number; onWatch?: (tick: number) => void; me?: number;
}) {
  const t = useT();
  const touch = useTouchUI();
  const [metric, setMetric] = useState<SummaryMetric>('army');
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const emphasis = focus ?? pinned;
  const series = summary.series[metric];
  const n = series[0]?.length ?? 0;
  const fmt = (v: number) => Math.round(v).toLocaleString();

  const H = typeof window !== 'undefined' && window.innerHeight < 560 ? 150 : 200;
  const endLabelsFit = players.length <= 4 && width >= 460;
  const geo = useMemo(() => {
    const max = Math.max(1, ...series.flat());
    const yt = niceTicks(max);
    const top = yt[yt.length - 1];
    const ml = 44, mt = 12, mb = 22;
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

  const minuteRows = useMemo(() => {
    const rows: number[] = [];
    const perMin = 60 * 20 * (speed || 1);
    for (let i = 0; i < n; i++) {
      const tk = sampleTick(summary, i);
      if (i === n - 1 || tk % perMin === 0) rows.push(i);
    }
    return rows;
  }, [summary, n, speed]);

  return (
    <div className="charts">
      <div className="row between chart-controls">
        <div className="seg" role="tablist">
          {SUMMARY_METRICS.map((m) => (
            <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? 'gold' : 'plain'} onClick={() => { setMetric(m); setHover(null); }}>{t(METRIC_KEYS[m][0])}</button>
          ))}
        </div>
        <div className="seg">
          <button className="plain" onClick={() => setAsTable((v) => !v)}>{asTable ? t('chartGraph') : t('chartTable')}</button>
        </div>
      </div>
      <div className="small muted chart-sub">{t(METRIC_KEYS[metric][1])}</div>

      <div className="legend small" onMouseLeave={() => setFocus(null)}>
        {players.map((p, i) => (
          <button key={i} type="button" className={`legend-item${emphasis === i ? ' on' : ''}${emphasis !== null && emphasis !== i ? ' dim' : ''}`}
            onMouseEnter={() => !touch && setFocus(i)} onClick={() => setPinned((v) => (v === i ? null : i))} aria-pressed={pinned === i}>
            <i style={{ background: hex(p.color) }} />{p.name}
          </button>
        ))}
      </div>

      {asTable ? (
        <div className="chart-table">
          <table>
            <thead><tr><th>{t('chartTime')}</th>{players.map((p, i) => <th key={i}><i className="key" style={{ background: hex(p.color) }} />{p.name}</th>)}</tr></thead>
            <tbody>
              {minuteRows.map((i) => (
                <tr key={i}><td>{formatTime(sampleTick(summary, i), speed)}</td>{series.map((s, p) => <td key={p}>{fmt(s[i] ?? 0)}</td>)}</tr>
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
              {geo.yt.map((v) => (
                <g key={v}>
                  <line x1={geo.ml} x2={geo.ml + geo.pw} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
                  <text x={geo.ml - 6} y={geo.y(v) + 4} className="tick" textAnchor="end">{v >= 10000 ? `${Math.round(v / 1000)}k` : fmt(v)}</text>
                </g>
              ))}
              {timeTicks(summary.end, speed).map((tk) => (
                <text key={tk} x={geo.x(tk)} y={H - 6} className="tick" textAnchor="middle">{formatTime(tk, speed)}</text>
              ))}
              {summary.battles.map((b, i) => {
                const x0 = geo.x(b.start), x1 = Math.max(x0 + 4, geo.x(b.end));
                return (
                  <g key={i} className="battle-band">
                    <rect x={x0} y={geo.mt} width={x1 - x0} height={geo.ph} />
                    <text x={(x0 + x1) / 2} y={geo.mt + 11} textAnchor="middle">⚔</text>
                  </g>
                );
              })}
              {order.map((p) => (
                <path key={p} d={points(series[p])} className="series" stroke={hex(players[p].color)} opacity={emphasis !== null && emphasis !== p ? 0.18 : 1} />
              ))}
              {order.map((p) => summary.ageUp[p] >= 0 && (emphasis === null || emphasis === p) && (() => {
                const cx = geo.x(summary.ageUp[p]), cy = geo.y(valueAt(series[p], summary.ageUp[p]));
                return <path key={`a${p}`} d={`M${cx},${cy - 5}L${cx + 5},${cy}L${cx},${cy + 5}L${cx - 5},${cy}Z`} fill={hex(players[p].color)} stroke={SURFACE} strokeWidth={2} />;
              })())}
              {order.map((p) => {
                const s = series[p];
                if (!s.length || (emphasis !== null && emphasis !== p)) return null;
                return <circle key={`e${p}`} cx={geo.x(summary.end)} cy={geo.y(s[s.length - 1])} r={4} fill={hex(players[p].color)} stroke={SURFACE} strokeWidth={2} />;
              })}
              {geo.labels && order.map((p) => {
                const s = series[p];
                return <text key={`l${p}`} x={geo.x(summary.end) + 9} y={geo.y(s[s.length - 1] ?? 0) + 4} className="end-label">{players[p].name.slice(0, 13)}</text>;
              })}
              {hover !== null && (
                <g>
                  <line x1={geo.x(hoverTick)} x2={geo.x(hoverTick)} y1={geo.mt} y2={geo.mt + geo.ph} className="crosshair" />
                  {order.map((p) => (emphasis === null || emphasis === p) && (
                    <circle key={`h${p}`} cx={geo.x(hoverTick)} cy={geo.y(series[p][hover] ?? 0)} r={4} fill={hex(players[p].color)} stroke={SURFACE} strokeWidth={2} />
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
            <div className={`chart-tip${tipFlip ? ' flip' : ''}`} style={{ left: tipLeft }}>
              <div className="tip-time">{formatTime(hoverTick, speed)}</div>
              {order.slice().sort((a, b) => (series[b][hover] ?? 0) - (series[a][hover] ?? 0)).map((p) => (
                <div key={p} className="tip-row"><i style={{ background: hex(players[p].color) }} /><b>{fmt(series[p][hover] ?? 0)}</b><span>{players[p].name}</span></div>
              ))}
              {hoverBattle >= 0 && <div className="tip-note">⚔ {t(hoverBattle === 0 ? 'battleBiggest' : 'battleOther')}</div>}
              {agedHere.map((p) => <div key={p} className="tip-note">◆ {players[p].name}: {t('secondAge')}</div>)}
              {touch && onWatch && <button className="primary" onClick={() => onWatch(hoverTick)}>▶ {t('watchFrom', { time: formatTime(hoverTick, speed) })}</button>}
            </div>
          )}
        </div>
      )}
      {!asTable && onWatch && <div className="small muted chart-hint">{t(touch ? 'chartHintTouch' : 'chartHint')}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ the whole report

/**
 * What the results screen, the replay's summary card and a shared link show about a match: the table,
 * the charts behind a tab and the battles under both. Watching and sharing are offered where they work.
 */
export function MatchReport({ summary, players, speed, rows, me, onWatchTick, onWatchBattle, onShareBattle, shareBusy }: {
  summary: MatchSummary | null; players: ReportPlayer[]; speed: number; rows: ResultRow[]; me?: number;
  onWatchTick?: (tick: number) => void; onWatchBattle?: (battle: number) => void; onShareBattle?: (battle: number) => void; shareBusy?: boolean;
}) {
  const t = useT();
  const [tab, setTab] = useState<'table' | 'charts'>('table');
  return (
    <div className="report">
      {summary && (
        <div className="seg report-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'table'} className={tab === 'table' ? 'gold' : 'plain'} onClick={() => setTab('table')}>{t('summaryTab')}</button>
          <button role="tab" aria-selected={tab === 'charts'} className={tab === 'charts' ? 'gold' : 'plain'} onClick={() => setTab('charts')}>📈 {t('chartsTab')}</button>
        </div>
      )}
      {tab === 'charts' && summary ? <MatchCharts summary={summary} players={players} speed={speed} onWatch={onWatchTick} me={me} /> : <ResultsTable rows={rows} />}
      {summary && <BattleList summary={summary} players={players} speed={speed} onWatch={onWatchBattle} onShare={onShareBattle} shareBusy={shareBusy} />}
    </div>
  );
}
