const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
const inventory = require("../inventory");
const docNumber = require("../docNumber");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

function shopLocationId() {
  return inventory.getLocationByCode("shop").id;
}

function nextSoNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("so-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("so-no", next);
  return `SO${String(next).padStart(7, "0")}`;
}

/** Identical shape to quotations.js's computeTotals — kept as its own copy
 *  (not shared) since Quotation and Sales Order are independent documents
 *  that happen to price the same way, matching how purchases.js and
 *  purchaseOrders.js also each keep their own copy rather than share one. */
function computeTotals({ items, discountType, discountValue, taxType, transport, loading, roundOff, gstOnCharges }) {
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  let discountAmount = 0;
  if (discountType === "flat") discountAmount = Number(discountValue) || 0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let goodsTax = 0;
  items.forEach(it => {
    const lineTotal = it.amount;
    const share = subtotal > 0 ? (lineTotal / subtotal) * discountAmount : 0;
    const taxable = Math.max(0, lineTotal - share);
    goodsTax += taxable * (it.gstRate / 100);
  });
  goodsTax = round2(goodsTax);

  const transportAmt = round2(Math.max(0, Number(transport) || 0));
  const loadingAmt = round2(Math.max(0, Number(loading) || 0));
  const taxableGoods = round2(subtotal - discountAmount);
  const effectiveRate = taxableGoods > 0 ? goodsTax / taxableGoods : 0;
  const ancillaryTax = gstOnCharges ? round2((transportAmt + loadingAmt) * effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === "IGST") igst = totalTax;
  else { cgst = round2(totalTax / 2); sgst = round2(totalTax - cgst); }

  const preRound = subtotal - discountAmount + transportAmt + loadingAmt + cgst + sgst + igst;
  const total = round2(roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return { subtotal, discountAmount, cgst, sgst, igst, transport: transportAmt, loading: loadingAmt, roundOffAmount, total };
}

function buildItems(rawItems) {
  const items = [];
  for (const raw of rawItems) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(bindId(raw.productId));
    if (!product) throw { status: 400, error: `Product ${raw.productId} no longer exists.` };
    const size = raw.sizeId != null
      ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(bindId(raw.sizeId), product.id)
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

function serialize(so) {
  const items = db.prepare("SELECT * FROM sales_order_items WHERE so_id = ?").all(so.id);
  return { ...so, items };
}

router.get("/", (req, res) => {
  const { customerId, status } = req.query;
  let rows = db.prepare("SELECT * FROM sales_orders ORDER BY created_at DESC").all();
  if (customerId) rows = rows.filter(s => s.customer_id === customerId);
  if (status) rows = rows.filter(s => s.status === status);
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const so = db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(req.params.id);
  if (!so) return res.status(404).json({ error: "Sales Order not found." });
  res.json(serialize(so));
});

router.post("/", (req, res) => {
  const {
    customerId, date, deliveryAddress, expectedDeliveryDate, saleType,
    discountType, discountValue, transport, loading, roundOff, gstOnCharges,
    remarks, items: rawItems, saveAsDraft
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the sales order." });
  }

  const saleTypeVal = saleType === "Interstate" ? "Interstate" : "Local";
  const taxType = saleTypeVal === "Interstate" ? "IGST" : "CGST_SGST";
  const gstOnChargesVal = gstOnCharges === false ? 0 : 1;

  let items;
  try { items = buildItems(rawItems); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({
    items, discountType, discountValue, taxType, transport, loading, roundOff, gstOnCharges: gstOnChargesVal
  });
  const id = uid("SO");
  const soNo = nextSoNo();
  const soDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();
  const status = saveAsDraft ? "Draft" : "Confirmed";

  const insertSo = db.prepare(`
    INSERT INTO sales_orders (id, so_no, date, created_at, customer_id, delivery_address, expected_delivery_date,
      sale_type, tax_type, subtotal, discount_type, discount_value, discount_amount, cgst, sgst, igst, transport,
      loading, round_off, total, gst_on_charges, remarks, status)
    VALUES (@id, @soNo, @date, @createdAt, @customerId, @deliveryAddress, @expectedDeliveryDate,
      @saleType, @taxType, @subtotal, @discountType, @discountValue, @discountAmount, @cgst, @sgst, @igst, @transport,
      @loading, @roundOffAmount, @total, @gstOnCharges, @remarks, @status)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sales_order_items
      (so_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertSo.run({
      id, soNo, date: soDate, createdAt: Date.now(), customerId: customerId || null,
      deliveryAddress: (deliveryAddress || "").trim(), expectedDeliveryDate: (expectedDeliveryDate || "").trim(),
      saleType: saleTypeVal, taxType,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: Math.max(0, Number(discountValue) || 0), discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, roundOffAmount: totals.roundOffAmount, total: totals.total,
      gstOnCharges: gstOnChargesVal, remarks: (remarks || "").trim(), status
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
    ));
  })();

  logAction(req, "so.create", `${soNo}: ${totals.total} (${status})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(id)));
});

router.put("/:id", (req, res) => {
  const so = db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(req.params.id);
  if (!so) return res.status(404).json({ error: "Sales Order not found." });
  if (["Converted", "Cancelled"].includes(so.status)) {
    return res.status(400).json({ error: `Can't edit a Sales Order that's already ${so.status}.` });
  }

  const {
    customerId, date, deliveryAddress, expectedDeliveryDate, saleType,
    discountType, discountValue, transport, loading, roundOff, gstOnCharges,
    remarks, items: rawItems, saveAsDraft
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the sales order." });
  }

  const saleTypeVal = saleType === "Interstate" ? "Interstate" : "Local";
  const taxType = saleTypeVal === "Interstate" ? "IGST" : "CGST_SGST";
  const gstOnChargesVal = gstOnCharges === false ? 0 : 1;

  let items;
  try { items = buildItems(rawItems); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({
    items, discountType, discountValue, taxType, transport, loading, roundOff, gstOnCharges: gstOnChargesVal
  });
  const soDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : so.date;
  const status = saveAsDraft ? "Draft" : (so.status === "Draft" ? "Confirmed" : so.status);

  const insertItem = db.prepare(`
    INSERT INTO sales_order_items
      (so_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM sales_order_items WHERE so_id = ?").run(so.id);
    items.forEach(it => insertItem.run(
      so.id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
    ));
    db.prepare(`
      UPDATE sales_orders SET customer_id=@customerId, date=@date, delivery_address=@deliveryAddress,
        expected_delivery_date=@expectedDeliveryDate, sale_type=@saleType, tax_type=@taxType,
        subtotal=@subtotal, discount_type=@discountType, discount_value=@discountValue, discount_amount=@discountAmount,
        cgst=@cgst, sgst=@sgst, igst=@igst, transport=@transport, loading=@loading,
        round_off=@roundOffAmount, total=@total, gst_on_charges=@gstOnCharges, remarks=@remarks, status=@status
      WHERE id=@id
    `).run({
      id: so.id, customerId: customerId || null, date: soDate, deliveryAddress: (deliveryAddress || "").trim(),
      expectedDeliveryDate: (expectedDeliveryDate || "").trim(), saleType: saleTypeVal, taxType,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: Math.max(0, Number(discountValue) || 0), discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, roundOffAmount: totals.roundOffAmount, total: totals.total,
      gstOnCharges: gstOnChargesVal, remarks: (remarks || "").trim(), status
    });
  })();

  logAction(req, "so.edit", `${so.so_no}`);
  res.json(serialize(db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(so.id)));
});

/** Draft -> Confirmed. Marks the order as a real commitment, not just a draft. */
router.post("/:id/confirm", (req, res) => {
  const so = db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(req.params.id);
  if (!so) return res.status(404).json({ error: "Sales Order not found." });
  if (so.status !== "Draft") {
    return res.status(400).json({ error: `Can't confirm a Sales Order that's ${so.status}.` });
  }
  db.prepare("UPDATE sales_orders SET status = 'Confirmed' WHERE id = ?").run(so.id);
  logAction(req, "so.confirm", `${so.so_no}`);
  res.json(serialize(db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(so.id)));
});

/** Any non-final state -> Cancelled. Nothing to reverse — an SO never touched stock or dues. */
router.post("/:id/cancel", (req, res) => {
  const so = db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(req.params.id);
  if (!so) return res.status(404).json({ error: "Sales Order not found." });
  if (["Converted", "Cancelled"].includes(so.status)) {
    return res.status(400).json({ error: `This Sales Order is already ${so.status}.` });
  }
  db.prepare("UPDATE sales_orders SET status = 'Cancelled' WHERE id = ?").run(so.id);
  logAction(req, "so.cancel", `${so.so_no}`);
  res.json(serialize(db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(so.id)));
});

/**
 * Confirmed -> Converted: creates a real Tax Invoice, exactly like
 * quotations.js's convert — see that file's comment for why this never
 * produces a Delivery Challan. All-or-nothing.
 */
router.post("/:id/convert", (req, res) => {
  const so = db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(req.params.id);
  if (!so) return res.status(404).json({ error: "Sales Order not found." });
  if (so.status !== "Confirmed") {
    return res.status(400).json({ error: "Only a Confirmed Sales Order can be converted to an Invoice." });
  }
  const soItems = db.prepare("SELECT * FROM sales_order_items WHERE so_id = ?").all(so.id);
  const { paymentMethod, advance, paperSize, deliveryMan, vehicleNumber, locationId } = req.body;
  let saleLocation = shopLocationId();
  if (locationId) {
    const loc = inventory.getLocationById(locationId);
    if (loc && loc.active) saleLocation = loc.id;
  }
  const saleLocationName = inventory.getLocationById(saleLocation).name;

  for (const it of soItems) {
    if (!it.size_id) continue;
    const atLocation = inventory.getStock(it.size_id, saleLocation);
    if (atLocation < it.pieces) {
      return res.status(400).json({ error: `Can't convert — only ${atLocation} left in ${saleLocationName} stock for ${it.name} (${it.size_label}), this order needs ${it.pieces}.` });
    }
  }

  /* The same engine invoices.js allocates from (server/docNumber.js).
     This used to keep a private "estimate-no" counter that never checked
     whether the number was already on an invoice, so the two numbering
     schemes drifted until they collided and the conversion died on the
     UNIQUE constraint. The engine walks past taken numbers and advances the
     shared counters, so a converted document gets the next free bill number
     exactly as a hand-written bill does. */
  function nextDocNo() {
    return docNumber.allocate("invoice");
  }

  const syncProductStockStmt = db.prepare(
    "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
  );
  const productStmt = db.prepare("SELECT code, hsn_code FROM products WHERE id = ?");
  const insertInvoiceItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, product_id, size_id, name, code, brand, hsn_code, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const advanceApplied = round2(Math.min(Math.max(0, Number(advance) || 0), so.total));
  const balanceDue = round2(so.total - advanceApplied);

  const invoiceId = uid("INV");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO invoices (id, challan_no, doc_type, date, created_at, customer_id, subtotal, discount_type, discount_value,
        discount_amount, tax_type, cgst, sgst, igst, transport, loading, gst_on_charges, round_off, total, advance, balance_due,
        payment_method, paper_size, delivery_man, vehicle_number, delivery_address, remarks, location_id)
      VALUES (@id, @challanNo, 'invoice', @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
        @discountAmount, @taxType, @cgst, @sgst, @igst, @transport, @loading, @gstOnCharges, @roundOffAmount, @total, @advance,
        @balanceDue, @paymentMethod, @paperSize, @deliveryMan, @vehicleNumber, @deliveryAddress, @remarks, @locationId)
    `).run({
      id: invoiceId, challanNo: nextDocNo(), date: todayStr(), createdAt: Date.now(), customerId: so.customer_id,
      subtotal: so.subtotal, discountType: so.discount_type, discountValue: so.discount_value, discountAmount: so.discount_amount,
      taxType: so.tax_type, cgst: so.cgst, sgst: so.sgst, igst: so.igst, transport: so.transport, loading: so.loading,
      gstOnCharges: so.gst_on_charges, roundOffAmount: so.round_off, total: so.total, advance: advanceApplied, balanceDue,
      paymentMethod: paymentMethod || "Cash", paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: (deliveryMan || "").trim(), vehicleNumber: (vehicleNumber || "").trim(),
      deliveryAddress: so.delivery_address, remarks: `Converted from ${so.so_no}`,
      locationId: saleLocation
    });

    soItems.forEach(it => {
      const product = it.product_id ? productStmt.get(it.product_id) : null;
      insertInvoiceItem.run(
        invoiceId, it.product_id, it.size_id, it.name, (product && product.code) || "", it.brand,
        (product && product.hsn_code) || "", it.mode, it.length_ft, it.width_val, it.thickness_in,
        it.size_label, it.pieces, it.per_piece, it.unit_label, it.qty, it.rate, it.gst_rate
      );
      if (it.size_id) {
        inventory.addStock(it.size_id, saleLocation, -it.pieces);
        syncProductStockStmt.run(it.product_id);
      }
    });

    if (balanceDue > 0 && so.customer_id) {
      db.prepare("UPDATE customers SET due = ROUND(due + ?, 2) WHERE id = ?").run(balanceDue, so.customer_id);
    }

    db.prepare("UPDATE sales_orders SET status = 'Converted', converted_invoice_id = ? WHERE id = ?").run(invoiceId, so.id);
  })();

  logAction(req, "so.convert", `${so.so_no} -> ${db.prepare("SELECT challan_no FROM invoices WHERE id = ?").get(invoiceId).challan_no}`);
  res.json({
    salesOrder: serialize(db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(so.id)),
    invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId)
  });
});

/** A Draft (never confirmed) can be deleted outright — nothing depends on it yet. */
router.delete("/:id", (req, res) => {
  const so = db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(req.params.id);
  if (!so) return res.status(404).json({ error: "Sales Order not found." });
  if (so.status !== "Draft") {
    return res.status(400).json({ error: "Only a Draft Sales Order can be deleted. Cancel it instead." });
  }
  db.prepare("DELETE FROM sales_orders WHERE id = ?").run(so.id);
  logAction(req, "so.delete", `${so.so_no}`);
  res.json({ ok: true });
});

module.exports = router;
