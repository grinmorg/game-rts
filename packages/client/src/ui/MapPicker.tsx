import { useEffect, useState } from 'react';
import { MapMeta } from '@rookfall/protocol';
import { OFFICIAL_MAPS } from '@rookfall/sim';
import { useT } from '../i18n';
import { refreshMyMaps, useMyMaps } from '../net/maps';
import { CommunityMaps } from './CommunityMaps';
import { MapPreview } from './MapPreview';
import { sizeLabel } from './mapText';

/** a map chosen for a skirmish or a room: an official one, or a player-made one by its server id */
export interface PickedMap {
  /** official id, or the server id of a player-made map (played as `c:<id>`) */
  id: string;
  custom: boolean;
  name: string;
  players: number;
  w: number;
  h: number;
  author?: string;
  thumb?: string;
  rev?: number;
}

export function officialPick(id: string): PickedMap {
  const m = OFFICIAL_MAPS.find((x) => x.id === id) ?? OFFICIAL_MAPS[0];
  return { id: m.id, custom: false, name: m.name, players: m.maxPlayers, w: m.size, h: m.size };
}

export function customPick(m: MapMeta): PickedMap {
  return { id: m.id, custom: true, name: m.name, players: m.players, w: m.w, h: m.h, author: m.author, thumb: m.thumb, rev: m.rev };
}

/**
 * Map choice for a skirmish or a room: the official maps and the player's own on two tabs, and a button to
 * the community maps (published by other players, most liked first). `value` is the chosen map.
 */
export function MapPicker({ value, onPick, compact = false, openEditor }: {
  value: PickedMap;
  onPick: (m: PickedMap) => void;
  /** narrow column (the room screen): two cards a row, smaller text */
  compact?: boolean;
  /** "make a map" link on an empty My maps tab */
  openEditor?: () => void;
}) {
  const t = useT();
  const mine = useMyMaps();
  const [tab, setTab] = useState<'official' | 'mine'>(value.custom && mine.maps?.some((m) => m.id === value.id) ? 'mine' : 'official');
  const [community, setCommunity] = useState(false);
  useEffect(() => { if (!mine.maps && !mine.loading) refreshMyMaps(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const own = mine.maps ?? [];
  const chosenOutside = value.custom && tab === 'official' || (value.custom && tab === 'mine' && !own.some((m) => m.id === value.id));
  const grid = compact ? { gridTemplateColumns: '1fr 1fr' } : undefined;
  return (
    <div className={`map-picker ${compact ? 'compact' : ''}`}>
      <div className="row map-tabs">
        <div className="seg">
          <button className={tab === 'official' ? 'gold' : 'plain'} onClick={() => setTab('official')}>{t('mapsOfficial')}</button>
          <button className={tab === 'mine' ? 'gold' : 'plain'} onClick={() => setTab('mine')}>{t('mapsMine')}{own.length ? ` · ${own.length}` : ''}</button>
        </div>
        <span className="grow" />
        <button className="plain" onClick={() => setCommunity(true)}>🌍 {t('communityMaps')}</button>
      </div>
      {chosenOutside && (
        <div className="picked-custom">
          <div className="picked-thumb"><MapPreview payload={value.thumb} fill zones /></div>
          <div>
            <div className="small muted">{t('mapChosen')}</div>
            <b>{value.name}</b>
            <div className="small muted">{value.author ? `${t('mapBy', { name: value.author })} · ` : ''}{sizeLabel(value.w, value.h)} · {t('mapPlayersN', { n: value.players })}</div>
          </div>
        </div>
      )}
      {tab === 'official' ? (
        <div className="maps" style={grid}>
          {OFFICIAL_MAPS.map((m) => (
            <button key={m.id} className={`map-card ${!value.custom && m.id === value.id ? 'active' : ''}`} onClick={() => onPick(officialPick(m.id))}>
              <MapPreview mapId={m.id} size={compact ? 90 : 120} fill />
              <div className={compact ? 'small' : ''}>{m.name}</div>
              <div className="small muted">{compact ? `${m.maxPlayers}p` : `${m.size}×${m.size} · ${m.maxPlayers}p`}</div>
            </button>
          ))}
        </div>
      ) : (
        <>
          {mine.loading && !mine.maps && <p className="muted small">{t('loading')}</p>}
          {mine.error && !mine.maps && <p className="muted small">{t('mapErrOffline')}</p>}
          {mine.maps && own.length === 0 && (
            <p className="muted small">{t('myMapsEmpty')} {openEditor && <button className="plain small-btn" onClick={openEditor}>🗺️ {t('mapEditor')}</button>}</p>
          )}
          <div className="maps" style={grid}>
            {own.map((m) => (
              <button
                key={m.id} className={`map-card ${value.custom && m.id === value.id ? 'active' : ''}`} disabled={!m.valid}
                title={m.valid ? undefined : t('mapHasErrors')} onClick={() => onPick(customPick(m))}
              >
                <MapPreview payload={m.thumb} fill zones />
                <div className={`map-card-name ${compact ? 'small' : ''}`}>{m.name}</div>
                <div className="small muted">{m.valid ? `${compact ? '' : sizeLabel(m.w, m.h) + ' · '}${m.players}p` : `⚠ ${t('mapHasErrors')}`}</div>
              </button>
            ))}
          </div>
        </>
      )}
      {community && <CommunityMaps onClose={() => setCommunity(false)} onPick={(m) => { setCommunity(false); onPick(customPick(m)); }} />}
    </div>
  );
}
