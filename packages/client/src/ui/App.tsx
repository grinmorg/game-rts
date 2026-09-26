import { useEffect, useRef, useState } from 'react';
import { RankedResult } from '@rookfall/protocol';
import { MatchSetup, ReplayData, battlePlayFrom, replayPlayable } from '@rookfall/sim';
import { LocalSession, NetSession, ReplaySession, Session } from '../game/session';
import { Models } from '../game/models';
import { FetchError, ReplayLaunch, ReplayLink, clockTick, computeSummary, fetchReplay, forgetReplayLink, parseReplayLink } from '../game/replayLinks';
import { TKey, formatTime, useT } from '../i18n';
import { net } from '../net/client';
import { AccountScreen, AuthMode } from './Account';
import { About, MainMenu } from './MainMenu';
import { Skirmish, TestMap } from './Skirmish';
import { MapsScreen } from './MapsScreen';
import { PickedMap } from './MapPicker';
import { EditorScreen } from '../editor/EditorScreen';
import { Lobby } from './Lobby';
import { Ranked } from './Ranked';
import { Replays } from './Replays';
import { SettingsScreen } from './Settings';
import { GameScreen } from './GameScreen';
import { LinkErrorScreen, SummaryScreen } from './ReplaySummary';
import { installStressHook, parseStressParam, startStress } from '../game/stress';

type Screen = 'menu' | 'skirmish' | 'lobby' | 'ranked' | 'replays' | 'settings' | 'about' | 'account' | 'game' | 'summary' | 'linkError' | 'maps' | 'editor';

interface GameLaunch {
  session: Session; net: boolean; roomCode?: string; ranked?: boolean; botMatch?: boolean; again?: () => void;
  /** a replay: where it was opened and how */
  launch?: ReplayLaunch;
  /** where leaving goes: a replay back to the list, the room or the ladder it was opened from; an editor test back to the editor */
  returnTo?: Screen;
  /** remounts the game screen for every launch, a replay restarted at another tick included */
  key: number;
}

/** what the loading card says while a replay is fetched, read through or wound forward */
interface Progress { key: TKey; time?: string; done: number }

let launches = 0;

const models = new Models();
let modelsPromise: Promise<void> | null = null;
function loadModels(): Promise<void> { return (modelsPromise ??= models.load()); }

export function App() {
  const t = useT();
  const [screen, setScreen] = useState<Screen>('menu');
  const [game, setGame] = useState<GameLaunch | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [ranked, setRanked] = useState<RankedResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  /** a replay on an earlier version: only its summary can be shown */
  const [summaryOf, setSummaryOf] = useState<{ data: ReplayData; launch: ReplayLaunch; returnTo: Screen } | null>(null);
  const [linkError, setLinkError] = useState<FetchError>('notFound');
  const roomParam = useRef(new URLSearchParams(location.search).get('room') ?? undefined);
  const linkParam = useRef(parseReplayLink(location.search));
  const lobbyCode = useRef<string | undefined>(roomParam.current);
  /** the account screen goes back to where it was opened from, on the tab that fits the way in */
  const [accountFrom, setAccountFrom] = useState<{ screen: Screen; mode: AuthMode }>({ screen: 'menu', mode: 'login' });
  const openAccount = (screen: Screen, mode: AuthMode) => { setAccountFrom({ screen, mode }); setScreen('account'); };
  /** how the skirmish setup opens: preselected on a map from the editor home, or locked to the editor's test map */
  const [skirmishWith, setSkirmishWith] = useState<{ initial?: PickedMap; test?: TestMap }>({});
  const openSkirmish = (w: { initial?: PickedMap; test?: TestMap } = {}) => { setSkirmishWith(w); setScreen('skirmish'); };

  // deep link into a room; preload models in the background so a match can start instantly
  useEffect(() => {
    // every open page holds a socket, so the online counter sees menu-sitters and skirmish players too
    net.connect();
    if (linkParam.current) void openLink(linkParam.current);
    else if (roomParam.current) setScreen('lobby');
    const stress = parseStressParam(new URLSearchParams(location.search).get('stress'));
    if (stress) {
      setLoading(true);
      loadModels().then(() => { setGame({ session: startStress(stress), net: false, key: ++launches }); setScreen('game'); setLoading(false); }).catch((e) => setLoadError(String(e)));
      return;
    }
    loadModels().catch((e) => setLoadError(String(e)));
  }, []);

  // server-started matches (lobby start, ladder pairing or reconnect resume)
  useEffect(() => net.on('start', async (m) => {
    net.clearPendingFrames();
    // create the session synchronously so no tick frame is lost while models load
    const s = new NetSession(net, m.setup, m.mySlot);
    setLoading(true);
    setRanked(null);
    try {
      await loadModels();
      // a ladder room is gone the moment the match ends, so it must not become the lobby's deep link
      lobbyCode.current = m.ranked ? undefined : m.roomCode;
      setGame((g) => { g?.session.dispose(); return { session: s, net: true, roomCode: m.roomCode, ranked: m.ranked, botMatch: m.botMatch, key: ++launches }; });
      setScreen('game');
    } catch (e) { setLoadError(String(e)); }
    setLoading(false);
  }), []);

  // the ladder writes the match down after it ends; the results panel and the ranked screen both show it
  useEffect(() => net.on('rankedResult', (m) => setRanked(m.result)), []);

  const launchLocal = async (setup: MatchSetup, mySlot: number, returnTo?: Screen) => {
    setLoading(true);
    try {
      await loadModels();
      const again = () => launchLocal({ ...setup, seed: (Math.random() * 0x7fffffff) | 0 }, mySlot, returnTo);
      setGame({ session: new LocalSession(setup, mySlot), net: false, again, returnTo, key: ++launches });
      setScreen('game');
    } catch (e) { setLoadError(String(e)); }
    setLoading(false);
  };
  /**
   * Open a replay, wound forward to `launch.from`. A recording on another version of the rules only has
   * its summary to show; one made before summaries existed gets it worked out first, so the charts and the
   * battle marks are there from the first frame.
   */
  const launchReplay = async (data: ReplayData, launch: ReplayLaunch = {}, returnTo: Screen = 'menu') => {
    setLoading(true);
    setLoadError('');
    try {
      if (!replayPlayable(data)) { setSummaryOf({ data, launch, returnTo }); setScreen('summary'); return; }
      await loadModels();
      if (!data.summary) data.summary = await computeSummary(data, (done) => setProgress({ key: 'analyzingReplay', done }));
      const session = new ReplaySession(data);
      if (launch.from) {
        const time = formatTime(launch.from, data.setup.speed ?? 1);
        setProgress({ key: 'seekingReplay', time, done: 0 });
        await session.seekTo(launch.from, (done) => setProgress({ key: 'seekingReplay', time, done }));
      }
      setGame((g) => { if (g && g.session !== session) g.session.dispose(); return { session, net: false, launch, returnTo, key: ++launches }; });
      setScreen('game');
    } catch (e) { setLoadError(String(e)); return; } finally { setProgress(null); }
    setLoading(false);
  };

  /** a shared link: fetch the match, find the moment it points at, open it there */
  const openLink = async (link: ReplayLink) => {
    setLoading(true);
    setProgress({ key: 'loadingReplay', done: 0 });
    const data = await fetchReplay(link.id);
    if (typeof data === 'string') { setProgress(null); setLoading(false); setLinkError(data); setScreen('linkError'); return; }
    const launch: ReplayLaunch = { serverId: link.id, fromLink: true, perspective: -1 };
    if (replayPlayable(data)) {
      try {
        if (!data.summary && link.m !== undefined) data.summary = await computeSummary(data, (done) => setProgress({ key: 'analyzingReplay', done }));
      } catch (e) { setLoadError(String(e)); return; }
      const b = link.m !== undefined ? data.summary?.battles[link.m] : undefined;
      if (b) Object.assign(launch, { from: battlePlayFrom(b), focus: { x: b.x, y: b.y }, battle: link.m });
      else if (link.t !== undefined) launch.from = Math.min(data.tickCount, clockTick(link.t, data.setup.speed ?? 1));
    }
    await launchReplay(data, launch, 'menu');
  };

  /** the replay of the match on screen (or a restart of the replay being watched) */
  const watchFromGame = (data: ReplayData, launch: ReplayLaunch) => {
    const g = game;
    const returnTo: Screen = g?.returnTo ?? (g?.ranked ? 'ranked' : g?.net ? 'lobby' : 'menu');
    void launchReplay(data, launch, returnTo);
  };
  const leaveLink = () => { forgetReplayLink(); linkParam.current = null; setGame(null); setSummaryOf(null); setScreen('menu'); };

  const leaveGame = () => {
    const wasNet = !!game?.net, wasRanked = !!game?.ranked;
    if (game?.launch) {
      // a replay goes back where it was opened from; one opened by a link leaves the link behind too
      const to = game.launch.fromLink ? 'menu' : game.returnTo ?? 'menu';
      if (game.launch.fromLink) { forgetReplayLink(); linkParam.current = null; }
      setGame(null);
      setScreen(to);
      return;
    }
    const returnTo = game?.returnTo;
    setGame(null);
    // a ladder match has no room to go back to; an ordinary online match returns to the room so the
    // same group can play again; an editor test goes back to the editor
    if (wasRanked) { net.send({ t: 'leave' }); setScreen('ranked'); return; }
    setScreen(wasNet ? 'lobby' : returnTo ?? 'menu');
  };
  const leaveLobby = () => { net.send({ t: 'leave' }); lobbyCode.current = undefined; roomParam.current = undefined; setScreen('menu'); };

  if (loading) {
    return (
      <div className="screen">
        <div className="card narrow">
          <h2>{progress ? t(progress.key, { time: progress.time ?? '' }) : t('loading')}</h2>
          {progress && progress.key !== 'loadingReplay' && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.done * 100)}><div style={{ width: `${Math.round(progress.done * 100)}%` }} /></div>}
          {loadError && <p className="error">{loadError}</p>}
          {loadError && <div className="row end"><button onClick={() => { setLoading(false); setLoadError(''); leaveLink(); }}>{t('toMenu')}</button></div>}
        </div>
      </div>
    );
  }
  if (screen === 'game' && game) {
    return <GameScreen key={game.key} session={game.session} models={models} net={game.net ? net : null} isRanked={!!game.ranked} botMatch={!!game.botMatch} ranked={ranked}
      onLeave={leaveGame} onPlayAgain={game.again ? () => { setGame(null); game.again!(); } : undefined}
      launch={game.launch} onWatch={watchFromGame} onPlay={game.launch?.fromLink ? leaveLink : undefined} />;
  }
  switch (screen) {
    case 'summary': return summaryOf
      ? <SummaryScreen data={summaryOf.data} serverId={summaryOf.launch.serverId} localId={summaryOf.launch.localId}
        back={summaryOf.launch.fromLink ? leaveLink : () => setScreen(summaryOf.returnTo)} play={summaryOf.launch.fromLink ? leaveLink : undefined} />
      : <MainMenu go={(sc) => setScreen(sc as Screen)} />;
    case 'linkError': return <LinkErrorScreen error={linkError} back={leaveLink} />;
    case 'skirmish': return (
      <Skirmish
        key={skirmishWith.test ? 'test' : skirmishWith.initial?.id ?? 'skirmish'} initialMap={skirmishWith.initial} testMap={skirmishWith.test}
        back={() => setScreen(skirmishWith.test ? 'editor' : skirmishWith.initial ? 'maps' : 'menu')}
        start={(setup, slot) => launchLocal(setup, slot, skirmishWith.test ? 'editor' : undefined)}
        openEditor={() => setScreen('maps')}
      />
    );
    case 'maps': return <MapsScreen back={() => setScreen('menu')} edit={() => setScreen('editor')} play={(m) => openSkirmish({ initial: m })} signIn={() => openAccount('maps', 'login')} />;
    case 'editor': return <EditorScreen back={() => setScreen('maps')} test={(payload, picked) => openSkirmish({ test: { payload, picked } })} />;
    case 'lobby': return <Lobby key={lobbyCode.current ?? 'lobby'} back={leaveLobby} initialCode={lobbyCode.current} />;
    case 'ranked': return <Ranked back={() => setScreen('menu')} lastResult={ranked} signUp={() => openAccount('ranked', 'register')} />;
    case 'replays': return <Replays back={() => setScreen('menu')} watch={(data, launch) => launchReplay(data, launch, 'replays')} />;
    case 'settings': return <SettingsScreen back={() => setScreen('menu')} />;
    case 'about': return <About back={() => setScreen('menu')} />;
    case 'account': return <AccountScreen back={() => setScreen(accountFrom.screen)} initialMode={accountFrom.mode} />;
    default: return <MainMenu go={(s) => (s === 'account' ? openAccount('menu', 'login') : s === 'skirmish' ? openSkirmish() : setScreen(s as Screen))} />;
  }
}
