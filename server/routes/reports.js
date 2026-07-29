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
