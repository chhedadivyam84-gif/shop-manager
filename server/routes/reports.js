const express = require("express");
const db = require("../db");
const { todayStr, localDate, round2 } = require("../util");
const { buildXlsx } = require("../xlsx");
const { requireRole } = require("../auth");

const router = express.Router();

/* Reports that reveal margin. Guarded on the SERVER, not just hidden in the
   browser: a staff login can call these endpoints directly, and hiding a
   button changes nothing about what the endpoint will hand out. */
const ownerOnly = requireRole("owner");

/** Report types under /export that expose cost or margin. */
const OWNER_ONLY_TYPES = new Set(["Profit", "ProfitByInvoice", "ProfitLoss", "BalanceSheet"]);

/**
 * A product's most recent purchase cost, whichever of the two purchase
 * systems it actually came from — stock_ins (the older single-line Record
 * Stock In) or purchase_items (the newer multi-line New Purchase) — by
 * timestamp. purchase_items has no stored cost_price/gst_rate the way
 * stock_ins does, so it's computed here the same way: rate net of its own
 * line discount, per piece, GST-exclusive (transport isn't split across
 * multi-line purchases the way stock_ins folds it in for a single line).
 */
function getLatestCost(productId) {
  const fromStockIn = db.prepare(
    "SELECT cost_price, gst_rate, created_at FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(productId);
  const fromPurchase = db.prepare(`
    SELECT pi.rate, pi.discount_amount, pi.pieces, pi.gst_rate, p.created_at
    FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
    WHERE pi.product_id = ? AND p.voided = 0
    ORDER BY p.created_at DESC LIMIT 1
  `).get(productId);

  // Nothing was ever bought through the app — fall back to the cost typed on
  // the product's size alongside its opening stock. This is what makes Closing
  // Stock and Cost of Goods Sold real for a shop that entered its existing
  // stock by hand instead of raising purchase bills for goods it already had.
  // A genuine purchase always takes priority: it is the more recent, more
  // specific fact.
  if (!fromStockIn && !fromPurchase) {
    const fromSize = db.prepare(`
      SELECT MAX(ps.cost_price) AS cost, p.gst_rate
      FROM product_sizes ps JOIN products p ON p.id = ps.product_id
      WHERE ps.product_id = ? AND ps.cost_price > 0
    `).get(productId);
    if (fromSize && fromSize.cost > 0) {
      return { costPrice: fromSize.cost, gstRate: fromSize.gst_rate || 0 };
    }
    return null;
  }
  if (fromStockIn && (!fromPurchase || fromStockIn.created_at >= fromPurchase.created_at)) {
    return { costPrice: fromStockIn.cost_price, gstRate: fromStockIn.gst_rate };
  }
  const costPrice = fromPurchase.pieces > 0
    ? round2((fromPurchase.rate * fromPurchase.pieces - fromPurchase.discount_amount) / fromPurchase.pieces)
    : fromPurchase.rate;
  return { costPrice, gstRate: fromPurchase.gst_rate };
}

/**
 * Optional date range for the transaction reports, from ?from=&to= (both
 * inclusive YYYY-MM-DD). Either side may be omitted for an open-ended range;
 * omitting both means ALL TIME, which stays the default so a report keeps
 * showing full history until a period is actually picked.
 *
 * Anything that isn't a well-formed date is ignored rather than rejected —
 * a junk value must never silently narrow a report to nothing, which would
 * read as "no sales that month" instead of "bad input".
 *
 * Returns SQL fragments rather than letting each route hand-roll a WHERE,
 * because the date column differs per table (i.date, purchase_date,
 * payment_date, ...) and getting it wrong filters on the wrong thing while
 * still looking plausible.
 *
 * NOTE: only for period reports. Stock and dues are point-in-time balances —
 * "what is on the shelf / owed right now" — so a date range there would
 * produce a number that looks meaningful and isn't. Those routes take no
 * range, and the UI hides the date bar for them.
 */
function dateRange(req) {
  const clean = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  return {
    from, to,
    active: !!(from || to),
    /** ` AND <col> >= ? AND <col> <= ?` for whichever bounds were supplied.
     *  `col` may be any SQL expression, e.g. date(created_at/1000,'unixepoch'). */
    sql(col) {
      return (from ? ` AND ${col} >= ?` : "") + (to ? ` AND ${col} <= ?` : "");
    },
    /** Params matching sql(), in the same order. Call once per sql() use. */
    params() {
      const p = [];
      if (from) p.push(from);
      if (to) p.push(to);
      return p;
    }
  };
}

router.get("/dashboard", (req, res) => {
  const today = todayStr();
  // Sales figures count priced tax invoices only — a delivery challan carries no
  // money, so it must never inflate sales, best-sellers or a customer's total.
  const todaysInvoices = db.prepare("SELECT * FROM invoices WHERE date = ? AND voided = 0 AND doc_type = 'invoice'").all(today);
  const todaysSales = todaysInvoices.reduce((s, i) => s + i.total, 0);

  // Real profit: today's sold items' revenue minus each product's latest
  // purchase cost (see /profit for the full breakdown and its caveats).
  const todaysItems = db.prepare(`
    SELECT ii.product_id, ii.pieces, ii.qty*ii.rate AS revenue
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.date = ? AND i.voided = 0 AND i.doc_type = 'invoice'
  `).all(today);
  const todaysProfit = Math.round(todaysItems.reduce((s, it) => {
    const c = it.product_id ? getLatestCost(it.product_id) : null;
    return s + (it.revenue - (c ? c.costPrice * it.pieces : 0));
  }, 0));

  const customers = db.prepare("SELECT * FROM customers").all();
  const outstandingTotal = customers.reduce((s, c) => s + (c.due || 0), 0);
  const outstandingCount = customers.filter(c => c.due > 0).length;

  const suppliers = db.prepare("SELECT * FROM suppliers").all();
  const payableTotal = suppliers.reduce((s, x) => s + (x.due || 0), 0);
  const payableCount = suppliers.filter(x => x.due > 0).length;

  const products = db.prepare("SELECT * FROM products").all();
  const lowStockCount = products.filter(p => p.stock < 15).length;

  const cashBalance = round2(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS net
    FROM cash_entries WHERE voided = 0
  `).get().net);
  const bankAccountsList = db.prepare("SELECT * FROM bank_accounts WHERE active = 1").all();
  const bankBalance = round2(bankAccountsList.reduce((sum, a) => {
    const net = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS net
      FROM bank_entries WHERE bank_account_id = ? AND voided = 0
    `).get(a.id).net;
    return sum + a.opening_balance + net;
  }, 0));

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDate(d);
    const total = db.prepare("SELECT COALESCE(SUM(total),0) AS t FROM invoices WHERE date = ? AND voided = 0 AND doc_type = 'invoice'").get(key).t;
    days.push({ label: d.toLocaleDateString("en-IN", { weekday: "short" }), date: key, total });
  }

  /* `units` is a COUNT OF GOODS, so it sums pieces. Summing qty put the billed
     area there instead: two 7 x 3 doors read "42 units sold", and anything
     measured in sq.ft always out-ranked something sold by the piece. Revenue
     keeps qty x rate — money is charged per selling unit. */
  const soldRows = db.prepare(`
    SELECT ii.name, SUM(ii.pieces) AS units, SUM(ii.qty*ii.rate) AS revenue
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice' GROUP BY ii.name ORDER BY units DESC LIMIT 4
  `).all();

  const topCustomers = db.prepare(`
    SELECT c.id, c.name, c.type, COALESCE(SUM(i.total),0) AS total
    FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0 AND i.doc_type = 'invoice'
    GROUP BY c.id ORDER BY total DESC LIMIT 4
  `).all();

  /* goods_value is the worth of what is on the document, summed from the
     lines. A challan's stored `total` is transport + loading only -- by
     design, since a challan is not a demand for money -- so the goods it
     carried had no figure anywhere, and the list could only show a tag.
     This is additive: nothing about the challan's money changes, no due is
     raised, no GST is applied. It just lets the list say what went out. */
  const recentInvoices = db.prepare(`
    SELECT i.*, c.name AS customer_name,
      (SELECT COALESCE(SUM(ii.qty * ii.rate * (1 - COALESCE(ii.discount_pct,0)/100.0)),0)
         FROM invoice_items ii WHERE ii.invoice_id = i.id) AS goods_value
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 ORDER BY i.created_at DESC LIMIT 5
  `).all();

  /* Profit is the owner's business. Staff take the till, raise the bills and
     load the van; what the shop makes on each sheet is not part of that, and
     a margin figure on a shared counter screen is read by whoever walks past.

     Omitted rather than zeroed: a zero is a claim, and a wrong one. Absent is
     honest, and the browser hides the tile when it is missing. */
  const forOwner = req.session && req.session.role === "owner";

  res.json({
    todaysSales,
    ...(forOwner ? { todaysProfit } : {}),
    outstandingTotal, outstandingCount, payableTotal, payableCount, lowStockCount,
    cashBalance, bankBalance,
    revenueChart: days, bestSellers: soldRows, topCustomers, recentInvoices
  });
});

router.get("/sales-by-payment", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT payment_method AS label, COALESCE(SUM(total),0) AS value
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice'${range.sql("date")}
    GROUP BY payment_method
  `).all(...range.params());
  res.json(rows);
});

router.get("/gst", (req, res) => {
  const range = dateRange(req);
  const row = db.prepare(`
    SELECT COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(igst),0) AS igst
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice'${range.sql("date")}
  `).get(...range.params());
  res.json(row);
});

router.get("/stock-by-brand", (req, res) => {
  const rows = db.prepare(`
    SELECT brand AS label, COALESCE(SUM(stock),0) AS value FROM products GROUP BY brand
  `).all();
  res.json(rows);
});

router.get("/customer-dues", (req, res) => {
  const rows = db.prepare(`
    SELECT name AS label, due AS value FROM customers WHERE due > 0 ORDER BY due DESC
  `).all();
  res.json(rows);
});

router.get("/supplier-dues", (req, res) => {
  const rows = db.prepare(`
    SELECT name AS label, due AS value FROM suppliers WHERE due > 0 ORDER BY due DESC
  `).all();
  res.json(rows);
});

/** Per-product Shop/Warehouse/Total breakdown — the "Shop Stock" and
 *  "Warehouse Stock" report views are this same data, just read for one
 *  location's column instead of shown side by side; no need for two
 *  near-duplicate endpoints when the client can pick a column. */
router.get("/stock-by-location", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations WHERE active = 1 ORDER BY sort_order ASC").all();
  const products = db.prepare("SELECT id, name, brand, stock FROM products ORDER BY name ASC").all();
  const qtyStmt = db.prepare(`
    SELECT COALESCE(SUM(sls.quantity),0) AS q
    FROM size_location_stock sls JOIN product_sizes ps ON ps.id = sls.size_id
    WHERE ps.product_id = ? AND sls.location_id = ?
  `);
  const rows = products.map(p => ({
    label: p.name, brand: p.brand, total: p.stock,
    byLocation: locations.map(l => ({ code: l.code, name: l.name, quantity: qtyStmt.get(p.id, l.id).q }))
  }));
  res.json(rows);
});

/** Purchases in / sales out / transfers, per day, for the last 14 days —
 *  a quick read on whether stock is net growing or shrinking day to day. */
router.get("/daily-movement", (req, res) => {
  const purchaseInStmt = db.prepare(`
    SELECT COALESCE(SUM(pi.pieces),0) AS q FROM purchases p
    JOIN purchase_items pi ON pi.purchase_id = p.id WHERE p.date = ? AND p.voided = 0
  `);
  const stockInStmt = db.prepare("SELECT COALESCE(SUM(qty),0) AS q FROM stock_ins WHERE purchase_date = ?");
  const salesOutStmt = db.prepare(`
    SELECT COALESCE(SUM(ii.pieces),0) AS q FROM invoices i
    JOIN invoice_items ii ON ii.invoice_id = i.id WHERE i.date = ? AND i.voided = 0
  `);
  const transferStmt = db.prepare(`
    SELECT COALESCE(SUM(quantity),0) AS q FROM stock_transfers WHERE date(created_at/1000, 'unixepoch') = ?
  `);

  // Without a range this stays the last 14 days. With one, it walks that
  // period instead — one row per day, so the caller sees every day including
  // the empty ones rather than a list with gaps.
  //
  // Capped at 370 rows: this runs four queries PER DAY, so an "all time"
  // range on a shop with years of history would otherwise fire thousands of
  // queries to render a table nobody can read. Past the cap the most recent
  // 370 days of the range are returned.
  const MAX_DAYS = 370;
  const range = dateRange(req);
  const dayKeys = [];
  if (range.active) {
    const end = range.to ? new Date(range.to + "T00:00:00Z") : new Date();
    const start = range.from ? new Date(range.from + "T00:00:00Z") : new Date(end.getTime() - 13 * 86400000);
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      dayKeys.push(localDate(t));
    }
    if (dayKeys.length > MAX_DAYS) dayKeys.splice(0, dayKeys.length - MAX_DAYS);
  } else {
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayKeys.push(localDate(d));
    }
  }

  const days = [];
  for (const key of dayKeys) {
    const d = new Date(key + "T00:00:00Z");
    const purchasesIn = round2(purchaseInStmt.get(key).q + stockInStmt.get(key).q);
    const salesOut = round2(salesOutStmt.get(key).q);
    const transferred = round2(transferStmt.get(key).q);
    days.push({
      date: key, label: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }),
      purchasesIn, salesOut, transferred, net: round2(purchasesIn - salesOut)
    });
  }
  res.json(days);
});

/** Every supplier's total purchases — mirrors party-wise for the payable side.
 *  The range narrows the purchases counted, not the supplier list: a supplier
 *  with nothing in the period still shows, at zero, so their outstanding `due`
 *  stays visible rather than the party vanishing from the report. */
router.get("/supplier-wise", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT s.id, s.name AS label, s.due,
      COALESCE(SUM(si.grand_total),0) AS value, COUNT(si.id) AS purchases
    FROM suppliers s
    LEFT JOIN stock_ins si ON si.supplier_id = s.id${range.sql("si.purchase_date")}
    GROUP BY s.id ORDER BY value DESC
  `).all(...range.params());
  res.json(rows);
});

/** Every Sale Payment (money received from customers) — the Receipt history. */
router.get("/sale-payments", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT p.*, c.name AS customer_name FROM payments p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.voided = 0${range.sql("p.payment_date")} ORDER BY p.created_at DESC
  `).all(...range.params());
  res.json(rows);
});

/** Every Purchase Payment (money paid to suppliers) — the Payment history. */
router.get("/purchase-payments", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT pp.*, s.name AS supplier_name FROM purchase_payments pp
    JOIN suppliers s ON s.id = pp.supplier_id
    WHERE pp.voided = 0${range.sql("pp.payment_date")} ORDER BY pp.created_at DESC
  `).all(...range.params());
  res.json(rows);
});

/**
 * Every purchase entry, newest first — the Purchase Report. Two sources feed
 * this: the older single-line stock_ins (Inventory > product > Record Stock
 * In) and the newer multi-line purchases/purchase_items (New Purchase),
 * flattened to one row per product line so both look the same to this
 * report — same merge this app already does for a supplier's ledger.
 */
router.get("/purchases", (req, res) => {
  const range = dateRange(req);
  const stockInRows = db.prepare(`
    SELECT id, product_name, size_label, purchase_date, invoice_no, supplier, qty, billed_qty, mode, grand_total, created_at
    FROM stock_ins WHERE 1 = 1${range.sql("purchase_date")}
  `).all(...range.params());

  const purchaseLineRows = db.prepare(`
    SELECT pi.id, pi.name AS product_name, pi.size_label, p.date AS purchase_date, p.supplier_invoice_no AS invoice_no,
      s.name AS supplier, pi.pieces AS qty, pi.qty AS billed_qty, pi.mode, pi.rate, pi.discount_amount, pi.gst_rate, p.created_at
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0${range.sql("p.date")}
  `).all(...range.params()).map(r => {
    const taxable = round2(r.qty * r.rate - r.discount_amount);
    return { ...r, grand_total: round2(taxable + taxable * (r.gst_rate / 100)) };
  });

  const rows = [...stockInRows, ...purchaseLineRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Every Challan, newest first — Delivery Challan (sales, goods going out)
 *  and Purchase Challan (goods coming in from a supplier) merged into one
 *  list, distinguished by `type`. Neither carries GST/pricing meaning, so
 *  this shows item/piece counts and any Transport/Loading charge rather
 *  than a rupee "sale" figure. */

/**
 * Jump straight to a document by its printed number (SP0000005, SQ0000012,
 * ...) instead of hunting through the right report. Every doc-type's number
 * series has its own 2-3 letter prefix, so the prefix alone almost always
 * tells us which table to look in; if a number is mistyped and matches no
 * known prefix (or is right but doesn't exist in the expected table), every
 * series gets tried as a fallback before giving up.
 * Falls back to a customer/supplier NAME search when the query doesn't
 * match any document number series — a single match opens that party
 * directly (same one-click feel as a number match); more than one match
 * is too ambiguous to guess, so the caller is told to browse the filtered
 * Customers/Suppliers list instead.
 */
router.get("/search-number", (req, res) => {
  const raw = String(req.query.q || "").trim();
  if (!raw) return res.status(400).json({ error: "Enter a document number or name." });
  const upper = raw.toUpperCase();

  const series = [
    { prefix: "SQ", type: "quotation", table: "quotations", col: "quotation_no" },
    { prefix: "SO", type: "salesOrder", table: "sales_orders", col: "so_no" },
    { prefix: "PO", type: "purchaseOrder", table: "purchase_orders", col: "po_no" },
    { prefix: "PC", type: "purchase", table: "purchases", col: "purchase_no" },
    { prefix: "PU", type: "purchase", table: "purchases", col: "purchase_no" },
    { prefix: "PR", type: "purchaseReturn", table: "purchase_returns", col: "return_no" },
    { prefix: "SR", type: "salesReturn", table: "sales_returns", col: "return_no" },
    { prefix: "SP", type: "invoice", table: "invoices", col: "challan_no" }
  ];
  const matchedPrefix = series
    .slice().sort((a, b) => b.prefix.length - a.prefix.length)
    .find(s => upper.startsWith(s.prefix));
  const ordered = matchedPrefix ? [matchedPrefix, ...series.filter(s => s !== matchedPrefix)] : series;

  for (const s of ordered) {
    const row = db.prepare(`SELECT id FROM ${s.table} WHERE ${s.col} = ?`).get(upper);
    if (row) return res.json({ type: s.type, id: row.id, number: upper });
  }

  const like = `%${raw}%`;
  const customers = db.prepare("SELECT id, name FROM customers WHERE name LIKE ? COLLATE NOCASE").all(like);
  const suppliers = db.prepare("SELECT id, name FROM suppliers WHERE name LIKE ? COLLATE NOCASE").all(like);
  const totalMatches = customers.length + suppliers.length;

  if (totalMatches === 1) {
    return customers.length === 1
      ? res.json({ type: "customer", id: customers[0].id, name: customers[0].name })
      : res.json({ type: "supplier", id: suppliers[0].id, name: suppliers[0].name });
  }
  if (totalMatches > 1) {
    // Picks whichever side actually has matches so the fallback list isn't
    // empty — if it's a mix of both, customers wins the tie-break (the
    // Customers/Suppliers toggle only shows one side at a time).
    const partyMode = customers.length > 0 ? "customer" : "supplier";
    return res.json({ type: "nameSearch", query: raw, count: totalMatches, partyMode });
  }

  res.status(404).json({ error: `No document or party found matching "${raw}".` });
});

router.get("/challans", (req, res) => {
  const range = dateRange(req);
  const salesRows = db.prepare(`
    SELECT i.id, i.challan_no, i.date, c.name AS party_name, i.transport, i.loading, i.converted_invoice_id,
      i.ack_status, i.ack_received_at, i.ack_receiver_name,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS item_count,
      (SELECT COALESCE(SUM(pieces),0) FROM invoice_items WHERE invoice_id = i.id) AS total_pieces,
      i.created_at
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 AND i.doc_type = 'challan'${range.sql("i.date")}
  `).all(...range.params()).map(r => ({
    ...r, type: "Sales",
    status: r.converted_invoice_id ? "Billed" : "Pending",
    ackStatus: r.ack_status === "Received" ? "Received" : "Pending"
  }));
  const purchaseRows = db.prepare(`
    SELECT p.id, p.purchase_no AS challan_no, p.date, s.name AS party_name, p.transport, p.loading,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) AS item_count,
      (SELECT COALESCE(SUM(pieces),0) FROM purchase_items WHERE purchase_id = p.id) AS total_pieces,
      p.created_at
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0 AND p.doc_type = 'challan'${range.sql("p.date")}
  `).all(...range.params()).map(r => ({ ...r, type: "Purchase" }));
  const rows = [...salesRows, ...purchaseRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Every Order, newest first — Purchase Order (sent to a supplier) and
 *  Sales Order (confirmed from a customer) merged into one list,
 *  distinguished by `type`. Each keeps its own creation/edit flow and
 *  status lifecycle; this is a read-only combined view. */
router.get("/orders", (req, res) => {
  const range = dateRange(req);
  const poRows = db.prepare(`
    SELECT po.id, po.po_no AS order_no, po.date, s.name AS party_name, po.total, po.status, po.created_at
    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE 1 = 1${range.sql("po.date")}
  `).all(...range.params()).map(r => ({ ...r, type: "Purchase" }));
  const soRows = db.prepare(`
    SELECT so.id, so.so_no AS order_no, so.date, c.name AS party_name, so.total, so.status, so.created_at
    FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
    WHERE 1 = 1${range.sql("so.date")}
  `).all(...range.params()).map(r => ({ ...r, type: "Sales" }));
  // Quotations belong here too. Until now a saved quotation was reachable
  // ONLY by opening the customer it was raised for — so a walk-in quotation,
  // or one whose customer you couldn't remember, was effectively lost even
  // though the row was sitting in the database the whole time.
  const quoRows = db.prepare(`
    SELECT q.id, q.quotation_no AS order_no, q.date, c.name AS party_name, q.total, q.status, q.created_at
    FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id
    WHERE 1 = 1${range.sql("q.date")}
  `).all(...range.params()).map(r => ({ ...r, type: "Quotation" }));

  const rows = [...poRows, ...soRows, ...quoRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Every Tax Invoice, newest first — the Tax Invoice Report (one row per
 *  document, unlike /profit's per-line breakdown). */
router.get("/tax-invoices", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT i.id, i.challan_no, i.date, c.name AS customer_name, i.payment_method, i.total, i.balance_due
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
    ORDER BY i.created_at DESC
  `).all(...range.params());
  res.json(rows);
});

/** Every Purchase Bill, newest first — one row per bill, unlike /purchases'
 *  per-line breakdown. Merges the older single-line stock_ins (each row IS
 *  one bill) with the newer multi-line purchases (grouped by purchase_no),
 *  same merge /purchases already does at the line level. */
router.get("/purchase-bills", (req, res) => {
  const range = dateRange(req);
  const stockInRows = db.prepare(`
    SELECT id, invoice_no AS bill_no, purchase_date AS date, supplier AS supplier_name, grand_total, created_at, 1 AS item_count
    FROM stock_ins WHERE 1 = 1${range.sql("purchase_date")}
  `).all(...range.params()).map(r => ({ ...r, source: "stock_in" }));
  const purchaseRows = db.prepare(`
    SELECT p.id, p.purchase_no AS bill_no, p.date, s.name AS supplier_name, p.total AS grand_total, p.created_at,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) AS item_count
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0${range.sql("p.date")}
  `).all(...range.params()).map(r => ({ ...r, source: "purchase" }));
  const rows = [...stockInRows, ...purchaseRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Tax Invoice revenue grouped by salesperson (the "Salesperson" / delivery_man
 *  field entered on Billing) — invoices with none recorded fall under
 *  "Unassigned" rather than being silently dropped. */
router.get("/salesman-wise", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(delivery_man),''), 'Unassigned') AS label,
      COALESCE(SUM(total),0) AS value, COUNT(*) AS invoices
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice'${range.sql("date")}
    GROUP BY label ORDER BY value DESC
  `).all(...range.params());
  res.json(rows);
});

/** Sales grouped by brand — revenue and units, not just stock on hand. */
router.get("/brand-wise", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(p.brand,''),'(No brand)') AS label,
      SUM(ii.qty*ii.rate) AS value, SUM(ii.pieces) AS pieces, COUNT(DISTINCT ii.invoice_id) AS invoices
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    LEFT JOIN products p ON p.id = ii.product_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
    GROUP BY label ORDER BY value DESC
  `).all(...range.params());
  res.json(rows);
});

/**
 * Sales and purchases side by side, per State › City › Area.
 *
 * The whole point of asking for an area on entry, so both halves are read
 * from one endpoint and can never be filtered differently by accident.
 *
 * Documents with no area are NOT dropped. They are gathered into a single
 * "(Not recorded)" line, because an area report that quietly omits a third
 * of the turnover is worse than one that shows the gap — an owner needs to
 * know how much of the picture is missing before trusting the rest.
 */
router.get("/area-wise", (req, res) => {
  const range = dateRange(req);
  const key = a => (a ? `${a.state}|${a.city}|${a.area}` : "|||");

  const salesRows = db.prepare(`
    SELECT ar.state, ar.city, ar.area,
           COUNT(*) AS bills,
           COALESCE(SUM(i.total),0) AS value
    FROM invoices i
    LEFT JOIN areas ar ON ar.id = i.area_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
    GROUP BY ar.state, ar.city, ar.area
  `).all(...range.params());

  const purchaseRows = db.prepare(`
    SELECT ar.state, ar.city, ar.area,
           COUNT(*) AS bills,
           COALESCE(SUM(p.total),0) AS value
    FROM purchases p
    LEFT JOIN areas ar ON ar.id = p.area_id
    WHERE p.voided = 0${range.sql("p.date")}
    GROUP BY ar.state, ar.city, ar.area
  `).all(...range.params());

  const byKey = new Map();
  const slot = r => {
    const k = key(r.state ? r : null);
    if (!byKey.has(k)) {
      byKey.set(k, {
        state: r.state || "", city: r.city || "", area: r.area || "",
        label: r.state ? `${r.state} › ${r.city} › ${r.area}` : "(Not recorded)",
        salesValue: 0, salesBills: 0, purchaseValue: 0, purchaseBills: 0
      });
    }
    return byKey.get(k);
  };
  salesRows.forEach(r => { const s = slot(r); s.salesValue = round2(r.value); s.salesBills = r.bills; });
  purchaseRows.forEach(r => { const s = slot(r); s.purchaseValue = round2(r.value); s.purchaseBills = r.bills; });

  // Biggest selling area first — that is the question this report is opened
  // to answer. "(Not recorded)" sinks to the bottom whatever its size, since
  // it is a data-quality note rather than a place.
  const rows = [...byKey.values()].sort((a, b) => {
    if (!a.state !== !b.state) return a.state ? -1 : 1;
    return b.salesValue - a.salesValue;
  });

  res.json({
    rows,
    totals: {
      salesValue: round2(rows.reduce((s, r) => s + r.salesValue, 0)),
      purchaseValue: round2(rows.reduce((s, r) => s + r.purchaseValue, 0)),
      salesBills: rows.reduce((s, r) => s + r.salesBills, 0),
      purchaseBills: rows.reduce((s, r) => s + r.purchaseBills, 0),
      unrecordedSales: round2(rows.filter(r => !r.state).reduce((s, r) => s + r.salesValue, 0))
    }
  });
});

/** Every customer's total business — full list, not just the dashboard's top 4.
 *  Range goes on the JOIN, not a WHERE, so a customer with no sales in the
 *  period still appears at zero with their `due` intact — dropping them would
 *  hide money still owed. */
router.get("/party-wise", (req, res) => {
  const range = dateRange(req);
  const rows = db.prepare(`
    SELECT c.id, c.name AS label, c.type, c.due,
      COALESCE(SUM(i.total),0) AS value, COUNT(i.id) AS invoices
    FROM customers c
    LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
    GROUP BY c.id ORDER BY value DESC
  `).all(...range.params());
  res.json(rows);
});

/**
 * Party-wise Product report: every product sold to each customer, or bought
 * from each supplier, grouped so the screen can show "this party bought/
 * sold these products in these quantities" rather than just one lump total
 * per party. The purchase side merges BOTH purchase systems (stock_ins and
 * purchase_items — see getLatestCost's comment above for why both exist),
 * summed together per (supplier, product) pair so a product bought through
 * both isn't split into two confusing rows.
 */
router.get("/party-product", (req, res) => {
  const type = req.query.type === "purchases" ? "purchases" : "sales";
  const range = dateRange(req);

  if (type === "sales") {
    const rows = db.prepare(`
      SELECT COALESCE(c.id, '') AS partyId, COALESCE(c.name, 'Walk-in') AS party,
        ii.name AS product, ii.unit_label AS unit,
        SUM(ii.pieces) AS qty, SUM(ii.qty * ii.rate) AS amount
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
      GROUP BY COALESCE(c.id, ''), ii.name
    `).all(...range.params());
    return res.json(groupByParty(rows));
  }

  const fromStockIns = db.prepare(`
    SELECT COALESCE(s.id, '') AS partyId, COALESCE(s.name, 'Unknown Supplier') AS party,
      si.product_name AS product, '' AS unit, si.qty AS qty, si.qty * si.cost_price AS amount
    FROM stock_ins si LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE 1 = 1${range.sql("si.purchase_date")}
  `).all(...range.params());
  const fromPurchaseItems = db.prepare(`
    SELECT COALESCE(s.id, '') AS partyId, COALESCE(s.name, 'Unknown Supplier') AS party,
      pi.name AS product, pi.unit_label AS unit, pi.pieces AS qty,
      (pi.qty * pi.rate - pi.discount_amount) AS amount
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0${range.sql("p.date")}
  `).all(...range.params());

  const merged = new Map();
  [...fromStockIns, ...fromPurchaseItems].forEach(r => {
    const key = r.partyId + "|" + r.product;
    const existing = merged.get(key);
    if (existing) { existing.qty += r.qty; existing.amount += r.amount; }
    else merged.set(key, { ...r });
  });
  res.json(groupByParty([...merged.values()]));
});

/** Rolls flat {partyId, party, product, unit, qty, amount} rows into one
 *  entry per party with a nested product list, sorted by that party's
 *  total amount (highest business first), each party's products likewise. */
function groupByParty(rows) {
  const parties = new Map();
  rows.forEach(r => {
    if (!parties.has(r.partyId)) parties.set(r.partyId, { partyId: r.partyId, party: r.party, total: 0, products: [] });
    const p = parties.get(r.partyId);
    p.total = round2(p.total + r.amount);
    p.products.push({ product: r.product, unit: r.unit, qty: round2(r.qty), amount: round2(r.amount) });
  });
  const result = [...parties.values()];
  result.forEach(p => p.products.sort((a, b) => b.amount - a.amount));
  result.sort((a, b) => b.total - a.total);
  return result;
}

/**
 * Profit per sold item, following the standard GST-exclusive method:
 *   Purchase Amount = purchase rate × qty (GST added separately as Purchase GST)
 *   Sales Amount     = sale rate × qty     (GST added separately as Sales GST)
 *   Gross Profit     = Sales Amount − Purchase Amount   (GST never enters this —
 *                       it's tax collected and remitted, not margin)
 * The purchase side's rate/GST% come from the most recent PURCHASE on file for
 * that product; cost_price already excludes GST (it's rate+transport per piece,
 * see stock-in), so purchaseAmount below is genuinely GST-exclusive without
 * needing a ÷1.18-style unwind. A product never purchased through this app has
 * no cost on file — its purchase side is 0 and the row is flagged (hasCost)
 * rather than silently guessing a number.
 */
router.get("/profit", ownerOnly, (req, res) => {
  const range = dateRange(req);
  const items = db.prepare(`
    SELECT ii.product_id, ii.name, ii.pieces, ii.qty, ii.rate, ii.gst_rate AS sales_gst_rate,
      ii.qty*ii.rate AS sales_amount, i.date, i.challan_no
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
    ORDER BY i.created_at DESC
  `).all(...range.params());

  const totals = { purchaseAmount: 0, purchaseGst: 0, salesAmount: 0, salesGst: 0 };
  const rows = items.map(it => {
    const costRow = it.product_id ? getLatestCost(it.product_id) : null;
    const hasCost = !!costRow;

    const purchaseAmount = round2((costRow ? costRow.costPrice : 0) * (it.pieces || 0));
    const purchaseGst = round2(purchaseAmount * ((costRow ? costRow.gstRate : 0) / 100));
    const purchaseTotal = round2(purchaseAmount + purchaseGst);

    const salesAmount = round2(it.sales_amount);
    const salesGst = round2(salesAmount * ((it.sales_gst_rate || 0) / 100));
    const salesTotal = round2(salesAmount + salesGst);

    const grossProfit = round2(salesAmount - purchaseAmount);
    const profitPerUnit = it.pieces > 0 ? round2(grossProfit / it.pieces) : 0;
    const profitPct = purchaseAmount > 0 ? round2((grossProfit / purchaseAmount) * 100) : null;

    totals.purchaseAmount += purchaseAmount; totals.purchaseGst += purchaseGst;
    totals.salesAmount += salesAmount; totals.salesGst += salesGst;

    return {
      name: it.name, date: it.date, challan_no: it.challan_no, pieces: it.pieces, hasCost,
      purchaseAmount, purchaseGst, purchaseTotal, salesAmount, salesGst, salesTotal,
      grossProfit, profitPerUnit, profitPct
    };
  });

  const purchaseAmount = round2(totals.purchaseAmount);
  const salesAmount = round2(totals.salesAmount);
  const grossProfit = round2(salesAmount - purchaseAmount);

  res.json({
    rows,
    purchaseAmount, purchaseGst: round2(totals.purchaseGst), purchaseTotal: round2(purchaseAmount + totals.purchaseGst),
    salesAmount, salesGst: round2(totals.salesGst), salesTotal: round2(salesAmount + totals.salesGst),
    grossProfit, profitPct: purchaseAmount > 0 ? round2((grossProfit / purchaseAmount) * 100) : null
  });
});

// Same GST-exclusive profit math as /profit, but rolled up per invoice
// instead of per line — "how much did this one sale actually make", which
// per-line is too granular for and the plain sales report has no cost data
// to answer at all.
router.get("/profit-by-invoice", ownerOnly, (req, res) => {
  const range = dateRange(req);
  const invoices = db.prepare(`
    SELECT i.id, i.challan_no, i.date, i.created_at, i.customer_id, c.name AS customer_name
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
    ORDER BY i.created_at DESC
  `).all(...range.params());

  const itemsStmt = db.prepare(`
    SELECT product_id, pieces, qty, rate, gst_rate AS sales_gst_rate, qty*rate AS sales_amount
    FROM invoice_items WHERE invoice_id = ?
  `);

  const rows = invoices.map(inv => {
    const items = itemsStmt.all(inv.id);
    let purchaseAmount = 0, purchaseGst = 0, salesAmount = 0, salesGst = 0;
    let hasCost = true;
    items.forEach(it => {
      const costRow = it.product_id ? getLatestCost(it.product_id) : null;
      if (!costRow) hasCost = false;
      const lineCost = round2((costRow ? costRow.costPrice : 0) * (it.pieces || 0));
      purchaseAmount += lineCost;
      purchaseGst += round2(lineCost * ((costRow ? costRow.gstRate : 0) / 100));
      const lineSales = round2(it.sales_amount);
      salesAmount += lineSales;
      salesGst += round2(lineSales * ((it.sales_gst_rate || 0) / 100));
    });
    purchaseAmount = round2(purchaseAmount); purchaseGst = round2(purchaseGst);
    salesAmount = round2(salesAmount); salesGst = round2(salesGst);
    const grossProfit = round2(salesAmount - purchaseAmount);
    const profitPct = purchaseAmount > 0 ? round2((grossProfit / purchaseAmount) * 100) : null;

    return {
      invoiceId: inv.id, challan_no: inv.challan_no, date: inv.date,
      customer: inv.customer_name || "Walk-in", itemCount: items.length, hasCost,
      purchaseAmount, purchaseGst, purchaseTotal: round2(purchaseAmount + purchaseGst),
      salesAmount, salesGst, salesTotal: round2(salesAmount + salesGst),
      grossProfit, profitPct
    };
  });

  const totals = rows.reduce((acc, r) => {
    acc.purchaseAmount += r.purchaseAmount; acc.salesAmount += r.salesAmount;
    return acc;
  }, { purchaseAmount: 0, salesAmount: 0 });
  const purchaseAmount = round2(totals.purchaseAmount);
  const salesAmount = round2(totals.salesAmount);
  const grossProfit = round2(salesAmount - purchaseAmount);

  res.json({
    rows, purchaseAmount, salesAmount, grossProfit,
    profitPct: purchaseAmount > 0 ? round2((grossProfit / purchaseAmount) * 100) : null
  });
});

/**
 * BALANCE SHEET (Statement of Financial Position)
 *
 * What the shop OWNS against what it OWES, and the difference — Net Worth.
 *
 * This is deliberately NOT a double-entry balance sheet. There is no capital
 * account, no chart of accounts and no expense ledger in this app, so
 * "Assets = Liabilities + Capital" cannot be made to balance without inventing
 * a capital figure. Presenting a fabricated one would look authoritative and
 * be wrong, so the statement stops at Net Worth = Assets − Liabilities, which
 * every number here genuinely supports.
 *
 * AS OF NOW, not as of a chosen date: stock levels and party dues are stored
 * as RUNNING BALANCES, not a dated ledger, so there is no honest way to rewind
 * them to a past date. A date picker here would silently mix today's stock
 * with an old cash position.
 *
 * Stock is valued at the latest PURCHASE cost per piece. A product never
 * purchased through this app has no cost on file and is counted at zero —
 * `stock.itemsWithoutCost` reports how many, because a large number there
 * means the stock figure (and therefore Net Worth) is understated.
 */
/* ============================================================
   PROFIT & LOSS  /  BALANCE SHEET
   ------------------------------------------------------------
   Expense and income categories. A cash/bank row is only ever
   income or expense if it is NOT linked to a customer/supplier
   payment: collecting a debtor is turning a receivable into
   cash, and paying a creditor is settling a payable — neither
   is profit or loss, and counting them would roughly double
   both sides of the P&L. Linked rows carry a non-empty
   source_type (see server/bankLink.js), which is how they are
   excluded below.
   ============================================================ */
/* The category lists are a MASTER the owner maintains (txn_categories), not
   a constant in this file. Adding "Staff Welfare" is a row, not a release.
   Read fresh each time so a category added a minute ago appears on the next
   Profit & Loss without a restart. The old hardcoded names are seeded into
   that table, so nothing that already reported under them moves. */
function categoryNames(kind) {
  return db.prepare(
    "SELECT name FROM txn_categories WHERE kind = ? AND active = 1 ORDER BY sort_order ASC, name ASC"
  ).all(kind).map(r => r.name);
}
const expenseCategoryNames = () => categoryNames("expense");
const incomeCategoryNames = () => categoryNames("income");

/**
 * Cash + bank rows that represent real income/expense.
 *
 * Two kinds of row are excluded, and both matter:
 *  - source_type set — a customer/supplier payment. Collecting a debtor turns
 *    a receivable into cash; paying a creditor settles a payable. Neither is
 *    profit or loss.
 *  - link_id set — one leg of a Deposit / Withdrawal / cash-to-bank Transfer.
 *    Moving the shop's own money between its own drawer and its own bank is
 *    not earning or spending it. Counting both legs would add the same rupees
 *    to income AND expenses, inflating the P&L from both ends at once.
 */
function ledgerMovements(range, direction) {
  const where = `voided = 0 AND type = ? AND COALESCE(source_type,'') = '' AND COALESCE(link_id,'') = ''`;
  const cash = db.prepare(
    `SELECT id, 'cash' AS source, date, amount, COALESCE(category,'') AS category, COALESCE(party,'') AS party, COALESCE(remarks,'') AS remarks, created_at
     FROM cash_entries WHERE ${where}${range.sql("date")}`
  ).all(direction, ...range.params());
  const bank = db.prepare(
    `SELECT id, 'bank' AS source, date, amount, COALESCE(category,'') AS category, COALESCE(party,'') AS party, COALESCE(remarks,'') AS remarks, created_at
     FROM bank_entries WHERE ${where}${range.sql("date")}`
  ).all(direction, ...range.params());
  return [...cash, ...bank];
}

/**
 * The Other Income / Other Expenses screens.
 *
 * Deliberately the SAME ledgerMovements() the Profit & Loss uses, so the list
 * on screen and the P&L line can never disagree about what counts. Customer
 * receipts and supplier payments are excluded there (collecting a debtor is
 * not income), and so they are excluded here — which is exactly what makes
 * this "OTHER" income rather than all money in.
 */
router.get("/other-entries", (req, res) => {
  const kind = req.query.kind === "income" ? "income" : "expense";
  const range = dateRange(req);
  const rows = ledgerMovements(range, kind === "income" ? "in" : "out")
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.created_at - a.created_at);
  const total = round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));

  /* Grouped through the SAME canonical names the P&L uses, case-folded.
     Grouping on the raw string instead listed "Salary 25,000" and
     "salary 900" as two rows while the P&L showed one line of 25,900 —
     the same money described two different ways on two screens. */
  const canonical = new Map();
  categoryNames(kind).forEach(n => canonical.set(n.trim().toLowerCase(), n));
  const byCategory = {};
  rows.forEach(r => {
    const key = String(r.category || "").trim().toLowerCase();
    const k = canonical.get(key) || (key ? (r.category || "").trim() : "Uncategorised");
    byCategory[k] = round2((byCategory[k] || 0) + (Number(r.amount) || 0));
  });

  res.json({ kind, rows, total, byCategory, period: { from: range.from || "", to: range.to || "" } });
});

/**
 * Profit & Loss for a period.
 *
 * Cost of goods sold uses the SAME per-line latest-purchase-cost method as
 * /profit, so the two screens can never disagree. The textbook alternative
 * (opening stock + purchases − closing stock) needs dated stock snapshots
 * this app does not keep, so it would have to be guessed.
 */
function computePnl(range) {
  const inv = db.prepare(`
    SELECT COALESCE(SUM(subtotal - discount_amount),0) AS net_sales,
           COALESCE(SUM(transport + loading),0) AS charges,
           COUNT(*) AS bills
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice'${range.sql("date")}
  `).get(...range.params());

  const soldItems = db.prepare(`
    SELECT ii.product_id, ii.pieces
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
  `).all(...range.params());
  const costCache = new Map();
  let cogs = 0, itemsWithoutCost = 0;
  for (const it of soldItems) {
    if (!it.product_id) { itemsWithoutCost++; continue; }
    if (!costCache.has(it.product_id)) costCache.set(it.product_id, getLatestCost(it.product_id));
    const c = costCache.get(it.product_id);
    if (c && c.costPrice > 0) cogs += c.costPrice * (it.pieces || 0);
    else itemsWithoutCost++;
  }
  cogs = round2(cogs);

  /* Match on a trimmed, case-folded name.
     The category used to be typed free-hand and compared exactly, so
     "salary", "Salary " and "Labour Charges" all fell into Uncategorised —
     the money reached the total but never the line the owner was looking
     for. Folding the case means an entry made before the dropdown existed
     still lands where it belongs. */
  const bucket = (rows, known) => {
    const out = {};
    const byKey = new Map();
    known.forEach(k => { out[k] = 0; byKey.set(k.trim().toLowerCase(), k); });
    out.Uncategorised = 0;
    rows.forEach(r => {
      const key = String(r.category || "").trim().toLowerCase();
      const k = byKey.get(key) || "Uncategorised";
      out[k] = round2(out[k] + r.amount);
    });
    return out;
  };
  const expenseRows = ledgerMovements(range, "out");
  const incomeRows = ledgerMovements(range, "in");
  const expenses = bucket(expenseRows, expenseCategoryNames());
  const otherIncome = bucket(incomeRows, incomeCategoryNames());

  const salesRevenue = round2(inv.net_sales);
  const chargesRecovered = round2(inv.charges);
  const grossProfit = round2(salesRevenue - cogs);
  const operatingExpenses = round2(Object.values(expenses).reduce((s, v) => s + v, 0));
  const otherIncomeTotal = round2(Object.values(otherIncome).reduce((s, v) => s + v, 0));
  const totalIncome = round2(salesRevenue + chargesRecovered + otherIncomeTotal);
  const totalExpenses = round2(cogs + operatingExpenses);

  return {
    range: { from: range.from, to: range.to },
    income: { salesRevenue, chargesRecovered, otherIncome, otherIncomeTotal, total: totalIncome },
    expenses: { costOfGoodsSold: cogs, operating: expenses, operatingTotal: operatingExpenses, total: totalExpenses },
    grossProfit,
    netProfit: round2(totalIncome - totalExpenses),
    bills: inv.bills,
    // Surfaced, not hidden: a sale of a product with no purchase cost on file
    // contributes revenue but no cost, which overstates profit.
    itemsWithoutCost
  };
}

router.get("/pnl", ownerOnly, (req, res) => res.json(computePnl(dateRange(req))));

/** Output GST (collected on sales) vs input GST (paid on purchases). Whichever
 *  side is larger decides whether GST sits on the asset or liability side. */
function gstPosition() {
  const out = db.prepare(`
    SELECT COALESCE(SUM(cgst+sgst+igst),0) AS t FROM invoices WHERE voided = 0 AND doc_type = 'invoice'
  `).get().t;
  const inStock = db.prepare("SELECT COALESCE(SUM(gst_amount),0) AS t FROM stock_ins").get().t;
  const inPurch = db.prepare(`
    SELECT COALESCE(SUM(cgst+sgst+igst),0) AS t FROM purchases WHERE voided = 0
  `).get().t;
  const output = round2(out), input = round2(inStock + inPurch);
  return {
    output, input,
    payable: output > input ? round2(output - input) : 0,
    credit: input > output ? round2(input - output) : 0
  };
}

function computeBalanceSheet() {
  const cashInHand = round2(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS net
    FROM cash_entries WHERE voided = 0
  `).get().net);

  const bankAccounts = db.prepare("SELECT * FROM bank_accounts WHERE active = 1 ORDER BY name").all().map(a => {
    const net = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS net
      FROM bank_entries WHERE bank_account_id = ? AND voided = 0
    `).get(a.id).net;
    return { id: a.id, name: a.name, balance: round2(a.opening_balance + net) };
  });
  const bankBalance = round2(bankAccounts.reduce((s, a) => s + a.balance, 0));

  // Stock at cost, from the authoritative per-size quantity (products.stock is
  // just a cached sum of these — see syncProductStock in routes/products.js).
  const sizes = db.prepare(`
    SELECT ps.product_id, ps.stock, ps.cost_price, p.name
    FROM product_sizes ps JOIN products p ON p.id = ps.product_id
    WHERE ps.stock > 0
  `).all();
  const costCache = new Map();
  let closingStock = 0, itemsWithoutCost = 0, itemsWithCost = 0, unitsWithoutCost = 0;
  for (const s of sizes) {
    // The size's OWN cost wins here. Two sizes of one product can be bought at
    // very different rates (an 8x4 sheet against a 7x4), and this loop values
    // each size's stock separately — using one product-wide figure would price
    // the cheap variant at the dear one's rate. getLatestCost is the fallback
    // for sizes with no cost of their own.
    let c = s.cost_price > 0 ? { costPrice: s.cost_price } : null;
    if (!c) {
      if (!costCache.has(s.product_id)) costCache.set(s.product_id, getLatestCost(s.product_id));
      c = costCache.get(s.product_id);
    }
    if (c && c.costPrice > 0) { closingStock += c.costPrice * s.stock; itemsWithCost++; }
    else { itemsWithoutCost++; unitsWithoutCost += s.stock; }
  }
  closingStock = round2(closingStock);

  // A customer's `due` can go negative when they've paid in advance — that is
  // money the shop OWES, not an asset, so the two directions are split rather
  // than netted into one misleading figure. Same, mirrored, for suppliers.
  const custRows = db.prepare("SELECT due FROM customers").all();
  const receivables = round2(custRows.filter(c => c.due > 0).reduce((s, c) => s + c.due, 0));
  const customerAdvances = round2(Math.abs(custRows.filter(c => c.due < 0).reduce((s, c) => s + c.due, 0)));

  const suppRows = db.prepare("SELECT due FROM suppliers").all();
  const payables = round2(suppRows.filter(s => s.due > 0).reduce((s, x) => s + x.due, 0));
  const supplierAdvances = round2(Math.abs(suppRows.filter(s => s.due < 0).reduce((s, x) => s + x.due, 0)));

  // ---- one-time-entry masters (see server/routes/accounting.js) ----
  const faRows = db.prepare("SELECT cost, accumulated_depreciation FROM fixed_assets WHERE active = 1").all();
  const fixedAssets = round2(faRows.reduce((s, r) => s + (r.cost - r.accumulated_depreciation), 0));
  const securityDeposits = round2(
    db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM deposits WHERE active = 1").get().t
  );
  const loanRows = db.prepare("SELECT kind, outstanding FROM loans WHERE active = 1").all();
  const bankLoans = round2(loanRows.filter(r => r.kind === "bank").reduce((s, r) => s + r.outstanding, 0));
  const otherLiabilities = round2(loanRows.filter(r => r.kind !== "bank").reduce((s, r) => s + r.outstanding, 0));
  const outstandingRows = db.prepare(
    "SELECT category, amount FROM outstanding_liabilities WHERE settled = 0"
  ).all();
  const outstandingExpenses = round2(outstandingRows.reduce((s, r) => s + r.amount, 0));
  const outstandingByCategory = {};
  outstandingRows.forEach(r => {
    const k = r.category || "Other";
    outstandingByCategory[k] = round2((outstandingByCategory[k] || 0) + r.amount);
  });

  const gst = gstPosition();

  const capRows = db.prepare("SELECT kind, amount FROM capital_entries WHERE voided = 0").all();
  const capSum = k => round2(capRows.filter(r => r.kind === k).reduce((s, r) => s + r.amount, 0));
  const openingCapital = capSum("opening");
  const capitalIntroduced = capSum("introduced");
  const drawings = capSum("drawings");

  // Retained profit since inception — an unbounded range, because the Balance
  // Sheet's capital is cumulative, not "this period's" profit.
  const allTime = { from: null, to: null, active: false, sql: () => "", params: () => [] };
  const pnl = computePnl(allTime);
  const closingCapital = round2(openingCapital + capitalIntroduced - drawings + pnl.netProfit);

  const assetsTotalFull = round2(
    cashInHand + bankBalance + closingStock + receivables + supplierAdvances
    + fixedAssets + securityDeposits + gst.credit
  );
  const liabilitiesTotalFull = round2(
    payables + customerAdvances + bankLoans + otherLiabilities + outstandingExpenses + gst.payable
  );

  // The equation is NOT forced. Whatever fails to reconcile is reported as a
  // Difference so the owner can see how much is still unrecorded — a plug
  // figure that makes it "balance" would hide exactly the thing worth knowing.
  const difference = round2(assetsTotalFull - (liabilitiesTotalFull + closingCapital));

  return {
    asOf: todayStr(),
    assets: {
      cashInHand, bankBalance, bankAccounts, closingStock, receivables, supplierAdvances,
      fixedAssets, securityDeposits, gstInputCredit: gst.credit,
      total: assetsTotalFull
    },
    liabilities: {
      payables, customerAdvances, bankLoans, otherLiabilities,
      outstandingExpenses, outstandingByCategory, gstPayable: gst.payable,
      total: liabilitiesTotalFull
    },
    capital: {
      opening: openingCapital, introduced: capitalIntroduced, drawings,
      retainedProfit: pnl.netProfit, closing: closingCapital
    },
    gst,
    balanceCheck: {
      totalAssets: assetsTotalFull,
      totalLiabilities: liabilitiesTotalFull,
      totalCapital: closingCapital,
      liabilitiesPlusCapital: round2(liabilitiesTotalFull + closingCapital),
      difference,
      balanced: Math.abs(difference) < 1
    },
    // Kept for the simpler "what do I own minus what I owe" read.
    netWorth: round2(assetsTotalFull - liabilitiesTotalFull),
    stock: { itemsWithCost, itemsWithoutCost, unitsWithoutCost }
  };
}

router.get("/balance-sheet", ownerOnly, (req, res) => res.json(computeBalanceSheet()));

/* Row data for a report, as a header row followed by data rows.
   The Excel download, the CSV, the PDF and the printed sheet all come from
   here, so a report cannot say one thing on paper and another in a file. */
function buildReportRows(req) {
  const type = req.query.type || "Sales";
  // Same range the on-screen report used, so a download can never quietly
  // contain a different set of rows than the table it came from.
  const range = dateRange(req);
  let rows = [];
  let filename = "report";

  if (type === "Sales") {
    filename = "sales-report";
    rows = [["Challan No", "Date", "Customer", "Payment", "Total"]];
    const invoices = db.prepare(`
      SELECT i.*, c.name AS customer_name FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")} ORDER BY i.created_at DESC
    `).all(...range.params());
    invoices.forEach(inv => rows.push([inv.challan_no, inv.date, inv.customer_name || "Walk-in", inv.payment_method, inv.total]));
  } else if (type === "Stock") {
    filename = "stock-report";
    rows = [["Product", "Brand", "SKU", "Stock", "Unit"]];
    db.prepare("SELECT * FROM products ORDER BY name").all().forEach(p => rows.push([p.name, p.brand, p.sku, p.stock, p.unit]));
  } else if (type === "Customer") {
    filename = "customer-report";
    rows = [["Customer", "Type", "Phone", "Outstanding Due"]];
    db.prepare("SELECT * FROM customers ORDER BY name").all().forEach(c => rows.push([c.name, c.type, c.phone, c.due]));
  } else if (type === "Purchase") {
    filename = "purchase-report";
    rows = [["Date", "Invoice No", "Supplier", "Product", "Size", "Qty", "Rate", "GST%", "Transport", "Grand Total"]];
    db.prepare(`SELECT * FROM stock_ins WHERE 1 = 1${range.sql("purchase_date")} ORDER BY created_at DESC`)
      .all(...range.params()).forEach(r =>
        rows.push([r.purchase_date, r.invoice_no, r.supplier, r.product_name, r.size_label, r.qty, r.rate, r.gst_rate, r.transport, r.grand_total]));
  } else if (type === "Challan") {
    filename = "challan-report";
    rows = [["Challan No", "Date", "Customer", "Items", "Total Pieces", "Transport", "Loading"]];
    db.prepare(`
      SELECT i.challan_no, i.date, c.name AS customer_name, i.transport, i.loading,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS item_count,
        (SELECT COALESCE(SUM(pieces),0) FROM invoice_items WHERE invoice_id = i.id) AS total_pieces
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'challan'${range.sql("i.date")} ORDER BY i.created_at DESC
    `).all(...range.params()).forEach(r => rows.push([r.challan_no, r.date, r.customer_name || "Walk-in", r.item_count, r.total_pieces, r.transport, r.loading]));
  } else if (type === "TaxInvoice") {
    filename = "tax-invoice-report";
    rows = [["Estimate No", "Date", "Customer", "Payment Method", "Total", "Balance Due"]];
    db.prepare(`
      SELECT i.challan_no, i.date, c.name AS customer_name, i.payment_method, i.total, i.balance_due
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")} ORDER BY i.created_at DESC
    `).all(...range.params()).forEach(r => rows.push([r.challan_no, r.date, r.customer_name || "Walk-in", r.payment_method, r.total, r.balance_due]));
  } else if (type === "PurchaseBill") {
    filename = "purchase-bill-report";
    rows = [["Bill No", "Date", "Supplier", "Items", "Grand Total"]];
    const stockInRows = db.prepare(`
      SELECT invoice_no AS bill_no, purchase_date AS date, supplier AS supplier_name, grand_total, created_at, 1 AS item_count
      FROM stock_ins WHERE 1 = 1${range.sql("purchase_date")}
    `).all(...range.params());
    const purchaseRows = db.prepare(`
      SELECT p.purchase_no AS bill_no, p.date, s.name AS supplier_name, p.total AS grand_total, p.created_at,
        (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) AS item_count
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.voided = 0${range.sql("p.date")}
    `).all(...range.params());
    [...stockInRows, ...purchaseRows].sort((a, b) => b.created_at - a.created_at)
      .forEach(r => rows.push([r.bill_no || "", r.date || "", r.supplier_name || "Unknown Supplier", r.item_count, r.grand_total]));
  } else if (type === "Salesman") {
    filename = "salesman-wise-report";
    rows = [["Salesperson", "Total Sales", "Invoices"]];
    db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(delivery_man),''), 'Unassigned') AS label, COALESCE(SUM(total),0) AS value, COUNT(*) AS invoices
      FROM invoices WHERE voided = 0 AND doc_type = 'invoice'${range.sql("date")} GROUP BY label ORDER BY value DESC
    `).all(...range.params()).forEach(r => rows.push([r.label, round2(r.value), r.invoices]));
  } else if (type === "Brand") {
    filename = "brand-wise-report";
    rows = [["Brand", "Revenue", "Pieces Sold", "Invoices"]];
    db.prepare(`
      SELECT COALESCE(NULLIF(p.brand,''),'(No brand)') AS brand, SUM(ii.qty*ii.rate) AS revenue,
        SUM(ii.pieces) AS pieces, COUNT(DISTINCT ii.invoice_id) AS invoices
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id LEFT JOIN products p ON p.id = ii.product_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")} GROUP BY COALESCE(NULLIF(p.brand,''),'(No brand)') ORDER BY revenue DESC
    `).all(...range.params()).forEach(r => rows.push([r.brand, round2(r.revenue), r.pieces, r.invoices]));
  } else if (type === "Party") {
    filename = "party-wise-report";
    rows = [["Customer", "Type", "Total Business", "Invoices", "Outstanding Due"]];
    db.prepare(`
      SELECT c.name, c.type, c.due, COALESCE(SUM(i.total),0) AS total, COUNT(i.id) AS invoices
      FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
      GROUP BY c.id ORDER BY total DESC
    `).all(...range.params()).forEach(r => rows.push([r.name, r.type, round2(r.total), r.invoices, r.due]));
  } else if (type === "Supplier") {
    filename = "supplier-report";
    rows = [["Supplier", "Phone", "Outstanding Due"]];
    db.prepare("SELECT * FROM suppliers ORDER BY name").all().forEach(s => rows.push([s.name, s.phone, s.due]));
  } else if (type === "BalanceSheet") {
    // Same function the screen reads, so the file can never drift from it.
    filename = "balance-sheet";
    const bs = computeBalanceSheet();
    rows = [["Balance Sheet — as of " + bs.asOf], [], ["ASSETS", ""]];
    rows.push(["Cash in Hand", bs.assets.cashInHand]);
    bs.assets.bankAccounts.forEach(a => rows.push(["Bank — " + a.name, a.balance]));
    rows.push(["Closing Stock (at cost)", bs.assets.closingStock]);
    rows.push(["Customer Receivables", bs.assets.receivables]);
    if (bs.assets.supplierAdvances) rows.push(["Advances to Suppliers", bs.assets.supplierAdvances]);
    rows.push(["Total Assets", bs.assets.total], []);
    rows.push(["LIABILITIES", ""]);
    rows.push(["Supplier Payables", bs.liabilities.payables]);
    if (bs.liabilities.customerAdvances) rows.push(["Advances from Customers", bs.liabilities.customerAdvances]);
    rows.push(["Total Liabilities", bs.liabilities.total], []);
    rows.push(["NET WORTH", bs.netWorth]);
    if (bs.stock.itemsWithoutCost) {
      rows.push([], ["Note: " + bs.stock.itemsWithoutCost + " stock item(s) totalling "
        + bs.stock.unitsWithoutCost + " unit(s) have no purchase cost on file and are valued at zero."]);
    }
  } else if (type === "SalePayments") {
    filename = "sale-payments-report";
    rows = [["Date", "Customer", "Against Invoice", "Amount", "Mode", "Reference No", "Remarks"]];
    db.prepare(`
      SELECT p.*, c.name AS customer_name, i.challan_no FROM payments p
      JOIN customers c ON c.id = p.customer_id
      LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.voided = 0${range.sql("p.payment_date")} ORDER BY p.created_at DESC
    `).all(...range.params()).forEach(p => rows.push([p.payment_date, p.customer_name, p.challan_no || "", p.amount, p.method, p.reference_no, p.note]));
  } else if (type === "PurchasePayments") {
    filename = "purchase-payments-report";
    rows = [["Date", "Supplier", "Against Purchase Invoice", "Amount", "Mode", "Reference No", "Remarks"]];
    db.prepare(`
      SELECT pp.*, s.name AS supplier_name, si.invoice_no FROM purchase_payments pp
      JOIN suppliers s ON s.id = pp.supplier_id
      LEFT JOIN stock_ins si ON si.id = pp.stock_in_id
      WHERE pp.voided = 0${range.sql("pp.payment_date")} ORDER BY pp.created_at DESC
    `).all(...range.params()).forEach(p => rows.push([p.payment_date, p.supplier_name, p.invoice_no || "", p.amount, p.method, p.reference_no, p.note]));
  } else if (type === "Profit") {
    filename = "profit-report";
    rows = [["Date", "Challan No", "Product", "Qty Sold", "Revenue", "Cost", "Profit"]];
    const items = db.prepare(`
      SELECT ii.product_id, ii.name, ii.pieces, ii.qty*ii.rate AS revenue, i.date, i.challan_no
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")} ORDER BY i.created_at DESC
    `).all(...range.params());
    items.forEach(it => {
      const c = it.product_id ? getLatestCost(it.product_id) : null;
      const cost = round2((c ? c.costPrice : 0) * (it.pieces || 0));
      rows.push([it.date, it.challan_no, it.name, it.pieces, round2(it.revenue), cost, round2(it.revenue - cost)]);
    });
  } else if (type === "GST") {
    filename = "gst-report";
    rows = [["Challan No", "Date", "Tax Type", "CGST", "SGST", "IGST"]];
    db.prepare(`SELECT * FROM invoices WHERE voided = 0 AND doc_type = 'invoice'${range.sql("date")} ORDER BY created_at DESC`)
      .all(...range.params())
      .forEach(inv => rows.push([inv.challan_no, inv.date, inv.tax_type, round2(inv.cgst), round2(inv.sgst), round2(inv.igst)]));
  }
  // ---- The eight report types that produced an empty download until now:
  // they were on the Reports screen but had no branch here, so choosing one
  // and pressing Export gave a spreadsheet containing nothing.
  else if (type === "Orders") {
    filename = "orders-report";
    // The same three document types the on-screen Orders report shows, so a
    // download can never be missing rows the screen just listed.
    rows = [["Type", "No.", "Date", "Party", "Status", "Total"]];
    const allOrders = [];
    db.prepare(`
      SELECT q.quotation_no AS no, q.date, c.name AS party, q.status, q.total, q.created_at
      FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id
      WHERE 1=1${range.sql("q.date")}
    `).all(...range.params()).forEach(r => allOrders.push({ ...r, docType: "Quotation" }));
    db.prepare(`
      SELECT so.so_no AS no, so.date, c.name AS party, so.status, so.total, so.created_at
      FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
      WHERE 1=1${range.sql("so.date")}
    `).all(...range.params()).forEach(r => allOrders.push({ ...r, docType: "Sales Order" }));
    db.prepare(`
      SELECT po.po_no AS no, po.date, s.name AS party, po.status, po.total, po.created_at
      FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE 1=1${range.sql("po.date")}
    `).all(...range.params()).forEach(r => allOrders.push({ ...r, docType: "Purchase Order" }));
    allOrders.sort((x, y) => y.created_at - x.created_at)
      .forEach(r => rows.push([r.docType, r.no, r.date, r.party || "", r.status || "", round2(r.total)]));
  } else if (type === "PartyProduct") {
    filename = "party-wise-product";
    rows = [["Customer", "Product", "Size", "Qty", "Amount"]];
    db.prepare(`
      SELECT c.name AS party, ii.name AS product, ii.size_label AS size,
             SUM(ii.pieces) AS qty, SUM(ii.qty * ii.rate) AS amount
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0${range.sql("i.date")}
      GROUP BY c.name, ii.name, ii.size_label
      ORDER BY c.name, ii.name
    `).all(...range.params())
      .forEach(r => rows.push([r.party || "Walk-in", r.product, r.size || "", round2(r.qty), round2(r.amount)]));
  } else if (type === "ProfitByInvoice") {
    filename = "profit-per-invoice";
    rows = [["Challan No", "Date", "Customer", "Sale Value", "Cost", "Profit"]];
    db.prepare(`
      SELECT i.challan_no, i.date, c.name AS customer_name, i.total,
             (SELECT COALESCE(SUM(ii.pieces * COALESCE(ps.cost_price,0)),0)
                FROM invoice_items ii LEFT JOIN product_sizes ps ON ps.id = ii.size_id
               WHERE ii.invoice_id = i.id) AS cost
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'${range.sql("i.date")}
      ORDER BY i.created_at DESC
    `).all(...range.params())
      .forEach(r => rows.push([r.challan_no, r.date, r.customer_name || "Walk-in",
        round2(r.total), round2(r.cost), round2(r.total - r.cost)]));
  } else if (type === "LocationStock") {
    filename = "shop-warehouse-stock";
    rows = [["Product", "Brand", "Size", "Unit", "Shop", "Warehouse", "Total"]];
    db.prepare(`
      SELECT p.name, p.brand, p.unit, ps.label AS size,
        (SELECT COALESCE(SUM(quantity),0) FROM size_location_stock WHERE size_id = ps.id AND location_id = 'LOC_shop') AS shop,
        (SELECT COALESCE(SUM(quantity),0) FROM size_location_stock WHERE size_id = ps.id AND location_id = 'LOC_warehouse') AS warehouse
      FROM products p JOIN product_sizes ps ON ps.product_id = p.id
      ORDER BY p.name, ps.sort_order
    `).all()
      .forEach(r => rows.push([r.name, r.brand || "", r.size || "", r.unit || "",
        round2(r.shop), round2(r.warehouse), round2(r.shop + r.warehouse)]));
  } else if (type === "Transfers") {
    filename = "stock-transfers";
    rows = [["Date", "Product", "Size", "From", "To", "Qty", "Staff"]];
    db.prepare(`
      SELECT st.*, lf.name AS from_name, lt.name AS to_name
      FROM stock_transfers st
      LEFT JOIN locations lf ON lf.id = st.from_location_id
      LEFT JOIN locations lt ON lt.id = st.to_location_id
      ORDER BY st.created_at DESC
    `).all()
      .forEach(t => rows.push([
        new Date(t.created_at).toISOString().slice(0, 10),
        t.product_name || "", t.size_label || "",
        t.from_name || "", t.to_name || "", round2(t.quantity), t.staff_name || ""
      ]));
  } else if (type === "DailyMovement") {
    filename = "daily-movement";
    rows = [["Date", "Invoices", "Sales Value", "Purchases", "Purchase Value"]];
    const sales = db.prepare(`
      SELECT date, COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM invoices
      WHERE voided = 0${range.sql("date")} GROUP BY date
    `).all(...range.params());
    const purch = db.prepare(`
      SELECT date, COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM purchases
      WHERE COALESCE(voided,0) = 0${range.sql("date")} GROUP BY date
    `).all(...range.params());
    const byDate = {};
    sales.forEach(s => { byDate[s.date] = { sn: s.n, sv: s.v, pn: 0, pv: 0 }; });
    purch.forEach(p => { byDate[p.date] = Object.assign({ sn: 0, sv: 0 }, byDate[p.date], { pn: p.n, pv: p.v }); });
    Object.keys(byDate).sort().reverse()
      .forEach(d => rows.push([d, byDate[d].sn, round2(byDate[d].sv), byDate[d].pn, round2(byDate[d].pv)]));
  } else if (type === "ProfitLoss") {
    filename = "profit-and-loss";
    const pnl = computePnl(range);
    rows = [["Section", "Particulars", "Amount"]];
    rows.push(["Income", "Sales Revenue", round2(pnl.income.salesRevenue)]);
    rows.push(["Income", "Transport & Loading Recovered", round2(pnl.income.chargesRecovered)]);
    Object.entries(pnl.income.otherIncome || {}).forEach(([label, amt]) => rows.push(["Income", label, round2(amt)]));
    rows.push(["Income", "Total Income", round2(pnl.income.total)]);
    rows.push(["Expenses", "Cost of Goods Sold", round2(pnl.expenses.costOfGoodsSold)]);
    Object.entries(pnl.expenses.operating || {}).forEach(([label, amt]) => rows.push(["Expenses", label, round2(amt)]));
    rows.push(["Expenses", "Total Expenses", round2(pnl.expenses.total)]);
    rows.push(["Result", "Gross Profit", round2(pnl.grossProfit)]);
    rows.push(["Result", "Net Profit", round2(pnl.netProfit)]);
  }

  // Stamp the period into the filename so two downloads of the same report
  // for different months don't land in Downloads as "sales-report (1).xlsx"
  // with no way to tell them apart.
  if (range.active) filename += `-${range.from || "start"}_to_${range.to || "today"}`;
  return { type, rows, filename, range };
}

/* JSON for the print engine — the same rows the .xlsx download contains. */
router.get("/data", (req, res) => {
  try {
    const out = buildReportRows(req);
    res.json({
      type: out.type,
      filename: out.filename,
      columns: out.rows[0] || [],
      rows: out.rows.slice(1),
      period: { from: out.range.from || "", to: out.range.to || "" }
    });
  } catch (e) {
    res.status(500).json({ error: "Could not build this report: " + e.message });
  }
});

router.get("/export", (req, res) => {
  /* The same guard as the on-screen reports. Without it the margin is one
     download away for anyone signed in — the spreadsheet does not care that
     the button was hidden. */
  if (OWNER_ONLY_TYPES.has(req.query.type) &&
      !(req.session && req.session.role === "owner")) {
    return res.status(403).json({ error: "Only the shop owner can download this report." });
  }
  let out;
  try { out = buildReportRows(req); }
  catch (e) { return res.status(500).json({ error: "Could not build this report: " + e.message }); }
  const buf = buildXlsx(out.rows, out.filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${out.filename}.xlsx"`);
  res.send(buf);
});

module.exports = router;

/* Shared with routes/financialYears.js, so a year-end snapshot records the
   exact figures the P&L and Balance Sheet screens show — not a second
   implementation that can drift away from them. */
module.exports.computePnl = computePnl;
module.exports.computeBalanceSheet = computeBalanceSheet;
module.exports.dateRange = dateRange;
