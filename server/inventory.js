// Multi-location stock primitives shared by every route that touches
// inventory (invoices, purchases, purchase orders, products, transfers).
// Kept as simple SQL primitives, same layering as the rest of this codebase:
// this module does NOT validate sufficiency — each route already owns that
// (checking availability, building a clear error message) exactly as it did
// against the old single-pool stock, just now scoped to one location.
const db = require("./db");

function getLocations() {
  return db.prepare("SELECT * FROM locations WHERE active = 1 ORDER BY sort_order ASC, name ASC").all();
}
function getAllLocations() {
  return db.prepare("SELECT * FROM locations ORDER BY sort_order ASC, name ASC").all();
}
function getLocationByCode(code) {
  if (code == null) return undefined;
  return db.prepare("SELECT * FROM locations WHERE code = ?").get(code);
}
function getLocationById(id) {
  // node:sqlite throws on an undefined bind param (unlike null) — callers
  // pass this straight through from an optional request body field, so
  // "not provided" must resolve to "not found" rather than a 500.
  if (id == null) return undefined;
  return db.prepare("SELECT * FROM locations WHERE id = ?").get(id);
}

/** Every size should have a row for every location; this fills in a missing
 *  one at 0 rather than letting a read/write 500 on a size older than some
 *  location, or a location newer than some size. */
function ensureRow(sizeId, locationId) {
  const existing = db.prepare("SELECT id FROM size_location_stock WHERE size_id = ? AND location_id = ?").get(sizeId, locationId);
  if (!existing) {
    db.prepare(`
      INSERT INTO size_location_stock (size_id, location_id, quantity, min_stock, last_updated)
      VALUES (?, ?, 0, 0, ?)
    `).run(sizeId, locationId, Date.now());
  }
}
function ensureAllLocationRows(sizeId) {
  getAllLocations().forEach(l => ensureRow(sizeId, l.id));
}

function getStock(sizeId, locationId) {
  ensureRow(sizeId, locationId);
  return db.prepare("SELECT quantity FROM size_location_stock WHERE size_id = ? AND location_id = ?").get(sizeId, locationId).quantity;
}

/** Every location's quantity/min_stock for one size, joined with the
 *  location's name/code — what the Inventory screen and product detail need. */
function getStockByLocation(sizeId) {
  ensureAllLocationRows(sizeId);
  return db.prepare(`
    SELECT sls.quantity, sls.min_stock, sls.last_updated, l.id AS location_id, l.code, l.name
    FROM size_location_stock sls JOIN locations l ON l.id = sls.location_id
    WHERE sls.size_id = ? AND l.active = 1
    ORDER BY l.sort_order ASC
  `).all(sizeId);
}

/** Recomputes product_sizes.stock as the SUM across every location — the
 *  single line that keeps every pre-existing report/screen/query reading
 *  that column (unaware locations even exist) correct without changes.
 *  Callers still run their own products.stock resync afterward, exactly as
 *  they already did before this feature existed. */
function syncSizeStockTotal(sizeId) {
  const total = db.prepare("SELECT COALESCE(SUM(quantity),0) AS t FROM size_location_stock WHERE size_id = ?").get(sizeId).t;
  db.prepare("UPDATE product_sizes SET stock = ? WHERE id = ?").run(total, sizeId);
}

/** delta may be negative. Sufficiency is the caller's job — see file header. */
/**
 * THE ONLY PLACE A STOCK QUANTITY CHANGES.
 *
 * Which is why the ledger is written here and nowhere else: purchase,
 * sale, return, transfer, adjustment and manual entry all arrive through
 * this one function, so every one of them is recorded without thirty-two
 * call sites having to remember — and without a future one being able to
 * forget.
 *
 * The quantity is read BEFORE and AFTER, in the same breath as the change,
 * so the row can say 100 → 150 rather than leaving the shop to add up
 * every line above it.
 */
function addStock(sizeId, locationId, delta) {
  ensureRow(sizeId, locationId);

  const before = db.prepare(
    "SELECT quantity FROM size_location_stock WHERE size_id = ? AND location_id = ?"
  ).get(sizeId, locationId);
  const prev = before ? Number(before.quantity) || 0 : 0;

  db.prepare(`
    UPDATE size_location_stock SET quantity = quantity + ?, last_updated = ?
    WHERE size_id = ? AND location_id = ?
  `).run(delta, Date.now(), sizeId, locationId);
  syncSizeStockTotal(sizeId);

  /* A movement of nothing is not a movement. Some callers pass 0 for a line
     that turned out to have no quantity, and a ledger full of 100 → 100 is
     a ledger nobody reads. */
  if (Number(delta)) {
    const size = db.prepare("SELECT product_id FROM product_sizes WHERE id = ?").get(sizeId);
    require("./stockLedger").record({
      sizeId, locationId,
      productId: size ? size.product_id : "",
      delta: Number(delta), prev, next: prev + Number(delta)
    });
  }
}

function setMinStock(sizeId, locationId, minStock) {
  ensureRow(sizeId, locationId);
  db.prepare("UPDATE size_location_stock SET min_stock = ? WHERE size_id = ? AND location_id = ?")
    .run(Math.max(0, Number(minStock) || 0), sizeId, locationId);
}

module.exports = {
  getLocations, getAllLocations, getLocationByCode, getLocationById,
  ensureRow, ensureAllLocationRows, getStock, getStockByLocation,
  syncSizeStockTotal, addStock, setMinStock
};
