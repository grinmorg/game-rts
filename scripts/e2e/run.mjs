// End-to-end runner: starts the game server and the Vite dev server, drives the real client in headless Chrome
// (skirmish + two-tab multiplayer), then shuts everything down. Usage: pnpm e2e
import { spawn, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const SERVER_PORT = 8080, CLIENT_PORT = 5173;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPort(port) {
  try { execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' }); } catch { /* nothing listening */ }
}
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ } await sleep(500); }
  return false;
}
function run(script, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

killPort(SERVER_PORT); killPort(CLIENT_PORT);
// a previous run that was interrupted may have left a headless browser pinning the CPU; start from clean
execSync(`node ${join(here, 'clean.mjs')}`, { stdio: 'inherit' });
// the multiplayer smoke asserts the server wrote exactly one replay, so the last run's must not still be there
rmSync(join(root, 'data/e2e/replays'), { recursive: true, force: true });
const server = spawn(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/server/src/index.ts')], { env: { ...process.env, PORT: String(SERVER_PORT), DATA_DIR: join(root, 'data/e2e') }, stdio: 'ignore' });
const client = spawn(join(root, 'node_modules/.bin/vite'), ['--port', String(CLIENT_PORT), '--strictPort'], { cwd: join(root, 'packages/client'), stdio: 'ignore' });
let code = 1;
try {
  const up = (await waitFor(`http://localhost:${SERVER_PORT}/api/health`)) && (await waitFor(`http://localhost:${CLIENT_PORT}/`));
  if (!up) throw new Error('servers did not start');
  const url = `http://localhost:${CLIENT_PORT}/`;
  console.log('\n=== e2e: skirmish ===');
  const a = await run('smoke.mjs', url, join(root, 'data/e2e/skirmish.png'));
  console.log('\n=== e2e: multiplayer ===');
  const b = await run('smoke-mp.mjs', url, join(root, 'data/e2e/multiplayer.png'));
  code = a || b;
  console.log(`\n=== e2e ${code ? 'FAILED' : 'PASSED'} (screenshots in data/e2e) ===`);
} catch (e) {
  console.error('e2e error:', e.message);
} finally {
  server.kill('SIGKILL'); client.kill('SIGKILL');
  killPort(SERVER_PORT); killPort(CLIENT_PORT);
  // belt and braces: the smoke scripts close their own browser, this catches one that died mid-close
  try { execSync(`node ${join(here, 'clean.mjs')}`, { stdio: 'inherit' }); } catch { /* nothing to clean */ }
}
process.exit(code);
