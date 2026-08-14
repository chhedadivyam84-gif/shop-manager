/* ============================================================
   E-WAY BILL ROUTES

   Thin: every decision lives in EWayBillService. These only translate HTTP
   to service calls and service results to messages a shop owner can act on.

   ewb_requests is never exposed here. It holds full payloads and provider
   tokens, and it stays server-side.
   ============================================================ */
const express = require("express");
const db = require("../db");
const svc = require("../ewb/service");
const { requireRole } = require("../auth");
const { logAction } = require("../util");

const router = express.Router();

/* Prepare — build from an invoice and validate, WITHOUT saving. Lets the
   screen show what is missing before anyone commits to anything. */
router.post("/prepare/:invoiceId", (req, res) => {
  try {
    const payload = svc.buildFromInvoice(req.params.invoiceId, req.body || {});
    res.json({ payload, problems: svc.validate(payload) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* Save a draft. Validation problems are returned but do NOT block saving —
   a draft you can come back to is the whole point of a draft. */
router.post("/draft/:invoiceId", (req, res) => {
  try {
    const existing = db.prepare(`
      SELECT id, status, ewb_no FROM ewb_bills
      WHERE invoice_id = ? AND status <> 'Cancelled'
    `).get(req.params.invoiceId);
    if (existing && existing.status === "Generated") {
      return res.status(409).json({
        error: `This invoice already has e-way bill ${existing.ewb_no}.`,
        ewbId: existing.id
      });
    }
    if (existing) return res.json({ id: existing.id, reused: true });

    const payload = svc.buildFromInvoice(req.params.invoiceId, req.body || {});
    const id = svc.saveDraft(payload, { id: req.session.staffId });
    logAction(req, "ewb.draft", `${payload.doc_no}`);
    res.json({ id, problems: svc.validate(payload) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* Update a draft's transport details. Only transport — the rest comes from
   the invoice and must not drift away from it. */
router.put("/:id/transport", (req, res) => {
  const bill = svc.getBill(req.params.id);
  if (!bill) return res.status(404).json({ error: "E-way bill not found." });
  if (bill.status === "Generated" || bill.status === "Cancelled")
    return res.status(400).json({ error: "This e-way bill has already been generated." });

  const b = req.body || {};
  db.prepare(`
    UPDATE ewb_bills SET transporter_id=?, transporter_name=?, trans_id=?, trans_mode=?,
      vehicle_no=?, vehicle_type=?, trans_doc_no=?, trans_doc_date=?, distance_km=?,
      status = CASE WHEN status='Failed' THEN 'Draft' ELSE status END, updated_at=?
    WHERE id=?
  `).run(
    b.transporterId || null, (b.transporterName || "").trim(), (b.transId || "").trim(),
    (b.transMode || "").trim(), (b.vehicleNo || "").trim().toUpperCase(),
    (b.vehicleType || "").trim(), (b.transDocNo || "").trim(), (b.transDocDate || "").trim(),
    Number(b.distanceKm) || 0, Date.now(), req.params.id
  );
  const updated = svc.getBill(req.params.id);
  res.json({ bill: updated, problems: svc.validate(toPayload(updated)) });
});

/** A stored bill in the shape validate() expects. */
function toPayload(bill) {
  return { ...bill, items: bill.items || [] };
}

/* Generate. Owner-only: it is an outward filing against the shop's GSTIN. */
router.post("/:id/generate", requireRole("owner"), async (req, res) => {
  try {
    const bill = svc.getBill(req.params.id);
    if (!bill) return res.status(404).json({ error: "E-way bill not found." });

    const problems = svc.validate(toPayload(bill));
    if (problems.length) return res.status(400).json({ problems });

    const r = await svc.generate(req.params.id, req);
    if (r.busy)
      return res.status(409).json({ error: "This e-way bill is already being submitted." });
    if (r.alreadyDone)
      return res.json({ bill: r.bill, message: `Already generated: ${r.bill.ewb_no}` });
    if (r.failed)
      return res.status(502).json({ error: r.error.message, field: r.error.field, code: r.error.code, bill: r.bill });
    res.json({ bill: r.bill });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/cancel", requireRole("owner"), async (req, res) => {
  const reason = (req.body && req.body.reason || "").trim();
  if (reason.length < 3) return res.status(400).json({ error: "Give a reason for cancelling." });
  try {
    const r = await svc.cancel(req.params.id, reason, req);
    if (r.failed) return res.status(502).json({ error: r.error.message });
    res.json({ bill: r.bill });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id", (req, res) => {
  const bill = svc.getBill(req.params.id);
  if (!bill) return res.status(404).json({ error: "E-way bill not found." });
  bill.problems = svc.validate(toPayload(bill));
  res.json(bill);
});

/**
 * The dashboard list. Expiry is derived against today rather than stored,
 * so a bill valid yesterday reads as expired now without anything having
 * run overnight — and a cancelled bill stays cancelled.
 */
router.get("/", (req, res) => {
  const { q, status, from, to } = req.query;
  const where = ["1=1"], params = [];
  if (q) {
    where.push("(b.ewb_no LIKE ? OR b.doc_no LIKE ? OR b.to_name LIKE ? OR b.vehicle_no LIKE ?)");
    const like = `%${q}%`; params.push(like, like, like, like);
  }
  if (from) { where.push("b.doc_date >= ?"); params.push(from); }
  if (to)   { where.push("b.doc_date <= ?"); params.push(to); }

  const rows = db.prepare(`
    SELECT b.* FROM ewb_bills b
    WHERE ${where.join(" AND ")}
    ORDER BY b.created_at DESC
  `).all(...params);

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

  const out = rows.map(b => {
    let shown = b.status;
    if (b.status === "Generated" && b.valid_until && b.valid_until < today) shown = "Expired";
    return {
      ...b, shownStatus: shown,
      expiringSoon: b.status === "Generated" && b.valid_until >= today && b.valid_until <= soon
    };
  }).filter(b => !status || b.shownStatus === status);

  const count = s => out.filter(b => b.shownStatus === s).length;
  res.json({
    rows: out,
    summary: {
      total: out.length, drafts: count("Draft"), generated: count("Generated"),
      expired: count("Expired"), cancelled: count("Cancelled"), failed: count("Failed"),
      expiringSoon: out.filter(b => b.expiringSoon).length
    }
  });
});

module.exports = router;
