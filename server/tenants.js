/**
 * WHICH SHOP IS SIGNING IN.
 *
 * One installation can serve many shops — a hundred demos on one address —
 * and each shop's books are their own SQLite file. This is the map from the
 * login a shopkeeper types to the file that gets opened.
 *
 * IT LIVES OUTSIDE EVERY COMPANY, in the root data directory, because it is
 * the thing that decides which company you are in. Keeping it inside one
 * would mean a shop had to be chosen before the app could work out which
 * shop to choose.
 *
 * WHY IT IS CACHED HERE AND NOT ASKED EVERY TIME
 *
 * The vendor's panel is the authority on who exists and until when. But a
 * shop must be able to open its own books when the panel is asleep, or the
 * line is down, or the vendor's host is having a bad night — that rule runs
 * through this whole system and it does not stop at the login page. So the
 * panel's answer is kept here after the first successful sign-in, and every
 * sign-in after that is decided locally. The check-in that already runs
 * every six hours is what notices a cancellation.
 *
 * The consequence, stated plainly: a shop cancelled in the panel can still
 * sign in until the next check-in lands. That is the same window the rest
 * of the licensing already has, and the alternative — no login without the
 * internet — is worse for every honest shop in order to inconvenience one
 * dishonest one for six hours.
 *
 * PASSWORDS ARE NEVER STORED IN THE CLEAR. What arrives from the panel is
 * already a hash, and it is kept as one.
 */
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { DATA_DIR } = require("./db-schema");

let tdb = null;
function open() {
  if (tdb) return tdb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  tdb = new DatabaseSync(path.join(DATA_DIR, "tenants.db"));
  tdb.exec("PRAGMA journal_mode = WAL");
  tdb.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      username      TEXT PRIMARY KEY,      -- lower-cased; a mobile or an email
      company_id    TEXT NOT NULL,
      shop_name     TEXT DEFAULT '',
      code          TEXT DEFAULT '',       -- their activation code
      plan          TEXT DEFAULT 'paid',   -- demo | paid
      expires_on    TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER,
      -- Set when the vendor cancels. The row stays: who had which books is
      -- not a question a deleted row can answer.
      blocked       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_company ON tenants(company_id);
  `);
  return tdb;
}

const norm = u => String(u || "").trim().toLowerCase();

/* The same scheme the panel uses, so a hash made there verifies here.
   Joined with ":" and by concatenation, never a template literal — a "$"
   inside one is one careless edit from being eaten by the interpolation it
   resembles, and a hash that never matches looks exactly like a shopkeeper
   typing their password wrong. */
const SEP = ":";
function hash(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "scrypt" + SEP + salt + SEP + crypto.scryptSync(String(plain), salt, 32).toString("hex");
}
function verify(plain, stored) {
  const parts = String(stored || "").split(SEP);
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const want = Buffer.from(parts[2], "hex");
  const got = crypto.scryptSync(String(plain), parts[1], want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function get(username) {
  return open().prepare("SELECT * FROM tenants WHERE username = ?").get(norm(username)) || null;
}

function count() {
  return open().prepare("SELECT COUNT(*) n FROM tenants").get().n;
}

function list() {
  return open().prepare("SELECT username, company_id, shop_name, plan, expires_on, blocked, last_seen_at FROM tenants ORDER BY shop_name").all();
}

/** Remember a shop, or update what we know about it. */
function upsert({ username, companyId, shopName, code, plan, expiresOn, password, passwordHash }) {
  const u = norm(username);
  const existing = get(u);
  const ph = passwordHash || (password ? hash(password) : (existing && existing.password_hash));
  if (!ph) throw new Error("A shop cannot be remembered without a password.");
  open().prepare(`
    INSERT INTO tenants (username, company_id, shop_name, code, plan, expires_on, password_hash, created_at, last_seen_at, blocked)
    VALUES (?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT(username) DO UPDATE SET
      company_id = excluded.company_id,
      shop_name  = excluded.shop_name,
      code       = excluded.code,
      plan       = excluded.plan,
      expires_on = excluded.expires_on,
      password_hash = excluded.password_hash,
      blocked    = 0
  `).run(u, companyId, shopName || "", code || "", plan || "paid", expiresOn || "", ph, Date.now(), Date.now());
  return get(u);
}

function touch(username) {
  open().prepare("UPDATE tenants SET last_seen_at = ? WHERE username = ?").run(Date.now(), norm(username));
}

function block(username, blocked) {
  open().prepare("UPDATE tenants SET blocked = ? WHERE username = ?").run(blocked ? 1 : 0, norm(username));
}

/**
 * Is this installation serving more than one shop?
 *
 * A desktop buyer with one shop must never be shown a shop sign-in screen
 * — they have one shop, they know which one it is, and a page between them
 * and their till is one they resent every morning.
 *
 * SAID BY THE HOST, NOT INFERRED FROM WHETHER ANYBODY HAS SIGNED IN YET.
 * This used to be `count() > 0`, which is a trap: the sign-in screen only
 * appeared once a shop had signed in, and a shop could only sign in
 * through that screen. The very first customer on a new installation was
 * shown the staff picker of an empty shop and had no way to reach their
 * own. Every test passed, because they all called the API directly and
 * never went through the page.
 *
 * So the vendor sets MULTI_TENANT on the shared installation and says so
 * outright. The count is still honoured underneath, so an installation
 * that already has tenants keeps working whether or not anyone remembers
 * the variable.
 */
const DECLARED = /^(1|true|yes|on)$/i.test(String(process.env.MULTI_TENANT || "").trim());
function multiTenant() {
  return DECLARED || count() > 0;
}

/** Whether the shop sign-in is even reachable — used to offer a way back
 *  to it from the staff picker, so nobody can be stranded on the wrong
 *  shop's screen. */
function declared() { return DECLARED; }

/** Where the file is, so the backup can include it. */
function file() {
  return path.join(DATA_DIR, "tenants.db");
}

/** A consistent copy, written the way every other part of a backup is.
 *  VACUUM INTO rather than a file copy: this database has a write-ahead
 *  log beside it, and copying the main file alone yields something that
 *  opens and is missing the last few sign-ins. */
function snapshotTo(destPath) {
  try { fs.unlinkSync(destPath); } catch (e) { /* not there, the normal case */ }
  open().exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  return destPath;
}

/** Put one back, from a restored backup. */
function restoreFrom(srcPath) {
  if (!fs.existsSync(srcPath)) return false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(srcPath, file());
  tdb = null;                     // reopened against the file just written
  return true;
}

module.exports = { open, get, list, count, upsert, touch, block, verify, hash, multiTenant, norm,
  file, snapshotTo, restoreFrom, declared };
