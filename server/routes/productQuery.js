// Product Query — one search screen that answers "what is this product, where is
// it, and everything that has ever moved it".
//
// Rows are per SIZE, not per product: in a plywood shop one product name covers
// sizes whose stock, cost and value differ by an order of magnitude, so a
// product-level row would average away the only numbers the owner cares about.
//
// Opening Stock is DERIVED (closing - in + out) rather than stored. There is no
// opening-quantity column anywhere: what the owner typed at product creation was
// pushed straight into size_location_stock. Deriving it keeps the row
// self-consistent — opening + in - out always equals the closing figure shown
// beside it, whatever the date filter.
const express = require("express");
const db = require("../db");

const router = express.Router();

function like(v) {
  return "%" + String(v || "").trim().toLowerCase() + "%";
}
function has(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

// Movement sources, unified. Every branch yields the same shape so the ledger and
// the summary can share one definition of "what counts as a movement" — the
// commonest way these two screens disagree is by each maintaining its own list.
//
// direction: +1 adds to stock, -1 removes. Voided documents are excluded at the
// source, not filtered later, so they never reach a total.
const MOVEMENTS = [
  {
    kind: "Stock In",
    dir: 1,
    sql: `
      SELECT si.size_id                                   AS size_id,
             si.product_id                                AS product_id,
             COALESCE(NULLIF(si.purchase_date,''), date(si.created_at/1000,'unixepoch','localtime')) AS date,
             COALESCE(NULLIF(si.invoice_no,''), 'Stock In') AS voucher,
             COALESCE(NULLIF(si.supplier,''), s.name, '')   AS party,
             si.qty                                       AS qty,
             si.cost_price                                AS rate,
             si.location_id                               AS location_id,
             si.created_at                                AS ord,
             si.id                                        AS rid
        FROM stock_ins si
        LEFT JOIN suppliers s ON s.id = si.supplier_id`
  },
  {
    kind: "Purchase",
    dir: 1,
    sql: `
      SELECT pi.size_id, pi.product_id, p.date,
             COALESCE(NULLIF(p.purchase_no,''), NULLIF(p.supplier_invoice_no,''), 'Purchase') AS voucher,
             COALESCE(s.name,'') AS party,
             pi.qty, pi.rate, p.location_id, p.created_at AS ord, pi.id AS rid
        FROM purchase_items pi
        JOIN purchases p ON p.id = pi.purchase_id
        LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE COALESCE(p.voided,0) = 0`
  },
  {
    kind: "Sale",
    dir: -1,
    sql: `
      SELECT ii.size_id, ii.product_id, i.date,
             COALESCE(NULLIF(i.challan_no,''), 'Sale') AS voucher,
             COALESCE(c.name,'') AS party,
             ii.qty, ii.rate, i.location_id, i.created_at AS ord, ii.id AS rid
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        LEFT JOIN customers c ON c.id = i.customer_id
       WHERE COALESCE(i.voided,0) = 0`
  },
  {
    kind: "Sales Return",
    dir: 1,
    sql: `
      SELECT ri.size_id, ri.product_id, r.date,
             COALESCE(NULLIF(r.return_no,''), 'Sales Return') AS voucher,
             COALESCE(c.name,'') AS party,
             ri.qty, ri.rate, r.location_id, r.created_at AS ord, ri.id AS rid
        FROM sales_return_items ri
        JOIN sales_returns r ON r.id = ri.return_id
        LEFT JOIN customers c ON c.id = r.customer_id
       WHERE COALESCE(r.voided,0) = 0`
  },
  {
    kind: "Purchase Return",
    dir: -1,
    sql: `
      SELECT ri.size_id, ri.product_id, r.date,
             COALESCE(NULLIF(r.return_no,''), 'Purchase Return') AS voucher,
             COALESCE(s.name,'') AS party,
             ri.qty, ri.rate, r.location_id, r.created_at AS ord, ri.id AS rid
        FROM purchase_return_items ri
        JOIN purchase_returns r ON r.id = ri.return_id
        LEFT JOIN suppliers s ON s.id = r.supplier_id
       WHERE COALESCE(r.voided,0) = 0`
  }
];

function movementUnion() {
  return MOVEMENTS
    .map(m => `SELECT '${m.kind}' AS kind, ${m.dir} AS dir, * FROM (${m.sql})`)
    .join("\n      UNION ALL\n      ");
}

// ---------------------------------------------------------------------------
// GET /api/product-query  — the search
// ---------------------------------------------------------------------------
router.get("/", (req, res) => {
  const {
    q, name, code, barcode, brand, category, subCategory,
    size, location, from, to, stockFilter
  } = req.query;

  const where = [];
  const params = {};

  if (has(q)) {
    // The single box searches everything a person might have in hand: the label
    // on the sheet, the code on the rack, the barcode on the sticker.
    where.push(`(LOWER(p.name) LIKE @q OR LOWER(p.code) LIKE @q OR LOWER(p.sku) LIKE @q
                 OR LOWER(COALESCE(p.barcode,'')) LIKE @q OR LOWER(p.brand) LIKE @q
                 OR LOWER(p.category) LIKE @q OR LOWER(COALESCE(p.sub_category,'')) LIKE @q
                 OR LOWER(ps.label) LIKE @q)`);
    params.q = like(q);
  }
  if (has(name))        { where.push("LOWER(p.name) LIKE @name");           params.name = like(name); }
  if (has(code))        { where.push("(LOWER(p.code) LIKE @code OR LOWER(p.sku) LIKE @code)"); params.code = like(code); }
  if (has(barcode))     { where.push("LOWER(COALESCE(p.barcode,'')) LIKE @barcode"); params.barcode = like(barcode); }
  if (has(brand))       { where.push("LOWER(p.brand) LIKE @brand");         params.brand = like(brand); }
  if (has(category))    { where.push("LOWER(p.category) LIKE @category");   params.category = like(category); }
  if (has(subCategory)) { where.push("LOWER(COALESCE(p.sub_category,'')) LIKE @subCategory"); params.subCategory = like(subCategory); }
  if (has(size))        { where.push("LOWER(ps.label) LIKE @size");         params.size = like(size); }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  // Closing stock respects the location filter; movements do not, because a
  // purchase into the Warehouse is still part of that size's purchase history.
  const locFilter = has(location) ? "AND sls.location_id = @location" : "";
  if (has(location)) params.location = String(location);

  const dateFilter = [];
  if (has(from)) { dateFilter.push("m.date >= @from"); params.from = String(from); }
  if (has(to))   { dateFilter.push("m.date <= @to");   params.to = String(to); }
  const dateSql = dateFilter.length ? "AND " + dateFilter.join(" AND ") : "";

  const sql = `
    WITH mv AS (${movementUnion()})
    SELECT
      p.id                AS product_id,
      p.name              AS product_name,
      p.brand             AS brand,
      p.category          AS category,
      COALESCE(p.sub_category,'') AS sub_category,
      COALESCE(p.barcode,'')      AS barcode,
      COALESCE(p.code, p.sku, '') AS code,
      p.unit              AS unit,
      COALESCE(p.opening_stock_date,'') AS opening_stock_date,
      ps.id               AS size_id,
      ps.label            AS size_label,
      ps.price            AS sale_rate,
      ps.cost_price       AS cost_rate,
      (SELECT COALESCE(SUM(sls.quantity),0) FROM size_location_stock sls
        WHERE sls.size_id = ps.id ${locFilter})                       AS closing_stock,
      (SELECT COALESCE(SUM(sls.quantity),0) FROM size_location_stock sls
        WHERE sls.size_id = ps.id AND sls.location_id = 'LOC_shop')   AS shop_stock,
      (SELECT COALESCE(SUM(sls.quantity),0) FROM size_location_stock sls
        WHERE sls.size_id = ps.id AND sls.location_id = 'LOC_warehouse') AS warehouse_stock,
      (SELECT COALESCE(SUM(m.qty),0) FROM mv m
        WHERE m.size_id = ps.id AND m.dir = 1 ${dateSql})             AS stock_in,
      (SELECT COALESCE(SUM(m.qty),0) FROM mv m
        WHERE m.size_id = ps.id AND m.dir = -1 ${dateSql})            AS stock_out,
      (SELECT MAX(m.date) FROM mv m
        WHERE m.size_id = ps.id AND m.kind IN ('Purchase','Stock In')) AS last_purchase_date,
      (SELECT MAX(m.date) FROM mv m
        WHERE m.size_id = ps.id AND m.kind = 'Sale')                   AS last_sale_date,
      (SELECT m.rate FROM mv m
        WHERE m.size_id = ps.id AND m.kind IN ('Purchase','Stock In')
        ORDER BY m.date DESC, m.ord DESC LIMIT 1)                      AS last_purchase_rate
    FROM products p
    JOIN product_sizes ps ON ps.product_id = p.id
    ${whereSql}
    ORDER BY p.name ASC, ps.sort_order ASC
    LIMIT 500
  `;

  let rows;
  try {
    rows = db.prepare(sql).all(params);
  } catch (e) {
    return res.status(500).json({ error: "Query failed: " + e.message });
  }

  const out = rows.map(r => {
    // Purchase Rate prefers what was actually last paid; the typed cost_price is
    // the fallback for a product that has only ever had an opening balance.
    const purchaseRate = r.last_purchase_rate != null && r.last_purchase_rate > 0
      ? r.last_purchase_rate
      : (r.cost_rate || 0);
    return {
      productId: r.product_id,
      productName: r.product_name,
      brand: r.brand,
      category: r.category,
      subCategory: r.sub_category,
      barcode: r.barcode,
      code: r.code,
      unit: r.unit,
      sizeId: r.size_id,
      sizeLabel: r.size_label,
      openingStockDate: r.opening_stock_date,
      stockIn: r.stock_in || 0,
      stockOut: r.stock_out || 0,
      openingStock: (r.closing_stock || 0) - (r.stock_in || 0) + (r.stock_out || 0),
      closingStock: r.closing_stock || 0,
      shopStock: r.shop_stock || 0,
      warehouseStock: r.warehouse_stock || 0,
      purchaseRate: purchaseRate,
      saleRate: r.sale_rate || 0,
      stockValue: Math.round((r.closing_stock || 0) * purchaseRate * 100) / 100,
      lastPurchaseDate: r.last_purchase_date || "",
      lastSaleDate: r.last_sale_date || ""
    };
  });

  const filtered = stockFilter === "inStock"  ? out.filter(r => r.closingStock > 0)
                 : stockFilter === "outStock" ? out.filter(r => r.closingStock <= 0)
                 : out;

  res.json({
    rows: filtered,
    totals: {
      lines: filtered.length,
      closingStock: filtered.reduce((s, r) => s + r.closingStock, 0),
      stockValue: Math.round(filtered.reduce((s, r) => s + r.stockValue, 0) * 100) / 100
    },
    truncated: rows.length >= 500
  });
});

// ---------------------------------------------------------------------------
// GET /api/product-query/filters — distinct values for the dropdowns
// ---------------------------------------------------------------------------
router.get("/filters", (_req, res) => {
  const col = c => db.prepare(
    `SELECT DISTINCT ${c} AS v FROM products WHERE COALESCE(${c},'') <> '' ORDER BY v ASC`
  ).all().map(r => r.v);
  res.json({
    brands: col("brand"),
    categories: col("category"),
    subCategories: col("sub_category"),
    units: col("unit"),
    locations: db.prepare("SELECT id, name FROM locations ORDER BY sort_order ASC").all()
  });
});

// ---------------------------------------------------------------------------
// GET /api/product-query/ledger/:productId — running stock ledger
// ---------------------------------------------------------------------------
router.get("/ledger/:productId", (req, res) => {
  const { sizeId, from, to } = req.query;
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.productId);
  if (!p) return res.status(404).json({ error: "Product not found" });

  const params = { pid: p.id };
  let scope = "m.product_id = @pid";
  if (has(sizeId)) { scope += " AND m.size_id = @sizeId"; params.sizeId = Number(sizeId); }

  const rows = db.prepare(`
    WITH mv AS (${movementUnion()})
    SELECT m.kind, m.dir, m.date, m.voucher, m.party, m.qty, m.rate, m.size_id, m.location_id
      FROM mv m
     WHERE ${scope}
     ORDER BY m.date ASC, m.ord ASC, m.rid ASC
  `).all(params);

  const sizeLabels = {};
  db.prepare("SELECT id, label FROM product_sizes WHERE product_id = ?").all(p.id)
    .forEach(s => { sizeLabels[s.id] = s.label; });
  const locNames = {};
  db.prepare("SELECT id, name FROM locations").all().forEach(l => { locNames[l.id] = l.name; });

  // The running balance is computed over the FULL history and only then trimmed
  // to the requested window, so the first visible row still shows the true stock
  // on hand rather than a balance that starts at zero mid-year.
  //
  // It starts at the DERIVED opening stock, not at zero. Opening stock was typed
  // straight into size_location_stock and left no movement row behind, so a
  // ledger that started at zero would close 6 short of the on-hand figure the
  // search screen shows for the very same product.
  const onHand = db.prepare(`
    SELECT COALESCE(SUM(sls.quantity),0) AS q
      FROM size_location_stock sls
      JOIN product_sizes ps ON ps.id = sls.size_id
     WHERE ps.product_id = @pid ${has(sizeId) ? "AND sls.size_id = @sizeId" : ""}
  `).get(params).q || 0;
  const netMovement = rows.reduce((sum, r) => sum + r.dir * (Number(r.qty) || 0), 0);

  let balance = Math.round((onHand - netMovement) * 1000) / 1000;
  const derivedOpening = balance;
  const all = rows.map(r => {
    const qty = Number(r.qty) || 0;
    balance += r.dir * qty;
    return {
      date: r.date || "",
      kind: r.kind,
      voucher: r.voucher || "",
      party: r.party || "",
      sizeLabel: sizeLabels[r.size_id] || "",
      locationName: locNames[r.location_id] || "",
      qtyIn: r.dir === 1 ? qty : 0,
      qtyOut: r.dir === -1 ? qty : 0,
      rate: Number(r.rate) || 0,
      amount: Math.round(qty * (Number(r.rate) || 0) * 100) / 100,
      balance: Math.round(balance * 1000) / 1000
    };
  });

  const visible = all.filter(r =>
    (!has(from) || r.date >= String(from)) && (!has(to) || r.date <= String(to))
  );
  // With no date filter this is the opening stock itself; with one, it is the
  // balance carried into the window.
  const openingBalance = visible.length
    ? Math.round((visible[0].balance - visible[0].qtyIn + visible[0].qtyOut) * 1000) / 1000
    : (all.length ? balance : derivedOpening);

  res.json({
    product: { id: p.id, name: p.name, brand: p.brand, category: p.category, unit: p.unit },
    openingBalance: Math.round(openingBalance * 1000) / 1000,
    closingBalance: Math.round(balance * 1000) / 1000,
    rows: visible
  });
});

module.exports = router;
