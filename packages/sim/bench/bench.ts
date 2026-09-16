/**
 * Tick-budget benchmark: spawns ~600 units on the 6-player map and measures ms/tick.
 * Run: pnpm bench
 */
import { performance } from 'node:perf_hooks';
import { CommandType, MatchSetup, PLAYER_COLORS, Simulation, UnitType, createMap, fp, Kind } from '../src';

const setup: MatchSetup = {
  seed: 42, mapId: 'six-kingdoms', version: 1,
  players: Array.from({ length: 6 }, (_, i) => ({ slot: i, team: i, name: `P${i}`, isBot: false, color: PLAYER_COLORS[i] })),
};
const sim = new Simulation(setup, createMap(setup.mapId));
const w = sim.world;
// spawn 100 units per player around their start
for (let p = 0; p < 6; p++) {
  const s = sim.map.starts[p];
  for (let i = 0; i < 100; i++) {
    const type = i % 3 === 0 ? UnitType.Archer : i % 7 === 0 ? UnitType.Catapult : UnitType.Soldier;
    const ox = (i % 10) - 5, oy = Math.floor(i / 10) - 12;
    sim.spawnUnit(p, type, fp(s.x + ox + 0.5), fp(s.y + oy + 0.5));
  }
}
let units = 0;
for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit) units++;
console.log(`units: ${units}`);

// everyone attack-moves to the centre
const cx = fp(sim.map.w / 2), cy = fp(sim.map.h / 2);
const cmds = [];
for (let p = 0; p < 6; p++) {
  const ids: number[] = [];
  for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === p && w.type[id] !== UnitType.Worker) ids.push(id);
  cmds.push({ type: CommandType.AttackMove, player: p, ids, x: cx, y: cy });
}
sim.step(cmds);

const N = 1200;
let worst = 0, total = 0;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const a = performance.now();
  sim.step([]);
  const dt = performance.now() - a;
  total += dt; if (dt > worst) worst = dt;
  if (sim.gameOver) break;
}
const elapsed = performance.now() - t0;
let alive = 0;
for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit) alive++;
console.log(`ticks: ${sim.tick}  avg ${(total / sim.tick).toFixed(2)} ms/tick  worst ${worst.toFixed(2)} ms  total ${elapsed.toFixed(0)} ms  alive units at end: ${alive}`);
