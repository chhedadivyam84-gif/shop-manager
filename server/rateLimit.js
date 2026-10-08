/* ============================================================
   RATE LIMITING

   The shop already refuses a sixth wrong PIN for fifteen minutes
   (auth.js). That protects the front door and nothing else: every other
   route would answer as fast as something could ask, which is what lets
   a stolen session be used to pull the whole customer book in a few
   seconds, or a stranger who has found /api/sync/receive post database
   after database at it.

   THE SHAPE: a fixed window per IP per bucket, in memory.

   In memory, deliberately, and for the same reason the login lockout
   already is: this is one small Node process serving one shop. A store
   that survived a restart would be a second database to keep, back up
   and corrupt, and anybody who can restart the process has already won.
   The cost is that a restart forgives everyone, which is the right way
   round for a till that must come back up mid-sale.

   WHAT IT MUST NOT DO is get in the way of the counter. A busy billing
   session is a few requests a second at worst, and the write limit
   below is far above anything a person generates — it is sized to stop
   a script, not to police a shopkeeper. Reads are not limited at all.
   ============================================================ */

/* bucket -> Map(ip -> { count, resetAt }) */
const buckets = new Map();

/* A cap on how many distinct IPs we will remember, so the limiter
   cannot itself become the memory leak that takes the shop down. Past
   it, the oldest window is dropped — the worst case is that one
   attacker's count restarts, which is no worse than not limiting. */
const MAX_TRACKED = 5000;

function windowFor(bucket) {
  let w = buckets.get(bucket);
  if (!w) { w = new Map(); buckets.set(bucket, w); }
  return w;
}

/** Drop everything already expired, plus the oldest if we are over cap. */
function sweep(w, now) {
  for (const [ip, rec] of w) if (rec.resetAt <= now) w.delete(ip);
  if (w.size <= MAX_TRACKED) return;
  const victims = [...w.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, w.size - MAX_TRACKED);
  for (const [ip] of victims) w.delete(ip);
}

/**
 * Count one hit. Returns { ok } or { ok: false, retryAfterSec }.
 *
 * Exported so a route can consult it without being middleware — the
 * sync receiver does, because it has to answer in its own shape.
 */
function hit(bucket, ip, limit, windowMs) {
  const now = Date.now();
  const w = windowFor(bucket);
  if (w.size > 64) sweep(w, now);

  const key = String(ip || "unknown");
  let rec = w.get(key);
  if (!rec || rec.resetAt <= now) {
    rec = { count: 0, resetAt: now + windowMs };
    w.set(key, rec);
  }
  rec.count++;

  if (rec.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

/**
 * Middleware.
 *
 * `methods` defaults to the ones that change something. A read is left
 * alone: the screens this app draws fire several reads at once on every
 * navigation, and throttling those would break the app long before it
 * inconvenienced anybody attacking it.
 */
function limit(opts) {
  const o = opts || {};
  const bucket = o.bucket || "default";
  const max = o.max || 240;
  const windowMs = o.windowMs || 60 * 1000;
  const methods = o.methods || ["POST", "PUT", "PATCH", "DELETE"];
  const message = o.message || "Too many requests. Please slow down and try again shortly.";

  return function (req, res, next) {
    if (methods !== "all" && !methods.includes(req.method)) return next();

    const r = hit(bucket, req.ip, max, windowMs);
    if (r.ok) return next();

    res.setHeader("Retry-After", String(r.retryAfterSec));
    /* 429 and a sentence a person can act on. No counts, no window
       size, no IP — telling an attacker exactly how the limit is shaped
       is free help. */
    return res.status(429).json({ error: message });
  };
}

/** For tests, and for anything that needs a clean slate. */
function reset(bucket) {
  if (bucket) buckets.delete(bucket);
  else buckets.clear();
}

module.exports = { limit, hit, reset, MAX_TRACKED };
