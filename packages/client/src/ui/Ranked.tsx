import { CSSProperties, useEffect, useState } from 'react';
import {
  LeaderboardEntry, PLACEMENT_GAMES, QueueState, RANKED_MAP_ID, RANKED_SPEEDS, RankTier, RankedProfile, RankedResult,
  levelProgress, tierFor, tierProgress,
} from '@pocket-of-empire/protocol';
import { OFFICIAL_MAPS } from '@pocket-of-empire/sim';
import { TKey, useT } from '../i18n';
import { STORAGE_PREFIX } from '../legacyStorage';
import { net } from '../net/client';
import { useAccount } from './useAccount';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
import { TIER_ICONS } from './icons/gameIcons';
import { MapPreview } from './MapPreview';
import { ScaleBar, SheetHead, useEscapeBack } from './Skirmish';

/**
 * The name of a tier. Tiers are map settlement signs (SPEC §1): hamlet → village → town → fortress → capital →
 * kingdom → empire. The protocol's keys (bronze…grandmaster) stay; only the names shown are the settlements.
 */
export function tierKey(tier: RankTier): TKey {
  const names: Record<RankTier['key'], TKey> = {
    unranked: 'unranked', bronze: 'settleHamlet', silver: 'settleVillage', gold: 'settleTown', platinum: 'settleFortress',
    diamond: 'settleCapital', master: 'settleKingdom', grandmaster: 'settleEmpire',
  };
  return names[tier.key];
}

/** the settlement sign of a rank: a sign in a ring of the tier's colour and its name (results panel, ladder) */
export function TierBadge({ profile, size = 'big' }: { profile: RankedProfile; size?: 'big' | 'small' }) {
  const t = useT();
  const tier = tierFor(profile.rating, profile.games);
  return (
    <span className={`tier tier--${tier.key}${size === 'big' ? ' tier--lg' : ''}${tier.key === 'unranked' ? ' tier--none' : ''}`} title={t('rank')}>
      <span className="tier__sign"><Icon name={TIER_ICONS[tier.key]} /></span>
      <span className="tier__name">{t(tierKey(tier))}</span>
    </span>
  );
}

const pct = (x: number) => ({ width: `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%` }) as CSSProperties;

/** rating, level and record - the card at the top of the ranked screen */
export function ProfileCard({ profile }: { profile: RankedProfile }) {
  const t = useT();
  const lvl = levelProgress(profile.xp);
  const tp = tierProgress(profile.rating);
  const placing = profile.games < PLACEMENT_GAMES;
  const winRate = profile.games ? Math.round((profile.wins / profile.games) * 100) : 0;
  return (
    <div className="profile-card slip">
      <div className="profile-card__head">
        <TierBadge profile={profile} />
        <div className="profile-card__rating">
          <span className="profile-card__num">{Math.round(profile.rating)}</span>
          <span className="profile-card__label">{t('rating')}</span>
        </div>
        <div className="profile-card__level">
          <span className="profile-card__lvl">{lvl.level}</span>
          <span className="profile-card__label">{t('ratingLevel')}</span>
        </div>
      </div>
      <div className="profile-card__meters">
        {placing ? (
          <div className="meter">
            <div className="meter__label"><span>{t('placement')}</span><span className="num">{profile.games} / {PLACEMENT_GAMES}</span></div>
            <div className="bar"><div style={pct(profile.games / PLACEMENT_GAMES)} /></div>
          </div>
        ) : (
          <div className="meter">
            <div className="meter__label">
              <span>{tp.next ? t('tierNext', { tier: t(tierKey(tp.next)) }) : t('tierTop')}</span>
              {tp.next && <span className="num">{Math.round(profile.rating)} / {Math.round(tp.next.min)}</span>}
            </div>
            <div className="bar"><div style={pct(tp.pct)} /></div>
          </div>
        )}
        <div className="meter">
          <div className="meter__label"><span>{t('xpToLevel', { n: lvl.level + 1 })}</span><span className="num">{lvl.into} / {lvl.need}</span></div>
          <div className="bar xp"><div style={pct(lvl.pct)} /></div>
        </div>
      </div>
      <dl className="profile-card__stats">
        <div><dt>{t('record')}</dt><dd>{profile.wins}–{profile.losses}{profile.draws ? `–${profile.draws}` : ''}</dd></div>
        <div><dt>{t('winRate')}</dt><dd>{winRate}%</dd></div>
        {profile.streak !== 0 && <div><dt>{t('streak')}</dt><dd className={profile.streak > 0 ? 'good' : 'bad'}>{profile.streak > 0 ? `+${profile.streak}` : profile.streak}</dd></div>}
        <div><dt>{t('peak')}</dt><dd>{Math.round(profile.best)}</dd></div>
      </dl>
    </div>
  );
}

/** a queue error in words: the ladder answers with a code */
function queueErrorKey(code: string): TKey {
  return code === 'noProfile' ? 'queueErrNoProfile' : code === 'inMatch' ? 'queueErrInMatch' : code === 'badSpeed' ? 'queueErrSpeed' : 'queueOffline';
}

export function Ranked({ back, lastResult, signUp }: { back: () => void; lastResult?: RankedResult | null; signUp: () => void }) {
  const t = useT();
  const { account } = useAccount();
  const [connected, setConnected] = useState(net.connected);
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [speed, setSpeed] = useState<number>(() => Number(localStorage.getItem(`${STORAGE_PREFIX}rankedSpeed`)) || 1);
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

  const leave = () => { net.send({ t: 'dequeue' }); back(); };
  useEscapeBack(leave);
  const pickSpeed = (v: number) => { setSpeed(v); try { localStorage.setItem(`${STORAGE_PREFIX}rankedSpeed`, String(v)); } catch { /* ignore */ } };
  const search = () => { setError(''); net.send({ t: 'queue', speed }); };
  const cancel = () => { net.send({ t: 'dequeue' }); setQueue(null); };
  const searching = !!queue;
  const myTier = profile ? tierFor(profile.rating, profile.games) : null;

  return (
    <div className="screen setup-screen">
      <MenuBackground />
      <main className="sheet sheet--framed setup-sheet setup-sheet--full ranked">
        <SheetHead onBack={leave} backLabel={t('back')} title={<h1 className="setup-head__title">{t('ranked')}</h1>} sub={t('rankedTagline')} />
        <div className="setup-body">
          <div className="setup-main ranked-main">
            {!connected && <p className="setup-alert" role="alert"><Icon name="error" />{t('queueOffline')}</p>}
            {profile ? <ProfileCard profile={profile} /> : (
              <div className="profile-card slip profile-card--wait" role="status"><span className="spinner" />{t('connecting')}</div>
            )}
            {profile && profile.games < PLACEMENT_GAMES && <p className="setup-note">{t('placementNote', { n: PLACEMENT_GAMES })}</p>}
            {/* PRD 6.3: the ladder is where a guest has something to lose, so this is where the offer goes */}
            {!account && (
              <div className="guest-ladder-hint">
                <Icon name="account" />
                <p>{t('guestLadderHint')}</p>
                <button className="btn btn--secondary btn--compact" disabled={searching} onClick={signUp}>{t('createAccount')}</button>
              </div>
            )}
            {lastResult && <LastResult result={lastResult} />}

            <section className="board" aria-labelledby="rk-board">
              <div className="legend-head">
                <h2 className="legend-head__name" id="rk-board">{t('leaderboard')}</h2>
                {myTier && <span className="legend-head__meta">{t('rank')}: {t(tierKey(myTier))}</span>}
              </div>
              {board.length === 0 ? <p className="setup-empty">{t('noLeaderboard')}</p> : (
                <div className="board-wrap">
                  <table className="table board-table">
                    <thead>
                      <tr><th>№</th><th>{t('boardPlayer')}</th><th>{t('boardLvl')}</th><th>{t('boardWins')}</th><th>{t('rating')}</th></tr>
                    </thead>
                    <tbody>
                      {board.map((e, i) => {
                        const tier = tierFor(e.rating, PLACEMENT_GAMES);
                        return (
                          <tr key={e.id} className={profile && e.id === profile.id ? 'is-me' : ''}>
                            <td className="dim">{i + 1}</td>
                            <td>
                              <span className="board-name">
                                <span className={`tier tier--sign tier--${tier.key}`} title={t(tierKey(tier))}>
                                  <span className="tier__sign"><Icon name={TIER_ICONS[tier.key]} title={t(tierKey(tier))} /></span>
                                </span>
                                <span className="board-name__text">{e.name}</span>
                              </span>
                            </td>
                            <td>{levelProgress(e.xp).level}</td>
                            <td>{e.wins}/{e.games}</td>
                            <td className="best">{e.rating}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <div className="setup-side ranked-side">
            <section aria-labelledby="rk-match">
              <div className="legend-head"><h2 className="legend-head__name" id="rk-match">{t('rankedMatch')}</h2></div>
              <div className="ranked-map">
                <div className="ranked-map__plate"><MapPreview mapId={RANKED_MAP_ID} size={120} fill /></div>
                <div className="ranked-map__text">
                  <div className="ranked-map__name">{OFFICIAL_MAPS.find((m) => m.id === RANKED_MAP_ID)?.name ?? RANKED_MAP_ID}</div>
                  <div className="ranked-map__meta">64×64 · 1 {t('versus')} 1</div>
                  <p className="ranked-map__note">{t('rankedMapNote')}</p>
                </div>
              </div>
            </section>
            <section aria-labelledby="rk-speed">
              <div className="legend-head"><h2 className="legend-head__name" id="rk-speed">{t('gameSpeed')}</h2></div>
              <ScaleBar
                className="scalebar--words ranked-speeds" options={RANKED_SPEEDS} value={speed as 1 | 3} disabled={searching} onChange={pickSpeed} label={t('gameSpeed')}
                render={(v) => <><span className="num">{v}×</span> {t(v === 1 ? 'speedNormal' : 'speedTurbo')}</>}
              />
              <p className="setup-note">{t('turboNote')}</p>
              {import.meta.env.DEV && <p className="setup-note setup-note--dev">{t('ladderTestHint')}</p>}
            </section>
          </div>

          <div className="setup-foot">
            {error && <p className="setup-alert" role="alert"><Icon name="error" />{t(queueErrorKey(error))}</p>}
            {searching ? (
              <div className="search-card well" role="status">
                <div className="search-card__head">
                  <span className="spinner spinner--lg" />
                  <span className="search-card__title">{t('searching')}</span>
                  <span className="search-card__time">{formatWait(queue!.waiting)}</span>
                </div>
                <ul className="search-card__facts">
                  <li><span>{t('inQueue')}</span><b>{queue!.size}</b></li>
                  <li><span>{t('searchRange')}</span><b>±{queue!.range}</b></li>
                  <li><span>{t('speedShort')}</span><b>{queue!.speed}×</b></li>
                  <li>{queue!.botIn > 0 ? <><span>{t('botIn')}</span><b>{formatWait(queue!.botIn)}</b></> : <span>{t('botSoon')}</span>}</li>
                </ul>
                <button className="btn btn--danger btn--block" onClick={cancel}><Icon name="close" />{t('cancelSearch')}</button>
                <p className="setup-note">{t('searchLeaveNote')}</p>
              </div>
            ) : (
              <button className="btn btn--seal btn--block setup-seal" disabled={!connected || !profile} onClick={search}>{t('findGame')}</button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function LastResult({ result }: { result: RankedResult }) {
  const t = useT();
  const up = result.delta >= 0;
  return (
    <div className={`last-result slip ${result.result}`}>
      <div className="last-result__main">
        <span className="last-result__label">{t('lastResultTitle')}</span>
        <b className="last-result__verdict">{t(result.result === 'win' ? 'victory' : result.result === 'loss' ? 'defeat' : 'draw')}</b>
        <span className="last-result__opp">{t('opponent')}: {result.opponent.name} ({result.opponent.rating})</span>
      </div>
      <b className={`last-result__delta ${up ? 'good' : 'bad'}`}>{up ? '+' : ''}{result.delta}</b>
      <span className="last-result__after">→ {result.ratingAfter}</span>
    </div>
  );
}

function formatWait(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
