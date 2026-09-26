import { useEffect, useRef, useState } from 'react';
import { COMMUNITY_PAGE, MapMeta, MapSort } from '@rookfall/protocol';
import { useT } from '../i18n';
import { net } from '../net/client';
import { fetchCommunity, likeMap } from '../net/maps';
import { MapPreview } from './MapPreview';
import { mapErrorKey, sizeLabel } from './mapText';

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

  useEffect(() => {
    const u = [net.on('open', () => setConnected(true)), net.on('close', () => setConnected(false))];
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { u.forEach((f) => f()); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

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

  return (
    <div className="overlay modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card community" role="dialog" aria-label={t('communityMaps')}>
        <button className="back" onClick={onClose}>{t('close')}</button>
        <h2>🌍 {t('communityMaps')}</h2>
        <div className="row community-controls">
          <div className="seg">
            <button className={sort === 'top' ? 'gold' : 'plain'} onClick={() => setSort('top')}>♥ {t('mapSortTop')}</button>
            <button className={sort === 'new' ? 'gold' : 'plain'} onClick={() => setSort('new')}>✦ {t('mapSortNew')}</button>
          </div>
          <input className="grow" placeholder={t('mapSearch')} value={q} maxLength={40} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!connected && <p className="muted small">{t('mapErrOffline')}</p>}
        {error && <p className="error small">{error}</p>}
        <div className="community-list">
          {connected && !loading && maps.length === 0 && !error && <div className="muted small empty">{query ? t('mapSearchNone') : t('communityEmpty')}</div>}
          {maps.map((m, i) => (
            <div key={m.id} className="cmap-row">
              <span className="cmap-rank">{sort === 'top' && !query ? i + 1 : ''}</span>
              <div className="cmap-thumb"><MapPreview payload={m.thumb} fill zones /></div>
              <div className="cmap-info">
                <div className="cmap-name">{m.name}</div>
                <div className="small muted">{t('mapBy', { name: m.author })}</div>
                <div className="small muted">{sizeLabel(m.w, m.h)} · {t('mapPlayersN', { n: m.players })}</div>
              </div>
              <button
                className={`like-btn ${m.liked ? 'liked' : ''}`} disabled={m.mine}
                title={m.mine ? t('mapErrOwnMap') : m.liked ? t('mapUnlike') : t('mapLike')}
                aria-pressed={!!m.liked} onClick={() => toggleLike(m)}
              >
                <span aria-hidden="true">{m.liked ? '♥' : '♡'}</span> {m.likes}
              </button>
              {onPick && <button className="primary" onClick={() => onPick(m)}>{pickLabel ?? t('mapPick')}</button>}
            </div>
          ))}
          {loading && <div className="muted small empty">{t('loading')}</div>}
        </div>
        {!loading && maps.length < total && (
          <div className="row end"><button className="plain" onClick={() => load(maps.length)}>{t('showMore', { n: Math.min(COMMUNITY_PAGE, total - maps.length) })}</button></div>
        )}
      </div>
    </div>
  );
}
