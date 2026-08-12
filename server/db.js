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

-- Mirrors customers: the party the shop owes money TO, rather than the party
-- that owes the shop. Same shape (name/phone/address/gst/state/due) so the
-- Suppliers screen and its ledger can reuse the exact same UI/logic as
-- Customers, just pointed at the other side of the books.
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  gst TEXT DEFAULT '',
  state TEXT DEFAULT '',
  due REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Mirrors payments (Sale Payment) exactly, but against a supplier's due
-- instead of a customer's — this is the Purchase Payment record.
CREATE TABLE IF NOT EXISTS purchase_payments (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  stock_in_id TEXT REFERENCES stock_ins(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'Cash',
  reference_no TEXT DEFAULT '',
  note TEXT DEFAULT '',
  payment_date TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- A one-time (but not enforced-single, so it can be voided and re-entered)
-- starting balance for a supplier when they're first added to the system
-- with an existing real-world balance — Payable raises due like a purchase
-- would, Advance lowers it like a payment would. Feeds into the same
-- supplier ledger/due/Total Payables/Dashboard figures a real purchase or
-- payment already does, rather than needing separate reporting.
CREATE TABLE IF NOT EXISTS supplier_opening_balances (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_type TEXT NOT NULL CHECK (balance_type IN ('Payable', 'Advance')),
  remarks TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Mirror of supplier_opening_balances for the customer (Debtor) side —
-- Receivable raises due like an invoice would, Advance lowers it like a
-- payment would.
CREATE TABLE IF NOT EXISTS customer_opening_balances (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_type TEXT NOT NULL CHECK (balance_type IN ('Receivable', 'Advance')),
  remarks TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Daily Cash Book: a standalone running cash ledger, independent of any
-- customer/supplier/invoice — for everyday cash in/out (petty cash, wages,
-- expenses, walk-in cash not tied to a bill) that the shop still wants
-- tracked. "voided" (not a hard delete) matches how payments/invoices are
-- removed everywhere else in this app, so a mistaken entry never erases
-- the audit trail — it's just excluded from the running balance.
CREATE TABLE IF NOT EXISTS cash_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('in', 'out')),
  amount REAL NOT NULL,
  party TEXT DEFAULT '',
  category TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per real bank account the shop holds (current a/c at whichever
-- banks). Each account's balance is opening_balance + the running total of
-- its own non-voided bank_entries rows -- never stored directly, so it can
-- never drift out of sync with the ledger that produced it.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bank_name TEXT DEFAULT '',
  account_no TEXT DEFAULT '',
  opening_balance REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Bank Book: identical shape and purpose to cash_entries above, just a
-- separate running balance for the bank account instead of the cash drawer —
-- extended (via addColumn migrations further down) with a transaction-type
-- taxonomy, payment mode/reference, optional party link, attachment, and a
-- link_id used to pair the two legs of a Deposit/Withdrawal/Transfer, or tie
-- an entry back to the customer/supplier payment that auto-created it.
CREATE TABLE IF NOT EXISTS bank_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('in', 'out')),
  amount REAL NOT NULL,
  party TEXT DEFAULT '',
  category TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
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

-- Multi-line Purchase Entry — a full purchase invoice from a supplier with
-- several products on it, mirroring invoices/invoice_items exactly (same
-- header/lines split, same tax_type + cgst/sgst/igst pattern driven by the
-- supplier's Customer-Master-style gst_type, same round-off handling).
-- stock_ins (above) is NOT replaced by this — it's the older one-product-at-
-- a-time "Record Purchase" flow, still used from a product's own Inventory
-- page, and existing history there is untouched. This is a second, parallel
-- path for entering a full multi-item supplier bill in one go.
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  purchase_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  -- The supplier's OWN invoice number (free text) — separate from purchase_no,
  -- which is this shop's own sequential record number, same split as how a
  -- sales invoice's challan_no differs from a customer's PO number.
  supplier_invoice_no TEXT DEFAULT '',
  purchase_type TEXT NOT NULL DEFAULT 'Local' CHECK (purchase_type IN ('Local', 'Interstate')),
  tax_type TEXT NOT NULL DEFAULT 'CGST_SGST',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  transport REAL NOT NULL DEFAULT 0,
  loading REAL NOT NULL DEFAULT 0,
  other_charges REAL NOT NULL DEFAULT 0,
  round_off REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Credit',
  due_date TEXT DEFAULT '',
  vehicle_number TEXT DEFAULT '',
  transport_name TEXT DEFAULT '',
  lr_number TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0
);

-- Purchase Order: a request SENT TO a supplier, before any goods or money
-- move — no stock or supplier-due impact, unlike the purchases table above.
-- Its status is a real STORED column (not derived) because Draft/Approved are
-- genuine workflow steps driven by explicit actions (Save Draft, Approve),
-- not something computable from payment state the way an invoice's status
-- is. "Convert to Purchase Entry" creates a real row in purchases and marks
-- this Completed — see server/routes/purchaseOrders.js.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  delivery_address TEXT DEFAULT '',
  expected_delivery_date TEXT DEFAULT '',
  purchase_type TEXT NOT NULL DEFAULT 'Local' CHECK (purchase_type IN ('Local', 'Interstate')),
  tax_type TEXT NOT NULL DEFAULT 'CGST_SGST',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  freight REAL NOT NULL DEFAULT 0,
  other_charges REAL NOT NULL DEFAULT 0,
  round_off REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_terms TEXT DEFAULT '',
  delivery_terms TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Pending', 'Approved', 'Partially Completed', 'Completed', 'Cancelled')),
  -- Set once Convert to Purchase Entry runs — lets the UI link straight to
  -- the resulting purchase instead of making staff go find it.
  converted_purchase_id TEXT REFERENCES purchases(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL, brand TEXT DEFAULT '', category TEXT DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'UNIT',
  length_ft REAL, width_val REAL, thickness_in REAL,
  size_label TEXT NOT NULL DEFAULT '',
  pieces REAL NOT NULL DEFAULT 0, per_piece REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  qty REAL NOT NULL, rate REAL NOT NULL,
  discount_amount REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  brand TEXT DEFAULT '',
  category TEXT DEFAULT '',
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
  -- Stored as the resolved rupee amount either way — the line's own %-or-flat
  -- choice at entry time doesn't need to survive, only what it worked out to.
  discount_amount REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18
);

-- Sales Quotation: an estimate with NO stock or due impact — creating,
-- editing or cancelling one never touches product_sizes or a customer's due,
-- exactly like a Purchase Order never touches supplier due until converted.
CREATE TABLE IF NOT EXISTS quotations (
  id TEXT PRIMARY KEY,
  quotation_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  valid_until TEXT DEFAULT '',
  sale_type TEXT NOT NULL DEFAULT 'Local' CHECK (sale_type IN ('Local', 'Interstate')),
  tax_type TEXT NOT NULL DEFAULT 'CGST_SGST',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'pct',
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  transport REAL NOT NULL DEFAULT 0,
  loading REAL NOT NULL DEFAULT 0,
  round_off REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  gst_on_charges INTEGER NOT NULL DEFAULT 1,
  terms TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Sent', 'Accepted', 'Converted', 'Cancelled')),
  -- Set once Convert to Invoice runs — lets the UI link straight to the
  -- resulting invoice instead of making staff go find it.
  converted_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL, brand TEXT DEFAULT '', category TEXT DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'UNIT',
  length_ft REAL, width_val REAL, thickness_in REAL,
  size_label TEXT NOT NULL DEFAULT '',
  pieces REAL NOT NULL DEFAULT 0, per_piece REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  qty REAL NOT NULL, rate REAL NOT NULL,
  discount_amount REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18
);

-- Sales Order: a confirmed order awaiting delivery. Same no-stock-impact
-- rule as Quotation applies until it's converted to a real Invoice/Challan.
CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY,
  so_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  delivery_address TEXT DEFAULT '',
  expected_delivery_date TEXT DEFAULT '',
  sale_type TEXT NOT NULL DEFAULT 'Local' CHECK (sale_type IN ('Local', 'Interstate')),
  tax_type TEXT NOT NULL DEFAULT 'CGST_SGST',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'pct',
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  transport REAL NOT NULL DEFAULT 0,
  loading REAL NOT NULL DEFAULT 0,
  round_off REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  gst_on_charges INTEGER NOT NULL DEFAULT 1,
  remarks TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Confirmed', 'Converted', 'Cancelled')),
  converted_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  so_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL, brand TEXT DEFAULT '', category TEXT DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'UNIT',
  length_ft REAL, width_val REAL, thickness_in REAL,
  size_label TEXT NOT NULL DEFAULT '',
  pieces REAL NOT NULL DEFAULT 0, per_piece REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  qty REAL NOT NULL, rate REAL NOT NULL,
  discount_amount REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18
);

-- Sales Return: a credit note against a past Tax Invoice. Reverses stock
-- (back into Shop, since a sale only ever deducted Shop) and, when the
-- refund is adjusted against the account, reduces the customer's due —
-- mirroring how Void/Delete reverse a Purchase's stock and supplier due.
CREATE TABLE IF NOT EXISTS sales_returns (
  id TEXT PRIMARY KEY,
  return_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  reason TEXT DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  refund_method TEXT NOT NULL DEFAULT 'AdjustDue' CHECK (refund_method IN ('AdjustDue', 'Cash', 'Bank')),
  location_id TEXT REFERENCES locations(id),
  voided INTEGER NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  invoice_item_id INTEGER REFERENCES invoice_items(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  pieces REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  qty REAL NOT NULL,
  rate REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 18
);

-- Purchase Return: a debit note against a past Purchase — goods going back
-- to the supplier. Reverses stock (deducted from wherever the purchase
-- originally received it into) and, when the refund is adjusted against
-- the account, reduces what's owed to the supplier — mirrors Sales Return's
-- relationship to a Tax Invoice, just with the money/stock flow reversed.
CREATE TABLE IF NOT EXISTS purchase_returns (
  id TEXT PRIMARY KEY,
  return_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  purchase_id TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  reason TEXT DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  refund_method TEXT NOT NULL DEFAULT 'AdjustDue' CHECK (refund_method IN ('AdjustDue', 'Cash', 'Bank')),
  location_id TEXT REFERENCES locations(id),
  voided INTEGER NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_item_id INTEGER REFERENCES purchase_items(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  pieces REAL NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT 'Pc',
  qty REAL NOT NULL,
  rate REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 18
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

-- Customer Inquiry Book: a walk-in/phone lead, logged before there's
-- necessarily a real Customer record or a sale at all -- customer_name and
-- mobile are plain text (not a link to customers) for exactly that reason.
-- "voided" instead of a hard delete, matching every other list in this app.
CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  inquiry_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL,
  mobile TEXT NOT NULL DEFAULT '',
  company_name TEXT DEFAULT '',
  salesperson TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Follow-up', 'Converted to Sale', 'Closed')),
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_product_sizes_product ON product_sizes(product_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_purchase_payments_supplier ON purchase_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_ins_product ON stock_ins(product_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON print_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_quotation_items_quotation ON quotation_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_so ON sales_order_items(so_id);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_return ON sales_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice ON sales_returns(invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns(purchase_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_date ON inquiries(date);
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
    // Local date, not toISOString() (UTC) — see todayStr() in util.js. Inlined
    // rather than imported because util.js requires this file.
    const d = new Date(r.created_at);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// Links a purchase to a Supplier record so Purchase Payments have a real
// balance to pay down. The old free-text `supplier` column on stock_ins is
// kept as-is (a point-in-time name snapshot, same idea as invoice_items
// snapshotting product name/brand) — purchases recorded before Suppliers
// existed keep their text but have no supplier_id, so they never contributed
// to any due and are left alone rather than retroactively inventing debt.
addColumn("stock_ins", "supplier_id", "TEXT REFERENCES suppliers(id) ON DELETE SET NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_stock_ins_supplier ON stock_ins(supplier_id)");

// Splits the existing lump gst_amount into CGST/SGST (same-state supplier) or
// IGST (different state), exactly mirroring invoices' tax_type/cgst/sgst/igst
// — determined the same way, by comparing the supplier's state to the shop's.
// gst_rate/gst_amount are kept as-is (gst_amount stays the source total that
// cgst+sgst+igst always sums back to).
const addedStockInTaxSplit = addColumn("stock_ins", "tax_type", "TEXT NOT NULL DEFAULT 'CGST_SGST'");
addColumn("stock_ins", "cgst", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "sgst", "REAL NOT NULL DEFAULT 0");
addColumn("stock_ins", "igst", "REAL NOT NULL DEFAULT 0");
// Backfill purchases recorded before this split existed: their supplier (if
// any) has no state on file either, so CGST_SGST is exactly what the new
// logic would compute for them anyway — this just makes the stored figures
// match what a fresh read of gst_amount would already imply.
if (addedStockInTaxSplit) {
  db.exec(`UPDATE stock_ins SET cgst = round(gst_amount / 2, 2), sgst = round(gst_amount - round(gst_amount / 2, 2), 2) WHERE gst_amount > 0`);
}

// Explicit GST Type on the customer/supplier record itself, replacing the old
// implicit "compare state to shop state" rule as the source of truth invoices
// and purchases read from — a shop can now mark a party CGST_SGST or IGST
// directly (e.g. when state is blank/wrong) instead of it being silently
// inferred. Backfilled from that same old state-comparison rule so every
// existing customer/supplier keeps computing the exact tax split it already
// did, until someone explicitly edits it.
const addedCustomerGstType = addColumn("customers", "gst_type", "TEXT NOT NULL DEFAULT 'CGST_SGST'");
if (addedCustomerGstType) {
  db.exec(`
    UPDATE customers SET gst_type = CASE
      WHEN TRIM(state) != '' AND TRIM((SELECT state FROM settings WHERE id = 1)) != ''
        AND LOWER(TRIM(state)) != LOWER(TRIM((SELECT state FROM settings WHERE id = 1)))
      THEN 'IGST' ELSE 'CGST_SGST' END
  `);
}
const addedSupplierGstType = addColumn("suppliers", "gst_type", "TEXT NOT NULL DEFAULT 'CGST_SGST'");
if (addedSupplierGstType) {
  db.exec(`
    UPDATE suppliers SET gst_type = CASE
      WHEN TRIM(state) != '' AND TRIM((SELECT state FROM settings WHERE id = 1)) != ''
        AND LOWER(TRIM(state)) != LOWER(TRIM((SELECT state FROM settings WHERE id = 1)))
      THEN 'IGST' ELSE 'CGST_SGST' END
  `);
}

// Payment & Receipt Entry: bank/UPI detail fields and an optional attachment
// (receipt/cheque photo). attachment_path is a filename under
// data/uploads/payments/, never a full path — so it stays portable if the
// data directory ever moves. attachment_name is the original filename, kept
// only for display (the on-disk name is a random id, see routes).
for (const t of ["payments", "purchase_payments"]) {
  addColumn(t, "bank_name", "TEXT DEFAULT ''");
  addColumn(t, "upi_id", "TEXT DEFAULT ''");
  addColumn(t, "attachment_path", "TEXT DEFAULT ''");
  addColumn(t, "attachment_name", "TEXT DEFAULT ''");
}

// A customer/supplier linked to any transaction can't be hard-deleted (see
// routes) — Deactivate is the alternative, so the record stops showing up as
// a live option while every historical invoice/purchase/payment keeps
// referencing it correctly.
addColumn("customers", "active", "INTEGER NOT NULL DEFAULT 1");
addColumn("suppliers", "active", "INTEGER NOT NULL DEFAULT 1");

/* ============================================================
   ACCOUNTING — the parts a shop cannot derive from its own
   sales/purchase/cash/bank activity.
   ------------------------------------------------------------
   Everything here is ONE-TIME ENTRY by design. The owner sets
   opening capital, fixed assets, loans and deposits once, and
   the statements pick them up from then on; nothing here has to
   be touched during a normal trading day. That is a deliberate
   constraint — a shop that has to remember daily bookkeeping
   discipline stops doing it within a fortnight, and the reports
   quietly rot.

   Because of that, the balance equation is NOT forced. Assets,
   Liabilities and Capital are each reported from what is
   genuinely recorded, and whatever fails to reconcile is shown
   as an explicit Difference (Suspense) line. A silently balanced
   sheet built on a plug figure is worse than an honest gap: the
   gap tells the owner what still needs entering.
   ============================================================ */
db.exec(`
-- Owner's capital: the opening figure, later injections, and drawings.
-- Kept as a movement LIST rather than one editable number so the history is
-- auditable — "why did capital change in November" has an answer.
CREATE TABLE IF NOT EXISTS capital_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'opening' | 'introduced' | 'drawings'
  amount REAL NOT NULL,            -- always positive; the kind column carries the sign
  remarks TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Fixed assets (furniture, computer, vehicle, machinery). Depreciation is
-- stored as an accumulated figure the owner can update, rather than computed
-- on a schedule — Indian small shops set it once a year with their CA, and a
-- monthly auto-depreciation nobody reviews would silently drift.
CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',        -- Furniture | Computer | Vehicle | Machinery | Other
  purchase_date TEXT DEFAULT '',
  cost REAL NOT NULL DEFAULT 0,
  accumulated_depreciation REAL NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Bank loans and any other standing liability (hand loan, hire purchase).
-- The outstanding column is what is still owed and is what the Balance Sheet
-- reads; principal is kept only so the owner can see how far through they are.
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  lender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'bank',   -- 'bank' | 'other'
  principal REAL NOT NULL DEFAULT 0,
  outstanding REAL NOT NULL DEFAULT 0,
  interest_rate REAL NOT NULL DEFAULT 0,
  start_date TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Security deposits PAID by the shop (shop rent deposit, electricity board,
-- supplier security) — an asset: money the shop expects back.
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  held_by TEXT NOT NULL,           -- landlord / board / supplier name
  purpose TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  paid_date TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Accrued/outstanding liabilities the shop owes but has not paid yet
-- (salary payable, unpaid electricity bill, pending GST). Settled by marking
-- them paid rather than deleting, so last year's statement still shows them.
CREATE TABLE IF NOT EXISTS outstanding_liabilities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT DEFAULT '',        -- Salary Payable | GST Payable | Expense Payable | Other
  amount REAL NOT NULL DEFAULT 0,
  due_date TEXT DEFAULT '',
  settled INTEGER NOT NULL DEFAULT 0,
  settled_date TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

// Financial year start month (1-12). April = the Indian standard, and the
// default, but configurable for a shop that closes on a different cycle.
addColumn("settings", "fy_start_month", "INTEGER NOT NULL DEFAULT 4");

// Purchase cost per size, entered directly on the product alongside its
// opening stock. Until now a cost existed ONLY if the goods had been bought
// through a Purchase or Record Stock In — so a shop that typed its opening
// stock straight onto the product had no cost basis at all, which made
// Closing Stock and Cost of Goods Sold read as zero and overstated profit.
// This is the fallback: a real purchase always wins (see getLatestCost),
// this is what's used when there is no purchase history.
addColumn("product_sizes", "cost_price", "REAL NOT NULL DEFAULT 0");

// The date the opening stock count was taken — "stock as on 11 Aug 2026".
// One per product rather than per size: a shop counts a product's variants in
// the same sitting, and asking for a date on every row would be noise. Purely
// a record of when the figure was true; it does not move stock.
addColumn("products", "opening_stock_date", "TEXT DEFAULT ''");

// Barcode and Sub-Category exist for the Product Query screen, which searches
// on both. Added as plain optional text: a shop that never scans barcodes or
// splits a category leaves them blank and nothing changes.
// Active/Inactive is the ordinary way to retire a product — deleting one that
// has been sold is the exception, not the routine. Customers and suppliers
// already worked this way; products were the odd one out, which left deletion
// as the only option a user had for "stop offering this".
// Defaults to 1 so every existing product stays exactly as it is.
addColumn("products", "active", "INTEGER NOT NULL DEFAULT 1");

/* GST / Non-GST on every priced document, not just invoices and purchases.
   A quotation for a non-GST customer that silently adds 18% is a quotation
   the shop cannot honour. Defaults to 1 so every existing document keeps the
   GST it was raised with. */
["quotations", "sales_orders", "purchase_orders", "sales_returns", "purchase_returns"]
  .forEach(t => addColumn(t, "gst_enabled", "INTEGER NOT NULL DEFAULT 1"));

/* Per-document-type numbering: its own prefix, width and high-water counter.
   Each type gets its OWN series — which is also what stops tax invoices and
   delivery challans colliding in the single UNIQUE challan_no column they
   share.

   next_number is a HIGH-WATER MARK, not "the biggest row that exists". That
   is the whole point: deleting a bill frees its number for manual re-use
   without dragging automatic numbering backwards onto it. */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_numbering (
  doc_type TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 6,
  next_number INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`);

/* Seeded from the numbers already issued, so an existing shop keeps its
   series running rather than restarting at 1 on top of live bills. Prefix
   defaults follow the owner's requested scheme; both prefix and width are
   editable, and changing them only affects numbers issued from then on. */
(function seedDocNumbering() {
  const seed = db.prepare(
    "INSERT OR IGNORE INTO doc_numbering (doc_type, prefix, width, next_number, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const highest = (table, column, scope) => {
    // Only rows matching this type's own prefix count towards its counter.
    const where = scope ? `WHERE ${scope}` : "";
    const rows = db.prepare(`SELECT ${column} AS n FROM ${table} ${where}`).all();
    return rows;
  };
  const startFor = (table, column, scope, prefix) => {
    let max = 0;
    try {
      highest(table, column, scope).forEach(r => {
        const v = String(r.n || "");
        if (!v.startsWith(prefix)) return;
        const digits = v.slice(prefix.length);
        if (/^\d+$/.test(digits)) max = Math.max(max, parseInt(digits, 10));
      });
    } catch (e) { /* table not ready yet on a fresh install */ }
    return max + 1;
  };

  // Seeded with the series this shop is ALREADY running, so switching the
  // app over changes no numbering by itself. The owner edits these in
  // Settings when they want a different scheme.
  //
  // Note invoice and challan both start on "SP": that is what the app has
  // been issuing, and it is exactly why the two collide in the shared
  // UNIQUE challan_no column. Giving the challan series its own prefix is
  // the real fix, but it changes a live numbering series, so it is the
  // owner's call rather than a silent migration.
  const defs = [
    ["invoice",   "SP", 7, "invoices",   "challan_no",   "doc_type = 'invoice'"],
    ["challan",   "SP", 7, "invoices",   "challan_no",   "doc_type = 'challan'"],
    ["quotation", "SQ", 7, "quotations", "quotation_no", null],
    ["purchase",  "PU", 7, "purchases",  "purchase_no",  null]
  ];
  defs.forEach(([type, prefix, width, table, column, scope]) => {
    seed.run(type, prefix, width, startFor(table, column, scope, prefix), Date.now());
  });
})();


/* ============================================================
   AREAS — the GEOGRAPHIC place a bill belongs to.

   Deliberately NOT called "location". This app already has a locations
   table meaning Shop and Warehouse, and invoices.location_id /
   purchases.location_id already decide which godown stock moves in or out
   of. Two different things sharing one word at a billing counter is how
   staff pick the wrong one.

     locations  = where the goods physically sit   (Shop / Warehouse)
     areas      = which part of town the trade is  (Kandivali / Borivali)

   Stored as one flat row per State + City + Area rather than three tables:
   a shop deals with a few dozen areas in one or two cities, and three
   joined tables would buy nothing but joins.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  area TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(state, city, area)
);
CREATE INDEX IF NOT EXISTS idx_areas_state_city ON areas(state, city);
`);

/* A starter list so the dropdowns are usable on day one. INSERT OR IGNORE,
   so re-running never duplicates and never overwrites an edit the owner
   has made to one of these rows. */
(function seedAreas() {
  const seed = [
    ["Maharashtra", "Mumbai", "Kandivali"],
    ["Maharashtra", "Mumbai", "Borivali"],
    ["Maharashtra", "Mumbai", "Malad"],
    ["Maharashtra", "Mumbai", "Mira Road"],
    ["Maharashtra", "Mumbai", "Goregaon East"],
    ["Maharashtra", "Mumbai", "Goregaon West"],
    ["Maharashtra", "Mumbai", "Local"]
  ];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO areas (id, state, city, area, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  seed.forEach(([state, city, area], i) => {
    ins.run("AREA_" + [state, city, area].join("_").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      state, city, area, i, Date.now());
  });
})();

/* The area a party normally trades from — used to pre-fill the bill so
   nobody types it twice (and left editable per bill, because a customer can
   take delivery somewhere else). */
addColumn("customers", "area_id", "TEXT REFERENCES areas(id) ON DELETE SET NULL");
addColumn("suppliers", "area_id", "TEXT REFERENCES areas(id) ON DELETE SET NULL");

/* Frozen onto the document itself, not just read through the party: a
   customer who moves from Malad to Borivali next year must not silently
   rewrite which area last year's sales belonged to. */
addColumn("invoices", "area_id", "TEXT REFERENCES areas(id) ON DELETE SET NULL");
addColumn("purchases", "area_id", "TEXT REFERENCES areas(id) ON DELETE SET NULL");

addColumn("products", "barcode", "TEXT DEFAULT ''");
addColumn("products", "sub_category", "TEXT DEFAULT ''");

// Multi-location inventory. A scalable Location model — not hardcoded to
// Shop/Warehouse — so a third, fourth, etc. location can be added later with
// zero schema changes. `code` is a stable machine key ("shop", "warehouse")
// for the few places that need to mean ONE SPECIFIC location by name (a
// sales invoice always deducts "shop" stock, never whichever row happens to
// sort first); `id` stays the opaque PK everything else joins on.
db.exec(`
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Per-SIZE, per-location stock — this app already tracks stock at the size
-- level (an "8x4" sheet and "7x4" sheet of the same board are separate), so
-- location is a further split of that same granularity, not a replacement
-- for it. product_sizes.stock is kept as a live-synced denormalised SUM
-- across every location (see syncSizeStockTotal in server/inventory.js) so
-- every existing report/query/screen that reads it unchanged keeps working
-- exactly as before — only code that specifically needs to know Shop vs
-- Warehouse reads this table directly.
CREATE TABLE IF NOT EXISTS size_location_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  size_id INTEGER NOT NULL REFERENCES product_sizes(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL,
  UNIQUE(size_id, location_id)
);

-- Full audit trail for Transfer Stock — kept separate from size_location_stock
-- (which only holds current quantities) so history survives even as
-- quantities keep changing.
CREATE TABLE IF NOT EXISTS stock_transfers (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  size_id INTEGER NOT NULL REFERENCES product_sizes(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  from_location_id TEXT NOT NULL REFERENCES locations(id),
  to_location_id TEXT NOT NULL REFERENCES locations(id),
  quantity REAL NOT NULL,
  reason TEXT DEFAULT '',
  staff_name TEXT NOT NULL DEFAULT ''
);
`);

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

// Seed the two starting locations (idempotent — INSERT OR IGNORE) and
// backfill size_location_stock for every size that doesn't have location
// rows yet. Existing stock becomes SHOP stock exactly as-is (not split or
// halved) — that's what keeps Billing selling the same available quantity
// it always has, on day one, with zero re-entry. Warehouse starts at 0 for
// every size; nothing is invented for a location that was never tracked
// before. Safe to re-run on every boot: a size that already has rows here
// (from this migration or from a location-aware create/purchase since) is
// left completely alone.
db.exec(`
  INSERT OR IGNORE INTO locations (id, name, code, active, sort_order, created_at)
  VALUES ('LOC_shop', 'Shop', 'shop', 1, 0, ${Date.now()})
`);
db.exec(`
  INSERT OR IGNORE INTO locations (id, name, code, active, sort_order, created_at)
  VALUES ('LOC_warehouse', 'Warehouse', 'warehouse', 1, 1, ${Date.now()})
`);
db.transaction(() => {
  const shop = db.prepare("SELECT id FROM locations WHERE code = 'shop'").get();
  const warehouse = db.prepare("SELECT id FROM locations WHERE code = 'warehouse'").get();
  const unmigratedSizes = db.prepare(`
    SELECT id, stock FROM product_sizes
    WHERE id NOT IN (SELECT DISTINCT size_id FROM size_location_stock)
  `).all();
  const insertLoc = db.prepare(`
    INSERT INTO size_location_stock (size_id, location_id, quantity, min_stock, last_updated)
    VALUES (?, ?, ?, 0, ?)
  `);
  const now = Date.now();
  unmigratedSizes.forEach(s => {
    insertLoc.run(s.id, shop.id, s.stock, now);
    insertLoc.run(s.id, warehouse.id, 0, now);
  });
})();

// Which location a purchase's stock landed in — every stock-in action asks.
// Existing rows predate this column and get backfilled to Warehouse, since
// that's this app's own default destination for a purchase (requirement:
// "Purchased items should increase Warehouse Stock by default").
const addedPurchaseLocation = addColumn("purchases", "location_id", "TEXT REFERENCES locations(id)");
const addedStockInLocation = addColumn("stock_ins", "location_id", "TEXT REFERENCES locations(id)");
if (addedPurchaseLocation || addedStockInLocation) {
  const warehouseId = db.prepare("SELECT id FROM locations WHERE code = 'warehouse'").get().id;
  if (addedPurchaseLocation) db.prepare("UPDATE purchases SET location_id = ? WHERE location_id IS NULL").run(warehouseId);
  if (addedStockInLocation) db.prepare("UPDATE stock_ins SET location_id = ? WHERE location_id IS NULL").run(warehouseId);
}

// A sale/challan previously ALWAYS deducted from Shop — this column lets
// staff instead choose Warehouse per-document (requirement: "sale to
// warehouse"). Existing rows predate this column and get backfilled to
// Shop, matching every invoice ever created under the old Shop-only rule.
const addedInvoiceLocation = addColumn("invoices", "location_id", "TEXT REFERENCES locations(id)");
if (addedInvoiceLocation) {
  const shopId = db.prepare("SELECT id FROM locations WHERE code = 'shop'").get().id;
  db.prepare("UPDATE invoices SET location_id = ? WHERE location_id IS NULL").run(shopId);
}

/* ------------------------------------------------------------------
   BANK ENTRY MODULE
   Multi-account Bank Book, a transaction-type taxonomy on top of the old
   plain in/out bank_entries row, and auto-posting from the existing
   customer/supplier payment routes so Cash Book/Bank Book stay in sync
   with "Record Payment" without that screen changing at all.
   ------------------------------------------------------------------ */
addColumn("bank_entries", "bank_account_id", "TEXT REFERENCES bank_accounts(id)");
addColumn("bank_entries", "txn_type", "TEXT DEFAULT ''");
addColumn("bank_entries", "payment_mode", "TEXT DEFAULT ''");
addColumn("bank_entries", "reference_no", "TEXT DEFAULT ''");
addColumn("bank_entries", "party_type", "TEXT DEFAULT ''");
addColumn("bank_entries", "party_id", "TEXT DEFAULT ''");
addColumn("bank_entries", "attachment_path", "TEXT DEFAULT ''");
addColumn("bank_entries", "attachment_name", "TEXT DEFAULT ''");
// Pairs the two legs of a Deposit/Withdrawal/Transfer (one bank_entries row
// + one cash_entries row, or two bank_entries rows) so voiding one side can
// find and void the other. Also shared with cash_entries.link_id below.
addColumn("bank_entries", "link_id", "TEXT DEFAULT ''");
// When this entry was auto-created by a customer/supplier payment rather
// than entered directly here, source_type/source_id point back at it —
// voiding must go through that payment, not this row, so the due and the
// ledger entry can never drift apart.
addColumn("bank_entries", "source_type", "TEXT DEFAULT ''");
addColumn("bank_entries", "source_id", "TEXT DEFAULT ''");

addColumn("cash_entries", "link_id", "TEXT DEFAULT ''");
addColumn("cash_entries", "source_type", "TEXT DEFAULT ''");
addColumn("cash_entries", "source_id", "TEXT DEFAULT ''");

// Which bank account a Bank-method customer/supplier payment hit, so it can
// auto-post the matching bank_entries row. NULL for Cash-method payments.
addColumn("payments", "bank_account_id", "TEXT REFERENCES bank_accounts(id)");
addColumn("purchase_payments", "bank_account_id", "TEXT REFERENCES bank_accounts(id)");

// Every bank_entries row ever created before multi-account support existed
// belongs to one real account by definition -- it just wasn't recorded which
// one. Give them a home ("Main Bank Account") rather than leaving orphaned
// entries with no account to add up into, so existing Bank Book history and
// its balance survive this migration intact.
const bankEntryCols = columnsOf("bank_entries");
if (bankEntryCols.includes("bank_account_id")) {
  const anyUnassigned = db.prepare("SELECT COUNT(*) AS n FROM bank_entries WHERE bank_account_id IS NULL").get().n;
  if (anyUnassigned > 0) {
    db.exec(`
      INSERT OR IGNORE INTO bank_accounts (id, name, bank_name, account_no, opening_balance, active, created_at)
      VALUES ('BANKACC_main', 'Main Bank Account', '', '', 0, 1, ${Date.now()})
    `);
    db.prepare("UPDATE bank_entries SET bank_account_id = 'BANKACC_main' WHERE bank_account_id IS NULL").run();
    db.prepare("UPDATE bank_entries SET txn_type = CASE type WHEN 'in' THEN 'Bank Deposit' ELSE 'Bank Withdrawal' END WHERE txn_type = ''").run();
  }
}

// Optional GST per document — "GST Invoice" vs "Non-GST Invoice" (and the
// purchase-side equivalent). Defaults to 1 (GST on) so every invoice/purchase
// ever created before this column existed keeps computing tax exactly as it
// already does; only a document where staff explicitly switches this off at
// entry time skips CGST/SGST/IGST.
addColumn("invoices", "gst_enabled", "INTEGER NOT NULL DEFAULT 1");
addColumn("purchases", "gst_enabled", "INTEGER NOT NULL DEFAULT 1");

// Purchase Challan — a goods-received note from a supplier with no GST or
// pricing, mirroring how invoices.doc_type distinguishes a Tax Invoice from
// a Delivery Challan. Defaults to 'purchase' so every existing row keeps
// its current (priced) meaning; only a document created as a challan from
// here on gets 'challan'.
addColumn("purchases", "doc_type", "TEXT NOT NULL DEFAULT 'purchase'");

// Tracks whether a Delivery Challan has since been billed — set to the new
// row's id when a real Tax Invoice is raised against it via the "Convert to
// Invoice" action. NULL means still pending (goods delivered, not yet
// billed). Only meaningful on doc_type='challan' rows; a Tax Invoice never
// sets this on itself.
addColumn("invoices", "converted_invoice_id", "TEXT REFERENCES invoices(id) ON DELETE SET NULL");

// Delivery-challan acknowledgement: whether the signed Office Copy has come
// back from the customer. Deliberately SEPARATE from converted_invoice_id
// above — a challan can be signed-for but not yet billed, or billed but with
// the signed copy still out with the driver. Only meaningful on
// doc_type='challan'; a Tax Invoice never uses it.
// Email/website printed in the document letterhead. These used to be
// hardcoded into the print templates, which meant every shop running this
// app printed one particular shop's contact details. Blank by default —
// the letterhead simply omits whichever of the two isn't filled in.
// Subscription licence key (see server/license.js). Blank until one is
// entered; harmless on builds where licensing is switched off.
addColumn("settings", "license_key", "TEXT DEFAULT ''");

addColumn("settings", "email", "TEXT DEFAULT ''");
addColumn("settings", "website", "TEXT DEFAULT ''");

// Printed look of the Estimate/Tax Invoice and the Delivery Challan, chosen
// independently so a shop can print a formal Tally-style invoice while its
// challans stay plain. 'classic' is the layout this app always printed, so an
// existing shop's documents are unchanged until someone picks another theme.
// Values: classic | tally | navy | minimal (see PRINT_THEMES in app.js —
// an unknown value falls back to classic rather than printing unstyled).
addColumn("settings", "invoice_theme", "TEXT NOT NULL DEFAULT 'classic'");
addColumn("settings", "challan_theme", "TEXT NOT NULL DEFAULT 'classic'");
// Letterhead logo, held as a data: URI rather than a file on disk — the app
// has to survive Render wiping its filesystem on every deploy, and a logo
// living in the database rides along with the ordinary backup instead of
// needing a second restore path of its own.
addColumn("settings", "logo_data", "TEXT DEFAULT ''");
// Allow a sale or challan to go out when the shelf figure says there isn't
// enough. Real shops receive goods before anyone enters the purchase, and
// refusing the bill stops the counter dead. OFF by default so no existing
// shop's behaviour changes until its owner asks for it.
addColumn("settings", "allow_negative_stock", "INTEGER NOT NULL DEFAULT 0");
// Per-report print preferences (paper, orientation, margins, chosen columns,
// with/without rate), as JSON keyed by report id. One column rather than a
// dozen: the set of options will keep growing, and every new one would
// otherwise be another migration.
addColumn("settings", "print_prefs", "TEXT NOT NULL DEFAULT '{}'");

addColumn("invoices", "ack_status", "TEXT NOT NULL DEFAULT 'Pending'");
addColumn("invoices", "ack_received_at", "INTEGER");
addColumn("invoices", "ack_receiver_name", "TEXT DEFAULT ''");
addColumn("invoices", "ack_remarks", "TEXT DEFAULT ''");

// Where the data lives — the backup module needs the on-disk paths, and this
// is the single place that knows them.
db.dataDir = DATA_DIR;
db.file = path.join(DATA_DIR, "shop.db");

module.exports = db;
