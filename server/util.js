const crypto = require("crypto");
const db = require("./db");

function uid(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

// Records who did what for accountability once multiple staff share the app.
// `req` may be omitted (e.g. during first-run seeding) — logs as System then.
//
// THE SIGNATURE IS FIXED. 217 call sites across 53 files call this with
// exactly three arguments, and PART 10 widened what gets WRITTEN without
// asking a single one of them to change: the
// actor type, the resource, the result, the address and the device are all
// worked out from `req` and `action`, which this function already had.
//
// The fourth argument is optional and new — see server/auditLog.js for what
// it accepts. A caller that wants to record a before/after change, or name
// the exact record it touched, passes it; everyone else carries on.
//
// The INSERT itself moved to auditLog.js deliberately: one writer, so the
// rule about what never reaches the log (credentials) is enforced in one
// place rather than trusted to each caller. This is not a second logging
// system beside the old one — it IS the old one, widened.
function logAction(req, action, details, opts) {
  require("./auditLog").record(req, action, details, opts);
}

/**
 * Today's date in the SHOP's own timezone, as YYYY-MM-DD.
 *
 * Deliberately not toISOString(), which formats in UTC. India is UTC+5:30, so
 * between midnight and 5:30am local time the UTC date is still YESTERDAY —
 * every invoice, cash entry and payment created in those hours was being
 * stamped with the previous day's date, and the dashboard's "Today's Sales"
 * looked at the wrong day. Worst at a month boundary: a bill written at 1am on
 * the 1st landed in the previous month, and therefore the previous GST period.
 *
 * Anything comparing against a stored `date` column must use this, not UTC.
 */
function todayStr() {
  return localDate(new Date());
}

/** YYYY-MM-DD for a Date or epoch-ms, in local time. Same reasoning as above:
 *  stored created_at timestamps rendered as a date must agree with the `date`
 *  columns they sit beside. */
function localDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * A value from a request on its way into a SQLite bind.
 *
 * node:sqlite REFUSES to bind `undefined` — it throws "Provided value cannot
 * be bound to SQLite parameter 1" rather than simply matching no row. So a
 * request missing one field (a cart line with no productId, a transfer with
 * no sizeId) blew up with a bare "Something went wrong on the server" instead
 * of the clear message the route had ready two lines further down.
 *
 * NULL is bindable and matches nothing, which is exactly the intended
 * meaning, and every one of these lookups already handles "not found".
 */
function bindId(value) {
  return value === undefined ? null : value;
}

/** A real calendar day as YYYY-MM-DD — not just the shape. "2026-02-30"
 *  has the shape and Date.parse rolls it into March without complaint, so
 *  the parsed day is written back out and compared. */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A client-made idempotency key, or "" — bounded and plain, so it can be
 *  stored and indexed without becoming a way to put arbitrary text in. */
function cleanKey(k) {
  const s = String(k == null ? "" : k).trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(s) ? s : "";
}

module.exports = { uid, todayStr, localDate, round2, logAction, bindId, isRealDate, cleanKey };
