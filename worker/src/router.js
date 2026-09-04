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

  if (flow === 'keys') {
    // Settings → Keys → Add (fix-03): newline-separated keys in one message.
    if (message.text && /^(cancel|stop|abort|never ?mind)$/i.test(message.text.trim())) {
      await sendText(env, chatId, 'Cancelled.');
      return true;
    }
    const text = (message.text || '').trim();
    if (!text) {
      await sendText(env, chatId, 'Send the key(s) as text, one per line.');
      return true;
    }
    // Part 2 (false key-exhaustion): split on ANY whitespace, not just
    // newlines. Confirmed live evidence: key pool entry [4] was a 106-char
    // doubled paste (two keys concatenated with no newline between them)
    // that returned 401 on EVERY model. The old \n-only split stored that
    // concatenation as ONE corrupted key; splitting on all whitespace means
    // a doubled paste now lands as two separate valid keys instead of one
    // permanently-dead one.
    const candidates = text.split(/\s+/).map(s => s.trim()).filter(Boolean);
    const { addKeys, kvErrorMessage } = await import('./keypool.js');
    const { keysScreen } = await import('./ui.js');
    let res;
    try {
      res = await addKeys(env, candidates);
    } catch (e) {
      // fix-01 v3: a KV storage failure is LOUD — never reported as
      // "key added" and never rendered as an empty pool.
      const kvMsg = kvErrorMessage(e);
      if (kvMsg) {
        const screen = await keysScreen(env);
        await sendText(env, chatId, `${kvMsg}\n\n${screen.text}`, { keyboard: screen.keyboard });
        return true;
      }
      throw e;
    }
    let head;
    if (res.added === 0) {
      head = `⚠️ No keys added — ${res.skipped} line${res.skipped === 1 ? ' was' : 's were'} invalid or already stored.`;
    } else {
      head = `✅ Added ${res.added} Gemini API key${res.added === 1 ? '' : 's'}` +
        (res.skipped ? ` (skipped ${res.skipped} invalid/duplicate line${res.skipped === 1 ? '' : 's'})` : '') +
        `. ${res.total} key${res.total === 1 ? '' : 's'} now configured.`;
    }
    const screen = await keysScreen(env);
    await sendText(env, chatId, `${head}\n\n${screen.text}`, { keyboard: screen.keyboard });
    return true;
  }

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
    // Two uses: (a) move flow — handle = h8 of current node, extra = entry
    // id; (b) fix-03 v3 tap-only topic creation — handle = root, no extra.
    if (message.text && /^(cancel|stop|abort|never ?mind)$/i.test(message.text.trim())) {
      await sendText(env, chatId, 'Cancelled.');
      return true;
    }
    const name = (message.text || '').trim();
    if (!name) { await sendText(env, chatId, 'Send a topic name, or tap Cancel.'); return true; }
    if (!extra) { // pure "New topic" from Home/Browse
      try {
        const made = await createNode(env, '', name);
        const { browseKeyboard } = await import('./keyboards.js');
        const { getNodes } = await import('./tree.js');
        const nodes = await getNodes(env, true);
        const rec = nodes.get(made.path);
        const kb = await browseKeyboard(made.path, rec ? rec.children : [], { backTo: '' });
        await sendText(env, chatId,
          `✅ Created new topic "${name}" (${made.path.split('/').join(' › ')}).`,
          { keyboard: kb });
      } catch (e) {
        console.error(e);
        await sendText(env, chatId, '❌ Could not create the topic. Try again.');
      }
      return true;
    }
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

  if (flow === 'edit') {
    // fix-03 v3: tap-only entry edit — handle = node h8, extra = entry id;
    // message.text = the operator's natural-language edit instruction.
    if (message.text && /^(cancel|stop|abort|never ?mind)$/i.test(message.text.trim())) {
      await sendText(env, chatId, 'Cancelled.');
      return true;
    }
    const instruction = (message.text || '').trim();
    if (!instruction) { await sendText(env, chatId, 'Send the edit instruction, or tap Cancel.'); return true; }
    const path = await resolveH8(env, handle);
    if (path === null) { await sendText(env, chatId, 'That topic no longer exists.'); return true; }
    const status = await sendText(env, chatId, '⏳ Editing…');
    const { maybeApplyTapEdit, allFailedMessage } = await import('./gemini.js');
    const { kvErrorMessage } = await import('./keypool.js');
    try {
      await maybeApplyTapEdit(env, chatId, path, extra, instruction, status.message_id);
    } catch (e) {
      console.error('tap edit failed', e);
      const kvMsg = kvErrorMessage(e);
      const { editText } = await import('./telegram.js');
      await editText(env, chatId, status.message_id,
        kvMsg || allFailedMessage(e) || '❌ I could not apply that edit. Try again.');
    }
    return true;
  }

  return false;
}
