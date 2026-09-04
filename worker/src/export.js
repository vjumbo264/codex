// Deterministic PDF export: mechanical render + document delivery. Used
// by both manual commands and button callbacks.
//
// Part 1 (adapt-compass-pattern): no interim "⏳ Gathering/Sending…"
// messages — callers fire the native upload_document chat action before
// invoking this and the delivered PDF document IS the reply. The
// statusMessageId parameter is retained for signature compatibility but
// every caller now passes null.

import { exportPdf, pdfFilename } from './pdf.js';
import { sendDocumentBytes, editText } from './telegram.js';

export async function doExport(env, chatId, nodePath, statusMessageId) {
  const status = async (t) => {
    if (statusMessageId) await editText(env, chatId, statusMessageId, t);
  };
  const bytes = await exportPdf(env, nodePath);
  const name = pdfFilename(nodePath);
  const sent = await sendDocumentBytes(env, chatId, bytes, name,
    nodePath ? `📄 Export: ${nodePath.split('/').join(' › ')}` : '📄 Export: whole notebook');
  await status(sent ? '✅ Done — PDF sent below.' : '❌ Failed to send the PDF.');
  return sent;
}
