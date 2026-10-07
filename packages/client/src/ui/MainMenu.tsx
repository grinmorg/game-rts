import { ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ACCOUNT_NAME_MIN, AuthErrorCode, NAME_MAX, sanitizeName } from '@pocket-of-empire/protocol';
import { version as APP_VERSION } from '../../package.json';
import { TKey, useT } from '../i18n';
import { net } from '../net/client';
import { refreshMyMaps, useMyMaps } from '../net/maps';
import { getSettings } from '../settings';
import { listLocalReplays } from '../store';
import { useTouchUI } from '../touch';
import { useAccount } from './useAccount';
import { GameLogo } from './common/GameLogo';
import { LangToggle } from './common/LangToggle';
import { MenuBackground } from './common/MenuBackground';
import { Icon, IconId } from './icons/Icon';

/* ============================== shared bits of the menu screens ============================== */

type T = ReturnType<typeof useT>;

/** "{n} записей": the plural form of the language (ru: one / few / many; en: one / other) */
function countOf(t: T, base: 'menuReplays' | 'menuMaps', n: number): string {
  const form = new Intl.PluralRules(getSettings().lang).select(n);
  const suffix = form === 'one' ? 'One' : form === 'few' ? 'Few' : 'Many';
  return t(`${base}${suffix}` as TKey, { n });
}

/** how a hotkey reads on a key cap: letters upper-case, the long key names short */
export function keyLabel(key: string, t: T): string {
  if (!key) return '—';
  if (key === ' ' || key === 'Space') return t('keySpace');
  if (key === 'Escape') return 'Esc';
  if (key === 'Delete') return 'Del';
  const arrow: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };
  if (arrow[key.toLowerCase()]) return arrow[key.toLowerCase()];
  return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
}

/**
 * The header row of an inner screen (about, account, settings): back as a quiet margin note, the title, and an
 * italic subtitle on the right. The sheet around it is `.leaf` (menu.css).
 */
export function LeafHead({ title, sub, back, titleId }: { title: string; sub?: ReactNode; back: () => void; titleId: string }) {
  const t = useT();
  return (
    <header className="leaf__head">
      <button type="button" className="btn btn--quiet leaf__back" onClick={back}><Icon name="back" />{t('back')}</button>
      <h1 className="leaf__title" id={titleId}>{title}</h1>
      {sub && <p className="leaf__sub">{sub}</p>}
    </header>
  );
}

/** true once the server has been out of reach for a while (not in the first moments while the socket opens) */
function useOffline(): boolean {
  const { connected } = useAccount();
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setGrace(false), 4000);
    const off = net.on('close', () => setGrace(false));
    return () => { clearTimeout(timer); off(); };
  }, []);
  return !connected && !grace;
}

/* ============================== main menu ============================== */

/** People on the site right now, as the server counts them; a dashed lamp once there is no connection. */
function OnlineCount({ offline }: { offline: boolean }) {
  const t = useT();
  const [count, setCount] = useState(net.online);
  useEffect(() => {
    const u = [net.on('online', (m) => setCount(m.count)), net.on('close', () => setCount(0))];
    return () => u.forEach((f) => f());
  }, []);
  if (offline) return <span className="menu-online is-off" title={t('offline')}><i aria-hidden="true" />{t('menuOfflineLamp')}</span>;
  if (!count) return <span className="menu-online" />;
  return <span className="menu-online" title={t('onlineHint')}><i aria-hidden="true" />{t('online', { n: count })}</span>;
}

/** sign in, or the account once signed in */
function AccountChip({ open }: { open: () => void }) {
  const t = useT();
  const { account } = useAccount();
  return account ? (
    <button type="button" className="btn btn--quiet btn--compact menu-acct" onClick={open}>
      <span className="acct-avatar acct-avatar--sm" aria-hidden="true">{[...account.name][0]?.toUpperCase()}</span>{t('account')}
    </button>
  ) : (
    <button type="button" className="btn btn--quiet btn--compact menu-acct" onClick={open}><Icon name="account" />{t('signIn')}</button>
  );
}

const NAME_ERRORS: Partial<Record<AuthErrorCode, TKey>> = { badName: 'authBadName', tooMany: 'authTooMany', inMatch: 'authInMatch' };

/**
 * Who is playing: the name as a slip of paper, edited in place (Enter or leaving the box saves it). A guest's name
 * changes at once; an account's nickname once the server accepts it, so the slip says so either way.
 */
function NameSlip({ open }: { open: () => void }) {
  const t = useT();
  const id = useId();
  const s = getSettings();
  const { account, connected } = useAccount();
  // an account's nickname is kept on the server, so it cannot change while there is no connection
  const locked = !!account && !connected;
  const [status, setStatus] = useState<{ k: 'idle' | 'pending' | 'saved' } | { k: 'error'; msg: TKey }>({ k: 'idle' });
  const pending = useRef(false);
  useEffect(() => {
    const u = [
      net.on('account', () => { if (pending.current) { pending.current = false; setStatus({ k: 'saved' }); } }),
      net.on('authError', (m) => { if (pending.current) { pending.current = false; setStatus({ k: 'error', msg: NAME_ERRORS[m.code] ?? 'authBadName' }); } }),
    ];
    return () => u.forEach((f) => f());
  }, []);
  useEffect(() => {
    if (status.k !== 'saved' && status.k !== 'pending') return;
    // "saved" fades after a moment; an answer that never comes stops being awaited
    const timer = setTimeout(() => { pending.current = false; setStatus({ k: 'idle' }); }, status.k === 'saved' ? 2200 : 8000);
    return () => clearTimeout(timer);
  }, [status]);

  const commit = (input: HTMLInputElement) => {
    const v = input.value.trim();
    if (!v || v === s.name) { input.value = s.name; return; }
    if (account && sanitizeName(v).length < ACCOUNT_NAME_MIN) { input.value = s.name; setStatus({ k: 'error', msg: 'authBadName' }); return; }
    if (account) { pending.current = true; setStatus({ k: 'pending' }); } else setStatus({ k: 'saved' });
    net.rename(v);
  };
  const sign: IconId = locked ? 'lock' : status.k === 'saved' ? 'check' : 'pencil';
  const note = locked ? t('nameNeedsServer') : status.k === 'error' ? t(status.msg) : '';

  return (
    <div className="menu-id slip">
      <label className="menu-id__who" htmlFor={id} title={locked ? t('nameNeedsServer') : t('menuEditName')}>
        <span className="menu-id__label">{t('yourName')}</span>
        <span className="menu-id__line">
          {/* keyed by the name, so a nickname that arrives from the server replaces what the box shows */}
          <input
            key={s.name} id={id} className="menu-id__input" defaultValue={s.name} maxLength={NAME_MAX} disabled={locked}
            autoComplete="nickname" spellCheck={false} aria-describedby={note ? `${id}-note` : undefined} aria-invalid={status.k === 'error' || undefined}
            onFocus={() => status.k === 'error' && setStatus({ k: 'idle' })}
            onBlur={(e) => commit(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = s.name; e.currentTarget.blur(); } }}
          />
          {status.k === 'pending' ? <span className="spinner" /> : <Icon name={sign} className={`menu-id__sign${status.k === 'saved' ? ' is-saved' : ''}`} />}
        </span>
      </label>
      <span className="menu-id__sep" aria-hidden="true" />
      <AccountChip open={open} />
      {note && <p className={`menu-id__note${locked ? '' : ' is-error'}`} id={`${id}-note`} role="status">{note}</p>}
    </div>
  );
}

function ContentsRow({ icon, label, value, onClick }: { icon: IconId; label: string; value?: string; onClick: () => void }) {
  return (
    <button type="button" className="ledger__row menu-row" onClick={onClick}>
      <Icon name={icon} />
      <span className="ledger__name">{label}</span>
      {value && <><span className="ledger__dots" /><span className="ledger__value">{value}</span></>}
    </button>
  );
}

export function MainMenu({ go }: { go: (screen: string) => void }) {
  const t = useT();
  const offline = useOffline();
  const replays = useMemo(() => listLocalReplays().length, []);
  const myMaps = useMyMaps();
  // the editor row shows how many maps the player has; the list is the same one the editor home keeps
  useEffect(() => { if (!myMaps.maps && !myMaps.loading) refreshMyMaps(); }, []);
  const mapCount = myMaps.maps?.length;

  return (
    <div className="screen menu-screen">
      <MenuBackground />
      <section className="sheet sheet--framed menu-sheet" aria-label={t('title')}>
        <header className="menu-cartouche">
          <GameLogo />
          <div className="menu-scale" aria-hidden="true">
            <span className="menu-scale__bar"><i /><i /><i /><i /><i /><i /></span>
            <span className="menu-scale__cap">{t('menuScaleCap')}</span>
          </div>
          <p className="menu-lede">{t('tagline')}</p>
        </header>

        <NameSlip open={() => go('account')} />

        <nav className="menu-orders" aria-label={t('play')}>
          <button type="button" className="btn btn--seal btn--block menu-seal" onClick={() => go('skirmish')}>{t('playAI')}</button>
          <div className="menu-pair">
            <button type="button" className="btn btn--secondary" onClick={() => go('ranked')}><Icon name="ranked" />{t('ranked')}</button>
            <button type="button" className="btn btn--secondary" onClick={() => go('lobby')}><Icon name="multiplayer" />{t('multiplayer')}</button>
          </div>
          {offline && <p className="menu-offline" role="status"><Icon name="warning" />{t('offline')}</p>}
        </nav>

        <nav className="ledger menu-contents" aria-label={t('menuContents')}>
          <ContentsRow icon="map-editor" label={t('mapEditor')} value={mapCount === undefined ? undefined : mapCount ? countOf(t, 'menuMaps', mapCount) : t('menuMapsNone')} onClick={() => go('maps')} />
          <ContentsRow icon="replays" label={t('replays')} value={replays ? countOf(t, 'menuReplays', replays) : t('menuReplaysNone')} onClick={() => go('replays')} />
          <ContentsRow icon="settings" label={t('settings')} onClick={() => go('settings')} />
          <ContentsRow icon="about" label={t('about')} value={t('menuVersion', { v: APP_VERSION })} onClick={() => go('about')} />
        </nav>

        <footer className="menu-foot">
          <OnlineCount offline={offline} />
          <LangToggle />
        </footer>
      </section>
    </div>
  );
}

/* ============================== about ============================== */

/** key caps joined the way they are pressed: "+" for together, a gap for alternatives */
function Keys({ seq, alt }: { seq?: string[]; alt?: string[] }) {
  if (seq) return <span className="keys">{seq.map((k, i) => <span key={i} className="keys__k">{i > 0 && <span className="keys__plus">+</span>}<kbd className="keycap">{k}</kbd></span>)}</span>;
  return <span className="keys">{(alt ?? []).map((k, i) => <kbd key={i} className="keycap">{k}</kbd>)}</span>;
}

function HelpRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ledger__row">
      <span className="ledger__name">{label}</span>
      <span className="ledger__dots" />
      <span className="ledger__value">{children}</span>
    </div>
  );
}

export function About({ back }: { back: () => void }) {
  const t = useT();
  const touch = useTouchUI();
  const titleId = useId();
  const hk = getSettings().hotkeys;
  const k = (key: string) => keyLabel(key, t);
  return (
    <div className="screen leaf-screen">
      <MenuBackground />
      <section className="sheet sheet--framed leaf about" aria-labelledby={titleId}>
        <LeafHead title={t('about')} sub={t('menuVersion', { v: APP_VERSION })} back={back} titleId={titleId} />
        <div className="leaf__body">
          <p className="about__text">{t('aboutBody')}</p>

          <div className="legend-head"><h2 className="legend-head__name">{t('controlsHelp')}</h2></div>
          {touch ? (
            <>
              <p className="about__rule">{t('aboutGestureRule')}</p>
              <div className="ledger ledger--dense about__help about__help--touch">
                <HelpRow label={t('gestSelect')}><i>{t('gestTap')}</i></HelpRow>
                <HelpRow label={t('gestDeselect')}><i>{t('gestTapGround')}</i></HelpRow>
                <HelpRow label={t('gestAllKind')}><i>{t('gestDoubleTap')}</i></HelpRow>
                <HelpRow label={t('ctlOrder')}><i>{t('gestTwoTap')}</i></HelpRow>
                <HelpRow label={t('ctlQueue')}><i>{t('gestTwoHold')}</i></HelpRow>
                <HelpRow label={t('ctlPan')}><i>{t('gestDrag')}</i></HelpRow>
                <HelpRow label={t('gestBox')}><i>{t('gestHoldDrag')}</i></HelpRow>
                <HelpRow label={t('gestZoom')}><i>{t('gestPinch')}</i></HelpRow>
                <HelpRow label={t('ctlArmy')}><i>{t('gestTapPop')}</i></HelpRow>
                <HelpRow label={t('idleWorkers')}><i>{t('gestTapIdle')}</i></HelpRow>
              </div>
            </>
          ) : (
            <div className="ledger ledger--dense about__help">
              <HelpRow label={t('ctlSelect')}><Keys alt={[t('keyLmb')]} /></HelpRow>
              <HelpRow label={t('ctlOrder')}><Keys alt={[t('keyRmb')]} /></HelpRow>
              <HelpRow label={t('ctlQueue')}><Keys seq={['Shift', t('keyRmb')]} /></HelpRow>
              <HelpRow label={t('ctlGroupSet')}><Keys seq={['Ctrl', '1…9']} /></HelpRow>
              <HelpRow label={t('ctlGroupGet')}><Keys alt={['1…9']} /></HelpRow>
              <HelpRow label={t('ctlArmy')}><Keys alt={[k(hk.selectArmy)]} /></HelpRow>
              <HelpRow label={t('ctlIdle')}><Keys alt={[k(hk.idleWorker)]} /></HelpRow>
              <HelpRow label={t('ctlPan')}><Keys alt={[[hk.scrollUp, hk.scrollLeft, hk.scrollDown, hk.scrollRight].map(k).join('')]} /><span className="keys__or">{t('keyOrEdges')}</span></HelpRow>
              <HelpRow label={t('ctlZoom')}><Keys alt={[t('keyWheel')]} /></HelpRow>
              <HelpRow label={t('ctlRotate')}><Keys alt={[k(hk.rotateLeft), k(hk.rotateRight)]} /></HelpRow>
              <HelpRow label={t('ctlTilt')}><Keys seq={['Ctrl', t('keyWheel')]} /></HelpRow>
              <HelpRow label={t('ctlResetCam')}><Keys alt={[k(hk.resetCamera)]} /></HelpRow>
              <HelpRow label={t('chat')}><Keys alt={['Enter']} /></HelpRow>
              <HelpRow label={t('menu')}><Keys alt={['Esc']} /></HelpRow>
            </div>
          )}

          <div className="legend-head"><h2 className="legend-head__name">{t('aboutCredits')}</h2></div>
          <div className="ledger ledger--dense about__credits">
            <HelpRow label={t('aboutCreditBuildings')}>Quaternius · CC0</HelpRow>
            <HelpRow label={t('aboutCreditFonts')}>Brygada 1918, Ysabeau Office · OFL</HelpRow>
            <HelpRow label={t('aboutCreditSigns')}>{t('aboutCreditSignsBy')}</HelpRow>
          </div>
        </div>
      </section>
    </div>
  );
}
