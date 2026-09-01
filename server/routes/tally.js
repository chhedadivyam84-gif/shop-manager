/* ============================================================
   TALLY SYNC — the API

   Owner only, all of it. Configuring where a shop's books get written,
   and which documents go there, is not a counter job.

   ONE DIRECTION, ENFORCED HERE TOO. There is no route in this file that
   reads a value out of Tally and writes it into Shop Manager. The only
   thing that comes back from Tally is a company list, a voucher number and
   an error message — and none of those touches a bill, a customer or a
   product. If a route to import from Tally is ever wanted, it would have
   to be written deliberately; nothing here can be persuaded into it.

   THE BROWSER CANNOT TOUCH A SYNC ID. Every route works on documents and
   queue rows the server looks up itself. A sync id is derived from the
   document, never accepted from a request — otherwise a browser could aim
   one bill's voucher at another bill.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
const { requireRole } = require("../auth");
const svc = require("../tally/service");
const proc = require("../tally/processor");
const connector = require("../tally/connector");
const autosync = require("../tally/autosync");
const backfill = require("../tally/backfill");

const router = express.Router();

/* Everything below is the owner's. Applied once, here, rather than
   remembered on each route — the one that gets forgotten is the one that
   matters. */
router.use(requireRole("owner"));

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function publicSettings() {
  const s = svc.settings();
  let ledgers = {};
  try { ledgers = JSON.parse(s.ledgers || "{}") || {}; } catch (e) { ledgers = {}; }
  return {
    host: s.host, port: s.port, company: s.company,
    enabled: !!s.enabled, autoSync: !!s.auto_sync, autoMode: s.auto_mode,
    modules: s.modulesObj, ledgers: { ...proc.ledgerNames(), ...ledgers },
    syncPakka: !!s.sync_pakka, syncKachha: !!s.sync_kachha,
    lastOkAt: s.last_ok_at || null, lastFailAt: s.last_fail_at || null,
    lastError: s.last_error || "",
    docTypes: Object.entries(svc.DOC_TYPES).map(([k, v]) => ({
      key: k, label: v.label, voucher: v.voucher, module: v.module,
      /* Honest about what is wired. A switch that turns on a document the
         processor cannot build would look like a bug in Tally. */
      ready: !!proc.LOADERS[k]
    }))
  };
}

router.get("/settings", (req, res) => res.json(publicSettings()));

router.put("/settings", (req, res) => {
  const b = req.body || {};
  const cur = svc.settings();

  const host = b.host === undefined ? cur.host : String(b.host).trim() || "localhost";
  const port = b.port === undefined ? cur.port
    : Math.max(1, Math.min(65535, Number(b.port) || 9000));
  const company = b.company === undefined ? cur.company : String(b.company).trim();

  /* Modules are replaced wholesale, not merged: a switch turned OFF has to
     actually go off, and a merge would leave it on forever. */
  let modules = cur.modulesObj;
  if (b.modules && typeof b.modules === "object") {
    modules = {};
    Object.keys(svc.DOC_TYPES).forEach(k => {
      const m = svc.DOC_TYPES[k].module;
      if (b.modules[m]) modules[m] = true;
    });
  }
  let ledgers = {};
  try { ledgers = JSON.parse(cur.ledgers || "{}") || {}; } catch (e) {}
  if (b.ledgers && typeof b.ledgers === "object") {
    Object.keys(proc.ledgerNames()).forEach(k => {
      if (typeof b.ledgers[k] === "string" && b.ledgers[k].trim()) {
        ledgers[k] = b.ledgers[k].trim();
      }
    });
  }

  db.prepare(`
    UPDATE tally_settings SET host=?, port=?, company=?, enabled=?, auto_sync=?,
      auto_mode=?, modules=?, ledgers=?, sync_pakka=?, sync_kachha=? WHERE id=1
  `).run(host, port, company,
    b.enabled === undefined ? cur.enabled : (b.enabled ? 1 : 0),
    b.autoSync === undefined ? cur.auto_sync : (b.autoSync ? 1 : 0),
    ["immediate", "1m", "5m", "15m", "manual"].includes(b.autoMode) ? b.autoMode : cur.auto_mode,
    JSON.stringify(modules), JSON.stringify(ledgers),
    b.syncPakka === undefined ? cur.sync_pakka : (b.syncPakka ? 1 : 0),
    /* Kachha stays a deliberate act. Sending an estimate to Tally books a
       sale that was never made. */
    b.syncKachha === undefined ? cur.sync_kachha : (b.syncKachha ? 1 : 0));

  logAction(req, "tally.settings", host + ":" + port + " / " + (company || "no company"));
  /* Take effect now. Without this, switching auto-sync off leaves the old
     timer running until the next restart — and switching it on does
     nothing until then, which reads as the setting being ignored. */
  autosync.reschedule();
  res.json(publicSettings());
});

/* ------------------------------------------------------------------ */
/* connection                                                          */
/* ------------------------------------------------------------------ */

/** Reaching the port proves nothing; this asks Tally for its companies. */
router.post("/test", async (req, res) => {
  const b = req.body || {};
  const cur = svc.settings();
  const probe = {
    host: (b.host || cur.host || "localhost").trim(),
    port: Number(b.port || cur.port) || 9000,
    company: b.company === undefined ? cur.company : String(b.company).trim()
  };
  const r = await connector.testConnection(probe);
  svc.log({ action: "test", status: r.ok ? "SUCCESS" : "FAILED",
            staff: (req.session && req.session.staffName) || "",
            message: r.ok ? (r.message || "connected") : r.error });
  res.json(r);
});

/* ------------------------------------------------------------------ */
/* the dashboard                                                       */
/* ------------------------------------------------------------------ */

router.get("/dashboard", async (req, res) => {
  const s = svc.settings();
  const out = { settings: publicSettings(), counts: svc.counts(),
                autoSync: autosync.status(), connection: null };
  /* Only when it is switched on. Probing a Tally nobody has configured
     makes every dashboard load wait fifteen seconds for a timeout. */
  if (s.enabled && s.host) {
    out.connection = await connector.testConnection(s);
  }
  res.json(out);
});

/* ------------------------------------------------------------------ */
/* the queue                                                           */
/* ------------------------------------------------------------------ */

/**
 * WHAT IS SITTING THERE, UNQUEUED.
 *
 * Asked before any backfill runs, so the owner sees the size of the thing
 * — "412 sales invoices" — and decides, rather than starting something
 * open-ended against live books.
 */
router.get("/backfill", requireRole("owner"), (req, res) => {
  try {
    res.json({ counts: backfill.survey({ from: req.query.from, to: req.query.to }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Put documents that already exist into the queue.
 *
 * Owner only, and it only ENQUEUES — nothing is sent, so this cannot post
 * anything by surprise and cannot hang on Tally being closed. Sending
 * stays a separate, deliberate press of Sync.
 *
 * Safe to run twice: enqueue() recognises a document it has already seen
 * rather than duplicating it.
 */
router.post("/backfill", requireRole("owner"), (req, res) => {
  const types = Array.isArray(req.body && req.body.docTypes) ? req.body.docTypes : null;
  try {
    const r = backfill.run(types, { from: req.body && req.body.from, to: req.body && req.body.to });
    if (r.error) return res.status(400).json(r);
    logAction(req, "tally.backfill",
      Object.entries(r).map(([k, v]) => k + ": " + v.queued + "/" + v.found).join(", "));
    res.json({ result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/queue", (req, res) => {
  const q = req.query || {};
  const where = [], params = [];
  if (q.status) { where.push("status = ?"); params.push(q.status); }
  if (q.docType) { where.push("doc_type = ?"); params.push(q.docType); }
  if (q.from) { where.push("doc_date >= ?"); params.push(q.from); }
  if (q.to) { where.push("doc_date <= ?"); params.push(q.to); }
  if (q.search) {
    where.push("(doc_no LIKE ? OR sync_id LIKE ? OR voucher_no LIKE ?)");
    const like = "%" + q.search + "%";
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT * FROM tally_queue ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY queued_at DESC LIMIT 500
  `).all(...params);
  res.json({ rows, counts: svc.counts() });
});

/**
 * Send. Nothing here takes a sync id from the browser as a target to
 * invent — the ids are matched against rows that already exist, so a
 * request can only ask for work that was already queued by the server.
 */
router.post("/sync", async (req, res) => {
  const b = req.body || {};
  const s = svc.settings();
  if (!s.enabled) return res.status(400).json({ error: "Tally sync is switched off." });
  if (!s.company) return res.status(400).json({ error: "Choose a Tally company first." });

  let syncIds = null;
  if (Array.isArray(b.syncIds) && b.syncIds.length) {
    const found = db.prepare(
      "SELECT sync_id FROM tally_queue WHERE sync_id IN (" +
      b.syncIds.map(() => "?").join(",") + ")"
    ).all(...b.syncIds.map(String)).map(r => r.sync_id);
    syncIds = found;
    if (!syncIds.length) return res.status(400).json({ error: "None of those are in the queue." });
  }

  const r = await proc.runQueue({
    syncIds, limit: b.limit,
    staff: (req.session && req.session.staffName) || ""
  });
  logAction(req, "tally.sync", `${r.ok} ok, ${r.failed} failed of ${r.attempted}`);
  res.json({ ...r, counts: svc.counts() });
});

/* ------------------------------------------------------------------ */
/* mappings                                                            */
/* ------------------------------------------------------------------ */

router.get("/map/:kind", (req, res) => {
  const kind = req.params.kind;
  if (!["ledger", "stockitem", "group", "unit"].includes(kind)) {
    return res.status(400).json({ error: "Unknown mapping type." });
  }
  const maps = db.prepare("SELECT * FROM tally_map WHERE kind = ?").all(kind);
  const byLocal = new Map(maps.map(m => [m.local_id, m]));

  /* Every record that COULD be mapped, with its mapping if it has one, so
     one screen shows both what is done and what is left. */
  let records = [];
  if (kind === "ledger") {
    records = [
      ...db.prepare("SELECT id, name, 'customer' AS side FROM customers ORDER BY name").all(),
      ...db.prepare("SELECT id, name, 'supplier' AS side FROM suppliers ORDER BY name").all()
    ];
  } else if (kind === "stockitem") {
    records = db.prepare("SELECT id, name, category, brand FROM products ORDER BY name").all();
  }
  res.json(records.map(r => {
    const m = byLocal.get(r.id);
    return { ...r, tallyName: m ? m.tally_name : "", action: m ? m.action : "" };
  }));
});

router.put("/map/:kind/:localId", (req, res) => {
  const kind = req.params.kind;
  if (!["ledger", "stockitem", "group", "unit"].includes(kind)) {
    return res.status(400).json({ error: "Unknown mapping type." });
  }
  const b = req.body || {};
  const action = ["map", "create", "ignore"].includes(b.action) ? b.action : "map";
  const tallyName = String(b.tallyName || "").trim();
  if (action !== "ignore" && !tallyName) {
    return res.status(400).json({ error: "Give the name it has in Tally." });
  }
  const existing = db.prepare("SELECT id FROM tally_map WHERE kind=? AND local_id=?")
                     .get(kind, req.params.localId);
  if (existing) {
    db.prepare("UPDATE tally_map SET tally_name=?, action=?, local_name=? WHERE id=?")
      .run(tallyName, action, String(b.localName || "").slice(0, 200), existing.id);
  } else {
    db.prepare(`
      INSERT INTO tally_map (id, kind, local_id, local_name, tally_name, action, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uid("TMAP"), kind, req.params.localId,
           String(b.localName || "").slice(0, 200), tallyName, action, Date.now());
  }
  logAction(req, "tally.map", kind + " / " + (tallyName || "ignored"));
  res.json(db.prepare("SELECT * FROM tally_map WHERE kind=? AND local_id=?")
             .get(kind, req.params.localId));
});

/* ------------------------------------------------------------------ */
/* the audit log                                                       */
/* ------------------------------------------------------------------ */

/* Readable, never deletable. There is deliberately no DELETE route: a sync
   history that can be tidied up is not a history. */
router.get("/log", (req, res) => {
  const q = req.query || {};
  const where = [], params = [];
  if (q.syncId) { where.push("sync_id = ?"); params.push(q.syncId); }
  if (q.status) { where.push("status = ?"); params.push(q.status); }
  const rows = db.prepare(`
    SELECT * FROM tally_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY at DESC LIMIT 500
  `).all(...params);
  res.json({ rows });
});

module.exports = router;
