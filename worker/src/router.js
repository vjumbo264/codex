// Task-03 scaffold router — replaced by the full command/callback
// implementations in tasks 05-09. Keeps the Worker deployable and
// verifiably alive from the very first deploy.

export async function routeMessage(message, env) {
  const chatId = message.chat && message.chat.id;
  if (!chatId) return;
  await sendTelegram(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Codex is online. Full command handling ships with the next build steps.',
  });
}

export async function routeCallbackQuery(query, env) {
  await sendTelegram(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: 'Codex scaffold online.',
  });
}

async function sendTelegram(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('telegram error', method, res.status, await res.text());
  }
  return res;
}
