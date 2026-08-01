/* ============================================================
   Auto-posts a customer/supplier payment into Cash Book (method Cash) or
   Bank Book (any other method), so the existing "Record Payment" screens
   keep working completely unchanged while Cash Book/Bank Book/Dashboard
   balances stay in sync with them automatically (Bank Entry Module spec).
   ============================================================ */
const db = require("./db");
const { uid } = require("./util");

/** Throws a plain Error with a user-facing message on anything invalid,
 *  same convention as saveAttachment — the calling route turns it into a 400. */
function postPaymentToLedger({ bankAccountId, method, amount, date, partyType, partyId, partyName, txnType, referenceNo, attachment, sourceType, sourceId, direction }) {
  if (method === "Cash") {
    const id = uid("CASH");
    db.prepare(`
      INSERT INTO cash_entries (id, date, type, amount, party, category, remarks, voided, source_type, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)
    `).run(id, date, direction, amount, partyName, txnType, sourceType, sourceId, Date.now());
    return;
  }
  if (!bankAccountId) throw new Error("Choose a bank account for this payment method.");
  const account = db.prepare("SELECT * FROM bank_accounts WHERE id = ? AND active = 1").get(bankAccountId);
  if (!account) throw new Error("Selected bank account not found or inactive.");
  const id = uid("BANK");
  db.prepare(`
    INSERT INTO bank_entries (
      id, date, type, amount, party, category, remarks, voided,
      bank_account_id, txn_type, payment_mode, reference_no, party_type, party_id,
      attachment_path, attachment_name, source_type, source_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, date, direction, amount, partyName, txnType,
    bankAccountId, txnType, method, referenceNo || "", partyType, partyId,
    attachment ? attachment.path : "", attachment ? attachment.name : "", sourceType, sourceId, Date.now()
  );
}

/** Voids whichever ledger row (cash or bank) was auto-created for this
 *  payment/purchase_payment, if any — called whenever the source payment
 *  itself is voided or replaced, so the two can never drift apart. */
function voidLinkedLedgerEntry(sourceType, sourceId) {
  db.prepare("UPDATE cash_entries SET voided = 1 WHERE source_type = ? AND source_id = ? AND voided = 0").run(sourceType, sourceId);
  db.prepare("UPDATE bank_entries SET voided = 1 WHERE source_type = ? AND source_id = ? AND voided = 0").run(sourceType, sourceId);
}

module.exports = { postPaymentToLedger, voidLinkedLedgerEntry };
