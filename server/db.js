const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { hashPin } = require("./auth");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "shop.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT 'My Shop',
  tagline TEXT DEFAULT '',
  address TEXT DEFAULT '',
  phones TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  state TEXT DEFAULT '',
  upi_id TEXT DEFAULT '',
  pin_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT DEFAULT '',
  category TEXT DEFAULT '',
  sku TEXT UNIQUE,
  unit TEXT DEFAULT 'Piece',
  hsn_code TEXT DEFAULT '',
  gst_rate REAL NOT NULL DEFAULT 18,
  stock REAL NOT NULL DEFAULT 0,
  godown TEXT DEFAULT '',
  rack TEXT DEFAULT '',
  -- Defaults pre-filled onto a billing line when this product is picked, so
  -- counter staff don't retype "8 × 4" for every single sale.
  default_mode TEXT NOT NULL DEFAULT 'UNIT',
  length_ft REAL,
  width_val REAL,
  thickness_in REAL,
  created_at INTEGER NOT NULL
);

-- Stock lives on the SIZE, not the product — "8x4" and "7x4" of the same
-- board are counted separately, since they're physically different sheets.
-- products.stock is kept as a denormalised SUM of these, updated alongside
-- every write here, purely so the many existing reports/inventory queries
-- that read products.stock don't all need rewriting to aggregate on read.
CREATE TABLE IF NOT EXISTS product_sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price REAL NOT NULL,
  stock REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'Retail Customer',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  gst TEXT DEFAULT '',
  state TEXT DEFAULT '',
  credit_limit REAL NOT NULL DEFAULT 0,
  due REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  challan_no TEXT UNIQUE NOT NULL,
  -- 'invoice' = priced tax invoice; 'challan' = delivery challan (goods leave
  -- the shop but carry no rates, GST or totals). Both reduce stock.
  doc_type TEXT NOT NULL DEFAULT 'invoice',
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  subtotal REAL NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'pct',
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_type TEXT NOT NULL DEFAULT 'CGST_SGST',
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  -- Freight/labour charges. Whether GST applies to them is a per-invoice
  -- choice (gst_on_charges) — some shops charge tax on delivery/loading,
  -- others treat it as a pure at-cost pass-through with no markup or tax.
  transport REAL NOT NULL DEFAULT 0,
  loading REAL NOT NULL DEFAULT 0,
  gst_on_charges INTEGER NOT NULL DEFAULT 1,
  round_off REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  advance REAL NOT NULL DEFAULT 0,
  balance_due REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  paper_size TEXT NOT NULL DEFAULT 'A5',
  voided INTEGER NOT NULL DEFAULT 0
);

-- qty is the BILLED quantity (total Sq.ft / Sq.m / Rft / CFT, or pieces) and
-- is what gets multiplied by rate. pieces is the PHYSICAL count that comes out
-- of stock. For UNIT-mode lines the two are equal; for board sold by area they
-- are not, which is exactly why both columns exist.
-- Width/thickness carry no unit in the column name on purpose: the trade uses
-- FEET for Sq.ft/Sq.m widths but INCHES for CFT width and thickness, so the
-- mode column is what tells you how to read them (see public/js/pricing.js).
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT,
  -- Which SIZE variant this line sold, so void/delete can credit stock back
  -- to the exact size it came from. NULL on rows sold before per-size stock
  -- existed; those fall back to adjusting the product's total only.
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'UNIT',
  length_ft REAL,
  width_val REAL,
  thickness_in REAL,
  size_label TEXT NOT NULL DEFAULT '',
  pieces REAL NOT NULL DEFAULT 0,
  per_piece REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  qty REAL NOT NULL,
  rate REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 18
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  staff_id TEXT,
  staff_name TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'Cash',
  note TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- A purchase entry, one product per row (mirrors how the product is sold: one
-- board/size per line). qty is the physical sheet/piece count received --
-- what products.stock goes up by. billed_qty/mode/geometry mirror
-- invoice_items so a Sq.ft purchase auto-calculates the same way a Sq.ft sale
-- does, via the shared public/js/pricing.js module.
CREATE TABLE IF NOT EXISTS stock_ins (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  -- Which SIZE variant received the stock. A purchase with no size chosen
  -- (or of a UNIT-mode product with only one size) still requires one —
  -- stock can no longer land on the product with nowhere specific to go.
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  purchase_date TEXT NOT NULL,
  invoice_no TEXT DEFAULT '',
  supplier TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  category TEXT DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'UNIT',
  length_ft REAL,
  width_val REAL,
  thickness_in REAL,
  size_label TEXT DEFAULT '',
  qty REAL NOT NULL,
  per_piece REAL NOT NULL DEFAULT 0,
  billed_qty REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  transport REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  -- Cost per physical piece (amount / qty), used by the Profit Report as the
  -- cost basis for a sale of the same product — kept even though it can be
  -- derived, because rate/amount can later be edited on the product while a
  -- historical purchase's cost must never move.
  cost_price REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- One row per silent print request sent to the shop PC's local printer. This
-- is the audit trail behind "Printing… / Printed / Failed" on the phone —
-- the phone polls this row's status rather than waiting on an open HTTP
-- connection, since a real printer can take longer than any reasonable
-- request timeout to actually finish.
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  doc_type TEXT NOT NULL DEFAULT 'invoice',
  show_rate INTEGER NOT NULL DEFAULT 0,
  printer_name TEXT NOT NULL DEFAULT '',
  pdf_path TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', -- queued | printing | done | failed
  error TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_product_sizes_product ON product_sizes(product_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_stock_ins_product ON stock_ins(product_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON print_jobs(created_at);
`);

/* ------------------------------------------------------------------
   MIGRATIONS
   CREATE TABLE IF NOT EXISTS never alters an existing table, so columns
   added after a shop is already live have to be patched on separately.
   Each step is guarded by a column check, making this safe to re-run on
   every boot — which is how it stays automatic for a shop owner who just
   pulls a new version and restarts.
   ------------------------------------------------------------------ */
function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}
// Not imported from util.js: util.js requires this file, so that would be
// circular. This migration-only copy avoids that.
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function addColumn(table, column, definition) {
  if (!columnsOf(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

// Area/length/volume billing (Sq.ft / Sq.m / Rft / CFT).
const addedItemMode = addColumn("invoice_items", "mode", "TEXT NOT NULL DEFAULT 'UNIT'");
addColumn("invoice_items", "length_ft", "REAL");
addColumn("invoice_items", "width_val", "REAL");
addColumn("invoice_items", "thickness_in", "REAL");
addColumn("invoice_items", "size_label", "TEXT NOT NULL DEFAULT ''");
addColumn("invoice_items", "pieces", "REAL NOT NULL DEFAULT 0");
addColumn("invoice_items", "per_piece", "REAL NOT NULL DEFAULT 0");
addColumn("invoice_items", "unit_label", "TEXT NOT NULL DEFAULT 'Pc'");

if (addedItemMode) {
  // Every invoice raised before this feature existed was priced per piece, so
  // one piece == one billed unit. Backfilling keeps old invoices re-printable
  // and keeps void-restores-stock correct: voiding reads `pieces`, which would
  // otherwise be 0 and silently restore nothing to inventory.
  db.exec("UPDATE invoice_items SET pieces = qty, per_piece = 1 WHERE pieces = 0");
}

// Charges carried on the invoice rather than on any single line.
addColumn("invoices", "transport", "REAL NOT NULL DEFAULT 0");
addColumn("invoices", "loading", "REAL NOT NULL DEFAULT 0");
addColumn("invoices", "round_off", "REAL NOT NULL DEFAULT 0");
// Delivery-challan support. Existing rows are all priced invoices.
addColumn("invoices", "doc_type", "TEXT NOT NULL DEFAULT 'invoice'");

// Customer billing address — appears in the invoice "Bill To" block, which a
// GST invoice is expected to carry.
addColumn("customers", "address", "TEXT DEFAULT ''");

addColumn("products", "default_mode", "TEXT NOT NULL DEFAULT 'UNIT'");
addColumn("products", "length_ft", "REAL");
addColumn("products", "width_val", "REAL");
addColumn("products", "thickness_in", "REAL");
addColumn("products", "hsn_code", "TEXT DEFAULT ''");

// Per-size stock. Each size/variant of a product is counted separately now
// (an "8x4" sheet and a "7x4" sheet are physically different stock), instead
// of one shared count on the product.
const addedSizeStock = addColumn("product_sizes", "stock", "REAL NOT NULL DEFAULT 0");
addColumn("invoice_items", "size_id", "INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL");
addColumn("stock_ins", "size_id", "INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL");

// Per-invoice choice of whether GST applies to Transport/Loading charges.
addColumn("invoices", "gst_on_charges", "INTEGER NOT NULL DEFAULT 1");

if (addedSizeStock) {
  // Existing products already carry a total in products.stock with no
  // record of which size it belongs to. A product with exactly one size is
  // unambiguous — give that size the whole total. A product with several
  // sizes has no way to know the true split, so the whole total goes on the
  // first size (by sort_order) as a documented best guess; the shop owner
  // can redistribute it via Edit afterward if it's wrong for their stock.
  const products = db.prepare("SELECT id, stock FROM products").all();
  const firstSize = db.prepare("SELECT id FROM product_sizes WHERE product_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1");
  const setStock = db.prepare("UPDATE product_sizes SET stock = ? WHERE id = ?");
  products.forEach(p => {
    const s = firstSize.get(p.id);
    if (s) setStock.run(p.stock, s.id);
  });
}

// Full Purchase Entry (invoice no., GST, transport, auto Sq.ft) on top of the
// original bare stock-in (qty + cost_price + supplier).
const addedPurchaseDate = addColumn("stock_ins", "purchase_date", "TEXT NOT NULL DEFAULT ''");
addColumn("stock_ins", "invoice_no", "TEXT DEFAULT ''");
addColumn("stock_ins", "brand", "TEXT DEFAULT ''");
addColumn("stock_ins", "category", "TEXT DEFAULT ''");
addColumn("stock_ins", "mode", "TEXT NOT NULL DEFAULT 'UNIT'");
addColumn("stock_ins", "length_ft", "REAL");
addColumn("stock_ins", "width_val", "REAL");
addColumn("stock_ins", "thickness_in", "REAL");
addColumn("stock_ins", "size_label", "TEXT DEFAULT ''");
addColumn("stock_ins", "per_piece", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "billed_qty", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "unit_label", "TEXT NOT NULL DEFAULT 'Pc'");
addColumn("stock_ins", "rate", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "amount", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "gst_rate", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "gst_amount", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "transport", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "grand_total", "REAL NOT NULL DEFAULT 0");

if (addedPurchaseDate) {
  // Every stock-in recorded before this feature existed only had qty and
  // cost_price. Backfill so those old rows are still coherent in the new
  // Purchase Report: date from created_at, UNIT mode (qty == billed_qty, one
  // piece == one billed unit), amount/grand_total derived from the cost
  // already on record rather than left at 0.
  const legacyRows = db.prepare(
    "SELECT id, qty, cost_price, created_at FROM stock_ins WHERE purchase_date = ''"
  ).all();
  const backfill = db.prepare(`
    UPDATE stock_ins SET purchase_date=?, mode='UNIT', per_piece=1, billed_qty=?,
      unit_label='Pc', rate=?, amount=?, grand_total=? WHERE id=?
  `);
  legacyRows.forEach(r => {
    const date = new Date(r.created_at).toISOString().slice(0, 10);
    const amount = round2(r.qty * r.cost_price);
    backfill.run(date, r.qty, r.cost_price, amount, amount, r.id);
  });
}

// First-run seed: create settings row if none exists. The PIN itself now lives
// on the owner's staff account (below) — settings.pin_hash is unused but kept
// as a NOT NULL column so we don't need a migration to drop it.
const settingsRow = db.prepare("SELECT * FROM settings WHERE id = 1").get();
if (!settingsRow) {
  db.prepare(`
    INSERT INTO settings (id, business_name, tagline, address, phones, gstin, state, upi_id, pin_hash)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "My Shop",
    "",
    "",
    "",
    "",
    "",
    "",
    hashPin("1234")
  );
}

// First-run seed: one Owner staff account with the default PIN 1234, so a
// freshly-installed shop always has exactly one way in. Also covers upgrading
// from a pre-staff-accounts database (no staff rows yet even though settings
// already exists) by carrying the old shared PIN over to the new Owner account
// instead of silently resetting everyone's login to 1234.
const staffCount = db.prepare("SELECT COUNT(*) AS n FROM staff").get().n;
if (staffCount === 0) {
  const priorPinHash = settingsRow ? settingsRow.pin_hash : null;
  db.prepare(`
    INSERT INTO staff (id, name, pin_hash, role, active, created_at)
    VALUES (?, 'Owner', ?, 'owner', 1, ?)
  `).run("STAFF_owner", priorPinHash || hashPin("1234"), Date.now());
}

// A shop-chosen product code (e.g. "LV-888-CAA"), separate from the
// auto-generated internal SKU — printed on invoices, freely editable.
addColumn("products", "code", "TEXT DEFAULT ''");

// Who physically delivered/carried the goods for this invoice or challan,
// printed next to the document number.
addColumn("invoices", "delivery_man", "TEXT DEFAULT ''");

// Vehicle carrying the goods, a delivery address separate from the
// customer's billing address (goods can ship somewhere else), and a free
// remarks line — all optional, all printed on the document.
addColumn("invoices", "vehicle_number", "TEXT DEFAULT ''");
addColumn("invoices", "delivery_address", "TEXT DEFAULT ''");
addColumn("invoices", "remarks", "TEXT DEFAULT ''");

// Snapshotted from the product at sale time, same as `name`/`size_label` —
// so a later edit to a product's code never rewrites an already-printed bill.
addColumn("invoice_items", "code", "TEXT DEFAULT ''");
addColumn("invoice_items", "brand", "TEXT DEFAULT ''");
addColumn("invoice_items", "hsn_code", "TEXT DEFAULT ''");

// Sale Payment form fields: which invoice the payment is against (optional —
// a payment can still be a general on-account credit with no specific
// invoice), a reference number (cheque/UPI transaction id), and an explicit,
// editable payment date separate from created_at (which stays the true
// record-creation timestamp used for ledger ordering).
addColumn("payments", "invoice_id", "TEXT REFERENCES invoices(id) ON DELETE SET NULL");
addColumn("payments", "reference_no", "TEXT DEFAULT ''");
addColumn("payments", "payment_date", "TEXT DEFAULT ''");

// node:sqlite has no built-in transaction wrapper the way better-sqlite3 does;
// this shim keeps every route file's `db.transaction(() => {...})()` call working unchanged.
db.transaction = function (fn) {
  return function (...args) {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
};

// Where the data lives — the backup module needs the on-disk paths, and this
// is the single place that knows them.
db.dataDir = DATA_DIR;
db.file = path.join(DATA_DIR, "shop.db");

module.exports = db;
