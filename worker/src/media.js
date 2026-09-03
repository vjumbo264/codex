// Media ingestion. Photos: download from Telegram, store under the node's
// assets/, append an entry embedding them — deterministic when a target
// node is known; otherwise the caption/content goes through auto-filing.
// Voice notes: need transcription (Gemini, task-07) before filing.

import { downloadTgFile, sendText } from './telegram.js';
import { storeImage, appendEntry, readNode } from './notes.js';
import { extFromMimeOrPath } from './util.js';
import { filedActionsKeyboard } from './keyboards.js';

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
    await editText(env, chatId, status.message_id,
      `✅ Photo filed under ${node ? node.title : nodePath}.`,
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
  if (!env.GEMINI_API_KEY) {
    await sendText(env, chatId,
      '🎙 Voice notes need the Gemini API key for transcription. Add it as the Worker secret GEMINI_API_KEY (see README), or send text instead.');
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
      await editText(env, chatId, status.message_id,
        `✅ Voice note filed under ${node ? node.title : explicitPath}.`,
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
    await editText(env, chatId, status.message_id, '❌ Transcription failed. Try again or send text.');
  }
}
