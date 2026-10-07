import { MouseEvent, useEffect, useRef, useState } from 'react';
import { formatTime, useT } from '../../i18n';
import { GameView } from '../../game/view';
import { Icon, IconId } from '../icons/Icon';
import { SaveSlip, useModalFocus, useReplaySave } from './ResultsOverlay';

/** a confirm button ignores presses this soon after it appeared, so a double click on the first button never confirms */
const CONFIRM_ARM_MS = 300;

/**
 * The menu over a match (Esc): a compact framed sheet. The seal resumes; saving the replay and offering a draw are
 * secondary; surrendering is the hatched danger in the corner and asks first, as does leaving a live match (on the
 * ladder leaving concedes it, so that exit is danger too). The controls help folds away behind «Управление» in the
 * corner, so the sheet fits a phone held sideways. Clicking outside the sheet resumes; Esc toggles it (or backs out of
 * a confirm). The confirm states live in the HUD; closing the menu drops them.
 */
export function PauseMenu({ view, touch, spectator, isReplay, isRanked, savedReplay, onSaveReplay, voteDraw, confirmSurrender, setConfirmSurrender, confirmLeave, setConfirmLeave, onLeave }: {
  view: GameView; touch: boolean; spectator: boolean; isReplay: boolean; isRanked?: boolean;
  savedReplay: boolean; onSaveReplay: () => void; voteDraw: boolean;
  confirmSurrender: boolean; setConfirmSurrender: (v: boolean) => void;
  confirmLeave: boolean; setConfirmLeave: (v: boolean) => void;
  onLeave: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const save = useReplaySave(view, savedReplay, onSaveReplay);
  const live = !spectator && !isReplay;
  const net = view.session.kind === 'net';
  const confirming = live ? (confirmSurrender ? 'surrender' : confirmLeave ? 'leave' : null) : null;
  const cancel = () => { setConfirmSurrender(false); setConfirmLeave(false); };
  // a confirm left open when the menu closes is dropped: the menu opens on its first page again
  useEffect(() => () => { setConfirmSurrender(false); setConfirmLeave(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // back from a confirm, the focus returns to the sheet's first page (it would fall to the page and into the game's hotkeys)
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && !confirming) ref.current?.querySelector<HTMLElement>('.pz-resume')?.focus({ preventScroll: true });
    wasConfirming.current = !!confirming;
  }, [confirming]);
  const onKeyDown = useModalFocus(ref, { initial: '.pz-resume', passEscape: true, onEscape: confirming ? cancel : undefined });
  const paused = view.session.kind === 'local';
  let mapName = '';
  try { mapName = view.sim.map.name; } catch { /* no place line */ }
  const time = formatTime(view.sim.tick, view.session.setup.speed ?? 1);

  const sheet = confirming ? (
    <ConfirmStep
      title={t(confirming === 'surrender' ? 'surrenderTitle' : isRanked ? 'leaveRankedTitle' : 'leaveTitle')}
      text={t(confirming === 'surrender' ? 'surrenderText' : isRanked ? 'leaveRankedConfirm' : net ? 'leaveTextNet' : 'leaveTextLocal')}
      yes={t(confirming === 'surrender' ? 'surrenderYes' : isRanked ? 'leaveRankedYes' : 'leaveYes')}
      icon={confirming === 'surrender' || isRanked ? 'flag' : 'back'}
      cancel={cancel}
      // walking out of a live ladder match is a loss, so the exit concedes it instead of leaving a bot in charge
      confirm={() => {
        if (confirming === 'surrender' || isRanked) { view.surrender(); cancel(); }
        else { cancel(); onLeave(); }
      }} />
  ) : (
    <>
      <div className="dialog__head pz-head">
        <div>
          <h2 className="dialog__title" id="pz-title">{paused ? t('pause') : t('menu')}</h2>
          <p className="dialog__sub pz-sub"><span className="num">{time}</span>{mapName && <> · {mapName}</>}{!paused && !isReplay && <> · {t('matchRunning')}</>}</p>
        </div>
        <button type="button" className="btn btn--quiet btn--small pz-help-toggle" aria-expanded={help} aria-controls="pz-help" onClick={() => setHelp((v) => !v)}>
          {t('controlsHelp')}<Icon name="chevron" className={help ? 'pz-chev is-open' : 'pz-chev'} />
        </button>
      </div>
      {help && <ControlsHelp touch={touch} />}
      <div className="pz-body">
        <button type="button" className="btn btn--seal btn--block pz-resume" onClick={() => view.closeMenu()}>{t('resume')}</button>
        <div className="pz-row">
          <button type="button" className="btn btn--secondary" onClick={save.save} disabled={save.state === 'saved'}>
            <Icon name={save.state === 'saved' ? 'check' : 'save'} />{save.state === 'saved' ? t('replaySaved') : t('saveReplay')}
          </button>
          {live && net && (
            <button type="button" className="btn btn--secondary" aria-pressed={voteDraw} title={voteDraw ? t('voteDrawOn') : undefined} onClick={() => view.voteDraw()}>
              <Icon name={voteDraw ? 'check' : 'flag'} />{voteDraw ? t('drawOffered') : t('drawOffer')}
            </button>
          )}
        </div>
        <SaveSlip save={save} />
      </div>
      <div className="dialog__foot pz-foot">
        {live && <button type="button" className="btn btn--danger btn--compact" onClick={() => setConfirmSurrender(true)}><Icon name="flag" />{t('surrender')}</button>}
        <span className="spacer" />
        {live
          ? <button type="button" className={`btn ${isRanked ? 'btn--danger' : 'btn--quiet'} btn--compact`} onClick={() => setConfirmLeave(true)}><Icon name="back" />{t('leaveGame')}</button>
          : <button type="button" className="btn btn--quiet btn--compact" onClick={onLeave}><Icon name="back" />{t('leaveGame')}</button>}
      </div>
    </>
  );

  return (
    <div className="overlay scrim pz-scrim" data-testid="pause-overlay" onClick={() => view.closeMenu()}>
      <div ref={ref} className={`dialog sheet sheet--framed pz${help ? ' pz--help' : ''}`} role="dialog" aria-modal="true" aria-labelledby="pz-title"
        tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        {sheet}
      </div>
    </div>
  );
}

/**
 * A second step instead of a button that swaps its label in place: the sheet asks, «Отмена» has the focus, and the
 * danger button sits where nothing was a moment ago and ignores presses for a beat - a double click or tap on the
 * first button cannot confirm.
 */
function ConfirmStep({ title, text, yes, icon, cancel, confirm }: {
  title: string; text: string; yes: string; icon: IconId; cancel: () => void; confirm: () => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const shownAt = useRef(performance.now());
  useEffect(() => { cancelRef.current?.focus({ preventScroll: true }); }, []);
  /** the second click of a double click, or a press right after the step appeared, is the first button's - not a yes */
  const deliberate = (e: MouseEvent) => !e.nativeEvent.isTrusted || (e.detail <= 1 && performance.now() - shownAt.current >= CONFIRM_ARM_MS);
  return (
    <div className="pz-confirm">
      <div className="dialog__head pz-head">
        <span className="pz-confirm__sign" aria-hidden><Icon name="warning" /></span>
        <div>
          <h2 className="dialog__title" id="pz-title">{title}</h2>
          <p className="pz-confirm__text">{text}</p>
        </div>
      </div>
      <div className="dialog__foot pz-foot">
        <button ref={cancelRef} type="button" className="btn btn--secondary" onClick={cancel}>{t('cancel')}</button>
        <button type="button" className="btn btn--danger" onClick={(e) => { if (deliberate(e)) confirm(); }}><Icon name={icon} />{yes}</button>
      </div>
    </div>
  );
}

/**
 * The controls, unfolded on demand: the desktop line becomes key caps beside what they do; the touch text (gestures,
 * no keys) becomes a plain list. Both come from the one i18n string, split on its " · " separators.
 */
function ControlsHelp({ touch }: { touch: boolean }) {
  const t = useT();
  const items = t(touch ? 'controlsTextTouch' : 'controlsText').split(/\s+·\s+/).filter(Boolean);
  return (
    <ul id="pz-help" className={`pz-help${touch ? ' pz-help--touch' : ''}`}>
      {items.map((s, i) => {
        if (touch) return <li key={i}>{s}</li>;
        const at = s.indexOf(' ');
        return at > 0
          ? <li key={i}><kbd className="keycap">{s.slice(0, at)}</kbd><span>{s.slice(at + 1)}</span></li>
          : <li key={i}><span>{s}</span></li>;
      })}
    </ul>
  );
}
