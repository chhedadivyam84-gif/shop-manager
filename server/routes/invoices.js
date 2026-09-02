const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");
const ledger = require("../stockLedger");
const docNumber = require("../docNumber");
// Same module the browser loads — see public/js/pricing.js for why it is shared.
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

/**
 * Offer a document to the Tally queue.
 *
 * WRAPPED IN EVERYTHING. This runs at the tail of saving a bill, and a
 * sync problem must never be able to fail a sale — not a missing module,
 * not a broken require, not a database error. The bill is already saved
 * and the customer is already waiting; the worst this may do is nothing.
 *
 * It only QUEUES. Sending happens separately, so Tally being off, slow or
 * mid-dialog cannot make a shopkeeper wait at the counter.
 */
function offerToTally(req, docType, doc, opts) {
  try {
    const svc = require("../tally/service");
    const r = svc.enqueue(docType, doc, {
      ...(opts || {}),
      staff: (req.session && req.session.staffName) || ""
    });
    /* "Immediately after saving" means immediately after — but on the next
       turn of the event loop, so the till gets its response back before
       anything starts talking to Tally. */
    if (r && r.queued) {
      try { require("../tally/autosync").nudge(); } catch (e) { /* never fatal */ }
    }
    return r;
  } catch (e) {
    /* Deliberately silent. There is nowhere useful to report this to at
       the moment a bill is being handed over, and the queue can be run by
       hand afterwards. */
    return { queued: false, reason: e.message };
  }
}

/** Cancelling in Tally, on the same terms: never able to fail the void. */
function offerCancelToTally(req, docType, doc) {
  try {
    const svc = require("../tally/service");
    return svc.enqueueCancel(docType, doc,
      { staff: (req.session && req.session.staffName) || "" });
  } catch (e) { return { queued: false, reason: e.message }; }
}

function getSettingsRow() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

/* Whether a sale may take stock below zero.
   Real shops receive goods before anyone types the purchase in, so the shelf
   figure is routinely behind reality and refusing the bill stops the counter
   dead. With this on, the sale goes through and the shortfall shows as
   negative stock — which is a visible, fixable discrepancy, unlike a sale
   that never got recorded. */
function negativeStockAllowed() {
  return (getSettingsRow() || {}).allow_negative_stock === 1;
}

/* The single stock check for selling. Both the create and the edit path call
   this, so the two can't drift into disagreeing about what is sellable.
   Returns an error message, or null when the sale may proceed. */
function checkSellableStock(piecesBySize, location) {
  if (negativeStockAllowed()) return null;
  const locationName = inventory.getLocationById(location).name;
  for (const [sizeId, pieces] of Object.entries(piecesBySize)) {
    const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(sizeId);
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(size.product_id);
    const atLocation = inventory.getStock(Number(sizeId), location);
    if (pieces > atLocation) {
      return `Not enough ${locationName} stock for ${product.name} (${size.label}). `
        + `Available: ${atLocation} ${product.unit || "Pc"}, needed: ${pieces}. `
        + `An owner can allow this in Settings → Allow Negative Stock.`;
    }
  }
  return null;
}

/* The geographic area a bill belongs to — Kandivali, Borivali, Mira Road.
   Nothing to do with resolveLocationId below, which is Shop vs Warehouse.

   Falls back to the customer's own area so staff don't retype it on every
   bill, but an explicit choice always wins: a Malad customer can take
   delivery in Borivali, and that bill belongs to Borivali.

   The chosen id is stored ON the invoice rather than read back through the
   customer, so a customer who relocates next year cannot silently rewrite
   which area last year's sales came from. */
function resolveAreaId(requestedId, customerId) {
  if (requestedId) {
    const a = db.prepare("SELECT id FROM areas WHERE id = ?").get(requestedId);
    if (a) return a.id;
  }
  if (customerId) {
    const c = db.prepare("SELECT area_id FROM customers WHERE id = ?").get(customerId);
    if (c && c.area_id) return c.area_id;
  }
  return null;
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
  /* One engine for every series (server/docNumber.js). This used to keep its
     own counter in the  table, which meant a deletion rolling back
     doc_numbering had no effect on what the next bill was actually given —
     two counters, one of them ignored. The engine also does the
     skip-if-already-taken walk this function used to do by hand, for the same
     reason: invoices and challans share one UNIQUE challan_no column. */
  return docNumber.allocate(docType === "challan" ? "challan" : "invoice");
}

/**
 * Applies a per-line discount percentage to a priced line.
 *
 * The bill-level discount (invoices.discount_type / discount_value) is
 * unchanged and still applies on top of this — the two stack, line first.
 * So a line reads: gross = qty x rate, then less its own discount%, and the
 * printed Amount column is the NET figure, which is also what the subtotal
 * sums. That ordering matters: taxing the gross and discounting afterwards
 * would charge GST on money the customer never paid.
 *
 * discountPct defaults to 0, so every line saved before this existed nets to
 * exactly its gross and no past bill changes by a paisa.
 */
function applyLineDiscount(calc, rawPct) {
  const pct = Math.min(100, Math.max(0, Number(rawPct) || 0));
  const gross = round2(calc.amount);
  const lineDiscount = round2(gross * (pct / 100));
  // calc.amount is overwritten with the NET figure deliberately: everything
  // downstream (subtotal, per-line GST share, the printed Amount) should see
  // one number, not two that can drift apart.
  return { ...calc, discountPct: pct, grossAmount: gross, lineDiscount, amount: round2(gross - lineDiscount) };
}

function computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff, gstOnCharges, gstEnabled }) {
  // `it.amount` is already (rounded billed qty × rate) from the shared pricing
  // module — summing that rather than recomputing keeps the invoice's line
  // amounts and its subtotal in exact agreement.
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  let discountAmount = 0;
  if (discountType === "flat") discountAmount = Number(discountValue) || 0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(discountValue) || 0)) / 100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  // "Non-GST Invoice" (gstEnabled === false) skips tax entirely — no goods
  // tax, no tax on transport/loading, no CGST/SGST/IGST at all, not just
  // zeroed-out fields. Everything below this still runs (itemTax stays an
  // array of zeros, matching every item) so the per-line shape callers
  // expect never changes, only the values do.
  let goodsTax = 0;
  const itemTax = items.map(it => {
    if (gstEnabled === false) return 0;
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
  const ancillaryTax = (gstEnabled !== false && gstOnCharges) ? round2((transportAmt + loadingAmt) * effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst = 0, sgst = 0, igst = 0;
  if (gstEnabled !== false) {
    if (taxType === "IGST") igst = totalTax;
    else { cgst = round2(totalTax / 2); sgst = round2(totalTax - cgst); }
  }

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
  // Pending until a real Tax Invoice is raised against it via "Convert to
  // Invoice"; Billed once that's happened. No such stage on a Tax Invoice
  // itself — it's already the billed document.
  if (inv.doc_type === "challan") return inv.converted_invoice_id ? "Billed" : "Pending";
  if (inv.balance_due <= 0) return "Completed";
  if (inv.advance > 0) return "Partially Completed";
  return "Pending";
}
function withStatus(inv) { return { ...inv, status: deriveDocStatus(inv) }; }

router.get("/", (req, res) => {
  const { date, customerId, includeVoided } = req.query;
  // Voided invoices are hidden by default (matches purchases.js's same
  // pattern) — includeVoided=true is the only way to look one back up, e.g.
  // to see why a customer with no visible ledger activity still can't be
  // deleted (a voided invoice still blocks that — see customers.js).
  const voidedClause = includeVoided === "true" ? "" : "AND voided = 0";
  let sql = "SELECT * FROM invoices WHERE 1=1 " + voidedClause;
  const params = [];
  if (date) { sql += " AND date = ?"; params.push(date); }
  if (customerId) { sql += " AND customer_id = ?"; params.push(customerId); }
  sql += " ORDER BY created_at DESC";
  const invoices = db.prepare(sql).all(...params);
  res.json(invoices.map(withStatus));
});

/**
 * Lets the Billing screen show what number THIS document will get before
 * it's saved — peeks the counter without incrementing it (mirrors
 * quotations.js's /next-number), so switching between Tax Invoice and
 * Delivery Challan on an unsaved form, or abandoning it, never burns a
 * number from either series.
 */
router.get("/next-number", (req, res) => {
  const counterName = req.query.docType === "challan" ? "challan-no" : "estimate-no";
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(counterName);
  const next = row ? row.value + 1 : 1;
  res.json({ challanNo: `SP${String(next).padStart(7, "0")}` });
});

/**
 * FINDING A BILL THAT HAS ALREADY BEEN WRITTEN.
 *
 * Declared BEFORE "/:id" on purpose: Express matches in order, so with
 * the routes the other way round "/search" arrives as an invoice id and
 * this never runs.
 *
 * Every field the counter would search by, and each one optional — the
 * common case is a bill number typed on its own, and nothing else should
 * have to be filled in for that to work.
 *
 * Salesman, order number and delivery number do not live on the invoice.
 * They are the staff member who wrote it, the sales order it was raised
 * from, and the delivery note that went out against it, so they are
 * joined here rather than copied onto the bill — a copy would be another
 * thing to keep in step.
 *
 * VOIDED BILLS ARE INCLUDED, marked. Searching a number and being told it
 * does not exist, when it does and was cancelled, sends somebody hunting
 * through paper. They are shown and flagged; whether one can be edited is
 * the billing form's decision, not this list's.
 */
router.get("/search", (req, res) => {
  const q = req.query || {};
  const like = (v) => "%" + String(v).trim() + "%";
  const where = ["1=1"];
  const args = [];

  if (String(q.no || "").trim())       { where.push("i.challan_no LIKE ?");   args.push(like(q.no)); }
  if (String(q.customer || "").trim()) { where.push("c.name LIKE ?");          args.push(like(q.customer)); }
  if (String(q.from || "").trim())     { where.push("i.date >= ?");            args.push(String(q.from).trim()); }
  if (String(q.to || "").trim())       { where.push("i.date <= ?");            args.push(String(q.to).trim()); }
  if (q.docType === "invoice" || q.docType === "challan") {
    where.push("i.doc_type = ?"); args.push(q.docType);
  }
  if (String(q.salesman || "").trim()) {
    where.push("(s.salesman_name LIKE ? OR i.created_by LIKE ?)");
    args.push(like(q.salesman), like(q.salesman));
  }
  if (String(q.orderNo || "").trim()) {
    where.push("EXISTS (SELECT 1 FROM sales_orders so WHERE so.converted_invoice_id = i.id AND so.so_no LIKE ?)");
    args.push(like(q.orderNo));
  }
  if (String(q.deliveryNo || "").trim()) {
    where.push("EXISTS (SELECT 1 FROM deliveries d WHERE d.invoice_id = i.id AND d.delivery_no LIKE ?)");
    args.push(like(q.deliveryNo));
  }
  /* An amount is remembered as "about nine thousand", not to the paisa,
     so this matches within a rupee either way rather than exactly. */
  if (String(q.amount || "").trim() !== "" && isFinite(Number(q.amount))) {
    where.push("i.total BETWEEN ? AND ?");
    args.push(Number(q.amount) - 1, Number(q.amount) + 1);
  }

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 500);

  try {
    const rows = db.prepare(`
      SELECT i.id, i.challan_no, i.date, i.total, i.doc_type, i.voided,
             i.payment_method, i.balance_due,
             c.name AS customer_name,
             COALESCE(NULLIF(TRIM(s.salesman_name), ''), i.created_by) AS salesman,
             (SELECT so.so_no FROM sales_orders so
               WHERE so.converted_invoice_id = i.id LIMIT 1) AS order_no,
             (SELECT d.delivery_no FROM deliveries d
               WHERE d.invoice_id = i.id ORDER BY d.created_at DESC LIMIT 1) AS delivery_no
        FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id
        LEFT JOIN staff s     ON s.name = i.created_by
       WHERE ${where.join(" AND ")}
       ORDER BY i.date DESC, i.created_at DESC
       LIMIT ?
    `).all(...args, limit);
    res.json({ rows, truncated: rows.length >= limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Invoice not found." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);

  /* The Estimate this bill was raised from, for the "Estimate No. / Estimate
     Date" lines on the printed bill. The link is recorded on the QUOTATION
     (quotations.converted_invoice_id), so this reads backwards — hence the
     index added in db.js. Returns null for a bill typed from scratch, which is
     most of them, and the print layout simply omits the lines. */
  const estimate = db.prepare(
    "SELECT quotation_no, date FROM quotations WHERE converted_invoice_id = ? LIMIT 1"
  ).get(inv.id) || null;

  res.json({ ...withStatus(inv), items, estimate });
});

/* The name to record against a document.

   The same field the audit log uses, so a bill and its log entry never
   disagree about who was at the counter. Falls back to "" rather than
   to something invented: an unsigned save is better recorded as blank
   than as a name nobody typed. */
function whoIs(req) {
  return String((req && req.session && req.session.staffName) || "").trim();
}

router.post("/", (req, res) => {
  const { customerId, items: rawItems, discountType, discountValue, advance,
          paymentMethod, paperSize, transport, loading, roundOff, deliveryMan,
          vehicleNumber, deliveryAddress, remarks, taxType: taxTypeOverride, locationId, areaId, date,
          dueDate, transportMode } = req.body;
  const docType = req.body.docType === "challan" ? "challan" : "invoice";
  const isChallan = docType === "challan";
  const location = resolveLocationId(locationId);
  // Defaults ON (matches the always-taxed behaviour before this toggle
  // existed) unless the client explicitly turns it off.
  const gstOnCharges = req.body.gstOnCharges !== false;
  // "GST Invoice" vs "Non-GST Invoice" — same default-on, explicit-off pattern.
  const gstEnabled = req.body.gstEnabled !== false;

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
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(bindId(raw.productId));
    if (!product) return res.status(400).json({ error: `Product ${raw.productId} no longer exists.` });
    const size = raw.sizeId != null
      ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(bindId(raw.sizeId), product.id)
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

    const calc = applyLineDiscount(Pricing.computeLine(line), raw.discountPct);
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
  const stockProblem = checkSellableStock(piecesBySize, location);
  if (stockProblem) return res.status(400).json({ error: stockProblem });

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
    : computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff, gstOnCharges, gstEnabled });
  const id = uid(isChallan ? "DC" : "INV");
  /* Auto ON hands out the next number in the series; auto OFF makes the
     operator type one, which is checked for a clash before anything is
     saved. A typed number is also allowed while auto is ON — the screen
     offers it — so the client sends the flag rather than the server
     inferring it from the setting alone. */
  /* ---- WHY THIS IS SAFE WITH MANY COUNTERS AT ONCE -------------------

     Five phones pressing Save in the same second cannot collide here, and
     not by luck. This handler is not async and nothing between the number
     being taken and the row being written ever awaits, so once a request
     starts it runs to the end before the next one is looked at — Node has
     one thread, and node:sqlite is synchronous. Two allocations cannot
     interleave because there is no point at which one could yield.

     Underneath that, challan_no is UNIQUE, so even a future change that
     did introduce an await would be caught by the database rather than
     quietly writing two bills with one number.

     Measured, not assumed: 40 simultaneous saves produce 40 consecutive
     numbers with no duplicate and no gap (see the concurrency suite).

     The one thing to be careful of is putting an await between here and
     the transaction below. Doing so would open exactly the window this
     comment says does not exist. */
  const series = isChallan ? "challan" : "invoice";
  const autoOff = docNumber.config(series).auto_enabled !== 1;

  /* REUSING A DELETED NUMBER IS THE ONLY WAY TO SET ONE BY HAND.

     There is deliberately no general "edit the invoice number" here. A
     number is issued automatically and in order, and the single
     exception is a number a deletion actually freed  which the owner
     may put back into use, with a reason, and once.

     Three gates, all on the server, because a check that only exists in
     the browser is not a check:
       - the owner, and nobody else;
       - the number must still be genuinely deleted AT THIS MOMENT, asked
         again rather than trusted from whatever list the screen drew;
       - a reason, which goes into the audit trail with it. */
  const wantsManual = req.body.useManualNumber === true && req.body.manualNumber;
  if (wantsManual) {
    if (!req.session || req.session.role !== "owner") {
      return res.status(403).json({
        error: "Only the shop owner can reuse a deleted document number."
      });
    }
    const wanted = String(req.body.manualNumber).trim();
    if (!docNumber.isDeletedNumber(series, wanted)) {
      return res.status(400).json({
        error: docNumber.isTaken(series, wanted)
          ? `${wanted} is already on another document.`
          : `${wanted} was never issued and then deleted, so it cannot be reused. ` +
            "Only a number a deletion actually freed can be put back into use."
      });
    }
    if (!String(req.body.reuseReason || "").trim()) {
      return res.status(400).json({ error: "Give a reason for reusing this number." });
    }
  }

  let challanNo;
  try {
    challanNo = docNumber.resolve(series, {
      manualNumber: req.body.manualNumber,
      useManual: req.body.useManualNumber === true || (autoOff && req.body.manualNumber)
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }
  if (autoOff && !req.body.manualNumber) {
    return res.status(400).json({
      error: "Auto numbering is off for this document — enter the number yourself, or switch it back on in Settings."
    });
  }
  if (req.body.useManualNumber === true || (autoOff && req.body.manualNumber)) {
    docNumber.logNumber(req, {
      docType: series, action: "reused", docId: id, docNumber: challanNo,
      detail: "Deleted number put back into use by the owner  reason: " +
        String(req.body.reuseReason || "").trim().slice(0, 300)
    });
  }
  // Same optional-backdate pattern as purchases.js/quotations.js — falls
  // back to today whenever the client doesn't send a valid YYYY-MM-DD date,
  // so every existing caller (which never sends one) keeps today's date.
  const invoiceDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, challan_no, doc_type, date, created_at, customer_id, subtotal, discount_type, discount_value,
      discount_amount, tax_type, cgst, sgst, igst, transport, loading, gst_on_charges, gst_enabled, round_off, total, advance, balance_due,
      payment_method, paper_size, delivery_man, vehicle_number, delivery_address, remarks, location_id, area_id,
      due_date, transport_mode, einvoice_wanted, ewb_wanted, created_by, updated_by, updated_at)
    VALUES (@id, @challanNo, @docType, @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
      @discountAmount, @taxType, @cgst, @sgst, @igst, @transport, @loading, @gstOnCharges, @gstEnabled, @roundOffAmount, @total, @advance,
      @balanceDue, @paymentMethod, @paperSize, @deliveryMan, @vehicleNumber, @deliveryAddress, @remarks, @locationId, @areaId,
      @dueDate, @transportMode, @einvoiceWanted, @ewbWanted, @createdBy, @updatedBy, @updatedAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, product_id, size_id, name, code, brand, hsn_code, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate, discount_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bumpDue = db.prepare("UPDATE customers SET due = ROUND(due + ?, 2) WHERE id = ?");

  db.transaction(() => {
    insertInvoice.run({
      id, challanNo, docType, date: invoiceDate, createdAt: Date.now(), customerId: customerId || null,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: isChallan ? 0 : (Number(discountValue) || 0), discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, gstOnCharges: gstOnCharges ? 1 : 0,
      gstEnabled: gstEnabled ? 1 : 0,
      // Absent means off. A caller that says nothing is not asking to file.
      einvoiceWanted: req.body.einvoiceWanted === true ? 1 : 0,
      ewbWanted: req.body.ewbWanted === true ? 1 : 0,
      /* Written once and never touched again on create; the edit handler
         moves updated_by/updated_at and leaves created_by alone. */
      createdBy: whoIs(req), updatedBy: whoIs(req), updatedAt: Date.now(),
      roundOffAmount: totals.roundOffAmount,
      total: totals.total, advance: totals.advance, balanceDue: totals.balanceDue,
      // A challan has no tender; store a dash rather than a misleading "Cash".
      paymentMethod: isChallan ? "—" : (paymentMethod || "Cash"),
      paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: (deliveryMan || "").trim(),
      vehicleNumber: (vehicleNumber || "").trim(),
      deliveryAddress: (deliveryAddress || "").trim(),
      remarks: (remarks || "").trim(),
      locationId: location,
      areaId: resolveAreaId(areaId, customerId),
      // Printed on the bill; neither drives any calculation.
      dueDate: (dueDate || "").trim() || null,
      transportMode: (transportMode || "").trim() || null
    });
    items.forEach(it => insertItem.run(
      id, it.productId, it.sizeId, it.name, it.code, it.brand, it.hsnCode, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit,
      // A challan's item RATE is now kept (optional, defaults 0) so the print
      // screen can offer "Delivery Challan (With Rate)" — but the invoice-level
      // GST/discount/transport/total above stays zero either way: a challan is
      // never a tax invoice regardless of whether a rate was noted per line.
      it.billedQty, it.rate, it.gstRate, it.discountPct || 0
    ));
    // Stock moves in pieces, not in billed area/length/volume — for a challan
    // too, since the goods physically leave the shop or warehouse. Deducted
    // per SIZE from this invoice's own location, then each touched product's
    // total is resynced.
    const touchedProducts = new Set();
    Object.entries(piecesBySize).forEach(([sizeId, pieces]) => {
      ledger.setContext({ movement: isChallan ? "stock_out" : "sale",
        refType: isChallan ? "Delivery Challan" : "Sales Invoice", refNo: challanNo, refId: id });
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

  /* AFTER the bill is saved and safe, never before.
     "Pakka" here means a real tax invoice: a challan carries no GST and an
     estimate is not a sale, and sending either to Tally books money that
     was never billed. The owner can switch those on deliberately. */
  offerToTally(req, "sales_invoice", invoice, {
    docNo: invoice.challan_no,
    pakka: !isChallan && invoice.gst_enabled !== 0,
    /* Hashed on what a voucher would actually contain, so re-saving a bill
       with an unchanged total does not rewrite Tally for nothing. */
    hashOn: { t: invoice.total, c: invoice.cgst, s: invoice.sgst, i: invoice.igst,
              d: invoice.date, p: invoice.customer_id,
              items: savedItems.map(x => [x.product_id, x.qty, x.rate, x.discount_amount]) }
  });

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
          vehicleNumber, deliveryAddress, remarks, taxType: taxTypeOverride, locationId, areaId, date,
          dueDate, transportMode } = req.body;
  const gstOnCharges = req.body.gstOnCharges !== false;
  const gstEnabled = req.body.gstEnabled !== false;
  // Same optional-date rule as creating: a valid YYYY-MM-DD moves the
  // document's date, anything else (including omitting it) keeps the date it
  // already has. Never falls back to today — that would silently re-stamp a
  // deliberately backdated bill just because someone fixed a typo in it.
  const editedDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : inv.date;

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
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate, discount_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const product = db.prepare("SELECT * FROM products WHERE id = ?").get(bindId(raw.productId));
      if (!product) throw { status: 400, error: `Product ${raw.productId} no longer exists.` };
      const size = raw.sizeId != null
        ? db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(bindId(raw.sizeId), product.id)
        : null;
      if (!size) throw { status: 400, error: `Choose a size for ${product.name} — it may have been removed since you added it.` };

      const line = {
        mode: Pricing.normaliseMode(raw.mode), lengthFt: raw.lengthFt, widthVal: raw.widthVal,
        thicknessIn: raw.thicknessIn, pieces: raw.pieces, rate: raw.rate
      };
      const invalid = Pricing.validateLine(line, `${product.name} (${size.label})`);
      if (invalid) throw { status: 400, error: invalid };

      const calc = applyLineDiscount(Pricing.computeLine(line), raw.discountPct);
      piecesBySize[size.id] = (piecesBySize[size.id] || 0) + calc.pieces;
      items.push({
        productId: product.id, sizeId: size.id, name: raw.name || product.name,
        code: product.code || "", brand: product.brand || "", hsnCode: product.hsn_code || "",
        gstRate: product.gst_rate, product, size, ...calc
      });
    }
    // Same check as the create path, through the same helper — the stock this
    // edit is measured against has already had the original lines put back
    // above, so it reflects what would really be on the shelf.
    const editStockProblem = checkSellableStock(piecesBySize, newLocation);
    if (editStockProblem) throw { status: 400, error: editStockProblem };

    const challanTransport = round2(Math.max(0, Number(transport) || 0));
    const challanLoading = round2(Math.max(0, Number(loading) || 0));
    const challanTotals = {
      subtotal: 0, discountAmount: 0, cgst: 0, sgst: 0, igst: 0,
      transport: challanTransport, loading: challanLoading, roundOffAmount: 0,
      total: round2(challanTransport + challanLoading), advance: 0, balanceDue: 0
    };
    const totals = isChallan
      ? challanTotals
      : computeTotals({ items, discountType, discountValue, advance, taxType, transport, loading, roundOff, gstOnCharges, gstEnabled });

    // 3. Reverse the OLD customer's due (whoever it was originally billed to).
    if (inv.customer_id && inv.balance_due > 0) {
      db.prepare("UPDATE customers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?").run(inv.balance_due, inv.customer_id);
    }

    // 4. Replace the line items.
    db.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").run(inv.id);
    items.forEach(it => insertItem.run(
      inv.id, it.productId, it.sizeId, it.name, it.code, it.brand, it.hsnCode, it.mode,
      it.lengthFt || null, it.widthVal || null, it.thicknessIn || null,
      it.sizeLabel, it.pieces, it.perPiece, it.unit, it.billedQty, it.rate, it.gstRate, it.discountPct || 0
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
        gst_on_charges=@gstOnCharges, gst_enabled=@gstEnabled, einvoice_wanted=@einvoiceWanted, ewb_wanted=@ewbWanted,
        round_off=@roundOffAmount, total=@total, advance=@advance,
        balance_due=@balanceDue, payment_method=@paymentMethod, paper_size=@paperSize,
        delivery_man=@deliveryMan, vehicle_number=@vehicleNumber, delivery_address=@deliveryAddress,
        due_date=@dueDate, transport_mode=@transportMode,
        remarks=@remarks, location_id=@locationId, area_id=@areaId, date=@date,
        updated_by=@updatedBy, updated_at=@updatedAt
      WHERE id=@id
    `).run({
      id: inv.id, date: editedDate, customerId: customerId || null,
      /* created_by is deliberately NOT touched. Who raised the bill and who
         last changed it are two different questions, and overwriting the
         first with the second loses the one the shop asks more often. */
      updatedBy: whoIs(req), updatedAt: Date.now(),
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: isChallan ? 0 : (Number(discountValue) || 0), discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, gstOnCharges: gstOnCharges ? 1 : 0,
      gstEnabled: gstEnabled ? 1 : 0,
      // Absent means off, the same rule the create path uses.
      einvoiceWanted: req.body.einvoiceWanted === true ? 1 : 0,
      ewbWanted: req.body.ewbWanted === true ? 1 : 0,
      roundOffAmount: totals.roundOffAmount, total: totals.total, advance: totals.advance,
      balanceDue: totals.balanceDue,
      paymentMethod: isChallan ? "—" : (paymentMethod || "Cash"),
      paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: (deliveryMan || "").trim(), vehicleNumber: (vehicleNumber || "").trim(),
      deliveryAddress: (deliveryAddress || "").trim(), remarks: (remarks || "").trim(),
      locationId: newLocation,
      areaId: resolveAreaId(areaId, customerId),
      dueDate: (dueDate || "").trim() || null,
      transportMode: (transportMode || "").trim() || null
    });

    // 7. Bump the (possibly new) customer's due by the new balance.
    if (customerId && totals.balanceDue > 0) {
      db.prepare("UPDATE customers SET due = ROUND(due + ?, 2) WHERE id = ?").run(totals.balanceDue, customerId);
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

/**
 * Marks a Delivery Challan's signed Office Copy as received back from the
 * customer (or reverts it to Pending if it was ticked by mistake).
 *
 * Any logged-in staff member can do this, not owner-only: whoever takes the
 * signed copy off the driver is the person standing there, and this records
 * paperwork coming back — it moves no stock and no money.
 */
router.post("/:id/acknowledge", (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "Challan not found." });
  if (inv.doc_type !== "challan") return res.status(400).json({ error: "Only a Delivery Challan can be acknowledged." });
  if (inv.voided) return res.status(400).json({ error: "This challan has been voided." });

  // Explicit false reverts to Pending; anything else (including a bare
  // {} body from a simple "mark received" tap) means received.
  const received = req.body.received !== false;
  const receiverName = (req.body.receiverName || "").trim();
  const remarks = (req.body.remarks || "").trim();

  db.prepare(`
    UPDATE invoices SET ack_status = ?, ack_received_at = ?, ack_receiver_name = ?, ack_remarks = ?
    WHERE id = ?
  `).run(
    received ? "Received" : "Pending",
    received ? Date.now() : null,
    received ? receiverName : "",
    received ? remarks : "",
    inv.id
  );

  logAction(req, received ? "challan.acknowledge" : "challan.acknowledge_undo",
    `${inv.challan_no}${received && receiverName ? " — signed by " + receiverName : ""}`);
  res.json(withStatus(db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id)));
});

/**
 * Delivery Challan -> Tax Invoice: raises the real bill for goods that have
 * already left the shop. No stock moves here — the challan itself deducted
 * it at creation — this only creates a priced invoice record (same items,
 * same rates already noted on the challan) and, unlike the challan, adds to
 * the customer's due. All-or-nothing, and only ever runs once per challan
 * (converted_invoice_id blocks a second conversion).
 */
router.post("/:id/convert-to-invoice", (req, res) => {
  const challan = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!challan) return res.status(404).json({ error: "Challan not found." });
  if (challan.doc_type !== "challan") return res.status(400).json({ error: "Only a Delivery Challan can be converted to an Invoice." });
  if (challan.voided) return res.status(400).json({ error: "This challan has been voided." });
  if (challan.converted_invoice_id) return res.status(400).json({ error: "This challan has already been converted to an invoice." });

  const challanItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(challan.id);
  if (!challanItems.length) return res.status(400).json({ error: "This challan has no items." });

  const { paymentMethod, advance, discountType, discountValue, taxTypeOverride, paperSize } = req.body;
  const gstOnCharges = req.body.gstOnCharges !== false;
  const gstEnabled = req.body.gstEnabled !== false;

  let customer = null;
  if (challan.customer_id) customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(challan.customer_id);
  const taxType = (taxTypeOverride === "IGST" || taxTypeOverride === "CGST_SGST")
    ? taxTypeOverride
    : (customer && customer.gst_type === "IGST" ? "IGST" : "CGST_SGST");

  // Reuse the rate/GST% already noted on the challan's own items — computeTotals
  // just needs each line's amount and GST rate, not the full geometry.
  // qty x rate is the GROSS line value; the stored discount_pct is what makes
  // it net, so the raised bill totals exactly what the challan's own print
  // showed rather than quietly dropping the line discounts.
  const items = challanItems.map(it => ({
    amount: round2(round2(it.qty * it.rate) * (1 - (Number(it.discount_pct) || 0) / 100)),
    gstRate: it.gst_rate
  }));
  const totals = computeTotals({
    items, discountType: discountType === "flat" ? "flat" : "pct", discountValue: Number(discountValue) || 0,
    advance, taxType, transport: challan.transport, loading: challan.loading,
    roundOff: false, gstOnCharges, gstEnabled
  });

  const invoiceId = uid("INV");
  const challanNo = nextDocNo("invoice");

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, challan_no, doc_type, date, created_at, customer_id, subtotal, discount_type, discount_value,
      discount_amount, tax_type, cgst, sgst, igst, transport, loading, gst_on_charges, gst_enabled, round_off, total, advance, balance_due,
      payment_method, paper_size, delivery_man, vehicle_number, delivery_address, remarks, location_id)
    VALUES (@id, @challanNo, 'invoice', @date, @createdAt, @customerId, @subtotal, @discountType, @discountValue,
      @discountAmount, @taxType, @cgst, @sgst, @igst, @transport, @loading, @gstOnCharges, @gstEnabled, @roundOffAmount, @total, @advance,
      @balanceDue, @paymentMethod, @paperSize, @deliveryMan, @vehicleNumber, @deliveryAddress, @remarks, @locationId)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, product_id, size_id, name, code, brand, hsn_code, mode, length_ft, width_val, thickness_in,
       size_label, pieces, per_piece, unit_label, qty, rate, gst_rate, discount_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertInvoice.run({
      id: invoiceId, challanNo, date: todayStr(), createdAt: Date.now(), customerId: challan.customer_id || null,
      subtotal: totals.subtotal, discountType: discountType === "flat" ? "flat" : "pct",
      discountValue: Number(discountValue) || 0, discountAmount: totals.discountAmount,
      taxType, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
      transport: totals.transport, loading: totals.loading, gstOnCharges: gstOnCharges ? 1 : 0,
      gstEnabled: gstEnabled ? 1 : 0, roundOffAmount: totals.roundOffAmount,
      total: totals.total, advance: totals.advance, balanceDue: totals.balanceDue,
      paymentMethod: paymentMethod || "Cash", paperSize: paperSize === "A4" ? "A4" : "A5",
      deliveryMan: challan.delivery_man, vehicleNumber: challan.vehicle_number,
      deliveryAddress: challan.delivery_address, remarks: `Converted from ${challan.challan_no}`,
      locationId: challan.location_id
    });
    // No stock movement here — the challan already took it out of stock when
    // it was created; this is purely raising the bill for goods already gone.
    challanItems.forEach(it => insertItem.run(
      invoiceId, it.product_id, it.size_id, it.name, it.code, it.brand, it.hsn_code, it.mode,
      it.length_ft, it.width_val, it.thickness_in, it.size_label, it.pieces, it.per_piece, it.unit_label,
      it.qty, it.rate, it.gst_rate, it.discount_pct || 0
    ));
    if (challan.customer_id && totals.balanceDue > 0) {
      db.prepare("UPDATE customers SET due = ROUND(due + ?, 2) WHERE id = ?").run(totals.balanceDue, challan.customer_id);
    }
    db.prepare("UPDATE invoices SET converted_invoice_id = ? WHERE id = ?").run(invoiceId, challan.id);
  })();

  logAction(req, "challan.convert", `${challan.challan_no} -> ${challanNo}`);
  res.json({
    challan: withStatus(db.prepare("SELECT * FROM invoices WHERE id = ?").get(challan.id)),
    invoice: withStatus(db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId))
  });
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
  const reduceDue = db.prepare("UPDATE customers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?");
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
  /* The Tally voucher is cancelled in place, never deleted — a hole in a
     numbered voucher book is a question an auditor will ask. */
  offerCancelToTally(req, "sales_invoice", inv);
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
  const reduceDue = db.prepare("UPDATE customers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?");
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

  /* Hand the number back if this was the latest one issued, so the next
     bill continues the sequence instead of leaving a hole. Done AFTER the
     row is gone, so "is anything numbered above it" is asked of what is
     really left. An older number stays spent — see docNumber.js rule 4. */
  const released = docNumber.releaseOnDelete(
    req, inv.doc_type === "challan" ? "challan" : "invoice", inv.challan_no, inv.id);

  logAction(req, inv.doc_type === "challan" ? "challan.delete" : "invoice.delete",
    `${inv.challan_no}${released ? " (number released for re-use)" : ""}`);
  res.json({ ok: true, releasedNumber: released ? released.number : null });
});

module.exports = router;
