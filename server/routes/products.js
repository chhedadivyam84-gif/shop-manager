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
  const sizes = db.prepare("SELECT id, label, price, stock FROM product_sizes WHERE product_id = ? ORDER BY sort_order ASC, id ASC").all(productId);
  sizes.forEach(s => { s.byLocation = inventory.getStockByLocation(s.id); });
  return sizes;
}

function serialize(p) {
  return { ...p, gst: p.gst_rate, sizes: loadSizes(p.id) };
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

/** Non-negative number, defaulting to 0 for blank/invalid input. */
function stockNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

router.get("/", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY name ASC").all();
  res.json(products.map(serialize));
});

router.post("/", (req, res) => {
  const { name, brand, category, unit, gst, godown, rack, sizes,
          defaultMode, lengthFt, widthVal, thicknessIn, hsnCode, code } = req.body;
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
      default_mode, length_ft, width_val, thickness_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_sizes (product_id, label, price, stock, sort_order) VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertProduct.run(
      id, name.trim(), (brand || "Generic").trim(), (category || "General").trim(),
      sku, (unit || "Piece").trim(), (hsnCode || "").trim(), (code || "").trim(), gstRate, openingTotal,
      (godown || "").trim(), (rack || "").trim(),
      Pricing.normaliseMode(defaultMode), dim(lengthFt), dim(widthVal), dim(thicknessIn),
      Date.now()
    );
    validSizes.forEach((s, i) => insertSize.run(id, String(s.label).trim(), parseFloat(s.price), stockNum(s.stock), i));
  })();

  logAction(req, "product.create", name.trim());
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  res.status(201).json(serialize(p));
});

router.put("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const { name, brand, category, unit, gst, godown, rack, sizes,
          defaultMode, lengthFt, widthVal, thicknessIn, hsnCode, code } = req.body;

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
      default_mode=?, length_ft=?, width_val=?, thickness_in=? WHERE id=?
  `);
  // Sizes are updated IN PLACE by id, not delete-all-and-reinsert: a stock-in
  // or a sold invoice_items row references a size_id, and destroying/
  // recreating every row on each edit would silently null out that link
  // (ON DELETE SET NULL) even for a size the owner didn't touch.
  const updateSize = db.prepare("UPDATE product_sizes SET label=?, price=?, stock=?, sort_order=? WHERE id=? AND product_id=?");
  const insertSize = db.prepare("INSERT INTO product_sizes (product_id, label, price, stock, sort_order) VALUES (?, ?, ?, ?, ?)");
  const deleteSize = db.prepare("DELETE FROM product_sizes WHERE id = ? AND product_id = ?");

  db.transaction(() => {
    update.run(
      (name || p.name).trim(), (brand ?? p.brand), (category ?? p.category),
      (unit ?? p.unit), (hsnCode ?? p.hsn_code), (code ?? p.code),
      gst !== undefined && gst !== "" ? Number(gst) : p.gst_rate,
      (godown ?? p.godown), (rack ?? p.rack),
      defaultMode !== undefined ? Pricing.normaliseMode(defaultMode) : p.default_mode,
      dim(lengthFt, p.length_ft), dim(widthVal, p.width_val), dim(thicknessIn, p.thickness_in),
      p.id
    );
    if (Array.isArray(sizes)) {
      const validSizes = sizes.filter(s => s && s.label && s.price !== "" && s.price != null && !isNaN(parseFloat(s.price)));
      const existingIds = new Set(loadSizes(p.id).map(s => s.id));
      const keptIds = new Set();
      validSizes.forEach((s, i) => {
        if (s.id != null && existingIds.has(Number(s.id))) {
          updateSize.run(String(s.label).trim(), parseFloat(s.price), stockNum(s.stock), i, Number(s.id), p.id);
          keptIds.add(Number(s.id));
        } else {
          insertSize.run(p.id, String(s.label).trim(), parseFloat(s.price), stockNum(s.stock), i);
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
    if (supplierRow) db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(grandTotal, supplierRow.id);
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

  const stockInRows = db.prepare("SELECT * FROM stock_ins WHERE product_id = ?").all(p.id);
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

  const runEdit = db.transaction(() => {
    // 1. Reverse the OLD stock impact at the OLD location — guarded, same
    //    reasoning as purchases.js: refuse if that would drive it negative.
    const atOldLocation = inventory.getStock(si.size_id, oldLocationId);
    if (atOldLocation < si.qty) {
      throw { status: 400, error: `Can't edit this purchase — ${p.name} stock has already been used elsewhere (only ${atOldLocation} left at that location, this purchase added ${si.qty}).` };
    }
    inventory.addStock(si.size_id, oldLocationId, -si.qty);

    // 2. Reverse the OLD supplier's due.
    if (si.supplier_id) db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(si.grand_total, si.supplier_id);

    // 3. Recompute, identical math to POST /:id/stock-in.
    const calc = Pricing.computeLine(line);
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

    // 4. Apply the NEW stock (at the NEW location) and update the row.
    inventory.addStock(size.id, newLocationId, calc.pieces);
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
    if (supplierRow) db.prepare("UPDATE suppliers SET due = due + ? WHERE id = ?").run(grandTotal, supplierRow.id);
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
    if (si.supplier_id) db.prepare("UPDATE suppliers SET due = MAX(0, due - ?) WHERE id = ?").run(si.grand_total, si.supplier_id);
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
    sizes.forEach((s, i) => insertSize.run(id, s.label, s.price, i));
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

router.delete("/:id", requireRole("owner"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });

  // A product that has ever gone out on a sale or challan cannot be deleted —
  // even a voided one, since the historical line still references it and losing
  // the product would break that document's product link for future reference.
  // Purchases (stock_ins) do NOT block deletion: a product bought but never
  // sold is fair game to remove.
  const usedInSales = db.prepare(
    "SELECT COUNT(*) AS n FROM invoice_items WHERE product_id = ?"
  ).get(p.id).n;
  if (usedInSales > 0) {
    return res.status(400).json({
      error: `"${p.name}" can't be deleted — it has been used in ${usedInSales} sale line${usedInSales > 1 ? "s" : ""}. Products already sold or on a challan are kept for record-keeping.`
    });
  }

  // Past invoices keep their own copy of the name, size and rate, so deleting a
  // product never rewrites history — the sale still prints exactly as issued.
  db.prepare("DELETE FROM products WHERE id = ?").run(p.id);
  logAction(req, "product.delete", p.name);
  res.json({ ok: true });
});

module.exports = router;
