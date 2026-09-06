// dispatch-reasoning-quality-v10 — supplementary stress harness.
//
// Probes the CONFIRMED note-vs-instruction confusion boundary (the operator's
// report: dispatcher misreads instructions as notes) with phrasings the
// current thin prompt has no guidance for: rhetorical/imperative-shaped
// NOTES, meta-references to notes as instructions, hedged instructions, and
// transcript-shaped commands.
//
// Same mechanics as dispatch-before-after.mjs: REAL exported
// classifyAndDispatch, REAL D1 key pool (masked), REAL live notebook tree
// (GitHub), real Gemini API, Telegram intercepted. With --seed, creates
// temporary topics/entries for targeting and cleans them up afterwards.
//
// Usage: node --import ./worker/test/ttf-loader.mjs \
//          worker/test/dispatch-stress.mjs --seed [--model X] [--file out.json]
// Env: CF_ACCOUNT_ID, CF_API_TOKEN, GITHUB_REPO_TOKEN.

import { classifyAndDispatch } from '../src/gemini.js';
import { createNode, appendEntry, deleteNodeTree, deleteEntry } from '../src/notes.js';
import { readNode } from '../src/notes.js';
import { writeFileSync } from 'node:fs';

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
const fileIdx = args.indexOf('--file');
const OUT = fileIdx >= 0 ? args[fileIdx + 1] : null;

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)} (len ${k.length})` : String(k));

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
        if (/key_pool_state/.test(norm)) await d1Query(norm, params);
        return { success: true };
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

// Seed a topic whose CONTENT is imperative-shaped (this is exactly the real
// voice-note material the operator saves — cleaned transcripts often read
// like advice/commands) so S9's "write down X" meta-instruction has a real
// matching target.
let seededPaths = [];
let seededEntryIds = {}; // path -> [entryIds created by this run]
if (doSeed) {
  const made = await createNode(env, '', 'Confidence');
  const e1 = await appendEntry(env, made.path,
    'Stop being so available to people who only call when they need something');
  const e2 = await appendEntry(env, made.path,
    'Confidence attracts quality; pretending not to care attracts chaos');
  seededPaths = [made.path];
  seededEntryIds[made.path] = [e1, e2];
  console.log(`seeded temp topic: ${made.path} with entries ${e1}, ${e2}`);
}

const TESTS = [
  // --- genuine NOTES whose surface shape looks like an instruction ---------
  { id: 'S1-note-imperative-shaped', expect: 'file_note',
    t: "Never text first twice in a row" },
  { id: 'S2-note-rhetorical', expect: 'file_note',
    t: "why do I always say yes to things I don't even want to do" },
  { id: 'S3-note-self-talk-imperative', expect: 'file_note',
    t: "stop checking your phone first thing in the morning, seriously" },
  { id: 'S4-note-advice-fragment', expect: 'file_note',
    t: "the trick with her is just consistency, not grand gestures" },
  // --- INSTRUCTIONS that reference note content ----------------------------
  { id: 'S5-instruction-show-note-about-X', expect: 'read_topic(confidence)',
    t: "can you show me my notes about confidence" },
  { id: 'S6-instruction-hedged-delete-topic', expect: 'delete_topic(confidence)',
    t: "I think I want to delete that whole confidence topic, it's all just noise at this point" },
  { id: 'S7-instruction-transcript-edit', expect: 'edit_entry(confidence)',
    t: "hey uh in the confidence one, the thing about not texting twice, add something about how it applies to calling too" },
  { id: 'S8-instruction-transcript-read', expect: 'read_topic(life-revelations)',
    t: "wait what was that long note I did about like nonchalant people, pull that up" },
  { id: 'S9-instruction-write-down-explicit', expect: 'file_note',
    t: "write this down: stop being so available to people who only call when they need something" },
  { id: 'S10-instruction-delete-entry-transcript', expect: 'delete_entry(confidence)',
    t: "so yeah um that entry in confidence about confidence attracting quality or whatever, actually scratch that, delete it" },
];

console.log(`model: ${MODEL}\nseeded: ${doSeed ? seededPaths.join(', ') : '(none)'}\n`);
const results = [];
for (const test of TESTS) {
  telegramCalls.length = 0;
  let error = null;
  try {
    await classifyAndDispatch(env, 12345, test.t, null);
  } catch (e) {
    error = `${e.message}`.slice(0, 300);
  }
  const outcome = telegramCalls.map(c =>
    `${c.method}${c.editsMessage ? `(edit#${c.editsMessage})` : ''}` +
    `${c.action ? ` action=${c.action}` : ''}` +
    `${c.text ? ` "${c.text.replace(/\n/g, ' | ').slice(0, 200)}"` : ''}` +
    `${c.hasKeyboard ? ' [keyboard]' : ''}`
  );
  const rec = { id: test.id, expect: test.expect, input: test.t, error, telegram: outcome };
  results.push(rec);
  console.log(`=== ${test.id}  (expect: ${test.expect})`);
  console.log(`input: ${JSON.stringify(test.t)}`);
  if (error) console.log(`ERROR: ${error}`);
  for (const line of outcome) console.log(`  -> ${line}`);
  console.log('');
}

// Cleanup: delete entries created mid-run inside seeded topics, then the
// seeded topics themselves.
for (const p of seededPaths) {
  try {
    const node = await readNode(env, p);
    if (node) {
      for (const e of node.entries) {
        await deleteEntry(env, p, e.id).catch(() => {});
      }
    }
    await deleteNodeTree(env, p);
    console.log(`cleaned up ${p}`);
  } catch (e) { console.log(`CLEANUP FAILED for ${p}: ${e.message}`); }
}

console.log('\nJSON_RESULTS_BEGIN');
console.log(JSON.stringify(results, null, 2));
console.log('JSON_RESULTS_END');
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
