const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");

const router = express.Router();

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
function alreadyReturned(purchaseItemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(pri.pieces), 0) AS n
    FROM purchase_return_items pri JOIN purchase_returns pr ON pr.id = pri.return_id
    WHERE pri.purchase_item_id = ? AND pr.voided = 0
  `).get(purchaseItemId).n;
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
    const purItem = db.prepare("SELECT * FROM purchase_items WHERE id = ? AND purchase_id = ?").get(raw.purchaseItemId, purchaseId);
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
        inventory.addStock(purItem.size_id, returnLocation, -pieces);
        if (purItem.product_id) touchedProducts.add(purItem.product_id);
      }
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    if (method === "AdjustDue" && purchase.supplier_id) {
      db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(total, purchase.supplier_id);
    }
  })();

  logAction(req, "purchase_return.create", `${returnNo}: against ${purchase.purchase_no} — ${total} (${method})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(id)));
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
      db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(pr.total, pr.supplier_id);
    }
    db.prepare("UPDATE purchase_returns SET voided = 1 WHERE id = ?").run(pr.id);
  })();

  logAction(req, "purchase_return.void", `${pr.return_no}`);
  res.json(serialize(db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(pr.id)));
});

module.exports = router;
