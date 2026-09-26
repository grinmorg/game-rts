import { describe, expect, it } from 'vitest';
import { createBots } from '../../ai/src/index';
import {
  CUSTOM_MAP_MAX_CHARS, CustomMapSource, MatchSetup, PLAYER_COLORS, SIM_VERSION, Simulation, Tile,
  blankCustomMap, customMapId, customMapThumb, decodeCustomMap, decodeCustomSource, encodeCustomMap, mapForSetup, mapHasErrors,
  officialMapSource, validateCustomMap,
} from '../src';

/** a small valid two-zone map: open field, a castle spot and a deposit per side, a lake in the middle */
function sample(w = 80, h = 48): CustomMapSource {
  const src = blankCustomMap('Test field', w, h);
  for (let y = 18; y < 30; y++) for (let x = 36; x < 44; x++) src.tiles[y * w + x] = Tile.Water;
  for (let y = 4; y < 10; y++) for (let x = 30; x < 50; x++) src.tiles[y * w + x] = Tile.Forest;
  src.starts.push({ x: 10, y: 24, zone: 0 }, { x: 12, y: 16, zone: 0 }, { x: w - 11, y: 24, zone: 1 }, { x: w - 13, y: 32, zone: 1 });
  src.mines.push({ x: 5, y: 24, gold: 6000 }, { x: w - 6, y: 24, gold: 6000 }, { x: 40, y: 40, gold: 9000 });
  return src;
}

function setupFor(payload: string, players = 2, bots = true): MatchSetup {
  return {
    seed: 99, mapId: customMapId('abc123'), map: payload, version: SIM_VERSION,
    players: Array.from({ length: players }, (_, i) => ({ slot: i, team: i, name: `P${i}`, isBot: bots, difficulty: 1 as const, color: PLAYER_COLORS[i] })),
  };
}

describe('custom maps', () => {
  it('round-trips through the payload, tiles and objects intact', () => {
    const src = sample();
    const payload = encodeCustomMap(src);
    const back = decodeCustomSource(payload)!;
    expect(back.w).toBe(80); expect(back.h).toBe(48);
    expect(back.name).toBe('Test field');
    expect(Array.from(back.tiles)).toEqual(Array.from(src.tiles));
    expect(back.mines).toEqual(src.mines);
    expect(back.starts).toEqual(src.starts);
    const m = decodeCustomMap(payload, 'c:x')!;
    expect(m.maxPlayers).toBe(2);
    expect(m.decor.length).toBeGreaterThan(50); // trees on the forest strip
  });

  it('packs a big empty map small and the worst case under the limit', () => {
    expect(encodeCustomMap(blankCustomMap('Big', 512, 512)).length).toBeLessThan(4000);
    const noise = blankCustomMap('Noise', 512, 512);
    for (let i = 0; i < noise.tiles.length; i++) noise.tiles[i] = (i * 7 + (i >> 9)) % 5;
    const p = encodeCustomMap(noise);
    expect(p.length).toBeLessThan(CUSTOM_MAP_MAX_CHARS);
    expect(Array.from(decodeCustomSource(p)!.tiles)).toEqual(Array.from(noise.tiles));
  });

  it('renumbers zones without gaps', () => {
    const src = sample();
    src.starts = src.starts.map((s) => ({ ...s, zone: s.zone === 0 ? 3 : 7 }));
    expect(decodeCustomSource(encodeCustomMap(src))!.starts.map((s) => s.zone)).toEqual([0, 0, 1, 1]);
  });

  it('refuses anything that is not a well-formed map', () => {
    const good = JSON.parse(encodeCustomMap(sample()));
    const bad: unknown[] = [
      null, 42, '', '{', '{"v":2}', JSON.stringify({ ...good, w: 0 }), JSON.stringify({ ...good, w: 600 }),
      JSON.stringify({ ...good, t: 'AAAA' }), // too few cells
      JSON.stringify({ ...good, t: good.t.slice(0, -4) + '////' }), // run past the end / tile out of range
      JSON.stringify({ ...good, m: [[1, 1, 10]] }), // too little gold
      JSON.stringify({ ...good, m: [[900, 1, 6000]] }),
      JSON.stringify({ ...good, s: [[1, 1, 40]] }),
      JSON.stringify({ ...good, s: [['a', 1, 0]] }),
      'x'.repeat(CUSTOM_MAP_MAX_CHARS + 1),
    ];
    for (const b of bad) expect(decodeCustomSource(b)).toBeNull();
  });

  it('validates what the simulation needs', () => {
    expect(validateCustomMap(sample()).filter((i) => i.error)).toEqual([]);
    const codes = (src: CustomMapSource) => validateCustomMap(src).filter((i) => i.error).map((i) => i.code);

    const one = sample(); one.starts = one.starts.filter((s) => s.zone === 0);
    expect(codes(one)).toContain('fewZones');

    const edge = sample(); edge.starts[0] = { x: 2, y: 24, zone: 0 };
    expect(codes(edge)).toContain('startEdge');

    const wet = sample(); wet.starts[0] = { x: 40, y: 24, zone: 0 };
    expect(codes(wet)).toContain('startBlocked');

    const clash = sample(); clash.mines.push({ x: 11, y: 24, gold: 6000 });
    expect(codes(clash)).toContain('startOverlap');

    const pile = sample(); pile.mines.push({ x: 6, y: 25, gold: 6000 });
    expect(codes(pile)).toContain('mineOverlap');

    // a wall of rock from top to bottom: the two sides never meet
    const split = sample();
    for (let y = 0; y < 48; y++) split.tiles[y * 80 + 30] = Tile.Rock;
    expect(codes(split)).toContain('unreachable');

    const poor = sample(); poor.mines = [];
    const issues = validateCustomMap(poor);
    expect(mapHasErrors(issues)).toBe(false);
    expect(issues.some((i) => i.code === 'noGold')).toBe(true);
  });

  it('the official maps pass the same rules', () => {
    for (const id of ['duel-valley', 'twin-rivers', 'crossroads', 'battle-arena', 'six-kingdoms']) {
      expect(validateCustomMap(officialMapSource(id)).filter((i) => i.error)).toEqual([]);
    }
  });

  it('thumbnails are small payloads of the same map', () => {
    const big = blankCustomMap('Huge', 400, 200);
    big.starts.push({ x: 20, y: 100, zone: 0 }, { x: 380, y: 100, zone: 1 });
    big.mines.push({ x: 399 - 3, y: 199 - 3, gold: 6000 });
    const t = decodeCustomSource(customMapThumb(big))!;
    expect(t.w).toBe(96); expect(t.h).toBe(48);
    expect(t.starts).toHaveLength(2);
    expect(t.mines[0].x).toBeLessThan(96);
    expect(t.tiles[0]).toBe(Tile.Rock);
    expect(t.tiles[48 * 24 + 24]).toBe(Tile.Grass);
  });

  it('a match on a custom map runs identically on two peers, bots and all', () => {
    const payload = encodeCustomMap(sample());
    const run = () => {
      const st = setupFor(payload);
      const sim = new Simulation(st, mapForSetup(st));
      const bots = createBots(sim);
      for (let t = 0; t < 20 * 90; t++) {
        const cmds = bots.flatMap((b) => b.think(sim));
        sim.step(cmds);
      }
      return sim;
    };
    const a = run(), b = run();
    expect(a.hash()).toBe(b.hash());
    expect(a.map.w).toBe(80); expect(a.map.h).toBe(48);
    expect(a.players.every((p) => p.castles === 1)).toBe(true);
    // the bots got going: more units than they started with
    expect(a.players.every((p) => p.unitsTrained > 0)).toBe(true);
  });

  it('mapForSetup falls back to the id for official maps and broken payloads', () => {
    expect(mapForSetup({ mapId: 'crossroads', seed: 1 }).name).toBe('Crossroads');
    expect(mapForSetup({ mapId: 'c:gone', seed: 1, map: 'garbage' }).id).toBe('duel-valley');
    expect(mapForSetup({ mapId: 'c:ok', seed: 1, map: encodeCustomMap(sample()) }).name).toBe('Test field');
  });
});
