import { KeyboardEvent, useRef } from 'react';
import { useT } from '../../i18n';
import { Lang, getSettings, updateSettings } from '../../settings';
import { toggleFullscreen } from '../fullscreen';
import { Icon } from '../icons/Icon';

const LANGS: { id: Lang; label: string }[] = [{ id: 'en', label: 'EN' }, { id: 'ru', label: 'RU' }];

/** the browser can put the page in fullscreen (iPhone Safari cannot: the button would do nothing there) */
const canFullscreen = () => typeof document !== 'undefined' && !!document.fullscreenEnabled && !!document.documentElement.requestFullscreen;

/**
 * The menu's utilities: the interface language as a small scale bar (a radio group: arrows move the choice) and the
 * fullscreen button where the browser supports it.
 */
export function LangToggle() {
  const t = useT();
  const lang = getSettings().lang;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = (LANGS.findIndex((l) => l.id === lang) + step + LANGS.length) % LANGS.length;
    updateSettings({ lang: LANGS[i].id });
    refs.current[i]?.focus();
  };
  return (
    <div className="lang-tools">
      <div className="scalebar scalebar--sm" role="radiogroup" aria-label={t('language')} onKeyDown={onKey}>
        {LANGS.map((l, i) => (
          <button
            key={l.id} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" lang={l.id}
            aria-checked={lang === l.id} tabIndex={lang === l.id ? 0 : -1} onClick={() => updateSettings({ lang: l.id })}
          >{l.label}</button>
        ))}
      </div>
      {canFullscreen() && (
        <button type="button" className="btn btn--secondary btn--icon" onClick={toggleFullscreen} title={t('fullscreen')} aria-label={t('fullscreen')}>
          <Icon name="fullscreen" />
        </button>
      )}
    </div>
  );
}
