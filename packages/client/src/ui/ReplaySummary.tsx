import { OFFICIAL_MAPS, ReplayData } from '@rookfall/sim';
import { formatTime, useT } from '../i18n';
import { FetchError } from '../game/replayLinks';
import { setLocalReplayServerId } from '../store';
import { MenuBackground } from './MainMenu';
import { MatchReport, ReportPlayer, ShareStatus, rowsFromSummary, shareTitle, useReplayShare } from './MatchReport';

/**
 * A match recorded on an earlier version of the rules: its commands no longer replay into the same
 * match, but the summary written down while it was played still tells it - the table, the charts and
 * the battles, and a link to all of that.
 */
export function SummaryScreen({ data, serverId, localId, back, play }: {
  data: ReplayData; serverId?: string; localId?: string; back: () => void; play?: () => void;
}) {
  const t = useT();
  const players: ReportPlayer[] = data.setup.players.map((p) => ({ name: p.name, color: p.color, team: p.team }));
  const speed = data.setup.speed ?? 1;
  const summary = data.summary ?? null;
  const share = useReplayShare(() => data, serverId, (id) => { if (localId) setLocalReplayServerId(localId, id); });
  const title = shareTitle(players);
  const mapName = OFFICIAL_MAPS.find((m) => m.id === data.setup.mapId)?.name ?? data.mapName ?? data.setup.mapId;
  return (
    <div className="screen">
      <MenuBackground />
      <div className="card results">
        <button className="back" onClick={back}>{t(play ? 'toMenu' : 'back')}</button>
        <h2>{players.map((p) => p.name).join(players.length === 2 ? ' vs ' : ', ')}</h2>
        <p className="muted small summary-meta">{mapName} · {formatTime(data.tickCount, speed)}{data.recordedAt ? ` · ${new Date(data.recordedAt).toLocaleString()}` : ''}</p>
        <div className="replay-warn static" role="status">⚠️ {t('replayOldVersion')}</div>
        {summary && <MatchReport summary={summary} players={players} speed={speed} rows={rowsFromSummary(summary, players)}
          onShareBattle={(i) => share.share({ m: i }, title)} shareBusy={share.busy} />}
        <ShareStatus state={share.state} />
        <div className="row end">
          <button onClick={() => share.share({}, title)} disabled={share.busy}>🔗 {t('shareMatch')}</button>
          {play && <button className="primary" onClick={play}>🎮 {t('playYourself')}</button>}
        </div>
      </div>
    </div>
  );
}

/** a link to a replay that is not there (removed, mistyped) or could not be fetched */
export function LinkErrorScreen({ error, back }: { error: FetchError; back: () => void }) {
  const t = useT();
  return (
    <div className="screen">
      <MenuBackground />
      <div className="card narrow">
        <h2>{t('replays')}</h2>
        <p>{t(error === 'notFound' ? 'replayNotFound' : 'replayLoadFailed')}</p>
        <div className="row end"><button className="primary" onClick={back}>{t('toMenu')}</button></div>
      </div>
    </div>
  );
}
