// Mechanical Markdown-tree -> PDF renderer (pdf-lib). No AI involvement.
// Layout: title page, then depth-first walk of the node subtree. Each node
// renders its title (size by depth), then entries (small italic gray date,
// word-wrapped body, images embedded inline at their position), then its
// children recursively.

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fontRegular from '../fonts/DejaVuSans.ttf';
import fontBold from '../fonts/DejaVuSans-Bold.ttf';
import { readNode, parseIndex } from './notes.js';
import { getNodes } from './tree.js';
import { rawUrl } from './github.js';

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

const C_TEXT = rgb(0.12, 0.12, 0.12);
const C_DATE = rgb(0.45, 0.45, 0.45);
const C_RULE = rgb(0.8, 0.8, 0.8);

function depthOf(path) { return path ? path.split('/').length : 0; }

function headingSize(depth) {
  return Math.max(20 - (depth - 1) * 2, 12);
}

class Writer {
  constructor(doc, font, fontBoldF) {
    this.doc = doc;
    this.font = font;
    this.bold = fontBoldF;
    this.page = doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  ensure(space) {
    if (this.y - space < MARGIN) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.y = PAGE_H - MARGIN;
    }
  }
  text(str, { size = 11, font = null, color = C_TEXT, indent = 0 } = {}) {
    const f = font || this.font;
    const words = String(str).split(/\s+/).filter(Boolean);
    let line = '';
    const lineH = size * 1.45;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > CONTENT_W - indent && line) {
        this.ensure(lineH);
        this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font: f, color });
        this.y -= lineH;
        line = w;
      } else {
        line = test;
      }
    }
    if (line) {
      this.ensure(lineH);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font: f, color });
      this.y -= lineH;
    }
  }
  gap(h) { this.ensure(h); this.y -= h; }
  rule() {
    this.ensure(14);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.5, color: C_RULE,
    });
    this.y -= 14;
  }
  image(img, imgW, imgH, caption) {
    const scale = Math.min(1, CONTENT_W / imgW, 380 / imgH);
    const w = imgW * scale, h = imgH * scale;
    this.ensure(h + 16);
    this.y -= 4;
    this.page.drawImage(img, { x: MARGIN, y: this.y - h, width: w, height: h });
    this.y -= h + 4;
    if (caption) this.text(caption, { size: 9, color: C_DATE });
  }
}

// Minimal inline markdown cleanup for PDF: bold/italic/code markers stripped
// to plain text (bold runs rendered in bold font when the whole line is bold).
function mdPlain(s) {
  return String(s)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

async function renderEntry(env, w, entry, nodePath) {
  if (entry.date) w.text(entry.date, { size: 9, color: C_DATE });
  const lines = entry.body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine;
    const imgMatch = /^!\[([^\]]*)\]\(assets\/([^)]+)\)\s*$/.exec(line.trim());
    if (imgMatch) {
      const alt = imgMatch[1], fname = imgMatch[2];
      try {
        const url = rawUrl(env, `notebook/${nodePath}/assets/${fname}`);
        const res = await fetch(url);
        if (res.ok) {
          const bytes = await res.arrayBuffer();
          let img = null;
          if (/\.png$/i.test(fname)) img = await w.doc.embedPng(bytes);
          else img = await w.doc.embedJpg(bytes);
          w.image(img, img.width, img.height, alt || null);
        } else {
          w.text(`[image: ${fname}]`, { size: 9, color: C_DATE, indent: 8 });
        }
      } catch (e) {
        console.error('pdf image embed failed', fname, e);
        w.text(`[image: ${fname}]`, { size: 9, color: C_DATE, indent: 8 });
      }
      continue;
    }
    const bullet = /^(\s*)[-*•] /.exec(line);
    if (bullet) {
      w.text('• ' + mdPlain(line.trim().slice(2)), { size: 11, indent: 10 + bullet[1].length * 2 });
    } else if (/^\s*#{1,6} /.test(line)) {
      w.text(mdPlain(line.replace(/^\s*#{1,6} /, '')), { size: 13, font: w.bold });
    } else if (/^(\*\*|__).*(\*\*|__)$/.test(line.trim()) && line.trim().length > 4) {
      w.text(mdPlain(line), { size: 11, font: w.bold });
    } else if (line.trim() === '') {
      w.gap(5);
    } else {
      w.text(mdPlain(line), { size: 11 });
    }
  }
  w.rule();
}

async function renderNode(env, doc, w, nodePath, nodes) {
  const node = await readNode(env, nodePath);
  if (!node) return;
  const depth = depthOf(nodePath);
  w.gap(depth > 1 ? 10 : 4);
  w.text(node.title || nodePath, { size: headingSize(depth), font: w.bold });
  w.gap(2);
  for (const entry of node.entries) {
    await renderEntry(env, w, entry, nodePath);
    w.gap(2);
  }
  const rec = nodes.get(nodePath);
  for (const child of (rec ? rec.children : [])) {
    await renderNode(env, doc, w, child, nodes);
  }
}

// Export one node (with all descendants). nodePath '' = whole notebook.
export async function exportPdf(env, nodePath) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit); // required for embedFont(custom TTF) — without it every export threw FontkitNotRegisteredError (fix-01 v5)
  const font = await doc.embedFont(fontRegular, { subset: true });
  const bold = await doc.embedFont(fontBold, { subset: true });

  // Title page
  const w = new Writer(doc, font, bold);
  const title = nodePath
    ? (await readNode(env, nodePath))?.title || nodePath
    : 'Codex — Notebook';
  w.gap(220);
  const tSize = 30;
  const tWidth = bold.widthOfTextAtSize(title, tSize);
  w.page.drawText(title, {
    x: Math.max(MARGIN, (PAGE_W - tWidth) / 2), y: w.y - tSize, size: tSize, font: bold, color: C_TEXT,
  });
  w.y -= tSize + 24;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const sWidth = font.widthOfTextAtSize(stamp, 11);
  w.page.drawText(stamp, { x: (PAGE_W - sWidth) / 2, y: w.y, size: 11, font, color: C_DATE });

  const nodes = await getNodes(env, true);
  if (nodePath === '') {
    // Whole notebook: every top-level topic, depth-first.
    const root = nodes.get('');
    for (const child of (root ? root.children : [])) {
      w.page = doc.addPage([PAGE_W, PAGE_H]);
      w.y = PAGE_H - MARGIN;
      await renderNode(env, doc, w, child, nodes);
    }
  } else {
    w.page = doc.addPage([PAGE_W, PAGE_H]);
    w.y = PAGE_H - MARGIN;
    await renderNode(env, doc, w, nodePath, nodes);
  }

  return doc.save();
}

export function pdfFilename(nodePath) {
  const slug = nodePath ? nodePath.split('/').pop() : 'full';
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `codex-${slug}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.pdf`;
}

export { parseIndex };
