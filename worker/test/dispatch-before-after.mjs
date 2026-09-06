// dispatch-reasoning-quality-v10 — fix-01 / fix-03 evidence harness.
//
// Runs the Worker's REAL exported classifyAndDispatch (worker/src/gemini.js)
// against the REAL live state:
//   - key pool:      read from the live D1 database via the Cloudflare API
//                    (never printed — masked tail only)
//   - notebook tree: read from the live GitHub repo via the real github.js
//   - Gemini API:    real calls (model = GEMINI_MODEL env or production
//                    default gemini-flash-lite-latest)
//   - Telegram API:  INTERCEPTED — every method call captured, nothing sent.
//
// For each test input it records verbatim: which dispatch tool fired (name +
// args), what the model replied when no tool fired, and every Telegram-side
// effect (sendMessage/editMessageText/answerCallback heads, chat actions).
// With --seed it first creates temporary topics/entries in the LIVE notebook
// so entry/topic-targeted inputs have real targets, and deletes them again
// afterwards (cleanup commits appear in the repo history; recorded in
// FIX_STATE.json).
//
// Usage:
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... GITHUB_REPO_TOKEN=... \
//     node worker/test/dispatch-before-after.mjs --seed          # before run
//     node worker/test/dispatch-before-after.mjs --seed --model gemini-flash-latest
// Never prints credentials or key material.

import { classifyAndDispatch } from '../src/gemini.js';
import { createNode, appendEntry, deleteNodeTree } from '../src/notes.js';

const account = process.env.CF_ACCOUNT_ID;
const cfToken = process.env.CF_API_TOKEN;
const ghToken = process.env.GITHUB_REPO_TOKEN;
if (!account || !cfToken || !ghToken) {
  console.error('need CF_ACCOUNT_ID, CF_API_TOKEN, GITHUB_REPO_TOKEN');
  process.exit(2);
}
const args = process.argv.slice(2);
const doSeed = args.includes('--seed');
const modelIdx = args.indexOf('--model');
const MODEL = modelIdx >= 0 ? args[modelIdx + 1] : 'gemini-flash-lite-latest';

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)} (len ${k.length})` : String(k));

// ---- live D1 key pool via Cloudflare API ---------------------------------
const DB_ID = 'ae30162f-069f-43ca-b9cb-1c6b852ad2fb';
async function d1Query(sql, params = []) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DB_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
  const j = await r.json();
  if (!j.success) throw new Error('D1 query failed: ' + JSON.stringify(j.errors).slice(0, 200));
  return j.result[0].results || [];
}
const keyRows = await d1Query('SELECT key_value FROM api_keys ORDER BY position ASC, id ASC');
const keys = keyRows.map(r => r.key_value);
if (!keys.length) { console.error('live key pool is empty'); process.exit(1); }
console.log(`pool: ${keys.length} keys (${keys.map(mask).join(', ')})`);

// Minimal CODEX_DB binding shape that keypool.js needs.
const CODEX_DB = {
  prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const bind = (...params) => ({
      async all() {
        if (/FROM api_keys/.test(norm)) return { results: keyRows };
        if (/FROM key_pool_state/.test(norm)) {
          const rows = await d1Query('SELECT value FROM key_pool_state WHERE key = ?1', params);
          return { results: rows };
        }
        return { results: [] };
      },
      async first() {
        const { results } = await this.all();
        return results[0] || null;
      },
      async run() {
        if (/key_pool_state/.test(norm)) {
          await d1Query(norm, params);
          return { success: true };
        }
        return { success: true }; // other writes not used by classifyAndDispatch reads
      },
    });
    return {
      bind,
      async all() { return bind().all(); },
      async first() { return bind().first(); },
      async run() { return bind().run(); },
    };
  },
  async batch() { return [{ success: true }]; },
};

// ---- intercept ONLY the Telegram Bot API ----------------------------------
const telegramCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) {
    const method = String(url).split('/').pop();
    const payload = init && init.body ? JSON.parse(init.body) : {};
    telegramCalls.push({
      method,
      text: payload.text || null,
      action: payload.action || null,
      editsMessage: payload.message_id ?? null,
      hasKeyboard: !!(payload.reply_markup),
    });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, result: { message_id: 4242 } }),
      text: async () => '',
    };
  }
  return realFetch(url, init);
};

const env = {
  GEMINI_MODEL: MODEL,
  CODEX_DB,
  GITHUB_REPO_TOKEN: ghToken,
  REPO_OWNER: 'vjumbo264', REPO_NAME: 'codex', REPO_BRANCH: 'main',
};

// ---- seed temporary topics/entries in the LIVE notebook -------------------
// Names are deliberately generic-realistic so indirect phrasings have real
// targets, and clearly prefixed so cleanup is unambiguous.
let seeded = [];
if (doSeed) {
  const a = await createNode(env, '', 'Grocery List');
  await appendEntry(env, a.path, 'buy oat milk and coffee beans');
  const b = await createNode(env, '', 'Trip Ideas');
  await appendEntry(env, b.path, 'maybe Lisbon in the spring, cheap flights in February');
  seeded = [a.path, b.path];
  console.log(`seeded temp topics: ${seeded.join(', ')}`);
}

// ---- the varied test set ---------------------------------------------------
// t = input text, expect = the correct classification this input SHOULD get.
// Instruction phrasings are deliberately indirect/conversational; note inputs
// are genuine content-to-remember (correct current behavior we must not
// break); transcript-style inputs carry voice-shaped artifacts.
const TESTS = [
  { id: 'T1-indirect-delete-topic', expect: 'delete_topic(grocery-list)',
    t: "yeah so that grocery list thing, I don't really need it anymore, can you get rid of it" },
  { id: 'T2-indirect-read', expect: 'read_topic(life-revelations)',
    t: "hmm what did I write down in my life revelations notes again?" },
  { id: 'T3-indirect-edit', expect: 'edit_entry(trip-ideas)',
    t: "in my trip ideas can you change the Lisbon bit to say March instead of February" },
  { id: 'T4-indirect-export', expect: 'export_pdf(all)',
    t: "hey could you send me everything as a PDF, like the whole notebook" },
  { id: 'T5-genuine-note', expect: 'file_note',
    t: "reminder that the dentist appointment got moved to Thursday at 3" },
  { id: 'T6-genuine-note-conversational', expect: 'file_note',
    t: "I keep thinking that most of my best ideas show up when I'm walking, not at my desk" },
  { id: 'T7-transcript-delete-entry', expect: 'delete_entry(grocery-list)',
    t: "um so yeah that oat milk thing on the grocery list uh I already got it so you can just like take that one off" },
  { id: 'T8-transcript-note', expect: 'file_note',
    t: "okay so uh quick thought before I forget, the wifi password for the airbnb is downstairs on the router thing" },
];

console.log(`model: ${MODEL}\nseeded: ${doSeed ? seeded.join(', ') : '(none)'}\n`);
const results = [];
for (const test of TESTS) {
  telegramCalls.length = 0;
  let outcome, error = null;
  try {
    await classifyAndDispatch(env, 12345, test.t, null);
    outcome = telegramCalls.map(c =>
      `${c.method}${c.editsMessage ? `(edit#${c.editsMessage})` : ''}` +
      `${c.action ? ` action=${c.action}` : ''}` +
      `${c.text ? ` "${c.text.replace(/\n/g, ' | ').slice(0, 160)}"` : ''}` +
      `${c.hasKeyboard ? ' [keyboard]' : ''}`
    );
  } catch (e) {
    error = `${e.message}`.slice(0, 300);
    outcome = telegramCalls.map(c => `${c.method} "${(c.text || '').slice(0, 160)}"`);
  }
  const rec = { id: test.id, expect: test.expect, input: test.t, error, telegram: outcome };
  results.push(rec);
  console.log(`=== ${test.id}  (expect: ${test.expect})`);
  console.log(`input: ${JSON.stringify(test.t)}`);
  if (error) console.log(`ERROR: ${error}`);
  for (const line of outcome) console.log(`  -> ${line}`);
  console.log('');
}

// ---- cleanup seeded topics -------------------------------------------------
for (const p of seeded) {
  try { await deleteNodeTree(env, p); console.log(`cleaned up ${p}`); }
  catch (e) { console.log(`CLEANUP FAILED for ${p}: ${e.message}`); }
}

console.log('\nJSON_RESULTS_BEGIN');
console.log(JSON.stringify(results, null, 2));
console.log('JSON_RESULTS_END');
