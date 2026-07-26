/* ============================================================
   PAYMENT ATTACHMENTS (receipt / cheque photo / screenshot)
   ------------------------------------------------------------
   Sent from the browser as a base64 data URL inside the normal JSON
   payment-creation request — no multipart parsing, no new npm
   dependency, consistent with the rest of this app's zero-build
   philosophy. Stored under data/uploads/payments/<random-id>.<ext>;
   the DB only ever holds that filename, never a full path, so the
   data directory can be moved without breaking old links.

   NOT included in the daily DB snapshot (VACUUM INTO only captures
   SQL tables) — each attachment is best-effort mirrored to the same
   Supabase bucket the DB backup already uses, when configured, so a
   dead shop PC doesn't take receipt photos with it. There is no
   restore-on-boot for attachments (unlike shop.db): on an ephemeral
   host a wiped attachment shows as "unavailable" on its ledger entry
   rather than crashing anything, but existing local files on the
   shop's own PC are never touched.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");

const UPLOAD_DIR = path.join(db.dataDir, "uploads", "payments");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf"
};
const MAX_BYTES = 8 * 1024 * 1024; // 8MB decoded — a phone photo of a receipt/cheque, generously.

/**
 * `input` is { filename, mimeType, dataBase64 } from the client, or falsy.
 * Returns { path, name } (path = the stored filename only) or null when
 * there is nothing to save. Throws a plain Error with a user-facing message
 * on anything invalid, so routes can turn it straight into a 400.
 */
function saveAttachment(input) {
  if (!input || !input.dataBase64) return null;
  const ext = ALLOWED[input.mimeType];
  if (!ext) throw new Error("Attachment must be a JPEG, PNG, WEBP or PDF.");

  const buf = Buffer.from(input.dataBase64, "base64");
  if (buf.length === 0) throw new Error("Attachment file is empty.");
  if (buf.length > MAX_BYTES) throw new Error("Attachment is too large (max 8MB).");

  const storedName = crypto.randomBytes(8).toString("hex") + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);

  // Best-effort — a failed/absent cloud config must never block saving the
  // payment itself, so this deliberately doesn't await inline in a way that
  // could throw past this point.
  try {
    const backup = require("./backup");
    if (backup.cloudConfig().enabled) {
      backup.uploadToCloud(path.join(UPLOAD_DIR, storedName), "uploads/" + storedName).catch(() => {});
    }
  } catch (_) { /* best effort only */ }

  return { path: storedName, name: (input.filename || storedName).slice(0, 200) };
}

function attachmentFilePath(storedName) {
  // Reject anything that isn't a bare filename this module generated —
  // storedName comes from a DB column that ultimately traces back to a
  // client request, so treat it as untrusted input against path traversal.
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName.includes("..")) return null;
  const full = path.join(UPLOAD_DIR, storedName);
  return fs.existsSync(full) ? full : null;
}

module.exports = { saveAttachment, attachmentFilePath, UPLOAD_DIR };
