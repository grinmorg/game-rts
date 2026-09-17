import { useEffect, useRef, useState } from 'react';
import { RankedResult } from '@rookfall/protocol';
import { MatchSetup, ReplayData } from '@rookfall/sim';
import { LocalSession, NetSession, ReplaySession, Session } from '../game/session';
import { Models } from '../game/models';
import { useT } from '../i18n';
import { net } from '../net/client';
import { About, MainMenu } from './MainMenu';
import { Skirmish } from './Skirmish';
import { Lobby } from './Lobby';
import { Ranked } from './Ranked';
import { Replays } from './Replays';
import { SettingsScreen } from './Settings';
import { GameScreen } from './GameScreen';
import { installStressHook, parseStressParam, startStress } from '../game/stress';

type Screen = 'menu' | 'skirmish' | 'lobby' | 'ranked' | 'replays' | 'settings' | 'about' | 'game';

interface GameLaunch { session: Session; net: boolean; roomCode?: string; ranked?: boolean; again?: () => void }

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
  const roomParam = useRef(new URLSearchParams(location.search).get('room') ?? undefined);
  const lobbyCode = useRef<string | undefined>(roomParam.current);

  // deep link into a room; preload models in the background so a match can start instantly
  useEffect(() => {
    if (roomParam.current) setScreen('lobby');
    const stress = parseStressParam(new URLSearchParams(location.search).get('stress'));
    if (stress) {
      setLoading(true);
      loadModels().then(() => { setGame({ session: startStress(stress), net: false }); setScreen('game'); setLoading(false); }).catch((e) => setLoadError(String(e)));
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
      setGame((g) => { g?.session.dispose(); return { session: s, net: true, roomCode: m.roomCode, ranked: m.ranked }; });
      setScreen('game');
    } catch (e) { setLoadError(String(e)); }
    setLoading(false);
  }), []);

  // the ladder writes the match down after it ends; the results panel and the ranked screen both show it
  useEffect(() => net.on('rankedResult', (m) => setRanked(m.result)), []);

  const launchLocal = async (setup: MatchSetup, mySlot: number) => {
    setLoading(true);
    try {
      await loadModels();
      const again = () => launchLocal({ ...setup, seed: (Math.random() * 0x7fffffff) | 0 }, mySlot);
      setGame({ session: new LocalSession(setup, mySlot), net: false, again });
      setScreen('game');
    } catch (e) { setLoadError(String(e)); }
    setLoading(false);
  };
  const launchReplay = async (data: ReplayData) => {
    setLoading(true);
    try {
      await loadModels();
      setGame({ session: new ReplaySession(data), net: false });
      setScreen('game');
    } catch (e) { setLoadError(String(e)); }
    setLoading(false);
  };
  const leaveGame = () => {
    const wasNet = !!game?.net, wasRanked = !!game?.ranked;
    setGame(null);
    // a ladder match has no room to go back to; an ordinary online match returns to the room so the
    // same group can play again
    if (wasRanked) { net.send({ t: 'leave' }); setScreen('ranked'); return; }
    setScreen(wasNet ? 'lobby' : 'menu');
  };
  const leaveLobby = () => { net.send({ t: 'leave' }); lobbyCode.current = undefined; roomParam.current = undefined; setScreen('menu'); };

  if (loading) return <div className="screen"><div className="card narrow"><h2>{t('loading')}</h2>{loadError && <p className="error">{loadError}</p>}</div></div>;
  if (screen === 'game' && game) return <GameScreen key={game.session.sim.setup.seed} session={game.session} models={models} net={game.net ? net : null} isRanked={!!game.ranked} ranked={ranked} onLeave={leaveGame} onPlayAgain={game.again ? () => { setGame(null); game.again!(); } : undefined} />;
  switch (screen) {
    case 'skirmish': return <Skirmish back={() => setScreen('menu')} start={launchLocal} />;
    case 'lobby': return <Lobby key={lobbyCode.current ?? 'lobby'} back={leaveLobby} initialCode={lobbyCode.current} />;
    case 'ranked': return <Ranked back={() => setScreen('menu')} lastResult={ranked} />;
    case 'replays': return <Replays back={() => setScreen('menu')} watch={launchReplay} />;
    case 'settings': return <SettingsScreen back={() => setScreen('menu')} />;
    case 'about': return <About back={() => setScreen('menu')} />;
    default: return <MainMenu go={(s) => setScreen(s as Screen)} />;
  }
}
