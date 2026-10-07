import { useEffect, useRef, useState } from 'react';
import { installStressHook } from '../game/stress';
import { RankedResult } from '@pocket-of-empire/protocol';
import { BattleMoment, MatchSummary, ReplayData, battlePlayFrom } from '@pocket-of-empire/sim';
import { formatTime, useT } from '../i18n';
import { GameView, HudState } from '../game/view';
import { LocalSession, ReplaySession, Session } from '../game/session';
import { Models } from '../game/models';
import { NetClient } from '../net/client';
import { ReplayLaunch } from '../game/replayLinks';
import { saveLocalReplay, setLocalReplayServerId } from '../store';
import { ReportPlayer, shareTitle, useReplayShare } from './MatchReport';
import { useTouchUI } from '../touch';
import { Icon } from './icons/Icon';
import { BottomBar } from './hud/BottomBar';
import { Messages } from './hud/Messages';
import { OrientationPrompt } from './hud/OrientationPrompt';
import { PauseMenu } from './hud/PauseMenu';
import { MomentBanner, ReplayControls } from './hud/ReplayControls';
import { ReplaySummaryOverlay, ResultsOverlay } from './hud/ResultsOverlay';
import { TopBar } from './hud/TopBar';

/** a jump in the replay being watched shows its progress on the bar only once it has taken this long */
const SEEK_BAR_DELAY_MS = 150;

export interface GameScreenProps {
  session: Session;
  models: Models;
  net: NetClient | null;
  /** ladder match: the results panel waits for the rating change and shows it */
  isRanked?: boolean;
  /** ladder queue could not find a human and gave the player a bot: the match is not rated */
  botMatch?: boolean;
  ranked?: RankedResult | null;
  onLeave: () => void;
  onPlayAgain?: () => void;
  /** a replay opened at a moment: where it starts, what the camera looks at, what the banner names */
  launch?: ReplayLaunch;
  /** open this match's replay (or restart the one being watched) at a moment */
  onWatch?: (data: ReplayData, launch: ReplayLaunch) => void;
  /** someone who came by a link wants to play the game */
  onPlay?: () => void;
}

export function GameScreen({ session, models, net, isRanked, botMatch, ranked, onLeave, onPlayAgain, launch, onWatch, onPlay }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GameView | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const view = new GameView(canvas, session, models, net);
    viewRef.current = view;
    (window as unknown as { __pocketOfEmpire?: GameView }).__pocketOfEmpire = view; // debug / e2e hook
    const unsub = view.subscribe(setHud);
    if (session instanceof ReplaySession) {
      // a replay opened at a moment arrives already wound forward to it
      if (launch?.perspective !== undefined) view.setPerspective(launch.perspective);
      if (launch?.focus) view.centerOn(launch.focus.x, launch.focus.y);
      if (launch?.speed) view.setSpeed(launch.speed);
      view.afterSeek();
    }
    view.start();
    if (session instanceof LocalSession && location.search.includes('stress=')) installStressHook(view, session);
    return () => { unsub(); view.dispose(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />
      {hud && viewRef.current && <Hud hud={hud} view={viewRef.current} net={net} isRanked={isRanked} botMatch={botMatch} ranked={ranked} onLeave={onLeave} onPlayAgain={onPlayAgain} launch={launch} onWatch={onWatch} onPlay={onPlay} />}
    </div>
  );
}

interface HudProps extends Pick<GameScreenProps, 'isRanked' | 'botMatch' | 'ranked' | 'onLeave' | 'onPlayAgain' | 'launch' | 'onWatch' | 'onPlay'> {
  hud: HudState; view: GameView; net: NetClient | null;
}

function Hud({ hud, view, net, isRanked, botMatch, ranked, onLeave, onPlayAgain, launch, onWatch, onPlay }: HudProps) {
  const t = useT();
  const touch = useTouchUI();
  // the hovered button is tracked by id, so the card keeps showing live gold, cooldowns and requirements
  const [tipId, setTipId] = useState<string | null>(null);
  const [savedReplay, setSavedReplay] = useState(false);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const session = view.session;
  const replaySession = session instanceof ReplaySession ? session : null;
  const players: ReportPlayer[] = session.setup.players.map((pl) => ({ name: pl.name, color: pl.color, team: pl.team }));
  const speed = session.setup.speed ?? 1;
  /** the copy of this match in the saved replays, once there is one */
  const [localId, setLocalId] = useState(launch?.localId);
  const share = useReplayShare(() => session.replay(), launch?.serverId, (id) => { if (localId) setLocalReplayServerId(localId, id); },
    session.keyframeAt ? (tick) => session.keyframeAt!(tick) : undefined);
  // an online match is saved by the server, which says under what id once it is over
  useEffect(() => net?.on('gameOver', (m) => { if (m.replayId) share.setId(m.replayId); }), [net]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showSummary, setShowSummary] = useState(false);
  const [bannerClosed, setBannerClosed] = useState(false);
  /** the battle the banner names: the one the replay was opened at, or the one jumped to since */
  const [battle, setBattle] = useState(launch?.battle);
  const [seeking, setSeeking] = useState<number | null>(null);
  const replaySummary = replaySession?.data.summary ?? null;

  /**
   * With a mouse the card follows the cursor and leaves with it. A finger has no cursor to leave, so the
   * card is a popover: anything touched outside it - the map, the minimap, another panel - puts it away.
   * The press that opened it has already happened by the time this is listening, so it cannot close itself.
   */
  useEffect(() => {
    if (!touch || !tipId) return;
    const close = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.('.hud-tip, .cmd-btn')) return; // the card itself, or the button that swaps it
      setTipId(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [touch, tipId]);

  const tip = tipId ? hud.panel.find((b) => b.id === tipId) ?? null : null;
  const isReplay = !!hud.replay;
  const spectator = hud.mySlot < 0;

  const saveReplay = () => {
    const data: ReplayData | null = view.session.replay();
    if (data) { setLocalId(saveLocalReplay(data, share.id).id); setSavedReplay(true); }
  };

  /** open the replay at a tick: this match's, or a restart of the one being watched (a jump back has to replay from the start) */
  const watch = (from: number, extra: ReplayLaunch = {}) => {
    const data = onWatch && session.replay();
    if (!data) return;
    onWatch!(data, { serverId: share.id, localId, fromLink: launch?.fromLink, speed: replaySession?.speed, perspective: replaySession ? view.perspective : -1, ...extra, from });
  };
  /**
   * Move the replay being watched to another moment, forward or back, in place (see ReplaySession.seekTo). A jump
   * from a keyframe is over at once; the bar shows how far one has got only when it takes a while.
   */
  const busySeek = useRef(false);
  const seekReplay = async (tick: number, then?: () => void) => {
    if (!replaySession || busySeek.current) return;
    busySeek.current = true;
    const wasPaused = replaySession.paused;
    replaySession.paused = true;
    let shown = false;
    const slow = window.setTimeout(() => { shown = true; setSeeking(0); }, SEEK_BAR_DELAY_MS);
    try {
      const jumped = await replaySession.seekTo(tick, (done) => { if (shown) setSeeking(done); });
      replaySession.paused = wasPaused;
      view.afterSeek(jumped);
      then?.();
    } finally {
      clearTimeout(slow);
      replaySession.paused = wasPaused;
      busySeek.current = false;
      setSeeking(null);
    }
  };
  const watchBattle = (s: MatchSummary, i: number) => {
    const b = s.battles[i];
    if (!b) return;
    if (replaySession) {
      void seekReplay(battlePlayFrom(b), () => { setBattle(i); setBannerClosed(false); view.setPerspective(-1); view.centerOn(b.x, b.y); });
      return;
    }
    watch(battlePlayFrom(b), { battle: i, focus: { x: b.x, y: b.y }, perspective: -1 });
  };
  /** the scrubber; a jump back leaves the battle the banner named */
  const jumpTo = (tick: number) => {
    const back = !!replaySession && tick < replaySession.sim.tick;
    void seekReplay(tick, () => { if (back) setBattle(undefined); });
  };
  const title = shareTitle(players);
  const matchOver = !!hud.gameOver && !hud.gameOver.canContinue;
  const bannerBattle: BattleMoment | undefined = battle !== undefined ? replaySummary?.battles[battle] : undefined;

  const replayCenter = hud.replay ? (
    <>
      <ReplayControls hud={{ ...hud, replay: hud.replay }} view={view} speed={speed} summary={replaySummary} share={share} title={title} seeking={seeking}
        onSummary={() => setShowSummary(true)} onJump={jumpTo} onBattle={(i) => replaySummary && watchBattle(replaySummary, i)} />
      {hud.replay.desyncTick >= 0 && <div className="replay-warn" role="alert"><Icon name="warning" /><span>{t('replayDesync', { time: formatTime(hud.replay.desyncTick, speed) })}</span></div>}
      {replaySession && (bannerBattle || launch?.fromLink) && !bannerClosed && !hud.gameOver && (
        <MomentBanner battle={bannerBattle} battleIndex={battle} players={players} speed={speed} summary={replaySummary}
          onWatchAgain={() => watchBattle(replaySummary!, battle!)} onWholeMatch={() => void seekReplay(0, () => setBattle(undefined))}
          onSummary={() => setShowSummary(true)} onPlay={launch?.fromLink ? onPlay : undefined} onClose={() => setBannerClosed(true)} />
      )}
    </>
  ) : null;

  return (
    // a mouse press on a HUD button must not leave it focused: Space or Enter would press it again (keyboard focus still works)
    <div className={`hud${touch ? ' touch' : ''}`} onMouseDown={(e) => { if ((e.target as Element).closest?.('button')) e.preventDefault(); }}>
      <TopBar hud={hud} view={view} touch={touch} isReplay={isReplay} center={replayCenter} />

      {!touch && hud.hint && <div className="hud-hint" role="status">{hud.hint}</div>}
      {hud.drag && <div className="selbox" style={{ left: hud.drag.x, top: hud.drag.y, width: hud.drag.w, height: hud.drag.h }} />}

      <Messages view={view} messages={hud.messages} chatOpen={hud.chatOpen} />
      <BottomBar hud={hud} view={view} touch={touch} isReplay={isReplay} tip={tip} onTip={setTipId} />

      {touch && <OrientationPrompt />}

      {hud.menuOpen && !hud.gameOver && (
        <PauseMenu view={view} touch={touch} spectator={spectator} isReplay={isReplay} isRanked={isRanked}
          savedReplay={savedReplay} onSaveReplay={saveReplay} voteDraw={hud.voteDraw}
          confirmSurrender={confirmSurrender} setConfirmSurrender={setConfirmSurrender} confirmLeave={confirmLeave} setConfirmLeave={setConfirmLeave}
          onLeave={onLeave} />
      )}

      {hud.gameOver && !hud.gameOver.dismissed && (
        <ResultsOverlay gameOver={hud.gameOver} view={view} players={players} speed={speed} mySlot={hud.mySlot}
          isRanked={isRanked} ranked={ranked} botMatch={botMatch} isReplay={isReplay} matchOver={matchOver}
          share={share} title={title} savedReplay={savedReplay} onSaveReplay={saveReplay}
          onPlayAgain={onPlayAgain} fromLink={launch?.fromLink} onPlay={onPlay} onLeave={onLeave}
          onWatchTick={matchOver && onWatch ? (tk) => {
            // a replay that has played to its end goes back in place; a match just finished opens its replay
            if (replaySession) void seekReplay(tk, () => { setBattle(undefined); view.setPerspective(-1); });
            else watch(tk, { perspective: -1 });
          } : undefined}
          onWatchBattle={matchOver && onWatch && hud.gameOver.summary ? (i) => watchBattle(hud.gameOver!.summary!, i) : undefined}
          onShareBattle={matchOver ? (i) => share.share({ m: i }, title) : undefined} />
      )}

      {/* the report of the replay being watched, on demand */}
      {showSummary && replaySummary && !hud.gameOver && (
        <ReplaySummaryOverlay summary={replaySummary} players={players} speed={speed} share={share} title={title}
          onClose={() => setShowSummary(false)}
          onWatchTick={(tk) => { setShowSummary(false); void jumpTo(tk); }}
          onWatchBattle={(i) => { setShowSummary(false); watchBattle(replaySummary, i); }} />
      )}
    </div>
  );
}
