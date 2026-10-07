import { CSSProperties, Fragment, ReactNode, useEffect, useState } from 'react';
import { formatTime, useT } from '../../i18n';
import { GameView, HudPlayer, HudState } from '../../game/view';
import { getSettings } from '../../settings';
import { toggleFullscreen } from '../fullscreen';
import { Icon, IconId } from '../icons/Icon';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
/** "Бот 2 (Средний)" → the name, and the bot's level as a quieter note the phone can drop */
const splitName = (name: string): [string, string] => {
  const m = /^(.*\S)\s+(\([^()]*\))$/.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
};
const TOAST_ICONS: Record<HudState['toasts'][number]['kind'], IconId> = { error: 'error', warn: 'warning', info: 'info' };

/**
 * The top edge: three slate islands with the edge left open between them for scrolling. Left, the players as pennants
 * (a spectator's are buttons that choose whose eyes to watch through; a big match keeps your own team and puts everyone
 * in a roster). Middle, the economy - gold, population (= select the army), the age, idle workers (= the next one) - or,
 * in a replay, its controls (`center`); toasts hang under it. Right, the clock, the match speed, chat (touch), fullscreen
 * and the menu; under it the connection, when there is anything to say about it.
 */
export function TopBar({ hud, view, touch, isReplay, center }: { hud: HudState; view: GameView; touch: boolean; isReplay: boolean; center?: ReactNode }) {
  const t = useT();
  const [rosterOpen, setRosterOpen] = useState(false);
  const spectator = hud.mySlot < 0;
  const many = hud.players.length > 12;
  const myTeam = hud.players.find((pl) => pl.slot === hud.mySlot)?.team;
  const barPlayers = !many ? hud.players : hud.players.filter((pl) => (spectator ? pl.slot === hud.perspective : pl.team === myTeam));
  const alive = hud.players.filter((pl) => pl.status !== 'eliminated').length;
  const teamGame = new Set(hud.players.map((pl) => pl.team)).size < hud.players.length;
  const showEco = hud.mySlot >= 0 && hud.perspective >= 0;
  const hk = getSettings().hotkeys;
  const speed = view.session.setup.speed ?? 1;
  const canFullscreen = typeof document === 'undefined' || document.fullscreenEnabled !== false;
  // the roster is a popover: a press anywhere else puts it away
  useEffect(() => {
    if (!rosterOpen) return;
    const close = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('.hud-roster, .roster-btn')) setRosterOpen(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [rosterOpen]);

  const chip = (pl: HudPlayer) => {
    const [name, note] = splitName(pl.name);
    const cls = `hud-player${pl.status === 'eliminated' ? ' is-out' : ''}${pl.status === 'disconnected' ? ' is-dc' : ''}`;
    const body = (
      <>
        <span className="hud-pennant" aria-hidden="true" />
        <span className="name">{name}</span>
        {note && <small className="hud-player__note">{note}</small>}
        {pl.status === 'disconnected' && pl.secondsLeft !== undefined && <span className="hud-player__dc"><Icon name="timer" />{formatTime(pl.secondsLeft * 20)}</span>}
        {pl.gold !== undefined && <span className="hud-player__eco"><Icon name="gold" />{pl.gold}<Icon name="population" />{pl.pop}</span>}
      </>
    );
    const style = { '--team': hex(pl.color) } as CSSProperties;
    const title = `${pl.name} · ${t('team')} ${pl.team + 1}`;
    return spectator
      ? <button key={pl.slot} className={cls} data-testid="hud-player" style={style} title={title} aria-pressed={hud.perspective === pl.slot}
          onClick={() => { view.setPerspective(pl.slot); setRosterOpen(false); }}>{body}</button>
      : <span key={pl.slot} className={cls} data-testid="hud-player" style={style} title={title}>{body}</span>;
  };
  // team games: the bar reads as sides, a thin rule between one team and the next
  const sorted = teamGame ? [...barPlayers].sort((a, b) => a.team - b.team) : barPlayers;

  return (
    <>
      <div className="hud-top">
        <div className="hud-top__l">
          <div className="hud-isle hud-players" role="group" aria-label={t('players')}>
            {/* the chips scroll sideways when they do not fit; the roster and "everyone" stay in view */}
            <div className="hud-players__list">
              {sorted.map((pl, i) => (
                <Fragment key={pl.slot}>
                  {teamGame && i > 0 && sorted[i - 1].team !== pl.team && <span className="hud-team-sep" aria-hidden="true" />}
                  {chip(pl)}
                </Fragment>
              ))}
            </div>
            {many && (
              <button className={`hud-btn roster-btn${rosterOpen ? ' is-on' : ''}`} onClick={() => setRosterOpen((o) => !o)} title={t('players')} aria-expanded={rosterOpen}>
                <Icon name="roster" />{alive}/{hud.players.length}
              </button>
            )}
            {spectator && (
              <button className="hud-all" aria-pressed={hud.perspective < 0} onClick={() => view.setPerspective(-1)} title={t('hudAllVision')}>
                <Icon name="eye" /><span className="name">{t('all')}</span>
              </button>
            )}
          </div>
        </div>

        <div className="hud-top__m">
          {showEco && (
            <div className="hud-isle hud-res" role="group" aria-label={t('hudEconomy')}>
              <span className="hud-seg gold" data-testid="hud-gold" title={t('gold')}><Icon name="gold" />{hud.gold}</span>
              {/* the two counters double as the selection shortcuts, which is all touch has instead of F1/F2 */}
              <button className={`hud-seg hud-seg--btn pop${hud.popUsed >= hud.popCap ? ' is-full' : ''}`} onClick={() => view.input.selectArmy()}
                title={`${t('hudPopulation')} · ${t('ctlArmy')} (${hk.selectArmy})`} aria-label={`${t('hudPopulation')} ${hud.popUsed}/${hud.popCap}. ${t('ctlArmy')}`}>
                <Icon name="population" /><span>{hud.popUsed}<small>/{hud.popCap}</small></span>
              </button>
              <span className="hud-seg hud-age" title={t('ageBadgeTitle')}><span className="hud-lbl">{t('hudAge')}</span><b className="roman">{hud.age >= 1 ? 'II' : 'I'}</b></span>
              {hud.idleWorkers > 0 && (
                <button className="hud-seg hud-seg--btn is-alert" onClick={() => view.input.selectIdleWorker()}
                  title={`${t('idleWorkers')} (${hk.idleWorker})`} aria-label={`${t('idleWorkers')}: ${hud.idleWorkers}`}>
                  <Icon name="idle-worker" /><span>{hud.idleWorkers}</span>
                </button>
              )}
            </div>
          )}
          {center}
          {touch && hud.hint && <div className="hud-hint" role="status">{hud.hint}</div>}
          <div className="hud-toast" role="status">
            {hud.toasts.map((x) => (
              <div key={x.id} className={`toast${x.kind === 'info' ? ' info toast--ok' : x.kind === 'warn' ? ' is-warn' : ' toast--danger'}`}>
                <Icon name={TOAST_ICONS[x.kind]} />{x.text}
              </div>
            ))}
          </div>
        </div>

        <div className="hud-top__r">
          <div className="hud-isle hud-right">
            <span className="hud-seg" title={t('hudMatchTime')}><Icon name="timer" /><span className="hud-timer" data-testid="hud-timer">{hud.time}</span></span>
            {speed !== 1 && <span className="hud-seg hud-speed" title={t('gameSpeed')}>{speed}×</span>}
            <span className="hud-seg hud-btns">
              {touch && !isReplay && (
                <button className="hud-btn hud-btn--icon" onClick={() => view.openChat()} title={t('chat')} aria-label={t('chat')}>
                  <Icon name="chat" />{hud.messages.length > 0 && <span className="hud-dot" aria-hidden="true" />}
                </button>
              )}
              {canFullscreen && <button className="hud-btn hud-btn--icon" onClick={toggleFullscreen} title={t('fullscreen')} aria-label={t('fullscreen')}><Icon name="fullscreen" /></button>}
              {/* the key cap is drawn by CSS (data-key): the button's text stays the plain word scripts look for */}
              {touch
                ? <button className="hud-btn hud-btn--icon hud-menu-btn" onClick={() => view.toggleMenu()} title={t('menu')} aria-label={t('menu')}><Icon name="menu" /></button>
                : <button className="hud-btn hud-menu-btn" data-key="Esc" aria-keyshortcuts="Escape" onClick={() => view.toggleMenu()}><Icon name="menu" />{t('menu')}</button>}
            </span>
          </div>
          {!hud.connected && <div className="hud-net is-warn" role="status"><span className="spinner" aria-hidden="true" />{t('reconnecting')}</div>}
          {hud.desync && <div className="hud-net is-bad" role="alert"><Icon name="error" />{t('hudDesync')}</div>}
          {hud.catchingUp && <div className="hud-net" role="status"><Icon name="fast-forward" />{t('hudCatchingUp')}</div>}
          <div className="hud-fps">{hud.fps} fps · {hud.drawCalls} dc{view.session.kind === 'net' ? ` · ${hud.ping} ms · ${hud.behind} ${t('tick')}` : ''}</div>
        </div>
      </div>
      {many && rosterOpen && (
        <div className="hud-roster" role="dialog" aria-label={t('players')}>
          {hud.players.map(chip)}
        </div>
      )}
    </>
  );
}
