import { useEffect, useRef, useState } from 'react';
import { OFFICIAL_MAPS, ReplayData, SIM_VERSION } from '@pocket-of-empire/sim';
import { formatTime, useT } from '../i18n';
import { ReplayLaunch } from '../game/replayLinks';
import { STORAGE_PREFIX } from '../legacyStorage';
import { getSettings } from '../settings';
import { LocalReplayMeta, deleteLocalReplay, downloadReplay, listLocalReplays, loadLocalReplay, setLocalReplayServerId } from '../store';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
import { Pennant, ShareStatus, Slip, shareTitle, useReplayShare } from './MatchReport';

interface ServerReplay { id: string; mapId: string; mapName?: string; players: string[]; ticks: number; winnerTeam: number; recordedAt: number; speed?: number; version?: number }
interface RowData { id: string; mapId: string; mapName?: string; players: string[]; ticks: number; recordedAt: number; speed?: number; version?: number }

/** what a saved replay's list entry leaves out: the players' colours, teams and bots, and how the match ended */
interface LocalDetails { colors: number[]; teams: number[]; bots: boolean[]; result?: { winnerTeam: number } }

/**
 * One pass over the stored recordings for what the list's meta does not carry. listLocalReplays parses the same
 * array once already; a second parse is cheap next to opening every replay one by one for its colours.
 */
function readLocalDetails(): Map<string, LocalDetails> {
  const out = new Map<string, LocalDetails>();
  try {
    const arr = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}replays`) ?? '[]') as { meta?: { id?: string }; data?: ReplayData }[];
    for (const r of arr) {
      const ps = r.data?.setup?.players;
      if (!r.meta?.id || !Array.isArray(ps)) continue;
      out.set(r.meta.id, { colors: ps.map((p) => p.color), teams: ps.map((p) => p.team), bots: ps.map((p) => !!p.isBot), result: r.data?.result });
    }
  } catch { /* unreadable storage: the rows go without colours and results */ }
  return out;
}

/** a file that is a replay at least in shape: the setup with players and the command frames */
function looksLikeReplay(x: unknown): x is ReplayData {
  const d = x as Partial<ReplayData> | null;
  return !!d && typeof d === 'object' && !!d.setup && Array.isArray(d.setup.players) && d.setup.players.length > 0 && Array.isArray(d.frames) && typeof d.tickCount === 'number';
}

/** "сегодня, 14:20" / "вчера, 09:10" / "7 окт., 14:20" / "7 окт. 2025 г." - a date to recognise, not to audit */
function shortDate(ts: number, today: string, yesterday: string): string {
  const lang = getSettings().lang;
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= day0) return `${today}, ${time}`;
  if (ts >= day0 - 86_400_000) return `${yesterday}, ${time}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.toLocaleDateString(lang, { day: 'numeric', month: 'short' })}, ${time}`;
  return d.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The saved and the shared recordings: one framed sheet, the back note and the title on top, the local list (with
 * the file import) and the server's below. Every failure says so where it happened - a file that is not a replay,
 * a server that does not answer, a recording that would not load - instead of passing for an empty list.
 */
export function Replays({ back, watch }: { back: () => void; watch: (data: ReplayData, launch: ReplayLaunch) => void }) {
  const t = useT();
  const [local, setLocal] = useState<LocalReplayMeta[]>(() => listLocalReplays());
  const [details, setDetails] = useState(() => readLocalDetails());
  const [server, setServer] = useState<ServerReplay[] | 'failed' | null>(null);
  const [importError, setImportError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadServer = () => {
    setServer(null);
    fetch('/api/replays').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((list) => setServer(Array.isArray(list) ? list : 'failed')).catch(() => setServer('failed'));
  };
  useEffect(loadServer, []);
  const refreshLocal = () => { setLocal(listLocalReplays()); setDetails(readLocalDetails()); };

  /** a server recording can be several MB: the row shows it is on its way, and says so if it does not come */
  const watchServer = async (id: string): Promise<boolean> => {
    try {
      const r = await fetch(`/api/replays/${encodeURIComponent(id)}`);
      if (!r.ok) return false;
      const data: unknown = await r.json();
      if (!looksLikeReplay(data)) return false;
      watch(data, { serverId: id });
      return true;
    } catch { return false; }
  };
  const importFile = (f: File | null) => {
    if (!f) return;
    setImportError(false);
    f.text().then((txt) => {
      let data: unknown = null;
      try { data = JSON.parse(txt); } catch { /* reported below */ }
      if (looksLikeReplay(data)) watch(data, {});
      else setImportError(true);
    }).catch(() => setImportError(true)).finally(() => { if (fileRef.current) fileRef.current.value = ''; });
  };
  const mapName = (r: RowData) => OFFICIAL_MAPS.find((m) => m.id === r.mapId)?.name ?? r.mapName ?? r.mapId;

  return (
    <div className="screen rp-screen">
      <MenuBackground />
      <main className="sheet sheet--framed rp" aria-labelledby="rp-title">
        <header className="rp-head">
          <button type="button" className="btn btn--quiet rp-back" onClick={back}><Icon name="back" />{t('back')}</button>
          <h1 className="h1" id="rp-title">{t('replays')}</h1>
          <p className="lede rp-lede">{t('replaysLede')}</p>
        </header>
        <div className="rp-body">
          <section aria-labelledby="rp-local">
            <div className="legend-head rp-section-head">
              <h2 className="legend-head__name" id="rp-local">{t('localReplays')}</h2>
              {local.length > 0 && <span className="legend-head__meta num">{local.length}</span>}
              <label className="btn btn--secondary btn--small rp-import">
                <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => importFile(e.target.files?.[0] ?? null)} />
                <Icon name="import" />{t('importReplay')}
              </label>
            </div>
            {importError && <Slip kind="error">{t('importBad')}</Slip>}
            {local.length === 0 ? (
              <div className="rp-empty">
                <span className="rp-empty__sign" aria-hidden><Icon name="replay" /></span>
                <div>
                  <p className="rp-empty__title">{t('noReplays')}</p>
                  <p className="rp-empty__hint">{t('noReplaysHint')}</p>
                </div>
              </div>
            ) : (
              <ul className="rp-list">
                {local.map((r) => (
                  <Row key={r.id} r={r} mapName={mapName(r)} serverId={r.serverId} details={details.get(r.id)} load={() => loadLocalReplay(r.id)}
                    onWatch={async () => { const d = loadLocalReplay(r.id); if (!d) return false; watch(d, { localId: r.id, serverId: r.serverId }); return true; }}
                    onUploaded={(id) => { setLocalReplayServerId(r.id, id); refreshLocal(); }}
                    onDelete={() => { deleteLocalReplay(r.id); refreshLocal(); }}
                    onDownload={() => { const d = loadLocalReplay(r.id); if (d) downloadReplay(d); }} />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="rp-server">
            <div className="legend-head rp-section-head">
              <h2 className="legend-head__name" id="rp-server">{t('serverReplays')}</h2>
              {Array.isArray(server) && server.length > 0 && <span className="legend-head__meta num">{server.length}</span>}
            </div>
            {server === null && <p className="rp-note" role="status"><span className="spinner" aria-hidden />{t('loading')}</p>}
            {server === 'failed' && (
              <div className="rp-note rp-note--error" role="alert">
                <Icon name="error" /><span>{t('replaysServerFailed')}</span>
                <button type="button" className="btn btn--quiet btn--small" onClick={loadServer}><Icon name="replay" />{t('retry')}</button>
              </div>
            )}
            {Array.isArray(server) && server.length === 0 && <p className="rp-note">{t('noServerReplays')}</p>}
            {Array.isArray(server) && server.length > 0 && (
              <ul className="rp-list">
                {server.map((r) => <Row key={r.id} r={r} mapName={mapName(r)} serverId={r.id} onWatch={() => watchServer(r.id)} />)}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

/** how a saved match ended, for the one who played it: their win or loss, else who won */
function resultBadge(names: string[], d: LocalDetails | undefined, t: ReturnType<typeof useT>): { text: string; ok?: boolean } | null {
  if (!d) return null;
  if (!d.result) return { text: t('resultUnfinished') };
  const w = d.result.winnerTeam;
  if (w < 0) return { text: t('resultDraw') };
  const me = getSettings().name;
  let mine = names.findIndex((n, i) => !d.bots[i] && n === me);
  if (mine < 0 && d.bots.filter((b) => !b).length === 1) mine = d.bots.indexOf(false);
  if (mine >= 0) return d.teams[mine] === w ? { text: t('resultWin'), ok: true } : { text: t('resultLoss') };
  const won = names.filter((_, i) => d.teams[i] === w);
  return { text: won.length === 1 ? t('resultWinner', { name: won[0] }) : t('resultTeamWon', { n: w + 1 }) };
}

/** pennants shown on a row before the rest is counted */
const ROW_PLAYERS = 4;

/**
 * One replay in a list: the players as pennants, then map · length · when, with badges for how it ended and for an
 * earlier version of the rules (its button opens the summary instead of a playback). Watching is the row's compact
 * seal; sharing, the file and deleting are icon buttons, the last one behind a confirm in the row itself.
 */
function Row({ r, mapName, serverId, details, load, onWatch, onUploaded, onDelete, onDownload }: {
  r: RowData; mapName: string; serverId?: string; details?: LocalDetails; load?: () => ReplayData | null;
  onWatch: () => Promise<boolean>; onUploaded?: (id: string) => void; onDelete?: () => void; onDownload?: () => void;
}) {
  const t = useT();
  const share = useReplayShare(() => load?.() ?? null, serverId, onUploaded);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  // the confirm takes the focus, and a cancel gives it back to the delete button
  useEffect(() => {
    if (confirmDelete) cancelRef.current?.focus();
    else if (asked.current) deleteRef.current?.focus();
    asked.current = confirmDelete;
  }, [confirmDelete]);
  const old = r.version !== undefined && r.version !== SIM_VERSION;
  const result = resultBadge(r.players, details, t);
  const open = async () => {
    if (opening) return;
    setFailed(false);
    setOpening(true);
    const ok = await onWatch();
    setOpening(false);
    if (!ok) setFailed(true);
  };
  const shown = r.players.slice(0, ROW_PLAYERS);
  return (
    <li className="row-item rp-row">
      <div className="row-item__main rp-row__main">
        <div className="rp-row__players">
          {shown.map((name, i) => <Pennant key={i} name={name} color={details?.colors[i]} split />)}
          {r.players.length > shown.length && <span className="rp-row__more num">+{r.players.length - shown.length}</span>}
        </div>
        <div className="row-item__meta rp-row__meta">
          <span>{mapName} · <span className="num">{formatTime(r.ticks, r.speed ?? 1)}</span> · {shortDate(r.recordedAt, t('today'), t('yesterday'))}</span>
          {result && <span className={`badge${result.ok ? ' badge--ok' : ''}`}>{result.text}</span>}
          {old && <span className="badge badge--warn old">{t('replayOldBadge')}</span>}
        </div>
      </div>
      {confirmDelete ? (
        <div className="rp-row__actions rp-row__confirm" role="group" aria-label={t('deleteReplayConfirm')}>
          <span className="rp-row__ask">{t('deleteReplayConfirm')}</span>
          <button ref={cancelRef} type="button" className="btn btn--secondary btn--small" onClick={() => setConfirmDelete(false)}>{t('cancel')}</button>
          <button type="button" className="btn btn--danger btn--small" onClick={() => { setConfirmDelete(false); onDelete?.(); }}><Icon name="delete" />{t('delete')}</button>
        </div>
      ) : (
        <div className="rp-row__actions">
          {old
            ? <button type="button" className="btn btn--secondary btn--compact" onClick={open} disabled={opening}>{opening ? <span className="spinner" aria-hidden /> : <Icon name="summary" />}{t('summaryTab')}</button>
            : <button type="button" className="btn btn--seal btn--compact" onClick={open} disabled={opening} aria-busy={opening || undefined}>{opening && <span className="spinner" aria-hidden />}{t('watch')}</button>}
          <button type="button" className="btn btn--quiet btn--icon" onClick={() => share.share({}, shareTitle(r.players.map((name) => ({ name, color: 0, team: 0 }))))}
            disabled={share.busy} title={t('shareMatch')} aria-label={t('shareMatch')}><Icon name="link" /></button>
          {onDownload && <button type="button" className="btn btn--quiet btn--icon" onClick={onDownload} title={t('download')} aria-label={t('download')}><Icon name="download" /></button>}
          {onDelete && <button ref={deleteRef} type="button" className="btn btn--quiet btn--icon rp-row__delete" onClick={() => setConfirmDelete(true)} title={t('delete')} aria-label={t('delete')}><Icon name="delete" /></button>}
        </div>
      )}
      {(share.state.kind !== 'idle' || failed) && (
        <div className="rp-row__status">
          <ShareStatus state={share.state} />
          {failed && <Slip kind="error">{t('replayLoadFailed')}</Slip>}
        </div>
      )}
    </li>
  );
}
