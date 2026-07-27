const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

const syncProductStockStmt = db.prepare(
  "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
);

// Own number series ("PU0000001…"), separate from sales' "SP" series, same
// ever-incrementing pattern with no year component — see invoices.js.
function nextPurchaseNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("purchase-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("purchase-no", next);
  return `PU${String(next).padStart(7, "0")}`;
}

/**
 * Mirrors invoices.js's computeTotals, but discount is PER LINE here (the
 * spec calls for a Discount column on each product row, not one overall
 * invoice-level discount) — each item already carries its resolved rupee
 * discountAmount, so this just sums rather than re-deriving a share of one
 * total discount the way the sales side does.
 */
function computeTotals({ items, taxType, transport, loading, otherCharges, roundOff }) {
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  const discountAmount = round2(items.reduce((s, it) => s + it.discountAmount, 0));

  let goodsTax = 0;
  items.forEach(it => {
    const taxable = Math.max(0, it.amount - it.discountAmount);
    goodsTax += taxable * (it.gstRate / 100);
  });
  goodsTax = round2(goodsTax);

  const transportAmt = round2(Math.max(0, Number(transport) || 0));
  const loadingAmt = round2(Math.max(0, Number(loading) || 0));
  const otherAmt = round2(Math.max(0, Number(otherCharges) || 0));

  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === "IGST") igst = goodsTax;
  else { cgst = round2(goodsTax / 2); sgst = round2(goodsTax - cgst); }

  const preRound = subtotal - discountAmount + cgst + sgst + igst + transportAmt + loadingAmt + otherAmt;
  const total = round2(roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return {
    subtotal, discountAmount, cgst, sgst, igst,
    transport: transportAmt, loading: loadingAmt, otherCharges: otherAmt,
    roundOffAmount, total
  };
}

router.get("/", (req, res) => {
  const { supplierId } = req.query;
  const rows = supplierId
    ? db.prepare("SELECT * FROM purchases WHERE supplier_id = ? AND voided = 0 ORDER BY created_at DESC").all(supplierId)
    : db.prepare("SELECT * FROM purchases WHERE voided = 0 ORDER BY created_at DESC").all();
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Purchase not found." });
  const items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
  res.json({ ...p, items });
});

router.post("/", (req, res) => {
  const {
    supplierId, supplierInvoiceNo, date, purchaseType, paymentMethod, dueDate,
    vehicleNumber, transportName, lrNumber, remarks,
    transport, loading, otherCharges, roundOff,
    items: rawItems
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the purchase." });
  }
  if (!supplierId) return res.status(400).json({ error: "Select a supplier." });
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(supplierId);
  if (!supplier) return res.status(400).json({ error: "Selected supplier no longer exists." });

  // A supplier's own invoice number only needs to be unique to THAT supplier —
  // two different suppliers can both hand you their "INV-001".
  const trimmedSupplierInvoiceNo = (supplierInvoiceNo || "").trim();
  if (trimmedSupplierInvoiceNo) {
    const dupe = db.prepare(
      "SELECT id FROM purchases WHERE supplier_id = ? AND supplier_invoice_no = ? AND voided = 0"
    ).get(supplierId, trimmedSupplierInvoiceNo);
    if (dupe) {
      return res.status(400).json({ error: `Invoice #${trimmedSupplierInvoiceNo} has already been recorded for ${supplier.name}.` });
    }
  }

  // Purchase Type is this form's explicit choice (Local/Interstate), same
  // role as the GST Type override on Sales — defaults from the supplier's
  // own Customer-Master-style gst_type when not given, but this form's
  // choice is what actually gets stored, not silently re-derived from state
  // text.
  const purchaseTypeVal = purchaseType === "Interstate" ? "Interstate" : "Local";
  const taxType = purchaseTypeVal === "Interstate" ? "IGST" : "CGST_SGST";

  const piecesBySize = {};
  const items = [];
  for (const raw of rawItems) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(raw.productId);
    if (!product) return res.status(400).json({ error: `Product ${raw.productId} no longer exists.` });
    const size = raw.sizeId != null
      ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(raw.sizeId, product.id)
      : null;
    if (!size) return res.status(400).json({ error: `Choose a size for ${product.name}.` });

    const line = {
      mode: Pricing.normaliseMode(raw.mode),
      lengthFt: raw.lengthFt, widthVal: raw.widthVal, thicknessIn: raw.thicknessIn,
      pieces: raw.pieces, rate: raw.rate
    };
    const invalid = Pricing.validateLine(line, `${product.name} (${size.label})`);
    if (invalid) return res.status(400).json({ error: invalid });

    const calc = Pricing.computeLine(line);
    const discountType = raw.discountType === "flat" ? "flat" : "pct";
    const discountValue = Math.max(0, Number(raw.discountValue) || 0);
    let discountAmount = discountType === "flat" ? discountValue : calc.amount * (Math.min(100, discountValue) / 100);
    discountAmount = round2(Math.min(Math.max(0, discountAmount), calc.amount));

    piecesBySize[size.id] = (piecesBySize[size.id] || 0) + calc.pieces;
    items.push({
      productId: product.id, sizeId: size.id, name: raw.name || product.name,
      brand: product.brand || "", category: product.category || "",
      gstRate: raw.gstRate != null ? Number(raw.gstRate) : product.gst_rate,
      discountAmount, ...calc
    });
  }

  const totals = computeTotals({ items, taxType, transport, loading, otherCharges, roundOff });
  const id = uid("PUR");
  const purchaseNo = nextPurchaseNo();
  const purchaseDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();

  const insertPurchase = db.prepare(`
    INSERT INTO purchases (id, purchase_no, date, created_at, supplier_id, supplier_invoice_no,
      purchase_type, tax_type, subtotal, discount_amount, cgst, sgst, igst, transport, loading,
      other_charges, round_off, total, payment_method, due_date, vehicle_number, transport_name,
      lr_number, remarks, voided)
    VALUES (@id, @purchaseNo, @date, @createdAt, @supplierId, @supplierInvoiceNo,
      @purchaseType, @taxType, @subtotal, @discountAmount, @cgst, @sgst, @igst, @transport, @loading,
      @otherCharges, @roundOffAmount, @total, @paymentMethod, @dueDate, @vehicleNumber, @transportName,
      @lrNumber, @remarks, 0)
  `);
  const insertItem = db.prepare(`
    INSERT INTO purchase_items
      (purchase_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addStock = db.prepare("UPDATE product_sizes SET stock = stock + ? WHERE id = ?");
  const bumpDue = db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?");

  db.transaction(() => {
    insertPurchase.run({
      id, purchaseNo, date: purchaseDate, createdAt: Date.now(), supplierId,
      supplierInvoiceNo: trimmedSupplierInvoiceNo, purchaseType: purchaseTypeVal, taxType,
      subtotal: totals.subtotal, discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, otherCharges: totals.otherCharges,
      roundOffAmount: totals.roundOffAmount, total: totals.total,
      paymentMethod: paymentMethod || "Credit", dueDate: (dueDate || "").trim(),
      vehicleNumber: (vehicleNumber || "").trim(), transportName: (transportName || "").trim(),
      lrNumber: (lrNumber || "").trim(), remarks: (remarks || "").trim()
    });

    const touchedProducts = new Set();
    items.forEach(it => {
      insertItem.run(
        id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
        it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
        it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
      );
      touchedProducts.add(it.productId);
    });
    Object.entries(piecesBySize).forEach(([sizeId, pieces]) => addStock.run(pieces, sizeId));
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    // Only Credit leaves a payable balance — Cash/UPI/Bank are settled at the
    // moment of purchase, same as how a Sales invoice's payment method works.
    if ((paymentMethod || "Credit") === "Credit") bumpDue.run(totals.total, supplierId);
  })();

  logAction(req, "purchase.create", `${purchaseNo}: ${supplier.name} — ${totals.total}`);
  const saved = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id);
  const savedItems = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(id);
  res.status(201).json({ ...saved, items: savedItems });
});

module.exports = router;
