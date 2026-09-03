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
    // 400 on edit with identical text is routine; everything else we log.
    if (!(method === 'editMessageText' && res.status === 400)) {
      console.error(`telegram ${method} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return null;
  }
  return data.result;
}

export function sendText(env, chatId, text, opts = {}) {
  const payload = { chat_id: chatId, text };
  if (opts.keyboard) payload.reply_markup = { inline_keyboard: opts.keyboard };
  if (opts.forceReply) {
    payload.reply_markup = { force_reply: true, selective: true, input_field_placeholder: opts.placeholder || 'Type here…' };
  }
  if (opts.replyTo) payload.reply_to_message_id = opts.replyTo;
  if (opts.allowNoReply) payload.allow_sending_without_reply = true;
  return tg(env, 'sendMessage', payload);
}

export function editText(env, chatId, messageId, text, opts = {}) {
  const payload = { chat_id: chatId, message_id: messageId, text };
  if (opts.keyboard) payload.reply_markup = { inline_keyboard: opts.keyboard };
  return tg(env, 'editMessageText', payload);
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
