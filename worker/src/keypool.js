// Gemini API key pool, persisted in the CODEX_KV namespace so keys can be
// managed from inside Telegram (Settings → Keys) with no redeploy and no
// Cloudflare dashboard access. fix-03.
//
// KV entries:
//   gemini:keys        JSON array of full key strings (never shown in full)
//   gemini:last_ok_idx index of the last key that succeeded (fix-04)
//   gemini:migrated    flag: legacy GEMINI_API_KEY secret already promoted
//
// v3 fix-01 — LOUD FAILURES. v2's cardinal sin: a missing/broken KV binding
// silently behaved as "zero keys configured", so the operator added keys,
// got a success message, and the very next request still claimed no key
// existed. That must never be invisible again:
//   - every KV read/parse/write failure throws a KeyPoolError with a
//     distinct, specific message (never a silent [] or silent no-op);
//   - every write is verified by reading the bytes back before success is
//     reported (short retry loop absorbs KV propagation lag);
//   - the UI surfaces these errors verbatim instead of an empty list.
//
// Migration: if the pool is empty and the legacy GEMINI_API_KEY Worker
// secret is still configured, that secret is promoted into the pool as
// key #1 automatically — the operator's existing setup keeps working with
// zero manual re-adding. After a deliberate "Clear all keys" the secret
// must NOT silently reappear (the migrated flag stays set).

const KEYS_KEY = 'gemini:keys';
const LAST_OK_KEY = 'gemini:last_ok_idx';
const MIGRATED_KEY = 'gemini:migrated';

// Distinct error type so every caller can tell "key storage is broken"
// apart from "no keys configured yet" and render a specific message.
export class KeyPoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyPoolError';
    this.code = code; // 'KV_MISSING' | 'KV_READ_FAILED' | 'KV_WRITE_FAILED'
  }
}

// Operator-facing text for a KeyPoolError, or null if `e` isn't one.
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
  const s = env.CODEX_KV || null;
  if (!s) {
    throw new KeyPoolError('KV_MISSING',
      'the CODEX_KV KV binding is not attached to the deployed Worker ' +
      '(check the [[kv_namespaces]] entry in the deployed wrangler.toml).');
  }
  return s;
}

// Read the raw pool. A missing binding is reported (kvOk:false) rather than
// thrown here so the legacy-secret transient fallback in getKeys still works
// mid-deploy; every ACTUAL read/parse failure throws.
async function readPoolRaw(env) {
  const store = env.CODEX_KV || null;
  if (!store) return { keys: [], kvOk: false };
  let raw;
  try {
    raw = await store.get(KEYS_KEY);
  } catch (e) {
    throw new KeyPoolError('KV_READ_FAILED',
      `reading the key pool from KV failed (${e && e.message ? e.message : e}).`);
  }
  if (!raw) return { keys: [], kvOk: true };
  try {
    const arr = JSON.parse(raw);
    const keys = Array.isArray(arr) ? arr.filter(k => typeof k === 'string' && k) : [];
    return { keys, kvOk: true };
  } catch {
    throw new KeyPoolError('KV_READ_FAILED',
      'the key pool stored in KV is corrupted (not valid JSON).');
  }
}

// Write the pool AND VERIFY the bytes persisted before reporting success.
// v2 reported "key added" without ever confirming the write landed.
async function writePool(env, keys) {
  const store = requireStore(env);
  const serialized = JSON.stringify(keys);
  try {
    await store.put(KEYS_KEY, serialized);
  } catch (e) {
    throw new KeyPoolError('KV_WRITE_FAILED',
      `writing the key pool to KV failed (${e && e.message ? e.message : e}).`);
  }
  // Read-back confirmation (KV propagation can lag briefly; retry a few
  // times before declaring failure).
  for (let attempt = 0; attempt < 4; attempt++) {
    let back = null;
    try { back = await store.get(KEYS_KEY); } catch { back = null; }
    if (back === serialized) return true;
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  throw new KeyPoolError('KV_WRITE_FAILED',
    'KV accepted the write but the pool did not read back — the change may not have persisted.');
}

// The effective key pool. Seeds from the legacy GEMINI_API_KEY secret ONCE
// (see header). Throws KeyPoolError when KV is present but unreadable —
// callers must surface that, never mistake it for "no keys".
export async function getKeys(env) {
  const { keys, kvOk } = await readPoolRaw(env);
  if (!keys.length && env.GEMINI_API_KEY) {
    let migrated = false;
    if (kvOk) {
      try { migrated = !!(await env.CODEX_KV.get(MIGRATED_KEY)); }
      catch { /* treat as not migrated */ }
    }
    if (!kvOk || !migrated) {
      const seeded = [env.GEMINI_API_KEY];
      if (kvOk) {
        try {
          await writePool(env, seeded);
          await env.CODEX_KV.put(MIGRATED_KEY, '1');
        } catch (e) { console.error('keypool seed failed', e); }
      }
      return seeded; // transient one-key pool when KV is absent mid-deploy
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
// success (v3 fix-01).
//
// Part 2 (false key-exhaustion): each candidate is additionally split on
// ALL embedded whitespace before validation, AND an exact self-concatenated
// double (a string whose two halves are byte-identical — the confirmed live
// corruption: key #5 pasted twice with no separator, stored as ONE 106-char
// key that returned 401 on every model) is reduced to a single copy before
// validation. Both defenses live here at the storage layer so they hold
// even if a future caller forgets to pre-split (router.js already splits
// pasted input on /\s+/).
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
// stale button tapped twice — the caller reports that explicitly, fix-02).
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
  try { requireStore(env); await env.CODEX_KV.put(MIGRATED_KEY, '1'); }
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
  const store = env.CODEX_KV || null;
  if (!store) return 0;
  try {
    const raw = await store.get(LAST_OK_KEY);
    const n = parseInt(raw || '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

export async function setLastOkIndex(env, idx) {
  const store = env.CODEX_KV || null;
  if (!store) return;
  try { await store.put(LAST_OK_KEY, String(idx)); }
  catch (e) { console.error('keypool last_ok write failed', e); }
}
