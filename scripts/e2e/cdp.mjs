// Minimal CDP helper shared by smoke scripts.
//
// Headless Chrome here renders WebGL through SwiftShader, on the CPU, and the game runs an animation frame
// loop that never stops on its own - so a browser that outlives its script does not idle, it pins every core
// until someone notices. Everything below is arranged so that cannot happen:
//
//   * the debugger talks over a *pipe*, not a TCP port. Chrome exits by itself the moment the pipe closes,
//     which the kernel does when this process dies - including a SIGKILL we never get to handle. It also
//     means two runs can never collide on a port and end up driving each other's browser.
//   * the browser is its own process group, and `close` takes the group down (SIGTERM, then SIGKILL), so no
//     GPU or renderer helper is left behind by a root that ignores the first signal.
//   * exit, SIGINT, SIGTERM and an unhandled throw all run the same cleanup.
//   * a watchdog kills the browser after `ttlMs` even if the script hangs rather than crashes.
//   * the throwaway profile is removed on the way out, and stale ones from earlier runs are swept.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** throwaway profiles are named with this; `sweepProfiles` and `scripts/e2e/clean.mjs` look for it */
export const PROFILE_PREFIX = 'rookfall-chrome-';
/**
 * Where those profiles live. New ones go in the first entry; all of them are swept, because `os.tmpdir()`
 * is `/var/folders/...` on macOS while earlier runs of this harness wrote to `/tmp` directly.
 */
export const PROFILE_DIRS = [...new Set(['/tmp', tmpdir()])];
/** a browser is killed after this long no matter what the script is doing; a hung test must not idle at 100 % */
const DEFAULT_TTL_MS = 8 * 60_000;

/**
 * Delete leftover profile directories older than `maxAgeMs`. A directory in use belongs to a live browser
 * that still holds a lock on it, and those are young, so age alone is a safe enough filter.
 */
export function sweepProfiles(maxAgeMs = 60 * 60_000) {
  let removed = 0, bytes = 0;
  for (const dir of PROFILE_DIRS) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (Date.now() - st.mtimeMs < maxAgeMs) continue;
        bytes += du(p);
        rmSync(p, { recursive: true, force: true });
        removed++;
      } catch { /* someone else got there first */ }
    }
  }
  return { removed, bytes };
}

function du(p) {
  let n = 0;
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of readdirSync(p)) n += du(join(p, e));
  } catch { /* vanished mid-walk */ }
  return n;
}

/** every browser this process started, so the exit hooks can take them all down */
const live = new Set();
let hooked = false;
function installExitHooks() {
  if (hooked) return;
  hooked = true;
  const killAll = () => { for (const kill of [...live]) kill(); };
  // 'exit' covers the ordinary end, a thrown error and an unhandled rejection alike - node runs it on the way
  // out in every one of those cases. Handling the last two here instead would swallow node's own non-zero
  // exit code and turn a real failure into a silent pass.
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAll(); process.exit(1); });
  }
}

/**
 * Start a headless browser and return `{ openTab, close, errors, logs }`. `label` only names the temp
 * profile, so several browsers can run side by side without any shared resource to fight over.
 */
export async function launch(label = 'e2e', { ttlMs = DEFAULT_TTL_MS, gpu = false } = {}) {
  const bin = CHROME.find((p) => existsSync(p));
  if (!bin) throw new Error('no chrome found');
  installExitHooks();
  sweepProfiles();

  const profile = mkdtempSync(join(PROFILE_DIRS[0], `${PROFILE_PREFIX}${label}-`));
  const chrome = spawn(bin, [
    '--remote-debugging-pipe', '--headless=new',
    // Smoke tests want a renderer that behaves identically everywhere; the perf harness wants the real card,
    // because SwiftShader's CPU rasterizer says nothing about frame times on the machine the game is played on.
    ...(gpu ? ['--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']),
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, 'about:blank',
  ], {
    // fd 3 is what we write to Chrome, fd 4 what Chrome writes back; its own group so `close` can take the
    // whole tree down rather than just the root process
    stdio: ['ignore', 'ignore', process.env.CDP_DEBUG ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const [, , chromeErr, toChrome, fromChrome] = chrome.stdio;
  if (chromeErr) chromeErr.on('data', (d) => process.stderr.write(`[chrome] ${d}`));
  let id = 0; const pending = new Map();
  const errors = []; const logs = [];
  let closed = false;

  /** extra listeners for raw protocol events, keyed by method name (the perf harness reads Tracing.*) */
  const subs = new Map();
  const on = (method, fn) => { if (!subs.has(method)) subs.set(method, new Set()); subs.get(method).add(fn); return () => subs.get(method).delete(fn); };

  const handle = (m) => {
    if (m.method && subs.has(m.method)) for (const fn of subs.get(m.method)) fn(m.params, m.sessionId);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    const tag = m.sessionId ? m.sessionId.slice(0, 4) : '';
    if (m.method === 'Runtime.consoleAPICalled') { const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' '); logs.push(`[${tag}][${m.params.type}] ${text}`); if (m.params.type === 'error') errors.push(`[${tag}] ${text}`); }
    if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails; errors.push(`[${tag}] EXCEPTION: ${e.text} ${e.exception?.description ?? ''}`); }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`[${tag}] LOG: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  // the pipe carries NUL-terminated JSON, and a message may arrive split across reads
  let buf = '';
  fromChrome.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      if (raw) try { handle(JSON.parse(raw)); } catch { /* not ours */ }
    }
  });

  /** SIGTERM the whole group, then make sure with SIGKILL; safe to call twice */
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(watchdog);
    live.delete(close);
    for (const { rej } of pending.values()) rej(new Error('browser closed'));
    pending.clear();
    try { toChrome.end(); } catch { /* already gone */ }
    const signal = (sig) => { try { process.kill(-chrome.pid, sig); } catch { try { chrome.kill(sig); } catch { /* gone */ } } };
    signal('SIGTERM');
    signal('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  live.add(close);
  const watchdog = setTimeout(() => {
    console.error(`[cdp] browser "${label}" hit its ${Math.round(ttlMs / 1000)}s limit and was killed - a hung script must not sit there burning CPU`);
    close();
  }, ttlMs);
  if (watchdog.unref) watchdog.unref();
  chrome.on('exit', (code, signal) => {
    // an exit we did not ask for is worth a line: without it the script only reports "browser closed"
    if (!closed) console.error(`[cdp] browser "${label}" exited on its own (code ${code}, signal ${signal})`);
    closed || close();
  });

  const send = (method, params = {}, sessionId) => {
    const p = new Promise((res, rej) => {
      if (closed) { rej(new Error('browser closed')); return; }
      const i = ++id; pending.set(i, { res, rej });
      toChrome.write(JSON.stringify({ id: i, method, params, sessionId }) + '\0');
    });
    // `close` rejects whatever is still in flight, and a caller that has already moved on would leave that
    // rejection unhandled - which crashes the script and makes a clean run look like a failure. An awaiting
    // caller still sees the error; this only marks the promise as attended to.
    p.catch(() => {});
    return p;
  };
  // the first call also proves the pipe is up
  for (let i = 0; ; i++) {
    try { await Promise.race([send('Browser.getVersion'), sleep(1000).then(() => { throw new Error('timeout'); })]); break; }
    catch (e) { if (i >= 20 || closed) { close(); throw new Error(`chrome did not start: ${e.message}`); } await sleep(250); }
  }

  const openTab = async (url, { width = 1400, height = 900, dpr = 1, preload = null } = {}) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => send(method, params, sessionId);
    await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    // `preload` runs before any of the page's own scripts - the perf probe needs that to wrap React's
    // scheduler before React is loaded
    if (preload) await S('Page.addScriptToEvaluateOnNewDocument', { source: preload });
    await S('Page.navigate', { url });
    const evalJs = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; };
    const click = async (x, y, button = 'left') => { await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }); await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }); };
    const key = async (k, code) => { await S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code ?? k }); await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code ?? k }); };
    const shot = async (file) => { const { writeFileSync } = await import('node:fs'); const r = await S('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.data, 'base64')); };
    const clickText = (re) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => ${re}.test(b.textContent)); if (!b) return 'no button'; b.click(); return 'clicked ' + b.textContent.trim(); })()`);
    return { S, evalJs, click, key, shot, clickText, sessionId };
  };
  return { openTab, close, errors, logs, profile, on, send };
}
