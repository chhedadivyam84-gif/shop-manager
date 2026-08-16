const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
const inventory = require("../inventory");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

function shopLocationId() {
  return inventory.getLocationByCode("shop").id;
}

function nextQuotationNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("quotation-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("quotation-no", next);
  return `SQ${String(next).padStart(7, "0")}`;
}

/** Same shape as invoices.js's computeTotals, minus advance/balance since a
 *  quotation is never paid against — just "loading" renamed nowhere, kept
 *  identical field-for-field so a converted Invoice's totals match exactly. */
/* gstEnabled === false is a Non-GST quotation: no goods tax, no tax on
   transport or loading, no CGST/SGST/IGST at all — not zeroed-out fields.
   Mirrors invoices.js exactly so the quotation and the invoice it converts
   into can never disagree about what tax was promised. */
function computeTotals({ items, discountType, discountValue, taxType, transport, loading, roundOff, gstOnCharges, gstEnabled }) {
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  let discountAmount = 0;
  if (discountType === "flat") discountAmount = Number(discountValue) || 0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let goodsTax = 0;
  items.forEach(it => {
    if (gstEnabled === false) return;
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
  const ancillaryTax = (gstEnabled !== false && gstOnCharges) ? round2((transportAmt + loadingAmt) * effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst = 0, sgst = 0, igst = 0;
  if (gstEnabled !== false) {
    if (taxType === "IGST") igst = totalTax;
    else { cgst = round2(totalTax / 2); sgst = round2(totalTax - cgst); }
  }

  const preRound = subtotal - discountAmount + transportAmt + loadingAmt + cgst + sgst + igst;
  const total = round2(roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return { subtotal, discountAmount, cgst, sgst, igst, transport: transportAmt, loading: loadingAmt, roundOffAmount, total };
}

/** Same shape as purchaseOrders.js's buildItems — no stock/due side effects here. */
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

function serialize(q) {
  const items = db.prepare("SELECT * FROM quotation_items WHERE quotation_id = ?").all(q.id);
  return { ...q, items };
}

router.get("/", (req, res) => {
  const { customerId, status } = req.query;
  let rows = db.prepare("SELECT * FROM quotations ORDER BY created_at DESC").all();
  if (customerId) rows = rows.filter(q => q.customer_id === customerId);
  if (status) rows = rows.filter(q => q.status === status);
  res.json(rows);
});

/**
 * Lets the New Quotation screen show what number THIS quotation will get
 * before it's saved. Peeks the counter without incrementing it (unlike
 * nextQuotationNo() above) — an abandoned form must not burn a number and
 * leave a gap in the series. There's a small window where two staff opening
 * the screen at once could see the same "next" number, but the number
 * actually stored is only ever assigned at save time by nextQuotationNo(),
 * so no two saved quotations can ever collide.
 */
router.get("/next-number", (req, res) => {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("quotation-no");
  const next = row ? row.value + 1 : 1;
  res.json({ quotationNo: `SQ${String(next).padStart(7, "0")}` });
});

router.get("/:id", (req, res) => {
  const q = db.prepare("SELECT * FROM quotations WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  res.json(serialize(q));
});

router.post("/", (req, res) => {
  const {
    customerId, date, validUntil, saleType, discountType, discountValue,
    transport, loading, roundOff, gstOnCharges, gstEnabled, terms, remarks,
    items: rawItems, saveAsDraft
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the quotation." });
  }

  const saleTypeVal = saleType === "Interstate" ? "Interstate" : "Local";
  const taxType = saleTypeVal === "Interstate" ? "IGST" : "CGST_SGST";
  const gstOnChargesVal = gstOnCharges === false ? 0 : 1;
  const gstEnabledVal = gstEnabled === false ? 0 : 1;

  let items;
  try { items = buildItems(rawItems); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({
    items, discountType, discountValue, taxType, transport, loading, roundOff, gstOnCharges: gstOnChargesVal,
    gstEnabled: gstEnabledVal === 1
  });
  const id = uid("SQ");
  const quotationNo = nextQuotationNo();
  const qDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();
  const status = saveAsDraft ? "Draft" : "Sent";

  const insertQ = db.prepare(`
    INSERT INTO quotations (id, quotation_no, date, created_at, customer_id, valid_until, sale_type, tax_type,
      subtotal, discount_type, discount_value, discount_amount, cgst, sgst, igst, transport, loading, round_off,
      total, gst_on_charges, gst_enabled, terms, remarks, status)
    VALUES (@id, @quotationNo, @date, @createdAt, @customerId, @validUntil, @saleType, @taxType,
      @subtotal, @discountType, @discountValue, @discountAmount, @cgst, @sgst, @igst, @transport, @loading, @roundOffAmount,
      @total, @gstOnCharges, @gstEnabled, @terms, @remarks, @status)
  `);
  const insertItem = db.prepare(`
    INSERT INTO quotation_items
      (quotation_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertQ.run({
      id, quotationNo, date: qDate, createdAt: Date.now(), customerId: customerId || null,
      validUntil: (validUntil || "").trim(), saleType: saleTypeVal, taxType,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: Math.max(0, Number(discountValue) || 0), discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, roundOffAmount: totals.roundOffAmount, total: totals.total,
      gstOnCharges: gstOnChargesVal, gstEnabled: gstEnabledVal, terms: (terms || "").trim(), remarks: (remarks || "").trim(), status
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
    ));
  })();

  logAction(req, "quotation.create", `${quotationNo}: ${totals.total} (${status})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM quotations WHERE id = ?").get(id)));
});

router.put("/:id", (req, res) => {
  const q = db.prepare("SELECT * FROM quotations WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (["Converted", "Cancelled"].includes(q.status)) {
    return res.status(400).json({ error: `Can't edit a Quotation that's already ${q.status}.` });
  }

  const {
    customerId, date, validUntil, saleType, discountType, discountValue,
    transport, loading, roundOff, gstOnCharges, gstEnabled, terms, remarks,
    items: rawItems, saveAsDraft
  } = req.body;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Add at least one product to the quotation." });
  }

  const saleTypeVal = saleType === "Interstate" ? "Interstate" : "Local";
  const taxType = saleTypeVal === "Interstate" ? "IGST" : "CGST_SGST";
  const gstOnChargesVal = gstOnCharges === false ? 0 : 1;
  const gstEnabledVal = gstEnabled === false ? 0 : 1;

  let items;
  try { items = buildItems(rawItems); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({
    items, discountType, discountValue, taxType, transport, loading, roundOff, gstOnCharges: gstOnChargesVal,
    gstEnabled: gstEnabledVal === 1
  });
  const qDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : q.date;
  const status = saveAsDraft ? "Draft" : (q.status === "Draft" ? "Sent" : q.status);

  const insertItem = db.prepare(`
    INSERT INTO quotation_items
      (quotation_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM quotation_items WHERE quotation_id = ?").run(q.id);
    items.forEach(it => insertItem.run(
      q.id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate
    ));
    db.prepare(`
      UPDATE quotations SET customer_id=@customerId, date=@date, valid_until=@validUntil, sale_type=@saleType,
        tax_type=@taxType, subtotal=@subtotal, discount_type=@discountType, discount_value=@discountValue,
        discount_amount=@discountAmount, cgst=@cgst, sgst=@sgst, igst=@igst, transport=@transport, loading=@loading,
        round_off=@roundOffAmount, total=@total, gst_on_charges=@gstOnCharges, gst_enabled=@gstEnabled, terms=@terms, remarks=@remarks, status=@status
      WHERE id=@id
    `).run({
      id: q.id, customerId: customerId || null, date: qDate, validUntil: (validUntil || "").trim(),
      saleType: saleTypeVal, taxType, subtotal: totals.subtotal,
      discountType: discountType === "flat" ? "flat" : "pct", discountValue: Math.max(0, Number(discountValue) || 0),
      discountAmount: totals.discountAmount, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, roundOffAmount: totals.roundOffAmount, total: totals.total,
      gstOnCharges: gstOnChargesVal, gstEnabled: gstEnabledVal, terms: (terms || "").trim(), remarks: (remarks || "").trim(), status
    });
  })();

  logAction(req, "quotation.edit", `${q.quotation_no}`);
  res.json(serialize(db.prepare("SELECT * FROM quotations WHERE id = ?").get(q.id)));
});

/** Draft/Sent -> Accepted. The customer's sign-off that they want this. */
router.post("/:id/accept", (req, res) => {
  const q = db.prepare("SELECT * FROM quotations WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (!["Draft", "Sent"].includes(q.status)) {
    return res.status(400).json({ error: `Can't accept a Quotation that's ${q.status}.` });
  }
  db.prepare("UPDATE quotations SET status = 'Accepted' WHERE id = ?").run(q.id);
  logAction(req, "quotation.accept", `${q.quotation_no}`);
  res.json(serialize(db.prepare("SELECT * FROM quotations WHERE id = ?").get(q.id)));
});

/** Any non-final state -> Cancelled. Nothing to reverse — a quotation never touched stock or dues. */
router.post("/:id/cancel", (req, res) => {
  const q = db.prepare("SELECT * FROM quotations WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (["Converted", "Cancelled"].includes(q.status)) {
    return res.status(400).json({ error: `This Quotation is already ${q.status}.` });
  }
  db.prepare("UPDATE quotations SET status = 'Cancelled' WHERE id = ?").run(q.id);
  logAction(req, "quotation.cancel", `${q.quotation_no}`);
  res.json(serialize(db.prepare("SELECT * FROM quotations WHERE id = ?").get(q.id)));
});

/**
 * Accepted -> Converted: creates a real Tax Invoice carrying this
 * quotation's items and totals forward — deducting Shop stock and raising
 * the customer's due for the first time, exactly like invoices.js's POST /
 * does. Always a Tax Invoice, never a Delivery Challan: a challan is a
 * zero-value goods-movement document with no GST/discount/total of its own
 * (see invoices.js POST /), so converting a priced quotation into one would
 * just discard all its pricing. All-or-nothing, same as Purchase Order's convert.
 */
router.post("/:id/convert", (req, res) => {
  const q = db.prepare("SELECT * FROM quotations WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (q.status !== "Accepted") {
    return res.status(400).json({ error: "Only an Accepted Quotation can be converted to an Invoice." });
  }
  const qItems = db.prepare("SELECT * FROM quotation_items WHERE quotation_id = ?").all(q.id);
  const { paymentMethod, advance, paperSize, deliveryMan, vehicleNumber, deliveryAddress, locationId } = req.body;
  let saleLocation = shopLocationId();
  if (locationId) {
    const loc = inventory.getLocationById(locationId);
    if (loc && loc.active) saleLocation = loc.id;
  }
  const saleLocationName = inventory.getLocationById(saleLocation).name;

  // Stock check up front — refuse cleanly rather than partially deduct.
  // Honours the same Allow Negative Stock setting the billing screen does:
  // this used to be a second, harder rule of its own, so a shop that had
  // deliberately switched negative stock ON still found conversions refused.
  const allowNegative = (db.prepare("SELECT allow_negative_stock FROM settings WHERE id = 1").get() || {}).allow_negative_stock === 1;
  if (!allowNegative) {
    for (const it of qItems) {
      if (!it.size_id) continue;
      const atLocation = inventory.getStock(it.size_id, saleLocation);
      if (atLocation < it.pieces) {
        return res.status(400).json({
          error: `Can't convert — only ${atLocation} left in ${saleLocationName} stock for ${it.name} (${it.size_label}), this quotation needs ${it.pieces}. `
            + `An owner can allow this in Settings → Allow Negative Stock.`
        });
      }
    }
  }

  function nextDocNo() {
    const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("estimate-no");
    const next = row ? row.value + 1 : 1;
    db.prepare(`
      INSERT INTO counters (name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run("estimate-no", next);
    return `SP${String(next).padStart(7, "0")}`;
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
  const advanceApplied = round2(Math.min(Math.max(0, Number(advance) || 0), q.total));
  const balanceDue = round2(q.total - advanceApplied);

  const invoiceId = uid("INV");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO invoices (id, challan_no, doc_type, date, created_at, customer_id, subtotal, discount_type, discount_value,
        discount_amount, tax_type, cgst, sgst, igst, transport, loading, gst_on_charges, gst_enabled, round_off, total, advance, balance_due,
        payment_method, paper_size, delivery_man, vehicle_number, delivery_address, remarks, location_id)
      VALUES (@id, @challanNo, 'invoice', @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
        @discountAmount, @taxType, @cgst, @sgst, @igst, @transport, @loading, @gstOnCharges, @gstEnabled, @roundOffAmount, @total, @advance,
        @balanceDue, @paymentMethod, @paperSize, @deliveryMan, @vehicleNumber, @deliveryAddress, @remarks, @locationId)
    `).run({
      id: invoiceId, challanNo: nextDocNo(), date: todayStr(), createdAt: Date.now(), customerId: q.customer_id,
      subtotal: q.subtotal, discountType: q.discount_type, discountValue: q.discount_value, discountAmount: q.discount_amount,
      taxType: q.tax_type, cgst: q.cgst, sgst: q.sgst, igst: q.igst, transport: q.transport, loading: q.loading,
      gstOnCharges: q.gst_on_charges, gstEnabled: q.gst_enabled, roundOffAmount: q.round_off, total: q.total, advance: advanceApplied, balanceDue,
      paymentMethod: paymentMethod || "Cash", paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: (deliveryMan || "").trim(), vehicleNumber: (vehicleNumber || "").trim(),
      deliveryAddress: (deliveryAddress || "").trim(), remarks: `Converted from ${q.quotation_no}`,
      locationId: saleLocation
    });

    qItems.forEach(it => {
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

    if (balanceDue > 0 && q.customer_id) {
      db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(balanceDue, q.customer_id);
    }

    db.prepare("UPDATE quotations SET status = 'Converted', converted_invoice_id = ? WHERE id = ?").run(invoiceId, q.id);
  })();

  logAction(req, "quotation.convert", `${q.quotation_no} -> ${db.prepare("SELECT challan_no FROM invoices WHERE id = ?").get(invoiceId).challan_no}`);
  res.json({
    quotation: serialize(db.prepare("SELECT * FROM quotations WHERE id = ?").get(q.id)),
    invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId)
  });
});

/**
 * A Draft (never sent) can be deleted by any staff — nothing depends on it
 * yet. Any other status is a genuine hard delete, owner-only, mirroring
 * invoices.js/purchases.js's owner-only DELETE. Unlike those, a quotation
 * never touches stock or a customer's due (that only happens at "Convert to
 * Invoice"), so there's nothing to reverse first — just the row itself.
 */
router.delete("/:id", (req, res) => {
  const q = db.prepare("SELECT * FROM quotations WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (q.status !== "Draft" && !(req.session && req.session.role === "owner")) {
    return res.status(403).json({ error: "Only the owner can delete a quotation that isn't a Draft." });
  }
  db.prepare("DELETE FROM quotations WHERE id = ?").run(q.id);
  logAction(req, "quotation.delete", `${q.quotation_no}`);
  res.json({ ok: true });
});

module.exports = router;
