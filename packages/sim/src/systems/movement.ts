import { UNITS } from '../data';
import { FP_ONE, FP_SHIFT, fp, fpLen } from '../fixed';
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
    });
    if (holding) { pushX = pushX >> 2; pushY = pushY >> 2; }
    const pl = fpLen(pushX, pushY);
    if (pl > MAX_PUSH) { pushX = Math.floor((pushX * MAX_PUSH) / pl); pushY = Math.floor((pushY * MAX_PUSH) / pl); }
    nx += pushX; ny += pushY;

    // --- bounds
    if (nx < minX) nx = minX; else if (nx > maxX) nx = maxX;
    if (ny < minY) ny = minY; else if (ny > maxY) ny = maxY;

    // --- static collision
    const curBlocked = path.isBlockedCell(x >> FP_SHIFT, y >> FP_SHIFT);
    if (curBlocked) {
      // pushed inside an obstacle (e.g. a building was placed on us): walk to the nearest free cell
      const cell = path.nearestFree(x >> FP_SHIFT, y >> FP_SHIFT, 6);
      if (cell >= 0) {
        const tx = ((cell % mapW) << FP_SHIFT) + (FP_ONE >> 1), ty = (Math.floor(cell / mapW) << FP_SHIFT) + (FP_ONE >> 1);
        const dx = tx - x, dy = ty - y, l = fpLen(dx, dy) || 1;
        const st = l < PUSHOUT_SPEED ? l : PUSHOUT_SPEED;
        nx = x + Math.floor((dx * st) / l); ny = y + Math.floor((dy * st) / l);
      }
    } else if (path.isBlockedCell(nx >> FP_SHIFT, ny >> FP_SHIFT)) {
      if (!path.isBlockedCell(nx >> FP_SHIFT, y >> FP_SHIFT)) ny = y;
      else if (!path.isBlockedCell(x >> FP_SHIFT, ny >> FP_SHIFT)) nx = x;
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
