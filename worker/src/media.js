// Media ingestion. Photos: download from Telegram, store under the node's
// assets/, append an entry embedding them — deterministic when a target
// node is known; otherwise the caption/content goes through auto-filing.
// Voice notes: need transcription (Gemini) before filing.
// Documents: text-bearing files (.txt/.md/.csv/.log/.json/.yaml/.xml, and
// any text/* MIME) are read as note content and auto-filed just like a
// typed note. A caption acts as filing context (may fast-path via
// pattern matching in routeFreeText). fix-02.
//
// adapt-compass-pattern-d1-and-user-lock, Part 1: NO placeholder status
// messages anywhere in this module ("⏳ Reading file…", "⏳ Saving photo…",
// "⏳ Transcribing…", "⏳ Filing…" are all gone). The router shows
// Telegram's NATIVE typing indicator for the whole turn (Compass
// handlers/webhook.ts pattern); each handler does its work and sends
// exactly ONE final message — the confirmation or the failure.

import { downloadTgFile, sendText } from './telegram.js';
import { storeImage, appendEntry, readNode } from './notes.js';
import { extFromMimeOrPath } from './util.js';
import { filedActionsKeyboard } from './keyboards.js';

// Max size of a text file we will read into a note. Keeps Worker memory
// bounded and prevents pathological Gemini quota consumption; the
// operator's own text notes are much smaller than this in practice.
const MAX_TEXT_FILE_BYTES = 256 * 1024;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'mdown', 'mkd',
  'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'xml',
  'ini', 'conf', 'cfg', 'toml', 'rst', 'org', 'tex',
]);

function isTextishDocument(doc) {
  if (!doc) return false;
  const mime = String(doc.mime_type || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml' ||
      mime === 'application/yaml' || mime === 'application/x-yaml' ||
      mime === 'application/toml' || mime === 'application/x-toml') {
    return true;
  }
  const name = String(doc.file_name || '').toLowerCase();
  const m = /\.([a-z0-9]+)$/.exec(name);
  if (m && TEXT_EXTS.has(m[1])) return true;
  // application/octet-stream + a text-looking extension is common when a
  // client uploads a .md/.txt without setting the MIME.
  return false;
}

function decodeText(bytes) {
  // Strip a UTF-8 BOM if present, then decode as UTF-8 (Workers TextDecoder
  // is UTF-8 by default). Invalid sequences are replaced with U+FFFD, not
  // thrown — the operator's file is more important than a decoder error.
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start));
}

// Handle a document upload. If the file is text-bearing, read it and
// route through the same path as a typed note (caption acts as filing
// hint). explicitPath: node path when destination is already known (e.g.
// from /add ForceReply flow). Non-text documents are politely declined.
export async function handleDocumentMessage(env, message, explicitPath = null) {
  const chatId = message.chat.id;
  const doc = message.document;
  if (!doc) return;

  if (!isTextishDocument(doc)) {
    await sendText(env, chatId,
      `📎 I can only read text-bearing files right now (${doc.file_name || 'this file'} — ${doc.mime_type || 'unknown type'}). ` +
      `Supported: .txt, .md, .csv, .log, .json, .yaml, .xml and any text/* MIME. Send it as text or a photo instead.`);
    return;
  }

  if (doc.file_size && doc.file_size > MAX_TEXT_FILE_BYTES) {
    await sendText(env, chatId,
      `📎 That file is ${Math.round(doc.file_size / 1024)} KB — larger than the ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB text-file cap. ` +
      `Trim it or split into multiple notes.`);
    return;
  }

  const caption = (message.caption || '').trim();

  let content;
  try {
    const { bytes } = await downloadTgFile(env, doc.file_id);
    if (bytes.length > MAX_TEXT_FILE_BYTES) {
      await sendText(env, chatId,
        `📎 That file is ${Math.round(bytes.length / 1024)} KB — larger than the ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB cap.`);
      return;
    }
    content = decodeText(bytes).replace(/\r\n/g, '\n').trim();
  } catch (e) {
    console.error('doc download failed', e);
    await sendText(env, chatId, '❌ Could not download the file. Try again.');
    return;
  }

  if (!content) {
    await sendText(env, chatId, '📎 That file looks empty.');
    return;
  }

  const fileLabel = doc.file_name ? `“${doc.file_name}”` : 'the uploaded file';

  // Explicit destination (from /add): deterministic, ZERO Gemini.
  if (explicitPath) {
    // If the file is clearly unstructured prose, we still don't call Gemini
    // on the explicit-path branch — the operator asked for a specific topic,
    // so we trust them and store the content as-is (same policy as typed
    // note in /add). No quota spent when destination is unambiguous.
    const body = caption ? `${caption}\n\n${content}` : content;
    const entryId = await appendEntry(env, explicitPath, body);
    const node = await readNode(env, explicitPath);
    const breadcrumb = explicitPath.split('/').join(' › ');
    const title = node ? node.title : explicitPath.split('/').pop();
    await sendText(env, chatId,
      `✅ Filed ${fileLabel} as entry ${entryId} under ${title} (${breadcrumb}).`,
      { keyboard: await filedActionsKeyboard(explicitPath, entryId) });
    return;
  }

  // No explicit destination — delegate to the free-text router. If the
  // caption is an "add this to X:" / "new topic X:" fast-path, that path
  // will match and never invoke Gemini. Otherwise routeFreeText will run
  // one classification call, exactly as if the operator had typed the
  // file's contents. Either way the turn ends with exactly ONE message
  // (Compass shape) — no "⏳ Reading file…" placeholder to clean up.
  const { routeFreeText } = await import('./gemini.js');
  // If the caption uses one of the explicit fast-paths, that pattern
  // expects "prefix TOPIC: content". Rebuild the string to match:
  let dispatchText;
  const fastAdd = caption && /^(?:add(?: this)? to|file (?:this|under|in)|put (?:this )?in)\s+[^:]+\s*:\s*$/i.exec(caption);
  const fastNew = caption && /^new topic\s+[^:]+\s*:\s*$/i.exec(caption);
  if (fastAdd || fastNew) {
    // Caption ends with the trailing ':' — append the file body.
    dispatchText = `${caption} ${content}`;
  } else if (caption) {
    // Free-form caption: prepend as context; Gemini reads both.
    dispatchText = `${caption}\n\n${content}`;
  } else {
    dispatchText = content;
  }
  const pseudo = { chat: { id: chatId } };
  await routeFreeText(env, pseudo, dispatchText);
}

// Biggest photo variant = best quality.
function bestPhoto(photos) {
  return [...photos].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0];
}

// Ingest a photo message. explicitPath: node path when destination is known
// (e.g. from /add pending flow); null -> auto-file via Gemini.
export async function handlePhotoMessage(env, message, explicitPath) {
  const chatId = message.chat.id;
  const caption = (message.caption || '').trim();

  let nodePath = explicitPath;
  if (!nodePath) {
    // Need Gemini to decide where this belongs (or the caption says where).
    const { routeFreeText } = await import('./gemini.js');
    await routeFreeText(env, message, caption || '(photo with no caption)', { photo: message });
    return;
  }

  // Explicit destination: no "⏳ Saving photo…" placeholder — download,
  // store, and send exactly one confirmation (or one failure) message.
  try {
    const photo = bestPhoto(message.photo);
    const { bytes, path: tgPath } = await downloadTgFile(env, photo.file_id);
    const ext = extFromMimeOrPath(null, tgPath);
    const stored = await storeImage(env, nodePath, bytes, ext);
    const body = (caption ? caption + '\n\n' : '') + `![photo](${stored.rel})`;
    const entryId = await appendEntry(env, nodePath, body);
    const node = await readNode(env, nodePath);
    const breadcrumb = nodePath.split('/').join(' › ');
    const title = node ? node.title : nodePath.split('/').pop();
    await sendText(env, chatId,
      `✅ Filed photo as entry ${entryId} under ${title} (${breadcrumb}).`,
      { keyboard: await filedActionsKeyboard(nodePath, entryId) });
  } catch (e) {
    console.error('photo ingest failed', e);
    await sendText(env, chatId, '❌ Could not save the photo. Try again.');
  }
}

// Voice note ingestion: transcribe + clean via Gemini, then file.
export async function handleVoiceMessage(env, message, explicitPath = null) {
  const chatId = message.chat.id;
  const { getKeys, kvErrorMessage } = await import('./keypool.js');
  let pool;
  try { pool = await getKeys(env); }
  catch (e) {
    // Storage failures are surfaced, not mistaken for "no key".
    const kvMsg = kvErrorMessage(e);
    if (kvMsg) { await sendText(env, chatId, kvMsg); return; }
    throw e;
  }
  if (!pool.length) {
    await sendText(env, chatId,
      '🎙 Voice notes need a Gemini API key for transcription. Add one via /menu → ⚙️ Settings → 🔑 Gemini API keys, or send text instead.');
    return;
  }
  // No "⏳ Transcribing…" / "⏳ Filing…" placeholders: the router's typing
  // indicator covers the wait; exactly one final message follows.
  try {
    const media = message.voice || message.audio;
    const { bytes, path: tgPath } = await downloadTgFile(env, media.file_id);
    const { transcribeAndClean } = await import('./gemini.js');
    const cleaned = await transcribeAndClean(env, bytes, tgPath);
    if (!cleaned) throw new Error('empty transcription');
    if (explicitPath) {
      const entryId = await appendEntry(env, explicitPath, cleaned);
      const node = await readNode(env, explicitPath);
      const breadcrumb = explicitPath.split('/').join(' › ');
      const title = node ? node.title : explicitPath.split('/').pop();
      await sendText(env, chatId,
        `✅ Filed voice note as entry ${entryId} under ${title} (${breadcrumb}).`,
        { keyboard: await filedActionsKeyboard(explicitPath, entryId) });
    } else {
      // No explicit destination was given (not sent as a reply into a
      // specific topic) — the transcript could be a note OR a spoken
      // instruction ("create a topic called X and put this inside"),
      // exactly like typed free text. Route it through the same
      // classifier/dispatcher text gets (classifyAndDispatch), not
      // straight to autoFileNote, so voice gets the same reasoning
      // about intent that text already gets. classifyAndDispatch's own
      // auto-file tool covers the "just a note" case; it now also
      // covers "create topic and file this" the way text always could.
      const { classifyAndDispatch } = await import('./gemini.js');
      await classifyAndDispatch(env, chatId, cleaned, null);
    }
  } catch (e) {
    console.error('voice ingest failed', e);
    const { allFailedMessage } = await import('./gemini.js');
    await sendText(env, chatId,
      allFailedMessage(e) || '❌ Transcription failed. Try again or send text.');
  }
}
