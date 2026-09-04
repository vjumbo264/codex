// Regression tests for remove-placeholder-and-fix-false-key-exhaustion,
// Part 2: the FALSE "Every configured Gemini API key failed (quota
// exhausted or keys invalid)" report.
//
// CONFIRMED ROOT CAUSE (see FIX_STATE.json -> part2_key_exhaustion,
// evidence captured live by worker/test/diag/*.mjs):
//   1. The configured model (gemini-flash-lite-latest) was returning
//      503 UNAVAILABLE "high demand" on EVERY key in the pool at once —
//      a MODEL-side saturation wave, not a key problem. geminiData let
//      that collapse into the same allKeysFailed error as genuinely dead
//      keys, and allFailedMessage then told the operator their keys were
//      "quota exhausted or keys invalid" — a false negative. Live diag
//      evidence: the identical request succeeded seconds later, and the
//      same keys returned 200 on gemini-3.1-flash-lite at the same time.
//   2. A corrupted DOUBLED-PASTE key (106 chars = 2x53, confirmed 401 on
//      every model) had entered the pool because the Settings → Keys
//      paste parser split only on '\n', storing two concatenated keys as
//      one permanently-dead entry.
//
// adapt-compass-pattern-d1-and-user-lock, Part 2: these tests now drive
// the key pool against a D1 stub (the pool migrated from CODEX_KV to the
// CODEX_DB D1 database — api_keys + key_pool_state tables), replacing the
// old KV mocks. Same assertions, same coverage.
//
// The tests stub globalThis.fetch with a scripted Gemini API and run the
// REAL worker/src/gemini.js geminiData/allFailedMessage + the REAL
// worker/src/keypool.js against the D1 stub. No network, no credentials.
// Run: node worker/test/false-key-exhaustion.test.mjs

import { allFailedMessage, __testables } from '../src/gemini.js';
import { addKeys, getKeys } from '../src/keypool.js';

const { geminiData } = __testables;

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

// ---- harness ------------------------------------------------------------
// D1 stub: an in-memory implementation of the api_keys / key_pool_state /
// sys_state schema (migrations/0001_initial.sql) exposing the D1 binding
// surface keypool.js uses: prepare().bind().{first,all,run} + batch().
export function makeD1({ keys = [], state = {} } = {}) {
  const rows = keys.map((k, i) => ({ id: i + 1, key_value: k, position: i }));
  const kv = new Map(Object.entries(state));
  const calls = [];
  function exec(sql, args) {
    calls.push({ sql, args });
    if (/SELECT key_value FROM api_keys/.test(sql)) {
      const sorted = [...rows].sort((a, b) => a.position - b.position || a.id - b.id);
      return { results: sorted.map(r => ({ key_value: r.key_value })) };
    }
    if (/SELECT value FROM key_pool_state/.test(sql)) {
      return kv.has(args[0]) ? { value: kv.get(args[0]) } : null;
    }
    if (/SELECT value FROM sys_state/.test(sql)) {
      return kv.has(args[0]) ? { value: kv.get(args[0]) } : null;
    }
    if (/DELETE FROM api_keys/.test(sql)) { rows.length = 0; return { meta: {} }; }
    if (/INSERT INTO api_keys/.test(sql)) {
      rows.push({ id: rows.length + 1, key_value: args[0], position: args[1] });
      return { meta: {} };
    }
    if (/INSERT INTO key_pool_state/.test(sql)) { kv.set(args[0], String(args[1])); return { meta: {} }; }
    if (/INSERT INTO sys_state/.test(sql)) { kv.set(args[0], String(args[1])); return { meta: {} }; }
    throw new Error('D1 stub: unexpected SQL: ' + sql);
  }
  const prepare = (sql) => {
    const mk = (args) => ({
      first: async () => { const r = exec(sql, args); return (r && !r.results) ? r : (r && r.results ? (r.results[0] ?? null) : null); },
      all: async () => { const r = exec(sql, args); return { results: r && r.results ? r.results : [] }; },
      run: async () => { exec(sql, args); return { meta: { changes: 1 } }; },
    });
    return { bind: (...args) => mk(args), ...mk([]) };
  };
  return {
    db: { prepare, batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
    calls, rows, kv,
  };
}

// Env with a pool of N fake keys, sticky index 0.
function makeEnv(nKeys) {
  return {
    CODEX_DB: makeD1({
      keys: Array.from({ length: nKeys }, (_, i) => `FAKEKEY${i}abcdefghijklmnop`),
      state: { last_ok_idx: '0', migrated: '1' },
    }).db,
    GEMINI_MODEL: 'gemini-test-model',
  };
}

// Gemini stub: `script(idx, callCountForIdx)` -> {status, body} per attempt.
// Records every attempt for assertion.
function stubGemini(script) {
  const attempts = [];
  const counts = new Map();
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) {
      throw new Error('unexpected fetch: ' + url);
    }
    const key = init.headers['x-goog-api-key'];
    const idx = parseInt(key.match(/^FAKEKEY(\d+)/)[1], 10);
    const n = (counts.get(idx) || 0) + 1;
    counts.set(idx, n);
    const out = script(idx, n);
    attempts.push({ idx, call: n, status: out.status });
    if (out.status === 200) {
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] } }] }),
        text: async () => '',
      };
    }
    return {
      ok: false, status: out.status,
      json: async () => ({}),
      text: async () => out.body,
    };
  };
  return attempts;
}

const PAYLOAD = { contents: [{ parts: [{ text: 'hi' }] }] };
const B503 = JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } });
const B401 = JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials. Expected OAuth 2 access token.' } });
const B429 = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric.' } });

// Shrink the Part-2 backoff for tests (real value is 1500ms).
__testables.setBackoffForTests(1);

// --- 1. CONFIRMED SCENARIO: pool-wide 503 saturation, then recovery ------
// Live evidence: run 1 all keys 503 -> old code threw the false
// "quota exhausted or keys invalid" error; run 2 seconds later succeeded.
// New code must absorb the wave via the bounded whole-pool retry.
{
  const attempts = stubGemini((idx, call) => {
    // Every key 503s on its first two calls (attempt + same-key retry)
    // during the FIRST sweep; the post-backoff second sweep succeeds.
    return call <= 2 ? { status: 503, body: B503 } : { status: 200 };
  });
  const data = await geminiData(makeEnv(7), PAYLOAD);
  ok(data && data.candidates, '503 saturation wave absorbed: whole-pool backoff retry SUCCEEDS');
  ok(attempts.filter(a => a.status === 503).length === 14,
    'first sweep tried all 7 keys x2 (attempt + same-key retry) = 14 saturated calls');
  ok(attempts[attempts.length - 1].status === 200, 'final attempt succeeded');
}

// --- 2. Persistent saturation -> truthful message, NOT "keys invalid" ----
{
  stubGemini(() => ({ status: 503, body: B503 })); // never recovers
  let err = null;
  try { await geminiData(makeEnv(7), PAYLOAD); } catch (e) { err = e; }
  ok(err && err.allKeysFailed, 'persistent 503 pool-wide still throws allKeysFailed (bounded, not infinite)');
  ok(err.poolExhaustedByKeyFailures === false, 'error tagged: pool NOT exhausted by key failures');
  ok(err.keyFailures === 0 && err.saturated > 0, 'tallies: 0 key failures, >0 saturated');
  const msg = allFailedMessage(err);
  ok(/temporarily overloaded/i.test(msg), 'message says the MODEL is temporarily overloaded');
  ok(!/quota exhausted or keys invalid/.test(msg),
    'REGRESSION: message must NOT falsely claim "quota exhausted or keys invalid" for a 503 wave');
  ok(/keys are fine/i.test(msg), 'message reassures the operator their keys are fine');
}

// --- 3. Genuine key failures still reported as key failures ---------------
{
  // Every key is dead: 401 (like the corrupted doubled-paste key[4]).
  stubGemini(() => ({ status: 401, body: B401 }));
  let err = null;
  try { await geminiData(makeEnv(7), PAYLOAD); } catch (e) { err = e; }
  ok(err && err.allKeysFailed, 'all-dead pool throws allKeysFailed');
  ok(err.poolExhaustedByKeyFailures === true, 'error tagged: pool exhausted BY key failures');
  ok(err.keyFailures === 7, 'tallies: all 7 counted as key-specific failures');
  const msg = allFailedMessage(err);
  ok(/key-specific error/.test(msg) && /quota exhausted or key invalid/.test(msg),
    'genuine key-failure message keeps the accurate quota/invalid wording with a count');
  ok(!/keys are fine/i.test(msg), 'genuine key failure does NOT claim keys are fine');
}

// --- 4. Mixed pool: one dead key, rest saturated -> rotates, truthful -----
{
  // key 0 dead (401), keys 1..6 saturated first sweep, success on backoff.
  const attempts = stubGemini((idx, call) => {
    if (idx === 0) return { status: 401, body: B401 };
    return call <= 2 ? { status: 503, body: B503 } : { status: 200 };
  });
  const data = await geminiData(makeEnv(3), PAYLOAD);
  ok(data && data.candidates, 'mixed pool: rotates past dead key and absorbs 503 wave');
  ok(attempts.some(a => a.idx === 0 && a.status === 401), 'dead key was tried and classified key-specific');
}

// --- 5. Real per-key 429 still rotates (behavior unchanged) ----------------
{
  const attempts = stubGemini((idx) => (idx === 0 ? { status: 429, body: B429 } : { status: 200 }));
  const data = await geminiData(makeEnv(3), PAYLOAD);
  ok(data && data.candidates, '429 on key 0 rotates to key 1 and succeeds');
  ok(attempts.length === 2, 'no wasted attempts (429 is key-specific: rotate immediately, no same-key retry)');
}

// --- 6. allFailedMessage: no 5xx, no key failure -> honest generic ---------
{
  const msg = allFailedMessage({ allKeysFailed: true, poolExhaustedByKeyFailures: false, saturated: 0 });
  ok(/no key reported a key-specific failure/i.test(msg),
    'edge case (no key failures, no saturation) gets an honest non-accusatory message');
}

// --- 7. KeyPoolError still takes precedence --------------------------------
{
  const msg = allFailedMessage({ name: 'KeyPoolError', message: 'D1 gone' });
  ok(/key storage problem/i.test(msg), 'KeyPoolError message unchanged and still takes precedence');
}

// --- 8. addKeys hygiene: doubled-paste can never enter the pool ---------
// Confirmed live evidence: the pool's key [4] was a 106-char concatenation
// (one 53-char key pasted twice with NO newline) that returned 401 on every
// model. The old \n-only parse stored it as one permanently-dead key.
{
  const K1 = 'A'.repeat(53), K2 = 'B'.repeat(53), K3 = 'C'.repeat(53);
  const env = { CODEX_DB: makeD1({ keys: [], state: { migrated: '1' } }).db };
  // The exact corruption shapes: newline-separated with a doubled line,
  // whitespace-run paste, and a byte-exact self-concatenation.
  const res = await addKeys(env, [`${K1}\n${K2}${K2}`, `${K3}   ${K1}`]);
  const pool = await getKeys(env);
  ok(res.added === 3, `doubled/whitespace pastes yield 3 keys, got ${res.added}`);
  ok(pool.length === 3 && pool.every(k => k.length === 53),
    'pool holds three clean 53-char keys — no 106-char concatenation stored');
  ok(new Set(pool).size === 3, 'no duplicates entered the pool');
  // Re-adding the same keys is idempotent.
  const res2 = await addKeys(env, [K1, K2, K3]);
  ok(res2.added === 0 && res2.skipped === 3, 're-adding existing keys skips all (idempotent)');
}

// --- 9. D1 storage semantics: remove/clear/last_ok round-trip --------------
// The KV->D1 port must preserve the exact key-pool management contract the
// Settings UI depends on (order, removal by index, clear, sticky index).
{
  const { removeKeyAt, clearKeys, getLastOkIndex, setLastOkIndex } = await import('../src/keypool.js');
  const env = { CODEX_DB: makeD1({ keys: ['K0abcdefghijklmnopqrst', 'K1abcdefghijklmnopqrst', 'K2abcdefghijklmnopqrst'], state: { migrated: '1', last_ok_idx: '2' } }).db };
  const removed = await removeKeyAt(env, 1);
  ok(removed === 'K1abcdefghijklmnopqrst', 'removeKeyAt removes the key at the displayed index');
  const pool = await getKeys(env);
  ok(pool.length === 2 && pool[0].startsWith('K0') && pool[1].startsWith('K2'),
    'pool order preserved after removal (positions rewritten compactly)');
  ok((await getLastOkIndex(env)) === 0, 'last_ok_idx reset when it points past the shrunken pool');
  await setLastOkIndex(env, 1);
  ok((await getLastOkIndex(env)) === 1, 'setLastOkIndex/getLastOkIndex round-trip via key_pool_state');
  const stale = await removeKeyAt(env, 9);
  ok(stale === null, 'removeKeyAt on a stale index returns null (double-tap safe)');
  const n = await clearKeys(env);
  ok(n === 2 && (await getKeys(env)).length === 0, 'clearKeys empties the pool and reports the count');
}

// --- 10. LOUD failure: a missing D1 binding is NOT "no keys" ---------------
{
  const { getKeys: gk } = await import('../src/keypool.js');
  const keys = await gk({ CODEX_DB: null, GEMINI_API_KEY: 'LEGACYSECRETKEYabcdefghijkl' });
  ok(keys.length === 1 && keys[0].startsWith('LEGACYSECRETKEY'),
    'missing binding mid-deploy degrades to the transient legacy-secret pool (never silent zero)');
  let threw = null;
  const brokenDb = { prepare() { return { bind() { return this; }, async all() { throw new Error('boom'); }, async first() { throw new Error('boom'); }, async run() { throw new Error('boom'); } }; } };
  try { await gk({ CODEX_DB: brokenDb }); } catch (e) { threw = e; }
  ok(threw && threw.name === 'KeyPoolError' && /D1 failed/.test(threw.message),
    'a broken D1 binding throws a LOUD KeyPoolError, never a silent empty pool');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
