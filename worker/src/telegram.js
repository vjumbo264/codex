// Telegram Bot API client. Plain-text messages only (no parse_mode), which
// keeps raw Markdown note content rendering exactly as written.

export async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    // "message is not modified" is a routine no-op; every OTHER failure is
    // logged — fix-silent-nonresponse: this used to suppress ALL
    // editMessageText 400s, which silently swallowed "message is too long".
    const desc = String((data && data.description) || '');
    if (!(method === 'editMessageText' && res.status === 400 && /message is not modified/i.test(desc))) {
      console.error(`telegram ${method} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return null;
  }
  return data.result;
}

// Telegram caps message text at 4096 chars (same chunking pattern as the
// Compass reference bot's services/telegram.ts chunkText). Chunked callers
// send the continuation parts as follow-up messages.
export function chunkText(text, size = 4000) {
  const t = String(text == null ? '' : text);
  const chunks = [];
  for (let i = 0; i < t.length; i += size) chunks.push(t.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

export async function sendText(env, chatId, text, opts = {}) {
  const chunks = chunkText(text);
  let first = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i] };
    if (i === 0) {
      if (opts.keyboard) payload.reply_markup = { inline_keyboard: opts.keyboard };
      if (opts.forceReply) {
        payload.reply_markup = { force_reply: true, selective: true, input_field_placeholder: opts.placeholder || 'Type here…' };
      }
      if (opts.replyTo) payload.reply_to_message_id = opts.replyTo;
      if (opts.allowNoReply) payload.allow_sending_without_reply = true;
    }
    const out = await tg(env, 'sendMessage', payload);
    if (i === 0) first = out;
  }
  return first; // Telegram Message of the first chunk, or null on failure
}

// Edit a message's text; if the replacement exceeds Telegram's 4096 cap the
// overflow goes out as follow-up sendText chunks so the content is NEVER
// lost to a silent 400 (the fix-silent-nonresponse root cause). Returns the
// edited Message, or null when the edit itself failed (callers fall back).
export async function editText(env, chatId, messageId, text, opts = {}) {
  const chunks = chunkText(text);
  const payload = { chat_id: chatId, message_id: messageId, text: chunks[0] };
  if (opts.keyboard) payload.reply_markup = { inline_keyboard: opts.keyboard };
  const edited = await tg(env, 'editMessageText', payload);
  if (edited !== null && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: chunks[i] });
    }
  }
  return edited;
}

export function sendPhoto(env, chatId, photoUrl, caption) {
  const payload = { chat_id: chatId, photo: photoUrl };
  if (caption) payload.caption = caption.slice(0, 1000);
  return tg(env, 'sendPhoto', payload);
}

export async function sendDocumentBytes(env, chatId, bytes, filename, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
  if (caption) form.append('caption', caption.slice(0, 1000));
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    console.error(`telegram sendDocument -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return null;
  }
  return data.result;
}

// Keep the Telegram `/` command menu in sync with what's actually
// implemented. Called at most once per UTC day per KV namespace so this is
// effectively free after the first update of the day.
const COMMANDS = [
  { command: 'start', description: 'Open the home menu' },
  { command: 'menu', description: 'Open the home menu' },
  { command: 'topics', description: 'Browse the notebook tree' },
  { command: 'new', description: 'Create a topic: /new travel/japan' },
  { command: 'add', description: 'Add a note to an exact topic' },
  { command: 'read', description: 'Read a topic in chat' },
  { command: 'export', description: 'PDF of a topic, or /export all' },
  { command: 'delete', description: 'Delete a topic or one entry' },
  { command: 'help', description: 'How to use Codex' },
];

export async function syncCommandMenu(env) {
  const today = new Date().toISOString().slice(0, 10);
  if (env.CODEX_KV) {
    try {
      const last = await env.CODEX_KV.get('sys:cmd_synced');
      if (last === today) return;
    } catch { /* fall through and try anyway */ }
  }
  const out = await tg(env, 'setMyCommands', { commands: COMMANDS });
  if (out !== null && env.CODEX_KV) {
    try { await env.CODEX_KV.put('sys:cmd_synced', today); } catch { /* non-fatal */ }
  }
  return out;
}

export function answerCb(env, callbackQueryId, text) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text.slice(0, 200);
  return tg(env, 'answerCallbackQuery', payload);
}

// Download a Telegram file (voice/photo) by file_id -> { bytes, path }.
export async function downloadTgFile(env, fileId) {
  const info = await tg(env, 'getFile', { file_id: fileId });
  if (!info || !info.file_path) throw new Error('getFile failed');
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
  if (!res.ok) throw new Error(`file download -> ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: info.file_path };
}
