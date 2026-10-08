/* ============================================================
   ADMIN SALES & INVOICES — reading the books, and nothing else

   THIS MODULE IS READ-ONLY, and that is a decision rather than an
   omission. An invoice is not a customer record: it has been printed,
   handed over, and filed in a GST return. Changing or voiding one is a
   financial act, and the shop app already surrounds it with the things
   that make it safe — the financial-year lock that refuses a write into
   a filed period, the stock that has to come back, the customer balance
   that has to move with it, and the audit entry. Offering a second door
   onto that from an admin screen would mean either reimplementing all
   of it or quietly skipping some, and the second is how books end up
   disagreeing with returns.

   So: no edit, no void, no delete, no renumber. Nothing in this file
   writes. The panel shows what the books say and sends anyone who needs
   to CHANGE something to the screen that was built to do it.

   WHAT COUNTS AS A SALE, consistently with every other figure in this
   app: a priced tax invoice, not voided. A delivery challan carries
   goods out of the shop but no rates, GST or total — it is listed here,
   clearly marked, and never added into a money figure. Counting one
   would inflate every total on the screen.

   TWO NUMBERS THAT LOOK ALIKE AND ARE NOT:
     total         what the document says, after discount, GST and
                   charges — the money.
     goods_value   what the lines are worth. A challan's `total` is
                   transport and loading only, by design, so this is the
                   only way to say what actually went out on one.
   ============================================================ */
const db = require("./db");
/* The shop's own status vocabulary — Pending, Partially Completed,
   Completed, Billed, Cancelled. This module first invented its own
   words for the same five states, which meant the admin panel and the
   billing screen could describe one bill differently. One engine. */
const { deriveDocStatus } = require("./routes/invoices");
const { localDate, round2, todayStr } = require("./util");

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
}

function likeTerm(q) {
  return "%" + String(q).replace(/[\\%_]/g, c => "\\" + c) + "%";
}

/* Priced tax invoices only, wherever money is counted. */
const SALE = "i.voided = 0 AND i.doc_type = 'invoice'";

/* ------------------------------------------------------------------
   FILTERS AND SORTS

   Only what the records can answer. There is no "profitable" filter and
   no "at risk" one, because nothing in these tables knows either.
   ------------------------------------------------------------------ */
const TYPES = {
  all:      { label: "Invoices and challans", where: null },
  invoice:  { label: "Tax invoices only",     where: "i.doc_type = 'invoice'" },
  challan:  { label: "Delivery challans only", where: "i.doc_type = 'challan'" },
};

const STATUSES = {
  all:      { label: "Any status",      where: "i.voided = 0" },
  unpaid:   { label: "Money outstanding", where: "i.voided = 0 AND COALESCE(i.balance_due, 0) > 0" },
  paid:     { label: "Settled",         where: "i.voided = 0 AND COALESCE(i.balance_due, 0) <= 0" },
  overdue:  { label: "Past its due date", where:
    "i.voided = 0 AND COALESCE(i.balance_due, 0) > 0 AND i.due_date IS NOT NULL" +
    " AND i.due_date <> '' AND i.due_date < :today" },
  unbilled: { label: "Challans not yet billed", where:
    "i.voided = 0 AND i.doc_type = 'challan' AND i.converted_invoice_id IS NULL" },
  /* Cancelled documents are NOT hidden. A voided bill is part of the
     record — the number was issued and then cancelled, and a screen
     that silently drops it invites the question of where SP0000042
     went. It is shown, struck through, and never counted. */
  voided:   { label: "Cancelled",       where: "i.voided = 1" },
};

const SORTS = {
  recent:  { label: "Newest first",   sql: "i.date DESC, i.created_at DESC" },
  oldest:  { label: "Oldest first",   sql: "i.date ASC, i.created_at ASC" },
  largest: { label: "Largest first",  sql: "i.total DESC" },
  due:     { label: "Most outstanding", sql: "COALESCE(i.balance_due,0) DESC, i.date DESC" },
  number:  { label: "Document number", sql: "i.challan_no ASC" },
};

/* Only customers who actually have a document, so the filter never
   offers a name that would return nothing. */
function billedCustomers() {
  try {
    return db.prepare(`
      SELECT c.id, c.name, COUNT(*) AS n
        FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.voided = 0
       GROUP BY c.id ORDER BY c.name COLLATE NOCASE ASC LIMIT 500`).all();
  } catch (e) { return []; }
}

function describeOptions() {
  return {
    customers: billedCustomers(),
    types: Object.keys(TYPES).map(k => ({ key: k, label: TYPES[k].label })),
    statuses: Object.keys(STATUSES).map(k => ({ key: k, label: STATUSES[k].label })),
    sorts: Object.keys(SORTS).map(k => ({ key: k, label: SORTS[k].label })),
    pageSize: PAGE_SIZE,
  };
}

/* ==================================================================
   THE DOCUMENT LIST
   ================================================================== */
function documents(opts) {
  const o = opts || {};
  const q = String(o.q || "").trim();
  const type = Object.prototype.hasOwnProperty.call(TYPES, o.type) ? o.type : "all";
  const status = Object.prototype.hasOwnProperty.call(STATUSES, o.status) ? o.status : "all";
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "recent";

  const size = Math.min(Math.max(Number(o.pageSize) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(o.page) || 1, 1);

  const where = [];
  const params = [];

  if (q) {
    /* The document number, the customer, and the exact amount — the
       three things somebody holding a piece of paper actually has. */
    where.push("(i.challan_no LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\'" +
               " OR i.id LIKE ? ESCAPE '\\' OR CAST(i.total AS TEXT) LIKE ? ESCAPE '\\')");
    const t = likeTerm(q);
    params.push(t, t, t, t);
  }

  if (TYPES[type].where) where.push(TYPES[type].where);

  /* One customer's documents. The id is matched exactly — this is a
     filter, not a search, and a LIKE here would quietly include a
     customer whose id merely starts the same. */
  const customerId = String(o.customerId || "").trim();
  if (customerId) { where.push("i.customer_id = ?"); params.push(customerId); }

  let statusWhere = STATUSES[status].where;
  if (statusWhere.includes(":today")) {
    statusWhere = statusWhere.replace(":today", "?");
    params.push(todayStr());
  }
  where.push(statusWhere);

  if (o.from) { where.push("i.date >= ?"); params.push(String(o.from)); }
  if (o.to)   { where.push("i.date <= ?"); params.push(String(o.to)); }

  const whereSql = " WHERE " + where.join(" AND ");
  const FROM = `FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id`;

  const head = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN i.doc_type = 'invoice' AND i.voided = 0 THEN i.total ELSE 0 END), 0) AS money,
           COALESCE(SUM(CASE WHEN i.voided = 0 THEN COALESCE(i.balance_due, 0) ELSE 0 END), 0) AS due
      ${FROM}${whereSql}`).get(...params);

  const pages = Math.max(Math.ceil(head.n / size), 1);
  const safePage = Math.min(page, pages);

  const rows = db.prepare(`
    SELECT i.id, i.challan_no, i.doc_type, i.date, i.created_at, i.total,
           i.balance_due, i.advance, i.payment_method, i.due_date, i.voided,
           i.converted_invoice_id, i.subtotal, i.discount_amount,
           i.cgst, i.sgst, i.igst, c.name AS customer, c.id AS customer_id,
           (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS lines,
           (SELECT COALESCE(SUM(ii.qty * ii.rate * (1 - COALESCE(ii.discount_pct,0)/100.0)), 0)
              FROM invoice_items ii WHERE ii.invoice_id = i.id) AS goods_value
      ${FROM}${whereSql}
     ORDER BY ${SORTS[sort].sql}
     LIMIT ? OFFSET ?`).all(...params, size, (safePage - 1) * size);

  return {
    total: head.n,
    page: safePage, pages, pageSize: size,
    q, type, status, sort, customerId, from: o.from || "", to: o.to || "",
    /* The totals for everything the filter matched, not just this page —
       a page total would be a number nobody asked for. */
    matched: { money: round2(head.money), due: round2(head.due) },
    rows: rows.map(shapeRow),
    options: describeOptions(),
  };
}

function shapeRow(r) {
  const challan = r.doc_type === "challan";
  const tax = round2((r.cgst || 0) + (r.sgst || 0) + (r.igst || 0));
  return {
    /* The shop's own word for this document's state, from the shop's own
       function — not a label invented here. */
    status: deriveDocStatus(r),
    id: r.id,
    no: r.challan_no,
    type: r.doc_type,
    isChallan: challan,
    date: r.date,
    customer: r.customer || "",
    customerId: r.customer_id || "",
    /* A challan has no money on it. Sending null rather than 0 keeps the
       browser from printing a confident zero rupees against goods that
       really did leave the shop. */
    total: challan ? null : round2(r.total || 0),
    /* A challan carries no money at all, so every money field on one is
       null rather than zero. Only its goods have a value. */
    subtotal: challan ? null : round2(r.subtotal || 0),
    discount: challan ? null : round2(r.discount_amount || 0),
    tax: challan ? null : tax,
    goodsValue: round2(r.goods_value || 0),
    balanceDue: r.voided ? 0 : round2(r.balance_due || 0),
    paymentMethod: r.payment_method || "",
    dueDate: r.due_date || "",
    overdue: !r.voided && (r.balance_due || 0) > 0 &&
             !!r.due_date && r.due_date < todayStr(),
    voided: !!r.voided,
    billed: challan ? !!r.converted_invoice_id : null,
    lines: r.lines,
  };
}

/* ==================================================================
   ONE DOCUMENT

   Null for an id this company does not have — db is bound to the
   session's company, so another shop's bill is not in the file.
   ================================================================== */
function document(id) {
  const i = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone,
           c.gst AS customer_gst, c.address AS customer_address
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = ?`).get(id);
  if (!i) return null;

  const items = db.prepare(`
    SELECT id, name, size_label, brand, code, hsn_code, mode,
           pieces, unit_label, qty, rate, gst_rate, discount_pct
      FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`).all(id);

  /* Money taken against THIS document. A payment can also be made
     against the customer rather than a bill, which is why this is not
     the whole story and the panel says so. */
  const payments = db.prepare(`
    SELECT id, amount, method, reference_no, payment_date, created_at
      FROM payments WHERE invoice_id = ? AND voided = 0
     ORDER BY created_at DESC`).all(id);

  let returns = [];
  try {
    returns = db.prepare(`
      SELECT id, return_no, date, total, reason
        FROM sales_returns WHERE invoice_id = ? AND voided = 0
       ORDER BY created_at DESC`).all(id);
  } catch (e) { returns = []; }

  const challan = i.doc_type === "challan";
  const goodsValue = items.reduce(
    (t, it) => t + (it.qty * it.rate * (1 - (it.discount_pct || 0) / 100)), 0);

  return {
    document: {
      id: i.id,
      no: i.challan_no,
      type: i.doc_type,
      isChallan: challan,
      date: i.date,
      createdAt: i.created_at,
      dueDate: i.due_date || "",
      voided: !!i.voided,
      paymentMethod: i.payment_method || "",
      /* Where a challan was later turned into a bill, and vice versa. */
      convertedInvoiceId: i.converted_invoice_id || "",
    },

    customer: {
      id: i.customer_id || "",
      name: i.customer_name || "",
      phone: i.customer_phone || "",
      gst: i.customer_gst || "",
      address: i.customer_address || "",
    },

    /* Every figure the document itself carries, so the panel never has
       to re-derive one and get it slightly different from the paper. */
    money: challan ? null : {
      subtotal: round2(i.subtotal || 0),
      discount: round2(i.discount_amount || 0),
      cgst: round2(i.cgst || 0),
      sgst: round2(i.sgst || 0),
      igst: round2(i.igst || 0),
      taxType: i.tax_type || "",
      transport: round2(i.transport || 0),
      loading: round2(i.loading || 0),
      roundOff: round2(i.round_off || 0),
      total: round2(i.total || 0),
      advance: round2(i.advance || 0),
      balanceDue: round2(i.balance_due || 0),
    },

    goodsValue: round2(goodsValue),

    items: items.map(it => ({
      id: it.id,
      name: it.name,
      size: it.size_label || "",
      brand: it.brand || "",
      hsn: it.hsn_code || "",
      pieces: it.pieces,
      qty: round2(it.qty || 0),
      unit: it.unit_label || "",
      rate: round2(it.rate || 0),
      gstRate: it.gst_rate,
      discountPct: it.discount_pct || 0,
      /* The line's own worth, the same arithmetic the document used. */
      value: round2(it.qty * it.rate * (1 - (it.discount_pct || 0) / 100)),
    })),

    payments: payments.map(p => ({
      id: p.id, amount: round2(p.amount || 0), method: p.method || "",
      reference: p.reference_no || "",
      date: p.payment_date || localDate(p.created_at),
    })),

    returns: returns.map(r => ({
      id: r.id, no: r.return_no, date: r.date,
      total: round2(r.total || 0), reason: r.reason || "",
    })),
  };
}

/* ==================================================================
   THE SALES VIEW

   Figures over a window, with the window stated rather than assumed.
   ================================================================== */
function summary(opts) {
  const o = opts || {};
  const to = String(o.to || todayStr());
  const from = String(o.from || daysAgo(29));

  const one = (sql, params) => {
    try { const r = db.prepare(sql).get(...(params || [])); return r ? r.v : null; }
    catch (e) { return null; }
  };
  const many = (sql, params) => {
    try { return db.prepare(sql).all(...(params || [])); } catch (e) { return []; }
  };

  const WINDOW = `${SALE} AND i.date >= ? AND i.date <= ?`;
  const w = [from, to];

  const money = one(`SELECT COALESCE(SUM(i.total),0) AS v FROM invoices i WHERE ${WINDOW}`, w);
  const bills = one(`SELECT COUNT(*) AS v FROM invoices i WHERE ${WINDOW}`, w);
  const customersBilled = one(
    `SELECT COUNT(DISTINCT i.customer_id) AS v FROM invoices i
      WHERE ${WINDOW} AND i.customer_id IS NOT NULL`, w);

  const tax = db.prepare(`
    SELECT COALESCE(SUM(i.cgst),0) AS cgst, COALESCE(SUM(i.sgst),0) AS sgst,
           COALESCE(SUM(i.igst),0) AS igst, COALESCE(SUM(i.discount_amount),0) AS discount
      FROM invoices i WHERE ${WINDOW}`).get(...w);

  /* The same window immediately before, for a comparison that is a
     comparison rather than a guess. */
  const spanDays = Math.max(1, Math.round(
    (Date.parse(to + "T00:00:00") - Date.parse(from + "T00:00:00")) / 86400000) + 1);
  const prevTo = localDate(new Date(Date.parse(from + "T00:00:00") - 86400000));
  const prevFrom = localDate(new Date(Date.parse(from + "T00:00:00") - spanDays * 86400000));
  const prevMoney = one(
    `SELECT COALESCE(SUM(i.total),0) AS v FROM invoices i WHERE ${SALE} AND i.date >= ? AND i.date <= ?`,
    [prevFrom, prevTo]);

  const byDay = many(`
    SELECT i.date, COALESCE(SUM(i.total),0) AS total, COUNT(*) AS bills
      FROM invoices i WHERE ${WINDOW} GROUP BY i.date ORDER BY i.date ASC`, w)
    .map(r => ({ date: r.date, total: round2(r.total), bills: r.bills }));

  const topProducts = many(`
    SELECT ii.name,
           SUM(ii.pieces) AS units,
           COALESCE(SUM(ii.qty * ii.rate * (1 - COALESCE(ii.discount_pct,0)/100.0)),0) AS value
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ${WINDOW}
     GROUP BY ii.name ORDER BY value DESC LIMIT 8`, w)
    .map(r => ({ name: r.name, units: round2(r.units || 0), value: round2(r.value) }));

  const topCustomers = many(`
    SELECT c.id, c.name, COUNT(*) AS bills, COALESCE(SUM(i.total),0) AS value
      FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE ${WINDOW}
     GROUP BY c.id ORDER BY value DESC LIMIT 8`, w)
    .map(r => ({ id: r.id, name: r.name, bills: r.bills, value: round2(r.value) }));

  const byMethod = many(`
    SELECT COALESCE(NULLIF(TRIM(i.payment_method), ''), 'Not recorded') AS method,
           COUNT(*) AS bills, COALESCE(SUM(i.total),0) AS value
      FROM invoices i WHERE ${WINDOW}
     GROUP BY method ORDER BY value DESC`, w)
    .map(r => ({ method: r.method, bills: r.bills, value: round2(r.value) }));

  /* Goods out on a challan in this window that nobody has billed. Not a
     sale, never counted as one, and exactly the thing an owner wants to
     be told about. */
  const unbilled = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM((SELECT COALESCE(SUM(ii.qty * ii.rate * (1 - COALESCE(ii.discount_pct,0)/100.0)),0)
                           FROM invoice_items ii WHERE ii.invoice_id = i.id)), 0) AS worth
      FROM invoices i
     WHERE i.doc_type = 'challan' AND i.voided = 0 AND i.converted_invoice_id IS NULL
       AND i.date >= ? AND i.date <= ?`).get(from, to);

  let returned = { n: 0, value: 0 };
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS value
        FROM sales_returns WHERE voided = 0 AND date >= ? AND date <= ?`).get(from, to);
    returned = { n: r.n, value: round2(r.value) };
  } catch (e) { returned = null; }

  const voided = db.prepare(`
    SELECT COUNT(*) AS n FROM invoices i
     WHERE i.voided = 1 AND i.doc_type = 'invoice' AND i.date >= ? AND i.date <= ?`)
    .get(from, to).n;

  return {
    window: { from, to, days: spanDays },
    previousWindow: { from: prevFrom, to: prevTo },

    money: round2(money || 0),
    bills: bills || 0,
    customersBilled: customersBilled || 0,
    averageBill: bills ? round2(money / bills) : null,

    previousMoney: round2(prevMoney || 0),
    change: prevMoney ? round2(((money - prevMoney) / prevMoney) * 100) : null,

    tax: {
      cgst: round2(tax.cgst), sgst: round2(tax.sgst), igst: round2(tax.igst),
      total: round2(tax.cgst + tax.sgst + tax.igst),
      discount: round2(tax.discount),
    },

    unbilledChallans: { count: unbilled.n, worth: round2(unbilled.worth) },
    returns: returned,
    voidedBills: voided,

    byDay, topProducts, topCustomers, byMethod,

    /* So the browser can tell "a quiet month" from "a new shop". */
    hasAnySales: (one(`SELECT COUNT(*) AS v FROM invoices i WHERE ${SALE}`) || 0) > 0,
  };
}

module.exports = {
  PAGE_SIZE, MAX_PAGE_SIZE, TYPES, STATUSES, SORTS,
  describeOptions, documents, document, summary, likeTerm,
};
