const express = require("express");
const db = require("../db");
const { uid } = require("../util");

const router = express.Router();

router.get("/", (req, res) => {
  const customers = db.prepare("SELECT * FROM customers ORDER BY name ASC").all();
  res.json(customers);
});

router.get("/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const history = db.prepare(`
    SELECT id, challan_no, date, total FROM invoices
    WHERE customer_id = ? AND voided = 0 ORDER BY created_at DESC
  `).all(c.id);
  res.json({ ...c, history });
});

router.post("/", (req, res) => {
  const { name, type, phone, gst, state, creditLimit } = req.body;
  if (!name || !String(name).trim() || !phone || !String(phone).trim()) {
    return res.status(400).json({ error: "Name and phone are required." });
  }
  const id = uid("C");
  db.prepare(`
    INSERT INTO customers (id, name, type, phone, gst, state, credit_limit, due, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, name.trim(), type || "Retail Customer", phone.trim(), (gst || "").trim(), (state || "").trim(), Number(creditLimit) || 0, Date.now());
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const { name, type, phone, gst, state, creditLimit } = req.body;
  db.prepare(`
    UPDATE customers SET name=?, type=?, phone=?, gst=?, state=?, credit_limit=? WHERE id=?
  `).run(
    (name || c.name).trim(), type ?? c.type, (phone ?? c.phone), (gst ?? c.gst),
    (state ?? c.state), creditLimit !== undefined ? Number(creditLimit) : c.credit_limit, c.id
  );
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.delete("/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  db.prepare("DELETE FROM customers WHERE id = ?").run(c.id);
  res.json({ ok: true });
});

module.exports = router;
