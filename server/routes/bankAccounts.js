const express = require("express");
const db = require("../db");
const { uid, logAction, round2 } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

/** opening_balance plus every non-voided bank_entries row against this
 *  account -- never stored, always derived, so it can't drift from the
 *  ledger that produced it. */
function balanceOf(accountId) {
  const row = db.prepare("SELECT opening_balance FROM bank_accounts WHERE id = ?").get(accountId);
  if (!row) return 0;
  const moved = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS net
    FROM bank_entries WHERE bank_account_id = ? AND voided = 0
  `).get(accountId).net;
  return round2(row.opening_balance + moved);
}

router.get("/", (req, res) => {
  const accounts = db.prepare("SELECT * FROM bank_accounts ORDER BY active DESC, created_at ASC").all();
  res.json(accounts.map(a => ({ ...a, balance: balanceOf(a.id) })));
});

router.post("/", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter an account name." });
  const bankName = (req.body.bankName || "").trim();
  const accountNo = (req.body.accountNo || "").trim();
  const openingBalance = round2(Number(req.body.openingBalance) || 0);

  const id = uid("BANKACC");
  db.prepare(`
    INSERT INTO bank_accounts (id, name, bank_name, account_no, opening_balance, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, bankName, accountNo, openingBalance, Date.now());

  logAction(req, "bank_account.create", `${name}${bankName ? " (" + bankName + ")" : ""}`);
  res.status(201).json({ ...db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(id), balance: balanceOf(id) });
});

router.put("/:id", (req, res) => {
  const a = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Bank account not found." });

  const name = (req.body.name ?? a.name).trim();
  if (!name) return res.status(400).json({ error: "Enter an account name." });
  const bankName = (req.body.bankName ?? a.bank_name).trim();
  const accountNo = (req.body.accountNo ?? a.account_no).trim();
  const openingBalance = req.body.openingBalance !== undefined ? round2(Number(req.body.openingBalance)) : a.opening_balance;

  db.prepare(`
    UPDATE bank_accounts SET name=?, bank_name=?, account_no=?, opening_balance=? WHERE id=?
  `).run(name, bankName, accountNo, openingBalance, a.id);

  logAction(req, "bank_account.edit", `${a.name} -> ${name}`);
  res.json({ ...db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(a.id), balance: balanceOf(a.id) });
});

// Archive rather than delete -- history in bank_entries must keep a valid
// account to point at (and keep adding into that account's balance), it
// just stops being offered as a destination for new entries.
router.post("/:id/active", requireRole("owner"), (req, res) => {
  const a = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Bank account not found." });
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE bank_accounts SET active = ? WHERE id = ?").run(active, a.id);
  logAction(req, "bank_account.active", `${a.name}: ${active ? "activated" : "archived"}`);
  res.json({ ...db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(a.id), balance: balanceOf(a.id) });
});

module.exports = router;
