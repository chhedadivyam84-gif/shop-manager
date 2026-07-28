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
  return db.prepare("SELECT * FROM locations WHERE code = ?").get(code);
}
function getLocationById(id) {
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
function addStock(sizeId, locationId, delta) {
  ensureRow(sizeId, locationId);
  db.prepare(`
    UPDATE size_location_stock SET quantity = quantity + ?, last_updated = ?
    WHERE size_id = ? AND location_id = ?
  `).run(delta, Date.now(), sizeId, locationId);
  syncSizeStockTotal(sizeId);
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
