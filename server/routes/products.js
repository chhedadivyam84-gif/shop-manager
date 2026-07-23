const express = require("express");
const db = require("../db");
const { uid } = require("../util");

const router = express.Router();

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
  const { name, brand, category, unit, gst, stock, godown, rack, sizes } = req.body;
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
    INSERT INTO products (id, name, brand, category, sku, unit, gst_rate, stock, godown, rack, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertProduct.run(
      id, name.trim(), (brand || "Generic").trim(), (category || "General").trim(),
      sku, (unit || "Piece").trim(), gstRate, Number(stock) || 0,
      (godown || "").trim(), (rack || "").trim(), Date.now()
    );
    validSizes.forEach((s, i) => insertSize.run(id, String(s.label).trim(), parseFloat(s.price), i));
  })();

  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  res.status(201).json(serialize(p));
});

router.put("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const { name, brand, category, unit, gst, godown, rack, sizes } = req.body;

  const update = db.prepare(`
    UPDATE products SET name=?, brand=?, category=?, unit=?, gst_rate=?, godown=?, rack=? WHERE id=?
  `);
  const deleteSizes = db.prepare("DELETE FROM product_sizes WHERE product_id = ?");
  const insertSize = db.prepare("INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)");

  db.transaction(() => {
    update.run(
      (name || p.name).trim(), (brand ?? p.brand), (category ?? p.category),
      (unit ?? p.unit), gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate,
      (godown ?? p.godown), (rack ?? p.rack), p.id
    );
    if (Array.isArray(sizes)) {
      const validSizes = sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)));
      deleteSizes.run(p.id);
      validSizes.forEach((s, i) => insertSize.run(p.id, String(s.label).trim(), parseFloat(s.price), i));
    }
  })();

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
  res.json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)));
});

router.delete("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  db.prepare("DELETE FROM products WHERE id = ?").run(p.id);
  res.json({ ok: true });
});

module.exports = router;
