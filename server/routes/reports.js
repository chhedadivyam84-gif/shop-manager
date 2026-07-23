const express = require("express");
const db = require("../db");
const { todayStr } = require("../util");

const router = express.Router();

router.get("/dashboard", (req, res) => {
  const today = todayStr();
  const todaysInvoices = db.prepare("SELECT * FROM invoices WHERE date = ? AND voided = 0").all(today);
  const todaysSales = todaysInvoices.reduce((s, i) => s + i.total, 0);
  const todaysProfit = Math.round(todaysSales * 0.22);

  const customers = db.prepare("SELECT * FROM customers").all();
  const outstandingTotal = customers.reduce((s, c) => s + (c.due || 0), 0);
  const outstandingCount = customers.filter(c => c.due > 0).length;

  const products = db.prepare("SELECT * FROM products").all();
  const lowStockCount = products.filter(p => p.stock < 15).length;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const total = db.prepare("SELECT COALESCE(SUM(total),0) AS t FROM invoices WHERE date = ? AND voided = 0").get(key).t;
    days.push({ label: d.toLocaleDateString("en-IN", { weekday: "short" }), date: key, total });
  }

  const soldRows = db.prepare(`
    SELECT ii.name, SUM(ii.qty) AS units, SUM(ii.qty*ii.rate) AS revenue
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.voided = 0 GROUP BY ii.name ORDER BY units DESC LIMIT 4
  `).all();

  const topCustomers = db.prepare(`
    SELECT c.id, c.name, c.type, COALESCE(SUM(i.total),0) AS total
    FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.voided = 0
    GROUP BY c.id ORDER BY total DESC LIMIT 4
  `).all();

  const recentInvoices = db.prepare(`
    SELECT i.*, c.name AS customer_name FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0 ORDER BY i.created_at DESC LIMIT 5
  `).all();

  res.json({
    todaysSales, todaysProfit, outstandingTotal, outstandingCount, lowStockCount,
    revenueChart: days, bestSellers: soldRows, topCustomers, recentInvoices
  });
});

router.get("/sales-by-payment", (req, res) => {
  const rows = db.prepare(`
    SELECT payment_method AS label, COALESCE(SUM(total),0) AS value
    FROM invoices WHERE voided = 0 GROUP BY payment_method
  `).all();
  res.json(rows);
});

router.get("/gst", (req, res) => {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(igst),0) AS igst
    FROM invoices WHERE voided = 0
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

function toCsv(rows) {
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

router.get("/export", (req, res) => {
  const type = req.query.type || "Sales";
  let rows = [];
  let filename = "report.csv";

  if (type === "Sales") {
    filename = "sales-report.csv";
    rows = [["Challan No", "Date", "Customer", "Payment", "Total"]];
    const invoices = db.prepare(`
      SELECT i.*, c.name AS customer_name FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id WHERE i.voided = 0 ORDER BY i.created_at DESC
    `).all();
    invoices.forEach(inv => rows.push([inv.challan_no, inv.date, inv.customer_name || "Walk-in", inv.payment_method, inv.total]));
  } else if (type === "Stock") {
    filename = "stock-report.csv";
    rows = [["Product", "Brand", "SKU", "Stock", "Unit"]];
    db.prepare("SELECT * FROM products ORDER BY name").all().forEach(p => rows.push([p.name, p.brand, p.sku, p.stock, p.unit]));
  } else if (type === "Customer") {
    filename = "customer-report.csv";
    rows = [["Customer", "Type", "Phone", "Outstanding Due"]];
    db.prepare("SELECT * FROM customers ORDER BY name").all().forEach(c => rows.push([c.name, c.type, c.phone, c.due]));
  } else {
    filename = "gst-report.csv";
    rows = [["Challan No", "Date", "Tax Type", "CGST", "SGST", "IGST"]];
    db.prepare("SELECT * FROM invoices WHERE voided = 0 ORDER BY created_at DESC").all()
      .forEach(inv => rows.push([inv.challan_no, inv.date, inv.tax_type, inv.cgst.toFixed(2), inv.sgst.toFixed(2), inv.igst.toFixed(2)]));
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(toCsv(rows));
});

module.exports = router;
