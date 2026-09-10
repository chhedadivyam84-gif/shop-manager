/* Attachments (payment receipts, scanned bills) are written to disk on
   Render. Workers have no disk, so these belong in R2 — which is built and
   working for backups but not yet wired for uploads.

   This throws rather than returning a fake path. A route that "saves" an
   attachment and hands back a path nothing can read is a bug discovered
   months later, when somebody needs the receipt. */
const UPLOAD_DIR = "/r2/attachments";

function saveAttachment() {
  throw new Error("Attachments are not available on this deployment yet (R2 upload is not wired).");
}
function attachmentFilePath() {
  throw new Error("Attachments are not available on this deployment yet (R2 upload is not wired).");
}

module.exports = { saveAttachment, attachmentFilePath, UPLOAD_DIR };
