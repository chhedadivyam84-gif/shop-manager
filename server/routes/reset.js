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
/* A different phrase for the smaller job, so muscle memory cannot run one
   while meaning the other. */
const CONFIRM_BILLS = "DELETE ALL BILLS";
// Survives the wipe (it's a plain file, not a DB row) so there is always a
// record of who reset the shop and when, even though audit_log itself —
// like everything else transactional — gets wiped along with the rest.
const RESET_LOG_PATH = path.join(__dirname, "..", "..", "data", "reset-log.txt");

/* EVERY TRANSACTIONAL DOCUMENT. Children first — always safe regardless of
   the FK cascade settings on any given table, so this order cannot produce a
   foreign-key violation.

   This list used to be badly incomplete. It named invoices but NOT purchases,
   so a "wipe all shop data" left every purchase bill standing while deleting
   the suppliers those bills pointed at — a worse state than not resetting at
   all. Returns, quotations, orders, deliveries and dispatches were missing
   too: eleven document tables survived a full reset, measured on a real
   database. */
const DOC_TABLES = [
  /* children */
  "invoice_items", "purchase_items", "purchase_order_items", "quotation_items",
  "sales_order_items", "sales_return_items", "purchase_return_items",
  "delivery_items", "delivery_status_log",
  "dispatch_items", "dispatch_drops", "dispatch_status_log",
  "payments", "purchase_payments", "print_jobs",
  /* parents */
  "invoices", "purchases", "purchase_orders", "quotations", "sales_orders",
  "sales_returns", "purchase_returns", "deliveries", "dispatches", "stock_ins",
  /* Queued Tally work now points at documents that no longer exist. This does
     NOT remove anything already posted INTO Tally — a voucher in Tally is
     Tally's own record, and this app never reaches back into it. */
  "tally_queue"
];

/* BILLS ONLY: the documents go, the shop stays. Products, stock levels,
   customers, suppliers, staff, settings, bank accounts and the numbering
   counters all survive — "clear the old bills and start from today" is not
   the same request as "set this shop up from scratch". */
const BILL_TABLES = DOC_TABLES;

/* EVERYTHING: the documents above, plus the masters. */
const WIPE_TABLES = [
  ...DOC_TABLES,
  "product_sizes", "customers", "suppliers", "products", "counters", "audit_log"
];

router.post("/", requireRole("owner"), async (req, res) => {
  const { pin, confirmText } = req.body;

  /* WHICH JOB. Defaults to the full wipe, so anything already calling this
     endpoint behaves exactly as it did before. */
  const billsOnly = req.body.scope === "bills";
  const tables = billsOnly ? BILL_TABLES : WIPE_TABLES;
  const phrase = billsOnly ? CONFIRM_BILLS : CONFIRM_PHRASE;

  const staff = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.session.staffId);
  if (!staff || !pin || !verifyPin(String(pin), staff.pin_hash)) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }
  if (String(confirmText || "").trim() !== phrase) {
    return res.status(400).json({ error: `Type "${phrase}" exactly to confirm.` });
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
    /* A table this build does not have is skipped rather than fatal — an
       older database that never grew dispatches must still be resettable. */
    tables.forEach(t => {
      const exists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      if (exists) db.exec(`DELETE FROM ${t}`);
    });

    /* THE DUES HAVE TO GO WITH THE BILLS.
       A customer's balance is a running total the bills built up. Delete the
       bills and leave the total, and the shop opens tomorrow being told a
       customer owes money for a bill that no longer exists — and no way to
       find out why. Only on the bills-only path; the full wipe removes the
       parties themselves. */
    if (billsOnly) {
      db.exec("UPDATE customers SET due = 0");
      db.exec("UPDATE suppliers SET due = 0");
    }
  })();

  const logLine = `${new Date().toISOString()} | ${billsOnly ? "bills cleared" : "reset"} by ${staff.name} (${staff.id}) | pre-reset backup: ${backupResult.file}\n`;
  try { fs.appendFileSync(RESET_LOG_PATH, logLine); } catch (_) { /* best effort — the backup itself is the real safety net */ }

  /* The bills-only path KEEPS audit_log, so the clearing can be recorded in
     it like any other action. The full wipe cannot: audit_log went with
     everything else, and writing here would recreate the one row it left. */
  if (billsOnly) {
    try {
      logAction(req, "reset.bills",
        `All bills, challans, returns, orders and deliveries cleared — backup: ${backupResult.file}`);
    } catch (_) { /* the backup is the real safety net */ }
  }
  console.log(`[reset] ${billsOnly ? "Bills cleared" : "Shop data wiped"} by ${staff.name}. Backup: ${backupResult.file}`);

  res.json({ ok: true, scope: billsOnly ? "bills" : "all", backupFile: backupResult.file });
});

module.exports = router;
