// Frame profiler injected into the running game by scripts/perf/run.mjs.
//
// It is loaded *before* the page's own scripts (Page.addScriptToEvaluateOnNewDocument) so that it can wrap
// React's scheduler before React grabs its MessageChannel - React commits happen between animation frames, so
// without that hook the HUD's cost looks like idle time. Everything else (the simulation step, renderer.sync,
// renderer.render, the minimap, the HUD build) is wrapped later, once `window.__rookfall` exists, by calling
// `__perf.install()`.
//
// Per frame it records: the frame's wall-clock length, the time spent in each phase, and enough state
// (entities, draw calls, heap, sim tick, what the simulation reported that frame) to explain a spike after
// the fact. Timing is `performance.now()` around function calls - a few dozen calls per frame, well under the
// noise floor of the thing being measured.
(() => {
  if (window.__perf) return;
  const now = () => performance.now();
  const CAP = 80000;
  /** one number per frame per column; kept in typed arrays so collecting never allocates */
  const COLS = [
    't',        // timestamp of the frame start (ms)
    'total',    // this frame start -> next frame start
    'busy',     // sum of the measured phases
    'gap',      // frame start - end of the last measured phase of the previous frame (idle + paint + GC)
    'sim',      // session.update: bots + simulation steps
    'step',     // simulation steps alone (sim.step + bot think), summed over the steps this frame ran
    'steps',    // how many simulation ticks ran in this frame
    'input',    // input.update + pruneSelection
    'sync',     // renderer.sync: walk the world, fill the instance buffers
    'paths',    // renderer.drawPaths (inside sync): route tracing on the view's flow fields
    'render',   // renderer.render: three.js draw submission
    'hud',      // view.publish: build the HUD state object
    'react',    // React scheduler work (the HUD re-render), measured through its MessageChannel
    'mini',     // view.drawMinimap
    'events',   // simulation events delivered this frame
    'units',    // live units
    'ents',     // live entities
    'calls',    // WebGL draw calls
    'tris',     // triangles submitted
    'heap',     // JS heap in use (MB)
    'tick',     // simulation tick
    'parts',    // live particles
    'dashes',   // route dash instances
    'known',    // remembered buildings (fog ghosts)
    'sel',      // selected entities
    // --- inside the simulation step (subsets of `step`) -------------------------------------------------
    'bot',      // bot AI think()
    'field',    // Pathfinder.fieldFor: seeding and expanding flow fields
    'fieldn',   // how many fieldFor calls
    'expand',   // Pathfinder.expand alone (the Dijkstra frontier)
    'region',   // region labelling / nearestReachable
    'pfset',    // passability edits: setFootprint / setTerrain / setGates / refresh
    'grid',     // spatial grid rebuild
    'fog',      // fog of war update
    'pop',      // population recount
    'deaths',   // death processing
    // --- inside the view ---------------------------------------------------------------------------------
    'vfield',   // the renderer's own flow fields, for drawing routes
    'vcopy',    // Pathfinder.copyFrom: the view re-copying the passability layers
    'terrain',  // terrain colour refresh + decor rebuild after a fire
    // --- the simulation step, split by the systems it runs in order (anchored on the methods we can see) ---
    'cmds',     // step entry -> grid rebuild: applying this tick's commands
    'move',     // updateUnits + resolveMovement + updateProjectilesAndZones
    'fires',    // updateFires
    'build',    // updateBuildings
    'gates',    // updateGates
    'victory',  // checkVictory + whatever is left of the step
    'query',    // SpatialGrid.query, called from inside the systems
    'queryn',   // how many of those
    // --- WebGL traffic ------------------------------------------------------------------------------------
    'glLink',   // programs linked this frame (a compile stall is the classic one-off hitch)
    'glUp',     // MB pushed into buffers with bufferData/bufferSubData
    'glUpN',    // how many buffer uploads
    'glTex',    // MB pushed into textures
  ];
  const buf = {};
  for (const c of COLS) buf[c] = new Float64Array(CAP);
  let n = 0;                       // frames recorded in the current window
  let collecting = false;
  let name = '';
  const acc = {};                  // phase accumulators for the frame being built
  const clearAcc = () => { for (const c of COLS) acc[c] = 0; };
  clearAcc();
  let lastEnd = 0;                 // end of the last measured phase (for `gap`)
  let frameStart = 0;
  let notable = [];                // interesting simulation events, tagged with the frame they landed in
  let marks = [];                  // scenario-supplied markers ("selected 300 units")

  // ---- React scheduler: its work runs in a MessageChannel task after the animation frame -----------------
  const RealMC = window.MessageChannel;
  window.MessageChannel = function PerfMessageChannel() {
    const mc = new RealMC();
    const port = mc.port1;
    let handler = null;
    Object.defineProperty(port, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (fn) => {
        const first = handler === null;
        handler = fn;
        if (!first) return; // React sets it once; a second setter call must not add a second listener
        port.addEventListener('message', (ev) => {
          if (!handler) return;
          const t0 = now();
          try { handler.call(port, ev); } finally { const d = now() - t0; acc.react += d; lastEnd = now(); }
        });
        port.start();
      },
    });
    return mc;
  };

  // ---- frame boundary -----------------------------------------------------------------------------------
  // Our callback is registered before the game registers its own, and every rAF callback re-registers itself
  // at the end of the queue, so this one keeps running first for the life of the page: a stable frame start.
  const beat = () => {
    requestAnimationFrame(beat);
    const t = now();
    if (collecting && frameStart > 0) commit(t);
    frameStart = t;
    clearAcc();
    acc.gap = lastEnd > 0 ? t - lastEnd : 0;
  };
  requestAnimationFrame(beat);

  function commit(t) {
    if (n >= CAP) return;
    const v = window.__rookfall;
    const r = v && v.renderer;
    acc.t = frameStart;
    acc.total = t - frameStart;
    acc.busy = acc.sim + acc.input + acc.sync + acc.render + acc.hud + acc.react + acc.mini;
    if (v) {
      const w = v.sim.world;
      let units = 0, ents = 0;
      // full entity scan every 10th frame only: it is O(maxId) and would show up in the numbers it measures
      if (n % 10 === 0) {
        for (let id = 0; id < w.maxId; id++) if (w.alive[id]) { ents++; if (w.kind[id] === 1) units++; }
        lastUnits = units; lastEnts = ents;
      }
      acc.units = lastUnits; acc.ents = lastEnts;
      acc.tick = v.sim.tick;
      acc.sel = v.input.selected.length;
      acc.known = r.known ? r.known.size : 0;
      acc.parts = r.particles && r.particles.live ? r.particles.live.length : 0;
      acc.dashes = r.dashSet ? r.dashSet.count : 0;
      acc.calls = r.gl.info.render.calls;
      acc.tris = r.gl.info.render.triangles;
    }
    acc.heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0;
    for (const c of COLS) buf[c][n] = acc[c];
    n++;
  }
  let lastUnits = 0, lastEnts = 0;

  // ---- wrapping -----------------------------------------------------------------------------------------
  const wrapped = new WeakSet();
  function wrap(obj, key, slot, tag) {
    if (!obj || typeof obj[key] !== 'function') return `missing ${tag || key}`;
    const orig = obj[key];
    if (orig.__perfWrapped) return 'already';
    const fn = function (...args) {
      const t0 = now();
      try { return orig.apply(this, args); } finally { const t1 = now(); acc[slot] += t1 - t0; lastEnd = t1; }
    };
    fn.__perfWrapped = true;
    obj[key] = fn;
    wrapped.add(fn);
    return 'ok';
  }

  /**
   * Wrap `key` so that the time between the previous anchor and this call lands in `before`, and the call
   * itself in `self`. The simulation's systems are module functions we cannot reach, but they run between
   * methods we can, so the gaps between anchors are the systems' own time.
   */
  let anchor = 0;
  function wrapAnchor(obj, key, before, self) {
    if (!obj || typeof obj[key] !== 'function') return `missing ${key}`;
    const orig = obj[key];
    if (orig.__perfAnchored) return 'already';
    const fn = function (...args) {
      const t0 = now();
      if (before && anchor > 0) acc[before] += t0 - anchor;
      try { return orig.apply(this, args); } finally { const t1 = now(); if (self) acc[self] += t1 - t0; anchor = t1; lastEnd = t1; }
    };
    fn.__perfAnchored = true;
    obj[key] = fn;
    return 'ok';
  }

  let installed = false;
  function install() {
    const v = window.__rookfall;
    if (!v) return 'no view';
    if (installed && v.__perfInstalled) return 'already';
    const s = v.session, r = v.renderer;
    const log = [];
    log.push('sim:' + wrap(s, 'update', 'sim'));
    log.push('step:' + wrap(s, 'step', 'step'));
    log.push('input:' + wrap(v.input, 'update', 'input'));
    log.push('prune:' + wrap(v.input, 'pruneSelection', 'input'));
    log.push('sync:' + wrap(r, 'sync', 'sync'));
    log.push('paths:' + wrap(r, 'drawPaths', 'paths'));
    log.push('render:' + wrap(r, 'render', 'render'));
    log.push('hud:' + wrap(v, 'publish', 'hud'));
    log.push('mini:' + wrap(v, 'drawMinimap', 'mini'));
    // `step` is nested inside `update`; count how many ticks ran so a sim-bound frame is recognisable
    const origStep = s.step;
    s.step = function (...a) { acc.steps++; return origStep.apply(this, a); };
    s.step.__perfWrapped = true;
    // simulation events: what happened on the frame that hitched
    const prevOnStep = s.onStep;
    s.onStep = (events) => {
      acc.events += events.length;
      for (const e of events) {
        if (NOTABLE.has(e.type)) notable.push({ f: n, tick: v.sim.tick, type: e.type, owner: e.owner, v: e.v });
      }
      return prevOnStep ? prevOnStep(events) : undefined;
    };
    // second level: what a long simulation tick was actually doing. The systems themselves are module
    // functions and cannot be reached from here, but everything they call that can be expensive is a method
    // on an object we can see, so `step` minus these is "the systems' own work".
    const p = v.sim.path;
    wrap(p, 'fieldFor', 'field');
    wrap(p, 'expand', 'expand');
    wrap(p, 'nearestReachable', 'region');
    wrap(p, 'rebuildRegions', 'region');
    wrap(p, 'setFootprint', 'pfset');
    wrap(p, 'setTerrain', 'pfset');
    wrap(p, 'setGates', 'pfset');
    wrap(p, 'refresh', 'pfset');
    const origField = p.fieldFor;
    p.fieldFor = function (...a) { acc.fieldn++; return origField.apply(this, a); };
    p.fieldFor.__perfWrapped = true;
    // the step, in the order sim.step() runs things
    const origStep2 = s.step;
    s.step = function (...a) { anchor = now(); return origStep2.apply(this, a); };
    wrapAnchor(v.sim.grid, 'rebuild', 'cmds', 'grid');
    wrapAnchor(p, 'beginTick', '', '');
    wrapAnchor(v.sim, 'updateFires', 'move', 'fires');
    wrapAnchor(v.sim, 'processDeaths', 'build', 'deaths');
    wrapAnchor(v.sim, 'recountPop', 'gates', 'pop');
    wrapAnchor(v.sim, 'updateFog', '', 'fog');
    wrapAnchor(v.sim, 'checkVictory', '', 'victory');
    const origQuery = v.sim.grid.query;
    v.sim.grid.query = function (...a) { const t0 = now(); acc.queryn++; try { return origQuery.apply(this, a); } finally { acc.query += now() - t0; } };
    // the view's own copy of the pathfinder (routes) and the terrain rebuild after a fire
    const vp = r.viewPath;
    if (vp) { wrap(vp, 'fieldFor', 'vfield'); wrap(vp, 'copyFrom', 'vcopy'); }
    wrap(r, 'refreshTerrainColors', 'terrain');
    wrap(r, 'rebuildDecor', 'terrain');
    // bots think inside the step; `s.bots` is the local session's array
    if (Array.isArray(s.bots)) for (const b of s.bots) wrap(b, 'think', 'bot');
    installed = true;
    v.__perfInstalled = true;
    return log.join(' ');
  }
  // EventType values worth correlating with a spike (see packages/sim/src/types.ts)
  const NOTABLE = new Set([4 /*BuildingPlaced*/, 5 /*BuildingComplete*/, 9 /*Ability*/, 10 /*PlayerEliminated*/, 12 /*ResearchComplete*/, 14 /*Fire*/, 15 /*BuildingDestroyed*/, 19 /*ForestBurnt*/, 20 /*AgeUp*/]);

  window.__perf = {
    install,
    begin(label) {
      install();
      name = label; n = 0; notable = []; marks = []; collecting = true;
      if (window.__rookfall) window.__rookfall.renderer.gl.info.autoReset = true;
      return label;
    },
    mark(text) { marks.push({ f: n, t: now(), text }); return text; },
    end() {
      collecting = false;
      const out = { name, frames: n, cols: {}, notable, marks, gpu: gpuInfo() };
      for (const c of COLS) out.cols[c] = Array.from(buf[c].subarray(0, n)).map((x) => Math.round(x * 1000) / 1000);
      return out;
    },
    /** live peek, for progress logging while a scenario runs */
    peek() {
      const a = Array.from(buf.total.subarray(Math.max(0, n - 120), n)).sort((x, y) => x - y);
      return { frames: n, p50: a.length ? a[a.length >> 1] : 0, max: a.length ? a[a.length - 1] : 0 };
    },
  };

  /**
   * Buffer and texture traffic, and program links. Uploads are what an instanced renderer spends its frame
   * on when the instance buffers are pushed whole; a link is a one-off stall the first time something new is
   * drawn. Patched on the prototype, so it survives a new context.
   */
  function installGl(P) {
    if (!P || P.__perfGl) return;
    P.__perfGl = true;
    const size = (x) => (x == null ? 0 : typeof x === 'number' ? x : x.byteLength ?? 0);
    {
      const orig = P.bufferData;
      P.bufferData = function (...a) { acc.glUp += size(a[1]) / 1048576; acc.glUpN++; return orig.apply(this, a); };
    }
    {
      // WebGL2 has a five-argument form that uploads a slice: gl.bufferSubData(target, offset, src, srcOffset,
      // length). Counting the source array there would report the whole buffer for a partial upload.
      const orig = P.bufferSubData;
      P.bufferSubData = function (...a) {
        const src = a[2];
        const bytes = a.length >= 5 && typeof a[4] === 'number' ? a[4] * (src.BYTES_PER_ELEMENT ?? 1) : size(src);
        acc.glUp += bytes / 1048576; acc.glUpN++;
        return orig.apply(this, a);
      };
    }
    for (const name of ['texImage2D', 'texSubImage2D']) {
      const orig = P[name];
      P[name] = function (...a) { const last = a[a.length - 1]; acc.glTex += size(last && last.byteLength ? last : null) / 1048576; return orig.apply(this, a); };
    }
    const link = P.linkProgram;
    P.linkProgram = function (...a) { acc.glLink++; return link.apply(this, a); };
  }

  // the context does not exist yet at document start, but its prototype does - and the first program links
  // happen on the very first frames, long before there is a view to install anything else on
  installGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  installGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  function gpuInfo() {
    try {
      const gl = window.__rookfall.renderer.gl.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { return '?'; }
  }
})();
