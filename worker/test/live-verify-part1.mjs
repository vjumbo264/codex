// LIVE verification for remove-placeholder-and-fix-false-key-exhaustion,
// Part 1: executes the REAL worker/src/gemini.js routeFreeText() dispatch
// path against the REAL live KV key pool, the REAL live notebook tree, and
// the REAL Gemini API — only the Telegram Bot API is intercepted (every
// method call captured). Proves the Compass one-message shape: the user's
// next visible message after their input is the REAL reply, with ZERO
// intermediate "⏳ Working on it…"-style placeholder messages.
//
// PASS criteria:
//   1. at least one Telegram sendMessage/editMessageText was captured (a
//      real reply WOULD be visible), and
//   2. NO captured call carries the placeholder text pattern, and
//   3. NO send-then-edit placeholder cycle (a sendMessage whose id is then
//      edited with the actual reply is exactly the pattern being removed —
//      for free-text dispatch there must be no editMessageText at all
//      unless a genuinely long-running sub-operation was invoked, which
//      this conversational input does not).
//
// Usage:
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... node worker/test/live-verify-part1.mjs ["prompt"] [model]
// Never prints credentials or full key material.

import { routeFreeText } from '../src/gemini.js';

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
if (!account || !token) { console.error('need CF_ACCOUNT_ID, CF_API_TOKEN'); process.exit(2); }

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)} (len ${k.length})` : String(k));

// Real key pool from the live KV namespace.
const nsRes = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces?per_page=100`,
  { headers: { Authorization: `Bearer ${token}` } });
const nsEntry = ((await nsRes.json()).result || []).find(n => /codex/i.test(n.title));
if (!nsEntry) { console.error('no codex KV namespace found'); process.exit(1); }
const ns = nsEntry.id;
const kvGet = async (key) => {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`kv get ${key} -> ${r.status}`);
  return r.text();
};
const keys = JSON.parse((await kvGet('gemini:keys')) || '[]');
console.log(`pool: ${keys.length} keys (${keys.map(mask).join(', ')})`);

// Capture ALL Telegram Bot API calls (pass nothing through).
const telegramCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) {
    const method = String(url).split('/').pop();
    const payload = init && init.body ? JSON.parse(init.body) : {};
    telegramCalls.push({
      method,
      len: (payload.text || '').length,
      textHead: (payload.text || '').slice(0, 60),
      editsMessage: payload.message_id ?? null,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }), text: async () => '' };
  }
  return realFetch(url, init);
};

const prompt = process.argv[2] || 'Hi — what do you think about the color of Tuesday?';
const model = process.argv[3] || 'gemini-flash-latest'; // healthy model: isolates Part 1 from the lite alias's live saturation
console.log(`input: ${JSON.stringify(prompt)}\nmodel: ${model}`);

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
  GITHUB_REPO_TOKEN: process.env.GITHUB_REPO_TOKEN || 'unused',
  REPO_OWNER: 'vjumbo264', REPO_NAME: 'codex', REPO_BRANCH: 'main',
};

const message = { chat: { id: 12345 }, message_id: 777, from: { id: 12345 } };
await routeFreeText(env, message, prompt);

console.log('\ntelegram calls captured:');
for (const c of telegramCalls) {
  console.log(`  ${c.method}  len=${c.len}${c.editsMessage ? `  edits msg ${c.editsMessage}` : ''}  ${JSON.stringify(c.textHead)}`);
}

const visible = telegramCalls.filter(c => ['sendMessage', 'editMessageText'].includes(c.method));
const placeholder = telegramCalls.filter(c => /working on it|filing/i.test(c.textHead));
// For a conversational (no-tool) turn there must be NO edit cycle at all:
// the reply is a single direct sendMessage.
const editCycle = telegramCalls.filter(c => c.method === 'editMessageText');

let pass = true;
if (!visible.length) { console.log('\nFAIL: no visible reply captured'); pass = false; }
if (placeholder.length) { console.log('\nFAIL: placeholder-pattern message captured'); pass = false; }
if (editCycle.length) { console.log('\nFAIL: send-then-edit placeholder cycle detected (editMessageText present on a no-tool turn)'); pass = false; }
if (pass) {
  console.log(`\nPASS: exactly ${visible.length} direct message(s), no placeholder, no edit cycle — Compass one-message shape confirmed live.`);
}
console.log(pass ? 'LIVE VERIFY PART 1: PASS' : 'LIVE VERIFY PART 1: FAIL');
process.exit(pass ? 0 : 1);
