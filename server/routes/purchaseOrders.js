const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
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
function buildItems(rawItems, headerCustomerId) {
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
      remark: String(raw.remark || "").trim().slice(0, 200),
      againstCustomerId: lineCustomerId(raw, headerCustomerId),
      discountAmount, ...calc
    });
  }
  return items;
}

/* ============================================================
   WHO THE ORDER IS FOR

   Takes the raw header fields off the request and turns them into what
   the table stores, refusing anything that would leave a dangling
   reference. A PO pointing at a customer who no longer exists is worse
   than one pointing at nobody: the report still counts it and the name
   comes back blank.
   ============================================================ */
function resolveAgainst(body) {
  const poType = body.poType === "AgainstCustomer" ? "AgainstCustomer" : "General";

  /* A General purchase carries no party chain at all. Keeping stale values
     "just in case they switch back" is how a report ends up attributing
     stock-replenishment orders to a customer who never asked for them. */
  if (poType !== "AgainstCustomer") {
    return { poType, salesman: "", againstCustomerId: null, soId: null,
             requiredDeliveryDate: String(body.requiredDeliveryDate || "").trim() };
  }

  let againstCustomerId = body.againstCustomerId || null;
  if (againstCustomerId) {
    const c = db.prepare("SELECT id FROM customers WHERE id = ?").get(bindId(againstCustomerId));
    if (!c) throw { status: 400, error: "That customer no longer exists." };
  }

  let soId = body.soId || null;
  if (soId) {
    const so = db.prepare("SELECT id, customer_id FROM sales_orders WHERE id = ?").get(bindId(soId));
    if (!so) throw { status: 400, error: "That Sales Order no longer exists." };
    /* The sales order already knows whose it is. Taking the party from it
       rather than trusting a second dropdown means the two can never
       disagree on screen. */
    if (so.customer_id) againstCustomerId = so.customer_id;
  }

  return {
    poType,
    salesman: String(body.salesman || "").trim().slice(0, 80),
    againstCustomerId,
    soId,
    requiredDeliveryDate: String(body.requiredDeliveryDate || "").trim()
  };
}

/** A line's own party, falling back to the order's. */
function lineCustomerId(raw, headerCustomerId) {
  if (!raw.againstCustomerId) return headerCustomerId || null;
  const c = db.prepare("SELECT id FROM customers WHERE id = ?").get(bindId(raw.againstCustomerId));
  return c ? c.id : (headerCustomerId || null);
}

function serialize(po) {
  const items = db.prepare(`
    SELECT poi.*,
           CASE WHEN COALESCE(NULLIF(TRIM(poi.size_label),''), '') <> ''
                THEN poi.size_label ELSE COALESCE(ps.label,'') END AS size_label
      FROM purchase_order_items poi
      LEFT JOIN product_sizes ps ON ps.id = poi.size_id
     WHERE poi.po_id = ?
     ORDER BY CASE WHEN COALESCE(poi.brand,'') = '' THEN 1 ELSE 0 END,
              poi.brand COLLATE NOCASE, poi.id`).all(po.id);

  /* Names, not just ids. Every screen and both WhatsApp messages need
     them, and four of them re-querying is four chances to disagree. */
  const nameOf = id => {
    if (!id) return null;
    const c = db.prepare("SELECT name FROM customers WHERE id = ?").get(bindId(id));
    return c ? c.name : null;
  };
  const so = po.so_id
    ? db.prepare("SELECT so_no FROM sales_orders WHERE id = ?").get(bindId(po.so_id))
    : null;

  return {
    ...po,
    against_customer_name: nameOf(po.against_customer_id),
    so_no: so ? so.so_no : null,
    items: items.map(it => ({
      ...it,
      against_customer_name: nameOf(it.against_customer_id),
      pending_qty: round2(Math.max(0, (it.qty || 0) - (it.received_qty || 0)))
    }))
  };
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
  let against;
  try { against = resolveAgainst(req.body); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  try { items = buildItems(rawItems, against.againstCustomerId); }
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
      payment_terms, delivery_terms, remarks, status,
      po_type, salesman, against_customer_id, so_id, required_delivery_date)
    VALUES (@id, @poNo, @date, @createdAt, @supplierId, @deliveryAddress, @expectedDeliveryDate,
      @purchaseType, @taxType, @subtotal, @discountAmount, @cgst, @sgst, @igst, @freight, @otherCharges, @roundOffAmount, @total,
      @paymentTerms, @deliveryTerms, @remarks, @status,
      @poType, @salesman, @againstCustomerId, @soId, @requiredDeliveryDate)
  `);
  const insertItem = db.prepare(`
    INSERT INTO purchase_order_items
      (po_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate, remark, against_customer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      status,
      poType: against.poType, salesman: against.salesman,
      againstCustomerId: against.againstCustomerId, soId: against.soId,
      requiredDeliveryDate: against.requiredDeliveryDate
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate, it.remark, it.againstCustomerId
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
  let against;
  try { against = resolveAgainst(req.body); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  try { items = buildItems(rawItems, against.againstCustomerId); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }

  const totals = computeTotals({ items, taxType, freight, otherCharges, roundOff });
  const poDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : po.date;
  const status = saveAsDraft ? "Draft" : "Pending";

  const insertItem = db.prepare(`
    INSERT INTO purchase_order_items
      (po_id, product_id, size_id, name, brand, category, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, discount_amount, gst_rate, remark, against_customer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM purchase_order_items WHERE po_id = ?").run(po.id);
    items.forEach(it => insertItem.run(
      po.id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate, it.remark, it.againstCustomerId
    ));
    db.prepare(`
      UPDATE purchase_orders SET supplier_id=@supplierId, date=@date, delivery_address=@deliveryAddress,
        expected_delivery_date=@expectedDeliveryDate, purchase_type=@purchaseType, tax_type=@taxType,
        subtotal=@subtotal, discount_amount=@discountAmount, cgst=@cgst, sgst=@sgst, igst=@igst,
        freight=@freight, other_charges=@otherCharges, round_off=@roundOffAmount, total=@total,
        payment_terms=@paymentTerms, delivery_terms=@deliveryTerms, remarks=@remarks, status=@status,
        po_type=@poType, salesman=@salesman, against_customer_id=@againstCustomerId,
        so_id=@soId, required_delivery_date=@requiredDeliveryDate
      WHERE id=@id
    `).run({
      id: po.id, supplierId, date: poDate, deliveryAddress: (deliveryAddress || "").trim(),
      expectedDeliveryDate: (expectedDeliveryDate || "").trim(), purchaseType: purchaseTypeVal, taxType,
      subtotal: totals.subtotal, discountAmount: totals.discountAmount,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      freight: totals.freight, otherCharges: totals.otherCharges, roundOffAmount: totals.roundOffAmount, total: totals.total,
      paymentTerms: (paymentTerms || "").trim(), deliveryTerms: (deliveryTerms || "").trim(), remarks: (remarks || "").trim(),
      status,
      poType: against.poType, salesman: against.salesman,
      againstCustomerId: against.againstCustomerId, soId: against.soId,
      requiredDeliveryDate: against.requiredDeliveryDate
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
  const bumpDue = db.prepare("UPDATE suppliers SET due = ROUND(due + ?, 2) WHERE id = ?");

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

    /* Converting takes the whole order in one go, so every line has now
       arrived. Saying so here is what stops a converted PO still reading
       as "40 pending" on the customer's side. */
    db.prepare("UPDATE purchase_order_items SET received_qty = qty WHERE po_id = ?").run(po.id);
    db.prepare("UPDATE purchase_orders SET status = 'Completed', converted_purchase_id = ? WHERE id = ?").run(purchaseId, po.id);
  })();

  logAction(req, "po.convert", `${po.po_no} -> ${db.prepare("SELECT purchase_no FROM purchases WHERE id = ?").get(purchaseId).purchase_no}`);
  res.json({
    po: serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id)),
    purchase: db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId)
  });
});

/** A Draft (never submitted) can be deleted outright — nothing depends on it yet. */

/* ============================================================
   WHAT ACTUALLY TURNED UP

   A mill sending 60 of 100 sheets is the normal case, not the exception,
   and until now the order had nowhere to say so: it was either untouched
   or converted in full. That left the 40 sheets still owed to the
   customer as a number nobody held.

   This records a delivery against the lines it arrived for. It does NOT
   touch stock or the supplier's due — those move when the supplier's bill
   is entered, which is Convert to Purchase Entry's job. Two engines for
   one event would double the stock.
   ============================================================ */
router.post("/:id/receive", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });
  if (["Cancelled"].includes(po.status)) {
    return res.status(400).json({ error: "This Purchase Order is cancelled." });
  }

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: "Nothing to record." });

  const items = db.prepare("SELECT * FROM purchase_order_items WHERE po_id = ?").all(po.id);
  const byId = new Map(items.map(it => [String(it.id), it]));

  /* Validate every line before writing any of them: a half-applied
     delivery is harder to explain than a rejected one. */
  const updates = [];
  for (const raw of lines) {
    const it = byId.get(String(raw.id));
    if (!it) return res.status(400).json({ error: "That line is not on this order." });
    const qty = Number(raw.receivedQty);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ error: `Received quantity for ${it.name} must be zero or more.` });
    }
    /* More than ordered is allowed — mills do send a few extra — but it
       is capped so a typo cannot make the pending figure negative. */
    updates.push({ id: it.id, qty: round2(Math.min(qty, it.qty)) });
  }

  const setQty = db.prepare("UPDATE purchase_order_items SET received_qty = ? WHERE id = ? AND po_id = ?");
  db.transaction(() => {
    updates.forEach(u => setQty.run(u.qty, u.id, po.id));

    const after = db.prepare("SELECT qty, received_qty FROM purchase_order_items WHERE po_id = ?").all(po.id);
    const anything = after.some(r => (r.received_qty || 0) > 0);
    const everything = after.every(r => (r.received_qty || 0) >= (r.qty || 0) - 0.0001);

    /* A converted order keeps its Completed status: the goods and the
       bill are both in, and re-deriving status from quantities would
       quietly undo that. */
    if (!po.converted_purchase_id) {
      const next = everything ? "Completed" : anything ? "Partially Completed" : po.status;
      if (next !== po.status) db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?").run(next, po.id);
    }
  })();

  const fresh = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id);
  logAction(req, "po.receive", `${po.po_no}: ${updates.length} line(s) updated`);
  res.json(serialize(fresh));
});

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
