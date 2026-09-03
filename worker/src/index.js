// Codex — Telegram-first personal notebook.
// Webhook entry point. Verifies the Telegram secret token header, then
// routes the update. Manual commands/buttons never touch Gemini. (redeploy)

import { routeMessage, routeCallbackQuery } from './router.js';

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
          if (update.message) {
            await routeMessage(update.message, env);
          } else if (update.callback_query) {
            await routeCallbackQuery(update.callback_query, env);
          }
        } catch (err) {
          console.error('update handling failed:', err && err.stack ? err.stack : err);
        }
      })()
    );

    return new Response('ok', { status: 200 });
  },
};
