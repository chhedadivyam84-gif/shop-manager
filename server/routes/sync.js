/* ============================================================
   DATA & SYNC

   Two sides of one feature, and they authenticate differently on purpose.

   Everything a person presses is owner-only, through the ordinary session.

   /receive is the exception: it is the other copy of this app talking, not
   a person, so it is authenticated by the sync key and NOT by a session.
   It is mounted outside requireAuth for that reason, and it is the single
   most dangerous route in this app — it accepts a database. So it refuses
   unless a key has been issued (off by default), compares that key in
   constant time, and hands the file to exactly the same checked path an
   uploaded backup takes: validated, the books it replaces kept, and the
   swap deferred to a restart.
   ============================================================ */
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../db");
const sync = require("../sync");
const restoreFile = require("../restoreFile");
const { logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();
const ownerOnly = requireRole("owner");

/* ------------------------------------------------------------------
   THE RECEIVING SIDE — this copy being written to
   ------------------------------------------------------------------ */

/** What this copy holds, for the sender to show before it pushes. */
router.get("/peek", (req, res) => {
  const allowed = sync.accepts(req.get("x-sync-key"));
  if (!allowed.ok) return res.status(403).json({ error: allowed.reason });
  const s = db.prepare("SELECT business_name FROM settings WHERE id = 1").get() || {};
  res.json({ businessName: s.business_name || "", counts: sync.localSummary() });
});

/**
 * Accept a pushed database.
 *
 * Nothing is swapped here — see restoreFile.js. The file is checked, the
 * books it would replace are kept, and it is parked for the restart that
 * follows. If any of that fails, this copy is left exactly as it was.
 */
router.post("/receive", (req, res) => {
  const allowed = sync.accepts(req.get("x-sync-key"));
  if (!allowed.ok) {
    sync.log({ direction: "receive", ok: false, error: allowed.reason,
               target: req.ip || "", summary: "refused" });
    return res.status(403).json({ error: allowed.reason });
  }

  const body = req.body || {};
  if (typeof body.file !== "string" || !body.file) {
    return res.status(400).json({ error: "No data arrived." });
  }

  /* What is about to be replaced, recorded before it is. */
  const replaced = { businessName: (db.prepare("SELECT business_name b FROM settings WHERE id = 1").get() || {}).b || "",
                     counts: sync.localSummary() };

  let tmp;
  try {
    const buf = Buffer.from(body.file, "base64");
    if (!buf.length) throw new Error("The data arrived empty.");
    tmp = path.join(os.tmpdir(), `sm-sync-${Date.now()}-${process.pid}.db`);
    fs.writeFileSync(tmp, buf);

    const info = restoreFile.stagePending(tmp, {
      by: "sync from " + (body.from || "the shop"),
      filename: body.filename || "sync.db"
    });
    tmp = null;                                  // renamed into place

    const c = info.counts || {};
    sync.log({ direction: "receive", ok: true, bytes: buf.length,
               target: String(body.from || ""),
               summary: `${c.invoices} invoices, ${c.challans} challans, ${c.customers} customers` });

    res.json({
      ok: true,
      received: info,
      replaced,
      message: "Received. This copy will restart and come back with it."
    });

    setTimeout(() => process.exit(0), 1200);
  } catch (err) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* temp */ } }
    sync.log({ direction: "receive", ok: false, error: err.message, target: String(body.from || "") });
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   THE SENDING SIDE — everything a person presses
   ------------------------------------------------------------------ */

router.get("/status", ownerOnly, async (req, res) => {
  res.json({ ...sync.status(), history: sync.history(20) });
});

/** Look at the cloud copy before pushing to it. */
router.get("/peek-cloud", ownerOnly, async (req, res) => {
  const r = await sync.askCloud("/api/sync/peek");
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ cloud: r.body, local: { counts: sync.localSummary() } });
});

router.put("/target", ownerOnly, (req, res) => {
  try {
    const out = sync.setTarget(req.body && req.body.url, req.body && req.body.key);
    /* The key itself is never logged, here or anywhere. */
    logAction(req, "sync.target", `Cloud address set to ${out.url || "(none)"}`);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/push", ownerOnly, async (req, res) => {
  const r = await sync.push({ staff: (req.session && req.session.staffName) || "" });
  if (!r.ok) {
    logAction(req, "sync.push.failed", r.error);
    return res.status(400).json({ error: r.error });
  }
  logAction(req, "sync.push", r.summary);
  res.json(r);
});

/* ------------------------------------------------------------------
   THE KEY
   ------------------------------------------------------------------ */

/** Issue one. Shown once, and only its hash is kept. */
router.post("/key", ownerOnly, (req, res) => {
  const key = sync.issueAcceptKey();
  logAction(req, "sync.key.issue", "A new sync key was issued");
  res.json({ key, note: "Copy this now — it is not shown again." });
});

router.delete("/key", ownerOnly, (req, res) => {
  sync.revokeAcceptKey();
  logAction(req, "sync.key.revoke", "The sync key was revoked");
  res.json({ ok: true });
});

module.exports = router;
