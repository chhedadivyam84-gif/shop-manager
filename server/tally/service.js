/* ============================================================
   THE SYNC ENGINE

   Shop Manager is the master. A document is written to Shop Manager's own
   database first and completely, and only then does a row appear in the
   queue saying it would like to reach Tally. Nothing in this file can
   refuse, delay or alter a sale — if Tally is off, unreachable or angry,
   the shop keeps billing and the queue keeps the work.

   DUPLICATE PREVENTION IS THE DATABASE'S JOB, NOT THIS CODE'S.
   Every document has one derived sync id, and tally_queue.sync_id is
   UNIQUE. Queue the same bill twice — by saving it again, by a retry, by
   two staff pressing Sync at once — and the second insert is refused by
   SQLite. Code that "checks first" loses that race; a unique index cannot.

   ONE DIRECTION. Nothing here reads a value out of Tally and writes it
   into Shop Manager. The only things that come back are a voucher number
   and an error message, and both live in the queue and the log — never in
   a customer, a product or a bill.
   ============================================================ */
const crypto = require("crypto");
const db = require("../db");
const { uid } = require("../util");
const connector = require("./connector");
const V = require("./vouchers");

/* Which Shop Manager documents can go, and what they become in Tally.
   A document type absent from here cannot be synced at all, which is the
   safest kind of "not supported yet". */
const DOC_TYPES = {
  sales_invoice:   { label: "Sales Invoice",    voucher: "Sales",    module: "sales_invoice" },
  sales_return:    { label: "Sales Return",     voucher: "Credit Note", module: "sales_return" },
  purchase_invoice:{ label: "Purchase Invoice", voucher: "Purchase", module: "purchase_invoice" },
  purchase_return: { label: "Purchase Return",  voucher: "Debit Note",  module: "purchase_return" },
  receipt:         { label: "Receipt",          voucher: "Receipt",  module: "receipt",
                     partyGroup: "Sundry Debtors" },
  payment:         { label: "Payment",          voucher: "Payment",  module: "payment",
                     partyGroup: "Sundry Creditors" },

  /* CASH BOOK ENTRIES TYPED STRAIGHT IN — rent, tea, freight, scrap sold.
     Not a customer receipt or a supplier payment: those already come across
     as `receipt` and `payment` from the payments tables, and a cash row
     auto-posted from one of them must NOT be sent again from here or the
     shop is charged twice in its own books.

     The "party" on one of these is its CATEGORY, not a person, so it posts
     to Indirect Incomes / Indirect Expenses rather than Sundry Debtors or
     Creditors. Booking the electricity bill against Sundry Creditors would
     make the electricity board a supplier the shop owes money to. */
  cash_in:         { label: "Cash Book — Money In",  voucher: "Receipt", module: "cash_in",
                     partyGroup: "Indirect Incomes" },
  cash_out:        { label: "Cash Book — Money Out", voucher: "Payment", module: "cash_out",
                     partyGroup: "Indirect Expenses" }
};

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function settings() {
  const r = db.prepare("SELECT * FROM tally_settings WHERE id = 1").get() || {};
  let modules = {};
  try { modules = JSON.parse(r.modules || "{}") || {}; } catch (e) { modules = {}; }
  return { ...r, modulesObj: modules };
}

/** A module is off unless it was deliberately switched on. */
function moduleOn(docType) {
  const s = settings();
  const spec = DOC_TYPES[docType];
  return !!(spec && s.modulesObj[spec.module]);
}

/* ------------------------------------------------------------------ */
/* the sync id                                                         */
/* ------------------------------------------------------------------ */

/**
 * One document, one id, forever.
 *
 * Derived from the type and the Shop Manager id, so it is the same every
 * time it is computed and does not depend on anything being remembered.
 * The financial year is in it because a shop's document numbers restart
 * each April, and two bills numbered 1 in different years must never
 * collide.
 */
function syncIdFor(docType, docId, fy) {
  return ["SM", String(docType).toUpperCase(), String(fy || "NA"), String(docId)].join("-");
}

/**
 * What the document looked like when it was sent.
 *
 * An edit changes this, which is how an edited bill is told apart from one
 * that has not moved — without it, every re-queue would look like a change
 * and Tally would be rewritten for nothing.
 */
function payloadHash(obj) {
  return crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

/** The financial year a date falls in, from the shop's own table. */
function fyFor(date) {
  const d = String(date || "").slice(0, 10);
  const r = db.prepare(
    "SELECT label FROM financial_years WHERE start_date <= ? AND end_date >= ? LIMIT 1"
  ).get(d, d);
  if (r) return r.label;
  /* No row means the shop has not defined that year. April is the Indian
     boundary, so it can still be worked out rather than refused. */
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return start + "-" + String((start + 1) % 100).padStart(2, "0");
}

/* ------------------------------------------------------------------ */
/* the log                                                             */
/* ------------------------------------------------------------------ */

function log(entry) {
  try {
    db.prepare(`
      INSERT INTO tally_log (id, at, staff_name, sync_id, doc_type, doc_id, doc_no,
                             action, status, voucher_no, attempt, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid("TLG"), Date.now(),
      entry.staff || "", entry.syncId || "", entry.docType || "", entry.docId || "",
      entry.docNo || "", entry.action || "", entry.status || "", entry.voucherNo || "",
      Number(entry.attempt) || 0, String(entry.message || "").slice(0, 900));
  } catch (e) { /* the log must never be able to break a sale */ }
}

/* ------------------------------------------------------------------ */
/* queueing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Put a document in the queue, or update the row it already has.
 *
 * NEVER THROWS AT THE CALLER. This is called from the tail of saving an
 * invoice, and a sync problem must not be able to fail a sale. Everything
 * is caught and logged.
 *
 * @returns { queued, reason } — for the caller's information only.
 */
function enqueue(docType, doc, opts) {
  opts = opts || {};
  try {
    const spec = DOC_TYPES[docType];
    if (!spec) return { queued: false, reason: "unknown document type" };

    const s = settings();
    if (!s.enabled) return { queued: false, reason: "sync is off" };
    if (!moduleOn(docType)) return { queued: false, reason: spec.label + " is not switched on" };

    /* An estimate or a challan is not a tax invoice. Sending one books a
       sale that was never made, so it goes only if the owner has said so
       in as many words. */
    const isPakka = opts.pakka !== false;
    if (isPakka && !s.sync_pakka) return { queued: false, reason: "GST invoices are not being sent" };
    if (!isPakka && !s.sync_kachha) return { queued: false, reason: "non-GST documents are not being sent" };

    const fy = fyFor(doc.date);
    const syncId = syncIdFor(docType, doc.id, fy);
    const hash = payloadHash(opts.hashOn || doc);
    const now = Date.now();

    const existing = db.prepare("SELECT * FROM tally_queue WHERE sync_id = ?").get(syncId);

    if (!existing) {
      try {
        db.prepare(`
          INSERT INTO tally_queue (id, sync_id, doc_type, doc_id, doc_no, doc_date, fy,
                                   status, payload_hash, queued_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
        `).run(uid("TQ"), syncId, docType, doc.id, opts.docNo || "", doc.date || "", fy,
               hash, now, now);
      } catch (e) {
        /* The unique index refused it, which means another path queued the
           same document a moment ago. That is the duplicate defence doing
           its job, not an error. */
        return { queued: false, reason: "already queued", syncId };
      }
      log({ syncId, docType, docId: doc.id, docNo: opts.docNo, action: "queue",
            status: "PENDING", staff: opts.staff, message: "queued" });
      return { queued: true, syncId };
    }

    /* Already there. If nothing about the document changed, leave it
       alone — re-sending an identical voucher is work for nobody. */
    if (existing.payload_hash === hash && existing.status === "SUCCESS") {
      return { queued: false, reason: "already synced, unchanged", syncId };
    }

    /* It changed, or the last attempt failed. Put it back in the queue
       WITHOUT losing the voucher number: the send will Alter that voucher
       rather than write a second one. */
    db.prepare(`
      UPDATE tally_queue SET status = 'PENDING', payload_hash = ?, doc_no = ?,
                             doc_date = ?, last_error = '', updated_at = ?
      WHERE sync_id = ?
    `).run(hash, opts.docNo || existing.doc_no, doc.date || existing.doc_date, now, syncId);
    log({ syncId, docType, docId: doc.id, docNo: opts.docNo, action: "queue",
          status: "PENDING", staff: opts.staff,
          message: existing.voucher_no ? "re-queued to alter voucher " + existing.voucher_no
                                       : "re-queued" });
    return { queued: true, syncId, changed: true };
  } catch (e) {
    log({ docType, docId: doc && doc.id, action: "queue", status: "FAILED",
          message: "could not queue: " + e.message });
    return { queued: false, reason: e.message };
  }
}

/**
 * A cancelled document.
 *
 * The Tally voucher is NOT deleted. Shop Manager's own rule is that
 * nothing is destroyed, and a hole in a numbered voucher book is a
 * question an auditor will ask. The voucher is marked cancelled in place.
 */
function enqueueCancel(docType, doc, opts) {
  opts = opts || {};
  try {
    const fy = fyFor(doc.date);
    const syncId = syncIdFor(docType, doc.id, fy);
    const row = db.prepare("SELECT * FROM tally_queue WHERE sync_id = ?").get(syncId);

    /* WHETHER A VOUCHER EXISTS IN TALLY, not what the queue currently says.
       These come apart: a bill that synced, was then edited (which puts the
       row back to PENDING) and is now cancelled still HAS a voucher sitting
       in Tally. Keying this on status === 'SUCCESS' left that voucher live
       against a bill the shop had cancelled — the books would have shown a
       sale that no longer existed. voucher_no is the fact; status is only
       where the queue has got to. */
    if (!row || !row.voucher_no) {
      /* Genuinely never reached Tally, so there is nothing there to cancel.
         Marked so a later queue run does not send it. */
      if (row) {
        db.prepare("UPDATE tally_queue SET status='CANCELLED', updated_at=? WHERE sync_id=?")
          .run(Date.now(), syncId);
        log({ syncId, docType, docId: doc.id, action: "cancel", status: "CANCELLED",
              staff: opts.staff, message: "cancelled before it ever reached Tally" });
      }
      return { queued: false, reason: "was never synced" };
    }
    db.prepare(`
      UPDATE tally_queue SET status='PENDING', payload_hash='cancel:'||payload_hash,
                             updated_at=? WHERE sync_id=?
    `).run(Date.now(), syncId);
    log({ syncId, docType, docId: doc.id, action: "cancel", status: "PENDING",
          staff: opts.staff, voucherNo: row.voucher_no,
          message: "queued to cancel voucher " + row.voucher_no });
    return { queued: true, syncId };
  } catch (e) {
    return { queued: false, reason: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* counts, for the dashboard                                           */
/* ------------------------------------------------------------------ */

function counts() {
  const rows = db.prepare(
    "SELECT status, COUNT(*) AS n FROM tally_queue GROUP BY status"
  ).all();
  const out = { PENDING: 0, PROCESSING: 0, SUCCESS: 0, FAILED: 0, RETRY: 0, CANCELLED: 0 };
  rows.forEach(r => { out[r.status] = r.n; });
  out.total = Object.values(out).reduce((a, b) => a + b, 0);

  const today = new Date().toISOString().slice(0, 10);
  out.today = db.prepare(`
    SELECT doc_type, COUNT(*) AS n FROM tally_queue
    WHERE status = 'SUCCESS' AND date(synced_at/1000, 'unixepoch', 'localtime') = ?
    GROUP BY doc_type
  `).all(today).reduce((a, r) => { a[r.doc_type] = r.n; return a; }, {});
  return out;
}

module.exports = {
  DOC_TYPES, settings, moduleOn,
  syncIdFor, payloadHash, fyFor,
  enqueue, enqueueCancel, counts, log,
  connector, V
};
