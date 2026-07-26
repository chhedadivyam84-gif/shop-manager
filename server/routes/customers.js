const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr } = require("../util");
const { requireRole } = require("../auth");
const { saveAttachment } = require("../attachments");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

router.get("/", (req, res) => {
  const customers = db.prepare("SELECT * FROM customers ORDER BY name ASC").all();
  res.json(customers);
});

/** Shared by GET /:id and the ledger Excel export — see suppliers.js for the mirror. */
function buildCustomerDetail(id) {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
  if (!c) return null;
  // Challans carry no price, so they belong to neither the purchase history nor
  // the money ledger — only priced tax invoices move a customer's balance.
  const history = db.prepare(`
    SELECT id, challan_no, date, total FROM invoices
    WHERE customer_id = ? AND voided = 0 AND doc_type = 'invoice' ORDER BY created_at DESC
  `).all(c.id);
  const payments = db.prepare(`
    SELECT * FROM payments WHERE customer_id = ? AND voided = 0 ORDER BY created_at DESC
  `).all(c.id);

  // A single chronological ledger — invoices raise the due, payments lower it —
  // is what actually answers "what does this customer owe and why", rather
  // than two disconnected lists staff have to mentally merge themselves.
  const invoiceRows = db.prepare(`
    SELECT id, challan_no, date, total, created_at FROM invoices
    WHERE customer_id = ? AND voided = 0 AND doc_type = 'invoice'
  `).all(c.id);
  const invoiceNoById = Object.fromEntries(invoiceRows.map(h => [h.id, h.challan_no]));
  // Oldest-first to accumulate a running balance the way a real ledger reads
  // top-to-bottom, then reversed for display (newest activity first, matching
  // every other list in the app) while keeping each entry's own balance.
  const chrono = [
    ...invoiceRows.map(h => ({ type: "invoice", id: h.id, label: h.challan_no, amount: h.total, date: h.date, at: h.created_at })),
    ...payments.map(p => ({
      type: "payment", id: p.id, label: p.method, amount: -p.amount, note: p.note,
      referenceNo: p.reference_no, bankName: p.bank_name, upiId: p.upi_id,
      attachmentPath: p.attachment_path, attachmentName: p.attachment_name,
      againstInvoiceNo: p.invoice_id ? (invoiceNoById[p.invoice_id] || null) : null,
      date: p.payment_date || new Date(p.created_at).toISOString().slice(0, 10), at: p.created_at
    }))
  ].sort((a, b) => a.at - b.at);
  let running = 0;
  const ledger = chrono.map(l => { running = round2(running + l.amount); return { ...l, runningBalance: running }; }).reverse();

  const totalSales = round2(invoiceRows.reduce((s, h) => s + h.total, 0));
  const totalPaymentReceived = round2(payments.reduce((s, p) => s + p.amount, 0));

  return {
    ...c, history, payments, ledger,
    openingBalance: 0, totalSales, totalPaymentReceived,
    outstandingReceivable: c.due, closingBalance: c.due
  };
}

router.get("/:id", (req, res) => {
  const detail = buildCustomerDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Customer not found." });
  res.json(detail);
});

router.get("/:id/ledger/export", (req, res) => {
  const detail = buildCustomerDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Customer not found." });
  const rows = [["Date", "Type", "Invoice No", "Debit", "Credit", "Running Balance", "Remarks"]];
  // Chronological (oldest first) for a real statement, opposite of the
  // newest-first order the app's UI uses — matches how a printed ledger reads.
  [...detail.ledger].reverse().forEach(l => {
    const isDebit = l.type === "invoice";
    rows.push([
      l.date, isDebit ? "Invoice" : "Payment", l.label,
      isDebit ? l.amount : "", isDebit ? "" : -l.amount,
      l.runningBalance, l.note || ""
    ]);
  });
  const filename = `ledger-${(detail.name || "customer").replace(/[^a-z0-9]+/gi, "-")}`;
  const buf = buildXlsx(rows, filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

router.post("/:id/payments", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid payment amount." });
  const method = req.body.method || "Cash";
  const note = (req.body.note || "").trim();
  const referenceNo = (req.body.referenceNo || "").trim();
  const bankName = (req.body.bankName || "").trim();
  const upiId = (req.body.upiId || "").trim();
  const paymentDate = (req.body.date || "").trim() || todayStr();

  let invoiceId = null;
  if (req.body.invoiceId) {
    const inv = db.prepare("SELECT id FROM invoices WHERE id = ? AND customer_id = ? AND doc_type = 'invoice'").get(req.body.invoiceId, c.id);
    if (!inv) return res.status(400).json({ error: "Selected invoice no longer exists for this customer." });
    invoiceId = inv.id;
  }

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const id = uid("PAY");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (id, customer_id, amount, method, note, invoice_id, reference_no, bank_name, upi_id, attachment_path, attachment_name, payment_date, voided, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, c.id, amount, method, note, invoiceId, referenceNo, bankName, upiId, attachment ? attachment.path : "", attachment ? attachment.name : "", paymentDate, Date.now());
    db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(amount, c.id);
  })();

  logAction(req, "payment.record", `${c.name}: ${amount} (${method})`);
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

// Corrects a mistyped amount/date/mode/etc. on a payment that hasn't been
// voided — the party/invoice link stays fixed (wrong party means void and
// re-enter, not edit). The due balance is adjusted by the DIFFERENCE between
// old and new amount, not just applied fresh, so editing 500 -> 700 only
// moves the due by 200, matching how much money actually changed.
router.put("/:id/payments/:paymentId", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const p = db.prepare("SELECT * FROM payments WHERE id = ? AND customer_id = ?").get(req.params.paymentId, c.id);
  if (!p) return res.status(404).json({ error: "Payment not found." });
  if (p.voided) return res.status(400).json({ error: "Can't edit a voided payment." });

  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid payment amount." });
  const method = req.body.method || p.method;
  const note = (req.body.note ?? p.note).trim();
  const referenceNo = (req.body.referenceNo ?? p.reference_no).trim();
  const bankName = (req.body.bankName ?? p.bank_name).trim();
  const upiId = (req.body.upiId ?? p.upi_id).trim();
  const paymentDate = (req.body.date || "").trim() || p.payment_date;

  let attachmentPath = p.attachment_path, attachmentName = p.attachment_name;
  try {
    const attachment = saveAttachment(req.body.attachment);
    if (attachment) { attachmentPath = attachment.path; attachmentName = attachment.name; }
  } catch (err) { return res.status(400).json({ error: err.message }); }

  const delta = round2(amount - p.amount);
  db.transaction(() => {
    db.prepare(`
      UPDATE payments SET amount=?, method=?, note=?, reference_no=?, bank_name=?, upi_id=?, attachment_path=?, attachment_name=?, payment_date=? WHERE id=?
    `).run(amount, method, note, referenceNo, bankName, upiId, attachmentPath, attachmentName, paymentDate, p.id);
    if (delta) db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(delta, c.id);
  })();

  logAction(req, "payment.edit", `${c.name}: ${p.amount} -> ${amount}`);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.post("/:id/payments/:paymentId/void", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const p = db.prepare("SELECT * FROM payments WHERE id = ? AND customer_id = ?").get(req.params.paymentId, c.id);
  if (!p) return res.status(404).json({ error: "Payment not found." });
  if (p.voided) return res.status(400).json({ error: "Payment already voided." });

  db.transaction(() => {
    db.prepare("UPDATE payments SET voided = 1 WHERE id = ?").run(p.id);
    db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(p.amount, c.id);
  })();

  logAction(req, "payment.void", `${c.name}: ${p.amount} (${p.method})`);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.post("/", (req, res) => {
  const { name, type, phone, address, gst, state, creditLimit, gstType } = req.body;
  if (!name || !String(name).trim() || !phone || !String(phone).trim()) {
    return res.status(400).json({ error: "Name and phone are required." });
  }
  const id = uid("C");
  db.prepare(`
    INSERT INTO customers (id, name, type, phone, address, gst, state, credit_limit, due, created_at, gst_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, name.trim(), type || "Retail Customer", phone.trim(), (address || "").trim(), (gst || "").trim(), (state || "").trim(), Number(creditLimit) || 0, Date.now(), gstType === "IGST" ? "IGST" : "CGST_SGST");
  logAction(req, "customer.create", name.trim());
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const { name, type, phone, address, gst, state, creditLimit, gstType } = req.body;
  db.prepare(`
    UPDATE customers SET name=?, type=?, phone=?, address=?, gst=?, state=?, credit_limit=?, gst_type=? WHERE id=?
  `).run(
    (name || c.name).trim(), type ?? c.type, (phone ?? c.phone), (address ?? c.address), (gst ?? c.gst),
    (state ?? c.state), creditLimit !== undefined ? Number(creditLimit) : c.credit_limit,
    gstType === "IGST" ? "IGST" : gstType === "CGST_SGST" ? "CGST_SGST" : c.gst_type, c.id
  );
  logAction(req, "customer.update", c.name);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  db.prepare("DELETE FROM customers WHERE id = ?").run(c.id);
  logAction(req, "customer.delete", c.name);
  res.json({ ok: true });
});

module.exports = router;
