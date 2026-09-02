/**
 * PUTTING DOCUMENTS THAT ALREADY EXIST INTO THE TALLY QUEUE.
 *
 * The create-time hooks only fire when a document is SAVED. Everything a
 * shop billed before Tally was switched on is therefore invisible to the
 * sync — the queue has no way of ever learning about it. That is the whole
 * reason this file exists: a shop turning Tally on today wants the year it
 * has already billed, not just tomorrow's bills.
 *
 * It only ENQUEUES. Nothing is sent from here, so a backfill cannot hang on
 * Tally being closed and cannot post anything by surprise — the queue is
 * filled, the owner looks at it, and sending stays a separate decision.
 *
 * Re-running is safe. enqueue() keys on a sync id built from the document
 * and its financial year, so a document already queued or already sent is
 * recognised rather than duplicated. That matters more than it sounds: the
 * natural instinct on a half-finished backfill is to run it again.
 *
 * VOIDED DOCUMENTS ARE SKIPPED. A voided bill keeps its number in Shop
 * Manager on purpose, but it was never a sale, and booking it into Tally
 * would invent revenue.
 */

const db = require("../db");
const svc = require("./service");

/* Each type says where its rows live and how to describe one to the queue,
   matching what the create-time hook passes — a backfilled document must
   land in Tally identically to one synced the day it was written. */
const SOURCES = {
  sales_invoice: {
    table: "invoices",
    /* A challan or an estimate is not a tax invoice; only real sales. */
    where: "doc_type = 'invoice'",
    opts: (r) => ({ docNo: r.challan_no, pakka: r.gst_enabled !== 0 })
  },
  purchase_invoice: {
    table: "purchases",
    where: "(doc_type IS NULL OR doc_type <> 'challan')",
    opts: (r) => ({ docNo: r.purchase_no, pakka: r.gst_enabled !== 0 })
  },
  sales_return: {
    table: "sales_returns",
    where: "1=1",
    opts: (r) => ({ docNo: r.return_no, pakka: r.gst_enabled !== 0 })
  },
  purchase_return: {
    table: "purchase_returns",
    where: "1=1",
    opts: (r) => ({ docNo: r.return_no, pakka: r.gst_enabled !== 0 })
  },
  receipt: {
    table: "payments",
    where: "1=1",
    /* Money has no bill number of its own; the cheque or UTR is what the
       shop would look for. The date column differs from every other table
       here, and the financial year is part of the sync id, so it is
       normalised rather than left for enqueue() to miss. */
    date: (r) => r.payment_date || new Date(r.created_at).toISOString().slice(0, 10),
    opts: (r) => ({ docNo: r.reference_no || String(r.id).slice(-8) })
  },
  payment: {
    table: "purchase_payments",
    where: "1=1",
    date: (r) => r.payment_date || new Date(r.created_at).toISOString().slice(0, 10),
    opts: (r) => ({ docNo: r.reference_no || String(r.id).slice(-8) })
  },

  /* CASH BOOK, TYPED ENTRIES ONLY. A row carrying a source_type was posted
     into the cash book automatically from a customer receipt or a supplier
     payment, and already travels as `receipt`/`payment`. Sweeping those up
     here would book the same money twice in the shop's own accounts, so
     the WHERE excludes them — the same test the loader makes again. */
  cash_in: {
    table: "cash_entries",
    where: "type = 'in' AND (source_type IS NULL OR TRIM(source_type) = '')",
    opts: (r) => ({ docNo: String(r.category || "").trim() || "Cash Book" })
  },
  cash_out: {
    table: "cash_entries",
    where: "type = 'out' AND (source_type IS NULL OR TRIM(source_type) = '')",
    opts: (r) => ({ docNo: String(r.category || "").trim() || "Cash Book" })
  }
};

/**
 * How many documents of each type are sitting there, unqueued.
 *
 * Asked before doing anything, so a shop sees "412 sales invoices" and
 * decides, rather than starting something open-ended against live books.
 */
function survey(opts) {
  opts = opts || {};
  const out = {};
  for (const [docType, spec] of Object.entries(SOURCES)) {
    const rows = read(spec, opts);
    let queued = 0;
    for (const r of rows) {
      const fy = svc.fyFor(spec.date ? spec.date(r) : r.date);
      if (db.prepare("SELECT 1 FROM tally_queue WHERE sync_id = ?")
            .get(svc.syncIdFor(docType, r.id, fy))) queued++;
    }
    out[docType] = { total: rows.length, alreadyQueued: queued, pending: rows.length - queued };
  }
  return out;
}

/** The rows for one type, oldest first so the queue reads like the books. */
function read(spec, opts) {
  const cond = [spec.where, "(voided IS NULL OR voided = 0)"];
  const args = [];
  if (opts.from) { cond.push("date >= ?"); args.push(opts.from); }
  if (opts.to)   { cond.push("date <= ?"); args.push(opts.to); }
  /* payments date on a different column, so a date filter cannot be pushed
     into SQL for them without lying about which column it means. */
  const usable = spec.date ? cond.filter(c => !c.startsWith("date")) : cond;
  const usableArgs = spec.date ? [] : args;
  return db.prepare(
    `SELECT * FROM ${spec.table} WHERE ${usable.join(" AND ")} ORDER BY created_at ASC`
  ).all(...usableArgs);
}

/**
 * Fill the queue.
 *
 * @param docTypes  which types to bring across. Nothing is assumed: a shop
 *                  asking for sales and purchases gets sales and purchases,
 *                  not its receipts as well.
 */
function run(docTypes, opts) {
  opts = opts || {};
  const wanted = (docTypes && docTypes.length ? docTypes : Object.keys(SOURCES))
    .filter(t => SOURCES[t]);
  if (!wanted.length) return { error: "No known document type was asked for." };

  const result = {};
  for (const docType of wanted) {
    const spec = SOURCES[docType];
    const rows = read(spec, opts);
    let queued = 0, skipped = 0;
    const reasons = {};

    for (const row of rows) {
      /* The money tables date their rows elsewhere; enqueue() reads .date to
         work out the financial year and the FY is part of the sync id. */
      const doc = spec.date ? { ...row, date: spec.date(row) } : row;
      const r = svc.enqueue(docType, doc, spec.opts(row));
      if (r && r.queued) queued++;
      else {
        skipped++;
        const why = (r && r.reason) || "unknown";
        reasons[why] = (reasons[why] || 0) + 1;
      }
    }
    result[docType] = { found: rows.length, queued, skipped, reasons };
  }
  return result;
}

module.exports = { run, survey, SOURCES };
