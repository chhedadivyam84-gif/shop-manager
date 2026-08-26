/**
 * GST filing periods — a warning, never a lock.
 *
 * server/fyLock.js beside this freezes a closed financial year and refuses
 * writes outright. This is deliberately weaker, because GST is a different
 * kind of deadline: returns go monthly, GSTR-1 and GSTR-3B on different
 * dates, and a shop genuinely does sometimes need to correct a month it has
 * already filed. The law provides amendments for exactly that.
 *
 * So nothing here blocks anything. It answers one question, at the moment
 * the owner is about to change something:
 *
 *   "That bill is dated 14 August. You filed GSTR-1 for August 2026 on
 *    9 September. Deleting it will make your books disagree with the
 *    return you filed."
 *
 * An owner who meant it carries on and files an amendment. An owner who
 * did not has been saved a reconciliation they would otherwise have met
 * months later, in a notice.
 *
 * ONLY DOCUMENTS THAT REACH A RETURN ARE CHECKED. A receipt against an
 * old bill does not appear in GSTR-1 — GST is on the supply, not the
 * payment — and neither does an order, a quotation or a selection slip.
 * Warning about those would be crying wolf, and a warning that fires when
 * it need not is a warning people learn to click through.
 */
const db = require("./db");

/* Where each kind of document keeps its date, for the kinds whose figures
   actually land in a return. Anything not listed here is not checked, and
   that omission is the feature. */
const DATED = {
  invoice:        { table: "invoices",         dateCol: "date", numberCol: "challan_no",   noun: "bill" },
  challan:        { table: "invoices",         dateCol: "date", numberCol: "challan_no",   noun: "challan" },
  purchase:       { table: "purchases",        dateCol: "date", numberCol: "purchase_no",  noun: "purchase" },
  salesReturn:    { table: "sales_returns",    dateCol: "date", numberCol: "return_no",    noun: "sales return" },
  purchaseReturn: { table: "purchase_returns", dateCol: "date", numberCol: "return_no",    noun: "purchase return" }
};

const RETURN_TYPES = ["GSTR-1", "GSTR-3B"];

/** 'YYYY-MM-DD' -> 'YYYY-MM'. Null for anything that is not a date. */
function periodOf(date) {
  const s = String(date || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

/** "2026-08" -> "August 2026", for a sentence a shopkeeper reads. */
function periodLabel(period) {
  if (!periodOf(period + "-01")) return String(period || "");
  const [y, m] = period.split("-");
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[Number(m) - 1] || m} ${y}`;
}

/** Every return filed for the month a date falls in. Re-opened ones are
 *  not filed any more, so they are left out — that is what re-opening a
 *  period means. */
function filingsFor(date) {
  const period = periodOf(date);
  if (!period) return [];
  return db.prepare(
    "SELECT * FROM gst_filings WHERE period = ? AND status = 'filed' ORDER BY return_type"
  ).all(period);
}

/**
 * The warning for one document, or null when there is nothing to say.
 *
 * `kind` is the same vocabulary the reports use. An unknown kind returns
 * null rather than throwing: a new document type should not break the
 * screen it appears on, and not warning is the safe direction for
 * something that has no GST effect anyway.
 */
function warningFor(kind, id) {
  const cfg = DATED[kind];
  if (!cfg || !id) return null;

  let row;
  try {
    row = db.prepare(
      `SELECT ${cfg.dateCol} AS date, ${cfg.numberCol} AS number FROM ${cfg.table} WHERE id = ?`
    ).get(id);
  } catch (e) { return null; }
  if (!row || !row.date) return null;

  const filed = filingsFor(row.date);
  if (!filed.length) return null;

  const period = periodOf(row.date);
  const list = filed.map(f => f.filed_on
    ? `${f.return_type} on ${f.filed_on}`
    : f.return_type).join(" and ");

  return {
    filed: true,
    period,
    periodLabel: periodLabel(period),
    date: row.date,
    number: row.number || "",
    returns: filed.map(f => ({ type: f.return_type, filedOn: f.filed_on, arn: f.arn })),
    /* Written as what will happen, not as a rule being cited. "You filed
       GSTR-1 for August" tells them something they can check; "this period
       is locked" tells them only that the app is in their way. */
    message:
      `This ${cfg.noun}${row.number ? " " + row.number : ""} is dated ${row.date}, and you have already filed `
      + `${list} for ${periodLabel(period)}. Changing it now will make your books disagree with the return you filed — `
      + `you would need to correct it in a later return.`
  };
}

/** True when any return has been filed for the month this date falls in. */
function isFiled(date) {
  return filingsFor(date).length > 0;
}

module.exports = { periodOf, periodLabel, filingsFor, warningFor, isFiled, RETURN_TYPES, DATED };
