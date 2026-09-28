/**
 * The rename Rookfall -> Pocket of Empire moved every browser-storage key to a new prefix. A returning player's
 * settings, guest ladder key, sign-in and local replays must all come along on the first load; nothing written by
 * the new build may be overwritten by stale values; a copy that does not fit the quota is moved instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** an in-memory Storage with an optional quota (bytes of keys + values), enough for what the module touches */
function memoryStorage(quota = Infinity): Storage {
  const m = new Map<string, string>();
  const size = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      const next = size() - (m.has(k) ? k.length + m.get(k)!.length : 0) + k.length + v.length;
      if (next > quota) throw new DOMException('quota', 'QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

async function load(local: Storage, session: Storage) {
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.resetModules();
  return import('../src/legacyStorage');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('storage keys after the rename', () => {
  it('copies every rookfall.* key to the new prefix and keeps the old ones for a rollback', async () => {
    const local = memoryStorage(), session = memoryStorage();
    local.setItem('rookfall.settings', '{"lang":"ru","name":"Ann"}');
    local.setItem('rookfall.playerKey', 'k1');
    local.setItem('rookfall.playerKey.alt', 'k2');
    local.setItem('rookfall.session', '{"token":"t"}');
    local.setItem('rookfall.replays', '[1,2,3]');
    local.setItem('rookfall.rankedSpeed', '2');
    local.setItem('someone-else', 'x');
    session.setItem('rookfall.token', 'reconnect');
    const { STORAGE_PREFIX } = await load(local, session);
    expect(STORAGE_PREFIX).toBe('pocket-of-empire.');
    for (const k of ['settings', 'playerKey', 'playerKey.alt', 'session', 'replays', 'rankedSpeed']) {
      expect(local.getItem(`pocket-of-empire.${k}`)).toBe(local.getItem(`rookfall.${k}`));
    }
    expect(session.getItem('pocket-of-empire.token')).toBe('reconnect');
    expect(local.getItem('rookfall.playerKey')).toBe('k1');
    expect(local.getItem('pocket-of-empire.someone-else')).toBeNull();
  });

  it('never overwrites what the new build already wrote', async () => {
    const local = memoryStorage(), session = memoryStorage();
    local.setItem('rookfall.settings', '{"name":"old"}');
    local.setItem('pocket-of-empire.settings', '{"name":"new"}');
    await load(local, session);
    expect(local.getItem('pocket-of-empire.settings')).toBe('{"name":"new"}');
  });

  it('moves a key whose copy does not fit the quota', async () => {
    const big = 'r'.repeat(600);
    const local = memoryStorage(1000), session = memoryStorage();
    local.setItem('rookfall.replays', big);
    await load(local, session);
    expect(local.getItem('pocket-of-empire.replays')).toBe(big);
    expect(local.getItem('rookfall.replays')).toBeNull();
  });

  it('does nothing when there is no storage at all', async () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('sessionStorage', undefined);
    vi.resetModules();
    await expect(import('../src/legacyStorage')).resolves.toBeDefined();
  });
});
