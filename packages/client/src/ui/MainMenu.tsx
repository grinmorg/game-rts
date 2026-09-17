import { useEffect, useRef } from 'react';
import { startMenuScene } from '../game/menuScene';
import { useT } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { isTouchUI } from '../touch';
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

export function MainMenu({ go }: { go: (screen: string) => void }) {
  const t = useT();
  const s = getSettings();
  return (
    <div className="screen">
      <MenuBackground />
      <LangToggle />
      <div className="card narrow">
        <h1>{t('title')}</h1>
        <p className="subtitle">{t('tagline')}</p>
        <div className="row" style={{ marginBottom: 16 }}>
          <label className="muted small">{t('yourName')}</label>
          <input className="grow" defaultValue={s.name} maxLength={20} onBlur={(e) => updateSettings({ name: e.target.value.trim() || s.name })} />
        </div>
        <div className="menu-buttons">
          <button className="primary" onClick={() => go('ranked')}>🏆 {t('ranked')}</button>
          <button onClick={() => go('skirmish')}>⚔️ {t('playAI')}</button>
          <button onClick={() => go('lobby')}>🌐 {t('multiplayer')}</button>
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
