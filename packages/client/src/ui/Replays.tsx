import { useEffect, useState } from 'react';
import { OFFICIAL_MAPS, ReplayData } from '@warlets/sim';
import { formatTime, useT } from '../i18n';
import { LocalReplayMeta, deleteLocalReplay, downloadReplay, listLocalReplays, loadLocalReplay } from '../store';
import { MenuBackground } from './MainMenu';

interface ServerReplay { id: string; mapId: string; players: string[]; ticks: number; winnerTeam: number; recordedAt: number }

export function Replays({ back, watch }: { back: () => void; watch: (data: ReplayData) => void }) {
  const t = useT();
  const [local, setLocal] = useState<LocalReplayMeta[]>(() => listLocalReplays());
  const [server, setServer] = useState<ServerReplay[] | null>(null);

  useEffect(() => {
    fetch('/api/replays').then((r) => (r.ok ? r.json() : [])).then(setServer).catch(() => setServer([]));
  }, []);

  const watchServer = async (id: string) => {
    const r = await fetch(`/api/replays/${id}`);
    if (r.ok) watch(await r.json());
  };
  const importFile = (f: File | null) => {
    if (!f) return;
    f.text().then((txt) => { try { watch(JSON.parse(txt)); } catch { /* ignore */ } });
  };
  const mapName = (id: string) => OFFICIAL_MAPS.find((m) => m.id === id)?.name ?? id;

  const Row = ({ r, onWatch, onDelete, onDownload }: { r: { id: string; mapId: string; players: string[]; ticks: number; recordedAt: number }; onWatch: () => void; onDelete?: () => void; onDownload?: () => void }) => (
    <div className="list-item">
      <div className="grow">
        <div><b>{r.players.join(' vs ')}</b></div>
        <div className="small muted">{mapName(r.mapId)} · {formatTime(r.ticks)} · {new Date(r.recordedAt).toLocaleString()}</div>
      </div>
      <button className="primary" onClick={onWatch}>{t('watch')}</button>
      {onDownload && <button onClick={onDownload}>⬇</button>}
      {onDelete && <button className="danger" onClick={onDelete}>✕</button>}
    </div>
  );

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
            <Row key={r.id} r={r} onWatch={() => { const d = loadLocalReplay(r.id); if (d) watch(d); }}
              onDelete={() => { deleteLocalReplay(r.id); setLocal(listLocalReplays()); }}
              onDownload={() => { const d = loadLocalReplay(r.id); if (d) downloadReplay(d); }} />
          ))}
        </div>
        <h3>{t('serverReplays')}</h3>
        <div className="list">
          {server === null && <div className="muted small">{t('loading')}</div>}
          {server && server.length === 0 && <div className="muted small">{t('noReplays')}</div>}
          {server?.map((r) => <Row key={r.id} r={r} onWatch={() => watchServer(r.id)} />)}
        </div>
      </div>
    </div>
  );
}
