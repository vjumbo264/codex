// Regression tests for fix-silent-nonresponse.
//
// CONFIRMED ROOT CAUSE (see FIX_STATE.json -> investigation): a Gemini
// conversational reply over Telegram's 4096-char cap made editMessageText
// return 400 "message is too long"; tg() suppressed ALL editMessageText
// 400 logs and returned null, and classifyAndDispatch never checked the
// result — so the "⏳ Working on it…" placeholder was never replaced and
// the user got total silence. Secondary: sendText could return null and
// status.message_id then threw TypeError, escaping into index.js's
// log-only catch.
//
// These tests stub globalThis.fetch with a REALISTIC Telegram API (400 on
// >4096 chars, "message is not modified" no-op) and run the REAL
// worker/src/telegram.js + gemini.js code against it. No network, no
// credentials. Run: node worker/test/silent-nonresponse.test.mjs

import { chunkText, sendText, editText } from '../src/telegram.js';
import { replaceStatus } from '../src/gemini.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

const ENV = { TELEGRAM_BOT_TOKEN: 'test-token-not-real' };

// --- realistic Telegram stub --------------------------------------------
const sent = []; // every Bot API call: { method, payload }
const logs = [];
const origError = console.error;
console.error = (...a) => { logs.push(a.join(' ')); };

globalThis.fetch = async (url, init) => {
  const method = url.split('/').pop();
  const payload = JSON.parse(init.body);
  sent.push({ method, payload });
  const text = payload.text || '';
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  if (text.length > 4096) {
    return reply(400, { ok: false, description: 'Bad Request: message is too long' });
  }
  if (method === 'editMessageText' && text === 'SAME') {
    return reply(400, { ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' });
  }
  if (payload.chat_id === 999) { // simulate a dead chat (send failure)
    return reply(400, { ok: false, description: 'Bad Request: chat not found' });
  }
  return reply(200, { ok: true, result: { message_id: 1000 + sent.length } });
};

// --- 1. chunkText --------------------------------------------------------
{
  const chunks = chunkText('x'.repeat(9492)); // the exact size captured live
  ok(chunks.length === 3, 'chunkText splits 9492 chars into 3 chunks');
  ok(chunks.every(c => c.length <= 4000), 'every chunk within the 4000 guard');
  ok(chunks.join('').length === 9492, 'chunking loses no content');
  ok(chunkText('short').length === 1, 'short text stays one chunk');
}

// --- 2. sendText chunks long text ----------------------------------------
{
  sent.length = 0;
  const first = await sendText(ENV, 42, 'y'.repeat(9000));
  ok(first && first.message_id, 'sendText returns first-chunk Message');
  ok(sent.filter(s => s.method === 'sendMessage').length === 3, 'sendText sent 3 chunks');
  ok(sent.every(s => s.payload.text.length <= 4096), 'no sendMessage exceeded 4096');
}

// --- 3. PRIMARY regression: over-4096 editText must NOT go silent --------
{
  sent.length = 0; logs.length = 0;
  const res = await editText(ENV, 42, 555, 'z'.repeat(9492)); // the failing case
  ok(res !== null, 'editText of 9492 chars SUCCEEDS (chunked), not a silent null');
  ok(sent[0].method === 'editMessageText' && sent[0].payload.text.length === 4000,
    'first chunk edits the placeholder in place');
  ok(sent.filter(s => s.method === 'sendMessage').length === 2,
    'overflow delivered as follow-up messages — reply never lost');
  ok(sent.every(s => s.payload.text.length <= 4096), 'no Telegram call exceeded 4096');
}

// --- 4. tg() logging: "too long" is logged, "not modified" is not --------
{
  logs.length = 0;
  await editText(ENV, 42, 555, 'SAME'); // not-modified no-op
  ok(!logs.some(l => /editMessageText/.test(l)), '"message is not modified" stays quiet');
  logs.length = 0;
  const bad = await editText(ENV, 999, 555, 'hello'); // dead chat -> real 400
  ok(bad === null, 'editText returns null on a genuine edit failure');
  ok(logs.some(l => /editMessageText -> 400/.test(l)),
    'genuine editMessageText 400 IS logged (silent-400 suppression removed)');
}

// --- 5. replaceStatus fallback contract ----------------------------------
{
  sent.length = 0;
  const edited = await replaceStatus(ENV, 42, 555, 'recovered reply');
  ok(edited === true, 'replaceStatus true when edit lands');
  const noStatus = await replaceStatus(ENV, 42, null, 'fallback reply');
  ok(noStatus === false, 'replaceStatus false with null statusMessageId (caller falls back to sendText)');
  const failedEdit = await replaceStatus(ENV, 999, 555, 'x');
  ok(failedEdit === false, 'replaceStatus false when the edit fails (caller falls back to sendText)');
}

console.error = origError;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
