/* ============================================================
   MATERIAL FLOW & DOCUMENT TRACKING — the API

   Owner only. It puts purchase cost, margin-adjacent figures and
   whole-company totals on one screen, all of which this app already treats
   as the owner's alone.
   ============================================================ */

const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { buildXlsx } = require("../xlsx");
const flow = require("../materialFlow");

const router = express.Router();

router.use(requireRole("owner"));

router.get("/meta", (req, res) => {
  res.json({
    suppliers: db.prepare(
      "SELECT id, name FROM suppliers ORDER BY name COLLATE NOCASE"
    ).all(),
    products: db.prepare(
      "SELECT id, name FROM products ORDER BY name COLLATE NOCASE"
    ).all()
  });
});

router.get("/", (req, res) => {
  try {
    res.json(flow.byDocument(req.query || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/export/xlsx", (req, res) => {
  const { rows } = flow.byDocument(req.query || {});
  const out = [[
    "Date", "Document", "Type", "Supplier", "Purchased Qty", "Purchased Value",
    "Via Sales Challan (qty)", "Via Sales Challan (value)",
    "Via Sales Invoice (qty)", "Via Sales Invoice (value)",
    "Remaining (qty)", "Remaining (value)"
  ]];
  rows.forEach(d => out.push([
    d.date, d.docNo, d.docType, d.party, d.qty, d.value,
    d.viaChallanQty, d.viaChallanValue,
    d.viaInvoiceQty, d.viaInvoiceValue,
    d.remainingQty, d.remainingValue
  ]));
  const name = "material-flow-" + (req.query.from || "all") + "-to-" + (req.query.to || "date");
  const buf = buildXlsx(out, name);
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(buf);
});

module.exports = router;
