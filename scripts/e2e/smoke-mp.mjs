// Multiplayer e2e: tab A creates a room, tab B joins through the invite link, host adds a bot and starts;
// both clients must tick in lockstep; chat, orders, elimination, game over and replay saving are exercised.
// Note: headless Chrome pauses requestAnimationFrame in background tabs, so we bring a tab to front before measuring it.
import { launch, sleep } from './cdp.mjs';
const URL_ = process.argv[2] ?? 'http://localhost:5173/';
const OUT = process.argv[3] ?? '/tmp/smoke-mp.png';
const b = await launch('multiplayer');
let fail = false;
const check = (cond, msg) => { console.log(cond ? 'OK  ' : 'FAIL', msg); if (!cond) fail = true; };
const setInput = (sel, value) => `(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return 'no input ' + ${JSON.stringify(sel)}; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`;
const front = async (tab, ms = 2500) => { await tab.S('Page.bringToFront'); await sleep(ms); };
const stat = (tab) => tab.evalJs(`(() => ({ canvas: !!document.querySelector('canvas.game-canvas'), players: [...document.querySelectorAll('.hud-player')].map(p => p.textContent.trim()), time: document.querySelector('.hud-timer')?.textContent, fps: document.querySelector('.hud-fps')?.textContent, gold: document.querySelector('.hud-res .gold')?.textContent, overlay: document.querySelector('.results h1')?.textContent ?? null, msgs: [...document.querySelectorAll('.hud-msgs .msg')].map(x => x.textContent) }))()`);
const secs = (s) => { const [m, ss] = (s ?? '0:0').split(':').map(Number); return m * 60 + ss; };
try {
  const A = await b.openTab(URL_);
  await sleep(2500);
  console.log('A', await A.clickText('/Multiplayer|Мультиплеер/'));
  await sleep(1500);
  console.log('A', await A.clickText('/Create room|Создать комнату/'));
  await sleep(800);
  const code = await A.evalJs(`document.querySelector('.card h2 .badge')?.textContent ?? ''`);
  console.log('room code:', code);
  if (code.length !== 5) throw new Error('no room code');
  const B = await b.openTab(`${URL_}?room=${code}`);
  await sleep(2500);
  const slotsA = await A.evalJs(`[...document.querySelectorAll('.slot .name')].map(x => x.textContent)`);
  // A's guest name, so the replay check below can pick out this run's match. The slot reads "Guest1234 (You) · Host"
  // and a guest name never has a space in it; settings only reach localStorage once something is changed there.
  const nameA = (slotsA[0] ?? '').split(' ')[0];
  check(slotsA.length === 2, `B joined via invite link (A sees ${JSON.stringify(slotsA)})`);
  await A.evalJs(`(() => { const b = [...document.querySelectorAll('.map-card')].find(b => /Crossroads/.test(b.textContent)); b?.click(); return !!b; })()`);
  await sleep(600);
  console.log('A', await A.evalJs(`(() => { const sel = [...document.querySelectorAll('.slot select')].find(s => [...s.options].some(o => o.value === 'bot') && s.value === 'open'); if (!sel) return 'no open slot select'; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'bot'); sel.dispatchEvent(new Event('change', { bubbles: true })); return 'bot set'; })()`));
  await sleep(600);
  await B.evalJs(setInput('.chat input', 'gl hf'));
  await B.evalJs(`(() => { const i = document.querySelector('.chat input'); i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(500);
  check(/gl hf/.test(await A.evalJs(`document.querySelector('.chat-log')?.textContent`)), 'lobby chat delivered to A');
  console.log('A', await A.clickText('/^Start$|^Старт$/'));
  await front(A, 5000);
  const sa = await stat(A);
  console.log('A:', JSON.stringify({ ...sa, msgs: undefined }));
  check(sa.canvas && sa.players.length === 3, 'A is in game with 3 players');
  await A.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 200, button: 'left', clickCount: 1 });
  await A.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 700, button: 'left' });
  await A.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1100, y: 700, button: 'left', clickCount: 1 });
  await sleep(200);
  await A.click(900, 300, 'right');
  await sleep(1500);
  await front(B, 5000);
  const sb = await stat(B);
  console.log('B:', JSON.stringify({ ...sb, msgs: undefined }));
  check(sb.canvas && sb.players.length === 3, 'B is in game with 3 players');
  await B.key('Enter', 'Enter'); await sleep(300);
  await B.evalJs(setInput('.hud-chat-input input', 'hello from B'));
  await B.evalJs(`(() => { const i = document.querySelector('.hud-chat-input input'); i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(1500);
  await front(A, 4000);
  const sa2 = await stat(A);
  console.log('A2 (after catch-up):', JSON.stringify({ ...sa2, msgs: undefined }));
  check(sa2.msgs.some((m) => /hello from B/.test(m)), 'in-game chat delivered to A');
  check(secs(sa2.time) >= 8, `A caught up with the server tick (${sa2.time})`);
  // B surrenders: 3-player FFA -> B is eliminated, match continues; B gets a defeat screen with "watch"
  await front(B, 1500);
  await B.key('Escape', 'Escape'); await sleep(300);
  console.log('B', await B.clickText('/^Surrender$|^Сдаться$/')); await sleep(200);
  console.log('B', await B.clickText('/Surrender this match|Сдаться в этом матче/'));
  await sleep(2500);
  const sb3 = await stat(B);
  check(/Defeat|Поражение/.test(sb3.overlay ?? ''), `B sees defeat overlay after surrender (${sb3.overlay})`);
  console.log('B', await B.clickText('/^Watch$|^Смотреть$/'));
  await sleep(500);
  check(!(await stat(B)).overlay, 'B can dismiss the overlay and keep watching');
  await front(A, 2500);
  const sa3 = await stat(A);
  check(sa3.msgs.some((m) => /eliminated|выбывает/.test(m)), `A sees elimination message (${JSON.stringify(sa3.msgs.slice(-2))})`);
  check(!sa3.overlay, 'A keeps playing vs the bot');
  // A surrenders too -> bot wins, game over for everyone, replay saved on the server
  await A.key('Escape', 'Escape'); await sleep(300);
  console.log('A', await A.clickText('/^Surrender$|^Сдаться$/')); await sleep(200);
  console.log('A', await A.clickText('/Surrender this match|Сдаться в этом матче/'));
  await sleep(3000);
  const sa4 = await stat(A);
  check(/Defeat|Поражение/.test(sa4.overlay ?? ''), `A sees game over (${sa4.overlay})`);
  await A.shot(OUT);
  // by this run's own players, not by the total: a server left behind by an earlier run writes into the same
  // DATA_DIR, and counting every file there turns somebody else's match into a failure here
  const rep = await (await fetch('http://localhost:8080/api/replays')).json();
  const mine = nameA ? rep.filter((r) => r.players.includes(nameA)) : [];
  check(mine.length === 1, `server saved this match's replay (${mine.length} of ${rep.length}) ${mine[0] ? `${mine[0].players.join(' vs ')} ${mine[0].ticks} ticks winner team ${mine[0].winnerTeam}` : ''}`);
  console.log('A', await A.clickText('/Leave to menu|Выйти в меню/'));
  await sleep(1500);
  const roomH2 = await A.evalJs(`document.querySelector('.card h2')?.textContent ?? null`);
  check(roomH2 !== null && roomH2.includes(code), `A is back in the room lobby (${roomH2})`);
  console.log('screenshot:', OUT);
} catch (e) {
  console.log('E2E FAIL:', e.message); fail = true;
} finally {
  console.log('console errors:', b.errors.length);
  for (const e of b.errors.slice(0, 15)) console.log('  ', e.slice(0, 400));
  b.close();
  if (b.errors.length || fail) process.exitCode = 1;
}
