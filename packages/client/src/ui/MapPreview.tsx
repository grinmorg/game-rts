import { useEffect, useRef } from 'react';
import { Tile, createMap } from '@warlets/sim';

const COLS: Record<number, string> = { [Tile.Grass]: '#60964a', [Tile.Water]: '#3a6f9e', [Tile.Rock]: '#6e706c', [Tile.Forest]: '#3a692d', [Tile.Dirt]: '#967d55' };

export function MapPreview({ mapId, size = 96 }: { mapId: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const m = createMap(mapId);
    c.width = m.w; c.height = m.h;
    const g = c.getContext('2d')!;
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
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}
