import { describe, expect, it } from 'vitest';
import {
  Age, BuildingType, EventType, FP_SHIFT, Kind, MapData, MatchSetup, PLAYER_COLORS, Simulation, Tile, UnitType, UpgradeId,
  canPlaceBuilding, createMap, fp, fpLen,
} from '@rookfall/sim';
import { Bot, Strategy } from '../src';

/** a bot (slot 0) against a player who never gives an order (slot 1) */
function duel(seed: number, map?: MapData): { setup: MatchSetup; sim: Simulation } {
  const setup: MatchSetup = {
    seed, mapId: 'duel-valley', version: 1,
    players: [
      { slot: 0, team: 0, name: 'Bot', isBot: true, difficulty: 2, color: PLAYER_COLORS[0] },
      { slot: 1, team: 1, name: 'Idle', isBot: false, color: PLAYER_COLORS[1] },
    ],
  };
  return { setup, sim: new Simulation(setup, map ?? createMap('duel-valley', seed)) };
}

function castleOf(sim: Simulation, owner: number): number {
  const w = sim.world;
  for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.owner[id] === owner && w.kind[id] === Kind.Building && w.type[id] === BuildingType.Castle) return id;
  return -1;
}

/** units of `type` for `owner`, stood in open cells a few steps from its castle towards the map's middle */
function army(sim: Simulation, owner: number, type: UnitType, n: number): number[] {
  const w = sim.world, c = castleOf(sim, owner);
  const cx = w.x[c] >> FP_SHIFT, cy = w.y[c] >> FP_SHIFT;
  const dx = Math.sign((sim.map.w >> 1) - cx), ids: number[] = [];
  for (let k = 0; ids.length < n && k < 400; k++) {
    const x = cx + dx * (3 + (k % 5)), y = cy - 4 + ((k / 5) | 0) % 9;
    if (sim.path.isBlockedCell(x, y)) continue;
    ids.push(sim.spawnUnit(owner, type, fp(x + 0.5) + (k % 3) * 1000, fp(y + 0.5)));
  }
  return ids;
}

/** a complete tower for `owner` near (x, y), first free spot outwards */
function tower(sim: Simulation, owner: number, x: number, y: number): number {
  for (let r = 0; r < 6; r++) for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
    if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
    if (canPlaceBuilding(sim, BuildingType.Tower, x + ox, y + oy, -1)) return sim.spawnBuilding(owner, BuildingType.Tower, x + ox, y + oy, true);
  }
  return -1;
}

/** let the bot see what the other side has built, as a scout walking round it would have */
function reveal(sim: Simulation, bot: Bot, owner: number): void {
  const w = sim.world;
  for (let id = 0; id < w.maxId; id++) {
    if (!w.alive[id] || w.owner[id] !== owner || w.kind[id] !== Kind.Building) continue;
    bot.known.set(id, { id, gen: w.gen[id], x: w.x[id], y: w.y[id], type: w.type[id], owner, lastSeen: sim.tick });
  }
}

describe('tactics', () => {
  it('burns its way through a forest that closes the enemy off, and gets to the castle', () => {
    // the idle player's castle inside an unbroken ring of forest: no way in on foot at all
    const seed = 3;
    const base = createMap('duel-valley', seed);
    const probe = duel(seed, base).sim;
    const home = probe.players[1];
    const tiles = base.tiles.slice();
    for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) {
      const dx = x - home.startX, dy = y - home.startY, d2 = dx * dx + dy * dy;
      if (d2 >= 9 * 9 && d2 <= 11 * 11 && tiles[y * base.w + x] !== Tile.Rock && tiles[y * base.w + x] !== Tile.Water) tiles[y * base.w + x] = Tile.Forest;
    }
    const { sim } = duel(seed, { ...base, tiles });
    const bot = new Bot(0, 2, seed, Strategy.Rush);
    // a stone-age army with the engines to burn with, and the range to out-throw the castle
    sim.players[0].age = Age.Second;
    sim.players[0].upgrades[UpgradeId.Range] = 1;
    army(sim, 0, UnitType.Catapult, 3);
    army(sim, 0, UnitType.Soldier, 12);
    const enemy = castleOf(sim, 1);
    const ex = sim.world.x[enemy], ey = sim.world.y[enemy];
    let burnt = 0, inside = false;
    for (let t = 0; t < 20 * 60 * 6 && !sim.gameOver; t++) {
      sim.step(bot.think(sim));
      for (const e of sim.events) if (e.type === EventType.ForestBurnt && fpLen(e.x - ex, e.y - ey) < fp(12)) burnt++;
      if (!inside && t % 20 === 0) {
        const w = sim.world;
        for (let id = 0; id < w.maxId; id++) {
          if (w.alive[id] && w.owner[id] === 0 && w.kind[id] === Kind.Unit && w.type[id] !== UnitType.Worker && fpLen(w.x[id] - ex, w.y[id] - ey) < fp(8)) { inside = true; break; }
        }
      }
    }
    expect(burnt).toBeGreaterThan(0);
    expect(inside).toBe(true);
    // and it does what it came for: the keep is down or badly hurt
    const w = sim.world;
    expect(!w.alive[enemy] || w.kind[enemy] !== Kind.Building || w.hp[enemy] * 2 < w.maxHp[enemy]).toBe(true);
  }, 20000);

  it('sends a party round the side of a base whose front is covered by towers', () => {
    const seed = 5;
    const { sim } = duel(seed);
    const bot = new Bot(0, 2, seed, Strategy.Rush);
    const w = sim.world;
    const enemy = castleOf(sim, 1), mine = castleOf(sim, 0);
    const ex = w.x[enemy] >> FP_SHIFT, ey = w.y[enemy] >> FP_SHIFT;
    const fx = Math.sign((w.x[mine] >> FP_SHIFT) - ex);
    // four towers on the side facing the bot
    for (const oy of [-4, -1, 2, 5]) tower(sim, 1, ex + fx * 5, ey + oy);
    reveal(sim, bot, 1);
    army(sim, 0, UnitType.Soldier, 18);
    army(sim, 0, UnitType.Archer, 10);
    type Sq = { units: number[]; stage: { x: number; y: number } | null; route: { cells: number[] } | null };
    let op: { main: Sq; flank: Sq | null } | null = null;
    for (let t = 0; t < 20 * 60 && !op; t++) {
      sim.step(bot.think(sim));
      op = (bot.commander as unknown as { op: typeof op }).op;
    }
    expect(op).not.toBeNull();
    expect(op!.flank).not.toBeNull();
    // the two come in from different sides: at least sixty degrees apart as seen from the castle
    const end = (sq: Sq) => { const c = sq.route!.cells[sq.route!.cells.length - 1]; return { x: (c % sim.map.w) - ex, y: ((c / sim.map.w) | 0) - ey }; };
    const a = end(op!.main), b = end(op!.flank!);
    const cos = (a.x * b.x + a.y * b.y) / (Math.sqrt(a.x * a.x + a.y * a.y) * Math.sqrt(b.x * b.x + b.y * b.y));
    expect(cos).toBeLessThan(0.5);
    // and the flank's way there keeps out of the towers' reach
    const towers: number[] = [];
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.owner[id] === 1 && w.kind[id] === Kind.Building && w.type[id] === BuildingType.Tower) towers.push(id);
    let exposed = 0;
    for (const c of op!.flank!.route!.cells) {
      const x = fp((c % sim.map.w) + 0.5), y = fp(((c / sim.map.w) | 0) + 0.5);
      if (towers.some((tw) => fpLen(w.x[tw] - x, w.y[tw] - y) < fp(8))) exposed++;
    }
    expect(exposed).toBe(0);
  }, 20000);

  it('does not walk a small army into a fortified base', () => {
    const seed = 7;
    const { sim } = duel(seed);
    const bot = new Bot(0, 1, seed, Strategy.Rush);
    const w = sim.world;
    const enemy = castleOf(sim, 1), mine = castleOf(sim, 0);
    const ex = w.x[enemy] >> FP_SHIFT, ey = w.y[enemy] >> FP_SHIFT;
    const fx = Math.sign((w.x[mine] >> FP_SHIFT) - ex);
    const towers: number[] = [];
    for (const [ox, oy] of [[5, -4], [5, 0], [5, 4], [8, -2], [8, 2], [2, 6]]) towers.push(tower(sim, 1, ex + fx * ox, ey + oy));
    reveal(sim, bot, 1);
    army(sim, 0, UnitType.Soldier, 12);
    let underGuns = 0;
    for (let t = 0; t < 20 * 60 * 3 && !sim.gameOver; t++) {
      sim.step(bot.think(sim));
      for (const e of sim.events) {
        if (e.type !== EventType.Death || e.owner !== 0 || e.b !== 1) continue;
        if (towers.some((tw) => w.alive[tw] && fpLen(w.x[tw] - e.x, w.y[tw] - e.y) < fp(9))) underGuns++;
      }
    }
    // twelve men against six towers and a castle is a massacre: the bot keeps them home and builds up instead
    expect(underGuns).toBeLessThanOrEqual(1);
    expect(sim.players[0].unitsLost).toBeLessThanOrEqual(2);
  }, 20000);
});
