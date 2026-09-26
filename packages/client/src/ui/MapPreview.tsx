import { useEffect, useRef } from 'react';
import { MapData, PLAYER_COLORS, Tile, createMap, decodeCustomMap, isCustomMapId, isRandomMapId } from '@rookfall/sim';

const COLS: Record<number, string> = { [Tile.Grass]: '#60964a', [Tile.Water]: '#3a6f9e', [Tile.Rock]: '#6e706c', [Tile.Forest]: '#3a692d', [Tile.Dirt]: '#967d55' };
const RGB = Object.fromEntries(Object.entries(COLS).map(([k, hex]) => [k, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))])) as Record<number, number[]>;

/**
 * Thumbnail of a map. `fill` stretches it to the width of its container (map cards); otherwise it is `size` px square.
 * An official map is named by `mapId`; a player-made one comes as its (thumbnail) `payload` or as decoded `map` data.
 * A map that is not square is letterboxed into the square. The procedural maps have no fixed layout, so they get a
 * "?" over a scatter of map-coloured pixels instead of a preview.
 */
export function MapPreview({ mapId, payload, map, size = 96, fill = false, zones = false }: {
  mapId?: string; payload?: string; map?: MapData | null; size?: number; fill?: boolean;
  /** colour the spawns by zone (map lists of player-made maps) instead of plain rings */
  zones?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    let m: MapData | null = map ?? null;
    if (!m && payload) m = decodeCustomMap(payload);
    if (!m && mapId) {
      if (isRandomMapId(mapId)) { drawRandomCard(c, g); return; }
      if (!isCustomMapId(mapId)) m = createMap(mapId);
    }
    if (!m) { c.width = c.height = 8; g.fillStyle = '#1b1310'; g.fillRect(0, 0, 8, 8); return; }
    drawMap(c, g, m, zones);
  }, [mapId, payload, map, zones]);
  return <canvas ref={ref} style={fill ? { width: '100%', height: 'auto' } : { width: size, height: size }} />;
}

function drawMap(c: HTMLCanvasElement, g: CanvasRenderingContext2D, m: MapData, zones: boolean): void {
  const n = Math.max(m.w, m.h);
  const ox = (n - m.w) >> 1, oy = (n - m.h) >> 1;
  c.width = n; c.height = n;
  g.fillStyle = '#120d0b';
  g.fillRect(0, 0, n, n);
  const img = g.createImageData(m.w, m.h);
  for (let i = 0; i < m.tiles.length; i++) {
    const rgb = RGB[m.tiles[i]] ?? RGB[0];
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, ox, oy);
  // markers keep a readable size on a big map
  const k = Math.max(1, n / 96);
  g.fillStyle = '#e0b53a';
  for (const mine of m.mines) g.fillRect(ox + mine.x - 1.5 * k + 0.5, oy + mine.y - 1.5 * k + 0.5, 3 * k, 3 * k);
  // every zone offers several candidate spawns and one is drawn at random per match, so they are
  // marked as hollow rings rather than solid "this is where you start" dots
  g.lineWidth = k;
  for (const s of m.starts) {
    const col = zones ? '#' + PLAYER_COLORS[s.zone % PLAYER_COLORS.length].toString(16).padStart(6, '0') : '#fff';
    g.strokeStyle = zones ? '#fff' : col;
    g.fillStyle = zones ? col : 'rgba(255, 255, 255, 0.35)';
    g.beginPath(); g.arc(ox + s.x + 0.5, oy + s.y + 0.5, 2.2 * k, 0, Math.PI * 2); g.fill(); g.stroke();
  }
}

/** a fixed (hash-based, so it never flickers) scatter of terrain-coloured blocks under a big question mark */
function drawRandomCard(c: HTMLCanvasElement, g: CanvasRenderingContext2D): void {
  const N = 24, B = 8;
  c.width = N * B; c.height = N * B;
  const palette = ['#60964a', '#60964a', '#5a8f45', '#68a050', '#3a692d', '#3a6f9e', '#967d55', '#6e706c'];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) >>> 0;
    g.fillStyle = palette[h % palette.length];
    g.fillRect(x * B, y * B, B, B);
  }
  g.fillStyle = 'rgba(12, 8, 4, 0.38)';
  g.fillRect(0, 0, c.width, c.height);
  const font = getComputedStyle(document.body).getPropertyValue('--font').trim() || 'serif';
  g.font = `bold ${Math.round(c.height * 0.74)}px ${font}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 12; g.lineJoin = 'round'; g.strokeStyle = 'rgba(22, 12, 6, 0.9)';
  g.strokeText('?', c.width / 2, c.height / 2 + c.height * 0.04);
  g.fillStyle = '#e8c76a';
  g.fillText('?', c.width / 2, c.height / 2 + c.height * 0.04);
}
