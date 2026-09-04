// Part 2 investigation step 2: run the worker's OWN request shape
// (x-goog-api-key header, same payload family) against the REAL live KV key
// pool on multiple models, capturing REAL status + body per key. Also runs
// the Compass request shape (?key= query param) for direct comparison.
// NEVER prints full keys — masked only.
const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const ns = process.env.KV_NAMESPACE_ID;
if (!account || !token || !ns) { console.error('need CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID'); process.exit(2); }

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)}` : '…????');

// Worker's exact isKeyFailure (gemini.js lines 40-49), verbatim copy for evidence.
function isKeyFailure(status, bodyText) {
  const t = String(bodyText || '');
  const quotaish = /RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|quota/i.test(t);
  const keyInvalid = /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|key.*(?:invalid|expired|revoked|forbidden)/i.test(t);
  if (status === 429) return true;
  if (status === 403) return keyInvalid || quotaish;
  if (status === 400) return keyInvalid;
  if (status === 401) return true;
  return false;
}

const r = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/gemini%3Akeys`,
  { headers: { Authorization: `Bearer ${token}` } });
const keys = await r.json();
if (!Array.isArray(keys) || !keys.length) throw new Error('pool empty');
console.log(`pool: ${keys.length} keys`);

// The worker's dispatch payload family (classifyAndDispatch round 1).
const payload = {
  systemInstruction: { role: 'system', parts: [{ text: 'You are the dispatcher for a Telegram notebook bot.\n\nThe notebook tree:\n(no topics yet)\n\nDecide what the user wants.' }] },
  contents: [{ role: 'user', parts: [{ text: 'Say OK.' }] }],
  tools: [{ functionDeclarations: [{ name: 'help', description: 'Explain what this bot can do.', parameters: { type: 'OBJECT', properties: {} } }] }],
  toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  generationConfig: { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 512 } },
};

const models = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

for (const model of models) {
  console.log(`\n=== model: ${model} — worker shape (x-goog-api-key header) ===`);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let out;
    try {
      const res = await fetch(`${BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload),
      });
      const t = await res.text();
      let snippet = '';
      if (res.ok) {
        try {
          const d = JSON.parse(t);
          const parts = d.candidates?.[0]?.content?.parts || [];
          snippet = 'OK text=' + JSON.stringify(parts.map(p => p.text || '').join('').slice(0, 40));
        } catch { snippet = 'OK (unparseable)'; }
      } else {
        try {
          const d = JSON.parse(t);
          snippet = (d.error && (d.error.status + ' | ' + String(d.error.message).slice(0, 160))) || t.slice(0, 160);
        } catch { snippet = t.slice(0, 160); }
      }
      out = `key[${i}] ${mask(key)} -> HTTP ${res.status} | isKeyFailure=${res.ok ? 'n/a' : isKeyFailure(res.status, t)} | ${snippet}`;
    } catch (e) {
      out = `key[${i}] ${mask(key)} -> NETWORK ERROR ${e.message}`;
    }
    console.log('  ' + out);
  }
}

// Compass shape comparison on the worker's configured model: ?key= query param.
{
  const model = 'gemini-flash-lite-latest';
  console.log(`\n=== model: ${model} — COMPASS shape (?key= query param) ===`);
  for (let i = 0; i < Math.min(3, keys.length); i++) {
    const key = keys[i];
    const res = await fetch(`${BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const t = await res.text();
    let snippet = '';
    if (res.ok) {
      try { snippet = 'OK text=' + JSON.stringify((JSON.parse(t).candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').slice(0, 40)); }
      catch { snippet = 'OK'; }
    } else {
      try { const d = JSON.parse(t); snippet = (d.error && (d.error.status + ' | ' + String(d.error.message).slice(0, 160))) || t.slice(0, 160); }
      catch { snippet = t.slice(0, 160); }
    }
    console.log(`  key[${i}] ${mask(key)} -> HTTP ${res.status} | ${snippet}`);
  }
}
