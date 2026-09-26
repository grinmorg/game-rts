/**
 * Player-made maps on the server: what a map list shows about each one. The map itself (the payload, see
 * `@rookfall/sim` custom.ts) is fetched separately, only when somebody is about to edit or play it.
 */
export interface MapMeta {
  /** the server's id; the map is played as `c:<id>` (customMapId) */
  id: string;
  name: string;
  /** the author's name as of their last save or rename */
  author: string;
  w: number;
  h: number;
  /** spawn zones = the most players the map takes */
  players: number;
  likes: number;
  /** the asking player has liked it */
  liked?: boolean;
  /** the asking player made it (and may edit, publish and delete it) */
  mine?: boolean;
  /** listed under community maps for everybody */
  public: boolean;
  /** passes validateCustomMap: only a valid map can be played or published */
  valid: boolean;
  createdAt: number;
  updatedAt: number;
  /** bumps on every save, so a cached payload is known to be stale */
  rev: number;
  /** downscaled payload for previews (customMapThumb) */
  thumb: string;
}

/** the map a room is set to, when it is a player-made one: enough for everyone in it to see what they will play */
export interface RoomMapInfo {
  id: string;
  name: string;
  author: string;
  w: number;
  h: number;
  players: number;
  thumb: string;
}

export type MapSort = 'top' | 'new';

export type MapErrorCode =
  /** the connection has no player key yet (the hello carried none) */
  | 'noProfile'
  /** the payload is not a map */
  | 'invalid'
  /** the payload is longer than CUSTOM_MAP_MAX_CHARS */
  | 'tooBig'
  /** MAPS_PER_PLAYER reached */
  | 'tooMany'
  /** saves or likes coming too fast */
  | 'throttled'
  | 'notFound'
  /** not the author's map */
  | 'notOwner'
  /** a map with errors cannot be published or played */
  | 'notValid'
  /** nobody likes their own map for the ranking */
  | 'ownMap';

/** how many maps one player may keep on the server */
export const MAPS_PER_PLAYER = 100;
/** community maps per page */
export const COMMUNITY_PAGE = 30;
