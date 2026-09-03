// Shared helpers: ids, dates, base64, hashing, text chunking.

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export function rand4() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += B36[b % 36];
  return s;
}

function pad(n) { return String(n).padStart(2, '0'); }

// Entry id: yyyymmdd-hhmmss-<rand4> (sortable, unique, deterministic target)
export function newEntryId(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${rand4()}`;
}

// Visible-but-subtle date line shown above each entry.
export function dateLine(d = new Date()) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `· ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function dateStampCompact(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// Topic title -> immutable directory slug: [a-z0-9-], max 48 chars.
export function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'topic';
}

export async function sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Node handle for callback_data (64-byte limit): sha1(path)[:8], 'root' for top level.
export async function h8(path) {
  if (!path) return 'root';
  return (await sha1hex(path)).slice(0, 8);
}

// Split long text for Telegram's 4096-char message cap (on paragraph/line breaks).
export function chunkText(text, max = 3800) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

// base64 helpers (Workers have atob/btoa but they are binary-string based).
export function b64encodeBytes(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64encodeText(str) {
  return b64encodeBytes(new TextEncoder().encode(str));
}

export function b64decodeToText(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function bytesToB64(bytes) { return b64encodeBytes(bytes); }

export function extFromMimeOrPath(mime, path) {
  const fromPath = path && /\.([a-z0-9]+)$/i.exec(path);
  if (fromPath) return fromPath[1].toLowerCase().replace('jpeg', 'jpg');
  const m = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  return m[mime] || 'jpg';
}
