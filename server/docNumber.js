/* ============================================================
   DOCUMENT NUMBERING
   One place that decides what number a document gets, for every document
   type. Before this each route had its own nextXxxNo() with its own counter
   and its own format, which is how invoices and delivery challans ended up
   sharing a single UNIQUE column and colliding.

   Three rules, and they interact:

   1. AUTO numbers come off a per-type counter that only ever moves FORWARD.
      It is a high-water mark, not "the highest currently existing row" — so
      deleting the newest bill does not make the next auto number re-issue it.

   2. MANUAL numbers are anything the user types. They are checked against
      the numbers currently in use for that type, and refused if taken.

   3. A DELETED document frees its number. Deletion here is a real DELETE
      (see the delete routes), so "in use" is simply "a row still has it" —
      nothing extra is needed to release it.

   The consequence the spec calls for falls out of 1 + 2: with SALE-00105 as
   the high-water mark, manually re-using deleted SALE-00103 does not drag
   the counter backwards. The next auto number is still SALE-00106.
   ============================================================ */
const db = require("./db");

/* Where each type's numbers live. Adding a document type means adding a row
   here and nothing else — the allocate/validate logic never changes.
   `scope` narrows a table that holds more than one type (invoices holds both
   tax invoices and delivery challans). */
const REGISTRY = {
  invoice:   { table: "invoices",   column: "challan_no",   scope: "doc_type = 'invoice'" },
  challan:   { table: "invoices",   column: "challan_no",   scope: "doc_type = 'challan'" },
  quotation: { table: "quotations", column: "quotation_no", scope: null },
  purchase:  { table: "purchases",  column: "purchase_no",  scope: null }
};

function config(docType) {
  const row = db.prepare("SELECT * FROM doc_numbering WHERE doc_type = ?").get(docType);
  if (!row) throw new Error(`Unknown document type "${docType}".`);
  return row;
}

function format(cfg, n) {
  return `${cfg.prefix}${String(n).padStart(cfg.width, "0")}`;
}

/** Is this exact number already on a live document of this type? */
function isTaken(docType, number, excludeId) {
  const reg = REGISTRY[docType];
  if (!reg) throw new Error(`Unknown document type "${docType}".`);
  const where = [`${reg.column} = ?`];
  const params = [number];
  if (reg.scope) where.push(reg.scope);
  if (excludeId) { where.push("id <> ?"); params.push(excludeId); }
  return !!db.prepare(
    `SELECT 1 FROM ${reg.table} WHERE ${where.join(" AND ")} LIMIT 1`
  ).get(...params);
}

/**
 * The next automatic number for a type.
 *
 * Advances the high-water counter and skips anything already taken — a number
 * can be taken because someone entered it manually, or because two series
 * historically shared a column. Refusing to save would cost the shop the bill;
 * a gap costs nothing.
 */
function allocate(docType) {
  const cfg = config(docType);
  let n = cfg.next_number;
  let value = format(cfg, n);
  let guard = 0;
  while (isTaken(docType, value) && guard++ < 100000) {
    n += 1;
    value = format(cfg, n);
  }
  db.prepare("UPDATE doc_numbering SET next_number = ? WHERE doc_type = ?").run(n + 1, docType);
  return value;
}

/**
 * Check a number the user typed. Returns null when it may be used, or the
 * message to show them — in their words, not the database's.
 */
function validateManual(docType, number, excludeId) {
  const value = String(number == null ? "" : number).trim();
  if (!value) return "Enter a document number, or switch back to Auto Number.";
  if (value.length > 40) return "That document number is too long (40 characters maximum).";
  if (isTaken(docType, value, excludeId)) {
    return "This document number already exists. Please enter a different number.";
  }
  return null;
}

/**
 * The number to store, given what the form sent. Manual when the user asked
 * for it and it passed validation; otherwise the next automatic one.
 * Throws { status, error } so routes surface the message unchanged.
 */
function resolve(docType, { manualNumber, useManual } = {}) {
  if (useManual) {
    const problem = validateManual(docType, manualNumber);
    if (problem) throw { status: 400, error: problem };
    // A manual number ahead of the counter pulls the counter up behind it, so
    // the next auto number continues after it rather than colliding with it.
    bumpHighWaterMark(docType, String(manualNumber).trim());
    return String(manualNumber).trim();
  }
  return allocate(docType);
}

/* If a manual number parses as this type's own format and sits at or above
   the counter, move the counter past it. A number in some other format the
   shop typed by hand is left alone — it is not part of the series. */
function bumpHighWaterMark(docType, value) {
  const cfg = config(docType);
  if (!value.startsWith(cfg.prefix)) return;
  const digits = value.slice(cfg.prefix.length);
  if (!/^\d+$/.test(digits)) return;
  const n = parseInt(digits, 10);
  if (n >= cfg.next_number) {
    db.prepare("UPDATE doc_numbering SET next_number = ? WHERE doc_type = ?").run(n + 1, docType);
  }
}

/** What the New-Bill screen shows before anything is saved. Peeks without
 *  consuming, so an abandoned form never burns a number. */
function peek(docType) {
  const cfg = config(docType);
  let n = cfg.next_number;
  let value = format(cfg, n);
  let guard = 0;
  while (isTaken(docType, value) && guard++ < 100000) {
    n += 1;
    value = format(cfg, n);
  }
  return value;
}

module.exports = { REGISTRY, allocate, peek, resolve, validateManual, isTaken, format, config };
