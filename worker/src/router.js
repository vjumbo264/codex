// Message routing. Manual commands and ForceReply-driven flows are fully
// deterministic. Free text/voice/photos without an explicit destination go
// to the Gemini dispatch layer (tasks 06/07) — which is imported lazily so
// the manual path contains no Gemini code at all.

import { sendText } from './telegram.js';
import { handleCommand } from './commands.js';
import { parsePending } from './pending.js';
import { resolveH8, resolvePath } from './tree.js';
import { appendEntry, createNode, moveEntry, readNode } from './notes.js';
import { h8 } from './util.js';
import { handlePhotoMessage, handleVoiceMessage, handleDocumentMessage } from './media.js';
import { routeCallbackQuery } from './callbacks.js';

export { routeCallbackQuery };

export async function routeMessage(message, env) {
  const chatId = message.chat && message.chat.id;
  if (!chatId) return;
  const text = (message.text || message.caption || '').trim();

  // 1) Pending ForceReply flows (deterministic)
  const pending = parsePending(message);
  if (pending) {
    const handled = await handlePendingFlow(env, message, pending);
    if (handled) return;
  }

  // 2) Slash commands (deterministic, zero Gemini)
  if (message.text && message.text.startsWith('/')) {
    const handled = await handleCommand(env, message);
    if (handled) return;
    await sendText(env, chatId, 'Unknown command. Try /help.');
    return;
  }

  // 3) Media ingestion (task-06): photos file deterministically when a
  //    destination is explicit; voice notes need transcription (task-07);
  //    text-bearing documents (fix-02) are read as note content.
  if (message.photo && message.photo.length) {
    await handlePhotoMessage(env, message, null);
    return;
  }
  if (message.voice || message.audio) {
    await handleVoiceMessage(env, message);
    return;
  }
  if (message.document) {
    await handleDocumentMessage(env, message, null);
    return;
  }

  // 4) Free text -> Gemini auto-file dispatch (task-07)
  if (text) {
    const { routeFreeText } = await import('./gemini.js');
    await routeFreeText(env, message, text);
  }
}

async function handlePendingFlow(env, message, pending) {
  const chatId = message.chat.id;
  const { flow, handle, extra } = pending;

  if (flow === 'add') {
    const path = await resolveH8(env, handle);
    if (path === null) { await sendText(env, chatId, 'That topic no longer exists.'); return true; }
    if (message.text && /^(cancel|stop|abort|never ?mind)$/i.test(message.text.trim())) {
      await sendText(env, chatId, 'Cancelled.');
      return true;
    }
    if (message.photo && message.photo.length) {
      await handlePhotoMessage(env, message, path);
      return true;
    }
    if (message.voice || message.audio) {
      await handleVoiceMessage(env, message, path);
      return true;
    }
    if (message.document) {
      await handleDocumentMessage(env, message, path);
      return true;
    }
    const text = (message.text || '').trim();
    if (!text) { await sendText(env, chatId, 'Send text or a photo for the note.'); return true; }
    const entryId = await appendEntry(env, path, text);
    const node = await readNode(env, path);
    const breadcrumb = path.split('/').join(' › ');
    const title = node ? node.title : path.split('/').pop();
    await sendText(env, chatId, `✅ Filed note as entry ${entryId} under ${title} (${breadcrumb}).`);
    return true;
  }

  if (flow === 'newtopic') {
    // handle = h8 of current node, extra = entry id; message.text = new topic name
    if (message.text && /^(cancel|stop|abort|never ?mind)$/i.test(message.text.trim())) {
      await sendText(env, chatId, 'Cancelled.');
      return true;
    }
    const name = (message.text || '').trim();
    if (!name) { await sendText(env, chatId, 'Send a topic name, or tap Cancel.'); return true; }
    const fromPath = await resolveH8(env, handle);
    if (fromPath === null) { await sendText(env, chatId, 'Original note no longer found.'); return true; }
    try {
      const made = await createNode(env, '', name);
      await moveEntry(env, fromPath, extra, made.path);
      const fromLabel = fromPath ? fromPath.split('/').join(' › ') : '(root)';
      const toLabel = made.path.split('/').join(' › ');
      await sendText(env, chatId,
        `✅ Created new topic "${name}" (${toLabel}) and moved entry ${extra} there from ${fromLabel}.`);
    } catch (e) {
      console.error(e);
      await sendText(env, chatId, '❌ Could not create/move. Try again.');
    }
    return true;
  }

  return false;
}
