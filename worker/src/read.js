// Shared "read a node in chat" renderer: paginated plain-text chunks with
// each entry's images sent as real inline photos right after its chunk.

import { readNode } from './notes.js';
import { rawUrl } from './github.js';
import { chunkText } from './util.js';
import { sendText, sendPhoto } from './telegram.js';
import { paginationKeyboard } from './keyboards.js';

// Build display chunks for a node: [{ text, images: [url] }]
export async function buildReadChunks(env, nodePath) {
  const node = await readNode(env, nodePath);
  if (!node) return null;
  const parts = [];
  const header = `📖 ${node.title}\n${nodePath ? nodePath.split('/').join(' › ') : ''}\n${'—'.repeat(18)}`;
  let buf = header + '\n\n';
  let bufIds = []; // entry ids visible in the current chunk (fix-03 v3)
  for (const e of node.entries) {
    const imgs = [...e.body.matchAll(/!\[[^\]]*\]\(assets\/([^)]+)\)/g)]
      .map(m => rawUrl(env, `notebook/${nodePath}/assets/${m[1]}`));
    const textBody = e.body.replace(/!\[[^\]]*\]\(assets\/[^)]+\)/g, '').replace(/\n{3,}/g, '\n\n').trim();
    let block = `_${e.date}_ · …${e.id.slice(-4)}\n\n${textBody}`;
    if (imgs.length) block += `\n(📷 ${imgs.length} photo${imgs.length > 1 ? 's' : ''} below)`;
    block += '\n\n' + '─'.repeat(14) + '\n\n';
    if ((buf + block).length > 3400) {
      parts.push({ text: buf.trim(), images: [], entryIds: bufIds });
      buf = '';
      bufIds = [];
    }
    buf += block;
    bufIds.push(e.id);
    if (imgs.length) {
      // flush so photos land directly under the entry text
      parts.push({ text: buf.trim(), images: imgs, entryIds: bufIds });
      buf = '';
      bufIds = [];
    }
  }
  if (buf.trim()) parts.push({ text: buf.trim(), images: [], entryIds: bufIds });
  if (!parts.length) parts.push({ text: header + '\n\n_(no entries yet)_', images: [], entryIds: [] });
  // Sub-chunk anything still too long
  const out = [];
  for (const p of parts) {
    if (p.text.length <= 3800) { out.push(p); continue; }
    const subs = chunkText(p.text, 3800);
    subs.forEach((t, i) => out.push({
      text: t,
      images: i === subs.length - 1 ? p.images : [],
      entryIds: i === 0 ? (p.entryIds || []) : [],
    }));
  }
  return { title: node.title, chunks: out };
}

export async function sendReadPage(env, chatId, nodePath, page, handle) {
  const data = await buildReadChunks(env, nodePath);
  if (!data) {
    await sendText(env, chatId, `Not found: ${nodePath || '(root)'}`);
    return;
  }
  const p = Math.min(Math.max(page, 0), data.chunks.length - 1);
  const chunk = data.chunks[p];
  const kb = await paginationKeyboard(handle, p, p < data.chunks.length - 1, chunk.entryIds || []);
  const label = data.chunks.length > 1 ? `\n\n— page ${p + 1}/${data.chunks.length} —` : '';
  await sendText(env, chatId, chunk.text + label, kb.length ? { keyboard: kb } : {});
  for (const url of chunk.images) {
    await sendPhoto(env, chatId, url);
  }
}
