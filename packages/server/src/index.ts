import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ReplayData } from '@rookfall/sim';
import { Lobby } from './lobby';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, 'data');
// Версия сборки: sha коммита, зашитый в образ (Dockerfile ARG GIT_SHA). По нему ops/deploy.sh
// проверяет, что после переключения контейнера отвечает именно новая версия.
const VERSION = process.env.GIT_SHA ?? 'dev';
const REPLAY_DIR = join(DATA_DIR, 'replays');
const PROFILES_FILE = join(DATA_DIR, 'profiles.json');
const CLIENT_DIST = join(ROOT, 'packages/client/dist');
mkdirSync(REPLAY_DIR, { recursive: true });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
};

function saveReplay(replay: ReplayData): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  replay.id = id;
  writeFileSync(join(REPLAY_DIR, `${id}.json`), JSON.stringify(replay));
  console.log(`[replay] saved ${id} (${replay.tickCount} ticks)`);
  return id;
}

const lobby = new Lobby({ saveReplay, profilesFile: PROFILES_FILE });

// the ladder is written to disk debounced; make sure a restart never loses the last games
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { lobby.ratings.flush(); process.exit(0); });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (path === '/api/health') return json(res, { ok: true, version: VERSION, rooms: lobby.rooms.size, clients: lobby.clients.size });
  if (path === '/api/rooms') return json(res, lobby.publicRooms());
  if (path === '/api/leaderboard') return json(res, lobby.ratings.top(50));
  if (path === '/api/replays') {
    const list = readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const d = JSON.parse(readFileSync(join(REPLAY_DIR, f), 'utf8')) as ReplayData;
        return { id: d.id ?? f.replace('.json', ''), mapId: d.setup.mapId, players: d.setup.players.map((p) => p.name), ticks: d.tickCount, winnerTeam: d.result?.winnerTeam ?? -1, recordedAt: d.recordedAt, speed: d.setup.speed };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b!.recordedAt - a!.recordedAt));
    return json(res, list.slice(0, 100));
  }
  if (path.startsWith('/api/replays/')) {
    const id = path.slice('/api/replays/'.length).replace(/[^a-z0-9-]/gi, '');
    const file = join(REPLAY_DIR, `${id}.json`);
    if (!existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', 'application/json');
    return res.end(readFileSync(file));
  }
  // static client (production build)
  if (existsSync(CLIENT_DIST)) {
    let file = normalize(join(CLIENT_DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(CLIENT_DIST)) { res.statusCode = 403; return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(CLIENT_DIST, 'index.html');
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    if (file.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); // после деплоя index.html должен сразу подхватить новые хэшированные чанки
    return res.end(readFileSync(file));
  }
  res.statusCode = 404;
  res.end('client not built - run `pnpm build` or use `pnpm dev`');
});

function json(res: import('node:http').ServerResponse, body: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', (ws) => lobby.handleConnection(ws));

server.listen(PORT, () => {
  console.log(`[server] Rookfall game server on http://localhost:${PORT}  (ws: /ws, replays: ${REPLAY_DIR}, ladder: ${PROFILES_FILE})`);
  if (!existsSync(CLIENT_DIST)) console.log('[server] no client build found; in dev the Vite server on :5173 proxies /ws and /api here');
});
