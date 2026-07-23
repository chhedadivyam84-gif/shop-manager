const express = require("express");
const db = require("../db");
const { verifyPin, loginLockStatus, recordLoginFailure, clearLoginFailures } = require("../auth");
const { logAction } = require("../util");

const router = express.Router();

// Names only, no PIN hashes — lets the login screen show "who are you"
// before asking for a PIN, without requiring a session yet.
router.get("/staff-list", (req, res) => {
  const staff = db.prepare("SELECT id, name, role FROM staff WHERE active = 1 ORDER BY role DESC, name ASC").all();
  res.json(staff);
});

router.post("/login", (req, res) => {
  const ip = req.ip;
  const lock = loginLockStatus(ip);
  if (lock.locked) {
    return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).` });
  }

  const { staffId, pin } = req.body;
  const staff = staffId && db.prepare("SELECT * FROM staff WHERE id = ? AND active = 1").get(staffId);
  if (!staff || !pin || !verifyPin(String(pin), staff.pin_hash)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  clearLoginFailures(ip);
  req.session.loggedIn = true;
  req.session.staffId = staff.id;
  req.session.staffName = staff.name;
  req.session.role = staff.role;

  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  logAction(req, "login", "");
  res.json({ ok: true, businessName: settings.business_name, staffName: staff.name, role: staff.role });
});

router.post("/logout", (req, res) => {
  logAction(req, "logout", "");
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/session", (req, res) => {
  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  const loggedIn = !!(req.session && req.session.loggedIn);
  res.json({
    loggedIn, businessName: settings.business_name,
    staffName: loggedIn ? req.session.staffName : null,
    role: loggedIn ? req.session.role : null
  });
});

module.exports = router;
