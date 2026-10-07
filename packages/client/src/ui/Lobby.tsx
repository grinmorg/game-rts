import { useEffect, useRef, useState } from 'react';
import { RoomSlot, RoomState, RoomSummary } from '@pocket-of-empire/protocol';
import { GAME_SPEEDS, OFFICIAL_MAPS, PLAYER_COLORS, customMapId, isCustomMapId } from '@pocket-of-empire/sim';
import { useT } from '../i18n';
import { net } from '../net/client';
import { MapPicker, PickedMap, mapMeta, officialPick } from './MapPicker';
import { MapPreview } from './MapPreview';
import { DIFF_KEYS, ScaleBar, SheetHead, SlotHead, TeamPicker, lineupText, teamVar, useEscapeBack } from './Skirmish';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';

interface ChatLine { from: string; text: string; system?: boolean }

/** server error codes the room list can run into */
function errorKey(code: string): 'errNoRoom' | 'errFull' | 'errStarted' | 'rejGeneric' {
  return code === 'noRoom' ? 'errNoRoom' : code === 'full' ? 'errFull' : code === 'started' ? 'errStarted' : 'rejGeneric';
}

/** the room's map as the picker shows it: official, or the player-made one the server described */
function roomPick(room: RoomState): PickedMap {
  const m = room.map;
  return m ? { id: m.id, custom: true, name: m.name, players: m.players, w: m.w, h: m.h, author: m.author, thumb: m.thumb } : officialPick(room.mapId);
}

export function Lobby({ back, initialCode }: { back: () => void; initialCode?: string }) {
  const t = useT();
  const [connected, setConnected] = useState(net.connected);
  const [lost, setLost] = useState(false);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [code, setCode] = useState(initialCode ?? '');
  const [makePrivate, setMakePrivate] = useState(false);
  const [error, setError] = useState('');
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const chatInput = useRef<HTMLInputElement>(null);
  const chatLog = useRef<HTMLDivElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);
  const joined = useRef(false);
  const inRoom = useRef(false);
  inRoom.current = !!room;

  useEffect(() => {
    net.connect();
    const u = [
      net.on('open', () => { setConnected(true); setLost(false); setError(''); net.send({ t: 'listRooms' }); if (initialCode && !joined.current) { joined.current = true; setTimeout(() => net.send({ t: 'join', code: initialCode }), 50); } }),
      net.on('close', () => { setConnected(false); setLost(true); }),
      net.on('room', (m) => { setRoom(m.room); setError(''); }),
      net.on('left', () => { setRoom(null); setChat([]); net.send({ t: 'listRooms' }); }),
      net.on('rooms', (m) => setRooms(m.rooms)),
      net.on('error', (m) => setError(m.code)),
      net.on('chat', (m) => setChat((c) => [...c.slice(-60), { from: m.name, text: m.text, system: m.system }])),
    ];
    if (net.connected) { net.send({ t: 'listRooms' }); if (initialCode && !joined.current) { joined.current = true; net.send({ t: 'join', code: initialCode }); } }
    const iv = setInterval(() => { if (!inRoom.current && net.connected) net.send({ t: 'listRooms' }); }, 5000);
    return () => { u.forEach((f) => f()); clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the newest chat line stays in view
  useEffect(() => { const el = chatLog.current; if (el) el.scrollTop = el.scrollHeight; }, [chat]);
  useEscapeBack(back, !room);

  const isHost = !!room && room.hostId === net.clientId;
  const mySlot = room?.slots.find((s) => s.clientId === net.clientId);
  const inviteUrl = room ? `${location.origin}${location.pathname}?room=${room.code}` : '';

  const leave = () => { net.send({ t: 'leave' }); setRoom(null); };
  const copied1500 = () => { setCopied(true); setCopyFailed(false); setTimeout(() => setCopied(false), 1500); };
  const copy = () => {
    // the clipboard API is missing on plain http: fall back to the selection, and say so when even that fails
    const manual = () => {
      const el = inviteInput.current;
      el?.focus(); el?.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      if (ok) copied1500(); else setCopyFailed(true);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(inviteUrl).then(copied1500, manual); else manual();
  };
  const share = () => { void navigator.share?.({ title: room?.name, url: inviteUrl }).catch(() => {}); };
  const sendChat = () => { const v = chatInput.current?.value.trim(); if (v) { net.send({ t: 'chat', text: v }); chatInput.current!.value = ''; } };
  const join = (c: string) => { setError(''); net.send({ t: 'join', code: c }); };

  if (!room) {
    const codeOk = code.length >= 4;
    return (
      <div className="screen setup-screen">
        <MenuBackground />
        <main className="sheet sheet--framed setup-sheet lobby-list">
          <SheetHead onBack={back} backLabel={t('back')} title={<h1 className="setup-head__title">{t('multiplayer')}</h1>} sub={t('lobbySub')} />
          <div className="setup-scroll">
            {!connected && (
              <p className="setup-status" role="status">
                <span className="spinner" />
                <span>{lost ? <>{t('offline')} {t('reconnecting')}</> : t('connecting')}</span>
              </p>
            )}
            <section className="join-code" aria-labelledby="lb-code">
              <div className="legend-head"><h2 className="legend-head__name" id="lb-code">{t('joinByCode')}</h2></div>
              <form className="join-code__row" onSubmit={(e) => { e.preventDefault(); if (connected && codeOk) join(code); }}>
                <input
                  className="text join-code__input" value={code} maxLength={5} aria-label={t('roomCode')} placeholder={t('roomCode')}
                  autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-describedby="lb-code-hint"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                />
                <button className="btn btn--secondary" type="submit" disabled={!connected || !codeOk}>{t('joinRoomAction')}</button>
              </form>
              <p className="setup-note" id="lb-code-hint">{t('roomCodeHint')}</p>
            </section>
            {error && <p className="setup-alert" role="alert"><Icon name="error" />{t(errorKey(error))}</p>}
            <section aria-labelledby="lb-rooms">
              <div className="legend-head">
                <h2 className="legend-head__name" id="lb-rooms">{t('publicRooms')}</h2>
                <span className="legend-head__meta">{t('autoRefresh')}</span>
                <button className="btn btn--quiet btn--icon btn--small room-refresh" aria-label={t('refresh')} title={t('refresh')} disabled={!connected} onClick={() => net.send({ t: 'listRooms' })}>
                  <Icon name="redo" />
                </button>
              </div>
              {rooms.length === 0 ? (
                <p className="setup-empty">{t('noRooms')} {t('noRoomsHint')}</p>
              ) : (
                <div className="room-list">
                  {rooms.map((r) => {
                    const full = r.players >= r.max;
                    const mapName = r.mapName ?? OFFICIAL_MAPS.find((m) => m.id === r.mapId)?.name ?? r.mapId;
                    return (
                      <div key={r.code} className="row-item room-row">
                        <span className="room-row__thumb">
                          {isCustomMapId(r.mapId) ? <Icon name="map-editor" /> : <MapPreview mapId={r.mapId} size={44} />}
                        </span>
                        <div className="row-item__main">
                          <div className="row-item__title">{r.name}</div>
                          <div className="row-item__meta">{mapName} · <span className="room-row__code">{r.code}</span></div>
                        </div>
                        <span className="row-item__num" aria-label={t('players')}>{r.players}/{r.max}</span>
                        <button className="btn btn--secondary btn--compact" disabled={!connected || full} onClick={() => join(r.code)}>
                          {full ? t('roomFull') : t('joinRoomAction')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
          <div className="setup-foot setup-foot--row">
            <label className="toggle-row create-private">
              <input type="checkbox" className="toggle" role="switch" checked={makePrivate} onChange={(e) => setMakePrivate(e.target.checked)} />
              <span><b>{t('privateRoom')}</b><small>{t('privateHint')}</small></span>
            </label>
            <button className="btn btn--seal setup-seal" disabled={!connected} onClick={() => { setError(''); net.send(makePrivate ? { t: 'create', private: true } : { t: 'create' }); }}>
              {t('createRoom')}
            </button>
          </div>
        </main>
      </div>
    );
  }

  const picked = roomPick(room);
  const maxPlayers = picked.players;
  const seats = room.slots.slice(0, maxPlayers);
  // the server's own rule for "Start": two filled seats in two different teams
  const filled = room.slots.filter((s) => s.kind === 'human' || s.kind === 'bot');
  const ready = filled.length >= 2 && new Set(filled.map((s) => s.team)).size >= 2;
  const lineup = lineupText(t, filled.map((s) => s.team));
  const nextFree = isHost ? seats.find((s) => s.kind === 'open' || s.kind === 'closed') : undefined;
  const canShare = typeof navigator.share === 'function';
  return (
    <div className="screen setup-screen">
      <MenuBackground />
      <main className="card sheet sheet--framed setup-sheet setup-sheet--full lobby-room">
        <SheetHead
          onBack={leave} backLabel={t('leaveRoom')}
          title={(
            <h2 className="setup-head__title">
              <span className="room-title">{room.name}</span>
              <span className="badge badge--solid room-code">{room.code}</span>
              {room.private && <span className="badge lock"><Icon name="lock" />{t('private')}</span>}
            </h2>
          )}
          sub={isHost ? t('roomSubHost') : t('roomSubGuest')}
        />
        <div className="setup-body">
          <div className="setup-main room-main">
            <section className="invite" aria-label={t('inviteLink')}>
              <label className="field__label" htmlFor="invite-url">{t('inviteLink')}</label>
              <div className="invite__row">
                <input id="invite-url" ref={inviteInput} className="text invite__url" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
                <button className="btn btn--secondary" onClick={copy}><Icon name={copied ? 'check' : 'copy'} />{copied ? t('copied') : t('copy')}</button>
                {canShare && <button className="btn btn--secondary btn--icon" aria-label={t('invite')} title={t('invite')} onClick={share}><Icon name="link" /></button>}
              </div>
              {copyFailed && <p className="field__hint">{t('copyManual')}</p>}
              {isHost && (
                <label className="toggle-row invite__listed">
                  <input type="checkbox" className="toggle" role="switch" checked={!room.private} onChange={() => net.send({ t: 'privacy', private: !room.private })} />
                  <span>{t('roomListed')}</span>
                </label>
              )}
            </section>

            <section aria-labelledby="rm-players">
              <div className="legend-head">
                <h3 className="legend-head__name" id="rm-players">{t('players')}</h3>
                <span className="legend-head__meta">{filled.length >= 2 ? `${lineup} · ` : ''}{filled.length}/{maxPlayers}</span>
              </div>
              <div className={`slots${seats.length > 12 ? ' many' : ''}${maxPlayers > 2 && maxPlayers <= 4 ? ' slots--team-scale' : ''}`}>
                <SlotHead />
                {seats.map((s) => (
                  <RoomSeat key={s.index} s={s} room={room} isHost={isHost} canMove={!!mySlot} maxPlayers={maxPlayers} />
                ))}
              </div>
              {nextFree && (
                <div className="slot-actions">
                  <button className="btn btn--quiet btn--compact slot-add" onClick={() => net.send({ t: 'slot', slot: nextFree.index, kind: 'bot', difficulty: 1 })}>
                    <Icon name="plus" />{t('addBot')}
                  </button>
                </div>
              )}
            </section>

            <section className="chat-section" aria-labelledby="rm-chat">
              <div className="legend-head"><h3 className="legend-head__name" id="rm-chat">{t('chat')}</h3></div>
              <div className="chat">
                <div className="chat-log well" ref={chatLog} aria-live="polite">
                  {chat.length === 0 && <div className="chat-empty">{t('chatEmpty')}</div>}
                  {chat.map((c, i) => <div key={i} className={c.system ? 'sys' : 'chat-line'}>{c.system ? c.text : <><b>{c.from}:</b> {c.text}</>}</div>)}
                </div>
                <div className="chat__input">
                  <input ref={chatInput} className="text" placeholder={t('chatPlaceholder')} aria-label={t('chat')} maxLength={200} onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }} />
                  <button className="btn btn--secondary" onClick={sendChat}>{t('send')}</button>
                </div>
              </div>
            </section>
          </div>

          <div className="setup-side room-side">
            <section className="room-map" aria-labelledby="rm-map">
              <div className="legend-head">
                <h3 className="legend-head__name" id="rm-map">{t('map')}</h3>
                {!isHost && <span className="legend-head__meta">{t('hostChanges')}</span>}
              </div>
              {isHost ? (
                <MapPicker compact value={picked} onPick={(m) => { setError(''); net.send({ t: 'map', mapId: m.custom ? customMapId(m.id) : m.id }); }} />
              ) : (
                <div className="map-card active map-card--static">
                  {room.map ? <MapPreview payload={room.map.thumb} fill zones /> : <MapPreview mapId={room.mapId} size={200} fill />}
                  <div className="map-card__name">{picked.name}</div>
                  <span className="map-card__meta">{room.map ? `${t('mapBy', { name: room.map.author })} · ` : ''}{mapMeta(picked.w, picked.h, picked.players)}</span>
                </div>
              )}
            </section>
            <section className="room-speed" aria-labelledby="rm-speed">
              <div className="legend-head">
                <h3 className="legend-head__name" id="rm-speed">{t('gameSpeed')}</h3>
                {!isHost && <span className="legend-head__meta">{t('hostChanges')}</span>}
              </div>
              <ScaleBar
                className="speed-scale" cellClass="speed-btn" options={GAME_SPEEDS} value={room.speed ?? 1} disabled={!isHost}
                onChange={(v) => net.send({ t: 'speed', speed: v })} label={t('gameSpeed')} render={(v) => `${v}×`}
              />
              <p className="setup-note">{t('speedHint')}</p>
            </section>
          </div>

          <div className="setup-foot">
            {error && <p className="setup-alert" role="alert"><Icon name="error" />{t(error === 'needPlayers' || error === 'needTeams' ? 'needPlayers' : error === 'mapUnavailable' ? 'mapUnavailable' : 'rejGeneric')}</p>}
            {isHost ? (
              <>
                <p className={`room-status${ready ? ' is-ready' : ''}`}>
                  <Icon name={ready ? 'check' : 'warning'} />{ready ? t('roomReady') : t('needPlayers')}
                </p>
                <button className="btn btn--seal btn--block setup-seal" disabled={!ready} onClick={() => net.send({ t: 'start' })}>{t('start')}</button>
              </>
            ) : (
              <p className="room-wait" role="status"><span className="spinner" />{t('waitingHost')}</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** one seat of the room: the same row as a skirmish slot, with the server's seat kinds (open / bot / closed / a person) */
function RoomSeat({ s, room, isHost, canMove, maxPlayers }: { s: RoomSlot; room: RoomState; isHost: boolean; canMove: boolean; maxPlayers: number }) {
  const t = useT();
  const mine = s.clientId === net.clientId;
  const person = s.kind === 'human';
  return (
    <div className={`slot${mine ? ' is-me' : ''}${s.kind === 'closed' ? ' is-closed' : ''}${s.kind === 'open' ? ' is-open' : ''}`} style={teamVar(PLAYER_COLORS[s.index % PLAYER_COLORS.length])}>
      <span className="slot__flag" aria-hidden="true"><Icon name="flag" /></span>
      {person ? (
        <div className="slot__person">
          <span className={`name${mine ? ' me' : ''}`}>{s.name}</span>
          {mine && <span className="badge badge--ok">{t('you').toLowerCase()}</span>}
          {room.hostId === s.clientId && <span className="badge">{t('host').toLowerCase()}</span>}
          {s.connected === false && <span className="badge badge--warn"><Icon name="warning" />{t('disconnectedShort')}</span>}
        </div>
      ) : (
        <>
          <div className="row slot__who">
            {isHost ? (
              <select className="select" aria-label={t('slotWho')} value={s.kind} onChange={(e) => net.send({ t: 'slot', slot: s.index, kind: e.target.value as 'open' | 'closed' | 'bot', difficulty: s.difficulty ?? 1 })}>
                <option value="open">{t('open')}</option>
                <option value="bot">{t('bot')}</option>
                <option value="closed">{t('closed')}</option>
              </select>
            ) : (
              <span className="slot__text">{s.kind === 'bot' ? (s.name ?? t('bot')) : t(s.kind as 'open' | 'closed')}</span>
            )}
          </div>
          <div className="slot__level">
            {s.kind === 'bot' && (isHost ? (
              <select className="select" aria-label={t('slotLevel')} value={s.difficulty ?? 1} onChange={(e) => net.send({ t: 'slot', slot: s.index, kind: 'bot', difficulty: Number(e.target.value) as 0 | 1 | 2 })}>
                {DIFF_KEYS.map((k, d) => <option key={k} value={d}>{t(k)}</option>)}
              </select>
            ) : <span className="slot__text">{t(DIFF_KEYS[s.difficulty ?? 1])}</span>)}
            {s.kind === 'open' && canMove && (
              <button className="btn btn--secondary btn--small slot__take" title={t('takeSlot')} onClick={() => net.send({ t: 'pick', slot: s.index })}>
                <Icon name="take-slot" />{t('takeSlotShort')}
              </button>
            )}
          </div>
        </>
      )}
      <TeamPicker value={s.team} count={maxPlayers} disabled={!(isHost || mine) || s.kind === 'closed'} onChange={(team) => net.send({ t: 'team', slot: s.index, team })} />
    </div>
  );
}
