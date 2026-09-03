// The tappable home interface (fix-03). Every screen follows one pattern:
// a title line, one button per available action, and Back/Home navigation
// so the whole bot is operable by taps alone after the initial /start.
//
// Screen opcodes (callbacks.js routes them):
//   h   — home screen                     ("h:root" redraws it)
//   s   — settings menu                   ("s:root")
//   sk  — settings → Gemini keys screen   ("sk:root")
//   ka  — add keys: ForceReply prompt     ("ka:root")
//   kr  — remove key by index             ("kr:<i>")
//   kc  — clear all keys                  ("kc:root" ask / "kc:confirm" do)
//
// Capture (sending text/voice/photo/file) still works by just sending the
// content — that part is not a screen, it is the bot's input.

import { btn } from './keyboards.js';
import { tokenFooter } from './pending.js';
import { getKeys, maskKey } from './keypool.js';

export const HOME_TEXT =
`🏠 Codex — home

Capture: just send text, a voice note, a photo, or a text file (add a caption to steer where it goes).

Or pick an action:`;

export function homeKeyboard() {
  return [
    [btn('🗂 Browse topics', 'b:root')],
    [btn('📄 Export', 'x:menu')],
    [btn('⚙️ Settings', 's:root')],
  ];
}

export function exportMenuKeyboard() {
  return [
    [btn('📄 Whole notebook', 'X:root')],
    [btn('🗂 Pick a topic…', 'b:root')],
    [btn('◀️ Back', 'h:root')],
  ];
}

export function settingsKeyboard() {
  return [
    [btn('🔑 Gemini API keys', 'sk:root')],
    [btn('◀️ Back', 'h:root'), btn('🏠 Home', 'h:root')],
  ];
}

// Settings → Keys screen: title + masked key list + actions.
export async function keysScreen(env) {
  const keys = await getKeys(env);
  const lines = ['🔑 Settings — Gemini API keys', ''];
  if (keys.length) {
    keys.forEach((k, i) => lines.push(`${i + 1}. ${maskKey(k)}`));
  } else {
    lines.push('No keys configured yet.');
  }
  lines.push('');
  lines.push(keys.length
    ? `${keys.length} key${keys.length === 1 ? '' : 's'} stored. Keys are tried in order; the bot remembers the last working one.`
    : 'Add at least one key to enable auto-filing, voice notes, and edits.');
  const rows = [[btn('➕ Add keys', 'ka:root')]];
  for (let i = 0; i < keys.length; i++) {
    rows.push([btn(`🗑 Remove ${i + 1} (${maskKey(keys[i])})`, `kr:${i}`)]);
  }
  if (keys.length) rows.push([btn('🧹 Clear all keys', 'kc:root')]);
  rows.push([btn('◀️ Back', 's:root'), btn('🏠 Home', 'h:root')]);
  return { text: lines.join('\n'), keyboard: rows };
}

// ForceReply prompt for pasting keys (one per line, any number at once).
export function addKeysPrompt() {
  return {
    text:
`Send your Gemini API key(s) — one per line, as many as you like, in a single message:

AIza…first
AIza…second

(Keys are stored masked; only the last 4 characters are ever shown back.)

${tokenFooter('keys', 'root')}`,
    opts: { forceReply: true, placeholder: 'Paste key(s), one per line…' },
  };
}
