// LIVE verification for remove-placeholder-and-fix-false-key-exhaustion,
// Part 2: executes the REAL worker/src/gemini.js geminiData() rotation loop
// (post-fix) against the REAL live KV key pool and the REAL Gemini API,
// with attempts logged (masked keys only) so the actual status/body of
// every attempt is captured — not assumed.
//
// PASS criteria:
//   1. the request SUCCEEDS (no allKeysFailed throw), OR
//   2. if the model is saturated again at verify time, the thrown error is
//      truthfully tagged (poolExhaustedByKeyFailures === false) and
//      allFailedMessage does NOT claim "quota exhausted or keys invalid".
//
// Usage:
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... node worker/test/live-verify-part2.mjs [model]
// Never prints credentials or full key material.

import { allFailedMessage, __testables } from '../src/gemini.js';

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
if (!account || !token) { console.error('need CF_ACCOUNT_ID, CF_API_TOKEN'); process.exit(2); }

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)} (len ${k.length})` : String(k));

// Locate the live CODEX_KV namespace (same discovery as diag/kv.mjs).
const nsRes = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces?per_page=100`,
  { headers: { Authorization: `Bearer ${token}` } });
const nsData = await nsRes.json();
const nsEntry = (nsData.result || []).find(n => /codex/i.test(n.title));
if (!nsEntry) { console.error('no codex KV namespace found'); process.exit(1); }
const ns = nsEntry.id;
console.log(`namespace: "${nsEntry.title}"`);

const kvGet = async (key) => {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`kv get ${key} -> ${r.status}`);
  return r.text();
};

const keys = JSON.parse((await kvGet('gemini:keys')) || '[]');
console.log(`pool: ${keys.length} keys: ${keys.map(mask).join(', ')}`);
const doubled = keys.findIndex(k => k.length >= 40 && k.length % 2 === 0 && k.slice(0, k.length / 2) === k.slice(k.length / 2));
console.log(doubled >= 0
  ? `pool hygiene: key [${doubled}] is STILL a stored doubled-paste concatenation (len ${keys[doubled].length}) — the addKeys fix prevents NEW ones; this pre-existing one keeps failing 401 and rotation must route around it`
  : 'pool hygiene: no doubled-paste concatenation in pool');

// Log every Gemini attempt (pass-through to the REAL API).
const attempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    const key = init && init.headers && init.headers['x-goog-api-key'];
    const res = await realFetch(url, init);
    let body = '';
    try {
      const t = await res.clone().text();
      if (!res.ok) {
        try { const d = JSON.parse(t); body = `${d.error?.status} | ${String(d.error?.message).slice(0, 100)}`; }
        catch { body = t.slice(0, 100); }
      } else body = 'OK';
    } catch { body = '(unreadable)'; }
    attempts.push({ key: mask(key), model: String(url).match(/models\/([^:]+)/)?.[1], status: res.status, body });
    return res;
  }
  return realFetch(url, init);
};

const model = process.argv[2] || 'gemini-flash-lite-latest'; // the CONFIGURED model
console.log(`model under test: ${model} (production configured model)`);

const env = {
  GEMINI_MODEL: model,
  CODEX_KV: {
    async get(k) {
      if (k === 'gemini:keys') return JSON.stringify(keys);
      if (k === 'gemini:last_ok_idx') return (await kvGet('gemini:last_ok_idx')) || '0';
      return null;
    },
    async put() {},
  },
};

const payload = { contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] };

let err = null, data = null;
const t0 = Date.now();
try { data = await __testables.geminiData(env, payload); }
catch (e) { err = e; }
const elapsed = Date.now() - t0;

console.log(`\nattempts (${attempts.length}, ${elapsed}ms):`);
for (const a of attempts) console.log(`  ${a.key}  ${a.model}  -> ${a.status}  ${a.body}`);

let pass = false;
if (data) {
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  console.log(`\nRESULT: SUCCESS — model replied (${JSON.stringify(text.slice(0, 60))})`);
  pass = true;
} else {
  console.log(`\nRESULT: threw — allKeysFailed=${!!err.allKeysFailed} keyFailures=${err.keyFailures} saturated=${err.saturated} poolExhaustedByKeyFailures=${err.poolExhaustedByKeyFailures}`);
  const msg = allFailedMessage(err);
  console.log('user-facing message:', JSON.stringify(msg));
  // A saturation-only failure is a PASS for Part 2 only if it is no longer
  // reported as exhausted/invalid keys.
  if (err.poolExhaustedByKeyFailures === false && !/quota exhausted or keys invalid/.test(msg || '')) {
    console.log('truthful saturation classification confirmed');
    pass = true;
  }
}
console.log(pass ? 'LIVE VERIFY PART 2: PASS' : 'LIVE VERIFY PART 2: FAIL');
process.exit(pass ? 0 : 1);
