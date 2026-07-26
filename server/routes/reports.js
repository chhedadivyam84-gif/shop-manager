const express = require("express");
const db = require("../db");
const { todayStr, round2 } = require("../util");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

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
  const latestCostStmt = db.prepare(
    "SELECT cost_price FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 1"
  );
  const todaysProfit = Math.round(todaysItems.reduce((s, it) => {
    const c = it.product_id ? latestCostStmt.get(it.product_id) : null;
    return s + (it.revenue - (c ? c.cost_price * it.pieces : 0));
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

/** Every purchase entry, newest first — the Purchase Report. */
router.get("/purchases", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM stock_ins ORDER BY created_at DESC
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
 * Profit per sold item: revenue (pre-tax line amount) minus a cost basis
 * pulled from the most recent PURCHASE on file for that product (cost_price
 * is per physical piece, already inclusive of transport — see stock-in).
 * A product never purchased through this app (e.g. opening stock typed
 * straight into Inventory) has no cost on file and shows cost 0 / profit =
 * full revenue, which is flagged in the row rather than silently guessed at.
 */
router.get("/profit", (req, res) => {
  const items = db.prepare(`
    SELECT ii.product_id, ii.name, ii.pieces, ii.qty, ii.rate, ii.qty*ii.rate AS revenue,
      i.date, i.challan_no
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 AND i.doc_type = 'invoice'
    ORDER BY i.created_at DESC
  `).all();

  const latestCost = db.prepare(`
    SELECT cost_price FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 1
  `);

  let totalRevenue = 0, totalCost = 0;
  const rows = items.map(it => {
    const costRow = it.product_id ? latestCost.get(it.product_id) : null;
    const hasCost = !!costRow;
    const cost = round2((costRow ? costRow.cost_price : 0) * (it.pieces || 0));
    const profit = round2(it.revenue - cost);
    totalRevenue += it.revenue; totalCost += cost;
    return { ...it, cost, profit, hasCost };
  });

  res.json({
    rows,
    totalRevenue: round2(totalRevenue),
    totalCost: round2(totalCost),
    totalProfit: round2(totalRevenue - totalCost)
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
    const latestCostStmt = db.prepare("SELECT cost_price FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 1");
    items.forEach(it => {
      const c = it.product_id ? latestCostStmt.get(it.product_id) : null;
      const cost = round2((c ? c.cost_price : 0) * (it.pieces || 0));
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
