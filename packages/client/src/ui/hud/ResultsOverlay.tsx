import { KeyboardEvent, ReactNode, RefObject, useEffect, useRef, useState } from 'react';
import { PLACEMENT_GAMES, RankedResult, levelFromXp } from '@pocket-of-empire/protocol';
import { MatchSummary } from '@pocket-of-empire/sim';
import { TKey, formatTime, useT } from '../../i18n';
import { GameView, HudGameOver } from '../../game/view';
import { STORAGE_PREFIX } from '../../legacyStorage';
import { downloadReplay, listLocalReplays } from '../../store';
import { MatchReport, Pennant, ReportPlayer, ShareStatus, Slip, rowsFromSummary, teamStyle, useReplayShare } from '../MatchReport';
import { TierBadge } from '../Ranked';
import { Icon } from '../icons/Icon';

type ReplayShare = ReturnType<typeof useReplayShare>;

// ------------------------------------------------------------------ modal behaviour

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A sheet over the match behaves as a modal: focus moves into it when it opens (to `initial`, else the sheet itself)
 * and back to where it was when it closes, Tab cycles inside it, and keys pressed in it stay out of the game's hotkeys
 * (Enter would open the chat behind it, digits would recall control groups). Escape is the exception: `onEscape`
 * handles it here, `passEscape` lets the game have it (the pause menu: Esc toggles the menu), otherwise it is dropped.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, opts: { initial?: string; passEscape?: boolean; onEscape?: () => void } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ((opts.initial ? el.querySelector<HTMLElement>(opts.initial) : null) ?? el).focus({ preventScroll: true });
    return () => { if (opener && opener !== document.body && document.contains(opener)) opener.focus({ preventScroll: true }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (opts.onEscape) { e.preventDefault(); e.stopPropagation(); opts.onEscape(); }
      else if (!opts.passEscape) e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === ref.current)) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && at === last) { first.focus(); e.preventDefault(); }
  };
}

// ------------------------------------------------------------------ saving the replay

type SaveOutcome = { kind: 'saved'; evicted: number } | { kind: 'failed' };
/** per match (view), so the pause menu and the results agree and the answer outlives either of them */
const saveOutcomes = new WeakMap<GameView, SaveOutcome>();
const REPLAYS_KEY = `${STORAGE_PREFIX}replays`;
const readReplays = (): string | null => { try { return localStorage.getItem(REPLAYS_KEY); } catch { return null; } };

/**
 * "Save replay", told truthfully. The store swallows a full quota and quietly drops the oldest recordings to make
 * room, and the HUD marks the match saved either way, so the stored list is looked at around the save: unchanged
 * means it did not fit (the button stays live, the slip offers the file instead), shorter than expected means older
 * replays were dropped for it (the slip says how many).
 */
export function useReplaySave(view: GameView, savedReplay: boolean, onSaveReplay: () => void) {
  const [, redraw] = useState(0);
  const outcome = saveOutcomes.get(view);
  const save = () => {
    const before = readReplays();
    const countBefore = listLocalReplays().length;
    onSaveReplay();
    const after = readReplays();
    const ok = after !== null && after !== before;
    saveOutcomes.set(view, ok ? { kind: 'saved', evicted: Math.max(0, countBefore + 1 - listLocalReplays().length) } : { kind: 'failed' });
    redraw((n) => n + 1);
  };
  const state: 'idle' | 'saved' | 'failed' = outcome?.kind === 'failed' ? 'failed' : savedReplay || outcome?.kind === 'saved' ? 'saved' : 'idle';
  const download = () => { const data = view.session.replay(); if (data) downloadReplay(data); };
  return { state, evicted: outcome?.kind === 'saved' ? outcome.evicted : 0, save, download };
}

/** what became of the save, as a slip: dropped older replays, or no room at all (with the file as the way out) */
export function SaveSlip({ save }: { save: ReturnType<typeof useReplaySave> }) {
  const t = useT();
  if (save.state === 'failed') {
    return (
      <Slip kind="error">
        {t('replaySaveFailed')}{' '}
        <button type="button" className="btn btn--quiet btn--small status-slip__act" onClick={save.download}><Icon name="download" />{t('download')}</button>
      </Slip>
    );
  }
  if (save.state === 'saved' && save.evicted > 0) return <Slip kind="info">{t('replayEvicted', { n: save.evicted })}</Slip>;
  return null;
}

/** "Сохранить реплей" with its state: saved = a tick and dashed (done), failed = live again */
function SaveButton({ save, className, short }: { save: ReturnType<typeof useReplaySave>; className: string; short?: boolean }) {
  const t = useT();
  const saved = save.state === 'saved';
  const label = saved ? t('replaySaved') : t('saveReplay');
  return (
    <button type="button" className={className} onClick={save.save} disabled={saved} aria-label={short ? label : undefined}>
      <Icon name={saved ? 'check' : 'save'} />
      {short ? <><span className="lbl-long">{label}</span><span className="lbl-short" aria-hidden>{saved ? label : t('saveReplayShort')}</span></> : label}
    </button>
  );
}

// ------------------------------------------------------------------ the results

const VERDICT_KEYS: Record<HudGameOver['result'], TKey> = { victory: 'victory', defeat: 'defeat', draw: 'draw', spectator: 'gameOver' };

/**
 * The end of a match (or of our part in it), a framed sheet over the frozen map: the verdict with its flag (and the
 * wax seal on a victory), when / who / where, the ladder's word on a ranked match, the report, and what to do next.
 * The one seal is the order you would give now: play again, play it yourself (came by a link), keep watching (we are
 * out, the match goes on) - or, when nothing else is on offer, leave.
 */
export function ResultsOverlay({
  gameOver, view, players, speed, mySlot, isRanked, ranked, botMatch, isReplay, matchOver, share, title, savedReplay, onSaveReplay,
  onPlayAgain, fromLink, onPlay, onLeave, onWatchTick, onWatchBattle, onShareBattle,
}: {
  gameOver: HudGameOver; view: GameView; players: ReportPlayer[]; speed: number; mySlot: number;
  isRanked?: boolean; ranked?: RankedResult | null; botMatch?: boolean; isReplay: boolean; matchOver: boolean;
  share: ReplayShare; title: string; savedReplay: boolean; onSaveReplay: () => void;
  onPlayAgain?: () => void; fromLink?: boolean; onPlay?: () => void; onLeave: () => void;
  onWatchTick?: (tick: number) => void; onWatchBattle?: (battle: number) => void; onShareBattle?: (battle: number) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const onKeyDown = useModalFocus(ref);
  const save = useReplaySave(view, savedReplay, onSaveReplay);
  const result = gameOver.result;
  const me = mySlot >= 0 ? players[mySlot] : undefined;
  const kind = view.session.kind;
  const kindLabel = kind === 'replay' ? t('kindReplay') : kind === 'net' ? t(isRanked ? 'kindRanked' : 'multiplayer') : t('playAI');
  const over = gameOver.canContinue ? t('youAreOut') : result === 'spectator' ? kindLabel : `${t('gameOver')} · ${kindLabel}`;
  const winners = !gameOver.canContinue && gameOver.winnerTeam >= 0 ? players.filter((p) => p.team === gameOver.winnerTeam) : [];
  let mapName = '';
  try { mapName = view.sim.map.name; } catch { /* a view without a map: no place line */ }

  const leave = (asSeal: boolean) => (
    <button type="button" className={asSeal ? 'btn btn--seal' : 'btn btn--secondary'} onClick={onLeave}>{t('leaveGame')}</button>
  );
  let seal: ReactNode;
  if (gameOver.canContinue) seal = <button type="button" className="btn btn--seal" onClick={() => view.dismissGameOver()}>{t('watch')}</button>;
  else if (fromLink && onPlay) seal = <button type="button" className="btn btn--seal" onClick={onPlay}>{t('playYourself')}</button>;
  else if (matchOver && onPlayAgain) seal = <button type="button" className="btn btn--seal" onClick={onPlayAgain}>{t('playAgain')}</button>;

  return (
    <div className="overlay scrim rs-scrim" data-testid="results-overlay">
      <section ref={ref} className="dialog sheet sheet--framed results rs" role="dialog" aria-modal="true" aria-labelledby="rs-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="rs-head">
          <p className="rs-over">{over}</p>
          <div className="rs-verdict">
            <span className="rs-flag" style={me ? teamStyle(me.color) : undefined}><Icon name="flag" /></span>
            <h1 id="rs-title" className={`rs-title banner ${result === 'spectator' ? 'gameover' : result}`} data-testid="results-banner">{t(VERDICT_KEYS[result])}</h1>
            {result === 'victory' && <span className="seal seal--lg rs-stamp" aria-hidden />}
          </div>
          <p className="rs-facts">
            <span className="rs-fact"><Icon name="timer" /><span className="num">{gameOver.duration}</span></span>
            {winners.length === 1 && <Pennant name={t('winnerIs', { name: winners[0].name })} color={winners[0].color} className="rs-fact" />}
            {winners.length > 1 && <Pennant name={t('winnerTeamIs', { n: gameOver.winnerTeam + 1 })} color={winners[0].color} className="rs-fact" />}
            {mapName && <span className="rs-fact rs-fact--map"><Icon name="pin" /><em>{mapName}</em></span>}
          </p>
        </header>
        <div className="rs-body">
          {isRanked && <RankedPanel result={ranked ?? null} botMatch={botMatch} />}
          {/* while the match goes on without us there is no replay to open or link to yet */}
          <MatchReport summary={gameOver.summary} players={players} speed={speed} rows={gameOver.rows} me={mySlot} winnerTeam={gameOver.canContinue ? -1 : gameOver.winnerTeam}
            onWatchTick={onWatchTick} onWatchBattle={onWatchBattle} onShareBattle={onShareBattle} shareBusy={share.busy} />
        </div>
        <footer className="dialog__foot rs-foot">
          <div className="rs-slips">
            <ShareStatus state={share.state} />
            <SaveSlip save={save} />
          </div>
          {matchOver && !isReplay && <SaveButton save={save} className="btn btn--quiet" short />}
          {matchOver && (
            <button type="button" className="btn btn--quiet" onClick={() => share.share({}, title)} disabled={share.busy} aria-label={t('shareMatch')}>
              <Icon name="link" /><span className="lbl-long">{t('shareMatch')}</span><span className="lbl-short" aria-hidden>{t('shareMoment')}</span>
            </button>
          )}
          <span className="spacer" />
          {isReplay && matchOver && onWatchTick && !seal && (
            <button type="button" className="btn btn--secondary" onClick={() => onWatchTick(0)}><Icon name="replay" />{t('watchAgain')}</button>
          )}
          {seal ? <>{leave(false)}{seal}</> : leave(true)}
        </footer>
      </section>
    </div>
  );
}

/** the report of the replay being watched, on demand; a click outside or Esc closes it */
export function ReplaySummaryOverlay({ summary, players, speed, share, title, onClose, onWatchTick, onWatchBattle }: {
  summary: MatchSummary; players: ReportPlayer[]; speed: number; share: ReplayShare; title: string;
  onClose: () => void; onWatchTick: (tick: number) => void; onWatchBattle: (battle: number) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const onKeyDown = useModalFocus(ref, { initial: '.dialog__close', onEscape: onClose });
  const shown = players.slice(0, 4);
  return (
    <div className="overlay scrim rs-scrim" onClick={onClose}>
      <section ref={ref} className="dialog sheet sheet--framed results rs rs--summary" role="dialog" aria-modal="true" aria-labelledby="rs-sum-title"
        tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <header className="rs-head rs-head--row">
          <div className="rs-head__main">
            <h2 className="dialog__title" id="rs-sum-title">{t('matchSummary')}</h2>
            <p className="rs-facts">
              <span className="rs-fact"><Icon name="timer" /><span className="num">{formatTime(summary.end, speed)}</span></span>
              {shown.map((p, i) => <Pennant key={i} name={p.name} color={p.color} split className="rs-fact" />)}
              {players.length > shown.length && <span className="rs-fact num">+{players.length - shown.length}</span>}
            </p>
          </div>
          <button type="button" className="btn btn--quiet btn--icon dialog__close" aria-label={t('close')} onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="rs-body">
          <MatchReport summary={summary} players={players} speed={speed} rows={rowsFromSummary(summary, players)}
            onWatchTick={onWatchTick} onWatchBattle={onWatchBattle}
            onShareBattle={(i) => share.share({ m: i }, title)} shareBusy={share.busy} />
        </div>
        <footer className="dialog__foot rs-foot">
          <div className="rs-slips"><ShareStatus state={share.state} /></div>
          <button type="button" className="btn btn--quiet" onClick={() => share.share({}, title)} disabled={share.busy}><Icon name="link" />{t('shareMatch')}</button>
          <span className="spacer" />
          <button type="button" className="btn btn--secondary" onClick={onClose}><Icon name="back" />{t('backToReplay')}</button>
        </footer>
      </section>
    </div>
  );
}

/**
 * The ladder's word on a ranked match, between the verdict and the report: the settlement sign of the rank, the
 * rating before → after with the change in tabular figures, experience and level, the placement count. The ladder
 * writes the match down a moment after the game ends, so it waits with a turning compass needle first.
 */
export function RankedPanel({ result, botMatch }: { result: RankedResult | null; botMatch?: boolean }) {
  const t = useT();
  if (botMatch) return <div className="rs-ranked rs-ranked--note"><Icon name="info" /><span>{t('botMatchNote')}</span></div>;
  if (!result) return <div className="rs-ranked rs-ranked--note" role="status"><span className="spinner" aria-hidden /><span>{t('ratingPending')}</span></div>;
  const up = result.delta >= 0;
  const level = levelFromXp(result.profile.xp);
  const levelUp = level > result.levelBefore;
  return (
    <div className="rs-ranked" role="status">
      <TierBadge profile={result.profile} size="small" />
      <div className="rs-ranked__rating">
        <span className="rs-ranked__label">{t('ratingChange')}</span>
        <span className="num rs-ranked__before">{result.ratingBefore}</span>
        <span className="rs-ranked__arrow" aria-hidden>→</span>
        <b className="num rs-ranked__after">{result.ratingAfter}</b>
        <b className={`num rs-ranked__delta ${up ? 'is-up' : 'is-down'}`}>{up ? '+' : '−'}{Math.abs(result.delta)}</b>
      </div>
      <dl className="rs-ranked__facts">
        <div><dt>{t('xpGained')}</dt><dd className="num">+{result.xpGained}</dd></div>
        <div className={levelUp ? 'is-up' : undefined}><dt>{t('ratingLevel')}</dt><dd className="num">{level}{levelUp && <span className="badge badge--ok">{t('levelUp')}</span>}</dd></div>
        <div><dt>{t('opponent')}</dt><dd>{result.opponent.name} <span className="num">({result.opponent.rating})</span></dd></div>
        {result.placement && <div><dt className="sr-only">{t('placement')}</dt><dd>{t('placementLeft', { n: PLACEMENT_GAMES - result.profile.games })}</dd></div>}
      </dl>
    </div>
  );
}
