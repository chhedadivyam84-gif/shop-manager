const express = require("express");
const db = require("../db");
const { uid, logAction, todayStr, round2 } = require("../util");
const { requireRole } = require("../auth");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

/** Optional numeric field: blank/absent stays NULL rather than becoming 0. */
function dim(v, fallback) {
  if (v === undefined) return fallback === undefined ? null : fallback;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function loadSizes(productId) {
  return db.prepare("SELECT id, label, price FROM product_sizes WHERE product_id = ? ORDER BY sort_order ASC, id ASC").all(productId);
}

function serialize(p) {
  return { ...p, gst: p.gst_rate, sizes: loadSizes(p.id) };
}

router.get("/", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY name ASC").all();
  res.json(products.map(serialize));
});

router.post("/", (req, res) => {
  const { name, brand, category, unit, gst, stock, godown, rack, sizes,
          defaultMode, lengthFt, widthVal, thicknessIn, hsnCode } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Product name is required." });
  }
  const validSizes = Array.isArray(sizes)
    ? sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)))
    : [];
  if (!validSizes.length) {
    return res.status(400).json({ error: "Add at least one size/variant with a price." });
  }
  const id = uid("P");
  const sku = "SKU-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const gstRate = gst !== undefined && gst !== null && gst !== "" ? Number(gst) : 18;

  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, brand, category, sku, unit, hsn_code, gst_rate, stock, godown, rack,
      default_mode, length_ft, width_val, thickness_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertProduct.run(
      id, name.trim(), (brand || "Generic").trim(), (category || "General").trim(),
      sku, (unit || "Piece").trim(), (hsnCode || "").trim(), gstRate, Number(stock) || 0,
      (godown || "").trim(), (rack || "").trim(),
      Pricing.normaliseMode(defaultMode), dim(lengthFt), dim(widthVal), dim(thicknessIn),
      Date.now()
    );
    validSizes.forEach((s, i) => insertSize.run(id, String(s.label).trim(), parseFloat(s.price), i));
  })();

  logAction(req, "product.create", name.trim());
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  res.status(201).json(serialize(p));
});

router.put("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const { name, brand, category, unit, gst, godown, rack, sizes,
          defaultMode, lengthFt, widthVal, thicknessIn, hsnCode } = req.body;

  // A product's price lives in its size rows, so an edit that supplies a `sizes`
  // array must leave at least one valid entry — otherwise the product becomes
  // unsellable and crashes the billing screen. Create enforces this; edit must
  // too, or the guard is trivially bypassed by clearing the field and saving.
  if (Array.isArray(sizes)) {
    const valid = sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)));
    if (!valid.length) {
      return res.status(400).json({ error: "Keep at least one size/variant with a price." });
    }
  }

  const update = db.prepare(`
    UPDATE products SET name=?, brand=?, category=?, unit=?, hsn_code=?, gst_rate=?, godown=?, rack=?,
      default_mode=?, length_ft=?, width_val=?, thickness_in=? WHERE id=?
  `);
  const deleteSizes = db.prepare("DELETE FROM product_sizes WHERE product_id = ?");
  const insertSize = db.prepare("INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)");

  db.transaction(() => {
    update.run(
      (name || p.name).trim(), (brand ?? p.brand), (category ?? p.category),
      (unit ?? p.unit), (hsnCode ?? p.hsn_code),
      gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate,
      (godown ?? p.godown), (rack ?? p.rack),
      defaultMode !== undefined ? Pricing.normaliseMode(defaultMode) : p.default_mode,
      dim(lengthFt, p.length_ft), dim(widthVal, p.width_val), dim(thicknessIn, p.thickness_in),
      p.id
    );
    if (Array.isArray(sizes)) {
      const validSizes = sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)));
      deleteSizes.run(p.id);
      validSizes.forEach((s, i) => insertSize.run(p.id, String(s.label).trim(), parseFloat(s.price), i));
    }
  })();

  logAction(req, "product.update", p.name);
  const updated = db.prepare("SELECT * FROM products WHERE id = ?").get(p.id);
  res.json(serialize(updated));
});

router.patch("/:id/stock", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  let newStock;
  if (req.body.stock !== undefined) newStock = Number(req.body.stock);
  else if (req.body.delta !== undefined) newStock = p.stock + Number(req.body.delta);
  else return res.status(400).json({ error: "Provide stock or delta." });
  newStock = Math.max(0, newStock);
  db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(newStock, p.id);
  logAction(req, "product.stock_adjust", `${p.name}: ${p.stock} → ${newStock}`);
  res.json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)));
});

/**
 * Full Purchase Entry for one product: date, supplier, invoice number, size/
 * thickness with the SAME auto Sq.ft calculation sales use (via the shared
 * Pricing module), GST, transport, and a grand total. `qty` is the physical
 * pieces received — what stock goes up by; `billedQty` (Sq.ft/Sq.m/etc) is
 * what the rate multiplies, exactly mirroring an invoice line.
 */
router.post("/:id/stock-in", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  const {
    purchaseDate, invoiceNo, supplier, note,
    mode, lengthFt, widthVal, thicknessIn, pieces, rate, gst, transport
  } = req.body;

  const line = {
    mode: Pricing.normaliseMode(mode || p.default_mode),
    lengthFt, widthVal, thicknessIn, pieces, rate
  };
  const invalid = Pricing.validateLine(line, p.name);
  if (invalid) return res.status(400).json({ error: invalid });

  const calc = Pricing.computeLine(line);
  const gstRate = gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate;
  const gstAmount = round2(calc.amount * (gstRate / 100));
  const transportAmt = round2(Math.max(0, Number(transport) || 0));
  const grandTotal = round2(calc.amount + gstAmount + transportAmt);
  const date = (purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) ? purchaseDate : todayStr();
  // Cost per physical piece — the basis the Profit Report uses for any future
  // sale of this product. Transport is included: it is a real cost of getting
  // the stock onto the shelf, same as the board itself.
  const costPrice = calc.pieces > 0 ? round2((calc.amount + transportAmt) / calc.pieces) : 0;

  const id = uid("SI");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO stock_ins
        (id, product_id, product_name, purchase_date, invoice_no, supplier, brand, category,
         mode, length_ft, width_val, thickness_in, size_label, qty, per_piece, billed_qty,
         unit_label, rate, amount, gst_rate, gst_amount, transport, grand_total, cost_price, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, p.id, p.name, date, (invoiceNo || "").trim(), (supplier || "").trim(), p.brand, p.category,
      calc.mode, calc.lengthFt || null, calc.widthVal || null, calc.thicknessIn || null, calc.sizeLabel,
      calc.pieces, calc.perPiece, calc.billedQty, calc.unit, calc.rate, calc.amount,
      gstRate, gstAmount, transportAmt, grandTotal, costPrice, (note || "").trim(), Date.now()
    );
    db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(calc.pieces, p.id);
  })();

  logAction(req, "product.stock_in", `${p.name}: +${calc.pieces}${supplier ? " from " + supplier.trim() : ""} — Grand Total ${grandTotal}`);
  res.status(201).json({
    product: serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)),
    purchase: db.prepare("SELECT * FROM stock_ins WHERE id = ?").get(id)
  });
});

router.get("/:id/stock-in", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const rows = db.prepare("SELECT * FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 20").all(p.id);
  res.json(rows);
});

/**
 * Copy a product into a new one — the fast way to add the next thickness or
 * grade of a board that is otherwise identical.
 *
 * Opening stock is deliberately 0 rather than the original's: a duplicate is a
 * DIFFERENT physical item, and inheriting 100 sheets would invent inventory
 * that nobody ever received. The user records a stock-in for the real count.
 */
router.post("/:id/duplicate", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  const id = uid("P");
  const sku = "SKU-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const name = String(req.body && req.body.name ? req.body.name : p.name + " (Copy)").trim().slice(0, 120);
  const sizes = loadSizes(p.id);

  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, brand, category, sku, unit, gst_rate, stock, godown, rack,
      default_mode, length_ft, width_val, thickness_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(
    "INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)"
  );

  db.transaction(() => {
    insertProduct.run(
      id, name, p.brand, p.category, sku, p.unit, p.gst_rate, p.godown, p.rack,
      p.default_mode, p.length_ft, p.width_val, p.thickness_in, Date.now()
    );
    sizes.forEach((s, i) => insertSize.run(id, s.label, s.price, i));
  })();

  logAction(req, "product.duplicate", `${p.name} -> ${name}`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(id)));
});

/**
 * How much history a product carries, so the delete confirmation can say
 * "this appears on 12 invoices" instead of a blind "are you sure?".
 */
router.get("/:id/usage", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  // Matches the DELETE route's guard exactly (counts voided sales too) so this
  // endpoint never tells the client "safe to delete" when the server would
  // then refuse it.
  const invoiceCount = db.prepare(
    "SELECT COUNT(DISTINCT invoice_id) AS n FROM invoice_items WHERE product_id = ?"
  ).get(p.id).n;
  const stockInCount = db.prepare("SELECT COUNT(*) AS n FROM stock_ins WHERE product_id = ?").get(p.id).n;
  res.json({ invoiceCount, stockInCount, stock: p.stock });
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  // A product that has ever gone out on a sale or challan cannot be deleted —
  // even a voided one, since the historical line still references it and losing
  // the product would break that document's product link for future reference.
  // Purchases (stock_ins) do NOT block deletion: a product bought but never
  // sold is fair game to remove.
  const usedInSales = db.prepare(
    "SELECT COUNT(*) AS n FROM invoice_items WHERE product_id = ?"
  ).get(p.id).n;
  if (usedInSales > 0) {
    return res.status(400).json({
      error: `"${p.name}" can't be deleted — it has been used in ${usedInSales} sale line${usedInSales > 1 ? "s" : ""}. Products already sold or on a challan are kept for record-keeping.`
    });
  }

  // Past invoices keep their own copy of the name, size and rate, so deleting a
  // product never rewrites history — the sale still prints exactly as issued.
  db.prepare("DELETE FROM products WHERE id = ?").run(p.id);
  logAction(req, "product.delete", p.name);
  res.json({ ok: true });
});

module.exports = router;
