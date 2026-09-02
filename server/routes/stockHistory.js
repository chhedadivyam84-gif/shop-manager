/* ============================================================
   STOCK HISTORY — reading the ledger

   Read-only, deliberately. There is no route here to change or remove a
   movement, and there should not be: a stock history that can be edited
   answers "how much is there" with whatever somebody last typed. A
   mistaken entry is corrected by making the opposite movement, which
   leaves both rows and explains itself.
   ============================================================ */

const express = require("express");
const db = require("../db");
const ledger = require("../stockLedger");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

/** What the filter dropdowns need, so the screen never invents its own. */
router.get("/meta", (req, res) => {
  res.json({
    movements: ledger.MOVEMENTS,
    locations: db.prepare("SELECT id, name, code FROM locations ORDER BY name").all(),
    brands: db.prepare(
      "SELECT DISTINCT brand FROM products WHERE TRIM(COALESCE(brand,'')) <> '' ORDER BY brand"
    ).all().map(r => r.brand),
    categories: db.prepare(
      "SELECT DISTINCT category FROM products WHERE TRIM(COALESCE(category,'')) <> '' ORDER BY category"
    ).all().map(r => r.category),
    staff: db.prepare(
      "SELECT DISTINCT staff FROM stock_ledger WHERE TRIM(COALESCE(staff,'')) <> '' ORDER BY staff"
    ).all().map(r => r.staff)
  });
});

router.get("/", (req, res) => {
  try {
    res.json(ledger.query(req.query));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** One movement, for the detail view. */
router.get("/:id", (req, res) => {
  const r = ledger.query({ limit: 2000 }).rows.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "That stock entry was not found." });
  res.json(r);
});

/* The same rows the screen is showing, as a spreadsheet. Mirrors the list
   filters exactly — exporting while filtered used to hand back everything,
   which is how a shop ends up mailing the wrong month to its accountant. */
router.get("/export/xlsx", (req, res) => {
  const { rows } = ledger.query({ ...req.query, limit: 2000 });
  const out = [[
    "Date", "Time", "Product", "Brand", "Category", "Size", "Movement",
    "Quantity", "Previous Stock", "New Stock", "Where", "Reference No.",
    "Reference Type", "Entered By", "Remarks"
  ]];
  const label = k => (ledger.MOVEMENTS.find(m => m.key === k) || {}).label || k;
  rows.forEach(r => out.push([
    r.date, r.time, r.product_name || "", r.brand || "", r.category || "",
    r.size_label || "", label(r.movement), r.qty, r.prev_qty, r.new_qty,
    r.location_name || "", r.ref_no || "", r.ref_type || "",
    r.staff || "", r.remarks || ""
  ]));
  const name = "stock-history-" + (req.query.from || "all") + "-to-" + (req.query.to || "date");
  const buf = buildXlsx(out, name);
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(buf);
});

module.exports = router;
