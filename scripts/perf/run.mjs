// Frame-time harness: drives the real client through a set of scripted situations and records what every
// frame was spent on. Usage:
//
//   node scripts/perf/run.mjs                 # production build, every scenario
//   node scripts/perf/run.mjs --skip-build    # reuse packages/client/dist as it is
//   node scripts/perf/run.mjs --only=stress600-battle,mid-3x
//
// Raw per-frame data lands in data/perf/<scenario>.json; `node scripts/perf/report.mjs` turns it into the
// summary. The browser runs headless but on the real GPU (see scripts/e2e/cdp.mjs), because SwiftShader's
// CPU rasterizer would drown every difference this is looking for.
import { execSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../e2e/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const OUT = join(root, 'data/perf');
const PORT = 5199;
const PROBE = readFileSync(join(here, 'probe.js'), 'utf8');
const args = process.argv.slice(2);
const has = (f) => args.some((a) => a === f || a.startsWith(f + '='));
const val = (f, d) => { const a = args.find((x) => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : d; };
const ONLY = val('--only', '').split(',').filter(Boolean);
const VIEW = { width: 1600, height: 900, dpr: 1 };

// ------------------------------------------------------------------ scenarios
// Each scenario names the page it needs; scenarios sharing a page run back to back on the same match, which
// is the point for the A/B pairs (HUD on/off, shadows on/off) - the world must be identical on both sides.
const PAGES = {
  skirmish: { url: () => `${base()}/`, start: startSkirmish },
  stress600: { url: () => `${base()}/?stress=6,100,128,bots`, start: waitForView },
  stress1200: { url: () => `${base()}/?stress=6,200,144,bots`, start: waitForView },
  stress2400: { url: () => `${base()}/?stress=6,400,160,bots`, start: waitForView },
  // The same battle on a retina panel. The renderer clamps the pixel ratio to 1.5, so a 1512x982 laptop
  // screen draws 2268x1473 - 2.3x the pixels of the 1600x900 the other pages use, which is what the machine
  // the game is actually played on has to push.
  stress600b: { url: () => `${base()}/?stress=6,100,128,bots`, start: waitForView },
  stress600c: { url: () => `${base()}/?stress=6,100,128,bots`, start: waitForView },
  stress1200b: { url: () => `${base()}/?stress=6,200,144,bots`, start: waitForView },
  stress600r: { url: () => `${base()}/?stress=6,100,128,bots`, start: waitForView, view: { width: 1512, height: 982, dpr: 2 } },
  skirmishr: { url: () => `${base()}/`, start: startSkirmish, view: { width: 1512, height: 982, dpr: 2 } },
};

const SCENARIOS = [
  // --- a real match against the bot, from the loading screen onwards. The player does nothing, so the
  // scenarios that need our own units run first, while the opening army is still alive.
  { page: 'skirmish', name: 'boot', ms: 6000, beforeStart: true,
    note: 'first seconds of a match: shader compilation, first fog upload, first HUD' },
  { page: 'skirmish', name: 'early-1x', ms: 20000, note: 'opening minute at normal speed, no input' },
  { page: 'skirmish', name: 'early-hover', ms: 15000, mouse: [800, 450], note: 'the same, with the cursor over the map (hover picking runs)' },
  { page: 'skirmish', name: 'early-edgescroll', ms: 12000, mouse: [1594, 450], note: 'camera panning along the map edge' },
  { page: 'skirmish', name: 'early-selected', ms: 12000, mouse: [800, 450], pre: 'selectOwn(999)', note: 'the starting workers selected' },
  { page: 'skirmish', name: 'wall-spam', ms: 20000, mouse: [800, 450], pre: 'selectOwn(999)', during: 'wallSpam', note: 'fences going up: every one of them edits the pathfinder' },
  { page: 'skirmish', name: 'forest-fire', ms: 20000, pre: 'igniteNear(14)', note: 'a forest burning down (terrain and decor rebuilt)' },
  { page: 'skirmish', name: 'hud-on', ms: 12000, pre: 'hud(true)', note: 'A/B pair: HUD + minimap on' },
  { page: 'skirmish', name: 'hud-off', ms: 12000, pre: 'hud(false)', note: 'A/B pair: HUD + minimap off' },
  { page: 'skirmish', name: 'mid-3x', ms: 90000, pre: 'hud(true);speed(3)', note: 'the match at 3x for 4.5 minutes of game time' },

  // --- synthetic armies (every player but ours is a bot, so the map fills with buildings too) ------------
  { page: 'stress600', name: 'stress600-battle', ms: 25000, note: '600 units fighting in the middle' },
  { page: 'stress600', name: 'stress600-hover', ms: 15000, mouse: [800, 450], note: 'same battle, cursor over the map' },
  { page: 'stress600', name: 'stress600-zoomout', ms: 15000, pre: 'zoom(1)', note: 'same battle, camera at maximum height' },
  { page: 'stress600', name: 'stress600-select', ms: 15000, mouse: [800, 450], pre: 'zoom(0.5);selectOwn(300)', note: 'our whole army selected at once' },
  { page: 'stress600', name: 'stress600-orders', ms: 20000, during: 'orderSpam', note: 'a new attack-move for the whole army every second' },
  { page: 'stress600b', name: 'stress600-noshadow', ms: 12000, pre: 'shadows(false)', note: 'A/B pair: shadows off' },
  { page: 'stress600b', name: 'stress600-shadow', ms: 12000, pre: 'shadows(true)', note: 'A/B pair: shadows on' },
  { page: 'stress600b', name: 'stress600-nohud', ms: 12000, pre: 'hud(false)', note: 'HUD + minimap off' },
  { page: 'stress600b', name: 'stress600-speed5', ms: 12000, pre: 'hud(true);speed(5)', note: 'match speed 5x: five simulation ticks per frame' },

  { page: 'stress1200', name: 'stress1200-battle', ms: 20000, note: '1200 units' },
  { page: 'stress1200', name: 'stress1200-zoomout', ms: 15000, pre: 'zoom(1)', note: '1200 units, camera at maximum height' },
  { page: 'stress1200', name: 'stress1200-select', ms: 15000, mouse: [800, 450], pre: 'selectOwn(600)', note: '200 units selected, cursor over the map' },

  { page: 'stress2400', name: 'stress2400-battle', ms: 20000, note: '2400 units: past anything a real match can field' },
  { page: 'stress2400', name: 'stress2400-zoomout', ms: 15000, pre: 'zoom(1)', note: '2400 units from above' },

  // --- the same load on a retina panel -----------------------------------------------------------------
  { page: 'stress600r', name: 'retina-battle', ms: 20000, note: '600 units at 2268x1473 (laptop screen, pixel ratio 1.5)' },
  { page: 'stress600r', name: 'retina-zoomout', ms: 15000, pre: 'zoom(1)', note: 'same, camera at maximum height' },
  { page: 'stress600r', name: 'retina-noshadow', ms: 12000, pre: 'shadows(false)', note: 'same, shadows off' },
  { page: 'skirmishr', name: 'retina-early', ms: 15000, mouse: [750, 490], note: 'a real match on a retina panel' },

  // --- the same, on a machine four times slower than this one ------------------------------------------
  // Chrome throttles the renderer's main thread; the GPU is untouched, so this is "what would the CPU side
  // look like on an ordinary laptop", not a full simulation of one.
  { page: 'stress600c', name: 'cpu4-battle', ms: 15000, cpu: 4, note: '600 units with the main thread throttled 4x' },
  { page: 'stress600c', name: 'cpu4-hover', ms: 15000, cpu: 4, mouse: [800, 450], note: 'same, cursor over the map' },
  { page: 'stress600c', name: 'cpu4-select', ms: 15000, cpu: 4, mouse: [800, 450], pre: 'selectOwn(300)', note: 'same, our army selected' },
  { page: 'stress1200b', name: 'cpu4-1200', ms: 15000, cpu: 4, note: '1200 units, main thread throttled 4x' },
];

// ------------------------------------------------------------------ in-page helpers
// Sent to the page once per match; the scenarios above call these by name.
const HELPERS = `(() => {
  const v = window.__rookfall, sim = v.sim, w = sim.world;
  const FP = 65536;
  window.__h = {
    speed: (x) => { v.session.speed = x; return x; },
    zoom: (f) => { const c = v.renderer.cam; for (let i = 0; i < 40; i++) c.zoom(f > 0.75 ? 1 : -1); return c.distance; },
    shadows: (on) => { v.renderer.setShadows(on); return on; },
    hud: (on) => {
      if (on) {
        if (window.__hudSaved) { for (const l of window.__hudSaved) v.listeners.add(l); window.__hudSaved = null; }
        // only restore a canvas that was taken away: turning the HUD "on" when it never went off must not
        // hand setMinimapCanvas a null and switch the minimap off instead
        if (window.__miniSaved) { v.setMinimapCanvas(window.__miniSaved); window.__miniSaved = null; }
      } else {
        window.__hudSaved = [...v.listeners]; v.listeners.clear();
        window.__miniSaved = v.minimap; v.setMinimapCanvas(null);
      }
      return { on, listeners: v.listeners.size, minimap: !!v.minimap };
    },
    ownUnits: (n) => { const ids = []; for (let id = 0; id < w.maxId && ids.length < n; id++) if (w.alive[id] && w.kind[id] === 1 && w.owner[id] === v.mySlot) ids.push(id); return ids; },
    selectOwn: (n) => { const ids = window.__h.ownUnits(n); v.input.setSelection(ids); return ids.length; },
    /** send everything we own somewhere new: fresh flow fields, fresh routes */
    orderSpam: () => {
      const ids = window.__h.ownUnits(9999).filter((id) => w.type[id] !== 0);
      const x = (10 + Math.random() * (sim.map.w - 20)) * FP | 0, y = (10 + Math.random() * (sim.map.h - 20)) * FP | 0;
      for (let i = 0; i < ids.length; i += 200) v.issue({ type: 2, player: v.mySlot, ids: ids.slice(i, i + 200), x, y });
      return ids.length;
    },
    /** a fence line next to the castle: every cell bumps the pathfinder's version */
    wallSpam: () => {
      const b = window.__h.base();
      const workers = []; for (let id = 0; id < w.maxId && workers.length < 4; id++) if (w.alive[id] && w.kind[id] === 1 && w.owner[id] === v.mySlot && w.type[id] === 0) workers.push(id);
      if (!workers.length) return 0;
      const k = (window.__wallN = (window.__wallN ?? 0) + 1);
      const cx = b.cx + 4 + (k % 12), cy = b.cy - 6 + Math.floor(k / 12) % 12;
      v.issue({ type: 8, player: v.mySlot, ids: workers, x: (cx + 0.5) * FP | 0, y: (cy + 0.5) * FP | 0, v: 5 });
      return k;
    },
    base: () => { for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === 2 && w.owner[id] === v.mySlot && w.type[id] === 0) return { id, cx: w.x[id] >> 16, cy: w.y[id] >> 16 }; const p = sim.players[Math.max(0, v.mySlot)]; return { id: -1, cx: p.startX, cy: p.startY }; },
    /** set every forest cell around the camera alight, then watch it burn down */
    igniteNear: (r) => {
      const t = v.renderer.cam.target;
      sim.igniteForest(t.x * FP | 0, t.z * FP | 0, r * FP);
      if (sim.burning.length < 20) { // camera is not on a forest: find the biggest one on the map
        const m = sim.map; let best = -1, bx = 0, by = 0;
        for (let y = 4; y < m.h - 4; y += 4) for (let x = 4; x < m.w - 4; x += 4) {
          let c = 0; for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) if (m.tiles[(y + j) * m.w + (x + i)] === 3) c++;
          if (c > best) { best = c; bx = x; by = y; }
        }
        v.centerOn(bx, by);
        sim.igniteForest(bx * FP | 0, by * FP | 0, r * FP);
      }
      return sim.burning.length;
    },
    /** how much of the battle the camera is looking at */
    lookAtCentre: () => { v.centerOn(sim.map.w / 2, sim.map.h / 2); return true; },
  };
  return 'helpers ready';
})()`;

// ------------------------------------------------------------------ plumbing
const base = () => `http://localhost:${PORT}`;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2' };

function serveStatic(dir) {
  const srv = createServer((req, res) => {
    const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, p);
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { file = join(dir, 'index.html'); }
    if (!existsSync(file)) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT, () => r(srv)));
}

async function waitForView(tab) {
  for (let i = 0; i < 120; i++) {
    if (await tab.evalJs('!!window.__rookfall')) return true;
    await sleep(500);
  }
  throw new Error('the match never started');
}
async function startSkirmish(tab) {
  await sleep(2000);
  await tab.clickText('/AI|ИИ/');
  await sleep(800);
  await tab.clickText('/Start|Старт/');
  return waitForView(tab);
}

async function runPage(browser, pageName, list) {
  const page = PAGES[pageName];
  console.log(`\n=== page ${pageName}: ${list.map((s) => s.name).join(', ')} ===`);
  const tab = await browser.openTab(page.url(), { ...VIEW, ...page.view, preload: PROBE });
  // `boot` has to be recording before the match exists, so it starts the window first and the page after
  const bootFirst = list[0]?.beforeStart;
  if (bootFirst) { await sleep(2500); await tab.evalJs(`__perf.begin('boot')`); }
  await page.start(tab);
  console.log('  view up:', await tab.evalJs('__perf.install()'));
  console.log('  hud listeners:', await tab.evalJs('({ listeners: window.__rookfall.listeners.size, minimap: !!window.__rookfall.minimap, speed: window.__rookfall.session.speed, map: window.__rookfall.sim.map.w + "x" + window.__rookfall.sim.map.h })'));
  await tab.evalJs(HELPERS);
  // models, shaders and the first fog upload all land in the first second; let them settle unless the
  // scenario is specifically about them
  for (const sc of list) {
    if (sc.beforeStart) {
      await sleep(sc.ms);
    } else {
      await sleep(1200);
      // a cursor over the canvas is not cosmetic: hover picking scans every entity on every frame, and it
      // only runs when the pointer is inside
      if (sc.mouse) await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sc.mouse[0], y: sc.mouse[1] });
      else await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -50, y: -50 });
      await tab.S('Emulation.setCPUThrottlingRate', { rate: sc.cpu ?? 1 });
      if (sc.pre) for (const call of sc.pre.split(';')) console.log(`  pre ${call} ->`, await tab.evalJs(`__h.${call}`));
      await tab.evalJs(`__perf.begin(${JSON.stringify(sc.name)})`);
      const t0 = Date.now();
      while (Date.now() - t0 < sc.ms) {
        await sleep(1000);
        // an edge-scroll scenario has to keep the pointer alive, or the camera stops where it is
        if (sc.mouse) await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sc.mouse[0] + (Math.random() < 0.5 ? 1 : -1), y: sc.mouse[1] });
        if (sc.during) await tab.evalJs(`__h.${sc.during}()`);
      }
    }
    const data = await tab.evalJs('JSON.stringify(__perf.end())');
    if (sc.cpu) await tab.S('Emulation.setCPUThrottlingRate', { rate: 1 });
    const parsed = JSON.parse(data);
    parsed.note = sc.note; parsed.page = pageName;
    writeFileSync(join(OUT, `${sc.name}.json`), JSON.stringify(parsed));
    const over = await tab.evalJs('window.__rookfall ? window.__rookfall.sim.gameOver : true');
    parsed.gameOver = over;
    writeFileSync(join(OUT, `${sc.name}.json`), JSON.stringify(parsed));
    console.log(`  ${sc.name.padEnd(22)} ${summarize(parsed)}${over ? '   [MATCH OVER - simulation idle]' : ''}`);
  }
  await tab.S('Page.close').catch(() => {});
}

/** one line per scenario while the run is going on; report.mjs does the real analysis */
function summarize(d) {
  const t = d.cols.total.slice().sort((a, b) => a - b);
  if (!t.length) return 'no frames';
  const q = (p) => t[Math.min(t.length - 1, Math.floor(t.length * p))];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return `frames ${d.frames} fps~${(1000 / q(0.5)).toFixed(0)} p50 ${q(0.5).toFixed(1)}ms p95 ${q(0.95).toFixed(1)} p99 ${q(0.99).toFixed(1)} max ${t[t.length - 1].toFixed(1)} | sim ${mean(d.cols.sim).toFixed(2)} sync ${mean(d.cols.sync).toFixed(2)} render ${mean(d.cols.render).toFixed(2)} hud ${mean(d.cols.hud).toFixed(2)} react ${mean(d.cols.react).toFixed(2)} mini ${mean(d.cols.mini).toFixed(2)}`;
}

// ------------------------------------------------------------------ main
mkdirSync(OUT, { recursive: true });
let srv = null, browsers = [];
try {
  if (!has('--skip-build')) {
    console.log('building the client...');
    execSync('pnpm --filter @rookfall/client build', { cwd: root, stdio: 'inherit' });
  }
  srv = await serveStatic(join(root, 'packages/client/dist'));
  console.log(`serving packages/client/dist on ${base()}`);

  const wanted = SCENARIOS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));
  const byPage = new Map();
  for (const s of wanted) { if (!byPage.has(s.page)) byPage.set(s.page, []); byPage.get(s.page).push(s); }
  for (const [pageName, list] of byPage) {
    const total = list.reduce((a, s) => a + s.ms, 0) + 60_000;
    const b = await launch(`perf-${pageName}`, { gpu: true, ttlMs: Math.max(120_000, total * 2) });
    browsers.push(b);
    try { await runPage(b, pageName, list); }
    finally {
      if (b.errors.length) { console.log('  console errors:'); for (const e of b.errors.slice(0, 5)) console.log('   ', e.slice(0, 200)); }
      b.close();
    }
  }
  console.log(`\nraw data in ${OUT}`);
} catch (e) {
  console.error('perf run failed:', e);
  process.exitCode = 1;
} finally {
  for (const b of browsers) b.close();
  srv?.close();
}
process.exit(process.exitCode ?? 0);
