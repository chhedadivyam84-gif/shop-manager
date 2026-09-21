/* ============================================================
   DOING THE IMPORT

   By the time anything here runs, the operator has seen every row, every
   refusal and every suspected duplicate, and has chosen what to take. This
   module's whole job is to write exactly that, in one transaction, and to
   leave behind enough of a record that it can be taken back out again.

   WHAT IT WILL NOT DO
   -------------------
   It never calls inventory.addStock, never touches size_location_stock,
   never advances doc_numbering, and never moves customers.due or
   suppliers.due. Historical bills are history: the goods left the shop
   years ago and the drawer was counted this morning. Opening stock is a
   separate, deliberate act — see the opening-stock flow, not this file.

   The check is not left to good intentions. importRun.js does not require
   inventory, stockLedger or docNumber at all, so there is no path from
   here to any of them, and a test asserts that the file never grows one.

   ONE TRANSACTION
   ---------------
   A half-finished import is worse than none: the operator cannot tell what
   landed, and running it again would double what did. So the batch, its
   rows and the records all commit together or not at all.
   ============================================================ */
const db = require("./db");
const { uid } = require("./util");
const M = require("./importMap");

const now = () => Date.now();

/* Where each category's rows go, and the columns each one fills. Written
   out rather than derived from the field list so that adding a field to a
   form cannot silently start writing to a column nobody intended. */
const WRITERS = {
  sales: {
    table: "hist_sales",
    insert: `INSERT INTO hist_sales
      (id, batch_id, date, bill_no, party, amount, taxable, tax, gstin, remarks, dup_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: (id, batch, v, key, t) =>
      [id, batch, v.date, v.bill_no || "", v.party || "", v.amount || 0,
       v.taxable, v.tax, v.gstin || "", v.remarks || "", key, t],
  },
  purchase: {
    table: "hist_purchases",
    insert: `INSERT INTO hist_purchases
      (id, batch_id, date, bill_no, party, amount, taxable, tax, gstin, remarks, dup_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: (id, batch, v, key, t) =>
      [id, batch, v.date, v.bill_no || "", v.party || "", v.amount || 0,
       v.taxable, v.tax, v.gstin || "", v.remarks || "", key, t],
  },
  cash: {
    table: "hist_cash_entries",
    insert: `INSERT INTO hist_cash_entries
      (id, batch_id, date, direction, amount, party, category, remarks, dup_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: (id, batch, v, key, t) =>
      [id, batch, v.date, v.direction, v.amount || 0, v.party || "",
       v.category || "", v.remarks || "", key, t],
  },
  gst: {
    table: "hist_gst_records",
    insert: `INSERT INTO hist_gst_records
      (id, batch_id, date, bill_no, party, gstin, irn, taxable, tax, amount, dup_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: (id, batch, v, key, t) =>
      [id, batch, v.date, v.bill_no || "", v.party || "", v.gstin || "",
       v.irn || "", v.taxable, v.tax, v.amount, key, t],
  },
};

/* Customers and suppliers are master data, not history, so they go into
   the live tables the rest of the app already reads. Two rules make that
   safe: a party that already exists is LEFT ALONE — never overwritten,
   because the shop's own spelling, phone number and GST are worth more
   than a spreadsheet's — and one that is created is recorded as created,
   so an undo removes only what the import actually added. */
const PARTY = {
  customers: { table: "customers", prefix: "C" },
  suppliers: { table: "suppliers", prefix: "S" },
};

function importParty(category, v, batchId) {
  const spec = PARTY[category];
  const existing = db.prepare(
    `SELECT id FROM ${spec.table} WHERE LOWER(TRIM(name)) = ?`
  ).get(M.norm(v.name));
  if (existing) return { id: existing.id, created: 0 };

  const id = uid(spec.prefix);
  db.prepare(`
    INSERT INTO ${spec.table} (id, name, phone, address, gst, state, due, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, String(v.name).trim(), v.phone || "", v.address || "",
         v.gst || "", v.state || "", now());
  return { id, created: 1 };
}

/**
 * Write an approved import.
 *
 * `rows` are validate()'s rows. `take` is the set of row numbers the
 * operator ticked; anything not in it is recorded as skipped rather than
 * dropped, so the history shows what was offered as well as what was
 * taken.
 */
function run({ category, filename, rows, take, mapping, staff }) {
  const spec = M.CATEGORIES[category];
  if (!spec) throw new Error("Unknown import type.");
  const wanted = new Set((take || []).map(Number));
  const batchId = uid("IMP");
  const t = now();

  let imported = 0, skipped = 0, duplicate = 0, errored = 0;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO import_batches
        (id, at, staff, category, filename, rows_total, mapping_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'imported')
    `).run(batchId, t, staff || "", category, filename || "",
           rows.length, JSON.stringify(mapping || {}));

    const logRow = db.prepare(`
      INSERT INTO import_rows
        (batch_id, row_no, status, reason, target_table, target_id, created, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of rows) {
      /* A row the operator did not tick is recorded and passed over, even
         when it was perfectly importable — the record is of what happened,
         not of what could have. */
      if (!wanted.has(r.rowNo)) {
        skipped++;
        logRow.run(batchId, r.rowNo, "skipped",
                   r.status === "ok" ? "not selected" : r.reason,
                   "", "", 0, JSON.stringify(r.raw || []));
        continue;
      }
      /* A row that could not be read is never written, ticked or not —
         there is nothing to write. */
      if (r.status === "error") {
        errored++;
        logRow.run(batchId, r.rowNo, "error", r.reason, "", "", 0, JSON.stringify(r.raw || []));
        continue;
      }

      /* A SUSPECTED DUPLICATE THAT WAS TICKED ANYWAY IS TAKEN.

         Reaching this line means the operator saw "already imported
         earlier" against this row and chose it regardless — and they are
         better placed to judge than a key built from a date, a bill
         number and an amount. Two genuine bills can share all three.

         It is still counted and recorded as a duplicate, so the history
         shows plainly that it went in over a warning rather than
         appearing as an ordinary row. Anything NOT ticked was already
         passed over above. */
      const wasDuplicate = r.status === "duplicate";
      if (wasDuplicate) duplicate++;

      if (PARTY[category]) {
        const res = importParty(category, r.values, batchId);
        if (!wasDuplicate) imported++;
        logRow.run(batchId, r.rowNo, wasDuplicate ? "duplicate" : "imported",
                   res.created ? (wasDuplicate ? r.reason : "")
                               : "matched a party already on file",
                   PARTY[category].table, res.id, res.created,
                   JSON.stringify(r.raw || []));
        continue;
      }

      const w = WRITERS[category];
      const id = uid("H");
      db.prepare(w.insert).run(...w.bind(id, batchId, r.values, r.dupKey || "", t));
      if (!wasDuplicate) imported++;
      logRow.run(batchId, r.rowNo, wasDuplicate ? "duplicate" : "imported",
                 wasDuplicate ? r.reason + " — taken anyway" : "",
                 w.table, id, 1, JSON.stringify(r.raw || []));
    }

    db.prepare(`
      UPDATE import_batches
         SET rows_imported = ?, rows_skipped = ?, rows_duplicate = ?, rows_error = ?
       WHERE id = ?
    `).run(imported, skipped, duplicate, errored, batchId);
  })();

  return { batchId, counts: { total: rows.length, imported, skipped, duplicate, error: errored } };
}

/* ------------------------------------------------------------- history */

function listBatches(limit = 50) {
  return db.prepare(`
    SELECT * FROM import_batches ORDER BY at DESC LIMIT ?
  `).all(Math.min(Number(limit) || 50, 200));
}

function batchDetail(batchId, limit = 500) {
  const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batchId);
  if (!batch) return null;
  const rows = db.prepare(`
    SELECT row_no, status, reason, target_table, target_id, created
      FROM import_rows WHERE batch_id = ? ORDER BY row_no LIMIT ?
  `).all(batchId, Math.min(Number(limit) || 500, 5000));
  return { batch, rows };
}

/* ------------------------------------------------------------- undoing

   A reversal follows import_rows and removes only the ids this batch
   created. It is deliberately NOT "delete from hist_sales where batch_id":
   the party tables hold rows the import merely matched, and deleting those
   would take out a customer the shop has been billing for years. `created`
   is the flag that tells the two apart.

   The batch itself is kept, marked reversed. A shop that imported the
   wrong file twice needs to be able to see that it did. */
function reverse(batchId, staff) {
  const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batchId);
  if (!batch) throw new Error("That import was not found.");
  if (batch.status === "reversed") throw new Error("That import has already been undone.");

  let removed = 0, kept = 0;
  const blocked = [];

  db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM import_rows
       /* Any row that WROTE something, whatever it was labelled. A row
          taken over a duplicate warning is recorded as a duplicate but it
          still created a record, and an undo that ignored it would leave
          exactly the rows the operator was least sure about. target_id is
          what says something was written; created says whether to remove
          it or leave it alone. */
       WHERE batch_id = ? AND target_id <> ''
    `).all(batchId);

    for (const r of rows) {
      if (!r.created) { kept++; continue; }   /* matched, not made */

      /* A party that has been used since the import is left in place. Its
         removal would orphan a bill or a payment that references it, and a
         tidy undo is not worth a broken ledger — so it is reported instead
         of forced. */
      if (r.target_table === "customers" || r.target_table === "suppliers") {
        const used =
          (r.target_table === "customers"
            ? db.prepare("SELECT COUNT(*) n FROM invoices WHERE customer_id = ?").get(r.target_id).n +
              db.prepare("SELECT COUNT(*) n FROM payments WHERE customer_id = ?").get(r.target_id).n
            : db.prepare("SELECT COUNT(*) n FROM purchases WHERE supplier_id = ?").get(r.target_id).n);
        if (used > 0) {
          kept++;
          blocked.push({ table: r.target_table, id: r.target_id,
                         reason: `used by ${used} record(s) since the import` });
          continue;
        }
      }

      db.prepare(`DELETE FROM ${r.target_table} WHERE id = ?`).run(r.target_id);
      removed++;
    }

    db.prepare(`
      UPDATE import_batches
         SET status = 'reversed', reversed_at = ?, reversed_by = ?
       WHERE id = ?
    `).run(now(), staff || "", batchId);
  })();

  return { batchId, removed, kept, blocked };
}

module.exports = { run, listBatches, batchDetail, reverse, WRITERS, PARTY };
