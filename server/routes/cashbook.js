const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr } = require("../util");
const { requireRole } = require("../auth");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

/**
 * Offer a finished document to Tally.
 *
 * Wrapped in everything: the row is already saved, and a sync problem must
 * never be able to fail the entry. It only QUEUES, so Tally being closed
 * cannot make anyone wait at the counter.
 */
function offerToTally(req, docType, doc, opts) {
  try {
    const svc = require("../tally/service");
    const r = svc.enqueue(docType, doc, {
      ...(opts || {}),
      staff: (req.session && req.session.staffName) || ""
    });
    if (r && r.queued) {
      try { require("../tally/autosync").nudge(); } catch (e) { /* never fatal */ }
    }
    return r;
  } catch (e) {
    return { queued: false, reason: e.message };
  }
}


/**
 * Every non-voided entry ever made, oldest-first, each annotated with the
 * running cash balance immediately after it — the balance is a running total
 * over ALL history, never just whatever date range is being viewed, so a
 * filtered day still shows the true balance at that point in time.
 */
function chronoWithBalance() {
  const rows = db.prepare(`
    SELECT * FROM cash_entries WHERE voided = 0 ORDER BY date ASC, created_at ASC
  `).all();
  let running = 0;
  return rows.map(r => {
    running = round2(running + (r.type === "in" ? r.amount : -r.amount));
    return { ...r, runningBalance: running };
  });
}

router.get("/", (req, res) => {
  const { from, to, q } = req.query;
  let rows = chronoWithBalance();
  const search = String(q || "").trim().toLowerCase();
  if (search) {
    // A search is for finding an entry whatever day it landed on ("who did
    // I pay for wages, sometime last month?"), so it deliberately REPLACES
    // the from/to range instead of narrowing within it — otherwise the
    // common case of searching while the range is still on "Today" would
    // return nothing and look broken.
    rows = rows.filter(r =>
      (r.party || "").toLowerCase().includes(search) ||
      (r.category || "").toLowerCase().includes(search) ||
      (r.remarks || "").toLowerCase().includes(search)
    );
  } else {
    if (from) rows = rows.filter(r => r.date >= from);
    if (to) rows = rows.filter(r => r.date <= to);
  }
  // Newest-first for display, matching every other list in the app — the
  // running balance on each row was already computed in true chronological
  // order above, so reversing here doesn't touch that.
  res.json(rows.reverse());
});

/**
 * Opening balance for a day is just the running balance at the moment before
 * that day's first entry — i.e. the cumulative total of everything dated
 * earlier. Closing balance is the same total including the day itself. No
 * separate "start of day" bookkeeping is needed; it falls out of one
 * chronological scan.
 */
/* Which days of a month have any entry at all.
 *
 * Just the dates, not the entries: the calendar only needs to know where to
 * put a dot, and a month of full rows to draw thirty dots would be the whole
 * ledger fetched twice over. Voided entries do not count — a day whose only
 * entry was cancelled has nothing on it. */
router.get("/days", (req, res) => {
  const month = String(req.query.month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "Give the month as YYYY-MM." });
  }
  const days = db.prepare(`
    SELECT DISTINCT date FROM cash_entries
     WHERE voided = 0 AND date LIKE ?
     ORDER BY date`).all(month + "-%").map(r => r.date);
  res.json({ month, days });
});

router.get("/summary", (req, res) => {
  const { from, to } = req.query;
  const date = req.query.date || todayStr();
  const rangeFrom = from || date;
  const rangeTo = to || date;

  const all = chronoWithBalance();
  const before = all.filter(r => r.date < rangeFrom);
  const inRange = all.filter(r => r.date >= rangeFrom && r.date <= rangeTo);

  const openingBalance = before.length ? before[before.length - 1].runningBalance : 0;
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
 * THE CASH BOOK, DAY BY DAY.
 *
 *   Opening = the balance carried in from the day before
 *   Cash In = everything received that day
 *   Cash Out = everything paid that day
 *   Closing = Opening + Cash In − Cash Out
 *   and tomorrow's Opening is today's Closing.
 *
 * CARRY-FORWARD IS NOT COMPUTED TWICE. Each day's opening is literally the
 * previous day's closing variable, not a second sum of everything before it.
 * Two independent calculations of the same figure is how a cash book comes
 * to disagree with itself on one day in a year, and nobody finds out until
 * they are counting the drawer.
 *
 * EVERY DAY IN THE RANGE APPEARS, not only the days somebody wrote in. A day
 * the shop took nothing and paid nothing still has a balance sitting in the
 * drawer, and a cash book that skips it makes the money look like it jumped.
 * Those days are marked quiet:true so the screen can fold them away without
 * this having to guess which the shop wants to see.
 *
 * A very long range is the exception — beyond ROW_CAP days only the days
 * with entries are listed, and the response says so rather than silently
 * returning something different from what was asked for.
 */
const ROW_CAP = 400;

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

router.get("/daily", (req, res) => {
  const all = chronoWithBalance();
  const first = all.length ? all[0].date : todayStr();
  const last = all.length ? all[all.length - 1].date : todayStr();

  const from = String(req.query.from || "").trim() || first;
  const to = String(req.query.to || "").trim() || todayStr();
  if (to < from) return res.status(400).json({ error: "The end date is before the start date." });

  /* What was in the drawer the moment this range began: everything dated
     earlier, which the chronological scan has already totalled. */
  const before = all.filter(r => r.date < from);
  const openingBalance = before.length ? before[before.length - 1].runningBalance : 0;

  /* Each day's movements, gathered once. */
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
  const everyDay = spanDays > 0 && spanDays <= ROW_CAP;

  const dates = everyDay
    ? Array.from({ length: spanDays }, (_, i) => addDays(from, i))
    : [...byDay.keys()].sort();

  let carry = openingBalance;
  let totalIn = 0, totalOut = 0;
  const days = dates.map(date => {
    const d = byDay.get(date) || { in: 0, out: 0, n: 0 };
    const cashIn = round2(d.in);
    const cashOut = round2(d.out);
    const opening = round2(carry);
    const closing = round2(opening + cashIn - cashOut);
    carry = closing;                 /* tomorrow opens where today closed */
    totalIn = round2(totalIn + cashIn);
    totalOut = round2(totalOut + cashOut);
    return { date, opening, cashIn, cashOut, closing, entryCount: d.n, quiet: d.n === 0 };
  });

  res.json({
    from, to,
    openingBalance,
    closingBalance: round2(carry),
    totalIn, totalOut,
    days,
    /* Said plainly so a screen cannot present a shortened list as a full
       one. Beyond the cap the quiet days are missing, and that changes what
       the reader is looking at. */
    everyDay,
    note: everyDay
      ? "Every day in the range, including days with no cash movement."
      : `More than ${ROW_CAP} days — only days with entries are listed.`
  });
});

router.get("/export", (req, res) => {
  const { from, to, q } = req.query;
  let rows = chronoWithBalance();
  // Mirrors the list route exactly, so the spreadsheet always contains the
  // rows the user is actually looking at — exporting mid-search used to
  // hand back the whole date range instead of the search results.
  const search = String(q || "").trim().toLowerCase();
  if (search) {
    rows = rows.filter(r =>
      (r.party || "").toLowerCase().includes(search) ||
      (r.category || "").toLowerCase().includes(search) ||
      (r.remarks || "").toLowerCase().includes(search)
    );
  } else {
    if (from) rows = rows.filter(r => r.date >= from);
    if (to) rows = rows.filter(r => r.date <= to);
  }

  const out = [["Date", "Type", "Party", "Category", "Remarks", "Cash In", "Cash Out", "Running Balance"]];
  rows.forEach(r => {
    out.push([
      r.date, r.type === "in" ? "Cash In" : "Cash Out", r.party || "", r.category || "", r.remarks || "",
      r.type === "in" ? r.amount : "", r.type === "out" ? r.amount : "", r.runningBalance
    ]);
  });

  /* THE DAY-BY-DAY SUMMARY GOES IN THE SAME SHEET, under the entries.
     A cash book that is printed and filed has to answer "what was in the
     drawer on the 5th" without the reader adding a column up, and it is
     the same question the screen answers — so it comes from the same
     figures rather than a second calculation that could disagree.

     Left out of a SEARCH export on purpose: those rows come from whatever
     days happened to match, and an opening balance computed across them
     would not be the shop's opening balance on any real day. */
  if (!search && rows.length) {
    const first = rows[0].date;
    const last = rows[rows.length - 1].date;
    const all = chronoWithBalance();
    const before = all.filter(r => r.date < first);
    let carry = before.length ? before[before.length - 1].runningBalance : 0;

    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.date)) byDay.set(r.date, { in: 0, out: 0 });
      const d = byDay.get(r.date);
      if (r.type === "in") d.in += r.amount; else d.out += r.amount;
    }

    out.push([]);
    out.push(["DAY BY DAY"]);
    out.push(["Date", "Opening Balance", "Cash In", "Cash Out", "Closing Balance"]);
    let tIn = 0, tOut = 0;
    const opening = carry;
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

  const filename = search
    ? `cash-book-search-${search.replace(/[^a-z0-9]+/gi, "-").slice(0, 30)}`
    : `cash-book-${(from || "all")}-to-${(to || "date")}`;
  const buf = buildXlsx(out, filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

router.post("/", (req, res) => {
  const { date, type, party, category, remarks } = req.body;
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  if (type !== "in" && type !== "out") return res.status(400).json({ error: "Choose Cash In or Cash Out." });
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();

  const id = uid("CASH");
  db.prepare(`
    INSERT INTO cash_entries (id, date, type, amount, party, category, remarks, voided, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, entryDate, type, amount, (party || "").trim(), (category || "").trim(), (remarks || "").trim(), Date.now());

  /* Straight into Tally as a Receipt or a Payment against the category.
     This route only ever writes rows the shop TYPED, so there is no
     source_type to guard against here — a cash row auto-posted from a
     customer receipt or a supplier payment is written by bankLink, never
     by this handler, and travels as `receipt`/`payment` instead. The
     loader checks source_type again anyway. */
  offerToTally(req, type === "in" ? "cash_in" : "cash_out",
    db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(id),
    { docNo: (category || "").trim() || "Cash Book" });

  logAction(req, "cashbook.create", `${type === "in" ? "+" : "-"}${amount} on ${entryDate}${party ? " (" + party + ")" : ""}`);
  res.status(201).json(db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const e = db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Can't edit a deleted entry." });
  if (e.source_type) return res.status(400).json({ error: `This entry was created automatically from a ${e.source_type === "payment" ? "customer receipt" : "supplier payment"} — edit it there instead.` });

  const { date, type, party, category, remarks } = req.body;
  const amount = req.body.amount !== undefined ? round2(Number(req.body.amount)) : e.amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const entryType = (type === "in" || type === "out") ? type : e.type;
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : e.date;

  db.prepare(`
    UPDATE cash_entries SET date=?, type=?, amount=?, party=?, category=?, remarks=? WHERE id=?
  `).run(entryDate, entryType, amount, (party ?? e.party).trim(), (category ?? e.category).trim(), (remarks ?? e.remarks).trim(), e.id);

  logAction(req, "cashbook.edit", `${e.id}: ${e.amount} -> ${amount}`);
  res.json(db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(e.id));
});

router.post("/:id/void", requireRole("owner"), (req, res) => {
  const e = db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Entry already deleted." });
  if (e.source_type) return res.status(400).json({ error: `This entry was created automatically from a ${e.source_type === "payment" ? "customer receipt" : "supplier payment"} — void it there instead.` });

  db.transaction(() => {
    db.prepare("UPDATE cash_entries SET voided = 1 WHERE id = ?").run(e.id);
    // A Bank Deposit/Withdrawal has a matching leg in bank_entries sharing
    // this link_id -- both sides of the same real-world movement void
    // together, or the two books would disagree about where the money went.
    if (e.link_id) {
      db.prepare("UPDATE bank_entries SET voided = 1 WHERE link_id = ? AND voided = 0").run(e.link_id);
    }
  })();
  logAction(req, "cashbook.void", `${e.type === "in" ? "+" : "-"}${e.amount} on ${e.date}`);
  res.json({ ok: true });
});

module.exports = router;
