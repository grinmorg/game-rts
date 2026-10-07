import { FormEvent, KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  ACCOUNT_NAME_MIN, AccountInfo, AuthErrorCode, ClientMessage, NAME_MAX, PASSWORD_MAX, PASSWORD_MIN,
  normalizeEmail, passwordOk, sanitizeName,
} from '@pocket-of-empire/protocol';
import { TKey, useT } from '../i18n';
import { net } from '../net/client';
import { getSettings } from '../settings';
import { MenuBackground } from './common/MenuBackground';
import { Icon } from './icons/Icon';
import { LeafHead } from './MainMenu';
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

/** a phone keyboard covers the lower half of the screen: bring the field being typed into above it */
const keepInView = (e: { currentTarget: HTMLElement }) => {
  const el = e.currentTarget;
  setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
};

/** a labelled field with its hint or its error under it, tied to the input for screen readers */
function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string | false; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="field__error" id={`${id}-msg`}>{error}</span> : hint ? <span className="field__hint" id={`${id}-msg`}>{hint}</span> : null}
    </div>
  );
}

/** a password box with an eye to peek at what was typed; starts hidden */
function PasswordInput({ id, value, onChange, autoComplete, invalid, described }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; described?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-field">
      <input
        id={id} className="text" type={shown ? 'text' : 'password'} value={value} autoComplete={autoComplete} maxLength={PASSWORD_MAX}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={invalid || undefined} aria-describedby={described ? `${id}-msg` : undefined}
        onChange={(e) => onChange(e.target.value)} onFocus={keepInView}
      />
      <button
        type="button" className="btn btn--quiet btn--icon pw-field__eye" aria-label={t(shown ? 'hidePassword' : 'showPassword')} title={t(shown ? 'hidePassword' : 'showPassword')}
        aria-pressed={shown} aria-controls={id} onClick={() => setShown((v) => !v)}
      >
        <Icon name="eye" />
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
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const emailBad = !normalizeEmail(email);
  const nameBad = sanitizeName(name).length < ACCOUNT_NAME_MIN;
  const passwordBad = registering ? !passwordOk(password) : !password;
  const mismatch = registering && repeat !== password;
  // no need to wait for submit here: once the second password is as long as the first, a typo is a typo
  const showMismatch = mismatch && (tried || repeat.length >= password.length);

  const switchTo = (m: AuthMode) => { setMode(m); setTried(false); setRepeat(''); req.setError(null); };
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: AuthMode = e.key === 'Home' ? 'login' : e.key === 'End' ? 'register' : registering ? 'login' : 'register';
    switchTo(next);
    tabs.current[next === 'login' ? 0 : 1]?.focus();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!connected || req.busy || emailBad || passwordBad || (registering && (nameBad || mismatch))) return;
    req.send(registering ? { t: 'register', email, password, name } : { t: 'login', email, password });
  };
  const id = (f: string) => `${ids}-${f}`;

  return (
    <>
      <div className="leaf__body">
        <div className="tabs auth-tabs" role="tablist" aria-label={t('account')} onKeyDown={onTabKey}>
          <button
            ref={(el) => { tabs.current[0] = el; }} type="button" role="tab" className="tab" id={id('tab-login')} aria-controls={id('form')}
            aria-selected={!registering} tabIndex={registering ? -1 : 0} onClick={() => switchTo('login')}
          >{t('acctTabSignIn')}</button>
          <button
            ref={(el) => { tabs.current[1] = el; }} type="button" role="tab" className="tab" id={id('tab-register')} aria-controls={id('form')}
            aria-selected={registering} tabIndex={registering ? 0 : -1} onClick={() => switchTo('register')}
          >{t('signUp')}</button>
        </div>
        <form className="auth-form" id={id('form')} role="tabpanel" aria-labelledby={id(registering ? 'tab-register' : 'tab-login')} onSubmit={submit} noValidate>
          <div className="auth-fields">
            <Field id={id('email')} label={t('email')} error={tried && emailBad && t('authBadEmail')}>
              <input
                id={id('email')} className="text" type="email" inputMode="email" autoComplete={registering ? 'email' : 'username'} maxLength={254}
                autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={(tried && emailBad) || undefined}
                aria-describedby={tried && emailBad ? id('email-msg') : undefined} value={email} onChange={(e) => setEmail(e.target.value)} onFocus={keepInView}
              />
            </Field>
            {registering && (
              <Field id={id('name')} label={t('nickname')} error={tried && nameBad && t('authBadName')} hint={t('nicknameHint')}>
                <input
                  id={id('name')} className="text" autoComplete="nickname" maxLength={NAME_MAX} aria-invalid={(tried && nameBad) || undefined}
                  aria-describedby={id('name-msg')} value={name} onChange={(e) => setName(e.target.value)} onFocus={keepInView}
                />
              </Field>
            )}
            <Field id={id('password')} label={t('password')} error={registering && tried && passwordBad && t('passwordHint', { n: PASSWORD_MIN })} hint={registering && t('passwordHint', { n: PASSWORD_MIN })}>
              <PasswordInput id={id('password')} value={password} onChange={setPassword} autoComplete={registering ? 'new-password' : 'current-password'} invalid={tried && passwordBad} described={registering} />
            </Field>
            {registering && (
              <Field id={id('repeat')} label={t('passwordRepeat')} error={showMismatch && t('passwordMismatch')}>
                <PasswordInput id={id('repeat')} value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={showMismatch} described={showMismatch} />
              </Field>
            )}
          </div>
          {req.error && (
            <p className="auth-alert" role="alert">
              <Icon name="error" />
              <span>
                {t(AUTH_ERRORS[req.error], { min: PASSWORD_MIN, max: PASSWORD_MAX })}
                {req.error === 'emailTaken' && <> <button type="button" className="inline-link" onClick={() => switchTo('login')}>{t('signIn')}</button></>}
              </span>
            </p>
          )}
          {!connected && <p className="auth-alert auth-alert--offline" role="status"><Icon name="warning" /><span>{t('authOffline')}</span></p>}
        </form>
      </div>
      {/* the seal sits in the sheet's foot, outside the scrolling fields (on a phone it stays on screen); it submits the form by its id, Enter in a field too */}
      <div className="leaf__foot auth-foot">
        <button type="submit" form={id('form')} className="btn btn--seal btn--block auth-submit" disabled={!connected || req.busy} aria-busy={req.busy || undefined}>
          {req.busy && <span className="spinner" />}
          {t(registering ? 'createAccount' : 'signIn')}
        </button>
        {registering && <p className="auth-note">{t('guestTransferNote')}</p>}
      </div>
    </>
  );
}

function AccountView({ account, connected, welcome }: { account: AccountInfo; connected: boolean; welcome: boolean }) {
  const t = useT();
  const ids = useId();
  const [name, setName] = useState(account.name);
  const [saved, setSaved] = useState(false);
  const [askOut, setAskOut] = useState(false);
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
  const nameId = `${ids}-name`;

  return (
    <div className="leaf__body acct">
      {welcome && <p className="acct__welcome" role="status"><Icon name="check" />{t('signedInAs', { name: account.name })}</p>}
      <div className="acct-card">
        <span className="acct-avatar" aria-hidden="true">{[...account.name][0]?.toUpperCase()}</span>
        <div className="acct-card__main">
          <b className="acct-card__name">{account.name}</b>
          <span className="acct-card__meta">{account.email}</span>
          <span className="acct-card__meta">{t('memberSince')} {new Date(account.createdAt).toLocaleDateString(getSettings().lang)}</span>
        </div>
      </div>
      <form className="acct-name" onSubmit={submit} noValidate>
        <Field
          id={nameId} label={t('nickname')} error={req.error ? t(AUTH_ERRORS[req.error]) : false}
          hint={saved ? <span className="acct-name__saved"><Icon name="check" />{t('saved')}</span> : t(connected ? 'nicknameHint' : 'nameNeedsServer')}
        >
          <div className="acct-name__row">
            <input
              id={nameId} className="text" autoComplete="nickname" maxLength={NAME_MAX} value={name} aria-describedby={`${nameId}-msg`}
              aria-invalid={!!req.error || undefined} onFocus={keepInView}
              onChange={(e) => { setName(e.target.value); setSaved(false); req.setError(null); }}
            />
            <button type="submit" className="btn btn--secondary" disabled={!connected || req.busy || clean === account.name}>{t('save')}</button>
          </div>
        </Field>
      </form>
      <div className="acct-out">
        {askOut ? (
          <div className="acct-out__ask" role="group" aria-label={t('signOut')}>
            <p className="acct-out__q">{t('acctSignOutConfirm', { name: account.name })}</p>
            <div className="acct-out__btns">
              <button type="button" className="btn btn--quiet" onClick={() => setAskOut(false)} autoFocus>{t('cancel')}</button>
              <button type="button" className="btn btn--danger" onClick={() => net.signOut()}>{t('signOut')}</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn--danger btn--compact" onClick={() => setAskOut(true)}>{t('acctSignOutAsk')}</button>
        )}
      </div>
    </div>
  );
}

export function AccountScreen({ back, initialMode = 'login' }: { back: () => void; initialMode?: AuthMode }) {
  const t = useT();
  const titleId = useId();
  const { account, connected } = useAccount();
  // greet a player who signed in on this screen; one who arrived signed in already knows
  const cameAsGuest = useRef(!account);
  useEffect(() => { if (!account) cameAsGuest.current = true; }, [account]);
  return (
    <div className="screen leaf-screen">
      <MenuBackground />
      <section className="sheet sheet--framed leaf leaf--narrow account" aria-labelledby={titleId}>
        <LeafHead title={t('account')} sub={account ? undefined : t('acctSub')} back={back} titleId={titleId} />
        {account
          ? <AccountView account={account} connected={connected} welcome={cameAsGuest.current} />
          : <AuthForms connected={connected} initialMode={initialMode} />}
      </section>
    </div>
  );
}
