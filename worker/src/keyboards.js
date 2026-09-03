// Inline keyboard builders. callback_data = "<op>:<h8>" or "<op>:<h8>:<arg>".

import { h8 } from './util.js';

export function btn(text, data) { return { text, callback_data: data }; }

// One consistent app pattern (fix-03): every screen ends with a Home
// button so the operator can always get back to the top by tapping.

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
    rows.push([btn('⬆️ Up', `b:${backTo === '' ? 'root' : await h8(backTo)}`), btn('🏠 Home', 'h:root')]);
  } else {
    rows.push([btn('🏠 Home', 'h:root')]);
  }
  return rows;
}

export function confirmDeleteKeyboard(handle, label) {
  return [
    [btn(`✅ Yes, delete ${label}`, `D:${handle}`), btn('❌ Cancel', 'c:0')],
    [btn('🏠 Home', 'h:root')],
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
  rows.push([btn('❌ Cancel', 'c:0'), btn('🏠 Home', 'h:root')]);
  return rows;
}

export function paginationKeyboard(handle, page, hasMore) {
  const row = [];
  if (page > 0) row.push(btn('◀️ Prev', `r:${handle}:${page - 1}`));
  if (hasMore) row.push(btn('Next ▶️', `r:${handle}:${page + 1}`));
  const rows = row.length ? [row] : [];
  rows.push([btn('🗂 Browse this topic', `b:${handle}`), btn('🏠 Home', 'h:root')]);
  return rows;
}
