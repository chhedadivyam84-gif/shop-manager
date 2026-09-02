/* ============================================================
   THE STOCK LEDGER — every movement, and what it did to the count

   One row per change, written by inventory.addStock() and by nothing else.
   That matters: addStock is the ONLY place in the app that alters a stock
   quantity, so logging there catches purchase, sale, return, transfer,
   adjustment and manual entry without asking thirty-two call sites to
   remember — and without a future one being able to forget.

   WHAT MAKES IT A LEDGER RATHER THAN A LOG. Each row carries the quantity
   BEFORE and AFTER, taken at the moment of the change inside the same
   transaction. So the shop can read a line and see 100 → 150 rather than
   working it out by adding up everything above it, and any row can be
   checked on its own: previous + change must equal new.

   NOTHING IS EVER DELETED OR REWRITTEN. A cancelled bill does not remove
   its row; putting the stock back is itself a movement and gets a row of
   its own, which is how the count and the history stay able to explain
   each other. There is deliberately no update or delete in this file.

   ADDING CONTEXT WITHOUT THREADING IT THROUGH EVERYTHING. addStock knows
   the size, the place and the amount, but not who did it or which bill it
   was for. Those come from a per-request context held in
   AsyncLocalStorage, set once when the request arrives and read here — so
   a route says what it is doing once, rather than every call site passing
   four more arguments.
   ============================================================ */

const { AsyncLocalStorage } = require("node:async_hooks");
const db = require("./db");
const { uid, todayStr } = require("./util");

const store = new AsyncLocalStorage();

/* The movements a shop would recognise. Kept as a list so the filter
   dropdown and the writer cannot disagree about what exists. */
const MOVEMENTS = [
  { key: "opening",         label: "Opening Stock" },
  { key: "purchase",        label: "Purchase" },
  { key: "sale",            label: "Sale" },
  { key: "sales_return",    label: "Sales Return" },
  { key: "purchase_return", label: "Purchase Return" },
  { key: "transfer",        label: "Stock Transfer" },
  { key: "adjustment",      label: "Stock Adjustment" },
  { key: "manual",          label: "Manual Stock Entry" },
  { key: "stock_in",        label: "Stock In" },
  { key: "stock_out",       label: "Stock Out" }
];
const MOVEMENT_KEYS = new Set(MOVEMENTS.map(m => m.key));

/**
 * Run something with a description of what the shop is doing.
 *
 * Everything inside — however deep — records against this. Nested calls
 * merge, so a route can name the document once and a helper can add a
 * remark without losing it.
 */
function withContext(ctx, fn) {
  const merged = { ...(store.getStore() || {}), ...(ctx || {}) };
  return store.run(merged, fn);
}

/** What is being done right now, as far as anything has said. */
function context() {
  return store.getStore() || {};
}

/**
 * Say what this request is doing, from inside a handler.
 *
 * Mutates the request's own context object rather than nesting another
 * scope, so a route needs ONE line near its stock work instead of wrapping
 * the whole body — which is the difference between this being adopted by
 * ten route files and being adopted by three.
 *
 * Safe because the object belongs to this request alone: AsyncLocalStorage
 * gave it out per request, so writing to it cannot reach another.
 */
function setContext(patch) {
  const cur = store.getStore();
  if (cur) Object.assign(cur, patch || {});
}

/**
 * Which movement this is, when nothing said.
 *
 * A bare addStock with no context is still worth recording — the count
 * changed, and a ledger that quietly skips the ones it cannot name is
 * worse than one that says "stock in". Direction is the only honest guess.
 */
function fallbackMovement(delta) {
  return delta >= 0 ? "stock_in" : "stock_out";
}

/**
 * Write one movement.
 *
 * Called from inside addStock's transaction, with the quantities it
 * measured either side of the change. Never throws outward: a shop must
 * not be unable to sell because the history could not be written.
 */
function record(row) {
  try {
    const ctx = context();
    const move = MOVEMENT_KEYS.has(ctx.movement) ? ctx.movement
      : fallbackMovement(Number(row.delta) || 0);
    const now = new Date();
    db.prepare(`
      INSERT INTO stock_ledger
        (id, at, date, time, size_id, product_id, location_id, movement,
         qty, prev_qty, new_qty, ref_type, ref_no, ref_id, staff, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid("SL"), now.getTime(), todayStr(),
      String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"),
      row.sizeId, row.productId || "", row.locationId, move,
      Number(row.delta) || 0, Number(row.prev) || 0, Number(row.next) || 0,
      ctx.refType || "", ctx.refNo || "", ctx.refId || "",
      ctx.staff || "", ctx.remarks || ""
    );
  } catch (e) {
    /* The count is already correct; only the note about it failed. Say so
       where a developer will see it and let the shop carry on billing. */
    console.error("[stock-ledger] could not record a movement:", e.message);
  }
}

/* ------------------------------------------------------------------ */
/* reading it back                                                      */
/* ------------------------------------------------------------------ */

/**
 * The history, newest first, with everything a shop needs to read a line
 * without looking anything else up.
 *
 * The product's name, brand and category are joined LIVE rather than
 * copied onto the row: a renamed product should read under its current
 * name throughout its history, otherwise the same item appears to be two.
 */
function query(f) {
  f = f || {};
  const where = ["1=1"];
  const args = [];
  const like = v => "%" + String(v).trim() + "%";

  if (String(f.from || "").trim())   { where.push("l.date >= ?"); args.push(String(f.from).trim()); }
  if (String(f.to || "").trim())     { where.push("l.date <= ?"); args.push(String(f.to).trim()); }
  if (String(f.productId || "").trim()) { where.push("l.product_id = ?"); args.push(String(f.productId).trim()); }
  if (String(f.sizeId || "").trim()) { where.push("l.size_id = ?"); args.push(Number(f.sizeId)); }
  if (String(f.locationId || "").trim()) { where.push("l.location_id = ?"); args.push(String(f.locationId).trim()); }
  if (String(f.movement || "").trim())   { where.push("l.movement = ?"); args.push(String(f.movement).trim()); }
  if (String(f.staff || "").trim())      { where.push("l.staff LIKE ?"); args.push(like(f.staff)); }
  if (String(f.refNo || "").trim())      { where.push("l.ref_no LIKE ?"); args.push(like(f.refNo)); }
  if (String(f.product || "").trim())    { where.push("p.name LIKE ?"); args.push(like(f.product)); }
  if (String(f.brand || "").trim())      { where.push("p.brand LIKE ?"); args.push(like(f.brand)); }
  if (String(f.category || "").trim())   { where.push("p.category LIKE ?"); args.push(like(f.category)); }

  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 300, 1), 2000);

  const rows = db.prepare(`
    SELECT l.*,
           p.name AS product_name, p.brand, p.category,
           s.label AS size_label,
           loc.name AS location_name
      FROM stock_ledger l
      LEFT JOIN product_sizes s ON s.id = l.size_id
      LEFT JOIN products p      ON p.id = COALESCE(NULLIF(l.product_id, ''), s.product_id)
      LEFT JOIN locations loc   ON loc.id = l.location_id
     WHERE ${where.join(" AND ")}
     ORDER BY l.at DESC, l.rowid DESC
     LIMIT ?
  `).all(...args, limit);

  return { rows, truncated: rows.length >= limit, limit };
}

module.exports = { withContext, context, setContext, record, query, MOVEMENTS };
