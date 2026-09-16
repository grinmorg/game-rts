import { keyFromEvent } from '../game/keys';
import { useEffect, useState } from 'react';
import { TKey, useT } from '../i18n';
import { DEFAULT_HOTKEYS, getSettings, resetHotkeys, subscribeSettings, updateSettings } from '../settings';
import { MenuBackground } from './MainMenu';

const HOTKEY_LABELS: Record<string, TKey> = {
  attackMove: 'attackMove', stop: 'stop', hold: 'hold', patrol: 'patrol', buildMenu: 'build', castle: 'castle', house: 'house', barracks: 'barracks', forge: 'forge', tower: 'tower', wall: 'wall', goldMine: 'goldMine', eject: 'eject', cavalry: 'cavalry', dismantle: 'dismantle',
  worker: 'worker', soldier: 'soldier', archer: 'archer', catapult: 'catapult', rally: 'rally', ability: 'shieldStance', militia: 'militiaCall',
  selectArmy: 'all', idleWorker: 'idleWorkers', rotateLeft: 'perspective', rotateRight: 'perspective', resetCamera: 'perspective',
  upgMelee: 'meleeAttack', upgRanged: 'rangedAttack', upgArmor: 'armor', upgSpeed: 'moveSpeed', upgRange: 'range', upgGather: 'gatherSpeed',
};
const HOTKEY_FALLBACK: Record<string, string> = { selectArmy: 'Select army', idleWorker: 'Idle worker', rotateLeft: 'Rotate left', rotateRight: 'Rotate right', resetCamera: 'Reset camera', ability: 'Ability', scrollUp: 'Scroll up', scrollDown: 'Scroll down', scrollLeft: 'Scroll left', scrollRight: 'Scroll right' };

export function SettingsScreen({ back }: { back: () => void }) {
  const t = useT();
  const [, force] = useState(0);
  const [listening, setListening] = useState<string | null>(null);
  useEffect(() => subscribeSettings(() => force((n) => n + 1)), []);
  const s = getSettings();

  useEffect(() => {
    if (!listening) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') { setListening(null); return; }
      const key = keyFromEvent(e); // physical key, so a binding made on a Russian layout still reads as the Latin letter
      updateSettings({ hotkeys: { ...getSettings().hotkeys, [listening]: key } });
      setListening(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [listening]);

  const label = (k: string) => (HOTKEY_FALLBACK[k] ?? (HOTKEY_LABELS[k] ? t(HOTKEY_LABELS[k]) : k));

  return (
    <div className="screen">
      <MenuBackground />
      <div className="card">
        <button className="back" onClick={back}>{t('back')}</button>
        <h2>{t('settings')}</h2>
        <table className="settings">
          <tbody>
            <tr><td>{t('language')}</td><td><select value={s.lang} onChange={(e) => updateSettings({ lang: e.target.value as 'en' | 'ru' })}><option value="en">English</option><option value="ru">Русский</option></select></td></tr>
            <tr><td>{t('scrollSpeed')}</td><td><input type="range" min={15} max={90} value={s.scrollSpeed} onChange={(e) => updateSettings({ scrollSpeed: Number(e.target.value) })} /> {s.scrollSpeed}</td></tr>
            <tr><td>{t('hudScale')}</td><td><input type="range" min={0.8} max={1.4} step={0.05} value={s.hudScale} onChange={(e) => updateSettings({ hudScale: Number(e.target.value) })} /> {s.hudScale.toFixed(2)}</td></tr>
            <tr><td>{t('volume')}</td><td><input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => updateSettings({ volume: Number(e.target.value) })} /> {Math.round(s.volume * 100)}%</td></tr>
            <tr><td>{t('shadows')}</td><td><input type="checkbox" checked={s.shadows} onChange={(e) => updateSettings({ shadows: e.target.checked })} /></td></tr>
            <tr><td>{t('colorblind')}</td><td><input type="checkbox" checked={s.colorblind} onChange={(e) => updateSettings({ colorblind: e.target.checked })} /></td></tr>
            <tr><td>{t('edgeScroll')}</td><td><input type="checkbox" checked={s.edgeScroll} onChange={(e) => updateSettings({ edgeScroll: e.target.checked })} /></td></tr>
            <tr><td>{t('rmbRotate')}</td><td><input type="checkbox" checked={s.rmbRotate} onChange={(e) => updateSettings({ rmbRotate: e.target.checked })} /></td></tr>
            <tr><td>{t('healthBars')}</td><td><select value={s.showHealthBars} onChange={(e) => updateSettings({ showHealthBars: e.target.value as 'damaged' })}><option value="damaged">{t('damaged')}</option><option value="always">{t('always')}</option><option value="selected">{t('selected')}</option></select></td></tr>
          </tbody>
        </table>
        <div className="row between"><h3>{t('hotkeys')}</h3><button onClick={resetHotkeys}>{t('resetHotkeys')}</button></div>
        <table className="settings">
          <tbody>
            {Object.keys(DEFAULT_HOTKEYS).map((k) => (
              <tr key={k}>
                <td>{label(k)}</td>
                <td><button className={`hotkey-btn ${listening === k ? 'listening' : ''}`} onClick={() => setListening(k)}>{listening === k ? t('pressKey') : s.hotkeys[k]}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
