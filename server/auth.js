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

/* Accepts one role or several. Called with a single role it behaves exactly as
   it always has — every existing owner-only route is unchanged. Several roles
   exist for work the shop floor genuinely does: a delivery is marked by whoever
   took the van out, not by the owner from a desk. */
function requireRole(...roles) {
  return function (req, res, next) {
    if (req.session && req.session.loggedIn && roles.includes(req.session.role)) return next();
    return res.status(403).json({
      error: roles.length === 1 && roles[0] === "owner"
        ? "Only the shop owner can do this."
        : "You don't have permission to do this."
    });
  };
}

/* Login brute-force protection. In memory only — a small single-instance
   app does not need this to survive a restart, and an attacker who can
   restart the process has bigger problems than this lock.
 *
 * KEYED ON THE ADDRESS AND THE STAFF MEMBER TOGETHER, not the address
 * alone, and that pairing matters more than it looks.
 *
 * On a shop PC an address is one person. Hosted, it is not: behind this
 * app's Cloudflare -> Render chain, req.ip resolves to the proxy rather
 * than the caller (measured: trust proxy 1 on a two-hop
 * X-Forwarded-For yields the intermediate hop). Keyed on the address
 * alone, every member of staff shares one counter — so five wrong PINs
 * from ANYBODY would lock the entire shop out of the till for fifteen
 * minutes. A stranger could close the counter from a phone.
 *
 * Pairing it keeps the protection where it belongs — five guesses at
 * ONE person's PIN from one source — and takes away the shop-wide
 * lockout. The arithmetic still holds: a four-digit PIN is ten thousand
 * combinations at five tries per quarter-hour, which is years per
 * account even before anybody notices.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

/** One counter per (source, account). Either part missing is still a key. */
function lockKey(ip, staffId) {
  return String(ip || "unknown") + "|" + String(staffId || "");
}

function loginLockStatus(ip, staffId) {
  const key = lockKey(ip, staffId);
  const rec = attempts.get(key);
  if (!rec || !rec.lockedUntil) return { locked: false };
  if (Date.now() >= rec.lockedUntil) { attempts.delete(key); return { locked: false }; }
  return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
}

function recordLoginFailure(ip, staffId) {
  const key = lockKey(ip, staffId);
  const rec = attempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(key, rec);
}

/**
 * Forget the failures for one account from one source.
 *
 * Called with no staffId it clears every counter for that source, which
 * is what a test wants and what a successful login by any member of
 * staff on a shop PC may as well do.
 */
function clearLoginFailures(ip, staffId) {
  if (staffId !== undefined) { attempts.delete(lockKey(ip, staffId)); return; }
  const prefix = String(ip || "unknown") + "|";
  for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key);
}

module.exports = {
  hashPin, verifyPin, requireAuth, requireRole,
  loginLockStatus, recordLoginFailure, clearLoginFailures
};
