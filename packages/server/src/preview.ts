import type { IncomingMessage } from 'node:http';
import type { ReplayMeta } from './replays';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** m:ss on the match clock, which divides the match speed out (see formatTime in the client) */
function clock(ticks: number, speed = 1): string {
  const s = Math.floor(ticks / (20 * (speed > 0 ? speed : 1)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const TEXT = {
  en: {
    and: 'and',
    battle: (at: string, n: number) => `Battle at ${at}: ${n} units fell.`,
    moment: (at: string) => `A moment at ${at}.`,
    replay: 'Match replay.',
    match: (map: string, len: string) => `${map}, ${len} match. Watch it in the browser, nothing to install.`,
  },
  ru: {
    and: 'и',
    battle: (at: string, n: number) => `Сражение на ${at}: погибло ${n} юнитов.`,
    moment: (at: string) => `Момент на ${at}.`,
    replay: 'Реплей матча.',
    match: (map: string, len: string) => `${map}, матч ${len}. Смотреть в браузере, без установки.`,
  },
};

/**
 * The page a replay link serves: index.html with Open Graph tags that name the players and the moment,
 * so a link dropped in Telegram or Discord unfurls into what it shows. The crawler's Accept-Language picks
 * the language; the picture is the one shared screenshot.
 */
export function linkPreview(html: string, meta: ReplayMeta, url: URL, req: IncomingMessage): string {
  const lang = /^ru\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'ru' : 'en';
  const tx = TEXT[lang];
  const names = meta.players;
  const who = names.length === 2 ? `${names[0]} vs ${names[1]}` : `${names.slice(0, -1).join(', ')} ${tx.and} ${names[names.length - 1]}`;
  const title = `${who.slice(0, 90)} · Rookfall`;
  const m = Number(url.searchParams.get('m'));
  const t = Number(url.searchParams.get('t'));
  const battle = url.searchParams.has('m') && Number.isInteger(m) ? meta.battles[m] : undefined;
  const lead = battle ? tx.battle(clock(battle.start, meta.speed), battle.deaths)
    : url.searchParams.has('t') && Number.isFinite(t) && t >= 0 ? tx.moment(clock(Math.floor(t) * 20 * (meta.speed ?? 1), meta.speed))
      : tx.replay;
  const description = `${lead} ${tx.match(meta.mapName ?? meta.mapId, clock(meta.ticks, meta.speed))}`;
  const fwdProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const origin = `${fwdProto || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http')}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`;
  const tags = [
    ['og:type', 'website'], ['og:site_name', 'Rookfall'], ['og:title', title], ['og:description', description],
    ['og:image', `${origin}/og.jpg`], ['og:url', `${origin}${url.pathname}${url.search}`],
  ].map(([k, v]) => `<meta property="${k}" content="${esc(v)}" />`);
  tags.push('<meta name="twitter:card" content="summary_large_image" />', `<meta name="description" content="${esc(description)}" />`);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace('</head>', `    ${tags.join('\n    ')}\n  </head>`);
}
