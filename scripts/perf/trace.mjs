// Chrome trace of one situation, for the frames the frame profiler cannot explain from inside the page:
// garbage collection, shader compilation, compositing, work on other threads.
//
//   node scripts/perf/trace.mjs stress600            # 6 players x 100 units
//   node scripts/perf/trace.mjs skirmish 20000       # a real match, 20 s
//   node scripts/perf/trace.mjs stress600 15000 select
//   node scripts/perf/trace.mjs skirmish 40000 fast,select
//
// Prints the longest main-thread tasks with what was inside them, every garbage collection over 5 ms, and
// every program compile/link, so a spike can be named rather than guessed at.
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../e2e/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const PORT = 5198;
const PROBE = (await import('node:fs')).readFileSync(join(here, 'probe.js'), 'utf8');
const [pageName = 'stress600', msArg = '15000', extra = ''] = process.argv.slice(2);
const MS = Number(msArg);
const URLS = {
  stress600: '/?stress=6,100,128,bots',
  stress1200: '/?stress=6,200,144,bots',
  skirmish: '/',
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

const srv = await new Promise((r) => {
  const s = createServer((req, res) => {
    const dir = join(root, 'packages/client/dist');
    const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, p);
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { file = join(dir, 'index.html'); }
    if (!existsSync(file)) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  s.listen(PORT, () => r(s));
});

const b = await launch('perf-trace', { gpu: true, ttlMs: MS * 3 + 120_000 });
const events = [];
b.on('Tracing.dataCollected', (p) => { for (const e of p.value) events.push(e); });
let done = null;
b.on('Tracing.tracingComplete', () => done?.());

try {
  const tab = await b.openTab(`http://localhost:${PORT}${URLS[pageName] ?? URLS.stress600}`, { width: 1600, height: 900, dpr: 1, preload: PROBE });
  if (pageName === 'skirmish') {
    await sleep(2500);
    await tab.clickText('/AI|ИИ/'); await sleep(800);
    await tab.clickText('/Start|Старт/');
  }
  for (let i = 0; i < 120 && !(await tab.evalJs('!!window.__rookfall')); i++) await sleep(500);
  await tab.evalJs('__perf.install()');
  await sleep(2000);
  if (extra.includes('fast')) console.log('speed:', await tab.evalJs('window.__rookfall.session.speed = 3'));
  if (extra.includes('select')) {
    await tab.evalJs(`(() => { const v = window.__rookfall, w = v.sim.world; const ids = []; for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === 1 && w.owner[id] === v.mySlot) ids.push(id); v.input.setSelection(ids); return ids.length; })()`);
  }
  await b.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile', 'blink.user_timing', 'gpu', 'disabled-by-default-devtools.timeline.frame', 'latency', 'toplevel'],
    },
    transferMode: 'ReportEvents',
  });
  await tab.evalJs(`__perf.begin('trace')`);
  await sleep(MS);
  const perf = JSON.parse(await tab.evalJs('JSON.stringify(__perf.end())'));
  const wait = new Promise((r) => { done = r; });
  await b.send('Tracing.end');
  await Promise.race([wait, sleep(20000)]);
  mkdirSync(join(root, 'data/perf'), { recursive: true });
  writeFileSync(join(root, `data/perf/trace-${pageName}.json`), JSON.stringify({ traceEvents: events }));
  writeFileSync(join(root, `data/perf/trace-${pageName}-frames.json`), JSON.stringify(perf));
  console.log(`\n${events.length} trace events, ${perf.frames} frames recorded`);
  analyze(events, perf);
} finally {
  b.close(); srv.close();
}
process.exit(0);

// ------------------------------------------------------------------ analysis
function analyze(evs, perf) {
  const us = (x) => x / 1000;
  // the renderer main thread is the one running the animation frames
  const byThread = new Map();
  for (const e of evs) {
    const k = e.pid + ':' + e.tid;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(e);
  }
  // the renderer's main thread is the one the animation frames run on - counting RunTask instead would pick
  // the compositor, which has more of them and none of the work we are looking for
  let mainKey = null, best = 0;
  for (const [k, list] of byThread) {
    const n = list.filter((e) => e.name === 'FireAnimationFrame').length;
    if (n > best) { best = n; mainKey = k; }
  }
  const main = (byThread.get(mainKey) ?? []).filter((e) => e.ph === 'X' || e.ph === 'B' || e.ph === 'E');
  main.sort((a, b) => a.ts - b.ts);
  const complete = main.filter((e) => e.ph === 'X' && e.dur);
  const tasks = complete.filter((e) => e.name === 'RunTask').sort((a, b) => b.dur - a.dur);
  console.log(`\n--- longest main-thread tasks (${mainKey}) ---`);
  for (const t of tasks.slice(0, 12)) {
    const inside = complete.filter((e) => e !== t && e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur && e.dur > t.dur * 0.15);
    const names = [...new Set(inside.map((e) => `${e.name}${e.args?.data?.functionName ? ':' + e.args.data.functionName : ''} ${us(e.dur).toFixed(1)}ms`))];
    console.log(`  ${us(t.dur).toFixed(1).padStart(7)} ms  ${names.slice(0, 6).join(' | ') || '(no children recorded)'}`);
  }
  const gcNames = ['MajorGC', 'MinorGC', 'V8.GCCompactor', 'V8.GCScavenger', 'V8.GCIncrementalMarking', 'V8.GCFinalizeMC', 'BlinkGC.AtomicPhase'];
  const gcs = complete.filter((e) => gcNames.includes(e.name) || (e.cat ?? '').includes('v8.gc')).sort((a, b) => b.dur - a.dur);
  console.log(`\n--- garbage collection (${gcs.length} events on every thread; the longest) ---`);
  const seen = new Map();
  for (const g of gcs) seen.set(g.name, (seen.get(g.name) ?? 0) + 1);
  console.log('  ' + [...seen].map(([k, v]) => `${k} x${v}`).join(', '));
  for (const g of gcs.slice(0, 8)) console.log(`  ${us(g.dur).toFixed(1).padStart(7)} ms  ${g.name} ${JSON.stringify(g.args?.usedHeapSizeBefore ?? g.args ?? {}).slice(0, 120)}`);
  const gl = complete.filter((e) => /Program|Shader|Compile|Link/i.test(e.name) && e.dur > 1000).sort((a, b) => b.dur - a.dur);
  console.log(`\n--- compiles / links over 1 ms (${gl.length}) ---`);
  for (const g of gl.slice(0, 10)) console.log(`  ${us(g.dur).toFixed(1).padStart(7)} ms  ${g.name} ${(e => e ? JSON.stringify(e).slice(0, 100) : '')(g.args?.data)}`);
  // longest events on any thread, to catch the GPU process
  const allX = evs.filter((e) => e.ph === 'X' && e.dur > 20000).sort((a, b) => b.dur - a.dur);
  console.log(`\n--- any thread, events over 20 ms (${allX.length}) ---`);
  for (const e of allX.slice(0, 15)) console.log(`  ${us(e.dur).toFixed(1).padStart(7)} ms  ${e.name}  pid ${e.pid} tid ${e.tid} cat ${e.cat}`);
  // what the frame profiler saw at the same time
  const t = perf.cols.total;
  const worst = t.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 6);
  console.log('\n--- worst frames from the in-page profiler ---');
  for (const [v, i] of worst) console.log(`  f${i} ${v.toFixed(1)} ms  sim ${perf.cols.sim[i]} render ${perf.cols.render[i]} gap ${perf.cols.gap[i]} heap ${perf.cols.heap[i]}`);
}
