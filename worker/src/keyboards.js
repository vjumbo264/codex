// Inline keyboard builders. callback_data = "<op>:<h8>" or "<op>:<h8>:<arg>".

import { h8 } from './util.js';

export function btn(text, data) { return { text, callback_data: data }; }

// One consistent app pattern (fix-03): every screen ends with a Home
// button so the operator can always get back to the top by tapping.

// Browse keyboard for a node: one button per child, then action rows.
// fix-03 v3: every topic gets a tap-only "Add note here" entry point, and
// the root gets "New topic" — no command syntax ever required.
export async function browseKeyboard(nodePath, children, { backTo } = {}) {
  const rows = [];
  for (const child of children) {
    const name = child.split('/').pop();
    rows.push([btn(`📁 ${name}`, `b:${await h8(child)}`)]);
  }
  if (nodePath) {
    rows.push([btn('➕ Add note here', `an:${await h8(nodePath)}`)]);
    const actions = [];
    actions.push(btn('📖 Read', `r:${await h8(nodePath)}:0`));
    actions.push(btn('📄 Export PDF', `x:${await h8(nodePath)}`));
    actions.push(btn('🗑 Delete', `d:${await h8(nodePath)}`));
    rows.push(actions);
  } else {
    rows.push([btn('➕ New topic', 'nt:root')]);
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

// Read-view keyboard. fix-03 v3: every entry on the page gets tap-only
// Edit / Delete buttons (identified by the entry id's last 4 chars, the
// same suffix shown next to each entry in the read text), so entries found
// while reading can be edited/deleted without typing any command.
export function paginationKeyboard(handle, page, hasMore, entryIds = []) {
  const rows = [];
  for (const id of entryIds.slice(0, 10)) {
    rows.push([
      btn(`✏️ Edit …${id.slice(-4)}`, `e:${handle}:${id}`),
      btn(`🗑 Delete …${id.slice(-4)}`, `d:${handle}:${id}`),
    ]);
  }
  const row = [];
  if (page > 0) row.push(btn('◀️ Prev', `r:${handle}:${page - 1}`));
  if (hasMore) row.push(btn('Next ▶️', `r:${handle}:${page + 1}`));
  if (row.length) rows.push(row);
  rows.push([btn('🗂 Browse this topic', `b:${handle}`), btn('🏠 Home', 'h:root')]);
  return rows;
}
