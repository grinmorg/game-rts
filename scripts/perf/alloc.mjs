// Where the per-frame garbage comes from. V8's sampling heap profiler attributes allocations to the function
// that made them, so this says which part of the frame loop is feeding the collector rather than just how
// much is being collected.
//
//   node scripts/perf/alloc.mjs stress600 12000
//   node scripts/perf/alloc.mjs skirmish 20000
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../e2e/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const PORT = 5197;
const PROBE = readFileSync(join(here, 'probe.js'), 'utf8');
const [pageName = 'stress600', msArg = '12000'] = process.argv.slice(2);
const URLS = { stress600: '/?stress=6,100,128,bots', stress1200: '/?stress=6,200,144,bots', skirmish: '/' };
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

const b = await launch('perf-alloc', { gpu: true, ttlMs: Number(msArg) * 3 + 120_000 });
try {
  const tab = await b.openTab(`http://localhost:${PORT}${URLS[pageName] ?? URLS.stress600}`, { width: 1600, height: 900, dpr: 1, preload: PROBE });
  if (pageName === 'skirmish') {
    await sleep(2500);
    await tab.clickText('/AI|ИИ/'); await sleep(800);
    await tab.clickText('/Start|Старт/');
  }
  for (let i = 0; i < 120 && !(await tab.evalJs('!!window.__rookfall')); i++) await sleep(500);
  await tab.evalJs('__perf.install()');
  // select what we own: that is the expensive HUD path, and it must be represented in the sample
  console.log('selected:', await tab.evalJs(`(() => { const v = window.__rookfall, w = v.sim.world; const ids = []; for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === 1 && w.owner[id] === v.mySlot) ids.push(id); v.input.setSelection(ids); return ids.length; })()`));
  await sleep(2000);
  await tab.S('HeapProfiler.enable');
  await tab.S('HeapProfiler.startSampling', { samplingInterval: 4096 });
  await sleep(Number(msArg));
  const { profile } = await tab.S('HeapProfiler.getSamplingProfile');
  await tab.S('HeapProfiler.stopSampling');

  // fold the tree: every node's own bytes, keyed by function and script position
  const rows = new Map();
  let total = 0;
  const walk = (node) => {
    const f = node.callFrame;
    const self = (node.selfSize ?? 0);
    if (self > 0) {
      const key = `${f.functionName || '(anonymous)'}  ${short(f.url)}:${f.lineNumber + 1}`;
      rows.set(key, (rows.get(key) ?? 0) + self);
      total += self;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(profile.head);
  const secs = Number(msArg) / 1000;
  console.log(`\nallocated ${(total / 1048576).toFixed(1)} MB in ${secs}s = ${(total / 1048576 / secs).toFixed(1)} MB/s\n`);
  console.log('   MB/s   share  where');
  for (const [k, v] of [...rows].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${(v / 1048576 / secs).toFixed(2).padStart(7)}  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
} finally {
  b.close(); srv.close();
}
process.exit(0);

function short(url) { return (url || '').replace(/^https?:\/\/[^/]+\//, ''); }
