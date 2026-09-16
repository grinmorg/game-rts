import { useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { getSettings, updateSettings } from '../settings';

export function LangToggle() {
  const t = useT();
  const lang = getSettings().lang;
  void t;
  return (
    <div className="lang-toggle">
      <button className={lang === 'en' ? 'primary' : ''} onClick={() => updateSettings({ lang: 'en' })}>EN</button>
      <button className={lang === 'ru' ? 'primary' : ''} onClick={() => updateSettings({ lang: 'ru' })}>RU</button>
    </div>
  );
}

/** Animated low-poly-ish background for menus (2D canvas, cheap). */
export function MenuBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext('2d')!;
    let raf = 0;
    const tris: { x: number; y: number; s: number; v: number; h: number }[] = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random(), s: 20 + Math.random() * 60, v: 0.01 + Math.random() * 0.03, h: 24 + Math.random() * 26 }));
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const w = c.width = c.clientWidth, h = c.height = c.clientHeight;
      g.clearRect(0, 0, w, h);
      for (const tr of tris) {
        const y = ((tr.y + t * 0.00002 * tr.v * 50) % 1.2) - 0.1;
        g.fillStyle = `hsla(${tr.h}, 45%, 38%, 0.16)`;
        g.beginPath(); g.moveTo(tr.x * w, y * h); g.lineTo(tr.x * w + tr.s, y * h + tr.s * 0.6); g.lineTo(tr.x * w - tr.s * 0.4, y * h + tr.s); g.closePath(); g.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
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
          <button className="primary" onClick={() => go('skirmish')}>⚔️ {t('playAI')}</button>
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
        <p className="small muted">{t('controlsText')}</p>
        <p className="small muted">{t('version')} 0.1.0 · PRD v0.3</p>
      </div>
    </div>
  );
}
