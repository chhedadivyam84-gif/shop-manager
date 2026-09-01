/* ============================================================
   DOCUMENT NUMBERING — settings, history, and the next number

   Owner-only for everything that CHANGES a series. Numbering is the one
   setting where a careless edit produces duplicate numbers on filed
   documents, which is an accounting problem rather than an inconvenience,
   so staff can read it and only an owner can move it.

   The rules themselves live in server/docNumber.js; this is the door to
   them.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { logAction } = require("../util");
const { requireRole } = require("../auth");
const docNumber = require("../docNumber");

const router = express.Router();

/* The label a shop knows each series by. Kept here rather than in the
   engine because it is presentation — the engine only cares about keys. */
const LABELS = {
  invoice: "Sales Invoice",
  challan: "Delivery Challan",
  quotation: "Quotation / Proforma",
  purchase: "Purchase Invoice"
};

/** Every series, with where it stands and what it will issue next. */
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM doc_numbering ORDER BY doc_type").all();
  res.json(rows.map(r => {
    let nextNumber = null, highest = null;
    try { nextNumber = docNumber.peek(r.doc_type); } catch (e) { /* type not in the engine's registry */ }
    try { highest = docNumber.highestLiveNumber(r.doc_type); } catch (e) { /* same */ }
    return {
      docType: r.doc_type,
      label: LABELS[r.doc_type] || r.doc_type,
      prefix: r.prefix,
      width: r.width,
      nextValue: r.next_number,
      nextNumber,
      highestInUse: highest,
      autoEnabled: r.auto_enabled === 1,
      updatedAt: r.updated_at
    };
  }));
});

/** What the New-Bill screen shows before saving. Peeks without consuming,
 *  so an abandoned form never burns a number. */
/**
 * Numbers that were genuinely deleted and are free to be used again.
 *
 * Owner only. Which numbers a shop has thrown away is not counter
 * information, and reusing one is an owner decision by design.
 */
router.get("/:docType/deleted", requireRole("owner"), (req, res) => {
  try {
    res.json({ rows: docNumber.deletedNumbers(req.params.docType, 200) });
  } catch (e) {
    res.status(404).json({ error: "Unknown document type." });
  }
});

router.get("/:docType/next", (req, res) => {
  try {
    const cfg = docNumber.config(req.params.docType);
    res.json({
      docType: req.params.docType,
      autoEnabled: cfg.auto_enabled === 1,
      nextNumber: docNumber.peek(req.params.docType)
    });
  } catch (e) {
    res.status(404).json({ error: "Unknown document type." });
  }
});

/** Is a number the operator typed free to use? Asked as they type, so the
 *  clash is caught before they fill in the whole bill. */
router.get("/:docType/check", (req, res) => {
  const problem = docNumber.validateManual(req.params.docType, req.query.number, req.query.excludeId);
  res.json({ ok: !problem, error: problem });
});

/**
 * Change a series: prefix, width, where it continues from, auto on/off.
 *
 * The counter is never allowed BELOW a number already on a live document.
 * Letting it go back would hand the next bill a number that is already on
 * a filed one — the duplicate this whole module exists to prevent.
 */
router.put("/:docType", requireRole("owner"), (req, res) => {
  let cfg;
  try { cfg = docNumber.config(req.params.docType); }
  catch (e) { return res.status(404).json({ error: "Unknown document type." }); }

  const before = { prefix: cfg.prefix, width: cfg.width, next: cfg.next_number, auto: cfg.auto_enabled };

  const prefix = req.body.prefix === undefined ? cfg.prefix : String(req.body.prefix).trim().toUpperCase();
  if (prefix.length > 10) return res.status(400).json({ error: "Prefix can be at most 10 characters." });
  if (/\d/.test(prefix)) return res.status(400).json({ error: "Prefix cannot contain digits — they would run into the number." });

  const width = req.body.width === undefined ? cfg.width : parseInt(req.body.width, 10);
  if (!Number.isFinite(width) || width < 1 || width > 12) {
    return res.status(400).json({ error: "Number width must be between 1 and 12 digits." });
  }

  let nextNumber = req.body.nextNumber === undefined ? cfg.next_number : parseInt(req.body.nextNumber, 10);
  if (!Number.isFinite(nextNumber) || nextNumber < 1) {
    return res.status(400).json({ error: "The next number must be 1 or more." });
  }

  const autoEnabled = req.body.autoEnabled === undefined ? cfg.auto_enabled : (req.body.autoEnabled ? 1 : 0);

  // Guard against going backwards over live documents — but only while the
  // FORMAT is unchanged. Changing the prefix starts a new sequence, where
  // the old numbers are not comparable.
  if (prefix === cfg.prefix && width === cfg.width) {
    const highest = docNumber.highestLiveNumber(req.params.docType);
    if (highest !== null && nextNumber <= highest) {
      return res.status(400).json({
        error: `${docNumber.format({ prefix, width }, highest)} is already on a document. `
             + `The next number must be at least ${docNumber.format({ prefix, width }, highest + 1)}.`
      });
    }
  }

  db.prepare(`
    UPDATE doc_numbering SET prefix = ?, width = ?, next_number = ?, auto_enabled = ?, updated_at = ?
    WHERE doc_type = ?
  `).run(prefix, width, nextNumber, autoEnabled, Date.now(), req.params.docType);

  const changes = [];
  if (before.prefix !== prefix) changes.push(`prefix ${before.prefix} to ${prefix}`);
  if (before.width !== width) changes.push(`width ${before.width} to ${width}`);
  if (before.next !== nextNumber) changes.push(`next number ${before.next} to ${nextNumber}`);
  if (before.auto !== autoEnabled) changes.push(`auto numbering ${autoEnabled ? "on" : "off"}`);

  if (changes.length) {
    docNumber.logNumber(req, {
      docType: req.params.docType, action: "settings",
      previousNumber: docNumber.format({ prefix: before.prefix, width: before.width }, before.next),
      newNumber: docNumber.format({ prefix, width }, nextNumber),
      detail: changes.join(", ")
    });
    logAction(req, "numbering.update", `${LABELS[req.params.docType] || req.params.docType}: ${changes.join(", ")}`);
  }

  res.json(db.prepare("SELECT * FROM doc_numbering WHERE doc_type = ?").get(req.params.docType));
});

/* ------------------------------------------------------------------ */
/* per-financial-year starting numbers                                 */
/* ------------------------------------------------------------------ */

router.get("/fy-starts/all", (req, res) => {
  res.json(db.prepare(
    "SELECT * FROM doc_number_fy_start ORDER BY fy_label DESC, doc_type"
  ).all());
});

/**
 * Set where a series restarts in a given financial year.
 *
 * Stored, not applied. Applying it the moment it is typed would renumber
 * mid-year; it takes effect when that year begins, via /apply below. That
 * separation is deliberate: an owner planning next year's numbering in
 * February should not disturb February's bills.
 */
router.put("/fy-starts/:docType/:fyLabel", requireRole("owner"), (req, res) => {
  try { docNumber.config(req.params.docType); }
  catch (e) { return res.status(404).json({ error: "Unknown document type." }); }

  const start = parseInt(req.body.startNumber, 10);
  if (!Number.isFinite(start) || start < 1) {
    return res.status(400).json({ error: "The starting number must be 1 or more." });
  }
  const fy = db.prepare("SELECT label FROM financial_years WHERE label = ?").get(req.params.fyLabel);
  if (!fy) return res.status(400).json({ error: "That financial year does not exist yet." });

  db.prepare(`
    INSERT INTO doc_number_fy_start (doc_type, fy_label, start_number, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(doc_type, fy_label) DO UPDATE SET start_number = excluded.start_number
  `).run(req.params.docType, req.params.fyLabel, start, Date.now());

  docNumber.logNumber(req, {
    docType: req.params.docType, action: "fy-start",
    newNumber: String(start),
    detail: `${req.params.fyLabel} will start at ${start}`
  });
  logAction(req, "numbering.fyStart",
    `${LABELS[req.params.docType] || req.params.docType} ${req.params.fyLabel} starts at ${start}`);
  res.json({ ok: true });
});

/**
 * Put a year's planned starting numbers into effect.
 *
 * Separate from setting them, and owner-only, because this is the moment
 * the series actually jumps. Refuses to go backwards over live documents
 * for the same reason the settings route does.
 */
router.post("/fy-starts/:fyLabel/apply", requireRole("owner"), (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM doc_number_fy_start WHERE fy_label = ?"
  ).all(req.params.fyLabel);
  if (!rows.length) return res.status(400).json({ error: "No starting numbers are set for that year." });

  const applied = [], refused = [];
  for (const row of rows) {
    let cfg;
    try { cfg = docNumber.config(row.doc_type); } catch (e) { continue; }
    const highest = docNumber.highestLiveNumber(row.doc_type);
    if (highest !== null && row.start_number <= highest) {
      refused.push(`${LABELS[row.doc_type] || row.doc_type}: ${row.start_number} is at or below ${docNumber.format(cfg, highest)}, which is already issued`);
      continue;
    }
    db.prepare("UPDATE doc_numbering SET next_number = ?, updated_at = ? WHERE doc_type = ?")
      .run(row.start_number, Date.now(), row.doc_type);
    db.prepare("UPDATE doc_number_fy_start SET applied_at = ? WHERE doc_type = ? AND fy_label = ?")
      .run(Date.now(), row.doc_type, row.fy_label);
    docNumber.logNumber(req, {
      docType: row.doc_type, action: "fy-apply",
      previousNumber: docNumber.format(cfg, cfg.next_number),
      newNumber: docNumber.format(cfg, row.start_number),
      detail: `${row.fy_label} starting number applied`
    });
    applied.push(`${LABELS[row.doc_type] || row.doc_type} now starts at ${docNumber.format(cfg, row.start_number)}`);
  }
  logAction(req, "numbering.fyApply", `${req.params.fyLabel}: ${applied.length} applied, ${refused.length} refused`);
  res.json({ applied, refused });
});

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

/** Who moved which number, when, and from what to what. Readable by any
 *  staff member — seeing the trail is not the same as being able to
 *  change it, and hiding it helps nobody. */
router.get("/history/all", (req, res) => {
  const where = [], params = [];
  if (req.query.docType) { where.push("doc_type = ?"); params.push(req.query.docType); }
  if (req.query.action)  { where.push("action = ?");   params.push(req.query.action); }
  const rows = db.prepare(`
    SELECT * FROM doc_number_log
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY at DESC LIMIT 300
  `).all(...params);
  res.json(rows.map(r => ({ ...r, label: LABELS[r.doc_type] || r.doc_type })));
});

module.exports = router;
