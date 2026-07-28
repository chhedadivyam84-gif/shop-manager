const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const inventory = require("../inventory");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

function nextPoNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("po-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("po-no", next);
  return `PO${String(next).padStart(7, "0")}`;
}

/** Mirrors purchases.js's computeTotals exactly, just "freight" instead of "transport". */
function computeTotals({ items, taxType, freight, otherCharges, roundOff }) {
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  const discountAmount = round2(items.reduce((s, it) => s + it.discountAmount, 0));

  let goodsTax = 0;
  items.forEach(it => {
    const taxable = Math.max(0, it.amount - it.discountAmount);
    goodsTax += taxable * (it.gstRate / 100);
  });
  goodsTax = round2(goodsTax);

  const freightAmt = round2(Math.max(0, Number(freight) || 0));
  const otherAmt = round2(Math.max(0, Number(otherCharges) || 0));

  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === "IGST") igst = goodsTax;
  else { cgst = round2(goodsTax / 2); sgst = round2(goodsTax - cgst); }

  const preRound = subtotal - discountAmount + cgst + sgst + igst + freightAmt + otherAmt;
  const total = round2(roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return { subtotal, discountAmount, cgst, sgst, igst, freight: freightAmt, otherCharges: otherAmt, roundOffAmount, total };
}

/** Shared item-build/validate — identical shape to purchases.js, no stock/due side effects here. */
function buildItems(rawItems) {
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

    items.push({
      productId: product.id, sizeId: size.id, name: raw.name || product.name,
      brand: product.brand || "", category: product.category || "",
      gstRate: raw.gstRate != null ? Number(raw.gstRate) : product.gst_rate,
      discountAmount, ...calc
    });
  }
  return items;
}

function serialize(po) {
  const items = db.prepare("SELECT * FROM purchase_order_items WHERE po_id = ?").all(po.id);
  return { ...po, items };
}

router.get("/", (req, res) => {
  const { supplierId, status } = req.query;
  let rows = db.prepare("SELECT * FROM purchase_orders ORDER BY created_at DESC").all();
  if (supplierId) rows = rows.filter(p => p.supplier_id === supplierId);
  if (status) rows = rows.filter(p => p.status === status);
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  res.json(serialize(po));
});

router.post("/", (req, res) => {
  const {
    supplierId, date, deliveryAddress, expectedDeliveryDate, purchaseType,
    freight, otherCharges, roundOff, paymentTerms, deliveryTerms, remarks,
    items: rawItems, saveAsDraft
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the purchase order." });
  }
  if (!supplierId) return res.status(400).json({ error: "Select a supplier." });
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(supplierId);
  if (!supplier) return res.status(400).json({ error: "Selected supplier no longer exists." });

  const purchaseTypeVal = purchaseType === "Interstate" ? "Interstate" : "Local";
  const taxType = purchaseTypeVal === "Interstate" ? "IGST" : "CGST_SGST";

  let items;
  try { items = buildItems(rawItems); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({ items, taxType, freight, otherCharges, roundOff });
  const id = uid("PO");
  const poNo = nextPoNo();
  const poDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();
  // Save Draft keeps it editable and un-submitted; a plain Save moves it to
  // Pending — awaiting the owner's Approve action, mirroring the spec's
  // "Save Draft" vs implicit-submit action pair.
  const status = saveAsDraft ? "Draft" : "Pending";

  const insertPo = db.prepare(`
    INSERT INTO purchase_orders (id, po_no, date, created_at, supplier_id, delivery_address, expected_delivery_date,
      purchase_type, tax_type, subtotal, discount_amount, cgst, sgst, igst, freight, other_charges, round_off, total,
      payment_terms, delivery_terms, remarks, status)
    VALUES (@id, @poNo, @date, @createdAt, @supplierId, @deliveryAddress, @expectedDeliveryDate,
      @purchaseType, @taxType, @subtotal, @discountAmount, @cgst, @sgst, @igst, @freight, @otherCharges, @roundOffAmount, @total,
      @paymentTerms, @deliveryTerms, @remarks, @status)
  `);
  const insertItem = db.prepare(`
    INSERT INTO purchase_order_items
      (po_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertPo.run({
      id, poNo, date: poDate, createdAt: Date.now(), supplierId,
      deliveryAddress: (deliveryAddress || "").trim(), expectedDeliveryDate: (expectedDeliveryDate || "").trim(),
      purchaseType: purchaseTypeVal, taxType,
      subtotal: totals.subtotal, discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      freight: totals.freight, otherCharges: totals.otherCharges, roundOffAmount: totals.roundOffAmount, total: totals.total,
      paymentTerms: (paymentTerms || "").trim(), deliveryTerms: (deliveryTerms || "").trim(), remarks: (remarks || "").trim(),
      status
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
    ));
  })();

  logAction(req, "po.create", `${poNo}: ${supplier.name} — ${totals.total} (${status})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id)));
});

router.put("/:id", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  if (["Approved", "Completed", "Cancelled"].includes(po.status)) {
    return res.status(400).json({ error: `Can't edit a Purchase Order that's already ${po.status}.` });
  }

  const {
    supplierId, date, deliveryAddress, expectedDeliveryDate, purchaseType,
    freight, otherCharges, roundOff, paymentTerms, deliveryTerms, remarks,
    items: rawItems, saveAsDraft
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the purchase order." });
  }
  if (!supplierId) return res.status(400).json({ error: "Select a supplier." });
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(supplierId);
  if (!supplier) return res.status(400).json({ error: "Selected supplier no longer exists." });

  const purchaseTypeVal = purchaseType === "Interstate" ? "Interstate" : "Local";
  const taxType = purchaseTypeVal === "Interstate" ? "IGST" : "CGST_SGST";

  let items;
  try { items = buildItems(rawItems); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({ items, taxType, freight, otherCharges, roundOff });
  const poDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : po.date;
  const status = saveAsDraft ? "Draft" : "Pending";

  const insertItem = db.prepare(`
    INSERT INTO purchase_order_items
      (po_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM purchase_order_items WHERE po_id = ?").run(po.id);
    items.forEach(it => insertItem.run(
      po.id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
    ));
    db.prepare(`
      UPDATE purchase_orders SET supplier_id=@supplierId, date=@date, delivery_address=@deliveryAddress,
        expected_delivery_date=@expectedDeliveryDate, purchase_type=@purchaseType, tax_type=@taxType,
        subtotal=@subtotal, discount_amount=@discountAmount, cgst=@cgst, sgst=@sgst, igst=@igst,
        freight=@freight, other_charges=@otherCharges, round_off=@roundOffAmount, total=@total,
        payment_terms=@paymentTerms, delivery_terms=@deliveryTerms, remarks=@remarks, status=@status
      WHERE id=@id
    `).run({
      id: po.id, supplierId, date: poDate, deliveryAddress: (deliveryAddress || "").trim(),
      expectedDeliveryDate: (expectedDeliveryDate || "").trim(), purchaseType: purchaseTypeVal, taxType,
      subtotal: totals.subtotal, discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      freight: totals.freight, otherCharges: totals.otherCharges, roundOffAmount: totals.roundOffAmount, total: totals.total,
      paymentTerms: (paymentTerms || "").trim(), deliveryTerms: (deliveryTerms || "").trim(), remarks: (remarks || "").trim(),
      status
    });
  })();

  logAction(req, "po.edit", `${po.po_no}`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id)));
});

/** Draft or Pending -> Approved. The owner's sign-off that this order is real. */
router.post("/:id/approve", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  if (!["Draft", "Pending"].includes(po.status)) {
    return res.status(400).json({ error: `Can't approve a Purchase Order that's ${po.status}.` });
  }
  db.prepare("UPDATE purchase_orders SET status = 'Approved' WHERE id = ?").run(po.id);
  logAction(req, "po.approve", `${po.po_no}`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id)));
});

/** Any non-final state -> Cancelled. Nothing to reverse — a PO never touched stock or dues. */
router.post("/:id/close", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  if (["Completed", "Cancelled"].includes(po.status)) {
    return res.status(400).json({ error: `This Purchase Order is already ${po.status}.` });
  }
  db.prepare("UPDATE purchase_orders SET status = 'Cancelled' WHERE id = ?").run(po.id);
  logAction(req, "po.cancel", `${po.po_no}`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id)));
});

/**
 * Approved -> Completed: creates a real Purchase Entry (purchases +
 * purchase_items, exactly the shape server/routes/purchases.js's POST /
 * builds) carrying this PO's items and totals forward, adjusting stock and
 * the supplier's due for the first time — nothing on a PO touches either
 * before this point. This is an all-or-nothing conversion for now: every
 * line converts in full, so "Partially Completed" is not produced by this
 * route (it would need per-line received-quantity tracking, not built yet).
 */
router.post("/:id/convert", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  if (po.status !== "Approved") {
    return res.status(400).json({ error: "Only an Approved Purchase Order can be converted to a Purchase Entry." });
  }
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(po.supplier_id);
  if (!supplier) return res.status(400).json({ error: "This Purchase Order's supplier no longer exists." });
  const poItems = db.prepare("SELECT * FROM purchase_order_items WHERE po_id = ?").all(po.id);

  const { paymentMethod, dueDate, vehicleNumber, transportName, lrNumber, supplierInvoiceNo, locationId } = req.body;
  // Same default as a direct New Purchase — Warehouse unless staff picks
  // another active location for where these goods actually landed.
  const targetLocation = inventory.getLocationById(locationId);
  const resolvedLocationId = (targetLocation && targetLocation.active) ? targetLocation.id : inventory.getLocationByCode("warehouse").id;

  const syncProductStockStmt = db.prepare(
    "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
  );
  const insertPurchaseItem = db.prepare(`
    INSERT INTO purchase_items
      (purchase_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bumpDue = db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?");

  function nextPurchaseNo() {
    const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("purchase-no");
    const next = row ? row.value + 1 : 1;
    db.prepare(`
      INSERT INTO counters (name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run("purchase-no", next);
    return `PU${String(next).padStart(7, "0")}`;
  }

  const purchaseId = uid("PUR");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO purchases (id, purchase_no, date, created_at, supplier_id, supplier_invoice_no,
        purchase_type, tax_type, subtotal, discount_amount, cgst, sgst, igst, transport, loading,
        other_charges, round_off, total, payment_method, due_date, vehicle_number, transport_name,
        lr_number, remarks, voided, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      purchaseId, nextPurchaseNo(), todayStr(), Date.now(), po.supplier_id, (supplierInvoiceNo || "").trim(),
      po.purchase_type, po.tax_type, po.subtotal, po.discount_amount, po.cgst, po.sgst, po.igst,
      po.other_charges, po.round_off, po.total, paymentMethod || "Credit", (dueDate || "").trim(),
      (vehicleNumber || "").trim(), (transportName || "").trim(), (lrNumber || "").trim(),
      `Converted from ${po.po_no}`, resolvedLocationId
    );

    const touchedProducts = new Set();
    const piecesBySize = {};
    poItems.forEach(it => {
      insertPurchaseItem.run(
        purchaseId, it.product_id, it.size_id, it.name, it.brand, it.category, it.mode,
        it.length_ft, it.width_val, it.thickness_in, it.size_label, it.pieces, it.per_piece,
        it.unit_label, it.qty, it.rate, it.discount_amount, it.gst_rate
      );
      if (it.size_id) {
        piecesBySize[it.size_id] = (piecesBySize[it.size_id] || 0) + it.pieces;
        touchedProducts.add(it.product_id);
      }
    });
    Object.entries(piecesBySize).forEach(([sizeId, pieces]) => inventory.addStock(Number(sizeId), resolvedLocationId, pieces));
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
    if ((paymentMethod || "Credit") === "Credit") bumpDue.run(po.total, po.supplier_id);

    db.prepare("UPDATE purchase_orders SET status = 'Completed', converted_purchase_id = ? WHERE id = ?").run(purchaseId, po.id);
  })();

  logAction(req, "po.convert", `${po.po_no} -> ${db.prepare("SELECT purchase_no FROM purchases WHERE id = ?").get(purchaseId).purchase_no}`);
  res.json({
    po: serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id)),
    purchase: db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId)
  });
});

/** A Draft (never submitted) can be deleted outright — nothing depends on it yet. */
router.delete("/:id", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  if (po.status !== "Draft") {
    return res.status(400).json({ error: "Only a Draft Purchase Order can be deleted. Use Close/Cancel for others." });
  }
  db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(po.id);
  logAction(req, "po.delete", `${po.po_no}`);
  res.json({ ok: true });
});

module.exports = router;
