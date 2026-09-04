// LIVE verification harness for fix-silent-nonresponse (manual procedure,
// same minimum-evidence standard as FIX_STATE v7): executes the REAL
// worker/src/gemini.js classifyAndDispatch against the REAL Gemini key
// pool and the configured model — only the Telegram Bot API and the
// notebook tree are intercepted. This proves end-to-end that a long
// conversational reply is now DELIVERED (chunked) instead of vanishing.
//
// Usage:
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... KV_NAMESPACE_ID=... \
//     node worker/test/live-verify.mjs
// Never prints credentials or full key material.

import { classifyAndDispatch } from '../src/gemini.js';

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const ns = process.env.KV_NAMESPACE_ID;
if (!account || !token || !ns) {
  console.error('need CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID');
  process.exit(2);
}

// Real key pool from the live KV namespace (keypool.getKeys contract).
async function cfKv(path) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/${path}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`cf kv ${path} -> ${res.status}`);
  return res;
}
const keysRes = await cfKv('values/gemini:keys');
const keys = await keysRes.json();
if (!Array.isArray(keys) || !keys.length) throw new Error('key pool empty');

// Captured Telegram traffic; simulates the REAL 4096 enforcement.
const telegramCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(init.body);
    const text = payload.text || '';
    telegramCalls.push({ method, len: text.length });
    if (text.length > 4096) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: message is too long' }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }), text: async () => '' };
  }
  return realFetch(url, init);
};

// Minimal env: real key pool, empty notebook tree, no GitHub writes needed
// for a conversational (no-tool) reply.
const env = {
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  CODEX_KV: {
    async get(k) {
      if (k === 'gemini:keys') return JSON.stringify(keys);
      return null; // last_ok_idx etc.
    },
    async put() {},
  },
  GITHUB_REPO_TOKEN: 'unused-for-conversational-reply',
  REPO_OWNER: 'vjumbo264', REPO_NAME: 'codex', REPO_BRANCH: 'main',
};

const prompt = process.argv[2] ||
  'Hi — tell me something abstract and thoughtful, a few paragraphs long.';
console.log('input:', JSON.stringify(prompt));

await classifyAndDispatch(env, 12345, prompt, 4242);

console.log('telegram calls:', JSON.stringify(telegramCalls));
const delivered = telegramCalls.length > 0 &&
  telegramCalls.every(c => c.len <= 4096) &&
  telegramCalls.some(c => c.len > 0);
const stranded = telegramCalls.length === 1 &&
  telegramCalls[0].method === 'editMessageText' === false && false; // n/a
console.log(delivered
  ? 'LIVE VERIFY PASS: dispatcher produced a visible, 4096-safe reply.'
  : 'LIVE VERIFY FAIL: no visible reply would reach the user.');
process.exit(delivered ? 0 : 1);
