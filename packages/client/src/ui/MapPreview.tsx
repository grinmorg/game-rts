import { useEffect, useRef } from 'react';
import { MapData, PLAYER_COLORS, Tile, createMap, decodeCustomMap, isCustomMapId, isRandomMapId } from '@pocket-of-empire/sim';
import { useT } from '../i18n';
import { getSettings } from '../settings';

/*
 * Map previews drawn as atlas plates for the night sheet (SPEC §5): muted washes (meadow, a darker forest dotted with
 * tree signs, water with a darker shore), hatched rock, gold dots, one numbered start disc per spawn zone in that
 * zone's player colour, and a graduated (scale-bar) border round the plate. The procedural maps have no fixed
 * layout, so they get a "terra incognita" plate with a dice sign.
 *
 * Cheap by design: a plate is painted once per mount into one canvas at the size it is shown (× DPR); nothing runs
 * per frame. The tile pass (the only part that grows with the map, 512×512 on Hundred Kingdoms) is cached per map.
 * The legend strip under the map picker (screens/setup.css, .map-legend) repeats this palette: keep them in step.
 */
const PAL = {
  sheet: '#1a1410',
  meadow: [104, 124, 76],
  dirt: [134, 114, 80],
  forest: [66, 92, 54],
  water: [79, 127, 158],
  shore: [52, 90, 118],
  rock: [128, 123, 112],
  tree: '#24361d',
  hatch: 'rgba(32, 27, 21, .62)',
  gold: '#e0b04a',
  goldEdge: '#4a3410',
  paper: '#ece1c8',
  outline: 'rgba(14, 11, 8, .9)',
  bandLight: '#a99878',
  bandDark: '#120e0b',
  unknown: '#2a231b',
  unknownLand: '#342b21',
  ink2: '#cbbb98',
  ink3: '#a99878',
} as const;

const NUM_FONT = '"Ysabeau Office", "PT Sans", system-ui, sans-serif';
const SERIF = '"Brygada 1918", "PT Serif", Georgia, serif';

/**
 * Thumbnail of a map. `fill` stretches it to the width of its container (map cards); otherwise it is `size` px square.
 * An official map is named by `mapId`; a player-made one comes as its (thumbnail) `payload` or as decoded `map` data.
 * A map that is not square is letterboxed into the square. `zones` is kept for the callers: every plate now marks
 * its spawn zones by number and colour.
 */
export function MapPreview({ mapId, payload, map, size = 96, fill = false }: {
  mapId?: string; payload?: string; map?: MapData | null; size?: number; fill?: boolean;
  /** colour the spawns by zone (map lists of player-made maps) - every plate does that now */
  zones?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const t = useT();
  const lang = getSettings().lang;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const css = fill ? (c.clientWidth || c.parentElement?.clientWidth || 160) : size;
    const R = Math.max(64, Math.min(512, Math.ceil((css * dpr) / 32) * 32));
    let alive = true;
    const random = !map && !payload && !!mapId && isRandomMapId(mapId);
    const paint = () => {
      if (!alive) return;
      if (random) { drawUnknown(c, R, dpr, t('mapTerraIncognita'), t('mapRolledAtStart')); return; }
      const model = plateModel(mapId, payload, map);
      if (!model) { c.width = c.height = 8; const g = c.getContext('2d')!; g.fillStyle = PAL.sheet; g.fillRect(0, 0, 8, 8); return; }
      drawPlate(c, model, R, dpr);
    };
    paint();
    // the numbers and the terra incognita lettering want the sheet's faces; redraw once they have arrived
    const fonts = document.fonts;
    const probe = random ? `italic 400 16px ${SERIF}` : `800 12px ${NUM_FONT}`;
    if (fonts && !fonts.check(probe)) fonts.load(probe).then(paint, () => {});
    return () => { alive = false; };
  }, [mapId, payload, map, size, fill, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="map-plate" style={fill ? { width: '100%', height: 'auto' } : { width: size, height: size }} />;
}

/* ------------------------------------------------------------------------------------------------------------- */

/** everything about a map the plate needs that does not depend on the size it is drawn at */
interface PlateModel {
  m: MapData;
  /** the square side the map is letterboxed into, and the offsets of the map inside it */
  n: number; ox: number; oy: number;
  /** n×n: one pixel per tile, shores darkened, the letterbox in sheet colour */
  base: HTMLCanvasElement;
  /** n×n alpha mask of the rock tiles (null: no rock) */
  rock: HTMLCanvasElement | null;
  /** one point per spawn zone (the middle of its candidates), by zone */
  zones: { x: number; y: number; zone: number }[];
}

const cache = new Map<string, PlateModel>();
const byData = new WeakMap<MapData, PlateModel>();
const CACHE_MAX = 16;

function plateModel(mapId?: string, payload?: string, map?: MapData | null): PlateModel | null {
  if (map) {
    let p = byData.get(map);
    if (!p) { p = buildModel(map); byData.set(map, p); }
    return p;
  }
  const key = payload ? `p:${payload}` : mapId && !isCustomMapId(mapId) ? `id:${mapId}` : '';
  if (!key) return null;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const m = payload ? decodeCustomMap(payload) : createMap(mapId!);
  if (!m) return null;
  const p = buildModel(m);
  cache.set(key, p);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

function buildModel(m: MapData): PlateModel {
  const n = Math.max(m.w, m.h);
  const ox = (n - m.w) >> 1, oy = (n - m.h) >> 1;
  const base = document.createElement('canvas');
  base.width = base.height = n;
  const bg = base.getContext('2d')!;
  bg.fillStyle = PAL.sheet;
  bg.fillRect(0, 0, n, n);
  const img = bg.createImageData(m.w, m.h);
  const { tiles, w, h } = m;
  let rocks = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const tile = tiles[i];
      let rgb: readonly number[];
      if (tile === Tile.Water) {
        // a water tile next to land is the shore: a darker edge round every lake and river
        const land = (x > 0 && tiles[i - 1] !== Tile.Water) || (x < w - 1 && tiles[i + 1] !== Tile.Water)
          || (y > 0 && tiles[i - w] !== Tile.Water) || (y < h - 1 && tiles[i + w] !== Tile.Water);
        rgb = land ? PAL.shore : PAL.water;
      } else if (tile === Tile.Forest) rgb = PAL.forest;
      else if (tile === Tile.Rock) { rgb = PAL.rock; rocks++; }
      else if (tile === Tile.Dirt) rgb = PAL.dirt;
      else rgb = PAL.meadow;
      img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 255;
    }
  }
  bg.putImageData(img, ox, oy);

  let rock: HTMLCanvasElement | null = null;
  if (rocks) {
    rock = document.createElement('canvas');
    rock.width = rock.height = n;
    const rg = rock.getContext('2d')!;
    const mask = rg.createImageData(m.w, m.h);
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === Tile.Rock) mask.data[i * 4 + 3] = 255;
    rg.putImageData(mask, ox, oy);
  }

  const acc = new Map<number, { x: number; y: number; k: number }>();
  for (const s of m.starts) {
    const a = acc.get(s.zone) ?? { x: 0, y: 0, k: 0 };
    a.x += s.x; a.y += s.y; a.k++;
    acc.set(s.zone, a);
  }
  const zones = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([zone, a]) => ({ zone, x: a.x / a.k, y: a.y / a.k }));
  return { m, n, ox, oy, base, rock, zones };
}

/* ------------------------------------------------------------------------------------------------------------- */

function hex(c: number): string { return '#' + c.toString(16).padStart(6, '0'); }
/** text on a team colour: dark ink on the light ones (yellow, white, steel), white on the rest */
function onColour(c: number): string {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#221b15' : '#fff';
}

function drawPlate(c: HTMLCanvasElement, p: PlateModel, R: number, dpr: number): void {
  const { m, n, ox, oy } = p;
  c.width = c.height = R;
  const g = c.getContext('2d')!;
  const u = R / 300;
  const fw = Math.max(3, Math.round(4 * u));     // the graduated band
  const S = R - 2 * fw;                           // the map inside it
  const cell = S / n;
  g.fillStyle = PAL.sheet;
  g.fillRect(0, 0, R, R);

  // the washes: the tile layer scaled up smoothly, so coasts and forest edges read as brush, not pixels
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(p.base, 0, 0, n, n, fw, fw, S, S);

  // rock: hatching, clipped to the rock tiles by their (smoothly scaled) mask
  if (p.rock) {
    const hc = document.createElement('canvas');
    hc.width = hc.height = R;
    const hg = hc.getContext('2d')!;
    hg.strokeStyle = PAL.hatch;
    hg.lineWidth = Math.max(1, 1.1 * u);
    const step = Math.max(2.5, 3.4 * u);
    hg.beginPath();
    for (let d = -R; d < R; d += step) { hg.moveTo(d, R); hg.lineTo(d + R, 0); }
    hg.stroke();
    hg.globalCompositeOperation = 'destination-in';
    hg.imageSmoothingEnabled = true;
    hg.drawImage(p.rock, 0, 0, n, n, fw, fw, S, S);
    g.drawImage(hc, 0, 0);
  }

  // forest: tree signs on a staggered grid about 5.5 units apart, whatever the map size
  const stride = Math.max(1, Math.round((5.6 * u) / cell));
  const th = Math.min(4.4 * u, cell * stride * 0.95);
  if (th >= 1.6) {
    g.fillStyle = PAL.tree;
    g.beginPath();
    const { tiles, w, h } = m;
    for (let y = stride >> 1, row = 0; y < h; y += stride, row++) {
      for (let x = row % 2 ? stride >> 1 : 0; x < w; x += stride) {
        if (tiles[y * w + x] !== Tile.Forest) continue;
        const cx = fw + (ox + x + 0.5) * cell, cy = fw + (oy + y + 0.5) * cell;
        g.moveTo(cx, cy - th * 0.55);
        g.lineTo(cx + th * 0.5, cy + th * 0.45);
        g.lineTo(cx - th * 0.5, cy + th * 0.45);
        g.closePath();
      }
    }
    g.fill();
  }

  // a faint vignette: the plate is printed on the sheet, not lit from behind
  const vg = g.createRadialGradient(R / 2, R / 2, S * 0.3, R / 2, R / 2, S * 0.75);
  vg.addColorStop(0, 'rgba(10, 8, 6, 0)');
  vg.addColorStop(1, 'rgba(10, 8, 6, .3)');
  g.fillStyle = vg;
  g.fillRect(fw, fw, S, S);

  // gold
  const gr = Math.max(1.7 * u, Math.min(3.4 * u, cell * 1.1));
  g.lineWidth = Math.max(1, 0.9 * u);
  g.strokeStyle = PAL.goldEdge;
  g.fillStyle = PAL.gold;
  for (const mine of m.mines) {
    g.beginPath();
    g.arc(fw + (ox + mine.x + 0.5) * cell, fw + (oy + mine.y + 0.5) * cell, gr, 0, Math.PI * 2);
    g.fill(); g.stroke();
  }

  // spawn zones: a numbered disc in the zone's colour; a hundred of them become plain coloured dots
  const Z = p.zones.length;
  const numbered = Z <= 16;
  const rm = numbered
    ? Math.max(4.5 * u, Math.min(R * 0.042, S / (Math.sqrt(Z) * 4)))
    : Math.max(2 * u, Math.min(5 * u, S / (Math.sqrt(Z) * 4.6)));
  const showNumbers = numbered && (rm * 1.1) / dpr >= 6.5;
  for (const z of p.zones) {
    const x = fw + (ox + z.x + 0.5) * cell, y = fw + (oy + z.y + 0.5) * cell;
    const col = PLAYER_COLORS[z.zone % PLAYER_COLORS.length];
    g.beginPath(); g.arc(x, y, rm, 0, Math.PI * 2); g.fillStyle = PAL.outline; g.fill();
    const ring = numbered ? Math.max(1, rm * 0.16) : Math.max(0.8, rm * 0.2);
    g.beginPath(); g.arc(x, y, rm - ring * 0.6, 0, Math.PI * 2); g.fillStyle = PAL.paper; g.fill();
    g.beginPath(); g.arc(x, y, rm - ring * 1.6, 0, Math.PI * 2); g.fillStyle = hex(col); g.fill();
    if (showNumbers) {
      const num = String(z.zone + 1);
      g.font = `800 ${Math.round(rm * (num.length > 1 ? 0.95 : 1.12))}px ${NUM_FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = onColour(col);
      g.fillText(num, x, y + rm * 0.07);
    }
  }

  drawBand(g, R, fw);
}

/** the graduated border of a map plate: alternating light and dark segments like a scale bar, 16 a side */
function drawBand(g: CanvasRenderingContext2D, R: number, fw: number): void {
  const S = R - 2 * fw, seg = S / 16;
  for (let i = 0; i < 16; i++) {
    const a = i % 2 ? PAL.bandDark : PAL.bandLight, b = i % 2 ? PAL.bandLight : PAL.bandDark;
    const o = fw + i * seg;
    g.fillStyle = a; g.fillRect(o, 0, seg, fw); g.fillRect(R - fw, o, fw, seg);
    g.fillStyle = b; g.fillRect(o, R - fw, seg, fw); g.fillRect(0, o, fw, seg);
  }
  g.fillStyle = PAL.bandDark;
  g.fillRect(0, 0, fw, fw); g.fillRect(R - fw, 0, fw, fw); g.fillRect(0, R - fw, fw, fw); g.fillRect(R - fw, R - fw, fw, fw);
  // the hairline between the band and the map
  g.strokeStyle = PAL.bandDark;
  g.lineWidth = 1;
  g.strokeRect(fw + 0.5, fw + 0.5, S - 1, S - 1);
}

/** a procedural map: unknown land under hatching, a dashed coast, the dice and "terra incognita" */
function drawUnknown(c: HTMLCanvasElement, R: number, dpr: number, title: string, note: string): void {
  c.width = c.height = R;
  const g = c.getContext('2d')!;
  const u = R / 300;
  const fw = Math.max(3, Math.round(4 * u));
  g.fillStyle = PAL.unknown;
  g.fillRect(0, 0, R, R);
  // hatching over the whole sheet: nobody has been here yet
  g.strokeStyle = 'rgba(236, 225, 200, .07)';
  g.lineWidth = Math.max(1, u);
  g.beginPath();
  for (let d = -R; d < R; d += 7 * u) { g.moveTo(d, R); g.lineTo(d + R, 0); }
  g.stroke();
  // the coast: a fixed wobbly outline (no randomness: the plate never changes)
  const J = [0.92, 1.06, 0.97, 1.1, 0.9, 1.02, 1.12, 0.94, 1.04, 0.88, 1.08, 0.98];
  const cx = R / 2, cy = R * 0.5, rr = R * 0.39;
  const pts = J.map((j, i) => { const a = (i / J.length) * Math.PI * 2; return [cx + rr * j * 1.04 * Math.cos(a), cy + rr * j * 0.86 * Math.sin(a)]; });
  g.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    if (i === 0) g.moveTo(mx, my); else g.quadraticCurveTo(p0[0], p0[1], mx, my);
  }
  const f0 = pts[0], f1 = pts[1];
  g.quadraticCurveTo(f0[0], f0[1], (f0[0] + f1[0]) / 2, (f0[1] + f1[1]) / 2);
  g.closePath();
  g.fillStyle = PAL.unknownLand;
  g.fill();
  g.setLineDash([5 * u, 4 * u]);
  g.strokeStyle = 'rgba(203, 187, 152, .6)';
  g.lineWidth = Math.max(1, 1.3 * u);
  g.stroke();
  g.setLineDash([]);
  // the dice: a rounded square with five pips
  const ds = R * 0.15, dx = cx - ds / 2, dy = R * 0.33 - ds / 2, rad = ds * 0.18;
  g.beginPath();
  g.moveTo(dx + rad, dy); g.arcTo(dx + ds, dy, dx + ds, dy + ds, rad); g.arcTo(dx + ds, dy + ds, dx, dy + ds, rad);
  g.arcTo(dx, dy + ds, dx, dy, rad); g.arcTo(dx, dy, dx + ds, dy, rad); g.closePath();
  g.fillStyle = PAL.ink2; g.fill();
  g.fillStyle = PAL.unknown;
  for (const [px, py] of [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]]) {
    g.beginPath(); g.arc(dx + ds * px, dy + ds * py, ds * 0.09, 0, Math.PI * 2); g.fill();
  }
  // the lettering, only where it can be read
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const t1 = R * 0.09;
  if (t1 / dpr >= 7) {
    g.fillStyle = PAL.ink2;
    g.font = `italic 400 ${Math.round(t1)}px ${SERIF}`;
    g.fillText(title, cx, R * 0.555);
    const t2 = R * 0.055;
    if (t2 / dpr >= 8) {
      g.fillStyle = PAL.ink3;
      g.font = `600 ${Math.round(t2)}px ${NUM_FONT}`;
      g.fillText(note, cx, R * 0.645);
    }
  }
  drawBand(g, R, fw);
}
