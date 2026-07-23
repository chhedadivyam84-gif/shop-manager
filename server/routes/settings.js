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

module.exports = router;
