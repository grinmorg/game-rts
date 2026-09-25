import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientMessage, ServerMessage, normalizeEmail } from '@rookfall/protocol';
import { AccountStore, Throttle, clientIp, hashPassword, verifyPassword } from '../src/accounts';
import { Lobby } from '../src/lobby';

class TestClient {
  ws!: WebSocket;
  msgs: ServerMessage[] = [];
  constructor(readonly url: string) {}
  connect(hello: Omit<Extract<ClientMessage, { t: 'hello' }>, 't'>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => { this.send({ t: 'hello', ...hello }); resolve(); });
      this.ws.on('error', reject);
      this.ws.on('message', (data, isBinary) => { if (!isBinary) this.msgs.push(JSON.parse(data.toString())); });
    });
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMessage['t']>(type: T, timeout = 5000): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = this.msgs.findIndex((m) => m.t === type);
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  /** the reply to a sign-in style request: either the new identity or the reason it was refused */
  async outcome(): Promise<Extract<ServerMessage, { t: 'account' | 'authError' }>> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const i = this.msgs.findIndex((m) => m.t === 'account' || m.t === 'authError');
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { t: 'account' | 'authError' }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout waiting for an auth reply');
  }
  close() { this.ws.close(); }
}

describe('passwords and helpers', () => {
  it('hashes with a fresh salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse'), b = await hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('correct horsf', a)).toBe(false);
    expect(await verifyPassword('correct horse', 'garbage')).toBe(false);
  });

  it('normalizes e-mails and rejects what is not one', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeEmail('a.b+tag@mail.co.uk')).toBe('a.b+tag@mail.co.uk');
    for (const bad of ['', 'alice', 'alice@', '@example.com', 'alice@example', 'al ice@example.com', 'a@b..com']) expect(normalizeEmail(bad)).toBeNull();
  });

  it('throttles per key within a window', () => {
    const th = new Throttle(3, 1000);
    for (let i = 0; i < 3; i++) { expect(th.allow('ip', 0)).toBe(true); th.hit('ip', 0); }
    expect(th.allow('ip', 500)).toBe(false);
    expect(th.allow('other', 500)).toBe(true);
    expect(th.allow('ip', 1000)).toBe(true); // the window is over
    th.hit('ip', 1000);
    th.clear('ip');
    expect(th.allow('ip', 1001)).toBe(true);
  });

  it('trusts X-Forwarded-For only from a private peer, and only its last hop', () => {
    const req = (peer: string, fwd?: string) => ({ socket: { remoteAddress: peer }, headers: fwd ? { 'x-forwarded-for': fwd } : {} }) as never;
    expect(clientIp(req('203.0.113.9', '1.1.1.1'))).toBe('203.0.113.9');
    expect(clientIp(req('127.0.0.1', '6.6.6.6, 198.51.100.7'))).toBe('198.51.100.7');
    expect(clientIp(req('172.18.0.1', '198.51.100.7'))).toBe('198.51.100.7');
    expect(clientIp(req('::1'))).toBe('::1');
  });
});

describe('account store', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'rookfall-accounts-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('persists accounts, sessions and renames, and keeps only token hashes on disk', () => {
    const file = join(dir, 'accounts.json');
    const store = new AccountStore(file);
    const a = store.create('bob@example.com', 'Bob', 'scrypt$x');
    const { token, hash } = store.openSession(a);
    const second = store.openSession(a);
    store.rename(a, 'Robert');
    store.closeSession(second.hash);
    store.flush();

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(hash);

    const again = new AccountStore(file);
    expect(again.size).toBe(1);
    const r = again.resolve(token);
    expect(r?.account.name).toBe('Robert');
    expect(r?.account.ladderKey).toContain(':');
    expect(again.resolve(second.token)).toBeNull();
    expect(again.resolve('nonsense')).toBeNull();
  });

  it('caps the signed-in browsers per account, pushing out the oldest', () => {
    const store = new AccountStore(null);
    const a = store.create('cap@example.com', 'Cap', 'scrypt$x');
    const tokens = Array.from({ length: 12 }, () => store.openSession(a).token);
    expect(a.sessions).toHaveLength(10);
    expect(store.resolve(tokens[11])).not.toBeNull();
  });
});

describe('accounts over the lobby socket', () => {
  let http: Server;
  let url: string;
  let lobby: Lobby;

  beforeAll(async () => {
    lobby = new Lobby({ saveReplay: () => 'r' });
    http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/ws' });
    wss.on('connection', (ws, req) => lobby.handleConnection(ws, req));
    await new Promise<void>((r) => http.listen(0, r));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
  });
  afterAll(() => { http.close(); });

  it('signs a guest up, keeps their ladder profile, and signs them back in by session and by password', async () => {
    const guest = new TestClient(url);
    await guest.connect({ name: 'Alice', playerKey: 'alice-browser-key' });
    expect((await guest.wait('account')).account).toBeNull();
    const guestProfile = (await guest.wait('profile')).profile;

    guest.send({ t: 'register', email: ' Alice@Example.com ', password: 'hunter2hunter2', name: 'Alice the Great' });
    const signedUp = await guest.outcome();
    if (signedUp.t !== 'account') throw new Error(`sign-up refused: ${signedUp.code}`);
    expect(signedUp.account).toMatchObject({ email: 'alice@example.com', name: 'Alice the Great' });
    expect(signedUp.session).toBeTruthy();
    // the rating earned as a guest moved into the account
    const accountProfile = (await guest.wait('profile')).profile;
    expect(accountProfile.id).toBe(guestProfile.id);
    guest.close();

    // another browser: the session alone is enough, and the account's nickname wins over the hello name
    const other = new TestClient(url);
    await other.connect({ name: 'Somebody', playerKey: 'other-browser-key', session: signedUp.session });
    expect((await other.wait('welcome')).name).toBe('Alice the Great');
    expect((await other.wait('account')).account?.email).toBe('alice@example.com');
    expect((await other.wait('profile')).profile.id).toBe(guestProfile.id);

    // the old browser key no longer reaches that profile
    const oldKey = new TestClient(url);
    await oldKey.connect({ name: 'Alice', playerKey: 'alice-browser-key' });
    expect((await oldKey.wait('profile')).profile.id).not.toBe(guestProfile.id);
    oldKey.close();

    // sign out, then back in with the password (e-mail case does not matter)
    other.send({ t: 'logout' });
    expect((await other.outcome())).toMatchObject({ t: 'account', account: null });
    other.send({ t: 'login', email: 'ALICE@example.com', password: 'wrong-password' });
    expect(await other.outcome()).toMatchObject({ t: 'authError', code: 'badCredentials' });
    other.send({ t: 'login', email: 'nobody@example.com', password: 'hunter2hunter2' });
    expect(await other.outcome()).toMatchObject({ t: 'authError', code: 'badCredentials' });
    other.send({ t: 'login', email: 'ALICE@example.com', password: 'hunter2hunter2' });
    const signedIn = await other.outcome();
    expect(signedIn).toMatchObject({ t: 'account', account: { name: 'Alice the Great' } });
    other.close();

    // the signed-out session is dead for good
    const stale = new TestClient(url);
    await stale.connect({ name: 'Alice', session: signedUp.session });
    expect((await stale.wait('account')).account).toBeNull();
    stale.close();
  });

  it('lets the nickname change any number of times and remembers the last one', async () => {
    const c = new TestClient(url);
    await c.connect({ name: 'Carol', playerKey: 'carol-browser-key' });
    await c.wait('account');
    c.send({ t: 'register', email: 'carol@example.com', password: 'carolcarol', name: 'Carol' });
    const up = await c.outcome();
    if (up.t !== 'account') throw new Error(up.code);
    for (const name of ['Caroline', 'Caz', 'Carol the Third']) {
      c.send({ t: 'setName', name });
      expect((await c.wait('account')).account?.name).toBe(name);
    }
    c.send({ t: 'setName', name: '!' }); // filtered down to nothing but '!' - too short for an account
    expect(await c.outcome()).toMatchObject({ t: 'authError', code: 'badName' });
    c.close();

    const back = new TestClient(url);
    await back.connect({ name: 'whatever', session: up.session });
    expect((await back.wait('account')).account?.name).toBe('Carol the Third');
    expect((await back.wait('profile')).profile.name).toBe('Carol the Third');
    back.close();
  });

  it('signs every tab of the browser out together', async () => {
    const a = new TestClient(url), b = new TestClient(url);
    await a.connect({ name: 'Erin', playerKey: 'erin-browser-key' });
    await a.wait('account');
    a.send({ t: 'register', email: 'erin@example.com', password: 'erinerinerin', name: 'Erin' });
    const up = await a.outcome();
    if (up.t !== 'account') throw new Error(up.code);
    await b.connect({ name: 'Erin', playerKey: 'erin-browser-key', session: up.session });
    expect((await b.wait('account')).account?.name).toBe('Erin');
    a.send({ t: 'logout' });
    expect(await a.outcome()).toMatchObject({ t: 'account', account: null });
    expect(await b.outcome()).toMatchObject({ t: 'account', account: null });
    a.close(); b.close();
  });

  it('refuses bad input and a taken e-mail', async () => {
    const c = new TestClient(url);
    await c.connect({ name: 'Dave' });
    await c.wait('account');
    c.send({ t: 'register', email: 'not-an-email', password: 'davedavedave', name: 'Dave' });
    expect(await c.outcome()).toMatchObject({ t: 'authError', code: 'badEmail' });
    c.send({ t: 'register', email: 'dave@example.com', password: 'short', name: 'Dave' });
    expect(await c.outcome()).toMatchObject({ t: 'authError', code: 'weakPassword' });
    c.send({ t: 'register', email: 'dave@example.com', password: 'davedavedave', name: ' ' });
    expect(await c.outcome()).toMatchObject({ t: 'authError', code: 'badName' });
    c.send({ t: 'register', email: 'ALICE@example.com', password: 'davedavedave', name: 'Dave' });
    expect(await c.outcome()).toMatchObject({ t: 'authError', code: 'emailTaken' });
    c.close();
  });

  it('never lets a guest claim an account ladder profile through its player key', async () => {
    const a = lobby.accounts.findByEmail('alice@example.com')!;
    const c = new TestClient(url);
    await c.connect({ name: 'Mallory', playerKey: a.ladderKey });
    expect((await c.wait('account')).account).toBeNull();
    expect((await c.wait('profile')).profile.id).not.toBe(lobby.ratings.get(a.ladderKey)!.id);
    c.close();
  });
});
