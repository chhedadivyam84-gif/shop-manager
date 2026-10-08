/* ============================================================
   ADMIN PRODUCTS & INVENTORY — reading the shelves

   THE ONE FACT THAT SHAPES THIS WHOLE FILE: stock does not live on a
   product. It lives on a SIZE, at a LOCATION.

       products          what it is          (name, brand, category, SKU)
       product_sizes     what you can buy    (label, price, cost_price)
       size_location_stock  how many, where  (quantity, min_stock)

   products.stock is a DENORMALISED SUM of the sizes, kept in step by
   inventory.syncSizeStockTotal so the older reports that read it keep
   working. Nothing here writes it, and nothing here treats it as the
   truth: a screen that says "40 in stock" without saying 40 of WHICH
   SIZE and WHERE is a screen that will be wrong the first time an 8x4
   sells and a 7x4 does not.

   NOTHING IN THIS FILE WRITES. No INSERT, no UPDATE, no DELETE. The two
   things an admin may change — a product's details and a size's count —
   go through routes/products.js's own handlers, which already carry the
   rules: the transaction, the clamp at zero, the in-place size update
   that keeps a sold invoice's size link alive, and the stock ledger
   entry that records what the count was before and after.

   WHAT THE SHOP CANNOT TELL US, and is therefore not shown:

     A SINGLE "TOTAL STOCK" FIGURE. Board is counted in square feet,
     handles in pieces. Summing the column gives a number that is not a
     quantity of anything. Counts are reported per unit instead.

     A LOW-STOCK RULE WHERE NOBODY SET ONE. min_stock is real and
     per-size, per-location (inventory.setMinStock). Where it is zero,
     nobody has said what "low" means for that item and this module
     does NOT guess — notably it does not copy the shop dashboard's
     hard-coded `stock < 15`, which is one number for a shop selling
     both plywood sheets and screws.
   ============================================================ */
const db = require("./db");
const { localDate, round2 } = require("./util");

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/* How many days counts as "recently moved", stated on screen rather
   than hidden inside a query. */
const RECENT_DAYS = 7;

function daysAgoMs(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function likeTerm(q) {
  return "%" + String(q).replace(/[\\%_]/g, c => "\\" + c) + "%";
}

/* ------------------------------------------------------------------
   STOCK STATUS

   Three states, and a fourth that is the honest answer when the shop
   has not configured a threshold.

     out      nothing on the shelf
     low      at or below the minimum SOMEBODY ACTUALLY SET
     in       above it
     unset    there is stock, and no minimum to judge it against

   "unset" is not a failure. Most shops never set a minimum for most
   lines, and calling those "in stock" would quietly imply a judgement
   nobody made.
   ------------------------------------------------------------------ */
const STATUSES = [
  { key: "out",   label: "Out of stock" },
  { key: "low",   label: "Low stock" },
  { key: "in",    label: "In stock" },
  { key: "unset", label: "No minimum set" },
];

function statusOf(quantity, minStock) {
  const q = Number(quantity) || 0;
  const m = Number(minStock) || 0;
  if (q <= 0) return "out";
  if (m > 0) return q <= m ? "low" : "in";
  return "unset";
}

/* The per-size stock summary, as ONE grouped pass over
   size_location_stock rather than a query per size. */
const STOCK_JOIN = `
  LEFT JOIN (
    SELECT size_id,
           COALESCE(SUM(quantity), 0) AS qty,
           COALESCE(MAX(min_stock), 0) AS min_stock,
           MAX(last_updated)          AS moved_at
      FROM size_location_stock
     GROUP BY size_id
  ) sl ON sl.size_id = ps.id`;

/* And the per-PRODUCT roll-up, one pass over sizes joined to that. */
const PRODUCT_STOCK_JOIN = `
  LEFT JOIN (
    SELECT ps.product_id,
           COUNT(ps.id)                      AS size_count,
           COALESCE(SUM(sl.qty), 0)          AS qty,
           COALESCE(SUM(CASE WHEN COALESCE(sl.qty,0) <= 0 THEN 1 ELSE 0 END), 0)        AS out_sizes,
           COALESCE(SUM(CASE WHEN COALESCE(sl.min_stock,0) > 0
                              AND COALESCE(sl.qty,0) > 0
                              AND COALESCE(sl.qty,0) <= sl.min_stock
                             THEN 1 ELSE 0 END), 0)                                     AS low_sizes,
           COALESCE(SUM(CASE WHEN COALESCE(sl.min_stock,0) > 0 THEN 1 ELSE 0 END), 0)   AS with_min,
           MIN(ps.price)                     AS min_price,
           MAX(ps.price)                     AS max_price,
           MAX(sl.moved_at)                  AS moved_at
      FROM product_sizes ps ${STOCK_JOIN}
     GROUP BY ps.product_id
  ) st ON st.product_id = p.id`;

/* ------------------------------------------------------------------
   FILTERS

   Each answerable from the records. There is no "slow mover" and no
   "overstocked", because nothing here knows either.
   ------------------------------------------------------------------ */
const FILTERS = {
  all:       { label: "All products",        where: null },
  active:    { label: "Active",              where: "COALESCE(p.active, 1) = 1" },
  inactive:  { label: "Switched off",        where: "COALESCE(p.active, 1) = 0" },
  out:       { label: "Out of stock",        where: "COALESCE(st.qty, 0) <= 0" },
  low:       { label: "Low stock",           where: "COALESCE(st.low_sizes, 0) > 0" },
  nomin:     { label: "No minimum set",      where: "COALESCE(st.with_min, 0) = 0" },
  moved:     { label: "Moved recently",      where: "st.moved_at >= :recentSince" },
};

const SORTS = {
  name:    { label: "Name",           sql: "p.name COLLATE NOCASE ASC" },
  stock:   { label: "Least stock",    sql: "COALESCE(st.qty, 0) ASC, p.name COLLATE NOCASE ASC" },
  stockhi: { label: "Most stock",     sql: "COALESCE(st.qty, 0) DESC, p.name COLLATE NOCASE ASC" },
  moved:   { label: "Last moved",     sql: "st.moved_at DESC NULLS LAST, p.name COLLATE NOCASE ASC" },
  category:{ label: "Category",       sql: "p.category COLLATE NOCASE ASC, p.name COLLATE NOCASE ASC" },
  recent:  { label: "Newest",         sql: "p.created_at DESC" },
};

function categories() {
  try {
    return db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(category), ''), '(none)') AS name, COUNT(*) AS n
        FROM products WHERE COALESCE(active, 1) = 1
       GROUP BY name ORDER BY name COLLATE NOCASE ASC`).all();
  } catch (e) { return []; }
}

function locations() {
  try {
    return db.prepare(
      "SELECT id, code, name FROM locations WHERE active = 1 ORDER BY sort_order ASC, name ASC").all();
  } catch (e) { return []; }
}

function describeOptions() {
  return {
    filters: Object.keys(FILTERS).map(k => ({ key: k, label: FILTERS[k].label })),
    sorts: Object.keys(SORTS).map(k => ({ key: k, label: SORTS[k].label })),
    statuses: STATUSES,
    categories: categories(),
    locations: locations(),
    recentDays: RECENT_DAYS,
    pageSize: PAGE_SIZE,
  };
}

/* ------------------------------------------------------------------
   THE LIST
   ------------------------------------------------------------------ */
function list(opts) {
  const o = opts || {};
  const q = String(o.q || "").trim();
  const category = String(o.category || "").trim();
  const filter = Object.prototype.hasOwnProperty.call(FILTERS, o.filter) ? o.filter : "all";
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "name";

  const size = Math.min(Math.max(Number(o.pageSize) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(o.page) || 1, 1);

  const where = [];
  const params = [];

  if (q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\'" +
               " OR p.code LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\'" +
               " OR p.category LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\'" +
               " OR p.id LIKE ? ESCAPE '\\')");
    const t = likeTerm(q);
    params.push(t, t, t, t, t, t, t);
  }

  if (category) {
    if (category === "(none)") where.push("COALESCE(NULLIF(TRIM(p.category), ''), '') = ''");
    else { where.push("p.category = ?"); params.push(category); }
  }

  const f = FILTERS[filter];
  if (f.where) {
    let clause = f.where;
    if (clause.includes(":recentSince")) {
      clause = clause.replace(":recentSince", "?");
      params.push(daysAgoMs(RECENT_DAYS));
    }
    where.push(clause);
  }

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM products p ${PRODUCT_STOCK_JOIN}${whereSql}`).get(...params).n;

  const pages = Math.max(Math.ceil(total / size), 1);
  const safePage = Math.min(page, pages);

  const rows = db.prepare(`
    SELECT p.id, p.name, p.brand, p.category, p.sku, p.code, p.unit, p.uqc,
           p.gst_rate, p.created_at, COALESCE(p.active, 1) AS active,
           COALESCE(st.size_count, 0) AS size_count,
           COALESCE(st.qty, 0)        AS qty,
           COALESCE(st.out_sizes, 0)  AS out_sizes,
           COALESCE(st.low_sizes, 0)  AS low_sizes,
           COALESCE(st.with_min, 0)   AS with_min,
           st.min_price, st.max_price, st.moved_at
      FROM products p ${PRODUCT_STOCK_JOIN}${whereSql}
     ORDER BY ${SORTS[sort].sql}
     LIMIT ? OFFSET ?`).all(...params, size, (safePage - 1) * size);

  return {
    total, page: safePage, pages, pageSize: size,
    q, filter, sort, category,
    rows: rows.map(shapeRow),
    options: describeOptions(),
  };
}

/* A product-level status. A product is only "in stock" when none of its
   sizes is out and none is low — anything else and the worst case is
   what the shop needs to see. */
/**
 * A product's overall state, from its sizes.
 *
 * The first version of this called a product "out of stock" as soon as
 * ANY of its sizes was empty, which produced the line
 * "Commercial Ply 12mm — Out of stock — 270 Sq.ft": true of one size
 * and plainly false of the product, and the sort of thing that teaches
 * an owner to stop trusting the column.
 *
 * So "out" now means there is genuinely nothing to sell — no sizes at
 * all, or nothing left across every one of them. A product with some
 * sizes empty and others stocked is "low": something needs attention,
 * which is what the shop actually needs to know, and the Sizes column
 * says how many are out.
 */
function rollUpStatus(r) {
  if (r.size_count === 0) return "out";
  if (r.qty <= 0) return "out";
  if (r.out_sizes >= r.size_count) return "out";
  if (r.out_sizes > 0 || r.low_sizes > 0) return "low";
  if (r.with_min === 0) return "unset";
  return "in";
}

function shapeRow(r) {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand || "",
    category: r.category || "",
    sku: r.sku || "",
    code: r.code || "",
    unit: r.unit || "",
    gstRate: r.gst_rate,
    active: !!r.active,
    sizes: r.size_count,
    /* Quantity carries its unit because the number alone is ambiguous
       across a catalogue that mixes square feet and pieces. */
    qty: round2(r.qty),
    unitLabel: r.unit || "",
    outSizes: r.out_sizes,
    lowSizes: r.low_sizes,
    minimumsSet: r.with_min,
    status: rollUpStatus(r),
    priceFrom: r.min_price === null ? null : round2(r.min_price),
    priceTo: r.max_price === null ? null : round2(r.max_price),
    lastMoved: r.moved_at ? localDate(r.moved_at) : null,
    created: localDate(r.created_at),
  };
}

/* ------------------------------------------------------------------
   ONE PRODUCT

   Null for an id this company does not have — `db` is bound to the
   session's company, so another shop's product is simply not in the
   file being read.
   ------------------------------------------------------------------ */
function profile(id) {
  const p = db.prepare(`
    SELECT id, name, brand, category, sub_category, sku, code, barcode, unit, uqc,
           hsn_code, gst_rate, stock, godown, rack, default_mode,
           length_ft, width_val, thickness_in, created_at, opening_stock_date,
           COALESCE(active, 1) AS active
      FROM products WHERE id = ?`).get(id);
  if (!p) return null;

  const sizes = db.prepare(`
    SELECT ps.id, ps.label, ps.price, ps.cost_price, ps.barcode, ps.sort_order,
           ps.stock AS denormalised,
           COALESCE(sl.qty, 0)       AS qty,
           COALESCE(sl.min_stock, 0) AS min_stock,
           sl.moved_at
      FROM product_sizes ps ${STOCK_JOIN}
     WHERE ps.product_id = ?
     ORDER BY ps.sort_order ASC, ps.id ASC`).all(id);

  /* Where each size actually sits. One query for every size of this
     product, not one per size. */
  const byLocation = sizes.length
    ? db.prepare(`
        SELECT sls.size_id, sls.location_id, l.name AS location, l.code,
               sls.quantity, sls.min_stock, sls.last_updated
          FROM size_location_stock sls
          JOIN locations l ON l.id = sls.location_id
         WHERE sls.size_id IN (${sizes.map(() => "?").join(",")})
           AND l.active = 1
         ORDER BY l.sort_order ASC, l.name ASC`).all(...sizes.map(s => s.id))
    : [];

  const locsBySize = new Map();
  byLocation.forEach(r => {
    if (!locsBySize.has(r.size_id)) locsBySize.set(r.size_id, []);
    locsBySize.get(r.size_id).push({
      locationId: r.location_id, location: r.location, code: r.code,
      quantity: round2(r.quantity), minStock: round2(r.min_stock),
      status: statusOf(r.quantity, r.min_stock),
      movedAt: r.last_updated || 0,
    });
  });

  const shaped = sizes.map(s => ({
    id: s.id,
    label: s.label,
    price: round2(s.price),
    cost: s.cost_price === null || s.cost_price === undefined ? null : round2(s.cost_price),
    barcode: s.barcode || "",
    qty: round2(s.qty),
    minStock: round2(s.min_stock),
    status: statusOf(s.qty, s.min_stock),
    lastMoved: s.moved_at ? localDate(s.moved_at) : null,
    locations: locsBySize.get(s.id) || [],
  }));

  return {
    product: {
      id: p.id, name: p.name, brand: p.brand || "", category: p.category || "",
      subCategory: p.sub_category || "", sku: p.sku || "", code: p.code || "",
      barcode: p.barcode || "", unit: p.unit || "", uqc: p.uqc || "",
      hsnCode: p.hsn_code || "", gstRate: p.gst_rate,
      godown: p.godown || "", rack: p.rack || "",
      defaultMode: p.default_mode || "",
      lengthFt: p.length_ft, widthVal: p.width_val, thicknessIn: p.thickness_in,
      active: !!p.active,
      created: localDate(p.created_at),
      openingStockDate: p.opening_stock_date || "",
      /* The denormalised product-level total, shown beside the sum of
         the sizes so a drift between them is visible rather than
         hidden. They should always agree. */
      denormalisedStock: round2(p.stock || 0),
    },

    sizes: shaped,

    summary: {
      sizes: shaped.length,
      qty: round2(shaped.reduce((t, s) => t + s.qty, 0)),
      unit: p.unit || "",
      out: shaped.filter(s => s.status === "out").length,
      low: shaped.filter(s => s.status === "low").length,
      minimumsSet: shaped.filter(s => s.minStock > 0).length,
      priceFrom: shaped.length ? Math.min(...shaped.map(s => s.price)) : null,
      priceTo: shaped.length ? Math.max(...shaped.map(s => s.price)) : null,
      /* Only where a cost was actually entered — a zero cost_price means
         "not recorded", not "free". */
      costed: shaped.filter(s => s.cost !== null && s.cost > 0).length,
    },

    history: historyFor({ productId: id, limit: 15 }).rows,
  };
}

/* ------------------------------------------------------------------
   INVENTORY OVERVIEW
   ------------------------------------------------------------------ */
function overview() {
  const one = (sql, params) => {
    try { const r = db.prepare(sql).get(...(params || [])); return r ? r.v : null; }
    catch (e) { return null; }
  };

  const products = one("SELECT COUNT(*) AS v FROM products WHERE COALESCE(active, 1) = 1");
  const sizes = one("SELECT COUNT(*) AS v FROM product_sizes");
  const minimums = one(
    "SELECT COUNT(*) AS v FROM size_location_stock WHERE COALESCE(min_stock, 0) > 0");

  const outSizes = one(`
    SELECT COUNT(*) AS v FROM product_sizes ps ${STOCK_JOIN}
     WHERE COALESCE(sl.qty, 0) <= 0`);

  const lowSizes = minimums === null || minimums === 0 ? null : one(`
    SELECT COUNT(*) AS v FROM product_sizes ps ${STOCK_JOIN}
     WHERE COALESCE(sl.min_stock, 0) > 0
       AND COALESCE(sl.qty, 0) > 0
       AND COALESCE(sl.qty, 0) <= sl.min_stock`);

  /* Quantities PER UNIT, never one grand total: adding square feet to
     pieces produces a number that measures nothing. */
  let byUnit = [];
  try {
    byUnit = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(p.unit), ''), 'Unspecified') AS unit,
             COALESCE(SUM(sl.qty), 0) AS qty,
             COUNT(DISTINCT p.id)     AS products
        FROM products p
        JOIN product_sizes ps ON ps.product_id = p.id
        ${STOCK_JOIN}
       WHERE COALESCE(p.active, 1) = 1
       GROUP BY unit ORDER BY qty DESC`).all()
      .map(r => ({ unit: r.unit, qty: round2(r.qty), products: r.products }));
  } catch (e) { byUnit = []; }

  /* By location, WITHOUT a quantity.
     The first version of this summed sls.quantity per location and
     printed "Shop 942" directly above the sentence saying quantities
     are never added across units — 942 being square feet, pieces,
     sheets and metres added together, which is exactly the number that
     sentence exists to rule out. A location is described by HOW MANY
     SIZES sit there and how many of them have run out; both are counts
     of things, and both are true. */
  let byLocation = [];
  try {
    byLocation = db.prepare(`
      SELECT l.id, l.name,
             COUNT(sls.size_id) AS sizes,
             COALESCE(SUM(CASE WHEN COALESCE(sls.quantity, 0) > 0 THEN 1 ELSE 0 END), 0) AS stocked
        FROM locations l
        LEFT JOIN size_location_stock sls ON sls.location_id = l.id
       WHERE l.active = 1
       GROUP BY l.id ORDER BY l.sort_order ASC, l.name ASC`).all()
      .map(r => ({ id: r.id, name: r.name, sizes: r.sizes, stocked: r.stocked }));
  } catch (e) { byLocation = []; }

  const movedRecently = one(
    "SELECT COUNT(*) AS v FROM stock_ledger WHERE at >= ?", [daysAgoMs(RECENT_DAYS)]);

  return {
    products, sizes,
    outSizes,
    lowSizes,
    minimumsSet: minimums,
    /* The honest shape of "we cannot tell you how many are low". */
    lowAvailable: !(minimums === null || minimums === 0),
    byUnit, byLocation,
    movedRecently, recentDays: RECENT_DAYS,
    categories: categories().length,
  };
}

/* ------------------------------------------------------------------
   INVENTORY HISTORY

   The stock_ledger, which this app has had all along — so this is a
   real movement history, not a placeholder. Every row already carries
   what an audit needs: the size, the location, the movement, the
   quantity, what the count was BEFORE and AFTER, who did it, what
   document it belonged to, and when.

   The product's name is joined live rather than copied onto the row, so
   a renamed product reads under its current name throughout its past.
   ------------------------------------------------------------------ */
function historyFor(f) {
  const o = f || {};
  const size = Math.min(Math.max(Number(o.limit) || 25, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(o.page) || 1, 1);

  const where = [];
  const params = [];

  if (o.productId) { where.push("sl.product_id = ?"); params.push(String(o.productId)); }
  if (o.sizeId)    { where.push("sl.size_id = ?");    params.push(Number(o.sizeId)); }
  if (o.movement)  { where.push("sl.movement = ?");   params.push(String(o.movement)); }
  if (o.from)      { where.push("sl.date >= ?");      params.push(String(o.from)); }
  if (o.to)        { where.push("sl.date <= ?");      params.push(String(o.to)); }

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  let total = 0, rows = [];
  try {
    total = db.prepare(`SELECT COUNT(*) AS n FROM stock_ledger sl${whereSql}`).get(...params).n;
    rows = db.prepare(`
      SELECT sl.id, sl.at, sl.date, sl.time, sl.movement, sl.qty,
             sl.prev_qty, sl.new_qty, sl.ref_type, sl.ref_no, sl.staff, sl.remarks,
             sl.size_id, sl.product_id,
             p.name AS product, ps.label AS size, l.name AS location
        FROM stock_ledger sl
        LEFT JOIN products p ON p.id = sl.product_id
        LEFT JOIN product_sizes ps ON ps.id = sl.size_id
        LEFT JOIN locations l ON l.id = sl.location_id
        ${whereSql}
       ORDER BY sl.at DESC
       LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  } catch (e) {
    return { available: false, total: 0, rows: [], page: 1, pages: 1,
             reason: "This copy has no stock movement log." };
  }

  return {
    available: true,
    total,
    page,
    pages: Math.max(Math.ceil(total / size), 1),
    pageSize: size,
    rows: rows.map(r => ({
      id: r.id,
      at: r.at,
      date: r.date,
      time: r.time || "",
      movement: r.movement || "",
      /* The three figures that make a line auditable on its own. */
      qty: round2(r.qty),
      before: round2(r.prev_qty),
      after: round2(r.new_qty),
      product: r.product || "",
      productId: r.product_id || "",
      size: r.size || "",
      location: r.location || "",
      ref: [r.ref_type, r.ref_no].filter(Boolean).join(" "),
      staff: r.staff || "",
      remarks: r.remarks || "",
    })),
  };
}

function movementTypes() {
  try { return require("./stockLedger").MOVEMENTS; }
  catch (e) { return []; }
}

module.exports = {
  PAGE_SIZE, MAX_PAGE_SIZE, RECENT_DAYS,
  FILTERS, SORTS, STATUSES,
  statusOf, rollUpStatus, describeOptions, categories, locations,
  list, profile, overview, historyFor, movementTypes, likeTerm,
};
