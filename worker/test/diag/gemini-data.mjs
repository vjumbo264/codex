// Part 2 investigation step 3: run the worker's REAL geminiData() rotation
// loop (imported verbatim from worker/src/gemini.js) against the REAL live
// KV key pool — a faithful "one failing request" capture of which key index
// was tried, what status/body came back, and how isKeyFailure classified it.
// Runs twice per model to expose flakiness. Masked keys only.
import { gemini } from '../../src/gemini.js';

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const ns = process.env.KV_NAMESPACE_ID;
if (!account || !token || !ns) { console.error('need CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID'); process.exit(2); }

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)}` : '…????');

const r = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/gemini%3Akeys`,
  { headers: { Authorization: `Bearer ${token}` } });
const keys = await r.json();
console.log(`real pool loaded: ${keys.length} keys (${keys.map(mask).join(', ')})`);

// Intercept fetch ONLY to log Gemini attempts (pass-through to real network).
const attempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    const key = init && init.headers && init.headers['x-goog-api-key'];
    const res = await realFetch(url, init);
    const clone = res.clone();
    let body = '';
    try {
      const t = await clone.text();
      if (!res.ok) {
        try { const d = JSON.parse(t); body = `${d.error?.status} | ${String(d.error?.message).slice(0, 110)}`; }
        catch { body = t.slice(0, 110); }
      } else {
        body = 'OK';
      }
    } catch { body = '(unreadable)'; }
    attempts.push({ key: mask(key), model: String(url).match(/models\/([^:]+)/)?.[1], status: res.status, body });
    return res;
  }
  return realFetch(url, init);
};

const env = {
  CODEX_KV: {
    async get(k) {
      if (k === 'gemini:keys') return JSON.stringify(keys);
      if (k === 'gemini:last_ok_idx') return '0';
      return null;
    },
    async put() {},
  },
};

const payload = {
  contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }],
  generationConfig: { temperature: 0.2, maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 32 } },
};

for (const model of ['gemini-flash-lite-latest', 'gemini-flash-latest']) {
  for (let run = 1; run <= 2; run++) {
    env.GEMINI_MODEL = model;
    attempts.length = 0;
    process.stdout.write(`\ngeminiData via gem() | model=${model} run=${run}\n`);
    try {
      const out = await gemini(env, payload);
      console.log(`  RESULT: SUCCESS -> ${JSON.stringify(out.slice(0, 60))}`);
    } catch (e) {
      console.log(`  RESULT: THREW allKeysFailed=${!!e.allKeysFailed} msg=${String(e.message).slice(0, 200)}`);
    }
    for (const a of attempts) console.log(`    attempt: ${a.key} ${a.model} -> ${a.status} ${a.body}`);
  }
}
