const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");
// Same module the browser loads — see public/js/pricing.js for why it is shared.
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

function getSettingsRow() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

// Tax invoices and delivery challans run on SEPARATE number series, so each has
// its own clean, gap-free sequence (CH-2026-0001…, DC-2026-0001…). Mixing them
// would leave holes in both, which looks wrong to a customer or an auditor.
function nextDocNo(docType) {
  const year = new Date().getFullYear();
  const isChallan = docType === "challan";
  const counterName = `${isChallan ? "deliverychallan" : "challan"}-${year}`;
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(counterName);
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(counterName, next);
  return `${isChallan ? "DC" : "CH"}-${year}-${String(next).padStart(4, "0")}`;
}

function computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff }) {
  // `it.amount` is already (rounded billed qty × rate) from the shared pricing
  // module — summing that rather than recomputing keeps the invoice's line
  // amounts and its subtotal in exact agreement.
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  let discountAmount = 0;
  if (discountType === "flat") discountAmount = Number(discountValue) || 0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let totalTax = 0;
  const itemTax = items.map(it => {
    const lineTotal = it.amount;
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

  // Freight and labour are recovered at cost and are not part of the taxable
  // supply, so they are added after GST rather than before it.
  const transportAmt = round2(Math.max(0, Number(transport) || 0));
  const loadingAmt = round2(Math.max(0, Number(loading) || 0));

  const preRound = subtotal - discountAmount + cgst + sgst + igst + transportAmt + loadingAmt;
  const total = round2(roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  const advanceApplied = round2(Math.min(Math.max(0, Number(advance) || 0), total));
  const balanceDue = round2(total - advanceApplied);

  return {
    subtotal, discountAmount, cgst, sgst, igst,
    transport: transportAmt, loading: loadingAmt, roundOffAmount,
    total, advance: advanceApplied, balanceDue, itemTax
  };
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
  const { customerId, items: rawItems, discountType, discountValue, advance,
          paymentMethod, paperSize, transport, loading, roundOff } = req.body;
  const docType = req.body.docType === "challan" ? "challan" : "invoice";
  const isChallan = docType === "challan";

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: `Add at least one item to the ${isChallan ? "challan" : "invoice"}.` });
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
  //
  // The billed quantity is likewise RECOMPUTED here from the raw geometry
  // rather than taken from the request. The browser sends length/width/
  // thickness/sheets; a client that posted its own `qty` could otherwise bill
  // 320 sq.ft while only drawing 1 sheet out of stock.
  const piecesByProduct = {};
  const items = [];
  for (const raw of rawItems) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(raw.productId);
    if (!product) return res.status(400).json({ error: `Product ${raw.productId} no longer exists.` });

    const line = {
      mode: Pricing.normaliseMode(raw.mode),
      lengthFt: raw.lengthFt,
      widthVal: raw.widthVal,
      thicknessIn: raw.thicknessIn,
      pieces: raw.pieces,
      rate: raw.rate
    };
    const invalid = Pricing.validateLine(line, product.name);
    if (invalid) return res.status(400).json({ error: invalid });

    const calc = Pricing.computeLine(line);
    piecesByProduct[product.id] = (piecesByProduct[product.id] || 0) + calc.pieces;
    items.push({
      productId: product.id,
      name: raw.name || product.name,
      gstRate: product.gst_rate,
      product,
      ...calc
    });
  }
  for (const [productId, pieces] of Object.entries(piecesByProduct)) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
    if (pieces > product.stock) {
      return res.status(400).json({
        error: `Not enough stock for ${product.name}. Available: ${product.stock} ${product.unit || "Pc"}, needed: ${pieces}.`
      });
    }
  }

  // A delivery challan carries no money at all — every monetary field is zero,
  // regardless of anything the client sent. Stock still moves (handled below),
  // but nothing is added to the customer's due.
  const zeroTotals = {
    subtotal: 0, discountAmount: 0, cgst: 0, sgst: 0, igst: 0,
    transport: 0, loading: 0, roundOffAmount: 0, total: 0, advance: 0, balanceDue: 0
  };
  const totals = isChallan
    ? zeroTotals
    : computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff });
  const id = uid(isChallan ? "DC" : "INV");
  const challanNo = nextDocNo(docType);
  const date = todayStr();

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, challan_no, doc_type, date, created_at, customer_id, subtotal, discount_type, discount_value,
      discount_amount, tax_type, cgst, sgst, igst, transport, loading, round_off, total, advance, balance_due,
      payment_method, paper_size)
    VALUES (@id, @challanNo, @docType, @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
      @discountAmount, @taxType, @cgst, @sgst, @igst, @transport, @loading, @roundOffAmount, @total, @advance,
      @balanceDue, @paymentMethod, @paperSize)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, product_id, name, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deductStock = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?");
  const bumpDue = db.prepare("UPDATE customers SET due = due + ? WHERE id = ?");

  db.transaction(() => {
    insertInvoice.run({
      id, challanNo, docType, date, createdAt: Date.now(), customerId: customerId || null,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: isChallan ? 0 : (Number(discountValue) || 0), discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, roundOffAmount: totals.roundOffAmount,
      total: totals.total, advance: totals.advance, balanceDue: totals.balanceDue,
      // A challan has no tender; store a dash rather than a misleading "Cash".
      paymentMethod: isChallan ? "—" : (paymentMethod || "Cash"),
      paperSize: paperSize === "A4" ? "A4" : "A5"
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.name, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit,
      // A challan's item RATE is now kept (optional, defaults 0) so the print
      // screen can offer "Delivery Challan (With Rate)" — but the invoice-level
      // GST/discount/transport/total above stays zero either way: a challan is
      // never a tax invoice regardless of whether a rate was noted per line.
      it.billedQty, it.rate, it.gstRate
    ));
    // Stock moves in pieces, not in billed area/length/volume — for a challan
    // too, since the goods physically leave the shop.
    Object.entries(piecesByProduct).forEach(([productId, pieces]) => deductStock.run(pieces, productId));
    if (customerId && totals.balanceDue > 0) bumpDue.run(totals.balanceDue, customerId);
  })();

  logAction(req, isChallan ? "challan.create" : "invoice.create",
    isChallan ? challanNo : `${challanNo} — ${totals.total}`);
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
    // Restore the physical piece count, NOT `qty` — on an area-priced line qty
    // is a sq.ft figure and would put hundreds of phantom sheets into stock.
    items.forEach(it => { if (it.product_id) restoreStock.run(it.pieces, it.product_id); });
    if (inv.customer_id && inv.balance_due > 0) reduceDue.run(inv.balance_due, inv.customer_id);
    voidInvoice.run(inv.id);
  })();

  logAction(req, "invoice.void", `${inv.challan_no}`);
  res.json({ ok: true });
});

module.exports = router;
