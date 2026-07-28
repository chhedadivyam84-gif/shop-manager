const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

const syncProductStockStmt = db.prepare(
  "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
);

/** A UNIT-mode line has no size_label, so this only appends the parens when there's one to show. */
function itemLabel(it) {
  return it.size_label ? `${it.name} (${it.size_label})` : it.name;
}

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

/**
 * Status Tracking — automatic, derived (see the matching deriveDocStatus() in
 * invoices.js for the full reasoning). Purchases only track an aggregate due
 * on the SUPPLIER, not a paid amount per purchase, so "Partially Completed"
 * can't be honestly derived here — attributing a supplier-level payment to
 * one specific purchase would be a guess, and a wrong one is worse than no
 * label at all. A Credit purchase is Pending until it's Cash/UPI/Bank
 * (settled at purchase time) or voided.
 */
function derivePurchaseStatus(p) {
  if (p.voided) return "Cancelled";
  return p.payment_method === "Credit" ? "Pending" : "Completed";
}
function withStatus(p) { return { ...p, status: derivePurchaseStatus(p) }; }

router.get("/", (req, res) => {
  const { supplierId } = req.query;
  const rows = supplierId
    ? db.prepare("SELECT * FROM purchases WHERE supplier_id = ? AND voided = 0 ORDER BY created_at DESC").all(supplierId)
    : db.prepare("SELECT * FROM purchases WHERE voided = 0 ORDER BY created_at DESC").all();
  res.json(rows.map(withStatus));
});

router.get("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Purchase not found." });
  const items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
  res.json({ ...withStatus(p), items });
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
  res.status(201).json({ ...withStatus(saved), items: savedItems });
});

/**
 * Full edit: reverses the OLD stock/due impact, then applies the NEW one —
 * mirrors invoices.js's PUT /:id exactly. There's no batch/lot tracking
 * linking a specific purchase to a specific later sale, so "has this stock
 * already left" is checked the only way available: if reversing would drive
 * a size's stock negative, at least some of what this purchase brought in
 * has since gone out, and the edit is refused rather than corrupting stock.
 */
router.put("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Purchase not found." });
  if (p.voided) return res.status(400).json({ error: "Cannot edit a voided purchase." });

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

  const trimmedSupplierInvoiceNo = (supplierInvoiceNo || "").trim();
  if (trimmedSupplierInvoiceNo) {
    const dupe = db.prepare(
      "SELECT id FROM purchases WHERE supplier_id = ? AND supplier_invoice_no = ? AND voided = 0 AND id != ?"
    ).get(supplierId, trimmedSupplierInvoiceNo, p.id);
    if (dupe) {
      return res.status(400).json({ error: `Invoice #${trimmedSupplierInvoiceNo} has already been recorded for ${supplier.name}.` });
    }
  }

  const purchaseTypeVal = purchaseType === "Interstate" ? "Interstate" : "Local";
  const taxType = purchaseTypeVal === "Interstate" ? "IGST" : "CGST_SGST";

  const oldItems = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
  const insertItem = db.prepare(`
    INSERT INTO purchase_items
      (purchase_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addStock = db.prepare("UPDATE product_sizes SET stock = stock + ? WHERE id = ?");
  const takeStock = db.prepare("UPDATE product_sizes SET stock = stock - ? WHERE id = ?");
  const bumpDue = db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?");
  const reduceDue = db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?");

  const runEdit = db.transaction(() => {
    const touchedProducts = new Set();

    // 1. Reverse the OLD stock impact — checked first, before touching
    //    anything, so a blocked edit leaves the purchase exactly as it was.
    oldItems.forEach(it => {
      const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(it.size_id);
      if (size && size.stock < it.pieces) {
        throw { status: 400, error: `Can't edit this purchase — ${itemLabel(it)} stock has already been used elsewhere (only ${size.stock} left, this purchase added ${it.pieces}).` };
      }
    });
    oldItems.forEach(it => {
      takeStock.run(it.pieces, it.size_id);
      touchedProducts.add(it.product_id);
    });

    // 2. Reverse the OLD supplier's due (only Credit purchases carried one).
    if (p.payment_method === "Credit") reduceDue.run(p.total, p.supplier_id);

    // 3. Build + validate the NEW items — identical logic to POST / above.
    const piecesBySize = {};
    const items = [];
    for (const raw of rawItems) {
      const product = db.prepare("SELECT * FROM products WHERE id = ?").get(raw.productId);
      if (!product) throw { status: 400, error: `Product ${raw.productId} no longer exists.` };
      const size = raw.sizeId != null
        ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(raw.sizeId, product.id)
        : null;
      if (!size) throw { status: 400, error: `Choose a size for ${product.name}.` };

      const line = {
        mode: Pricing.normaliseMode(raw.mode),
        lengthFt: raw.lengthFt, widthVal: raw.widthVal, thicknessIn: raw.thicknessIn,
        pieces: raw.pieces, rate: raw.rate
      };
      const invalid = Pricing.validateLine(line, `${product.name} (${size.label})`);
      if (invalid) throw { status: 400, error: invalid };

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
    const purchaseDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : p.date;

    // 4. Replace the line items.
    db.prepare("DELETE FROM purchase_items WHERE purchase_id = ?").run(p.id);
    items.forEach(it => {
      insertItem.run(
        p.id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
        it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
        it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
      );
      touchedProducts.add(it.productId);
    });

    // 5. Apply stock for the NEW items and resync affected product totals.
    Object.entries(piecesBySize).forEach(([sizeId, pieces]) => addStock.run(pieces, sizeId));
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    // 6. Update the purchase row itself — purchase_no/created_at are never
    //    touched here, only content and money fields.
    db.prepare(`
      UPDATE purchases SET supplier_id=@supplierId, supplier_invoice_no=@supplierInvoiceNo, date=@date,
        purchase_type=@purchaseType, tax_type=@taxType, subtotal=@subtotal, discount_amount=@discountAmount,
        cgst=@cgst, sgst=@sgst, igst=@igst, transport=@transport, loading=@loading, other_charges=@otherCharges,
        round_off=@roundOffAmount, total=@total, payment_method=@paymentMethod, due_date=@dueDate,
        vehicle_number=@vehicleNumber, transport_name=@transportName, lr_number=@lrNumber, remarks=@remarks
      WHERE id=@id
    `).run({
      id: p.id, supplierId, supplierInvoiceNo: trimmedSupplierInvoiceNo, date: purchaseDate,
      purchaseType: purchaseTypeVal, taxType, subtotal: totals.subtotal, discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, transport: totals.transport, loading: totals.loading,
      otherCharges: totals.otherCharges, roundOffAmount: totals.roundOffAmount, total: totals.total,
      paymentMethod: paymentMethod || "Credit", dueDate: (dueDate || "").trim(),
      vehicleNumber: (vehicleNumber || "").trim(), transportName: (transportName || "").trim(),
      lrNumber: (lrNumber || "").trim(), remarks: (remarks || "").trim()
    });

    // 7. Bump the (possibly new) supplier's due, only if Credit.
    if ((paymentMethod || "Credit") === "Credit") bumpDue.run(totals.total, supplierId);
  });

  try {
    runEdit();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "purchase.edit", `${p.purchase_no}`);
  const updated = db.prepare("SELECT * FROM purchases WHERE id = ?").get(p.id);
  const savedItems = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
  res.json({ ...withStatus(updated), items: savedItems });
});

/**
 * Void: the safe, non-destructive reversal — reverses stock/due exactly like
 * an edit's "old side" does, then flags the row rather than removing it, so
 * the PU number sequence stays intact for audit purposes. Same
 * already-used-elsewhere guard as edit.
 */
router.post("/:id/void", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Purchase not found." });
  if (p.voided) return res.status(400).json({ error: "Purchase already voided." });
  const items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);

  const reduceDue = db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?");

  const runVoid = db.transaction(() => {
    const touchedProducts = new Set();
    items.forEach(it => {
      const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(it.size_id);
      if (size && size.stock < it.pieces) {
        throw { status: 400, error: `Can't void this purchase — ${itemLabel(it)} stock has already been used elsewhere (only ${size.stock} left, this purchase added ${it.pieces}).` };
      }
    });
    items.forEach(it => {
      db.prepare("UPDATE product_sizes SET stock = stock - ? WHERE id = ?").run(it.pieces, it.size_id);
      touchedProducts.add(it.product_id);
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
    if (p.payment_method === "Credit") reduceDue.run(p.total, p.supplier_id);
    db.prepare("UPDATE purchases SET voided = 1 WHERE id = ?").run(p.id);
  });

  try {
    runVoid();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "purchase.void", `${p.purchase_no}`);
  res.json({ ok: true });
});

/**
 * Genuine hard delete, owner-only — reverses stock/due exactly like Void
 * (skipped if already voided, since that reversal already happened), then
 * actually removes the row and cascades to purchase_items. Leaves a gap in
 * the PU number sequence, which is why Void exists as the default choice;
 * this is for a purchase entered by mistake that should never have existed.
 */
router.delete("/:id", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Purchase not found." });
  const items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
  const reduceDue = db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?");

  const runDelete = db.transaction(() => {
    if (!p.voided) {
      const touchedProducts = new Set();
      items.forEach(it => {
        const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(it.size_id);
        if (size && size.stock < it.pieces) {
          throw { status: 400, error: `Can't delete this purchase — ${itemLabel(it)} stock has already been used elsewhere (only ${size.stock} left, this purchase added ${it.pieces}). Void it after correcting stock, or edit it instead.` };
        }
      });
      items.forEach(it => {
        db.prepare("UPDATE product_sizes SET stock = stock - ? WHERE id = ?").run(it.pieces, it.size_id);
        touchedProducts.add(it.product_id);
      });
      touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
      if (p.payment_method === "Credit") reduceDue.run(p.total, p.supplier_id);
    }
    db.prepare("DELETE FROM purchases WHERE id = ?").run(p.id);
  });

  try {
    runDelete();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "purchase.delete", `${p.purchase_no}`);
  res.json({ ok: true });
});

module.exports = router;
