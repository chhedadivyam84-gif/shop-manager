const express = require("express");
const db = require("../db");
const { logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

function publicSettings() {
  const s = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  const { pin_hash, ...rest } = s;
  return rest;
}

router.get("/", (req, res) => {
  res.json(publicSettings());
});

// Printed-document themes. Validated against this list rather than stored as
// free text: an unrecognised value would reach the print CSS as a class that
// matches nothing, silently printing an unstyled document.
const PRINT_THEMES = ["classic", "tally", "navy", "minimal"];
const cleanTheme = (v, fallback) => (PRINT_THEMES.includes(v) ? v : fallback);

router.put("/", requireRole("owner"), (req, res) => {
  const { businessName, tagline, address, phones, gstin, state, upiId, email, website,
          invoiceTheme, challanTheme, allowNegativeStock } = req.body;
  const current = db.prepare("SELECT * FROM settings WHERE id = 1").get();

  db.prepare(`
    UPDATE settings SET business_name=?, tagline=?, address=?, phones=?, gstin=?, state=?, upi_id=?, email=?, website=?,
      invoice_theme=?, challan_theme=?, allow_negative_stock=? WHERE id=1
  `).run(
    (businessName || current.business_name).trim(), (tagline ?? current.tagline),
    (address ?? current.address), (phones ?? current.phones), (gstin ?? current.gstin),
    (state ?? current.state), (upiId ?? current.upi_id),
    (email ?? current.email), (website ?? current.website),
    invoiceTheme === undefined ? (current.invoice_theme || "classic") : cleanTheme(invoiceTheme, current.invoice_theme || "classic"),
    challanTheme === undefined ? (current.challan_theme || "classic") : cleanTheme(challanTheme, current.challan_theme || "classic"),
    allowNegativeStock === undefined ? current.allow_negative_stock : (allowNegativeStock ? 1 : 0)
  );

  logAction(req, "settings.update", "");
  res.json(publicSettings());
});

/**
 * Numbering: read/set where the Estimate and Delivery Challan series
 * currently stand, so an owner switching from paper records can make the
 * NEXT digital number continue on from their last paper one instead of
 * restarting at 1. Both series print as "SP" + 7 digits (SP0000001…) on
 * their OWN independent counters — the same literal number can come up on
 * both an Estimate and a Challan at once; the document banner (ESTIMATE
 * CHALLAN vs DELIVERY CHALLAN) is what tells them apart, not the number.
 *
 * The stored counter is always "the last number ISSUED", not "the next
 * one" — nextDocNo() in routes/invoices.js reads it and adds 1. Setting a
 * new starting point of N therefore writes N-1 here, so the very next
 * document created is exactly N.
 */
function readCounter(name) {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(name);
  return row ? row.value : 0;
}
function writeCounter(name, value) {
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(name, value);
}
function formatDocNo(n) {
  return "SP" + String(n).padStart(7, "0");
}

router.get("/numbering", requireRole("owner"), (req, res) => {
  res.json({
    nextEstimateNo: formatDocNo(readCounter("estimate-no") + 1),
    nextChallanNo: formatDocNo(readCounter("challan-no") + 1)
  });
});

router.put("/numbering", requireRole("owner"), (req, res) => {
  const { nextEstimateNumber, nextChallanNumber } = req.body;
  const result = {};

  if (nextEstimateNumber !== undefined && nextEstimateNumber !== "") {
    const n = parseInt(nextEstimateNumber, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "Next Estimate No. must be a positive whole number." });
    writeCounter("estimate-no", n - 1);
    result.nextEstimateNo = formatDocNo(n);
  }
  if (nextChallanNumber !== undefined && nextChallanNumber !== "") {
    const n = parseInt(nextChallanNumber, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "Next Challan No. must be a positive whole number." });
    writeCounter("challan-no", n - 1);
    result.nextChallanNo = formatDocNo(n);
  }

  logAction(req, "settings.numbering",
    `Next Estimate: ${result.nextEstimateNo || "(unchanged)"}, Next Challan: ${result.nextChallanNo || "(unchanged)"}`);
  res.json(result);
});

module.exports = router;
