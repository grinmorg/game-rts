import { useEffect, useRef, useState } from 'react';
import { installStressHook } from '../game/stress';
import { ReplayData } from '@rookfall/sim';
import { formatTime, useT } from '../i18n';
import { GameView, HudState, PanelButton } from '../game/view';
import { LocalSession, Session } from '../game/session';
import { Models } from '../game/models';
import { NetClient } from '../net/client';
import { saveLocalReplay } from '../store';
import { getSettings } from '../settings';
import { toggleFullscreen } from './fullscreen';

export interface GameScreenProps {
  session: Session;
  models: Models;
  net: NetClient | null;
  onLeave: () => void;
  onPlayAgain?: () => void;
}

export function GameScreen({ session, models, net, onLeave, onPlayAgain }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GameView | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const view = new GameView(canvas, session, models, net);
    viewRef.current = view;
    (window as unknown as { __rookfall?: GameView }).__rookfall = view; // debug / e2e hook
    const unsub = view.subscribe(setHud);
    view.start();
    if (session instanceof LocalSession && location.search.includes('stress=')) installStressHook(view, session);
    return () => { unsub(); view.dispose(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />
      {hud && viewRef.current && <Hud hud={hud} view={viewRef.current} onLeave={onLeave} onPlayAgain={onPlayAgain} />}
    </div>
  );
}

function Hud({ hud, view, onLeave, onPlayAgain }: { hud: HudState; view: GameView; onLeave: () => void; onPlayAgain?: () => void }) {
  const t = useT();
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const chatRef = useRef<HTMLInputElement>(null);
  const [tip, setTip] = useState<PanelButton | null>(null);
  const [savedReplay, setSavedReplay] = useState(false);
  const [confirmSurrender, setConfirmSurrender] = useState(false);

  useEffect(() => { view.setMinimapCanvas(minimapRef.current); return () => view.setMinimapCanvas(null); }, [view]);
  useEffect(() => { if (hud.chatOpen) chatRef.current?.focus(); }, [hud.chatOpen]);

  const sel = hud.selection;
  const p = sel?.primary;
  const hpPct = p ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : 0;
  const isReplay = !!hud.replay;
  const spectator = hud.mySlot < 0;

  const minimapPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    view.minimapClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.button, e.shiftKey);
  };

  const saveReplay = () => {
    const data: ReplayData | null = view.session.replay();
    if (data) { saveLocalReplay(data); setSavedReplay(true); }
  };

  return (
    <div className="hud">
      {/* top bar */}
      <div className="hud-top">
        <div className="hud-players">
          {hud.players.map((pl) => (
            <div key={pl.slot} className={`hud-player ${pl.status === 'eliminated' ? 'dead' : ''} ${pl.status === 'disconnected' ? 'dc' : ''}`} title={`${t('team')} ${pl.team + 1}`}
              onClick={() => { if (spectator) view.setPerspective(pl.slot); }} style={{ cursor: spectator ? 'pointer' : 'default', outline: spectator && hud.perspective === pl.slot ? '1px solid var(--accent)' : 'none' }}>
              <span className="dot" style={{ background: '#' + pl.color.toString(16).padStart(6, '0') }} />
              <span>{pl.name}</span>
              {pl.status === 'disconnected' && pl.secondsLeft !== undefined && <span className="small">⏱{formatTime(pl.secondsLeft * 20)}</span>}
              {pl.gold !== undefined && <span className="small muted">💰{pl.gold} 👥{pl.pop}</span>}
            </div>
          ))}
          {spectator && <button className="hud-menu-btn" onClick={() => view.setPerspective(-1)} style={{ outline: hud.perspective < 0 ? '1px solid var(--accent)' : 'none' }}>{t('all')}</button>}
        </div>
        <div className="row">
          {!spectator && (
            <div className="hud-res">
              <span className="gold">💰 {hud.gold}</span>
              <span className={`pop ${hud.popUsed >= hud.popCap ? 'full' : ''}`}>👥 {hud.popUsed}/{hud.popCap}</span>
              <span className={`hud-age age-${hud.age}`} title={t('ageBadgeTitle')}>{hud.age >= 1 ? 'II' : 'I'}</span>
              {hud.idleWorkers > 0 && <span title={t('idleWorkers')} style={{ cursor: 'pointer' }} onClick={() => view.input.selectIdleWorker()}>⛏️ {hud.idleWorkers}</span>}
            </div>
          )}
          <span className="hud-timer">{hud.time}</span>
          {(view.session.setup.speed ?? 1) !== 1 && <span className="hud-speed" title={t('gameSpeed')}>{view.session.setup.speed}×</span>}
          <button className="hud-menu-btn" onClick={toggleFullscreen} title={t('fullscreen')}>⛶</button>
          <button className="hud-menu-btn" onClick={() => view.toggleMenu()}>{t('menu')}</button>
        </div>
      </div>
      <div className="hud-fps">{hud.fps} fps · {hud.drawCalls} dc{view.session.kind === 'net' ? ` · ${hud.ping} ms · ${hud.behind} ${t('tick')}` : ''}{hud.desync ? ' · DESYNC' : ''}{!hud.connected ? ` · ${t('reconnecting')}` : ''}{hud.catchingUp ? ' · ⏩' : ''}</div>

      {/* replay controls */}
      {hud.replay && (
        <div className="replay-ctl">
          <button onClick={() => view.togglePause()}>{hud.replay.paused ? '▶' : '⏸'}</button>
          {[1, 2, 4, 8].map((s) => <button key={s} className={hud.replay!.speed === s ? 'primary' : ''} onClick={() => view.setSpeed(s)}>{s}×</button>)}
          <span className="muted small" style={{ alignSelf: 'center' }}>{hud.time} / {formatTime(hud.replay.total)}</span>
        </div>
      )}

      {/* toasts & hint */}
      <div className="hud-toast">{hud.toasts.map((x) => <div key={x.id} className={`toast ${x.kind === 'info' ? 'info' : ''}`}>{x.text}</div>)}</div>
      {hud.hint && <div className="hud-hint">{hud.hint}</div>}
      {hud.drag && <div className="selbox" style={{ left: hud.drag.x, top: hud.drag.y, width: hud.drag.w, height: hud.drag.h }} />}

      {/* messages / chat */}
      {!hud.chatOpen && <div className="hud-msgs">{hud.messages.map((m) => <div key={m.id} className={`msg ${m.system ? 'sys' : ''}`}>{m.from ? <><b style={{ color: '#' + (m.color ?? 0xffffff).toString(16).padStart(6, '0') }}>{m.from}:</b> {m.text}</> : m.text}</div>)}</div>}
      {hud.chatOpen && (
        <div className="hud-chat-input">
          <div className="hud-msgs" style={{ position: 'static', width: 'auto', marginBottom: 4 }}>{hud.messages.map((m) => <div key={m.id} className={`msg ${m.system ? 'sys' : ''}`}>{m.from ? <><b>{m.from}:</b> {m.text}</> : m.text}</div>)}</div>
          <input ref={chatRef} placeholder={t('chat')} maxLength={200} onKeyDown={(e) => { if (e.key === 'Enter') view.sendChat(e.currentTarget.value); if (e.key === 'Escape') view.sendChat(''); }} style={{ width: '100%' }} />
        </div>
      )}

      {/* bottom */}
      <div className="hud-bottom">
        <div className="minimap-wrap" onContextMenu={(e) => e.preventDefault()}>
          <canvas ref={minimapRef} width={180} height={180} onPointerDown={minimapPointer} />
        </div>
        <div className="sel-panel">
          {p ? (
            <>
              <div className="sel-portrait" style={{ background: '#' + p.color.toString(16).padStart(6, '0') + '33', borderColor: '#' + p.color.toString(16).padStart(6, '0') }}>{p.icon}</div>
              <div className="sel-info">
                <h4>{p.name} {sel!.foreign && <span className="small muted">· {p.ownerName}</span>}</h4>
                {p.kind === 'mine' ? (
                  <div className="stats"><span>{t('goldLeft')}: <b>{p.goldLeft}</b></span></div>
                ) : (
                  <>
                    <div className={`hpbar ${hpPct < 30 ? 'crit' : hpPct < 60 ? 'low' : ''}`}><div style={{ width: `${hpPct}%` }} /></div>
                    <div className="stats">
                      <span>{t('hp')} {p.hp}/{p.maxHp}</span>
                      {p.stats?.map((s) => <span key={s.k}>{s.k}: {s.v}</span>)}
                      {p.carry ? <span>{t('carrying')}: 💰{p.carry}</span> : null}
                      {p.abilityCd !== undefined && p.abilityName && <span>{p.abilityName}: {p.abilityCd > 0 ? `${Math.ceil(p.abilityCd / 20)}s` : '✓'}</span>}
                      {p.buff ? <span>{p.kind === 'building' ? `⚠️ ${t('siteSlowed')}` : '🛡️'} {Math.ceil(p.buff / 20)}s</span> : null}
                      {p.progress !== undefined && <span>{p.dismantling ? t('dismantling') : t('constructing')} {Math.round(p.progress * 100)}%</span>}
                      {p.garrison && <span>⛏️ {t('workersInside')}: <b>{p.garrison.n}/{p.garrison.max}</b></span>}
                      {p.upgrades && <span>{p.upgrades}</span>}
                    </div>
                    {p.hint && <div className="small muted">{p.hint}</div>}
                  </>
                )}
                {p.queue && p.queue.length > 0 && (
                  <div className="queue">
                    {p.queue.map((q, i) => <div key={i} className="queue-item" title={q.label} onClick={() => view.panelAction(`cancelQueue:${i}`)}>{q.icon}<div className="prog" style={{ width: `${Math.round(q.progress * 100)}%` }} /></div>)}
                  </div>
                )}
                {sel!.groups.length > 0 && sel!.ids.length > 1 && (
                  <div className="sel-units" style={{ marginTop: 6 }}>
                    {sel!.groups.map((g) => (
                      <div key={g.type} className="sel-unit" title={g.label} onClick={() => view.selectGroup(g.ids)}>{g.icon}<span className="n">{g.count}</span><div className="hp" style={{ width: `${Math.round(g.hp * 100)}%` }} /></div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="muted small" style={{ alignSelf: 'center' }}>{isReplay ? t('spectator') : t('controlsText')}</div>
          )}
        </div>
        <div className="cmd-panel" onMouseLeave={() => setTip(null)}>
          {hud.panel.slice(0, 9).map((b) => (
            <button key={b.id} className={`cmd-btn ${b.active ? 'active' : ''}`} disabled={b.disabled && !b.cooldown} onMouseEnter={() => setTip(b)} onClick={() => view.panelAction(b.id)}>
              <span className="key">{b.key === 'Escape' ? 'Esc' : b.key}</span>
              <span className="icon">{b.icon}</span>
              <span>{b.label}</span>
              {b.cost !== undefined && <span className="cost">💰{b.cost}</span>}
              {b.cooldown ? <span className="cd">{Math.ceil(b.cooldown * 100)}%</span> : null}
            </button>
          ))}
        </div>
      </div>
      {tip && tip.tooltip && <div className="tooltip"><b>{tip.label}</b><br />{tip.tooltip}</div>}

      {/* pause menu */}
      {hud.menuOpen && !hud.gameOver && (
        <div className="overlay" onClick={() => view.closeMenu()}>
          <div className="card narrow" onClick={(e) => e.stopPropagation()}>
            <h2>{t('menu')}</h2>
            <div className="menu-buttons">
              <button className="primary" onClick={() => view.closeMenu()}>{t('resume')}</button>
              {!spectator && !isReplay && (confirmSurrender
                ? <button className="danger" onClick={() => { view.surrender(); setConfirmSurrender(false); }}>{t('surrenderConfirm')}</button>
                : <button onClick={() => setConfirmSurrender(true)}>{t('surrender')}</button>)}
              {!spectator && !isReplay && view.session.kind === 'net' && <button onClick={() => view.voteDraw()}>{hud.voteDraw ? t('voteDrawOn') : t('voteDraw')}</button>}
              <button onClick={saveReplay} disabled={savedReplay}>{savedReplay ? t('replaySaved') : t('saveReplay')}</button>
              <button className="danger" onClick={onLeave}>{t('leaveGame')}</button>
            </div>
            <p className="small muted" style={{ marginTop: 14 }}>{t('controlsText')}</p>
          </div>
        </div>
      )}

      {/* results */}
      {hud.gameOver && !hud.gameOver.dismissed && (
        <div className="overlay">
          <div className="card results">
            <h1 className={`banner ${hud.gameOver.result === 'victory' ? 'victory' : hud.gameOver.result === 'defeat' ? 'defeat' : hud.gameOver.result === 'draw' ? 'draw' : 'gameover'}`}>
              {hud.gameOver.result === 'victory' ? t('victory') : hud.gameOver.result === 'defeat' ? t('defeat') : hud.gameOver.result === 'draw' ? t('draw') : t('gameOver')}
            </h1>
            <p className="muted">{t('duration')}: {hud.gameOver.duration}{!hud.gameOver.canContinue && hud.gameOver.winnerTeam >= 0 ? ` · ${t('winner')}: ${t('team')} ${hud.gameOver.winnerTeam + 1}` : ''}</p>
            <table>
              <thead><tr><th>{t('players')}</th><th>{t('team')}</th><th>{t('unitsTrained')}</th><th>{t('unitsLost')}</th><th>{t('unitsKilled')}</th><th>{t('buildingsRazed')}</th><th>{t('goldMined')}</th></tr></thead>
              <tbody>
                {hud.gameOver.rows.map((r, i) => (
                  <tr key={i} style={{ opacity: r.alive ? 1 : 0.6 }}>
                    <td><span className="dot" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#' + r.color.toString(16).padStart(6, '0'), marginRight: 6 }} />{r.name}</td>
                    <td>{r.team + 1}</td><td>{r.trained}</td><td>{r.lost}</td><td>{r.killed}</td><td>{r.razed}</td><td>{r.gold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row end">
              {hud.gameOver.canContinue && <button onClick={() => view.dismissGameOver()}>{t('watch')}</button>}
              {!hud.gameOver.canContinue && <button onClick={saveReplay} disabled={savedReplay || isReplay}>{savedReplay ? t('replaySaved') : t('saveReplay')}</button>}
              {!hud.gameOver.canContinue && onPlayAgain && <button onClick={onPlayAgain}>{t('playAgain')}</button>}
              <button className="primary" onClick={onLeave}>{t('leaveGame')}</button>
            </div>
          </div>
        </div>
      )}
      {getSettings().colorblind && null}
    </div>
  );
}
