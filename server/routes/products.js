const express = require("express");
const db = require("../db");
const { uid, logAction, todayStr, round2 } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");
const Pricing = require("../../public/js/pricing.js");

const router = express.Router();

/** Optional numeric field: blank/absent stays NULL rather than becoming 0. */
function dim(v, fallback) {
  if (v === undefined) return fallback === undefined ? null : fallback;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// `stock` on each size stays the existing denormalised cross-location total
// (unchanged shape, every existing screen keeps working) — `byLocation` is
// purely additive, the per-location breakdown the Inventory screen's
// Shop/Warehouse tabs need.
function loadSizes(productId) {
  const sizes = db.prepare("SELECT id, label, price, stock, cost_price, barcode FROM product_sizes WHERE product_id = ? ORDER BY sort_order ASC, id ASC").all(productId);
  sizes.forEach(s => { s.byLocation = inventory.getStockByLocation(s.id); });
  return sizes;
}

/**
 * A SKU as it goes on a label: "SKU-FK2EZB" becomes "FK2EZB".
 *
 * Those four characters carry no information — the random part is already
 * unique — and a barcode does not wrap, so they cost about 15mm of printed
 * width. That is the whole difference between a code that fits a 38mm
 * address label and one that fits nothing smaller than 66mm.
 */
function labelCode(sku) { return String(sku || "").replace(/^SKU-/i, ""); }

/**
 * The code that goes on this size's printed label.
 *
 * Stamped after the row exists, because it is built from the row's own id —
 * that is what makes it unique without a second uniqueness check, and what
 * makes it survive the size being renamed or reordered. A label already
 * stuck to a board has to go on meaning what it meant when it was printed.
 *
 * Never overwrites one that is already there.
 */
function stampSizeBarcode(sizeId, sku) {
  if (!sku) return;
  db.prepare("UPDATE product_sizes SET barcode = ? WHERE id = ? AND COALESCE(barcode,'') = ''")
    .run(labelCode(sku) + "-" + sizeId, sizeId);
}

function serialize(p) {
  return { ...p, gst: p.gst_rate, sizes: loadSizes(p.id) };
}

/**
 * The whole catalogue in three queries instead of three per product.
 *
 * serialize() above runs one query for a product's sizes and then one more
 * for every size's per-location stock. That is fine for one product, but the
 * list endpoint called it in a loop: a 2,400-product catalogue became roughly
 * 4,800 queries and took 4.6 seconds — on a request the app makes on almost
 * every screen. Here the sizes and the location rows are each fetched once
 * and grouped in memory.
 *
 * The output is identical, field for field and order for order, so nothing
 * downstream changes: same `gst` alias, same size ordering (sort_order then
 * id), same `byLocation` rows ordered by the location's sort_order, active
 * locations only.
 */
function serializeAll(products) {
  const sizes = db.prepare(
    "SELECT id, label, price, stock, cost_price, barcode, product_id FROM product_sizes ORDER BY sort_order ASC, id ASC"
  ).all();

  /* getStockByLocation() calls ensureAllLocationRows() first, so reading the
     stock is also what CREATES the row for a location a size has never been
     stocked at. Dropping that would quietly change the answer: a size added
     before a second location existed would come back with one location
     instead of two. Done here in one statement for every size at once,
     rather than one per size. */
  db.exec(`
    INSERT INTO size_location_stock (size_id, location_id, quantity, last_updated)
    SELECT s.id, l.id, 0, 0
    FROM product_sizes s CROSS JOIN locations l
    WHERE NOT EXISTS (
      SELECT 1 FROM size_location_stock x WHERE x.size_id = s.id AND x.location_id = l.id
    )
  `);

  const locRows = db.prepare(`
    SELECT sls.size_id, sls.quantity, sls.min_stock, sls.last_updated,
           l.id AS location_id, l.code, l.name
    FROM size_location_stock sls JOIN locations l ON l.id = sls.location_id
    WHERE l.active = 1
    ORDER BY l.sort_order ASC
  `).all();

  const byLoc = new Map();
  for (const r of locRows) {
    const { size_id, ...rest } = r;
    if (!byLoc.has(size_id)) byLoc.set(size_id, []);
    byLoc.get(size_id).push(rest);
  }

  const byProduct = new Map();
  for (const s of sizes) {
    const { product_id, ...rest } = s;
    rest.byLocation = byLoc.get(rest.id) || [];
    if (!byProduct.has(product_id)) byProduct.set(product_id, []);
    byProduct.get(product_id).push(rest);
  }

  return products.map(p => ({ ...p, gst: p.gst_rate, sizes: byProduct.get(p.id) || [] }));
}

/**
 * products.stock is a denormalised total of its sizes' stock, kept in sync
 * here rather than computed on every read — the alternative would be
 * rewriting every report/inventory query that already reads products.stock
 * directly to aggregate on the fly instead. Call this after ANY write that
 * changes a size's stock.
 */
function syncProductStock(productId) {
  const total = db.prepare(
    "SELECT COALESCE(SUM(stock),0) AS t FROM product_sizes WHERE product_id = ?"
  ).get(productId).t;
  db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(total, productId);
}

/** A YYYY-MM-DD date, or "" for anything else — the opening-stock date is
 *  documentation, so a malformed value is simply not recorded. */
function openingDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

/** Non-negative number, defaulting to 0 for blank/invalid input. */
function stockNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Makes a stock figure typed on the Add/Edit Product screen into REAL,
 * location-aware stock.
 *
 * Without this the number only ever landed in product_sizes.stock while
 * size_location_stock stayed empty, which broke two things badly:
 *   - Billing checks LOCATION stock, so a product showing "10 in stock"
 *     could not be sold at all — "Not enough Shop stock".
 *   - The first purchase for that size resynced the total from the location
 *     ledger and silently overwrote the typed figure (an opening 10 became 5
 *     after receiving 5).
 *
 * The difference is applied to SHOP — the same choice the one-time backfill in
 * db.js makes — and only the difference, so a quantity sitting in Warehouse is
 * never disturbed by someone correcting a count here.
 */
function applyTypedStock(sizeId, typedTotal) {
  const current = inventory.getStockByLocation(sizeId)
    .reduce((sum, l) => sum + (l.quantity || 0), 0);
  const delta = stockNum(typedTotal) - current;
  if (delta === 0) return;
  inventory.addStock(sizeId, inventory.getLocationByCode("shop").id, delta);
}

/**
 * Opening stock entered per location: Shop and Warehouse each get an exact
 * quantity rather than one lump sum landing in Shop.
 *
 * Set to the figure typed, by applying the difference — addStock is the only
 * write path, and going through it keeps product_sizes.stock resynced as the
 * sum across locations (see syncSizeStockTotal). A location the caller did not
 * mention is left exactly as it is, so a shop using only one of the two never
 * has the other silently zeroed.
 *
 * Returns the resulting total so the caller can keep products.stock in step.
 */
function applyTypedLocationStock(sizeId, perLocation) {
  const rows = inventory.getStockByLocation(sizeId);
  for (const row of rows) {
    const typed = perLocation[row.code];
    if (typed === undefined || typed === null || typed === "") continue;
    const delta = stockNum(typed) - (row.quantity || 0);
    if (delta !== 0) inventory.addStock(sizeId, row.location_id, delta);
  }
  return inventory.getStockByLocation(sizeId)
    .reduce((sum, l) => sum + (l.quantity || 0), 0);
}

/** True when the client sent per-location opening stock for this size. Keeps
 *  older callers (and the duplicate/import paths) on the single-total route. */
function hasLocationStock(s) {
  return s && (s.shopStock !== undefined || s.warehouseStock !== undefined);
}

router.get("/", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY name ASC").all();
  res.json(serializeAll(products));
});

/**
 * What did that scan just point at?
 *
 * Declared before "/:id" on purpose — Express takes the first route that
 * matches, and "/:id" would swallow "/scan" and go looking for a product
 * whose id is the word scan.
 *
 * FOUR PLACES ARE TRIED, most specific first, because a shop ends up with
 * codes from more than one source and the counter should not have to know
 * which kind it is holding:
 *
 *   1. the size's own printed code   — the useful one: names a rate and a
 *                                      count, so it becomes a bill line
 *   2. the product's manufacturer barcode — typed in by hand off the
 *                                      supplier's sticker
 *   3. the product's SKU            — what the label prints when a product
 *                                      has no sizes worth separating
 *   4. the product's own code        — the shop's internal reference
 *
 * Only 1 identifies a size. The rest identify a product, and the caller then
 * has to ask which size — which is why the answer says which it found rather
 * than pretending they are the same thing.
 */
router.get("/scan", (req, res) => {
  const raw = String(req.query.code || "").trim();
  if (!raw) return res.status(400).json({ error: "No code given." });

  /* Scanners append a newline and some prepend whitespace; case varies by how
     the code was typed in. Matching is done on the trimmed, case-folded form
     so a label read by a machine and one typed by a person agree. */
  const code = raw.toUpperCase();

  const size = db.prepare(`
    SELECT s.id, s.product_id, s.label, s.sort_order
      FROM product_sizes s
     WHERE UPPER(TRIM(COALESCE(s.barcode,''))) = ?
     LIMIT 1
  `).get(code);

  if (size) {
    const p = db.prepare("SELECT * FROM products WHERE id = ?").get(size.product_id);
    if (p) {
      const full = serialize(p);
      /* The INDEX, not the id: addToCart on the client takes a position in
         the product's own size list, and that list is ordered the same way
         loadSizes orders it. */
      const idx = full.sizes.findIndex(s => Number(s.id) === Number(size.id));
      return res.json({ found: "size", product: full, sizeId: size.id, sizeIndex: idx < 0 ? 0 : idx });
    }
  }

  const p = db.prepare(`
    SELECT * FROM products
     WHERE UPPER(TRIM(COALESCE(barcode,''))) = ?
        OR UPPER(TRIM(COALESCE(sku,'')))     = ?
        OR UPPER(TRIM(COALESCE(sku,'')))     = 'SKU-' || ?
        OR UPPER(TRIM(COALESCE(code,'')))    = ?
     LIMIT 1
  `).get(code, code, code, code);

  if (p) return res.json({ found: "product", product: serialize(p), sizeId: null, sizeIndex: null });

  /* 404 with the code echoed back, so the screen can say WHAT it did not
     recognise. "Not found" alone sends somebody hunting for a fault in the
     scanner when the real answer is that this board was never labelled. */
  res.status(404).json({ error: "No product carries the code " + raw, code: raw });
});

router.post("/", (req, res) => {
  const { name, brand, category, unit, gst, godown, rack, sizes,
          defaultMode, lengthFt, widthVal, thicknessIn, hsnCode, code, openingStockDate,
          barcode, subCategory } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Product name is required." });
  }
  const validSizes = Array.isArray(sizes)
    ? sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)))
    : [];
  if (!validSizes.length) {
    return res.status(400).json({ error: "Add at least one size/variant with a price." });
  }
  const id = uid("P");
  const sku = "SKU-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const gstRate = gst !== undefined && gst !== null && gst !== "" ? Number(gst) : 18;
  // The product's total is the sum of what's being entered per size — there is
  // no separate "opening stock" field anymore now that every size carries its
  // own count.
  const openingTotal = validSizes.reduce((sum, s) => sum + stockNum(s.stock), 0);

  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, brand, category, sku, unit, hsn_code, code, gst_rate, stock, godown, rack,
      default_mode, length_ft, width_val, thickness_in, created_at, opening_stock_date, barcode, sub_category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_sizes (product_id, label, price, stock, sort_order, cost_price) VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertProduct.run(
      id, name.trim(), (brand || "Generic").trim(), (category || "General").trim(),
      sku, (unit || "Piece").trim(), (hsnCode || "").trim(), (code || "").trim(), gstRate, openingTotal,
      (godown || "").trim(), (rack || "").trim(),
      Pricing.normaliseMode(defaultMode), dim(lengthFt), dim(widthVal), dim(thicknessIn),
      Date.now(), openingDate(openingStockDate),
      String(barcode || "").trim(), String(subCategory || "").trim()
    );
    validSizes.forEach((s, i) => {
      const info = insertSize.run(id, String(s.label).trim(), parseFloat(s.price), stockNum(s.stock), i, stockNum(s.cost));
      const sid150 = Number(info.lastInsertRowid);
      stampSizeBarcode(sid150, sku);
      if (hasLocationStock(s)) applyTypedLocationStock(sid150, { shop: s.shopStock, warehouse: s.warehouseStock });
      else applyTypedStock(sid150, s.stock);
    });
    // products.stock is derived from what actually landed per location, not
    // from the total the client sent — with per-location entry the two can
    // legitimately differ, and the locations are the truth.
    syncProductStock(id);
  })();

  logAction(req, "product.create", name.trim());
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  res.status(201).json(serialize(p));
});

router.put("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const { name, brand, category, unit, gst, godown, rack, sizes,
          defaultMode, lengthFt, widthVal, thicknessIn, hsnCode, code, openingStockDate,
          barcode, subCategory } = req.body;

  // A product's price lives in its size rows, so an edit that supplies a `sizes`
  // array must leave at least one valid entry — otherwise the product becomes
  // unsellable and crashes the billing screen. Create enforces this; edit must
  // too, or the guard is trivially bypassed by clearing the field and saving.
  if (Array.isArray(sizes)) {
    const valid = sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)));
    if (!valid.length) {
      return res.status(400).json({ error: "Keep at least one size/variant with a price." });
    }
  }

  const update = db.prepare(`
    UPDATE products SET name=?, brand=?, category=?, unit=?, hsn_code=?, code=?, gst_rate=?, godown=?, rack=?,
      default_mode=?, length_ft=?, width_val=?, thickness_in=?, opening_stock_date=?, barcode=?, sub_category=? WHERE id=?
  `);
  // Sizes are updated IN PLACE by id, not delete-all-and-reinsert: a stock-in
  // or a sold invoice_items row references a size_id, and destroying/
  // recreating every row on each edit would silently null out that link
  // (ON DELETE SET NULL) even for a size the owner didn't touch.
  const updateSize = db.prepare("UPDATE product_sizes SET label=?, price=?, stock=?, sort_order=?, cost_price=? WHERE id=? AND product_id=?");
  const insertSize = db.prepare("INSERT INTO product_sizes (product_id, label, price, stock, sort_order, cost_price) VALUES (?, ?, ?, ?, ?, ?)");
  const deleteSize = db.prepare("DELETE FROM product_sizes WHERE id = ? AND product_id = ?");

  db.transaction(() => {
    update.run(
      (name || p.name).trim(), (brand ?? p.brand), (category ?? p.category),
      (unit ?? p.unit), (hsnCode ?? p.hsn_code), (code ?? p.code),
      gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate,
      (godown ?? p.godown), (rack ?? p.rack),
      defaultMode !== undefined ? Pricing.normaliseMode(defaultMode) : p.default_mode,
      dim(lengthFt, p.length_ft), dim(widthVal, p.width_val), dim(thicknessIn, p.thickness_in),
      // A malformed date keeps whatever is already stored rather than clearing
      // it — losing a good "stock as on" date to a typo would be worse than
      // ignoring the typo. Clearing it deliberately means sending "".
      openingStockDate === undefined
        ? p.opening_stock_date
        : (openingStockDate === "" ? "" : (openingDate(openingStockDate) || p.opening_stock_date)),
      (barcode ?? p.barcode ?? ""), (subCategory ?? p.sub_category ?? ""),
      p.id
    );
    if (Array.isArray(sizes)) {
      const validSizes = sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)));
      const existingIds = new Set(loadSizes(p.id).map(s => s.id));
      const keptIds = new Set();
      validSizes.forEach((s, i) => {
        if (s.id != null && existingIds.has(Number(s.id))) {
          updateSize.run(String(s.label).trim(), parseFloat(s.price), stockNum(s.stock), i, stockNum(s.cost), Number(s.id), p.id);
          const sid205 = Number(s.id);
          if (hasLocationStock(s)) applyTypedLocationStock(sid205, { shop: s.shopStock, warehouse: s.warehouseStock });
          else applyTypedStock(sid205, s.stock);
          keptIds.add(Number(s.id));
        } else {
          const info = insertSize.run(p.id, String(s.label).trim(), parseFloat(s.price), stockNum(s.stock), i, stockNum(s.cost));
          const sid209 = Number(info.lastInsertRowid);
          stampSizeBarcode(sid209, p.sku);
          if (hasLocationStock(s)) applyTypedLocationStock(sid209, { shop: s.shopStock, warehouse: s.warehouseStock });
          else applyTypedStock(sid209, s.stock);
        }
      });
      existingIds.forEach(id => { if (!keptIds.has(id)) deleteSize.run(id, p.id); });
      syncProductStock(p.id);
    }
  })();

  logAction(req, "product.update", p.name);
  const updated = db.prepare("SELECT * FROM products WHERE id = ?").get(p.id);
  res.json(serialize(updated));
});

/**
 * Correct ONE size's stock directly — every size carries its own count now,
 * so there is no longer a single product-level number to adjust.
 */
/**
 * Manual Adjustment — always at a specific location (Shop, Warehouse, ...),
 * per the multi-location requirement that every stock action says where.
 * `locationId` defaults to Shop when omitted, since the Inventory screen's
 * stock editor always has a location selected before this fires; Shop is
 * the safer default for any older caller (matches what a sale can actually
 * draw from) rather than silently landing in Warehouse.
 */
router.patch("/:id/sizes/:sizeId/stock", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const size = db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(req.params.sizeId, p.id);
  if (!size) return res.status(404).json({ error: "Size not found on this product." });
  const targetLocation = inventory.getLocationById(req.body.locationId);
  const locationId = (targetLocation && targetLocation.active) ? targetLocation.id : inventory.getLocationByCode("shop").id;
  const before = inventory.getStock(size.id, locationId);

  let newStock;
  if (req.body.stock !== undefined) newStock = Number(req.body.stock);
  else if (req.body.delta !== undefined) newStock = before + Number(req.body.delta);
  else return res.status(400).json({ error: "Provide stock or delta." });
  newStock = Math.max(0, newStock);

  db.transaction(() => {
    inventory.addStock(size.id, locationId, newStock - before);
    syncProductStock(p.id);
  })();

  logAction(req, "product.stock_adjust", `${p.name} (${size.label}) @ ${targetLocation ? targetLocation.name : "Shop"}: ${before} → ${newStock}`);
  res.json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)));
});

/**
 * Full Purchase Entry for one product: date, supplier, invoice number, size/
 * thickness with the SAME auto Sq.ft calculation sales use (via the shared
 * Pricing module), GST, transport, and a grand total. `qty` is the physical
 * pieces received — what stock goes up by; `billedQty` (Sq.ft/Sq.m/etc) is
 * what the rate multiplies, exactly mirroring an invoice line.
 */
router.post("/:id/stock-in", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  const {
    purchaseDate, invoiceNo, supplier, supplierId, note, sizeId,
    mode, lengthFt, widthVal, thicknessIn, pieces, rate, gst, transport, locationId
  } = req.body;
  // Same default as New Purchase/Purchase Order — Warehouse unless staff
  // picks another active location.
  const targetLocation = inventory.getLocationById(locationId);
  const resolvedLocationId = (targetLocation && targetLocation.active) ? targetLocation.id : inventory.getLocationByCode("warehouse").id;

  // The Supplier field on Purchase Entry stays a single free-text box (no
  // extra picker step) — but it now resolves to a real Supplier record
  // behind the scenes: an exact case-insensitive name match reuses the
  // existing supplier (and its running due), anything new is created on the
  // spot. A blank supplier name records the purchase with no ledger effect,
  // same as before this feature existed.
  let supplierRow = null;
  if (supplierId) {
    supplierRow = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(supplierId);
    if (!supplierRow) return res.status(400).json({ error: "Selected supplier no longer exists." });
  } else if (supplier && String(supplier).trim()) {
    const name = String(supplier).trim();
    supplierRow = db.prepare("SELECT * FROM suppliers WHERE LOWER(name) = LOWER(?)").get(name);
    if (!supplierRow) {
      const newId = uid("SUP");
      db.prepare("INSERT INTO suppliers (id, name, due, created_at) VALUES (?, ?, 0, ?)").run(newId, name, Date.now());
      supplierRow = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(newId);
    }
  }

  // Stock lands on a specific size variant now. A product with only one
  // size doesn't need it spelled out; anything else must say which.
  const sizes = loadSizes(p.id);
  let size = null;
  if (sizeId != null) size = sizes.find(s => s.id === Number(sizeId));
  else if (sizes.length === 1) size = sizes[0];
  if (!size) {
    return res.status(400).json({ error: "Choose which size/variant received this stock." });
  }

  const line = {
    mode: Pricing.normaliseMode(mode || p.default_mode),
    lengthFt, widthVal, thicknessIn, pieces, rate
  };
  const invalid = Pricing.validateLine(line, p.name);
  if (invalid) return res.status(400).json({ error: invalid });

  const calc = Pricing.computeLine(line);
  const gstRate = gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate;
  const gstAmount = round2(calc.amount * (gstRate / 100));
  const transportAmt = round2(Math.max(0, Number(transport) || 0));
  const grandTotal = round2(calc.amount + gstAmount + transportAmt);

  // GST Type is an explicit field on the supplier record (Supplier Master) —
  // the source of truth for CGST_SGST vs IGST, not an inferred comparison of
  // state text. No supplier (blank free-text field) has nothing to read, so
  // it defaults to CGST_SGST same as always.
  const taxType = supplierRow && supplierRow.gst_type === "IGST" ? "IGST" : "CGST_SGST";
  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === "IGST") igst = gstAmount;
  else { cgst = round2(gstAmount / 2); sgst = round2(gstAmount - cgst); }
  const date = (purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) ? purchaseDate : todayStr();
  // Cost per physical piece — the basis the Profit Report uses for any future
  // sale of this product. Transport is included: it is a real cost of getting
  // the stock onto the shelf, same as the board itself.
  const costPrice = calc.pieces > 0 ? round2((calc.amount + transportAmt) / calc.pieces) : 0;

  const id = uid("SI");
  const supplierName = supplierRow ? supplierRow.name : (supplier || "").trim();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO stock_ins
        (id, product_id, size_id, product_name, purchase_date, invoice_no, supplier, supplier_id, brand, category,
         mode, length_ft, width_val, thickness_in, size_label, qty, per_piece, billed_qty,
         unit_label, rate, amount, gst_rate, gst_amount, tax_type, cgst, sgst, igst, transport, grand_total, cost_price, note, created_at, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, p.id, size.id, p.name, date, (invoiceNo || "").trim(), supplierName, supplierRow ? supplierRow.id : null, p.brand, p.category,
      calc.mode, calc.lengthFt || null, calc.widthVal || null, calc.thicknessIn || null, calc.sizeLabel || size.label,
      calc.pieces, calc.perPiece, calc.billedQty, calc.unit, calc.rate, calc.amount,
      gstRate, gstAmount, taxType, cgst, sgst, igst, transportAmt, grandTotal, costPrice, (note || "").trim(), Date.now(), resolvedLocationId
    );
    inventory.addStock(size.id, resolvedLocationId, calc.pieces);
    syncProductStock(p.id);
    // Purchases go on credit by default, mirroring how a sales invoice raises
    // the customer's due — a Purchase Payment is what brings it back down.
    if (supplierRow) db.prepare("UPDATE suppliers SET due = ROUND(due + ?, 2) WHERE id = ?").run(grandTotal, supplierRow.id);
  })();

  logAction(req, "product.stock_in", `${p.name}: +${calc.pieces}${supplierName ? " from " + supplierName : ""} — Grand Total ${grandTotal}`);
  res.status(201).json({
    product: serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)),
    purchase: db.prepare("SELECT * FROM stock_ins WHERE id = ?").get(id)
  });
});

/**
 * A product's "Recent Purchases" panel — merges both purchase systems (see
 * reports.js's /purchases for the same merge, same reasoning) so a product
 * bought only through New Purchase doesn't show an empty history here.
 */
router.get("/:id/stock-in", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  // `source` distinguishes the two feeds, which have separate id spaces —
  // stock_ins uses a text uid, purchase_items an integer. Only stock_in rows
  // are editable through PUT /:id/stock-in/:siId; a purchase_item belongs to a
  // multi-line Purchase Bill and has to be edited there, so the client needs
  // to be able to tell them apart rather than guessing from the id's shape.
  const stockInRows = db.prepare("SELECT * FROM stock_ins WHERE product_id = ?").all(p.id)
    .map(r => ({ ...r, source: "stock_in" }));
  const purchaseLineRows = db.prepare(`
    SELECT pi.id, pi.size_label, pi.mode, pi.pieces AS qty, pi.qty AS billed_qty, pi.rate, pi.discount_amount, pi.gst_rate,
      p.date AS purchase_date, p.supplier_invoice_no AS invoice_no, p.created_at, s.name AS supplier
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE pi.product_id = ? AND p.voided = 0
  `).all(p.id).map(r => {
    const taxable = round2(r.qty * r.rate - r.discount_amount);
    return { ...r, grand_total: round2(taxable + taxable * (r.gst_rate / 100)) };
  });

  const rows = [...stockInRows, ...purchaseLineRows].sort((a, b) => b.created_at - a.created_at).slice(0, 20);
  res.json(rows);
});

router.get("/:id/stock-in/:siId", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const si = db.prepare("SELECT * FROM stock_ins WHERE id = ? AND product_id = ?").get(req.params.siId, p.id);
  if (!si) return res.status(404).json({ error: "Purchase record not found." });
  res.json(si);
});

/**
 * Full edit of a past Record Stock In purchase — quantity, rate, size,
 * supplier, dates, everything. Reverses the OLD stock/due impact first (with
 * the same already-used-elsewhere guard as purchases.js: if the size no
 * longer has enough stock to take back, some of what this purchase brought
 * in has since left, and the edit is refused), then applies the new one.
 * A body with only `supplier`/`supplierId` set (nothing else) behaves exactly
 * like the old relink-only route this replaces.
 */
router.put("/:id/stock-in/:siId", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const si = db.prepare("SELECT * FROM stock_ins WHERE id = ? AND product_id = ?").get(req.params.siId, p.id);
  if (!si) return res.status(404).json({ error: "Purchase record not found." });

  const {
    purchaseDate, invoiceNo, supplier, supplierId, note, sizeId,
    mode, lengthFt, widthVal, thicknessIn, pieces, rate, gst, transport, locationId
  } = req.body;
  // The OLD location this stock-in actually put stock into — a row saved
  // before this column existed falls back to Warehouse, same as the schema
  // backfill did. The NEW location (possibly changed by this edit) is
  // resolved separately.
  const oldLocationId = si.location_id || inventory.getLocationByCode("warehouse").id;
  const requestedNewLocation = inventory.getLocationById(locationId);
  const newLocationId = (requestedNewLocation && requestedNewLocation.active) ? requestedNewLocation.id : oldLocationId;

  let supplierRow = null;
  if (supplierId) {
    supplierRow = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(supplierId);
    if (!supplierRow) return res.status(400).json({ error: "Selected supplier no longer exists." });
  } else if (supplier && String(supplier).trim()) {
    const name = String(supplier).trim();
    supplierRow = db.prepare("SELECT * FROM suppliers WHERE LOWER(name) = LOWER(?)").get(name);
    if (!supplierRow) {
      const newId = uid("SUP");
      db.prepare("INSERT INTO suppliers (id, name, due, created_at) VALUES (?, ?, 0, ?)").run(newId, name, Date.now());
      supplierRow = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(newId);
    }
  }

  const sizes = loadSizes(p.id);
  let size = null;
  if (sizeId != null) size = sizes.find(s => s.id === Number(sizeId));
  else size = sizes.find(s => s.id === si.size_id) || (sizes.length === 1 ? sizes[0] : null);
  if (!size) return res.status(400).json({ error: "Choose which size/variant received this stock." });

  const line = {
    mode: Pricing.normaliseMode(mode || si.mode),
    lengthFt: lengthFt !== undefined ? lengthFt : si.length_ft,
    widthVal: widthVal !== undefined ? widthVal : si.width_val,
    thicknessIn: thicknessIn !== undefined ? thicknessIn : si.thickness_in,
    pieces: pieces !== undefined ? pieces : si.qty,
    rate: rate !== undefined ? rate : si.rate
  };
  const invalid = Pricing.validateLine(line, p.name);
  if (invalid) return res.status(400).json({ error: invalid });

  // Pure math, so it can be computed before the guard needs the new piece count.
  const calc = Pricing.computeLine(line);
  // Correcting a figure in place (same size, same location) only physically
  // requires that a REDUCTION fits. Reversing the whole old quantity first and
  // demanding it all still be there refused perfectly safe edits — raising a
  // mistyped 4 to 6 was rejected merely because some pieces had been
  // transferred, even though that edit only ADDS stock. Moving the entry to a
  // different size or location genuinely does need the original quantity back,
  // so that path keeps the strict check.
  const sameTarget = size.id === si.size_id && newLocationId === oldLocationId;

  const runEdit = db.transaction(() => {
    // 1. Stock: guard, then move by the smallest correct amount.
    if (sameTarget) {
      const delta = calc.pieces - si.qty;
      if (delta < 0) {
        const available = inventory.getStock(si.size_id, oldLocationId);
        if (available < -delta) {
          throw { status: 400, error: `Can't reduce this entry to ${calc.pieces} — only ${available} of ${p.name} is left at that location, so ${-delta} can't be taken back. Some of it has already been sold or transferred.` };
        }
      }
      if (delta !== 0) inventory.addStock(si.size_id, oldLocationId, delta);
    } else {
      const atOldLocation = inventory.getStock(si.size_id, oldLocationId);
      if (atOldLocation < si.qty) {
        throw { status: 400, error: `Can't move this purchase — ${p.name} stock has already been used elsewhere (only ${atOldLocation} left at that location, this purchase added ${si.qty}).` };
      }
      inventory.addStock(si.size_id, oldLocationId, -si.qty);
      inventory.addStock(size.id, newLocationId, calc.pieces);
    }

    // 2. Reverse the OLD supplier's due.
    if (si.supplier_id) db.prepare("UPDATE suppliers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?").run(si.grand_total, si.supplier_id);

    // 3. Recompute, identical math to POST /:id/stock-in.
    const gstRate = gst !== undefined && gst !== "" ? Number(gst) : si.gst_rate;
    const gstAmount = round2(calc.amount * (gstRate / 100));
    const transportAmt = transport !== undefined ? round2(Math.max(0, Number(transport) || 0)) : si.transport;
    const grandTotal = round2(calc.amount + gstAmount + transportAmt);
    const taxType = supplierRow ? (supplierRow.gst_type === "IGST" ? "IGST" : "CGST_SGST") : si.tax_type;
    let cgst = 0, sgst = 0, igst = 0;
    if (taxType === "IGST") igst = gstAmount;
    else { cgst = round2(gstAmount / 2); sgst = round2(gstAmount - cgst); }
    const date = (purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) ? purchaseDate : si.purchase_date;
    const costPrice = calc.pieces > 0 ? round2((calc.amount + transportAmt) / calc.pieces) : 0;
    const supplierName = supplierRow ? supplierRow.name : (supplier !== undefined ? String(supplier || "").trim() : si.supplier);

    // 4. Write the corrected row (stock itself was already moved in step 1).
    db.prepare(`
      UPDATE stock_ins SET size_id=?, purchase_date=?, invoice_no=?, supplier=?, supplier_id=?,
        mode=?, length_ft=?, width_val=?, thickness_in=?, size_label=?, qty=?, per_piece=?, billed_qty=?,
        unit_label=?, rate=?, amount=?, gst_rate=?, gst_amount=?, tax_type=?, cgst=?, sgst=?, igst=?,
        transport=?, grand_total=?, cost_price=?, note=?, location_id=?
      WHERE id=?
    `).run(
      size.id, date, invoiceNo !== undefined ? String(invoiceNo || "").trim() : si.invoice_no, supplierName,
      supplierRow ? supplierRow.id : null,
      calc.mode, calc.lengthFt || null, calc.widthVal || null, calc.thicknessIn || null, calc.sizeLabel || size.label,
      calc.pieces, calc.perPiece, calc.billedQty, calc.unit, calc.rate, calc.amount,
      gstRate, gstAmount, taxType, cgst, sgst, igst, transportAmt, grandTotal, costPrice,
      note !== undefined ? String(note || "").trim() : si.note, newLocationId, si.id
    );
    syncProductStock(p.id);

    // 5. Apply the (possibly new) supplier's due.
    if (supplierRow) db.prepare("UPDATE suppliers SET due = ROUND(due + ?, 2) WHERE id = ?").run(grandTotal, supplierRow.id);
  });

  try {
    runEdit();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "product.stock_in.edit", `${p.name} (${si.id})`);
  res.json(db.prepare("SELECT * FROM stock_ins WHERE id = ?").get(si.id));
});

/**
 * Deletes a past Record Stock In purchase, owner-only — reverses stock and
 * the supplier's due first (same already-used-elsewhere guard as edit),
 * then removes the row.
 */
router.delete("/:id/stock-in/:siId", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const si = db.prepare("SELECT * FROM stock_ins WHERE id = ? AND product_id = ?").get(req.params.siId, p.id);
  if (!si) return res.status(404).json({ error: "Purchase record not found." });

  const runDelete = db.transaction(() => {
    const locationId = si.location_id || inventory.getLocationByCode("warehouse").id;
    const atLocation = inventory.getStock(si.size_id, locationId);
    if (atLocation < si.qty) {
      throw { status: 400, error: `Can't delete this purchase — ${p.name} stock has already been used elsewhere (only ${atLocation} left at that location, this purchase added ${si.qty}).` };
    }
    inventory.addStock(si.size_id, locationId, -si.qty);
    syncProductStock(p.id);
    if (si.supplier_id) db.prepare("UPDATE suppliers SET due = MAX(0, ROUND(due - ?, 2)) WHERE id = ?").run(si.grand_total, si.supplier_id);
    db.prepare("DELETE FROM stock_ins WHERE id = ?").run(si.id);
  });

  try {
    runDelete();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  logAction(req, "product.stock_in.delete", `${p.name} (${si.id})`);
  res.json({ ok: true });
});

/**
 * Copy a product into a new one — the fast way to add the next thickness or
 * grade of a board that is otherwise identical.
 *
 * Opening stock is deliberately 0 rather than the original's: a duplicate is a
 * DIFFERENT physical item, and inheriting 100 sheets would invent inventory
 * that nobody ever received. The user records a stock-in for the real count.
 */
router.post("/:id/duplicate", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  const id = uid("P");
  const sku = "SKU-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const name = String(req.body && req.body.name ? req.body.name : p.name + " (Copy)").trim().slice(0, 120);
  const sizes = loadSizes(p.id);

  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, brand, category, sku, unit, gst_rate, stock, godown, rack,
      default_mode, length_ft, width_val, thickness_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(
    "INSERT INTO product_sizes (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)"
  );

  db.transaction(() => {
    insertProduct.run(
      id, name, p.brand, p.category, sku, p.unit, p.gst_rate, p.godown, p.rack,
      p.default_mode, p.length_ft, p.width_val, p.thickness_in, Date.now()
    );
    /* A duplicate is a DIFFERENT product with its own SKU, so its sizes get
       their own codes rather than inheriting the original's — two products
       sharing a barcode would put the wrong one on the bill. */
    sizes.forEach((s, i) => {
      const info = insertSize.run(id, s.label, s.price, i);
      stampSizeBarcode(Number(info.lastInsertRowid), sku);
    });
  })();

  logAction(req, "product.duplicate", `${p.name} -> ${name}`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(id)));
});

/**
 * How much history a product carries, so the delete confirmation can say
 * "this appears on 12 invoices" instead of a blind "are you sure?".
 */
router.get("/:id/usage", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  // Matches the DELETE route's guard exactly (counts voided sales too) so this
  // endpoint never tells the client "safe to delete" when the server would
  // then refuse it.
  const invoiceCount = db.prepare(
    "SELECT COUNT(DISTINCT invoice_id) AS n FROM invoice_items WHERE product_id = ?"
  ).get(p.id).n;
  const stockInCount = db.prepare("SELECT COUNT(*) AS n FROM stock_ins WHERE product_id = ?").get(p.id).n;
  res.json({ invoiceCount, stockInCount, stock: p.stock });
});

/* Retire a product without destroying it — the ordinary alternative to
   deletion. An inactive product keeps all its stock, history and ledger
   entries and still appears in Inventory, Product Query and every report;
   it simply stops being offered when someone starts a new bill, purchase,
   quotation or order. Mirrors the customer and supplier routes exactly. */
router.patch("/:id/active", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE products SET active = ? WHERE id = ?").run(active, p.id);
  logAction(req, active ? "product.activate" : "product.deactivate", p.name);
  res.json(serialize(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  // A product that has ever gone out on a sale or challan cannot be deleted —
  // even a voided one, since the historical line still references it and losing
  // the product would break that document's product link for future reference.
  // Purchases (stock_ins) do NOT block deletion: a product bought but never
  // sold is fair game to remove. An owner can override this with ?force=true.
  const usedInSales = db.prepare(
    "SELECT COUNT(*) AS n FROM invoice_items WHERE product_id = ?"
  ).get(p.id).n;
  const force = req.query.force === "true";
  if (usedInSales > 0 && !force) {
    return res.status(400).json({
      error: `"${p.name}" can't be deleted — it has been used in ${usedInSales} sale line${usedInSales > 1 ? "s" : ""}. Products already sold or on a challan are kept for record-keeping.`,
      canForce: true,
      usedInSales
    });
  }

  // Force delete: sever the historical sale lines' link to this product before
  // removing it. Each invoice_item already stores its own copy of the name,
  // size and rate, so the sale still prints exactly as issued — this only
  // clears the live product_id, matching the ON DELETE SET NULL behaviour
  // every other product_id reference in the schema already has.
  if (usedInSales > 0) {
    db.prepare("UPDATE invoice_items SET product_id = NULL WHERE product_id = ?").run(p.id);
  }

  // Past invoices keep their own copy of the name, size and rate, so deleting a
  // product never rewrites history — the sale still prints exactly as issued.
  db.prepare("DELETE FROM products WHERE id = ?").run(p.id);
  logAction(
    req,
    usedInSales > 0 ? "product.force_delete" : "product.delete",
    usedInSales > 0 ? `${p.name} (force — ${usedInSales} sale line${usedInSales > 1 ? "s" : ""} detached)` : p.name
  );
  res.json({ ok: true, forced: usedInSales > 0 });
});

module.exports = router;
