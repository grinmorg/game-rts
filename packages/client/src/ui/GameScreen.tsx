import { useEffect, useRef, useState } from 'react';
import { installStressHook } from '../game/stress';
import { PLACEMENT_GAMES, RankedResult, levelFromXp } from '@rookfall/protocol';
import { ReplayData, TICK_RATE } from '@rookfall/sim';
import { formatTime, useT } from '../i18n';
import { GameView, HudState, PanelButton } from '../game/view';
import { LocalSession, Session } from '../game/session';
import { Models } from '../game/models';
import { NetClient } from '../net/client';
import { saveLocalReplay } from '../store';
import { getSettings } from '../settings';
import { buzz, usePortrait, useTouchUI } from '../touch';
import { toggleFullscreen } from './fullscreen';
import { TierBadge } from './Ranked';

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
}

export function GameScreen({ session, models, net, isRanked, botMatch, ranked, onLeave, onPlayAgain }: GameScreenProps) {
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
      {hud && viewRef.current && <Hud hud={hud} view={viewRef.current} isRanked={isRanked} botMatch={botMatch} ranked={ranked} onLeave={onLeave} onPlayAgain={onPlayAgain} />}
    </div>
  );
}

function Hud({ hud, view, isRanked, botMatch, ranked, onLeave, onPlayAgain }: { hud: HudState; view: GameView; isRanked?: boolean; botMatch?: boolean; ranked?: RankedResult | null; onLeave: () => void; onPlayAgain?: () => void }) {
  const t = useT();
  const touch = useTouchUI();
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const chatRef = useRef<HTMLInputElement>(null);
  // the hovered button is tracked by id, so the card keeps showing live gold, cooldowns and requirements
  const [tipId, setTipId] = useState<string | null>(null);
  const [savedReplay, setSavedReplay] = useState(false);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => { view.setMinimapCanvas(minimapRef.current); return () => view.setMinimapCanvas(null); }, [view]);
  useEffect(() => { if (hud.chatOpen) chatRef.current?.focus(); }, [hud.chatOpen]);

  /**
   * With a mouse the card follows the cursor and leaves with it. A finger has no cursor to leave, so the
   * card is a popover: anything touched outside it - the map, the minimap, another panel - puts it away.
   * The press that opened it has already happened by the time this is listening, so it cannot close itself.
   */
  useEffect(() => {
    if (!touch || !tipId) return;
    const close = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.('.tooltip, .cmd-btn')) return; // the card itself, or the button that swaps it
      setTipId(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [touch, tipId]);

  const sel = hud.selection;
  const tip = tipId ? hud.panel.find((b) => b.id === tipId) ?? null : null;
  const p = sel?.primary;
  const hpPct = p ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : 0;
  const isReplay = !!hud.replay;
  const spectator = hud.mySlot < 0;

  /**
   * The minimap answers a finger the way it answers a mouse: a tap or a drag walks the camera around,
   * and the long press that gives orders everywhere else sends the selection to that spot.
   */
  const mm = useRef({ timer: 0, x: 0, y: 0, ordered: false, down: false });
  const mmAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const minimapDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = mmAt(e);
    mm.current = { timer: 0, x: p.x, y: p.y, ordered: false, down: true };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType !== 'touch') { view.minimapClick(p.x, p.y, e.button, e.shiftKey); return; }
    view.minimapClick(p.x, p.y, 0, false);
    mm.current.timer = window.setTimeout(() => {
      mm.current.ordered = true;
      buzz();
      view.minimapOrder(mm.current.x, mm.current.y);
    }, 420);
  };
  const minimapMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!mm.current.down) return;
    const p = mmAt(e);
    if (Math.hypot(p.x - mm.current.x, p.y - mm.current.y) > 0.03 && mm.current.timer) { clearTimeout(mm.current.timer); mm.current.timer = 0; }
    mm.current.x = p.x; mm.current.y = p.y;
    if (!mm.current.ordered && (e.pointerType === 'touch' || e.buttons === 1)) view.minimapClick(p.x, p.y, 0, false);
  };
  const minimapUp = () => {
    if (mm.current.timer) clearTimeout(mm.current.timer);
    mm.current = { timer: 0, x: 0, y: 0, ordered: false, down: false };
  };

  const saveReplay = () => {
    const data: ReplayData | null = view.session.replay();
    if (data) { saveLocalReplay(data); setSavedReplay(true); }
  };

  return (
    <div className={`hud${touch ? ' touch' : ''}`}>
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
              {/* the two counters double as the selection shortcuts, which is all touch has instead of F1/F2 */}
              <span className={`pop tappable ${hud.popUsed >= hud.popCap ? 'full' : ''}`} title={t('all')} onClick={() => view.input.selectArmy()}>👥 {hud.popUsed}/{hud.popCap}</span>
              <span className={`hud-age age-${hud.age}`} title={t('ageBadgeTitle')}>{hud.age >= 1 ? 'II' : 'I'}</span>
              {hud.idleWorkers > 0 && <span className="tappable" title={t('idleWorkers')} onClick={() => view.input.selectIdleWorker()}>⛏️ {hud.idleWorkers}</span>}
            </div>
          )}
          <span className="hud-timer">{hud.time}</span>
          {(view.session.setup.speed ?? 1) !== 1 && <span className="hud-speed" title={t('gameSpeed')}>{view.session.setup.speed}×</span>}
          {touch && !isReplay && <button className="hud-menu-btn" onClick={() => view.openChat()} title={t('chat')}>💬</button>}
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
          <div className="row">
            <input ref={chatRef} className="grow" placeholder={t('chat')} maxLength={200} onKeyDown={(e) => { if (e.key === 'Enter') view.sendChat(e.currentTarget.value); if (e.key === 'Escape') view.sendChat(''); }} />
            <button onClick={() => view.sendChat(chatRef.current?.value ?? '')}>{t('send')}</button>
          </div>
        </div>
      )}

      {/* bottom */}
      <div className="hud-bottom">
        <div className="minimap-wrap" onContextMenu={(e) => e.preventDefault()}>
          <canvas ref={minimapRef} width={180} height={180} onPointerDown={minimapDown} onPointerMove={minimapMove} onPointerUp={minimapUp} onPointerCancel={minimapUp} />
        </div>
        {/* `empty` lets the phone layout drop the card altogether and give the map the space */}
        <div className={`sel-panel${p ? '' : ' empty'}`}>
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
            <div className="muted small sel-help">{isReplay ? t('spectator') : t(touch ? 'controlsTextTouch' : 'controlsText')}</div>
          )}
        </div>
        <div className="cmd-panel" onMouseLeave={() => { if (!touch) setTipId(null); }}>
          {hud.panel.slice(0, 9).map((b) => (
            <CmdButton key={b.id} b={b} touch={touch} showKey={!touch} onTip={setTipId} onAction={() => view.panelAction(b.id)} />
          ))}
        </div>
      </div>
      {tip && <CommandTip tip={tip} onClose={touch ? () => setTipId(null) : undefined} />}

      {touch && <OrientationPrompt />}

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
              {/* walking out of a live ladder match is a loss, so the exit concedes it instead of leaving a bot in charge */}
              {isRanked && !spectator && !isReplay ? (
                confirmLeave
                  ? <button className="danger" onClick={() => { view.surrender(); setConfirmLeave(false); }}>{t('leaveRankedConfirm')}</button>
                  : <button className="danger" onClick={() => setConfirmLeave(true)}>{t('leaveGame')}</button>
              ) : (
                <button className="danger" onClick={onLeave}>{t('leaveGame')}</button>
              )}
            </div>
            <p className="small muted" style={{ marginTop: 14 }}>{t(touch ? 'controlsTextTouch' : 'controlsText')}</p>
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
            {isRanked && <RankedPanel result={ranked ?? null} botMatch={botMatch} />}
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

/**
 * A command-panel button. With a mouse the card follows the cursor; with a finger there is no hover, so the
 * card comes up on a press-and-hold - and immediately on a greyed-out button, where "why can't I press
 * this?" is the only thing the player wants to know.
 */
function CmdButton({ b, touch, showKey, onTip, onAction }: { b: PanelButton; touch: boolean; showKey: boolean; onTip: (id: string | null) => void; onAction: () => void }) {
  // greyed out, but never `disabled`: a disabled button swallows hover, and its tooltip - the one
  // that says what is missing - is exactly the one the player needs
  const off = !!b.disabled && !b.cooldown;
  const hold = useRef({ timer: 0, fired: false });
  const stopHold = () => { if (hold.current.timer) { clearTimeout(hold.current.timer); hold.current.timer = 0; } };
  useEffect(() => stopHold, []);

  const down = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    hold.current.fired = false;
    hold.current.timer = window.setTimeout(() => { hold.current.timer = 0; hold.current.fired = true; buzz(); onTip(b.id); }, 320);
  };
  const click = () => {
    stopHold();
    if (hold.current.fired) return; // the hold already showed the card; do not also fire the order
    if (off) { onTip(b.id); return; }
    if (touch) onTip(null);
    onAction();
  };

  return (
    <button className={`cmd-btn ${b.active ? 'active' : ''} ${off ? 'off' : ''}`} aria-disabled={off || undefined}
      onMouseEnter={() => { if (!touch) onTip(b.id); }}
      onPointerDown={down} onPointerUp={stopHold} onPointerCancel={stopHold} onPointerLeave={stopHold}
      onContextMenu={(e) => e.preventDefault()}
      onClick={click}>
      {showKey && <span className="key">{b.key === 'Escape' ? 'Esc' : b.key}</span>}
      <span className="icon">{b.icon}</span>
      {/* the label shrinks a step only when it is too long to fit at the normal size */}
      <span className={`label ${b.label.length > 10 ? 'tight' : ''}`}>{b.label}</span>
      {b.cost !== undefined && <span className={`cost ${b.costOk === false ? 'no' : ''} ${b.cost >= 1000 ? 'long' : ''}`}>💰 {b.cost}</span>}
      {b.cooldown ? <span className="cd">{Math.ceil(b.cooldown * 100)}%</span> : null}
    </button>
  );
}

/** Portrait is playable but cramped; say so once and get out of the way. */
function OrientationPrompt() {
  const t = useT();
  const portrait = usePortrait();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (!portrait) setDismissed(false); }, [portrait]);
  if (!portrait || dismissed) return null;
  return (
    <div className="orient-prompt" onClick={() => setDismissed(true)}>
      <div className="orient-icon">📱</div>
      <h3>{t('rotateDevice')}</h3>
      <p className="small muted">{t('rotateDeviceHint')}</p>
    </div>
  );
}

/**
 * The card above the command panel: price, time, stats, then every requirement ticked off or crossed out,
 * then what the thing actually does. The requirement lines are the point - they say why a button is grey.
 */
function CommandTip({ tip, onClose }: { tip: PanelButton; onClose?: () => void }) {
  const t = useT();
  return (
    <div className={`tooltip${onClose ? ' closable' : ''}`} onClick={onClose}>
      <div className="tt-head">
        <b>{tip.title ?? tip.label}</b>
        {tip.key && !onClose && <span className="tt-key">{tip.key === 'Escape' ? 'Esc' : tip.key.toUpperCase()}</span>}
      </div>
      {(tip.cost !== undefined || tip.time) && (
        <div className="tt-line">
          {tip.cost !== undefined && <span className={tip.costOk === false ? 'bad' : 'gold'}>💰 {tip.cost}</span>}
          {tip.time ? <span className="muted">⏱ {Math.round(tip.time / TICK_RATE)} {t('sec')}</span> : null}
        </div>
      )}
      {tip.stats && tip.stats.length > 0 && (
        <div className="tt-stats">{tip.stats.map((s) => <span key={s.k}>{s.k} <b>{s.v}</b></span>)}</div>
      )}
      {tip.reqs?.map((r, i) => <div key={i} className={`tt-req ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? '✓' : '✕'} {r.text}</div>)}
      {tip.desc && <p className="tt-desc">{tip.desc}</p>}
    </div>
  );
}

/** rating change on the results panel; the ladder writes the match down a moment after the game ends */
function RankedPanel({ result, botMatch }: { result: RankedResult | null; botMatch?: boolean }) {
  const t = useT();
  if (botMatch) return <div className="ranked-result pending muted small">{t('botMatchNote')}</div>;
  if (!result) return <div className="ranked-result pending muted small">{t('rating')}…</div>;
  const up = result.delta >= 0;
  const level = levelFromXp(result.profile.xp);
  return (
    <div className="ranked-result">
      <TierBadge profile={result.profile} size="small" />
      <div className="grow">
        <div className="rating-row">
          <span className="muted small">{t('ratingChange')}</span>
          <span className="muted">{result.ratingBefore}</span>
          <span className="muted">→</span>
          <b className="rating-value">{result.ratingAfter}</b>
          <b className={up ? 'good' : 'bad'}>{up ? '+' : ''}{result.delta}</b>
        </div>
        <div className="small muted">
          {t('opponent')}: {result.opponent.name} ({result.opponent.rating}) · {t('xpGained')} +{result.xpGained}
          {level > result.levelBefore ? ` · ${t('levelUp')} ${t('ratingLevel')} ${level}` : ` · ${t('ratingLevel')} ${level}`}
          {result.placement ? ` · ${t('placementLeft', { n: PLACEMENT_GAMES - result.profile.games })}` : ''}
        </div>
      </div>
    </div>
  );
}
