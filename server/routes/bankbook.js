const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr } = require("../util");
const { requireRole } = require("../auth");
const { saveAttachment } = require("../attachments");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

function activeAccount(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM bank_accounts WHERE id = ? AND active = 1").get(id);
}
/** First active account, for routes that need a sensible default when the
 *  caller doesn't specify one (mirrors resolveLocationId in other routes). */
function defaultAccountId() {
  const a = db.prepare("SELECT id FROM bank_accounts WHERE active = 1 ORDER BY created_at ASC LIMIT 1").get();
  return a ? a.id : null;
}

/**
 * Every non-voided entry for ONE account, oldest-first, each annotated with
 * the running balance of THAT account immediately after it, starting from
 * its opening_balance — balances are now per-account, not global, since a
 * shop can hold more than one bank account.
 */
function chronoWithBalance(accountId) {
  const account = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(accountId);
  if (!account) return [];
  const rows = db.prepare(`
    SELECT * FROM bank_entries WHERE bank_account_id = ? AND voided = 0 ORDER BY date ASC, created_at ASC
  `).all(accountId);
  let running = account.opening_balance;
  return rows.map(r => {
    running = round2(running + (r.type === "in" ? r.amount : -r.amount));
    return { ...r, runningBalance: running };
  });
}

router.get("/", (req, res) => {
  const accountId = req.query.accountId || defaultAccountId();
  if (!accountId) return res.json([]);
  const { from, to } = req.query;
  let rows = chronoWithBalance(accountId);
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);
  res.json(rows.reverse());
});

router.get("/summary", (req, res) => {
  const accountId = req.query.accountId || defaultAccountId();
  if (!accountId) return res.json({ from: todayStr(), to: todayStr(), openingBalance: 0, totalIn: 0, totalOut: 0, closingBalance: 0, netCashFlow: 0, entryCount: 0 });
  const { from, to } = req.query;
  const date = req.query.date || todayStr();
  const rangeFrom = from || date;
  const rangeTo = to || date;

  const all = chronoWithBalance(accountId);
  const before = all.filter(r => r.date < rangeFrom);
  const inRange = all.filter(r => r.date >= rangeFrom && r.date <= rangeTo);

  const account = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(accountId);
  const openingBalance = before.length ? before[before.length - 1].runningBalance : (account ? account.opening_balance : 0);
  const totalIn = round2(inRange.filter(r => r.type === "in").reduce((s, r) => s + r.amount, 0));
  const totalOut = round2(inRange.filter(r => r.type === "out").reduce((s, r) => s + r.amount, 0));
  const closingBalance = round2(openingBalance + totalIn - totalOut);

  res.json({
    from: rangeFrom, to: rangeTo,
    openingBalance, totalIn, totalOut, closingBalance,
    netCashFlow: round2(totalIn - totalOut),
    entryCount: inRange.length
  });
});

router.get("/export", (req, res) => {
  const accountId = req.query.accountId || defaultAccountId();
  const account = accountId ? db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(accountId) : null;
  const { from, to } = req.query;
  let rows = accountId ? chronoWithBalance(accountId) : [];
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);

  const out = [["Date", "Type", "Transaction Type", "Party", "Payment Mode", "Reference No.", "Remarks", "Bank In", "Bank Out", "Running Balance"]];
  rows.forEach(r => {
    out.push([
      r.date, r.type === "in" ? "Bank In" : "Bank Out", r.txn_type || r.category || "", r.party || "",
      r.payment_mode || "", r.reference_no || "", r.remarks || "",
      r.type === "in" ? r.amount : "", r.type === "out" ? r.amount : "", r.runningBalance
    ]);
  });
  const filename = `bank-book-${(account ? account.name.replace(/\W+/g, "-") : "all")}-${(from || "all")}-to-${(to || "date")}`;
  const buf = buildXlsx(out, filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

/** Direct entries with no dedicated flow: Bank Charges, Interest Received,
 *  Refund, and the original free-form Bank In/Bank Out. Deposit, Withdrawal,
 *  Transfer, Customer Receipt and Supplier Payment each have their own route
 *  below (or, for the latter two, live on customers.js/suppliers.js so the
 *  due they affect and the ledger entry they post are never out of sync). */
router.post("/", (req, res) => {
  const { date, type, party, remarks, paymentMode } = req.body;
  const txnType = (req.body.txnType || "Other").trim();
  const referenceNo = (req.body.referenceNo || "").trim();
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  if (type !== "in" && type !== "out") return res.status(400).json({ error: "Choose Bank In or Bank Out." });
  const account = activeAccount(req.body.accountId);
  if (!account) return res.status(400).json({ error: "Choose a bank account." });
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const id = uid("BANK");
  db.prepare(`
    INSERT INTO bank_entries (
      id, date, type, amount, party, category, remarks, voided,
      bank_account_id, txn_type, payment_mode, reference_no, attachment_path, attachment_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, entryDate, type, amount, (party || "").trim(), txnType, (remarks || "").trim(),
    account.id, txnType, (paymentMode || "").trim(), referenceNo,
    attachment ? attachment.path : "", attachment ? attachment.name : "", Date.now()
  );

  logAction(req, "bankbook.create", `${account.name}: ${type === "in" ? "+" : "-"}${amount} on ${entryDate} (${txnType})`);
  res.status(201).json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(id));
});

// Cash -> Bank: cash drawer goes down, this account goes up. One linked pair.
router.post("/deposit", (req, res) => {
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const account = activeAccount(req.body.accountId);
  if (!account) return res.status(400).json({ error: "Choose a bank account." });
  const date = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : todayStr();
  const referenceNo = (req.body.referenceNo || "").trim();
  const remarks = (req.body.remarks || "").trim();

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const linkId = uid("LINK");
  const bankId = uid("BANK");
  const cashId = uid("CASH");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO bank_entries (id, date, type, amount, party, category, remarks, voided, bank_account_id, txn_type, reference_no, attachment_path, attachment_name, link_id, created_at)
      VALUES (?, ?, 'in', ?, '', 'Bank Deposit', ?, 0, ?, 'Bank Deposit', ?, ?, ?, ?, ?)
    `).run(bankId, date, amount, remarks, account.id, referenceNo, attachment ? attachment.path : "", attachment ? attachment.name : "", linkId, Date.now());
    db.prepare(`
      INSERT INTO cash_entries (id, date, type, amount, party, category, remarks, voided, link_id, created_at)
      VALUES (?, ?, 'out', ?, '', 'Bank Deposit', ?, 0, ?, ?)
    `).run(cashId, date, amount, remarks, linkId, Date.now());
  })();

  logAction(req, "bankbook.deposit", `${account.name}: +${amount} on ${date} (from Cash)`);
  res.status(201).json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(bankId));
});

// Bank -> Cash: this account goes down, cash drawer goes up. One linked pair.
router.post("/withdrawal", (req, res) => {
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const account = activeAccount(req.body.accountId);
  if (!account) return res.status(400).json({ error: "Choose a bank account." });
  const date = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : todayStr();
  const referenceNo = (req.body.referenceNo || "").trim();
  const remarks = (req.body.remarks || "").trim();

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const linkId = uid("LINK");
  const bankId = uid("BANK");
  const cashId = uid("CASH");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO bank_entries (id, date, type, amount, party, category, remarks, voided, bank_account_id, txn_type, reference_no, attachment_path, attachment_name, link_id, created_at)
      VALUES (?, ?, 'out', ?, '', 'Bank Withdrawal', ?, 0, ?, 'Bank Withdrawal', ?, ?, ?, ?, ?)
    `).run(bankId, date, amount, remarks, account.id, referenceNo, attachment ? attachment.path : "", attachment ? attachment.name : "", linkId, Date.now());
    db.prepare(`
      INSERT INTO cash_entries (id, date, type, amount, party, category, remarks, voided, link_id, created_at)
      VALUES (?, ?, 'in', ?, '', 'Bank Withdrawal', ?, 0, ?, ?)
    `).run(cashId, date, amount, remarks, linkId, Date.now());
  })();

  logAction(req, "bankbook.withdrawal", `${account.name}: -${amount} on ${date} (to Cash)`);
  res.status(201).json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(bankId));
});

// Bank -> Bank: one account down, another up. Two linked bank_entries rows.
router.post("/transfer", (req, res) => {
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const from = activeAccount(req.body.fromAccountId);
  const to = activeAccount(req.body.toAccountId);
  if (!from || !to) return res.status(400).json({ error: "Choose both accounts to transfer between." });
  if (from.id === to.id) return res.status(400).json({ error: "Choose two different accounts." });
  const date = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : todayStr();
  const referenceNo = (req.body.referenceNo || "").trim();
  const remarks = (req.body.remarks || "").trim();

  let attachment;
  try { attachment = saveAttachment(req.body.attachment); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const linkId = uid("LINK");
  const outId = uid("BANK");
  const inId = uid("BANK");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO bank_entries (id, date, type, amount, party, category, remarks, voided, bank_account_id, txn_type, reference_no, attachment_path, attachment_name, link_id, created_at)
      VALUES (?, ?, 'out', ?, ?, 'Bank Transfer', ?, 0, ?, 'Bank Transfer', ?, ?, ?, ?, ?)
    `).run(outId, date, amount, `To ${to.name}`, remarks, from.id, referenceNo, attachment ? attachment.path : "", attachment ? attachment.name : "", linkId, Date.now());
    db.prepare(`
      INSERT INTO bank_entries (id, date, type, amount, party, category, remarks, voided, bank_account_id, txn_type, reference_no, link_id, created_at)
      VALUES (?, ?, 'in', ?, ?, 'Bank Transfer', ?, 0, ?, 'Bank Transfer', ?, ?, ?)
    `).run(inId, date, amount, `From ${from.name}`, remarks, to.id, referenceNo, linkId, Date.now());
  })();

  logAction(req, "bankbook.transfer", `${from.name} -> ${to.name}: ${amount} on ${date}`);
  res.status(201).json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(outId));
});

// Only a plain, unlinked, directly-entered row can be edited in place — a
// Deposit/Withdrawal/Transfer leg or a payment-sourced row must be voided
// and re-entered instead, so its paired/linked side is never left stale.
router.put("/:id", (req, res) => {
  const e = db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Can't edit a deleted entry." });
  if (e.source_type) return res.status(400).json({ error: `This entry was created automatically from a ${e.source_type === "payment" ? "customer receipt" : "supplier payment"} — edit it there instead.` });
  if (e.link_id) return res.status(400).json({ error: "This entry is one leg of a Deposit/Withdrawal/Transfer — void it and re-enter instead of editing." });

  const { date, type, party, remarks, paymentMode } = req.body;
  const amount = req.body.amount !== undefined ? round2(Number(req.body.amount)) : e.amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const entryType = (type === "in" || type === "out") ? type : e.type;
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : e.date;
  const txnType = (req.body.txnType ?? e.txn_type).trim();
  const referenceNo = (req.body.referenceNo ?? e.reference_no).trim();
  let accountId = e.bank_account_id;
  if (req.body.accountId) {
    const account = activeAccount(req.body.accountId);
    if (!account) return res.status(400).json({ error: "Choose a bank account." });
    accountId = account.id;
  }

  let attachmentPath = e.attachment_path, attachmentName = e.attachment_name;
  try {
    const attachment = saveAttachment(req.body.attachment);
    if (attachment) { attachmentPath = attachment.path; attachmentName = attachment.name; }
  } catch (err) { return res.status(400).json({ error: err.message }); }

  db.prepare(`
    UPDATE bank_entries SET date=?, type=?, amount=?, party=?, category=?, remarks=?, bank_account_id=?, txn_type=?, payment_mode=?, reference_no=?, attachment_path=?, attachment_name=? WHERE id=?
  `).run(entryDate, entryType, amount, (party ?? e.party).trim(), txnType, (remarks ?? e.remarks).trim(), accountId, txnType, (paymentMode ?? e.payment_mode).trim(), referenceNo, attachmentPath, attachmentName, e.id);

  logAction(req, "bankbook.edit", `${e.id}: ${e.amount} -> ${amount}`);
  res.json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(e.id));
});

router.post("/:id/void", requireRole("owner"), (req, res) => {
  const e = db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Entry already deleted." });
  if (e.source_type) return res.status(400).json({ error: `This entry was created automatically from a ${e.source_type === "payment" ? "customer receipt" : "supplier payment"} — void it there instead.` });

  db.transaction(() => {
    db.prepare("UPDATE bank_entries SET voided = 1 WHERE id = ?").run(e.id);
    // A Deposit/Withdrawal's cash leg, or a Transfer's other bank leg,
    // shares this link_id — both sides void together.
    if (e.link_id) {
      db.prepare("UPDATE bank_entries SET voided = 1 WHERE link_id = ? AND id != ? AND voided = 0").run(e.link_id, e.id);
      db.prepare("UPDATE cash_entries SET voided = 1 WHERE link_id = ? AND voided = 0").run(e.link_id);
    }
  })();
  logAction(req, "bankbook.void", `${e.type === "in" ? "+" : "-"}${e.amount} on ${e.date}`);
  res.json({ ok: true });
});

module.exports = router;
