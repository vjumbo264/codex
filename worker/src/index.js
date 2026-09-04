// Codex — Telegram-first personal notebook.
// Webhook entry point. Verifies the Telegram secret token header, then
// routes the update. Manual commands/buttons never touch Gemini. (redeploy)

import { routeMessage, routeCallbackQuery } from './router.js';
import { syncCommandMenu, sendText } from './telegram.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('codex-bot ok', { status: 200 });
    }

    // Verify the request really comes from Telegram (set via setWebhook).
    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    // ACK Telegram immediately; do the real work in the background so
    // Telegram never retries on slow operations (GitHub/Gemini calls).
    ctx.waitUntil(
      (async () => {
        try {
          // Keep the `/` command menu matching the implementation (runs at
          // most once per day; a no-op otherwise).
          await syncCommandMenu(env);
          if (update.message) {
            await routeMessage(update.message, env);
          } else if (update.callback_query) {
            await routeCallbackQuery(update.callback_query, env);
          }
        } catch (err) {
          console.error('update handling failed:', err && err.stack ? err.stack : err);
          // fix-silent-nonresponse (Compass safeSendError pattern): the
          // catch above used to be log-only, so any error escaping the
          // routers left the user staring at "⏳ Working on it…" forever.
          // Tell the user SOMETHING — best effort, never re-throw.
          try {
            const chatId = (update.message && update.message.chat && update.message.chat.id) ||
              (update.callback_query && update.callback_query.message &&
                update.callback_query.message.chat && update.callback_query.message.chat.id);
            if (chatId) {
              await sendText(env, chatId,
                '⚠️ Something went wrong handling that. Please try again in a moment, or use a command from /help.');
            }
          } catch { /* never let the failure notifier itself fail */ }
        }
      })()
    );

    return new Response('ok', { status: 200 });
  },
};
