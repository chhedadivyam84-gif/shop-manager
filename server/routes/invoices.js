const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

function getSettingsRow() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

function nextChallanNo() {
  const year = new Date().getFullYear();
  const counterName = `challan-${year}`;
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(counterName);
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(counterName, next);
  return `CH-${year}-${String(next).padStart(4, "0")}`;
}

function computeTotals({ items, discountType, discountValue, advance, taxType }) {
  const subtotal = round2(items.reduce((s, it) => s + it.qty * it.rate, 0));
  let discountAmount = 0;
  if (discountType === "flat") discountAmount = Number(discountValue) || 0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let totalTax = 0;
  const itemTax = items.map(it => {
    const lineTotal = it.qty * it.rate;
    const share = subtotal > 0 ? (lineTotal / subtotal) * discountAmount : 0;
    const taxable = Math.max(0, lineTotal - share);
    const tax = taxable * (it.gstRate / 100);
    totalTax += tax;
    return tax;
  });
  totalTax = round2(totalTax);

  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === "IGST") igst = totalTax;
  else { cgst = round2(totalTax / 2); sgst = round2(totalTax - cgst); }

  const total = round2(subtotal - discountAmount + cgst + sgst + igst);
  const advanceApplied = round2(Math.min(Math.max(0, Number(advance) || 0), total));
  const balanceDue = round2(total - advanceApplied);

  return { subtotal, discountAmount, cgst, sgst, igst, total, advance: advanceApplied, balanceDue, itemTax };
}

router.get("/", (req, res) => {
  const { date } = req.query;
  const invoices = date
    ? db.prepare("SELECT * FROM invoices WHERE date = ? AND voided = 0 ORDER BY created_at DESC").all(date)
    : db.prepare("SELECT * FROM invoices WHERE voided = 0 ORDER BY created_at DESC").all();
  res.json(invoices);
});

router.get("/:id", (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
  res.json({ ...inv, items });
});

router.post("/", (req, res) => {
  const { customerId, items: rawItems, discountType, discountValue, advance, paymentMethod, paperSize } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one item to the invoice." });
  }

  const settings = getSettingsRow();
  let customer = null;
  if (customerId) {
    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
    if (!customer) return res.status(400).json({ error: "Selected customer no longer exists." });
  }
  const taxType = (customer && customer.state && settings.state && customer.state.trim().toLowerCase() !== settings.state.trim().toLowerCase())
    ? "IGST" : "CGST_SGST";

  // Look up authoritative product data (gst rate, stock) server-side; never trust client for these.
  const qtyByProduct = {};
  const items = [];
  for (const raw of rawItems) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(raw.productId);
    if (!product) return res.status(400).json({ error: `Product ${raw.productId} no longer exists.` });
    const qty = Number(raw.qty);
    const rate = Number(raw.rate);
    if (!qty || qty <= 0) return res.status(400).json({ error: `Invalid quantity for ${product.name}.` });
    if (!(rate >= 0)) return res.status(400).json({ error: `Invalid rate for ${product.name}.` });
    qtyByProduct[product.id] = (qtyByProduct[product.id] || 0) + qty;
    items.push({ productId: product.id, name: raw.name || product.name, qty, rate, gstRate: product.gst_rate, product });
  }
  for (const [productId, qty] of Object.entries(qtyByProduct)) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
    if (qty > product.stock) {
      return res.status(400).json({ error: `Not enough stock for ${product.name}. Available: ${product.stock}.` });
    }
  }

  const totals = computeTotals({ items, discountType, discountValue, advance, taxType });
  const id = uid("INV");
  const challanNo = nextChallanNo();
  const date = todayStr();

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, challan_no, date, created_at, customer_id, subtotal, discount_type, discount_value,
      discount_amount, tax_type, cgst, sgst, igst, total, advance, balance_due, payment_method, paper_size)
    VALUES (@id, @challanNo, @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
      @discountAmount, @taxType, @cgst, @sgst, @igst, @total, @advance, @balanceDue, @paymentMethod, @paperSize)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, product_id, name, qty, rate, gst_rate) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deductStock = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?");
  const bumpDue = db.prepare("UPDATE customers SET due = due + ? WHERE id = ?");

  db.transaction(() => {
    insertInvoice.run({
      id, challanNo, date, createdAt: Date.now(), customerId: customerId || null,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: Number(discountValue) || 0, discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, total: totals.total,
      advance: totals.advance, balanceDue: totals.balanceDue,
      paymentMethod: paymentMethod || "Cash", paperSize: paperSize === "A4" ? "A4" : "A5"
    });
    items.forEach(it => insertItem.run(id, it.productId, it.name, it.qty, it.rate, it.gstRate));
    Object.entries(qtyByProduct).forEach(([productId, qty]) => deductStock.run(qty, productId));
    if (customerId && totals.balanceDue > 0) bumpDue.run(totals.balanceDue, customerId);
  })();

  logAction(req, "invoice.create", `${challanNo} — ${totals.total}`);
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  const savedItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(id);
  res.status(201).json({ ...invoice, items: savedItems });
});

router.post("/:id/void", requireRole("owner"), (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  if (inv.voided) return res.status(400).json({ error: "Invoice already voided." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);

  const restoreStock = db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?");
  const reduceDue = db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?");
  const voidInvoice = db.prepare("UPDATE invoices SET voided = 1 WHERE id = ?");

  db.transaction(() => {
    items.forEach(it => { if (it.product_id) restoreStock.run(it.qty, it.product_id); });
    if (inv.customer_id && inv.balance_due > 0) reduceDue.run(inv.balance_due, inv.customer_id);
    voidInvoice.run(inv.id);
  })();

  logAction(req, "invoice.void", `${inv.challan_no}`);
  res.json({ ok: true });
});

module.exports = router;
