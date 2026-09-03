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

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function requireKey(env) {
  return !!env.GEMINI_API_KEY;
}

async function gemini(env, payload) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini: no content');
  return parts.map(p => p.text || '').join('');
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
  const withTitle = [];
  for (const p of paths) {
    if (!p) continue;
    withTitle.push(p.split('/').join(' > '));
  }
  return withTitle.length ? withTitle.join('\n') : '(no topics yet)';
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
    generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
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
  if (!requireKey(env)) {
    if (opts.photo) {
      await sendText(env, chatId,
        '📷 I can save this photo, but I need the Gemini API key to decide where it goes. Add GEMINI_API_KEY (see README), or use /add <topic> then send the photo.');
      return;
    }
    await sendText(env, chatId,
      'I need the Gemini API key to file free-form notes. Add GEMINI_API_KEY (see README), or use a command: /new, /add, /topics, /read, /export, /delete.');
    return;
  }

  // A photo with no explicit path -> auto-file it (image content + caption).
  if (opts.photo) {
    const status = await sendText(env, chatId, '⏳ Filing photo…');
    try {
      await autoFilePhoto(env, message, text, status.message_id);
    } catch (e) {
      console.error(e);
      await editText(env, chatId, status.message_id, '❌ Could not file the photo. Try /add <topic>.');
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
      '❌ I could not handle that. Try a command from /help.');
  }
}

// ---- case 4 + task-08: minimal intent classification ----------------------

async function classifyAndDispatch(env, chatId, text, statusMessageId) {
  const tree = await treeListing(env);
  const raw = await gemini(env, {
    contents: [{
      parts: [{ text:
`You are the dispatcher for a Telegram notebook bot. The notebook tree:
${tree}

Classify the user's message into ONE action and reply with ONLY strict JSON. Actions:
- {"action":"note","text":"<the note content>"}                       -> a new note to auto-file
- {"action":"read","path":"<topic>"}                                   -> read/show a topic
- {"action":"export","path":"<topic or 'all'>"}                        -> export PDF
- {"action":"delete_topic","path":"<topic>"}                           -> delete a topic
- {"action":"delete_entry","path":"<topic>","entry_hint":"<what the entry says>"} -> delete one entry
- {"action":"edit","path":"<topic>","entry_hint":"<which entry>","instruction":"<how to change it>"} -> edit an entry
- {"action":"browse"}                                                  -> show/browse topics
- {"action":"help"}                                                    -> how to use
Use the tree paths exactly as listed (with > separators). If a referenced topic is not in the tree, still give your best-guess path string.

USER MESSAGE:
${text}` }],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
  });
  const intent = parseJsonLoose(raw);

  switch (intent.action) {
    case 'note':
      await autoFileNote(env, chatId, intent.text || text, statusMessageId);
      return;
    case 'read': {
      const path = await resolvePath(env, intent.path || '', true);
      if (path === null) { await editText(env, chatId, statusMessageId, `Topic not found: ${intent.path}`); return; }
      await editText(env, chatId, statusMessageId, '📖 Here it is:');
      await sendReadPage(env, chatId, path, 0, await h8(path));
      return;
    }
    case 'export': {
      const path = /^all$/i.test(intent.path || '') ? '' : await resolvePath(env, intent.path || '', true);
      if (path === null) { await editText(env, chatId, statusMessageId, `Topic not found: ${intent.path}`); return; }
      await editText(env, chatId, statusMessageId, '⏳ Rendering PDF…');
      await doExport(env, chatId, path, statusMessageId);
      return;
    }
    case 'delete_topic': {
      const path = await resolvePath(env, intent.path || '', true);
      if (path === null) { await editText(env, chatId, statusMessageId, `Topic not found: ${intent.path}`); return; }
      const breadcrumb = path.split('/').join(' › ');
      await editText(env, chatId, statusMessageId,
        `⚠️ Delete topic "${path.split('/').pop()}" (${breadcrumb}) and everything inside?`,
        { keyboard: confirmDeleteKeyboard(await h8(path), 'topic') });
      return;
    }
    case 'delete_entry': {
      await handleEntryAction(env, chatId, statusMessageId, intent, 'delete');
      return;
    }
    case 'edit': {
      await handleEntryAction(env, chatId, statusMessageId, intent, 'edit');
      return;
    }
    case 'browse': {
      const { getNodes } = await import('./tree.js');
      const { browseKeyboard } = await import('./keyboards.js');
      const nodes = await getNodes(env);
      const root = nodes.get('');
      await editText(env, chatId, statusMessageId, '🗂 Your topics — pick one to open:',
        { keyboard: await browseKeyboard('', root ? root.children : [], { backTo: null }) });
      return;
    }
    default:
      await editText(env, chatId, statusMessageId,
        'I can capture notes, browse, read, export, edit and delete. Try /help for commands.');
  }
}

// Entry-targeted actions: resolve which entry Gemini means (case 4), then
// either confirm-delete it or rewrite it (case 3).
async function handleEntryAction(env, chatId, statusMessageId, intent, mode) {
  const path = await resolvePath(env, intent.path || '', true);
  if (path === null) { await editText(env, chatId, statusMessageId, `Topic not found: ${intent.path}`); return; }
  const node = await readNode(env, path);
  if (!node || !node.entries.length) {
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
  const { id } = parseJsonLoose(raw);
  const entry = node.entries.find(e => e.id === id);
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
    generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
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
