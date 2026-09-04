// Codex — Telegram-first personal notebook.
// Webhook entry point. Verifies the Telegram secret token header, then
// routes the update. Manual commands/buttons never touch Gemini.
//
// adapt-compass-pattern-d1-and-user-lock, Part 1 (messaging pattern):
// after the update is parsed and the sender is authorized, the worker
// immediately fires Telegram's NATIVE typing indicator (sendChatAction,
// 'typing') — Compass src/handlers/webhook.ts line 117. Telegram renders
// this as its built-in "user is typing…" UI: there is no placeholder
// message to store an id for, edit later, or ever leave stranded. The
// typing indicator auto-expires after ~5s, so the router re-sends it on
// a 4s interval for the duration of dispatch (router.js withTyping).
// Exactly ONE final sendText with the real reply follows, and the outer
// catch below always produces a visible fallback (Compass safeSendError).

import { routeMessage, routeCallbackQuery } from './router.js';
import { syncCommandMenu, sendText, answerCb } from './telegram.js';

// Part 3 (user lock): a single authorized Telegram user id, from env so
// it can be changed without a code edit. Unset => refuse EVERYONE (fail
// closed — an unreleased personal bot must not silently become public).
function authorizedUserId(env) {
  const raw = env.AUTHORIZED_USER_ID;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

function senderUserId(update) {
  if (update.message && update.message.from) return update.message.from.id;
  if (update.callback_query && update.callback_query.from) return update.callback_query.from.id;
  return null;
}

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

    // Part 3 (user lock) — checked BEFORE syncCommandMenu, BEFORE any
    // routing, tool call, D1 write or Gemini call. Covers every entry
    // point that can trigger bot behavior: text messages, voice/photo/
    // file messages (they all arrive as update.message) and callback
    // queries (button taps — update.callback_query).
    const authorized = authorizedUserId(env);
    const sender = senderUserId(update);
    if (authorized === null || sender === null || sender !== authorized) {
      try {
        if (update.callback_query) {
          // Always answer a tap so the button's spinner stops even for a
          // refused user (Compass: never leave a callback hanging).
          await answerCb(env, update.callback_query.id, 'This bot is not available for this user.');
        }
        const chatId = (update.message && update.message.chat && update.message.chat.id) ||
          (update.callback_query && update.callback_query.message &&
            update.callback_query.message.chat && update.callback_query.message.chat.id);
        if (chatId) {
          await sendText(env, chatId,
            '🔒 Codex is not available for this user. This is a private bot locked to its operator.');
        }
      } catch { /* the refusal itself must never hang the update */ }
      return new Response('ok', { status: 200 });
    }

    // Inline, awaited dispatch (previous initiative, kept): Cloudflare
    // only guarantees a waitUntil'd task keeps the isolate alive, not
    // that it runs to completion once the Response is returned. Telegram's
    // own webhook retry/timeout governs the request instead.
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
      // Compass safeSendError pattern: tell the user SOMETHING — best
      // effort, never re-throw.
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
