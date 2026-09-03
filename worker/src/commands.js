// Manual slash-command handlers — fully deterministic, ZERO Gemini usage.

import { sendText } from './telegram.js';
import { h8 } from './util.js';
import { resolvePath, getNodes, nodeExists } from './tree.js';
import { createNode, appendEntry, readNode, deleteNodeTree, deleteEntry } from './notes.js';
import { browseKeyboard, confirmDeleteKeyboard } from './keyboards.js';
import { sendReadPage } from './read.js';
import { doExport } from './export.js';
import { tokenFooter } from './pending.js';

const HELP = `📓 *Codex* — your notebook, right here in Telegram.

Capture
• Just send text, a voice note, or a photo — I'll file it (via Gemini when set up).
• /new <topic> — create a topic (use a/b for nesting)
• /add <topic> — add a note to an exact topic (I'll ask for the text)

Browse & read
• /topics — browse the tree with buttons (drill in, read, export, delete)
• /read <topic> — read a topic in chat, photos included

Export
• /export <topic> — PDF of that topic + everything under it
• /export all — the whole notebook as one PDF

Edit & delete
• /delete <topic> — delete a topic and all inside it (asks first)
• /delete <topic> <entry-id> — delete one entry (asks first)
• To edit, just ask in plain language, e.g. "edit the note about visas in travel"

Tips
• Tap a topic's Read button to page through it.
• After I auto-file something, you get View / Move / New topic buttons.`;

export async function handleCommand(env, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const m = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();

  switch (cmd) {
    case 'start':
      await sendText(env, chatId, `👋 Welcome to Codex — your Telegram notebook.\n\n${HELP}`);
      return true;

    case 'help':
      await sendText(env, chatId, HELP);
      return true;

    case 'new': {
      if (!arg) {
        await sendText(env, chatId, 'Usage: /new <topic>  (e.g. /new travel, or /new travel/japan)');
        return true;
      }
      const segs = arg.split('/').map(s => s.trim()).filter(Boolean);
      let cur = '';
      const made = [];
      for (const seg of segs) {
        const existing = await resolvePath(env, cur ? `${cur}/${seg}` : seg, true);
        if (existing !== null) { cur = existing; continue; }
        const created = await createNode(env, cur, seg);
        made.push(created.path);
        cur = created.path;
      }
      if (made.length) {
        const p = made[made.length - 1];
        const leaf = p.split('/').pop();
        await sendText(env, chatId, `✅ Created new topic "${leaf}" (${p.split('/').join(' › ')}).`);
      } else {
        await sendText(env, chatId, `Topic already exists: ${cur.split('/').join(' › ')}`);
      }
      return true;
    }

    case 'topics':
    case 'browse': {
      const nodes = await getNodes(env);
      const root = nodes.get('');
      const kb = await browseKeyboard('', root ? root.children : [], { backTo: null });
      if (!root || !root.children.length) {
        await sendText(env, chatId, 'No topics yet. Create one with /new <topic> or just send me a note.', { keyboard: kb });
      } else {
        await sendText(env, chatId, '🗂 Your topics:', { keyboard: kb });
      }
      return true;
    }

    case 'add': {
      if (!arg) {
        await sendText(env, chatId, 'Usage: /add <topic>  — I\'ll then ask for the note text.');
        return true;
      }
      const path = await resolvePath(env, arg, true);
      if (path === null) {
        await sendText(env, chatId, `Topic not found: ${arg}\nCreate it first with /new ${arg}`);
        return true;
      }
      const handle = await h8(path);
      await sendText(env, chatId,
        `Send the note text for "${arg}" (text or a photo; reply to this message):\n\n${tokenFooter('add', handle)}`,
        { forceReply: true, placeholder: 'Type your note…' });
      return true;
    }

    case 'read': {
      if (!arg) { await sendText(env, chatId, 'Usage: /read <topic>'); return true; }
      const path = await resolvePath(env, arg, true);
      if (path === null) { await sendText(env, chatId, `Topic not found: ${arg}`); return true; }
      await sendReadPage(env, chatId, path, 0, await h8(path));
      return true;
    }

    case 'export': {
      if (!arg) { await sendText(env, chatId, 'Usage: /export <topic> or /export all'); return true; }
      const path = /^all$/i.test(arg) ? '' : await resolvePath(env, arg, true);
      if (path === null) { await sendText(env, chatId, `Topic not found: ${arg}`); return true; }
      const status = await sendText(env, chatId, '⏳ Rendering PDF…');
      try {
        await doExport(env, chatId, path, status && status.message_id);
      } catch (e) {
        console.error('export failed', e);
        await sendText(env, chatId, '❌ Export failed. Please try again.');
      }
      return true;
    }

    case 'delete': {
      if (!arg) { await sendText(env, chatId, 'Usage: /delete <topic> [entry-id]'); return true; }
      // entry-id form: /delete <topic> <entry-id>
      const entryM = /^(.+?)\s+([0-9]{8}-[0-9]{6}-[0-9a-z]{4})$/.exec(arg);
      if (entryM) {
        const path = await resolvePath(env, entryM[1], true);
        if (path === null) { await sendText(env, chatId, `Topic not found: ${entryM[1]}`); return true; }
        const node = await readNode(env, path);
        const entry = node && node.entries.find(e => e.id === entryM[2]);
        if (!entry) { await sendText(env, chatId, `Entry not found: ${entryM[2]}`); return true; }
        const handle = await h8(path);
        await sendText(env, chatId,
          `⚠️ Delete this entry from ${node.title}?\n\n_${entry.date}_\n${entry.body.slice(0, 200)}`,
          { keyboard: confirmDeleteKeyboard(`${handle}:${entry.id}`, 'entry') });
        return true;
      }
      const path = await resolvePath(env, arg, true);
      if (path === null) { await sendText(env, chatId, `Topic not found: ${arg}`); return true; }
      const nodes = await getNodes(env);
      const rec = nodes.get(path);
      const nKids = rec ? rec.children.length : 0;
      const handle = await h8(path);
      await sendText(env, chatId,
        `⚠️ Delete topic "${path.split('/').pop()}"${nKids ? ` and its ${nKids} subtopic${nKids > 1 ? 's' : ''}` : ''}, with everything inside?\n\nThis cannot be undone (recoverable only via git history).`,
        { keyboard: confirmDeleteKeyboard(handle, 'topic') });
      return true;
    }

    default:
      return false; // unknown command -> fall through
  }
}
