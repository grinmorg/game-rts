import { KeyboardEvent, useEffect, useState } from 'react';
import { MapMeta } from '@pocket-of-empire/protocol';
import { OFFICIAL_MAPS } from '@pocket-of-empire/sim';
import { TKey, t as translate, useT } from '../i18n';
import { refreshMyMaps, useMyMaps } from '../net/maps';
import { getSettings } from '../settings';
import { CommunityMaps } from './CommunityMaps';
import { Icon } from './icons/Icon';
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

/** "2 players" / "2 игрока" / "5 игроков": the plural the interface language asks for */
export function playersLabel(n: number): string {
  return pluralT(n, 'playersCount1', 'playersCount2', 'playersCount5');
}

/** one of three plural forms (Russian: 1 / 2–4 / 5+; English: 1 / other), with {n} filled in */
export function pluralT(n: number, one: TKey, few: TKey, many: TKey): string {
  if (getSettings().lang === 'ru') {
    const a = n % 10, b = n % 100;
    return translate(a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many, { n });
  }
  return translate(n === 1 ? one : many, { n });
}

/** the size and seats of a map: "64×64 · 2 players" */
export function mapMeta(w: number, h: number, players: number): string {
  return `${sizeLabel(w, h)} · ${playersLabel(players)}`;
}

/**
 * Map choice for a skirmish or a room: the official maps and the player's own on bookmark tabs, and a third tab that
 * opens the community maps (published by other players, most liked first). `value` is the chosen map. The maps are
 * atlas plates (MapPreview); the chosen one carries a verdigris ring and a brass pin. Under the grid, on big screens,
 * the legend of the plates' signs.
 */
export function MapPicker({ value, onPick, compact = false, openEditor }: {
  value: PickedMap;
  onPick: (m: PickedMap) => void;
  /** narrow column (the room screen): smaller plates, no legend */
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
  const chosenOutside = value.custom && (tab === 'official' || !own.some((m) => m.id === value.id));
  const tabKeys = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'official' ? 'mine' : 'official';
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className={`map-picker${compact ? ' compact' : ''}`}>
      <div className="tabs map-tabs" role="tablist" aria-label={t('map')} onKeyDown={tabKeys}>
        <button className="tab" role="tab" data-tab="official" aria-selected={tab === 'official'} tabIndex={tab === 'official' ? 0 : -1} onClick={() => setTab('official')}>
          {t('mapsOfficial')}
        </button>
        <button className="tab" role="tab" data-tab="mine" aria-selected={tab === 'mine'} tabIndex={tab === 'mine' ? 0 : -1} onClick={() => setTab('mine')}>
          {t('mapsMine')}{own.length > 0 && <span className="badge">{own.length}</span>}
        </button>
        <button className="tab tab--community" aria-haspopup="dialog" aria-label={t('communityMaps')} title={t('communityMaps')} onClick={() => setCommunity(true)}>
          <Icon name="community" />
          <span className="tab__long">{t('communityMaps')}</span>
          <span className="tab__short">{t('communityShort')}</span>
        </button>
      </div>
      {chosenOutside && (
        <div className="picked-custom slip">
          <div className="picked-thumb"><MapPreview payload={value.thumb} fill zones /></div>
          <div className="picked-custom__text">
            <div className="picked-custom__label">{t('mapChosen')}</div>
            <div className="picked-custom__name">{value.name}</div>
            <div className="picked-custom__meta">{value.author ? `${t('mapBy', { name: value.author })} · ` : ''}{mapMeta(value.w, value.h, value.players)}</div>
          </div>
        </div>
      )}
      {tab === 'official' ? (
        <div className="maps map-grid">
          {OFFICIAL_MAPS.map((m) => {
            const on = !value.custom && m.id === value.id;
            return (
              <button key={m.id} className={`map-card${on ? ' active' : ''}`} aria-pressed={on} onClick={() => onPick(officialPick(m.id))}>
                {on && <Icon name="pin" className="map-card__pin" />}
                <MapPreview mapId={m.id} size={compact ? 90 : 150} fill />
                <div className="map-card__name">{m.name}</div>
                <span className="map-card__meta">{!compact && <span className="map-card__size">{sizeLabel(m.size, m.size)} · </span>}{playersLabel(m.maxPlayers)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {mine.loading && !mine.maps && <p className="map-picker__note"><span className="spinner" /> {t('loading')}</p>}
          {mine.error && !mine.maps && <p className="map-picker__note error">{t('mapErrOffline')}</p>}
          {mine.maps && own.length === 0 && (
            <p className="map-picker__note">
              {t('myMapsEmpty')}{' '}
              {openEditor && <button className="btn btn--quiet btn--small" onClick={openEditor}><Icon name="map-editor" />{t('mapEditor')}</button>}
            </p>
          )}
          {own.length > 0 && (
            <div className="maps map-grid">
              {own.map((m) => {
                const on = value.custom && m.id === value.id;
                return (
                  <button
                    key={m.id} className={`map-card${on ? ' active' : ''}`} aria-pressed={on} disabled={!m.valid}
                    title={m.valid ? undefined : t('mapHasErrorsLong')} onClick={() => onPick(customPick(m))}
                  >
                    {on && <Icon name="pin" className="map-card__pin" />}
                    <MapPreview payload={m.thumb} fill zones />
                    <div className="map-card__name">{m.name}</div>
                    <span className="map-card__meta">
                      {m.valid ? <>{!compact && <span className="map-card__size">{sizeLabel(m.w, m.h)} · </span>}{playersLabel(m.players)}</> : <><Icon name="warning" />{t('mapHasErrors')}</>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {!compact && <MapLegend />}
      {community && <CommunityMaps onClose={() => setCommunity(false)} onPick={(m) => { setCommunity(false); onPick(customPick(m)); }} />}
    </div>
  );
}

/** «Условные знаки»: the signs of the plates, as on the margin of a printed map (big screens only) */
function MapLegend() {
  const t = useT();
  const item = (sw: string, key: TKey) => <li className="map-legend__item"><span className={`map-legend__sw sw--${sw}`} aria-hidden="true" />{t(key)}</li>;
  return (
    <div className="map-legend">
      <span className="map-legend__title">{t('legendTitle')}</span>
      <ul className="map-legend__list">
        {item('meadow', 'legendMeadow')}
        {item('forest', 'legendForest')}
        {item('water', 'legendWater')}
        {item('rock', 'legendRock')}
        {item('gold', 'legendGold')}
        <li className="map-legend__item"><span className="map-legend__start" aria-hidden="true">1</span>{t('legendStart')}</li>
      </ul>
    </div>
  );
}
