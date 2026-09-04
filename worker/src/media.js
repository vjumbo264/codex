// Media ingestion. Photos: download from Telegram, store under the node's
// assets/, append an entry embedding them — deterministic when a target
// node is known; otherwise the caption/content goes through auto-filing.
// Voice notes: need transcription (Gemini, task-07) before filing.
// Documents: text-bearing files (.txt/.md/.csv/.log/.json/.yaml/.xml, and
// any text/* MIME) are read as note content and auto-filed just like a
// typed note. A caption acts as filing context (may fast-path via
// pattern matching in routeFreeText). fix-02.

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
  const status = await sendText(env, chatId, '⏳ Reading file…');
  const { editText } = await import('./telegram.js');

  let content;
  try {
    const { bytes } = await downloadTgFile(env, doc.file_id);
    if (bytes.length > MAX_TEXT_FILE_BYTES) {
      await editText(env, chatId, status.message_id,
        `📎 That file is ${Math.round(bytes.length / 1024)} KB — larger than the ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB cap.`);
      return;
    }
    content = decodeText(bytes).replace(/\r\n/g, '\n').trim();
  } catch (e) {
    console.error('doc download failed', e);
    await editText(env, chatId, status.message_id, '❌ Could not download the file. Try again.');
    return;
  }

  if (!content) {
    await editText(env, chatId, status.message_id, '📎 That file looks empty.');
    return;
  }

  const fileLabel = doc.file_name ? `“${doc.file_name}”` : 'the uploaded file';

  // Explicit destination (from /add): deterministic, ZERO Gemini.
  if (explicitPath) {
    await editText(env, chatId, status.message_id, '⏳ Filing…');
    // If the file is clearly unstructured prose, we still don't call Gemini
    // on the explicit-path branch — the operator asked for a specific topic,
    // so we trust them and store the content as-is (same policy as typed
    // note in /add). No quota spent when destination is unambiguous.
    const body = caption ? `${caption}\n\n${content}` : content;
    const entryId = await appendEntry(env, explicitPath, body);
    const node = await readNode(env, explicitPath);
    const breadcrumb = explicitPath.split('/').join(' › ');
    const title = node ? node.title : explicitPath.split('/').pop();
    await editText(env, chatId, status.message_id,
      `✅ Filed ${fileLabel} as entry ${entryId} under ${title} (${breadcrumb}).`,
      { keyboard: await filedActionsKeyboard(explicitPath, entryId) });
    return;
  }

  // No explicit destination — delegate to the free-text router. If the
  // caption is an "add this to X:" / "new topic X:" fast-path, that path
  // will match and never invoke Gemini. Otherwise routeFreeText will run
  // one classification call, exactly as if the operator had typed the
  // file's contents.
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
  // Fake a message-like object carrying just chat + text; routeFreeText
  // only reads chat.id and dispatches. fix-remove-placeholder: the
  // "⏳ Reading file…" message above is edited into the result of the
  // explicit fast-path when it matches (deterministic branch — reuses the
  // status message in place). When the caption/body needs Gemini dispatch,
  // routeFreeText no longer emits a placeholder at all: its next visible
  // message is the real reply, so the stale "Reading file…" message is
  // deleted to leave exactly one message for the turn (Compass shape).
  const { tg } = await import('./telegram.js');
  const pseudo = { chat: { id: chatId } };
  const placeholderless = await routeFreeText(env, pseudo, dispatchText,
    { statusMessageId: status.message_id });
  if (!placeholderless) {
    await tg(env, 'deleteMessage', { chat_id: chatId, message_id: status.message_id });
  }
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

  const status = await sendText(env, chatId, '⏳ Saving photo…');
  try {
    const photo = bestPhoto(message.photo);
    const { bytes, path: tgPath } = await downloadTgFile(env, photo.file_id);
    const ext = extFromMimeOrPath(null, tgPath);
    const stored = await storeImage(env, nodePath, bytes, ext);
    const body = (caption ? caption + '\n\n' : '') + `![photo](${stored.rel})`;
    const entryId = await appendEntry(env, nodePath, body);
    const node = await readNode(env, nodePath);
    const { editText } = await import('./telegram.js');
    const breadcrumb = nodePath.split('/').join(' › ');
    const title = node ? node.title : nodePath.split('/').pop();
    await editText(env, chatId, status.message_id,
      `✅ Filed photo as entry ${entryId} under ${title} (${breadcrumb}).`,
      { keyboard: await filedActionsKeyboard(nodePath, entryId) });
  } catch (e) {
    console.error('photo ingest failed', e);
    const { editText } = await import('./telegram.js');
    await editText(env, chatId, status.message_id, '❌ Could not save the photo. Try again.');
  }
}

// Voice note ingestion: transcribe + clean via Gemini, then file.
export async function handleVoiceMessage(env, message, explicitPath = null) {
  const chatId = message.chat.id;
  const { getKeys, kvErrorMessage } = await import('./keypool.js');
  let pool;
  try { pool = await getKeys(env); }
  catch (e) {
    // fix-01 v3: storage failures are surfaced, not mistaken for "no key".
    const kvMsg = kvErrorMessage(e);
    if (kvMsg) { await sendText(env, chatId, kvMsg); return; }
    throw e;
  }
  if (!pool.length) {
    await sendText(env, chatId,
      '🎙 Voice notes need a Gemini API key for transcription. Add one via /menu → ⚙️ Settings → 🔑 Gemini API keys, or send text instead.');
    return;
  }
  const status = await sendText(env, chatId, '⏳ Transcribing…');
  try {
    const media = message.voice || message.audio;
    const { bytes, path: tgPath } = await downloadTgFile(env, media.file_id);
    const { transcribeAndClean } = await import('./gemini.js');
    const cleaned = await transcribeAndClean(env, bytes, tgPath);
    if (!cleaned) throw new Error('empty transcription');
    const { editText } = await import('./telegram.js');
    if (explicitPath) {
      await editText(env, chatId, status.message_id, '⏳ Filing…');
      const entryId = await appendEntry(env, explicitPath, cleaned);
      const node = await readNode(env, explicitPath);
      const breadcrumb = explicitPath.split('/').join(' › ');
      const title = node ? node.title : explicitPath.split('/').pop();
      await editText(env, chatId, status.message_id,
        `✅ Filed voice note as entry ${entryId} under ${title} (${breadcrumb}).`,
        { keyboard: await filedActionsKeyboard(explicitPath, entryId) });
    } else {
      // No destination -> auto-file the cleaned text via Gemini.
      await editText(env, chatId, status.message_id, '⏳ Filing…');
      const { autoFileNote } = await import('./gemini.js');
      await autoFileNote(env, chatId, cleaned, status.message_id);
    }
  } catch (e) {
    console.error('voice ingest failed', e);
    const { editText } = await import('./telegram.js');
    const { allFailedMessage } = await import('./gemini.js');
    await editText(env, chatId, status.message_id,
      allFailedMessage(e) || '❌ Transcription failed. Try again or send text.');
  }
}
