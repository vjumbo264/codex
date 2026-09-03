// Stateless multi-step flows via Telegram ForceReply. The bot asks a
// question with ForceReply and appends an invisible-ish footer token:
//
//     #cx:<flow>:<h8>[:<extra>]
//
// When the operator replies, message.reply_to_message.text contains that
// footer, so the Worker recovers full context with zero server state.

const TOKEN_RE = /#cx:([a-z]+):([0-9a-f]+|root)(?::([0-9A-Za-z-]+))?\s*$/;

export function tokenFooter(flow, handle, extra) {
  return `#cx:${flow}:${handle}${extra ? ':' + extra : ''}`;
}

// Parse a reply's context from the message it replies to.
// Returns { flow, handle, extra } or null.
export function parsePending(message) {
  const replied = message.reply_to_message;
  if (!replied || !replied.text) return null;
  const m = TOKEN_RE.exec(replied.text.trim());
  if (!m) return null;
  return { flow: m[1], handle: m[2], extra: m[3] || null };
}

export function stripToken(text) {
  return String(text || '').replace(TOKEN_RE, '').trim();
}
