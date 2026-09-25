/**
 * Accounts: e-mail + password sign-up on top of the guest mode (PRD 6.3). The rules live here so the
 * sign-up form and the server reject exactly the same input.
 */

/** a signed-in player as they see themselves; nobody else is ever sent the e-mail */
export interface AccountInfo {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

export type AuthErrorCode =
  | 'badEmail' | 'weakPassword' | 'badName' | 'emailTaken' | 'badCredentials'
  /** throttled: too many sign-ups or failed sign-ins from this address or for this e-mail */
  | 'tooMany'
  /** sign-in, sign-up and sign-out wait until the match this connection plays in is over */
  | 'inMatch';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
/** a guest may call themselves anything that survives the name filter; an account needs a real nickname */
export const ACCOUNT_NAME_MIN = 2;
export const NAME_MAX = 20;

/** the canonical form of an e-mail (trimmed, lower-case), or null if it does not look like one */
export function normalizeEmail(s: unknown): string | null {
  const v = String(s ?? '').trim().toLowerCase();
  return v.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v) ? v : null;
}

export function passwordOk(p: unknown): p is string {
  return typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= PASSWORD_MAX;
}

/** the name filter both sides apply: letters, digits and a little punctuation, at most NAME_MAX long */
export function sanitizeName(s: unknown): string {
  return String(s ?? '').replace(/[^\p{L}\p{N} _\-.'!]/gu, '').trim().slice(0, NAME_MAX);
}
