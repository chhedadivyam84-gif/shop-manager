const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr } = require("../util");
const { requireRole } = require("../auth");
const { buildXlsx } = require("../xlsx");
const partyCash = require("../partyCash");
const permissions = require("../permissions");
const cashAccess = require("../cashAccess");

const router = express.Router();

/* ============================================================
   WHO MAY READ AND WRITE THIS BOOK

   Two gates, asked in this order on every route below:

     1. PERMISSION — the "cash" module in Staff Access, which has carried
        View / Add / Edit / Print since the permission screen was built.
        It was never checked here, so every signed-in person could read
        and write the whole book whatever the owner had ticked. It is
        checked now.

     2. PERIOD — which days of it, from server/cashAccess.js.

   Both are server-side and neither is reachable from the browser. A
   staff member can retype a URL, edit the query string, call the API by
   hand or change the page's own JavaScript; none of it widens what the
   SQL below is willing to return, because the window is read from their
   staff row on every request and never from anything they sent.
   ============================================================ */
const mayView  = permissions.require("cash", "view");
const mayAdd   = permissions.require("cash", "add");
const mayEdit  = permissions.require("cash", "edit");
const mayPrint = permissions.require("cash", "print");

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
/* THE ACCESS PERIOD IS APPLIED IN THE QUERY, not to the answer.
   Every route below reads through this one function, so narrowing here
   narrows the list, the totals, the day view, the category and party
   breakdowns, the search, the export and the khata at once — and a route
   added later inherits it rather than having to remember it.

   The running balance is then built over what is left, which is why a
   limited person's book opens at zero on their first allowed day instead
   of carrying in the total of everything they may not see. */
function chronoWithBalance(req) {
  const win = cashAccess.sqlAnd(req, "date");
  const rows = db.prepare(`
    SELECT * FROM cash_entries WHERE voided = 0${win.sql} ORDER BY date ASC, created_at ASC
  `).all(...win.params);
  let running = 0;
  return rows.map(r => {
    running = round2(running + (r.type === "in" ? r.amount : -r.amount));
    return { ...r, runningBalance: running };
  });
}

/**
 * Does one entry match what was typed in the search box?
 *
 * Party, category and remarks have always matched as text. Two more:
 *
 * AMOUNTS MATCH EXACTLY, not as text. "500" finding 1500, 5000 and
 * 500.50 because all three contain those digits is noise in a book of
 * money — the reason to search an amount is that you remember the
 * figure. Commas and a rupee sign are stripped first, because that is
 * how a figure is read off a screen or a bill: "₹1,500".
 *
 * DATES STAY A TEXT MATCH, on purpose. "2026-09" is a whole month and
 * "-14" is a day in any month, and people type both.
 *
 * Defined once because /cashbook and /cashbook/export both need it and
 * previously held identical copies. The export is meant to return what
 * the screen is showing, which stops being true the moment one copy
 * gains a rule the other does not.
 */
function matchesSearch(r, search) {
  if (!search) return true;
  const cleaned = search.replace(/[,₹\s]/g, "");
  const asNumber = Number(cleaned);
  const isAmount = /^[₹\s]*[\d,]+(\.\d+)?\s*$/.test(search) && cleaned !== "" && isFinite(asNumber);

  return (r.party || "").toLowerCase().includes(search) ||
         (r.category || "").toLowerCase().includes(search) ||
         (r.remarks || "").toLowerCase().includes(search) ||
         (r.date || "").includes(search) ||
         (isAmount && round2(r.amount) === round2(asNumber));
}

router.get("/", mayView, (req, res) => {
  const { from, to, q } = req.query;
  let rows = chronoWithBalance(req);
  const search = String(q || "").trim().toLowerCase();
  if (search) {
    // A search is for finding an entry whatever day it landed on ("who did
    // I pay for wages, sometime last month?"), so it deliberately REPLACES
    // the from/to range instead of narrowing within it — otherwise the
    // common case of searching while the range is still on "Today" would
    // return nothing and look broken.
    rows = rows.filter(r => matchesSearch(r, search));
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
router.get("/days", mayView, (req, res) => {
  const month = String(req.query.month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "Give the month as YYYY-MM." });
  }
  const win = cashAccess.sqlAnd(req, "date");
  const days = db.prepare(`
    SELECT DISTINCT date FROM cash_entries
     WHERE voided = 0 AND date LIKE ?${win.sql}
     ORDER BY date`).all(month + "-%", ...win.params).map(r => r.date);
  res.json({ month, days });
});

router.get("/summary", mayView, (req, res) => {
  const { from, to } = req.query;
  const date = req.query.date || todayStr();
  const rangeFrom = from || date;
  const rangeTo = to || date;

  const all = chronoWithBalance(req);
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

/* ============================================================
   WHO AND WHAT THE MONEY WENT TO

   Three additions, all read-only. Nothing below writes, edits or voids
   anything, and none of the existing routes changed — the day-by-day
   cash book, its balances and its entries are exactly as they were.

   WHY THE TOTALS ARE BUILT FROM chronoWithBalance(req) AND NOT FROM THEIR
   OWN QUERY: the cash book's opening and closing already come from that
   one running total over all history. A second, independent sum of the
   same money is how a book comes to disagree with itself on one day in
   a year, and nobody finds out until they are counting the drawer. So
   these group the SAME rows rather than re-deriving them.

   CATEGORY AND PARTY ARE FREE TEXT on cash_entries, not linked ids.
   That is how the shop has always used them and it is not being
   changed here. The consequence is honest and worth stating: grouping
   is by the name as typed, so "Ramesh" and "ramesh " are one group only
   because these trim and compare case-insensitively. A genuinely
   different spelling is a genuinely different party, and no total can
   guess otherwise.
   ============================================================ */

/* The label a nameless row groups under. It is shown to the reader AND sent
   back as the filter when that group is clicked, so both sides have to agree
   on it — hence one constant rather than a string written twice. */
const NO_NAME = "(none)";

/* The key a name groups under; the display name is the first spelling seen.
   A blank resolves to NO_NAME so that grouping and filtering cannot disagree
   about what an unnamed row is called. */
const groupKey = (s) => String(s || "").trim().toLowerCase() || NO_NAME;

function groupTotals(req, field, from, to, only) {
  const all = chronoWithBalance(req);
  const rangeFrom = from || "0000-01-01";
  const rangeTo = to || "9999-12-31";

  /* Narrow to one category (or one party) before grouping, so "the people
     inside Labour Charges" is answerable without the screen downloading
     every entry and working it out for itself. */
  const onlyField = only && only.field;
  const onlyKey = only && groupKey(only.value);

  const groups = new Map();
  const take = (row, where) => {
    const key = groupKey(row[field]);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: String(row[field] || "").trim() || NO_NAME,
        opening: 0, income: 0, expense: 0, transactions: 0, lastDate: "",
      });
    }
    const g = groups.get(key);
    const signed = row.type === "in" ? row.amount : -row.amount;

    if (where === "before") {
      /* A category has no running cash balance of its own, so "opening"
         here means what this name had netted BEFORE the range — the
         figure a shopkeeper means by "and where did we stand with them
         before this month". */
      g.opening = round2(g.opening + signed);
      return;
    }
    if (row.type === "in") g.income = round2(g.income + row.amount);
    else g.expense = round2(g.expense + row.amount);
    g.transactions += 1;
    if (row.date > g.lastDate) g.lastDate = row.date;
  };

  for (const row of all) {
    if (onlyField && groupKey(row[onlyField]) !== onlyKey) continue;
    if (row.date < rangeFrom) take(row, "before");
    else if (row.date <= rangeTo) take(row, "in");
  }

  return [...groups.values()]
    .map(g => ({ ...g, closing: round2(g.opening + g.income - g.expense) }))
    /* Names that only ever appeared before the range would otherwise show
       as rows with nothing in them for the period being looked at. */
    .filter(g => g.transactions > 0 || g.opening !== 0)
    .sort((a, b) => (b.income + b.expense) - (a.income + a.expense));
}

/** Every category name the cash book has actually used, plus the master
 *  list — so the picker offers both what exists and what was set up. */
router.get("/categories-used", mayView, (req, res) => {
  const win = cashAccess.sqlAnd(req, "date");
  const used = db.prepare(`
    SELECT category AS name, COUNT(*) AS uses, MAX(date) AS lastDate
    FROM cash_entries
    WHERE voided = 0 AND TRIM(COALESCE(category,'')) <> ''${win.sql}
    GROUP BY LOWER(TRIM(category))
    ORDER BY uses DESC
  `).all(...win.params);
  res.json(used);
});

/** Every party the cash book has dealt with. Feeds the person picker. */
router.get("/parties", mayView, (req, res) => {
  const win = cashAccess.sqlAnd(req, "date");
  const rows = db.prepare(`
    SELECT party AS name, COUNT(*) AS transactions, MAX(date) AS lastDate
    FROM cash_entries
    WHERE voided = 0 AND TRIM(COALESCE(party,'')) <> ''${win.sql}
    GROUP BY LOWER(TRIM(party))
    ORDER BY transactions DESC, name ASC
  `).all(...win.params);
  res.json(rows);
});

/** Opening, income, expense, closing and a count, per category.
 *  ?party= narrows it to one person's categories. */
router.get("/by-category", mayView, (req, res) => {
  const { from, to, party } = req.query;
  const only = party ? { field: "party", value: party } : null;
  res.json({ from: from || null, to: to || null, party: party || null,
             groups: groupTotals(req, "category", from, to, only) });
});

/** The same, per person/party.
 *  ?category= narrows it to the people inside one category. */
router.get("/by-party", mayView, (req, res) => {
  const { from, to, category } = req.query;
  const only = category ? { field: "category", value: category } : null;
  res.json({ from: from || null, to: to || null, category: category || null,
             groups: groupTotals(req, "party", from, to, only) });
});

/**
 * One person's transactions, in full.
 *
 * The cash book's own list is the place to read entries, but it filters by
 * date and search text — there was no way to ask "everything we have ever
 * done with Ramesh". This answers exactly that, optionally inside one
 * category, and returns the entries themselves rather than a total, so the
 * screen can show the history behind a figure it has just displayed.
 */
router.get("/history", mayView, (req, res) => {
  const { party, category, from, to } = req.query;
  /* Asked for nothing at all, versus asked for the nameless ones. groupKey
     turns "" into NO_NAME, so the presence of the query parameter — not its
     value — is what says whether a filter was requested. */
  const wantParty = party !== undefined && party !== "" ? groupKey(party) : null;
  const wantCategory = category !== undefined && category !== "" ? groupKey(category) : null;
  if (!wantParty && !wantCategory) {
    return res.status(400).json({ error: "Ask for a party, a category, or both." });
  }

  const rows = chronoWithBalance(req).filter(r => {
    if (wantParty && groupKey(r.party) !== wantParty) return false;
    if (wantCategory && groupKey(r.category) !== wantCategory) return false;
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    return true;
  });

  const income = round2(rows.filter(r => r.type === "in").reduce((s, r) => s + r.amount, 0));
  const expense = round2(rows.filter(r => r.type === "out").reduce((s, r) => s + r.amount, 0));

  /* IS THIS PERSON ONE OF THE SHOP'S ACCOUNTS?

     The list above is grouped by the name written on the entry, because that
     is all most rows have. If any of those rows also carries a link, the same
     name is a real customer or supplier, and the question changes from "what
     moved this month" to "what do they still owe" — which is the whole reason
     for linking. The balance comes from partyCash so the figure here and the
     figure on their account can never be two different calculations.

     Taken from the entries themselves rather than by matching the name against
     the customer list: the link is what the operator actually chose, and a name
     that merely looks like a customer is not one. */
  let khata = null;
  const linked = rows.find(r => r.party_type && r.party_id);
  if (linked) {
    const name = partyCash.partyName(linked.party_type, linked.party_id);
    if (name) {
      khata = { ...partyCash.partyCashBalance(linked.party_type, linked.party_id, req), name };
    }
  }

  res.json({
    party: party || null, category: category || null,
    transactions: rows.length, income, expense, net: round2(income - expense),
    /* Null when the name is just a name. The screen says so rather than
       showing a zero balance, which would read as "settled". */
    khata,
    entries: rows.slice().reverse(),        /* newest first, as the screen reads */
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

router.get("/daily", mayView, (req, res) => {
  const all = chronoWithBalance(req);
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

router.get("/export", mayPrint, (req, res) => {
  const { from, to, q } = req.query;
  let rows = chronoWithBalance(req);
  // Mirrors the list route exactly, so the spreadsheet always contains the
  // rows the user is actually looking at — exporting mid-search used to
  // hand back the whole date range instead of the search results.
  const search = String(q || "").trim().toLowerCase();
  if (search) {
    rows = rows.filter(r => matchesSearch(r, search));
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
    const all = chronoWithBalance(req);
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

/** Everyone a cash entry may be attached to — the dropdown's contents. */
router.get("/link-targets", mayView, (req, res) => {
  res.json(partyCash.linkTargets());
});

/**
 * KHATA BALANCES — what each linked party owes the shop, worked out from
 * the cash book alone. See server/partyCash.js for the sign rule and for
 * why rows auto-posted from a recorded payment are left out.
 *
 * Deliberately NOT merged with customers.due: that figure comes from bills
 * and the payments made against them, this one comes from cash handed over
 * and taken back. A shop that uses both would be shown the same money twice
 * if they were added together here, so they are returned apart and labelled.
 */
router.get("/party-balances", mayView, (req, res) => {
  const type = String(req.query.type || "").trim();
  if (type && type !== "customer" && type !== "supplier") {
    return res.status(400).json({ error: "Party type must be customer or supplier." });
  }
  const rows = partyCash.allPartyCashBalances(type || null, req);

  /* Names are attached here rather than joined in SQL so the balance query
     stays one grouped scan, and so a party deleted since the entry was
     written still shows its money instead of vanishing from the total. */
  const named = rows.map(r => ({
    ...r,
    name: partyCash.partyName(r.partyType, r.partyId) || "(deleted party)",
  }));
  res.json({
    parties: named,
    owedToShop: round2(named.filter(r => r.balance > 0).reduce((t, r) => t + r.balance, 0)),
    owedByShop: round2(named.filter(r => r.balance < 0).reduce((t, r) => t - r.balance, 0)),
  });
});

/** One party's khata: the balance and the entries that make it up. */
router.get("/party/:type/:id", mayView, (req, res) => {
  const { type, id } = req.params;
  const name = partyCash.partyName(type, id);
  if (!name) return res.status(404).json({ error: "Customer or supplier not found." });
  const { from, to } = req.query;
  /* `entries` stays the COUNT that partyCashBalance returns; the rows go in
     `history`. Spreading the balance and then writing `entries` again with
     the array silently replaced a number with a list, and every caller
     reading it as a count got "[object Object]". */
  res.json({
    ...partyCash.partyCashBalance(type, id, req),
    name,
    history: partyCash.partyCashHistory(type, id, from, to, req),
  });
});


/**
 * The customer or supplier an entry is being attached to, if any.
 *
 * Optional on purpose: a cash entry that names nobody is still a cash entry,
 * and every row written before this existed has no link at all. An id that
 * does not resolve is refused rather than stored, because a balance against
 * a party that is not there is worse than no balance.
 *
 * Returns { partyType, partyId, name } — name so the free-text party column
 * can be kept in step, which is what the ledger, the search and the export
 * all still read.
 */
function readPartyLink(body) {
  const partyType = String(body.partyType || "").trim();
  const partyId = String(body.partyId || "").trim();
  if (!partyType && !partyId) return { partyType: "", partyId: "", name: null };
  if (partyType !== "customer" && partyType !== "supplier") {
    throw new Error("A cash entry can only be linked to a customer or a supplier.");
  }
  const name = partyCash.partyName(partyType, partyId);
  if (!name) throw new Error("That customer or supplier no longer exists.");
  return { partyType, partyId, name };
}

router.post("/", mayAdd, (req, res) => {
  const { date, type, party, category, remarks } = req.body;
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  if (type !== "in" && type !== "out") return res.status(400).json({ error: "Choose Cash In or Cash Out." });
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();

  /* An entry has to fall on a day this person may see. Otherwise somebody
     limited to the 10th could write Tuesday's takings into last month,
     where they are the one person who cannot check them again. */
  if (!cashAccess.allows(req, entryDate)) {
    return res.status(403).json({ error: cashAccess.describe(req) + " This entry is dated outside that." });
  }

  let link;
  try { link = readPartyLink(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  /* A linked entry carries the party's real name in the free-text column too.
     The ledger, the search and the Excel export all read that column, and a
     row that shows a blank party because the name now lives in an id would be
     a step backwards from what the shop has today. */
  const partyText = link.name || (party || "").trim();

  const id = uid("CASH");
  db.prepare(`
    INSERT INTO cash_entries (id, date, type, amount, party, category, remarks, voided, party_type, party_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, entryDate, type, amount, partyText, (category || "").trim(), (remarks || "").trim(), link.partyType, link.partyId, Date.now());

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

router.put("/:id", mayEdit, (req, res) => {
  const e = db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(req.params.id);
  /* AN ENTRY OUTSIDE THE WINDOW IS NOT FOUND, not forbidden. Answering
     "you may not edit that" confirms the id exists and that something
     happened that day, which is the fact being withheld. The lookup above
     cannot be windowed — it is by primary key — so the check is here. */
  if (e && !cashAccess.allows(req, e.date)) {
    return res.status(404).json({ error: "Entry not found." });
  }
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Can't edit a deleted entry." });
  if (e.source_type) return res.status(400).json({ error: `This entry was created automatically from a ${e.source_type === "payment" ? "customer receipt" : "supplier payment"} — edit it there instead.` });

  const { date, type, party, category, remarks } = req.body;
  const amount = req.body.amount !== undefined ? round2(Number(req.body.amount)) : e.amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const entryType = (type === "in" || type === "out") ? type : e.type;
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : e.date;

  /* BOTH SIDES OF THE EDIT ARE CHECKED. The row being edited is already
     known to be inside the window; this is the date it is being moved TO.
     Without it, an entry could be walked out of the window a day at a
     time — and once outside, its author is the one person who can no
     longer see what they did. */
  if (!cashAccess.allows(req, entryDate)) {
    return res.status(403).json({ error: cashAccess.describe(req) + " You can't move an entry outside that." });
  }

  /* Left out of the body entirely, the existing link stands; sent empty, it
     is cleared. Re-pointing an entry at the wrong party is an ordinary typo
     and must be fixable here, not only by deleting and re-entering. */
  let link;
  try {
    link = (req.body.partyType === undefined && req.body.partyId === undefined)
      ? { partyType: e.party_type || "", partyId: e.party_id || "", name: null }
      : readPartyLink(req.body);
  } catch (err) { return res.status(400).json({ error: err.message }); }

  db.prepare(`
    UPDATE cash_entries SET date=?, type=?, amount=?, party=?, category=?, remarks=?, party_type=?, party_id=? WHERE id=?
  `).run(entryDate, entryType, amount, (link.name ?? party ?? e.party).trim(), (category ?? e.category).trim(), (remarks ?? e.remarks).trim(), link.partyType, link.partyId, e.id);

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
