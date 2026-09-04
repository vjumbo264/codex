// Gemini layer — the ONLY module that calls the model. Used strictly for
// the four reasoning cases (ARCHITECTURE.md §5):
//   1. voice transcription + cleanup
//   2. auto-filing an unspecified note against the existing tree
//   3. editing an existing entry via natural request
//   4. resolving ambiguous targets / minimal intent classification
// Everything dispatches to the same deterministic functions as the manual
// path. Explicit requests (exact delete/export/read/add) are answered with
// ONE tiny classification call returning strict JSON — never re-reading or
// re-writing stored content.

import { sendText, editText } from './telegram.js';
import { getNodes } from './tree.js';
import { readNode, appendEntry, updateEntry, deleteEntry, deleteNodeTree, createNode } from './notes.js';
import { resolveH8, resolvePath, findByName, listNodePaths } from './tree.js';
import { h8 } from './util.js';
import { filedActionsKeyboard, confirmDeleteKeyboard } from './keyboards.js';
import { sendReadPage } from './read.js';
import { doExport } from './export.js';
import { b64encodeBytes } from './util.js';
import { getKeys, getLastOkIndex, setLastOkIndex, maskKey } from './keypool.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// fix-04: key pool presence check (the legacy GEMINI_API_KEY secret is
// auto-migrated into the pool on first read by keypool.getKeys).
async function requireKey(env) {
  const keys = await getKeys(env);
  return keys.length > 0;
}

// Is this failure specific to the KEY (rotate) rather than the request or
// the service (don't rotate)? Matches Gemini's actual error shapes:
//   429 (RESOURCE_EXHAUSTED / quota)     -> key's quota/rate exhausted
//   403 (PERMISSION_DENIED / key forbidden) -> key unusable
//   400/403 (API_KEY_INVALID / API key not valid) -> dead key
//   401 -> key auth failure
// Deliberately NOT matched: 500/503 (service-side), 400 INVALID_ARGUMENT
// for malformed requests (rotating would burn every key pointlessly).
function isKeyFailure(status, bodyText) {
  const t = String(bodyText || '');
  const quotaish = /RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|quota/i.test(t);
  const keyInvalid = /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|key.*(?:invalid|expired|revoked|forbidden)/i.test(t);
  if (status === 429) return true; // Gemini 429s are per-key rate/quota
  if (status === 403) return keyInvalid || quotaish;
  if (status === 400) return keyInvalid;
  if (status === 401) return true;
  return false;
}

// Single attempt with one key. Throws a tagged error
// { keyFailure: bool, status, body } on failure.
async function geminiOnce(env, model, key, payload) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    err.body = t;
    err.keyFailure = isKeyFailure(res.status, t);
    throw err;
  }
  const data = await res.json();
  const content = data.candidates && data.candidates[0] && data.candidates[0].content;
  if (!content) {
    const err = new Error('Gemini: no content');
    err.keyFailure = false;
    throw err;
  }
  return data; // full response: function-calling callers need the raw parts
}

// fix-04: multi-key rotation, cheapest-first model, sticky last-success.
// Starts from the last key that worked (KV 'gemini:last_ok_idx') instead of
// re-discovering dead keys on every request. Rotates ONLY on key-specific
// failures; service errors (5xx) get one same-key retry, then bubble.
// v7 fix-02: the rotation core now returns the FULL response data object so
// both plain-text callers (gemini) and the function-calling dispatcher
// (geminiContent) share it.
async function geminiData(env, payload) {
  const model = env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const keys = await getKeys(env);
  if (!keys.length) {
    const err = new Error('no gemini keys configured');
    err.noKeys = true;
    throw err;
  }
  let start = await getLastOkIndex(env);
  if (start >= keys.length) start = 0;

  let lastErr = null;
  for (let step = 0; step < keys.length; step++) {
    const idx = (start + step) % keys.length;
    const key = keys[idx];
    try {
      const out = await geminiOnce(env, model, key, payload);
      if (idx !== start) await setLastOkIndex(env, idx);
      return out;
    } catch (e) {
      lastErr = e;
      if (e.keyFailure) {
        console.error(`gemini key ${idx} (${maskKey(key)}) failed as key-specific: ${e.status}`);
        continue; // try the next key in the pool
      }
      if (e.status && e.status >= 500) {
        // Service-side blip: retry once on the SAME key, then try the NEXT
        // key. v7 fix-01 evidence: consecutive 503 UNAVAILABLE responses
        // (saturated model) collapsed into the generic dispatch error while
        // other keys in the pool were fine — a 5xx is not request-fatal.
        try {
          const out = await geminiOnce(env, model, key, payload);
          if (idx !== start) await setLastOkIndex(env, idx);
          return out;
        } catch (e2) {
          if (e2.keyFailure) { lastErr = e2; continue; }
          if (e2.status && e2.status >= 500) { lastErr = e2; continue; }
          throw e2;
        }
      }
      throw e; // non-key, non-5xx failure (e.g. bad request): do not rotate
    }
  }
  const err = new Error(
    `all ${keys.length} Gemini key(s) failed for this request (last: ${lastErr ? lastErr.message : 'unknown'})`);
  err.allKeysFailed = true;
  err.cause = lastErr;
  throw err;
}

// Plain-text callers (transcription, auto-file decisions, entry rewrites):
// join all text parts — the legacy contract.
async function gemini(env, payload) {
  const data = await geminiData(env, payload);
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [];
  return parts.map(p => p.text || '').join('');
}

// v7 fix-02: function-calling callers get the raw model content
// ({ role, parts }) so functionCall parts survive intact.
async function geminiContent(env, payload) {
  const data = await geminiData(env, payload);
  return (data.candidates && data.candidates[0] && data.candidates[0].content) || null;
}

// fix-01-style specific failure feedback when the whole key pool is spent.
// v3 fix-01: a KV key-storage failure takes precedence — it is LOUD and
// specific, never collapsed into a generic "try a command" message.
export function allFailedMessage(e) {
  if (e && e.name === 'KeyPoolError') {
    return `⚠️ Gemini key storage problem: ${e.message}\n\n` +
      'This is an infrastructure fault, not a missing key. It has been logged.';
  }
  if (e && e.allKeysFailed) {
    return '❌ Every configured Gemini API key failed for this request (quota exhausted or keys invalid). ' +
      'Add a fresh key via /menu → ⚙️ Settings → 🔑 Gemini API keys, then try again.';
  }
  return null;
}

// fix-03 v3: apply a natural-language edit instruction to a specific entry
// (the tap-only edit entry point from the read view). Same reasoning path
// as a Gemini-dispatched free-text edit: read + rewrite only this entry.
export async function maybeApplyTapEdit(env, chatId, path, entryId, instruction, statusMessageId) {
  const node = await readNode(env, path);
  const entry = node && node.entries.find(e => e.id === entryId);
  if (!entry) {
    await editText(env, chatId, statusMessageId, 'That entry no longer exists.');
    return;
  }
  const rewritten = await gemini(env, {
    contents: [{ parts: [{ text:
`Rewrite this notebook entry per the instruction. Output ONLY the new entry body (Markdown, keep any image embeds ![..](assets/..) unchanged unless the instruction says otherwise). No commentary.

CURRENT ENTRY:
${entry.body}

INSTRUCTION:
${instruction || 'improve clarity'}` }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });
  const body = String(rewritten).trim();
  if (!body) { await editText(env, chatId, statusMessageId, '❌ Edit produced nothing.'); return; }
  await updateEntry(env, path, entry.id, body);
  const breadcrumb = path.split('/').join(' › ');
  await editText(env, chatId, statusMessageId,
    `✏️ Updated entry ${entry.id} in ${node.title} (${breadcrumb}):\n\n_${entry.date}_\n${body.slice(0, 400)}`);
}

function parseJsonLoose(text) {
  const m = String(text).replace(/```json|```/g, '').trim();
  const s = m.indexOf('{');
  const e = m.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no json in response');
  return JSON.parse(m.slice(s, e + 1));
}

// ---- case 1: voice transcription + cleanup -------------------------------

export async function transcribeAndClean(env, audioBytes, tgPath) {
  const mime = /oga|ogg|opus/i.test(tgPath) ? 'audio/ogg' : 'audio/mpeg';
  const text = await gemini(env, {
    contents: [{
      parts: [
        { inline_data: { mime_type: mime, data: b64encodeBytes(audioBytes) } },
        { text: 'Transcribe this voice note, then output ONLY the cleaned note: coherent written text with rambling, false starts, filler words and repetitions removed. Preserve meaning, lists and details. Write in the same language the speaker used. No preamble, no commentary, just the cleaned note.' },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  return String(text).trim();
}

// ---- tree context for filing/classification ------------------------------

async function treeListing(env) {
  const paths = await listNodePaths(env);
  const lines = [];
  for (const p of paths) {
    if (!p) continue;
    let suffix = '';
    try {
      const node = await readNode(env, p);
      if (node) {
        suffix = `  [${node.entries.length} ${node.entries.length === 1 ? 'entry' : 'entries'}]`;
        const prev = node.entries.slice(-3)
          .map(e => `    - (${e.date}, id ...${e.id.slice(-4)}) ${e.body.replace(/!\[[^\]]*\]\(assets\/[^)]+\)/g, '[photo]').replace(/\n+/g, ' ').slice(0, 80)}`)
          .filter(Boolean);
        if (prev.length) suffix += '\n' + prev.join('\n');
      }
    } catch { suffix = ''; }
    lines.push(p.split('/').join(' > ') + suffix);
  }
  return lines.length ? lines.join('\n') : '(no topics yet)';
}

// ---- case 2: auto-filing --------------------------------------------------

// Decide where a note belongs, file it, confirm with quick-action buttons.
export async function autoFileNote(env, chatId, noteText, statusMessageId) {
  const status = async (t) => { if (statusMessageId) await editText(env, chatId, statusMessageId, t); };
  const tree = await treeListing(env);
  const raw = await gemini(env, {
    contents: [{
      parts: [{ text:
`You file notes into a personal notebook's topic tree. Existing topics (path > subpath):
${tree}

Decide where this note belongs. Prefer an existing related topic/subtopic; only mint a NEW topic when nothing fits. Reply with ONLY strict JSON:
{"path": "<exact existing path using > separators>", "new": false}
or, to create a new topic: {"title": "<short topic title>", "parent": "<existing parent path or empty>", "new": true}

NOTE TO FILE:
${noteText}` }],
    }],
    // v7: 256 was not enough headroom on newer Gemini models — thinking
    // tokens share this budget, so the JSON decision could be truncated
    // mid-string (captured live: "no json in response" from an unfinished
    // `{"action":"note","text":"` fragment).
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 512 } },
  });
  const decision = parseJsonLoose(raw);
  let nodePath = null;
  if (decision.new) {
    const parentPath = decision.parent ? await resolvePath(env, decision.parent, true) : '';
    const made = await createNode(env, parentPath || '', decision.title || 'Notes');
    nodePath = made.path;
  } else if (decision.path) {
    nodePath = await resolvePath(env, String(decision.path).replace(/ > /g, '/'), true);
    if (nodePath === null) {
      const made = await createNode(env, '', String(decision.path).split(/ > |\//).pop());
      nodePath = made.path;
    }
  }
  if (!nodePath) {
    const made = await createNode(env, '', 'Inbox');
    nodePath = made.path;
  }
  await status('⏳ Filing…');
  const entryId = await appendEntry(env, nodePath, noteText);
  const node = await readNode(env, nodePath);
  const breadcrumb = nodePath.split('/').join(' › ');
  const created = !!decision.new;
  const title = node ? node.title : nodePath.split('/').pop();
  await editText(env, chatId, statusMessageId,
    created
      ? `✅ Created new topic "${title}" (${breadcrumb}) and filed the note there as entry ${entryId}.`
      : `✅ Filed note as entry ${entryId} under ${title} (${breadcrumb}).`,
    { keyboard: await filedActionsKeyboard(nodePath, entryId) });
  return nodePath;
}

// ---- free-text entry point -----------------------------------------------

// Pattern-match explicit requests first (no Gemini). Only genuinely
// open-ended text goes through Gemini classification.
export async function routeFreeText(env, message, text, opts = {}) {
  const chatId = message.chat.id;

  // Explicit "add this to X" / "new topic X" — deterministic, no Gemini.
  let m = /^(?:add(?: this)? to|file (?:this|under|in)|put (?:this )?in)\s+(.+?)\s*:\s*([\s\S]+)$/i.exec(text);
  if (m) {
    const path = await resolvePath(env, m[1], true);
    if (path !== null) {
      const entryId = await appendEntry(env, path, m[2].trim());
      const node = await readNode(env, path);
      const breadcrumb = path.split('/').join(' › ');
      const title = node ? node.title : path.split('/').pop();
      await sendText(env, chatId, `✅ Filed note as entry ${entryId} under ${title} (${breadcrumb}).`,
        { keyboard: await filedActionsKeyboard(path, entryId) });
      return;
    }
  }
  m = /^new topic\s+(.+?)\s*:\s*([\s\S]+)$/i.exec(text);
  if (m) {
    const made = await createNode(env, '', m[1].trim());
    const entryId = await appendEntry(env, made.path, m[2].trim());
    const breadcrumb = made.path.split('/').join(' › ');
    await sendText(env, chatId,
      `✅ Created new topic "${m[1].trim()}" (${breadcrumb}) and filed the note there as entry ${entryId}.`,
      { keyboard: await filedActionsKeyboard(made.path, entryId) });
    return;
  }

  // Everything else requires reasoning.
  if (!(await requireKey(env))) {
    if (opts.photo) {
      await sendText(env, chatId,
        '📷 I can save this photo, but I need a Gemini API key to decide where it goes. Add one via /menu → ⚙️ Settings → 🔑 Gemini API keys, or use /add <topic> then send the photo.');
      return;
    }
    await sendText(env, chatId,
      'I need a Gemini API key to file free-form notes. Add one via /menu → ⚙️ Settings → 🔑 Gemini API keys, or use a command: /new, /add, /topics, /read, /export, /delete.');
    return;
  }

  // A photo with no explicit path -> auto-file it (image content + caption).
  if (opts.photo) {
    const status = await sendText(env, chatId, '⏳ Filing photo…');
    try {
      await autoFilePhoto(env, message, text, status.message_id);
    } catch (e) {
      console.error(e);
      await editText(env, chatId, status.message_id,
        allFailedMessage(e) || '❌ Could not file the photo. Try /add <topic>.');
    }
    return;
  }

  // Could be: a note to auto-file, an edit request, an explicit action asked
  // in plain language, or an ambiguous target. One classification call:
  const status = await sendText(env, chatId, '⏳ Working on it…');
  try {
    await classifyAndDispatch(env, chatId, text, status.message_id);
  } catch (e) {
    console.error('gemini dispatch failed', e);
    await editText(env, chatId, status.message_id,
      allFailedMessage(e) || '⚠️ The AI dispatcher hiccuped on that message. Try again in a moment, or use a command from /help.');
  }
}

// ---- case 4 (v7 fix-02): native function-calling dispatch ------------------
//
// Replaces the v1-v6 "ask for ONLY strict JSON and hand-parse it" classifier.
// That design had NO valid shape for non-actionable input, so a prose reply,
// a markdown fence, a truncated JSON fragment, or a transient API error all
// collapsed into the same opaque generic error (v7 fix-01 captured evidence).
// Codex now declares its actions as real Gemini functionDeclarations — the
// pattern proven in production by the operator's Compass bot
// (src/ai/agent.ts + tools.ts + toolExecutor.ts): "no function call, just
// talk to the user" is a first-class API outcome, which naturally covers
// arbitrary free text.

const DISPATCH_TOOLS = [{
  functionDeclarations: [
    {
      name: 'file_note',
      description: 'Save a new note into the notebook (auto-filed to the best topic). Use whenever the user gives you content to remember, save, jot down, or store — including when they just state a fact, idea, reminder or task with no explicit command.',
      parameters: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING', description: 'The full note content to save.' } },
        required: ['text'],
      },
    },
    {
      name: 'read_topic',
      description: 'Show/read the entries of a topic the user asks to see.',
      parameters: {
        type: 'OBJECT',
        properties: { path: { type: 'STRING', description: 'Topic path, slash-separated (e.g. "morning/random"). Use the tree listing.' } },
        required: ['path'],
      },
    },
    {
      name: 'export_pdf',
      description: 'Export a topic (or the whole notebook) as a PDF document.',
      parameters: {
        type: 'OBJECT',
        properties: { path: { type: 'STRING', description: 'Topic path, or the word "all" for the entire notebook.' } },
        required: ['path'],
      },
    },
    {
      name: 'delete_topic',
      description: 'Delete ONE named topic and everything inside it. The user always confirms via inline buttons before anything is removed.',
      parameters: {
        type: 'OBJECT',
        properties: { path: { type: 'STRING', description: 'Topic path, slash-separated.' } },
        required: ['path'],
      },
    },
    {
      name: 'delete_everything',
      description: 'Delete the ENTIRE notebook — every topic and every entry. Use ONLY for explicit whole-notebook requests like "delete all topics", "wipe my notebook", "delete everything". The user always confirms via inline buttons before anything is removed.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'delete_entry',
      description: 'Delete ONE specific entry inside a topic. The user always confirms via inline buttons first.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Topic path holding the entry. Resolve to the DEEPEST node whose entries actually match the description.' },
          entry_hint: { type: 'STRING', description: 'What the entry says / how the user referred to it.' },
        },
        required: ['path', 'entry_hint'],
      },
    },
    {
      name: 'edit_entry',
      description: "Rewrite/modify one existing entry per the user's instruction.",
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Topic path holding the entry (deepest matching node).' },
          entry_hint: { type: 'STRING', description: 'Which entry the user means.' },
          instruction: { type: 'STRING', description: 'How to change it.' },
        },
        required: ['path', 'entry_hint', 'instruction'],
      },
    },
    {
      name: 'browse_topics',
      description: 'Show the interactive topic browser (buttons).',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'help',
      description: 'Explain what this bot can do and how to use it.',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}];

function dispatchSystemPrompt(tree) {
  return `You are the dispatcher for a Telegram notebook bot — a personal note tree the user manages entirely through chat.

The notebook tree (path  [entry count] + previews of latest entries):
${tree}

Decide what the user's message is:
- If it asks you to DO something with the notebook (save a note, read, export, edit, delete, browse), call the matching function exactly once. Never claim you did something without calling its function.
- If it is NOT an actionable notebook request — a greeting, small talk, a question, a request for ideas or anything else — do NOT call any function. Just reply conversationally and helpfully in plain text. You may briefly mention what you can do with their notebook if relevant.
- If the user gives you information without an explicit command, that is a note to save: call file_note.

Targeting rules for paths:
- Use paths exactly as listed above, slash-separated.
- When the user references an entry by content or loosely (e.g. "that morning note", "my note about X"), resolve "path" to the DEEPEST node whose entries actually match the description — a note described as "the morning note" that lives under morning/random belongs to path "morning/random", NOT "morning".
- Prefer a node that actually contains a matching entry over an empty parent with a similar name.
- If a referenced topic is not in the tree, still pass your best-guess path.`;
}

const MAX_DISPATCH_ROUNDS = 4;

// The tool loop (Compass agent.ts pattern): call Gemini with the tools
// declared; plain text with no function call IS the reply (never an error);
// function calls execute against the real Codex handlers and their results
// go back as functionResponse parts for a possible follow-up round.
async function classifyAndDispatch(env, chatId, text, statusMessageId) {
  const tree = await treeListing(env);
  const contents = [{ role: 'user', parts: [{ text }] }];

  for (let round = 0; round < MAX_DISPATCH_ROUNDS; round++) {
    const content = await geminiContent(env, {
      systemInstruction: { role: 'system', parts: [{ text: dispatchSystemPrompt(tree) }] },
      contents,
      tools: DISPATCH_TOOLS,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 512 } },
    });

    if (!content) {
      await editText(env, chatId, statusMessageId, "I'm here — could you say that again?");
      return;
    }
    contents.push(content);

    const parts = content.parts || [];
    const calls = [];
    let textChunk = '';
    for (const part of parts) {
      if (part.functionCall) calls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
      else if (part.text) textChunk += part.text;
    }

    // No function call -> conversation, not a failure. The model's text IS
    // the reply (the correct outcome for input like "Hi tell me something
    // abstract").
    if (!calls.length) {
      const reply = textChunk.trim() ||
        'Sorry, I lost my train of thought there — could you rephrase or send that again?';
      await editText(env, chatId, statusMessageId, reply);
      return;
    }

    const responseParts = [];
    let allTerminal = true;
    for (const call of calls) {
      const result = await executeDispatchTool(env, chatId, statusMessageId, call, text);
      if (!result.terminal) allTerminal = false;
      responseParts.push({ functionResponse: { name: call.name, response: result.response } });
    }
    contents.push({ role: 'function', parts: responseParts });

    // Every Codex tool delivers its own user-facing response (confirm
    // keyboard, read page, filed confirmation...), so explicit single-tool
    // requests finish in ONE round — no gratuitous follow-up Gemini call.
    if (allTerminal) return;
  }

  await editText(env, chatId, statusMessageId,
    'I hit a snag thinking that through. Try again in a moment?');
}

// Execute one function call against the real Codex handlers. Every branch
// delivers the user-facing response itself (terminal: true ends the loop in
// one round). Failures produce SPECIFIC messages — never the old generic
// "I could not handle that", and never a raw exception.
async function executeDispatchTool(env, chatId, statusMessageId, call, originalText) {
  const { name, args } = call;
  const fail = async (msg) => {
    await editText(env, chatId, statusMessageId, msg);
    return { response: { ok: false, error: msg }, terminal: true };
  };
  try {
    switch (name) {
      case 'file_note': {
        await autoFileNote(env, chatId, String(args.text || originalText), statusMessageId);
        return { response: { ok: true }, terminal: true };
      }
      case 'read_topic': {
        const path = await resolvePath(env, String(args.path || '').replace(/\s*>\s*/g, '/'), true);
        if (path === null) return fail(`Topic not found: ${args.path}`);
        await editText(env, chatId, statusMessageId, '📖 Here it is:');
        await sendReadPage(env, chatId, path, 0, await h8(path));
        return { response: { ok: true, path }, terminal: true };
      }
      case 'export_pdf': {
        const want = String(args.path || 'all');
        const path = /^(all|everything|whole( notebook)?)$/i.test(want)
          ? ''
          : await resolvePath(env, want.replace(/\s*>\s*/g, '/'), true);
        if (path === null) return fail(`Topic not found: ${args.path}`);
        await editText(env, chatId, statusMessageId, '⏳ Rendering PDF…');
        await doExport(env, chatId, path, statusMessageId);
        return { response: { ok: true, path }, terminal: true };
      }
      case 'delete_topic': {
        const path = await resolvePath(env, String(args.path || '').replace(/\s*>\s*/g, '/'), true);
        if (path === null) return fail(`Topic not found: ${args.path}`);
        const breadcrumb = path.split('/').join(' › ');
        await editText(env, chatId, statusMessageId,
          `⚠️ Delete topic "${path.split('/').pop()}" (${breadcrumb}) and everything inside?`,
          { keyboard: confirmDeleteKeyboard(await h8(path), 'topic') });
        return { response: { ok: true, path, confirmPresented: true }, terminal: true };
      }
      case 'delete_everything': {
        const count = (await listNodePaths(env, true)).filter(Boolean).length;
        if (!count) return fail('The notebook is already empty — nothing to delete.');
        await editText(env, chatId, statusMessageId,
          `⚠️ Delete the ENTIRE notebook — all ${count} topic${count === 1 ? '' : 's'} and every entry inside them?\n\nThis cannot be undone (recoverable only via git history).`,
          { keyboard: confirmDeleteKeyboard('root', 'EVERYTHING') });
        return { response: { ok: true, confirmPresented: true, topics: count }, terminal: true };
      }
      case 'delete_entry': {
        await handleEntryAction(env, chatId, statusMessageId,
          { path: args.path, entry_hint: args.entry_hint }, 'delete');
        return { response: { ok: true }, terminal: true };
      }
      case 'edit_entry': {
        await handleEntryAction(env, chatId, statusMessageId,
          { path: args.path, entry_hint: args.entry_hint, instruction: args.instruction }, 'edit');
        return { response: { ok: true }, terminal: true };
      }
      case 'browse_topics': {
        const { browseKeyboard } = await import('./keyboards.js');
        const nodes = await getNodes(env);
        const root = nodes.get('');
        await editText(env, chatId, statusMessageId, '🗂 Your topics — pick one to open:',
          { keyboard: await browseKeyboard('', root ? root.children : [], { backTo: null }) });
        return { response: { ok: true }, terminal: true };
      }
      case 'help': {
        await editText(env, chatId, statusMessageId,
          'I can capture notes (just send text or voice — I file them), browse, read, export, edit and delete. Commands: /new /add /topics /read /export /delete — or /help.');
        return { response: { ok: true }, terminal: true };
      }
      default:
        return fail(`I don't have a way to "${name}" yet — try /help for what I can do.`);
    }
  } catch (e) {
    console.error(`dispatch tool ${name} failed`, e);
    return fail(`❌ That ${name.replace(/_/g, ' ')} failed (${String(e && e.message || e).slice(0, 120)}). Nothing was changed — try again, or use a command from /help.`);
  }
}

// Entry-targeted actions: resolve which entry Gemini means (case 4), then
// either confirm-delete it or rewrite it (case 3).
async function handleEntryAction(env, chatId, statusMessageId, intent, mode) {
  let path = await resolvePath(env, String(intent.path || '').replace(/\s*>\s*/g, '/'), true);
  let node = path !== null ? await readNode(env, path) : null;

  // v5 fix-02: never report "not found"/"no entries" while a matching
  // entry exists elsewhere in the tree. Order of fallback:
  //   1. resolved node has no entries -> search its descendants;
  //   2. path did not resolve at all -> search the WHOLE tree by content.
  const hint = String(intent.entry_hint || '').toLowerCase();
  const hintWords = hint.split(/[^a-z0-9]+/).filter(w => w.length > 3);

  async function entriesWithScore(p) {
    const n = await readNode(env, p);
    if (!n) return { node: n, scored: [] };
    const scored = n.entries.map(e => {
      const hay = (e.body + ' ' + e.id).toLowerCase();
      const score = hintWords.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
      return { e, score };
    });
    return { node: n, scored };
  }

  if (node && node.entries.length === 0) {
    const nodes = await getNodes(env, true);
    const rec = nodes.get(path);
    const queue = [...(rec ? rec.children : [])];
    let best = null;
    while (queue.length) {
      const p = queue.shift();
      const { node: n, scored } = await entriesWithScore(p);
      queue.push(...((nodes.get(p) || {}).children || []));
      if (n && n.entries.length) {
        const hit = scored.reduce((a, b) => (b.score > (a ? a.score : -1) ? b : a), null);
        if (!best || (hit && hit.score > best.score)) best = { path: p, node: n, score: hit ? hit.score : 0 };
      }
    }
    if (best) { path = best.path; node = best.node; }
  } else if (!node) {
    // whole-tree content search for the best-matching entry
    const paths = await listNodePaths(env, true);
    let best = null;
    for (const p of paths) {
      if (!p) continue;
      const { node: n, scored } = await entriesWithScore(p);
      if (!n || !n.entries.length) continue;
      const hit = scored.reduce((a, b) => (b.score > (a ? a.score : -1) ? b : a), null);
      if (hit && hit.score > 0 && (!best || hit.score > best.score)) best = { path: p, node: n, score: hit.score };
    }
    if (best) { path = best.path; node = best.node; }
  }

  if (!node) { await editText(env, chatId, statusMessageId, `Topic not found: ${intent.path}`); return; }
  if (!node.entries.length) {
    await editText(env, chatId, statusMessageId, 'No entries found there.');
    return;
  }
  // Minimal reasoning to identify the entry from the hint:
  const listing = node.entries.map(e => `id=${e.id} | ${e.date} | ${e.body.slice(0, 120).replace(/\n/g, ' ')}`).join('\n');
  const raw = await gemini(env, {
    contents: [{ parts: [{ text:
`Pick which entry the user means. Reply with ONLY strict JSON: {"id":"<entry id>"}
Entries:
${listing}
User described: ${intent.entry_hint || ''}` }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
  });
  let entry = null;
  try { entry = node.entries.find(e => e.id === parseJsonLoose(raw).id) || null; } catch { entry = null; }
  // v5 fix-02: if Gemini's pick misses, fall back to content scoring, then
  // the most recent entry — never declare a real entry unidentifiable.
  if (!entry && node.entries.length) {
    const { scored } = await entriesWithScore(path);
    const best = scored.reduce((a, b) => (b.score > (a ? a.score : -1) ? b : a), null);
    entry = (best && best.score > 0) ? best.e : node.entries[node.entries.length - 1];
  }
  if (!entry) { await editText(env, chatId, statusMessageId, 'Could not identify that entry.'); return; }

  if (mode === 'delete') {
    const breadcrumb = path.split('/').join(' › ');
    await editText(env, chatId, statusMessageId,
      `⚠️ Delete entry ${entry.id} from ${node.title} (${breadcrumb})?\n\n_${entry.date}_\n${entry.body.slice(0, 200)}`,
      { keyboard: confirmDeleteKeyboard(`${await h8(path)}:${entry.id}`, 'entry') });
    return;
  }

  // edit (case 3): read + rewrite only this entry
  await editText(env, chatId, statusMessageId, '⏳ Editing…');
  const rewritten = await gemini(env, {
    contents: [{ parts: [{ text:
`Rewrite this notebook entry per the instruction. Output ONLY the new entry body (Markdown, keep any image embeds ![..](assets/..) unchanged unless the instruction says otherwise). No commentary.

CURRENT ENTRY:
${entry.body}

INSTRUCTION:
${intent.instruction || 'improve clarity'}` }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });
  const body = String(rewritten).trim();
  if (!body) { await editText(env, chatId, statusMessageId, '❌ Edit produced nothing.'); return; }
  await updateEntry(env, path, entry.id, body);
  const breadcrumb = path.split('/').join(' › ');
  await editText(env, chatId, statusMessageId,
    `✏️ Updated entry ${entry.id} in ${node.title} (${breadcrumb}):\n\n_${entry.date}_\n${body.slice(0, 400)}`);
}

// ---- auto-filing a photo (caption + image understanding) ------------------

async function autoFilePhoto(env, message, caption, statusMessageId) {
  const chatId = message.chat.id;
  const { downloadTgFile } = await import('./telegram.js');
  const { storeImage } = await import('./notes.js');
  const { extFromMimeOrPath } = await import('./util.js');
  const photos = message.photo;
  const best = [...photos].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0];
  const { bytes, path: tgPath } = await downloadTgFile(env, best.file_id);

  const tree = await treeListing(env);
  const raw = await gemini(env, {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/jpeg', data: b64encodeBytes(bytes) } },
      { text:
`File this photo (caption: "${caption || 'none'}") into the notebook tree:
${tree}

Reply with ONLY strict JSON: {"path":"<existing path with > separators>","caption":"<one-line description for the note>"} to use an existing topic, or {"title":"<new topic>","parent":"<parent or empty>","caption":"<one-line description>","new":true}.` },
    ] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 512 } },
  });
  const decision = parseJsonLoose(raw);
  let nodePath = null;
  if (decision.new) {
    const parent = decision.parent ? await resolvePath(env, decision.parent, true) : '';
    const made = await createNode(env, parent || '', decision.title || 'Photos');
    nodePath = made.path;
  } else {
    nodePath = await resolvePath(env, String(decision.path || '').replace(/ > /g, '/'), true);
  }
  if (!nodePath) { const made = await createNode(env, '', 'Photos'); nodePath = made.path; }

  const ext = extFromMimeOrPath(null, tgPath);
  const stored = await storeImage(env, nodePath, bytes, ext);
  const body = `${decision.caption ? decision.caption + '\n\n' : (caption ? caption + '\n\n' : '')}![photo](${stored.rel})`;
  const entryId = await appendEntry(env, nodePath, body);
  const node = await readNode(env, nodePath);
  const breadcrumb = nodePath.split('/').join(' › ');
  const title = node ? node.title : nodePath.split('/').pop();
  const created = !!decision.new;
  await editText(env, chatId, statusMessageId,
    created
      ? `✅ Created new topic "${title}" (${breadcrumb}) and filed the photo there as entry ${entryId}.`
      : `✅ Filed photo as entry ${entryId} under ${title} (${breadcrumb}).`,
    { keyboard: await filedActionsKeyboard(nodePath, entryId) });
}

export { gemini, parseJsonLoose };
