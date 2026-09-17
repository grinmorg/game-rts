import { useEffect, useRef } from 'react';
import { RANDOM_MAP_ID, Tile, createMap } from '@rookfall/sim';

const COLS: Record<number, string> = { [Tile.Grass]: '#60964a', [Tile.Water]: '#3a6f9e', [Tile.Rock]: '#6e706c', [Tile.Forest]: '#3a692d', [Tile.Dirt]: '#967d55' };

/**
 * Thumbnail of a map. `fill` stretches it to the width of its container (map cards); otherwise it is `size` px square.
 * The random map has no fixed layout, so it gets a "?" over a scatter of map-coloured pixels instead of a preview.
 */
export function MapPreview({ mapId, size = 96, fill = false }: { mapId: string; size?: number; fill?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    if (mapId === RANDOM_MAP_ID) { drawRandomCard(c, g); return; }
    const m = createMap(mapId);
    c.width = m.w; c.height = m.h;
    const img = g.createImageData(m.w, m.h);
    for (let i = 0; i < m.tiles.length; i++) {
      const hex = COLS[m.tiles[i]] ?? COLS[0];
      img.data[i * 4] = parseInt(hex.slice(1, 3), 16); img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16); img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16); img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = '#e0b53a';
    for (const mine of m.mines) g.fillRect(mine.x - 1, mine.y - 1, 3, 3);
    // every zone offers several candidate spawns and one is drawn at random per match, so they are
    // marked as hollow rings rather than solid "this is where you start" dots
    g.strokeStyle = '#fff';
    g.fillStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1;
    for (const s of m.starts) {
      g.beginPath(); g.arc(s.x, s.y, 2.2, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }, [mapId]);
  return <canvas ref={ref} style={fill ? { width: '100%', height: 'auto' } : { width: size, height: size }} />;
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
