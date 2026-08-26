/**
 * Recording which GST periods have been filed.
 *
 * The app cannot know this on its own — returns are filed on the GST
 * portal, not here — so the owner tells it, once a month, and gets a
 * warning ever after if they are about to change something in a month
 * they have already filed. See server/gstFiling.js for why this warns
 * rather than locks.
 *
 * Marking is owner-only: it is a statement about what was filed with the
 * tax office, not routine data entry.
 */
const express = require("express");
const db = require("../db");
const { uid, todayStr, logAction } = require("../util");
const { requireRole } = require("../auth");
const gstFiling = require("../gstFiling");

const router = express.Router();

/** Every period on record, newest first, with what it holds. Readable by
 *  anyone who can see the GST report — knowing August is filed is not a
 *  sensitive figure, and staff benefit from seeing it too. */
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM gst_filings ORDER BY period DESC, return_type").all();

  /* Grouped by month, because that is how the owner thinks about it: one
     line per month showing which of the two returns are done. */
  const byPeriod = new Map();
  rows.forEach(r => {
    if (!byPeriod.has(r.period)) {
      byPeriod.set(r.period, { period: r.period, label: gstFiling.periodLabel(r.period), returns: [] });
    }
    byPeriod.get(r.period).returns.push(r);
  });

  res.json({
    periods: [...byPeriod.values()],
    returnTypes: gstFiling.RETURN_TYPES
  });
});

/**
 * Is this document in a month already filed?
 *
 * Asked by the screen just before it offers to void or delete something.
 * The document's date is looked up HERE rather than passed in, so the
 * answer is about the document as recorded and not about whatever the row
 * on screen happened to be showing.
 */
router.get("/check", (req, res) => {
  const w = gstFiling.warningFor(String(req.query.kind || ""), req.query.id);
  res.json(w || { filed: false });
});

/** Mark a return filed for a month. Re-marking a re-opened period puts it
 *  back to filed rather than making a second row for the same month. */
router.post("/", requireRole("owner"), (req, res) => {
  const period = String(req.body.period || "").trim();
  const returnType = String(req.body.returnType || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: "Which month? Pick one, e.g. August 2026." });
  }
  if (!gstFiling.RETURN_TYPES.includes(returnType)) {
    return res.status(400).json({ error: `Which return? ${gstFiling.RETURN_TYPES.join(" or ")}.` });
  }

  const filedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.filedOn || "")) ? req.body.filedOn : todayStr();
  const arn = String(req.body.arn || "").trim();
  const note = String(req.body.note || "").trim();
  const who = (req.session && req.session.staffName) || "";

  const existing = db.prepare("SELECT * FROM gst_filings WHERE period = ? AND return_type = ?").get(period, returnType);
  if (existing) {
    db.prepare(`
      UPDATE gst_filings SET status='filed', filed_on=?, arn=?, note=?, filed_by=?,
        reopened_on='', reopened_by='', updated_at=? WHERE id=?
    `).run(filedOn, arn, note, who, Date.now(), existing.id);
    logAction(req, "gst.filed", `${returnType} ${period} (re-marked)`);
  } else {
    db.prepare(`
      INSERT INTO gst_filings (id, period, return_type, filed_on, arn, note, filed_by, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'filed', ?, ?)
    `).run(uid("GSTF"), period, returnType, filedOn, arn, note, who, Date.now(), Date.now());
    logAction(req, "gst.filed", `${returnType} ${period} on ${filedOn}${arn ? " ARN " + arn : ""}`);
  }

  res.status(201).json(db.prepare("SELECT * FROM gst_filings WHERE period = ? AND return_type = ?").get(period, returnType));
});

/**
 * Re-open a period — the return was not actually filed, or is being
 * revised. The row stays, marked re-opened, because "was August ever
 * filed, and when" is a question somebody will ask, and a deleted row
 * cannot answer it. There is deliberately no DELETE on this router.
 */
router.post("/:id/reopen", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM gst_filings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "That filing record was not found." });
  if (row.status !== "filed") {
    return res.status(400).json({ error: `${row.return_type} for ${gstFiling.periodLabel(row.period)} is already re-opened.` });
  }
  db.prepare("UPDATE gst_filings SET status='reopened', reopened_on=?, reopened_by=?, updated_at=? WHERE id=?")
    .run(todayStr(), (req.session && req.session.staffName) || "", Date.now(), row.id);
  logAction(req, "gst.reopened", `${row.return_type} ${row.period}`);
  res.json(db.prepare("SELECT * FROM gst_filings WHERE id = ?").get(row.id));
});

module.exports = router;
