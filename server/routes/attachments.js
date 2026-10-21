const express = require("express");
const db = require("../db");
const { attachmentFilePath, restoreFromCloud } = require("../attachments");

const router = express.Router();

/* The records that can carry an attachment, in THIS business's own file. */
const OWNERS = ["payments", "purchase_payments", "bank_entries"];

/**
 * Whether the business this request is bound to actually holds a record
 * that names this file.
 *
 * The files themselves sit in one folder for the whole installation, so
 * on a copy serving many shops a file name alone says nothing about whose
 * receipt it is. Before this check the route served ANY file in that
 * folder to ANY signed-in user of ANY shop who had its name. The names are
 * random enough not to be guessed — but a name that has been seen (a
 * shared screenshot, a forwarded link) was all it took. Now a file is
 * served only to the business whose payment or bank entry it belongs to.
 */
function ownedHere(storedName) {
  for (const t of OWNERS) {
    try {
      if (db.prepare(`SELECT 1 FROM ${t} WHERE attachment_path = ? LIMIT 1`).get(storedName)) return true;
    } catch (e) { /* table not built on this copy */ }
  }
  return false;
}

// Auth only (no role check) — any logged-in staff can view a payment they
// can already see on a customer/supplier ledger.
router.get("/:filename", async (req, res) => {
  const name = req.params.filename;
  /* Whose it is, before anything else — including before asking the backup
     store for it — and the same answer either way, so asking does not
     reveal whether some other shop has a file by that name. */
  if (!ownedHere(name)) return res.status(404).json({ error: "Attachment not found." });
  /* On a host that wipes its disk the file may be gone while its backed-up
     copy is not; fetch it back rather than showing it as unavailable. */
  const full = attachmentFilePath(name) || await restoreFromCloud(name);
  if (!full) return res.status(404).json({ error: "Attachment not found." });
  res.sendFile(full);
});

module.exports = router;
