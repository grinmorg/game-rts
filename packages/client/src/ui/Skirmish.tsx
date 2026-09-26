import { useState } from 'react';
import { GAME_SPEEDS, MAX_PLAYERS, MatchSetup, PLAYER_COLORS, PlayerSetup, SIM_VERSION, customMapId } from '@rookfall/sim';
import { useT } from '../i18n';
import { fetchMapData } from '../net/maps';
import { getSettings } from '../settings';
import { MapPicker, PickedMap, officialPick } from './MapPicker';
import { MapPreview } from './MapPreview';
import { MenuBackground } from './MainMenu';
import { mapErrorKey, sizeLabel } from './mapText';

interface SlotCfg { kind: 'me' | 'bot' | 'closed'; difficulty: 0 | 1 | 2; team: number }

/** a map straight from the editor: played from its payload as it is now, saved or not */
export interface TestMap { picked: PickedMap; payload: string }

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
  const [slots, setSlots] = useState<SlotCfg[]>(() => {
    // the editor's test game fills every zone, so the whole map is tried at once
    const all = testMap?.picked.players ?? 2;
    return Array.from({ length: MAX_PLAYERS }, (_, i) => ({ kind: i === 0 ? 'me' : i < all ? 'bot' : 'closed', difficulty: 1, team: i }) as SlotCfg);
  });
  const maxPlayers = picked.players;
  const visible = slots.slice(0, maxPlayers);
  const setSlot = (i: number, patch: Partial<SlotCfg>) => setSlots((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const filled = visible.filter((s) => s.kind !== 'closed');
  const teams = new Set(filled.map((s) => s.team));
  const canStart = filled.length >= 2 && teams.size >= 2 && !loading;

  const onStart = async () => {
    const players: PlayerSetup[] = [];
    let mySlot = 0;
    visible.forEach((s, i) => {
      if (s.kind === 'closed') return;
      const idx = players.length;
      if (s.kind === 'me') mySlot = idx;
      players.push({ slot: idx, team: s.team, name: s.kind === 'me' ? getSettings().name : `${t('bot')} ${idx + 1} (${t(['easy', 'medium', 'hard'][s.difficulty] as 'easy')})`, isBot: s.kind === 'bot', difficulty: s.difficulty, color: PLAYER_COLORS[i] });
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

  return (
    <div className="screen">
      <MenuBackground />
      <div className="card">
        <button className="back" onClick={back}>{t('back')}</button>
        <h2>{testMap ? t('testMapTitle') : t('playAI')}</h2>
        <h3>{t('map')}</h3>
        {testMap ? (
          <div className="picked-custom">
            <div className="picked-thumb"><MapPreview payload={testMap.picked.thumb} fill zones /></div>
            <div>
              <b>{testMap.picked.name}</b>
              <div className="small muted">{sizeLabel(picked.w, picked.h)} · {t('mapPlayersN', { n: picked.players })}</div>
              <div className="small muted">{t('testMapNote')}</div>
            </div>
          </div>
        ) : (
          <MapPicker value={picked} onPick={(m) => { setPicked(m); setError(''); }} openEditor={openEditor} />
        )}
        <h3>{t('gameSpeed')}</h3>
        <div className="row speeds">
          {GAME_SPEEDS.map((v) => (
            <button key={v} className={`speed-btn ${v === speed ? 'primary' : ''}`} onClick={() => setSpeed(v)}>{v}×</button>
          ))}
          <span className="small muted">{t('speedHint')}</span>
        </div>
        <h3>{t('players')}</h3>
        <div className="slots">
          {visible.map((s, i) => (
            <div key={i} className={`slot ${s.kind === 'closed' ? 'closed' : ''}`}>
              <div className="color" style={{ background: '#' + PLAYER_COLORS[i].toString(16).padStart(6, '0') }} />
              <div className="row">
                <select value={s.kind} onChange={(e) => {
                  const kind = e.target.value as SlotCfg['kind'];
                  if (kind === 'me') setSlots((all) => all.map((x, k) => (k === i ? { ...x, kind: 'me' } : x.kind === 'me' ? { ...x, kind: 'bot' } : x)));
                  else setSlot(i, { kind });
                }}>
                  <option value="me">{t('you')}</option>
                  <option value="bot">{t('bot')}</option>
                  <option value="closed">{t('closed')}</option>
                </select>
                {s.kind === 'bot' && (
                  <select value={s.difficulty} onChange={(e) => setSlot(i, { difficulty: Number(e.target.value) as 0 | 1 | 2 })}>
                    <option value={0}>{t('easy')}</option>
                    <option value={1}>{t('medium')}</option>
                    <option value={2}>{t('hard')}</option>
                  </select>
                )}
              </div>
              <label className="small muted">{t('team')}</label>
              <select value={s.team} onChange={(e) => setSlot(i, { team: Number(e.target.value) })} disabled={s.kind === 'closed'}>
                {Array.from({ length: maxPlayers }, (_, k) => <option key={k} value={k}>{k + 1}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="small muted">{t('hardNote')}</p>
        {!canStart && !loading && <p className="small error">{t('needPlayers')}</p>}
        {error && <p className="small error">{error}</p>}
        <div className="row end">
          <button onClick={() => setSlots((all) => all.map((x, k) => (k < maxPlayers && x.kind === 'closed' ? { ...x, kind: 'bot' } : x)))}>{t('fill')}</button>
          <button className="primary" disabled={!canStart} onClick={() => void onStart()}>{loading ? t('loading') : t('start')}</button>
        </div>
      </div>
    </div>
  );
}
