import { useEffect, useRef, useState } from 'react';
import { MAPS_PER_PLAYER, MapMeta } from '@pocket-of-empire/protocol';
import { MAP_NAME_MAX, MAP_SIZE_MAX, MAP_SIZE_MIN, OFFICIAL_MAPS, blankCustomMap, decodeCustomSource, isRandomMapId, officialMapSource } from '@pocket-of-empire/sim';
import { EditorDoc } from '../editor/doc';
import { SizeFields } from '../editor/EditorScreen';
import { openEditor } from '../editor/session';
import { formatDate, useT } from '../i18n';
import { net } from '../net/client';
import { deleteMap, fetchMapData, publishMap, refreshMyMaps, useMyMaps } from '../net/maps';
import { CommunityMaps, useDialog } from './CommunityMaps';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
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
  /** the map whose delete is waiting for the second, confirming press */
  const [confirming, setConfirming] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    <div className="screen maps-screen">
      <MenuBackground />
      <main className="sheet sheet--framed maps-sheet" aria-labelledby="maps-title">
        <header className="maps-head">
          <button type="button" className="btn btn--quiet maps-head__back" onClick={back}><Icon name="back" /><span className="maps-head__back-label">{t('menuContents')}</span></button>
          <h1 className="h1 maps-head__title" id="maps-title">{t('mapEditor')}</h1>
          <p className="lede maps-head__lede">{t('mapsLede')}</p>
        </header>

        <div className="maps-body">
          {(!account || !connected || error) && (
            <div className="maps-notes">
              {!account && (
                <p className="maps-note">
                  <Icon name="info" />
                  <span>{t('mapsGuestNote')} <button type="button" className="inline-link maps-note__link" onClick={signIn}>{t('signIn')}</button></span>
                </p>
              )}
              {!connected && <p className="maps-note is-warn"><Icon name="warning" /><span>{t('mapsOffline')}</span></p>}
              {error && <p className="maps-note is-error" role="alert"><Icon name="error" /><span>{error}</span></p>}
            </div>
          )}

          <section className="maps-mine" aria-labelledby="maps-mine-title">
            <div className="legend-head">
              <h2 className="legend-head__name" id="maps-mine-title">{t('mapsMine')}</h2>
              {mine.maps && <span className="legend-head__meta num">{t('mapsQuota', { n: maps.length, max: MAPS_PER_PLAYER })}</span>}
            </div>

            {mine.loading && !mine.maps && <div className="maps-state"><span className="spinner" aria-hidden="true" /><p>{t('loading')}</p></div>}
            {mine.maps && maps.length === 0 && (
              <div className="maps-empty">
                <div className="maps-empty__plate" aria-hidden="true"><Icon name="map-editor" /></div>
                <div>
                  <p className="maps-empty__title">{t('mapsEmptyTitle')}</p>
                  <p className="maps-empty__text">{t('myMapsEmptyEditor')}</p>
                </div>
              </div>
            )}

            {maps.length > 0 && (
              <ul className="maps-grid">
                {maps.map((m) => (
                  <MapSlip
                    key={m.id} m={m} busy={busy === m.id} connected={connected} confirming={confirming === m.id}
                    onOpen={() => void open(m)} onPlay={() => play(customPick(m))}
                    onPublish={(pub) => void run(m.id, () => publishMap(m.id, pub))}
                    onAskDelete={() => setConfirming(m.id)} onCancelDelete={() => setConfirming(null)}
                    onDelete={() => { setConfirming(null); void run(m.id, () => deleteMap(m.id)); }}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="maps-foot">
          <button type="button" className="btn btn--secondary" onClick={() => fileRef.current?.click()}><Icon name="import" />{t('edImport')}</button>
          <button type="button" className="btn btn--secondary" onClick={() => setCommunity(true)}><Icon name="community" />{t('communityMaps')}</button>
          <span className="maps-foot__spacer" />
          <button type="button" className="btn btn--seal maps-foot__seal" onClick={() => setCreating(true)}>{t('newMap')}</button>
          <input ref={fileRef} type="file" accept=".rookmap,.json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        </footer>
      </main>
      {creating && <NewMapDialog close={() => setCreating(false)} create={(doc) => { openEditor(doc); edit(); }} />}
      {community && <CommunityMaps onClose={() => setCommunity(false)} onPick={(m) => { setCommunity(false); play(customPick(m)); }} pickLabel={t('playOnMap')} />}
    </div>
  );
}

/** one of the player's maps: its plate, what it is, whether it can be played and published, and what to do with it */
function MapSlip({ m, busy, connected, confirming, onOpen, onPlay, onPublish, onAskDelete, onCancelDelete, onDelete }: {
  m: MapMeta; busy: boolean; connected: boolean; confirming: boolean;
  onOpen: () => void; onPlay: () => void; onPublish: (pub: boolean) => void;
  onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const delRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    // the confirm strip takes the focus (on the harmless choice); cancelling hands it back to the trash button
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) delRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const offline = !connected;
  return (
    <li className={`map-slip ${m.valid ? '' : 'is-invalid'} ${busy ? 'is-busy' : ''}`}>
      {/* the plate opens the map too (a mouse shortcut: the Edit button is the accessible way) */}
      <div className="map-slip__plate graduated" aria-hidden="true" onClick={() => { if (!busy && connected) onOpen(); }}>
        <MapPreview payload={m.thumb} fill zones />
      </div>
      <div className="map-slip__info">
        <h3 className="map-slip__name">{m.name}</h3>
        <p className="map-slip__meta">
          {sizeLabel(m.w, m.h)} · {t('mapPlayersN', { n: m.players })} · <span className="map-slip__likes"><Icon name="like" /><span className="sr-only">{t('mapLikesSr')}</span>{m.likes}</span>
        </p>
        <p className="map-slip__meta">{t('mapEdited', { date: formatDate(m.updatedAt) })}</p>
        <div className="map-slip__status">
          {busy
            ? <span className="badge"><span className="spinner" aria-hidden="true" />{t('mapBusy')}</span>
            : m.valid
              ? <span className="badge badge--ok"><Icon name="check" />{t('mapReady')}</span>
              : <span className="badge badge--danger"><Icon name="error" />{t('mapHasErrors')}</span>}
          <label className="toggle-row map-slip__public">
            <input type="checkbox" className="toggle" role="switch" checked={m.public} disabled={!m.valid || busy || offline} onChange={(e) => onPublish(e.target.checked)} />
            <span>{t('mapPublic')}</span>
          </label>
        </div>
      </div>
      {!m.valid && <p className="map-slip__why">{t('mapHasErrorsLong')}</p>}
      {m.valid && m.public && <p className="map-slip__why is-ok">{t('mapPublicHint')}</p>}
      {confirming ? (
        <div className="map-slip__actions map-slip__confirm" role="group" aria-label={t('delete')}>
          <p className="map-slip__ask">{t('mapDeleteConfirm', { name: m.name })}</p>
          <button type="button" ref={cancelRef} className="btn btn--quiet btn--compact" onClick={onCancelDelete} onKeyDown={(e) => { if (e.key === 'Escape') onCancelDelete(); }}>{t('cancel')}</button>
          <button type="button" className="btn btn--danger btn--compact" onClick={onDelete} onKeyDown={(e) => { if (e.key === 'Escape') onCancelDelete(); }}><Icon name="delete" />{t('delete')}</button>
        </div>
      ) : (
        <div className="map-slip__actions">
          <button type="button" className="btn btn--secondary btn--compact" disabled={busy || offline} onClick={onOpen}><Icon name="edit" />{t('edit')}</button>
          <button type="button" className="btn btn--secondary btn--compact" disabled={!m.valid} onClick={onPlay}><Icon name="play" />{t('playOnMap')}</button>
          <span className="map-slip__spacer" />
          <button
            type="button" ref={delRef} className="btn btn--danger btn--icon map-slip__del" disabled={busy || offline} onClick={onAskDelete}
            aria-label={t('mapDeleteN', { name: m.name })} title={t('delete')}
          ><Icon name="delete" /></button>
        </div>
      )}
    </li>
  );
}

function NewMapDialog({ close, create }: { close: () => void; create: (doc: EditorDoc) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [w, setW] = useState(128);
  const [h, setH] = useState(128);
  const [base, setBase] = useState('blank');
  const nameRef = useRef<HTMLInputElement>(null);
  const { scrimRef, boxRef, onBackdrop } = useDialog(close, () => nameRef.current);
  const official = OFFICIAL_MAPS.filter((m) => !isRandomMapId(m.id));
  const fromOfficial = base !== 'blank';
  const ok = fromOfficial || (w >= MAP_SIZE_MIN && w <= MAP_SIZE_MAX && h >= MAP_SIZE_MIN && h <= MAP_SIZE_MAX);
  const submit = () => {
    if (!ok) return;
    const title = name.trim() || t('untitledMap');
    const src = fromOfficial ? { ...officialMapSource(base), name: title } : blankCustomMap(title, w, h);
    const doc = new EditorDoc(src);
    doc.dirty = true;
    create(doc);
  };
  return (
    <div className="scrim maps-scrim" ref={scrimRef} onPointerDown={onBackdrop}>
      <div className="dialog sheet sheet--framed maps-dialog newmap" role="dialog" aria-modal="true" aria-labelledby="newmap-title" ref={boxRef} tabIndex={-1}>
        <div className="dialog__head">
          <div>
            <h2 className="dialog__title" id="newmap-title">{t('newMap')}</h2>
            <p className="dialog__sub">{t('newMapSub')}</p>
          </div>
          <button type="button" className="btn btn--quiet btn--icon dialog__close" aria-label={t('close')} onClick={close}><Icon name="close" /></button>
        </div>
        {/* Enter in a text field creates the map, as the seal below does */}
        <div className="dialog__body newmap__body" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); submit(); } }}>
          <div className="newmap__col">
            <label className="field">
              <span className="field__label">{t('mapName')}</span>
              <input ref={nameRef} className="text" value={name} maxLength={MAP_NAME_MAX} placeholder={t('untitledMap')} enterKeyHint="done" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">{t('newMapBase')}</span>
              <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="blank">{t('newMapBlank')}</option>
                {official.map((m) => <option key={m.id} value={m.id}>{t('newMapCopyOf', { name: m.name })} ({sizeLabel(m.size, m.size)})</option>)}
              </select>
            </label>
            <p className="field__hint newmap__note">{t('newMapNote')}</p>
          </div>
          {!fromOfficial && (
            <fieldset className="newmap__col newmap__size">
              <legend className="field__label">{t('mapSize')}</legend>
              <SizeFields w={w} h={h} setW={setW} setH={setH} />
            </fieldset>
          )}
        </div>
        <div className="dialog__foot maps-dialog__foot">
          <button type="button" className="btn btn--quiet" onClick={close}>{t('cancel')}</button>
          <button type="button" className="btn btn--seal" disabled={!ok} onClick={submit}>{t('create')}</button>
        </div>
      </div>
    </div>
  );
}
