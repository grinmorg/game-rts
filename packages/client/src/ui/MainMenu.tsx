import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_NAME_MIN, NAME_MAX, sanitizeName } from '@rookfall/protocol';
import { startMenuScene } from '../game/menuScene';
import { useT } from '../i18n';
import { net } from '../net/client';
import { getSettings, updateSettings } from '../settings';
import { isTouchUI } from '../touch';
import { useAccount } from './useAccount';
import { toggleFullscreen } from './fullscreen';

export function LangToggle() {
  const t = useT();
  const lang = getSettings().lang;
  void t;
  return (
    <div className="lang-toggle">
      <button className={lang === 'en' ? 'primary' : ''} onClick={() => updateSettings({ lang: 'en' })}>EN</button>
      <button className={lang === 'ru' ? 'primary' : ''} onClick={() => updateSettings({ lang: 'ru' })}>RU</button>
      <button onClick={toggleFullscreen} title={t('fullscreen')}>⛶</button>
    </div>
  );
}

/** Animated background for menus: trees, rocks and catapults tumbling past (see startMenuScene). */
export function MenuBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => startMenuScene(ref.current!), []);
  return <canvas ref={ref} className="menu-bg-canvas" />;
}

/** People on the site right now, as the server counts them; hidden while there is no connection. */
function OnlineCount() {
  const t = useT();
  const [count, setCount] = useState(net.online);
  useEffect(() => {
    const u = [net.on('online', (m) => setCount(m.count)), net.on('close', () => setCount(0))];
    return () => u.forEach((f) => f());
  }, []);
  if (!count) return null;
  return <div className="online-count" title={t('onlineHint')}><span className="online-dot" />{t('online', { n: count })}</div>;
}

/** top-right corner of the main menu: the nickname when signed in, a way to sign in otherwise */
function AccountChip({ open }: { open: () => void }) {
  const t = useT();
  const { account } = useAccount();
  return (
    <button className={`account-chip ${account ? '' : 'gold'}`} onClick={open} title={t('account')}>
      <span aria-hidden="true">👤</span> {account ? account.name : t('signIn')}
    </button>
  );
}

export function MainMenu({ go }: { go: (screen: string) => void }) {
  const t = useT();
  const s = getSettings();
  const { account, connected } = useAccount();
  // an account's nickname is kept on the server, so it cannot change while there is no connection
  const nameLocked = !!account && !connected;
  const commitName = (input: HTMLInputElement) => {
    const v = input.value.trim();
    if (!v || v === s.name || (account && sanitizeName(v).length < ACCOUNT_NAME_MIN)) { input.value = s.name; return; }
    net.rename(v);
  };
  return (
    <div className="screen">
      <MenuBackground />
      <LangToggle />
      <AccountChip open={() => go('account')} />
      <div className="card narrow">
        <h1>{t('title')}</h1>
        <p className="subtitle">{t('tagline')}</p>
        <OnlineCount />
        <div className="row" style={{ marginBottom: 16 }}>
          <label className="muted small">{t('yourName')}</label>
          {/* keyed by the name, so a nickname that arrives from the server replaces what the box shows */}
          <input
            key={s.name} className="grow" defaultValue={s.name} maxLength={NAME_MAX} disabled={nameLocked} title={nameLocked ? t('nameNeedsServer') : undefined}
            onBlur={(e) => commitName(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>
        <div className="menu-buttons">
          <button className="primary" onClick={() => go('ranked')}>🏆 {t('ranked')}</button>
          <button onClick={() => go('skirmish')}>⚔️ {t('playAI')}</button>
          <button onClick={() => go('lobby')}>🌐 {t('multiplayer')}</button>
          <button onClick={() => go('maps')}>🗺️ {t('mapEditor')}</button>
          <button onClick={() => go('replays')}>🎞️ {t('replays')}</button>
          <button onClick={() => go('settings')}>⚙️ {t('settings')}</button>
          <button onClick={() => go('about')}>ℹ️ {t('about')}</button>
        </div>
      </div>
    </div>
  );
}

export function About({ back }: { back: () => void }) {
  const t = useT();
  return (
    <div className="screen">
      <MenuBackground />
      <div className="card narrow">
        <button className="back" onClick={back}>{t('back')}</button>
        <h2>{t('about')}</h2>
        <p>{t('aboutText')}</p>
        <h3>{t('controlsHelp')}</h3>
        <p className="small muted">{t(isTouchUI() ? 'controlsTextTouch' : 'controlsText')}</p>
        <p className="small muted">{t('version')} 0.1.0 · PRD v0.3</p>
      </div>
    </div>
  );
}
