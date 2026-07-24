/* ============================================================
   FACTORY RESET — wipe all shop data
   ------------------------------------------------------------
   This is the single most destructive endpoint in the app, so it is
   deliberately harder to reach than every other route:

     1. Owner role only (requireRole enforces this on every request).
     2. The owner's PIN must be re-entered and verified AGAIN, right
        here, even though they're already logged in — a phone left
        unlocked on the counter is not the same as someone who can
        type the owner's PIN.
     3. A typed confirmation phrase, checked server-side (never trust
        a client-side "are you sure?" alone for something this final).
     4. A full backup is taken automatically, BEFORE anything is
        touched, using the exact same code path as a normal daily
        backup — so even a correctly-authorised wipe leaves a way back.

   What is wiped vs kept is a deliberate choice, not "everything":
   wiping the `staff` table would lock every login out until someone
   restarts the server process (the auto-seed that creates a fresh
   Owner/1234 account only runs at server startup, not on every
   request) — so staff accounts and the shop's business-profile
   settings survive a reset. "Wipe all shop data" means the shop's
   operational records: products, customers, invoices, purchases,
   payments, print jobs, and the activity log.
   ============================================================ */
const express = require("express");
const db = require("../db");
const fs = require("fs");
const path = require("path");
const { verifyPin, requireRole } = require("../auth");
const { logAction } = require("../util");
const backup = require("../backup");

const router = express.Router();

const CONFIRM_PHRASE = "DELETE ALL DATA";
// Survives the wipe (it's a plain file, not a DB row) so there is always a
// record of who reset the shop and when, even though audit_log itself —
// like everything else transactional — gets wiped along with the rest.
const RESET_LOG_PATH = path.join(__dirname, "..", "..", "data", "reset-log.txt");

const WIPE_TABLES = [
  // Children first — always safe regardless of the FK cascade settings on
  // any given table, so this order can't produce a foreign-key violation.
  "invoice_items", "payments", "product_sizes", "stock_ins", "print_jobs",
  "invoices", "customers", "products", "counters", "audit_log"
];

router.post("/", requireRole("owner"), async (req, res) => {
  const { pin, confirmText } = req.body;

  const staff = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.session.staffId);
  if (!staff || !pin || !verifyPin(String(pin), staff.pin_hash)) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }
  if (String(confirmText || "").trim() !== CONFIRM_PHRASE) {
    return res.status(400).json({ error: `Type "${CONFIRM_PHRASE}" exactly to confirm.` });
  }

  let backupResult;
  try {
    backupResult = await backup.runBackup("pre-reset");
  } catch (err) {
    // If we can't even confirm a safety-net backup succeeded, refuse to
    // proceed — a reset with no fallback is not a risk worth taking here.
    return res.status(500).json({ error: "Could not take a safety backup before resetting, so nothing was touched: " + err.message });
  }

  db.transaction(() => {
    WIPE_TABLES.forEach(t => db.exec(`DELETE FROM ${t}`));
  })();

  const logLine = `${new Date().toISOString()} | reset by ${staff.name} (${staff.id}) | pre-reset backup: ${backupResult.file}\n`;
  try { fs.appendFileSync(RESET_LOG_PATH, logLine); } catch (_) { /* best effort — the backup itself is the real safety net */ }

  // Not logAction(): audit_log was just wiped along with everything else,
  // so writing to it here would just recreate the one row this reset left.
  console.log(`[reset] Shop data wiped by ${staff.name}. Backup: ${backupResult.file}`);

  res.json({ ok: true, backupFile: backupResult.file });
});

module.exports = router;
