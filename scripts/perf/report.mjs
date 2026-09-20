// Turns the raw per-frame data in data/perf/*.json into a readable summary:
// steady-state cost per phase, the frames that hitched, and what those frames were doing.
//
//   node scripts/perf/report.mjs            # every scenario found
//   node scripts/perf/report.mjs mid-3x     # just these
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../data/perf');
const only = process.argv.slice(2);
/** a frame longer than this dropped at least one refresh at 60 Hz */
const HITCH_MS = 25;
/** phases that can be blamed for a hitch, in the order they run */
const PHASES = ['sim', 'input', 'sync', 'render', 'hud', 'react', 'mini', 'gap'];
const SUB = {
  sim: ['bot', 'cmds', 'grid', 'move', 'query', 'field', 'expand', 'region', 'fires', 'build', 'deaths', 'gates', 'pop', 'fog', 'victory', 'pfset'],
  sync: ['paths', 'vfield', 'vcopy', 'terrain'],
};
const EVENT = { 4: 'BuildingPlaced', 5: 'BuildingComplete', 9: 'Ability', 10: 'PlayerEliminated', 12: 'ResearchComplete', 14: 'Fire', 15: 'BuildingDestroyed', 19: 'ForestBurnt', 20: 'AgeUp' };

const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f2 = (x) => x.toFixed(2);

const files = readdirSync(OUT).filter((f) => f.endsWith('.json')).filter((f) => !only.length || only.includes(f.replace('.json', '')));
const all = files.map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'))).filter((d) => d.frames > 30);
all.sort((a, b) => (a.page + a.name).localeCompare(b.page + b.name));

console.log(`GPU: ${all[0]?.gpu ?? '?'}   scenarios: ${all.length}\n`);
console.log('scenario                 frames  fps  p50    p95    p99    max    busy50 busy95 | sim   sync  render hud   react mini   hitch');
console.log('-'.repeat(132));
for (const d of all) {
  const c = d.cols;
  const t = c.total.slice().sort((a, b) => a - b);
  const bz = c.busy.slice().sort((a, b) => a - b);
  const hitches = c.total.reduce((n, x) => n + (x > HITCH_MS ? 1 : 0), 0);
  console.log(
    d.name.padEnd(24) +
    String(d.frames).padStart(6) +
    (1000 / q(t, 0.5)).toFixed(0).padStart(5) +
    [q(t, 0.5), q(t, 0.95), q(t, 0.99), t[t.length - 1], q(bz, 0.5), q(bz, 0.95)].map((x) => x.toFixed(1).padStart(7)).join('') +
    ' |' + [mean(c.sim), mean(c.sync), mean(c.render), mean(c.hud), mean(c.react), mean(c.mini)].map((x) => f2(x).padStart(6)).join('') +
    String(hitches).padStart(7) + (hitches ? ` (${(hitches / d.frames * 100).toFixed(1)}%)` : ''),
  );
}

console.log('\n\n================ per scenario ================');
for (const d of all) {
  const c = d.cols;
  const t = c.total.slice().sort((a, b) => a - b);
  console.log(`\n--- ${d.name} --- ${d.note ?? ''}`);
  if (c.glUp) console.log(`  gl: ${f2(mean(c.glUp))} MB/frame in ${Math.round(mean(c.glUpN))} buffer uploads, ${f2(mean(c.glTex))} MB/frame into textures, ${c.glLink.reduce((a, b) => a + b, 0)} programs linked`);
  console.log(`  ${d.frames} frames over ${((c.t[d.frames - 1] - c.t[0]) / 1000).toFixed(1)}s, ${Math.round(mean(c.units))} units, ${Math.round(mean(c.ents))} entities, ${Math.round(mean(c.calls))} draw calls, ${(mean(c.tris) / 1000).toFixed(0)}k triangles, ${Math.round(mean(c.sel))} selected`);
  console.log(`  frame ms: p50 ${f2(q(t, 0.5))}  p95 ${f2(q(t, 0.95))}  p99 ${f2(q(t, 0.99))}  max ${f2(t[t.length - 1])}   (fps p50 ${(1000 / q(t, 0.5)).toFixed(0)}, worst ${(1000 / t[t.length - 1]).toFixed(0)})`);
  // where the CPU went
  const rows = [];
  for (const p of PHASES) {
    const a = c[p].slice().sort((x, y) => x - y);
    rows.push([p, mean(c[p]), q(a, 0.95), a[a.length - 1]]);
    for (const s of SUB[p] ?? []) {
      if (!c[s] || mean(c[s]) < 0.005) continue;
      const b = c[s].slice().sort((x, y) => x - y);
      rows.push(['  └ ' + s, mean(c[s]), q(b, 0.95), b[b.length - 1]]);
    }
  }
  console.log('    phase        mean    p95     max');
  for (const [k, m, p95, mx] of rows) console.log(`    ${k.padEnd(12)}${f2(m).padStart(7)}${f2(p95).padStart(8)}${f2(mx).padStart(8)}`);
  // hitches
  const hits = [];
  for (let i = 0; i < d.frames; i++) if (c.total[i] > HITCH_MS) hits.push(i);
  console.log(`  hitches (> ${HITCH_MS} ms): ${hits.length}`);
  if (hits.length) {
    const blame = new Map();
    for (const i of hits) {
      let best = 'gap', bv = 0;
      for (const p of PHASES) if (c[p][i] > bv) { bv = c[p][i]; best = p; }
      blame.set(best, (blame.get(best) ?? 0) + 1);
    }
    console.log('    blamed on: ' + [...blame].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
    const worst = hits.slice().sort((a, b) => c.total[b] - c.total[a]).slice(0, 6);
    for (const i of worst) {
      const parts = PHASES.filter((p) => c[p][i] > 0.5).map((p) => `${p} ${f2(c[p][i])}`);
      const subs = [...SUB.sim, ...SUB.sync].filter((s) => c[s] && c[s][i] > 0.5).map((s) => `${s} ${f2(c[s][i])}`);
      if (c.glLink && c.glLink[i] > 0) subs.push(`programs linked ${c.glLink[i]}`);
      const ev = d.notable.filter((e) => Math.abs(e.f - i) <= 1).map((e) => EVENT[e.type] ?? e.type);
      console.log(`    f${i} t+${((c.t[i] - c.t[0]) / 1000).toFixed(1)}s  ${f2(c.total[i])} ms  [${parts.join(', ')}]${subs.length ? '  {' + subs.join(', ') + '}' : ''}${ev.length ? '  events: ' + [...new Set(ev)].join(',') : ''}`);
    }
  }
  // memory: heap drops mean a collection ran
  const gcs = [];
  for (let i = 1; i < d.frames; i++) if (c.heap[i - 1] - c.heap[i] > 2) gcs.push(i);
  const secs = Math.max(0.001, (c.t[d.frames - 1] - c.t[0]) / 1000);
  const freed = gcs.reduce((s, i) => s + (c.heap[i - 1] - c.heap[i]), 0);
  console.log(`  heap: ${f2(c.heap[0])} -> ${f2(c.heap[d.frames - 1])} MB, ${gcs.length} collections freeing ${f2(freed)} MB => allocation ~${f2((freed + c.heap[d.frames - 1] - c.heap[0]) / secs)} MB/s`);
  if (gcs.length) {
    const gcFrames = gcs.map((i) => c.total[i]).sort((a, b) => a - b);
    const norm = c.total.slice().sort((a, b) => a - b);
    console.log(`    frame ms on a collection: p50 ${f2(q(gcFrames, 0.5))} max ${f2(gcFrames[gcFrames.length - 1])} (all frames: p50 ${f2(q(norm, 0.5))})`);
  }
}
