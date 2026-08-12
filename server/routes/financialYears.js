/**
 * Financial Year closing.
 *
 * Read this before changing anything here, because the obvious mental model
 * is the wrong one for this app.
 *
 * In a posting-based ledger, closing a year MOVES things: stock, debtors,
 * creditors, cash and bank are carried into opening balances of the next
 * year, and the year's profit is transferred to capital. This app does not
 * work that way. Stock lives in product_sizes / size_location_stock as a
 * running quantity. A customer's balance is customers.due, a running figure.
 * Cash and bank are running sums of their entries. None of them are scoped to
 * a year, so all of them already continue into 1 April untouched — there is
 * nothing to carry forward, and code that "carried" them would double them.
 *
 * Retained profit is the same story: computeBalanceSheet() deliberately runs
 * the P&L over an unbounded range for capital, so prior years' profit is
 * already inside closing capital. Posting a retained-profit capital entry at
 * closing would count that profit twice.
 *
 * So what closing actually gives the owner is the two things that genuinely
 * did not exist:
 *   1. A permanent, dated record of what the year closed at (fy_snapshot) —
 *      because every balance in this app is a LIVE figure, and today's stock
 *      report cannot tell you what stock was on 31 March.
 *   2. A lock, so a filed year stops accepting edits (see server/fyLock.js).
 *
 * Nothing here deletes anything. Closed years remain fully readable.
 */
const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, round2, logAction } = require("../util");
const reports = require("./reports");

const { computePnl, computeBalanceSheet } = reports;

/* ------------------------------------------------------------------ */
/* year helpers                                                        */
/* ------------------------------------------------------------------ */

const pad = n => String(n).padStart(2, "0");

/* Snapshot detail lines are read by a person, years later, so amounts inside
   them are written the way the rest of the app writes money. */
const rupees = n => "₹" + Number(round2(n) || 0).toLocaleString("en-IN");

function fyStartMonth() {
  const s = db.prepare("SELECT fy_start_month FROM settings WHERE id = 1").get();
  return (s && s.fy_start_month) || 4;
}

/** The year that begins on `startYear`-`startMonth`-01. */
function yearSpan(startYear, startMonth) {
  const start = `${startYear}-${pad(startMonth)}-01`;
  const endD = new Date(startYear + 1, startMonth - 1, 0); // day 0 = last of previous month
  const end = `${endD.getFullYear()}-${pad(endD.getMonth() + 1)}-${pad(endD.getDate())}`;
  const label = startMonth === 1
    ? String(startYear)
    : `${startYear}-${pad((startYear + 1) % 100)}`;
  return { label, start, end, id: "FY_" + label.replace(/\W+/g, "_") };
}

/** Creates the year following `fy` if it does not exist yet, and returns it. */
function ensureNextYear(fy) {
  const startMonth = fyStartMonth();
  const nextStartYear = Number(fy.start_date.slice(0, 4)) + 1;
  const span = yearSpan(nextStartYear, startMonth);
  const existing = db.prepare("SELECT * FROM financial_years WHERE id = ?").get(span.id);
  if (existing) return existing;
  db.prepare(`
    INSERT INTO financial_years (id, label, start_date, end_date, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
  `).run(span.id, span.label, span.start, span.end, Date.now());
  return db.prepare("SELECT * FROM financial_years WHERE id = ?").get(span.id);
}

function rangeFor(fy) {
  return {
    from: fy.start_date,
    to: fy.end_date,
    active: true,
    sql: col => ` AND ${col} >= ? AND ${col} <= ?`,
    params: () => [fy.start_date, fy.end_date]
  };
}

/* ------------------------------------------------------------------ */
/* the closing position                                                */
/* ------------------------------------------------------------------ */

/**
 * Builds every line that would be recorded for `fy`.
 *
 * Used unchanged by the preview and by the close itself, so what the owner
 * approves on screen is exactly what gets written — no second code path that
 * can drift away from the one they looked at.
 *
 * The balances are LIVE (today's stock, today's dues). That is honest rather
 * than convenient: the app has no historical reconstruction, and inventing
 * one would produce a figure nobody could tie back to anything. Closing on or
 * near 31 March therefore matters, and the UI says so.
 */
function buildClosingPosition(fy) {
  const range = rangeFor(fy);
  const pnl = computePnl(range);
  const bs = computeBalanceSheet();
  const lines = [];
  const add = (section, label, opts = {}) => lines.push({
    section,
    ref_id: opts.refId || null,
    label,
    detail: opts.detail || null,
    quantity: opts.quantity == null ? null : round2(opts.quantity),
    amount: opts.amount == null ? null : round2(opts.amount)
  });

  // --- closing stock, per product size, at the value the Balance Sheet uses
  const sizes = db.prepare(`
    SELECT ps.id, ps.product_id, ps.label AS size, ps.stock, ps.cost_price, p.name, p.brand
    FROM product_sizes ps JOIN products p ON p.id = ps.product_id
    WHERE ps.stock <> 0
    ORDER BY p.name, ps.label
  `).all();
  for (const s of sizes) {
    add("stock", s.name, {
      refId: s.id,
      detail: [s.brand, s.size].filter(Boolean).join(" · ") || null,
      quantity: s.stock,
      amount: (s.cost_price || 0) * s.stock
    });
  }

  // --- who owes the shop, and who the shop owes
  db.prepare("SELECT id, name, phone, due FROM customers WHERE due <> 0 ORDER BY name")
    .all().forEach(c => add("customer", c.name, { refId: c.id, detail: c.phone || null, amount: c.due }));
  db.prepare("SELECT id, name, phone, due FROM suppliers WHERE due <> 0 ORDER BY name")
    .all().forEach(s => add("supplier", s.name, { refId: s.id, detail: s.phone || null, amount: s.due }));

  // --- cash and bank
  add("cash", "Cash in hand", { amount: bs.assets.cashInHand });
  bs.assets.bankAccounts.forEach(a =>
    add("bank", a.name, { refId: a.id, amount: a.balance }));

  // --- one-time-entry masters
  db.prepare("SELECT id, name, cost, accumulated_depreciation FROM fixed_assets WHERE active = 1 ORDER BY name")
    .all().forEach(a => add("asset", a.name, {
      refId: a.id,
      detail: `Cost ${rupees(a.cost)} less depreciation ${rupees(a.accumulated_depreciation)}`,
      amount: a.cost - a.accumulated_depreciation
    }));
  db.prepare("SELECT id, held_by, purpose, amount FROM deposits WHERE active = 1 ORDER BY held_by")
    .all().forEach(d => add("deposit", d.held_by, { refId: d.id, detail: d.purpose || null, amount: d.amount }));
  db.prepare("SELECT id, lender, kind, outstanding FROM loans WHERE active = 1 ORDER BY lender")
    .all().forEach(l => add("loan", l.lender, { refId: l.id, detail: l.kind, amount: l.outstanding }));
  db.prepare("SELECT id, label, category, amount FROM outstanding_liabilities WHERE settled = 0 ORDER BY label")
    .all().forEach(l => add("liability", l.label || l.category || "Other", {
      refId: l.id, detail: l.category || null, amount: l.amount
    }));

  // --- the year's own result, and the position it closed at
  add("pnl", "Sales revenue", { amount: pnl.income.salesRevenue });
  add("pnl", "Transport & loading recovered", { amount: pnl.income.chargesRecovered });
  add("pnl", "Other income", { amount: pnl.income.otherIncomeTotal });
  add("pnl", "Cost of goods sold", { amount: pnl.expenses.costOfGoodsSold });
  add("pnl", "Operating expenses", { amount: pnl.expenses.operatingTotal });
  add("pnl", "Gross profit", { amount: pnl.grossProfit });
  add("pnl", "Net profit", { amount: pnl.netProfit });
  add("pnl", "Bills raised", { quantity: pnl.bills });

  const totals = {
    stockValue: round2(lines.filter(l => l.section === "stock").reduce((s, l) => s + (l.amount || 0), 0)),
    stockLines: lines.filter(l => l.section === "stock").length,
    receivables: bs.assets.receivables,
    payables: bs.liabilities.payables,
    cash: bs.assets.cashInHand,
    bank: bs.assets.bankBalance,
    netProfit: pnl.netProfit,
    closingCapital: bs.capital.closing
  };

  return {
    year: { id: fy.id, label: fy.label, start: fy.start_date, end: fy.end_date, status: fy.status },
    lines,
    totals,
    pnl,
    balanceSheet: bs,
    // Said plainly rather than buried: the owner should know which figures are
    // as-at-today and which are for the year.
    notes: [
      "Stock, dues, cash and bank are today's live balances — close the year on or near 31 March for them to be right.",
      "Profit figures cover " + fy.start_date + " to " + fy.end_date + " only.",
      "Closing does not move any balance. Everything continues into the new year exactly as it is now.",
      pnl.itemsWithoutCost > 0
        ? pnl.itemsWithoutCost + " sold line(s) have no purchase cost on file, so profit is overstated by their cost."
        : null
    ].filter(Boolean)
  };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

router.get("/", (req, res) => {
  const years = db.prepare("SELECT * FROM financial_years ORDER BY start_date DESC").all();
  const counts = db.prepare("SELECT fy_id, COUNT(*) AS n FROM fy_snapshot GROUP BY fy_id").all();
  const byFy = new Map(counts.map(c => [c.fy_id, c.n]));
  res.json({
    years: years.map(y => ({ ...y, snapshotLines: byFy.get(y.id) || 0 })),
    startMonth: fyStartMonth()
  });
});

/** The current year — whichever open year today falls in. */
router.get("/current", (req, res) => {
  const today = new Date();
  const d = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const fy = db.prepare(
    "SELECT * FROM financial_years WHERE start_date <= ? AND end_date >= ?"
  ).get(d, d);
  res.json(fy || null);
});

/** What closing this year would record. Writes nothing. */
router.get("/:id/preview", (req, res) => {
  const fy = db.prepare("SELECT * FROM financial_years WHERE id = ?").get(req.params.id);
  if (!fy) return res.status(404).json({ error: "Financial year not found" });
  res.json(buildClosingPosition(fy));
});

/** A stored snapshot, for a year already closed. */
router.get("/:id/snapshot", (req, res) => {
  const fy = db.prepare("SELECT * FROM financial_years WHERE id = ?").get(req.params.id);
  if (!fy) return res.status(404).json({ error: "Financial year not found" });
  const lines = db.prepare(
    "SELECT section, ref_id, label, detail, quantity, amount FROM fy_snapshot WHERE fy_id = ? ORDER BY id"
  ).all(fy.id);
  const sum = section => round2(
    lines.filter(l => l.section === section).reduce((s, l) => s + (l.amount || 0), 0)
  );
  const pnlLine = label => {
    const row = lines.find(l => l.section === "pnl" && l.label === label);
    return row ? row.amount : null;
  };
  res.json({
    year: fy,
    lines,
    totals: {
      stockValue: sum("stock"),
      stockLines: lines.filter(l => l.section === "stock").length,
      receivables: round2(lines.filter(l => l.section === "customer" && l.amount > 0)
        .reduce((s, l) => s + l.amount, 0)),
      payables: round2(lines.filter(l => l.section === "supplier" && l.amount > 0)
        .reduce((s, l) => s + l.amount, 0)),
      cash: sum("cash"),
      bank: sum("bank"),
      netProfit: pnlLine("Net profit")
    }
  });
});

/**
 * Close a year: record the position, then lock it.
 *
 * A backup runs first. It is not optional and not a checkbox — the one moment
 * an owner most wants a restore point is the moment before a year is frozen.
 */
router.post("/:id/close", async (req, res, next) => {
  try {
    const fy = db.prepare("SELECT * FROM financial_years WHERE id = ?").get(req.params.id);
    if (!fy) return res.status(404).json({ error: "Financial year not found" });
    if (fy.status === "closed") {
      return res.status(400).json({ error: `Financial year ${fy.label} is already closed.` });
    }

    const position = buildClosingPosition(fy);

    let backup = null;
    try {
      backup = await require("../backup").runBackup("fy-close");
    } catch (e) {
      // Reported, never swallowed — the owner decides whether to go on without one.
      backup = { error: e.message };
    }
    if (backup && backup.error && req.body.proceedWithoutBackup !== true) {
      return res.status(409).json({
        error: "Backup before closing failed: " + backup.error,
        needsConfirm: true
      });
    }

    const now = Date.now();
    const by = (req.session && req.session.staffName) || "Owner";
    const insert = db.prepare(`
      INSERT INTO fy_snapshot (fy_id, section, ref_id, label, detail, quantity, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    try {
      // Re-closing after a re-open replaces that year's snapshot rather than
      // stacking a second one beside it. The old figures were superseded by
      // the corrections the re-open was granted for.
      db.prepare("DELETE FROM fy_snapshot WHERE fy_id = ?").run(fy.id);
      for (const l of position.lines) {
        insert.run(fy.id, l.section, l.ref_id, l.label, l.detail, l.quantity, l.amount, now);
      }
      db.prepare(
        "UPDATE financial_years SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?"
      ).run(now, by, fy.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    const next_ = ensureNextYear(fy);
    logAction(req, "fy_close",
      `Closed ${fy.label}: ${position.lines.length} lines recorded, net profit ${position.totals.netProfit}`);

    res.json({
      ok: true,
      year: db.prepare("SELECT * FROM financial_years WHERE id = ?").get(fy.id),
      nextYear: next_,
      linesRecorded: position.lines.length,
      totals: position.totals,
      backup
    });
  } catch (e) { next(e); }
});

/**
 * Re-open a closed year.
 *
 * Real books get corrected in June for something dated March. An app that
 * refuses simply pushes people into misdating the entry, which is worse. So
 * the year re-opens — with the reason recorded, permanently, against it.
 */
router.post("/:id/reopen", (req, res) => {
  const fy = db.prepare("SELECT * FROM financial_years WHERE id = ?").get(req.params.id);
  if (!fy) return res.status(404).json({ error: "Financial year not found" });
  if (fy.status !== "closed") {
    return res.status(400).json({ error: `Financial year ${fy.label} is not closed.` });
  }
  const reason = String(req.body.reason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: "Give a reason for re-opening this year (at least 5 characters)." });
  }
  const by = (req.session && req.session.staffName) || "Owner";
  db.prepare(`
    UPDATE financial_years
    SET status = 'open', reopened_at = ?, reopened_by = ?, reopen_reason = ?
    WHERE id = ?
  `).run(Date.now(), by, reason, fy.id);
  // The snapshot stays. It is the record of what was filed, and it is what the
  // corrected figures will be compared against.
  logAction(req, "fy_reopen", `Re-opened ${fy.label}: ${reason}`);
  res.json({ ok: true, year: db.prepare("SELECT * FROM financial_years WHERE id = ?").get(fy.id) });
});

/** Start a year by hand — for a shop whose first year is a part year. */
router.post("/", (req, res) => {
  const startYear = Number(req.body.startYear);
  if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 2100) {
    return res.status(400).json({ error: "Give a valid starting year." });
  }
  const span = yearSpan(startYear, fyStartMonth());
  const existing = db.prepare("SELECT * FROM financial_years WHERE id = ?").get(span.id);
  if (existing) return res.status(400).json({ error: `Financial year ${span.label} already exists.` });
  db.prepare(`
    INSERT INTO financial_years (id, label, start_date, end_date, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
  `).run(span.id, span.label, span.start, span.end, Date.now());
  logAction(req, "fy_create", `Created financial year ${span.label}`);
  res.json(db.prepare("SELECT * FROM financial_years WHERE id = ?").get(span.id));
});

module.exports = router;
module.exports.buildClosingPosition = buildClosingPosition;
