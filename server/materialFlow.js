/* ============================================================
   MATERIAL FLOW — where did this purchase go?

   Answers, for every purchase: how much of it left through a sales challan,
   how much through a sales invoice, and how much is still on the racks.

   HOW IT KNOWS, GIVEN THE APP DOES NOT TRACK LOTS
   -----------------------------------------------
   Stock here is a single pooled quantity per size per location. Nothing
   records that "these ten sheets came from PU0000016", and adding that
   would change how every sale writes stock — a large change to a working
   billing system for a report.

   So allocation is DERIVED, oldest purchase first, exactly the rule
   outstanding.js already uses to decide which bill a payment settled: "the
   way a shop actually settles an account". The same reasoning applies to
   material — the sheets at the bottom of the pile went out first.

   This is an ESTIMATE and is labelled as one everywhere it is shown. It is
   arithmetically sound and it balances, but it is not lot tracking, and a
   shop that needs to know which physical batch reached which customer needs
   lot numbers, not this.

   THE DOUBLE-COUNT THIS AVOIDS
   ----------------------------
   Converting a sales challan into an invoice COPIES its item rows onto the
   new invoice, and both documents keep them. Count both and every converted
   challan consumes its material twice — the report would show goods leaving
   that never existed. So a challan that has been converted is skipped; its
   invoice speaks for it. Each unit of material is counted exactly once.

   VALUE IS AT COST, not at what it later sold for. The question is "where
   did my ₹1,00,000 go", so the parts have to add back up to ₹1,00,000.
   Mixing purchase cost with sale price would produce a report whose
   columns do not reconcile with anything.
   ============================================================ */

const db = require("./db");

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Everything that ever brought stock in, oldest first.
 *
 * Purchase challans count as well as purchase invoices: both physically
 * bring goods onto the racks, and a shop that receives on a challan and is
 * billed a month later still has the material in the meantime.
 */
function purchaseLines(filters) {
  const where = ["p.voided = 0"];
  const args = [];
  if (filters.from) { where.push("p.date >= ?"); args.push(filters.from); }
  if (filters.to)   { where.push("p.date <= ?"); args.push(filters.to); }
  if (filters.supplierId) { where.push("p.supplier_id = ?"); args.push(filters.supplierId); }
  if (filters.productId)  { where.push("pi.product_id = ?"); args.push(filters.productId); }

  return db.prepare(`
    SELECT pi.id AS line_id, pi.product_id, pi.size_id, pi.name,
           pi.pieces, pi.qty, pi.rate, COALESCE(pi.discount_amount, 0) AS discount_amount,
           p.id AS doc_id, p.purchase_no AS doc_no, p.date, p.doc_type,
           s.name AS party_name
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE ${where.join(" AND ")}
     ORDER BY p.date ASC, p.created_at ASC, pi.id ASC
  `).all(...args);
}

/**
 * Everything that took stock out, oldest first.
 *
 * A converted challan is deliberately absent — see the note at the top.
 * Sales returns come back as NEGATIVE consumption, so goods a customer
 * sent back stop counting as gone.
 */
function salesLines() {
  const out = db.prepare(`
    SELECT ii.product_id, ii.size_id, ii.pieces,
           i.id AS doc_id, i.challan_no AS doc_no, i.date, i.doc_type,
           c.name AS party_name
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.voided = 0
       AND (i.doc_type = 'invoice'
            OR (i.doc_type = 'challan'
                AND (i.converted_invoice_id IS NULL OR i.converted_invoice_id = '')))
     ORDER BY i.date ASC, i.created_at ASC, ii.id ASC
  `).all();

  const returned = db.prepare(`
    SELECT ri.product_id, ri.size_id, ri.pieces
      FROM sales_return_items ri
      JOIN sales_returns r ON r.id = ri.return_id
     WHERE r.voided = 0
  `).all();

  /* Netted per size rather than as their own timeline entries: a return is
     material coming back to the pile, not a separate consumer of it. */
  const backBySize = new Map();
  for (const r of returned) {
    const k = String(r.size_id);
    backBySize.set(k, (backBySize.get(k) || 0) + (Number(r.pieces) || 0));
  }
  return { out, backBySize };
}

/**
 * Match goods out against goods in, oldest purchase first.
 *
 * @returns one row per purchase LINE, with how much of it went where.
 */
function allocate(filters) {
  filters = filters || {};
  const buys = purchaseLines(filters);
  const { out, backBySize } = salesLines();

  /* One queue per size: material of one size is interchangeable, which is
     the whole reason a pooled stock figure works in the first place. */
  const queues = new Map();
  for (const b of buys) {
    const k = String(b.size_id);
    const pieces = Number(b.pieces) || 0;
    const net = (Number(b.qty) || 0) * (Number(b.rate) || 0) - Number(b.discount_amount || 0);
    const perPiece = pieces ? net / pieces : 0;
    const row = {
      ...b, pieces, perPiece,
      value: round2(net),
      viaChallanQty: 0, viaInvoiceQty: 0, left: pieces,
      consumers: []
    };
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(row);
  }

  /* Returns replenish the OLDEST consumed material first, undoing the most
     recent... no: they put material back at the front of the pile, so the
     simplest honest treatment is to reduce what the sales side is asking
     for, size by size. */
  const owed = new Map(backBySize);

  for (const s of out) {
    const k = String(s.size_id);
    const q = queues.get(k);
    if (!q) continue;
    let want = Number(s.pieces) || 0;

    const credit = owed.get(k) || 0;
    if (credit > 0) {
      const used = Math.min(credit, want);
      owed.set(k, credit - used);
      want -= used;
    }

    for (const row of q) {
      if (want <= 0) break;
      if (row.left <= 0) continue;
      const take = Math.min(row.left, want);
      row.left -= take;
      want -= take;
      if (s.doc_type === "challan") row.viaChallanQty += take;
      else row.viaInvoiceQty += take;
      row.consumers.push({
        type: s.doc_type === "challan" ? "Sales Challan" : "Sales Invoice",
        no: s.doc_no, date: s.date, party: s.party_name || "Walk-in",
        docId: s.doc_id, pieces: take, value: round2(take * row.perPiece)
      });
    }
    /* want > 0 here means goods went out that this purchase window cannot
       explain — stock from before the range, or an adjustment. Not an
       error, and deliberately not forced onto a purchase that did not
       supply it. */
  }

  return buys.length ? [...queues.values()].flat() : [];
}

/**
 * Rolled up per purchase DOCUMENT, which is how a shop asks the question:
 * "that ₹1,00,000 bill — where did it go?"
 */
function byDocument(filters) {
  const lines = allocate(filters);
  const docs = new Map();

  for (const l of lines) {
    if (!docs.has(l.doc_id)) {
      docs.set(l.doc_id, {
        docId: l.doc_id, docNo: l.doc_no, date: l.date,
        docType: l.doc_type === "challan" ? "Purchase Challan" : "Purchase Invoice",
        party: l.party_name || "Unknown supplier",
        qty: 0, value: 0,
        viaChallanQty: 0, viaChallanValue: 0,
        viaInvoiceQty: 0, viaInvoiceValue: 0,
        remainingQty: 0, remainingValue: 0,
        consumers: []
      });
    }
    const d = docs.get(l.doc_id);
    d.qty += l.pieces;
    d.value = round2(d.value + l.value);
    d.viaChallanQty += l.viaChallanQty;
    d.viaChallanValue = round2(d.viaChallanValue + l.viaChallanQty * l.perPiece);
    d.viaInvoiceQty += l.viaInvoiceQty;
    d.viaInvoiceValue = round2(d.viaInvoiceValue + l.viaInvoiceQty * l.perPiece);
    d.remainingQty += l.left;
    d.remainingValue = round2(d.remainingValue + l.left * l.perPiece);

    /* One entry per consuming document, not per line, so a bill that took
       three sizes from this purchase reads as one sale. */
    for (const c of l.consumers) {
      const seen = d.consumers.find(x => x.docId === c.docId);
      if (seen) { seen.pieces += c.pieces; seen.value = round2(seen.value + c.value); }
      else d.consumers.push({ ...c });
    }
  }

  const rows = [...docs.values()].sort((a, b) =>
    String(b.date).localeCompare(String(a.date)));

  const totals = rows.reduce((t, d) => ({
    value: round2(t.value + d.value),
    viaChallanValue: round2(t.viaChallanValue + d.viaChallanValue),
    viaInvoiceValue: round2(t.viaInvoiceValue + d.viaInvoiceValue),
    remainingValue: round2(t.remainingValue + d.remainingValue)
  }), { value: 0, viaChallanValue: 0, viaInvoiceValue: 0, remainingValue: 0 });

  return {
    rows, totals,
    /* Said in the response, not only in the code, so anything that renders
       this cannot present it as lot-accurate. */
    basis: "Allocated oldest purchase first. Stock is pooled, so this is a " +
           "sound estimate rather than lot tracking."
  };
}

module.exports = { byDocument, allocate };
