/**
 * Browser storage keys all live under one prefix. The game was called Rookfall until 2026-09-28 and kept its keys
 * under `rookfall.*`; on the first load after the rename every such key (settings, the guest ladder key, the signed-in
 * session, local replays, the ranked speed pick...) is copied once to the same name under the new prefix, so nobody
 * loses their rating, their sign-in or their replays. The old keys stay where they are - a rollback to the previous
 * build still finds them - unless the copy does not fit the storage quota (the local replays can be big), and then
 * the key is moved instead.
 *
 * Imported for its side effect by settings.ts, which everything that touches storage goes through first.
 */
export const STORAGE_PREFIX = 'pocket-of-empire.';
const LEGACY_PREFIXES = ['rookfall.'];

function migrate(store: Storage): void {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k !== null) keys.push(k); }
  for (const key of keys) {
    const legacy = LEGACY_PREFIXES.find((p) => key.startsWith(p));
    if (!legacy) continue;
    const next = STORAGE_PREFIX + key.slice(legacy.length);
    if (store.getItem(next) !== null) continue; // already migrated (or written by the new build)
    const value = store.getItem(key);
    if (value === null) continue;
    try {
      store.setItem(next, value);
    } catch {
      try { store.removeItem(key); store.setItem(next, value); } catch { /* still no room: keep the old key */ }
    }
  }
}

// no storage at all (private mode, a worker, the test runner): nothing to migrate
try { migrate(localStorage); } catch { /* ignore */ }
try { migrate(sessionStorage); } catch { /* ignore */ }
