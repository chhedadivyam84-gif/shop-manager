const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
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
          defaultMode, lengthFt, widthVal, thicknessIn } = req.body;
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
    INSERT INTO products (id, name, brand, category, sku, unit, gst_rate, stock, godown, rack,
      default_mode, length_ft, width_val, thickness_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertProduct.run(
      id, name.trim(), (brand || "Generic").trim(), (category || "General").trim(),
      sku, (unit || "Piece").trim(), gstRate, Number(stock) || 0,
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
          defaultMode, lengthFt, widthVal, thicknessIn } = req.body;

  const update = db.prepare(`
    UPDATE products SET name=?, brand=?, category=?, unit=?, gst_rate=?, godown=?, rack=?,
      default_mode=?, length_ft=?, width_val=?, thickness_in=? WHERE id=?
  `);
  const deleteSizes = db.prepare("DELETE FROM product_sizes WHERE product_id = ?");
  const insertSize = db.prepare("INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)");

  db.transaction(() => {
    update.run(
      (name || p.name).trim(), (brand ?? p.brand), (category ?? p.category),
      (unit ?? p.unit), gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate,
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

router.post("/:id/stock-in", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const qty = Number(req.body.qty);
  if (!qty || qty <= 0) return res.status(400).json({ error: "Enter a valid quantity received." });
  const costPrice = Number(req.body.costPrice) || 0;
  const supplier = (req.body.supplier || "").trim();
  const note = (req.body.note || "").trim();

  const id = uid("SI");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO stock_ins (id, product_id, product_name, qty, cost_price, supplier, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, p.id, p.name, qty, costPrice, supplier, note, Date.now());
    db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(qty, p.id);
  })();

  logAction(req, "product.stock_in", `${p.name}: +${qty}${supplier ? " from " + supplier : ""}`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)));
});

router.get("/:id/stock-in", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const rows = db.prepare("SELECT * FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 20").all(p.id);
  res.json(rows);
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  db.prepare("DELETE FROM products WHERE id = ?").run(p.id);
  logAction(req, "product.delete", p.name);
  res.json({ ok: true });
});

module.exports = router;
