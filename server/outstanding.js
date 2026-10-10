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

/**
 * CHALLAN OUTSTANDING — goods that moved but were never billed.
 *
 * A DIFFERENT THING from money outstanding, and kept apart from it on
 * purpose. A challan carries no demand for payment, so it is deliberately
 * excluded from receivables above; what is open about it is the INVOICE
 * that has not been raised yet. Adding the two together would inflate what
 * customers owe by the value of goods nobody has been billed for.
 *
 * So this answers "what have I delivered and not yet invoiced", which is a
 * conversion queue with a value on it — the thing a shop chases at month
 * end, and the thing an auditor asks about when stock has left but no sale
 * appears.
 */
function challanOutstanding(side) {
  const sales = side !== "supplier";
  const rows = sales
    ? db.prepare(`
        /* A DELIVERY CHALLAN CARRIES NO HEADER TOTAL — it is a list of goods,
           not a demand for money, so invoices.total is 0 on one. The value is
           therefore worked out from its own lines, which do hold quantity and
           rate. Without this the whole report reads zero and looks broken,
           when in fact nobody ever priced the header. */
        SELECT i.id, i.challan_no AS no, i.date,
               COALESCE(NULLIF(i.total, 0), (
                 SELECT ROUND(SUM(ii.qty * ii.rate * (1 - COALESCE(ii.discount_pct, 0) / 100.0)), 2)
                   FROM invoice_items ii WHERE ii.invoice_id = i.id
               ), 0) AS total,
               c.name AS party_name, i.customer_id AS party_id
          FROM invoices i
          LEFT JOIN customers c ON c.id = i.customer_id
         WHERE i.doc_type = 'challan' AND i.voided = 0
           AND (i.converted_invoice_id IS NULL OR i.converted_invoice_id = '')
         ORDER BY i.date DESC, i.created_at DESC
      `).all()
    : db.prepare(`
        SELECT p.id, p.purchase_no AS no, p.date, p.total,
               s.name AS party_name, p.supplier_id AS party_id
          FROM purchases p
          LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.doc_type = 'challan' AND p.voided = 0
           AND (p.converted_purchase_id IS NULL OR p.converted_purchase_id = '')
         ORDER BY p.date DESC, p.created_at DESC
      `).all();

  const out = rows.map(r => ({
    ...r,
    party_name: r.party_name || (sales ? "Walk-in" : "Unknown supplier"),
    total: round2(Number(r.total) || 0),
    daysOld: daysOld(r.date)
  }));
  return {
    side: sales ? "customer" : "supplier",
    kind: "challan",
    count: out.length,
    total: round2(out.reduce((t, r) => t + r.total, 0)),
    rows: out
  };
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
/* MONEY PAID WHEN THE BILL WAS MADE.

   A bill is not owed in full just because it exists. The billing screen
   books a Cash, UPI or Card sale as received in full (invoices.advance =
   total), and a part payment at the counter as that part — and the
   customer's due only ever rose by what was left (balance_due). Until this
   column was read here, the bill-wise breakdown ignored that money, so
   every counter sale to a named customer showed as unpaid and the aging
   buckets were inflated by it. The headline balance (customers.due) was
   right all along; this brings the breakdown back into line with it.

   Purchases are the same idea in the purchase screen's terms: only a
   Credit purchase raises the supplier's due, so anything else was paid
   when it was bought. A purchase challan is goods without a bill, and is
   left out exactly as a sales challan is. */
function loadSide(side, partyIds) {
  /* Optional narrowing to a few parties, for a screen that needs the
     status of a handful of bills rather than the whole book. */
  const ids = Array.isArray(partyIds) ? [...new Set(partyIds.filter(Boolean))] : null;
  const only = col => ids ? ` AND ${col} IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})` : "";
  const args = ids || [];
  if (side === "supplier") {
    return {
      parties: db.prepare(
        "SELECT id, name, phone, due FROM suppliers WHERE 1=1" + only("id") + " ORDER BY name COLLATE NOCASE"
      ).all(...args),
      bills: db.prepare(`
        SELECT id, supplier_id AS party_id, purchase_no AS no, date, total, due_date,
               CASE WHEN COALESCE(payment_method, 'Credit') = 'Credit' THEN 0 ELSE total END AS paid_at_bill
        FROM purchases WHERE voided = 0 AND COALESCE(doc_type, 'purchase') <> 'challan'` + only("supplier_id")
      ).all(...args),
      payments: db.prepare(`
        SELECT supplier_id AS party_id, stock_in_id AS bill_id, amount,
               COALESCE(payment_date, date(created_at/1000, 'unixepoch')) AS date
        FROM purchase_payments WHERE voided = 0` + only("supplier_id")
      ).all(...args),
      openings: db.prepare(`
        SELECT supplier_id AS party_id, date, amount, balance_type
        FROM supplier_opening_balances WHERE voided = 0` + only("supplier_id")
      ).all(...args),
      advanceType: "Advance"
    };
  }
  return {
    parties: db.prepare(
      "SELECT id, name, phone, due FROM customers WHERE 1=1" + only("id") + " ORDER BY name COLLATE NOCASE"
    ).all(...args),
    // A challan is not a demand for payment, so it never becomes outstanding.
    bills: db.prepare(`
      SELECT id, customer_id AS party_id, challan_no AS no, date, total, due_date,
             COALESCE(advance, 0) AS paid_at_bill
      FROM invoices WHERE voided = 0 AND doc_type = 'invoice'` + only("customer_id")
    ).all(...args),
    payments: db.prepare(`
      SELECT customer_id AS party_id, invoice_id AS bill_id, amount,
             COALESCE(payment_date, date(created_at/1000, 'unixepoch')) AS date
      FROM payments WHERE voided = 0` + only("customer_id")
    ).all(...args),
    openings: db.prepare(`
      SELECT customer_id AS party_id, date, amount, balance_type
      FROM customer_opening_balances WHERE voided = 0` + only("customer_id")
    ).all(...args),
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
/**
 * One party's bills, with what has been paid against each — THE allocation,
 * used by the Outstanding report and by every screen that shows a single
 * bill's status, so the two can never disagree about whether a bill is paid.
 */
function allocateParty(partyId, bills, pays, opens, advanceType) {
  const rawBills = (bills || []).map(b => {
    const total = round2(b.total);
    return {
      id: b.id, no: b.no, date: b.date, due_date: b.due_date || "", total,
      // Paid at the counter when the bill was raised — see loadSide().
      paid: Math.min(total, Math.max(0, round2(b.paid_at_bill || 0)))
    };
  });

  // Opening balance rides along as the oldest entry. An "Advance" opening
  // is money already with us, so it pays bills off rather than adding one.
  let advance = 0;
  for (const o of (opens || [])) {
    if (o.balance_type === advanceType) advance += round2(o.amount);
    else rawBills.push({ id: "OPENING:" + partyId, no: "Opening Balance",
                         date: o.date, total: round2(o.amount), paid: 0, opening: true });
  }

  rawBills.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byId = new Map(rawBills.map(b => [b.id, b]));

  // 1. payments that name a bill settle that bill first
  let pool = advance;
  for (const pay of (pays || [])) {
    const target = pay.bill_id != null ? byId.get(pay.bill_id) : null;
    if (target) {
      const room = Math.max(0, round2(target.total - target.paid));
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
  return { rawBills, pool, advance };
}

/**
 * The payment status of particular bills, from the allocation above.
 *
 *   state    unpaid | partial | paid
 *   overdue  true when something is still owed and its due date has passed
 *
 * Bills without a party (a walk-in sale) have nobody to allocate against,
 * so they are judged on the money taken at the counter alone.
 */
function billStatus(side, bills) {
  const out = new Map();
  const list = (bills || []).filter(b => b && b.id);
  const partyIds = [...new Set(list.map(b => b.party_id).filter(Boolean))];
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const shape = (total, paid, dueDate) => {
    const balance = round2(Math.max(0, total - paid));
    const state = balance <= 0.005 ? "paid" : (paid > 0 ? "partial" : "unpaid");
    return {
      total, paid: round2(paid), balance, state,
      label: state === "paid" ? "Paid" : state === "partial" ? "Partly paid" : "Unpaid",
      overdue: state !== "paid" && !!dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && dueDate < today,
      dueDate: dueDate || ""
    };
  };
  if (partyIds.length) {
    const src = loadSide(side, partyIds);
    const billsBy = groupBy(src.bills, "party_id");
    const paysBy = groupBy(src.payments, "party_id");
    const opensBy = groupBy(src.openings, "party_id");
    for (const pid of partyIds) {
      const { rawBills } = allocateParty(pid, billsBy.get(pid), paysBy.get(pid), opensBy.get(pid), src.advanceType);
      for (const b of rawBills) if (!b.opening) out.set(b.id, shape(b.total, b.paid, b.due_date));
    }
  }
  for (const b of list) {
    if (out.has(b.id)) continue;
    const total = round2(b.total);
    out.set(b.id, shape(total, Math.min(total, round2(b.paid_at_bill || 0)), b.due_date));
  }
  return out;
}

function outstandingDetails(side) {
  const src = loadSide(side);
  const billsBy = groupBy(src.bills, "party_id");
  const paysBy = groupBy(src.payments, "party_id");
  const opensBy = groupBy(src.openings, "party_id");

  const parties = [];
  for (const p of src.parties) {
    const { rawBills, pool, advance } = allocateParty(
      p.id, billsBy.get(p.id), paysBy.get(p.id), opensBy.get(p.id), src.advanceType);

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

    // The report's own columns. Opening is netted (a Receivable opening
    // less any Advance), Total Bills excludes the opening so the two are
    // never double-counted, and Total Received is every payment recorded
    // against the party whether or not it named a bill.
    const openingReceivable = (opensBy.get(p.id) || [])
      .filter(o => o.balance_type !== src.advanceType)
      .reduce((s2, o) => round2(s2 + round2(o.amount)), 0);
    const openingOutstanding = round2(openingReceivable - advance);
    const totalBills = rawBills.filter(b => !b.opening)
      .reduce((s2, b) => round2(s2 + b.total), 0);
    /* Received = payments recorded later PLUS what was taken at the counter
       when each bill was made, so Opening + Bills − Received comes out at
       the balance instead of overstating it by every cash sale. */
    const takenAtBill = (billsBy.get(p.id) || []).reduce((s2, b) =>
      round2(s2 + Math.min(round2(b.total), Math.max(0, round2(b.paid_at_bill || 0)))), 0);
    const totalPaid = round2((paysBy.get(p.id) || [])
      .reduce((s2, x) => round2(s2 + round2(x.amount)), 0) + takenAtBill);

    parties.push({
      id: p.id, name: p.name, phone: p.phone || "",
      openingOutstanding, totalBills, totalPaid,
      // No adjustment store exists yet, so this is honestly zero rather than
      // a number invented to make the row add up. When debit/credit notes
      // land, they sum in here and the arithmetic below still holds.
      adjustment: 0,
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

  /* Only parties who still owe something. A cleared party drops off the
     moment its balance reaches zero, and the totals below are therefore the
     sum of pending amounts alone. The half-paisa threshold keeps a rounding
     residue like 0.004 from keeping a settled party on the report. */
  const withDues = parties.filter(p => p.balance > 0.005);
  const totals = withDues.reduce((acc, p) => {
    acc.balance = round2(acc.balance + p.balance);
    for (const k of Object.keys(acc.aging)) acc.aging[k] = round2(acc.aging[k] + p.aging[k]);
    return acc;
  }, { balance: 0, aging: emptyAging() });

  return { side, parties: withDues, partyCount: withDues.length, totals };
}

module.exports = { outstandingDetails, challanOutstanding, daysOld, agingBucket, billStatus, allocateParty };
