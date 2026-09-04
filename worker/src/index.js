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

    // Compass pattern: do the real work INLINE, awaited, before responding
    // to Telegram — not deferred via ctx.waitUntil. Cloudflare only
    // guarantees a waitUntil'd background task keeps the isolate alive; it
    // does not guarantee it runs to completion once the Response has
    // already been returned, which was producing intermittent total
    // silence under real load. Awaiting here means Telegram's own webhook
    // retry/timeout governs the request instead.
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
      // fix-silent-nonresponse (Compass safeSendError pattern): tell the
      // user SOMETHING — best effort, never re-throw.
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

    return new Response('ok', { status: 200 });
  },
};
