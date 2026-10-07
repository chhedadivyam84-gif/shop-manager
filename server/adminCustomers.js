/* ============================================================
   ADMIN CUSTOMERS — reading the customer book, not keeping one

   THERE IS NO SECOND CUSTOMER DATABASE HERE. Every row below comes out
   of the same `customers`, `invoices`, `payments` and
   `customer_opening_balances` tables the counter writes to all day, and
   nothing in this file copies a transaction anywhere. The shop's
   records stay the only source of truth; this is a reading room.

   WRITES GO THROUGH THE SHOP'S OWN HANDLERS. Editing a customer and
   switching one off are not reimplemented here — routes/admin.js calls
   the very functions routes/customers.js uses, so an admin edit gets
   the same validation, the same audit entry and the same careful
   treatment of a blank WhatsApp number that clears a value rather than
   being read as "not supplied". One engine, two front doors.

   WHAT THIS SHOP DOES NOT RECORD, and is therefore not shown:

     EMAIL. There is no email column on customers, anywhere in the
     schema. A shop like this reaches a customer on a phone and on
     WhatsApp. An empty "Email —" on every row would be a field that
     looks broken rather than absent, so it is not drawn at all.

     A SEPARATE COMPANY NAME. `name` IS the business name for a dealer
     and the person's name for a walk-in; `type` is what tells them
     apart, and `gst` carries the GSTIN where there is one. Inventing a
     second "company" field would leave every existing row blank.

   PAGINATION IS NOT OPTIONAL. The shop app's own GET /api/customers
   does `SELECT * FROM customers` and sends the lot, which is fine for
   a screen that then filters in the browser and will not be fine for
   an admin panel that has to stay usable as the book grows. Every list
   query below is LIMIT/OFFSET with the search and the filter applied
   in SQL.

   ONE PASS, NOT N+1. Totals, bill counts and last-sale dates come from
   a single grouped join over invoices rather than a query per customer.
   ============================================================ */
const db = require("./db");
const { localDate, round2 } = require("./util");

/* How many rows a page holds. Small enough to stay quick on a phone
   over a shop's broadband, large enough that scrolling is rare. */
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/* Windows the filters below are defined in terms of. Both are stated on
   screen rather than being hidden rules — "recent" means something
   different to every shop, and a filter whose meaning is a secret is
   worse than no filter. */
const NEW_DAYS = 30;
const DORMANT_DAYS = 90;

function daysAgoMs(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysAgoDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
}

/* ------------------------------------------------------------------
   SEARCH

   LIKE with an explicit ESCAPE. Without it a customer searching for
   "50%" matches every row, and an underscore matches any character —
   not a security hole here, but a search box that quietly lies about
   what it found.
   ------------------------------------------------------------------ */
function likeTerm(q) {
  return "%" + String(q).replace(/[\\%_]/g, c => "\\" + c) + "%";
}

/* Priced tax invoices only, as everywhere else money is counted: a
   delivery challan carries goods but no rates, GST or total. */
const SALE = "voided = 0 AND doc_type = 'invoice'";

/* The per-customer sales summary, as ONE grouped pass over invoices
   rather than a correlated subquery that would run once per row. */
const SUMMARY_JOIN = `
  LEFT JOIN (
    SELECT customer_id,
           COUNT(*)              AS bills,
           COALESCE(SUM(total),0) AS sales,
           MAX(date)             AS last_date
      FROM invoices
     WHERE ${SALE} AND customer_id IS NOT NULL
     GROUP BY customer_id
  ) s ON s.customer_id = c.id`;

/* ------------------------------------------------------------------
   FILTERS

   Only what the records can actually answer. There is no "churn risk"
   and no "VIP" here, because nothing in this database knows either.
   ------------------------------------------------------------------ */
const FILTERS = {
  all:       { label: "All customers",        where: null },
  active:    { label: "Active",               where: "COALESCE(c.active, 1) = 1" },
  inactive:  { label: "Switched off",         where: "COALESCE(c.active, 1) = 0" },
  owing:     { label: "Owing money",          where: "c.due > 0" },
  new:       { label: "Added recently",       where: "c.created_at >= :newSince" },
  dormant:   { label: "No sale recently",     where: "(s.last_date IS NULL OR s.last_date < :dormantBefore)" },
  /* Only where a limit was actually agreed: credit_limit 0 means "none
     set", not "nothing allowed". */
  overlimit: { label: "Over credit limit",    where: "c.credit_limit > 0 AND c.due > c.credit_limit" },
};

const SORTS = {
  name:     { label: "Name",          sql: "c.name COLLATE NOCASE ASC" },
  due:      { label: "Owes most",     sql: "c.due DESC, c.name COLLATE NOCASE ASC" },
  sales:    { label: "Buys most",     sql: "COALESCE(s.sales,0) DESC, c.name COLLATE NOCASE ASC" },
  recent:   { label: "Newest",        sql: "c.created_at DESC" },
  activity: { label: "Last sale",     sql: "s.last_date DESC NULLS LAST, c.name COLLATE NOCASE ASC" },
};

function describeOptions() {
  return {
    filters: Object.keys(FILTERS).map(k => ({ key: k, label: FILTERS[k].label })),
    sorts: Object.keys(SORTS).map(k => ({ key: k, label: SORTS[k].label })),
    windows: { newDays: NEW_DAYS, dormantDays: DORMANT_DAYS },
    pageSize: PAGE_SIZE,
  };
}

/* ------------------------------------------------------------------
   THE LIST
   ------------------------------------------------------------------ */
function list(opts) {
  const o = opts || {};
  const q = String(o.q || "").trim();
  const filter = Object.prototype.hasOwnProperty.call(FILTERS, o.filter) ? o.filter : "all";
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "name";

  const size = Math.min(Math.max(Number(o.pageSize) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(o.page) || 1, 1);

  const where = [];
  const params = [];

  if (q) {
    /* The fields this shop actually holds. No email: there is no column
       for one. The id is matched too, so pasting a customer id from a
       document finds the customer. */
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\'" +
               " OR c.whatsapp LIKE ? ESCAPE '\\' OR c.gst LIKE ? ESCAPE '\\'" +
               " OR c.id LIKE ? ESCAPE '\\')");
    const t = likeTerm(q);
    params.push(t, t, t, t, t);
  }

  const f = FILTERS[filter];
  if (f.where) {
    let clause = f.where;
    if (clause.includes(":newSince")) {
      clause = clause.replace(":newSince", "?");
      params.push(daysAgoMs(NEW_DAYS));
    }
    if (clause.includes(":dormantBefore")) {
      clause = clause.replace(":dormantBefore", "?");
      params.push(daysAgoDate(DORMANT_DAYS));
    }
    where.push(clause);
  }

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM customers c ${SUMMARY_JOIN}${whereSql}`).get(...params).n;

  const pages = Math.max(Math.ceil(total / size), 1);
  const safePage = Math.min(page, pages);

  const rows = db.prepare(`
    SELECT c.id, c.name, c.type, c.phone, c.whatsapp, c.gst, c.state,
           c.credit_limit, c.due, c.created_at, COALESCE(c.active, 1) AS active,
           COALESCE(s.bills, 0) AS bills,
           COALESCE(s.sales, 0) AS sales,
           s.last_date AS last_date
      FROM customers c ${SUMMARY_JOIN}${whereSql}
     ORDER BY ${SORTS[sort].sql}
     LIMIT ? OFFSET ?`).all(...params, size, (safePage - 1) * size);

  return {
    total,
    page: safePage,
    pages,
    pageSize: size,
    q, filter, sort,
    rows: rows.map(shapeRow),
    options: describeOptions(),
  };
}

/* What a list row looks like to the browser. Deliberately NOT the whole
   customer: an address and a PIN code are not needed to draw a list,
   and the less personal information crosses the wire the less there is
   to leak. The profile sends them when somebody actually opens one. */
function shapeRow(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type || "",
    phone: r.phone || "",
    gst: r.gst || "",
    state: r.state || "",
    active: !!r.active,
    due: round2(r.due || 0),
    creditLimit: round2(r.credit_limit || 0),
    overLimit: r.credit_limit > 0 && r.due > r.credit_limit,
    bills: r.bills,
    sales: round2(r.sales || 0),
    lastSale: r.last_date || null,
    created: localDate(r.created_at),
  };
}

/* ------------------------------------------------------------------
   ONE CUSTOMER

   Returns null for an id this company does not have, which is what
   makes changing the id in the URL useless: `db` is bound to the
   company the session is in, so another shop's customer is simply not
   there to be found. See the note on the route.
   ------------------------------------------------------------------ */
function profile(id) {
  const c = db.prepare(`
    SELECT id, name, type, phone, whatsapp, wa_contact_type, address, gst, gst_type,
           state, pin_code, credit_limit, due, created_at, COALESCE(active, 1) AS active,
           area_id, salesman
      FROM customers WHERE id = ?`).get(id);
  if (!c) return null;

  /* Aggregates, not a download of the ledger. A customer with ten
     thousand bills must cost the same to open as one with three. */
  const sales = db.prepare(`
    SELECT COUNT(*) AS bills, COALESCE(SUM(total), 0) AS total,
           MIN(date) AS first_date, MAX(date) AS last_date
      FROM invoices WHERE customer_id = ? AND ${SALE}`).get(id);

  const challans = db.prepare(`
    SELECT COUNT(*) AS n FROM invoices
     WHERE customer_id = ? AND voided = 0 AND doc_type = 'challan'`).get(id).n;

  const paid = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total, MAX(created_at) AS last_at
      FROM payments WHERE customer_id = ? AND voided = 0`).get(id);

  const opening = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN balance_type = 'Advance' THEN -amount ELSE amount END), 0) AS v
      FROM customer_opening_balances WHERE customer_id = ? AND voided = 0`).get(id).v;

  /* The most recent of each, for a glance. The complete ledger stays
     where it has always been — the customer's page in Shop Manager —
     rather than being rebuilt, and half-rebuilt, in a second place. */
  const recentInvoices = db.prepare(`
    SELECT id, challan_no, doc_type, date, total, balance_due, created_at
      FROM invoices
     WHERE customer_id = ? AND voided = 0
     ORDER BY created_at DESC LIMIT 10`).all(id);

  const recentPayments = db.prepare(`
    SELECT id, amount, method, reference_no, payment_date, created_at
      FROM payments
     WHERE customer_id = ? AND voided = 0
     ORDER BY created_at DESC LIMIT 10`).all(id);

  return {
    customer: {
      id: c.id,
      name: c.name,
      type: c.type || "",
      phone: c.phone || "",
      whatsapp: c.whatsapp || "",
      address: c.address || "",
      gst: c.gst || "",
      gstType: c.gst_type || "",
      state: c.state || "",
      pinCode: c.pin_code || "",
      salesman: c.salesman || "",
      creditLimit: round2(c.credit_limit || 0),
      due: round2(c.due || 0),
      active: !!c.active,
      created: localDate(c.created_at),
      createdAt: c.created_at,
    },

    summary: {
      bills: sales.bills,
      sales: round2(sales.total),
      challans,
      firstSale: sales.first_date || null,
      lastSale: sales.last_date || null,
      payments: paid.n,
      paid: round2(paid.total),
      lastPaymentAt: paid.last_at || 0,
      openingBalance: round2(opening),
      outstanding: round2(c.due || 0),
      overLimit: c.credit_limit > 0 && c.due > c.credit_limit,
      /* What a customer costs on average, which the shop can read off
         the two figures above anyway — stated so the panel does not do
         arithmetic of its own on numbers it was given. */
      averageBill: sales.bills ? round2(sales.total / sales.bills) : null,
    },

    recentInvoices: recentInvoices.map(i => ({
      id: i.id, no: i.challan_no, docType: i.doc_type,
      date: i.date, total: round2(i.total || 0),
      balanceDue: round2(i.balance_due || 0), at: i.created_at,
    })),

    recentPayments: recentPayments.map(p => ({
      id: p.id, amount: round2(p.amount || 0), method: p.method || "",
      reference: p.reference_no || "",
      date: p.payment_date || localDate(p.created_at), at: p.created_at,
    })),

    /* What is attached to this customer, and therefore what would be
       destroyed or orphaned by a deletion. The admin panel does not
       delete — see routes/admin.js — but it says what is there. */
    usage: {
      invoices: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?").get(id).n,
      payments: db.prepare("SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?").get(id).n,
    },

    activity: activityFor(id, c),
  };
}

/* ------------------------------------------------------------------
   ACTIVITY

   Built from the records themselves — every one of these rows carries a
   customer_id, so the link is a foreign key and not a guess.

   WHAT THIS IS NOT: the audit log. audit_log has an action and a free
   text `details`, and for a customer edit that text is the customer's
   NAME. Matching on it would attribute one customer's edits to another
   the moment two names are alike, and would lose them all the moment a
   customer is renamed. A per-entity event system would fix that, and
   this function is the single place that would then change — it is the
   seam, deliberately. Until then it reports what is certain and the
   panel says so.
   ------------------------------------------------------------------ */
function activityFor(id, customer) {
  const events = [];

  events.push({
    kind: "created",
    at: customer.created_at,
    date: localDate(customer.created_at),
    label: "Customer added",
    detail: "",
  });

  db.prepare(`
    SELECT id, challan_no, doc_type, date, total, created_at
      FROM invoices WHERE customer_id = ? AND voided = 0
     ORDER BY created_at DESC LIMIT 15`).all(id).forEach(i => {
    events.push({
      kind: i.doc_type === "challan" ? "challan" : "invoice",
      at: i.created_at,
      date: i.date,
      label: i.doc_type === "challan" ? "Delivery challan " + i.challan_no
                                      : "Invoice " + i.challan_no,
      amount: i.doc_type === "challan" ? null : round2(i.total || 0),
      detail: "",
    });
  });

  db.prepare(`
    SELECT id, amount, method, payment_date, created_at
      FROM payments WHERE customer_id = ? AND voided = 0
     ORDER BY created_at DESC LIMIT 15`).all(id).forEach(p => {
    events.push({
      kind: "payment",
      at: p.created_at,
      date: p.payment_date || localDate(p.created_at),
      label: "Payment received",
      amount: round2(p.amount || 0),
      detail: p.method || "",
    });
  });

  db.prepare(`
    SELECT id, date, amount, balance_type, remarks, created_at
      FROM customer_opening_balances WHERE customer_id = ? AND voided = 0
     ORDER BY created_at DESC LIMIT 5`).all(id).forEach(o => {
    events.push({
      kind: "opening",
      at: o.created_at,
      date: o.date,
      label: "Opening " + (o.balance_type || "balance"),
      amount: round2(o.amount || 0),
      detail: o.remarks || "",
    });
  });

  events.sort((a, b) => b.at - a.at);

  return {
    /* True once there is a per-entity event feed to read. Today the
       panel uses this to say, in one line, that what it is showing is
       the transactions rather than an edit history. */
    fromEventSystem: false,
    events: events.slice(0, 20),
  };
}

/** Does this id exist in the company this request is bound to? */
function exists(id) {
  return !!db.prepare("SELECT 1 AS v FROM customers WHERE id = ?").get(id);
}

module.exports = {
  PAGE_SIZE, MAX_PAGE_SIZE, NEW_DAYS, DORMANT_DAYS,
  FILTERS, SORTS, describeOptions,
  list, profile, activityFor, exists, likeTerm,
};
