/* ============================================================
   ADMIN DASHBOARD — the figures, and where each one comes from

   THE RULE THIS FILE IS WRITTEN TO: a number on this screen is either
   read out of the books or it is not shown. There is no sample data, no
   placeholder total, and no metric that is "roughly" something. Where
   the shop's records cannot answer a question, the section says so and
   says why — see the `unavailable()` shape below, which is what the
   browser draws an empty state from.

   Two metrics the brief asked for cannot be answered, and both are
   reported as unavailable rather than guessed at:

     FAILED PAYMENTS. The payments table records what was taken —
     id, customer, amount, method, reference, date, voided. There is
     no status column and no gateway: a payment that failed was never
     entered, so the shop has no record of it to count. Nothing here
     invents one. (A voided payment is a different thing — a reversal
     of money that WAS taken — and is counted separately.)

     INVENTORY VALUE. products.stock mixes units: boards sold by the
     square foot and handles sold by the piece sit in the same column,
     and only product_sizes.cost_price knows what either is worth.
     A single "total stock" figure would be the sum of square feet and
     pieces, which is not a quantity of anything.

   LOW STOCK is real here, and deliberately not the shop dashboard's
   rule. That screen uses `p.stock < 15` — one hard-coded number for a
   shop that sells both plywood sheets and screws. This reads the
   min_stock actually configured per size and location (inventory.js
   setMinStock), counts only rows where somebody has set one, and when
   nobody has, says the feature needs thresholds configured rather than
   reporting a confident zero.

   EVERY FIGURE IS AGGREGATED IN SQL. The shop dashboard does
   `SELECT * FROM customers` and sums in JavaScript, which is fine at a
   few hundred rows and is not what this screen should grow into. Here
   COUNT and SUM happen in SQLite and only the answer crosses.

   NOTHING IN THIS FILE WRITES. No INSERT, no UPDATE, no DELETE. It is
   a read-only view of the books.
   ============================================================ */
const db = require("./db");
const { todayStr, localDate, round2 } = require("./util");

/* ------------------------------------------------------------------
   SHAPES

   Every section returns one of these, so the browser never has to guess
   whether a zero means "none" or "could not tell".
   ------------------------------------------------------------------ */

/** A figure the books can answer. */
const value = (v) => ({ available: true, value: v });

/** A figure they cannot, and the reason a person would accept. */
const unavailable = (reason, needs) => ({ available: false, reason, needs: needs || "" });

/* ------------------------------------------------------------------
   DATES

   todayStr/localDate are the app's own, and the comment on them in
   util.js explains why: a bill written at 1am was landing on the
   previous day — and at a month boundary, in the previous GST period —
   when UTC was used. Everything below is anchored to local midnight so
   it agrees with the `date` columns it compares against.
   ------------------------------------------------------------------ */

/** Local midnight, as epoch ms — for the created_at columns. */
function midnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function periods() {
  const now = new Date();
  const today = todayStr();

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  return {
    today,
    yesterday: localDate(dayOffset(-1)),

    /* "This week" is the last seven days INCLUDING today, not a calendar
       week — a shop comparing Tuesday to Tuesday wants the last seven
       trading days, and a calendar week makes Monday look catastrophic. */
    weekFrom: localDate(dayOffset(-6)),
    prevWeekFrom: localDate(dayOffset(-13)),
    prevWeekTo: localDate(dayOffset(-7)),

    monthFrom: localDate(monthStart),
    monthStartMs: midnight(monthStart),
    prevMonthFrom: localDate(prevMonthStart),
    prevMonthTo: localDate(prevMonthEnd),

    /* For "has this customer bought from us lately". Ninety days is
       stated on the screen; it is not a hidden assumption. */
    activeSinceDays: 90,
    activeSince: localDate(dayOffset(-90)),
  };
}

/* ------------------------------------------------------------------
   SMALL QUERY HELPERS

   one() returns a single scalar and never throws for a column or table
   this copy of the schema has not got — an older database should give a
   quiet "unavailable", not a 500 that takes the whole screen down.
   ------------------------------------------------------------------ */
function one(sql, params, field) {
  try {
    const row = db.prepare(sql).get(...(params || []));
    return row ? row[field || "v"] : null;
  } catch (e) {
    return null;
  }
}

function many(sql, params) {
  try {
    return db.prepare(sql).all(...(params || []));
  } catch (e) {
    return null;
  }
}

/** A figure, or an unavailable with the reason spelled out. */
function figure(n, reason) {
  return n === null || n === undefined
    ? unavailable(reason || "This copy's records cannot answer that yet.")
    : value(n);
}

/** Percentage change, or null when the base is zero (not "100% up"). */
function change(now, before) {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return round2(((now - before) / before) * 100);
}

/* Priced tax invoices only, everywhere money is counted. A delivery
   challan carries goods but no rates, GST or total — counting one as a
   sale would inflate every figure on this screen. The shop dashboard
   makes the same distinction and says so for the same reason. */
const SALE = "voided = 0 AND doc_type = 'invoice'";

function salesBetween(from, to) {
  return one(
    `SELECT COALESCE(SUM(total), 0) AS v FROM invoices
      WHERE ${SALE} AND date >= ? AND date <= ?`, [from, to]);
}

function salesOn(day) {
  return one(
    `SELECT COALESCE(SUM(total), 0) AS v FROM invoices
      WHERE ${SALE} AND date = ?`, [day]);
}

function countBetween(from, to) {
  return one(
    `SELECT COUNT(*) AS v FROM invoices
      WHERE ${SALE} AND date >= ? AND date <= ?`, [from, to]);
}

/* ==================================================================
   A.  OVERVIEW — the headline row
   ================================================================== */
function overview() {
  const p = periods();

  return {
    asOf: p.today,
    customers: figure(one("SELECT COUNT(*) AS v FROM customers")),
    products: figure(one("SELECT COUNT(*) AS v FROM products WHERE COALESCE(active, 1) = 1")),
    todaysSales: figure(salesOn(p.today)),
    monthSales: figure(salesBetween(p.monthFrom, p.today)),
    outstanding: figure(one("SELECT COALESCE(SUM(due), 0) AS v FROM customers WHERE due > 0")),
    invoices: figure(one(`SELECT COUNT(*) AS v FROM invoices WHERE ${SALE}`)),
    /* Staff who may log in — the nearest honest reading of "active
       users" in a shop app where there are no accounts, only staff. */
    activeUsers: figure(one("SELECT COUNT(*) AS v FROM staff WHERE active = 1")),
  };
}

/* ==================================================================
   B / C.  SALES
   ================================================================== */
function sales() {
  const p = periods();

  const today = salesOn(p.today);
  const yesterday = salesOn(p.yesterday);
  const week = salesBetween(p.weekFrom, p.today);
  const prevWeek = salesBetween(p.prevWeekFrom, p.prevWeekTo);
  const month = salesBetween(p.monthFrom, p.today);
  const prevMonth = salesBetween(p.prevMonthFrom, p.prevMonthTo);

  /* Fourteen days of real daily totals, for the chart. One grouped
     query rather than fourteen — the shop dashboard runs its seven-day
     strip as seven separate round trips, which is the thing section 11
     of the brief asks not to grow. Days with no trade are filled in as
     zero here so the chart has no gaps. */
  const rows = many(
    `SELECT date, COALESCE(SUM(total), 0) AS total, COUNT(*) AS bills
       FROM invoices
      WHERE ${SALE} AND date >= ? AND date <= ?
      GROUP BY date`, [localDate(dayOffset(-13)), p.today]) || [];
  const byDay = new Map(rows.map(r => [r.date, r]));
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = dayOffset(-i);
    const key = localDate(d);
    const hit = byDay.get(key);
    series.push({
      date: key,
      label: d.toLocaleDateString("en-IN", { weekday: "short" }),
      day: d.getDate(),
      total: hit ? round2(hit.total) : 0,
      bills: hit ? hit.bills : 0,
    });
  }

  const everTraded = one(`SELECT COUNT(*) AS v FROM invoices WHERE ${SALE}`);

  return {
    /* So the browser can tell "a quiet fortnight" from "a new shop" and
       draw the right empty state for each. */
    hasAnySales: everTraded !== null && everTraded > 0,

    today: figure(today),
    yesterday: figure(yesterday),
    week: figure(week),
    month: figure(month),

    vsYesterday: change(today, yesterday),
    vsPrevWeek: change(week, prevWeek),
    vsPrevMonth: change(month, prevMonth),

    prevWeek: figure(prevWeek),
    prevMonth: figure(prevMonth),

    billsToday: figure(countBetween(p.today, p.today)),
    billsMonth: figure(countBetween(p.monthFrom, p.today)),

    /* Goods that left on a challan and have not been billed. Not a sale
       and never counted as one, but the owner wants to know it is there. */
    openChallans: figure(one(
      `SELECT COUNT(*) AS v FROM invoices
        WHERE doc_type = 'challan' AND voided = 0
          AND converted_invoice_id IS NULL`)),

    series,
    /* Raw ISO bounds, not a pre-joined sentence. Formatting a date for a
       person is the browser's job — it is the side that knows the
       reader's locale, and the shop app already shows a stored date as
       "7 Oct 2026" everywhere else. */
    periodLabels: {
      weekFrom: p.weekFrom, weekTo: p.today,
      monthFrom: p.monthFrom, monthTo: p.today,
      prevMonthFrom: p.prevMonthFrom, prevMonthTo: p.prevMonthTo,
    },
  };
}

/* ==================================================================
   D.  CUSTOMERS
   ================================================================== */
function customers() {
  const p = periods();

  return {
    total: figure(one("SELECT COUNT(*) AS v FROM customers")),

    /* Two different questions, and conflating them is how a dashboard
       starts lying. "On the books" is the active flag; "buying" is
       whether they have actually been billed lately. */
    onBooks: figure(one("SELECT COUNT(*) AS v FROM customers WHERE COALESCE(active, 1) = 1")),
    buying: figure(one(
      `SELECT COUNT(DISTINCT customer_id) AS v FROM invoices
        WHERE ${SALE} AND customer_id IS NOT NULL AND date >= ?`, [p.activeSince])),
    buyingWindowDays: p.activeSinceDays,

    newThisMonth: figure(one(
      "SELECT COUNT(*) AS v FROM customers WHERE created_at >= ?", [p.monthStartMs])),

    owing: figure(one("SELECT COUNT(*) AS v FROM customers WHERE due > 0")),
    owedTotal: figure(one("SELECT COALESCE(SUM(due), 0) AS v FROM customers WHERE due > 0")),

    /* Over their agreed limit. Only counted where a limit was actually
       set — a credit_limit of 0 means "none agreed", not "zero allowed". */
    overLimit: figure(one(
      "SELECT COUNT(*) AS v FROM customers WHERE credit_limit > 0 AND due > credit_limit")),

    recent: (many(
      `SELECT id, name, type, created_at, due
         FROM customers ORDER BY created_at DESC LIMIT 5`) || [])
      .map(c => ({
        id: c.id, name: c.name, type: c.type || "",
        added: localDate(c.created_at), due: round2(c.due || 0),
      })),
  };
}

/* ==================================================================
   E.  INVENTORY
   ================================================================== */
function inventory() {
  const products = one("SELECT COUNT(*) AS v FROM products WHERE COALESCE(active, 1) = 1");
  const sizes = one("SELECT COUNT(*) AS v FROM product_sizes");
  const outOfStock = one("SELECT COUNT(*) AS v FROM product_sizes WHERE COALESCE(stock, 0) <= 0");

  /* The configured thresholds. If nobody has set one, there is no low
     stock rule to apply and this screen says exactly that instead of
     inventing a number the way the shop dashboard's `stock < 15` does. */
  const thresholds = one(
    "SELECT COUNT(*) AS v FROM size_location_stock WHERE COALESCE(min_stock, 0) > 0");

  let low;
  if (thresholds === null) {
    low = unavailable("This copy does not have per-location stock levels.",
                      "the Locations and Transfer Stock module");
  } else if (thresholds === 0) {
    low = unavailable("No minimum stock levels have been set yet.",
                      "a minimum level on at least one product size, under Inventory");
  } else {
    low = value(one(
      `SELECT COUNT(DISTINCT size_id) AS v FROM size_location_stock
        WHERE COALESCE(min_stock, 0) > 0 AND quantity <= min_stock`));
  }

  return {
    products: figure(products),
    sizes: figure(sizes),
    outOfStock: figure(outOfStock),
    lowStock: low,
    thresholdsSet: figure(thresholds),

    /* Deliberately absent: a single "total stock" or "stock value".
       products.stock mixes square feet with pieces, so summing it
       produces a number that is not a quantity of anything. */
    stockValue: unavailable(
      "Stock is counted in different units per product — square feet for board, pieces for hardware — so there is no single total.",
      "a costing rule that says how to value each unit"),

    recent: (many(
      `SELECT at, movement, qty, ref_type, ref_no, staff,
              COALESCE(product_id, '') AS product_id
         FROM stock_ledger ORDER BY at DESC LIMIT 6`) || [])
      .map(r => ({
        at: r.at, when: localDate(r.at),
        movement: r.movement || "", qty: r.qty,
        ref: [r.ref_type, r.ref_no].filter(Boolean).join(" "),
        staff: r.staff || "",
      })),
  };
}

/* ==================================================================
   F.  PAYMENTS AND REVENUE

   Reads the existing payments table. It does not touch how a payment is
   taken, recorded or reversed — the Payments module comes later.
   ================================================================== */
function paymentsSummary() {
  const p = periods();
  const monthMs = p.monthStartMs;
  const todayMs = midnight(new Date());

  /* Counted by when the payment was ENTERED (created_at), because that
     is the one column every row has — payment_date arrived later and is
     empty on older entries, so a date filter on it would silently drop
     exactly the history this screen is meant to show. Labelled
     "recorded" on screen so the figure is not mistaken for a banking
     date. */
  const takenToday = one(
    "SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE voided = 0 AND created_at >= ?",
    [todayMs]);
  const takenMonth = one(
    "SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE voided = 0 AND created_at >= ?",
    [monthMs]);
  const countMonth = one(
    "SELECT COUNT(*) AS v FROM payments WHERE voided = 0 AND created_at >= ?", [monthMs]);
  const reversedMonth = one(
    "SELECT COUNT(*) AS v FROM payments WHERE voided = 1 AND created_at >= ?", [monthMs]);

  return {
    takenToday: figure(takenToday),
    takenMonth: figure(takenMonth),
    countMonth: figure(countMonth),

    /* A reversal of money that WAS taken. This is NOT a failed payment —
       see the note at the top of this file. */
    reversedMonth: figure(reversedMonth),

    failed: unavailable(
      "A payment that failed was never entered, so the shop has no record of one to count.",
      "a payment gateway or a status on each payment"),

    outstanding: figure(one("SELECT COALESCE(SUM(due), 0) AS v FROM customers WHERE due > 0")),
    payable: figure(one("SELECT COALESCE(SUM(due), 0) AS v FROM suppliers WHERE due > 0")),

    byMethod: (many(
      `SELECT method, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
         FROM payments WHERE voided = 0 AND created_at >= ?
        GROUP BY method ORDER BY total DESC`, [monthMs]) || [])
      .map(r => ({ method: r.method || "—", n: r.n, total: round2(r.total) })),

    recent: (many(
      `SELECT p.id, p.amount, p.method, p.created_at, c.name AS customer
         FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.voided = 0 ORDER BY p.created_at DESC LIMIT 5`) || [])
      .map(r => ({
        id: r.id, amount: round2(r.amount), method: r.method || "",
        customer: r.customer || "—", when: localDate(r.created_at),
      })),
  };
}

/* ==================================================================
   G.  ALERTS AND ISSUES

   NOT a second alert engine. routes/alerts.js already works the shop's
   reminders out of live data — unbilled challans, overdue money either
   way, cheques to watch, deliveries still out, products at zero, the
   backup store filling up — and it respects what the owner has
   dismissed. That function is now shared rather than copied, so a rule
   added there appears here with no further work and the two screens
   cannot drift into disagreeing.

   The dashboard shows a COUNT per group and leaves the lists to the
   Reminders screen: this is a glance, not a worklist, and sending up to
   fifty rows per group to draw seven numbers is the kind of thing
   section 11 of the brief asks not to do.

   FUTURE AI AND SECURITY ALERTS plug in at the same seam — another
   `add(key, title, tone, items)` inside buildAlerts — and arrive here
   automatically. Neither is built now.
   ================================================================== */
function alerts(req) {
  let built;
  try {
    built = require("./routes/alerts").buildAlerts(req);
  } catch (e) {
    return { available: false, reason: "Reminders could not be worked out.", groups: [], total: 0 };
  }

  const WORST = { bad: 3, warn: 2, info: 1 };
  const groups = (built.groups || []).map(g => ({
    key: g.key, title: g.title, tone: g.tone, count: g.count,
  }));

  return {
    available: true,
    total: built.total || 0,
    groups,
    /* The loudest tone present, so the panel can lead with the right
       colour without the browser ranking tones itself. */
    worst: groups.reduce((w, g) => (WORST[g.tone] || 0) > (WORST[w] || 0) ? g.tone : w, "info"),
    generatedAt: built.generatedAt,
  };
}

/* ==================================================================
   H.  RECENT ACTIVITY

   The audit log, which this app has had all along — so this is a real
   feed, not a placeholder waiting for an event system to be built.
   Reads only; writing to the audit log stays with logAction().
   ================================================================== */
function activity() {
  const rows = many(
    `SELECT at, staff_name, role, action, details
       FROM audit_log ORDER BY at DESC LIMIT 12`);

  if (rows === null) {
    return { available: false,
             reason: "This copy has no audit log table.",
             entries: [] };
  }

  return {
    available: true,
    entries: rows.map(r => ({
      at: r.at,
      when: localDate(r.at),
      time: new Date(r.at).toLocaleTimeString("en-IN",
        { hour: "2-digit", minute: "2-digit" }),
      who: r.staff_name || "—",
      role: r.role || "",
      action: r.action || "",
      /* Trimmed, because a details string can be long and the panel
         shows one line. The full entry lives in Audit Logs. */
      details: String(r.details || "").slice(0, 160),
    })),
    total: one("SELECT COUNT(*) AS v FROM audit_log"),
  };
}

/* ==================================================================
   H.  SYSTEM STATUS

   A health indicator, and nothing more. No path, no credential, no
   connection string, no stack trace — see the note in routes/admin.js
   about what must never cross this boundary.
   ================================================================== */
function system() {
  let database = { ok: false, detail: "Not reachable." };
  try {
    db.prepare("SELECT 1 AS v").get();
    const mode = one("PRAGMA journal_mode", [], "journal_mode");
    database = { ok: true, detail: mode ? "Connected (" + mode + ")" : "Connected" };
  } catch (e) {
    /* The reason is deliberately NOT passed through: a SQLite error can
       name a file path. The panel says it is down; the log says why. */
    database = { ok: false, detail: "Not reachable." };
  }

  const backupAt = one("SELECT MAX(at) AS v FROM audit_log WHERE action LIKE 'backup%'");

  let sync = { configured: false, lastAt: 0, lastOk: false };
  try {
    const s = db.prepare(
      "SELECT sync_cloud_url, sync_cloud_key, sync_last_at, sync_last_ok FROM settings WHERE id = 1").get();
    if (s) {
      sync = {
        /* Whether an address is set — never the address, and never the key. */
        configured: !!(s.sync_cloud_url && s.sync_cloud_key),
        lastAt: s.sync_last_at || 0,
        lastOk: !!s.sync_last_ok,
      };
    }
  } catch (e) { /* older schema, before sync existed */ }

  return {
    app: { ok: true, detail: "Running" },
    database,
    /* Whole seconds. The exact process start time is of no use to anyone
       looking at this screen and is one more thing to leak. */
    uptimeSeconds: Math.floor(process.uptime()),
    lastBackupAt: backupAt || 0,
    sync,
  };
}

/* ==================================================================
   THE SECTION TABLE

   One place that says what a section is called, which capability it
   needs, and how to build it. The route walks this; it does not hold a
   list of its own.
   ================================================================== */
const SECTIONS = {
  overview:  { cap: "business.view", build: overview },
  sales:     { cap: "business.view", build: sales },
  customers: { cap: "business.view", build: customers },
  inventory: { cap: "business.view", build: inventory },
  payments:  { cap: "business.view", build: paymentsSummary },
  alerts:    { cap: "business.view", build: alerts },
  /* The audit log and the health of the box are not business figures;
     a support login that may see sales has no reason to read either. */
  activity:  { cap: "security.view", build: activity },
  system:    { cap: "security.view", build: system },
};

module.exports = {
  SECTIONS,
  overview, sales, customers, inventory,
  payments: paymentsSummary, alerts, activity, system,
  periods, value, unavailable,
};
