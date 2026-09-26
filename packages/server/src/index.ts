import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Throttle, clientIp } from './accounts';
import { Lobby } from './lobby';
import { linkPreview } from './preview';
import { ReplayStore, UPLOAD_MAX_BYTES } from './replays';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, 'data');
// Версия сборки: sha коммита, зашитый в образ (Dockerfile ARG GIT_SHA). По нему ops/deploy.sh
// проверяет, что после переключения контейнера отвечает именно новая версия.
const VERSION = process.env.GIT_SHA ?? 'dev';
const REPLAY_DIR = join(DATA_DIR, 'replays');
const PROFILES_FILE = join(DATA_DIR, 'profiles.json');
const ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json');
const CLIENT_DIST = join(ROOT, 'packages/client/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
};

const replays = new ReplayStore(REPLAY_DIR);
/** a player shares a skirmish now and then; a script uploading in a loop is stopped here */
const uploads = new Throttle(20, 60 * 60_000);

const lobby = new Lobby({ saveReplay: (r) => replays.save(r), profilesFile: PROFILES_FILE, accountsFile: ACCOUNTS_FILE });

// the ladder and the accounts are written to disk debounced; make sure a restart never loses the last changes
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { lobby.ratings.flush(); lobby.accounts.flush(); process.exit(0); });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (path === '/api/health') return json(res, { ok: true, version: VERSION, rooms: lobby.rooms.size, clients: lobby.clients.size, online: lobby.onlineCount() });
  if (path === '/api/rooms') return json(res, lobby.publicRooms());
  if (path === '/api/leaderboard') return json(res, lobby.ratings.top(50));
  if (path === '/api/replays' && req.method === 'POST') { upload(req, res); return; }
  if (path === '/api/replays') return json(res, replays.list(100));
  if (path.startsWith('/api/replays/')) {
    const body = replays.read(path.slice('/api/replays/'.length));
    if (!body) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', 'application/json');
    return res.end(body);
  }
  // static client (production build)
  if (existsSync(CLIENT_DIST)) {
    let file = normalize(join(CLIENT_DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(CLIENT_DIST)) { res.statusCode = 403; return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(CLIENT_DIST, 'index.html');
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    if (file.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); // после деплоя index.html должен сразу подхватить новые хэшированные чанки
    // a link to a replay unfurls in a messenger as the match it points at, not as a bare "Rookfall"
    const replayId = url.searchParams.get('replay');
    if (replayId && file.endsWith('index.html')) {
      const meta = replays.meta(replayId);
      if (meta) return res.end(linkPreview(readFileSync(file, 'utf8'), meta, url, req));
    }
    return res.end(readFileSync(file));
  }
  res.statusCode = 404;
  res.end('client not built - run `pnpm build` or use `pnpm dev`');
});

function json(res: import('node:http').ServerResponse, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** POST /api/replays: a skirmish replay to share. Answers { id } or { error } */
function upload(req: IncomingMessage, res: import('node:http').ServerResponse): void {
  const ip = clientIp(req);
  if (!uploads.allow(ip)) { json(res, { error: 'tooMany' }, 429); req.resume(); return; }
  const chunks: Buffer[] = [];
  let size = 0, over = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > UPLOAD_MAX_BYTES) { over = true; chunks.length = 0; return; }
    if (!over) chunks.push(c);
  });
  req.on('end', () => {
    if (over) return json(res, { error: 'tooBig' }, 413);
    uploads.hit(ip);
    const out = replays.upload(Buffer.concat(chunks).toString('utf8'));
    if ('error' in out) return json(res, out, out.error === 'tooBig' ? 413 : 400);
    json(res, out);
  });
  req.on('error', () => { res.statusCode = 400; res.end(); });
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
// A peer that vanished without a goodbye (laptop lid shut, phone out of signal) never fires 'close' and
// would sit in the online counter for good. Ping every 30 s and drop whoever did not answer the last one;
// browsers answer protocol pings on their own, even from a throttled background tab.
const alive = new WeakSet<WebSocket>();
wss.on('connection', (ws, req) => {
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  lobby.handleConnection(ws, req);
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`[server] Rookfall game server on http://localhost:${PORT}  (ws: /ws, replays: ${REPLAY_DIR}, ladder: ${PROFILES_FILE}, accounts: ${ACCOUNTS_FILE})`);
  if (!existsSync(CLIENT_DIST)) console.log('[server] no client build found; in dev the Vite server on :5173 proxies /ws and /api here');
});
