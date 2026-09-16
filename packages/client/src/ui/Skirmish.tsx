import { useState } from 'react';
import { GAME_SPEEDS, MatchSetup, OFFICIAL_MAPS, PLAYER_COLORS, PlayerSetup, SIM_VERSION } from '@warlets/sim';
import { useT } from '../i18n';
import { getSettings } from '../settings';
import { MapPreview } from './MapPreview';
import { MenuBackground } from './MainMenu';

interface SlotCfg { kind: 'me' | 'bot' | 'closed'; difficulty: 0 | 1 | 2; team: number }

export function Skirmish({ back, start }: { back: () => void; start: (setup: MatchSetup, mySlot: number) => void }) {
  const t = useT();
  const [mapId, setMapId] = useState('duel-valley');
  const [speed, setSpeed] = useState(1);
  const [slots, setSlots] = useState<SlotCfg[]>(() => [{ kind: 'me', difficulty: 1, team: 0 }, { kind: 'bot', difficulty: 1, team: 1 }, ...Array.from({ length: 4 }, (_, i) => ({ kind: 'closed' as const, difficulty: 1 as const, team: i + 2 }))]);
  const map = OFFICIAL_MAPS.find((m) => m.id === mapId)!;
  const visible = slots.slice(0, map.maxPlayers);
  const setSlot = (i: number, patch: Partial<SlotCfg>) => setSlots((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const filled = visible.filter((s) => s.kind !== 'closed');
  const teams = new Set(filled.map((s) => s.team));
  const canStart = filled.length >= 2 && teams.size >= 2;

  const onStart = () => {
    const players: PlayerSetup[] = [];
    let mySlot = 0;
    visible.forEach((s, i) => {
      if (s.kind === 'closed') return;
      const idx = players.length;
      if (s.kind === 'me') mySlot = idx;
      players.push({ slot: idx, team: s.team, name: s.kind === 'me' ? getSettings().name : `${t('bot')} ${idx + 1} (${t(['easy', 'medium', 'hard'][s.difficulty] as 'easy')})`, isBot: s.kind === 'bot', difficulty: s.difficulty, color: PLAYER_COLORS[i] });
    });
    start({ seed: (Math.random() * 0x7fffffff) | 0, mapId, players, version: SIM_VERSION, speed }, mySlot);
  };

  return (
    <div className="screen">
      <MenuBackground />
      <div className="card">
        <button className="back" onClick={back}>{t('back')}</button>
        <h2>{t('playAI')}</h2>
        <h3>{t('map')}</h3>
        <div className="maps">
          {OFFICIAL_MAPS.map((m) => (
            <button key={m.id} className={`map-card ${m.id === mapId ? 'active' : ''}`} onClick={() => setMapId(m.id)}>
              <MapPreview mapId={m.id} size={120} fill />
              <div>{m.name}</div>
              <div className="small muted">{m.size}×{m.size} · {m.maxPlayers}p</div>
            </button>
          ))}
        </div>
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
                {Array.from({ length: map.maxPlayers }, (_, k) => <option key={k} value={k}>{k + 1}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="small muted">{t('hardNote')}</p>
        {!canStart && <p className="small error">{t('needPlayers')}</p>}
        <div className="row end">
          <button onClick={() => setSlots((all) => all.map((x, k) => (k < map.maxPlayers && x.kind === 'closed' ? { ...x, kind: 'bot' } : x)))}>{t('fill')}</button>
          <button className="primary" disabled={!canStart} onClick={onStart}>{t('start')}</button>
        </div>
      </div>
    </div>
  );
}
