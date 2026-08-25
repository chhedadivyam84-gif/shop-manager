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

/* The number this purchase order will get, WITHOUT taking it.

   Reads the counter rather than allocating from it, the same way
   purchases.js and quotations.js do: a form the shopkeeper opens and then
   abandons must not burn a number out of the series. The number becomes
   real on save, and not before. */
router.get("/next-number", (req, res) => {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("po-no");
  const next = row ? row.value + 1 : 1;
  res.json({ poNo: `PO${String(next).padStart(7, "0")}` });
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
  /* Only what genuinely cannot change is listed here.

     Completed means the goods are all in and the entry is made; editing
     it would rewrite an order the books have already acted on.
     Cancelled means it did not happen.

     Approved and Partially Completed are both editable on purpose. A
     mill revising a rate after the owner signed off, or a line they
     cannot supply, is ordinary — and the shopkeeper who has to work
     around a locked order will raise a second one, which is how a
     shop ends up with two orders for one delivery. The approval does
     not survive the change: the status drops back below, so somebody
     signs off on what the order actually says now. */
  if (["Completed", "Cancelled"].includes(po.status)) {
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
    /* What has already arrived, kept across the rewrite.

       Matched on the GOODS — product and size — not on the row id, because
       the rows are about to be deleted and re-created with new ids. Match
       a line to itself by what it is for, and a line that was removed
       correctly takes its receipt with it. */
    const receiptsByGoods = new Map();
    db.prepare("SELECT product_id, size_id, received_qty FROM purchase_order_items WHERE po_id = ?")
      .all(po.id)
      .forEach(r => {
        if (!r.received_qty) return;
        const key = String(r.product_id) + "|" + String(r.size_id);
        receiptsByGoods.set(key, (receiptsByGoods.get(key) || 0) + r.received_qty);
      });

    db.prepare("DELETE FROM purchase_order_items WHERE po_id = ?").run(po.id);
    items.forEach(it => insertItem.run(
      po.id, it.productId, it.sizeId, it.name, it.brand, it.category, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.discountAmount, it.gstRate, it.remark, it.againstCustomerId
    ));

    /* Put the receipts back on the lines they belong to, never above what
       the line now asks for: an order edited DOWN to 5 cannot have 8
       received against it, and a pending figure must never go negative. */
    for (const row of db.prepare(
      "SELECT id, product_id, size_id, qty FROM purchase_order_items WHERE po_id = ? ORDER BY id").all(po.id)) {
      const key = String(row.product_id) + "|" + String(row.size_id);
      const left = receiptsByGoods.get(key);
      if (!left) continue;
      const give = round2(Math.min(left, row.qty));
      db.prepare("UPDATE purchase_order_items SET received_qty = ? WHERE id = ?").run(give, row.id);
      receiptsByGoods.set(key, round2(left - give));
    }
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

    /* Quantities just changed, so what counted as complete may not any
       more. Recomputed here rather than left to the next delivery, which
       might never come. A draft stays a draft: it has not been submitted,
       and arriving goods do not submit it. */
    if (status !== "Draft") {
      const after = db.prepare("SELECT qty, received_qty FROM purchase_order_items WHERE po_id = ?").all(po.id);
      const anything = after.some(r => (r.received_qty || 0) > 0);
      const everything = after.length && after.every(r => (r.received_qty || 0) >= (r.qty || 0) - 0.0001);
      if (anything) {
        db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?")
          .run(everything ? "Completed" : "Partially Completed", po.id);
      }
    }
  })();

  logAction(req, "po.edit", `${po.po_no}`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(po.id)));
});

/** Draft or Pending -> Approved. The owner's sign-off that this order is real. */
/* ============================================================
   THE WHOLE CHAIN, FOLLOWED

   Salesman -> party -> sales order -> purchase order -> supplier -> goods
   received -> sales bill -> dispatch -> delivered, signed for.

   Every one of those links already existed as its own foreign key. What did
   not exist was anything that walked them, so answering "did ABC actually
   get the material we bought for them?" meant opening four screens and
   holding the answer in your head.

   Followed, never guessed. Where a purchase order names a sales order the
   trail is exact: that sales order became that bill, and that bill went out
   on that van. Where it names only a party, the trail honestly stops at
   "received" — matching a bill to a purchase order by customer and product
   would look like an answer and sometimes be the wrong one, and a delivery
   report that is sometimes wrong is worse than one that says it does not
   know.
   ============================================================ */
router.get("/:id/chain", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });

  const items = db.prepare(`
    SELECT poi.*,
           COALESCE(NULLIF(TRIM(poi.size_label),''), ps.label, '') AS size_label
      FROM purchase_order_items poi
      LEFT JOIN product_sizes ps ON ps.id = poi.size_id
     WHERE poi.po_id = ?
     ORDER BY CASE WHEN COALESCE(poi.brand,'') = '' THEN 1 ELSE 0 END,
              poi.brand COLLATE NOCASE, poi.id`).all(po.id);

  const customerName = id => {
    if (!id) return null;
    const c = db.prepare("SELECT name FROM customers WHERE id = ?").get(bindId(id));
    return c ? c.name : null;
  };
  const supplier = po.supplier_id
    ? db.prepare("SELECT name, phone FROM suppliers WHERE id = ?").get(bindId(po.supplier_id))
    : null;

  /* ---- the sales side, where there is one ----------------------------- */
  const so = po.so_id
    ? db.prepare("SELECT * FROM sales_orders WHERE id = ?").get(bindId(po.so_id))
    : null;

  const invoice = so && so.converted_invoice_id
    ? db.prepare("SELECT * FROM invoices WHERE id = ? AND voided = 0").get(bindId(so.converted_invoice_id))
    : null;

  let invoiceItems = [];
  let drops = [];
  if (invoice) {
    invoiceItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(invoice.id);

    /* What has physically left, per bill line. Cancelled rounds never
       counted — those goods did not go anywhere. */
    const sent = new Map();
    try {
      db.prepare(`
        SELECT di.invoice_item_id AS item_id, SUM(di.qty_dispatched) AS qty
          FROM dispatch_items di
          JOIN dispatch_drops dd ON dd.id = di.drop_id
          JOIN dispatches d ON d.id = dd.dispatch_id
         WHERE dd.invoice_id = ?
           AND d.status <> 'Cancelled' AND dd.status <> 'Cancelled'
         GROUP BY di.invoice_item_id`).all(invoice.id)
        .forEach(r => sent.set(String(r.item_id), r.qty || 0));

      drops = db.prepare(`
        SELECT dd.id, dd.status, dd.delivered_at, dd.received_by,
               dd.signature <> '' AS signed,
               d.dispatch_no, d.dispatch_at, d.vehicle_no, d.driver_name,
               a.area AS area
          FROM dispatch_drops dd
          JOIN dispatches d ON d.id = dd.dispatch_id
          LEFT JOIN areas a ON a.id = dd.area_id
         WHERE dd.invoice_id = ? AND d.status <> 'Cancelled' AND dd.status <> 'Cancelled'
         ORDER BY d.dispatch_at ASC`).all(invoice.id);
    } catch (e) {
      /* A copy of the app without the delivery module still answers the rest
         of the chain rather than failing the whole request. */
      drops = [];
    }

    invoiceItems = invoiceItems.map(it => ({
      ...it,
      delivered_qty: round2(sent.get(String(it.id)) || 0),
      pending_qty: round2(Math.max(0, (it.qty || 0) - (sent.get(String(it.id)) || 0)))
    }));
  }

  /* ---- one row per stage, so the screen draws rather than decides ----- */
  const orderedQty = round2(items.reduce((t, it) => t + (it.qty || 0), 0));
  const receivedQty = round2(items.reduce((t, it) => t + (it.received_qty || 0), 0));
  const soQty = so
    ? round2(db.prepare("SELECT COALESCE(SUM(qty),0) q FROM sales_order_items WHERE so_id = ?").get(so.id).q)
    : null;
  const billedQty = invoice ? round2(invoiceItems.reduce((t, it) => t + (it.qty || 0), 0)) : null;
  const deliveredQty = invoice ? round2(invoiceItems.reduce((t, it) => t + it.delivered_qty, 0)) : null;

  res.json({
    po: {
      id: po.id, po_no: po.po_no, date: po.date, status: po.status,
      po_type: po.po_type, salesman: po.salesman,
      party: customerName(po.against_customer_id),
      supplier: supplier ? supplier.name : null,
      required_delivery_date: po.required_delivery_date,
      ordered_qty: orderedQty, received_qty: receivedQty,
      pending_qty: round2(Math.max(0, orderedQty - receivedQty)),
      converted_purchase_id: po.converted_purchase_id
    },
    items: items.map(it => ({
      id: it.id, name: it.name, brand: it.brand, size_label: it.size_label,
      unit_label: it.unit_label, mode: it.mode,
      party: customerName(it.against_customer_id) || customerName(po.against_customer_id),
      qty: it.qty, received_qty: it.received_qty,
      pending_qty: round2(Math.max(0, (it.qty || 0) - (it.received_qty || 0)))
    })),
    salesOrder: so ? { id: so.id, so_no: so.so_no, date: so.date, status: so.status, qty: soQty } : null,
    invoice: invoice
      ? { id: invoice.id, no: invoice.challan_no, date: invoice.date,
          doc_type: invoice.doc_type, qty: billedQty, delivered_qty: deliveredQty,
          pending_qty: round2(Math.max(0, (billedQty || 0) - (deliveredQty || 0))),
          items: invoiceItems.map(it => ({
            id: it.id, name: it.name, size_label: it.size_label, unit_label: it.unit_label,
            mode: it.mode, qty: it.qty, delivered_qty: it.delivered_qty, pending_qty: it.pending_qty
          })) }
      : null,
    deliveries: drops.map(d => ({
      dispatch_no: d.dispatch_no, at: d.dispatch_at, status: d.status,
      delivered_at: d.delivered_at, received_by: d.received_by,
      signed: !!d.signed, vehicle: d.vehicle_no, driver: d.driver_name, area: d.area
    })),

    /* Why the trail stops where it does, in words the screen can print
       rather than leaving a blank nobody can interpret. */
    stopsBecause: !so
      ? "no-sales-order"
      : !invoice
        ? "sales-order-not-billed"
        : !drops.length
          ? "not-dispatched"
          : null
  });
});

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
  /* A converted order is the one thing that must not be deleted whoever
     asks. Converting it moved stock onto the racks and put the amount on
     the supplier's account; the purchase entry that did so points back
     here. Deleting the order leaves that entry pointing at nothing, and
     nothing about the stock or the money is undone by it. Cancel is the
     action for an order that should not have been placed. */
  if (po.converted_purchase_id) {
    return res.status(400).json({
      error: "This order has already been made into a Purchase Entry, so it can't be deleted. Cancel it instead."
    });
  }

  /* Otherwise the same rule quotations already use: a draft is anyone's
     to discard, anything further is the owner's call. */
  if (po.status !== "Draft" && !(req.session && req.session.role === "owner")) {
    return res.status(403).json({ error: "Only the owner can delete a Purchase Order that isn't a Draft." });
  }
  db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(po.id);
  logAction(req, "po.delete", `${po.po_no}`);
  res.json({ ok: true });
});

module.exports = router;
