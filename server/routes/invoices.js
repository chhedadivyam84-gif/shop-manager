const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");
// Same module the browser loads — see public/js/pricing.js for why it is shared.
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

function getSettingsRow() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

// A sale defaults to deducting Shop stock, but staff can pick Warehouse
// instead per-document (requirement: "sale to warehouse") — mirrors
// purchases.js's resolveLocationId, just defaulting to Shop instead of
// Warehouse, since Shop was every invoice's only option before this existed.
function shopLocationId() {
  return inventory.getLocationByCode("shop").id;
}
function resolveLocationId(requestedId) {
  if (requestedId) {
    const loc = inventory.getLocationById(requestedId);
    if (loc && loc.active) return loc.id;
  }
  return shopLocationId();
}

// Stock lives on product_sizes; products.stock is kept as a denormalised sum
// so the many places that still read the product-level total (reports,
// inventory list, low-stock check) don't need rewriting to aggregate live.
// Same statement used from create/void/delete below, one definition.
const syncProductStockStmt = db.prepare(
  "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
);

// Tax invoices and delivery challans run on SEPARATE number series — each on
// its own counter, so neither ever has a gap caused by the other — but both
// now use the SAME "SP" + 7-digit format (SP0000001…), ever-incrementing with
// no year component. Because the two series can independently land on the
// same literal number (an Estimate and a Challan can both be "SP0000005" at
// once), the printed document banner (ESTIMATE CHALLAN vs DELIVERY CHALLAN)
// is what actually tells them apart — the number alone does not.
function nextDocNo(docType) {
  const counterName = docType === "challan" ? "challan-no" : "estimate-no";
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(counterName);
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(counterName, next);
  return `SP${String(next).padStart(7, "0")}`;
}

function computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff, gstOnCharges }) {
  // `it.amount` is already (rounded billed qty × rate) from the shared pricing
  // module — summing that rather than recomputing keeps the invoice's line
  // amounts and its subtotal in exact agreement.
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  let discountAmount = 0;
  if (discountType === "flat") discountAmount = Number(discountValue) || 0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let goodsTax = 0;
  const itemTax = items.map(it => {
    const lineTotal = it.amount;
    const share = subtotal > 0 ? (lineTotal / subtotal) * discountAmount : 0;
    const taxable = Math.max(0, lineTotal - share);
    const tax = taxable * (it.gstRate / 100);
    goodsTax += tax;
    return tax;
  });
  goodsTax = round2(goodsTax);

  // Whether Transport/Loading are taxed is a per-invoice choice
  // (gst_on_charges) — when on, they're taxed at the invoice's own EFFECTIVE
  // rate (goods tax ÷ taxable goods value), since there's no natural "GST%"
  // on a freight charge the way there is on a priced item; when off, they're
  // a pure at-cost pass-through with no tax at all. GST is computed LAST,
  // once transport/loading are known, and folded into one CGST/SGST or IGST
  // figure — it is not split into a separate "GST on transport" line.
  const transportAmt = round2(Math.max(0, Number(transport) || 0));
  const loadingAmt = round2(Math.max(0, Number(loading) || 0));
  const taxableGoods = round2(subtotal - discountAmount);
  const effectiveRate = taxableGoods > 0 ? goodsTax / taxableGoods : 0;
  const ancillaryTax = gstOnCharges ? round2((transportAmt + loadingAmt) * effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === "IGST") igst = totalTax;
  else { cgst = round2(totalTax / 2); sgst = round2(totalTax - cgst); }

  // Transport/loading sit BEFORE GST now (GST is computed on top of them),
  // so the totals block reads Subtotal, Discount, Transport, Loading, GST,
  // Grand Total — GST is deliberately the last line before the total.
  const preRound = subtotal - discountAmount + transportAmt + loadingAmt + cgst + sgst + igst;
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

/**
 * Status Tracking (Draft / Pending / Approved / Partially Completed /
 * Completed / Cancelled) — automatic, derived from existing fields rather
 * than a stored column, so it can never drift out of sync with the real
 * payment/void state. This app has no draft-saving step (Complete Sale both
 * creates and finalises a document in one action), so Draft and Approved
 * never apply here — every invoice/challan starts life already "approved";
 * what's actually tracked is what happens to it afterward.
 */
function deriveDocStatus(inv) {
  if (inv.voided) return "Cancelled";
  if (inv.doc_type === "challan") return "Completed"; // no price/payment to track — goods have already left the shop
  if (inv.balance_due <= 0) return "Completed";
  if (inv.advance > 0) return "Partially Completed";
  return "Pending";
}
function withStatus(inv) { return { ...inv, status: deriveDocStatus(inv) }; }

router.get("/", (req, res) => {
  const { date } = req.query;
  const invoices = date
    ? db.prepare("SELECT * FROM invoices WHERE date = ? AND voided = 0 ORDER BY created_at DESC").all(date)
    : db.prepare("SELECT * FROM invoices WHERE voided = 0 ORDER BY created_at DESC").all();
  res.json(invoices.map(withStatus));
});

router.get("/:id", (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
  res.json({ ...withStatus(inv), items });
});

router.post("/", (req, res) => {
  const { customerId, items: rawItems, discountType, discountValue, advance,
          paymentMethod, paperSize, transport, loading, roundOff, deliveryMan,
          vehicleNumber, deliveryAddress, remarks, taxType: taxTypeOverride, locationId } = req.body;
  const docType = req.body.docType === "challan" ? "challan" : "invoice";
  const isChallan = docType === "challan";
  const location = resolveLocationId(locationId);
  // Defaults ON (matches the always-taxed behaviour before this toggle
  // existed) unless the client explicitly turns it off.
  const gstOnCharges = req.body.gstOnCharges !== false;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: `Add at least one item to the ${isChallan ? "challan" : "invoice"}.` });
  }

  const settings = getSettingsRow();
  let customer = null;
  if (customerId) {
    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
    if (!customer) return res.status(400).json({ error: "Selected customer no longer exists." });
  }
  // GST Type defaults from the customer record (Customer Master), but staff
  // can override it for just this one invoice from the Billing screen —
  // validated against the two known values so a bad/missing override can't
  // silently corrupt tax_type; only ever falls back to the old behavior.
  const taxType = (taxTypeOverride === "IGST" || taxTypeOverride === "CGST_SGST")
    ? taxTypeOverride
    : (customer && customer.gst_type === "IGST" ? "IGST" : "CGST_SGST");

  // Look up authoritative product/size data (gst rate, stock) server-side;
  // never trust client for these. Stock lives on the SIZE, not the product —
  // an "8x4" sheet and a "7x4" sheet are counted separately — so every line
  // must identify which size it's selling.
  //
  // The billed quantity is likewise RECOMPUTED here from the raw geometry
  // rather than taken from the request. The browser sends length/width/
  // thickness/sheets; a client that posted its own `qty` could otherwise bill
  // 320 sq.ft while only drawing 1 sheet out of stock.
  const piecesBySize = {};
  const items = [];
  for (const raw of rawItems) {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(raw.productId);
    if (!product) return res.status(400).json({ error: `Product ${raw.productId} no longer exists.` });
    const size = raw.sizeId != null
      ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(raw.sizeId, product.id)
      : null;
    if (!size) return res.status(400).json({ error: `Choose a size for ${product.name} — it may have been removed since you added it.` });

    const line = {
      mode: Pricing.normaliseMode(raw.mode),
      lengthFt: raw.lengthFt,
      widthVal: raw.widthVal,
      thicknessIn: raw.thicknessIn,
      pieces: raw.pieces,
      rate: raw.rate
    };
    const invalid = Pricing.validateLine(line, `${product.name} (${size.label})`);
    if (invalid) return res.status(400).json({ error: invalid });

    const calc = Pricing.computeLine(line);
    piecesBySize[size.id] = (piecesBySize[size.id] || 0) + calc.pieces;
    items.push({
      productId: product.id,
      sizeId: size.id,
      name: raw.name || product.name,
      code: product.code || "",
      brand: product.brand || "",
      hsnCode: product.hsn_code || "",
      gstRate: product.gst_rate,
      product, size,
      ...calc
    });
  }
  const locationName = inventory.getLocationById(location).name;
  for (const [sizeId, pieces] of Object.entries(piecesBySize)) {
    const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(sizeId);
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(size.product_id);
    const atLocation = inventory.getStock(Number(sizeId), location);
    if (pieces > atLocation) {
      return res.status(400).json({
        error: `Not enough ${locationName} stock for ${product.name} (${size.label}). Available: ${atLocation} ${product.unit || "Pc"}, needed: ${pieces}.`
      });
    }
  }

  // A delivery challan is never a tax invoice: no GST, no discount, no
  // round-off, no advance, and nothing added to the customer's due —
  // regardless of anything the client sent for those fields. Transport and
  // loading/labour ARE kept though: they're real charges a driver or the
  // customer needs to see on the challan itself, not a taxable sale value,
  // so `total` on a challan means "transport + loading", nothing else.
  const challanTransport = round2(Math.max(0, Number(transport) || 0));
  const challanLoading = round2(Math.max(0, Number(loading) || 0));
  const challanTotals = {
    subtotal: 0, discountAmount: 0, cgst: 0, sgst: 0, igst: 0,
    transport: challanTransport, loading: challanLoading, roundOffAmount: 0,
    total: round2(challanTransport + challanLoading), advance: 0, balanceDue: 0
  };
  const totals = isChallan
    ? challanTotals
    : computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff, gstOnCharges });
  const id = uid(isChallan ? "DC" : "INV");
  const challanNo = nextDocNo(docType);
  const date = todayStr();

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, challan_no, doc_type, date, created_at, customer_id, subtotal, discount_type, discount_value,
      discount_amount, tax_type, cgst, sgst, igst, transport, loading, gst_on_charges, round_off, total, advance, balance_due,
      payment_method, paper_size, delivery_man, vehicle_number, delivery_address, remarks, location_id)
    VALUES (@id, @challanNo, @docType, @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
      @discountAmount, @taxType, @cgst, @sgst, @igst, @transport, @loading, @gstOnCharges, @roundOffAmount, @total, @advance,
      @balanceDue, @paymentMethod, @paperSize, @deliveryMan, @vehicleNumber, @deliveryAddress, @remarks, @locationId)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, product_id, size_id, name, code, brand, hsn_code, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bumpDue = db.prepare("UPDATE customers SET due = due + ? WHERE id = ?");

  db.transaction(() => {
    insertInvoice.run({
      id, challanNo, docType, date, createdAt: Date.now(), customerId: customerId || null,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: isChallan ? 0 : (Number(discountValue) || 0), discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, gstOnCharges: gstOnCharges ? 1 : 0,
      roundOffAmount: totals.roundOffAmount,
      total: totals.total, advance: totals.advance, balanceDue: totals.balanceDue,
      // A challan has no tender; store a dash rather than a misleading "Cash".
      paymentMethod: isChallan ? "—" : (paymentMethod || "Cash"),
      paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: (deliveryMan || "").trim(),
      vehicleNumber: (vehicleNumber || "").trim(),
      deliveryAddress: (deliveryAddress || "").trim(),
      remarks: (remarks || "").trim(),
      locationId: location
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.sizeId, it.name, it.code, it.brand, it.hsnCode, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit,
      // A challan's item RATE is now kept (optional, defaults 0) so the print
      // screen can offer "Delivery Challan (With Rate)" — but the invoice-level
      // GST/discount/transport/total above stays zero either way: a challan is
      // never a tax invoice regardless of whether a rate was noted per line.
      it.billedQty, it.rate, it.gstRate
    ));
    // Stock moves in pieces, not in billed area/length/volume — for a challan
    // too, since the goods physically leave the shop or warehouse. Deducted
    // per SIZE from this invoice's own location, then each touched product's
    // total is resynced.
    const touchedProducts = new Set();
    Object.entries(piecesBySize).forEach(([sizeId, pieces]) => {
      inventory.addStock(Number(sizeId), location, -pieces);
      const size = db.prepare("SELECT product_id FROM product_sizes WHERE id = ?").get(sizeId);
      if (size) touchedProducts.add(size.product_id);
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
    if (customerId && totals.balanceDue > 0) bumpDue.run(totals.balanceDue, customerId);
  })();

  logAction(req, isChallan ? "challan.create" : "invoice.create",
    isChallan ? challanNo : `${challanNo} — ${totals.total}`);
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  const savedItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(id);
  res.status(201).json({ ...withStatus(invoice), items: savedItems });
});

/**
 * Edit a saved (non-voided) invoice/challan: replace its line items and
 * recompute totals, correctly reversing the OLD stock/due impact first and
 * applying the NEW one — not just overwriting the print. challan_no,
 * doc_type, date and created_at are immutable; editing never changes which
 * document this is or its position in the numbered sequence.
 */
router.put("/:id", (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  if (inv.voided) return res.status(400).json({ error: "Cannot edit a voided document." });
  const isChallan = inv.doc_type === "challan"; // fixed at creation, not editable

  const { customerId, items: rawItems, discountType, discountValue, advance,
          paymentMethod, paperSize, transport, loading, roundOff, deliveryMan,
          vehicleNumber, deliveryAddress, remarks, taxType: taxTypeOverride, locationId } = req.body;
  const gstOnCharges = req.body.gstOnCharges !== false;

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: `Add at least one item to the ${isChallan ? "challan" : "invoice"}.` });
  }

  const settings = getSettingsRow();
  let customer = null;
  if (customerId) {
    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
    if (!customer) return res.status(400).json({ error: "Selected customer no longer exists." });
  }
  // GST Type defaults from the customer record (Customer Master), but staff
  // can override it for just this one invoice from the Billing screen —
  // validated against the two known values so a bad/missing override can't
  // silently corrupt tax_type; only ever falls back to the old behavior.
  const taxType = (taxTypeOverride === "IGST" || taxTypeOverride === "CGST_SGST")
    ? taxTypeOverride
    : (customer && customer.gst_type === "IGST" ? "IGST" : "CGST_SGST");

  const oldItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
  const restoreProduct = db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?");
  const insertItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, product_id, size_id, name, code, brand, hsn_code, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // The OLD location this document actually deducted from — never the NEW
  // requested one — so reversal always undoes what really happened. Falls
  // back to Shop for a document saved before location_id existed.
  const oldLocation = inv.location_id || shopLocationId();
  const newLocation = resolveLocationId(locationId);

  const runEdit = db.transaction(() => {
    // 1. Reverse the OLD stock impact at the OLD location — stock now
    //    reflects "as if this document never existed", so the new items
    //    validate against true availability rather than double-counting
    //    what this edit removes.
    const touchedProducts = new Set();
    oldItems.forEach(it => {
      if (it.size_id) { inventory.addStock(it.size_id, oldLocation, it.pieces); touchedProducts.add(it.product_id); }
      else if (it.product_id) restoreProduct.run(it.pieces, it.product_id);
    });

    // 2. Build + validate the NEW items — identical logic to creating a
    //    fresh invoice (see POST / above).
    const piecesBySize = {};
    const items = [];
    for (const raw of rawItems) {
      const product = db.prepare("SELECT * FROM products WHERE id = ?").get(raw.productId);
      if (!product) throw { status: 400, error: `Product ${raw.productId} no longer exists.` };
      const size = raw.sizeId != null
        ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(raw.sizeId, product.id)
        : null;
      if (!size) throw { status: 400, error: `Choose a size for ${product.name} — it may have been removed since you added it.` };

      const line = {
        mode: Pricing.normaliseMode(raw.mode), lengthFt: raw.lengthFt, widthVal: raw.widthVal,
        thicknessIn: raw.thicknessIn, pieces: raw.pieces, rate: raw.rate
      };
      const invalid = Pricing.validateLine(line, `${product.name} (${size.label})`);
      if (invalid) throw { status: 400, error: invalid };

      const calc = Pricing.computeLine(line);
      piecesBySize[size.id] = (piecesBySize[size.id] || 0) + calc.pieces;
      items.push({
        productId: product.id, sizeId: size.id, name: raw.name || product.name,
        code: product.code || "", brand: product.brand || "", hsnCode: product.hsn_code || "",
        gstRate: product.gst_rate, product, size, ...calc
      });
    }
    const newLocationName = inventory.getLocationById(newLocation).name;
    for (const [sizeId, pieces] of Object.entries(piecesBySize)) {
      const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(sizeId);
      const product = db.prepare("SELECT * FROM products WHERE id = ?").get(size.product_id);
      const atLocation = inventory.getStock(Number(sizeId), newLocation);
      if (pieces > atLocation) {
        throw { status: 400, error: `Not enough ${newLocationName} stock for ${product.name} (${size.label}). Available: ${atLocation} ${product.unit || "Pc"}, needed: ${pieces}.` };
      }
    }

    const challanTransport = round2(Math.max(0, Number(transport) || 0));
    const challanLoading = round2(Math.max(0, Number(loading) || 0));
    const challanTotals = {
      subtotal: 0, discountAmount: 0, cgst: 0, sgst: 0, igst: 0,
      transport: challanTransport, loading: challanLoading, roundOffAmount: 0,
      total: round2(challanTransport + challanLoading), advance: 0, balanceDue: 0
    };
    const totals = isChallan
      ? challanTotals
      : computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff, gstOnCharges });

    // 3. Reverse the OLD customer's due (whoever it was originally billed to).
    if (inv.customer_id && inv.balance_due > 0) {
      db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(inv.balance_due, inv.customer_id);
    }

    // 4. Replace the line items.
    db.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").run(inv.id);
    items.forEach(it => insertItem.run(
      inv.id, it.productId, it.sizeId, it.name, it.code, it.brand, it.hsnCode, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.gstRate
    ));

    // 5. Deduct stock for the NEW items at the NEW location and resync
    //    affected product totals.
    Object.entries(piecesBySize).forEach(([sizeId, pieces]) => {
      inventory.addStock(Number(sizeId), newLocation, -pieces);
      const size = db.prepare("SELECT product_id FROM product_sizes WHERE id = ?").get(sizeId);
      if (size) touchedProducts.add(size.product_id);
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    // 6. Update the invoice row itself — challan_no/doc_type/date/created_at
    //    are never touched here, only content and money fields.
    db.prepare(`
      UPDATE invoices SET customer_id=@customerId, subtotal=@subtotal, discount_type=@discountType,
        discount_value=@discountValue, discount_amount=@discountAmount, tax_type=@taxType,
        cgst=@cgst, sgst=@sgst, igst=@igst, transport=@transport, loading=@loading,
        gst_on_charges=@gstOnCharges, round_off=@roundOffAmount, total=@total, advance=@advance,
        balance_due=@balanceDue, payment_method=@paymentMethod, paper_size=@paperSize,
        delivery_man=@deliveryMan, vehicle_number=@vehicleNumber, delivery_address=@deliveryAddress,
        remarks=@remarks, location_id=@locationId
      WHERE id=@id
    `).run({
      id: inv.id, customerId: customerId || null,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: isChallan ? 0 : (Number(discountValue) || 0), discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, gstOnCharges: gstOnCharges ? 1 : 0,
      roundOffAmount: totals.roundOffAmount, total: totals.total, advance: totals.advance,
      balanceDue: totals.balanceDue,
      paymentMethod: isChallan ? "—" : (paymentMethod || "Cash"),
      paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: (deliveryMan || "").trim(), vehicleNumber: (vehicleNumber || "").trim(),
      deliveryAddress: (deliveryAddress || "").trim(), remarks: (remarks || "").trim(),
      locationId: newLocation
    });

    // 7. Bump the (possibly new) customer's due by the new balance.
    if (customerId && totals.balanceDue > 0) {
      db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(totals.balanceDue, customerId);
    }
  });

  try {
    runEdit();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, isChallan ? "challan.edit" : "invoice.edit", `${inv.challan_no}`);
  const updated = db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id);
  const savedItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
  res.json({ ...withStatus(updated), items: savedItems });
});

router.post("/:id/void", requireRole("owner"), (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  if (inv.voided) return res.status(400).json({ error: "Invoice already voided." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);

  // Legacy fallback for invoice_items sold before size-level stock existed —
  // those rows have no size_id, so the best that can be done is credit the
  // product's total directly (no location to attribute it to).
  const restoreProduct = db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?");
  const reduceDue = db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?");
  const voidInvoice = db.prepare("UPDATE invoices SET voided = 1 WHERE id = ?");
  const location = inv.location_id || shopLocationId();

  db.transaction(() => {
    // Restore the physical piece count, NOT `qty` — on an area-priced line qty
    // is a sq.ft figure and would put hundreds of phantom sheets into stock.
    // Restored to wherever this invoice actually deducted from.
    const touchedProducts = new Set();
    items.forEach(it => {
      if (it.size_id) { inventory.addStock(it.size_id, location, it.pieces); touchedProducts.add(it.product_id); }
      else if (it.product_id) restoreProduct.run(it.pieces, it.product_id);
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
    if (inv.customer_id && inv.balance_due > 0) reduceDue.run(inv.balance_due, inv.customer_id);
    voidInvoice.run(inv.id);
  })();

  logAction(req, "invoice.void", `${inv.challan_no}`);
  res.json({ ok: true });
});

/**
 * A genuine hard delete, owner-only. Restores stock (and, for a real Tax
 * Invoice, the customer's due) exactly like Void does, then actually removes
 * the row instead of leaving a "voided" stub behind.
 *
 * Deleting a Tax Invoice/Estimate leaves a gap in its numbered sequence
 * (SP0000001, SP0000003, … with no SP0000002) — that can look irregular in a
 * GST audit, which is precisely why Void exists as the non-destructive
 * alternative. This route allows it anyway, at the owner's explicit request,
 * but the client-side confirmation must say so plainly each time; this is
 * not a decision to make silently on someone's behalf.
 */
router.delete("/:id", requireRole("owner"), (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Document not found." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
  const restoreProduct = db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?");
  const reduceDue = db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?");
  const location = inv.location_id || shopLocationId();

  db.transaction(() => {
    if (!inv.voided) {
      // Only reverse stock/dues if a prior Void hasn't already done so.
      const touchedProducts = new Set();
      items.forEach(it => {
        if (it.size_id) { inventory.addStock(it.size_id, location, it.pieces); touchedProducts.add(it.product_id); }
        else if (it.product_id) restoreProduct.run(it.pieces, it.product_id);
      });
      touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
      if (inv.customer_id && inv.balance_due > 0) reduceDue.run(inv.balance_due, inv.customer_id);
    }
    db.prepare("DELETE FROM invoices WHERE id = ?").run(inv.id); // cascades to invoice_items
  })();

  logAction(req, inv.doc_type === "challan" ? "challan.delete" : "invoice.delete", `${inv.challan_no}`);
  res.json({ ok: true });
});

module.exports = router;
