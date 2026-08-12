/**
 * Financial-year lock.
 *
 * Closing a year does not move any money in this app — balances already carry
 * forward on their own. What closing DOES do is freeze the year, so that the
 * figures filed with the tax office cannot quietly change afterwards.
 *
 * Nothing here deletes or hides data. A closed year stays fully readable,
 * printable and exportable; it just stops accepting writes.
 */
const db = require("./db");

/** The year a given date falls in, or null if no year covers it. */
function yearFor(date) {
  if (!date) return null;
  const d = String(date).slice(0, 10);
  return db.prepare(
    "SELECT * FROM financial_years WHERE start_date <= ? AND end_date >= ? LIMIT 1"
  ).get(d, d) || null;
}

/** True when a date lands inside a year that has been closed. */
function isLocked(date) {
  const fy = yearFor(date);
  return !!(fy && fy.status === "closed");
}

/**
 * Throws when `date` falls in a closed year. The thrown error carries
 * `status = 423` (Locked) so route handlers and the global error handler can
 * pass it straight through with a message the owner will understand.
 */
function assertOpen(date, what = "This entry") {
  const fy = yearFor(date);
  if (!fy || fy.status !== "closed") return;
  const err = new Error(
    `${what} is dated ${String(date).slice(0, 10)}, which falls in financial year ` +
    `${fy.label} — that year is closed. Re-open ${fy.label} from Accounts → ` +
    `Financial Year if you need to change it.`
  );
  err.status = 423;
  err.fyLabel = fy.label;
  throw err;
}

/**
 * Where each write path keeps its documents, so an edit, a void or a delete
 * can be checked against the date already stored — those requests carry an id
 * in the URL and often no date in the body at all. Voiding a March bill in
 * September is exactly the kind of change a closed year has to refuse, and
 * checking only req.body.date would wave it straight through.
 *
 * Keyed by the first path segment under /api. Anything not listed is checked
 * on its body date alone.
 */
const DOCUMENTS = {
  invoices: { table: "invoices", column: "date" },
  purchases: { table: "purchases", column: "date" },
  quotations: { table: "quotations", column: "date" },
  "sales-orders": { table: "sales_orders", column: "date" },
  "purchase-orders": { table: "purchase_orders", column: "date" },
  "sales-returns": { table: "sales_returns", column: "date" },
  "purchase-returns": { table: "purchase_returns", column: "date" },
  "stock-ins": { table: "stock_ins", column: "purchase_date" },
  cashbook: { table: "cash_entries", column: "date" },
  bankbook: { table: "bank_entries", column: "date" },
  inquiries: { table: "inquiries", column: "date" }
};

/** The stored date of the document a request is acting on, if it names one. */
function storedDateFor(pathname) {
  const parts = String(pathname).split("/").filter(Boolean);
  const doc = DOCUMENTS[parts[0]];
  const id = parts[1];
  if (!doc || !id) return null;
  try {
    const row = db.prepare(`SELECT ${doc.column} AS d FROM ${doc.table} WHERE id = ?`).get(id);
    return row ? row.d : null;
  } catch {
    // A table this build does not have is not a reason to block the request.
    return null;
  }
}

/**
 * Express middleware. Blocks any write that touches a closed year, whether
 * the date arrives in the body (a new or back-dated entry) or belongs to the
 * document being edited, voided or deleted.
 *
 * Reads are never blocked. A closed year stays fully visible, printable and
 * exportable — it just stops changing.
 */
function guard(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const bodyDate = req.body && (req.body.date || req.body.entry_date || req.body.entryDate);
  const storedDate = storedDateFor(req.path);
  try {
    // Both are checked. Re-dating a bill OUT of a closed year is still a
    // change to that year, so the old date has to be honoured too.
    if (storedDate) assertOpen(storedDate, "This document");
    if (bodyDate) assertOpen(bodyDate);
    next();
  } catch (e) {
    res.status(e.status || 423).json({ error: e.message });
  }
}

module.exports = { yearFor, isLocked, assertOpen, guard };
