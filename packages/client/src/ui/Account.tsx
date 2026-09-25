import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  ACCOUNT_NAME_MIN, AccountInfo, AuthErrorCode, ClientMessage, NAME_MAX, PASSWORD_MAX, PASSWORD_MIN,
  normalizeEmail, passwordOk, sanitizeName,
} from '@rookfall/protocol';
import { TKey, useT } from '../i18n';
import { net } from '../net/client';
import { getSettings } from '../settings';
import { MenuBackground } from './MainMenu';
import { useAccount } from './useAccount';

export type AuthMode = 'login' | 'register';

const AUTH_ERRORS: Record<AuthErrorCode, TKey> = {
  badEmail: 'authBadEmail', weakPassword: 'authWeakPassword', badName: 'authBadName', emailTaken: 'authEmailTaken',
  badCredentials: 'authBadCredentials', tooMany: 'authTooMany', inMatch: 'authInMatch',
};

/** one request to the server at a time, waiting for its `account` or `authError` answer */
function useAuthRequest(onAccepted?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);
  const pending = useRef(false);
  const accepted = useRef(onAccepted);
  accepted.current = onAccepted;
  useEffect(() => {
    const settle = () => { pending.current = false; setBusy(false); };
    const u = [
      net.on('authError', (m) => { if (pending.current) { settle(); setError(m.code); } }),
      net.on('account', () => { if (pending.current) { settle(); accepted.current?.(); } }),
      net.on('close', settle),
    ];
    return () => u.forEach((f) => f());
  }, []);
  const send = (msg: ClientMessage) => { pending.current = true; setBusy(true); setError(null); net.send(msg); };
  return { busy, error, setError, send };
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {crossed && <path d="M3.5 3.5l17 17" />}
    </svg>
  );
}

/** a password box with an eye to peek at what was typed; starts hidden */
function PasswordInput({ id, value, onChange, autoComplete, invalid }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <input
        id={id} type={shown ? 'text' : 'password'} value={value} autoComplete={autoComplete} maxLength={PASSWORD_MAX}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button" className="eye" aria-label={t(shown ? 'hidePassword' : 'showPassword')} title={t(shown ? 'hidePassword' : 'showPassword')}
        aria-pressed={shown} aria-controls={id} onClick={() => setShown((v) => !v)}
      >
        <EyeIcon crossed={shown} />
      </button>
    </div>
  );
}

function AuthForms({ connected, initialMode }: { connected: boolean; initialMode: AuthMode }) {
  const t = useT();
  const ids = useId();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState('');
  const [name, setName] = useState(() => getSettings().name);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  /** field errors wait for the first submit, so the form does not scold while it is being filled in */
  const [tried, setTried] = useState(false);
  const req = useAuthRequest();
  const registering = mode === 'register';

  const emailBad = !normalizeEmail(email);
  const nameBad = sanitizeName(name).length < ACCOUNT_NAME_MIN;
  const passwordBad = registering ? !passwordOk(password) : !password;
  const mismatch = registering && repeat !== password;
  // no need to wait for submit here: once the second password is as long as the first, a typo is a typo
  const showMismatch = mismatch && (tried || repeat.length >= password.length);

  const switchTo = (m: AuthMode) => { setMode(m); setTried(false); setRepeat(''); req.setError(null); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!connected || req.busy || emailBad || passwordBad || (registering && (nameBad || mismatch))) return;
    req.send(registering ? { t: 'register', email, password, name } : { t: 'login', email, password });
  };

  return (
    <>
      <h2>{t('account')}</h2>
      <div className="row auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!registering} className={registering ? '' : 'primary'} onClick={() => switchTo('login')}>{t('signIn')}</button>
        <button type="button" role="tab" aria-selected={registering} className={registering ? 'primary' : ''} onClick={() => switchTo('register')}>{t('signUp')}</button>
      </div>
      <form className="auth-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${ids}-email`}>{t('email')}</label>
          <input
            id={`${ids}-email`} type="email" inputMode="email" autoComplete={registering ? 'email' : 'username'} maxLength={254}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={(tried && emailBad) || undefined}
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          {tried && emailBad && <small className="error">{t('authBadEmail')}</small>}
        </div>
        {registering && (
          <div className="field">
            <label htmlFor={`${ids}-name`}>{t('nickname')}</label>
            <input id={`${ids}-name`} autoComplete="nickname" maxLength={NAME_MAX} aria-invalid={(tried && nameBad) || undefined} value={name} onChange={(e) => setName(e.target.value)} />
            <small className={tried && nameBad ? 'error' : 'muted'}>{t(tried && nameBad ? 'authBadName' : 'nicknameHint')}</small>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${ids}-password`}>{t('password')}</label>
          <PasswordInput id={`${ids}-password`} value={password} onChange={setPassword} autoComplete={registering ? 'new-password' : 'current-password'} invalid={tried && passwordBad} />
          {registering && <small className={tried && passwordBad ? 'error' : 'muted'}>{t('passwordHint', { n: PASSWORD_MIN })}</small>}
        </div>
        {registering && (
          <div className="field">
            <label htmlFor={`${ids}-repeat`}>{t('passwordRepeat')}</label>
            <PasswordInput id={`${ids}-repeat`} value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={showMismatch} />
            {showMismatch && <small className="error">{t('passwordMismatch')}</small>}
          </div>
        )}
        {req.error && (
          <p className="error small" role="alert">
            {t(AUTH_ERRORS[req.error], { min: PASSWORD_MIN, max: PASSWORD_MAX })}
            {req.error === 'emailTaken' && <> <button type="button" className="inline-link" onClick={() => switchTo('login')}>{t('signIn')}</button></>}
          </p>
        )}
        {!connected && <p className="error small">{t('authOffline')}</p>}
        <button type="submit" className="primary auth-submit" disabled={!connected || req.busy}>
          {req.busy ? <span className="spinner" /> : t(registering ? 'createAccount' : 'signIn')}
        </button>
        {registering && <p className="small muted auth-note">{t('guestTransferNote')}</p>}
      </form>
    </>
  );
}

function AccountView({ account, connected, welcome }: { account: AccountInfo; connected: boolean; welcome: boolean }) {
  const t = useT();
  const ids = useId();
  const [name, setName] = useState(account.name);
  const [saved, setSaved] = useState(false);
  const req = useAuthRequest(() => setSaved(true));
  // the server trims and filters the nickname; show what it actually kept
  useEffect(() => { setName(account.name); }, [account.name]);

  const clean = sanitizeName(name);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (clean.length < ACCOUNT_NAME_MIN) { req.setError('badName'); return; }
    if (clean === account.name) return;
    req.send({ t: 'setName', name: clean });
  };

  return (
    <>
      <h2>{t('account')}</h2>
      {welcome && <p className="auth-welcome small">{t('signedInAs', { name: account.name })}</p>}
      <div className="profile-card account-card">
        <span className="account-avatar" aria-hidden="true">{[...account.name][0]?.toUpperCase()}</span>
        <div className="grow">
          <b className="account-name">{account.name}</b>
          <div className="small muted">{account.email}</div>
          <div className="small muted">{t('memberSince')} {new Date(account.createdAt).toLocaleDateString(getSettings().lang)}</div>
        </div>
      </div>
      <form className="auth-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${ids}-name`}>{t('nickname')}</label>
          <div className="row">
            <input
              id={`${ids}-name`} className="grow" autoComplete="nickname" maxLength={NAME_MAX} value={name}
              onChange={(e) => { setName(e.target.value); setSaved(false); req.setError(null); }}
            />
            <button type="submit" disabled={!connected || req.busy || clean === account.name}>{t('save')}</button>
          </div>
          {req.error
            ? <small className="error" role="alert">{t(AUTH_ERRORS[req.error])}</small>
            : <small className="muted">{saved ? `✓ ${t('saved')}` : t(connected ? 'nicknameHint' : 'nameNeedsServer')}</small>}
        </div>
      </form>
      <div className="row end">
        <button className="danger" onClick={() => net.signOut()}>{t('signOut')}</button>
      </div>
    </>
  );
}

export function AccountScreen({ back, initialMode = 'login' }: { back: () => void; initialMode?: AuthMode }) {
  const t = useT();
  const { account, connected } = useAccount();
  // greet a player who signed in on this screen; one who arrived signed in already knows
  const cameAsGuest = useRef(!account);
  useEffect(() => { if (!account) cameAsGuest.current = true; }, [account]);
  return (
    <div className="screen">
      <MenuBackground />
      <div className="card narrow account">
        <button className="back" onClick={back}>{t('back')}</button>
        {account
          ? <AccountView account={account} connected={connected} welcome={cameAsGuest.current} />
          : <AuthForms connected={connected} initialMode={initialMode} />}
      </div>
    </div>
  );
}
