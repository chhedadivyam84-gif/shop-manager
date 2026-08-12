// Income and expense categories — the master behind Other Income and
// Other Expenses, and behind the lines on the Profit & Loss.
//
// These were two hardcoded arrays in reports.js matched against a free-text
// box, so anything spelled differently vanished into "Uncategorised". See the
// note beside txn_categories in db.js.
const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

const KINDS = ["income", "expense"];

router.get("/", (req, res) => {
  const all = req.query.all === "true";
  const rows = db.prepare(
    `SELECT * FROM txn_categories ${all ? "" : "WHERE active = 1"}
     ORDER BY kind ASC, sort_order ASC, name ASC`
  ).all();
  res.json({
    income: rows.filter(r => r.kind === "income"),
    expense: rows.filter(r => r.kind === "expense")
  });
});

router.post("/", requireRole("owner"), (req, res) => {
  const kind = String(req.body.kind || "").trim();
  const name = String(req.body.name || "").trim();
  if (!KINDS.includes(kind)) return res.status(400).json({ error: "Choose Income or Expense." });
  if (!name) return res.status(400).json({ error: "Enter a category name." });
  if (name.length > 60) return res.status(400).json({ error: "That category name is too long (60 characters maximum)." });

  // Case-insensitive, so "salary" cannot be added alongside "Salary" and split
  // the same spending across two Profit & Loss lines.
  const clash = db.prepare(
    "SELECT * FROM txn_categories WHERE kind = ? AND LOWER(name) = LOWER(?)"
  ).get(kind, name);
  if (clash) {
    if (clash.active === 0) {
      db.prepare("UPDATE txn_categories SET active = 1 WHERE id = ?").run(clash.id);
      logAction(req, "category.activate", `${kind}: ${clash.name}`);
      return res.json(db.prepare("SELECT * FROM txn_categories WHERE id = ?").get(clash.id));
    }
    return res.status(400).json({ error: `"${clash.name}" is already in the ${kind} list.` });
  }

  const id = uid("CAT");
  const maxSort = db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS n FROM txn_categories WHERE kind = ?"
  ).get(kind).n;
  db.prepare(
    "INSERT INTO txn_categories (id, kind, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, kind, name, maxSort + 1, Date.now());
  logAction(req, "category.create", `${kind}: ${name}`);
  res.status(201).json(db.prepare("SELECT * FROM txn_categories WHERE id = ?").get(id));
});

/* Retired, never deleted. Past entries still carry the name, and removing the
   row would drop them out of their Profit & Loss line and into
   Uncategorised — rewriting a year that has already been reported on. */
router.patch("/:id/active", requireRole("owner"), (req, res) => {
  const c = db.prepare("SELECT * FROM txn_categories WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Category not found." });
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE txn_categories SET active = ? WHERE id = ?").run(active, c.id);
  logAction(req, active ? "category.activate" : "category.deactivate", `${c.kind}: ${c.name}`);
  res.json(db.prepare("SELECT * FROM txn_categories WHERE id = ?").get(c.id));
});

module.exports = router;
