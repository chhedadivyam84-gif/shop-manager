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

/* ------------------------------------------------------------------
   WHAT A "CALLER" IS, and why it is not simply the IP address

   The first version keyed on req.ip alone. Behind this app's actual
   deployment — Cloudflare in front of Render in front of the app —
   `trust proxy` is 1, and Express then reports the INTERMEDIATE PROXY
   rather than the client. Measured, not assumed: with
   X-Forwarded-For: "203.0.113.55, 172.16.0.9", trust proxy 1 yields
   172.16.0.9 and trust proxy 2 yields 203.0.113.55.

   That single mistake fails in two opposite directions and both are
   bad:

     If the proxy address varies between requests, every request looks
     like a new caller and the limit never applies to anybody. This is
     what was actually observed in production — thirteen hits on the
     sync endpoint, no refusal.

     If it is stable, every caller shares ONE bucket. The whole shop
     then queues behind a single limit, and one person hammering the
     app locks out the counter.

   So the key is the SESSION where there is one. A session id is issued
   by this app, is unforgeable (signed), and identifies the actual
   caller no matter how many proxies the request crossed. Only
   unauthenticated traffic — a login, a sync push — falls back to the
   address, and the global backstop below bounds that case even when
   the address is useless.
   ------------------------------------------------------------------ */
function callerKey(req) {
  /* ONLY an established, signed-in session. express-session hands out a
     fresh req.sessionID to every request that arrives without a cookie,
     so keying on its mere presence would give an anonymous flood a new
     identity per request and limit nobody — which a test caught doing
     exactly that on the sync endpoint.
     Signed in is the condition that makes the id mean a person: it
     cannot be reached without a cookie the app itself issued. */
  if (req && req.sessionID && req.session && req.session.loggedIn) {
    return "s:" + req.sessionID;
  }
  /* Everything before a login — the login itself, a sync push — falls
     back to the address, with the global backstop below as the floor
     under a proxy that makes addresses meaningless. */
  return "i:" + String((req && req.ip) || "unknown");
}

/* bucket -> Map(key -> { count, resetAt }) */
const buckets = new Map();

/* A per-bucket total, independent of who is asking.
   The per-caller limit above is only as good as its key, and for
   unauthenticated traffic behind a proxy the key may be worthless. This
   is the floor under that: however many distinct callers a flood
   appears to come from, a bucket still has a ceiling. Sized well above
   any real shop so it is a backstop and not a second limit. */
const globals = new Map();

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
function hit(bucket, who, limit, windowMs, globalMax) {
  const now = Date.now();
  const w = windowFor(bucket);
  if (w.size > 64) sweep(w, now);

  const key = String(who || "unknown");
  let rec = w.get(key);
  if (!rec || rec.resetAt <= now) {
    rec = { count: 0, resetAt: now + windowMs };
    w.set(key, rec);
  }
  rec.count++;

  /* The backstop, counted whether or not the per-caller limit trips. */
  let g = globals.get(bucket);
  if (!g || g.resetAt <= now) { g = { count: 0, resetAt: now + windowMs }; globals.set(bucket, g); }
  g.count++;

  const retryAfterSec = at => Math.max(1, Math.ceil((at - now) / 1000));

  if (rec.count > limit) {
    return { ok: false, scope: "caller", retryAfterSec: retryAfterSec(rec.resetAt) };
  }
  if (globalMax && g.count > globalMax) {
    return { ok: false, scope: "global", retryAfterSec: retryAfterSec(g.resetAt) };
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

  /* Well above any real shop, so it only ever catches a flood. */
  const globalMax = o.globalMax || max * 20;

  return function (req, res, next) {
    if (methods !== "all" && !methods.includes(req.method)) return next();

    const r = hit(bucket, callerKey(req), max, windowMs, globalMax);
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
  if (bucket) { buckets.delete(bucket); globals.delete(bucket); }
  else { buckets.clear(); globals.clear(); }
}

module.exports = { limit, hit, reset, callerKey, MAX_TRACKED };
