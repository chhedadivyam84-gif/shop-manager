const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");

const router = express.Router();

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
function alreadyReturned(invoiceItemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(sri.pieces), 0) AS n
    FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.return_id
    WHERE sri.invoice_item_id = ? AND sr.voided = 0
  `).get(invoiceItemId).n;
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
    const invItem = db.prepare("SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?").get(raw.invoiceItemId, invoiceId);
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

  const shop = shopLocationId();
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
      subtotal, cgst, sgst, igst, total, method, shop, "");

    const touchedProducts = new Set();
    items.forEach(({ invItem, pieces, qty }) => {
      insertItem.run(id, invItem.id, invItem.product_id, invItem.size_id, invItem.name, invItem.size_label,
        pieces, invItem.unit_label, qty, invItem.rate, invItem.gst_rate);
      if (invItem.size_id) {
        inventory.addStock(invItem.size_id, shop, pieces);
        if (invItem.product_id) touchedProducts.add(invItem.product_id);
      }
    });
    touchedProducts.forEach(pid => syncProductStockStmt.run(pid));

    if (method === "AdjustDue" && invoice.customer_id) {
      db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(total, invoice.customer_id);
    }
  })();

  logAction(req, "return.create", `${returnNo}: against ${invoice.challan_no} — ${total} (${method})`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(id)));
});

/** Reverses stock and due exactly like Void on an invoice/purchase — flags
 *  the row rather than removing it, so the SR number sequence stays intact. */
router.post("/:id/void", requireRole("owner"), (req, res) => {
  const sr = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(req.params.id);
  if (!sr) return res.status(404).json({ error: "Sales Return not found." });
  if (sr.voided) return res.status(400).json({ error: "This return is already voided." });
  const items = db.prepare("SELECT * FROM sales_return_items WHERE return_id = ?").all(sr.id);
  const shop = sr.location_id || shopLocationId();

  try {
    db.transaction(() => {
      const touchedProducts = new Set();
      items.forEach(it => {
        if (!it.size_id) return;
        const atShop = inventory.getStock(it.size_id, shop);
        if (atShop < it.pieces) {
          throw { status: 400, error: `Can't void — ${it.name} stock has already been used elsewhere (only ${atShop} left, this return added ${it.pieces}).` };
        }
      });
      items.forEach(it => {
        if (!it.size_id) return;
        inventory.addStock(it.size_id, shop, -it.pieces);
        if (it.product_id) touchedProducts.add(it.product_id);
      });
      touchedProducts.forEach(pid => syncProductStockStmt.run(pid));
      if (sr.refund_method === "AdjustDue" && sr.customer_id) {
        db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(sr.total, sr.customer_id);
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
