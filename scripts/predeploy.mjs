#!/usr/bin/env node
// Predeploy hook (runs in the GitHub Actions deploy workflow, before
// `wrangler deploy`). Owns Codex's Cloudflare resource provisioning so no
// dashboard access is ever needed. Idempotent — safe on every push.
//
// adapt-compass-pattern-d1-and-user-lock, Part 2: this script previously
// provisioned the CODEX_KV namespace; it now provisions the codex_db D1
// database instead (same idempotent approach: find-or-create via the
// Cloudflare API, stamp the real id into wrangler.toml), applies the
// migrations/ directory remotely, and copies the legacy KV key pool
// across EXACTLY ONCE (only when the D1 pool is still empty).
//
// Uses the same CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets as
// the wrangler-action step.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const PLACEHOLDER_DB_ID = '00000000-0000-0000-0000-000000000000';
const DB_NAME = 'codex_db';
const KV_TITLE = 'CODEX_KV'; // legacy migration source only — never created
const API = 'https://api.cloudflare.com/client/v4';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const tomlPath = process.argv[2] || 'wrangler.toml';

if (!token || !accountId) {
  console.error('predeploy: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set; skipping D1 provisioning.');
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

// Raw-text variant for KV value reads.
async function cfText(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloudflare API GET ${path} -> ${res.status}`);
  return res.text();
}

// Run one SQL statement (optionally parameterised) against the D1 database.
async function d1(dbId, sql, params = []) {
  const out = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, 'POST', { sql, params });
  return (out && out[0]) || { results: [] };
}

async function main() {
  const toml = readFileSync(tomlPath, 'utf8');
  const workerDir = dirname(tomlPath) || '.';

  // ---- 1. Find-or-create the D1 database --------------------------------
  const dbs = await cf(`/accounts/${accountId}/d1/database?per_page=100`);
  let db = (dbs || []).find(d => d.name === DB_NAME);
  if (!db) {
    console.log(`predeploy: creating D1 database "${DB_NAME}"…`);
    db = await cf(`/accounts/${accountId}/d1/database`, 'POST', { name: DB_NAME });
    console.log(`predeploy: created database id=${db.uuid}`);
  } else {
    console.log(`predeploy: D1 database "${DB_NAME}" exists, id=${db.uuid}`);
  }

  // Stamp the real id into wrangler.toml if needed.
  const bindingRe = /(\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*")([0-9a-f-]{36})(")/;
  const m = bindingRe.exec(toml);
  if (!m) {
    console.error('predeploy: CODEX_DB binding not found in wrangler.toml; leaving it unchanged.');
  } else if (m[2] !== db.uuid) {
    const updated = toml.replace(bindingRe, `$1${db.uuid}$3`);
    writeFileSync(tomlPath, updated);
    console.log(`predeploy: wrangler.toml updated with database_id=${db.uuid}${m[2] === PLACEHOLDER_DB_ID ? ' (was placeholder)' : ''}`);
  } else {
    console.log('predeploy: wrangler.toml already has the correct database_id.');
  }

  // ---- 2. Apply migrations remotely (Compass deploy.yml pattern) --------
  console.log('predeploy: applying D1 migrations (remote)…');
  const mig = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'], {
    cwd: workerDir,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (mig.status !== 0) {
    throw new Error(`predeploy: wrangler d1 migrations apply failed (exit ${mig.status})`);
  }

  // ---- 3. One-time KV -> D1 data migration of the Gemini key pool -------
  // Only when the D1 pool is still EMPTY and the legacy KV namespace has a
  // pool: preserves the operator's existing keys across the storage swap.
  const poolCount = await d1(db.uuid, 'SELECT COUNT(*) AS n FROM api_keys');
  const n = Number(poolCount.results && poolCount.results[0] && poolCount.results[0].n) || 0;
  if (n > 0) {
    console.log(`predeploy: D1 key pool already has ${n} key(s); KV migration not needed.`);
    return;
  }
  const namespaces = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const ns = (namespaces || []).find(x => x.title === KV_TITLE);
  if (!ns) {
    console.log('predeploy: no legacy KV namespace found; nothing to migrate.');
    return;
  }
  const rawKeys = await cfText(`/accounts/${accountId}/storage/kv/namespaces/${ns.id}/values/gemini:keys`);
  if (!rawKeys) {
    console.log('predeploy: legacy KV pool is empty; nothing to migrate.');
    return;
  }
  let keys = [];
  try { keys = JSON.parse(rawKeys); } catch { keys = []; }
  keys = Array.isArray(keys) ? keys.filter(k => typeof k === 'string' && k) : [];
  if (keys.length) {
    for (let i = 0; i < keys.length; i++) {
      await d1(db.uuid,
        'INSERT OR IGNORE INTO api_keys (key_value, position) VALUES (?1, ?2)',
        [keys[i], i]);
    }
    console.log(`predeploy: migrated ${keys.length} Gemini key(s) from KV to D1.`);
  }
  const lastOk = await cfText(`/accounts/${accountId}/storage/kv/namespaces/${ns.id}/values/gemini:last_ok_idx`);
  const migrated = await cfText(`/accounts/${accountId}/storage/kv/namespaces/${ns.id}/values/gemini:migrated`);
  const upsert = `INSERT INTO key_pool_state (key, value) VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  await d1(db.uuid, upsert, ['last_ok_idx', String(parseInt(lastOk || '0', 10) || 0)]);
  await d1(db.uuid, upsert, ['migrated', migrated ? '1' : '1']); // pool came from KV; never re-seed the legacy secret
  console.log('predeploy: key_pool_state (last_ok_idx, migrated) carried over.');
}

main().catch(e => {
  console.error(`predeploy failed: ${e.message}`);
  process.exit(1);
});
