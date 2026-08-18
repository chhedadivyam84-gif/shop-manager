/* ============================================================
   DOCUMENT NUMBERING
   One place that decides what number a document gets, for every document
   type. Before this each route had its own nextXxxNo() with its own counter
   and its own format, which is how invoices and delivery challans ended up
   sharing a single UNIQUE column and colliding.

   Three rules, and they interact:

   1. AUTO numbers come off a per-type counter. It normally only moves
      FORWARD — with one deliberate exception, rule 4.

   2. MANUAL numbers are anything the user types. They are checked against
      the numbers currently in use for that type, and refused if taken.

   3. A DELETED document frees its number. Deletion here is a real DELETE
      (see the delete routes), so "in use" is simply "a row still has it" —
      nothing extra is needed to release it.

   4. DELETING THE LATEST document rolls the counter back to its number, so
      the next bill re-uses it instead of leaving a hole. Deleting an OLDER
      one does not: a number with documents after it stays spent, because
      re-issuing it would put two different bills at the same point in the
      sequence and no auditor would thank you for that.

      "Latest" is decided by looking, not by assuming — the counter can sit
      ahead of reality after an abandoned form, so releaseIfLatest asks
      whether any live document in the series holds a HIGHER number. Only
      when none does is the number handed back. That also makes repeated
      deletions walk backwards correctly on their own: delete 1004 then
      1003, and the counter follows to 1004 then 1003.
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
  purchase:  { table: "purchases",  column: "purchase_no",  scope: null },
  dispatch:  { table: "dispatches", column: "dispatch_no",  scope: null },
  // Separate series from dispatch, deliberately: they are separate registers.
  delivery:  { table: "deliveries", column: "delivery_no",  scope: null }
};

function config(docType) {
  const row = db.prepare("SELECT * FROM doc_numbering WHERE doc_type = ?").get(docType);
  if (!row) throw new Error(`Unknown document type "${docType}".`);
  return row;
}

function format(cfg, n) {
  return `${cfg.prefix}${String(n).padStart(cfg.width, "0")}`;
}

/**
 * Is this exact number already on a live document?
 *
 * Checked across the WHOLE column, deliberately NOT narrowed by reg.scope.
 * Tax invoices and delivery challans are separate series but share one
 * UNIQUE challan_no column, so "free within my own series" is not the same
 * question as "free in the database". Scoping this was exactly the mistake
 * that let an invoice be handed SP0000050 while a challan already held it —
 * a number the INSERT would then reject.
 *
 * reg.scope still matters, but only for working out where a series has
 * reached; see the seeding in db.js.
 */
function isTaken(docType, number, excludeId) {
  const reg = REGISTRY[docType];
  if (!reg) throw new Error(`Unknown document type "${docType}".`);
  const where = [`${reg.column} = ?`];
  const params = [number];
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
  advanceSharedCounters(docType, n);
  return value;
}

/**
 * Move every series that would produce this same number past it.
 *
 * Two series sharing a column AND a prefix are numerically ONE series — with
 * "SP" on both tax invoices and delivery challans, SP0000052 means the same
 * row either way. Advancing only the requested one lets two allocations made
 * before either is saved hand out the identical number, which the UNIQUE
 * column then rejects.
 *
 * Give the challan series its own prefix in Settings and the two become
 * genuinely independent; this loop then only ever touches the one counter.
 */
function advanceSharedCounters(docType, n) {
  const reg = REGISTRY[docType];
  const cfg = config(docType);
  db.prepare("UPDATE doc_numbering SET next_number = ? WHERE doc_type = ?").run(n + 1, docType);

  Object.keys(REGISTRY).forEach(other => {
    if (other === docType) return;
    const oReg = REGISTRY[other];
    if (oReg.table !== reg.table || oReg.column !== reg.column) return;
    const oCfg = config(other);
    if (oCfg.prefix !== cfg.prefix || oCfg.width !== cfg.width) return;
    if (oCfg.next_number <= n) {
      db.prepare("UPDATE doc_numbering SET next_number = ? WHERE doc_type = ?").run(n + 1, other);
    }
  });
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

/** The numeric part of a value, if it is in this series' own format.
 *  Returns null for anything else — a number the shop typed by hand in some
 *  other shape is not part of the sequence and must not move the counter. */
function parseSeriesNumber(cfg, value) {
  const s = String(value == null ? "" : value).trim();
  if (!s.startsWith(cfg.prefix)) return null;
  const digits = s.slice(cfg.prefix.length);
  if (digits.length !== cfg.width || !/^\d+$/.test(digits)) return null;
  return parseInt(digits, 10);
}

/**
 * The highest number still held by a live document in this series, or null.
 *
 * Matched on PREFIX and width rather than on the registry's scope, because
 * two types sharing a column AND a prefix are numerically one sequence — the
 * same reason advanceSharedCounters exists. Give the challan its own prefix
 * in Settings and this narrows to that series alone, automatically.
 */
function highestLiveNumber(docType) {
  const reg = REGISTRY[docType];
  const cfg = config(docType);
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(${reg.column}, ?) AS INTEGER)) AS n
    FROM ${reg.table}
    WHERE ${reg.column} LIKE ? AND LENGTH(${reg.column}) = ?
  `).get(cfg.prefix.length + 1, cfg.prefix + "%", cfg.prefix.length + cfg.width);
  return row && row.n != null ? row.n : null;
}

/**
 * Hands a deleted document's number back, but ONLY if it was the last one.
 *
 * Call this AFTER the row is gone, so "is anything above it" is asked of the
 * documents that actually remain. Returns the released number, or null when
 * the number stays spent — which the caller can log either way.
 *
 * Every series sharing this column and prefix is rolled back together. They
 * are one sequence; leaving a sibling counter high would immediately hand the
 * released number straight back out to the other type.
 */
function releaseIfLatest(docType, number) {
  const cfg = config(docType);
  const n = parseSeriesNumber(cfg, number);
  if (n === null) return null;

  const highest = highestLiveNumber(docType);
  // Something still sits at or above it — this was not the latest, so the
  // gap stays. This is the rule that protects the audit trail.
  if (highest !== null && highest >= n) return null;

  const reg = REGISTRY[docType];
  const affected = [];
  Object.keys(REGISTRY).forEach(type => {
    const oReg = REGISTRY[type];
    if (oReg.table !== reg.table || oReg.column !== reg.column) {
      if (type !== docType) return;
    }
    const oCfg = config(type);
    if (type !== docType && (oCfg.prefix !== cfg.prefix || oCfg.width !== cfg.width)) return;
    if (oCfg.next_number > n) {
      db.prepare("UPDATE doc_numbering SET next_number = ?, updated_at = ? WHERE doc_type = ?")
        .run(n, Date.now(), type);
      affected.push({ docType: type, from: oCfg.next_number, to: n });
    }
  });

  return affected.length ? { number: format(cfg, n), value: n, affected } : null;
}

/** Records a movement in doc_number_log. Never throws: a failed log entry
 *  must not undo a deletion the user already confirmed. */
function logNumber(req, entry) {
  try {
    db.prepare(`
      INSERT INTO doc_number_log
        (doc_type, action, doc_id, doc_number, previous_number, new_number, detail, staff_id, staff_name, at)
      VALUES (@docType, @action, @docId, @docNumber, @previousNumber, @newNumber, @detail, @staffId, @staffName, @at)
    `).run({
      docType: entry.docType, action: entry.action,
      docId: entry.docId || null, docNumber: entry.docNumber || null,
      previousNumber: entry.previousNumber || null, newNumber: entry.newNumber || null,
      detail: entry.detail || null,
      staffId: (req && req.session && req.session.staffId) || null,
      staffName: (req && req.session && req.session.staffName) || "System",
      at: Date.now()
    });
  } catch (e) { /* the paper trail is important, the operation is more so */ }
}

/**
 * The whole delete-side story in one call: release the number if it was the
 * latest, and record what happened either way.
 *
 * Called AFTER the row is deleted. Returns the released number or null, so a
 * route can tell the operator "1003 will be used again" rather than leaving
 * them to find out on the next bill.
 */
function releaseOnDelete(req, docType, number, docId) {
  const released = releaseIfLatest(docType, number);
  if (released) {
    logNumber(req, {
      docType, action: "released", docId, docNumber: number,
      previousNumber: String(released.affected[0].from),
      newNumber: String(released.value),
      detail: `${number} was the latest ${docType} — it will be issued again on the next one`
        + (released.affected.length > 1
            ? `; also rolled back ${released.affected.slice(1).map(a => a.docType).join(", ")}`
            : "")
    });
  } else {
    logNumber(req, {
      docType, action: "kept", docId, docNumber: number,
      detail: `${number} was deleted but is NOT the latest — the number stays spent so the sequence is not disturbed`
    });
  }
  return released;
}

module.exports = {
  REGISTRY, allocate, peek, resolve, validateManual, isTaken, format, config,
  releaseIfLatest, releaseOnDelete, highestLiveNumber, parseSeriesNumber, logNumber
};
