/* ============================================================
   CHEQUE PRINTING

   A cheque is pre-printed stationery: the bank's paper already carries the
   boxes, and the shop's printer only overlays the words. So this is not a
   document layout problem like an invoice — it is a COORDINATE problem. Every
   field has a fixed position in millimetres from the top-left of the leaf,
   and the only thing that varies is how a given printer grips the paper.

   That variation is why the offsets exist. Two printers fed the same cheque
   will place the same ink 2-3mm apart, and on a cheque 3mm is the difference
   between the payee line and the box above it. The offsets are stored PER
   BANK ACCOUNT, because a shop's cheque books differ between banks and each
   needs calibrating once against its own stationery.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

/* The CTS-2010 standard leaf every Indian bank issues: 202mm x 92mm. The
   field positions below are measured from the top-left corner of that leaf
   and are the same on every bank's paper — that is the point of the standard.
   A shop only ever adjusts offsetX / offsetY, never these. */
const CTS_2010 = {
  width: 202, height: 92,
  fields: {
    date:       { x: 152, y: 7,  size: 11, spacing: 4.4, boxes: 8 },  // DDMMYYYY
    payee:      { x: 24,  y: 24, size: 11, maxWidth: 120 },
    words1:     { x: 30,  y: 33, size: 10, maxWidth: 150 },
    words2:     { x: 12,  y: 41, size: 10, maxWidth: 168 },
    amount:     { x: 158, y: 40, size: 12 },
    acPayee:    { x: 14,  y: 10, size: 8 }
  }
};

const DEFAULT_CONFIG = { offsetX: 0, offsetY: 0, fontFamily: "monospace", capsPayee: false };

function layoutFor(bankAccountId) {
  const row = bankAccountId
    ? db.prepare("SELECT * FROM cheque_layouts WHERE bank_account_id = ?").get(bindId(bankAccountId))
    : null;
  const fallback = db.prepare("SELECT * FROM cheque_layouts WHERE is_default = 1").get();
  const chosen = row || fallback;
  let config = { ...DEFAULT_CONFIG };
  if (chosen) {
    try { config = { ...config, ...JSON.parse(chosen.config) }; } catch { /* keep defaults */ }
  }
  return { id: chosen ? chosen.id : null, config, template: CTS_2010 };
}

/** The template plus this account's calibration — everything the printer needs. */
router.get("/layout", (req, res) => {
  res.json(layoutFor(req.query.bankAccountId));
});

/**
 * Save a calibration. Offsets are clamped to +/-25mm: beyond that the paper
 * is in the tray wrong, and letting someone save 200mm would put the ink off
 * the leaf entirely with no obvious way back.
 */
router.post("/layout", requireRole("owner"), (req, res) => {
  const { bankAccountId, offsetX, offsetY, fontFamily, capsPayee } = req.body;
  const clamp = v => Math.max(-25, Math.min(25, Number(v) || 0));
  const config = JSON.stringify({
    offsetX: clamp(offsetX), offsetY: clamp(offsetY),
    fontFamily: fontFamily === "serif" ? "serif" : fontFamily === "sans" ? "sans-serif" : "monospace",
    capsPayee: !!capsPayee
  });

  const existing = bankAccountId
    ? db.prepare("SELECT id FROM cheque_layouts WHERE bank_account_id = ?").get(bindId(bankAccountId))
    : db.prepare("SELECT id FROM cheque_layouts WHERE is_default = 1").get();

  if (existing) {
    db.prepare("UPDATE cheque_layouts SET config = ?, updated_at = ? WHERE id = ?")
      .run(config, Date.now(), existing.id);
  } else {
    db.prepare(`INSERT INTO cheque_layouts (id, name, bank_account_id, config, is_default, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uid("CL"), "Cheque calibration", bindId(bankAccountId), config, bankAccountId ? 0 : 1, Date.now());
  }
  logAction(req, "cheque.layout", `offset ${clamp(offsetX)},${clamp(offsetY)}mm`);
  res.json(layoutFor(bankAccountId));
});

/** Cheques written, newest first. */
router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, b.name AS bank_name
    FROM cheques c LEFT JOIN bank_accounts b ON b.id = c.bank_account_id
    ORDER BY c.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

/**
 * Write a cheque. This RECORDS it; it does not move money — a cheque is a
 * promise until the bank clears it, and clearing is what posts to the bank
 * book. Recording it at issue is what makes an unpresented cheque visible.
 */
router.post("/", (req, res) => {
  const { bankAccountId, chequeNo, payeeName, amount, chequeDate, crossing, partyType, partyId, remarks } = req.body;

  const bank = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bindId(bankAccountId));
  if (!bank) return res.status(400).json({ error: "Choose the bank account this cheque is drawn on." });

  const no = String(chequeNo || "").trim();
  if (!no) return res.status(400).json({ error: "Enter the cheque number printed on the leaf." });
  const payee = String(payeeName || "").trim();
  if (!payee) return res.status(400).json({ error: "Enter who the cheque is payable to." });
  const amt = round2(Number(amount) || 0);
  if (!(amt > 0)) return res.status(400).json({ error: "Enter an amount greater than zero." });

  // One leaf, one cheque: the number is unique within its bank account.
  const clash = db.prepare("SELECT id FROM cheques WHERE bank_account_id = ? AND cheque_no = ?")
    .get(bank.id, no);
  if (clash) return res.status(400).json({ error: `Cheque ${no} has already been written on this account.` });

  const id = uid("CHQ");
  db.prepare(`INSERT INTO cheques (id, bank_account_id, cheque_no, payee_name, amount, cheque_date,
                issue_date, crossing, status, party_type, party_id, remarks, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Issued', ?, ?, ?, ?)`)
    .run(id, bank.id, no, payee, amt,
         String(chequeDate || todayStr()).trim() || todayStr(), todayStr(),
         ["account_payee", "bearer", "self"].includes(crossing) ? crossing : "account_payee",
         bindId(partyType), bindId(partyId), String(remarks || "").trim(), Date.now());

  logAction(req, "cheque.issue", `${no} to ${payee} — ${amt}`);
  res.status(201).json(db.prepare("SELECT * FROM cheques WHERE id = ?").get(id));
});

/** Marks a cheque printed, so a re-print is a deliberate act rather than a slip. */
router.post("/:id/printed", (req, res) => {
  const c = db.prepare("SELECT * FROM cheques WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cheque not found." });
  db.prepare("UPDATE cheques SET status = 'Printed' WHERE id = ? AND status = 'Issued'").run(c.id);
  logAction(req, "cheque.print", c.cheque_no);
  res.json(db.prepare("SELECT * FROM cheques WHERE id = ?").get(c.id));
});

module.exports = router;
