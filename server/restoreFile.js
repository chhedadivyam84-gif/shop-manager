/* ============================================================
   RESTORING A BACKUP FILE

   The app could always hand you a backup and never take one back. That
   was survivable while the shop PC and the hosted copy were both just
   running; it stops being survivable the moment one of them becomes the
   master and the other holds the real books.

   THE SWAP HAPPENS AT BOOT, BEFORE ANYTHING OPENS THE DATABASE.

   That is the whole design. A running process holds shop.db open, and
   SQLite keeps recent writes in a -wal file beside it; replacing the .db
   underneath a live handle leaves the old -wal pointing into a file that
   no longer exists, and what comes back afterwards is neither the old
   book nor the new one. So an upload does not swap anything. It parks
   the file and asks the process to stop; pm2 starts it again, and the
   swap happens here, in the same pre-open window restore.js already uses,
   when nothing has either file open.

   AND THE OLD DATABASE IS KEPT. Every restore snapshots what it is about
   to replace into data/backups first, so a restore is itself undoable.
   Nothing in this file ever deletes a book.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
                                      : path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PENDING = path.join(DATA_DIR, "pending-restore.db");
const MARKER = path.join(DATA_DIR, "pending-restore.json");

/* The tables a file must have before this app will call it one of its own.
   Not the full schema — a backup from an older version legitimately has
   fewer tables, and refusing it would make the feature useless exactly
   when it is needed. These five are the ones that have existed since the
   beginning and whose absence means "this is some other database". */
const CORE_TABLES = ["settings", "staff", "products", "customers", "invoices"];

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Is this file a Shop Manager database, and what is in it?
 *
 * Opened READ-ONLY and never written to. Throws with something a
 * shopkeeper can act on rather than a SQLite error string.
 */
function describe(filePath) {
  const st = fs.statSync(filePath);
  if (st.size < 512) throw new Error("That file is too small to be a backup.");

  /* Every SQLite file begins with this. Checked before opening so a PDF
     or a zip is refused by name rather than by a parser error. */
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString("utf8", 0, 15) !== "SQLite format 3") {
    throw new Error("That is not a Shop Manager backup — it is not a database file.");
  }

  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const tables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const missing = CORE_TABLES.filter(t => !tables.has(t));
    if (missing.length) {
      throw new Error("That database is not a Shop Manager backup — it has no " +
        missing.join(", ") + " table" + (missing.length > 1 ? "s" : "") + ".");
    }

    const n = sql => { try { return db.prepare(sql).get().n; } catch (e) { return null; } };
    const one = sql => { try { return db.prepare(sql).get(); } catch (e) { return null; } };
    const s = one("SELECT business_name FROM settings WHERE id = 1") || {};

    return {
      sizeBytes: st.size,
      businessName: s.business_name || "",
      counts: {
        invoices:  n("SELECT COUNT(*) n FROM invoices WHERE doc_type='invoice'"),
        challans:  n("SELECT COUNT(*) n FROM invoices WHERE doc_type='challan'"),
        purchases: n("SELECT COUNT(*) n FROM purchases"),
        customers: n("SELECT COUNT(*) n FROM customers"),
        suppliers: n("SELECT COUNT(*) n FROM suppliers"),
        products:  n("SELECT COUNT(*) n FROM products"),
        cash:      n("SELECT COUNT(*) n FROM cash_entries WHERE voided = 0"),
        staff:     n("SELECT COUNT(*) n FROM staff"),
      },
      /* The last document it issued, which is the single most useful line
         for telling two copies of the same shop apart. */
      lastInvoice: (one("SELECT challan_no AS v FROM invoices ORDER BY created_at DESC LIMIT 1") || {}).v || "",
      lastEntryAt: (one("SELECT MAX(created_at) AS v FROM invoices") || {}).v || null,
    };
  } finally {
    db.close();
  }
}

/** Park an uploaded file for the next boot to swap in. Nothing is replaced. */
function stagePending(tmpPath, meta) {
  const info = describe(tmpPath);              // throws if it is not ours
  if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
  fs.renameSync(tmpPath, PENDING);
  fs.writeFileSync(MARKER, JSON.stringify({
    at: Date.now(), by: (meta && meta.by) || "", filename: (meta && meta.filename) || "",
    info
  }, null, 2));
  return info;
}

function pending() {
  if (!fs.existsSync(PENDING) || !fs.existsSync(MARKER)) return null;
  try { return JSON.parse(fs.readFileSync(MARKER, "utf8")); } catch (e) { return { at: 0 }; }
}

function cancelPending() {
  let had = false;
  for (const f of [PENDING, MARKER]) if (fs.existsSync(f)) { fs.unlinkSync(f); had = true; }
  return had;
}

/**
 * Called at boot, before the database module opens anything.
 *
 * Swaps a parked file into place, having first snapshotted whatever is
 * there now. Returns a line for the log either way; never throws, because
 * a shop that cannot start is worse than a restore that did not happen.
 */
function applyPendingRestore() {
  const marker = pending();
  if (!marker) return { restored: false, reason: "nothing waiting to be restored" };

  const live = path.join(DATA_DIR, "shop.db");
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    /* KEEP WHAT IS BEING REPLACED. A plain copy, not VACUUM INTO: this
       runs before the database module exists, and copying the .db with
       its -wal and -shm beside it preserves exactly what was there —
       including writes still sitting in the log. */
    let kept = null;
    if (fs.existsSync(live)) {
      kept = path.join(BACKUP_DIR, `before-restore-${stamp()}.db`);
      for (const ext of ["", "-wal", "-shm"]) {
        if (fs.existsSync(live + ext)) fs.copyFileSync(live + ext, kept + ext);
      }
    }

    /* The old log and shared-memory file describe the OLD database. Left
       in place they would be replayed over the new one. */
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(live + ext)) fs.unlinkSync(live + ext);
    }
    if (fs.existsSync(live)) fs.unlinkSync(live);
    fs.renameSync(PENDING, live);
    fs.unlinkSync(MARKER);

    return { restored: true, kept: kept ? path.basename(kept) : null, info: marker.info || null };
  } catch (err) {
    /* Leave the marker alone so the attempt is visible and repeatable
       rather than silently dropped. */
    return { restored: false, reason: "could not swap the file: " + err.message, failed: true };
  }
}

module.exports = { describe, stagePending, pending, cancelPending, applyPendingRestore, PENDING, MARKER };
