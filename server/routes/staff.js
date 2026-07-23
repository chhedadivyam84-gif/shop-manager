const express = require("express");
const db = require("../db");
const { hashPin } = require("../auth");
const { uid, logAction } = require("../util");

const router = express.Router();

function serialize(s) {
  const { pin_hash, ...rest } = s;
  return rest;
}

router.get("/", (req, res) => {
  const staff = db.prepare("SELECT * FROM staff ORDER BY role DESC, name ASC").all();
  res.json(staff.map(serialize));
});

router.post("/", (req, res) => {
  const { name, pin, role } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });
  if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: "PIN must be 4-6 digits." });
  const finalRole = role === "owner" ? "owner" : "staff";

  const id = uid("STAFF");
  db.prepare(`
    INSERT INTO staff (id, name, pin_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)
  `).run(id, name.trim(), hashPin(String(pin)), finalRole, Date.now());

  logAction(req, "staff.create", `Added ${finalRole} "${name.trim()}"`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM staff WHERE id = ?").get(id)));
});

router.put("/:id", (req, res) => {
  const s = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Staff member not found." });
  const { name, pin, role, active } = req.body;

  if (s.role === "owner" && (role === "staff" || active === false)) {
    const owners = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1").get().n;
    if (owners <= 1) return res.status(400).json({ error: "There must always be at least one active owner." });
  }

  let pinHash = s.pin_hash;
  if (pin) {
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: "PIN must be 4-6 digits." });
    pinHash = hashPin(String(pin));
  }

  db.prepare(`
    UPDATE staff SET name=?, pin_hash=?, role=?, active=? WHERE id=?
  `).run(
    (name || s.name).trim(), pinHash, role === "owner" || role === "staff" ? role : s.role,
    active !== undefined ? (active ? 1 : 0) : s.active, s.id
  );

  logAction(req, "staff.update", `Updated "${s.name}"${pin ? " (PIN changed)" : ""}${active === false ? " — deactivated" : ""}`);
  res.json(serialize(db.prepare("SELECT * FROM staff WHERE id = ?").get(s.id)));
});

router.delete("/:id", (req, res) => {
  const s = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Staff member not found." });
  if (s.role === "owner") {
    const owners = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1").get().n;
    if (owners <= 1) return res.status(400).json({ error: "There must always be at least one active owner." });
  }
  if (s.id === req.session.staffId) return res.status(400).json({ error: "You can't remove your own account while logged in." });

  db.prepare("DELETE FROM staff WHERE id = ?").run(s.id);
  logAction(req, "staff.delete", `Removed "${s.name}"`);
  res.json({ ok: true });
});

module.exports = router;
