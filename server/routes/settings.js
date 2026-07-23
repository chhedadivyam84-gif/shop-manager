const express = require("express");
const db = require("../db");
const { hashPin } = require("../auth");

const router = express.Router();

function publicSettings() {
  const s = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  const { pin_hash, ...rest } = s;
  return rest;
}

router.get("/", (req, res) => {
  res.json(publicSettings());
});

router.put("/", (req, res) => {
  const { businessName, tagline, address, phones, gstin, state, upiId, newPin } = req.body;
  const current = db.prepare("SELECT * FROM settings WHERE id = 1").get();

  let pinHash = current.pin_hash;
  if (newPin) {
    if (!/^\d{4,6}$/.test(String(newPin))) {
      return res.status(400).json({ error: "PIN must be 4-6 digits." });
    }
    pinHash = hashPin(String(newPin));
  }

  db.prepare(`
    UPDATE settings SET business_name=?, tagline=?, address=?, phones=?, gstin=?, state=?, upi_id=?, pin_hash=? WHERE id=1
  `).run(
    (businessName || current.business_name).trim(), (tagline ?? current.tagline),
    (address ?? current.address), (phones ?? current.phones), (gstin ?? current.gstin),
    (state ?? current.state), (upiId ?? current.upi_id), pinHash
  );

  res.json(publicSettings());
});

module.exports = router;
