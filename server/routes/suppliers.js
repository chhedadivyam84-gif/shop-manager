const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr, localDate, bindId } = require("../util");
const { requireRole } = require("../auth");
const { saveAttachment } = require("../attachments");
const { postPaymentToLedger, voidLinkedLedgerEntry } = require("../bankLink");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

router.get("/", (req, res) => {
  const suppliers = db.prepare("SELECT * FROM suppliers ORDER BY name ASC").all();
  res.json(suppliers);
});

/** Shared by GET /:id and the ledger Excel export — mirrors customers.js. */
function buildSupplierDetail(id) {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(id);
  if (!s) return null;

  const history = db.prepare(`
    SELECT id, invoice_no, purchase_date AS date, grand_total AS total, product_name
    FROM stock_ins WHERE supplier_id = ? ORDER BY created_at DESC
  `).all(s.id);
  const payments = db.prepare(`
    SELECT * FROM purchase_payments WHERE supplier_id = ? AND voided = 0 ORDER BY created_at DESC
  `).all(s.id);

  // One chronological ledger — purchases raise the due, payments lower it —
  // mirroring the customer ledger exactly (see customers.js). Two purchase
  // sources feed it: the legacy single-line stock_ins (from Inventory's
  // "Record Stock In") and the newer multi-line purchases (from New
  // Purchase). Only the latter is tagged `source: "purchases"` and carries
  // an id the client can open for Edit/Void/Delete — stock_ins rows stay
  // read-only here, same as before this feature existed.
  const stockInRows = db.prepare(`
    SELECT id, product_id, invoice_no, purchase_date AS date, grand_total AS total, created_at
    FROM stock_ins WHERE supplier_id = ?
  `).all(s.id);
  const purchaseInvoiceRows = db.prepare(`
    SELECT id, supplier_invoice_no AS invoice_no, date, total, created_at
    FROM purchases WHERE supplier_id = ? AND voided = 0
  `).all(s.id);
  const openingBalanceRows = db.prepare(`
    SELECT * FROM supplier_opening_balances WHERE supplier_id = ? AND voided = 0
  `).all(s.id);
  const invoiceNoById = Object.fromEntries(stockInRows.map(h => [h.id, h.invoice_no]));
  const chrono = [
    ...stockInRows.map(h => ({ type: "purchase", source: "stock_in", id: h.id, productId: h.product_id, label: h.invoice_no || "(no invoice no.)", amount: h.total, date: h.date, at: h.created_at })),
    ...purchaseInvoiceRows.map(h => ({ type: "purchase", source: "purchases", id: h.id, label: h.invoice_no || "(no invoice no.)", amount: h.total, date: h.date, at: h.created_at })),
    ...payments.map(p => ({
      type: "payment", id: p.id, label: p.method, amount: -p.amount, note: p.note,
      referenceNo: p.reference_no, bankName: p.bank_name, upiId: p.upi_id, bankAccountId: p.bank_account_id,
      attachmentPath: p.attachment_path, attachmentName: p.attachment_name,
      againstInvoiceNo: p.stock_in_id ? (invoiceNoById[p.stock_in_id] || null) : null,
      date: p.payment_date || localDate(p.created_at), at: p.created_at
    })),
    // Payable raises the due like a purchase would; Advance lowers it like a
    // payment would — the sign is baked into `amount` here so the ledger's
    // running-balance math (below) treats it exactly the same way.
    ...openingBalanceRows.map(o => ({
      type: "opening_balance", id: o.id, label: o.balance_type, note: o.remarks,
      amount: o.balance_type === "Advance" ? -o.amount : o.amount,
      date: o.date, at: o.created_at
    }))
  ].sort((a, b) => a.at - b.at);
  let running = 0;
  const ledger = chrono.map(l => { running = round2(running + l.amount); return { ...l, runningBalance: running }; }).reverse();

  const totalPurchases = round2(
    stockInRows.reduce((sum, h) => sum + h.total, 0) + purchaseInvoiceRows.reduce((sum, h) => sum + h.total, 0)
  );
  const totalPaymentPaid = round2(payments.reduce((sum, p) => sum + p.amount, 0));
  const openingBalance = round2(openingBalanceRows.reduce((sum, o) => sum + (o.balance_type === "Advance" ? -o.amount : o.amount), 0));

  return {
    ...s, history, payments, ledger,
    openingBalance, totalPurchases, totalPaymentPaid,
    outstandingPayable: s.due, closingBalance: s.due
  };
}

router.get("/:id", (req, res) => {
  const detail = buildSupplierDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Supplier not found." });
  res.json(detail);
});

router.get("/:id/ledger/export", (req, res) => {
  const detail = buildSupplierDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Supplier not found." });
  const rows = [["Date", "Type", "Invoice No", "Debit", "Credit", "Running Balance", "Remarks"]];
  [...detail.ledger].reverse().forEach(l => {
    const isDebit = l.type === "purchase";
    rows.push([
      l.date, isDebit ? "Purchase" : "Payment", l.label,
      isDebit ? l.amount : "", isDebit ? "" : -l.amount,
      l.runningBalance, l.note || ""
    ]);
  });
  const filename = `ledger-${(detail.name || "supplier").replace(/[^a-z0-9]+/gi, "-")}`;
  const buf = buildXlsx(rows, filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

/** Sets (or adds another) starting balance for this supplier — Payable
 *  raises due, Advance lowers it. Not restricted to once, so a mistaken
 *  entry can be voided and re-entered rather than being permanent. Owner-only:
 *  opening balances are a financial starting point, not routine data entry. */
router.post("/:id/opening-balance", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid opening balance amount." });
  const balanceType = req.body.balanceType === "Advance" ? "Advance" : "Payable";
  const date = (req.body.date || "").trim() || todayStr();
  const remarks = (req.body.remarks || "").trim();

  const id = uid("SOB");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO supplier_opening_balances (id, supplier_id, date, amount, balance_type, remarks, voided, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, s.id, date, amount, balanceType, remarks, Date.now());
    if (balanceType === "Advance") db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(amount, s.id);
    else db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(amount, s.id);
  })();

  logAction(req, "supplier.opening_balance", `${s.name}: ${amount} (${balanceType})`);
  res.status(201).json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

// Corrects a mistyped amount/date/type/remarks on an opening balance that
// hasn't been voided — due is adjusted by the DIFFERENCE between the old and
// new contribution (each signed: Advance negative, Payable positive), the
// same delta approach used for editing a purchase payment.
router.put("/:id/opening-balance/:obId", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const o = db.prepare("SELECT * FROM supplier_opening_balances WHERE id = ? AND supplier_id = ?").get(req.params.obId, s.id);
  if (!o) return res.status(404).json({ error: "Opening balance entry not found." });
  if (o.voided) return res.status(400).json({ error: "Can't edit a voided entry." });

  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid opening balance amount." });
  const balanceType = req.body.balanceType === "Advance" ? "Advance" : "Payable";
  const date = (req.body.date || "").trim() || o.date;
  const remarks = (req.body.remarks ?? o.remarks).trim();

  const oldContribution = o.balance_type === "Advance" ? -o.amount : o.amount;
  const newContribution = balanceType === "Advance" ? -amount : amount;
  const delta = round2(newContribution - oldContribution);

  db.transaction(() => {
    db.prepare(`
      UPDATE supplier_opening_balances SET date=?, amount=?, balance_type=?, remarks=? WHERE id=?
    `).run(date, amount, balanceType, remarks, o.id);
    if (delta) db.prepare("UPDATE suppliers SET due = MAX(0, due + ?) WHERE id = ?").run(delta, s.id);
  })();

  logAction(req, "supplier.opening_balance_edit", `${s.name}: ${o.amount} (${o.balance_type}) -> ${amount} (${balanceType})`);
  res.json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

router.post("/:id/opening-balance/:obId/void", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const o = db.prepare("SELECT * FROM supplier_opening_balances WHERE id = ? AND supplier_id = ?").get(req.params.obId, s.id);
  if (!o) return res.status(404).json({ error: "Opening balance entry not found." });
  if (o.voided) return res.status(400).json({ error: "Already voided." });

  db.transaction(() => {
    db.prepare("UPDATE supplier_opening_balances SET voided = 1 WHERE id = ?").run(o.id);
    // Reverse exactly what it did: a Payable had raised due, so voiding lowers
    // it back (floored at 0, same as every other reversal in this app); an
    // Advance had lowered due, so voiding raises it back.
    if (o.balance_type === "Advance") db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(o.amount, s.id);
    else db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(o.amount, s.id);
  })();

  logAction(req, "supplier.opening_balance_void", `${s.name}: ${o.amount} (${o.balance_type})`);
  res.json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

router.post("/:id/payments", (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid payment amount." });
  const method = req.body.method || "Cash";
  const note = (req.body.note || "").trim();
  const referenceNo = (req.body.referenceNo || "").trim();
  const bankName = (req.body.bankName || "").trim();
  const upiId = (req.body.upiId || "").trim();
  const bankAccountId = req.body.bankAccountId || null;
  const paymentDate = (req.body.date || "").trim() || todayStr();

  let stockInId = null;
  if (req.body.stockInId) {
    const si = db.prepare("SELECT id FROM stock_ins WHERE id = ? AND supplier_id = ?").get(bindId(req.body.stockInId), s.id);
    if (!si) return res.status(400).json({ error: "Selected purchase invoice no longer exists for this supplier." });
    stockInId = si.id;
  }

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const id = uid("PPAY");
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO purchase_payments (id, supplier_id, stock_in_id, amount, method, reference_no, bank_name, upi_id, bank_account_id, attachment_path, attachment_name, note, payment_date, voided, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(id, s.id, stockInId, amount, method, referenceNo, bankName, upiId, bankAccountId, attachment ? attachment.path : "", attachment ? attachment.name : "", note, paymentDate, Date.now());
      db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(amount, s.id);
      postPaymentToLedger({
        bankAccountId, method, amount, date: paymentDate,
        partyType: "supplier", partyId: s.id, partyName: s.name,
        txnType: "Supplier Payment", referenceNo, attachment,
        sourceType: "purchase_payment", sourceId: id, direction: "out"
      });
    })();
  } catch (err) { return res.status(400).json({ error: err.message }); }

  logAction(req, "purchase_payment.record", `${s.name}: ${amount} (${method})`);
  res.status(201).json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

router.put("/:id/payments/:paymentId", (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const p = db.prepare("SELECT * FROM purchase_payments WHERE id = ? AND supplier_id = ?").get(req.params.paymentId, s.id);
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
        UPDATE purchase_payments SET amount=?, method=?, note=?, reference_no=?, bank_name=?, upi_id=?, bank_account_id=?, attachment_path=?, attachment_name=?, payment_date=? WHERE id=?
      `).run(amount, method, note, referenceNo, bankName, upiId, bankAccountId, attachmentPath, attachmentName, paymentDate, p.id);
      if (delta) db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(delta, s.id);
      voidLinkedLedgerEntry("purchase_payment", p.id);
      postPaymentToLedger({
        bankAccountId, method, amount, date: paymentDate,
        partyType: "supplier", partyId: s.id, partyName: s.name,
        txnType: "Supplier Payment", referenceNo,
        attachment: attachmentPath ? { path: attachmentPath, name: attachmentName } : null,
        sourceType: "purchase_payment", sourceId: p.id, direction: "out"
      });
    })();
  } catch (err) { return res.status(400).json({ error: err.message }); }

  logAction(req, "purchase_payment.edit", `${s.name}: ${p.amount} -> ${amount}`);
  res.json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

router.post("/:id/payments/:paymentId/void", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const p = db.prepare("SELECT * FROM purchase_payments WHERE id = ? AND supplier_id = ?").get(req.params.paymentId, s.id);
  if (!p) return res.status(404).json({ error: "Payment not found." });
  if (p.voided) return res.status(400).json({ error: "Payment already voided." });

  db.transaction(() => {
    db.prepare("UPDATE purchase_payments SET voided = 1 WHERE id = ?").run(p.id);
    db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(p.amount, s.id);
    voidLinkedLedgerEntry("purchase_payment", p.id);
  })();

  logAction(req, "purchase_payment.void", `${s.name}: ${p.amount} (${p.method})`);
  res.json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

/** Validates an area id against the master list.
 *  A supplier's own area is the fallback used when a purchase leaves the field
 *  blank, so a stale or mistyped id here would quietly mis-file every future
 *  purchase from them. Blank stays blank — not knowing is a legitimate answer. */
function cleanAreaId(id, fallback) {
  if (id === undefined) return fallback;
  if (!id) return null;
  const a = db.prepare("SELECT id FROM areas WHERE id = ?").get(id);
  return a ? a.id : null;
}

router.post("/", (req, res) => {
  const { name, phone, address, gst, state, gstType, areaId } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Supplier name is required." });
  }
  // Opening Outstanding is entered at the same moment the supplier is
  // created (the natural, one-time entry point per the Opening Outstanding
  // spec) — owner-only, same as the standalone opening-balance route below.
  const openingAmount = round2(Number(req.body.openingBalance) || 0);
  if (openingAmount > 0 && (!req.session || req.session.role !== "owner")) {
    return res.status(403).json({ error: "Only the shop owner can set an Opening Outstanding amount." });
  }

  const id = uid("SUP");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO suppliers (id, name, phone, address, gst, state, due, created_at, gst_type, area_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, name.trim(), (phone || "").trim(), (address || "").trim(), (gst || "").trim(), (state || "").trim(), Date.now(), gstType === "IGST" ? "IGST" : "CGST_SGST", cleanAreaId(areaId, null));

    if (openingAmount > 0) {
      const balanceType = req.body.openingBalanceType === "Advance" ? "Advance" : "Payable";
      const date = (req.body.openingDate || "").trim() || todayStr();
      const remarks = (req.body.openingRemarks || "").trim();
      db.prepare(`
        INSERT INTO supplier_opening_balances (id, supplier_id, date, amount, balance_type, remarks, voided, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(uid("SOB"), id, date, openingAmount, balanceType, remarks, Date.now());
      if (balanceType === "Advance") db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(openingAmount, id);
      else db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(openingAmount, id);
    }
  })();

  logAction(req, "supplier.create", name.trim() + (openingAmount > 0 ? ` (opening ${openingAmount})` : ""));
  res.status(201).json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const { name, phone, address, gst, state, gstType, areaId } = req.body;
  db.prepare(`
    UPDATE suppliers SET name=?, phone=?, address=?, gst=?, state=?, gst_type=?, area_id=? WHERE id=?
  `).run(
    (name || s.name).trim(), (phone ?? s.phone), (address ?? s.address), (gst ?? s.gst), (state ?? s.state),
    gstType === "IGST" ? "IGST" : gstType === "CGST_SGST" ? "CGST_SGST" : s.gst_type,
    cleanAreaId(areaId, s.area_id), s.id
  );
  logAction(req, "supplier.update", s.name);
  res.json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

/** Any Purchase, Payment or stock-in record naming this supplier — see
 *  customers.js's customerUsage() for the mirrored reasoning. */
function supplierUsage(id) {
  const stockInCount = db.prepare("SELECT COUNT(*) AS n FROM stock_ins WHERE supplier_id = ?").get(id).n;
  const purchaseCount = db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE supplier_id = ?").get(id).n;
  const paymentCount = db.prepare("SELECT COUNT(*) AS n FROM purchase_payments WHERE supplier_id = ?").get(id).n;
  return { stockInCount, purchaseCount, paymentCount, total: stockInCount + purchaseCount + paymentCount };
}

router.get("/:id/usage", (req, res) => {
  const s = db.prepare("SELECT id FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  res.json(supplierUsage(s.id));
});

router.patch("/:id/active", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE suppliers SET active = ? WHERE id = ?").run(active, s.id);
  logAction(req, active ? "supplier.activate" : "supplier.deactivate", s.name);
  res.json(db.prepare("SELECT * FROM suppliers WHERE id = ?").get(s.id));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Supplier not found." });
  if (supplierUsage(s.id).total > 0) {
    return res.status(400).json({ error: "This Supplier cannot be deleted because it is linked to existing transactions. You may deactivate or edit the record instead." });
  }
  db.prepare("DELETE FROM suppliers WHERE id = ?").run(s.id);
  logAction(req, "supplier.delete", s.name);
  res.json({ ok: true });
});

module.exports = router;
