/* ============================================================
   DATA HEALTH — unit-confusion detector

   Finds lines where a square-foot or running-foot figure looks to have been
   typed into a box that counts pieces. That mistake is invisible in the
   totals — the money can be right while the stock is wrong by a factor of
   thirty — so it has to be found by looking at the RELATIONSHIP between
   pieces and quantity rather than at either on its own.

   Deliberately reports SUSPECTS, not verdicts. A shop can legitimately sell
   320 loose pieces, and this cannot know that it did not. Every row comes
   with the arithmetic that made it suspicious so a person can judge it.
   ============================================================ */
const db = require("./db");

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * An area/length line should have qty = pieces × (size of one piece).
 * So qty/pieces is the area of a single sheet — 32 for 8x4, 24 for 6x4.
 *
 * When someone types the square footage into the pieces box, two fingerprints
 * appear together:
 *   - per-piece works out at or near 1, because the app multiplied the
 *     already-converted figure by nothing meaningful, and
 *   - pieces is far larger than anything a shop counts by hand.
 * Either alone is weak; together they are the signature.
 */
function inspectLine(row) {
  const pieces = Number(row.pieces) || 0;
  const qty = Number(row.qty) || 0;
  const mode = String(row.mode || "UNIT").toUpperCase();
  if (pieces <= 0) return null;

  const perPiece = round2(qty / pieces);
  const reasons = [];

  // Area/length billing where each piece is somehow one unit — the tell-tale
  // of a converted figure entered as a raw count.
  if (mode !== "UNIT" && perPiece > 0 && Math.abs(perPiece - 1) < 0.01) {
    reasons.push(`billed as ${mode} but each piece works out at 1 ${row.unit_label || "unit"} — a sheet is never 1 sq.ft`);
  }
  // A piece count in the hundreds for a sheet product.
  if (mode !== "UNIT" && pieces >= 100) {
    reasons.push(`${pieces} pieces is a very large count for a ${mode}-billed item`);
  }
  // The size label says the sheet's dimensions; if those multiply to
  // something far from per-piece, the two disagree.
  const dims = String(row.size_label || "").match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (dims && mode !== "UNIT") {
    const expected = round2(Number(dims[1]) * Number(dims[2]));
    if (expected > 0 && perPiece > 0 && Math.abs(perPiece - expected) > expected * 0.2) {
      reasons.push(`size ${row.size_label} implies about ${expected} per piece, but this line has ${perPiece}`);
    }
  }
  if (!reasons.length) return null;
  return { perPiece, expectedFromSize: dims ? round2(Number(dims[1]) * Number(dims[2])) : null, reasons };
}

/** Every suspect line across sales, purchases and both return types. */
function scan() {
  const sources = [
    { label: "Sales Invoice", sql: `
        SELECT ii.id, ii.name, ii.size_label, ii.pieces, ii.qty, ii.rate, ii.mode, ii.unit_label,
               i.challan_no AS doc_no, i.date, i.voided
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.voided = 0` },
    { label: "Purchase", sql: `
        SELECT pi.id, pi.name, pi.size_label, pi.pieces, pi.qty, pi.rate, pi.mode, pi.unit_label,
               p.purchase_no AS doc_no, p.date, p.voided
        FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
        WHERE p.voided = 0` },
    { label: "Sales Return", sql: `
        SELECT sri.id, sri.name, sri.size_label, sri.pieces, sri.qty, sri.rate,
               'UNKNOWN' AS mode, sri.unit_label,
               sr.return_no AS doc_no, sr.date, sr.voided
        FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.return_id
        WHERE sr.voided = 0` },
    { label: "Purchase Return", sql: `
        SELECT pri.id, pri.name, pri.size_label, pri.pieces, pri.qty, pri.rate,
               'UNKNOWN' AS mode, pri.unit_label,
               pr.return_no AS doc_no, pr.date, pr.voided
        FROM purchase_return_items pri JOIN purchase_returns pr ON pr.id = pri.return_id
        WHERE pr.voided = 0` }
  ];

  const suspects = [];
  for (const src of sources) {
    let rows = [];
    try { rows = db.prepare(src.sql).all(); } catch (e) { continue; }  // table may not exist
    for (const r of rows) {
      /* A return line has no mode of its own, so it is judged by whether its
         unit label implies area or length. Without that, every return would
         be treated as unit-billed and the fault would hide. */
      const row = { ...r };
      if (row.mode === "UNKNOWN") {
        row.mode = /sq|ft|feet|mtr|met|rft/i.test(row.unit_label || "") ? "AREA" : "UNIT";
      }
      const finding = inspectLine(row);
      if (finding) {
        suspects.push({
          source: src.label, docNo: r.doc_no, date: r.date, item: r.name,
          size: r.size_label, pieces: r.pieces, qty: r.qty, unit: r.unit_label,
          rate: r.rate, ...finding
        });
      }
    }
  }
  suspects.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    checked: sources.map(s => s.label),
    suspectCount: suspects.length,
    suspects
  };
}

module.exports = { scan, inspectLine };
