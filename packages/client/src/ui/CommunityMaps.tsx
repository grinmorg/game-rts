import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { COMMUNITY_PAGE, MapMeta, MapSort } from '@pocket-of-empire/protocol';
import { useT } from '../i18n';
import { net } from '../net/client';
import { fetchCommunity, likeMap } from '../net/maps';
import { isTouchUI } from '../touch';
import { MapPreview } from './MapPreview';
import { Icon } from './icons/Icon';
import { mapErrorKey, sizeLabel } from './mapText';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The behaviour of a modal sheet (the map screens' and the editor's dialogs): focus moves in on open (to `initial`,
 * or to the sheet itself on a touch screen, so no virtual keyboard springs up), Tab stays inside, Esc closes, and
 * focus goes back to the opener on close. The scrim follows the visual viewport, so a virtual keyboard shrinks the
 * room the dialog has instead of covering it, and a focused field is scrolled into the part that is still visible.
 */
export function useDialog(close: () => void, initial?: () => HTMLElement | null | undefined) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    const first = isTouchUI() ? null : initialRef.current?.();
    (first ?? box)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length);
      if (!items.length) { e.preventDefault(); box.focus(); return; }
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === items.length - 1)) { e.preventDefault(); items[0].focus(); }
    };
    // a virtual keyboard: the scrim takes the visible part of the screen only
    const vv = window.visualViewport;
    const fit = () => {
      const s = scrimRef.current;
      if (!s || !vv) return;
      s.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      s.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (!isTouchUI() || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      setTimeout(() => { if (document.activeElement === el) el.scrollIntoView({ block: 'center' }); }, 320);
    };
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('keydown', onKey);
    box?.addEventListener('focusin', onFocusIn);
    return () => {
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      window.removeEventListener('keydown', onKey);
      box?.removeEventListener('focusin', onFocusIn);
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  /** the backdrop closes the dialog only when the press starts on it, not on the sheet */
  const onBackdrop = (e: ReactPointerEvent) => { if (e.target === e.currentTarget) closeRef.current(); };
  return { scrimRef, boxRef, onBackdrop };
}

/**
 * A scale bar used as a radio group (SPEC §4): one cell per choice, the chosen one inked; arrow keys move the
 * choice and the focus together, Tab enters on the chosen cell.
 */
export function ScaleBar<T extends string | number>({ items, value, onChange, label, className = '' }: {
  items: { value: T; label: ReactNode; title?: string; ariaLabel?: string; disabled?: boolean }[];
  value: T; onChange: (v: T) => void; label: string; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const cur = items.findIndex((x) => x.value === value);
  const move = (from: number, dir: number) => {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (!items[i].disabled) { onChange(items[i].value); refs.current[i]?.focus(); return; }
    }
  };
  return (
    <div className={`scalebar ${className}`} role="radiogroup" aria-label={label}>
      {items.map((x, i) => (
        <button
          key={String(x.value)} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={x.value === value}
          tabIndex={(cur === -1 ? i === 0 : i === cur) ? 0 : -1} title={x.title} aria-label={x.ariaLabel} disabled={x.disabled}
          onClick={() => onChange(x.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
          }}
        >{x.label}</button>
      ))}
    </div>
  );
}

/**
 * Community maps: every published map, the most liked on top (or the newest), searchable by name or author.
 * With `onPick` it is a map chooser for a skirmish or a room; without, a place to browse and like.
 */
export function CommunityMaps({ onPick, onClose, pickLabel }: { onPick?: (m: MapMeta) => void; onClose: () => void; pickLabel?: string }) {
  const t = useT();
  const [sort, setSort] = useState<MapSort>('top');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [maps, setMaps] = useState<MapMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(net.connected);
  const seq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const { scrimRef, boxRef, onBackdrop } = useDialog(onClose, () => searchRef.current);

  useEffect(() => {
    const u = [net.on('open', () => setConnected(true)), net.on('close', () => setConnected(false))];
    return () => u.forEach((f) => f());
  }, []);

  // typing settles for a moment before the search goes out
  useEffect(() => { const id = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(id); }, [q]);

  const load = (offset: number) => {
    const my = ++seq.current;
    setLoading(true);
    setError('');
    fetchCommunity(sort, query, offset).then((page) => {
      if (my !== seq.current) return;
      setMaps((cur) => (offset ? [...cur, ...page.maps] : page.maps));
      setTotal(page.total);
      setLoading(false);
    }, (e) => { if (my === seq.current) { setError(t(mapErrorKey(e))); setLoading(false); } });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (connected) load(0); }, [sort, query, connected]);

  const toggleLike = (m: MapMeta) => {
    const like = !m.liked;
    const patch = (x: MapMeta): MapMeta => (x.id === m.id ? { ...x, liked: like, likes: Math.max(0, x.likes + (like ? 1 : -1)) } : x);
    setMaps((cur) => cur.map(patch));
    likeMap(m.id, like).then((fresh) => setMaps((cur) => cur.map((x) => (x.id === fresh.id ? fresh : x))), (e) => {
      setMaps((cur) => cur.map((x) => (x.id === m.id ? m : x)));
      setError(t(mapErrorKey(e)));
    });
  };

  const ranked = sort === 'top' && !query;
  const first = loading && maps.length === 0;
  return (
    <div className="scrim maps-scrim" ref={scrimRef} onPointerDown={onBackdrop}>
      <div className="dialog dialog--wide sheet sheet--framed maps-dialog cmaps" role="dialog" aria-modal="true" aria-labelledby="cmaps-title" ref={boxRef} tabIndex={-1}>
        <div className="dialog__head">
          <div>
            <h2 className="dialog__title" id="cmaps-title">{t('communityMaps')}</h2>
            <p className="dialog__sub">{t('communitySub')}</p>
          </div>
          <button type="button" className="btn btn--quiet btn--icon dialog__close" aria-label={t('close')} onClick={onClose}><Icon name="close" /></button>
        </div>

        <div className="cmaps-controls">
          <input
            ref={searchRef} className="text cmaps-search" type="search" enterKeyHint="search" placeholder={t('mapSearch')} aria-label={t('mapSearch')}
            value={q} maxLength={40} onChange={(e) => setQ(e.target.value)}
          />
          <ScaleBar
            className="scalebar--words cmaps-sort" label={t('mapSortLabel')} value={sort} onChange={setSort}
            items={[
              { value: 'top', label: <><Icon name="like" />{t('mapSortTop')}</> },
              { value: 'new', label: <><Icon name="new" />{t('mapSortNew')}</> },
            ]}
          />
        </div>

        <div className="cmaps-list" role="list" aria-busy={loading} aria-label={t('communityMaps')}>
          {!connected && (
            <div className="maps-state"><Icon name="info" /><p>{t('mapErrOffline')}</p></div>
          )}
          {connected && error && (
            <div className="maps-state is-error" role="alert">
              <Icon name="error" /><p>{error}</p>
              <button type="button" className="btn btn--secondary btn--compact" onClick={() => load(maps.length && maps.length < total ? maps.length : 0)}>{t('mapsRetry')}</button>
            </div>
          )}
          {first && <div className="maps-state"><span className="spinner" aria-hidden="true" /><p>{t('loading')}</p></div>}
          {connected && !loading && !error && maps.length === 0 && (
            query
              ? <div className="maps-state"><Icon name="info" /><p>{t('mapSearchNone')}</p><button type="button" className="btn btn--quiet btn--compact" onClick={() => setQ('')}>{t('mapSearchClear')}</button></div>
              : <div className="maps-state"><Icon name="community" /><p>{t('communityEmpty')}</p></div>
          )}
          {maps.map((m, i) => (
            <div key={m.id} className="row-item cmap" role="listitem">
              {ranked && <span className="cmap__rank num" aria-hidden="true">{i + 1}</span>}
              <div className="cmap__plate graduated" aria-hidden="true"><MapPreview payload={m.thumb} fill zones /></div>
              <div className="row-item__main cmap__main">
                <div className="row-item__title">{m.name}</div>
                <div className="row-item__meta">{t('mapBy', { name: m.author })} · {sizeLabel(m.w, m.h)} · {t('mapPlayersN', { n: m.players })}</div>
              </div>
              {m.mine ? (
                <span className="cmap-like is-mine" title={t('mapErrOwnMap')}>
                  <Icon name="like" /><span className="num">{m.likes}</span><span className="badge">{t('mapYours')}</span>
                </span>
              ) : (
                <button
                  type="button" className="cmap-like" aria-pressed={!!m.liked} onClick={() => toggleLike(m)}
                  aria-label={`${m.liked ? t('mapUnlike') : t('mapLike')}: ${m.likes}`} title={m.liked ? t('mapUnlike') : t('mapLike')}
                >
                  <Icon name="like" /><span className="num">{m.likes}</span>
                </button>
              )}
              {onPick && <button type="button" className="btn btn--seal btn--compact cmap__pick" onClick={() => onPick(m)}>{pickLabel ?? t('mapPick')}</button>}
            </div>
          ))}
          {loading && maps.length > 0 && <div className="maps-state is-inline"><span className="spinner" aria-hidden="true" /><p>{t('loading')}</p></div>}
          {!loading && !error && maps.length < total && (
            <div className="cmaps-more">
              <button type="button" className="btn btn--secondary btn--compact" onClick={() => load(maps.length)}>
                {t('showMore', { n: Math.min(COMMUNITY_PAGE, total - maps.length) })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
