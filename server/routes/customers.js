const express = require("express");
const db = require("../db");
const { uid, logAction, round2 } = require("../util");
const { requireRole } = require("../auth");

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
  const payments = db.prepare(`
    SELECT * FROM payments WHERE customer_id = ? AND voided = 0 ORDER BY created_at DESC
  `).all(c.id);

  // A single chronological ledger — invoices raise the due, payments lower it —
  // is what actually answers "what does this customer owe and why", rather
  // than two disconnected lists staff have to mentally merge themselves.
  const invoiceRows = db.prepare(`
    SELECT id, challan_no, date, total, created_at FROM invoices WHERE customer_id = ? AND voided = 0
  `).all(c.id);
  const ledger = [
    ...invoiceRows.map(h => ({ type: "invoice", id: h.id, label: h.challan_no, amount: h.total, date: h.date, at: h.created_at })),
    ...payments.map(p => ({ type: "payment", id: p.id, label: p.method, amount: -p.amount, note: p.note, date: new Date(p.created_at).toISOString().slice(0, 10), at: p.created_at }))
  ].sort((a, b) => b.at - a.at);

  res.json({ ...c, history, payments, ledger });
});

router.post("/:id/payments", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid payment amount." });
  const method = req.body.method || "Cash";
  const note = (req.body.note || "").trim();

  const id = uid("PAY");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (id, customer_id, amount, method, note, voided, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(id, c.id, amount, method, note, Date.now());
    db.prepare("UPDATE customers SET due = MAX(0, due - ?) WHERE id = ?").run(amount, c.id);
  })();

  logAction(req, "payment.record", `${c.name}: ${amount} (${method})`);
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.post("/:id/payments/:paymentId/void", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const p = db.prepare("SELECT * FROM payments WHERE id = ? AND customer_id = ?").get(req.params.paymentId, c.id);
  if (!p) return res.status(404).json({ error: "Payment not found." });
  if (p.voided) return res.status(400).json({ error: "Payment already voided." });

  db.transaction(() => {
    db.prepare("UPDATE payments SET voided = 1 WHERE id = ?").run(p.id);
    db.prepare("UPDATE customers SET due = due + ? WHERE id = ?").run(p.amount, c.id);
  })();

  logAction(req, "payment.void", `${c.name}: ${p.amount} (${p.method})`);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.post("/", (req, res) => {
  const { name, type, phone, address, gst, state, creditLimit } = req.body;
  if (!name || !String(name).trim() || !phone || !String(phone).trim()) {
    return res.status(400).json({ error: "Name and phone are required." });
  }
  const id = uid("C");
  db.prepare(`
    INSERT INTO customers (id, name, type, phone, address, gst, state, credit_limit, due, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, name.trim(), type || "Retail Customer", phone.trim(), (address || "").trim(), (gst || "").trim(), (state || "").trim(), Number(creditLimit) || 0, Date.now());
  logAction(req, "customer.create", name.trim());
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  const { name, type, phone, address, gst, state, creditLimit } = req.body;
  db.prepare(`
    UPDATE customers SET name=?, type=?, phone=?, address=?, gst=?, state=?, credit_limit=? WHERE id=?
  `).run(
    (name || c.name).trim(), type ?? c.type, (phone ?? c.phone), (address ?? c.address), (gst ?? c.gst),
    (state ?? c.state), creditLimit !== undefined ? Number(creditLimit) : c.credit_limit, c.id
  );
  logAction(req, "customer.update", c.name);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Customer not found." });
  db.prepare("DELETE FROM customers WHERE id = ?").run(c.id);
  logAction(req, "customer.delete", c.name);
  res.json({ ok: true });
});

module.exports = router;
