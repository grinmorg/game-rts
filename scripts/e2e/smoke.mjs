// Skirmish smoke test: economy ticks up without input; selection, build menu, edge scrolling & castle defence are checked.
import { launch, sleep } from './cdp.mjs';
const URL_ = process.argv[2] ?? 'http://localhost:5173/';
const OUT = process.argv[3] ?? '/tmp/smoke.png';
const b = await launch('skirmish');
let fail = false;
const check = (cond, msg) => { console.log(cond ? 'OK  ' : 'FAIL', msg); if (!cond) fail = true; };
try {
  const tab = await b.openTab(URL_);
  await sleep(2500);
  console.log('page:', await tab.evalJs('document.title'));
  console.log(await tab.clickText('/AI|ИИ/'));
  await sleep(600);
  console.log(await tab.clickText('/Start|Старт/'));
  await sleep(12000);
  const h1 = await tab.evalJs(`(() => ({ fps: document.querySelector('.hud-fps')?.textContent, gold: document.querySelector('.hud-res .gold')?.textContent, time: document.querySelector('.hud-timer')?.textContent }))()`);
  console.log('after 12s:', JSON.stringify(h1));
  check(Number((h1.gold ?? '').replace(/\D/g, '')) > 300, 'gold increased without input (workers auto-mine)');

  // --- edge scrolling direction: mouse at right edge must move the camera target to +x; top edge to -z (screen up)
  const cam = () => tab.evalJs(`(() => { const c = window.__rookfall.renderer.cam.target; return { x: c.x, z: c.z, yaw: window.__rookfall.renderer.cam.yaw }; })()`);
  // spawns are random, so start from the map centre - a base on the right edge leaves no room to scroll right
  await tab.evalJs(`(() => { const v = window.__rookfall, m = v.sim.map; v.centerOn(m.w / 2, m.h / 2); })()`);
  await sleep(300);
  const c0 = await cam();
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1395, y: 450 }); await sleep(700);
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 450 }); await sleep(100);
  const c1 = await cam();
  check(c1.x > c0.x + 1, `right edge scroll moves view right (x ${c0.x.toFixed(1)} -> ${c1.x.toFixed(1)})`);
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 3 }); await sleep(700);
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 450 }); await sleep(100);
  const c2 = await cam();
  check(c2.z < c1.z - 1, `top edge scroll moves view up (z ${c1.z.toFixed(1)} -> ${c2.z.toFixed(1)})`);
  // WASD: 'd' must move right as well (edge scrolling above may have parked the camera on the map border)
  await tab.evalJs(`(() => { const v = window.__rookfall, m = v.sim.map; v.centerOn(m.w / 2, m.h / 2); })()`);
  await sleep(300);
  const c2b = await cam();
  await tab.S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD' }); await sleep(400);
  await tab.S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD' }); await sleep(100);
  const c3 = await cam();
  check(c3.x > c2b.x + 0.5, `D key scrolls right (x ${c2b.x.toFixed(1)} -> ${c3.x.toFixed(1)})`);
  // minimap orientation: the projected screen position of a point with larger map y must be lower on screen
  const orient = await tab.evalJs(`(() => { const v = window.__rookfall; const t = v.renderer.cam.target; const a = { sx: 0, sy: 0, visible: false }, b2 = { sx: 0, sy: 0, visible: false }; v.renderer.worldToScreen(t.x, t.z - 3, 0, a); v.renderer.worldToScreen(t.x, t.z + 3, 0, b2); const r = { sx: 0, sy: 0, visible: false }; v.renderer.worldToScreen(t.x + 3, t.z, 0, r); return { upY: a.sy, downY: b2.sy, rightX: r.sx, centerX: 700 }; })()`);
  check(orient.upY < orient.downY, `smaller map y is higher on screen (${orient.upY.toFixed(0)} < ${orient.downY.toFixed(0)}) - matches minimap`);
  check(orient.rightX > orient.centerX, `larger map x is to the right on screen (${orient.rightX.toFixed(0)})`);
  await tab.key('Backspace', 'Backspace');

  // --- castle defence: spawn an enemy soldier next to our castle through the debug hook (local sim) and watch it take damage
  const dmg = await tab.evalJs(`(async () => { const v = window.__rookfall; const sim = v.sim, w = sim.world; let castle = -1; for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === 2 && w.owner[id] === v.mySlot && w.type[id] === 0) castle = id;
    const enemy = sim.players.findIndex(p => p.id !== v.mySlot);
    const u = sim.spawnUnit(enemy, 1, w.x[castle] + (4 << 16), w.y[castle]);
    const hp0 = w.hp[u]; const t0 = sim.tick;
    await new Promise(r => setTimeout(r, 3000));
    return { castle, enemy, hp0, hp1: w.alive[u] ? w.hp[u] : 0, ticks: sim.tick - t0, castleHp: w.hp[castle], castleMax: w.maxHp[castle] }; })()`);
  console.log('castle defence:', JSON.stringify(dmg));
  check(dmg.hp1 < dmg.hp0, 'castle shoots an enemy soldier standing next to it');
  // --- range circle: selecting the castle must draw one range ring; a worker none
  const rings = await tab.evalJs(`(async () => { const v = window.__rookfall, w = v.sim.world; let castle = -1, worker = -1; for (let id = 0; id < w.maxId; id++) { if (!w.alive[id] || w.owner[id] !== v.mySlot) continue; if (w.kind[id] === 2 && w.type[id] === 0) castle = id; if (w.kind[id] === 1 && w.type[id] === 0) worker = id; }
    v.input.setSelection([castle]); await new Promise(r => setTimeout(r, 150)); const a = v.renderer.rangeSet.count;
    v.input.setSelection([worker]); await new Promise(r => setTimeout(r, 150)); const b2 = v.renderer.rangeSet.count;
    v.input.setSelection([]); return { castleRings: a, workerRings: b2 }; })()`);
  check(rings.castleRings === 1 && rings.workerRings === 0, `range ring drawn for castle only (${JSON.stringify(rings)})`);

  // --- selection & build flow (re-centre the camera on our castle first)
  await tab.evalJs(`(() => { const v = window.__rookfall, w = v.sim.world; for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === 2 && w.owner[id] === v.mySlot && w.type[id] === 0) { v.centerOn(w.x[id] / 65536, w.y[id] / 65536); return id; } return -1; })()`);
  await sleep(400);
  await tab.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 200, button: 'left', clickCount: 1 });
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 700, button: 'left' });
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1100, y: 700, button: 'left', clickCount: 1 });
  await sleep(300);
  const sel = await tab.evalJs(`(() => ({ sel: document.querySelector('.sel-info h4')?.textContent ?? null, groups: [...document.querySelectorAll('.sel-unit .n')].map(x => x.textContent), panel: [...document.querySelectorAll('.cmd-btn')].map(b => b.textContent.trim()).join('|') }))()`);
  console.log('box selection:', JSON.stringify(sel));
  await tab.key('b', 'KeyB'); await sleep(200);
  console.log('build menu:', await tab.evalJs(`[...document.querySelectorAll('.cmd-btn')].map(b => b.textContent.trim()).join('|')`));
  await tab.key('h', 'KeyH'); await sleep(200);
  const goldBefore = Number((await tab.evalJs(`document.querySelector('.hud-res .gold')?.textContent`)).replace(/\D/g, ''));
  await tab.click(560, 560); await sleep(600);
  const goldAfter = Number((await tab.evalJs(`document.querySelector('.hud-res .gold')?.textContent`)).replace(/\D/g, ''));
  check(goldAfter <= goldBefore - 60 + 16, `placing a house deducted gold (${goldBefore} -> ${goldAfter})`);
  await tab.S('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: -120 });
  await sleep(1500);
  await tab.shot(OUT);
  await tab.key('Escape', 'Escape'); await sleep(300);
  check(await tab.evalJs(`!!document.querySelector('.overlay')`), 'Esc opens the pause menu');
  await tab.key('Escape', 'Escape');
  console.log('screenshot:', OUT);
} catch (e) {
  console.log('SMOKE FAIL:', e.message); fail = true;
} finally {
  console.log('console errors:', b.errors.length);
  for (const e of b.errors.slice(0, 15)) console.log('  ', e.slice(0, 400));
  b.close();
  if (b.errors.length || fail) process.exitCode = 1;
}
