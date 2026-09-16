import { UNITS, isHeavy } from '../data';
import { fp, fpLen } from '../fixed';
import { FINE_SHIFT } from '../path';
import type { Simulation } from '../sim';
import { Kind, Order, UnitType } from '../types';

const MAX_PUSH = fp(0.12);
const SEP_QUERY = fp(1.4);
const PUSHOUT_SPEED = fp(0.15);

/**
 * Movement resolution: apply requested motion, separate overlapping units,
 * keep units out of blocked cells and inside the map, track stuck counters.
 */
export function resolveMovement(sim: Simulation): void {
  const w = sim.world;
  const path = sim.path;
  const max = w.maxId;
  const mapW = sim.map.w, mapH = sim.map.h;
  const minX = fp(1), minY = fp(1), maxX = fp(mapW - 1) - 1, maxY = fp(mapH - 1) - 1;

  for (let id = 0; id < max; id++) {
    if (!w.alive[id] || w.kind[id] !== Kind.Unit) continue;
    const x = w.x[id], y = w.y[id];
    const rMe = UNITS[w.type[id] as UnitType].radius;
    const heavy = isHeavy(w.type[id] as UnitType);
    const holding = w.order[id] === Order.Hold;
    let nx = x, ny = y;
    if (sim.wantMove[id]) { nx += sim.mvx[id]; ny += sim.mvy[id]; }

    // --- separation
    let pushX = 0, pushY = 0;
    sim.grid.query(x, y, SEP_QUERY, (o) => {
      if (o === id || !w.alive[o] || w.kind[o] !== Kind.Unit) return;
      const ddx = x - w.x[o], ddy = y - w.y[o];
      const minD = fp(rMe + UNITS[w.type[o] as UnitType].radius);
      const dist = fpLen(ddx, ddy);
      if (dist >= minD) return;
      if (dist === 0) {
        // exactly stacked: split deterministically by id parity
        const s = ((id + o) & 1) === 0 ? 1 : -1;
        pushX += s * fp(0.06) * (id < o ? 1 : -1);
        pushY += fp(0.04) * (id < o ? 1 : -1);
        return;
      }
      const overlap = minD - dist;
      // moving units yield less than idle ones so crowds part for a marching group
      const factor = sim.wantMove[id] ? 0.45 : 0.6;
      pushX += Math.floor((ddx * overlap * factor) / dist);
      pushY += Math.floor((ddy * overlap * factor) / dist);
      // two movers heading into each other (or a mover that has been stuck for a while) also step
      // sideways - the same right-hand rule on both sides sends them to opposite sides, so they pass
      // instead of pushing head-on forever
      const headOn = sim.wantMove[id] && sim.wantMove[o] && sim.mvx[id] * sim.mvx[o] + sim.mvy[id] * sim.mvy[o] < 0;
      if (headOn || (sim.wantMove[id] && w.stuck[id] > 4)) {
        pushX += Math.floor((-ddy * overlap) / (dist * 2));
        pushY += Math.floor((ddx * overlap) / (dist * 2));
      }
    });
    if (holding) { pushX = pushX >> 2; pushY = pushY >> 2; }
    const pl = fpLen(pushX, pushY);
    if (pl > MAX_PUSH) { pushX = Math.floor((pushX * MAX_PUSH) / pl); pushY = Math.floor((pushY * MAX_PUSH) / pl); }
    nx += pushX; ny += pushY;

    // --- bounds
    if (nx < minX) nx = minX; else if (nx > maxX) nx = maxX;
    if (ny < minY) ny = minY; else if (ny > maxY) ny = maxY;

    // --- static collision (the unit's centre may not enter a blocked fine cell of its layer)
    const fx = x >> FINE_SHIFT, fy = y >> FINE_SHIFT;
    if (path.isBlockedFine(fx, fy, heavy)) {
      // pushed inside an obstacle (e.g. a building was finished around us): walk to the nearest free cell
      const cell = path.nearestFreeFine(fx, fy, 12, heavy);
      if (cell >= 0) {
        const tx = path.fineCenter(cell % path.w), ty = path.fineCenter(Math.floor(cell / path.w));
        const dx = tx - x, dy = ty - y, l = fpLen(dx, dy) || 1;
        const st = l < PUSHOUT_SPEED ? l : PUSHOUT_SPEED;
        nx = x + Math.floor((dx * st) / l); ny = y + Math.floor((dy * st) / l);
      }
    } else if (path.isBlockedFP(nx, ny, heavy)) {
      if (!path.isBlockedFP(nx, y, heavy)) ny = y;
      else if (!path.isBlockedFP(x, ny, heavy)) nx = x;
      else { nx = x; ny = y; }
    }

    // --- stuck tracking & facing
    const dx = nx - x, dy = ny - y;
    const movedLen = fpLen(dx, dy);
    if (sim.wantMove[id]) {
      if (movedLen < (sim.mvSpeed[id] >> 2)) { if (w.stuck[id] < 255) w.stuck[id]++; }
      else w.stuck[id] = 0;
    }
    if (movedLen > fp(0.01)) { w.moved[id] = 1; if (sim.wantMove[id]) { w.fx[id] = dx; w.fy[id] = dy; } }
    w.x[id] = nx; w.y[id] = ny;
  }
}
