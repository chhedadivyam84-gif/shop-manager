/* ============================================================
   ACCOUNTING — one-time-entry masters
   ------------------------------------------------------------
   Capital, fixed assets, loans, security deposits and accrued
   liabilities: the figures a shop cannot derive from its own
   trading activity, and which the owner therefore has to state
   once. Everything here is owner-only — these lines move the
   Balance Sheet's bottom line without any goods or money moving
   through the shop, so a staff member must not be able to edit
   them.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { outstandingDetails } = require("../outstanding");
const { uid, round2, todayStr, logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

const money = v => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n) : 0;
};
const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const text = v => String(v == null ? "" : v).trim();

/* ---------------- Capital ---------------- */

const CAPITAL_KINDS = ["opening", "introduced", "drawings"];

router.get("/capital", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM capital_entries WHERE voided = 0 ORDER BY date ASC, created_at ASC"
  ).all();
  res.json({ rows, summary: capitalSummary() });
});

/** Opening + introduced − drawings. Net profit is NOT added here: it belongs
 *  to the Balance Sheet, which knows the reporting period. */
function capitalSummary() {
  const rows = db.prepare("SELECT kind, amount FROM capital_entries WHERE voided = 0").all();
  const sum = k => round2(rows.filter(r => r.kind === k).reduce((s, r) => s + r.amount, 0));
  const opening = sum("opening"), introduced = sum("introduced"), drawings = sum("drawings");
  return { opening, introduced, drawings, beforeProfit: round2(opening + introduced - drawings) };
}

router.post("/capital", requireRole("owner"), (req, res) => {
  const { kind, amount, date, remarks } = req.body;
  if (!CAPITAL_KINDS.includes(kind)) {
    return res.status(400).json({ error: "Choose Opening Capital, Capital Introduced or Drawings." });
  }
  const amt = money(amount);
  if (!(amt > 0)) return res.status(400).json({ error: "Enter an amount greater than zero." });
  // Only one opening figure makes sense — a second would silently double the
  // shop's starting capital, and the owner would have no way to see why.
  if (kind === "opening") {
    const existing = db.prepare("SELECT id FROM capital_entries WHERE kind = 'opening' AND voided = 0").get();
    if (existing) {
      return res.status(400).json({ error: "Opening Capital is already set. Edit or remove the existing entry instead of adding a second one." });
    }
  }
  const id = uid("CAP");
  db.prepare(`
    INSERT INTO capital_entries (id, date, kind, amount, remarks, voided, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(id, day(date) || todayStr(), kind, amt, text(remarks), Date.now());
  logAction(req, "capital.add", `${kind}: ${amt}`);
  res.status(201).json(db.prepare("SELECT * FROM capital_entries WHERE id = ?").get(id));
});

router.delete("/capital/:id", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM capital_entries WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Entry not found." });
  // Voided, never deleted — last year's Balance Sheet must still explain itself.
  db.prepare("UPDATE capital_entries SET voided = 1 WHERE id = ?").run(row.id);
  logAction(req, "capital.void", `${row.kind}: ${row.amount}`);
  res.json({ ok: true });
});

/* ---------------- Fixed assets ---------------- */

router.get("/fixed-assets", (req, res) => {
  const rows = db.prepare("SELECT * FROM fixed_assets WHERE active = 1 ORDER BY created_at ASC").all()
    .map(r => ({ ...r, net_value: round2(r.cost - r.accumulated_depreciation) }));
  res.json({ rows, total: round2(rows.reduce((s, r) => s + r.net_value, 0)) });
});

router.post("/fixed-assets", requireRole("owner"), (req, res) => {
  const { name, category, purchaseDate, cost, accumulatedDepreciation, remarks } = req.body;
  if (!text(name)) return res.status(400).json({ error: "Asset name is required." });
  const c = money(cost);
  const dep = money(accumulatedDepreciation);
  // Depreciation above cost would show the asset as a negative-value item and
  // quietly reduce total assets — almost always a typo, so it is refused.
  if (dep > c) return res.status(400).json({ error: "Depreciation cannot be more than the asset's cost." });
  const id = uid("FA");
  db.prepare(`
    INSERT INTO fixed_assets (id, name, category, purchase_date, cost, accumulated_depreciation, remarks, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, text(name), text(category), day(purchaseDate), c, dep, text(remarks), Date.now());
  logAction(req, "asset.add", `${text(name)}: ${c}`);
  res.status(201).json(db.prepare("SELECT * FROM fixed_assets WHERE id = ?").get(id));
});

router.put("/fixed-assets/:id", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM fixed_assets WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Asset not found." });
  const { name, category, purchaseDate, cost, accumulatedDepreciation, remarks } = req.body;
  const c = cost === undefined ? row.cost : money(cost);
  const dep = accumulatedDepreciation === undefined ? row.accumulated_depreciation : money(accumulatedDepreciation);
  if (dep > c) return res.status(400).json({ error: "Depreciation cannot be more than the asset's cost." });
  db.prepare(`
    UPDATE fixed_assets SET name=?, category=?, purchase_date=?, cost=?, accumulated_depreciation=?, remarks=? WHERE id=?
  `).run(
    name === undefined ? row.name : text(name),
    category === undefined ? row.category : text(category),
    purchaseDate === undefined ? row.purchase_date : day(purchaseDate),
    c, dep,
    remarks === undefined ? row.remarks : text(remarks),
    row.id
  );
  logAction(req, "asset.update", row.name);
  res.json(db.prepare("SELECT * FROM fixed_assets WHERE id = ?").get(row.id));
});

router.delete("/fixed-assets/:id", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM fixed_assets WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Asset not found." });
  db.prepare("UPDATE fixed_assets SET active = 0 WHERE id = ?").run(row.id);
  logAction(req, "asset.remove", row.name);
  res.json({ ok: true });
});

/* ---------------- Loans and other liabilities ---------------- */

router.get("/loans", (req, res) => {
  const rows = db.prepare("SELECT * FROM loans WHERE active = 1 ORDER BY created_at ASC").all();
  res.json({
    rows,
    bankTotal: round2(rows.filter(r => r.kind === "bank").reduce((s, r) => s + r.outstanding, 0)),
    otherTotal: round2(rows.filter(r => r.kind !== "bank").reduce((s, r) => s + r.outstanding, 0)),
    total: round2(rows.reduce((s, r) => s + r.outstanding, 0))
  });
});

router.post("/loans", requireRole("owner"), (req, res) => {
  const { lender, kind, principal, outstanding, interestRate, startDate, remarks } = req.body;
  if (!text(lender)) return res.status(400).json({ error: "Lender name is required." });
  const p = money(principal);
  // Outstanding defaults to the principal: a loan entered today has normally
  // not been repaid yet, and leaving it at zero would understate liabilities.
  const out = outstanding === undefined || outstanding === "" ? p : money(outstanding);
  const id = uid("LOAN");
  db.prepare(`
    INSERT INTO loans (id, lender, kind, principal, outstanding, interest_rate, start_date, remarks, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, text(lender), kind === "other" ? "other" : "bank", p, out,
         money(interestRate), day(startDate), text(remarks), Date.now());
  logAction(req, "loan.add", `${text(lender)}: ${out}`);
  res.status(201).json(db.prepare("SELECT * FROM loans WHERE id = ?").get(id));
});

router.put("/loans/:id", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM loans WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Loan not found." });
  const { lender, kind, principal, outstanding, interestRate, startDate, remarks } = req.body;
  db.prepare(`
    UPDATE loans SET lender=?, kind=?, principal=?, outstanding=?, interest_rate=?, start_date=?, remarks=? WHERE id=?
  `).run(
    lender === undefined ? row.lender : text(lender),
    kind === undefined ? row.kind : (kind === "other" ? "other" : "bank"),
    principal === undefined ? row.principal : money(principal),
    outstanding === undefined ? row.outstanding : money(outstanding),
    interestRate === undefined ? row.interest_rate : money(interestRate),
    startDate === undefined ? row.start_date : day(startDate),
    remarks === undefined ? row.remarks : text(remarks),
    row.id
  );
  logAction(req, "loan.update", row.lender);
  res.json(db.prepare("SELECT * FROM loans WHERE id = ?").get(row.id));
});

router.delete("/loans/:id", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM loans WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Loan not found." });
  db.prepare("UPDATE loans SET active = 0 WHERE id = ?").run(row.id);
  logAction(req, "loan.remove", row.lender);
  res.json({ ok: true });
});

/* ---------------- Security deposits (asset) ---------------- */

router.get("/deposits", (req, res) => {
  const rows = db.prepare("SELECT * FROM deposits WHERE active = 1 ORDER BY created_at ASC").all();
  res.json({ rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) });
});

router.post("/deposits", requireRole("owner"), (req, res) => {
  const { heldBy, purpose, amount, paidDate, remarks } = req.body;
  if (!text(heldBy)) return res.status(400).json({ error: "Enter who is holding the deposit." });
  const id = uid("DEP");
  db.prepare(`
    INSERT INTO deposits (id, held_by, purpose, amount, paid_date, remarks, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, text(heldBy), text(purpose), money(amount), day(paidDate), text(remarks), Date.now());
  logAction(req, "deposit.add", `${text(heldBy)}: ${money(amount)}`);
  res.status(201).json(db.prepare("SELECT * FROM deposits WHERE id = ?").get(id));
});

router.delete("/deposits/:id", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM deposits WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Deposit not found." });
  db.prepare("UPDATE deposits SET active = 0 WHERE id = ?").run(row.id);
  logAction(req, "deposit.remove", row.held_by);
  res.json({ ok: true });
});

/* ---------------- Outstanding (accrued) liabilities ---------------- */

router.get("/outstanding", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM outstanding_liabilities WHERE settled = 0 ORDER BY created_at ASC"
  ).all();
  const byCategory = {};
  rows.forEach(r => {
    const k = r.category || "Other";
    byCategory[k] = round2((byCategory[k] || 0) + r.amount);
  });
  res.json({ rows, byCategory, total: round2(rows.reduce((s, r) => s + r.amount, 0)) });
});

router.post("/outstanding", requireRole("owner"), (req, res) => {
  const { label, category, amount, dueDate, remarks } = req.body;
  if (!text(label)) return res.status(400).json({ error: "Describe what is owed." });
  const id = uid("OL");
  db.prepare(`
    INSERT INTO outstanding_liabilities (id, label, category, amount, due_date, settled, settled_date, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, 0, '', ?, ?)
  `).run(id, text(label), text(category), money(amount), day(dueDate), text(remarks), Date.now());
  logAction(req, "outstanding.add", `${text(label)}: ${money(amount)}`);
  res.status(201).json(db.prepare("SELECT * FROM outstanding_liabilities WHERE id = ?").get(id));
});

/** Marked settled rather than deleted, so a past-dated statement still shows
 *  the liability as it stood then. */
router.post("/outstanding/:id/settle", requireRole("owner"), (req, res) => {
  const row = db.prepare("SELECT * FROM outstanding_liabilities WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Entry not found." });
  db.prepare("UPDATE outstanding_liabilities SET settled = 1, settled_date = ? WHERE id = ?")
    .run(day(req.body && req.body.date) || todayStr(), row.id);
  logAction(req, "outstanding.settle", `${row.label}: ${row.amount}`);
  res.json({ ok: true });
});

/* Party-wise outstanding with its bill-wise breakdown and aging.
   Derived on read, so it can never drift from the bills and payments it
   describes. side=customer (receivable) or supplier (payable). */
router.get("/outstanding-details", (req, res) => {
  const side = req.query.side === "supplier" ? "supplier" : "customer";
  res.json(outstandingDetails(side));
});

module.exports = router;
module.exports.capitalSummary = capitalSummary;
