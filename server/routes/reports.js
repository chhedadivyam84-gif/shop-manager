const express = require("express");
const db = require("../db");
const { todayStr, round2 } = require("../util");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

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

  if (!fromStockIn && !fromPurchase) return null;
  if (fromStockIn && (!fromPurchase || fromStockIn.created_at >= fromPurchase.created_at)) {
    return { costPrice: fromStockIn.cost_price, gstRate: fromStockIn.gst_rate };
  }
  const costPrice = fromPurchase.pieces > 0
    ? round2((fromPurchase.rate * fromPurchase.pieces - fromPurchase.discount_amount) / fromPurchase.pieces)
    : fromPurchase.rate;
  return { costPrice, gstRate: fromPurchase.gst_rate };
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
    const key = d.toISOString().slice(0, 10);
    const total = db.prepare("SELECT COALESCE(SUM(total),0) AS t FROM invoices WHERE date = ? AND voided = 0 AND doc_type = 'invoice'").get(key).t;
    days.push({ label: d.toLocaleDateString("en-IN", { weekday: "short" }), date: key, total });
  }

  const soldRows = db.prepare(`
    SELECT ii.name, SUM(ii.qty) AS units, SUM(ii.qty*ii.rate) AS revenue
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice' GROUP BY ii.name ORDER BY units DESC LIMIT 4
  `).all();

  const topCustomers = db.prepare(`
    SELECT c.id, c.name, c.type, COALESCE(SUM(i.total),0) AS total
    FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0 AND i.doc_type = 'invoice'
    GROUP BY c.id ORDER BY total DESC LIMIT 4
  `).all();

  const recentInvoices = db.prepare(`
    SELECT i.*, c.name AS customer_name FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 ORDER BY i.created_at DESC LIMIT 5
  `).all();

  res.json({
    todaysSales, todaysProfit, outstandingTotal, outstandingCount, payableTotal, payableCount, lowStockCount,
    cashBalance, bankBalance,
    revenueChart: days, bestSellers: soldRows, topCustomers, recentInvoices
  });
});

router.get("/sales-by-payment", (req, res) => {
  const rows = db.prepare(`
    SELECT payment_method AS label, COALESCE(SUM(total),0) AS value
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice' GROUP BY payment_method
  `).all();
  res.json(rows);
});

router.get("/gst", (req, res) => {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(igst),0) AS igst
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice'
  `).get();
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

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
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

/** Every supplier's total purchases — mirrors party-wise for the payable side. */
router.get("/supplier-wise", (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name AS label, s.due,
      COALESCE(SUM(si.grand_total),0) AS value, COUNT(si.id) AS purchases
    FROM suppliers s
    LEFT JOIN stock_ins si ON si.supplier_id = s.id
    GROUP BY s.id ORDER BY value DESC
  `).all();
  res.json(rows);
});

/** Every Sale Payment (money received from customers) — the Receipt history. */
router.get("/sale-payments", (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.name AS customer_name FROM payments p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.voided = 0 ORDER BY p.created_at DESC
  `).all();
  res.json(rows);
});

/** Every Purchase Payment (money paid to suppliers) — the Payment history. */
router.get("/purchase-payments", (req, res) => {
  const rows = db.prepare(`
    SELECT pp.*, s.name AS supplier_name FROM purchase_payments pp
    JOIN suppliers s ON s.id = pp.supplier_id
    WHERE pp.voided = 0 ORDER BY pp.created_at DESC
  `).all();
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
  const stockInRows = db.prepare(`
    SELECT id, product_name, size_label, purchase_date, invoice_no, supplier, qty, billed_qty, mode, grand_total, created_at
    FROM stock_ins
  `).all();

  const purchaseLineRows = db.prepare(`
    SELECT pi.id, pi.name AS product_name, pi.size_label, p.date AS purchase_date, p.supplier_invoice_no AS invoice_no,
      s.name AS supplier, pi.pieces AS qty, pi.qty AS billed_qty, pi.mode, pi.rate, pi.discount_amount, pi.gst_rate, p.created_at
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0
  `).all().map(r => {
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
 */
router.get("/search-number", (req, res) => {
  const raw = String(req.query.q || "").trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: "Enter a document number." });

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
    .find(s => raw.startsWith(s.prefix));
  const ordered = matchedPrefix ? [matchedPrefix, ...series.filter(s => s !== matchedPrefix)] : series;

  for (const s of ordered) {
    const row = db.prepare(`SELECT id FROM ${s.table} WHERE ${s.col} = ?`).get(raw);
    if (row) return res.json({ type: s.type, id: row.id, number: raw });
  }
  res.status(404).json({ error: `No document found with number "${raw}".` });
});

router.get("/challans", (req, res) => {
  const salesRows = db.prepare(`
    SELECT i.id, i.challan_no, i.date, c.name AS party_name, i.transport, i.loading, i.converted_invoice_id,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS item_count,
      (SELECT COALESCE(SUM(pieces),0) FROM invoice_items WHERE invoice_id = i.id) AS total_pieces,
      i.created_at
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 AND i.doc_type = 'challan'
  `).all().map(r => ({ ...r, type: "Sales", status: r.converted_invoice_id ? "Billed" : "Pending" }));
  const purchaseRows = db.prepare(`
    SELECT p.id, p.purchase_no AS challan_no, p.date, s.name AS party_name, p.transport, p.loading,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) AS item_count,
      (SELECT COALESCE(SUM(pieces),0) FROM purchase_items WHERE purchase_id = p.id) AS total_pieces,
      p.created_at
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0 AND p.doc_type = 'challan'
  `).all().map(r => ({ ...r, type: "Purchase" }));
  const rows = [...salesRows, ...purchaseRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Every Order, newest first — Purchase Order (sent to a supplier) and
 *  Sales Order (confirmed from a customer) merged into one list,
 *  distinguished by `type`. Each keeps its own creation/edit flow and
 *  status lifecycle; this is a read-only combined view. */
router.get("/orders", (req, res) => {
  const poRows = db.prepare(`
    SELECT po.id, po.po_no AS order_no, po.date, s.name AS party_name, po.total, po.status, po.created_at
    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
  `).all().map(r => ({ ...r, type: "Purchase" }));
  const soRows = db.prepare(`
    SELECT so.id, so.so_no AS order_no, so.date, c.name AS party_name, so.total, so.status, so.created_at
    FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
  `).all().map(r => ({ ...r, type: "Sales" }));
  const rows = [...poRows, ...soRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Every Tax Invoice, newest first — the Tax Invoice Report (one row per
 *  document, unlike /profit's per-line breakdown). */
router.get("/tax-invoices", (req, res) => {
  const rows = db.prepare(`
    SELECT i.id, i.challan_no, i.date, c.name AS customer_name, i.payment_method, i.total, i.balance_due
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'
    ORDER BY i.created_at DESC
  `).all();
  res.json(rows);
});

/** Every Purchase Bill, newest first — one row per bill, unlike /purchases'
 *  per-line breakdown. Merges the older single-line stock_ins (each row IS
 *  one bill) with the newer multi-line purchases (grouped by purchase_no),
 *  same merge /purchases already does at the line level. */
router.get("/purchase-bills", (req, res) => {
  const stockInRows = db.prepare(`
    SELECT id, invoice_no AS bill_no, purchase_date AS date, supplier AS supplier_name, grand_total, created_at, 1 AS item_count
    FROM stock_ins
  `).all().map(r => ({ ...r, source: "stock_in" }));
  const purchaseRows = db.prepare(`
    SELECT p.id, p.purchase_no AS bill_no, p.date, s.name AS supplier_name, p.total AS grand_total, p.created_at,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) AS item_count
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0
  `).all().map(r => ({ ...r, source: "purchase" }));
  const rows = [...stockInRows, ...purchaseRows].sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

/** Tax Invoice revenue grouped by salesperson (the "Salesperson" / delivery_man
 *  field entered on Billing) — invoices with none recorded fall under
 *  "Unassigned" rather than being silently dropped. */
router.get("/salesman-wise", (req, res) => {
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(delivery_man),''), 'Unassigned') AS label,
      COALESCE(SUM(total),0) AS value, COUNT(*) AS invoices
    FROM invoices WHERE voided = 0 AND doc_type = 'invoice'
    GROUP BY label ORDER BY value DESC
  `).all();
  res.json(rows);
});

/** Sales grouped by brand — revenue and units, not just stock on hand. */
router.get("/brand-wise", (req, res) => {
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(p.brand,''),'(No brand)') AS label,
      SUM(ii.qty*ii.rate) AS value, SUM(ii.pieces) AS pieces, COUNT(DISTINCT ii.invoice_id) AS invoices
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    LEFT JOIN products p ON p.id = ii.product_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'
    GROUP BY label ORDER BY value DESC
  `).all();
  res.json(rows);
});

/** Every customer's total business — full list, not just the dashboard's top 4. */
router.get("/party-wise", (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name AS label, c.type, c.due,
      COALESCE(SUM(i.total),0) AS value, COUNT(i.id) AS invoices
    FROM customers c
    LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0 AND i.doc_type = 'invoice'
    GROUP BY c.id ORDER BY value DESC
  `).all();
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

  if (type === "sales") {
    const rows = db.prepare(`
      SELECT COALESCE(c.id, '') AS partyId, COALESCE(c.name, 'Walk-in') AS party,
        ii.name AS product, ii.unit_label AS unit,
        SUM(ii.pieces) AS qty, SUM(ii.qty * ii.rate) AS amount
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice'
      GROUP BY COALESCE(c.id, ''), ii.name
    `).all();
    return res.json(groupByParty(rows));
  }

  const fromStockIns = db.prepare(`
    SELECT COALESCE(s.id, '') AS partyId, COALESCE(s.name, 'Unknown Supplier') AS party,
      si.product_name AS product, '' AS unit, si.qty AS qty, si.qty * si.cost_price AS amount
    FROM stock_ins si LEFT JOIN suppliers s ON s.id = si.supplier_id
  `).all();
  const fromPurchaseItems = db.prepare(`
    SELECT COALESCE(s.id, '') AS partyId, COALESCE(s.name, 'Unknown Supplier') AS party,
      pi.name AS product, pi.unit_label AS unit, pi.pieces AS qty,
      (pi.qty * pi.rate - pi.discount_amount) AS amount
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.voided = 0
  `).all();

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
router.get("/profit", (req, res) => {
  const items = db.prepare(`
    SELECT ii.product_id, ii.name, ii.pieces, ii.qty, ii.rate, ii.gst_rate AS sales_gst_rate,
      ii.qty*ii.rate AS sales_amount, i.date, i.challan_no
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'
    ORDER BY i.created_at DESC
  `).all();

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
router.get("/profit-by-invoice", (req, res) => {
  const invoices = db.prepare(`
    SELECT i.id, i.challan_no, i.date, i.created_at, i.customer_id, c.name AS customer_name
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'
    ORDER BY i.created_at DESC
  `).all();

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

router.get("/export", (req, res) => {
  const type = req.query.type || "Sales";
  let rows = [];
  let filename = "report";

  if (type === "Sales") {
    filename = "sales-report";
    rows = [["Challan No", "Date", "Customer", "Payment", "Total"]];
    const invoices = db.prepare(`
      SELECT i.*, c.name AS customer_name FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id WHERE i.voided = 0 AND i.doc_type = 'invoice' ORDER BY i.created_at DESC
    `).all();
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
    db.prepare("SELECT * FROM stock_ins ORDER BY created_at DESC").all().forEach(r =>
      rows.push([r.purchase_date, r.invoice_no, r.supplier, r.product_name, r.size_label, r.qty, r.rate, r.gst_rate, r.transport, r.grand_total]));
  } else if (type === "Challan") {
    filename = "challan-report";
    rows = [["Challan No", "Date", "Customer", "Items", "Total Pieces", "Transport", "Loading"]];
    db.prepare(`
      SELECT i.challan_no, i.date, c.name AS customer_name, i.transport, i.loading,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS item_count,
        (SELECT COALESCE(SUM(pieces),0) FROM invoice_items WHERE invoice_id = i.id) AS total_pieces
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'challan' ORDER BY i.created_at DESC
    `).all().forEach(r => rows.push([r.challan_no, r.date, r.customer_name || "Walk-in", r.item_count, r.total_pieces, r.transport, r.loading]));
  } else if (type === "TaxInvoice") {
    filename = "tax-invoice-report";
    rows = [["Estimate No", "Date", "Customer", "Payment Method", "Total", "Balance Due"]];
    db.prepare(`
      SELECT i.challan_no, i.date, c.name AS customer_name, i.payment_method, i.total, i.balance_due
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice' ORDER BY i.created_at DESC
    `).all().forEach(r => rows.push([r.challan_no, r.date, r.customer_name || "Walk-in", r.payment_method, r.total, r.balance_due]));
  } else if (type === "PurchaseBill") {
    filename = "purchase-bill-report";
    rows = [["Bill No", "Date", "Supplier", "Items", "Grand Total"]];
    const stockInRows = db.prepare(`
      SELECT invoice_no AS bill_no, purchase_date AS date, supplier AS supplier_name, grand_total, created_at, 1 AS item_count FROM stock_ins
    `).all();
    const purchaseRows = db.prepare(`
      SELECT p.purchase_no AS bill_no, p.date, s.name AS supplier_name, p.total AS grand_total, p.created_at,
        (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) AS item_count
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.voided = 0
    `).all();
    [...stockInRows, ...purchaseRows].sort((a, b) => b.created_at - a.created_at)
      .forEach(r => rows.push([r.bill_no || "", r.date || "", r.supplier_name || "Unknown Supplier", r.item_count, r.grand_total]));
  } else if (type === "Salesman") {
    filename = "salesman-wise-report";
    rows = [["Salesperson", "Total Sales", "Invoices"]];
    db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(delivery_man),''), 'Unassigned') AS label, COALESCE(SUM(total),0) AS value, COUNT(*) AS invoices
      FROM invoices WHERE voided = 0 AND doc_type = 'invoice' GROUP BY label ORDER BY value DESC
    `).all().forEach(r => rows.push([r.label, round2(r.value), r.invoices]));
  } else if (type === "Brand") {
    filename = "brand-wise-report";
    rows = [["Brand", "Revenue", "Pieces Sold", "Invoices"]];
    db.prepare(`
      SELECT COALESCE(NULLIF(p.brand,''),'(No brand)') AS brand, SUM(ii.qty*ii.rate) AS revenue,
        SUM(ii.pieces) AS pieces, COUNT(DISTINCT ii.invoice_id) AS invoices
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id LEFT JOIN products p ON p.id = ii.product_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice' GROUP BY brand ORDER BY revenue DESC
    `).all().forEach(r => rows.push([r.brand, round2(r.revenue), r.pieces, r.invoices]));
  } else if (type === "Party") {
    filename = "party-wise-report";
    rows = [["Customer", "Type", "Total Business", "Invoices", "Outstanding Due"]];
    db.prepare(`
      SELECT c.name, c.type, c.due, COALESCE(SUM(i.total),0) AS total, COUNT(i.id) AS invoices
      FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0 AND i.doc_type = 'invoice'
      GROUP BY c.id ORDER BY total DESC
    `).all().forEach(r => rows.push([r.name, r.type, round2(r.total), r.invoices, r.due]));
  } else if (type === "Supplier") {
    filename = "supplier-report";
    rows = [["Supplier", "Phone", "Outstanding Due"]];
    db.prepare("SELECT * FROM suppliers ORDER BY name").all().forEach(s => rows.push([s.name, s.phone, s.due]));
  } else if (type === "SalePayments") {
    filename = "sale-payments-report";
    rows = [["Date", "Customer", "Against Invoice", "Amount", "Mode", "Reference No", "Remarks"]];
    db.prepare(`
      SELECT p.*, c.name AS customer_name, i.challan_no FROM payments p
      JOIN customers c ON c.id = p.customer_id
      LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.voided = 0 ORDER BY p.created_at DESC
    `).all().forEach(p => rows.push([p.payment_date, p.customer_name, p.challan_no || "", p.amount, p.method, p.reference_no, p.note]));
  } else if (type === "PurchasePayments") {
    filename = "purchase-payments-report";
    rows = [["Date", "Supplier", "Against Purchase Invoice", "Amount", "Mode", "Reference No", "Remarks"]];
    db.prepare(`
      SELECT pp.*, s.name AS supplier_name, si.invoice_no FROM purchase_payments pp
      JOIN suppliers s ON s.id = pp.supplier_id
      LEFT JOIN stock_ins si ON si.id = pp.stock_in_id
      WHERE pp.voided = 0 ORDER BY pp.created_at DESC
    `).all().forEach(p => rows.push([p.payment_date, p.supplier_name, p.invoice_no || "", p.amount, p.method, p.reference_no, p.note]));
  } else if (type === "Profit") {
    filename = "profit-report";
    rows = [["Date", "Challan No", "Product", "Qty Sold", "Revenue", "Cost", "Profit"]];
    const items = db.prepare(`
      SELECT ii.product_id, ii.name, ii.pieces, ii.qty*ii.rate AS revenue, i.date, i.challan_no
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.voided = 0 AND i.doc_type = 'invoice' ORDER BY i.created_at DESC
    `).all();
    items.forEach(it => {
      const c = it.product_id ? getLatestCost(it.product_id) : null;
      const cost = round2((c ? c.costPrice : 0) * (it.pieces || 0));
      rows.push([it.date, it.challan_no, it.name, it.pieces, round2(it.revenue), cost, round2(it.revenue - cost)]);
    });
  } else {
    filename = "gst-report";
    rows = [["Challan No", "Date", "Tax Type", "CGST", "SGST", "IGST"]];
    db.prepare("SELECT * FROM invoices WHERE voided = 0 AND doc_type = 'invoice' ORDER BY created_at DESC").all()
      .forEach(inv => rows.push([inv.challan_no, inv.date, inv.tax_type, round2(inv.cgst), round2(inv.sgst), round2(inv.igst)]));
  }

  // A real .xlsx (not CSV renamed) — see server/xlsx.js for why this is
  // hand-built rather than an npm dependency.
  const buf = buildXlsx(rows, filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

module.exports = router;
