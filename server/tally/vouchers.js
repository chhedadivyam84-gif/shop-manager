/* ============================================================
   SHOP MANAGER DOCUMENTS AS TALLY VOUCHERS

   Tally's XML voucher format has been stable for twenty years and is
   documented by Tally themselves, so unlike a GSP's proprietary API this
   can be written directly. It still wants checking against a real Tally
   before a shop trusts it with a year of books — see the note at the foot.

   THE SIGN CONVENTION, because everything here depends on it and it is
   the thing that is easy to get backwards:

     ISDEEMEDPOSITIVE = Yes   this entry is a DEBIT
     AMOUNT negative          debit
     AMOUNT positive          credit

   So a sale debits the party and credits Sales; a purchase does the
   opposite. Getting this wrong does not produce an error — Tally accepts
   it and the shop's books are quietly inverted, which is far worse than a
   rejection. Each voucher below states its own double entry in a comment
   so the arithmetic can be checked by reading.

   ONE DIRECTION ONLY. Everything here turns Shop Manager data into XML.
   Nothing reads Tally.
   ============================================================ */
const { esc, tallyDate } = require("./connector");

/** Two decimals, no symbol, no grouping — Tally parses the number. */
function amt(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }

/** Tally wants a unit on quantities: "20 Nos". */
function qty(v, unit) {
  const n = Math.round((Number(v) || 0) * 1000) / 1000;
  return n + " " + (String(unit || "Nos").trim() || "Nos");
}

/**
 * One ledger line.
 *
 * @param debit  true for a debit, which is both ISDEEMEDPOSITIVE=Yes and a
 *               negative AMOUNT. They are not two facts; Tally wants the
 *               same fact stated twice, and disagreeing between them is
 *               how a voucher ends up posted the wrong way round.
 */
/* WHICH TAG, AND WHY IT IS NOT A DETAIL.

   An invoice-view voucher — one carrying stock — must state its ledger
   lines as LEDGERENTRIES.LIST. Given ALLLEDGERENTRIES.LIST, TallyPrime
   does not complain about the tag: it silently DROPS every one of those
   lines, then rejects the voucher for not balancing. Measured against
   build 27913, a sale of 118 came back "Dr: (blank) Cr: 100.00 Diff:
   100.00" — the party and both tax lines simply gone, leaving only the
   stock line Tally had read from ALLINVENTORYENTRIES.LIST.

   An accounting-view voucher — a receipt or a payment, no stock — takes
   ALLLEDGERENTRIES.LIST and is happy with it, which is why that stays
   the default here rather than being changed everywhere.

   Ordering makes no difference either way; only the tag does. */
const INVOICE_ENTRY = "LEDGERENTRIES.LIST";

function ledgerLine(name, value, debit, tag) {
  const T = tag || "ALLLEDGERENTRIES.LIST";
  const v = Number(value) || 0;
  return "<" + T + ">" +
    "<LEDGERNAME>" + esc(name) + "</LEDGERNAME>" +
    "<ISDEEMEDPOSITIVE>" + (debit ? "Yes" : "No") + "</ISDEEMEDPOSITIVE>" +
    "<AMOUNT>" + amt(debit ? -Math.abs(v) : Math.abs(v)) + "</AMOUNT>" +
    "</" + T + ">";
}

/** One stock line, with the sales/purchase ledger it posts against. */
function inventoryLine(it, postingLedger, isSale) {
  const value = Number(it.amount) || 0;
  return "<ALLINVENTORYENTRIES.LIST>" +
    "<STOCKITEMNAME>" + esc(it.tallyItem) + "</STOCKITEMNAME>" +
    "<ISDEEMEDPOSITIVE>" + (isSale ? "No" : "Yes") + "</ISDEEMEDPOSITIVE>" +
    "<RATE>" + amt(it.rate) + "/" + esc(it.unit || "Nos") + "</RATE>" +
    "<AMOUNT>" + amt(isSale ? value : -value) + "</AMOUNT>" +
    "<ACTUALQTY>" + esc(qty(it.qty, it.unit)) + "</ACTUALQTY>" +
    "<BILLEDQTY>" + esc(qty(it.qty, it.unit)) + "</BILLEDQTY>" +
    "<ACCOUNTINGALLOCATIONS.LIST>" +
      "<LEDGERNAME>" + esc(postingLedger) + "</LEDGERNAME>" +
      "<ISDEEMEDPOSITIVE>" + (isSale ? "No" : "Yes") + "</ISDEEMEDPOSITIVE>" +
      "<AMOUNT>" + amt(isSale ? value : -value) + "</AMOUNT>" +
    "</ACCOUNTINGALLOCATIONS.LIST>" +
    "</ALLINVENTORYENTRIES.LIST>";
}

/**
 * The tax lines for one document.
 *
 * Rates are never assumed. Whatever the saved document carries is what
 * goes — a bill raised at 12% must reach Tally at 12%, however the shop
 * has since changed its defaults, because the paper in the customer's file
 * says 12%.
 */
function taxLines(doc, names, tag) {
  const out = [];
  const isIGST = String(doc.tax_type || "").toUpperCase() === "IGST";
  if (isIGST) {
    if (Number(doc.igst)) out.push(ledgerLine(names.igst, doc.igst, false, tag));
  } else {
    if (Number(doc.cgst)) out.push(ledgerLine(names.cgst, doc.cgst, false, tag));
    if (Number(doc.sgst)) out.push(ledgerLine(names.sgst, doc.sgst, false, tag));
  }
  return out;
}

/**
 * @param o.action  "Create" first time, "Alter" when a synced document was
 *                  edited. Alter is what stops an edit writing a second
 *                  voucher — Tally matches on REMOTEID, which is our own
 *                  sync id, so the same document can only ever own one.
 */
function voucherOpen(o) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<VOUCHER VCHTYPE="' + esc(o.type) + '" ACTION="' + (o.action || "Create") + '" ' +
      'OBJVIEW="' + esc(o.view || "Accounting Voucher View") + '">' +
    /* OUR id, carried into Tally. This is what makes an edit an edit and
       not a duplicate, and what lets a voucher be traced back to the bill
       it came from months later. */
    "<REMOTEID>" + esc(o.syncId) + "</REMOTEID>" +
    "<VOUCHERTYPENAME>" + esc(o.type) + "</VOUCHERTYPENAME>" +
    "<DATE>" + tallyDate(o.date) + "</DATE>" +
    "<EFFECTIVEDATE>" + tallyDate(o.date) + "</EFFECTIVEDATE>" +
    "<VOUCHERNUMBER>" + esc(o.number) + "</VOUCHERNUMBER>" +
    "<REFERENCE>" + esc(o.number) + "</REFERENCE>" +
    "<REFERENCEDATE>" + tallyDate(o.date) + "</REFERENCEDATE>" +
    (o.party ? "<PARTYLEDGERNAME>" + esc(o.party) + "</PARTYLEDGERNAME>" +
               "<PARTYNAME>" + esc(o.party) + "</PARTYNAME>" : "") +
    (o.narration ? "<NARRATION>" + esc(o.narration) + "</NARRATION>" : "") +
    "<PERSISTEDVIEW>" + esc(o.view || "Accounting Voucher View") + "</PERSISTEDVIEW>";
}
const voucherClose = "</VOUCHER></TALLYMESSAGE>";

/* ------------------------------------------------------------------ */
/* the four vouchers                                                   */
/* ------------------------------------------------------------------ */

/**
 * SALES.  Party Dr, Sales Cr, tax Cr.
 *
 * @param d.items  [{ tallyItem, qty, unit, rate, amount }]
 */
function salesVoucher(d) {
  const lines = [
    ledgerLine(d.party, d.total, true, INVOICE_ENTRY)        // party debited
  ].concat(
    d.items.map(it => inventoryLine(it, d.ledgers.sales, true)),
    taxLines(d, d.ledgers, INVOICE_ENTRY),
    Number(d.roundOff)
      ? [ledgerLine(d.ledgers.roundOff, d.roundOff, Number(d.roundOff) < 0, INVOICE_ENTRY)]
      : []
  );
  return voucherOpen({ ...d, type: d.voucherType || "Sales",
                       view: "Invoice Voucher View" }) + lines.join("") + voucherClose;
}

/** PURCHASE.  Purchase Dr, tax Dr, Party Cr. The mirror of a sale. */
function purchaseVoucher(d) {
  const lines = [
    ledgerLine(d.party, d.total, false, INVOICE_ENTRY)       // party credited
  ].concat(
    d.items.map(it => inventoryLine(it, d.ledgers.purchase, false)),
    /* Tax on a purchase is INPUT tax and is debited — the shop is owed it
       back, not liable for it. Same rates, opposite side. */
    taxLines(d, d.ledgers, INVOICE_ENTRY).map(l => l.replace("<ISDEEMEDPOSITIVE>No", "<ISDEEMEDPOSITIVE>Yes")
                                     .replace(/<AMOUNT>([\d.]+)<\/AMOUNT>/, "<AMOUNT>-$1</AMOUNT>"))
  );
  return voucherOpen({ ...d, type: d.voucherType || "Purchase",
                       view: "Invoice Voucher View" }) + lines.join("") + voucherClose;
}

/** RECEIPT.  Money in: Bank/Cash Dr, Party Cr. */
function receiptVoucher(d) {
  const lines = [
    ledgerLine(d.account, d.amount, true),
    ledgerLine(d.party, d.amount, false)
  ];
  return voucherOpen({ ...d, type: "Receipt", number: d.number,
                       party: d.party }) + lines.join("") + voucherClose;
}

/** PAYMENT.  Money out: Party Dr, Bank/Cash Cr. */
function paymentVoucher(d) {
  const lines = [
    ledgerLine(d.party, d.amount, true),
    ledgerLine(d.account, d.amount, false)
  ];
  return voucherOpen({ ...d, type: "Payment", number: d.number,
                       party: d.party }) + lines.join("") + voucherClose;
}

/* ------------------------------------------------------------------ */
/* masters                                                             */
/* ------------------------------------------------------------------ */

/**
 * A ledger, created only when it is not already there.
 *
 * Tally matches on NAME, so re-sending an existing ledger alters it rather
 * than duplicating it — which is why this is safe to send before every
 * voucher, and why the mapping table exists to make sure the NAME is the
 * one the shop already uses in Tally rather than a near-miss spelling.
 */
function ledgerMaster(name, parent, opts) {
  const o = opts || {};
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<LEDGER NAME="' + esc(name) + '" ACTION="Create">' +
    "<NAME>" + esc(name) + "</NAME>" +
    "<PARENT>" + esc(parent) + "</PARENT>" +
    (o.gstin ? "<PARTYGSTIN>" + esc(o.gstin) + "</PARTYGSTIN>" : "") +
    (o.address ? "<ADDRESS.LIST><ADDRESS>" + esc(o.address) + "</ADDRESS></ADDRESS.LIST>" : "") +
    (o.state ? "<LEDSTATENAME>" + esc(o.state) + "</LEDSTATENAME>" : "") +
    "<ISBILLWISEON>" + (o.billwise === false ? "No" : "Yes") + "</ISBILLWISEON>" +
    "</LEDGER></TALLYMESSAGE>";
}

/** A stock item. Same matching rule as a ledger: name is the key. */
function stockItemMaster(name, group, unit) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<STOCKITEM NAME="' + esc(name) + '" ACTION="Create">' +
    "<NAME>" + esc(name) + "</NAME>" +
    /* AN EMPTY PARENT, NOT "Primary".

       "Primary" is the root every Tally tutorial names, and TallyPrime
       rejects it outright for stock: "Stock Group 'Primary' does not
       exist!" — measured against build 27913, where it failed all six
       document types at the master stage before a voucher was even
       attempted. Left empty, Tally files the item at the root itself,
       which is what naming Primary was trying to say.

       A real group name still passes straight through, so a shop that
       maps its categories keeps them. */
    "<PARENT>" + esc(group || "") + "</PARENT>" +
    "<BASEUNITS>" + esc(unit || "Nos") + "</BASEUNITS>" +
    "</STOCKITEM></TALLYMESSAGE>";
}

/** A simple unit. Tally refuses a stock item whose unit does not exist. */
function unitMaster(symbol) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<UNIT NAME="' + esc(symbol) + '" ACTION="Create">' +
    "<NAME>" + esc(symbol) + "</NAME>" +
    "<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>" +
    "</UNIT></TALLYMESSAGE>";
}

/** A stock group, for Category and Brand. */
function stockGroupMaster(name, parent) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<STOCKGROUP NAME="' + esc(name) + '" ACTION="Create">' +
    "<NAME>" + esc(name) + "</NAME>" +
    /* Empty rather than "Primary", for the same reason as the stock
       item above — Tally has no stock group by that name. */
    "<PARENT>" + esc(parent || "") + "</PARENT>" +
    "</STOCKGROUP></TALLYMESSAGE>";
}

/* ------------------------------------------------------------------ */

/**
 * CANCELLING.
 *
 * A voided bill does NOT delete its Tally voucher. Deleting would leave a
 * gap in a numbered book that an auditor will ask about, and Shop
 * Manager's own rule is that nothing is ever destroyed — a document is
 * cancelled and kept. Tally has the same idea, so the voucher is marked
 * cancelled in place and stays where it is.
 */
function cancelVoucher(d) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<VOUCHER VCHTYPE="' + esc(d.type) + '" ACTION="Alter" ' +
      'OBJVIEW="Accounting Voucher View">' +
    "<REMOTEID>" + esc(d.syncId) + "</REMOTEID>" +
    "<VOUCHERTYPENAME>" + esc(d.type) + "</VOUCHERTYPENAME>" +
    "<VOUCHERNUMBER>" + esc(d.number) + "</VOUCHERNUMBER>" +
    "<DATE>" + tallyDate(d.date) + "</DATE>" +
    "<ISCANCELLED>Yes</ISCANCELLED>" +
    "</VOUCHER></TALLYMESSAGE>";
}

/* ------------------------------------------------------------------
   A NOTE BEFORE A SHOP TRUSTS THIS WITH A YEAR OF BOOKS.

   The format above is Tally's published one, but Tally is old software
   with version differences, and a company configured for one thing will
   reject XML written for another. Post a handful of vouchers into a COPY
   of the company first and look at them in Tally: the party balance, the
   stock quantity, the tax ledgers and which side each amount landed on.

   That check takes ten minutes and is the difference between a sync and a
   year of quietly inverted entries.
   ------------------------------------------------------------------ */

module.exports = {
  amt, qty, ledgerLine, inventoryLine, taxLines,
  salesVoucher, purchaseVoucher, receiptVoucher, paymentVoucher,
  ledgerMaster, stockItemMaster, unitMaster, stockGroupMaster,
  cancelVoucher
};
