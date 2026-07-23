const express = require("express");
const db = require("../db");
const { verifyPin } = require("../auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const { pin } = req.body;
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  if (!pin || !verifyPin(String(pin), settings.pin_hash)) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }
  req.session.loggedIn = true;
  res.json({ ok: true, businessName: settings.business_name });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/session", (req, res) => {
  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  res.json({ loggedIn: !!(req.session && req.session.loggedIn), businessName: settings.business_name });
});

module.exports = router;
