const crypto = require("crypto");
const db = require("./db");

function uid(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

// Records who did what for accountability once multiple staff share the app.
// `req` may be omitted (e.g. during first-run seeding) — logs as System then.
function logAction(req, action, details) {
  const staffId = req && req.session ? req.session.staffId : null;
  const staffName = req && req.session ? req.session.staffName : "System";
  const role = req && req.session ? req.session.role : "system";
  db.prepare(`
    INSERT INTO audit_log (at, staff_id, staff_name, role, action, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now(), staffId || null, staffName || "System", role || "system", action, details || "");
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

module.exports = { uid, todayStr, localDate, round2, logAction, bindId };
