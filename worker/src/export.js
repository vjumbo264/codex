// Deterministic PDF export: mechanical render, status message updates,
// document delivery. Used by both manual commands and button callbacks.

import { exportPdf, pdfFilename } from './pdf.js';
import { sendDocumentBytes, editText } from './telegram.js';

export async function doExport(env, chatId, nodePath, statusMessageId) {
  const status = async (t) => {
    if (statusMessageId) await editText(env, chatId, statusMessageId, t);
  };
  await status('⏳ Gathering notes…');
  const bytes = await exportPdf(env, nodePath);
  await status('⏳ Sending PDF…');
  const name = pdfFilename(nodePath);
  const sent = await sendDocumentBytes(env, chatId, bytes, name,
    nodePath ? `📄 Export: ${nodePath.split('/').join(' › ')}` : '📄 Export: whole notebook');
  await status(sent ? '✅ Done — PDF sent below.' : '❌ Failed to send the PDF.');
  return sent;
}
