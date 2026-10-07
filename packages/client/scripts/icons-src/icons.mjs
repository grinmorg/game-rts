#!/usr/bin/env node
// "Условные знаки" — the atlas icon family, drawn as code. Writes one <name>.svg per icon into src/ui/icons/svg
// (or the folder given as the first argument); then `node scripts/build-icons.mjs` turns that folder into the registry.
//
//   node packages/client/scripts/icons-src/icons.mjs [outDir] [--only=name,name]
//
// Rules of the family (keep them when adding a sign):
// - 24-unit grid, live area 2..22, solid ink-stamp silhouettes in currentColor, never an outline drawing;
// - cuts 1.2–1.5 units (≈1 px at 16 px), smallest solid feature 2 units;
// - buildings and settlements stand on the shared ground line y 20..22, so a row of them reads as one legend;
// - an icon is a list of layers; a layer is solid shapes minus its cuts (an SVG mask, black = cut), optionally moved
//   as a whole by a transform. `#K` in markup is the ink colour (currentColor), for stroked solids.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const OUT = resolve(args.find((a) => !a.startsWith('--')) ?? join(pkg, 'src/ui/icons/svg'));
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');

// ------------------------------------------------------------------ helpers
const n = (v) => +v.toFixed(2);
const L = (s, c = '', t = '') => ({ s, c, t });
const rot = (deg, inner, cx = 12, cy = 12) => `<g transform="rotate(${deg} ${cx} ${cy})">${inner}</g>`;
/** a stroked solid (ink) */
const line = (d, w = 2, cap = 'round') => `<path d="${d}" fill="none" stroke="#K" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="round"/>`;
/** a filled polygon with rounded corners: the stroke adds w/2 all round */
const rp = (d, w = 1.2) => `<path d="${d}" stroke="#K" stroke-width="${w}" stroke-linejoin="round"/>`;
/** a stroked cut (inside a mask) */
const cut = (d, w = 1.3, cap = 'round', join = 'round') => `<path d="${d}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="${join}"/>`;
const ring = (cx, cy, r, w = 1.3) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000" stroke-width="${w}"/>`;
const poly = (pts) => 'M' + pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L') + 'z';
const MIRROR_X = 'matrix(-1 0 0 1 24 0)';
const MIRROR_Y = 'matrix(1 0 0 -1 0 24)';

const GROUND = '<rect x="1.5" y="20" width="21" height="2" rx=".6"/>';
const ground = (x0, x1) => `<rect x="${n(x0)}" y="20" width="${n(x1 - x0)}" height="2" rx=".6"/>`;

// one sword, point up, centred on the grid
const SWORD = '<path d="M10.8 15.2V4.4L12 2l1.2 2.4v10.8z"/><rect x="7.6" y="15" width="8.8" height="2" rx=".6"/><rect x="11.05" y="16.6" width="1.9" height="3.6"/><circle cx="12" cy="21.3" r="1.45"/>';
const SWORD_CUT = '<path d="M10.8 15.2V4.4L12 2l1.2 2.4v10.8z M7.6 15h8.8v2H7.6z M11.05 16.6h1.9v3.6h-1.9z" fill="none" stroke="#000" stroke-width="1.5"/><circle cx="12" cy="21.3" r="1.45" fill="none" stroke="#000" stroke-width="1.5"/>';
const FIG = (cx, cy, r, bx, bw, by, bh) => `<circle cx="${cx}" cy="${cy}" r="${r}"/><path d="M${bx} ${by + bh}v-${bh * 0.45}a${bw / 2} ${bh * 0.62} 0 0 1 ${bw} 0v${bh * 0.45}z"/>`;

/** octagon with flat sides, apothem a */
const octagon = (cx, cy, a) => { const b = a * Math.tan(Math.PI / 8); return poly([[cx - b, cy - a], [cx + b, cy - a], [cx + a, cy - b], [cx + a, cy + b], [cx + b, cy + a], [cx - b, cy + a], [cx - a, cy + b], [cx - a, cy - b]]); };
/** four-point star with concave sides; k pulls the waist towards the centre */
const sparkle = (cx, cy, r, k = 0.2) => { const c = r * k; return `M${n(cx)} ${n(cy - r)}Q${n(cx + c)} ${n(cy - c)} ${n(cx + r)} ${n(cy)}Q${n(cx + c)} ${n(cy + c)} ${n(cx)} ${n(cy + r)}Q${n(cx - c)} ${n(cy + c)} ${n(cx - r)} ${n(cy)}Q${n(cx - c)} ${n(cy - c)} ${n(cx)} ${n(cy - r)}z`; };
/** heart from two circles (radius r, centres d off the axis at height cy) and a tip */
function heart(cx, cy, r, d, tipY) {
  const P = [cx, tipY];
  const tangent = (c, side) => {
    const vx = P[0] - c[0], vy = P[1] - c[1], D = Math.hypot(vx, vy), a = Math.acos(r / D), base = Math.atan2(vy, vx);
    const cands = [base + a, base - a].map((t) => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
    return cands.sort((p, q) => side * (q[0] - p[0]))[0]; // side -1: leftmost, +1: rightmost
  };
  const cl = [cx - d, cy], cr = [cx + d, cy];
  const tl = tangent(cl, -1), trr = tangent(cr, 1); // outermost tangent points
  const cusp = [cx, cy - Math.sqrt(r * r - d * d)];
  const large = (c, p0, p1) => { let s = Math.atan2(p1[1] - c[1], p1[0] - c[0]) - Math.atan2(p0[1] - c[1], p0[0] - c[0]); while (s < 0) s += 2 * Math.PI; return s > Math.PI ? 1 : 0; };
  return `M${n(P[0])} ${n(P[1])}L${n(tl[0])} ${n(tl[1])}A${r} ${r} 0 ${large(cl, tl, cusp)} 1 ${n(cusp[0])} ${n(cusp[1])}A${r} ${r} 0 ${large(cr, cusp, trr)} 1 ${n(trr[0])} ${n(trr[1])}z`;
}
/** heater shield: flat top, straight sides, curved to a point */
const heater = (x, y, w, h) => `M${n(x)} ${n(y)}h${n(w)}v${n(h * 0.42)}q0 ${n(h * 0.4)}-${n(w / 2)} ${n(h * 0.58)}q-${n(w / 2)}-${n(h * 0.18)}-${n(w / 2)}-${n(h * 0.58)}z`;
/** a gable hut or a tent-roofed tower (шатёр) on the ground (y 20): walls x..x+w up to `wall`, apex at `top` */
const gable = (x, w, wall, top, eave = 0) => poly([[x, 20], [x, wall], [x - eave, wall], [x + w / 2, top], [x + w + eave, wall], [x + w, wall], [x + w, 20]]);
/** onion dome sitting on (cx, base), height h, half-width r */
const onion = (cx, base, r, h) => `M${n(cx)} ${n(base - h)}C${n(cx + r * 0.2)} ${n(base - h * 0.72)} ${n(cx + r * 1.15)} ${n(base - h * 0.62)} ${n(cx + r)} ${n(base - h * 0.22)}Q${n(cx + r * 0.9)} ${n(base)} ${n(cx)} ${n(base)}Q${n(cx - r * 0.9)} ${n(base)} ${n(cx - r)} ${n(base - h * 0.22)}C${n(cx - r * 1.15)} ${n(base - h * 0.62)} ${n(cx - r * 0.2)} ${n(base - h * 0.72)} ${n(cx)} ${n(base - h)}z`;
/** crown: band at y..y+bh, k points up to `top` with balls */
function crown(x0, x1, y, bh, top, k = 3, ball = 1.1) {
  const w = x1 - x0, pts = [[x0, y + bh], [x0, top + ball]];
  for (let i = 0; i < k; i++) {
    const px = x0 + (w * i) / (k - 1);
    if (i > 0) pts.push([px - w / (k - 1) / 2, y - (y - top) * 0.25], [px, top + ball]);
  }
  pts.push([x1, y + bh]);
  const balls = Array.from({ length: k }, (_, i) => `<circle cx="${n(x0 + (w * i) / (k - 1))}" cy="${n(top + ball)}" r="${ball}"/>`).join('');
  return `<path d="${poly(pts)}"/>` + balls;
}

// pennant used by the symmetry signs: pole + flag, in the top-left quadrant
const SYM_PEN = '<rect x="2.6" y="2.6" width="2.2" height="8" rx=".5"/><path d="M4.8 2.6l5.4 2.8-5.4 2.8z"/>';
const SYM_AXIS_V = [2, 6.2, 10.4, 14.6, 18.8].map((y) => `<rect x="11.3" y="${y}" width="1.4" height="3.2" rx=".3"/>`).join('');
const SYM_AXIS_H = [2, 6.2, 10.4, 14.6, 18.8].map((x) => `<rect x="${x}" y="11.3" width="3.2" height="1.4" rx=".3"/>`).join('');
const SYM_PIVOT = '<circle cx="12" cy="12" r="1.8"/>';
const symPen = (t) => (t ? `<g transform="${t}">${SYM_PEN}</g>` : SYM_PEN);

// ------------------------------------------------------------------ the set
const icons = {
  // ---------- resources & status
  gold: [
    L('<circle cx="9" cy="9" r="6.8"/>', '<circle cx="14.6" cy="14.6" r="8.5"/>'),
    L('<circle cx="14.6" cy="14.6" r="7.2"/>', '<circle cx="14.6" cy="14.6" r="5.5" fill="none" stroke="#000" stroke-width="1.3"/><path transform="translate(14.6 14.6)" d="M0 -3.6 1 -1 3.6 0 1 1 0 3.6 -1 1 -3.6 0 -1 -1z"/>'),
  ],
  population: [
    L(FIG(8.3, 7.4, 3.1, 2.4, 11.6, 11.2, 8.8), '<circle cx="15.4" cy="8.9" r="4.4" fill="#000"/><path d="M7.6 22.4v-3.6a7.8 6.6 0 0 1 15.6 0v3.6z" fill="#000"/>'),
    L(FIG(15.4, 8.9, 3.5, 8.8, 13.2, 12.6, 8.9)),
  ],
  'idle-worker': [
    L('<circle cx="10.6" cy="11.4" r="3.3"/><path d="M3 21.6v-2.2a7.6 5.8 0 0 1 15.2 0v2.2z"/><ellipse cx="10.6" cy="8" rx="7.2" ry="1.55"/><path d="M7.4 8.2 8.1 4.1q2.5-1.2 5 0l.7 4.1z"/>' +
      line('M16.6 2.6h4.6l-4.6 4.8h4.6', 1.7, 'square'), '<path d="M3.4 9.6h14.4" stroke="#000" stroke-width="1.1"/>'),
  ],
  'age-1': [
    L('<rect x="3.2" y="2" width="17.6" height="2" rx=".6"/><path d="M5.2 4h13.6v17L12 17.4 5.2 21z"/>', '<rect x="11" y="7" width="2" height="7.8"/><rect x="9.2" y="6.4" width="5.6" height="1.6"/><rect x="9.2" y="14.2" width="5.6" height="1.6"/>'),
  ],
  'age-2': [
    L('<rect x="3.2" y="2" width="17.6" height="2" rx=".6"/><path d="M5.2 4h13.6v17L12 17.4 5.2 21z"/>', '<rect x="8.9" y="7" width="2" height="7.8"/><rect x="13.1" y="7" width="2" height="7.8"/><rect x="7.6" y="6.4" width="8.8" height="1.6"/><rect x="7.6" y="14.2" width="8.8" height="1.6"/>'),
  ],
  // redrawn 2026-10: the age banner with a bold arrow cut, no tiny cap above it
  'age-up': [
    L('<rect x="3.2" y="2" width="17.6" height="2" rx=".6"/><path d="M5.2 4h13.6v17L12 17.4 5.2 21z"/>', '<path d="M12 6.4l4.6 4.8h-3.4v4.6h-2.4v-4.6H7.4z"/>'),
  ],
  timer: [
    L('<rect x="4.5" y="2" width="15" height="2.4" rx=".6"/><rect x="4.5" y="19.6" width="15" height="2.4" rx=".6"/><path d="M6.4 4.2h11.2c0 4.3-3.5 6.3-4.3 7.8.8 1.5 4.3 3.5 4.3 7.8H6.4c0-4.3 3.5-6.3 4.3-7.8-.8-1.5-4.3-3.5-4.3-7.8z"/>',
      '<path d="M8.5 5.8h7c-.4 2.6-2.6 3.9-3.5 5.2-.9-1.3-3.1-2.6-3.5-5.2z"/><path d="M12 12.9v3" stroke="#000" stroke-width=".9"/>'),
  ],
  chat: [
    L('<path d="M2.8 5.6A2.6 2.6 0 0 1 5.4 3h13.2a2.6 2.6 0 0 1 2.6 2.6v8.6a2.6 2.6 0 0 1-2.6 2.6h-7.4L6 21v-4.2h-.6a2.6 2.6 0 0 1-2.6-2.6z"/>',
      '<rect x="6.2" y="7.2" width="11.6" height="1.6" rx=".5"/><rect x="6.2" y="11" width="7.6" height="1.6" rx=".5"/>'),
  ],
  // ---------- system
  fullscreen: [L('<path d="M3 9.4V3h6.4v2.3H5.3v4.1zM14.6 3H21v6.4h-2.3V5.3h-4.1zM3 14.6V21h6.4v-2.3H5.3v-4.1zM21 14.6V21h-6.4v-2.3h4.1v-4.1z"/>')],
  menu: [L('<rect x="3" y="4.6" width="18" height="2.6" rx=".7"/><rect x="3" y="10.7" width="18" height="2.6" rx=".7"/><rect x="3" y="16.8" width="18" height="2.6" rx=".7"/>')],
  settings: [
    L('<circle cx="12" cy="12" r="7"/>' + [0, 45, 90, 135, 180, 225, 270, 315].map((a) => rot(a, '<rect x="10.3" y="1.6" width="3.4" height="4.6" rx=".6"/>')).join(''), '<circle cx="12" cy="12" r="3"/>'),
  ],
  back: [L('<path d="M2.6 12 10.4 4.4v4.5h11l-2.6 3.1 2.6 3.1h-11v4.5z"/>')],
  close: [L(rot(45, '<rect x="10.9" y="2.6" width="2.2" height="18.8" rx=".6"/>') + rot(-45, '<rect x="10.9" y="2.6" width="2.2" height="18.8" rx=".6"/>'))],
  check: [L('<path d="M2.8 12.6 5.1 10.3l4.6 4.6 9.2-9.2 2.3 2.3L9.7 19.5z"/>')],
  cross: [L(rot(45, '<rect x="10.5" y="3.2" width="3" height="17.6" rx=".8"/>') + rot(-45, '<rect x="10.5" y="3.2" width="3" height="17.6" rx=".8"/>'))],
  lock: [L(line('M8 11V7.6a4 4 0 0 1 8 0V11', 2.4, 'butt') + '<rect x="4.8" y="10.4" width="14.4" height="11.2" rx="1.4"/>', '<circle cx="12" cy="14.8" r="1.7"/><rect x="11.25" y="15" width="1.5" height="3.8" rx=".5"/>')],
  link: [L(rot(-45, line('M6.6 9.2h3.2a2.8 2.8 0 0 1 0 5.6H6.6a2.8 2.8 0 0 1 0-5.6zM14.2 9.2h3.2a2.8 2.8 0 0 1 0 5.6h-3.2a2.8 2.8 0 0 1 0-5.6z', 2.3) + '<rect x="9.6" y="10.9" width="4.8" height="2.2" rx="1.1"/>'))],
  chart: [L('<rect x="2.6" y="2.6" width="2.2" height="18.8" rx=".5"/><rect x="2.6" y="19.2" width="18.8" height="2.2" rx=".5"/><path d="M6.8 17.4v-3.8l3.8-5 3.3 3 4.4-6.4 2.7 2.2v10z"/>')],
  replay: [
    L(line('M6.1 7.2A7.8 7.8 0 1 1 4.2 13', 2.3, 'butt') + '<path d="M2.4 3.6 9 4.6 4.4 9.6z"/><path d="M10 8.3l6 3.7-6 3.7z"/>'),
  ],
  play: [L('<path d="M6.5 3.6a1 1 0 0 1 1.5-.86l12.6 8.4a1 1 0 0 1 0 1.72L8 21.26A1 1 0 0 1 6.5 20.4z"/>')],
  pause: [L('<rect x="5.4" y="4" width="4.6" height="16" rx=".8"/><rect x="14" y="4" width="4.6" height="16" rx=".8"/>')],
  info: [L('<circle cx="12" cy="12" r="10"/>', '<circle cx="12.4" cy="7" r="1.6"/><path d="M9.6 10.2h3.9v6.5h1.6v1.7H9.6v-1.7h1.6v-4.8H9.6z"/>')],
  account: [L(FIG(12, 7.6, 4.1, 3.8, 16.4, 12.6, 9.2))],
  ranked: [L([3, 8.2, 13.4].map((y) => `<path d="M4 ${y + 5}L12 ${y}l8 ${5}v2.4l-8-5-8 5z"/>`).join(''))],
  'vs-ai': [
    L(rot(45, SWORD), rot(-45, SWORD_CUT)),
    L(rot(-45, SWORD)),
  ],
  multiplayer: [
    L('<circle cx="12" cy="12" r="9.8"/>', '<ellipse cx="12" cy="12" rx="4.2" ry="9.8" fill="none" stroke="#000" stroke-width="1.3"/><path d="M12 2v20M2.4 12h19.2M3.8 7.4h16.4M3.8 16.6h16.4" stroke="#000" stroke-width="1.3"/>'),
  ],
  'map-editor': [
    L('<circle cx="12" cy="5" r="3"/><rect x="11.1" y="1" width="1.8" height="2.4" rx=".4"/>' + line('M10.9 7.4 4.6 21.6', 2.3, 'butt') + line('M13.1 7.4l4.4 10', 2.3, 'butt') + '<path d="M16.2 16.6l2.7-1.2 1.9 4.2-1.5 2.6-.4-.2-1.3-1.2z"/>',
      '<circle cx="12" cy="5" r="1.1"/>'),
  ],
  // ---------- army commands
  // redrawn 2026-10: a sword whose point is a broad arrowhead, thrust towards the upper right
  'attack-move': [
    L(rot(45, '<path d="M7 9.4 12 1.6l5 7.8-5-1.8z"/><rect x="10.8" y="7" width="2.4" height="8.4"/><rect x="7.4" y="15" width="9.2" height="2.2" rx=".6"/><rect x="11" y="16.6" width="2" height="3.4"/><circle cx="12" cy="21.2" r="1.6"/>')),
  ],
  stop: [L('<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1.6"/>')],
  hold: [L('<path d="M4.4 3.4h15.2v7.8c0 5-3.6 8.6-7.6 10.6-4-2-7.6-5.6-7.6-10.6z"/>', '<path d="M12.7 5.6h4.7v5.6c0 3.6-2.2 6.4-4.7 8z"/>')],
  patrol: [L('<rect x="3" y="6.5" width="3.6" height="2.4" rx=".5"/><rect x="8" y="6.5" width="6.4" height="2.4" rx=".5"/><path d="M14 3.2l6.4 4.5L14 12.2z"/><rect x="17.4" y="15.1" width="3.6" height="2.4" rx=".5"/><rect x="9.6" y="15.1" width="6.4" height="2.4" rx=".5"/><path d="M10 11.8l-6.4 4.5 6.4 4.5z"/>')],
  build: [L(rot(45, '<rect x="10.8" y="8.6" width="2.4" height="13.4" rx=".8"/><path d="M6 3.4h10.2l2.4 1.6v3.2H6z"/>'))],
  // redrawn 2026-10: the house split down a crack, its right half falling away
  dismantle: [
    L(GROUND),
    L('<path d="M2.4 11 12 3.2l9.6 7.8z"/><rect x="4.8" y="12.2" width="14.4" height="8.8"/>', '<path d="M12.6 0 10.6 5.2l2.4 3.4-2.6 4 2.6 3.6-1.8 4.4L12 24H24V0z"/>'),
    L('<path d="M2.4 11 12 3.2l9.6 7.8z"/><rect x="4.8" y="12.2" width="14.4" height="8.8"/>', '<path d="M13.9 0 11.9 5.2l2.4 3.4-2.6 4 2.6 3.6-1.8 4.4.8 3.4H0V0z"/>', 'rotate(9 19.2 20)'),
  ],
  rally: [L('<rect x="5.4" y="2.4" width="2" height="17.4" rx=".6"/><path d="M7.4 3h12.2l-2.8 3.9 2.8 3.9H7.4z"/><ellipse cx="6.4" cy="20.4" rx="4.4" ry="1.6"/>')],
  eject: [
    L('<path d="M2.6 21.4V5a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2v16.4z"/>', '<rect x="5" y="5.4" width="6.4" height="16.4" rx=".6"/><path d="M8.6 9.4h8.2v-3.7l6.6 6.3-6.6 6.3v-3.7H8.6z" stroke="#000" stroke-width="2.6" stroke-linejoin="round"/>'),
    L('<path d="M8.6 10.8h8.2V7.1l5.6 4.9-5.6 4.9v-3.7H8.6z"/>'),
  ],
  cancel: [L('<circle cx="12" cy="12" r="10"/>', rot(45, '<rect x="10.9" y="5.6" width="2.2" height="12.8" rx=".5"/>') + rot(-45, '<rect x="10.9" y="5.6" width="2.2" height="12.8" rx=".5"/>'))],
  militia: [
    L(rot(38, '<rect x="11" y="9.6" width="2" height="13.6" rx=".7"/><path d="M6.6 8.4a1 1 0 0 1 1-1h8.8a1 1 0 0 1 1 1v2.4H6.6z"/><path d="M6.6 8.4V3.6l.9-2 .9 2v4.8zM11.1 8.4V2.8l.9-2 .9 2v5.6zM15.6 8.4V3.6l.9-2 .9 2v4.8z"/>')),
  ],
  // ---------- buildings (all on the ground line)
  castle: [
    L(GROUND + '<rect x="2.8" y="7" width="5.4" height="14"/><rect x="2.8" y="4.6" width="1.7" height="3"/><rect x="6.5" y="4.6" width="1.7" height="3"/>' +
      '<rect x="15.8" y="7" width="5.4" height="14"/><rect x="15.8" y="4.6" width="1.7" height="3"/><rect x="19.5" y="4.6" width="1.7" height="3"/>' +
      '<rect x="8" y="10.4" width="8" height="10.6"/><rect x="8" y="8.4" width="1.6" height="2.4"/><rect x="11.2" y="8.4" width="1.6" height="2.4"/><rect x="14.4" y="8.4" width="1.6" height="2.4"/>',
      '<path d="M10.2 20v-3.6a1.8 1.8 0 0 1 3.6 0V20z"/><rect x="4.75" y="10.2" width="1.5" height="3.2"/><rect x="17.75" y="10.2" width="1.5" height="3.2"/>'),
  ],
  house: [L(GROUND + '<path d="M2.4 11 12 3.2l9.6 7.8z"/><rect x="15.4" y="4.2" width="2.4" height="5"/><rect x="4.8" y="12.2" width="14.4" height="8.8"/>', '<rect x="10.5" y="14.6" width="3" height="5.4"/>')],
  barracks: [
    L(GROUND + '<path d="M1.6 11.8 5 7.6h14l3.4 4.2z"/><rect x="2.6" y="13" width="18.8" height="8"/><rect x="11.2" y="1.4" width="1.6" height="6.6"/><path d="M12.8 1.8l6 1.7-6 1.7z"/>',
      '<rect x="10" y="15.4" width="4" height="4.6"/><rect x="4.8" y="15.2" width="2.8" height="2.2"/><rect x="16.4" y="15.2" width="2.8" height="2.2"/>'),
  ],
  forge: [
    L(GROUND + '<path d="M2.4 7.4 7.6 6.8h13v3.4h-2.8q-2.1.4-2.4 2.6v1.8q2.4.4 4.2 2.4V20H6.2v-3q1.8-2 4.4-2.4v-1.8q-.3-2.2-2.4-2.6Q4.6 9.8 2.4 7.4z"/>',
      '<path d="M10.2 20q1.9-2.8 3.8-2.8t3.8 2.8z"/>'),
  ],
  tower: [
    L(GROUND + '<path d="M8.6 21 9.2 8.6h5.6l.6 12.4z"/><rect x="6.4" y="6" width="11.2" height="3" rx=".5"/><rect x="6.4" y="3" width="2.2" height="3.6"/><rect x="10.9" y="3" width="2.2" height="3.6"/><rect x="15.4" y="3" width="2.2" height="3.6"/>',
      '<rect x="11.3" y="10.6" width="1.4" height="3.6"/><path d="M10.6 20v-1.8a1.4 1.4 0 0 1 2.8 0V20z"/>'),
  ],
  fence: [L(GROUND + [2.6, 7.6, 12.6, 17.6].map((x) => `<path d="M${x} 20V7.6l1.9-2.8 1.9 2.8V20z"/>`).join('') + '<rect x="1.6" y="10" width="20.8" height="2.2" rx=".5"/><rect x="1.6" y="15" width="20.8" height="2.2" rx=".5"/>')],
  mine: [
    L(GROUND + '<path d="M2.4 21q1-9.6 9.6-10.6 8.6 1 9.6 10.6z"/>', '<path d="M8.6 20v-4.4h6.8V20h-1.4v-3h-4v3z"/>'),
    L(rot(45, '<rect x="11.2" y="2.6" width="1.6" height="8.2" rx=".5"/><rect x="9" y="1.2" width="6" height="2.6" rx=".5"/>', 12, 6) + rot(-45, '<rect x="11.2" y="2.6" width="1.6" height="8.2" rx=".5"/><path d="M8.6 2.6 12 1.2l3.4 1.4v1.4H8.6z"/>', 12, 6)),
  ],
  // ---------- extra signs used by the mockups
  sword: [L(rot(45, SWORD))],
  range: [L(line('M6.4 3.2q11.6 8.8 0 17.6', 2.6, 'butt') + line('M6.4 3.4v17.2', 1.2, 'butt') + line('M3.4 12h13.4', 2, 'butt') + '<path d="M15.8 8.8 21.6 12l-5.8 3.2z"/><path d="M2.4 9.8l3 2.2-3 2.2z"/>')],
  // redrawn 2026-10: a great helm with a T visor instead of the small crested helmet
  armor: [
    L('<path d="M4.2 21.4V9.6C4.2 5.2 7.6 2.4 12 2.4s7.8 2.8 7.8 7.2v11.8z"/>',
      '<rect x="5.8" y="9.6" width="12.4" height="1.8" rx=".3"/><rect x="11.1" y="9.6" width="1.8" height="7.4" rx=".3"/>' + cut('M12 2v5.4', 1.2, 'butt')),
  ],
  speed: [L('<path d="M7.8 3h6.4v9.6l5.4 3.2a2 2 0 0 1 1 1.7V20H4.6v-3.4l3.2-1.6z"/>', '<path d="M4.6 18.2h16.2" stroke="#000" stroke-width="1.2"/>')],
  emblem: [L('<path d="M12 1.6 13.9 10.1 22.4 12 13.9 13.9 12 22.4 10.1 13.9 1.6 12 10.1 10.1z"/><path d="M12 12 18.3 5.7 14.6 12z M12 12 18.3 18.3 12 14.6z M12 12 5.7 18.3 9.4 12z M12 12 5.7 5.7 12 9.4z"/>', '<circle cx="12" cy="12" r="1.5"/>')],
  pin: [L('<circle cx="12" cy="7.4" r="5.2"/><path d="M11 12h2l-.6 10h-.8z"/>', '<circle cx="10.4" cy="5.8" r="1.4"/>')],
  dice: [L('<rect x="3" y="3" width="18" height="18" rx="3"/>', '<circle cx="7.8" cy="7.8" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="16.2" cy="16.2" r="1.7"/><circle cx="16.2" cy="7.8" r="1.7"/><circle cx="7.8" cy="16.2" r="1.7"/>')],
  plus: [L('<rect x="10.8" y="3.6" width="2.4" height="16.8" rx=".6"/><rect x="3.6" y="10.8" width="16.8" height="2.4" rx=".6"/>')],
  pencil: [L(rot(45, '<rect x="9.8" y="5" width="4.4" height="12.4"/><path d="M9.8 17.4h4.4L12 22z"/><rect x="9.8" y="1.6" width="4.4" height="2.4" rx=".6"/>'))],
  save: [L('<path d="M10.8 2.6h2.4v9.2h3.4L12 16.6l-4.6-4.8h3.4z"/><path d="M3 14.6h2.4v4.2h13.2v-4.2H21v6.6H3z"/>')],
  flag: [L('<rect x="4.6" y="2.4" width="2" height="19.2" rx=".6"/><path d="M6.6 3.2h13l-2.8 4 2.8 4h-13z"/>', '<path d="M8.6 5.2h7.4l-1.4 2 1.4 2H8.6z"/>')],
  trash: [L('<rect x="3.6" y="4.6" width="16.8" height="2.4" rx=".6"/><path d="M9.4 4.6V2.8h5.2v1.8z"/><path d="M5.4 8.2h13.2l-1.2 13.2H6.6z"/>', '<rect x="8.6" y="10.4" width="1.6" height="8.6" rx=".5"/><rect x="13.8" y="10.4" width="1.6" height="8.6" rx=".5"/>')],
  eye: [L('<path d="M1.6 12Q6.4 4.6 12 4.6T22.4 12Q17.6 19.4 12 19.4T1.6 12z"/>', '<circle cx="12" cy="12" r="4.4"/>'), L('<circle cx="12" cy="12" r="2.2"/>')],
  chevron: [L('<path d="M5 8.4 12 15.4l7-7 1.8 1.8-8.8 8.8-8.8-8.8z"/>')],
  minus: [L('<rect x="3.6" y="10.8" width="16.8" height="2.4" rx=".6"/>')],

  // ================================================================== added 2026-10 (were aliases)
  // ---------- media & states
  'fast-forward': [L(rp('M3 5.6 11.6 12 3 18.4z') + rp('M12.2 5.6 20.8 12l-8.6 6.4z'))],
  'to-start': [L('<rect x="2.6" y="5" width="2.4" height="14" rx=".6"/>' + rp('M14 5.6 7 12l7 6.4z') + rp('M21.2 5.6 14.2 12l7 6.4z'))],
  warning: [L(rp('M12 3.4 21.2 19.8H2.8z', 1.8), '<path d="M10.85 8.4h2.3l-.4 6.8h-1.5z"/><circle cx="12" cy="17.4" r="1.3"/>')],
  error: [L(rp(octagon(12, 12, 9.4), 1.2), '<path d="M10.8 5.8h2.4l-.4 8.4h-1.6z"/><circle cx="12" cy="17.4" r="1.45"/>')],
  'play-game': [
    L('<circle cx="12" cy="12" r="8"/>' + Array.from({ length: 12 }, (_, i) => { const a = (i * Math.PI) / 6; return `<circle cx="${n(12 + 8 * Math.cos(a))}" cy="${n(12 + 8 * Math.sin(a))}" r="1.9"/>`; }).join(''),
      ring(12, 12, 6.7, 1.2) + '<path d="M9.9 8.2 16 12l-6.1 3.8z"/>'),
  ],
  'take-slot': [L('<path d="M12.6 3h6.8a1.6 1.6 0 0 1 1.6 1.6v14.8a1.6 1.6 0 0 1-1.6 1.6h-6.8v-2.4h6V5.4h-6z"/><rect x="2.6" y="10.8" width="8.6" height="2.4" rx=".6"/><path d="M10 6.2 15.8 12 10 17.8z"/>')],
  'rotate-device': [
    L('<rect x="2.6" y="5" width="9.2" height="16" rx="1.8"/>', '<rect x="4.4" y="7.2" width="5.6" height="10.4" rx=".4"/>'),
    L(line('M13.6 4.8a5.8 5.8 0 0 1 5.8 5.8', 2.2, 'butt') + '<path d="M16.8 10.2h5.2l-2.6 4.2z"/>'),
  ],
  import: [L('<path d="M12 2.4l4.6 4.8h-3.4v9.4h-2.4V7.2H7.4z"/><path d="M3 14.6h2.4v4.2h13.2v-4.2H21v6.6H3z"/>')],
  like: [L(`<path d="${heart(12, 8.6, 5.2, 4.6, 21)}"/>`)],
  new: [L(`<path d="${sparkle(10, 13.6, 8, 0.2)}"/><path d="${sparkle(18.4, 5.4, 3.6, 0.24)}"/>`)],
  copy: [
    L('<rect x="3" y="2.6" width="12.4" height="14.8" rx="1.4"/>', '<rect x="7.2" y="5.2" width="15.2" height="17.6" rx="2.8"/>'),
    L('<rect x="8.6" y="6.6" width="12.4" height="14.8" rx="1.4"/>'),
  ],
  resize: [
    L('<rect x="3" y="12" width="9" height="9" rx="1"/>' + line('M13.4 3.6h7v7', 2.4, 'butt') +
      rot(-45, '<rect x="12.4" y="7.7" width="3.4" height="2.2"/><path d="M15 5.6l4.4 3.2-4.4 3.2z"/>', 15.2, 8.8)),
  ],
  // a broom, drawn upright and laid at 40°
  clear: [
    L('<rect x="10.7" y="2.4" width="2.6" height="8.4" rx="1"/><rect x="8.2" y="10.2" width="7.6" height="3" rx=".6"/><path d="M7.8 14.4h8.4l3.2 8H4.6z"/>',
      cut('M10.3 15.6 9.2 23M13.7 15.6l1.1 7.4', 1.2, 'butt'), 'translate(12 12) scale(.95) translate(-12 -12) translate(2.59 -2.27) rotate(40 12 12)'),
  ],
  undo: [L(line('M8 8.6h6.4a5.4 5.4 0 0 1 0 10.8H7.6', 2.4, 'butt') + '<path d="M2.6 8.6 8.6 3.4v10.4z"/>')],
  redo: [L(line('M8 8.6h6.4a5.4 5.4 0 0 1 0 10.8H7.6', 2.4, 'butt') + '<path d="M2.6 8.6 8.6 3.4v10.4z"/>', '', MIRROR_X)],
  // ---------- editor tools
  'tool-line': [L(line('M6 18 18 6', 2, 'butt') + '<rect x="2.6" y="16.4" width="5" height="5" rx=".8"/><rect x="16.4" y="2.6" width="5" height="5" rx=".8"/>')],
  'tool-fill': [
    L(rot(40, '<path d="M4.6 8.8h11.2l-1.4 10.4a1.6 1.6 0 0 1-1.6 1.4H7.6A1.6 1.6 0 0 1 6 19.2z"/><rect x="3.6" y="6.4" width="13.2" height="2.6" rx=".8"/>' + line('M6 6.6a4.2 4.2 0 0 1 8.4 0', 1.8, 'butt'), 10.2, 13)),
    L('<path d="M19.4 12.4q2.8 3.6 2.8 5.4a2.8 2.8 0 0 1-5.6 0q0-1.8 2.8-5.4z"/>'),
  ],
  'tool-pick': [L(rot(45, '<rect x="9.2" y="1.6" width="5.6" height="6.8" rx="2.8"/><rect x="7.6" y="7.8" width="8.8" height="2.6" rx=".6"/><path d="M9.8 11.8h4.4v6.6L12 22.4l-2.2-4z"/>'))],
  'tool-select': [L(rp('M5.4 2.8v16.6l4.2-4 3 6.4 3-1.4-3-6.3h6z', 1.2))],
  'tool-pan': [
    L('<rect x="6.2" y="4.4" width="2.4" height="10" rx="1.2"/><rect x="9.8" y="2.6" width="2.4" height="11" rx="1.2"/><rect x="13.4" y="3.4" width="2.4" height="10.5" rx="1.2"/><rect x="17" y="5.8" width="2.4" height="8.5" rx="1.2"/>' +
      '<path d="M6.2 11.6h13.2v4.6c0 3.2-2.4 5.6-5.6 5.6h-2.6c-2 0-3.4-.8-4.6-2.4L2.8 14.2a1.6 1.6 0 0 1 2.4-2.1l1 1.2z"/>'),
  ],
  // ---------- symmetry: a pennant in the top-left quarter and its copies
  'sym-none': [L(symPen('translate(12 12) scale(1.6) translate(-6.4 -6.6)'))],
  'sym-x': [L(symPen() + symPen(MIRROR_X) + SYM_AXIS_V)],
  'sym-y': [L(symPen() + symPen(MIRROR_Y) + SYM_AXIS_H)],
  'sym-xy': [L(symPen() + symPen(MIRROR_X) + symPen(MIRROR_Y) + symPen('rotate(180 12 12)') + SYM_AXIS_V + SYM_AXIS_H)],
  'sym-rot': [L(symPen() + symPen('rotate(180 12 12)') + SYM_PIVOT)],
  'sym-rot4': [L(symPen() + symPen('rotate(90 12 12)') + symPen('rotate(180 12 12)') + symPen('rotate(270 12 12)') + SYM_PIVOT)],
  'shape-round': [L('<circle cx="12" cy="12" r="8"/>')],
  // ---------- map
  gate: [
    L(GROUND + '<rect x="2.6" y="9" width="3" height="11"/><rect x="18.4" y="9" width="3" height="11"/><path d="M2.6 10A9.4 6.6 0 0 1 21.4 10h-2.2A7.2 4.4 0 0 0 4.8 10z"/><path d="M7 20v-9.4a5 3.4 0 0 1 10 0V20z"/>',
      cut('M12 6v14', 1.3, 'butt')),
  ],
  'gold-vein': [
    L(GROUND + '<path d="M2.6 20.4 4.2 13.6 8 9.4l3.2 1.2 3.4-4.8 4.2 3.4 2.6 6.4v4.8z"/>',
      `<path d="${sparkle(12.4, 14.6, 4.2, 0.2)}"/><circle cx="6.8" cy="17" r="1.1"/><circle cx="17.6" cy="13.6" r="1.1"/>`),
  ],
  // ---------- units
  'unit-worker': [
    L('<circle cx="12" cy="11.6" r="3.4"/><path d="M4.2 21.8v-2.4a7.8 6 0 0 1 15.6 0v2.4z"/><ellipse cx="12" cy="8.1" rx="7.4" ry="1.6"/><path d="M8.7 8.3 9.4 4.1q2.6-1.2 5.2 0l.7 4.2z"/>',
      '<path d="M4.4 9.8h15.2" stroke="#000" stroke-width="1.1"/>'),
  ],
  'unit-catapult': [
    L('<rect x="2.4" y="13.6" width="19.2" height="2.6" rx=".6"/><rect x="13.2" y="8" width="2.4" height="6"/>' + line('M17.6 13.4 6.4 5.6', 2.2, 'butt') + '<path d="M2.2 6.6a3.4 3.4 0 0 0 6.6-1.6z"/>',
      ring(6.4, 18.6, 3.6, 1.3) + ring(17.6, 18.6, 3.6, 1.3)),
    L('<circle cx="6.4" cy="18.6" r="2.9"/><circle cx="17.6" cy="18.6" r="2.9"/>', '<circle cx="6.4" cy="18.6" r=".9"/><circle cx="17.6" cy="18.6" r=".9"/>'),
  ],
  'unit-cavalry': [
    L('<path d="M7 21.6C7.6 19 9 16.8 9.6 15.6L5 15.8C3.8 15.8 3 14.8 3.2 13.6l.4-1.4 7-7.2.8-2.6 2.2 2C17.6 5.4 20.4 9.4 20.4 14.6v7z"/>',
      '<circle cx="9.4" cy="8.8" r="1.1"/>' + cut('M14.6 6.4C17 7.8 18.6 10.6 18.8 14.4', 1.3, 'butt')),
  ],
  'unit-ram': [
    L('<path d="M2.4 11.4 9.6 4.4l7.2 7z"/><rect x="3" y="12.8" width="16" height="3"/><rect x="18.4" y="11.4" width="3.6" height="5.8" rx="1"/><circle cx="6.6" cy="19.6" r="2.4"/><circle cx="14.4" cy="19.6" r="2.4"/>'),
  ],
  'unit-golem': [
    // hunched stone giant: tiny head sunk between boulder shoulders, arms to the ground, stumps for legs
    L([
      [[10.3, 3], [13.7, 3], [14.4, 7.6], [9.6, 7.6]],
      [[2.2, 8.6], [3.6, 4.8], [7.6, 4.2], [8.4, 8.2], [7.2, 12], [6.6, 15.4], [7.2, 19.4], [2.2, 19.4], [2.6, 15]],
      [[21.8, 8.6], [20.4, 4.8], [16.4, 4.2], [15.6, 8.2], [16.8, 12], [17.4, 15.4], [16.8, 19.4], [21.8, 19.4], [21.4, 15]],
      [[9.9, 9], [14.1, 9], [15.6, 12], [14.8, 16], [9.2, 16], [8.4, 12]],
      [[8.8, 17.4], [11.3, 17.4], [11.3, 21.6], [8.4, 21.6]],
      [[12.7, 17.4], [15.2, 17.4], [15.6, 21.6], [12.7, 21.6]],
    ].map((p) => `<path d="${poly(p)}"/>`).join(''),
      '<rect x="10.8" y="4.8" width="2.4" height="1.3"/>' + cut('M1.6 11.8 7.6 12.8M22.4 11.8l-6 1', 1.2, 'butt')),
  ],
  // ---------- forge & abilities
  // an arrow in flight over a dimension line: reach
  'upg-range': [
    L('<rect x="2.6" y="5.8" width="13.4" height="2.2" rx=".5"/><path d="M15 2.8 21.4 6.9 15 11z"/>' +
      '<rect x="2.4" y="13" width="2.2" height="8.6" rx=".5"/><rect x="19.4" y="13" width="2.2" height="8.6" rx=".5"/><rect x="8.4" y="16.5" width="7.2" height="2"/><path d="M5.6 17.5 9.4 14.4v6.2zM18.4 17.5l-3.8-3.1v6.2z"/>'),
  ],
  'abl-shield': [
    L(`<path d="${heater(1.8, 7, 7.6, 12.6)}"/><path d="${heater(14.6, 7, 7.6, 12.6)}"/>`, `<path d="${heater(7.6, 3.4, 8.8, 17.6)}" stroke="#000" stroke-width="2.6" stroke-linejoin="round"/>`),
    L(`<path d="${heater(7.6, 3.4, 8.8, 17.6)}"/>`),
  ],
  'abl-volley': [
    L(rot(-30, [[5.6, 2.4], [12, 5], [18.4, 2.4]].map(([x, y]) => `<rect x="${x - 1}" y="${y}" width="2" height="10"/><path d="M${n(x - 2.8)} ${n(y + 9.6)}h5.6L${x} ${n(y + 15)}z"/>`).join(''))),
  ],
  'abl-incendiary': [
    L('<path d="M12.6 2C13.4 5.6 18.8 8.4 18.8 14.4a6.8 6.8 0 0 1-13.6 0C5.2 11.4 6.6 9.4 8.4 8c0 2 .8 3.4 2 4C10 8 11.2 4.6 12.6 2z"/>',
      '<path d="M12 12.6c1.2 1.6 3.2 2.8 3.2 5a3.2 3.2 0 0 1-6.4 0c0-1.4.8-2.4 1.8-3 .2 1 .6 1.6 1.2 1.8-.4-1.4-.4-2.6.2-3.8z"/>'),
  ],
  // ---------- rank tiers: settlement signs from хутор to империя, growing on the ground line
  'tier-unranked': [
    L([2, 6.9, 11.8, 16.7].map((x) => `<rect x="${x}" y="20" width="3.4" height="2" rx=".6"/>`).join('') +
      line('M8.6 7.6a3.4 3.4 0 1 1 5 3c-1 .6-1.6 1.4-1.6 2.6v1', 2.4, 'round') + '<circle cx="12" cy="17.2" r="1.4"/>'),
  ],
  'tier-bronze': [L(ground(5.6, 18.4) + `<path d="${gable(8, 8, 14.4, 9.2, 0.8)}"/>`, '<rect x="11" y="16.4" width="2" height="3.6"/>')],
  'tier-silver': [
    L(ground(2, 22) + `<path d="${gable(2.6, 5.4, 15.4, 11.4, 0.5)}"/><path d="${gable(9.3, 5.4, 14, 9.2, 0.5)}"/><path d="${gable(16, 5.4, 15.4, 11.4, 0.5)}"/>`),
  ],
  'tier-gold': [
    L(GROUND + `<path d="${gable(2.8, 5.8, 14.4, 10.4, 0.5)}"/><path d="${gable(15.4, 5.8, 14.4, 10.4, 0.5)}"/><rect x="10.2" y="9.2" width="3.6" height="11"/><path d="M9.8 9.6 12 2.4l2.2 7.2z"/>`,
      '<rect x="11.3" y="12" width="1.4" height="3"/>'),
  ],
  'tier-platinum': [
    L(GROUND + `<path d="${gable(2.4, 4.4, 9.4, 3, 0.4)}"/><path d="${gable(17.2, 4.4, 9.4, 3, 0.4)}"/><rect x="6.8" y="12.4" width="10.4" height="7.6"/>` +
      [7.6, 10.4, 13.2].map((x) => `<rect x="${x + 0.4}" y="10.4" width="1.6" height="2.4"/>`).join(''),
      '<path d="M10.4 20v-3a1.6 1.6 0 0 1 3.2 0v3z"/>'),
  ],
  'tier-diamond': [
    L(GROUND + `<path d="${gable(2.4, 4, 10.4, 5, 0.4)}"/><path d="${gable(17.6, 4, 10.4, 5, 0.4)}"/><rect x="6.4" y="13.6" width="11.2" height="6.4"/><rect x="9.8" y="8.4" width="4.4" height="5.6"/><path d="${onion(12, 8.4, 3.4, 6)}"/><rect x="11.3" y="1.4" width="1.4" height="2"/>`,
      '<path d="M10.6 20v-2.6a1.4 1.4 0 0 1 2.8 0V20z"/><rect x="6.4" y="12.4" width="11.2" height="1.3"/>'),
  ],
  // королевство: a crown over the walled city
  'tier-master': [
    L(GROUND + `<path d="${gable(2.4, 4, 12, 7, 0.4)}"/><path d="${gable(17.6, 4, 12, 7, 0.4)}"/><rect x="6.4" y="14.4" width="11.2" height="5.6"/>` + crown(7.6, 16.4, 9, 2.4, 3.2, 3, 1.2),
      '<path d="M10.6 20v-2.4a1.4 1.4 0 0 1 2.8 0V20z"/>'),
  ],
  // империя: four towers and a crowned keep, the whole sheet
  'tier-grandmaster': [
    L(GROUND + `<path d="${gable(1.6, 3.2, 10.6, 3.6, 0.3)}"/><path d="${gable(19.2, 3.2, 10.6, 3.6, 0.3)}"/><path d="${gable(5.8, 2.6, 13.4, 8.6, 0.3)}"/><path d="${gable(15.6, 2.6, 13.4, 8.6, 0.3)}"/>` +
      '<rect x="9.4" y="9" width="5.2" height="11"/><rect x="4" y="15.4" width="16" height="4.6"/>' + crown(8.2, 15.8, 6, 2, 1.4, 3, 1.1),
      '<path d="M10.7 20v-2.4a1.3 1.3 0 0 1 2.6 0V20z"/><rect x="8" y="7.8" width="8" height="1.2"/>'),
  ],
};

// ------------------------------------------------------------------ output
const esc = (s) => s.replace(/#K/g, 'currentColor');
function build(name, layers) {
  let defs = '', body = '';
  layers.forEach((ly, i) => {
    const solid = esc(ly.s);
    let g;
    if (ly.c) {
      const id = `${name}-m${i}`;
      defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/><g fill="#000">${ly.c}</g></mask>`;
      g = `<g mask="url(#${id})">${solid}</g>`;
    } else g = `<g>${solid}</g>`;
    body += ly.t ? `<g transform="${ly.t}">${g}</g>` : g;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>\n`;
}

mkdirSync(OUT, { recursive: true });
const names = Object.keys(icons).filter((k) => !ONLY || ONLY.includes(k));
for (const name of names) writeFileSync(join(OUT, `${name}.svg`), build(name, icons[name]));
console.log(`${names.length} icons -> ${OUT}`);
