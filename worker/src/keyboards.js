// Inline keyboard builders. callback_data = "<op>:<h8>" or "<op>:<h8>:<arg>".

import { h8 } from './util.js';

function btn(text, data) { return { text, callback_data: data }; }

// Browse keyboard for a node: one button per child, then an action row.
export async function browseKeyboard(nodePath, children, { backTo } = {}) {
  const rows = [];
  for (const child of children) {
    const name = child.split('/').pop();
    rows.push([btn(`📁 ${name}`, `b:${await h8(child)}`)]);
  }
  const actions = [];
  if (nodePath) {
    actions.push(btn('📖 Read', `r:${await h8(nodePath)}:0`));
    actions.push(btn('📄 Export PDF', `x:${await h8(nodePath)}`));
    actions.push(btn('🗑 Delete', `d:${await h8(nodePath)}`));
    rows.push(actions);
  } else {
    rows.push([btn('📄 Export whole notebook', 'X:root')]);
  }
  if (backTo !== undefined && backTo !== null) {
    rows.push([btn('⬆️ Up', `b:${backTo === '' ? 'root' : await h8(backTo)}`)]);
  }
  return rows;
}

export function confirmDeleteKeyboard(handle, label) {
  return [
    [btn(`✅ Yes, delete ${label}`, `D:${handle}`), btn('❌ Cancel', 'c:0')],
  ];
}

export function cancelKeyboard() {
  return [[btn('❌ Cancel', 'c:0')]];
}

// Quick actions shown after an auto-filed note.
export async function filedActionsKeyboard(nodePath, entryId) {
  const h = await h8(nodePath);
  return [
    [btn('👀 View', `v:${h}:${entryId}`), btn('🔀 Move', `m:${h}:${entryId}`), btn('✨ New topic', `n:${h}:${entryId}`)],
  ];
}

// Move-flow: pick a target node (top-level + their children, 2 cols).
export async function moveTargetKeyboard(entryH, entryId, nodePaths) {
  const rows = [];
  const top = nodePaths.filter(p => p && !p.includes('/'));
  for (const p of top) {
    rows.push([btn(`📁 ${p}`, `mt:${entryH}:${entryId}:${await h8(p)}`)]);
  }
  rows.push([btn('❌ Cancel', 'c:0')]);
  return rows;
}

export function paginationKeyboard(handle, page, hasMore) {
  const row = [];
  if (page > 0) row.push(btn('◀️ Prev', `r:${handle}:${page - 1}`));
  if (hasMore) row.push(btn('Next ▶️', `r:${handle}:${page + 1}`));
  return row.length ? [row] : [];
}
