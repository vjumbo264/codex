// Topic tree model on top of the repo. A topic = a directory under
// notebook/ containing index.md. Nesting is plain directories, so depth is
// unlimited. Node identity = slash-joined path below notebook/; '' = root.

import { getTree } from './github.js';
import { h8 as h8of } from './util.js';

const NB = 'notebook';

// All node paths in the notebook, sorted (root '' first).
export async function listNodePaths(env, fresh = false) {
  const tree = await getTree(env, fresh);
  const nodes = new Set();
  for (const e of tree) {
    if (e.type !== 'blob') continue;
    if (!e.path.startsWith(NB + '/')) continue;
    if (!e.path.endsWith('/index.md')) continue;
    const dir = e.path.slice(NB.length + 1, -('/index.md').length);
    // Every ancestor prefix of an index.md is also a node.
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) nodes.add(parts.slice(0, i).join('/'));
  }
  return ['', ...[...nodes].sort()];
}

// Nodes with their parent/children relationships.
export async function getNodes(env, fresh = false) {
  const paths = await listNodePaths(env, fresh);
  const byPath = new Map(paths.map(p => [p, { path: p, children: [] }]));
  for (const p of paths) {
    if (!p) continue;
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (byPath.has(parent)) byPath.get(parent).children.push(p);
  }
  for (const n of byPath.values()) n.children.sort();
  return byPath;
}

export async function nodeExists(env, path, fresh = false) {
  const paths = await listNodePaths(env, fresh);
  return paths.includes(path);
}

// Resolve an h8 handle back to a node path. Handles collisions by widening.
export async function resolveH8(env, handle, fresh = false) {
  if (handle === 'root') return '';
  const paths = await listNodePaths(env, fresh);
  const matches = [];
  for (const p of paths) {
    const h = await h8of(p);
    if (h === handle) matches.push(p);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Vanishingly unlikely; widen to 12 chars deterministically.
    for (const p of matches) {
      const h12 = (await h8of(p + '#w')).slice(0, 12);
      if (h12 === handle) return p;
    }
    return matches[0];
  }
  return null;
}

// Find a node path by human name (case-insensitive, exact then prefix),
// preferring exact matches anywhere in the tree. Returns path or null.
export async function findByName(env, name, fresh = false) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  const paths = await listNodePaths(env, fresh);
  const leaf = p => p.split('/').pop();
  const exact = paths.filter(p => p && leaf(p) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact.sort((a, b) => a.length - b.length)[0];
  const prefix = paths.filter(p => p && leaf(p).startsWith(target));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) return prefix.sort((a, b) => a.length - b.length)[0];
  return null;
}

// Resolve "a/b/c" where segments may be human names or slugs -> node path.
export async function resolvePath(env, pathish, fresh = false) {
  const segs = String(pathish || '').split('/').map(s => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  const nodes = await getNodes(env, fresh);
  let cur = '';
  for (const seg of segs) {
    const node = nodes.get(cur);
    if (!node) return null;
    const target = seg.toLowerCase();
    let next = node.children.find(c => c.split('/').pop() === target);
    if (!next) next = node.children.find(c => c.split('/').pop().startsWith(target));
    if (!next) return null;
    cur = next;
  }
  return cur;
}

// Unique child slug under parentPath for a title.
export async function uniqueChildSlug(env, parentPath, title, fresh = false) {
  const nodes = await getNodes(env, fresh);
  const parent = nodes.get(parentPath);
  const siblings = new Set(parent ? parent.children.map(c => c.split('/').pop()) : []);
  const { slugify } = await import('./util.js');
  const base = slugify(title);
  if (!siblings.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!siblings.has(cand)) return cand;
  }
}

// All asset (image) blob paths belonging to a node, for PDF/reading.
export async function listAssets(env, nodePath, fresh = false) {
  const tree = await getTree(env, fresh);
  const prefix = `${NB}/${nodePath}/assets/`;
  return tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix)).map(e => e.path);
}

// Every file under a node (index.md + assets + all descendants) — used by
// delete. Returns repo paths relative to repo root.
export async function filesUnderNode(env, nodePath, fresh = false) {
  const tree = await getTree(env, fresh);
  // v7 fix-03: nodePath '' (root) must match the whole notebook/ tree —
  // the old template produced the never-matching prefix 'notebook//'.
  const prefix = nodePath ? `${NB}/${nodePath}/` : `${NB}/`;
  return tree
    .filter(e => e.type === 'blob' && e.path.startsWith(prefix))
    .map(e => ({ path: e.path, sha: e.sha }));
}

export { NB };
