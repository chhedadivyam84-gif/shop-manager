/* ============================================================
   SUBSCRIPTION LICENCE
   ------------------------------------------------------------
   A licence key is  <base64url(payload)>.<base64url(signature)>
   where payload is JSON { shop, expires, issued } and the
   signature is Ed25519 over the payload bytes, made with a
   private key that only the vendor holds. The public key below
   can only VERIFY, never mint — so shipping it is safe, and a
   buyer cannot forge a later expiry date without it.

   What this does and does not buy you: it stops the ordinary
   case (a shopkeeper whose year is up) and gives a clean renew
   prompt. It cannot stop someone who edits this source, since
   the app ships as readable JavaScript. That is a deliberate
   trade — an online activation server would be stronger, but
   would also take the shop offline whenever the vendor's server
   or the shop's internet is down.

   ENFORCEMENT IS OPT-IN: with PUBLIC_KEY left empty the whole
   mechanism is dormant and the app behaves exactly as an
   unlicensed build always did. Set the key to switch it on.
   ============================================================ */
const crypto = require("crypto");

// Vendor's Ed25519 public key. Empty string = licensing disabled.
//
// Deliberately EMPTY in this repo, so the shop's own copy (this PC and the
// Render deployment) can never lock itself out — a Render redeploy has been
// seen to roll the database back, and if that wiped the stored licence key
// an enforced build would drop live billing into read-only mid-trading.
//
// To build a copy FOR SALE, paste the public key from
// tools/vendor-public-key.pem between the backticks below. That single
// change switches enforcement on for that build only.
const PUBLIC_KEY = ``;

// Shown as a warning banner this many days before the expiry date.
const WARN_WITHIN_DAYS = 14;

/* How many businesses a licence allows.
 *
 * `null` means unlimited. A key that predates multi-business carries no
 * `companies` field at all, so it resolves to ONE — an existing buyer keeps
 * exactly what they paid for and nothing changes under them. An unlicensed
 * build (the shop's own copy, PUBLIC_KEY empty) is unlimited: enforcement is
 * dormant there by design, and a shop must never be blocked from its own
 * books by a mechanism meant for buyers. */
const DEFAULT_COMPANY_LIMIT = 1;

function limitFrom(data) {
  const n = data && data.companies;
  if (n === "unlimited" || n === 0) return null;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_COMPANY_LIMIT;
}

function enabled() {
  return PUBLIC_KEY.trim().length > 0;
}

/* Where the key is read from.
 *
 * It normally lives in settings.license_key, inside the database. On a host
 * that hands the app a fresh disk on every restart — a spun-down Render
 * instance, a new container — that file is gone and the key with it, and the
 * shop is asked to paste it again. An environment variable survives that,
 * because the host supplies it at boot rather than the disk.
 *
 * LICENSE_KEY therefore WINS over the stored key: on such a host the stored
 * copy is the unreliable one. Set it and the shop never re-enters a key. */
function resolveKey(storedKey) {
  const fromEnv = (process.env.LICENSE_KEY || "").trim();
  return fromEnv || String(storedKey || "").trim();
}

/** True when the key is coming from the environment, so the UI can say so
 *  rather than showing a paste box that would have no effect. */
function keyIsFromEnv() {
  return (process.env.LICENSE_KEY || "").trim().length > 0;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a key's signature and shape. Returns the payload on success,
 * or null for anything malformed, tampered with, or signed by someone
 * else — callers must treat null as "not licensed".
 */
function parse(key) {
  if (!key || typeof key !== "string" || !key.includes(".")) return null;
  const [payloadPart, sigPart] = key.trim().split(".");
  if (!payloadPart || !sigPart) return null;
  try {
    const payloadBuf = b64urlToBuf(payloadPart);
    const ok = crypto.verify(null, payloadBuf, PUBLIC_KEY, b64urlToBuf(sigPart));
    if (!ok) return null;
    const data = JSON.parse(payloadBuf.toString("utf8"));
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data.expires || "")) return null;
    return data;
  } catch {
    return null;
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO + "T00:00:00Z"), b = Date.parse(toISO + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

/**
 * Current licence state, safe to expose to the browser (it carries no
 * secret — the key itself is already on the buyer's own machine).
 */
function state(key) {
  if (!enabled()) {
    return { enforced: false, status: "unlicensed-build", expired: false, companyLimit: null };
  }
  const data = parse(key);
  if (!data) {
    return {
      enforced: true, status: key ? "invalid" : "missing", expired: true,
      companyLimit: DEFAULT_COMPANY_LIMIT,
      message: key
        ? "This licence key isn't valid for this app."
        : "No licence key entered yet."
    };
  }
  const today = todayStr();
  const daysLeft = daysBetween(today, data.expires);
  const expired = daysLeft < 0;
  return {
    enforced: true,
    status: expired ? "expired" : (daysLeft <= WARN_WITHIN_DAYS ? "expiring" : "active"),
    expired,
    daysLeft,
    expiresOn: data.expires,
    licensedTo: data.shop || "",
    companyLimit: limitFrom(data),
    message: expired
      ? `Subscription expired on ${data.expires}.`
      : `Subscription active until ${data.expires} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left).`
  };
}

module.exports = {
  enabled, parse, state, resolveKey, keyIsFromEnv,
  WARN_WITHIN_DAYS, DEFAULT_COMPANY_LIMIT
};
