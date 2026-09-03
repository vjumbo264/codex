#!/usr/bin/env node
// Predeploy hook (runs in the GitHub Actions deploy workflow): makes sure
// the CODEX_KV namespace exists and that wrangler.toml carries its real id.
// Uses the same CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets as the
// wrangler-action step, so no new credentials and no dashboard access are
// ever needed. Idempotent — safe on every push.

import { readFileSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = '00000000000000000000000000000000';
const TITLE = 'CODEX_KV';
const API = 'https://api.cloudflare.com/client/v4';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const tomlPath = process.argv[2] || 'wrangler.toml';

if (!token || !accountId) {
  console.error('predeploy: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set; skipping KV provisioning.');
  process.exit(0);
}

async function cf(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`Cloudflare API ${method} ${path} -> ${res.status}: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  }
  return data.result;
}

async function main() {
  const toml = readFileSync(tomlPath, 'utf8');

  // Find an existing namespace by title.
  const namespaces = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  let ns = (namespaces || []).find(n => n.title === TITLE);

  if (!ns) {
    console.log(`predeploy: creating KV namespace "${TITLE}"…`);
    ns = await cf(`/accounts/${accountId}/storage/kv/namespaces`, 'POST', { title: TITLE });
    console.log(`predeploy: created namespace id=${ns.id}`);
  } else {
    console.log(`predeploy: KV namespace "${TITLE}" exists, id=${ns.id}`);
  }

  // Stamp the real id into wrangler.toml if needed.
  const bindingRe = /(\[\[kv_namespaces\]\]\s*\nbinding\s*=\s*"CODEX_KV"\s*\nid\s*=\s*")([0-9a-f]{32})(")/;
  const m = bindingRe.exec(toml);
  if (!m) {
    console.error('predeploy: CODEX_KV binding not found in wrangler.toml; leaving it unchanged.');
    return;
  }
  if (m[2] === ns.id) {
    console.log('predeploy: wrangler.toml already has the correct id.');
    return;
  }
  const updated = toml.replace(bindingRe, `$1${ns.id}$3`);
  writeFileSync(tomlPath, updated);
  console.log(`predeploy: wrangler.toml updated with id=${ns.id}`);

  // If we replaced the placeholder, also persist it back to the repo copy
  // so future deploys skip the API call (best-effort; the workflow may
  // commit this, but the id is not sensitive).
  if (m[2] === PLACEHOLDER) console.log('predeploy: (id was placeholder — now real)');
}

main().catch(e => {
  console.error(`predeploy failed: ${e.message}`);
  process.exit(1);
});
