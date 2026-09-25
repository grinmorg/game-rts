import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { AccountInfo } from '@rookfall/protocol';

// ------------------------------------------------------------------ passwords

/**
 * scrypt at the OWASP baseline: 16 MB and ~50 ms a hash. It runs on the libuv pool, so a sign-in never
 * stalls the event loop the lockstep matches tick on.
 */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

function scryptAsync(password: string, salt: Buffer, len: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** the same password typed on a phone and a laptop must hash the same, whatever the keyboard composed */
const norm = (password: string) => password.normalize('NFKC');

/** `scrypt$N$r$p$salt$hash`: the cost travels with the hash, so it can be raised later without a migration */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(norm(password), salt, KEY_LEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  try {
    const key = await scryptAsync(norm(password), Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(key, expected);
  } catch {
    return false; // a mangled cost in the file: refuse the sign-in rather than leave the client waiting
  }
}

/**
 * Checked against when the e-mail is unknown, so "no such account" costs the same scrypt as "wrong
 * password" and the response time does not tell the two apart.
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> { return (dummy ??= hashPassword(randomBytes(12).toString('hex'))); }

// ------------------------------------------------------------------ store

/** a session is dropped after this long without a visit */
const SESSION_TTL_MS = 180 * 24 * 3600_000;
/** signed-in browsers per account; signing in on one more pushes out the one seen longest ago */
const MAX_SESSIONS = 10;
/** a visit is written down at most this often, so a reload does not rewrite the file */
const SEEN_RESOLUTION_MS = 3600_000;

interface SessionRecord {
  /** sha-256 of the token: a leaked accounts file does not sign anybody in */
  hash: string;
  createdAt: number;
  seenAt: number;
}

export interface AccountRecord {
  id: string;
  /** normalized: trimmed and lower-case */
  email: string;
  name: string;
  passwordHash: string;
  /**
   * The RatingStore key of the account's ladder profile. It contains a ':', which the guest key filter
   * strips, so no client can claim this profile by sending it as its `playerKey`.
   */
  ladderKey: string;
  createdAt: number;
  sessions: SessionRecord[];
}

export function accountInfo(a: AccountRecord): AccountInfo {
  return { id: a.id, email: a.email, name: a.name, createdAt: a.createdAt };
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');

/**
 * Accounts and their sessions, in one JSON file next to the ladder - the same light-stack trade as
 * RatingStore: a debounced full rewrite is cheaper than a database for this many records.
 */
export class AccountStore {
  private byId = new Map<string, AccountRecord>();
  private byEmail = new Map<string, AccountRecord>();
  /** token hash -> account */
  private bySession = new Map<string, AccountRecord>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  /** `file` is null for an in-memory store (tests) */
  constructor(private file: string | null) { this.load(); }

  get size(): number { return this.byId.size; }

  private load(): void {
    try {
      if (!this.file || !existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { accounts?: AccountRecord[] };
      for (const a of raw.accounts ?? []) this.index(a);
      console.log(`[account] loaded ${this.byId.size} accounts`);
    } catch (err) {
      console.error('[account] could not read accounts, starting empty', err);
    }
  }

  private index(a: AccountRecord): void {
    this.byId.set(a.id, a);
    this.byEmail.set(a.email, a);
    for (const s of a.sessions) this.bySession.set(s.hash, a);
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 2000);
  }

  flush(): void {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, accounts: [...this.byId.values()] }), { mode: 0o600 });
      renameSync(tmp, this.file); // atomic: a crash mid-write never truncates the file
    } catch (err) {
      console.error('[account] save failed', err);
    }
  }

  findByEmail(email: string): AccountRecord | undefined { return this.byEmail.get(email); }

  /** a new account, written to disk at once: losing a sign-up to a restart is worse than a sync write */
  create(email: string, name: string, passwordHash: string): AccountRecord {
    let id = randomId();
    while (this.byId.has(id)) id = randomId();
    const a: AccountRecord = { id, email, name, passwordHash, ladderKey: `acct:${id}`, createdAt: Date.now(), sessions: [] };
    this.index(a);
    this.dirty = true;
    this.flush();
    return a;
  }

  rename(a: AccountRecord, name: string): void {
    if (a.name === name) return;
    a.name = name;
    this.scheduleSave();
  }

  /** sign a browser in: returns the token it keeps, the store keeps only its hash */
  openSession(a: AccountRecord): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    const now = Date.now();
    // newest first; the sort is stable, so the new session stays ahead of any seen in the same millisecond
    a.sessions.unshift({ hash, createdAt: now, seenAt: now });
    a.sessions.sort((x, y) => y.seenAt - x.seenAt);
    for (const old of a.sessions.splice(MAX_SESSIONS)) this.bySession.delete(old.hash);
    this.bySession.set(hash, a);
    this.scheduleSave();
    return { token, hash };
  }

  /** the account behind a session token, or null if the token is unknown or expired */
  resolve(token: string): { account: AccountRecord; hash: string } | null {
    if (typeof token !== 'string' || token.length > 100) return null;
    const hash = tokenHash(token);
    const a = this.bySession.get(hash);
    const s = a?.sessions.find((x) => x.hash === hash);
    if (!a || !s) return null;
    const now = Date.now();
    if (now - s.seenAt > SESSION_TTL_MS) { this.closeSession(hash); return null; }
    if (now - s.seenAt > SEEN_RESOLUTION_MS) { s.seenAt = now; this.scheduleSave(); }
    return { account: a, hash };
  }

  closeSession(hash: string): void {
    const a = this.bySession.get(hash);
    if (!a) return;
    this.bySession.delete(hash);
    a.sessions = a.sessions.filter((s) => s.hash !== hash);
    this.scheduleSave();
  }
}

function randomId(): string {
  return `u${randomBytes(6).toString('hex')}`;
}

// ------------------------------------------------------------------ throttling

/**
 * Fixed-window attempt counter per key (an IP address or an e-mail). The windows are short and the map
 * is swept on every check past its window, so it never outgrows the traffic of the last few minutes.
 */
export class Throttle {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private limit: number, private windowMs: number) {}

  /** true while `key` has attempts left in its current window */
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !h || h.until <= now || h.n < this.limit;
  }

  hit(key: string, now = Date.now()): void {
    let h = this.hits.get(key);
    if (!h || h.until <= now) {
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
      h = { n: 0, until: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.n++;
  }

  clear(key: string): void { this.hits.delete(key); }
}

// ------------------------------------------------------------------ client address

const PRIVATE_ADDR = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i;

/**
 * The address a throttle counts against. Behind the host nginx (and the Docker bridge) every socket comes
 * from a private address, and the real one is the last X-Forwarded-For hop - the one nginx appended
 * itself; anything before it is whatever the client chose to send. A socket from a public address is
 * the client itself, and its headers are not trusted at all.
 */
export function clientIp(req: IncomingMessage | undefined): string {
  const peer = req?.socket.remoteAddress ?? '';
  if (!PRIVATE_ADDR.test(peer)) return peer;
  const fwd = req?.headers['x-forwarded-for'];
  const last = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last ?? peer;
}
