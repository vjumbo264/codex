// Part 2 investigation step 1: locate the live CODEX_KV namespace and read
// the real key pool + rotation cursor. NEVER prints full keys — masked only.
const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
if (!account || !token) { console.error('need CF_ACCOUNT_ID, CF_API_TOKEN'); process.exit(2); }

const mask = (k) => (typeof k === 'string' && k.length > 4 ? `…${k.slice(-4)} (len ${k.length})` : String(k));

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces?per_page=100`,
  { headers: { Authorization: `Bearer ${token}` } });
const data = await res.json();
if (!res.ok) { console.error('list namespaces failed', res.status, JSON.stringify(data).slice(0, 300)); process.exit(1); }
console.log('namespaces:');
for (const ns of data.result || []) console.log(`  ${ns.id}  ${ns.title}`);

const nsEntry = (data.result || []).find(n => /codex/i.test(n.title));
if (!nsEntry) { console.error('no codex namespace found'); process.exit(1); }
const ns = nsEntry.id;
console.log(`using namespace "${nsEntry.title}"`);

async function kvGet(key) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`kv get ${key} -> ${r.status}`);
  return r.text();
}

const raw = await kvGet('gemini:keys');
console.log('gemini:keys present:', raw !== null);
let keys = [];
try { keys = JSON.parse(raw || '[]'); } catch { console.log('gemini:keys NOT valid JSON!'); }
console.log(`pool size: ${keys.length}`);
keys.forEach((k, i) => console.log(`  [${i}] ${mask(k)}${/\s/.test(k) ? '  <-- CONTAINS WHITESPACE' : ''}`));

console.log('gemini:last_ok_idx =', await kvGet('gemini:last_ok_idx'));
console.log('gemini:migrated =', await kvGet('gemini:migrated'));

// Duplicate detection
const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dupes.length) console.log('DUPLICATE keys in pool:', dupes.map(mask));
console.log('NS=' + ns);
