// Gemini API key pool, persisted in the CODEX_DB D1 database so keys can
// be managed from inside Telegram (Settings → Keys) with no redeploy and
// no Cloudflare dashboard access. (Migrated from the CODEX_KV namespace —
// adapt-compass-pattern-d1-and-user-lock, Part 2.)
//
// D1 tables (migrations/0001_initial.sql, adapted from the Compass
// reference migrations pattern):
//   api_keys        one row per key (key_value UNIQUE, position = pool
//                   order, health fields: consecutive_errors, last_used_at)
//   key_pool_state  'last_ok_idx' = index of the last key that succeeded
//                   'migrated'    = legacy GEMINI_API_KEY promotion flag
//
// LOUD FAILURES (carried over from the KV design): a missing/broken D1
// binding must never silently behave as "zero keys configured":
//   - every D1 read/parse/write failure throws a KeyPoolError with a
//     distinct, specific message (never a silent [] or silent no-op);
//   - every write is verified by reading the rows back before success is
//     reported;
//   - the UI surfaces these errors verbatim instead of an empty list.
//
// Migration: if the pool is empty and the legacy GEMINI_API_KEY Worker
// secret is still configured, that secret is promoted into the pool as
// key #1 automatically — the operator's existing setup keeps working with
// zero manual re-adding. After a deliberate "Clear all keys" the secret
// must NOT silently reappear (the migrated flag stays set).

const LAST_OK_KEY = 'last_ok_idx';
const MIGRATED_KEY = 'migrated';

// Distinct error type so every caller can tell "key storage is broken"
// apart from "no keys configured yet" and render a specific message.
export class KeyPoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyPoolError';
    this.code = code; // 'DB_MISSING' | 'DB_READ_FAILED' | 'DB_WRITE_FAILED'
  }
}

// Operator-facing text for a KeyPoolError, or null if `e` isn't one.
// (Name kept from the KV era so existing callers don't change.)
export function kvErrorMessage(e) {
  if (e && e.name === 'KeyPoolError') {
    return `⚠️ Gemini key storage problem: ${e.message}\n\n` +
      'This is a configuration/infrastructure fault, NOT a missing key — ' +
      'any keys you add cannot be saved until it is fixed. It has been ' +
      'logged in the Worker logs.';
  }
  return null;
}

// Throws (loudly) when the binding itself is absent. Used by write paths.
function requireStore(env) {
  const s = env.CODEX_DB || null;
  if (!s) {
    throw new KeyPoolError('DB_MISSING',
      'the CODEX_DB D1 binding is not attached to the deployed Worker ' +
      '(check the [[d1_databases]] entry in the deployed wrangler.toml).');
  }
  return s;
}

// Small state helpers for key_pool_state (last_ok_idx / migrated).
async function getState(env, key) {
  const store = env.CODEX_DB || null;
  if (!store) return null;
  const row = await store.prepare('SELECT value FROM key_pool_state WHERE key = ?1').bind(key).first();
  return row ? row.value : null;
}

async function putState(env, key, value) {
  const store = requireStore(env);
  await store.prepare(
    `INSERT INTO key_pool_state (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(key, String(value)).run();
}

// Read the raw pool, ordered by pool position. A missing binding is
// reported (dbOk:false) rather than thrown here so the legacy-secret
// transient fallback in getKeys still works mid-deploy; every ACTUAL
// read failure throws.
async function readPoolRaw(env) {
  const store = env.CODEX_DB || null;
  if (!store) return { keys: [], dbOk: false };
  let rows;
  try {
    const out = await store.prepare(
      'SELECT key_value FROM api_keys ORDER BY position ASC, id ASC'
    ).all();
    rows = out.results || [];
  } catch (e) {
    throw new KeyPoolError('DB_READ_FAILED',
      `reading the key pool from D1 failed (${e && e.message ? e.message : e}).`);
  }
  return { keys: rows.map(r => r.key_value).filter(k => typeof k === 'string' && k), dbOk: true };
}

// Replace the pool atomically (one D1 batch = one transaction) AND VERIFY
// the rows read back before reporting success — the KV-era design reported
// "key added" without ever confirming the write landed.
async function writePool(env, keys) {
  const store = requireStore(env);
  const stmts = [store.prepare('DELETE FROM api_keys')];
  keys.forEach((k, i) => {
    stmts.push(store.prepare(
      'INSERT INTO api_keys (key_value, position) VALUES (?1, ?2)'
    ).bind(k, i));
  });
  try {
    await store.batch(stmts);
  } catch (e) {
    throw new KeyPoolError('DB_WRITE_FAILED',
      `writing the key pool to D1 failed (${e && e.message ? e.message : e}).`);
  }
  // Read-back confirmation.
  const { keys: back } = await readPoolRaw(env);
  if (back.length === keys.length && back.every((k, i) => k === keys[i])) return true;
  throw new KeyPoolError('DB_WRITE_FAILED',
    'D1 accepted the write but the pool did not read back — the change may not have persisted.');
}

// The effective key pool. Seeds from the legacy GEMINI_API_KEY secret ONCE
// (see header). Throws KeyPoolError when D1 is present but unreadable —
// callers must surface that, never mistake it for "no keys".
export async function getKeys(env) {
  const { keys, dbOk } = await readPoolRaw(env);
  if (!keys.length && env.GEMINI_API_KEY) {
    let migrated = false;
    if (dbOk) {
      try { migrated = !!(await getState(env, MIGRATED_KEY)); }
      catch { /* treat as not migrated */ }
    }
    if (!dbOk || !migrated) {
      const seeded = [env.GEMINI_API_KEY];
      if (dbOk) {
        try {
          await writePool(env, seeded);
          await putState(env, MIGRATED_KEY, '1');
        } catch (e) { console.error('keypool seed failed', e); }
      }
      return seeded; // transient one-key pool when D1 is absent mid-deploy
    }
  }
  return keys;
}

// Loose sanity check: long enough, no whitespace. (Gemini keys are ~39
// chars starting "AIza", but we don't hard-require the prefix.)
function looksLikeKey(s) {
  return typeof s === 'string' && s.length >= 20 && !/\s/.test(s);
}

// Add keys (array of raw strings, e.g. one per pasted line).
// Returns { added, skipped, total }. Throws KeyPoolError if the pool
// cannot be persisted — the caller MUST surface that instead of claiming
// success.
//
// Each candidate is additionally split on ALL embedded whitespace before
// validation, AND an exact self-concatenated double (a string whose two
// halves are byte-identical — the confirmed live corruption: a key pasted
// twice with no separator, stored as ONE 106-char key that returned 401 on
// every model) is reduced to a single copy before validation. Both
// defenses live here at the storage layer so they hold even if a future
// caller forgets to pre-split (router.js already splits pasted input on
// /\s+/).
function undouble(s) {
  if (s.length >= 40 && s.length % 2 === 0) {
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) return s.slice(0, half);
  }
  return s;
}

export async function addKeys(env, candidates) {
  const keys = await getKeys(env);
  const existing = new Set(keys);
  let added = 0, skipped = 0;
  for (const raw of candidates) {
    for (const piece of String(raw || '').split(/\s+/)) {
      const k = undouble(piece.trim());
      if (!k) continue;
      if (!looksLikeKey(k) || existing.has(k)) { skipped++; continue; }
      keys.push(k); existing.add(k); added++;
    }
  }
  if (added) await writePool(env, keys); // throws loudly on failure
  return { added, skipped, total: keys.length };
}

// Remove the key at index `idx` (indexes match what the Keys screen shows).
// Returns the removed key, or null when the index is out of range (e.g. a
// stale button tapped twice — the caller reports that explicitly).
// Throws KeyPoolError on storage failure.
export async function removeKeyAt(env, idx) {
  const keys = await getKeys(env);
  if (idx < 0 || idx >= keys.length) return null;
  const [removed] = keys.splice(idx, 1);
  await writePool(env, keys);
  const last = await getLastOkIndex(env);
  if (last >= keys.length) await setLastOkIndex(env, 0);
  return removed;
}

export async function clearKeys(env) {
  const keys = await getKeys(env);
  await writePool(env, []);
  await setLastOkIndex(env, 0);
  // Deliberate clear: never re-seed the legacy secret after this.
  try { await putState(env, MIGRATED_KEY, '1'); }
  catch (e) {
    if (e && e.name === 'KeyPoolError') throw e;
    /* non-fatal: flag write is best-effort */
  }
  return keys.length;
}

export function maskKey(k) {
  const s = String(k || '');
  return s.length > 4 ? `…${s.slice(-4)}` : '…????';
}

// Last-successful key index is an optimisation, not state that must be
// loud: failures here degrade to "start from key 0" and stay soft.
export async function getLastOkIndex(env) {
  const store = env.CODEX_DB || null;
  if (!store) return 0;
  try {
    const raw = await getState(env, LAST_OK_KEY);
    const n = parseInt(raw || '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

export async function setLastOkIndex(env, idx) {
  const store = env.CODEX_DB || null;
  if (!store) return;
  try { await putState(env, LAST_OK_KEY, String(idx)); }
  catch (e) { console.error('keypool last_ok write failed', e); }
}
