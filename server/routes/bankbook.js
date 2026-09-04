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

/**
 * Free-text search over the fields staff actually recall an entry by.
 * Beyond the Cash Book's party/category/remarks this also covers the
 * bank-only identifiers — Transaction Type, Payment Mode and above all
 * Reference No., since "find that cheque number" is the single most common
 * reason to go digging through a bank ledger.
 *
 * Like the Cash Book, a search REPLACES the from/to range rather than
 * narrowing inside it: the point is to find an entry whatever day it landed
 * on. It stays scoped to the SELECTED ACCOUNT though — the running balance
 * column is per-account, so mixing accounts into one list would produce a
 * balance sequence that means nothing.
 */
function matchesSearch(r, search) {
  return [r.party, r.category, r.txn_type, r.remarks, r.payment_mode, r.reference_no]
    .some(v => String(v || "").toLowerCase().includes(search));
}
function applyFilters(rows, { from, to, q }) {
  const search = String(q || "").trim().toLowerCase();
  if (search) return rows.filter(r => matchesSearch(r, search));
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);
  return rows;
}

router.get("/", (req, res) => {
  const accountId = req.query.accountId || defaultAccountId();
  if (!accountId) return res.json([]);
  const rows = applyFilters(chronoWithBalance(accountId), req.query);
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

/**
 * THE BANK BOOK, DAY BY DAY — the same rule the cash book follows.
 *
 *   Opening = the balance carried in from the day before
 *   Money In / Money Out = that day's movements on THIS account
 *   Closing = Opening + In − Out
 *   and tomorrow's Opening is today's Closing.
 *
 * ONE DIFFERENCE FROM THE CASH BOOK, and it matters: a bank account has a
 * stored opening_balance — what was in it before this app knew about it.
 * A range that starts before the first entry therefore opens on THAT, not
 * on zero. Getting this wrong would show a shop's bank book starting empty
 * and every balance below it short by the same amount.
 *
 * Carry-forward is not computed twice: each day's opening is the previous
 * day's closing value, never a second sum of everything earlier.
 *
 * Per account, always. Balances here are per-account — a shop with two
 * banks has two books, and adding them together would be meaningless.
 */
const BB_ROW_CAP = 400;

function bbAddDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

router.get("/daily", (req, res) => {
  const accountId = req.query.accountId || defaultAccountId();
  if (!accountId) {
    return res.json({ from: todayStr(), to: todayStr(), openingBalance: 0,
      closingBalance: 0, totalIn: 0, totalOut: 0, days: [], everyDay: true,
      note: "No bank account yet." });
  }
  const account = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(accountId);
  if (!account) return res.status(404).json({ error: "No such bank account." });

  const all = chronoWithBalance(accountId);
  const from = String(req.query.from || "").trim() || (all.length ? all[0].date : todayStr());
  const to = String(req.query.to || "").trim() || todayStr();
  if (to < from) return res.status(400).json({ error: "The end date is before the start date." });

  /* Before the range: the last running balance, or the account's own
     opening balance when nothing has been entered yet. */
  const before = all.filter(r => r.date < from);
  const openingBalance = before.length
    ? before[before.length - 1].runningBalance
    : round2(account.opening_balance || 0);

  const byDay = new Map();
  for (const r of all) {
    if (r.date < from || r.date > to) continue;
    if (!byDay.has(r.date)) byDay.set(r.date, { in: 0, out: 0, n: 0 });
    const d = byDay.get(r.date);
    if (r.type === "in") d.in += r.amount; else d.out += r.amount;
    d.n++;
  }

  const spanDays = Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
  const everyDay = spanDays > 0 && spanDays <= BB_ROW_CAP;
  const dates = everyDay
    ? Array.from({ length: spanDays }, (_, i) => bbAddDays(from, i))
    : [...byDay.keys()].sort();

  let carry = openingBalance;
  let totalIn = 0, totalOut = 0;
  const days = dates.map(date => {
    const d = byDay.get(date) || { in: 0, out: 0, n: 0 };
    const cashIn = round2(d.in);
    const cashOut = round2(d.out);
    const opening = round2(carry);
    const closing = round2(opening + cashIn - cashOut);
    carry = closing;
    totalIn = round2(totalIn + cashIn);
    totalOut = round2(totalOut + cashOut);
    return { date, opening, cashIn, cashOut, closing, entryCount: d.n, quiet: d.n === 0 };
  });

  res.json({
    accountId, accountName: account.name || "",
    from, to,
    openingBalance,
    closingBalance: round2(carry),
    totalIn, totalOut,
    days,
    everyDay,
    note: everyDay
      ? "Every day in the range, including days with no movement."
      : `More than ${BB_ROW_CAP} days — only days with entries are listed.`
  });
});

router.get("/export", (req, res) => {
  const accountId = req.query.accountId || defaultAccountId();
  const account = accountId ? db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(accountId) : null;
  const { from, to, q } = req.query;
  // Same filter path as the list route, so the spreadsheet always holds the
  // rows on screen rather than the date range sitting unused behind a search.
  const rows = applyFilters(accountId ? chronoWithBalance(accountId) : [], req.query);
  /* Declared here because BOTH the day-by-day block and the filename
     below need it. Declared once, not twice. */
  const searchTerm = String(q || "").trim();

  const out = [["Date", "Type", "Transaction Type", "Party", "Payment Mode", "Reference No.", "Remarks", "Bank In", "Bank Out", "Running Balance"]];
  rows.forEach(r => {
    out.push([
      r.date, r.type === "in" ? "Bank In" : "Bank Out", r.txn_type || r.category || "", r.party || "",
      r.payment_mode || "", r.reference_no || "", r.remarks || "",
      r.type === "in" ? r.amount : "", r.type === "out" ? r.amount : "", r.runningBalance
    ]);
  });

  /* The day-by-day summary goes in the same sheet, from the same figures
     the screen and the printed page use. Left out of a SEARCH export: those
     rows come from whichever days matched, and an opening balance across
     them is not this account's opening balance on any real day. */
  if (!searchTerm && rows.length && accountId) {
    const first = rows[0].date;
    const all = chronoWithBalance(accountId);
    const before = all.filter(r => r.date < first);
    let carry = before.length ? before[before.length - 1].runningBalance
      : round2((account && account.opening_balance) || 0);

    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.date)) byDay.set(r.date, { in: 0, out: 0 });
      const d = byDay.get(r.date);
      if (r.type === "in") d.in += r.amount; else d.out += r.amount;
    }

    out.push([]);
    out.push(["DAY BY DAY"]);
    out.push(["Date", "Opening Balance", "Money In", "Money Out", "Closing Balance"]);
    const opening = carry;
    let tIn = 0, tOut = 0;
    for (const date of [...byDay.keys()].sort()) {
      const d = byDay.get(date);
      const cashIn = round2(d.in), cashOut = round2(d.out);
      const open = round2(carry);
      const close = round2(open + cashIn - cashOut);
      carry = close;
      tIn = round2(tIn + cashIn); tOut = round2(tOut + cashOut);
      out.push([date, open, cashIn, cashOut, close]);
    }
    out.push(["Total", opening, tIn, tOut, round2(carry)]);
  }
  const accountPart = account ? account.name.replace(/\W+/g, "-") : "all";
  const filename = searchTerm
    ? `bank-book-${accountPart}-search-${searchTerm.replace(/[^a-z0-9]+/gi, "-").slice(0, 30)}`
    : `bank-book-${accountPart}-${(from || "all")}-to-${(to || "date")}`;
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
