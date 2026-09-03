// Note entry operations: create nodes, append/edit/delete entries, delete
// whole nodes, and the read model (parse index.md into structured entries).
// All writes commit to the repo — git history is the versioning.

import { getFile, putFile, deleteFile, putBinaryFile, rawUrl } from './github.js';
import { NB, nodeExists, uniqueChildSlug, filesUnderNode } from './tree.js';
import { newEntryId, dateLine, b64encodeBytes } from './util.js';

function indexPath(nodePath) {
  return nodePath ? `${NB}/${nodePath}/index.md` : `${NB}/index.md`;
}

// ---- parsing -------------------------------------------------------------

// Parse an index.md into { title, entries: [{ id, date, body }] }.
export function parseIndex(text) {
  const lines = String(text || '').split('\n');
  let title = null;
  const entries = [];
  let i = 0;
  if (lines[0] && lines[0].startsWith('# ')) { title = lines[0].slice(2).trim(); i = 1; }
  const ID_RE = /^<!-- e:([0-9a-z-]+) -->$/;
  const DATE_RE = /^_(\d{4}-\d{2}-\d{2} · \d{2}:\d{2} UTC)_$/;
  while (i < lines.length) {
    const idm = ID_RE.exec(lines[i].trim());
    if (!idm) { i++; continue; }
    const id = idm[1];
    i++;
    let date = '';
    if (i < lines.length) {
      const dm = DATE_RE.exec(lines[i].trim());
      if (dm) { date = dm[1]; i++; }
    }
    // body = lines until separator '---' (blank lines around it trimmed)
    const bodyLines = [];
    while (i < lines.length && lines[i].trim() !== '---') { bodyLines.push(lines[i]); i++; }
    if (i < lines.length && lines[i].trim() === '---') i++; // consume separator
    const body = bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
    entries.push({ id, date, body });
  }
  return { title, entries };
}

// Serialize back to the canonical index.md text.
export function serializeIndex(title, entries) {
  let out = `# ${title}\n`;
  for (const e of entries) {
    out += `\n<!-- e:${e.id} -->\n_${e.date}_\n\n${e.body}\n\n---\n`;
  }
  return out;
}

// ---- node operations -----------------------------------------------------

export async function readNode(env, nodePath) {
  const f = await getFile(env, indexPath(nodePath));
  if (!f) return null;
  const parsed = parseIndex(f.text);
  return { ...parsed, sha: f.sha, raw: f.text };
}

// Create a node (topic) with an empty index.md. Returns final path.
export async function createNode(env, parentPath, title) {
  const slug = await uniqueChildSlug(env, parentPath, title);
  const path = parentPath ? `${parentPath}/${slug}` : slug;
  const text = `# ${title}\n`;
  await putFile(env, indexPath(path), text, null, `codex: new topic "${title}" (${path || '/'})`);
  return { path, title };
}

// Ensure a node exists (create with given title if missing). Returns {path, created}.
export async function ensureNode(env, parentPath, title) {
  const { resolvePath } = await import('./tree.js');
  const want = parentPath ? `${parentPath}/${title}` : title;
  const existing = await resolvePath(env, want);
  if (existing !== null) return { path: existing, created: false };
  const made = await createNode(env, parentPath, title);
  return { path: made.path, created: true };
}

// Append an entry to a node. body = markdown text (may include image embeds
// already rewritten to relative assets/ paths). Returns the entry id.
export async function appendEntry(env, nodePath, body) {
  const node = await readNode(env, nodePath);
  if (!node) throw new Error(`node not found: ${nodePath}`);
  const id = newEntryId();
  const entry = { id, date: dateLine(), body };
  const entries = [...node.entries, entry];
  await putFile(env, indexPath(nodePath), serializeIndex(node.title, entries), node.sha,
    `codex: add entry ${id} to ${nodePath}`);
  return id;
}

// Replace the body of one entry (used by edit and by move flows).
export async function updateEntry(env, nodePath, entryId, newBody) {
  const node = await readNode(env, nodePath);
  if (!node) throw new Error(`node not found: ${nodePath}`);
  const idx = node.entries.findIndex(e => e.id === entryId);
  if (idx < 0) throw new Error(`entry not found: ${entryId}`);
  node.entries[idx].body = newBody;
  await putFile(env, indexPath(nodePath), serializeIndex(node.title, node.entries), node.sha,
    `codex: edit entry ${entryId} in ${nodePath}`);
  return true;
}

// Delete one entry from a node.
export async function deleteEntry(env, nodePath, entryId) {
  const node = await readNode(env, nodePath);
  if (!node) throw new Error(`node not found: ${nodePath}`);
  const entries = node.entries.filter(e => e.id !== entryId);
  if (entries.length === node.entries.length) throw new Error(`entry not found: ${entryId}`);
  await putFile(env, indexPath(nodePath), serializeIndex(node.title, entries), node.sha,
    `codex: delete entry ${entryId} from ${nodePath}`);
  return true;
}

// Delete a node and everything nested under it (index.md, assets, all
// descendants). Also prunes now-empty parent dirs implicitly (git tracks
// files only). Returns count of files removed.
export async function deleteNodeTree(env, nodePath) {
  const files = await filesUnderNode(env, nodePath, true);
  for (const f of files) {
    await deleteFile(env, f.path, f.sha, `codex: delete ${f.path} (node ${nodePath})`);
  }
  return files.length;
}

// Save image bytes under a node's assets/ and return the relative ref.
export async function storeImage(env, nodePath, bytes, ext) {
  const fname = `${newEntryId()}.${ext}`;
  const repoPath = `${NB}/${nodePath}/assets/${fname}`;
  await putBinaryFile(env, repoPath, bytes, null, `codex: add image ${fname} to ${nodePath}`);
  return { rel: `assets/${fname}`, repoPath, url: rawUrl(env, repoPath) };
}

// Move an entry (with its image refs) from one node to another: copies the
// entry body, rewrites image refs to the target's assets, moves the files.
export async function moveEntry(env, fromPath, entryId, toPath) {
  const src = await readNode(env, fromPath);
  if (!src) throw new Error('source node missing');
  const entry = src.entries.find(e => e.id === entryId);
  if (!entry) throw new Error('entry not found');
  // Rewrite image refs: copy each referenced asset into the target node.
  const refs = [...entry.body.matchAll(/!\[[^\]]*\]\(assets\/([^)]+)\)/g)].map(m => m[1]);
  let body = entry.body;
  for (const fname of refs) {
    const srcRepo = `${NB}/${fromPath}/assets/${fname}`;
    const f = await getFile(env, srcRepo);
    if (f) {
      // fetch raw bytes via raw url (public repo)
      const res = await fetch(rawUrl(env, srcRepo));
      const buf = new Uint8Array(await res.arrayBuffer());
      const dst = await storeImage(env, toPath, buf, fname.split('.').pop());
      body = body.replace(`assets/${fname}`, dst.rel);
      await deleteFile(env, srcRepo, f.sha, `codex: move image ${fname} ${fromPath} -> ${toPath}`);
    }
  }
  await appendEntry(env, toPath, body);
  await deleteEntry(env, fromPath, entryId);
  return true;
}

export { indexPath };
