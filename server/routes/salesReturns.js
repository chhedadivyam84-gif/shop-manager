const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");
const ledger = require("../stockLedger");

const router = express.Router();

/**
 * Offer a finished document to Tally.
 *
 * WRAPPED IN EVERYTHING, deliberately. This runs at the tail of saving, and
 * a sync problem must never be able to fail the entry  not a missing
 * module, not a broken require, not a database error. The record is already
 * saved; the worst this may do is nothing.
 *
 * It only QUEUES. Sending happens separately, so Tally being off, slow or
 * sitting on a dialog cannot make anyone wait at the counter.
 */
function offerToTally(req, docType, doc, opts) {
  try {
    const svc = require("../tally/service");
    const r = svc.enqueue(docType, doc, {
      ...(opts || {}),
      staff: (req.session && req.session.staffName) || ""
    });
    if (r && r.queued) {
      try { require("../tally/autosync").nudge(); } catch (e) { /* never fatal */ }
    }
    return r;
  } catch (e) {
    return { queued: false, reason: e.message };
  }
}


function shopLocationId() {
  return inventory.getLocationByCode("shop").id;
}

const syncProductStockStmt = db.prepare(
  "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
);

function nextReturnNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("return-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("return-no", next);
  return `SR${String(next).padStart(7, "0")}`;
}

// How much of one invoice_item has already been returned (across every
// non-voided return) — a partial return today doesn't allow re-returning
// the same pieces tomorrow.
/**
 * How much of an invoice line has already come back.
 *
 * `exceptReturnId` exists for editing: a return being amended must not have
 * its OWN pieces counted against the remaining returnable quantity, or
 * changing 10 to 9 would be refused for exceeding a limit it is itself
 * responsible for.
 */
/**
 * Reduces a customer's due and reports how much it actually moved.
 *
 * The clamp at zero means a 5,900 return against a 5,000 due only shifts
 * 5,000. Reversing later must give back 5,000, not 5,900 — so the caller
 * stores what this returns rather than assuming the total.
 */
function applyDueReduction(customerId, amount) {
  if (!customerId || !(amount > 0)) return 0;
  const row = db.prepare("SELECT due FROM customers WHERE id = ?").get(customerId);
  if (!row) return 0;
  const moved = Math.min(round2(row.due), round2(amount));
  db.prepare("UPDATE customers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?").run(amount, customerId);
  return moved;
}

/** What to give back when reversing. Rows created before ledger_applied
 *  existed have 0 stored, so they fall back to the old assumption. */
function ledgerToReverse(sr) {
  return sr.ledger_applied > 0 ? sr.ledger_applied : sr.total;
}

function alreadyReturned(invoiceItemId, exceptReturnId) {
  return db.prepare(`
    SELECT COALESCE(SUM(sri.pieces), 0) AS n
    FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.return_id
    WHERE sri.invoice_item_id = ? AND sr.voided = 0
      AND (? IS NULL OR sr.id <> ?)
  `).get(invoiceItemId, exceptReturnId || null, exceptReturnId || null).n;
}

function serialize(sr) {
  const items = db.prepare("SELECT * FROM sales_return_items WHERE return_id = ?").all(sr.id);
  const invoice = sr.invoice_id ? db.prepare("SELECT challan_no FROM invoices WHERE id = ?").get(sr.invoice_id) : null;
  return { ...sr, items, invoice_challan_no: invoice ? invoice.challan_no : null };
}

router.get("/", (req, res) => {
  const { customerId, invoiceId } = req.query;
  let rows = db.prepare("SELECT * FROM sales_returns ORDER BY created_at DESC").all();
  if (customerId) rows = rows.filter(r => r.customer_id === customerId);
  if (invoiceId) rows = rows.filter(r => r.invoice_id === invoiceId);
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const sr = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(req.params.id);
  if (!sr) return res.status(404).json({ error: "Sales Return not found." });
  res.json(serialize(sr));
});

/**
 * A credit note against a past Tax Invoice. Client sends which invoice_item
 * rows are being returned and how many pieces of each — everything else
 * (name, size, rate, gst_rate) is read back from that invoice_item, never
 * trusted from the client, so a return can't misprice itself relative to
 * what was actually sold.
 */
router.post("/", (req, res) => {
  const { invoiceId, reason, refundMethod, items: rawItems } = req.body;

  if (!invoiceId) return res.status(400).json({ error: "Select the invoice this return is against." });
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
  if (!invoice) return res.status(400).json({ error: "That invoice no longer exists." });
  if (invoice.voided) return res.status(400).json({ error: "Can't return against a voided invoice." });
  if (invoice.doc_type !== "invoice") return res.status(400).json({ error: "Returns can only be made against a Tax Invoice, not a Delivery Challan." });

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Select at least one item to return." });
  }
  const method = ["AdjustDue", "Cash", "Bank"].includes(refundMethod) ? refundMethod : "AdjustDue";

  const items = [];
  for (const raw of rawItems) {
    const invItem = db.prepare("SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?").get(bindId(raw.invoiceItemId), invoiceId);
    if (!invItem) return res.status(400).json({ error: "One of the selected items doesn't belong to this invoice." });
    const pieces = Number(raw.pieces) || 0;
    if (pieces <= 0) return res.status(400).json({ error: `Enter a quantity to return for ${invItem.name}.` });
    const remaining = round2(invItem.pieces - alreadyReturned(invItem.id));
    if (pieces > remaining) {
      return res.status(400).json({ error: `Can't return ${pieces} of ${invItem.name} — only ${remaining} left returnable (already returned ${round2(invItem.pieces - remaining)}).` });
    }
    // Qty/rate scale down proportionally with pieces for a partial return —
    // same per-piece rate the item actually sold at.
    const perPieceQty = invItem.pieces > 0 ? invItem.qty / invItem.pieces : 0;
    const qty = round2(perPieceQty * pieces);
    items.push({ invItem, pieces, qty });
  }

  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  items.forEach(({ invItem, qty }) => {
    const amount = round2(qty * invItem.rate);
    subtotal += amount;
    const tax = round2(amount * (invItem.gst_rate / 100));
    if (invoice.tax_type === "IGST") igst += tax;
    else { const half = round2(tax / 2); cgst += half; sgst += round2(tax - half); }
  });
  subtotal = round2(subtotal); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  const total = round2(subtotal + cgst + sgst + igst);

  // A return credits stock back to wherever the original sale actually
  // deducted it from — Shop by default, but Warehouse if that invoice was
  // sold from there (see invoices.js's location_id).
  const returnLocation = invoice.location_id || shopLocationId();
  const id = uid("SR");
  const returnNo = nextReturnNo();

  const insertReturn = db.prepare(`
    INSERT INTO sales_returns (id, return_no, date, created_at, invoice_id, customer_id, reason,
      subtotal, cgst, sgst, igst, total, refund_method, location_id, voided, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sales_return_items (return_id, invoice_item_id, product_id, size_id, name, size_label, pieces, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertReturn.run(id, returnNo, todayStr(), Date.now(), invoiceId, invoice.customer_id, (reason || "").trim(),
      subtotal, cgst, sgst, igst, total, method, returnLocation, "");

    const touchedProducts = new Set();
    items.forEach(({ invItem, pieces, qty }) => {
      insertItem.run(id, invItem.id, invItem.product_id, invItem.size_id, invItem.name, invItem.size_label,
        pieces, invItem.unit_label, qty, invItem.rate, invItem.gst_rate);
      if (invItem.size_id) {
        ledger.setContext({ movement: "sales_return", refType: "Sales Return", refNo: returnNo, refId: id });
        inventory.addStock(invItem.size_id, returnLocation, pieces);
        if (invItem.product_id) touchedProducts.add(invItem.product_id);
      }
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    if (method === "AdjustDue" && invoice.customer_id) {
      const moved = applyDueReduction(invoice.customer_id, total);
      db.prepare("UPDATE sales_returns SET ledger_applied = ? WHERE id = ?").run(moved, id);
    }
  })();

  /* A sales return is a Credit Note in Tally. The number and the date both live on the row, so
     nothing has to be normalised here the way it does for a payment. */
  {
    const saved = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(id);
    offerToTally(req, "sales_return", saved, {
      docNo: saved.return_no,
      /* A return against a bill that carried no GST is kachha, exactly as
         the bill it reverses was. */
      pakka: saved.gst_enabled !== 0
    });
  }

  logAction(req, "return.create", `${returnNo}: against ${invoice.challan_no} — ${total} (${method})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(id)));
});

/**
 * Edit a sales return.
 *
 * Reverse the old effect, apply the new one, in ONE transaction. Not a
 * delta: computing "you changed 10 to 7, so add 3 back" means the correction
 * is only ever as good as the arithmetic, and a single rounding slip leaves
 * stock permanently wrong with nothing to compare against. Reversing fully
 * and re-applying means the end state is derived from the new data alone.
 *
 * The return number never changes — it is a numbered document, and editing
 * its contents does not make it a different document.
 *
 * Refused rather than forced when the returned stock has since been sold on:
 * lowering the return would drive stock negative, and a silently negative
 * shelf is worse than an edit that explains why it cannot happen.
 */
router.put("/:id", requireRole("owner"), (req, res) => {
  const sr = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(req.params.id);
  if (!sr) return res.status(404).json({ error: "Sales Return not found." });
  if (sr.voided) return res.status(400).json({ error: "This return is voided — restore it before editing." });

  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(sr.invoice_id);
  if (!invoice) return res.status(400).json({ error: "The original invoice no longer exists." });

  const { reason, refundMethod, items: rawItems, date } = req.body;
  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Keep at least one item on the return, or void it instead." });
  }
  const method = ["AdjustDue", "Cash", "Bank"].includes(refundMethod) ? refundMethod : sr.refund_method;

  // --- validate the NEW lines against what is returnable, ignoring this return
  const items = [];
  for (const raw of rawItems) {
    const invItem = db.prepare("SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?")
      .get(bindId(raw.invoiceItemId), sr.invoice_id);
    if (!invItem) return res.status(400).json({ error: "One of the items doesn't belong to the original invoice." });
    const pieces = Number(raw.pieces) || 0;
    if (pieces <= 0) return res.status(400).json({ error: `Enter a quantity for ${invItem.name}, or remove the line.` });
    const remaining = round2(invItem.pieces - alreadyReturned(invItem.id, sr.id));
    if (pieces > remaining) {
      return res.status(400).json({
        error: `Can't return ${pieces} of ${invItem.name} — only ${remaining} is still returnable on this invoice.`
      });
    }
    const perPieceQty = invItem.pieces > 0 ? invItem.qty / invItem.pieces : 0;
    items.push({ invItem, pieces, qty: round2(perPieceQty * pieces) });
  }

  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  items.forEach(({ invItem, qty }) => {
    const amount = round2(qty * invItem.rate);
    subtotal += amount;
    const tax = round2(amount * (invItem.gst_rate / 100));
    if (invoice.tax_type === "IGST") igst += tax;
    else { const half = round2(tax / 2); cgst += half; sgst += round2(tax - half); }
  });
  subtotal = round2(subtotal); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  const total = round2(subtotal + cgst + sgst + igst);

  const oldItems = db.prepare("SELECT * FROM sales_return_items WHERE return_id = ?").all(sr.id);
  const location = sr.location_id || shopLocationId();

  const insertItem = db.prepare(`
    INSERT INTO sales_return_items (return_id, invoice_item_id, product_id, size_id, name, size_label, pieces, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    db.transaction(() => {
      const touched = new Set();

      // 1. reverse the old effect — refusing if that stock has moved on
      oldItems.forEach(it => {
        if (!it.size_id) return;
        const atLocation = inventory.getStock(it.size_id, location);
        if (atLocation < it.pieces) {
          throw { status: 400, error: `Can't edit — ${it.name} stock has already been used elsewhere (only ${atLocation} left, this return added ${it.pieces}).` };
        }
      });
      oldItems.forEach(it => {
        if (!it.size_id) return;
        inventory.addStock(it.size_id, location, -it.pieces);
        if (it.product_id) touched.add(it.product_id);
      });
      if (sr.refund_method === "AdjustDue" && sr.customer_id) {
        db.prepare("UPDATE customers SET due = ROUND(due + ?, 2) WHERE id = ?").run(ledgerToReverse(sr), sr.customer_id);
      }

      // 2. apply the new one
      db.prepare("DELETE FROM sales_return_items WHERE return_id = ?").run(sr.id);
      items.forEach(({ invItem, pieces, qty }) => {
        insertItem.run(sr.id, invItem.id, invItem.product_id, invItem.size_id, invItem.name,
          invItem.size_label, pieces, invItem.unit_label, qty, invItem.rate, invItem.gst_rate);
        if (invItem.size_id) {
          inventory.addStock(invItem.size_id, location, pieces);
          if (invItem.product_id) touched.add(invItem.product_id);
        }
      });
      touched.forEach(pid => syncProductStockStmt.run(pid));

      const movedNow = method === "AdjustDue" ? applyDueReduction(sr.customer_id, total) : 0;

      db.prepare(`
        UPDATE sales_returns SET date = ?, reason = ?, refund_method = ?,
          subtotal = ?, cgst = ?, sgst = ?, igst = ?, total = ?, ledger_applied = ?
        WHERE id = ?
      `).run(date || sr.date, (reason || "").trim(), method,
             subtotal, cgst, sgst, igst, total, movedNow, sr.id);
    })();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "return.edit", `${sr.return_no}: ${sr.total} -> ${total} (${method})`);
  res.json(serialize(db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(sr.id)));
});

/**
 * Duplicate — a fresh draft with the same lines and a NEW number.
 *
 * Stock and ledger are deliberately NOT touched here: this creates a return
 * through the normal create path's rules, and a copy that silently moved
 * stock would be a second return nobody reviewed.
 */
router.post("/:id/duplicate", (req, res) => {
  const sr = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(req.params.id);
  if (!sr) return res.status(404).json({ error: "Sales Return not found." });
  const items = db.prepare("SELECT * FROM sales_return_items WHERE return_id = ?").all(sr.id);

  // Only what is still returnable, so a duplicate cannot exceed the invoice.
  const usable = [];
  for (const it of items) {
    const invItem = db.prepare("SELECT * FROM invoice_items WHERE id = ?").get(it.invoice_item_id);
    if (!invItem) continue;
    const remaining = round2(invItem.pieces - alreadyReturned(invItem.id, null));
    if (remaining > 0) usable.push({ invoiceItemId: it.invoice_item_id, pieces: Math.min(it.pieces, remaining) });
  }
  if (!usable.length) {
    return res.status(400).json({ error: "Nothing left to return on that invoice — it has all been returned already." });
  }
  res.json({ invoiceId: sr.invoice_id, reason: sr.reason, refundMethod: sr.refund_method, items: usable });
});


/** Reverses stock and due exactly like Void on an invoice/purchase — flags
 *  the row rather than removing it, so the SR number sequence stays intact. */
router.post("/:id/void", requireRole("owner"), (req, res) => {
  const sr = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(req.params.id);
  if (!sr) return res.status(404).json({ error: "Sales Return not found." });
  if (sr.voided) return res.status(400).json({ error: "This return is already voided." });
  const items = db.prepare("SELECT * FROM sales_return_items WHERE return_id = ?").all(sr.id);
  const location = sr.location_id || shopLocationId();

  try {
    db.transaction(() => {
      const touchedProducts = new Set();
      items.forEach(it => {
        if (!it.size_id) return;
        const atLocation = inventory.getStock(it.size_id, location);
        if (atLocation < it.pieces) {
          throw { status: 400, error: `Can't void — ${it.name} stock has already been used elsewhere (only ${atLocation} left, this return added ${it.pieces}).` };
        }
      });
      items.forEach(it => {
        if (!it.size_id) return;
        inventory.addStock(it.size_id, location, -it.pieces);
        if (it.product_id) touchedProducts.add(it.product_id);
      });
      touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
      if (sr.refund_method === "AdjustDue" && sr.customer_id) {
        db.prepare("UPDATE customers SET due = ROUND(due + ?, 2) WHERE id = ?").run(ledgerToReverse(sr), sr.customer_id);
      }
      db.prepare("UPDATE sales_returns SET voided = 1 WHERE id = ?").run(sr.id);
    })();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "return.void", `${sr.return_no}`);
  res.json(serialize(db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(sr.id)));
});

module.exports = router;
