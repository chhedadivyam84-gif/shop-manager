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


function warehouseLocationId() {
  return inventory.getLocationByCode("warehouse").id;
}

const syncProductStockStmt = db.prepare(
  "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
);

function nextReturnNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("purchase-return-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("purchase-return-no", next);
  return `PR${String(next).padStart(7, "0")}`;
}

// How much of one purchase_item has already been returned (across every
// non-voided return) — a partial return today doesn't allow re-returning
// the same pieces tomorrow.
/** How much of a purchase line has already gone back. `exceptReturnId` is
 *  for editing: a return being amended must not count its own pieces
 *  against the remaining returnable quantity. */
function alreadyReturned(purchaseItemId, exceptReturnId) {
  return db.prepare(`
    SELECT COALESCE(SUM(pri.pieces), 0) AS n
    FROM purchase_return_items pri JOIN purchase_returns pr ON pr.id = pri.return_id
    WHERE pri.purchase_item_id = ? AND pr.voided = 0
      AND (? IS NULL OR pr.id <> ?)
  `).get(purchaseItemId, exceptReturnId || null, exceptReturnId || null).n;
}

/** Reduces a supplier due and reports what actually moved, because the
 *  clamp at zero means a large return against a small due shifts less than
 *  its total — and the reversal has to give back exactly that. */
function applyDueReduction(supplierId, amount) {
  if (!supplierId || !(amount > 0)) return 0;
  const row = db.prepare("SELECT due FROM suppliers WHERE id = ?").get(supplierId);
  if (!row) return 0;
  const moved = Math.min(round2(row.due), round2(amount));
  db.prepare("UPDATE suppliers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?").run(amount, supplierId);
  return moved;
}

function ledgerToReverse(pr) {
  return pr.ledger_applied > 0 ? pr.ledger_applied : pr.total;
}

function serialize(pr) {
  const items = db.prepare("SELECT * FROM purchase_return_items WHERE return_id = ?").all(pr.id);
  const purchase = pr.purchase_id ? db.prepare("SELECT purchase_no FROM purchases WHERE id = ?").get(pr.purchase_id) : null;
  return { ...pr, items, purchase_no: purchase ? purchase.purchase_no : null };
}

router.get("/", (req, res) => {
  const { supplierId, purchaseId } = req.query;
  let rows = db.prepare("SELECT * FROM purchase_returns ORDER BY created_at DESC").all();
  if (supplierId) rows = rows.filter(r => r.supplier_id === supplierId);
  if (purchaseId) rows = rows.filter(r => r.purchase_id === purchaseId);
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const pr = db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(req.params.id);
  if (!pr) return res.status(404).json({ error: "Purchase Return not found." });
  res.json(serialize(pr));
});

/**
 * A debit note against a past Purchase — goods going back to the supplier.
 * Client sends which purchase_item rows are being returned and how many
 * pieces of each — everything else (name, size, rate, gst_rate) is read
 * back from that purchase_item, never trusted from the client, so a return
 * can't misprice itself relative to what was actually bought.
 */
router.post("/", (req, res) => {
  const { purchaseId, reason, refundMethod, items: rawItems } = req.body;

  if (!purchaseId) return res.status(400).json({ error: "Select the purchase this return is against." });
  const purchase = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId);
  if (!purchase) return res.status(400).json({ error: "That purchase no longer exists." });
  if (purchase.voided) return res.status(400).json({ error: "Can't return against a voided purchase." });

  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Select at least one item to return." });
  }
  const method = ["AdjustDue", "Cash", "Bank"].includes(refundMethod) ? refundMethod : "AdjustDue";

  const returnLocation = purchase.location_id || warehouseLocationId();
  const locationName = inventory.getLocationById(returnLocation).name;

  const items = [];
  for (const raw of rawItems) {
    const purItem = db.prepare("SELECT * FROM purchase_items WHERE id = ? AND purchase_id = ?").get(bindId(raw.purchaseItemId), purchaseId);
    if (!purItem) return res.status(400).json({ error: "One of the selected items doesn't belong to this purchase." });
    const pieces = Number(raw.pieces) || 0;
    if (pieces <= 0) return res.status(400).json({ error: `Enter a quantity to return for ${purItem.name}.` });
    const remaining = round2(purItem.pieces - alreadyReturned(purItem.id));
    if (pieces > remaining) {
      return res.status(400).json({ error: `Can't return ${pieces} of ${purItem.name} — only ${remaining} left returnable (already returned ${round2(purItem.pieces - remaining)}).` });
    }
    // Qty/rate scale down proportionally with pieces for a partial return —
    // same per-piece rate the item actually cost.
    const perPieceQty = purItem.pieces > 0 ? purItem.qty / purItem.pieces : 0;
    const qty = round2(perPieceQty * pieces);
    items.push({ purItem, pieces, qty });
  }

  // Goods physically have to be on hand to send back — stock check up
  // front, refuse cleanly rather than partially deduct.
  if (returnLocation) {
    const piecesBySize = {};
    items.forEach(({ purItem, pieces }) => {
      if (!purItem.size_id) return;
      piecesBySize[purItem.size_id] = (piecesBySize[purItem.size_id] || 0) + pieces;
    });
    for (const [sizeId, pieces] of Object.entries(piecesBySize)) {
      const atLocation = inventory.getStock(Number(sizeId), returnLocation);
      if (pieces > atLocation) {
        const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(sizeId);
        const product = size ? db.prepare("SELECT * FROM products WHERE id = ?").get(size.product_id) : null;
        return res.status(400).json({
          error: `Not enough ${locationName} stock to return ${product ? product.name : "this item"}${size ? " (" + size.label + ")" : ""}. Available: ${atLocation}, needed: ${pieces}.`
        });
      }
    }
  }

  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  items.forEach(({ purItem, qty }) => {
    const amount = round2(qty * purItem.rate);
    subtotal += amount;
    const tax = round2(amount * (purItem.gst_rate / 100));
    if (purchase.tax_type === "IGST") igst += tax;
    else { const half = round2(tax / 2); cgst += half; sgst += round2(tax - half); }
  });
  subtotal = round2(subtotal); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  const total = round2(subtotal + cgst + sgst + igst);

  const id = uid("PR");
  const returnNo = nextReturnNo();

  const insertReturn = db.prepare(`
    INSERT INTO purchase_returns (id, return_no, date, created_at, purchase_id, supplier_id, reason,
      subtotal, cgst, sgst, igst, total, refund_method, location_id, voided, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO purchase_return_items (return_id, purchase_item_id, product_id, size_id, name, size_label, pieces, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertReturn.run(id, returnNo, todayStr(), Date.now(), purchaseId, purchase.supplier_id, (reason || "").trim(),
      subtotal, cgst, sgst, igst, total, method, returnLocation, "");

    const touchedProducts = new Set();
    items.forEach(({ purItem, pieces, qty }) => {
      insertItem.run(id, purItem.id, purItem.product_id, purItem.size_id, purItem.name, purItem.size_label,
        pieces, purItem.unit_label, qty, purItem.rate, purItem.gst_rate);
      if (purItem.size_id) {
        ledger.setContext({ movement: "purchase_return", refType: "Purchase Return", refNo: returnNo, refId: id });
        inventory.addStock(purItem.size_id, returnLocation, -pieces);
        if (purItem.product_id) touchedProducts.add(purItem.product_id);
      }
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    if (method === "AdjustDue" && purchase.supplier_id) {
      const moved = applyDueReduction(purchase.supplier_id, total);
      db.prepare("UPDATE purchase_returns SET ledger_applied = ? WHERE id = ?").run(moved, id);
    }
  })();

  /* A purchase return is a Debit Note in Tally. The number and the date both live on the row, so
     nothing has to be normalised here the way it does for a payment. */
  {
    const saved = db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(id);
    offerToTally(req, "purchase_return", saved, {
      docNo: saved.return_no,
      /* A return against a bill that carried no GST is kachha, exactly as
         the bill it reverses was. */
      pakka: saved.gst_enabled !== 0
    });
  }

  logAction(req, "purchase_return.create", `${returnNo}: against ${purchase.purchase_no} — ${total} (${method})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(id)));
});

/**
 * Edit a purchase return.
 *
 * Mirrors the sales return — reverse fully, re-apply, one transaction — but
 * the stock risk sits on the opposite side. A purchase return SENDS GOODS
 * BACK, so applying it removes stock. Reversing the old one therefore always
 * succeeds, and it is the NEW quantity that can fail for want of stock.
 * Guarding the wrong side here would let an edit quietly go negative.
 */
router.put("/:id", requireRole("owner"), (req, res) => {
  const pr = db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(req.params.id);
  if (!pr) return res.status(404).json({ error: "Purchase Return not found." });
  if (pr.voided) return res.status(400).json({ error: "This return is voided — it cannot be edited." });

  const purchase = db.prepare("SELECT * FROM purchases WHERE id = ?").get(pr.purchase_id);
  if (!purchase) return res.status(400).json({ error: "The original purchase no longer exists." });

  const { reason, refundMethod, items: rawItems, date } = req.body;
  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: "Keep at least one item on the return, or void it instead." });
  }
  const method = ["AdjustDue", "Cash", "Bank"].includes(refundMethod) ? refundMethod : pr.refund_method;

  const items = [];
  for (const raw of rawItems) {
    const purItem = db.prepare("SELECT * FROM purchase_items WHERE id = ? AND purchase_id = ?")
      .get(bindId(raw.purchaseItemId), pr.purchase_id);
    if (!purItem) return res.status(400).json({ error: "One of the items doesn't belong to the original purchase." });
    const pieces = Number(raw.pieces) || 0;
    if (pieces <= 0) return res.status(400).json({ error: `Enter a quantity for ${purItem.name}, or remove the line.` });
    const remaining = round2(purItem.pieces - alreadyReturned(purItem.id, pr.id));
    if (pieces > remaining) {
      return res.status(400).json({
        error: `Can't return ${pieces} of ${purItem.name} — only ${remaining} is still returnable on this purchase.`
      });
    }
    const perPieceQty = purItem.pieces > 0 ? purItem.qty / purItem.pieces : 0;
    items.push({ purItem, pieces, qty: round2(perPieceQty * pieces) });
  }

  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  items.forEach(({ purItem, qty }) => {
    const amount = round2(qty * purItem.rate);
    subtotal += amount;
    const tax = round2(amount * (purItem.gst_rate / 100));
    if (purchase.tax_type === "IGST") igst += tax;
    else { const half = round2(tax / 2); cgst += half; sgst += round2(tax - half); }
  });
  subtotal = round2(subtotal); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  const total = round2(subtotal + cgst + sgst + igst);

  const oldItems = db.prepare("SELECT * FROM purchase_return_items WHERE return_id = ?").all(pr.id);
  const location = pr.location_id || shopLocationId();

  const insertItem = db.prepare(`
    INSERT INTO purchase_return_items (return_id, purchase_item_id, product_id, size_id, name, size_label, pieces, unit_label, qty, rate, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    db.transaction(() => {
      const touched = new Set();

      // 1. reverse: goods that had gone back come in again — always possible
      oldItems.forEach(it => {
        if (!it.size_id) return;
        inventory.addStock(it.size_id, location, it.pieces);
        if (it.product_id) touched.add(it.product_id);
      });
      if (pr.refund_method === "AdjustDue" && pr.supplier_id) {
        db.prepare("UPDATE suppliers SET due = ROUND(due + ?, 2) WHERE id = ?").run(ledgerToReverse(pr), pr.supplier_id);
      }

      // 2. apply: THIS is the side that can fail, because sending goods back
      //    takes them off the shelf. Checked after the reversal, so the stock
      //    the old return is giving up counts towards the new one.
      items.forEach(({ purItem, pieces }) => {
        if (!purItem.size_id) return;
        const atLocation = inventory.getStock(purItem.size_id, location);
        if (atLocation < pieces) {
          throw { status: 400, error: `Can't return ${pieces} of ${purItem.name} — only ${atLocation} in stock at that location to send back.` };
        }
      });

      db.prepare("DELETE FROM purchase_return_items WHERE return_id = ?").run(pr.id);
      items.forEach(({ purItem, pieces, qty }) => {
        insertItem.run(pr.id, purItem.id, purItem.product_id, purItem.size_id, purItem.name,
          purItem.size_label, pieces, purItem.unit_label, qty, purItem.rate, purItem.gst_rate);
        if (purItem.size_id) {
          inventory.addStock(purItem.size_id, location, -pieces);
          if (purItem.product_id) touched.add(purItem.product_id);
        }
      });
      touched.forEach(pid => syncProductStockStmt.run(pid));

      const movedNow = method === "AdjustDue" ? applyDueReduction(pr.supplier_id, total) : 0;

      db.prepare(`
        UPDATE purchase_returns SET date = ?, reason = ?, refund_method = ?,
          subtotal = ?, cgst = ?, sgst = ?, igst = ?, total = ?, ledger_applied = ?
        WHERE id = ?
      `).run(date || pr.date, (reason || "").trim(), method,
             subtotal, cgst, sgst, igst, total, movedNow, pr.id);
    })();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "purchase_return.edit", `${pr.return_no}: ${pr.total} -> ${total} (${method})`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(pr.id)));
});

/** A fresh draft with the same lines and a new number, capped at what is
 *  still returnable. Touches neither stock nor ledger. */
router.post("/:id/duplicate", (req, res) => {
  const pr = db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(req.params.id);
  if (!pr) return res.status(404).json({ error: "Purchase Return not found." });
  const items = db.prepare("SELECT * FROM purchase_return_items WHERE return_id = ?").all(pr.id);

  const usable = [];
  for (const it of items) {
    const purItem = db.prepare("SELECT * FROM purchase_items WHERE id = ?").get(it.purchase_item_id);
    if (!purItem) continue;
    const remaining = round2(purItem.pieces - alreadyReturned(purItem.id, null));
    if (remaining > 0) usable.push({ purchaseItemId: it.purchase_item_id, pieces: Math.min(it.pieces, remaining) });
  }
  if (!usable.length) {
    return res.status(400).json({ error: "Nothing left to return on that purchase — it has all been returned already." });
  }
  res.json({ purchaseId: pr.purchase_id, reason: pr.reason, refundMethod: pr.refund_method, items: usable });
});


/** Reverses stock and due exactly like Void on a purchase/invoice — flags
 *  the row rather than removing it, so the PR number sequence stays intact. */
router.post("/:id/void", requireRole("owner"), (req, res) => {
  const pr = db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(req.params.id);
  if (!pr) return res.status(404).json({ error: "Purchase Return not found." });
  if (pr.voided) return res.status(400).json({ error: "This return is already voided." });
  const items = db.prepare("SELECT * FROM purchase_return_items WHERE return_id = ?").all(pr.id);
  const location = pr.location_id || warehouseLocationId();

  db.transaction(() => {
    const touchedProducts = new Set();
    items.forEach(it => {
      if (!it.size_id) return;
      inventory.addStock(it.size_id, location, it.pieces);
      if (it.product_id) touchedProducts.add(it.product_id);
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
    if (pr.refund_method === "AdjustDue" && pr.supplier_id) {
      db.prepare("UPDATE suppliers SET due = ROUND(due + ?, 2) WHERE id = ?").run(ledgerToReverse(pr), pr.supplier_id);
    }
    db.prepare("UPDATE purchase_returns SET voided = 1 WHERE id = ?").run(pr.id);
  })();

  logAction(req, "purchase_return.void", `${pr.return_no}`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(pr.id)));
});

module.exports = router;
