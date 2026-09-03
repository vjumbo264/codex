// callback_query routing: browse (b), read pages (r), export (x/X),
// delete ask/confirm (d/D), cancel (c), and post-file actions (v/m/mt/n).
// All deterministic — no Gemini.

import { answerCb, sendText, editText } from './telegram.js';
import { h8 } from './util.js';
import { resolveH8, getNodes } from './tree.js';
import { readNode, deleteNodeTree, deleteEntry, moveEntry, createNode } from './notes.js';

import { browseKeyboard, confirmDeleteKeyboard, moveTargetKeyboard } from './keyboards.js';
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
    case 'x': { // export node
      const path = await resolveH8(env, a1);
      await answerCb(env, query.id);
      if (path === null) { await sendText(env, chatId, 'Not found.'); break; }
      const status = await sendText(env, chatId, '⏳ Rendering PDF…');
      try { await doExport(env, chatId, path, status && status.message_id); }
      catch (e) { console.error(e); await sendText(env, chatId, '❌ Export failed.'); }
      break;
    }
    case 'X': { // export whole notebook
      await answerCb(env, query.id);
      const status = await sendText(env, chatId, '⏳ Rendering PDF…');
      try { await doExport(env, chatId, '', status && status.message_id); }
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
          const parentPath = path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          const where = path ? path.split('/').join(' › ') : '(root)';
          const n = await deleteNodeTree(env, path);
          await editText(env, chatId, messageId,
            `🗑 Deleted topic "${path.split('/').pop()}" (${where}) and ${n} file${n === 1 ? '' : 's'} inside it.`);
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
