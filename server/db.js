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

CREATE TABLE IF NOT EXISTS product_sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price REAL NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'Retail Customer',
  phone TEXT DEFAULT '',
  gst TEXT DEFAULT '',
  state TEXT DEFAULT '',
  credit_limit REAL NOT NULL DEFAULT 0,
  due REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  challan_no TEXT UNIQUE NOT NULL,
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
  -- Post-tax charges. Freight and labour are not the shop's supply and are
  -- billed at cost, so they sit outside the taxable value rather than being
  -- folded into the subtotal.
  transport REAL NOT NULL DEFAULT 0,
  loading REAL NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS stock_ins (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  supplier TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_product_sizes_product ON product_sizes(product_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_stock_ins_product ON stock_ins(product_id);
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

addColumn("products", "default_mode", "TEXT NOT NULL DEFAULT 'UNIT'");
addColumn("products", "length_ft", "REAL");
addColumn("products", "width_val", "REAL");
addColumn("products", "thickness_in", "REAL");

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
