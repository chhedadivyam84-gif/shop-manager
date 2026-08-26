/**
 * What rate applies, to this party, for this product, on this date, at this
 * quantity.
 *
 * One place answers that, for buying and for selling, because the rules are
 * identical on both sides and two copies would disagree within a month.
 *
 * THE ORDER OF PREFERENCE, and why each step is where it is:
 *
 *   1. the party's own rate for this exact size
 *   2. the party's own rate for the product, any size
 *   3. the general rate for this exact size
 *   4. the general rate for the product, any size
 *   5. the price on the size itself (products.sizes[].price)
 *
 * Specific beats general at every step, and a party's rate beats everyone's
 * — a special rate agreed with ABC Traders must not be silently overridden
 * by a general revision. Step 5 is the rate the app has always used, so a
 * shop that never writes a price list sees no change at all.
 *
 * WITHIN one of those steps, if several rows still qualify, the one with
 * the LATEST effective_from wins. That is what makes a rate change a new
 * row rather than an edit: yesterday's row is still there, still correct
 * for yesterday's date, and simply not the latest one for today.
 *
 * NOTHING HERE IS CONSULTED WHEN A DOCUMENT IS PRINTED OR REPORTED. It is
 * read once, when a line is first put on a document, and the answer is
 * copied into that line. A price list can therefore never change what a
 * saved bill says — not by rule, but because the saved bill does not ask.
 */
const db = require("./db");

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/**
 * Rows that could apply, most specific and most recent first.
 *
 * Deliberately returns the whole shortlist rather than one row: the caller
 * showing a salesman "your rate 2,100, general rate 2,200" needs both, and
 * asking twice would be two queries that could disagree.
 */
function candidates({ side = "sale", partyId = null, productId, sizeId = null, date = null, qty = null }) {
  if (!productId) return [];
  const on = isDate(date) ? date : new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT * FROM price_list
    WHERE side = ?
      AND product_id = ?
      AND active = 1
      AND (party_id IS NULL OR party_id = ?)
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to = '' OR effective_to >= ?)
  `).all(side, productId, partyId || "", on, on);

  const q = qty === null || qty === undefined || qty === "" ? null : Number(qty);

  return rows
    .filter(r => {
      if (r.size_id != null && sizeId != null && r.size_id !== sizeId) return false;
      /* A row written for one size must not price a different size. A row
         written for no size prices any of them. */
      if (r.size_id != null && sizeId == null) return false;
      if (q === null) return true;
      /* A quantity band only applies when the quantity is inside it. With
         no quantity yet — the moment a product is picked, before anyone has
         typed how many — every band is a candidate and the base band wins
         by the sort below. */
      if (q < (r.min_qty || 0)) return false;
      if (r.max_qty != null && q > r.max_qty) return false;
      return true;
    })
    .sort((a, b) => {
      /* 1. a party's own rate beats the general rate */
      const ap = a.party_id ? 0 : 1, bp = b.party_id ? 0 : 1;
      if (ap !== bp) return ap - bp;
      /* 2. a rate written for this size beats one written for any size */
      const as = a.size_id != null ? 0 : 1, bs = b.size_id != null ? 0 : 1;
      if (as !== bs) return as - bs;
      /* 3. quantity bands.

         With a quantity given, only one band can qualify anyway; if two
         overlap by mistake the tighter one (higher floor) wins.

         With NO quantity yet — the instant a product is picked, before
         anyone has typed how many — every band qualifies, and the
         ENTRY band must win. Showing the 51+ rate to somebody who has
         not said 51 under-prices the sale, and it is the salesman who
         finds out, at the counter, after the customer has heard it. */
      const qGiven = q !== null;
      if ((b.min_qty || 0) !== (a.min_qty || 0)) {
        return qGiven ? (b.min_qty || 0) - (a.min_qty || 0)
                      : (a.min_qty || 0) - (b.min_qty || 0);
      }
      /* 4. and finally the most recently effective */
      return String(b.effective_from).localeCompare(String(a.effective_from));
    });
}

/**
 * The answer, with its reasoning attached.
 *
 * `source` says WHERE the rate came from, and the screens show it. A rate
 * that appears in a box with no explanation is a rate a salesman overrides
 * because they do not trust it.
 */
function resolve(opts) {
  const list = candidates(opts);
  const own = list.find(r => r.party_id);
  const general = list.find(r => !r.party_id);
  const chosen = list[0] || null;

  let fallback = null;
  if (!chosen && opts.sizeId != null) {
    const size = db.prepare("SELECT price FROM product_sizes WHERE id = ?").get(opts.sizeId);
    if (size) fallback = size.price;
  }

  return {
    rate: chosen ? chosen.rate : fallback,
    source: chosen ? (chosen.party_id ? "party" : "general") : (fallback != null ? "product" : "none"),
    row: chosen || null,
    /* Both shown side by side on the sales screen, so the person typing can
       see at once that they are giving this party their agreed rate and
       what everyone else pays. */
    partyRate: own ? own.rate : null,
    generalRate: general ? general.rate : null,
    productRate: fallback,
    /* Every band for this product and party, so a screen can show "21-50 at
       2,150" before the quantity has been typed. */
    bands: list
      .filter(r => (own ? r.party_id : !r.party_id))
      .map(r => ({ minQty: r.min_qty, maxQty: r.max_qty, rate: r.rate }))
      .filter((b, i, all) => all.findIndex(x => x.minQty === b.minQty && x.maxQty === b.maxQty) === i)
      .sort((a, b) => a.minQty - b.minQty)
  };
}

/**
 * What this party was last actually charged for this product.
 *
 * Read from the bills themselves rather than from the price list, because
 * that is the question being asked: not "what should it cost" but "what did
 * we do last time". The two differ exactly when somebody overrode the rate,
 * which is the case worth seeing.
 */
function lastSoldRate({ side = "sale", partyId, productId, sizeId = null }) {
  if (!partyId || !productId) return null;
  if (side === "sale") {
    const row = db.prepare(`
      SELECT ii.rate, i.date, i.challan_no AS number
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.customer_id = ? AND ii.product_id = ? AND i.voided = 0
        ${sizeId != null ? "AND ii.size_id = ?" : ""}
      ORDER BY i.date DESC, i.created_at DESC LIMIT 1
    `).get(...(sizeId != null ? [partyId, productId, sizeId] : [partyId, productId]));
    return row || null;
  }
  const row = db.prepare(`
    SELECT pi.rate, p.date, p.purchase_no AS number
    FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
    WHERE p.supplier_id = ? AND pi.product_id = ? AND p.voided = 0
      ${sizeId != null ? "AND pi.size_id = ?" : ""}
    ORDER BY p.date DESC, p.created_at DESC LIMIT 1
  `).get(...(sizeId != null ? [partyId, productId, sizeId] : [partyId, productId]));
  return row || null;
}

/** Every rate ever set for this party and product, newest first — the
 *  Price History screen. Closed and inactive rows are included; they are
 *  the history. */
function history({ side = "sale", partyId = null, productId, sizeId = null }) {
  const where = ["side = ?", "product_id = ?"];
  const params = [side, productId];
  if (partyId) { where.push("party_id = ?"); params.push(partyId); }
  else { where.push("party_id IS NULL"); }
  if (sizeId != null) { where.push("(size_id IS NULL OR size_id = ?)"); params.push(sizeId); }
  return db.prepare(`
    SELECT * FROM price_list WHERE ${where.join(" AND ")}
    ORDER BY effective_from DESC, created_at DESC
  `).all(...params);
}

module.exports = { candidates, resolve, lastSoldRate, history };
