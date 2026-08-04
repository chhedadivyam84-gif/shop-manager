const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { logAction } = require("../util");
const inventory = require("../inventory");

const router = express.Router();

function syncProductStock(productId) {
  const total = db.prepare(
    "SELECT COALESCE(SUM(stock),0) AS t FROM product_sizes WHERE product_id = ?"
  ).get(productId).t;
  db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(total, productId);
}

/**
 * Force-delete a stock-in record regardless of whether the stock it added
 * is still traceable — for cleaning up old/erroneous entries whose product
 * was since removed (product_id/size_id go NULL via ON DELETE SET NULL,
 * see db.js) or whose stock has already moved on through later sales or
 * transfers. Reverses stock/due only when it's safe to do so (won't drive
 * a live size negative); otherwise leaves current stock untouched and just
 * removes the historical record — this never corrupts what's actually on
 * hand. Unlike DELETE /api/products/:id/stock-in/:siId, this never refuses.
 */
router.delete("/:id", requireRole("owner"), (req, res) => {
  const si = db.prepare("SELECT * FROM stock_ins WHERE id = ?").get(req.params.id);
  if (!si) return res.status(404).json({ error: "Purchase record not found." });

  db.transaction(() => {
    if (si.size_id != null) {
      const locationId = si.location_id || inventory.getLocationByCode("warehouse").id;
      const atLocation = inventory.getStock(si.size_id, locationId);
      if (atLocation >= si.qty) {
        inventory.addStock(si.size_id, locationId, -si.qty);
        if (si.product_id) syncProductStock(si.product_id);
      }
      // else: this stock has already moved on elsewhere — leave current
      // stock untouched rather than driving it negative.
    }
    if (si.supplier_id) db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(si.grand_total, si.supplier_id);
    db.prepare("DELETE FROM stock_ins WHERE id = ?").run(si.id);
  })();

  logAction(req, "stock_in.force_delete", `${si.product_name} (${si.id})`);
  res.json({ ok: true });
});

module.exports = router;
