const crypto = require("crypto");
const db = require("./db");

function uid(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

// Records who did what for accountability once multiple staff share the app.
// `req` may be omitted (e.g. during first-run seeding) — logs as System then.
function logAction(req, action, details) {
  const staffId = req && req.session ? req.session.staffId : null;
  const staffName = req && req.session ? req.session.staffName : "System";
  const role = req && req.session ? req.session.role : "system";
  db.prepare(`
    INSERT INTO audit_log (at, staff_id, staff_name, role, action, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now(), staffId || null, staffName || "System", role || "system", action, details || "");
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { uid, todayStr, round2, logAction };
