import { useEffect, useRef, useState } from 'react';
import { RoomState, RoomSummary } from '@rookfall/protocol';
import { GAME_SPEEDS, OFFICIAL_MAPS, PLAYER_COLORS } from '@rookfall/sim';
import { useT } from '../i18n';
import { net } from '../net/client';
import { MapPreview } from './MapPreview';
import { MenuBackground } from './MainMenu';

interface ChatLine { from: string; text: string; system?: boolean }

/** server error codes the room list can run into */
function errorKey(code: string): 'errNoRoom' | 'errFull' | 'errStarted' | 'rejGeneric' {
  return code === 'noRoom' ? 'errNoRoom' : code === 'full' ? 'errFull' : code === 'started' ? 'errStarted' : 'rejGeneric';
}

export function Lobby({ back, initialCode }: { back: () => void; initialCode?: string }) {
  const t = useT();
  const [connected, setConnected] = useState(net.connected);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [code, setCode] = useState(initialCode ?? '');
  const [error, setError] = useState('');
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [copied, setCopied] = useState(false);
  const chatInput = useRef<HTMLInputElement>(null);
  const joined = useRef(false);

  useEffect(() => {
    net.connect();
    const u = [
      net.on('open', () => { setConnected(true); setError(''); net.send({ t: 'listRooms' }); if (initialCode && !joined.current) { joined.current = true; setTimeout(() => net.send({ t: 'join', code: initialCode }), 50); } }),
      net.on('close', () => setConnected(false)),
      net.on('room', (m) => { setRoom(m.room); setError(''); }),
      net.on('left', () => { setRoom(null); setChat([]); net.send({ t: 'listRooms' }); }),
      net.on('rooms', (m) => setRooms(m.rooms)),
      net.on('error', (m) => setError(m.code)),
      net.on('chat', (m) => setChat((c) => [...c.slice(-60), { from: m.name, text: m.text, system: m.system }])),
    ];
    if (net.connected) { net.send({ t: 'listRooms' }); if (initialCode && !joined.current) { joined.current = true; net.send({ t: 'join', code: initialCode }); } }
    const iv = setInterval(() => { if (!room && net.connected) net.send({ t: 'listRooms' }); }, 5000);
    return () => { u.forEach((f) => f()); clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isHost = room && room.hostId === net.clientId;
  const mySlot = room?.slots.find((s) => s.clientId === net.clientId);
  const inviteUrl = room ? `${location.origin}${location.pathname}?room=${room.code}` : '';

  const leave = () => { net.send({ t: 'leave' }); setRoom(null); };
  const copy = () => { navigator.clipboard?.writeText(inviteUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  const sendChat = () => { const v = chatInput.current?.value.trim(); if (v) { net.send({ t: 'chat', text: v }); chatInput.current!.value = ''; } };

  if (!room) {
    return (
      <div className="screen">
        <MenuBackground />
        <div className="card">
          <button className="back" onClick={() => { back(); }}>{t('back')}</button>
          <h2>{t('multiplayer')}</h2>
          {!connected && <p className="muted">{t('connecting')} <span className="small">({t('offline')})</span></p>}
          <div className="row" style={{ marginBottom: 6 }}>
            <button className="primary" disabled={!connected} onClick={() => net.send({ t: 'create' })}>{t('createRoom')}</button>
            <button disabled={!connected} onClick={() => net.send({ t: 'create', private: true })}>🔒 {t('privateRoom')}</button>
            <span className="grow" />
            <input placeholder={t('roomCode')} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 120, textTransform: 'uppercase' }} maxLength={5} />
            <button disabled={!connected || code.length < 4} onClick={() => net.send({ t: 'join', code })}>{t('joinRoom')}</button>
          </div>
          <p className="small muted" style={{ marginTop: 0, marginBottom: 12 }}>{t('privateHint')}</p>
          {error && <p className="error small">{t(errorKey(error))}</p>}
          <h3>{t('publicRooms')} <button className="small" style={{ padding: '2px 8px' }} onClick={() => net.send({ t: 'listRooms' })}>{t('refresh')}</button></h3>
          <div className="list">
            {rooms.length === 0 && <div className="muted small">{t('noRooms')}</div>}
            {rooms.map((r) => (
              <div key={r.code} className="list-item">
                <b>{r.name}</b>
                <span className="badge">{r.code}</span>
                <span className="muted small">{OFFICIAL_MAPS.find((m) => m.id === r.mapId)?.name ?? r.mapId}</span>
                <span className="grow" />
                <span className="small">{r.players}/{r.max}</span>
                <button onClick={() => net.send({ t: 'join', code: r.code })}>{t('joinRoom')}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const maxPlayers = OFFICIAL_MAPS.find((m) => m.id === room.mapId)?.maxPlayers ?? 2;
  return (
    <div className="screen">
      <MenuBackground />
      <div className="card">
        <button className="back" onClick={leave}>{t('leave')}</button>
        <h2>{room.name} <span className="badge">{room.code}</span>{room.private && <span className="badge lock">🔒 {t('private')}</span>}</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="muted small">{t('inviteLink')}:</span>
          <input readOnly value={inviteUrl} className="grow" onFocus={(e) => e.target.select()} />
          <button onClick={copy}>{copied ? t('copied') : t('copy')}</button>
          {isHost && (
            <button title={t('privateHint')} onClick={() => net.send({ t: 'privacy', private: !room.private })}>
              {room.private ? `🔒 ${t('private')}` : `🌐 ${t('publicRoom')}`}
            </button>
          )}
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <h3>{t('players')}</h3>
            <div className="slots">
              {room.slots.slice(0, maxPlayers).map((s) => {
                const me = s.clientId === net.clientId;
                return (
                  <div key={s.index} className={`slot ${s.kind === 'closed' ? 'closed' : ''}`}>
                    <div className="color" style={{ background: '#' + PLAYER_COLORS[s.index].toString(16).padStart(6, '0') }} />
                    <div className="row">
                      {s.kind === 'human' ? (
                        <span className={`name ${me ? 'me' : ''}`}>{s.name}{me ? ` (${t('you')})` : ''}{room.hostId === s.clientId ? ` · ${t('host')}` : ''}{s.connected === false ? ' ⚠' : ''}</span>
                      ) : isHost ? (
                        <>
                          <select value={s.kind} onChange={(e) => net.send({ t: 'slot', slot: s.index, kind: e.target.value as 'open' | 'closed' | 'bot', difficulty: s.difficulty ?? 1 })}>
                            <option value="open">{t('open')}</option>
                            <option value="bot">{t('bot')}</option>
                            <option value="closed">{t('closed')}</option>
                          </select>
                          {s.kind === 'bot' && (
                            <select value={s.difficulty ?? 1} onChange={(e) => net.send({ t: 'slot', slot: s.index, kind: 'bot', difficulty: Number(e.target.value) as 0 | 1 | 2 })}>
                              <option value={0}>{t('easy')}</option><option value={1}>{t('medium')}</option><option value={2}>{t('hard')}</option>
                            </select>
                          )}
                        </>
                      ) : (
                        <span className="muted">{s.kind === 'bot' ? s.name : t(s.kind as 'open')}</span>
                      )}
                      {s.kind === 'open' && !me && mySlot && <button className="small" style={{ padding: '2px 8px' }} onClick={() => net.send({ t: 'pick', slot: s.index })}>→</button>}
                    </div>
                    <label className="small muted">{t('team')}</label>
                    <select value={s.team} disabled={!(isHost || me) || s.kind === 'closed'} onChange={(e) => net.send({ t: 'team', slot: s.index, team: Number(e.target.value) })}>
                      {Array.from({ length: maxPlayers }, (_, k) => <option key={k} value={k}>{k + 1}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ width: 260 }}>
            <h3>{t('map')}</h3>
            {isHost ? (
              <div className="maps" style={{ gridTemplateColumns: '1fr 1fr' }}>
                {OFFICIAL_MAPS.map((m) => (
                  <button key={m.id} className={`map-card ${m.id === room.mapId ? 'active' : ''}`} onClick={() => net.send({ t: 'map', mapId: m.id })}>
                    <MapPreview mapId={m.id} size={90} fill />
                    <div className="small">{m.name}</div>
                    <div className="small muted">{m.maxPlayers}p</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="map-card active">
                <MapPreview mapId={room.mapId} size={200} fill />
                <div>{OFFICIAL_MAPS.find((m) => m.id === room.mapId)?.name}</div>
              </div>
            )}
            <h3>{t('gameSpeed')}</h3>
            <div className="row speeds">
              {GAME_SPEEDS.map((v) => (
                <button key={v} className={`speed-btn ${v === (room.speed ?? 1) ? 'primary' : ''}`} disabled={!isHost} onClick={() => net.send({ t: 'speed', speed: v })}>{v}×</button>
              ))}
            </div>
          </div>
        </div>
        <h3>{t('chat')}</h3>
        <div className="chat">
          <div className="chat-log">
            {chat.map((c, i) => <div key={i} className={c.system ? 'sys' : ''}>{c.system ? c.text : <><b>{c.from}:</b> {c.text}</>}</div>)}
          </div>
          <div className="row">
            <input ref={chatInput} className="grow" onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }} />
            <button onClick={sendChat}>{t('send')}</button>
          </div>
        </div>
        {error && <p className="error small">{t(error === 'needPlayers' || error === 'needTeams' ? 'needPlayers' : 'rejGeneric')}</p>}
        <div className="row end" style={{ marginTop: 12 }}>
          {isHost ? <button className="primary" onClick={() => net.send({ t: 'start' })}>{t('start')}</button> : <span className="muted">{t('waitingHost')}</span>}
        </div>
      </div>
    </div>
  );
}
