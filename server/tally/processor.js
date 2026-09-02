/* ============================================================
   SENDING WHAT IS IN THE QUEUE

   One queue row at a time: load the document from Shop Manager, resolve
   the names Tally knows it by, build the voucher, send it, write down what
   happened.

   THE ORDER MATTERS. Masters go first — the party ledger and every stock
   item — because Tally rejects a voucher naming a ledger it does not have,
   and rejects it with a message that names the ledger but not the bill. A
   shop should not have to learn that "Ledger ABC Traders does not exist"
   means "go and create ABC Traders".

   Sending a master that already exists is safe: Tally matches on name and
   alters rather than duplicating. That is why this can send them every
   time instead of tracking which ones it has sent.

   ONE DIRECTION. What comes back is a voucher number and, on failure, a
   message. Neither is ever written into a bill, a customer or a product —
   they live in the queue and the log, which is where facts about the sync
   belong.
   ============================================================ */
const db = require("../db");
const connector = require("./connector");
const V = require("./vouchers");
const svc = require("./service");

/* The Tally ledgers a voucher posts against. A shop that calls its sales
   ledger something else changes it here, once, rather than in six places.
   Held in settings so it is per-shop and not per-install. */
const DEFAULT_LEDGERS = {
  sales: "Sales", purchase: "Purchase",
  cgst: "CGST", sgst: "SGST", igst: "IGST",
  roundOff: "Round Off", cash: "Cash"
};

function ledgerNames() {
  const s = svc.settings();
  let over = {};
  try { over = JSON.parse(s.ledgers || "{}") || {}; } catch (e) { over = {}; }
  return { ...DEFAULT_LEDGERS, ...over };
}

/**
 * What Tally calls this record.
 *
 * A mapping wins; otherwise the Shop Manager name is used as-is, which is
 * right for a shop starting fresh. `ignore` means the owner decided this
 * one never goes — and that is a decision, not a gap, so it is honoured.
 */
function mapped(kind, localId, fallbackName) {
  const m = db.prepare("SELECT * FROM tally_map WHERE kind = ? AND local_id = ?")
              .get(kind, localId);
  if (m && m.action === "ignore") return { ignore: true };
  if (m && m.tally_name) return { name: m.tally_name, create: m.action === "create" };
  return { name: String(fallbackName || "").trim(), create: true };
}

/* ------------------------------------------------------------------ */
/* loading a document                                                   */
/* ------------------------------------------------------------------ */

function loadSalesInvoice(id) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  if (!inv) return null;
  inv.items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(id);
  inv.party = inv.customer_id
    ? db.prepare("SELECT * FROM customers WHERE id = ?").get(inv.customer_id) : null;
  return inv;
}

function loadPurchase(id) {
  const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id);
  if (!p) return null;
  p.items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(id);
  p.party = p.supplier_id
    ? db.prepare("SELECT * FROM suppliers WHERE id = ?").get(p.supplier_id) : null;
  return p;
}

function loadSalesReturn(id) {
  const r = db.prepare("SELECT * FROM sales_returns WHERE id = ?").get(id);
  if (!r) return null;
  r.items = db.prepare("SELECT * FROM sales_return_items WHERE return_id = ?").all(id);
  r.party = r.customer_id
    ? db.prepare("SELECT * FROM customers WHERE id = ?").get(r.customer_id) : null;
  return r;
}

function loadPurchaseReturn(id) {
  const r = db.prepare("SELECT * FROM purchase_returns WHERE id = ?").get(id);
  if (!r) return null;
  r.items = db.prepare("SELECT * FROM purchase_return_items WHERE return_id = ?").all(id);
  r.party = r.supplier_id
    ? db.prepare("SELECT * FROM suppliers WHERE id = ?").get(r.supplier_id) : null;
  return r;
}

/**
 * Money in from a customer.
 *
 * Shop Manager calls this table `payments` because that is what the
 * customer did. In Tally the shop RECEIVED it, so it becomes a Receipt.
 * Getting these two words the wrong way round posts every collection as a
 * payment out, which reverses the whole cash book.
 */
function loadReceipt(id) {
  const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  if (!p) return null;
  p.party = p.customer_id
    ? db.prepare("SELECT * FROM customers WHERE id = ?").get(p.customer_id) : null;
  p.date = p.payment_date || new Date(p.created_at).toISOString().slice(0, 10);
  p.bank = p.bank_account_id
    ? db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(p.bank_account_id) : null;
  return p;
}

/** Money out to a supplier. A Payment in both vocabularies. */
function loadPayment(id) {
  const p = db.prepare("SELECT * FROM purchase_payments WHERE id = ?").get(id);
  if (!p) return null;
  p.party = p.supplier_id
    ? db.prepare("SELECT * FROM suppliers WHERE id = ?").get(p.supplier_id) : null;
  p.date = p.payment_date || new Date(p.created_at).toISOString().slice(0, 10);
  p.bank = p.bank_account_id
    ? db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(p.bank_account_id) : null;
  return p;
}

/**
 * Which Tally ledger the money moved through.
 *
 * A named bank account if there is one, otherwise the shop's Cash ledger.
 * Falling back to Cash is right rather than lazy: Shop Manager records
 * "Bank" without naming which until a bank account is chosen, and posting
 * an unnamed bank receipt into Cash is at least a real ledger the shop can
 * then correct, where a made-up name is a voucher Tally refuses.
 */
function moneyLedger(doc, L) {
  if (doc.bank && doc.bank.name) {
    const m = mapped("ledger", doc.bank.id, doc.bank.name);
    if (!m.ignore && m.name) return { name: m.name, create: m.create, isBank: true };
  }
  return { name: L.cash, create: true, isBank: false };
}

const LOADERS = {
  sales_invoice: loadSalesInvoice,
  purchase_invoice: loadPurchase,
  sales_return: loadSalesReturn,
  purchase_return: loadPurchaseReturn,
  receipt: loadReceipt,
  payment: loadPayment,
  cash_in: loadCashEntry,
  cash_out: loadCashEntry
};

/**
 * A CASH BOOK ENTRY TYPED STRAIGHT IN.
 *
 * Its party is its CATEGORY — "Rent", "Tea", "Freight" — because that is
 * what the money was actually for. A cash row that was auto-posted from a
 * customer receipt or a supplier payment is NOT loaded here: those already
 * travel as `receipt` and `payment`, and sending them again would charge
 * the shop twice in its own books. source_type is how they are told apart,
 * and the guard is repeated at the point of enqueue as well as here.
 */
function loadCashEntry(id) {
  const c = db.prepare("SELECT * FROM cash_entries WHERE id = ?").get(id);
  if (!c) return null;
  if (String(c.source_type || "").trim()) return null;   // already sent another way
  const name = String(c.category || "").trim() || "Cash Book";
  return {
    ...c,
    /* The shape the money branch expects: a party with a name, an amount,
       and a date. The party here is a heading in the books, not a person. */
    party: { id: "CAT:" + name, name },
    amount: Math.abs(Number(c.amount) || 0),
    note: [c.party, c.remarks].filter(Boolean).join(" · "),
    bank: null                       /* always Cash — that is what a cash book is */
  };
}

/* A receipt and a payment have no stock lines — they are two ledger lines
   and nothing else. They take their own path through processOne below.
   Cash book entries are the same shape, so they take the same path. */
const MONEY_TYPES = { receipt: 1, payment: 1, cash_in: 1, cash_out: 1 };

/* ------------------------------------------------------------------ */
/* masters a voucher depends on                                         */
/* ------------------------------------------------------------------ */

/**
 * Every master this voucher needs, as XML messages.
 *
 * Returns null when something is deliberately ignored, so the caller can
 * skip the whole document rather than send a voucher missing a line.
 */
function mastersFor(doc, isSale) {
  const msgs = [];
  const L = ledgerNames();

  const party = mapped("ledger", doc.party ? doc.party.id : "", doc.party ? doc.party.name : "Cash");
  if (party.ignore) return { ignore: true, why: "the party is set to Ignore" };
  if (!party.name) return { error: "This document has no party, and no ledger to post against." };

  if (party.create) {
    msgs.push(V.ledgerMaster(party.name,
      isSale ? "Sundry Debtors" : "Sundry Creditors",
      { gstin: doc.party && doc.party.gst, address: doc.party && doc.party.address,
        state: doc.party && doc.party.state }));
  }

  /* The posting and tax ledgers. Cheap to send, and their absence is the
     commonest reason a first sync fails on a fresh Tally company. */
  msgs.push(V.ledgerMaster(isSale ? L.sales : L.purchase,
    isSale ? "Sales Accounts" : "Purchase Accounts", { billwise: false }));
  ["cgst", "sgst", "igst"].forEach(k =>
    msgs.push(V.ledgerMaster(L[k], "Duties & Taxes", { billwise: false })));

  const items = [];
  const units = new Set();
  for (const it of (doc.items || [])) {
    const prod = it.product_id
      ? db.prepare("SELECT * FROM products WHERE id = ?").get(it.product_id) : null;
    const m = mapped("stockitem", it.product_id || "", it.name);
    if (m.ignore) continue;                       // this line deliberately excluded
    if (!m.name) return { error: "A line on this document has no product name." };

    const unit = (it.unit_label || (prod && prod.unit) || "Nos").trim() || "Nos";
    units.add(unit);
    if (m.create) {
      /* NO GROUP IS AN EMPTY STRING, NOT "Primary".

         Naming "Primary" is what every Tally example does and TallyPrime
         refuses it for stock — "Stock Group 'Primary' does not exist!" —
         which failed every document at the master stage, before a voucher
         was ever attempted. Empty lets Tally file the item at the root,
         which is what "Primary" was reaching for.

         A product that HAS a category or brand still gets a real group,
         created at the root, exactly as before. */
      const group = (prod && (prod.category || prod.brand)) || "";
      if (group) msgs.push(V.stockGroupMaster(group, ""));
      msgs.push(V.stockItemMaster(m.name, group, unit));
    }
    const qty = Number(it.qty) || 0;
    const rate = Number(it.rate) || 0;
    const disc = Number(it.discount_amount) || 0;
    items.push({
      tallyItem: m.name, qty, unit, rate,
      amount: Math.round((qty * rate - disc) * 100) / 100
    });
  }
  /* Tally refuses a stock item whose unit it does not have, so the units
     go before the items that use them. */
  units.forEach(u => msgs.unshift(V.unitMaster(u)));

  if (!items.length) return { ignore: true, why: "every line on it is set to Ignore" };
  return { msgs, party: party.name, items, ledgers: L };
}

/* ------------------------------------------------------------------ */
/* sending one row                                                      */
/* ------------------------------------------------------------------ */

/**
 * @returns { ok, error?, voucherNo?, skipped? }
 *
 * Never throws. A queue run walks many rows and one bad document must not
 * stop the rest.
 */
async function processOne(rowOrSyncId, opts) {
  opts = opts || {};
  const row = typeof rowOrSyncId === "string"
    ? db.prepare("SELECT * FROM tally_queue WHERE sync_id = ?").get(rowOrSyncId)
    : rowOrSyncId;
  if (!row) return { ok: false, error: "That document is not in the queue." };

  const s = svc.settings();
  if (!s.enabled) return { ok: false, error: "Tally sync is switched off." };
  if (!s.company) return { ok: false, error: "No Tally company has been chosen yet." };

  const mark = (status, extra) => {
    db.prepare(`
      UPDATE tally_queue SET status = ?, attempts = attempts + ?, last_error = ?,
        voucher_no = COALESCE(NULLIF(?, ''), voucher_no),
        voucher_type = COALESCE(NULLIF(?, ''), voucher_type),
        updated_at = ?, synced_at = ?
      WHERE sync_id = ?
    `).run(status, extra.countAttempt ? 1 : 0, extra.error || "",
           extra.voucherNo || "", extra.voucherType || "",
           Date.now(), status === "SUCCESS" ? Date.now() : row.synced_at || null,
           row.sync_id);
  };

  db.prepare("UPDATE tally_queue SET status='PROCESSING', updated_at=? WHERE sync_id=?")
    .run(Date.now(), row.sync_id);

  try {
    const spec = svc.DOC_TYPES[row.doc_type];
    const load = LOADERS[row.doc_type];
    if (!spec || !load) {
      mark("FAILED", { error: "This document type cannot be synced yet.", countAttempt: true });
      return { ok: false, error: "This document type cannot be synced yet." };
    }

    const doc = load(row.doc_id);
    if (!doc) {
      mark("FAILED", { error: "The document no longer exists in Shop Manager.", countAttempt: true });
      return { ok: false, error: "The document no longer exists in Shop Manager." };
    }

    /* A cancellation, queued by enqueueCancel. The voucher is marked
       cancelled in Tally and left in place — never deleted. */
    const cancelling = String(row.payload_hash || "").startsWith("cancel:");
    if (cancelling) {
      const xml = connector.voucherEnvelope(s.company, [V.cancelVoucher({
        syncId: row.sync_id, type: row.voucher_type || spec.voucher,
        number: row.doc_no, date: row.doc_date
      })]);
      const r = await connector.send(s, xml);
      if (!r.ok) {
        mark("FAILED", { error: r.error, countAttempt: true });
        svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                  docNo: row.doc_no, action: "cancel", status: "FAILED",
                  attempt: row.attempts + 1, message: r.error, staff: opts.staff });
        return { ok: false, error: r.error };
      }
      mark("CANCELLED", { countAttempt: true });
      svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                docNo: row.doc_no, action: "cancel", status: "CANCELLED",
                voucherNo: row.voucher_no, attempt: row.attempts + 1,
                message: "voucher cancelled in Tally", staff: opts.staff });
      return { ok: true, cancelled: true };
    }

    /* MONEY VOUCHERS: a receipt or a payment. Two ledger lines, no stock,
       so none of the stock-item machinery below applies to them. */
    if (MONEY_TYPES[row.doc_type]) {
      const L = ledgerNames();
      const party = mapped("ledger", doc.party ? doc.party.id : "",
                           doc.party ? doc.party.name : "");
      if (party.ignore) {
        mark("CANCELLED", { error: "the party is set to Ignore" });
        return { ok: true, skipped: true, reason: "the party is set to Ignore" };
      }
      if (!party.name) {
        mark("FAILED", { error: "This entry has no party to post against.", countAttempt: true });
        return { ok: false, error: "This entry has no party to post against." };
      }
      const money = moneyLedger(doc, L);
      const isReceipt = spec.voucher === "Receipt";

      const msgs = [];
      if (party.create) {
        /* Which BOOK the other side belongs in comes from the document
           type, not from the direction the money moved. A cash expense and
           a supplier payment are both Payments, and they do not belong in
           the same group. */
        msgs.push(V.ledgerMaster(party.name,
          spec.partyGroup || (isReceipt ? "Sundry Debtors" : "Sundry Creditors"),
          { gstin: doc.party && doc.party.gst,
            billwise: !!spec.partyGroup && /Sundry/.test(spec.partyGroup) }));
      }
      if (money.create) {
        msgs.push(V.ledgerMaster(money.name,
          money.isBank ? "Bank Accounts" : "Cash-in-Hand", { billwise: false }));
      }
      if (msgs.length) {
        const mr = await connector.send(s, connector.importEnvelope(s.company, msgs));
        if (!mr.ok) {
          mark("FAILED", { error: "Setting up ledgers failed: " + mr.error, countAttempt: true });
          return { ok: false, error: "Setting up ledgers failed: " + mr.error };
        }
      }

      const build = {
        syncId: row.sync_id, action: row.voucher_no ? "Alter" : "Create",
        number: row.doc_no || doc.reference_no || String(doc.id).slice(-8),
        date: doc.date, party: party.name, account: money.name,
        amount: Math.abs(Number(doc.amount) || 0),
        narration: [doc.method, doc.reference_no, doc.note].filter(Boolean).join(" · ")
      };
      const xml = connector.voucherEnvelope(s.company,
        [isReceipt ? V.receiptVoucher(build) : V.paymentVoucher(build)]);
      const rr = await connector.send(s, xml);
      if (!rr.ok) {
        mark("FAILED", { error: rr.error, countAttempt: true });
        db.prepare("UPDATE tally_settings SET last_fail_at=?, last_error=? WHERE id=1")
          .run(Date.now(), String(rr.error).slice(0, 400));
        svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                  docNo: row.doc_no, action: "send", status: "FAILED",
                  attempt: row.attempts + 1, message: rr.error, staff: opts.staff });
        return { ok: false, error: rr.error };
      }
      mark("SUCCESS", { voucherNo: build.number, voucherType: spec.voucher, countAttempt: true });
      db.prepare("UPDATE tally_settings SET last_ok_at=?, last_error='' WHERE id=1").run(Date.now());
      svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                docNo: row.doc_no, action: "send", status: "SUCCESS",
                voucherNo: build.number, attempt: row.attempts + 1, staff: opts.staff,
                message: spec.voucher + " posted" });
      return { ok: true, voucherNo: build.number };
    }

    /* A sales return is a Credit Note and moves goods the way a purchase
       does — in, not out — so it takes the purchase side of every sign. A
       purchase return is the mirror again. */
    /* Which SIDE the party sits on: a customer for anything sales-side,
       a supplier for anything purchase-side. That decides whether a new
       ledger is created under Sundry Debtors or Sundry Creditors, and it
       follows the screen the document came from — a sales return is still
       a customer even though the goods came back. */
    const customerSide = row.doc_type === "sales_invoice" || row.doc_type === "sales_return";
    const prep = mastersFor(doc, customerSide);
    if (prep.ignore) {
      mark("CANCELLED", { error: prep.why });
      svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                docNo: row.doc_no, action: "send", status: "SKIPPED",
                message: prep.why, staff: opts.staff });
      return { ok: true, skipped: true, reason: prep.why };
    }
    if (prep.error) {
      mark("FAILED", { error: prep.error, countAttempt: true });
      svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                docNo: row.doc_no, action: "send", status: "FAILED",
                attempt: row.attempts + 1, message: prep.error, staff: opts.staff });
      return { ok: false, error: prep.error };
    }

    /* Masters first, in their own envelope. If this fails the voucher is
       not attempted — a voucher naming a ledger Tally does not have fails
       with a message about the ledger, and the shop is left guessing which
       bill it came from. */
    const mres = await connector.send(s, connector.importEnvelope(s.company, prep.msgs));
    if (!mres.ok) {
      mark("FAILED", { error: "Setting up ledgers/items failed: " + mres.error, countAttempt: true });
      svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                docNo: row.doc_no, action: "send", status: "FAILED",
                attempt: row.attempts + 1, message: mres.error, staff: opts.staff });
      return { ok: false, error: "Setting up ledgers/items failed: " + mres.error };
    }

    /* Alter when a voucher already exists for this document — that is what
       makes an edit an edit. Tally matches on REMOTEID, which is our sync
       id, so the same bill can never own two vouchers. */
    const action = row.voucher_no ? "Alter" : "Create";
    const build = {
      syncId: row.sync_id, action,
      number: doc.challan_no || doc.purchase_no || row.doc_no,
      date: doc.date, party: prep.party, ledgers: prep.ledgers, items: prep.items,
      total: Number(doc.total) || 0,
      tax_type: doc.tax_type, cgst: doc.cgst, sgst: doc.sgst, igst: doc.igst,
      roundOff: doc.round_off,
      narration: "Shop Manager " + (doc.challan_no || doc.purchase_no || ""),
      voucherType: spec.voucher
    };
    /* Which SHAPE the voucher takes is about the direction the goods and
       the money move, not about which screen raised it:

         sales invoice    goods out, party owes more   -> sales shape
         purchase return  goods out, we owe less       -> sales shape
         purchase invoice goods in,  we owe more       -> purchase shape
         sales return     goods in,  party owes less   -> purchase shape

       The VOUCHERTYPENAME still says Credit Note or Debit Note, which is
       what Tally files it under. */
    const salesShape = row.doc_type === "sales_invoice" || row.doc_type === "purchase_return";

    /* THE SHAPE IS NOT THE BOOK.

       The shape above decides the signs and which way the party ledger
       moves. It does NOT decide which nominal ledger the money lands in,
       and treating it as if it did posts a return into the wrong book:
       a customer's return took the purchase shape and so was written to
       Purchase, inflating purchases instead of reducing sales, and a
       supplier return was written to Sales. Both were wrong in the P&L
       and in GSTR-1.

       Which book a document belongs to follows the screen it came from,
       exactly as customerSide already decides Sundry Debtors against
       Sundry Creditors — and mastersFor() has been creating the ledger
       on that same basis all along, so before this the voucher named a
       ledger the masters had not set up.

         sales invoice, sales return       -> Sales
         purchase invoice, purchase return -> Purchase

       Only the key the chosen shape reads is overridden; the signs, the
       party side and both invoice paths are untouched. A shop that wants
       returns in their own "Sales Return"/"Purchase Return" ledgers can
       say so in Names in Tally — this is the sensible default, not a
       decision taken away from them. */
    const nominal = customerSide ? prep.ledgers.sales : prep.ledgers.purchase;
    build.ledgers = { ...prep.ledgers, sales: nominal, purchase: nominal };

    const xml = connector.voucherEnvelope(s.company,
      [salesShape ? V.salesVoucher(build) : V.purchaseVoucher(build)]);

    const r = await connector.send(s, xml);
    if (!r.ok) {
      mark("FAILED", { error: r.error, countAttempt: true });
      db.prepare("UPDATE tally_settings SET last_fail_at=?, last_error=? WHERE id=1")
        .run(Date.now(), String(r.error).slice(0, 400));
      svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
                docNo: row.doc_no, action: action === "Alter" ? "retry" : "send",
                status: "FAILED", attempt: row.attempts + 1, message: r.error,
                staff: opts.staff });
      return { ok: false, error: r.error };
    }

    const voucherNo = build.number;
    mark("SUCCESS", { voucherNo, voucherType: spec.voucher, countAttempt: true });
    db.prepare("UPDATE tally_settings SET last_ok_at=?, last_error='' WHERE id=1")
      .run(Date.now());
    svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
              docNo: row.doc_no, action: "send", status: "SUCCESS",
              voucherNo, attempt: row.attempts + 1, staff: opts.staff,
              message: action === "Alter" ? "voucher updated" : "voucher created" });
    return { ok: true, voucherNo, altered: action === "Alter" };
  } catch (e) {
    mark("FAILED", { error: e.message, countAttempt: true });
    svc.log({ syncId: row.sync_id, docType: row.doc_type, docId: row.doc_id,
              docNo: row.doc_no, action: "send", status: "FAILED",
              attempt: row.attempts + 1, message: e.message, staff: opts.staff });
    return { ok: false, error: e.message };
  }
}

/**
 * Walk the queue.
 *
 * Sequential on purpose. Tally is single-threaded and will reject or
 * mangle work sent in parallel, and a shop's queue is tens of rows, not
 * thousands — so there is nothing to gain and a corrupted company to lose.
 */
async function runQueue(opts) {
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const where = opts.syncIds && opts.syncIds.length
    ? "sync_id IN (" + opts.syncIds.map(() => "?").join(",") + ")"
    : "status IN ('PENDING','RETRY','FAILED')";
  const params = opts.syncIds && opts.syncIds.length ? opts.syncIds : [];

  const rows = db.prepare(
    `SELECT * FROM tally_queue WHERE ${where} ORDER BY queued_at LIMIT ${limit}`
  ).all(...params);

  const out = { attempted: 0, ok: 0, failed: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    out.attempted++;
    const r = await processOne(row, opts);
    if (r.skipped) out.skipped++;
    else if (r.ok) out.ok++;
    else {
      out.failed++;
      if (out.errors.length < 20) out.errors.push({ docNo: row.doc_no, error: r.error });
      /* Tally being off makes every remaining row fail the same way, and
         twenty identical timeouts is four minutes of waiting for nothing. */
      if (/did not answer|Nothing is listening|Could not reach/i.test(r.error || "")) {
        out.stoppedEarly = true;
        break;
      }
    }
  }
  return out;
}

module.exports = { processOne, runQueue, mastersFor, mapped, ledgerNames, LOADERS };
