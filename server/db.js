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
  total REAL NOT NULL,
  advance REAL NOT NULL DEFAULT 0,
  balance_due REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  paper_size TEXT NOT NULL DEFAULT 'A5',
  voided INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT,
  name TEXT NOT NULL,
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

module.exports = db;
