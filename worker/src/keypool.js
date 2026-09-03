// Gemini API key pool, persisted in the CODEX_KV namespace so keys can be
// managed from inside Telegram (Settings → Keys) with no redeploy and no
// Cloudflare dashboard access. fix-03.
//
// KV entries:
//   gemini:keys        JSON array of full key strings (never shown in full)
//   gemini:last_ok_idx index of the last key that succeeded (fix-04)
//
// Migration: if the pool is empty and the legacy GEMINI_API_KEY Worker
// secret is still configured, that secret is promoted into the pool as
// key #1 automatically — the operator's existing setup keeps working with
// zero manual re-adding.

const KEYS_KEY = 'gemini:keys';
const LAST_OK_KEY = 'gemini:last_ok_idx';
const MIGRATED_KEY = 'gemini:migrated';

function kv(env) { return env.CODEX_KV || null; }

async function readPool(env) {
  const store = kv(env);
  if (!store) return [];
  try {
    const raw = await store.get(KEYS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(k => typeof k === 'string' && k) : [];
  } catch (e) {
    console.error('keypool read failed', e);
    return [];
  }
}

async function writePool(env, keys) {
  const store = kv(env);
  if (!store) return false;
  await store.put(KEYS_KEY, JSON.stringify(keys));
  return true;
}

// The effective key pool. Seeds from the legacy GEMINI_API_KEY secret ONCE:
// when the pool is empty, the secret exists, and the migration flag is not
// yet set, the secret is promoted into the pool as key #1 and the flag is
// written. The flag matters: after a deliberate "Clear all keys" the
// secret must NOT silently reappear. When KV is unavailable the secret is
// still used as a transient one-key pool so nothing breaks mid-deploy.
export async function getKeys(env) {
  let keys = await readPool(env);
  if (!keys.length && env.GEMINI_API_KEY) {
    const store = kv(env);
    let migrated = false;
    if (store) {
      try { migrated = !!(await store.get(MIGRATED_KEY)); }
      catch { /* treat as not migrated */ }
    }
    if (!store || !migrated) {
      keys = [env.GEMINI_API_KEY];
      if (store) {
        try {
          await store.put(KEYS_KEY, JSON.stringify(keys));
          await store.put(MIGRATED_KEY, '1');
        } catch (e) { console.error('keypool seed failed', e); }
      }
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
// Returns { added, skipped, total }.
export async function addKeys(env, candidates) {
  const keys = await getKeys(env);
  const existing = new Set(keys);
  let added = 0, skipped = 0;
  for (const raw of candidates) {
    const k = String(raw || '').trim();
    if (!looksLikeKey(k) || existing.has(k)) { skipped++; continue; }
    keys.push(k); existing.add(k); added++;
  }
  if (added) await writePool(env, keys);
  return { added, skipped, total: keys.length };
}

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
  const store = kv(env);
  if (store) {
    try { await store.put(MIGRATED_KEY, '1'); } catch { /* non-fatal */ }
  }
  return keys.length;
}

export function maskKey(k) {
  const s = String(k || '');
  return s.length > 4 ? `…${s.slice(-4)}` : '…????';
}

export async function getLastOkIndex(env) {
  const store = kv(env);
  if (!store) return 0;
  const raw = await store.get(LAST_OK_KEY);
  const n = parseInt(raw || '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function setLastOkIndex(env, idx) {
  const store = kv(env);
  if (!store) return;
  await store.put(LAST_OK_KEY, String(idx));
}
