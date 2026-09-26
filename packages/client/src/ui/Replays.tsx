import { useEffect, useState } from 'react';
import { OFFICIAL_MAPS, ReplayData, SIM_VERSION } from '@rookfall/sim';
import { formatTime, useT } from '../i18n';
import { ReplayLaunch } from '../game/replayLinks';
import { LocalReplayMeta, deleteLocalReplay, downloadReplay, listLocalReplays, loadLocalReplay, setLocalReplayServerId } from '../store';
import { MenuBackground } from './MainMenu';
import { ShareStatus, shareTitle, useReplayShare } from './MatchReport';

interface ServerReplay { id: string; mapId: string; mapName?: string; players: string[]; ticks: number; winnerTeam: number; recordedAt: number; speed?: number; version?: number }
interface RowData { id: string; mapId: string; mapName?: string; players: string[]; ticks: number; recordedAt: number; speed?: number; version?: number }

export function Replays({ back, watch }: { back: () => void; watch: (data: ReplayData, launch: ReplayLaunch) => void }) {
  const t = useT();
  const [local, setLocal] = useState<LocalReplayMeta[]>(() => listLocalReplays());
  const [server, setServer] = useState<ServerReplay[] | null>(null);

  useEffect(() => {
    fetch('/api/replays').then((r) => (r.ok ? r.json() : [])).then(setServer).catch(() => setServer([]));
  }, []);

  const watchServer = async (id: string) => {
    const r = await fetch(`/api/replays/${id}`);
    if (r.ok) watch(await r.json(), { serverId: id });
  };
  const importFile = (f: File | null) => {
    if (!f) return;
    f.text().then((txt) => { try { watch(JSON.parse(txt), {}); } catch { /* ignore */ } });
  };
  const mapName = (r: RowData) => OFFICIAL_MAPS.find((m) => m.id === r.mapId)?.name ?? r.mapName ?? r.mapId;

  return (
    <div className="screen">
      <MenuBackground />
      <div className="card">
        <button className="back" onClick={back}>{t('back')}</button>
        <h2>{t('replays')}</h2>
        <div className="row between">
          <h3>{t('localReplays')}</h3>
          <label className="small">
            <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => importFile(e.target.files?.[0] ?? null)} />
            <span className="badge" style={{ cursor: 'pointer' }}>{t('importReplay')}</span>
          </label>
        </div>
        <div className="list">
          {local.length === 0 && <div className="muted small">{t('noReplays')}</div>}
          {local.map((r) => (
            <Row key={r.id} r={r} mapName={mapName(r)} serverId={r.serverId} load={() => loadLocalReplay(r.id)}
              onWatch={() => { const d = loadLocalReplay(r.id); if (d) watch(d, { localId: r.id, serverId: r.serverId }); }}
              onUploaded={(id) => { setLocalReplayServerId(r.id, id); setLocal(listLocalReplays()); }}
              onDelete={() => { deleteLocalReplay(r.id); setLocal(listLocalReplays()); }}
              onDownload={() => { const d = loadLocalReplay(r.id); if (d) downloadReplay(d); }} />
          ))}
        </div>
        <h3>{t('serverReplays')}</h3>
        <div className="list">
          {server === null && <div className="muted small">{t('loading')}</div>}
          {server && server.length === 0 && <div className="muted small">{t('noReplays')}</div>}
          {server?.map((r) => <Row key={r.id} r={r} mapName={mapName(r)} serverId={r.id} onWatch={() => watchServer(r.id)} />)}
        </div>
      </div>
    </div>
  );
}

/**
 * One replay in a list. A recording on an earlier version says so - its button opens the summary rather
 * than a playback - and the link button uploads a local recording the first time it is shared.
 */
function Row({ r, mapName, serverId, load, onWatch, onUploaded, onDelete, onDownload }: {
  r: RowData; mapName: string; serverId?: string; load?: () => ReplayData | null;
  onWatch: () => void; onUploaded?: (id: string) => void; onDelete?: () => void; onDownload?: () => void;
}) {
  const t = useT();
  const share = useReplayShare(() => load?.() ?? null, serverId, onUploaded);
  const old = r.version !== undefined && r.version !== SIM_VERSION;
  return (
    <div className="list-item replay-row">
      <div className="grow">
        <div><b>{r.players.join(' vs ')}</b>{old && <span className="badge old">{t('replayOldBadge')}</span>}</div>
        <div className="small muted">{mapName} · {formatTime(r.ticks, r.speed ?? 1)} · {new Date(r.recordedAt).toLocaleString()}</div>
        <ShareStatus state={share.state} />
      </div>
      <button className="primary" onClick={onWatch}>{old ? `📊 ${t('summaryTab')}` : t('watch')}</button>
      <button onClick={() => share.share({}, shareTitle(r.players.map((name) => ({ name, color: 0, team: 0 }))))} disabled={share.busy} title={t('shareMatch')} aria-label={t('shareMatch')}>🔗</button>
      {onDownload && <button onClick={onDownload} title={t('download')} aria-label={t('download')}>⬇</button>}
      {onDelete && <button className="danger" onClick={onDelete} title={t('delete')} aria-label={t('delete')}>✕</button>}
    </div>
  );
}
