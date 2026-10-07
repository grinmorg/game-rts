import { BattleMoment, MatchSummary, TICK_RATE } from '@pocket-of-empire/sim';
import { formatTime, useT } from '../../i18n';
import { GameView, HudState } from '../../game/view';
import { clockSeconds } from '../../game/replayLinks';
import { ReportPlayer, ShareStatus, useReplayShare } from '../MatchReport';
import { Icon } from '../icons/Icon';

type ReplayShare = ReturnType<typeof useReplayShare>;
const SPEEDS = [1, 2, 4, 8];

/**
 * The replay's island, top-centre where a player's economy would be: play/pause, the speed as a scale bar, the clock, the
 * report and a link to the moment on screen; under them the timeline with the battles marked on it.
 */
export function ReplayControls({ hud, view, speed, summary, share, title, seeking, onSummary, onJump, onBattle }: {
  hud: HudState & { replay: NonNullable<HudState['replay']> }; view: GameView; speed: number; summary: MatchSummary | null;
  share: ReplayShare; title: string; seeking: number | null;
  onSummary: () => void; onJump: (tick: number) => void; onBattle: (i: number) => void;
}) {
  const t = useT();
  const cur = hud.replay.speed;
  /** arrows move the speed along the scale (a radiogroup), and do not also pan the camera */
  const speedKey = (e: React.KeyboardEvent) => {
    const i = SPEEDS.indexOf(cur);
    const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? SPEEDS[Math.max(0, i - 1)] : undefined;
    if (next === undefined) return;
    e.preventDefault(); e.stopPropagation();
    view.setSpeed(next);
    (e.currentTarget.querySelector(`[data-speed="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="replay-ctl hud-isle">
      <div className="replay-buttons">
        <button className="hud-btn hud-btn--icon replay-play" onClick={() => view.togglePause()} aria-label={t(hud.replay.paused ? 'play' : 'pause')} title={t(hud.replay.paused ? 'play' : 'pause')}>
          <Icon name={hud.replay.paused ? 'play' : 'pause'} />
        </button>
        <div className="scalebar scalebar--sm hud-speeds" role="radiogroup" aria-label={t('hudReplaySpeed')} onKeyDown={speedKey}>
          {SPEEDS.map((s) => (
            <button key={s} role="radio" data-speed={s} aria-checked={cur === s} tabIndex={cur === s ? 0 : -1} onClick={() => view.setSpeed(s)}>{s}×</button>
          ))}
        </div>
        <span className="replay-time">{hud.time}<small> / {formatTime(hud.replay.total, hud.replay.matchSpeed)}</small></span>
        <span className="replay-gap" />
        {summary && <button className="hud-btn hud-btn--icon" onClick={onSummary} title={t('matchSummary')} aria-label={t('matchSummary')}><Icon name="summary" /></button>}
        <button className="hud-btn hud-btn--icon" onClick={() => share.share({ t: clockSeconds(hud.tick, speed) }, title)} disabled={share.busy} title={t('shareAtTime')} aria-label={t('shareAtTime')}><Icon name="link" /></button>
      </div>
      <ReplayBar tick={hud.tick} total={hud.replay.total} speed={speed} battles={summary?.battles ?? []} seeking={seeking}
        onJump={onJump} onBattle={onBattle} />
      {!hud.gameOver && <ShareStatus state={share.state} />}
    </div>
  );
}

/**
 * The replay's timeline: how far it has played, the battles marked where they happened (a click opens
 * one), and a click anywhere else jumps there. While a jump winds forward the bar shows its progress.
 */
export function ReplayBar({ tick, total, speed, battles, seeking, onJump, onBattle }: {
  tick: number; total: number; speed: number; battles: BattleMoment[]; seeking: number | null;
  onJump: (tick: number) => void; onBattle: (i: number) => void;
}) {
  const t = useT();
  const pct = total > 0 ? Math.min(100, (tick / total) * 100) : 0;
  const at = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total);
  };
  const step = 30 * TICK_RATE * (speed || 1);
  return (
    <div className={`replay-bar${seeking !== null ? ' seeking' : ''}`} role="slider" tabIndex={0} aria-label={t('replayTimeline')} title={t('replayTimeline')}
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={tick} aria-valuetext={formatTime(tick, speed)}
      onClick={(e) => onJump(at(e))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onJump(Math.min(total, tick + step));
        else if (e.key === 'ArrowLeft') onJump(Math.max(0, tick - step));
        else return;
        e.preventDefault(); e.stopPropagation();
      }}>
      <div className="fill" style={{ width: `${pct}%` }} />
      <span className="replay-bar__head" style={{ left: `${pct}%` }} aria-hidden="true" />
      {battles.map((b, i) => (
        <span key={i} role="button" tabIndex={0} className={`mark${i === 0 ? ' is-big' : ''}`} style={{ left: `${(b.start / Math.max(1, total)) * 100}%` }}
          title={`${t(i === 0 ? 'battleBiggest' : 'battleOther')} · ${formatTime(b.start, speed)}`}
          onClick={(e) => { e.stopPropagation(); onBattle(i); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onBattle(i); } }}><Icon name="battle" /></span>
      ))}
      {seeking !== null && <div className="seek" style={{ width: `${Math.round(seeking * 100)}%` }} />}
    </div>
  );
}

/** what a replay opened at a battle (or from a link) shows over the map: which one, and where to go from here */
export function MomentBanner({ battle, battleIndex, players, speed, summary, onWatchAgain, onWholeMatch, onSummary, onPlay, onClose }: {
  battle: BattleMoment | undefined; battleIndex: number | undefined; players: ReportPlayer[]; speed: number; summary: MatchSummary | null;
  onWatchAgain: () => void; onWholeMatch: () => void; onSummary: () => void; onPlay?: () => void; onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="moment-banner hud-isle" role="region" aria-label={t('moments')}>
      <div className="moment-title">
        {battle
          ? <><Icon name="battle" /><b>{t(battleIndex === 0 ? 'battleBiggest' : 'battleOther')}</b><span className="moment-meta">{t('battleLine', { time: formatTime(battle.start, speed), n: battle.deaths })}</span></>
          : <b>{players.length > 6 ? t('mapPlayersN', { n: players.length }) : players.map((pl) => pl.name).join(players.length === 2 ? ' — ' : ', ')}</b>}
        <button className="hud-btn hud-btn--icon moment-close" onClick={onClose} title={t('close')} aria-label={t('close')}><Icon name="close" /></button>
      </div>
      <div className="moment-actions">
        {battle && <button className="hud-btn" onClick={onWatchAgain}><Icon name="replay-again" />{t('watchAgain')}</button>}
        {battle && <button className="hud-btn" onClick={onWholeMatch}><Icon name="to-start" />{t('wholeMatch')}</button>}
        {summary && <button className="hud-btn" onClick={onSummary}><Icon name="summary" />{t('matchSummary')}</button>}
        {onPlay && <button className="btn btn--seal btn--compact moment-play" onClick={onPlay}><Icon name="play-game" />{t('playYourself')}</button>}
      </div>
    </div>
  );
}
