const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { hashPin } = require("./auth");

/* Everything the shop owns lives here: the databases, backups, uploads and the
 * licence key. It defaults to the folder beside the code, which is right for a
 * shop running this on its own PC.
 *
 * A host that rebuilds the container on every restart throws that folder away,
 * taking the shop's invoices and its licence key with it. DATA_DIR points the
 * app at a mounted disk instead, so the data outlives the container and a key
 * is entered once rather than every few days. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* Opens ONE company's database and brings its schema up to date.

   This used to run once at import against a fixed file, which is what made
   the app single-company. The body below is unchanged: it still talks to a
   local `db`, which is now this function's connection rather than a module
   global. Every CREATE TABLE IF NOT EXISTS / addColumn in here is idempotent,
   so running it against a brand-new file builds a company from nothing, and
   running it against an existing one migrates it — the same code path that
   has always run on startup. */
function openCompanyDb(file){
const db = new DatabaseSync(file);
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

-- A customer's WhatsApp groups. One customer can have several — an Order
-- group, an Accounts group, a site group — and the operator picks which one
-- an order goes to.
--
-- invite_link is a chat.whatsapp.com invite, stored only so the shop can
-- REACH the group; it is not, and cannot be, a way to post into it. See
-- server/routes/whatsapp.js for why.
--
-- Deactivated, never deleted: a group that stops being used is still the
-- destination named on every send already in the log, and a row that
-- vanishes turns that history into a reference to nothing.
CREATE TABLE IF NOT EXISTS customer_wa_groups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  invite_link TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_groups_customer ON customer_wa_groups(customer_id);

-- What was actually sent, and what actually happened.
--
-- STATUS IS HONEST, NOT ASPIRATIONAL. A web page hands a message to
-- WhatsApp and never hears from it again — there is no delivery callback of
-- any kind. So this records what THIS APP can see:
--
--   opened     the wa.me chat was opened with the message pre-filled
--   shared     the OS share sheet completed (the operator picked a chat)
--   copied     no share sheet, so the message went to the clipboard
--   cancelled  the operator dismissed the share sheet
--
-- There is deliberately no "delivered" and no "read". Recording either
-- would be inventing a fact nobody here can know.
CREATE TABLE IF NOT EXISTS wa_send_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  customer_id TEXT,
  -- Copied, not joined. The log has to stay readable years later even if the
  -- customer is renamed, and it is a record of what was sent at the time.
  customer_name TEXT NOT NULL DEFAULT '',
  doc_type TEXT NOT NULL DEFAULT '',
  doc_id TEXT NOT NULL DEFAULT '',
  doc_no TEXT NOT NULL DEFAULT '',
  dest_type TEXT NOT NULL DEFAULT 'individual',
  dest_name TEXT NOT NULL DEFAULT '',
  dest_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'opened',
  staff_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wa_log_at ON wa_send_log(at);

-- ============================================================
-- SHOP MANAGER -> TALLY, ONE WAY
--
-- Shop Manager is the master. Nothing in this app ever reads a figure
-- back from Tally, and there is deliberately no table here that could
-- hold one: the only direction data moves is out.
--
-- WHY THIS CAN ONLY WORK ON A LOCAL COPY. Tally exposes its XML
-- interface on the machine it runs on, usually port 9000 on the shop PC.
-- A server in a data centre cannot reach that — there is no route from
-- the internet to a PC behind a shop's router, and there should not be.
-- So this syncs from the copy running on the same network as Tally.
-- ============================================================

-- One row. Where Tally is, and what is allowed to go to it.
CREATE TABLE IF NOT EXISTS tally_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host TEXT NOT NULL DEFAULT 'localhost',
  port INTEGER NOT NULL DEFAULT 9000,
  company TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  auto_sync INTEGER NOT NULL DEFAULT 0,
  -- immediate | 1m | 5m | 15m | manual
  auto_mode TEXT NOT NULL DEFAULT 'immediate',
  /* Which documents may go. Off by default, every one of them: a sync
     that starts sending the moment it is switched on, before anybody has
     checked a single voucher, is how a Tally company gets filled with
     rubbish that then has to be deleted by hand. */
  modules TEXT NOT NULL DEFAULT '{}',
  /* A tax invoice goes; an estimate or a challan does not, unless the
     owner deliberately says so. Sending an estimate to Tally books a sale
     that was never made. */
  sync_pakka INTEGER NOT NULL DEFAULT 1,
  sync_kachha INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER,
  last_fail_at INTEGER,
  last_error TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO tally_settings (id) VALUES (1);

-- What a Shop Manager record is called in Tally.
--
-- Keyed on the Shop Manager id, never on the name. Names change — a
-- customer gets renamed, a product gets a longer description — and a
-- mapping that lives on the name silently starts pointing at nothing, or
-- worse, creates a second ledger for the same party.
CREATE TABLE IF NOT EXISTS tally_map (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- ledger | stockitem | group | unit
  local_id TEXT NOT NULL,         -- customers.id, suppliers.id, products.id
  local_name TEXT NOT NULL DEFAULT '',   -- what it was called when mapped
  tally_name TEXT NOT NULL,       -- the exact name in Tally
  /* ignore = deliberately never synced. A shop has products it does not
     want in Tally at all, and "no mapping yet" must not look the same as
     "decided not to". */
  action TEXT NOT NULL DEFAULT 'map' CHECK (action IN ('map','create','ignore')),
  created_at INTEGER NOT NULL,
  UNIQUE (kind, local_id)
);

-- The queue. One row per document that wants to reach Tally.
--
-- sync_id IS UNIQUE, AND THAT IS THE WHOLE DUPLICATE DEFENCE. It is
-- derived from the document, so the same bill can only ever produce one
-- row however many times it is saved, retried or re-queued — the database
-- refuses the second one rather than relying on code to remember.
CREATE TABLE IF NOT EXISTS tally_queue (
  id TEXT PRIMARY KEY,
  sync_id TEXT NOT NULL UNIQUE,
  doc_type TEXT NOT NULL,         -- sales_invoice, purchase_invoice, receipt, payment...
  doc_id TEXT NOT NULL,
  doc_no TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL DEFAULT '',
  fy TEXT NOT NULL DEFAULT '',    -- the financial year it belongs to, fixed at queue time
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','SUCCESS','FAILED','RETRY','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  /* What Tally called it back. Held so an edit updates that voucher
     instead of writing a second one. */
  voucher_no TEXT NOT NULL DEFAULT '',
  voucher_type TEXT NOT NULL DEFAULT '',
  /* Changes when the document changes, so an edited bill can be told
     apart from one that has not moved since it was sent. */
  payload_hash TEXT NOT NULL DEFAULT '',
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tally_queue_status ON tally_queue(status);
CREATE INDEX IF NOT EXISTS idx_tally_queue_doc ON tally_queue(doc_type, doc_id);

-- Every attempt, kept. Not deletable from any screen.
--
-- The queue holds where a document stands NOW; this holds what happened.
-- When a voucher is questioned months later, "it says SUCCESS" is not an
-- answer — who sent it, when, on which attempt and what Tally replied is.
CREATE TABLE IF NOT EXISTS tally_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  staff_name TEXT NOT NULL DEFAULT '',
  sync_id TEXT NOT NULL DEFAULT '',
  doc_type TEXT NOT NULL DEFAULT '',
  doc_id TEXT NOT NULL DEFAULT '',
  doc_no TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',   -- queue | send | retry | cancel | test
  status TEXT NOT NULL DEFAULT '',
  voucher_no TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tally_log_at ON tally_log(at);

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
  gst_rate REAL NOT NULL DEFAULT 18,
  remark TEXT DEFAULT ''
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

/* ============================================================
   CHECKING IN WITH THE LICENCE SERVER

   A copy that was sold holds an activation code, which grants nothing on
   its own — it says which row in the vendor's panel to ask about. The
   signed answer is cached here so the shop keeps working when the licence
   server cannot be reached, which is the whole point of caching it.

   All dormant in the shop's own copy: license.js ships with an empty
   public key, and nothing here is read without one.
   ============================================================ */
addColumn("settings", "activation_code", "TEXT DEFAULT ''");
addColumn("settings", "install_id", "TEXT DEFAULT ''");
addColumn("settings", "last_verdict", "TEXT");
addColumn("settings", "last_verdict_at", "INTEGER");

/* The last verdict that said ACTIVE, kept separately from the latest one.

   It is what lets a copy tell two very different things apart when the
   licence server suddenly does not recognise its code: a code that was
   never approved, and a code the SERVER has forgotten because its own
   database was lost. The vendor panel has no delete, so a code that
   worked yesterday cannot legitimately vanish today — and a shop must
   not be taken off the air by its supplier's hosting accident. */
addColumn("settings", "last_good_verdict", "TEXT");
addColumn("settings", "last_good_at", "INTEGER");

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

/* A customer's WhatsApp number, kept SEPARATE from phone.
   They are the same number for most shops and not for some — an office
   landline in phone, the owner's mobile on WhatsApp — and merging them
   would mean a shop could not record both. Blank falls back to phone at
   send time, so nothing has to be re-entered for the ones that match. */
addColumn("customers", "whatsapp", "TEXT NOT NULL DEFAULT ''");
/* individual | group | both — how this customer prefers to be sent to, so
   the send dialog can default sensibly rather than asking every time. */
addColumn("customers", "wa_contact_type", "TEXT NOT NULL DEFAULT 'individual'");

/* Which Tally ledgers a voucher posts against. A shop whose sales ledger
   is called "Sales A/c" or "Sales - Local" changes it once, here, instead
   of every voucher failing on a name Tally does not have. JSON so a new
   ledger can be named later without another migration. */
addColumn("tally_settings", "ledgers", "TEXT NOT NULL DEFAULT '{}'");
/* The Tally Bridge signs in with a token, not a staff PIN: it runs
   unattended on a counter PC, and a PIN sitting in a text file there is a
   PIN anyone at the counter can read. Only the hash is kept, so the token
   is shown once when it is made and cannot be recovered afterwards. */
addColumn("tally_settings", "bridge_token_hash", "TEXT NOT NULL DEFAULT ''");
addColumn("tally_settings", "bridge_token_made_at", "INTEGER");

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



/* One-time carry-over from the old per-route `counters` rows.

   Numbers used to be issued from counters (estimate-no, challan-no, ...)
   while doc_numbering sat unused, so the two disagreed. Issuing now runs
   entirely through doc_numbering — which is also what a deletion rolls
   back — and this lifts it to wherever the old counter had reached, so
   the switch changes no shop's next number.

   Only ever raises. A counter behind the documents that actually exist
   must not drag the series backwards into re-issuing live numbers. */
(function syncDocNumberingFromCounters() {
  const pairs = [
    ["invoice", "estimate-no"],
    ["challan", "challan-no"],
    ["quotation", "quotation-no"],
    ["purchase", "purchase-no"]
  ];
  for (const [docType, counterName] of pairs) {
    const c = db.prepare("SELECT value FROM counters WHERE name = ?").get(counterName);
    if (!c) continue;
    const cur = db.prepare("SELECT next_number FROM doc_numbering WHERE doc_type = ?").get(docType);
    if (!cur) continue;
    const wanted = c.value + 1;   // counters store the LAST issued number
    if (wanted > cur.next_number) {
      db.prepare("UPDATE doc_numbering SET next_number = ?, updated_at = ? WHERE doc_type = ?")
        .run(wanted, Date.now(), docType);
    }
  }
})();

/* ---- numbering: auto on/off, and a per-financial-year start ---- */

/* Where each series restarts at the top of a financial year.
   Kept as its own table rather than a column because it is a value PER
   YEAR: a shop that starts 2026-27 at 1001 and 2027-28 at 2001 needs both
   on file, and a single column could only remember the latest. */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_number_fy_start (
  doc_type TEXT NOT NULL,
  fy_label TEXT NOT NULL,
  start_number INTEGER NOT NULL,
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_type, fy_label)
);
`);

/* Every movement of a document number, in one place.
   audit_log already records WHAT happened in prose; this records the
   numbers themselves, so "who changed 1003 to 1007, and when" is a query
   rather than a hunt through free text. Nothing here is ever deleted —
   it is the paper trail that makes re-using a number defensible. */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_number_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  action TEXT NOT NULL,
  doc_id TEXT,
  doc_number TEXT,
  previous_number TEXT,
  new_number TEXT,
  detail TEXT,
  staff_id TEXT,
  staff_name TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_number_log_type ON doc_number_log(doc_type, at DESC);
`);

/* ============================================================
   PRINT TEMPLATES

   One row per named template, keyed by doc_type. The isolation rule —
   changing one document's print format must never touch another's — is
   enforced HERE, by the schema, rather than by discipline in the UI: a
   template row belongs to exactly one doc_type, and there is no shared
   record for two documents to fight over.

   That matters because the thing it replaces was exactly such a record.
   settings.print_prefs was a single shop-wide blob read by both the
   Invoice and the Challan, so "change the Challan columns" and "change
   the Invoice columns" wrote to the same place. No amount of careful
   coding makes that safe; a different shape does.

   doc_type holds a registry key (see server/printRegistry.js) and is
   deliberately NOT a foreign key: a template may be designed for a
   document whose module does not exist yet, and must survive until it
   does.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_templates (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_doc_templates_type ON doc_templates(doc_type);
-- Two templates of one document cannot share a name. The same name under a
-- DIFFERENT document is fine and expected — every document has a "Standard".
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_templates_name ON doc_templates(doc_type, name);
`);

/* Templates generated before the registry was corrected carry Qty ahead of
   Unit, while the bill has always PRINTED Unit then Qty. Once templates
   drive the printed page that stale order would silently swap two columns on
   the shop's own paper, so it is put right here.

   Deliberately narrow: it only acts when qty sits IMMEDIATELY before unit —
   the exact shape the old default generated. A template someone reordered on
   purpose does not match that and is left alone. Nothing is added or removed,
   the two entries only trade places. */
(function alignTemplateColumnOrder() {
  const rows = db.prepare("SELECT id, config FROM doc_templates").all();
  const upd = db.prepare("UPDATE doc_templates SET config = ? WHERE id = ?");
  for (const r of rows) {
    let cfg;
    try { cfg = JSON.parse(r.config); } catch (e) { continue; }   // leave anything unreadable untouched
    if (!cfg || !Array.isArray(cfg.columns)) continue;
    const q = cfg.columns.findIndex(c => c && c.key === "qty");
    const u = cfg.columns.findIndex(c => c && c.key === "unit");
    if (q === -1 || u === -1 || u !== q + 1) continue;
    cfg.columns.splice(q, 2, cfg.columns[u], cfg.columns[q]);
    upd.run(JSON.stringify(cfg), r.id);
  }
})();

/* Which documents have actually been sent out, so Print Management can
   filter Printed / Not Printed.

   print_jobs already tracks the Windows spooler queue for the shop's own
   printer. This is the wider fact: a PDF downloaded or a copy sent on
   WhatsApp also answers "did this go to the customer?", and an owner
   asking that question does not care which button was used. */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_print_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  template_id TEXT,
  method TEXT NOT NULL,
  staff_name TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_print_log_doc ON doc_print_log(doc_type, doc_id);
`);

/* Every registered document starts with one template named Standard, built
   from the registry's own defaults. A shop that never opens the designer
   still gets a sensible printout, and the designer always has something to
   open rather than an empty screen. */
(function seedDocTemplates() {
  const reg = require("./printRegistry");
  const insert = db.prepare(
    "INSERT INTO doc_templates (id, doc_type, name, config, is_default, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  );
  const has = db.prepare("SELECT COUNT(*) AS n FROM doc_templates WHERE doc_type = ?");
  for (const doc of reg.DOCUMENTS) {
    if (has.get(doc.key).n > 0) continue;
    insert.run("TPL_" + doc.key + "_std", doc.key, "Standard",
      JSON.stringify(reg.defaultConfig(doc)), Date.now());
  }
})();

/* ============================================================
   FINANCIAL YEARS

   This app derives balances from current state rather than posting into
   periods, so closing a year does NOT move stock, debtors, creditors, cash
   or bank anywhere — those already continue unbroken into the new year.
   Nor does it post retained profit to capital: the Balance Sheet already
   computes capital from an ALL-TIME profit figure regardless of the range
   it is run over, so an extra capital row would be counted twice.

   What closing a year does provide is the two things the app had no way to
   do: a permanent record of what the year closed at, and a lock so nobody
   edits a year that has been reported to the tax office.

   A closed year can be re-opened by the owner with a reason, because real
   books get adjusted in June for something dated March, and an app that
   pretends otherwise just pushes people into working around it.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS financial_years (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,          -- "2026-27"
  start_date TEXT NOT NULL,            -- inclusive, "2026-04-01"
  end_date TEXT NOT NULL,              -- inclusive, "2027-03-31"
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at INTEGER,
  closed_by TEXT,
  reopened_at INTEGER,
  reopened_by TEXT,
  reopen_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_financial_years_dates ON financial_years(start_date, end_date);

-- One row per line of the closing position. Deliberately generic: the point
-- is an auditable record of what each figure WAS on the closing date, not a
-- source anything reads back to rebuild balances from.
CREATE TABLE IF NOT EXISTS fy_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fy_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE,
  section TEXT NOT NULL,               -- stock | customer | supplier | cash | bank | asset | loan | deposit | liability | pnl
  ref_id TEXT,                         -- the product size, customer, account… where there is one
  label TEXT NOT NULL,
  detail TEXT,                         -- size, location, brand — whatever identifies the line
  quantity REAL,
  amount REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fy_snapshot_fy ON fy_snapshot(fy_id, section);
`);

/* The year the shop is in right now, created on demand from
   settings.fy_start_month so nobody has to set one up before billing. */
(function seedCurrentFinancialYear() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM financial_years").get().n;
  if (existing > 0) return;
  const s = db.prepare("SELECT fy_start_month FROM settings WHERE id = 1").get();
  const startMonth = (s && s.fy_start_month) || 4;
  const now = new Date();
  const startYear = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
  const pad = n => String(n).padStart(2, "0");
  const start = `${startYear}-${pad(startMonth)}-01`;
  const endD = new Date(startYear + 1, startMonth - 1, 0);
  const end = `${endD.getFullYear()}-${pad(endD.getMonth() + 1)}-${pad(endD.getDate())}`;
  const label = startMonth === 1
    ? String(startYear)
    : `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  db.prepare(
    "INSERT INTO financial_years (id, label, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)"
  ).run("FY_" + label.replace(/\W+/g, "_"), label, start, end, Date.now());
})();

/* ============================================================
   INCOME & EXPENSE CATEGORIES

   These used to be two hardcoded arrays in reports.js matched against a
   free-text box on the entry form. Anything that did not match EXACTLY —
   "salary", "Salary ", "Labour Charges" — fell into "Uncategorised", so the
   money reached the Profit & Loss total but never the line the owner was
   looking for. A shop cannot see what it spends on labour if labour has no
   line.

   A table instead of a list means the owner can add "Staff Welfare" without
   a developer, and the entry form can offer a dropdown so nothing has to be
   spelled exactly right in the first place.

   `kind` is 'income' or 'expense' — the same name can legitimately exist on
   both sides (an "Office Rent" paid and an "Office Rent Received"), so the
   uniqueness is per side.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS txn_categories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, name)
);
CREATE INDEX IF NOT EXISTS idx_txn_categories_kind ON txn_categories(kind, active);
`);

(function seedTxnCategories() {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO txn_categories (id, kind, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  // The owner's own list, plus the ones the P&L already recognised so no
  // existing entry loses the line it was reporting under.
  const expense = [
    "Salary", "Labour Charges", "Staff Welfare", "Office Rent", "Electricity",
    "Transport", "Freight & Transport", "Repairs & Maintenance", "Stationery",
    "Printing & Stationery", "Advertising", "Bank Charges", "Office Expenses",
    "Rent", "Miscellaneous Expenses", "Miscellaneous"
  ];
  const income = [
    "Office Rent Received", "Commission Received", "Interest Income",
    "Interest Received", "Scrap Sale", "Discount Received",
    "Miscellaneous Income", "Other Income"
  ];
  const now = Date.now();
  expense.forEach((n, i) => ins.run("CAT_exp_" + n.toLowerCase().replace(/[^a-z0-9]+/g, "_"), "expense", n, i, now));
  income.forEach((n, i) => ins.run("CAT_inc_" + n.toLowerCase().replace(/[^a-z0-9]+/g, "_"), "income", n, i, now));
})();

/* Same idea for the header WORDING. Templates generated before the registry
   carried per-document labels say "Sr. No." / "Product" / "Quantity", while
   the bill prints "Sr No." / "Product Description" / "Qty" (and a challan
   says "Product / Item" / "Description"). Left alone, switching the printed
   page over to templates would silently reword the shop's own headers.

   Narrow in the same way as the order fix: a column is only rewritten when
   its label still equals the OLD generic default, i.e. nobody has renamed it.
   A header the owner typed themselves is never touched. */
/* A COLUMN ADDED TO THE REGISTRY HAS TO REACH THE TEMPLATES ALREADY SAVED.
   ------------------------------------------------------------------------
   The designer edits a template's STORED column list, and a shop's template
   was written when it was created. So a column added to the registry later
   — Length is the first — would exist for a brand new template and be
   invisible to every shop that already had one, which reads exactly like
   the feature not working.

   Missing columns are appended, HIDDEN, in registry order. Hidden because
   a bill must not grow a column on its own: that is the shop's paperwork
   changing without anybody asking for it. Appended rather than inserted so
   an order somebody arranged by hand is never rearranged, and existing
   entries are not touched at all — a renamed header, a chosen width and a
   column deliberately switched off all survive. */
(function offerNewColumnsToExistingTemplates() {
  const reg = require("./printRegistry");
  const rows = db.prepare("SELECT id, doc_type, config FROM doc_templates").all();
  const upd = db.prepare("UPDATE doc_templates SET config = ? WHERE id = ?");
  for (const r of rows) {
    const doc = reg.getDoc(r.doc_type);
    if (!doc || !Array.isArray(doc.items)) continue;
    let cfg;
    try { cfg = JSON.parse(r.config); } catch (e) { continue; }
    if (!cfg || !Array.isArray(cfg.columns)) continue;

    const have = new Set(cfg.columns.map(c => c && c.key));
    let added = 0;
    for (const key of doc.items) {
      if (have.has(key)) continue;
      const f = reg.ITEM_FIELDS[key];
      if (!f) continue;
      cfg.columns.push({
        key,
        label: (doc.labels && doc.labels[key]) || f.label,
        show: 0,
        width: doc.autoWidths ? 0 : f.width,
        align: f.align
      });
      added++;
    }
    if (added) upd.run(JSON.stringify(cfg), r.id);
  }
})();

(function alignTemplateLabelsAndWidths() {
  const reg = require("./printRegistry");
  const rows = db.prepare("SELECT id, doc_type, config FROM doc_templates").all();
  const upd = db.prepare("UPDATE doc_templates SET config = ? WHERE id = ?");
  for (const r of rows) {
    const doc = reg.getDoc(r.doc_type);
    if (!doc || !doc.labels) continue;
    let cfg;
    try { cfg = JSON.parse(r.config); } catch (e) { continue; }
    if (!cfg || !Array.isArray(cfg.columns)) continue;
    let changed = false;
    for (const col of cfg.columns) {
      const field = reg.ITEM_FIELDS[col.key];
      const want = doc.labels[col.key];
      const generic = field && field.label;
      if (want && col.label === generic && col.label !== want) { col.label = want; changed = true; }
      // Bill columns size themselves from the stylesheet. A stored width
      // still equal to the generic default was never chosen by anyone, and
      // applying it would pin columns the bill has always left to flow.
      if (doc.autoWidths && field && col.width === field.width && col.width !== 0) {
        col.width = 0; changed = true;
      }
    }
    // Page metrics too. A stored 10.5pt / 10mm still at the generic default
    // was never chosen by anyone, and applying it redrew the whole bill
    // (11px text became 14px, 10px padding became 37.8px). Zero means
    // "inherit the stylesheet", which is how the bill has always printed.
    if (doc.autoWidths) {
      const reg2 = reg.defaultConfig(doc);
      if (cfg.fontSize === 10.5) { cfg.fontSize = 0; changed = true; }
      if (cfg.margins && cfg.margins.top === 10) {
        cfg.margins = { top: 0, right: 0, bottom: 0, left: 0 }; changed = true;
      }
      // Same for a heading nobody has retyped.
      if (cfg.title && cfg.title !== reg2.title &&
          (cfg.title === "TAX INVOICE" || cfg.title === doc.label)) {
        cfg.title = reg2.title; changed = true;
      }
    }
    if (changed) upd.run(JSON.stringify(cfg), r.id);
  }
})();

/* ============================================================
   E-INVOICE

   Deliberately single-company. One install serves one GSTIN, so there is no
   company_id here or anywhere else: adding one would mean scoping every
   query in the app, partitioning numbering and backups, and rewriting
   working code for a second business that does not exist. If one ever
   does, this is the point to revisit.

   The signed invoice and QR come back as long base64 strings. They are
   stored because the QR must be reprintable months later and the signed
   payload is the evidence the invoice was registered — but they are kept
   OUT of the list query, which would otherwise drag megabytes into a
   screen that only needs the IRN.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS einvoices (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft','Ready','Generating','Generated','Cancelled','Failed')),
  client_ref TEXT UNIQUE,

  irn TEXT NOT NULL DEFAULT '',
  ack_no TEXT NOT NULL DEFAULT '',
  ack_date TEXT NOT NULL DEFAULT '',
  signed_invoice TEXT NOT NULL DEFAULT '',
  signed_qr TEXT NOT NULL DEFAULT '',

  cancelled_at INTEGER, cancel_reason TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER
);
-- An invoice may only carry one live IRN. A cancelled one does not block a
-- fresh attempt, which is why the index is partial rather than a plain
-- UNIQUE on invoice_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_einvoice_live
  ON einvoices(invoice_id) WHERE status <> 'Cancelled';
CREATE INDEX IF NOT EXISTS idx_einvoice_status ON einvoices(status);

-- What the checklist found, and when. Kept so a rejected invoice can be
-- answered for later: what was missing at the time, not what is missing now.
CREATE TABLE IF NOT EXISTS gst_validation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT, kind TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  problems_json TEXT NOT NULL DEFAULT '[]',
  staff_id TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gstval_invoice ON gst_validation_logs(invoice_id, at);
`);

/* IRN, acknowledgement and QR alongside the e-way bill columns already on
   invoices, so the PRINT path needs no join and no change of shape — the
   print engine reads the invoice row it always read. */
/* How much a return ACTUALLY moved the party ledger.

   Applying a return clamps at zero — a customer who owes 5,000 and returns
   5,900 of goods ends at zero, not at minus 900. But reversing it used to
   add back the full 5,900, handing back money that was never taken and
   leaving the ledger higher than before the return existed. Voiding a
   return could therefore INCREASE what a customer owed.
   Storing the applied figure makes the reversal exact instead of assumed.
   0 on existing rows is the honest default: nothing is known about them,
   and the fallback below uses the total as it always did. */
addColumn("sales_returns", "ledger_applied", "REAL NOT NULL DEFAULT 0");
addColumn("purchase_returns", "ledger_applied", "REAL NOT NULL DEFAULT 0");

addColumn("invoices", "irn", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "irn_ack_no", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "irn_ack_date", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "irn_qr", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "einvoice_status", "TEXT NOT NULL DEFAULT ''");

/* ============================================================
   E-WAY BILL

   ewb_bills is the record of truth; the eway_* columns already on invoices
   stay as the denormalised copy the printed bill reads, so printing never
   has to join. invoice_id is the traceability requirement — every e-way
   bill can be walked back to the document that produced it.

   client_ref is the idempotency key. It is generated once when a bill moves
   to Submitting and is UNIQUE, so a double-tap, a retry after a timeout, or
   two staff on two devices cannot produce two e-way bills for one invoice.
   The provider echoes it back and a duplicate insert fails loudly rather
   than quietly generating twice.

   status vocabulary is ours; a provider's own wording is mapped onto it in
   the adapter rather than leaking through the app. Expired is NOT stored —
   it is derived from valid_until, so nothing has to run overnight and a bill
   cancelled before expiry stays Cancelled.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS transporters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trans_id TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transporters_active ON transporters(active, name);

CREATE TABLE IF NOT EXISTS ewb_bills (
  id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(id),
  doc_type TEXT NOT NULL DEFAULT 'invoice',
  status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft','Validated','Submitting','Generated','Failed','Cancelled')),
  client_ref TEXT UNIQUE,

  ewb_no TEXT NOT NULL DEFAULT '',
  ewb_date TEXT NOT NULL DEFAULT '',
  valid_until TEXT NOT NULL DEFAULT '',

  supply_type TEXT NOT NULL DEFAULT 'Outward',
  sub_type TEXT NOT NULL DEFAULT 'Supply',
  doc_no TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL DEFAULT '',
  doc_value REAL NOT NULL DEFAULT 0,

  from_gstin TEXT NOT NULL DEFAULT '',  from_name TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',   from_place TEXT NOT NULL DEFAULT '',
  from_pin TEXT NOT NULL DEFAULT '',    from_state_code TEXT NOT NULL DEFAULT '',

  to_gstin TEXT NOT NULL DEFAULT '',    to_name TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',     to_place TEXT NOT NULL DEFAULT '',
  to_pin TEXT NOT NULL DEFAULT '',      to_state_code TEXT NOT NULL DEFAULT '',

  transporter_id TEXT REFERENCES transporters(id),
  transporter_name TEXT NOT NULL DEFAULT '',
  trans_id TEXT NOT NULL DEFAULT '',
  trans_mode TEXT NOT NULL DEFAULT '',
  vehicle_no TEXT NOT NULL DEFAULT '',
  vehicle_type TEXT NOT NULL DEFAULT '',
  trans_doc_no TEXT NOT NULL DEFAULT '',
  trans_doc_date TEXT NOT NULL DEFAULT '',
  distance_km REAL NOT NULL DEFAULT 0,

  taxable_value REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0, cess REAL NOT NULL DEFAULT 0,
  total_value REAL NOT NULL DEFAULT 0,

  last_error TEXT NOT NULL DEFAULT '',
  cancelled_at INTEGER, cancel_reason TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ewb_status ON ewb_bills(status);
CREATE INDEX IF NOT EXISTS idx_ewb_invoice ON ewb_bills(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ewb_date ON ewb_bills(doc_date);

CREATE TABLE IF NOT EXISTS ewb_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ewb_id TEXT NOT NULL REFERENCES ewb_bills(id) ON DELETE CASCADE,
  product_id TEXT,
  name TEXT NOT NULL, hsn TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 0, uqc TEXT NOT NULL DEFAULT '',
  taxable_value REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0, cess REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ewb_items_bill ON ewb_items(ewb_id);

-- Every call to the provider, request and response. SERVER-SIDE ONLY: it
-- holds tokens and full payloads and is never returned by any API.
CREATE TABLE IF NOT EXISTS ewb_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ewb_id TEXT, provider TEXT NOT NULL, operation TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '', response_json TEXT NOT NULL DEFAULT '',
  http_status INTEGER, error_code TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewb_requests_bill ON ewb_requests(ewb_id, at);
`);

/* ============================================================
   CHEQUES

   A cheque book belongs to a bank account (bank_accounts already carries the
   bank master fields — name, bank_name, account_no) and hands out numbers
   from a series, the same high-water idea the document numbering uses: the
   next number only ever moves forward, so cancelling a spoiled cheque never
   drags the series back onto a number already printed.

   The bank balance deliberately does NOT move when a cheque is written. A
   cheque is a promise; the money leaves when the bank clears it. So the
   balance moves on CLEARED and only then, by posting a normal bank entry
   tagged source_type=cheque — which means reconciliation, the Bank Book and
   every existing report keep working with no special cases for cheques.
   Bouncing or un-clearing voids that entry and the balance comes back.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS cheque_books (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  prefix TEXT NOT NULL DEFAULT '',
  start_number INTEGER NOT NULL,
  end_number INTEGER,
  next_number INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cheque_books_account ON cheque_books(bank_account_id, active);

CREATE TABLE IF NOT EXISTS cheques (
  id TEXT PRIMARY KEY,
  cheque_book_id TEXT REFERENCES cheque_books(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  cheque_no TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  amount REAL NOT NULL,
  -- The date written ON the cheque. A future one is a PDC; nothing special
  -- is stored for that, it falls out of the date being ahead of today.
  cheque_date TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  crossing TEXT NOT NULL DEFAULT 'account_payee'
    CHECK (crossing IN ('account_payee', 'bearer', 'self')),
  status TEXT NOT NULL DEFAULT 'Issued'
    CHECK (status IN ('Issued', 'Printed', 'Cleared', 'Bounced', 'Cancelled')),
  -- The bank entry raised when it cleared, so un-clearing knows what to void.
  bank_entry_id TEXT,
  cleared_date TEXT,
  bounce_reason TEXT,
  party_type TEXT,
  party_id TEXT,
  remarks TEXT NOT NULL DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- One number can only exist once per bank account. Two accounts may
  -- legitimately both have a cheque 000123.
  UNIQUE(bank_account_id, cheque_no)
);
CREATE INDEX IF NOT EXISTS idx_cheques_status ON cheques(status, voided);
CREATE INDEX IF NOT EXISTS idx_cheques_date ON cheques(cheque_date);
CREATE INDEX IF NOT EXISTS idx_cheques_account ON cheques(bank_account_id, voided);

-- Where each field sits on the paper, per bank. Every bank's cheque differs,
-- so the layout is data, not code: printing is a millimetre problem and the
-- owner is the one holding the cheque against the test print.
CREATE TABLE IF NOT EXISTS cheque_layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bank_account_id TEXT REFERENCES bank_accounts(id),
  config TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cheque_layouts_account ON cheque_layouts(bank_account_id);
`);

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

/* Auto ON hands out the next number in the series. Auto OFF makes the
   operator type it. Default ON, because that is what every existing shop
   already had and a silent switch to manual entry would be a nasty
   surprise mid-shift. */
addColumn("doc_numbering", "auto_enabled", "INTEGER NOT NULL DEFAULT 1");

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
    ["purchase",  "PU", 7, "purchases",  "purchase_no",  null],
    // Its own series and its own prefix from the start — a dispatch note is
    // not a bill, and nothing else writes to this column.
    ["dispatch",  "DN", 7, "dispatches", "dispatch_no",  null],
    ["delivery",  "DL", 7, "deliveries", "delivery_no",  null],
    /* Width 4 and no prefix, unlike every other series here: a selection
       slip is torn off a printed pad numbered 0001-9999, and the number the
       app shows has to be the number on the paper in the customer's hand.
       Editable in Settings like the rest. */
    ["selection", "", 4, "selection_slips", "slip_no", null]
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

/* THE BARCODE WE PRINT, which is not the same thing as the one above.
   `products.barcode` is free text for the manufacturer's number, typed off
   whatever the supplier printed. This is the shop's own code, generated,
   and it is per SIZE because a size is what carries a rate and a count: an
   8x4 sheet and a 6x4 sheet of the same board are different money and
   different stock, so a label that only said which product it was would
   still leave the counter choosing by hand.

   Derived from the product's SKU, which is already unique, so a shop can
   read a label aloud down a phone and it still means something. Backfilled
   below for every size that predates this. */
addColumn("product_sizes", "barcode", "TEXT DEFAULT ''");

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
CREATE TABLE IF NOT EXISTS stock_ledger (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  size_id INTEGER,
  product_id TEXT DEFAULT '',
  location_id TEXT DEFAULT '',
  movement TEXT NOT NULL DEFAULT 'stock_in',
  qty REAL NOT NULL DEFAULT 0,
  prev_qty REAL NOT NULL DEFAULT 0,
  new_qty REAL NOT NULL DEFAULT 0,
  ref_type TEXT DEFAULT '',
  ref_no TEXT DEFAULT '',
  ref_id TEXT DEFAULT '',
  staff TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_at ON stock_ledger(at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_size ON stock_ledger(size_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_prod ON stock_ledger(product_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_date ON stock_ledger(date);

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

// Whether this bill was raised INTENDING to file an e-invoice or an e-way
// bill. They default to 0, so every bill already in the book reads as "not
// for filing" — which is the truth, nothing was ever filed for them. Nothing
// is validated against the GST portal's rules unless one of these is 1.
addColumn("invoices", "einvoice_wanted", "INTEGER NOT NULL DEFAULT 0");
addColumn("invoices", "ewb_wanted", "INTEGER NOT NULL DEFAULT 0");

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

/* The e-invoice portal requires a six-digit PIN for both the shop and the
   buyer, and neither was stored anywhere. Added as plain optional columns so
   nothing existing is disturbed: every current row simply has none until it
   is filled in, and the readiness check names exactly which records need it
   rather than blocking billing. Legal Name and Trade Name are separate from
   business_name because the portal matches them against the GSTIN record,
   which often differs from the name a shop trades under. */
addColumn("settings", "pin_code", "TEXT NOT NULL DEFAULT ''");
addColumn("settings", "legal_name", "TEXT NOT NULL DEFAULT ''");
addColumn("settings", "trade_name", "TEXT NOT NULL DEFAULT ''");
addColumn("customers", "pin_code", "TEXT NOT NULL DEFAULT ''");
addColumn("suppliers", "pin_code", "TEXT NOT NULL DEFAULT ''");
/* A product whose unit wording has no automatic UQC match gets one set by
   hand here, rather than the portal accepting a guess that is legally wrong. */
addColumn("products", "uqc", "TEXT NOT NULL DEFAULT ''");

/* E-way bill details recorded against the invoice they cover.

   These are filled in whether the bill was generated on the government
   portal by hand or, later, through an API — the storage is the same either
   way, so recording them now is not throwaway work. status is left free
   text rather than a CHECK constraint because the portal owns that
   vocabulary and it is not ours to freeze. */
addColumn("invoices", "eway_bill_no", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "eway_bill_date", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "eway_valid_until", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "eway_status", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "transporter_name", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "transporter_id", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "vehicle_type", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "lr_number", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "lr_date", "TEXT NOT NULL DEFAULT ''");
addColumn("invoices", "distance_km", "REAL NOT NULL DEFAULT 0");
addColumn("invoices", "dispatch_from", "TEXT NOT NULL DEFAULT ''");
// Per-report print preferences (paper, orientation, margins, chosen columns,
// with/without rate), as JSON keyed by report id. One column rather than a
// dozen: the set of options will keep growing, and every new one would
// otherwise be another migration.
addColumn("settings", "print_prefs", "TEXT NOT NULL DEFAULT '{}'");

/* ---- what the printed bill needs and the app never asked for ----
   The Bank Book's bank_accounts are a DIFFERENT thing: those record money
   moving in and out. These four are the shop's own details as they appear
   in the Bank Details box on a bill, so a customer knows where to pay. */
addColumn("settings", "bank_name", "TEXT NOT NULL DEFAULT ''");
addColumn("settings", "bank_account_no", "TEXT NOT NULL DEFAULT ''");
addColumn("settings", "bank_ifsc", "TEXT NOT NULL DEFAULT ''");
addColumn("settings", "bank_branch", "TEXT NOT NULL DEFAULT ''");

/* The banner text and the closing line, typed by the owner rather than
   fixed in code. Separate per document, because "SALE BILL" and
   "DELIVERY CHALLAN" are not interchangeable. */
addColumn("settings", "invoice_title", "TEXT NOT NULL DEFAULT 'TAX INVOICE'");
addColumn("settings", "challan_title", "TEXT NOT NULL DEFAULT 'DELIVERY CHALLAN'");
addColumn("settings", "footer_message", "TEXT NOT NULL DEFAULT 'Thank you for your business!'");

/* ORIGINAL / DUPLICATE / TRIPLICATE, printed top-right. Off by default so
   nobody's existing bills change appearance without them asking. */
addColumn("settings", "show_copy_label", "INTEGER NOT NULL DEFAULT 0");

/* ---- fields the bill layout shows that the document never stored ---- */
addColumn("invoices", "due_date", "TEXT");
addColumn("invoices", "transport_mode", "TEXT");

/* Per-line discount percentage.
   Until now a discount was one figure for the whole bill (invoices.discount_type
   / discount_value / discount_amount), and that stays exactly as it is — this
   is an ADDITIONAL discount applied to the line before the bill-level one, so
   every existing bill still totals to precisely what it did. Default 0 means
   no line ever changes value on upgrade. */
addColumn("invoice_items", "discount_pct", "REAL NOT NULL DEFAULT 0");
/* A Sale Bill prints the Estimate number it came from. The link is stored on
   the quotation, so the lookup runs backwards and needs this index. */
db.exec("CREATE INDEX IF NOT EXISTS idx_quotations_converted ON quotations(converted_invoice_id)");

addColumn("invoices", "ack_status", "TEXT NOT NULL DEFAULT 'Pending'");
addColumn("invoices", "ack_received_at", "INTEGER");
addColumn("invoices", "ack_receiver_name", "TEXT DEFAULT ''");
addColumn("invoices", "ack_remarks", "TEXT DEFAULT ''");

/* Clear floating-point dust out of the stored balances.

   `due` is a REAL, and every bill and payment used to be added to it without
   rounding. Binary floating point cannot hold 0.01 exactly, so the error
   accumulates: paying a bill off in instalments left roughly two customers in
   five owing something like 0.0000000000001. That shows as ₹0.00 on screen but
   is still greater than zero, and the Outstanding list, the receivable count
   and the balance sheet all test `due > 0` — so a customer who had paid in
   full never left the list.

   Every write now rounds (see the routes), and this clears what the old ones
   left behind. Rounding a rupee figure to paise cannot lose real money: it
   only removes a fraction of a paisa that was never owed. It rewrites nothing
   where the value is already clean. */
const dust = db.prepare(
  "SELECT COUNT(*) n FROM customers WHERE due <> ROUND(due, 2)"
).get().n + db.prepare(
  "SELECT COUNT(*) n FROM suppliers WHERE due <> ROUND(due, 2)"
).get().n;
if (dust) {
  db.exec("UPDATE customers SET due = ROUND(due, 2) WHERE due <> ROUND(due, 2)");
  db.exec("UPDATE suppliers SET due = ROUND(due, 2) WHERE due <> ROUND(due, 2)");
  console.log(`Tidied ${dust} account balance(s) that carried floating-point dust.`);
}

/* Delivery areas, broken into the parts a dispatch round is planned by.
   "Bhandup East" is one area, but a driver thinks in station and side, and a
   dispatcher thinks in line — so the pieces are stored rather than parsed out
   of the name every time. Left NULL for an area that is not a station, like
   the shop's own "Local". */
addColumn("areas", "station", "TEXT");
addColumn("areas", "side", "TEXT");   // 'East' | 'West' | NULL

/* Zone, sub-area and route: the coarser and finer cuts a delivery round is
   actually planned by. A zone groups areas ("North Mumbai"), a sub-area names
   the pocket within one ("Mamletdar Wadi"), and a route is the run a van does
   on a given day — which is not the same as geography, because two adjacent
   areas can sit on different days' rounds.

   Left blank on the 193 areas already seeded. Blank, not guessed: inventing a
   zone for Kasara would be a claim about how this shop organises its rounds
   that only the shop can make. */
/* Which Purchase Invoice a Cash/Kachha purchase challan became.
 *
 * The mirror of invoices.converted_invoice_id on the sales side. Set once and
 * never cleared: it is what stops the same goods being billed twice, and what
 * lets either document open the other. */
addColumn("purchases", "converted_purchase_id", "TEXT");

/* ------------------------------------------------------------
   NOTEPAD

   Typed text and pen strokes in the same note, because the shop writes both:
   a measurement scribbled while on the phone, a name typed properly after.

   The ink is SVG path data, not an image — a few hundred bytes a note, so it
   sits in the database and rides along in the backup like everything else. A
   PNG on disk would be gone the first time the host rebuilt its container.
   ------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  ink TEXT DEFAULT '',           -- SVG path data, '' when nothing was drawn
  ink_height INTEGER DEFAULT 0,  -- the canvas it was drawn on, so it redraws true
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(pinned DESC, updated_at DESC);
`);

/* A dismissed reminder is only hidden from the bell; the business record it
   came from is never changed.  Keep the text fingerprint too, so a reminder
   naturally returns when that record changes and needs attention again. */
db.exec(`
CREATE TABLE IF NOT EXISTS dismissed_reminders (
  reminder_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL DEFAULT '',
  dismissed_at INTEGER NOT NULL,
  dismissed_by TEXT DEFAULT ''
);
`);

/* THE SHOP'S OWN REMINDERS — "call Laxmi Thursday", "renew the licence".
   A SEPARATE THING from the reminders worked out of the books, and kept
   separate on purpose. Those are questions asked of live data and cannot be
   edited, because editing one would only make it disagree with the ledger.
   These are the shop's own words, so they can be written, changed and
   thrown away freely.

   The link to a customer or product is deliberately soft: just an id and
   the name as it read when the reminder was written. A reminder saying
   "chase Laxmi" should survive Laxmi being renamed or removed — it is a
   note to a person, not a foreign key into the books. */
db.exec(`
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_date TEXT DEFAULT '',
  due_time TEXT DEFAULT '',
  link_kind TEXT DEFAULT '',
  link_id TEXT DEFAULT '',
  link_name TEXT DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT DEFAULT '',
  updated_at INTEGER
);
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(done, due_date)");

addColumn("areas", "zone", "TEXT DEFAULT ''");
addColumn("areas", "sub_area", "TEXT DEFAULT ''");
addColumn("areas", "route", "TEXT DEFAULT ''");

/* A note against one line of a purchase order, not the whole order.

   The order already has a Remarks box, but it is the wrong place for
   "send this one in 12mm if 18mm is short" — that belongs beside the item
   it is about, and it has to survive into the brand-wise WhatsApp message
   where the supplier reads only their own few lines. */
addColumn("purchase_order_items", "remark", "TEXT DEFAULT ''");

/* ============================================================
   WHO A PURCHASE ORDER IS FOR

   A PO already recorded who the goods come FROM. It records nothing about
   who they are for, so the moment a salesman orders 20 sheets against a
   customer's requirement, the link between that requirement and this order
   lives only in his head.

   These columns hold the chain the owner actually wants to follow:

     salesman -> customer -> sales order -> PO -> supplier -> goods

   Both a header party and an item party, because both happen: a PO raised
   for one customer's job, and a PO consolidating three customers' needs
   into one order to the mill. The item column wins where it is set; the
   header is the default for lines that name nobody.

   Salesman is free text rather than a new master table. Sales already
   records it that way (invoices.delivery_man, which the salesman-wise
   report reads), and a second list of names to keep in step would drift
   from the first within a month. The screen offers the names already in
   use so they stay spelled the same.
   ============================================================ */
addColumn("purchase_orders", "po_type", "TEXT NOT NULL DEFAULT 'General'");
addColumn("purchase_orders", "salesman", "TEXT DEFAULT ''");
addColumn("purchase_orders", "against_customer_id", "TEXT");
addColumn("purchase_orders", "so_id", "TEXT");
addColumn("purchase_orders", "required_delivery_date", "TEXT DEFAULT ''");
addColumn("purchase_order_items", "against_customer_id", "TEXT");

/* How much of each line has actually turned up.

   Converting a PO used to be all-or-nothing, so a mill sending 60 of 100
   sheets left the order looking either untouched or complete, and the 40
   still owed to the customer were nobody's number. Received quantity per
   line is what makes "40 pending against ABC Traders" answerable. */
addColumn("purchase_order_items", "received_qty", "REAL NOT NULL DEFAULT 0");

/* The shop's own covering note above a purchase order on WhatsApp.
   The order itself is generated and stays generated; only the greeting
   around it is theirs to word. Blank means use the built-in wording. */
addColumn("settings", "po_wa_template", "TEXT DEFAULT ''");

/* The colour the app itself wears. Shop-wide rather than per-device: the
   look is the shop's, and a counter, a phone and a tablet showing three
   different colours reads as three different apps. Blank means the
   original navy and gold, so an existing shop sees no change. */
addColumn("settings", "app_theme", "TEXT DEFAULT ''");

/* WHOSE BOOKS THESE ARE.

   The activation code of the shop this database belongs to, written
   when they first sign in. It is redundant with the tenant map beside
   it, and that redundancy is the point: the map is one file, and if it
   is ever lost or restored a run out of step, this is what lets the app
   find the right books instead of creating an empty company and leaving
   the real ones orphaned.

   Backed up automatically, because it lives inside the books. */
addColumn("settings", "tenant_code", "TEXT DEFAULT ''");

/* WHICH HOME TILES THIS SHOP HAS PUT AWAY.

   The shop's own choice, and nothing to do with what the vendor sold
   them — those are two different questions and they are kept apart: the
   vendor decides what EXISTS, the shop decides what it wants on its own
   front screen.

   The hidden list, not the shown list, for the same reason as everywhere
   else here: a tile added in a later version then appears by itself
   instead of being invisible to every shop that saved a list before it
   existed. Putting a tile away never touches the screen behind it, which
   stays reachable from the menu. */
addColumn("settings", "home_tiles_hidden", "TEXT DEFAULT ''");

/* And the other direction: screens the shop has PUT ON Home that were not
   there to begin with. Kept as its own list rather than inverting the one
   above, because the two mean different things — that one is "I do not
   want this", this one is "I want this as well" — and a single list would
   have to guess which a key meant every time the built-in set changed. */
addColumn("settings", "home_tiles_added", "TEXT DEFAULT ''");

/* THE GST PROVIDER, SET FROM INSIDE THE APP.

   Provider and environment are not secrets — the shop can see which GSP it
   is pointed at and whether it is on sandbox.

   gst_credentials IS a secret, and the rule that governs it is absolute:
   it is written here and NEVER read back out to a browser. publicSettings()
   in routes/settings.js strips it, and the status endpoint answers only
   "set" or "not set". The screen used to have no field for a key at all,
   for the good reason that everything else in this table is handed to any
   signed-in staff member; this column is the exception and has to be
   treated as one every time something new reads from settings.

   AN ENVIRONMENT VARIABLE STILL WINS over anything stored here. A hosted
   copy that already sets EWB_PROVIDER keeps working untouched, and a secret
   kept in the host rather than the database stays out of the nightly backup
   — which is a real difference, because these rows are copied to the cloud
   and restored on every redeploy. */
addColumn("settings", "gst_provider", "TEXT DEFAULT ''");
addColumn("settings", "gst_env", "TEXT DEFAULT ''");
addColumn("settings", "gst_credentials", "TEXT DEFAULT ''");

/* ============================================================
   WHO WROTE THIS BILL, AND WHO CHANGED IT

   Several people bill from their own phones at once. The books recorded
   what was sold and when, and nothing at all about which of them did it,
   so a wrong rate or a missing line was a question nobody could answer
   without asking the whole counter.

   created_by is written once and never touched again. updated_by moves
   every time the document is edited, which is the pair the shop actually
   needs: who raised it, and who last touched it. One field could not say
   both, and the second is the one that gets argued about.

   Names, not staff ids: a staff row can be renamed or removed, and a bill
   from last March must still say who wrote it. The audit log already
   stores names for the same reason.
   ============================================================ */
addColumn("invoices", "created_by", "TEXT DEFAULT ''");
addColumn("invoices", "updated_by", "TEXT DEFAULT ''");
addColumn("invoices", "updated_at", "INTEGER");

/* ============================================================
   WHO MAY DO WHAT

   The shop had two roles — owner and staff — and every gate in the app
   was one of those two. That answers "can they open Settings" and nothing
   else: the person who takes orders and the person who enters purchases
   were the same user as far as the app was concerned.

   Permissions are stored per staff member, not per role. Roles are a
   starting point the owner picks from — a shop with four salesmen will
   want three of them identical and one allowed to see outstanding, and a
   role-only model forces a new role to be invented for that one person.
   The role is kept as a label and as the source of the defaults; what
   actually gets checked is the row.

   Delete is deliberately NOT a column here. It is not configurable — it
   belongs to the owner, enforced ahead of every route in index.js — and a
   column would invite somebody to switch it on.
   ============================================================ */
addColumn("staff", "login_id", "TEXT DEFAULT ''");

/* The role a staff member was created as. The CHECK on the original column
   only allows owner/staff, and widening it would mean rebuilding the table
   on every existing shop; this carries the finer role beside it. Anything
   the app has not been taught about falls back to the plain staff rules. */
addColumn("staff", "job_role", "TEXT DEFAULT ''");

/* The salesman this login IS. A sales staff member's own transactions are
   recorded against this name, and Own Only scope is measured by it. */
addColumn("staff", "salesman_name", "TEXT DEFAULT ''");

/* Own Only | Assigned Staff | All Staff | All Data. Blank means Own Only:
   an unconfigured login should see the least, not the most. */
addColumn("staff", "data_scope", "TEXT DEFAULT ''");

db.exec(`
CREATE TABLE IF NOT EXISTS staff_permissions (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  module   TEXT NOT NULL,
  can_view  INTEGER NOT NULL DEFAULT 0,
  can_add   INTEGER NOT NULL DEFAULT 0,
  can_edit  INTEGER NOT NULL DEFAULT 0,
  can_print INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (staff_id, module)
);

-- Which salesmen a manager may see. Empty for everyone else.
CREATE TABLE IF NOT EXISTS staff_assigned (
  manager_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (manager_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_perm ON staff_permissions(staff_id);
`);

/* Indexes for the party- and salesman-wise reports: without them every
   report scans every PO line the shop has ever raised. */
db.exec("CREATE INDEX IF NOT EXISTS idx_po_customer ON purchase_orders(against_customer_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_po_salesman ON purchase_orders(salesman)");
db.exec("CREATE INDEX IF NOT EXISTS idx_po_so ON purchase_orders(so_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_poi_customer ON purchase_order_items(against_customer_id)");

/* A station can sit on more than one line — CSMT is Central and Harbour, Bandra
   is Western and Harbour — so line membership is its own table rather than a
   column that would force a false choice. */
db.exec(`
CREATE TABLE IF NOT EXISTS area_lines (
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  line TEXT NOT NULL,
  PRIMARY KEY (area_id, line)
);
CREATE INDEX IF NOT EXISTS idx_area_lines_line ON area_lines(line);
`);

/* ------------------------------------------------------------
   DELIVERY DISPATCH

   A dispatch is one VEHICLE TRIP, not one bill. A van leaving with five
   customers' goods is one dispatch carrying five drops, so the vehicle and
   driver are recorded once and each customer still gets their own status,
   signature and delivery time.

   Dispatch NEVER touches stock. The invoice already deducted it when the sale
   was made; deducting again here would take the goods out of stock twice.
   ------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  dispatch_no TEXT UNIQUE NOT NULL,
  dispatch_at INTEGER NOT NULL,
  vehicle_no TEXT DEFAULT '',
  driver_name TEXT DEFAULT '',
  driver_mobile TEXT DEFAULT '',
  -- Pending | Ready | Out | Delivered | Partial | Cancelled | Returned
  status TEXT NOT NULL DEFAULT 'Pending',
  notes TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);

-- One stop: this customer, this bill, this address.
CREATE TABLE IF NOT EXISTS dispatch_drops (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,           -- order of drops on the round
  invoice_id TEXT REFERENCES invoices(id),
  order_id TEXT,
  customer_id TEXT,
  -- Copied at dispatch time: the van carries the address as it was printed,
  -- and editing the customer months later must not rewrite delivery history.
  customer_name TEXT DEFAULT '',
  customer_mobile TEXT DEFAULT '',
  customer_gstin TEXT DEFAULT '',
  delivery_address TEXT DEFAULT '',
  landmark TEXT DEFAULT '',
  pincode TEXT DEFAULT '',
  area_id TEXT REFERENCES areas(id),
  status TEXT NOT NULL DEFAULT 'Pending',
  delivered_at INTEGER,
  received_by TEXT DEFAULT '',
  -- Proof of delivery: the finger-drawn signature, as SVG path data. Kept in
  -- the database so the existing backup carries it; a file on disk would be
  -- lost on any host that resets its filesystem.
  signature TEXT DEFAULT '',
  remarks TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_drops_dispatch ON dispatch_drops(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_drops_invoice ON dispatch_drops(invoice_id);

/* What actually went on the van. qty_ordered is what the bill says;
   qty_dispatched is what was loaded. The difference IS the outstanding
   quantity — which is what makes "Partial" mean something a shop can act on
   rather than a label someone has to remember the meaning of. */
CREATE TABLE IF NOT EXISTS dispatch_items (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL REFERENCES dispatch_drops(id) ON DELETE CASCADE,
  -- INTEGER, matching invoice_items.id, which is a rowid. Declared TEXT this
  -- would store 1 as "1" and never match the number it points at, so every
  -- delivered quantity would silently fail to count against the bill.
  invoice_item_id INTEGER,
  product_id TEXT,
  product_name TEXT DEFAULT '',
  size_label TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  qty_ordered REAL NOT NULL DEFAULT 0,
  qty_dispatched REAL NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dispatch_items_drop ON dispatch_items(drop_id);

-- Every status change, so "when did it actually leave" has an answer.
CREATE TABLE IF NOT EXISTS dispatch_status_log (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  drop_id TEXT REFERENCES dispatch_drops(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT DEFAULT '',
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dispatch_log ON dispatch_status_log(dispatch_id, at);
`);

/* ------------------------------------------------------------
   DELIVERY

   Dispatch is goods LEAVING; delivery is goods ARRIVING. They are kept in
   separate tables with separate numbering on purpose: a shop that asks "what
   went out on Tuesday" and "what reached the customer on Tuesday" is asking
   two different questions, and one table with a status column answers neither
   cleanly once a load goes out on Tuesday and lands on Thursday.

   A delivery may be raised from a dispatch drop or entered on its own — a
   customer collecting from the shop is a delivery with no dispatch behind it.

   Like dispatch, this NEVER touches stock. The invoice already deducted it.
   ------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  delivery_no TEXT UNIQUE NOT NULL,
  delivery_at INTEGER NOT NULL,

  -- Where it came from, when it came from anywhere. Both nullable: a walk-in
  -- collection has neither.
  dispatch_id TEXT REFERENCES dispatches(id),
  drop_id TEXT REFERENCES dispatch_drops(id),

  invoice_id TEXT REFERENCES invoices(id),
  order_id TEXT,
  customer_id TEXT,
  -- Copied, not joined: the delivery note records the address the goods went
  -- to, and editing the customer next year must not rewrite last year's note.
  customer_name TEXT DEFAULT '',
  customer_mobile TEXT DEFAULT '',
  customer_gstin TEXT DEFAULT '',
  delivery_address TEXT DEFAULT '',
  landmark TEXT DEFAULT '',
  pincode TEXT DEFAULT '',

  area_id TEXT REFERENCES areas(id),
  sub_area TEXT DEFAULT '',
  route TEXT DEFAULT '',

  transporter TEXT DEFAULT '',
  vehicle_no TEXT DEFAULT '',
  driver_name TEXT DEFAULT '',
  driver_mobile TEXT DEFAULT '',

  -- Pending | Out | Delivered | Partial | Cancelled | Returned
  status TEXT NOT NULL DEFAULT 'Pending',
  delivered_at INTEGER,
  received_by TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  remarks TEXT DEFAULT '',

  created_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deliveries_area ON deliveries(area_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON deliveries(customer_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_invoice ON deliveries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_at ON deliveries(delivery_at);

CREATE TABLE IF NOT EXISTS delivery_items (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  invoice_item_id INTEGER,          -- INTEGER: invoice_items.id is a rowid
  product_id TEXT,
  product_name TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  size_label TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_delivery_items ON delivery_items(delivery_id);

CREATE TABLE IF NOT EXISTS delivery_status_log (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT DEFAULT '',
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_delivery_log ON delivery_status_log(delivery_id, at);
`);


/* ============================================================
   SELECTION SLIP

   The pink slip the counter writes while the customer is still standing at
   the catalogue. It is not a quotation and not an order: it is the record of
   WHICH DESIGNS THIS PARTY PICKED, so that the moment they ring back — days
   or weeks later, usually asking "that wooden one I liked" — somebody can
   read out the design numbers instead of starting the selection again.

   Three things about it are unlike every other document here, and each one
   is deliberate:

   1. THE PARTY MAY NOT HAVE AN ACCOUNT. A slip gets written for whoever
      walks in. Requiring a customer record first would mean the slip does
      not get written at all, which loses the only thing it exists to keep.
      So customer_id is optional and customer_name always holds the name as
      written. A slip made for an existing customer carries both.

   2. QUANTITY IS USUALLY BLANK, AND BLANK IS NOT ZERO. The party has chosen
      designs, not amounts — the Qty column on the paper slip is empty far
      more often than not. Storing that as 0 would turn "not decided yet"
      into "none wanted", and the difference is the whole conversation when
      they call back. qty and rate are therefore nullable.

   3. A LINE NEED NOT BE A PRODUCT. Laminate design numbers come off a
      supplier's catalogue long before anyone creates a product record for
      them, and the slip must be able to hold 2066HG whether or not the shop
      stocks it. product_id is optional; design_no is always written down.
      Where a line IS linked to a product, the link is what lets the slip
      convert into a quotation without retyping.

   The referrer is the Ar / ID / Cont box on the paper: the architect,
   interior designer or contractor who sent the party in. Recorded because
   it is who gets the follow-up call and, at some shops, the commission.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS selection_slips (
  id TEXT PRIMARY KEY,
  slip_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  -- Optional link; the name is always there. See note 1 above.
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  contact TEXT DEFAULT '',

  -- The Ar | ID | Cont box.
  referrer_type    TEXT DEFAULT '',
  referrer_name    TEXT DEFAULT '',
  referrer_contact TEXT DEFAULT '',

  site_address TEXT DEFAULT '',

  -- Free text, matching purchase_orders.salesman deliberately: one spelling
  -- of a salesman's name across the app beats two lists drifting apart.
  salesman         TEXT DEFAULT '',
  salesman_contact TEXT DEFAULT '',

  remarks TEXT DEFAULT '',

  -- Sum of the lines that HAVE both a quantity and a rate. Lines still
  -- undecided contribute nothing rather than distorting it.
  total REAL NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'Open'
    CHECK (status IN ('Open', 'Quoted', 'Converted', 'Cancelled')),

  -- Set once Convert to Quotation runs, so the slip links forward.
  converted_quotation_id TEXT REFERENCES quotations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sel_customer ON selection_slips(customer_id);
CREATE INDEX IF NOT EXISTS idx_sel_salesman ON selection_slips(salesman);
CREATE INDEX IF NOT EXISTS idx_sel_date ON selection_slips(date);
CREATE INDEX IF NOT EXISTS idx_sel_status ON selection_slips(status);

CREATE TABLE IF NOT EXISTS selection_slip_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_id TEXT NOT NULL REFERENCES selection_slips(id) ON DELETE CASCADE,

  -- The order the lines were written in. The paper slip is numbered by hand
  -- and the party refers to "the third one", so the sequence is data.
  sr_no INTEGER NOT NULL DEFAULT 0,

  -- Optional. See note 3 above.
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,

  design_no   TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',

  -- NULL means "not decided", 0 means "none". Never conflate them.
  qty  REAL,
  rate REAL,

  -- qty * rate when both are known, else 0. Stored rather than computed so
  -- a report never has to re-derive it and get a different answer.
  amount REAL NOT NULL DEFAULT 0,

  -- The margin note on the paper — "(Plain)", "matt finish", "check stock".
  -- Beside the line it is about, the way it is written on the slip.
  remark TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sel_items ON selection_slip_items(slip_id);
CREATE INDEX IF NOT EXISTS idx_sel_items_design ON selection_slip_items(design_no);
CREATE INDEX IF NOT EXISTS idx_sel_items_product ON selection_slip_items(product_id);
`);


/* ============================================================
   WHICH GST PERIODS HAVE BEEN FILED

   The financial-year lock beside this freezes a whole year and refuses
   writes outright. GST is not that. Returns go monthly — GSTR-1 and
   GSTR-3B, on different dates — and a shop very often does need to correct
   a month it has already filed. The law has amendments for exactly that.

   So this does not block anything. It answers one question: "the bill you
   are about to delete falls in August, and you filed GSTR-1 for August on
   the 9th of September — did you mean to?" An owner who did mean to
   carries on and files an amendment. An owner who did not has just been
   saved a reconciliation they would otherwise have discovered months later
   from a notice.

   Rows are never deleted, only re-opened. Whether a month was filed, and
   when, is the record that explains a figure — throwing it away to tidy
   the screen is how the question becomes unanswerable.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS gst_filings (
  id          TEXT PRIMARY KEY,

  -- 'YYYY-MM'. A GST period is a calendar month, never a financial year.
  period      TEXT NOT NULL,

  -- GSTR-1 (outward supplies) and GSTR-3B (summary + tax paid) are filed
  -- separately and on different dates, so they are tracked separately. A
  -- shop that has filed GSTR-1 but not 3B for a month is in a real and
  -- common state, and one row per month could not describe it.
  return_type TEXT NOT NULL,

  filed_on    TEXT NOT NULL DEFAULT '',
  -- The acknowledgement number the portal gives back. Optional, because a
  -- shop that files through its accountant often does not have it to hand
  -- and should not be stopped from recording that the month is done.
  arn         TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  filed_by    TEXT DEFAULT '',

  -- 'filed' | 'reopened'. Re-opening keeps the row and its history rather
  -- than deleting it, so "was August ever filed, and when" stays answerable.
  status      TEXT NOT NULL DEFAULT 'filed',
  reopened_on TEXT DEFAULT '',
  reopened_by TEXT DEFAULT '',

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER,

  UNIQUE (period, return_type)
);
CREATE INDEX IF NOT EXISTS idx_gst_filings_period ON gst_filings(period);
`);


/* ============================================================
   PARTY-WISE PRICE LISTS

   One product, many rates. ABC Traders buy 18mm at 2,100 and XYZ at
   2,050, and the counter should not have to remember which.

   FOUR RULES DECIDE THE WHOLE DESIGN.

   1. A RATE CHANGE IS A NEW ROW, NEVER AN EDIT. Rows are never rewritten
      when a price moves; a new one is inserted with a later effective_from
      and the old one stays exactly as it was. That is what makes the
      history real rather than a log written beside the truth, and it is
      what lets a back-dated bill get the rate that applied on ITS date
      rather than today's.

   2. A SAVED BILL IS NEVER RE-PRICED. invoice_items.rate has always held
      the rate as sold, and nothing here reads a price list at print or
      report time — only when a line is first added to a document. Changing
      a price list cannot reach backwards into a bill that already exists,
      and no rule in here is what stops it: the rate simply is not stored
      in one place and read from another.

   3. NULL CUSTOMER MEANS EVERYBODY. The general list and a party's own
      list are the same table, distinguished only by whether customer_id is
      set. Resolution prefers the party's row and falls back to the general
      one, so there is one query and one set of rules rather than two lists
      that disagree at the edges.

   4. QUANTITY BANDS ARE ROWS TOO. "1-20 at 2,200, 21-50 at 2,150, 51+ at
      2,100" is three rows differing only in min_qty. Nothing special.

   SIDE deliberately separates buying from selling in one table rather than
   two. Every rule above is identical for a supplier's purchase rate, and
   a second table would be the same code twice, drifting.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS price_list (
  id TEXT PRIMARY KEY,

  -- 'sale' | 'purchase'. Sales rates are keyed to a customer, purchase
  -- rates to a supplier; everything else about them is the same.
  side TEXT NOT NULL DEFAULT 'sale',

  -- NULL = the general rate, used for any party with no rate of their own.
  party_id TEXT,

  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  -- NULL = every size of the product. A shop that prices by product rather
  -- than by size should not have to write a row per size.
  size_id INTEGER REFERENCES product_sizes(id) ON DELETE CASCADE,

  -- Copied at the time the row was written, for display, for the Excel
  -- import to match on, and so a row still reads sensibly after a product
  -- has been renamed. Never used to decide which row applies.
  brand     TEXT DEFAULT '',
  category  TEXT DEFAULT '',
  size_label TEXT DEFAULT '',
  thickness TEXT DEFAULT '',
  unit      TEXT DEFAULT '',

  rate REAL NOT NULL,

  -- The band this rate applies to. max_qty NULL means "and upwards".
  min_qty REAL NOT NULL DEFAULT 0,
  max_qty REAL,

  -- effective_to NULL means "still current". A row is never deleted to end
  -- it; it is closed, so what was charged last March stays answerable.
  effective_from TEXT NOT NULL,
  effective_to   TEXT,

  active INTEGER NOT NULL DEFAULT 1,
  remark TEXT DEFAULT '',

  created_at INTEGER NOT NULL,
  created_by TEXT DEFAULT '',
  -- Set when a row is deactivated or closed. The row itself still never
  -- changes its rate.
  updated_at INTEGER,
  updated_by TEXT DEFAULT ''
);

-- The index resolution actually uses: narrow to one party's rows for one
-- product before looking at dates or quantities.
CREATE INDEX IF NOT EXISTS idx_pl_lookup ON price_list(side, product_id, party_id, active);
CREATE INDEX IF NOT EXISTS idx_pl_party ON price_list(party_id, side);
CREATE INDEX IF NOT EXISTS idx_pl_product ON price_list(product_id, side);

/* Every change to a rate, in the owner's words.

   The rows above are already a history — a new rate is a new row — so this
   is not where the old rate is kept. It is where the REASON is, and who
   decided it, which the rows cannot hold: closing one row and opening
   another is two events and one decision. */
CREATE TABLE IF NOT EXISTS price_list_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  side TEXT NOT NULL DEFAULT 'sale',
  party_id TEXT,
  party_name TEXT DEFAULT '',
  product_id TEXT,
  product_name TEXT DEFAULT '',
  size_label TEXT DEFAULT '',
  action TEXT NOT NULL,              -- added | changed | deactivated | reactivated | imported
  old_rate REAL,
  new_rate REAL,
  reason TEXT DEFAULT '',
  by_name TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pl_log ON price_list_log(party_id, at);
CREATE INDEX IF NOT EXISTS idx_pl_log_product ON price_list_log(product_id, at);
`);

/* The salesman a party belongs to.

   Free text, matching purchase_orders.salesman and selection_slips.salesman
   deliberately: one spelling of a name across the app beats a second list
   of names drifting from the first. */
addColumn("customers", "salesman", "TEXT DEFAULT ''");
/* How much bigger or smaller each line of the printed letterhead is, as a
   JSON object of factors — {"name":1.2,"addr":0.9}. Empty means every one
   is 1, which is what the bill has always printed at. Stored shop-wide
   rather than per device: the letterhead is the shop's identity and must
   not differ between the counter PC and a phone. */
addColumn("settings", "header_scales", "TEXT NOT NULL DEFAULT ''");
/* The government portal the e-way bill screen links to. Blank means the
   e-way bill portal, which is where most shops go. A shop filing through
   the e-invoice portal, or through its GSP's own site, sets its own. */
addColumn("settings", "portal_url", "TEXT NOT NULL DEFAULT ''");

/* MOVED HERE DELIBERATELY, AND THIS IS WHY.

   This reads settings.invoice_title  a column added by addColumn() above.
   It used to sit 769 lines EARLIER, before that column existed. On a
   database that already had the column it worked; on a FRESH one it threw
   "no such column: invoice_title" during startup, and a server that cannot
   start is a deploy that fails. Nine of them, until this was found by
   booting the build against an empty data directory.

   Data migrations belong after the columns they read. */
/* The seeded title said ESTIMATE CHALLAN on the SALES INVOICE, so shops that
   installed before that was fixed still carry it in their saved template —
   and a saved template beats the title in Settings, so their GST bills print
   as estimates however they set that field.

   Only the string WE seeded is replaced, and only where the shop's own
   Settings say something different — so a shop that deliberately typed
   "ESTIMATE CHALLAN" over the top of a matching setting keeps it, and a
   title anyone has edited to anything else is never touched. Nothing is
   cleared: the wrong value is replaced by the shop's own configured one, so
   the sheet ends up headed what the shop already asked for. */
(function retitleInvoiceTemplatesThatSayEstimate() {
  const rows = db.prepare(
    "SELECT id, config FROM doc_templates WHERE doc_type = 'sales_invoice'"
  ).all();
  if (!rows.length) return;
  const s = db.prepare("SELECT invoice_title FROM settings WHERE id = 1").get();
  const want = ((s && s.invoice_title) || "").trim();
  /* Nothing to correct TO, so nothing is changed. */
  if (!want || want.toUpperCase() === "ESTIMATE CHALLAN") return;

  const upd = db.prepare("UPDATE doc_templates SET config = ? WHERE id = ?");
  for (const r of rows) {
    let cfg;
    try { cfg = JSON.parse(r.config); } catch (e) { continue; }
    if (!cfg || String(cfg.title || "").trim().toUpperCase() !== "ESTIMATE CHALLAN") continue;
    cfg.title = want;
    upd.run(JSON.stringify(cfg), r.id);
  }
})();

/* Every size that predates the printed barcode gets one now, so a shop that
   has been trading for a year can print labels for its whole rack on the
   first day rather than only for what it adds afterwards.

   SKU + the size's own row id. The SKU is unique per product and the id is
   unique per size, so the pair cannot collide, and it stays put when a size
   is renamed or reordered — a label already stuck to a board must not stop
   meaning what it meant when it was printed. Only blank ones are filled:
   anything already carrying a code keeps it. */
db.prepare(`
  UPDATE product_sizes
     SET barcode = REPLACE((SELECT p.sku FROM products p WHERE p.id = product_sizes.product_id), 'SKU-', '') || '-' || product_sizes.id
   WHERE COALESCE(barcode, '') = ''
     AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_sizes.product_id AND COALESCE(p.sku,'') != '')
`).run();

// Where the data lives — the backup module needs the on-disk paths, and this
// is the single place that knows them.
db.dataDir = DATA_DIR;
db.file = file;
return db;
}

module.exports = { openCompanyDb, DATA_DIR };
