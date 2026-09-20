// A/B experiments: change one thing at runtime and measure the same situation again, so a suspected cause
// can be confirmed rather than argued about.
//
//   node scripts/perf/experiment.mjs ranges      # upload only the used part of each instance buffer
//   node scripts/perf/experiment.mjs visible     # skip the instance sets that are empty this frame
//   node scripts/perf/experiment.mjs audio       # create the AudioContext before the match instead of on the first sound
//   node scripts/perf/experiment.mjs compile    # what rebuilding the shader programs costs
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../e2e/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const PORT = 5196;
const PROBE = readFileSync(join(here, 'probe.js'), 'utf8');
const NAME = process.argv[2] ?? 'ranges';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

/** upload only `count` instances instead of the whole capacity (three.js update ranges) */
const PATCH_RANGES = `(() => {
  const v = window.__rookfall, gl = v.renderer.gl;
  // collect the meshes once: walking the scene graph every frame would cost more than it saves
  const meshes = [];
  v.renderer.scene.traverse((o) => { if (o.isInstancedMesh) meshes.push([o, o.instanceMatrix, o.instanceColor, o.geometry.getAttribute('aAnim')]); });
  const real = gl.render.bind(gl);
  gl.render = (scene, cam) => {
    for (const [o, m, c, a] of meshes) {
      const n = o.count;
      m.clearUpdateRanges(); m.addUpdateRange(0, n * 16); m.needsUpdate = true;
      if (c) { c.clearUpdateRanges(); c.addUpdateRange(0, n * 3); c.needsUpdate = true; }
      if (a && a.isInstancedBufferAttribute) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    }
    return real(scene, cam);
  };
  return meshes.length + ' instanced meshes patched';
})()`;

/** hide the sets that have nothing in them: three.js skips an invisible object before it uploads anything */
const PATCH_VISIBLE = `(() => {
  const v = window.__rookfall, gl = v.renderer.gl;
  const meshes = [];
  v.renderer.scene.traverse((o) => { if (o.isInstancedMesh) meshes.push(o); });
  const real = gl.render.bind(gl);
  gl.render = (scene, cam) => {
    for (const o of meshes) o.visible = o.count > 0;
    return real(scene, cam);
  };
  return meshes.length + ' instanced meshes patched';
})()`;

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
const url = (q) => `http://localhost:${PORT}${q}`;
const stats = (d) => {
  const t = d.cols.total.slice().sort((a, b) => a - b);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const q = (p) => t[Math.min(t.length - 1, Math.floor(t.length * p))];
  return `frames ${d.frames} p50 ${q(0.5).toFixed(2)} p95 ${q(0.95).toFixed(2)} max ${t[t.length - 1].toFixed(1)} | busy ${mean(d.cols.busy).toFixed(2)} render ${mean(d.cols.render).toFixed(2)} sync ${mean(d.cols.sync).toFixed(2)} | gl ${mean(d.cols.glUp).toFixed(2)} MB/frame in ${Math.round(mean(d.cols.glUpN))} uploads`;
};

const b = await launch('perf-exp', { gpu: true, ttlMs: 300_000 });
try {
  if (NAME === 'ranges' || NAME === 'visible') {
    // the same battle, measured before and after the patch
    const tab = await b.openTab(url('/?stress=6,200,144,bots'), { width: 1600, height: 900, dpr: 1, preload: PROBE });
    for (let i = 0; i < 120 && !(await tab.evalJs('!!window.__rookfall')); i++) await sleep(500);
    await tab.evalJs('__perf.install()');
    await sleep(3000);
    console.log('scene:', await tab.evalJs(`(() => { const r = window.__rookfall.renderer; let n = 0, cap = 0, used = 0, bytes = 0; r.scene.traverse((o) => { if (!o.isInstancedMesh) return; n++; cap += o.instanceMatrix.count; used += o.count; bytes += o.instanceMatrix.array.byteLength + (o.instanceColor ? o.instanceColor.array.byteLength : 0) + (o.geometry.getAttribute('aAnim') ? o.geometry.getAttribute('aAnim').array.byteLength : 0); }); return { instancedMeshes: n, capacity: cap, used, mbPerFrame: +(bytes / 1048576).toFixed(2), drawCalls: r.gl.info.render.calls, programs: r.gl.info.programs.length }; })()`));
    await tab.evalJs(`__perf.begin('before')`); await sleep(12000);
    const before = JSON.parse(await tab.evalJs('JSON.stringify(__perf.end())'));
    console.log('whole-capacity uploads :', stats(before));
    console.log('patch:', await tab.evalJs(NAME === 'visible' ? PATCH_VISIBLE : PATCH_RANGES));
    await sleep(1000);
    await tab.evalJs(`__perf.begin('after')`); await sleep(12000);
    const after = JSON.parse(await tab.evalJs('JSON.stringify(__perf.end())'));
    console.log(`${NAME === 'visible' ? 'empty sets hidden      ' : 'used-range uploads     '}:`, stats(after));
  } else if (NAME === 'compile') {
    // What a shader program costs on this machine: mark every material for a rebuild and render once. That is
    // exactly what happens the first time anything new appears on screen, only all at once.
    const tab = await b.openTab(url('/?stress=6,100,128,bots'), { width: 1600, height: 900, dpr: 1, preload: PROBE });
    for (let i = 0; i < 120 && !(await tab.evalJs('!!window.__rookfall')); i++) await sleep(500);
    await tab.evalJs('__perf.install()');
    await sleep(3000);
    const r = await tab.evalJs(`(() => {
      const r = window.__rookfall.renderer, gl = r.gl;
      const before = gl.info.programs.length;
      let links = 0; const proto = Object.getPrototypeOf(gl.getContext()); const orig = proto.linkProgram;
      proto.linkProgram = function (...a) { links++; return orig.apply(this, a); };
      r.scene.traverse((o) => { const m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; }); });
      const t0 = performance.now();
      gl.render(r.scene, r.cam.camera);
      const t1 = performance.now();
      proto.linkProgram = orig;
      return { programsBefore: before, programsAfter: gl.info.programs.length, linkedNow: links, blockedMs: +(t1 - t0).toFixed(1) };
    })()`);
    console.log('rebuilding every program in the scene:', r);
    // and what one more program costs, the way a new effect appearing mid-match pays for it
    const one = await tab.evalJs(`(() => {
      const r = window.__rookfall.renderer, gl = r.gl;
      const m = r.scene.children.find((o) => o.isInstancedMesh && o.material).material;
      m.needsUpdate = true;
      const t0 = performance.now(); gl.render(r.scene, r.cam.camera); const t1 = performance.now();
      return +(t1 - t0).toFixed(1);
    })()`);
    console.log('one program rebuilt, frame blocked for', one, 'ms');
  } else if (NAME === 'audio') {
    // The AudioContext the first sound creates: this is the whole cost, measured on its own.
    const tab = await b.openTab(url('/?stress=6,100,128,bots'), { width: 1600, height: 900, dpr: 1, preload: PROBE });
    for (let i = 0; i < 120 && !(await tab.evalJs('!!window.__rookfall')); i++) await sleep(500);
    console.log('creating an AudioContext blocked the main thread for', await tab.evalJs(`(() => { const t0 = performance.now(); const c = new AudioContext(); const t1 = performance.now(); c.close(); return +(t1 - t0).toFixed(1); })()`), 'ms');
    console.log('a second one:', await tab.evalJs(`(() => { const t0 = performance.now(); const c = new AudioContext(); const t1 = performance.now(); c.close(); return +(t1 - t0).toFixed(1); })()`), 'ms');
    console.log('the game\'s own, through audio.unlock():', await tab.evalJs(`(() => { const t0 = performance.now(); window.__rookfall.audio.unlock(); return +(performance.now() - t0).toFixed(1); })()`), 'ms');
  } else {
    console.log('unknown experiment:', NAME);
  }
} finally {
  b.close(); srv.close();
}
process.exit(0);
