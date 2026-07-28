const express = require("express");
const db = require("../db");
const { uid, logAction, round2 } = require("../util");
const inventory = require("../inventory");

const router = express.Router();

const syncProductStockStmt = db.prepare(
  "UPDATE products SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_sizes WHERE product_id = products.id) WHERE id = ?"
);

router.get("/", (req, res) => {
  const { sizeId, locationId } = req.query;
  let rows = db.prepare("SELECT * FROM stock_transfers ORDER BY created_at DESC LIMIT 200").all();
  if (sizeId) rows = rows.filter(t => String(t.size_id) === String(sizeId));
  if (locationId) rows = rows.filter(t => t.from_location_id === locationId || t.to_location_id === locationId);
  res.json(rows);
});

/**
 * Moves quantity from one location to another for one size, in a single
 * transaction — decrement source, increment destination, log the move.
 * Never partial: if the source doesn't have enough, nothing happens at all.
 */
router.post("/", (req, res) => {
  const { sizeId, fromLocationId, toLocationId, quantity, reason } = req.body;

  const size = db.prepare("SELECT * FROM product_sizes WHERE id = ?").get(sizeId);
  if (!size) return res.status(400).json({ error: "Product size not found." });
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(size.product_id);
  if (!product) return res.status(400).json({ error: "Product not found." });

  const from = inventory.getLocationById(fromLocationId);
  const to = inventory.getLocationById(toLocationId);
  if (!from || !from.active) return res.status(400).json({ error: "Choose a valid source location." });
  if (!to || !to.active) return res.status(400).json({ error: "Choose a valid destination location." });
  if (from.id === to.id) return res.status(400).json({ error: "Source and destination must be different locations." });

  const qty = round2(Number(quantity));
  if (!qty || qty <= 0) return res.status(400).json({ error: "Enter a quantity greater than zero." });

  const available = inventory.getStock(size.id, from.id);
  if (qty > available) {
    return res.status(400).json({ error: `Not enough stock at ${from.name} — available ${available}, requested ${qty}.` });
  }

  const id = uid("XFR");
  db.transaction(() => {
    inventory.addStock(size.id, from.id, -qty);
    inventory.addStock(size.id, to.id, qty);
    syncProductStockStmt.run(product.id);
    db.prepare(`
      INSERT INTO stock_transfers (id, created_at, size_id, product_name, size_label, from_location_id, to_location_id, quantity, reason, staff_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, Date.now(), size.id, product.name, size.label, from.id, to.id, qty, (reason || "").trim(), (req.session && req.session.staffName) || "System");
  })();

  logAction(req, "stock.transfer", `${product.name} (${size.label}): ${qty} ${from.name} -> ${to.name}`);
  res.status(201).json({
    transfer: db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id),
    product: { ...product, stock: db.prepare("SELECT stock FROM products WHERE id = ?").get(product.id).stock }
  });
});

module.exports = router;
