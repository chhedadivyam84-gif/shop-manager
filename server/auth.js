const crypto = require("crypto");

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(pin), salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: "Not logged in" });
}

function requireRole(role) {
  return function (req, res, next) {
    if (req.session && req.session.loggedIn && req.session.role === role) return next();
    return res.status(403).json({ error: "Only the shop owner can do this." });
  };
}

// Login brute-force protection. Keyed by IP, kept in memory only — a small
// local/single-instance app doesn't need this to survive a restart, and an
// attacker who can restart the process has bigger problems than this lock.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function loginLockStatus(ip) {
  const rec = attempts.get(ip);
  if (!rec || !rec.lockedUntil) return { locked: false };
  if (Date.now() >= rec.lockedUntil) { attempts.delete(ip); return { locked: false }; }
  return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
}

function recordLoginFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

function clearLoginFailures(ip) {
  attempts.delete(ip);
}

module.exports = {
  hashPin, verifyPin, requireAuth, requireRole,
  loginLockStatus, recordLoginFailure, clearLoginFailures
};
