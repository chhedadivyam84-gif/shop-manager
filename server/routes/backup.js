const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const backup = require("../backup");
const restoreFile = require("../restoreFile");
const db = require("../db");
const { logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

/** Current backup status for the Settings screen. */
router.get("/", (req, res) => {
  res.json(backup.status());
});

/** Run a backup right now (local + cloud if configured). */
router.post("/run", async (req, res) => {
  try {
    const result = await backup.runBackup("manual");
    logAction(req, "backup.run", result.cloud.ok ? "local+cloud" : "local");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Backup failed: " + err.message });
  }
});

/**
 * Stream a fresh, consistent snapshot as a download. Named after the shop and
 * timestamped so a phone's Downloads folder stays readable. The temp file is
 * deleted once the response finishes, whether it succeeded or the client
 * aborted mid-download.
 */
router.get("/download", (req, res) => {
  let tmpPath;
  try {
    tmpPath = backup.snapshotForDownload();
  } catch (err) {
    return res.status(500).json({ error: "Couldn't prepare backup: " + err.message });
  }

  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  const slug = (settings.business_name || "shop").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "shop";
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  const fname = `${slug}-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;

  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch (_) {} };
  res.download(tmpPath, fname, err => {
    cleanup();
    if (err && !res.headersSent) res.status(500).end();
  });
  logAction(req, "backup.download", fname);
});

/* ============================================================
   RESTORING A BACKUP FILE

   Two steps, deliberately. The first only LOOKS at the file and says what
   is in it beside what is here now; the second is the one that acts, and
   it cannot be reached without having seen the first. Replacing a shop's
   books is not something to do on one tap.

   Neither step touches the live database — see restoreFile.js for why the
   swap has to wait for the next start.
   ============================================================ */

/** Whatever is currently in this shop, in the same shape describe() returns,
 *  so the screen can put the two side by side. */
function describeLive() {
  const n = sql => { try { return db.prepare(sql).get().n; } catch (e) { return null; } };
  const one = sql => { try { return db.prepare(sql).get(); } catch (e) { return null; } };
  const s = one("SELECT business_name FROM settings WHERE id = 1") || {};
  return {
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
    lastInvoice: (one("SELECT challan_no AS v FROM invoices ORDER BY created_at DESC LIMIT 1") || {}).v || "",
  };
}

/** Turns the uploaded base64 into a temp file, or throws something readable. */
function writeTemp(fileB64) {
  if (typeof fileB64 !== "string" || !fileB64) throw new Error("No file was sent.");
  const comma = fileB64.indexOf(",");
  const b64 = fileB64.startsWith("data:") && comma > -1 ? fileB64.slice(comma + 1) : fileB64;
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("That file arrived empty.");
  const tmp = path.join(os.tmpdir(), `sm-restore-${Date.now()}-${process.pid}.db`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/** Look at a backup without touching anything. */
router.post("/restore/preview", requireRole("owner"), (req, res) => {
  let tmp;
  try {
    tmp = writeTemp(req.body && req.body.file);
    const incoming = restoreFile.describe(tmp);
    res.json({ incoming, current: describeLive(), filename: (req.body && req.body.filename) || "" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* temp file */ } }
  }
});

/**
 * Accept it. Parks the file and stops the process so it starts again with
 * the new database in place.
 *
 * The exit is the point, not a side effect: pm2 (and Render) restart the
 * app, and the swap happens in the pre-open window at boot. Answering
 * first, then exiting a moment later, so the screen is told what is about
 * to happen rather than losing the connection mid-request.
 */
router.post("/restore/apply", requireRole("owner"), (req, res) => {
  let tmp;
  try {
    tmp = writeTemp(req.body && req.body.file);
    const info = restoreFile.stagePending(tmp, {
      by: (req.session && req.session.staffName) || "",
      filename: (req.body && req.body.filename) || ""
    });
    tmp = null;                       // stagePending renamed it into place

    const c = info.counts || {};
    logAction(req, "backup.restore",
      `Restoring from ${(req.body && req.body.filename) || "an uploaded backup"} — ` +
      `${c.invoices} invoices, ${c.customers} customers, ${c.cash} cash entries`);

    res.json({
      ok: true, info,
      message: "The backup is ready. Shop Manager will restart in a moment and come back with it."
    });

    /* Long enough for the answer to reach the browser, short enough that
       nobody starts typing a bill into a database that is about to go. */
    setTimeout(() => process.exit(0), 1200);
  } catch (err) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* temp file */ } }
    res.status(400).json({ error: err.message });
  }
});

/** Is one waiting? Lets the screen say so after a restart that did not happen. */
router.get("/restore/pending", requireRole("owner"), (req, res) => {
  res.json({ pending: restoreFile.pending() });
});

router.post("/restore/cancel", requireRole("owner"), (req, res) => {
  const had = restoreFile.cancelPending();
  if (had) logAction(req, "backup.restore.cancel", "A waiting restore was cancelled");
  res.json({ ok: true, cancelled: had });
});

/* ------------------------------------------------------------
   THE CLOUD BUCKET, AND CLEARING IT

   Owner only. Deleting backups is not routine work, and on a host that wipes
   its own disk these copies are the only thing standing between a restart and
   an empty shop.
   ------------------------------------------------------------ */
router.get("/cloud", requireRole("owner"), async (req, res) => {
  try {
    res.json(await backup.listCloud());
  } catch (e) {
    res.status(502).json({ error: "Could not read the backup store: " + e.message });
  }
});

router.post("/cloud/delete", requireRole("owner"), async (req, res) => {
  const stamps = Array.isArray(req.body.stamps) ? req.body.stamps : [];
  if (!stamps.length) return res.status(400).json({ error: "Choose at least one backup." });
  try {
    const out = await backup.deleteCloudRuns(stamps);
    logAction(req, "backup.cloud.delete", `${out.deleted} backup(s)`);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Could not delete: " + e.message });
  }
});

module.exports = router;
