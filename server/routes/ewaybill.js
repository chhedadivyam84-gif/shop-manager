/* ============================================================
   E-WAY BILL

   Records the e-way bill covering an invoice. Today those numbers come from
   the government portal, entered by hand; when API credentials exist the
   same rows get written by the API instead. Nothing here assumes which,
   which is the point — the register, the printing and the search all work
   the same either way.

   Deliberately NOT validated against the portal's rules. The portal owns
   those and they change; guessing them here would produce an app that
   refuses a bill the portal would have accepted. What is enforced is only
   what this app can know for certain: that the invoice exists, that it is
   not a challan, and that a number is not silently overwritten.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { logAction } = require("../util");

const router = express.Router();

const clean = v => String(v == null ? "" : v).trim();

/** The invoice an e-way bill can attach to, or null. */
function billableInvoice(id) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND voided = 0").get(id);
  if (!inv || inv.doc_type !== "invoice") return null;
  return inv;
}

/* Save (or correct) the e-way bill details on one invoice. */
router.post("/:invoiceId", (req, res) => {
  const inv = billableInvoice(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: "Invoice not found, or it is a challan rather than an invoice." });

  const b = req.body || {};
  const number = clean(b.ewayBillNo);
  if (!number) return res.status(400).json({ error: "Enter the e-way bill number." });

  /* Replacing a number that is already on file is allowed — a mistyped
     entry has to be correctable — but it is written to the activity log
     with both values, because silently swapping the number on a document
     that has already travelled is exactly the kind of change that needs a
     trail. */
  const replacing = inv.eway_bill_no && inv.eway_bill_no !== number;

  db.prepare(`
    UPDATE invoices SET
      eway_bill_no = ?, eway_bill_date = ?, eway_valid_until = ?, eway_status = ?,
      transporter_name = ?, transporter_id = ?, transport_mode = ?, vehicle_number = ?,
      vehicle_type = ?, lr_number = ?, lr_date = ?, distance_km = ?, dispatch_from = ?
    WHERE id = ?
  `).run(
    number, clean(b.ewayBillDate), clean(b.validUntil), clean(b.status) || "Generated",
    clean(b.transporterName), clean(b.transporterId),
    clean(b.transportMode) || inv.transport_mode || "",
    clean(b.vehicleNumber) || inv.vehicle_number || "",
    clean(b.vehicleType), clean(b.lrNumber), clean(b.lrDate),
    Number(b.distanceKm) || 0, clean(b.dispatchFrom),
    inv.id
  );

  logAction(req, "ewaybill.save",
    replacing ? `${inv.challan_no}: ${inv.eway_bill_no} replaced by ${number}`
              : `${inv.challan_no}: ${number}`);
  res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id));
});

/* Clear the details — for a bill cancelled on the portal, or entered against
   the wrong invoice. The invoice itself is untouched. */
router.delete("/:invoiceId", (req, res) => {
  const inv = billableInvoice(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  if (!inv.eway_bill_no) return res.status(400).json({ error: "This invoice has no e-way bill recorded." });

  db.prepare(`
    UPDATE invoices SET eway_bill_no = '', eway_bill_date = '', eway_valid_until = '',
                        eway_status = '' WHERE id = ?
  `).run(inv.id);
  logAction(req, "ewaybill.clear", `${inv.challan_no}: removed ${inv.eway_bill_no}`);
  res.json({ ok: true });
});

/**
 * The register. Every invoice carrying an e-way bill, newest first, with
 * validity worked out against today so an expired one is visible as such
 * without anyone having to compare dates by eye.
 */
router.get("/", (req, res) => {
  const { q, status, from, to } = req.query;
  const where = ["i.voided = 0", "i.doc_type = 'invoice'", "i.eway_bill_no <> ''"];
  const params = [];
  if (q) {
    where.push("(i.eway_bill_no LIKE ? OR i.challan_no LIKE ? OR c.name LIKE ? OR i.vehicle_number LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (from) { where.push("i.date >= ?"); params.push(from); }
  if (to)   { where.push("i.date <= ?"); params.push(to); }

  const rows = db.prepare(`
    SELECT i.id, i.challan_no, i.date, i.total, i.eway_bill_no, i.eway_bill_date,
           i.eway_valid_until, i.eway_status, i.transporter_name, i.vehicle_number,
           i.distance_km, c.name AS customer_name
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE ${where.join(" AND ")}
    ORDER BY i.date DESC, i.created_at DESC
  `).all(...params);

  const today = new Date().toISOString().slice(0, 10);
  const out = rows.map(r => {
    // Expiry is derived, never stored: a bill valid yesterday is expired
    // today without anything having to run overnight to say so.
    const expired = !!r.eway_valid_until && r.eway_valid_until < today;
    const stated = r.eway_status || "Generated";
    return { ...r, expired, status: expired && stated !== "Cancelled" ? "Expired" : stated };
  }).filter(r => !status || r.status === status);

  res.json(out);
});

module.exports = router;
