// GitHub-as-database: the repo IS the notebook store.
// Reads of file content use the Contents API (repo is public, but we send
// the token anyway for rate limits); writes use the same API with the
// fine-grained GITHUB_REPO_TOKEN secret. The recursive git tree is cached
// briefly in isolate memory to keep browsing cheap.

import { b64decodeToText, b64encodeText, b64encodeBytes } from './util.js';

const API = 'https://api.github.com';

function base(env) {
  return `/repos/${env.REPO_OWNER}/${env.REPO_NAME}`;
}

async function gh(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_REPO_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codex-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- file contents -------------------------------------------------------

// Returns { text, sha } or null when missing.
export async function getFile(env, repoPath) {
  const data = await gh(env, 'GET',
    `${base(env)}/contents/${repoPath}?ref=${env.REPO_BRANCH}`);
  if (!data) return null;
  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`not a file: ${repoPath}`);
  }
  return { text: b64decodeToText(data.content), sha: data.sha };
}

// Create or update a text file. sha = current sha for updates, null for creates.
export async function putFile(env, repoPath, text, sha, message) {
  const body = {
    message,
    content: b64encodeText(text),
    branch: env.REPO_BRANCH,
  };
  if (sha) body.sha = sha;
  const out = await gh(env, 'PUT', `${base(env)}/contents/${repoPath}`, body);
  invalidateTreeCache();
  return out;
}

// Create or update a binary file from Uint8Array.
export async function putBinaryFile(env, repoPath, bytes, sha, message) {
  const body = {
    message,
    content: b64encodeBytes(bytes),
    branch: env.REPO_BRANCH,
  };
  if (sha) body.sha = sha;
  const out = await gh(env, 'PUT', `${base(env)}/contents/${repoPath}`, body);
  invalidateTreeCache();
  return out;
}

export async function deleteFile(env, repoPath, sha, message) {
  const out = await gh(env, 'DELETE', `${base(env)}/contents/${repoPath}`, {
    message, sha, branch: env.REPO_BRANCH,
  });
  invalidateTreeCache();
  return out;
}

// ---- tree ----------------------------------------------------------------

let treeCache = { at: 0, tree: null };
const TREE_TTL_MS = 20000;

export function invalidateTreeCache() {
  treeCache = { at: 0, tree: null };
}

// Recursive tree entries: [{ path, type: 'blob'|'tree', sha }]
export async function getTree(env, fresh = false) {
  if (!fresh && treeCache.tree && Date.now() - treeCache.at < TREE_TTL_MS) {
    return treeCache.tree;
  }
  const data = await gh(env, 'GET',
    `${base(env)}/git/trees/${env.REPO_BRANCH}?recursive=1`);
  if (!data) return [];
  const tree = (data.tree || []).map(e => ({ path: e.path, type: e.type, sha: e.sha }));
  treeCache = { at: Date.now(), tree };
  return tree;
}

// Raw bytes URL for a repo path (repo is public -> no credential needed).
export function rawUrl(env, repoPath) {
  return `https://raw.githubusercontent.com/${env.REPO_OWNER}/${env.REPO_NAME}/${env.REPO_BRANCH}/${repoPath}`;
}
