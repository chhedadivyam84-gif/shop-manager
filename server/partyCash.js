/* ============================================================
   PARTY BALANCE FROM THE CASH BOOK — the khata

   A shop that bills every sale gets its outstanding from invoices, and
   server/outstanding.js already answers that question properly. A shop that
   does NOT bill every sale keeps the same information in one place: the cash
   book. Money handed over is written down, money taken back is written down,
   and what is left between those two lines is what the party owes.

   This file answers only that second question. It does not touch invoices,
   payments, customers.due or suppliers.due, and it is not an alternative to
   outstanding.js — the two describe different money and are shown separately
   so a shop that uses both can never add one into the other by accident.

   THE SIGN RULE, one rule for both sides
   --------------------------------------
   The balance is always "what this party owes the shop".

       Cash OUT to a party   →  they owe the shop MORE   (+)
       Cash IN  from a party →  they owe the shop LESS   (-)

   A customer who took goods and paid later reads naturally: out 25,000,
   in 10,000, owes 15,000. A supplier the shop has paid in advance comes out
   negative on the same rule, which is the truthful reading of it — the shop
   is out of pocket until the goods arrive.

   WHAT IS DELIBERATELY EXCLUDED
   -----------------------------
   Rows with a source_type. Those were not typed into the cash book: they
   were auto-posted by server/bankLink.js when a payment was recorded on the
   Customers or Suppliers screen, and that payment has ALREADY moved
   customers.due. Counting them here as well would take the same receipt off
   the party's account twice — which is the exact double-entry this feature
   exists to remove, arriving by the back door.

   Voided rows are excluded for the ordinary reason.

   DERIVED, NEVER STORED
   ---------------------
   Same choice outstanding.js made, for the same reason: nothing to migrate,
   nothing to keep in step, and it cannot drift away from the entries it
   describes. Change a cash entry and the balance is already correct.
   ============================================================ */
const db = require("./db");
const cashAccess = require("./cashAccess");

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/** Rows that count towards a party's khata balance: linked, alive, and
 *  typed by a person rather than posted by another screen. */
const LINKED = `
  FROM cash_entries
  WHERE voided = 0
    AND COALESCE(source_type, '') = ''
    AND COALESCE(party_id, '') <> ''
`;

/* THE READER'S ACCESS PERIOD, if they have one.
   A balance is a sum, and a sum is the most compact way there is to hand
   somebody data they may not read: "Ramesh owes 15,000" is built from
   entries that might all sit outside a one-day window. So every query
   below is narrowed the same way the ledger is, and a limited reader sees
   the balance as it stands WITHIN their period — the entries they can
   actually open, adding up to the figure they are shown.

   `req` is optional throughout: called without it (a background job, a
   test) there is no session and therefore no limit, which is the same
   answer cashAccess gives for the owner. */
const win = req => cashAccess.sqlAnd(req, "date");

/**
 * One party's balance, plus the two totals it is made of so the figure can
 * always be checked rather than trusted.
 */
function partyCashBalance(partyType, partyId, req) {
  const w = win(req);
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END), 0) AS given,
      COALESCE(SUM(CASE WHEN type = 'in'  THEN amount ELSE 0 END), 0) AS received,
      COUNT(*) AS entries,
      COALESCE(MAX(date), '') AS lastDate
    ${LINKED} AND party_type = ? AND party_id = ?${w.sql}
  `).get(partyType, partyId, ...w.params) || {};

  const given = round2(r.given);
  const received = round2(r.received);
  return {
    partyType, partyId,
    given,                       // cash OUT to them
    received,                    // cash IN from them
    balance: round2(given - received),   // + they owe the shop, - the shop owes them
    entries: r.entries || 0,
    lastDate: r.lastDate || "",
  };
}

/** Every party with a khata balance, heaviest first. One query rather than
 *  one per party, so a screen listing them does not fan out. */
function allPartyCashBalances(partyType, req) {
  const w = win(req);
  const rows = db.prepare(`
    SELECT
      party_type AS partyType,
      party_id   AS partyId,
      COALESCE(SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END), 0) AS given,
      COALESCE(SUM(CASE WHEN type = 'in'  THEN amount ELSE 0 END), 0) AS received,
      COUNT(*) AS entries,
      COALESCE(MAX(date), '') AS lastDate
    ${LINKED} ${partyType ? "AND party_type = ?" : ""}${w.sql}
    GROUP BY party_type, party_id
  `).all(...(partyType ? [partyType] : []), ...w.params);

  return rows
    .map(r => ({
      ...r,
      given: round2(r.given),
      received: round2(r.received),
      balance: round2(r.given - r.received),
    }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

/**
 * The entries behind one party's balance, oldest first with a running total,
 * so the number can be read down the page the way a khata page is read.
 */
function partyCashHistory(partyType, partyId, from, to, req) {
  const w = win(req);
  const rows = db.prepare(`
    SELECT id, date, type, amount, category, remarks
    ${LINKED} AND party_type = ? AND party_id = ?${w.sql}
    ORDER BY date ASC, created_at ASC
  `).all(partyType, partyId, ...w.params);

  let running = 0;
  const out = [];
  for (const r of rows) {
    /* The running total is built across EVERY entry, then the range is
       applied for display. A page that starts mid-account still shows a
       true balance, rather than one that pretends the account began on
       the From date. */
    running = round2(running + (r.type === "out" ? r.amount : -r.amount));
    if (from && r.date < from) continue;
    if (to && r.date > to) continue;
    out.push({ ...r, balance: running });
  }
  return out;
}

/** The dropdown's contents: every customer and supplier, name and id only.
 *  Two small columns rather than whole rows, because the picker is opened
 *  every time an entry is written and needs nothing else. */
function linkTargets() {
  const customers = db.prepare("SELECT id, name FROM customers ORDER BY name COLLATE NOCASE").all();
  const suppliers = db.prepare("SELECT id, name FROM suppliers ORDER BY name COLLATE NOCASE").all();
  return [
    ...customers.map(c => ({ ...c, type: "customer" })),
    ...suppliers.map(s => ({ ...s, type: "supplier" })),
  ];
}

/** Confirms a party exists before a cash entry claims to belong to it, so a
 *  stale id from an old screen cannot create a balance against nobody. */
function partyName(partyType, partyId) {
  if (!partyType || !partyId) return null;
  const table = partyType === "customer" ? "customers" : partyType === "supplier" ? "suppliers" : null;
  if (!table) return null;
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(partyId);
  return row ? row.name : null;
}

module.exports = {
  partyCashBalance,
  allPartyCashBalances,
  partyCashHistory,
  linkTargets,
  partyName,
};
