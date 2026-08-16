const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr, localDate, bindId } = require("../util");
const { requireRole } = require("../auth");
const { saveAttachment } = require("../attachments");
const { postPaymentToLedger, voidLinkedLedgerEntry } = require("../bankLink");
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
  const openingBalanceRows = db.prepare(`
    SELECT * FROM customer_opening_balances WHERE customer_id = ? AND voided = 0
  `).all(c.id);
  const invoiceNoById = Object.fromEntries(invoiceRows.map(h => [h.id, h.challan_no]));
  // Oldest-first to accumulate a running balance the way a real ledger reads
  // top-to-bottom, then reversed for display (newest activity first, matching
  // every other list in the app) while keeping each entry's own balance.
  const chrono = [
    ...invoiceRows.map(h => ({ type: "invoice", id: h.id, label: h.challan_no, amount: h.total, date: h.date, at: h.created_at })),
    ...payments.map(p => ({
      type: "payment", id: p.id, label: p.method, amount: -p.amount, note: p.note,
      referenceNo: p.reference_no, bankName: p.bank_name, upiId: p.upi_id, bankAccountId: p.bank_account_id,
      attachmentPath: p.attachment_path, attachmentName: p.attachment_name,
      againstInvoiceNo: p.invoice_id ? (invoiceNoById[p.invoice_id] || null) : null,
      date: p.payment_date || localDate(p.created_at), at: p.created_at
    })),
    // Receivable raises the due like an invoice would; Advance lowers it like
    // a payment would — sign baked into `amount` so the running-balance math
    // (below) treats it exactly the same way as every other ledger entry.
    ...openingBalanceRows.map(o => ({
      type: "opening_balance", id: o.id, label: o.balance_type, note: o.remarks,
      amount: o.balance_type === "Advance" ? -o.amount : o.amount,
      date: o.date, at: o.created_at
    }))
  ].sort((a, b) => a.at - b.at);
  let running = 0;
  const ledger = chrono.map(l => { running = round2(running + l.amount); return { ...l, runningBalance: running }; }).reverse();

  const totalSales = round2(invoiceRows.reduce((s, h) => s + h.total, 0));
  const totalPaymentReceived = round2(payments.reduce((s, p) => s + p.amount, 0));
  const openingBalance = round2(openingBalanceRows.reduce((sum, o) => sum + (o.balance_type === "Advance" ? -o.amount : o.amount), 0));

  return {
    ...c, history, payments, ledger,
    openingBalance, totalSales, totalPaymentReceived,
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

/** Sets (or adds another) starting balance for this customer — Receivable
 *  raises due, Advance lowers it. Not restricted to once, so a mistaken
 *  entry can be voided and re-entered rather than being permanent. Owner-only:
 *  opening balances are a financial starting point, not routine data entry. */
router.post("/:id/opening-balance", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid opening balance amount." });
  const balanceType = req.body.balanceType === "Advance" ? "Advance" : "Receivable";
  const date = (req.body.date || "").trim() || todayStr();
  const remarks = (req.body.remarks || "").trim();

  const id = uid("COB");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO customer_opening_balances (id, customer_id, date, amount, balance_type, remarks, voided, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, c.id, date, amount, balanceType, remarks, Date.now());
    if (balanceType === "Advance") db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(amount, c.id);
    else db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(amount, c.id);
  })();

  logAction(req, "customer.opening_balance", `${c.name}: ${amount} (${balanceType})`);
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

// Corrects a mistyped amount/date/type/remarks on an opening balance that
// hasn't been voided — due is adjusted by the DIFFERENCE between the old and
// new contribution (each signed: Advance negative, Receivable positive), the
// same delta approach used for editing a payment.
router.put("/:id/opening-balance/:obId", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const o = db.prepare("SELECT * FROM customer_opening_balances WHERE id = ? AND customer_id = ?").get(req.params.obId, c.id);
  if (!o) return res.status(404).json({ error: "Opening balance entry not found." });
  if (o.voided) return res.status(400).json({ error: "Can't edit a voided entry." });

  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid opening balance amount." });
  const balanceType = req.body.balanceType === "Advance" ? "Advance" : "Receivable";
  const date = (req.body.date || "").trim() || o.date;
  const remarks = (req.body.remarks ?? o.remarks).trim();

  const oldContribution = o.balance_type === "Advance" ? -o.amount : o.amount;
  const newContribution = balanceType === "Advance" ? -amount : amount;
  const delta = round2(newContribution - oldContribution);

  db.transaction(() => {
    db.prepare(`
      UPDATE customer_opening_balances SET date=?, amount=?, balance_type=?, remarks=? WHERE id=?
    `).run(date, amount, balanceType, remarks, o.id);
    if (delta) db.prepare("UPDATE customers SET due = MAX(0, due + ?) WHERE id = ?").run(delta, c.id);
  })();

  logAction(req, "customer.opening_balance_edit", `${c.name}: ${o.amount} (${o.balance_type}) -> ${amount} (${balanceType})`);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.post("/:id/opening-balance/:obId/void", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const o = db.prepare("SELECT * FROM customer_opening_balances WHERE id = ? AND customer_id = ?").get(req.params.obId, c.id);
  if (!o) return res.status(404).json({ error: "Opening balance entry not found." });
  if (o.voided) return res.status(400).json({ error: "Already voided." });

  db.transaction(() => {
    db.prepare("UPDATE customer_opening_balances SET voided = 1 WHERE id = ?").run(o.id);
    if (o.balance_type === "Advance") db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(o.amount, c.id);
    else db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(o.amount, c.id);
  })();

  logAction(req, "customer.opening_balance_void", `${c.name}: ${o.amount} (${o.balance_type})`);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
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
  const bankAccountId = req.body.bankAccountId || null;
  const paymentDate = (req.body.date || "").trim() || todayStr();

  let invoiceId = null;
  if (req.body.invoiceId) {
    const inv = db.prepare("SELECT id FROM invoices WHERE id = ? AND customer_id = ? AND doc_type = 'invoice'").get(bindId(req.body.invoiceId), c.id);
    if (!inv) return res.status(400).json({ error: "Selected invoice no longer exists for this customer." });
    invoiceId = inv.id;
  }

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const id = uid("PAY");
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO payments (id, customer_id, amount, method, note, invoice_id, reference_no, bank_name, upi_id, bank_account_id, attachment_path, attachment_name, payment_date, voided, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(id, c.id, amount, method, note, invoiceId, referenceNo, bankName, upiId, bankAccountId, attachment ? attachment.path : "", attachment ? attachment.name : "", paymentDate, Date.now());
      db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(amount, c.id);
      // Auto-posts into Cash Book (method Cash) or Bank Book (any other
      // method) so this screen keeps working unchanged while the ledgers
      // stay in sync with it — see server/bankLink.js.
      postPaymentToLedger({
        bankAccountId, method, amount, date: paymentDate,
        partyType: "customer", partyId: c.id, partyName: c.name,
        txnType: "Customer Receipt", referenceNo, attachment,
        sourceType: "payment", sourceId: id, direction: "in"
      });
    })();
  } catch (err) { return res.status(400).json({ error: err.message }); }

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
  const bankAccountId = req.body.bankAccountId !== undefined ? req.body.bankAccountId : p.bank_account_id;
  const paymentDate = (req.body.date || "").trim() || p.payment_date;

  let attachmentPath = p.attachment_path, attachmentName = p.attachment_name;
  try {
    const attachment = saveAttachment(req.body.attachment);
    if (attachment) { attachmentPath = attachment.path; attachmentName = attachment.name; }
  } catch (err) { return res.status(400).json({ error: err.message }); }

  const delta = round2(amount - p.amount);
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE payments SET amount=?, method=?, note=?, reference_no=?, bank_name=?, upi_id=?, bank_account_id=?, attachment_path=?, attachment_name=?, payment_date=? WHERE id=?
      `).run(amount, method, note, referenceNo, bankName, upiId, bankAccountId, attachmentPath, attachmentName, paymentDate, p.id);
      if (delta) db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(delta, c.id);
      // Re-derive the linked ledger entry from scratch rather than patching
      // it in place — simplest way to handle a switch between Cash/Bank or
      // between bank accounts without leaving a stale row behind.
      voidLinkedLedgerEntry("payment", p.id);
      postPaymentToLedger({
        bankAccountId, method, amount, date: paymentDate,
        partyType: "customer", partyId: c.id, partyName: c.name,
        txnType: "Customer Receipt", referenceNo,
        attachment: attachmentPath ? { path: attachmentPath, name: attachmentName } : null,
        sourceType: "payment", sourceId: p.id, direction: "in"
      });
    })();
  } catch (err) { return res.status(400).json({ error: err.message }); }

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
    voidLinkedLedgerEntry("payment", p.id);
  })();

  logAction(req, "payment.void", `${c.name}: ${p.amount} (${p.method})`);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

/** Validates an area id against the master list.
 *  A party's own area is the fallback used when a bill leaves the field
 *  blank, so a stale or mistyped id here would quietly mis-file every future
 *  sale to them — checking once, on the way in, is the cheap place to stop
 *  that. Blank stays blank: not knowing is a legitimate answer. */
function cleanAreaId(id, fallback) {
  if (id === undefined) return fallback;
  if (!id) return null;
  const a = db.prepare("SELECT id FROM areas WHERE id = ?").get(id);
  return a ? a.id : null;
}

router.post("/", (req, res) => {
  const { name, type, phone, address, gst, state, creditLimit, gstType, areaId } = req.body;
  if (!name || !String(name).trim() || !phone || !String(phone).trim()) {
    return res.status(400).json({ error: "Name and phone are required." });
  }
  // Opening Outstanding is entered at the same moment the customer is
  // created (the natural, one-time entry point per the Opening Outstanding
  // spec) — owner-only, same as the standalone opening-balance route below.
  const openingAmount = round2(Number(req.body.openingBalance) || 0);
  if (openingAmount > 0 && (!req.session || req.session.role !== "owner")) {
    return res.status(403).json({ error: "Only the shop owner can set an Opening Outstanding amount." });
  }

  const id = uid("C");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO customers (id, name, type, phone, address, gst, state, credit_limit, due, created_at, gst_type, area_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, name.trim(), type || "Retail Customer", phone.trim(), (address || "").trim(), (gst || "").trim(), (state || "").trim(), Number(creditLimit) || 0, Date.now(), gstType === "IGST" ? "IGST" : "CGST_SGST", cleanAreaId(areaId, null));

    if (openingAmount > 0) {
      const balanceType = req.body.openingBalanceType === "Advance" ? "Advance" : "Receivable";
      const date = (req.body.openingDate || "").trim() || todayStr();
      const remarks = (req.body.openingRemarks || "").trim();
      db.prepare(`
        INSERT INTO customer_opening_balances (id, customer_id, date, amount, balance_type, remarks, voided, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(uid("COB"), id, date, openingAmount, balanceType, remarks, Date.now());
      if (balanceType === "Advance") db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(openingAmount, id);
      else db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(openingAmount, id);
    }
  })();

  logAction(req, "customer.create", name.trim() + (openingAmount > 0 ? ` (opening ${openingAmount})` : ""));
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const { name, type, phone, address, gst, state, creditLimit, gstType, areaId } = req.body;
  db.prepare(`
    UPDATE customers SET name=?, type=?, phone=?, address=?, gst=?, state=?, credit_limit=?, gst_type=?, area_id=? WHERE id=?
  `).run(
    (name || c.name).trim(), type ?? c.type, (phone ?? c.phone), (address ?? c.address), (gst ?? c.gst),
    (state ?? c.state), creditLimit !== undefined ? Number(creditLimit) : c.credit_limit,
    gstType === "IGST" ? "IGST" : gstType === "CGST_SGST" ? "CGST_SGST" : c.gst_type,
    cleanAreaId(areaId, c.area_id), c.id
  );
  logAction(req, "customer.update", c.name);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

/** Any Sales, Payment or Receipt record naming this customer — deleting would
 *  either orphan or (for payments, via ON DELETE CASCADE) silently destroy
 *  that history, so this gates both the DELETE route and the usage endpoint
 *  the UI checks before showing a delete confirmation. */
function customerUsage(id) {
  const invoiceCount = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?").get(id).n;
  const paymentCount = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?").get(id).n;
  return { invoiceCount, paymentCount, total: invoiceCount + paymentCount };
}

router.get("/:id/usage", (req, res) => {
  const c = db.prepare("SELECT id FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  res.json(customerUsage(c.id));
});

router.patch("/:id/active", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE customers SET active = ? WHERE id = ?").run(active, c.id);
  logAction(req, active ? "customer.activate" : "customer.deactivate", c.name);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  if (customerUsage(c.id).total > 0) {
    return res.status(400).json({ error: "This Customer cannot be deleted because it is linked to existing transactions. You may deactivate or edit the record instead." });
  }
  db.prepare("DELETE FROM customers WHERE id = ?").run(c.id);
  logAction(req, "customer.delete", c.name);
  res.json({ ok: true });
});

module.exports = router;
