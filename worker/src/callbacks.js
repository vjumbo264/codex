// callback_query routing: app screens (home h, settings s, keys sk/ka/kr/kc
// — fix-03), browse (b), read pages (r), export (x/X), delete ask/confirm
// (d/D), cancel (c), and post-file actions (v/m/mt/n).
// All deterministic — no Gemini.

import { answerCb, sendText, editText, sendChatAction } from './telegram.js';
import { h8 } from './util.js';
import { resolveH8, getNodes } from './tree.js';
import { readNode, deleteNodeTree, deleteEntry, moveEntry, createNode } from './notes.js';

import { browseKeyboard, confirmDeleteKeyboard, moveTargetKeyboard } from './keyboards.js';
import { HOME_TEXT, homeKeyboard, exportMenuKeyboard, settingsKeyboard, keysScreen, addKeysPrompt } from './ui.js';
import { removeKeyAt, clearKeys, maskKey, kvErrorMessage } from './keypool.js';
import { sendReadPage } from './read.js';
import { doExport } from './export.js';
import { tokenFooter } from './pending.js';

async function sendBrowse(env, chatId, nodePath, messageId) {
  const nodes = await getNodes(env);
  const rec = nodes.get(nodePath);
  const children = rec ? rec.children : [];
  const parent = nodePath.includes('/') ? nodePath.slice(0, nodePath.lastIndexOf('/')) : (nodePath ? '' : null);
  const kb = await browseKeyboard(nodePath, children, { backTo: parent });
  const label = nodePath ? `🗂 ${nodePath.split('/').join(' › ')}` : '🗂 Your topics:';
  if (messageId) await editText(env, chatId, messageId, label, { keyboard: kb });
  else await sendText(env, chatId, label, { keyboard: kb });
}

export async function routeCallbackQuery(query, env) {
  const chatId = query.message && query.message.chat.id;
  const messageId = query.message && query.message.message_id;
  const data = query.data || '';
  const [op, a1, a2, a3] = data.split(':');

  switch (op) {
    // ---- app screens (fix-03) -------------------------------------------
    case 'h': { // home screen
      await answerCb(env, query.id);
      await editText(env, chatId, messageId, HOME_TEXT, { keyboard: homeKeyboard() });
      break;
    }
    case 's': { // settings menu
      await answerCb(env, query.id);
      await editText(env, chatId, messageId,
        '⚙️ Settings\n\nPick a section:', { keyboard: settingsKeyboard() });
      break;
    }
    case 'sk': { // settings -> Gemini keys
      await answerCb(env, query.id);
      const screen = await keysScreen(env); // shows KV failures loudly (fix-01 v3)
      await editText(env, chatId, messageId, screen.text, { keyboard: screen.keyboard });
      break;
    }
    case 'nt': { // new topic (fix-03 v3): ForceReply prompt for the name
      await answerCb(env, query.id);
      await sendText(env, chatId,
        `Name for the new topic:\n\n${tokenFooter('newtopic', 'root')}`,
        { forceReply: true, placeholder: 'New topic name…' });
      break;
    }
    case 'an': { // add note to this topic (fix-03 v3): ForceReply prompt
      const path = await resolveH8(env, a1);
      await answerCb(env, query.id);
      if (path === null) { await sendText(env, chatId, 'That topic no longer exists.'); break; }
      await sendText(env, chatId,
        `Send the note for "${path.split('/').pop()}" (text, a photo, a voice note, or a text file; reply to this message):\n\n${tokenFooter('add', a1)}`,
        { forceReply: true, placeholder: 'Type your note…' });
      break;
    }
    case 'e': { // edit entry (fix-03 v3): ForceReply prompt for the instruction
      const path = await resolveH8(env, a1);
      await answerCb(env, query.id);
      if (path === null) { await sendText(env, chatId, 'That topic no longer exists.'); break; }
      const node = await readNode(env, path);
      const entry = node && node.entries.find(x => x.id === a2);
      if (!entry) { await sendText(env, chatId, 'That entry no longer exists.'); break; }
      await sendText(env, chatId,
        `✏️ Editing entry ${a2} in ${node.title}:\n\n_${entry.date}_\n${entry.body.slice(0, 200)}\n\nReply with your edit instruction (e.g. "make it shorter", "change the date to Friday"):\n\n${tokenFooter('edit', a1, a2)}`,
        { forceReply: true, placeholder: 'How should I change it?' });
      break;
    }
    case 'ka': { // add keys -> ForceReply prompt
      await answerCb(env, query.id);
      const prompt = addKeysPrompt();
      await sendText(env, chatId, prompt.text, prompt.opts);
      break;
    }
    case 'kr': { // remove key by index (tap only — never retype a key)
      const idx = parseInt(a1 || '-1', 10);
      try {
        const removed = await removeKeyAt(env, idx);
        await answerCb(env, query.id, removed ? `Removed ${maskKey(removed)}` : 'Key not found');
        const screen = await keysScreen(env);
        // fix-02 v3: a stale/double-tapped button says so explicitly.
        const note = removed
          ? `🗑 Removed key ${maskKey(removed)}.\n\n`
          : `ℹ️ No key at position ${idx + 1} anymore (already removed, or the list changed) — the current list is below.\n\n`;
        await editText(env, chatId, messageId, note + screen.text, { keyboard: screen.keyboard });
      } catch (e) {
        const kvMsg = kvErrorMessage(e);
        if (kvMsg) {
          await answerCb(env, query.id, 'Key storage problem');
          const screen = await keysScreen(env);
          await editText(env, chatId, messageId, `${kvMsg}\n\n${screen.text}`, { keyboard: screen.keyboard });
        } else { throw e; }
      }
      break;
    }
    case 'kc': { // clear all keys (two taps: ask -> confirm)
      if (a1 === 'confirm') {
        try {
          const n = await clearKeys(env);
          await answerCb(env, query.id, `Cleared ${n} key${n === 1 ? '' : 's'}`);
          const screen = await keysScreen(env);
          await editText(env, chatId, messageId,
            `🧹 Cleared all ${n} key${n === 1 ? '' : 's'}.\n\n` + screen.text,
            { keyboard: screen.keyboard });
        } catch (e) {
          const kvMsg = kvErrorMessage(e);
          if (kvMsg) {
            await answerCb(env, query.id, 'Key storage problem');
            await editText(env, chatId, messageId, kvMsg);
          } else { throw e; }
        }
      } else {
        await answerCb(env, query.id);
        await editText(env, chatId, messageId,
          '⚠️ Remove ALL Gemini API keys? Voice notes, auto-filing and edits will stop working until you add one.',
          { keyboard: [
              [{ text: '✅ Yes, clear all', callback_data: 'kc:confirm' },
               { text: '◀️ Back', callback_data: 'sk:root' }],
              [{ text: '🏠 Home', callback_data: 'h:root' }],
            ] });
      }
      break;
    }
    case 'b': { // browse node
      const path = await resolveH8(env, a1);
      if (path === null) { await answerCb(env, query.id, 'Not found'); break; }
      await answerCb(env, query.id);
      await sendBrowse(env, chatId, path, messageId);
      break;
    }
    case 'r': { // read page
      const path = await resolveH8(env, a1);
      await answerCb(env, query.id);
      if (path === null) { await sendText(env, chatId, 'Not found.'); break; }
      await sendReadPage(env, chatId, path, parseInt(a2 || '0', 10), a1);
      break;
    }
    case 'x': { // export node — or the Export chooser from Home (x:menu)
      if (a1 === 'menu') {
        await answerCb(env, query.id);
        await editText(env, chatId, messageId,
          '📄 Export — what should I render as PDF?',
          { keyboard: exportMenuKeyboard() });
        break;
      }
      const path = await resolveH8(env, a1);
      await answerCb(env, query.id);
      if (path === null) { await sendText(env, chatId, 'Not found.'); break; }
      await sendChatAction(env, chatId, 'upload_document');
      try { await doExport(env, chatId, path, null); }
      catch (e) { console.error(e); await sendText(env, chatId, '❌ Export failed.'); }
      break;
    }
    case 'X': { // export whole notebook
      await answerCb(env, query.id);
      await sendChatAction(env, chatId, 'upload_document');
      try { await doExport(env, chatId, '', null); }
      catch (e) { console.error(e); await sendText(env, chatId, '❌ Export failed.'); }
      break;
    }
    case 'd': { // ask delete confirmation
      await answerCb(env, query.id);
      if (a1.includes(':') || a2) { /* entry delete confirm handled via d:<h8>:<id> */ }
      const handle = a1;
      const extra = a2;
      if (extra) { // entry within node
        await editText(env, chatId, messageId,
          '⚠️ Delete this entry? This cannot be undone (recoverable only via git history).',
          { keyboard: confirmDeleteKeyboard(`${handle}:${extra}`, 'entry') });
      } else {
        const path = await resolveH8(env, handle);
        const name = path ? path.split('/').pop() : '?';
        await editText(env, chatId, messageId,
          `⚠️ Delete topic "${name}" and everything inside it?`,
          { keyboard: confirmDeleteKeyboard(handle, 'topic') });
      }
      break;
    }
    case 'D': { // confirmed delete -> execute
      const handle = a1, entryId = a2;
      await answerCb(env, query.id, 'Deleting…');
      try {
        if (entryId) {
          const path = await resolveH8(env, handle);
          const node = path !== null ? await readNode(env, path) : null;
          await deleteEntry(env, path, entryId);
          const where = path ? path.split('/').join(' › ') : '(root)';
          const title = node ? node.title : (path ? path.split('/').pop() : '(unknown)');
          await editText(env, chatId, messageId,
            `🗑 Deleted entry ${entryId} from ${title} (${where}).`);
        } else {
          const path = await resolveH8(env, handle, true);
          const n = await deleteNodeTree(env, path);
          if (!path) {
            // v7 fix-03: whole-notebook delete, confirmed via 'D:root'.
            await editText(env, chatId, messageId,
              `🗑 Deleted the ENTIRE notebook — ${n} file${n === 1 ? '' : 's'} removed (every topic and entry). Recoverable only via git history.`);
          } else {
            const where = path.split('/').join(' › ');
            await editText(env, chatId, messageId,
              `🗑 Deleted topic "${path.split('/').pop()}" (${where}) and ${n} file${n === 1 ? '' : 's'} inside it.`);
          }
        }
      } catch (e) {
        console.error(e);
        await editText(env, chatId, messageId, '❌ Delete failed.');
      }
      break;
    }
    case 'c': { // cancel/dismiss
      await answerCb(env, query.id, 'Cancelled');
      await editText(env, chatId, messageId, 'Cancelled.');
      break;
    }
    case 'v': { // view just-filed entry's node
      const path = await resolveH8(env, a1);
      await answerCb(env, query.id);
      if (path === null) { await sendText(env, chatId, 'Not found.'); break; }
      await sendReadPage(env, chatId, path, 0, a1);
      break;
    }
    case 'm': { // start move flow -> pick a top-level target
      const nodePaths = await getNodes(env);
      await answerCb(env, query.id);
      const kb = await moveTargetKeyboard(a1, a2, [...nodePaths.keys()]);
      await editText(env, chatId, messageId, '🔀 Move to which topic?', { keyboard: kb });
      break;
    }
    case 'mt': { // move target chosen: mt:<fromH8>:<entryId>:<toH8>
      const fromPath = await resolveH8(env, a1);
      const toPath = await resolveH8(env, a3);
      await answerCb(env, query.id, 'Moving…');
      try {
        await moveEntry(env, fromPath, a2, toPath);
        const fromLabel = fromPath ? fromPath.split('/').join(' › ') : '(root)';
        const toLabel = toPath ? toPath.split('/').join(' › ') : '(root)';
        await editText(env, chatId, messageId,
          `✅ Moved entry ${a2} from ${fromLabel} to ${toLabel}.`);
      } catch (e) {
        console.error(e);
        await editText(env, chatId, messageId, '❌ Move failed.');
      }
      break;
    }
    case 'n': { // re-file as brand-new top-level topic: ask for the name
      await answerCb(env, query.id);
      await sendText(env, chatId,
        `Name for the new topic (the note will move there):\n\n${tokenFooter('newtopic', a1, a2)}`,
        { forceReply: true, placeholder: 'New topic name…' });
      break;
    }
    default:
      await answerCb(env, query.id, 'Unknown action');
  }
}
