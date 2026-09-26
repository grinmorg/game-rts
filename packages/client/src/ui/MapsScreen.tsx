import { useEffect, useState } from 'react';
import { MAPS_PER_PLAYER, MapMeta } from '@rookfall/protocol';
import { MAP_NAME_MAX, MAP_SIZE_MAX, MAP_SIZE_MIN, OFFICIAL_MAPS, blankCustomMap, decodeCustomSource, isRandomMapId, officialMapSource } from '@rookfall/sim';
import { EditorDoc } from '../editor/doc';
import { SizeFields } from '../editor/EditorScreen';
import { openEditor } from '../editor/session';
import { formatDate, useT } from '../i18n';
import { net } from '../net/client';
import { deleteMap, fetchMapData, publishMap, refreshMyMaps, useMyMaps } from '../net/maps';
import { CommunityMaps } from './CommunityMaps';
import { MenuBackground } from './MainMenu';
import { PickedMap, customPick } from './MapPicker';
import { MapPreview } from './MapPreview';
import { mapErrorKey, sizeLabel } from './mapText';
import { useAccount } from './useAccount';

/**
 * The map editor's home: the player's own maps (open, play, publish, delete), a new map, a file import, and
 * the community maps to browse and like.
 */
export function MapsScreen({ back, edit, play, signIn }: {
  back: () => void;
  /** a document is open in the editor session: show the editor */
  edit: () => void;
  /** a skirmish on this map */
  play: (m: PickedMap) => void;
  signIn: () => void;
}) {
  const t = useT();
  const mine = useMyMaps();
  const { account } = useAccount();
  const [connected, setConnected] = useState(net.connected);
  const [creating, setCreating] = useState(false);
  const [community, setCommunity] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    refreshMyMaps();
    const u = [net.on('open', () => setConnected(true)), net.on('close', () => setConnected(false))];
    return () => u.forEach((f) => f());
  }, []);

  const run = async (id: string, job: () => Promise<unknown>) => {
    setBusy(id); setError('');
    try { await job(); } catch (e) { setError(t(mapErrorKey(e))); }
    setBusy(null);
  };

  const open = (m: MapMeta) => run(m.id, async () => {
    const src = decodeCustomSource(await fetchMapData(m.id, m.rev));
    if (!src) throw new Error('invalid');
    openEditor(new EditorDoc(src, m.id, m.rev));
    edit();
  });

  const importFile = async (file: File) => {
    const src = decodeCustomSource(await file.text());
    if (!src) { setError(t('edImportBad')); return; }
    const doc = new EditorDoc(src);
    doc.dirty = true;
    openEditor(doc);
    edit();
  };

  const maps = mine.maps ?? [];
  return (
    <div className="screen">
      <MenuBackground />
      <div className="card maps-screen">
        <button className="back" onClick={back}>{t('back')}</button>
        <h2>🗺️ {t('mapEditor')}</h2>
        <div className="row">
          <button className="primary" onClick={() => setCreating(true)}>＋ {t('newMap')}</button>
          <label className="file-btn">
            <input type="file" accept=".rookmap,.json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
            <span>⬆️ {t('edImport')}</span>
          </label>
          <span className="grow" />
          <button className="plain" onClick={() => setCommunity(true)}>🌍 {t('communityMaps')}</button>
        </div>
        {!account && <p className="small muted">{t('mapsGuestNote')} <button className="link-btn" onClick={signIn}>{t('signIn')}</button></p>}
        {!connected && <p className="small muted">{t('mapsOffline')}</p>}
        {error && <p className="error small">{error}</p>}

        <h3>{t('mapsMine')} {mine.maps && <span className="muted small">{maps.length}/{MAPS_PER_PLAYER}</span>}</h3>
        {mine.loading && !mine.maps && <p className="muted small">{t('loading')}</p>}
        {mine.maps && maps.length === 0 && <p className="muted small">{t('myMapsEmptyEditor')}</p>}
        <div className="my-maps">
          {maps.map((m) => (
            <div key={m.id} className={`my-map ${m.valid ? '' : 'invalid'}`}>
              <button className="my-map-thumb" onClick={() => void open(m)} disabled={busy === m.id} title={t('edit')}>
                <MapPreview payload={m.thumb} fill zones />
              </button>
              <div className="my-map-info">
                <div className="my-map-name">{m.name}</div>
                <div className="small muted">{sizeLabel(m.w, m.h)} · {t('mapPlayersN', { n: m.players })} · ♥ {m.likes}</div>
                <div className="tiny muted">{t('mapEdited', { date: formatDate(m.updatedAt) })}</div>
                {!m.valid && <div className="small error">⚠ {t('mapHasErrorsLong')}</div>}
                <label className={`check ${m.valid ? '' : 'disabled'}`} title={m.valid ? t('mapPublicHint') : t('mapHasErrorsLong')}>
                  <input type="checkbox" checked={m.public} disabled={!m.valid || busy === m.id || !connected} onChange={(e) => void run(m.id, () => publishMap(m.id, e.target.checked))} />
                  <span>{t('mapPublic')}</span>
                </label>
              </div>
              <div className="my-map-actions">
                <button className="gold small-btn" disabled={busy === m.id || !connected} onClick={() => void open(m)}>✏️ {t('edit')}</button>
                <button className="small-btn" disabled={!m.valid} onClick={() => play(customPick(m))}>⚔️ {t('playOnMap')}</button>
                <button className="danger small-btn" disabled={busy === m.id || !connected} onClick={() => { if (window.confirm(t('mapDeleteConfirm', { name: m.name }))) void run(m.id, () => deleteMap(m.id)); }}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {creating && <NewMapDialog close={() => setCreating(false)} create={(doc) => { openEditor(doc); edit(); }} />}
      {community && <CommunityMaps onClose={() => setCommunity(false)} onPick={(m) => { setCommunity(false); play(customPick(m)); }} pickLabel={t('playOnMap')} />}
    </div>
  );
}

function NewMapDialog({ close, create }: { close: () => void; create: (doc: EditorDoc) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [w, setW] = useState(128);
  const [h, setH] = useState(128);
  const [base, setBase] = useState('blank');
  const official = OFFICIAL_MAPS.filter((m) => !isRandomMapId(m.id));
  const fromOfficial = base !== 'blank';
  const ok = fromOfficial || (w >= MAP_SIZE_MIN && w <= MAP_SIZE_MAX && h >= MAP_SIZE_MIN && h <= MAP_SIZE_MAX);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [close]);
  const submit = () => {
    if (!ok) return;
    const title = name.trim() || t('untitledMap');
    const src = fromOfficial ? { ...officialMapSource(base), name: title } : blankCustomMap(title, w, h);
    const doc = new EditorDoc(src);
    doc.dirty = true;
    create(doc);
  };
  return (
    <div className="overlay modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="card narrow" role="dialog" aria-label={t('newMap')}>
        <h2>{t('newMap')}</h2>
        <label className="field"><span className="small muted">{t('mapName')}</span>
          <input autoFocus value={name} maxLength={MAP_NAME_MAX} placeholder={t('untitledMap')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} /></label>
        <h3>{t('newMapBase')}</h3>
        <select value={base} onChange={(e) => setBase(e.target.value)} style={{ width: '100%' }}>
          <option value="blank">{t('newMapBlank')}</option>
          {official.map((m) => <option key={m.id} value={m.id}>{t('newMapCopyOf', { name: m.name })} ({m.size}×{m.size})</option>)}
        </select>
        {!fromOfficial && <><h3>{t('mapSize')}</h3><SizeFields w={w} h={h} setW={setW} setH={setH} /></>}
        <p className="tiny muted">{t('newMapNote')}</p>
        <div className="row end">
          <button className="plain" onClick={close}>{t('cancel')}</button>
          <button className="primary" disabled={!ok} onClick={submit}>{t('create')}</button>
        </div>
      </div>
    </div>
  );
}
