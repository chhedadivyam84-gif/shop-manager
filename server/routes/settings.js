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

router.put("/", requireRole("owner"), (req, res) => {
  const { businessName, tagline, address, phones, gstin, state, upiId } = req.body;
  const current = db.prepare("SELECT * FROM settings WHERE id = 1").get();

  db.prepare(`
    UPDATE settings SET business_name=?, tagline=?, address=?, phones=?, gstin=?, state=?, upi_id=? WHERE id=1
  `).run(
    (businessName || current.business_name).trim(), (tagline ?? current.tagline),
    (address ?? current.address), (phones ?? current.phones), (gstin ?? current.gstin),
    (state ?? current.state), (upiId ?? current.upi_id)
  );

  logAction(req, "settings.update", "");
  res.json(publicSettings());
});

/**
 * Numbering: read/set where the Estimate (SP0000001…) and Delivery Challan
 * (DC-2026-####) series currently stand, so an owner switching from paper
 * records can make the NEXT digital number continue on from their last
 * paper one instead of restarting at 1.
 *
 * The stored counter is always "the last number ISSUED", not "the next
 * one" — nextDocNo() in routes/invoices.js reads it and adds 1. Setting a
 * new starting point of N therefore writes N-1 here, so the very next
 * document created is exactly N.
 */
function currentChallanYear() {
  return new Date().getFullYear();
}
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

router.get("/numbering", requireRole("owner"), (req, res) => {
  const estimateLast = readCounter("estimate-no");
  const challanLast = readCounter(`deliverychallan-${currentChallanYear()}`);
  res.json({
    nextEstimateNo: "SP" + String(estimateLast + 1).padStart(7, "0"),
    nextChallanNo: `DC-${currentChallanYear()}-${String(challanLast + 1).padStart(4, "0")}`
  });
});

router.put("/numbering", requireRole("owner"), (req, res) => {
  const { nextEstimateNumber, nextChallanNumber } = req.body;
  const result = {};

  if (nextEstimateNumber !== undefined && nextEstimateNumber !== "") {
    const n = parseInt(nextEstimateNumber, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "Next Estimate No. must be a positive whole number." });
    writeCounter("estimate-no", n - 1);
    result.nextEstimateNo = "SP" + String(n).padStart(7, "0");
  }
  if (nextChallanNumber !== undefined && nextChallanNumber !== "") {
    const n = parseInt(nextChallanNumber, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "Next Challan No. must be a positive whole number." });
    writeCounter(`deliverychallan-${currentChallanYear()}`, n - 1);
    result.nextChallanNo = `DC-${currentChallanYear()}-${String(n).padStart(4, "0")}`;
  }

  logAction(req, "settings.numbering",
    `Next Estimate: ${result.nextEstimateNo || "(unchanged)"}, Next Challan: ${result.nextChallanNo || "(unchanged)"}`);
  res.json(result);
});

module.exports = router;
