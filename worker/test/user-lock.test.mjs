// Regression tests for adapt-compass-pattern-d1-and-user-lock,
// Part 3: the bot is locked to a SINGLE authorized Telegram user id
// (AUTHORIZED_USER_ID env var; provisioned value 6339561761).
//
// These tests drive the REAL worker/src/index.js fetch handler with
// constructed webhook updates and a stubbed Telegram API, and assert:
//   - an unauthorized sender gets ONE short refusal message;
//   - NO tool call, NO D1 access, NO Gemini call, no command-menu sync
//     happens for that sender — across EVERY entry point (text, photo,
//     voice, document, callback_query button taps);
//   - the check fails CLOSED when AUTHORIZED_USER_ID is unset;
//   - a wrong webhook secret is still a bare 403;
//   - the authorized user is routed normally.
//
// No network, no credentials. Run: node worker/test/user-lock.test.mjs

import worker from '../src/index.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

const AUTHORIZED = 6339561761;
const STRANGER = 111111111;

// ---- stubs ---------------------------------------------------------------
const tgCalls = [];
const geminiCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) {
    const method = u.split('/').pop();
    let payload = {};
    try { payload = init.body ? JSON.parse(init.body) : {}; } catch { /* form data */ }
    tgCalls.push({ method, payload });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, result: { message_id: 1000 + tgCalls.length } }),
      text: async () => '',
    };
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls.push(u);
    throw new Error('Gemini must never be called in these tests');
  }
  throw new Error('unexpected fetch: ' + u);
};

// D1 stub that RECORDS every access — the lock must mean zero D1 work.
function makeRecordingDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      const stmt = {
        bind() { return stmt; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { meta: {} }; },
      };
      return stmt;
    },
    async batch() { calls.push('BATCH'); return []; },
  };
}

function makeEnv(extra = {}) {
  return {
    WEBHOOK_SECRET: 'test-secret',
    TELEGRAM_BOT_TOKEN: 'test-token',
    AUTHORIZED_USER_ID: String(AUTHORIZED),
    CODEX_DB: makeRecordingDb(),
    ...extra,
  };
}

function post(update, secret = 'test-secret') {
  return new Request('https://codex-bot.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  });
}

async function run(update, env) {
  tgCalls.length = 0;
  geminiCalls.length = 0;
  const res = await worker.fetch(post(update), env, {});
  return res;
}

const baseMsg = { message_id: 1, chat: { id: AUTHORIZED, type: 'private' }, date: 1 };

// --- 1. Unauthorized TEXT message -----------------------------------------
{
  const env = makeEnv();
  const res = await run({ update_id: 1, message: { ...baseMsg, from: { id: STRANGER }, text: 'hello bot' } }, env);
  ok(res.status === 200, 'unauthorized text: webhook still acks 200 (no Telegram retry storm)');
  const sends = tgCalls.filter(c => c.method === 'sendMessage');
  ok(sends.length === 1 && /not available for this user/i.test(sends[0].payload.text),
    'unauthorized text: exactly ONE short refusal message');
  ok(env.CODEX_DB.calls.length === 0, 'unauthorized text: ZERO D1 access');
  ok(geminiCalls.length === 0, 'unauthorized text: ZERO Gemini calls');
  ok(!tgCalls.some(c => c.method === 'setMyCommands'), 'unauthorized text: no command-menu sync (check runs before syncCommandMenu)');
  ok(!tgCalls.some(c => c.method === 'sendChatAction'), 'unauthorized text: no typing indicator');
}

// --- 2. Unauthorized PHOTO message ----------------------------------------
{
  const env = makeEnv();
  const res = await run({ update_id: 2, message: { ...baseMsg, from: { id: STRANGER }, photo: [{ file_id: 'x', width: 1, height: 1 }] } }, env);
  ok(res.status === 200, 'unauthorized photo: acks 200');
  ok(tgCalls.filter(c => c.method === 'sendMessage').length === 1, 'unauthorized photo: refusal message sent');
  ok(!tgCalls.some(c => c.method === 'getFile'), 'unauthorized photo: file is NEVER downloaded');
  ok(env.CODEX_DB.calls.length === 0 && geminiCalls.length === 0, 'unauthorized photo: no D1, no Gemini');
}

// --- 3. Unauthorized VOICE message ----------------------------------------
{
  const env = makeEnv();
  const res = await run({ update_id: 3, message: { ...baseMsg, from: { id: STRANGER }, voice: { file_id: 'v' } } }, env);
  ok(res.status === 200 && tgCalls.filter(c => c.method === 'sendMessage').length === 1,
    'unauthorized voice: refused with one message');
  ok(!tgCalls.some(c => c.method === 'getFile'), 'unauthorized voice: audio NEVER downloaded');
  ok(env.CODEX_DB.calls.length === 0 && geminiCalls.length === 0, 'unauthorized voice: no D1, no Gemini');
}

// --- 4. Unauthorized DOCUMENT message -------------------------------------
{
  const env = makeEnv();
  const res = await run({ update_id: 4, message: { ...baseMsg, from: { id: STRANGER }, document: { file_id: 'd', file_name: 'notes.md', mime_type: 'text/markdown' } } }, env);
  ok(res.status === 200 && tgCalls.filter(c => c.method === 'sendMessage').length === 1,
    'unauthorized document: refused with one message');
  ok(!tgCalls.some(c => c.method === 'getFile'), 'unauthorized document: file NEVER downloaded');
  ok(env.CODEX_DB.calls.length === 0 && geminiCalls.length === 0, 'unauthorized document: no D1, no Gemini');
}

// --- 5. Unauthorized CALLBACK QUERY (button tap) ---------------------------
{
  const env = makeEnv();
  const res = await run({
    update_id: 5,
    callback_query: {
      id: 'cbq1', from: { id: STRANGER }, data: 'h:root',
      message: { message_id: 9, chat: { id: AUTHORIZED, type: 'private' } },
    },
  }, env);
  ok(res.status === 200, 'unauthorized callback: acks 200');
  ok(tgCalls.some(c => c.method === 'answerCallbackQuery'),
    'unauthorized callback: tap is answered (no stuck spinner)');
  ok(tgCalls.filter(c => c.method === 'sendMessage').length === 1,
    'unauthorized callback: refusal message sent');
  ok(!tgCalls.some(c => c.method === 'editMessageText'),
    'unauthorized callback: no menu/screen is ever opened for a stranger');
  ok(env.CODEX_DB.calls.length === 0 && geminiCalls.length === 0, 'unauthorized callback: no D1, no Gemini');
}

// --- 6. FAIL CLOSED: AUTHORIZED_USER_ID unset ------------------------------
{
  const env = makeEnv({ AUTHORIZED_USER_ID: undefined });
  const res = await run({ update_id: 6, message: { ...baseMsg, from: { id: AUTHORIZED }, text: '/help' } }, env);
  ok(res.status === 200, 'unset AUTHORIZED_USER_ID: acks 200');
  ok(tgCalls.filter(c => c.method === 'sendMessage').length === 1 &&
     /not available/i.test(tgCalls.find(c => c.method === 'sendMessage').payload.text),
    'unset AUTHORIZED_USER_ID: even the operator id is refused (fail closed, never silently public)');
  ok(env.CODEX_DB.calls.length === 0, 'unset AUTHORIZED_USER_ID: no D1 access');
}

// --- 7. Wrong webhook secret still 403 -------------------------------------
{
  tgCalls.length = 0;
  const env = makeEnv();
  const res = await worker.fetch(
    post({ update_id: 7, message: { ...baseMsg, from: { id: AUTHORIZED }, text: 'hi' } }, 'WRONG'),
    env, {});
  ok(res.status === 403 && tgCalls.length === 0, 'wrong secret: bare 403, zero Telegram calls');
}

// --- 8. Authorized user routes normally ------------------------------------
{
  const env = makeEnv();
  const res = await run({ update_id: 8, message: { ...baseMsg, from: { id: AUTHORIZED }, text: '/help' } }, env);
  ok(res.status === 200, 'authorized: acks 200');
  const sends = tgCalls.filter(c => c.method === 'sendMessage');
  ok(sends.length === 1 && /Codex/.test(sends[0].payload.text) && !/not available/i.test(sends[0].payload.text),
    'authorized /help: reaches the real handler (help text, not the refusal)');
  ok(geminiCalls.length === 0, 'authorized /help: deterministic command path (no Gemini, as designed)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
