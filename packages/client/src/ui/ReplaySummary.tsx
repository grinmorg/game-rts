import { OFFICIAL_MAPS, ReplayData } from '@pocket-of-empire/sim';
import { formatDate, formatTime, useT } from '../i18n';
import { FetchError, parseReplayLink } from '../game/replayLinks';
import { setLocalReplayServerId } from '../store';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
import { MatchReport, Pennant, ReportPlayer, ShareStatus, rowsFromSummary, shareTitle, useReplayShare } from './MatchReport';

/**
 * A match recorded on an earlier version of the rules: its commands no longer replay into the same match, but the
 * summary written down while it was played still tells it - the table, the charts and the battles, and a link to all
 * of that. One framed sheet: the back note and the title, who played where and when, a quiet word on why there is no
 * playback, the report, and the footer (share; the seal «Сыграть самому» for someone who came by a link).
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
  const winnerTeam = data.result?.winnerTeam ?? -1;
  return (
    <div className="screen rp-screen">
      <MenuBackground />
      <main className="sheet sheet--framed results rp rp--summary" aria-labelledby="rp-sum-title">
        <header className="rp-head">
          <button type="button" className="btn btn--quiet rp-back" onClick={back}><Icon name="back" />{t(play ? 'toMenu' : 'back')}</button>
          <h1 className="h1" id="rp-sum-title">{t('matchSummary')}</h1>
          <p className="lede rp-lede">
            <span>{mapName}</span> · <span className="num">{formatTime(data.tickCount, speed)}</span>
            {data.recordedAt ? <> · <span className="num">{formatDate(data.recordedAt)}</span></> : null}
          </p>
        </header>
        <div className="rp-body">
          <div className="rp-sum__players">
            {players.map((p, i) => <Pennant key={i} name={p.name} color={p.color} split />)}
          </div>
          <p className="rp-sum__note"><span className="badge badge--warn">{t('replayOldBadge')}</span><span>{t('replayOldVersion')}</span></p>
          {summary
            ? <MatchReport summary={summary} players={players} speed={speed} rows={rowsFromSummary(summary, players)} winnerTeam={winnerTeam}
                onShareBattle={(i) => share.share({ m: i }, title)} shareBusy={share.busy} />
            : null}
        </div>
        <footer className="rp-foot">
          <div className="rs-slips"><ShareStatus state={share.state} /></div>
          <button type="button" className="btn btn--quiet" onClick={() => share.share({}, title)} disabled={share.busy}><Icon name="link" />{t('shareMatch')}</button>
          <span className="spacer" />
          {play && <button type="button" className="btn btn--seal" onClick={play}>{t('playYourself')}</button>}
        </footer>
      </main>
    </div>
  );
}

/**
 * A link to a replay that is not there (removed, mistyped) or could not be fetched: a small framed sheet that says
 * which, names the link, and offers the way on - another try for a network failure (the link is still in the address
 * bar, so a reload opens it again), the menu otherwise.
 */
export function LinkErrorScreen({ error, back }: { error: FetchError; back: () => void }) {
  const t = useT();
  const id = typeof location !== 'undefined' ? parseReplayLink(location.search)?.id : undefined;
  const network = error !== 'notFound';
  return (
    <div className="screen rp-screen">
      <MenuBackground />
      <main className="sheet sheet--framed rp-link" role="alert" aria-labelledby="rp-link-title">
        <span className="rp-link__sign" aria-hidden><Icon name={network ? 'warning' : 'link'} /></span>
        <h1 className="h2" id="rp-link-title">{t(network ? 'linkFailedTitle' : 'linkNotFoundTitle')}</h1>
        <p className="rp-link__text">{t(network ? 'linkFailedText' : 'linkNotFoundText')}</p>
        {id && <p className="rp-link__id">{t('linkWas', { id })}</p>}
        <div className="rp-link__foot">
          {network
            ? <><button type="button" className="btn btn--secondary" onClick={back}>{t('toMenu')}</button>
                <button type="button" className="btn btn--seal" onClick={() => location.reload()}>{t('retry')}</button></>
            : <button type="button" className="btn btn--seal" onClick={back}>{t('toMenu')}</button>}
        </div>
      </main>
    </div>
  );
}
