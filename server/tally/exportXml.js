/* ============================================================
   TALLY EXPORT — the same vouchers, as a file

   The bridge exists for one reason: Tally listens on port 9000 of the
   shop's own PC, and a server in a data centre cannot reach it. Nothing
   about BUILDING the XML needs the bridge — only delivering it does. So
   this hands the operator the file and lets Tally's own importer take it:
   Gateway of Tally > Import Data.

   IT BUILDS NOTHING ITSELF. Every voucher here comes out of processOne in
   capture mode, which is the same function the live sync uses. A second
   builder would mean two copies of the GST split, the ledger mapping, the
   party grouping and the rule that stops a cash row being booked twice —
   and the copy nobody watches is the one that quietly goes wrong.

   NOTHING IS MARKED SYNCED. A downloaded file says nothing about whether
   Tally accepted it; the shop might never import it. Queue rows are left
   exactly as they were, and the operator confirms separately once Tally
   has actually taken the data. An optimistic tick here would be a lie the
   shop only discovers at filing time.

   TWO FILES, NOT ONE. Tally takes masters under the report name
   "All Masters" and vouchers under "Vouchers" — different envelopes, so
   they cannot be merged. Masters go first: a voucher that names a ledger
   Tally has never heard of is rejected.
   ============================================================ */
const db = require("../db");
const svc = require("./service");
const connector = require("./connector");
const { processOne } = require("./processor");

const MAX_ROWS = 2000;

/** The rows an export will cover. PENDING and RETRY are what has not
 *  reached Tally yet; a date range can also pull back things already sent,
 *  which is what you want when rebuilding a company from scratch. */
function selectRows({ scope, from, to, ids }) {
  if (Array.isArray(ids) && ids.length) {
    const marks = ids.map(() => "?").join(",");
    return db.prepare(
      `SELECT * FROM tally_queue WHERE sync_id IN (${marks}) ORDER BY doc_date ASC, id ASC`
    ).all(...ids);
  }
  if (scope === "range") {
    return db.prepare(`
      SELECT * FROM tally_queue
       WHERE doc_date >= ? AND doc_date <= ?
       ORDER BY doc_date ASC, id ASC
       LIMIT ?`).all(from || "0000-01-01", to || "9999-12-31", MAX_ROWS);
  }
  return db.prepare(`
    SELECT * FROM tally_queue
     WHERE status IN ('PENDING','RETRY','FAILED')
     ORDER BY doc_date ASC, id ASC
     LIMIT ?`).all(MAX_ROWS);
}

/** The <TALLYMESSAGE> blocks inside one envelope, and which kind it is.
 *  Read off the report name the envelope declares rather than guessed
 *  from the contents, so a masters envelope can never be filed as a
 *  voucher and silently dropped by Tally. */
function unwrap(xml) {
  const kind = xml.includes("<REPORTNAME>All Masters</REPORTNAME>") ? "masters"
             : xml.includes("<REPORTNAME>Vouchers</REPORTNAME>") ? "vouchers"
             : null;
  const a = xml.indexOf("<REQUESTDATA>");
  const b = xml.lastIndexOf("</REQUESTDATA>");
  if (kind === null || a < 0 || b < 0) return null;
  return { kind, body: xml.slice(a + "<REQUESTDATA>".length, b) };
}

/**
 * Build the export.
 *
 * Returns the two XML documents plus an honest account of what went in and
 * what did not — a row that could not be built is reported, never skipped
 * in silence, because a missing voucher is the kind of thing a shop finds
 * out about from its accountant.
 */
async function buildExport(opts) {
  opts = opts || {};
  const s = svc.settings();
  if (!s.company) {
    throw new Error("Choose the Tally company first — the export has to name it.");
  }

  const rows = selectRows(opts);
  const masters = [];
  const vouchers = [];
  const included = [];
  const problems = [];

  for (const row of rows) {
    const captured = [];
    let r;
    try {
      /* capture: an array is the signal. processOne fills it and neither
         sends nor writes — see the note above its mark(). */
      r = await processOne(row, { capture: captured, staff: opts.staff });
    } catch (err) {
      problems.push({ docNo: row.doc_no, date: row.doc_date, type: row.doc_type,
                      reason: err.message });
      continue;
    }
    if (!captured.length) {
      problems.push({ docNo: row.doc_no, date: row.doc_date, type: row.doc_type,
                      reason: (r && r.error) || (r && r.reason) || "nothing to send for this row" });
      continue;
    }
    for (const xml of captured) {
      const part = unwrap(xml);
      if (!part) continue;
      (part.kind === "masters" ? masters : vouchers).push(part.body);
    }
    included.push({ syncId: row.sync_id, docNo: row.doc_no, date: row.doc_date,
                    type: row.doc_type });
  }

  /* Tally re-reads a master it already has without complaint, so exact
     repeats are dropped only to keep the file small and readable. */
  const uniqueMasters = [...new Set(masters)];

  return {
    company: s.company,
    counts: {
      rows: rows.length,
      included: included.length,
      vouchers: vouchers.length,
      masters: uniqueMasters.length,
      problems: problems.length,
    },
    included,
    problems,
    mastersXml: uniqueMasters.length
      ? connector.importEnvelope(s.company, uniqueMasters) : "",
    vouchersXml: vouchers.length
      ? connector.voucherEnvelope(s.company, vouchers) : "",
  };
}

/**
 * Mark rows as reached-Tally AFTER the operator confirms the import
 * succeeded. Separate from the export on purpose: only the person who
 * watched Tally's import report knows whether it worked.
 */
function confirmImported(syncIds, staff) {
  if (!Array.isArray(syncIds) || !syncIds.length) return { updated: 0 };
  const now = Date.now();
  const upd = db.prepare(`
    UPDATE tally_queue
       SET status = 'SUCCESS', synced_at = ?, updated_at = ?, last_error = ''
     WHERE sync_id = ? AND status IN ('PENDING','RETRY','FAILED')`);
  let updated = 0;
  db.transaction(() => {
    for (const id of syncIds) updated += upd.run(now, now, id).changes;
  })();
  svc.log({ syncId: "", docType: "", docId: "", docNo: "",
            action: "export-confirm", status: "SUCCESS", attempt: 0,
            message: `operator confirmed ${updated} voucher(s) imported into Tally by file`,
            staff: staff || "" });
  return { updated };
}

module.exports = { buildExport, confirmImported, selectRows };
