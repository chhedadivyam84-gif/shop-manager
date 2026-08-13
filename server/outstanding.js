/* ============================================================
   OUTSTANDING — one engine for both sides

   Party balances already live on customers.due / suppliers.due, kept correct
   by the bill and payment routes. What did not exist was the breakdown: WHICH
   bills make up that balance, how old each one is, and how much of each is
   still unpaid.

   Allocation rule
   ---------------
   A payment that names a bill is applied to THAT bill — payments already
   carry invoice_id / stock_in_id, so a link the operator made is honoured
   exactly rather than second-guessed. Everything else is applied oldest bill
   first, the way a shop actually settles an account.

   That makes bill-wise status DERIVED, not stored: nothing to migrate, no
   historical re-entry, and it stays correct the moment a bill, payment or
   opening balance changes. If explicit allocation is added later, this FIFO
   result is exactly the default it should start from.

   Opening balance is treated as the oldest "bill" of all, because that is
   what it represents — what the party already owed on day one.
   ============================================================ */
const db = require("./db");

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/** Whole days between a date and today. Negative (future-dated) clamps to 0
 *  so a post-dated bill never lands in an aging bucket it has not reached. */
function daysOld(dateStr) {
  if (!dateStr) return 0;
  const then = new Date(dateStr + "T00:00:00");
  if (isNaN(then)) return 0;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((now - then) / 86400000));
}

function agingBucket(days) {
  if (days <= 30) return "d0_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90plus";
}

function emptyAging() {
  return { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
}

/**
 * Bills and payments for one side, shaped identically so the allocation
 * below does not care whether it is looking at a customer or a supplier.
 */
function loadSide(side) {
  if (side === "supplier") {
    return {
      parties: db.prepare(
        "SELECT id, name, phone, due FROM suppliers ORDER BY name COLLATE NOCASE"
      ).all(),
      bills: db.prepare(`
        SELECT id, supplier_id AS party_id, purchase_no AS no, date, total
        FROM purchases WHERE voided = 0
      `).all(),
      payments: db.prepare(`
        SELECT supplier_id AS party_id, stock_in_id AS bill_id, amount,
               COALESCE(payment_date, date(created_at/1000, 'unixepoch')) AS date
        FROM purchase_payments WHERE voided = 0
      `).all(),
      openings: db.prepare(`
        SELECT supplier_id AS party_id, date, amount, balance_type
        FROM supplier_opening_balances WHERE voided = 0
      `).all(),
      advanceType: "Advance"
    };
  }
  return {
    parties: db.prepare(
      "SELECT id, name, phone, due FROM customers ORDER BY name COLLATE NOCASE"
    ).all(),
    // A challan is not a demand for payment, so it never becomes outstanding.
    bills: db.prepare(`
      SELECT id, customer_id AS party_id, challan_no AS no, date, total
      FROM invoices WHERE voided = 0 AND doc_type = 'invoice'
    `).all(),
    payments: db.prepare(`
      SELECT customer_id AS party_id, invoice_id AS bill_id, amount,
             COALESCE(payment_date, date(created_at/1000, 'unixepoch')) AS date
      FROM payments WHERE voided = 0
    `).all(),
    openings: db.prepare(`
      SELECT customer_id AS party_id, date, amount, balance_type
      FROM customer_opening_balances WHERE voided = 0
    `).all(),
    advanceType: "Advance"
  };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
}

/**
 * Party-wise outstanding, each with its bill-wise breakdown and aging.
 *
 * `side` is "customer" (receivable) or "supplier" (payable).
 */
function outstandingDetails(side) {
  const src = loadSide(side);
  const billsBy = groupBy(src.bills, "party_id");
  const paysBy = groupBy(src.payments, "party_id");
  const opensBy = groupBy(src.openings, "party_id");

  const parties = [];
  for (const p of src.parties) {
    const rawBills = (billsBy.get(p.id) || []).map(b => ({
      id: b.id, no: b.no, date: b.date, total: round2(b.total), paid: 0
    }));

    // Opening balance rides along as the oldest entry. An "Advance" opening
    // is money already with us, so it pays bills off rather than adding one.
    let advance = 0;
    for (const o of (opensBy.get(p.id) || [])) {
      if (o.balance_type === src.advanceType) advance += round2(o.amount);
      else rawBills.push({ id: "OPENING:" + p.id, no: "Opening Balance",
                           date: o.date, total: round2(o.amount), paid: 0, opening: true });
    }

    rawBills.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const byId = new Map(rawBills.map(b => [b.id, b]));

    // 1. payments that name a bill settle that bill first
    let pool = advance;
    for (const pay of (paysBy.get(p.id) || [])) {
      const target = pay.bill_id != null ? byId.get(pay.bill_id) : null;
      if (target) {
        const room = Math.max(0, target.total - target.paid);
        const used = Math.min(room, round2(pay.amount));
        target.paid = round2(target.paid + used);
        pool = round2(pool + (round2(pay.amount) - used));  // overpayment flows on
      } else {
        pool = round2(pool + round2(pay.amount));
      }
    }
    // 2. whatever is left settles the oldest bills first
    for (const b of rawBills) {
      if (pool <= 0) break;
      const room = round2(b.total - b.paid);
      if (room <= 0) continue;
      const used = Math.min(room, pool);
      b.paid = round2(b.paid + used);
      pool = round2(pool - used);
    }

    const aging = emptyAging();
    let outstanding = 0;
    const bills = rawBills.map(b => {
      const balance = round2(b.total - b.paid);
      const days = daysOld(b.date);
      if (balance > 0) {
        outstanding = round2(outstanding + balance);
        aging[agingBucket(days)] = round2(aging[agingBucket(days)] + balance);
      }
      return {
        id: b.id, no: b.no, date: b.date, total: b.total, paid: b.paid, balance,
        daysOld: days, opening: !!b.opening,
        status: balance <= 0 ? "Paid" : (b.paid > 0 ? "Partially Paid" : "Pending")
      };
    });

    parties.push({
      id: p.id, name: p.name, phone: p.phone || "",
      // The stored due stays the authority for the headline figure; the
      // bill-wise sum is shown beside it, and any gap is surfaced rather
      // than hidden, since a mismatch means something needs looking at.
      balance: round2(p.due || 0),
      billwiseTotal: outstanding,
      unappliedCredit: round2(pool),
      aging,
      bills: bills.filter(b => b.balance > 0 || b.paid > 0),
      billCount: bills.filter(b => b.balance > 0).length
    });
  }

  const withDues = parties.filter(p => p.balance > 0 || p.billwiseTotal > 0);
  const totals = withDues.reduce((acc, p) => {
    acc.balance = round2(acc.balance + p.balance);
    for (const k of Object.keys(acc.aging)) acc.aging[k] = round2(acc.aging[k] + p.aging[k]);
    return acc;
  }, { balance: 0, aging: emptyAging() });

  return { side, parties: withDues, partyCount: withDues.length, totals };
}

module.exports = { outstandingDetails, daysOld, agingBucket };
