import { useEffect, useState } from 'react';
import {
  LeaderboardEntry, PLACEMENT_GAMES, QueueState, RANKED_MAP_ID, RANKED_SPEEDS, RankTier, RankedProfile, RankedResult,
  levelProgress, tierFor, tierProgress,
} from '@rookfall/protocol';
import { TKey, useT } from '../i18n';
import { net } from '../net/client';
import { useAccount } from './useAccount';
import { MenuBackground } from './MainMenu';
import { MapPreview } from './MapPreview';

/** the "gold" tier would collide with the gold resource string, so it gets its own key */
export function tierKey(tier: RankTier): TKey { return (tier.key === 'gold' ? 'gold_tier' : tier.key) as TKey; }

export function TierBadge({ profile, size = 'big' }: { profile: RankedProfile; size?: 'big' | 'small' }) {
  const t = useT();
  const tier = tierFor(profile.rating, profile.games);
  return (
    <span className={`tier ${tier.key} ${size}`} title={t('rank')}>
      <span className="tier-icon">{tier.icon}</span>
      <span className="tier-name">{t(tierKey(tier))}</span>
    </span>
  );
}

/** rating, level and record - the card at the top of the ranked screen and on the results panel */
export function ProfileCard({ profile }: { profile: RankedProfile }) {
  const t = useT();
  const lvl = levelProgress(profile.xp);
  const tp = tierProgress(profile.rating);
  const placing = profile.games < PLACEMENT_GAMES;
  const winRate = profile.games ? Math.round((profile.wins / profile.games) * 100) : 0;
  return (
    <div className="profile-card">
      <div className="profile-head">
        <TierBadge profile={profile} />
        <div className="grow">
          <div className="rating-row">
            <b className="rating-value">{Math.round(profile.rating)}</b>
            <span className="muted small">{t('rating')}</span>
          </div>
          {placing ? (
            <div className="small muted">{t('placementLeft', { n: PLACEMENT_GAMES - profile.games })}</div>
          ) : (
            <div className="bar" title={tp.next ? `${Math.round(tp.next.min)}` : ''}><div style={{ width: `${Math.round(tp.pct * 100)}%` }} /></div>
          )}
        </div>
        <div className="level-badge" title={t('ratingLevel')}>
          <span className="lvl-n">{lvl.level}</span>
          <span className="lvl-l">{t('ratingLevel')}</span>
        </div>
      </div>
      <div className="bar xp" title={`${lvl.into} / ${lvl.need} ${t('xpGained')}`}><div style={{ width: `${Math.round(lvl.pct * 100)}%` }} /></div>
      <div className="profile-stats small">
        <span>{t('record')}: <b>{profile.wins}</b>–<b>{profile.losses}</b>{profile.draws ? `–${profile.draws}` : ''}</span>
        <span>{t('winRate')}: <b>{winRate}%</b></span>
        {profile.streak !== 0 && <span>{t('streak')}: <b className={profile.streak > 0 ? 'good' : 'bad'}>{profile.streak > 0 ? `+${profile.streak}` : profile.streak}</b></span>}
        <span className="muted">{t('peak')}: {Math.round(profile.best)}</span>
      </div>
    </div>
  );
}

export function Ranked({ back, lastResult, signUp }: { back: () => void; lastResult?: RankedResult | null; signUp: () => void }) {
  const t = useT();
  const { account } = useAccount();
  const [connected, setConnected] = useState(net.connected);
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [speed, setSpeed] = useState<number>(() => Number(localStorage.getItem('rookfall.rankedSpeed')) || 1);
  const [error, setError] = useState('');

  useEffect(() => {
    net.connect();
    const ask = () => { net.send({ t: 'profile' }); net.send({ t: 'leaderboard' }); };
    const u = [
      net.on('open', () => { setConnected(true); setError(''); ask(); }),
      net.on('close', () => { setConnected(false); setQueue(null); }),
      net.on('profile', (m) => setProfile(m.profile)),
      net.on('queued', (m) => setQueue(m.state)),
      net.on('dequeued', () => setQueue(null)),
      net.on('leaderboard', (m) => setBoard(m.entries)),
      net.on('error', (m) => { setError(m.code); setQueue(null); }),
      // a found match takes over the screen; drop the queue so coming back shows the idle state
      net.on('start', () => setQueue(null)),
    ];
    if (net.connected) ask();
    const iv = setInterval(() => { if (net.connected) net.send({ t: 'leaderboard' }); }, 30_000);
    return () => { u.forEach((f) => f()); clearInterval(iv); };
  }, []);

  // leaving the screen must not leave a ghost in the queue
  useEffect(() => () => { net.send({ t: 'dequeue' }); }, []);

  const pickSpeed = (v: number) => { setSpeed(v); try { localStorage.setItem('rookfall.rankedSpeed', String(v)); } catch { /* ignore */ } };
  const search = () => { setError(''); net.send({ t: 'queue', speed }); };
  const cancel = () => { net.send({ t: 'dequeue' }); setQueue(null); };
  const searching = !!queue;

  return (
    <div className="screen">
      <MenuBackground />
      <div className="card ranked">
        <button className="back" onClick={() => { net.send({ t: 'dequeue' }); back(); }}>{t('back')}</button>
        <h2>{t('ranked')}</h2>
        <p className="subtitle">{t('rankedTagline')}</p>
        {!connected && <p className="error small">{t('queueOffline')}</p>}

        {profile ? <ProfileCard profile={profile} /> : <div className="profile-card muted small">{t('connecting')}</div>}
        {profile && profile.games < PLACEMENT_GAMES && <p className="small muted">{t('placementNote', { n: PLACEMENT_GAMES })}</p>}
        {/* PRD 6.3: the ladder is where a guest has something to lose, so this is where the offer goes */}
        {!account && (
          <div className="guest-ladder-hint small">
            <span className="grow">{t('guestLadderHint')}</span>
            <button className="gold" disabled={searching} onClick={signUp}>{t('createAccount')}</button>
          </div>
        )}
        {lastResult && <LastResult result={lastResult} />}

        <div className="row ranked-play" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <h3>{t('gameSpeed')}</h3>
            <div className="row speeds">
              {RANKED_SPEEDS.map((v) => (
                <button key={v} className={`speed-btn ${v === speed ? 'primary' : ''}`} disabled={searching} onClick={() => pickSpeed(v)}>
                  {v}× {t(v === 1 ? 'speedNormal' : 'speedTurbo')}
                </button>
              ))}
            </div>
            <p className="small muted">{t('turboNote')}</p>
            {searching ? (
              <div className="searching">
                <div className="row">
                  <span className="spinner" />
                  <b>{t('searching')}</b>
                  <span className="grow" />
                  <span className="mono">{formatWait(queue!.waiting)}</span>
                </div>
                <div className="small muted">{t('inQueue')}: {queue!.size} · {t('searchRange')}: ±{queue!.range} · {queue!.speed}×</div>
                <div className="small muted">
                  {queue!.botIn > 0 ? `${t('botIn')}: ${formatWait(queue!.botIn)}` : t('botSoon')}
                </div>
                <button className="danger" onClick={cancel}>{t('cancelSearch')}</button>
              </div>
            ) : (
              <button className="primary find-game" disabled={!connected || !profile} onClick={search}>⚔️ {t('findGame')}</button>
            )}
            {error && <p className="error small">{t('queueOffline')}</p>}
            <p className="small muted">{t('ladderTestHint')}</p>
          </div>
          <div className="ranked-map">
            <MapPreview mapId={RANKED_MAP_ID} size={150} fill />
            <div className="small muted">64×64 · 1 vs 1</div>
          </div>
        </div>

        <h3>{t('leaderboard')}</h3>
        <div className="list board">
          {board.length === 0 && <div className="muted small">{t('noLeaderboard')}</div>}
          {board.map((e, i) => {
            const tier = tierFor(e.rating, PLACEMENT_GAMES);
            return (
              <div key={e.id} className={`list-item ${profile && e.id === profile.id ? 'me' : ''}`}>
                <span className="rank-n">{i + 1}</span>
                <span className={`tier small ${tier.key}`}><span className="tier-icon">{tier.icon}</span></span>
                <b>{e.name}</b>
                <span className="grow" />
                <span className="small muted">{t('ratingLevel')} {levelProgress(e.xp).level}</span>
                <span className="small muted">{e.wins}/{e.games}</span>
                <span className="rating-value small">{e.rating}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LastResult({ result }: { result: RankedResult }) {
  const t = useT();
  const up = result.delta >= 0;
  return (
    <div className={`last-result ${result.result}`}>
      <b>{t(result.result === 'win' ? 'victory' : result.result === 'loss' ? 'defeat' : 'draw')}</b>
      <span className="muted small">{t('opponent')}: {result.opponent.name} ({result.opponent.rating})</span>
      <span className="grow" />
      <b className={up ? 'good' : 'bad'}>{up ? '+' : ''}{result.delta}</b>
      <span className="small muted">→ {result.ratingAfter}</span>
    </div>
  );
}

function formatWait(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
