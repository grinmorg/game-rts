// Minimal CDP helper shared by smoke scripts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(port = 9333) {
  const bin = CHROME.find((p) => existsSync(p));
  if (!bin) throw new Error('no chrome found');
  const chrome = spawn(bin, [`--remote-debugging-port=${port}`, '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=/tmp/warlets-chrome-${port}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(250); } }
  if (!ver) { chrome.kill(); throw new Error('chrome did not start'); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map();
  const errors = []; const logs = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    const tag = m.sessionId ? m.sessionId.slice(0, 4) : '';
    if (m.method === 'Runtime.consoleAPICalled') { const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' '); logs.push(`[${tag}][${m.params.type}] ${text}`); if (m.params.type === 'error') errors.push(`[${tag}] ${text}`); }
    if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails; errors.push(`[${tag}] EXCEPTION: ${e.text} ${e.exception?.description ?? ''}`); }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`[${tag}] LOG: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const openTab = async (url) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => send(method, params, sessionId);
    await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url });
    const evalJs = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; };
    const click = async (x, y, button = 'left') => { await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }); await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }); };
    const key = async (k, code) => { await S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code ?? k }); await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code ?? k }); };
    const shot = async (file) => { const { writeFileSync } = await import('node:fs'); const r = await S('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.data, 'base64')); };
    const clickText = (re) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => ${re}.test(b.textContent)); if (!b) return 'no button'; b.click(); return 'clicked ' + b.textContent.trim(); })()`);
    return { S, evalJs, click, key, shot, clickText, sessionId };
  };
  const close = () => { ws.close(); chrome.kill(); };
  return { openTab, close, errors, logs };
}
