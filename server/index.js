const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Load data/.env if present, before anything reads process.env. Node 20.12+/22
// has this built in, so cloud-backup credentials need no dotenv dependency.
// Guarded: a shop with no .env (the default, fully-local setup) is normal.
try {
  const envPath = path.join(__dirname, "..", "data", ".env");
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
} catch (err) {
  console.warn("Could not load data/.env:", err.message);
}

/* ============================================================
   SHOP TIMEZONE — must be set before anything creates a Date.
   ------------------------------------------------------------
   Every stored `date` column is the shop's calendar date, taken
   from the server's local timezone (see todayStr() in util.js).
   A cloud host runs its containers in UTC, so without this the
   server's "local" time IS UTC: in India (UTC+5:30) every bill,
   cash entry and payment made between midnight and 5:30am gets
   stamped with YESTERDAY's date, and at a month boundary lands
   in the previous GST period. That is not theoretical — it was
   exactly what this deployment was doing.

   Defaults to India because that is who this app is for; set
   the TZ environment variable to override (e.g. TZ=Asia/Dubai)
   without touching code. Set here rather than only as a hosting
   env var so a shop that forgets to configure it is still right.
   ============================================================ */
// Only ASSIGN when defaulting. Re-assigning process.env.TZ to the value it
// already holds still invalidates Node's timezone cache, and on some platforms
// it then re-resolves to the SYSTEM zone instead of the string — which would
// silently ignore an operator's explicit TZ. Leaving it untouched avoids that.
if (!process.env.TZ) process.env.TZ = "Asia/Kolkata";

start().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

/* ============================================================
   ONE BUCKET PER SHOP

   restore.js repopulates an empty disk from the NEWEST shop-*.db in the
   bucket. It has no way to tell whose it is, and it should not need one:
   a bucket is meant to hold one shop's books.

   Two sold copies pointed at the same bucket would therefore overwrite
   each other's backups and, the first time either was redeployed,
   restore the other shop's entire book — customers, bills, outstanding.
   There is no recovering from that quietly, and nothing later in the
   code can make up for it.

   SUPABASE_BUCKET has a default so the shop's own copy needs no
   configuration. On a SOLD copy that default is a trap: whoever sets up
   the second buyer and leaves the variable unset lands both on
   "shop-backups". So a licence-enforced copy must name its bucket.

   This refuses at start-up rather than warning, and start-up on a hosted
   copy is the first deploy — before the shop has entered anything. It is
   the one moment when failing costs nothing and is impossible to miss.
   ============================================================ */
function assertOwnBucket() {
  const sold = require("./license").enabled();
  if (!sold) return;                       // the shop's own copy: unchanged
  const url = (process.env.SUPABASE_URL || "").trim();
  const r2 = (process.env.R2_ACCOUNT_ID || "").trim();
  if (!url && !r2) return;                 // no cloud backup configured at all

  const named = (process.env.SUPABASE_BUCKET || "").trim() || (process.env.R2_BUCKET || "").trim();
  if (named) return;

  console.error("");
  console.error("  Cloud backup is configured but no bucket is named.");
  console.error("");
  console.error("  Set SUPABASE_BUCKET (or R2_BUCKET) to a bucket used by THIS shop");
  console.error("  and no other. Without it this copy would fall back to the shared");
  console.error("  default name, overwrite another shop's backups, and restore their");
  console.error("  books the next time it was redeployed.");
  console.error("");
  console.error("  One bucket per shop. Refusing to start.");
  console.error("");
  process.exit(1);
}

async function start() {
  assertOwnBucket();
  // Must happen before anything requires ./db — on an ephemeral-disk host
  // (Render free tier resets the filesystem on every redeploy) this is what
  // puts shop.db back in place from the last cloud snapshot, before the
  // database module opens (and would otherwise create empty) the file.
  /* A backup somebody uploaded and confirmed. Swapped in HERE, in the same
     pre-open window as the cloud restore below and for the same reason:
     nothing has shop.db or its -wal open yet. See restoreFile.js. */
  const swapped = require("./restoreFile").applyPendingRestore();
  if (swapped.restored) {
    const c = (swapped.info && swapped.info.counts) || {};
    console.log(`[restore] Restored from an uploaded backup — ${c.invoices ?? "?"} invoices, ` +
      `${c.customers ?? "?"} customers, ${c.cash ?? "?"} cash entries.` +
      (swapped.kept ? ` The database it replaced was kept as ${swapped.kept}.` : ""));
  } else if (swapped.failed) {
    console.error(`[restore] An uploaded backup could NOT be swapped in: ${swapped.reason}`);
  }

  const restore = await require("./restore").restoreIfNeeded();
  const release = require("./release");
  release.BOOT.restore = { restored: !!restore.restored, from: restore.file || null };
  if (restore.restored) {
    const many = restore.businesses > 1 ? `, ${restore.businesses} businesses` : "";
    console.log(`[restore] Restored database from cloud backup: ${restore.file} (${restore.size} bytes${many})`);
    // Loud: the app is up but not everything came back with it.
    if (restore.partial) console.error(`[restore] INCOMPLETE — ${restore.partial}`);
  } else {
    console.log(`[restore] Skipped: ${restore.reason}`);
  }

  const express = require("express");
  const session = require("express-session");
  const db = require("./db");
  const backup = require("./backup");
  const { requireAuth, requireRole } = require("./auth");

  /* Keeps the shop's delivery rounds identical on every machine it runs on.
     Insert-only, and limited to this shop by name — see seed-areas.js. */
  try {
    const { added, fixed, routed, moved } = require("./seed-areas").seedCentralLineAreas(db);
    if (added)  console.log(`[areas] added ${added} station delivery areas`);
    if (fixed)  console.log(`[areas] moved ${fixed} area(s) to a corrected round`);
    if (routed) console.log(`[areas] set the round on ${routed} area(s)`);
    if (moved)  console.log(`[areas] reordered ${moved} areas into line order`);
  } catch (err) {
    /* The file is absent by design in a build for sale — one shop's delivery
       rounds are not a buyer's data. That is not a fault, so it is silent;
       anything else is worth seeing, but never worth blocking billing over. */
    if (err.code !== "MODULE_NOT_FOUND") console.error("[areas] seed skipped:", err.message);
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

// Session secret persists across restarts in data/session-secret so logins
// aren't wiped every time the shop PC reboots the app.
// Follows DATA_DIR too: on a mounted disk the secret survives the container,
// so a restart doesn't sign every till in the shop out mid-sale.
const SECRET_PATH = path.join(
  process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data"),
  "session-secret.txt");
/* SESSION_SECRET wins when it is set, so a hosted copy can keep the
   secret in the platform's own secret store rather than on a disk — and
   so two instances of the same shop agree about a cookie. The file stays
   as the fallback, which is what a shop PC with no environment to
   configure actually needs.

   A SET-BUT-TOO-SHORT SECRET IS IGNORED LOUDLY, not fatal. The first
   version of this threw, on the usual fail-closed reasoning — and that
   reasoning does not hold here, because there IS a safe fallback. This
   variable was read by nothing until today, so a hosted copy may well
   have one set to anything at all; refusing to boot would take a live
   shop down to protect it from a value it was already not using, and
   the generated 32-byte file secret it falls back to is strong. So:
   shout where an operator will see it, and keep the till running. */
let sessionSecret = String(process.env.SESSION_SECRET || "").trim();
if (sessionSecret && sessionSecret.length < 32) {
  console.error("[session] SESSION_SECRET is set but shorter than 32 characters, so it is " +
                "being IGNORED. Set a longer one, or remove it and the app will keep its own.");
  sessionSecret = "";
}
if (!sessionSecret) {
  if (fs.existsSync(SECRET_PATH)) {
    sessionSecret = fs.readFileSync(SECRET_PATH, "utf8").trim();
  } else {
    sessionSecret = crypto.randomBytes(32).toString("hex");
    /* 0600: readable by the account running the app and nobody else.
       Windows ignores the mode, which is why this is one layer and not
       the answer — see the note on local data in SECURITY.md. */
    fs.writeFileSync(SECRET_PATH, sessionSecret, { mode: 0o600 });
  }
  try { fs.chmodSync(SECRET_PATH, 0o600); } catch (e) { /* Windows, or a filesystem without modes */ }
}

const isProduction = process.env.NODE_ENV === "production";

/* Behind a hosting proxy, TLS is terminated upstream and requests reach
   us over plain HTTP with X-Forwarded-Proto set — trust it so secure
   cookies work.
 *
 * THE NUMBER IS THE NUMBER OF PROXIES IN FRONT, and getting it wrong is
 * not cosmetic: it decides what req.ip is. Measured, with
 * X-Forwarded-For: "203.0.113.55, 172.16.0.9" —
 *
 *     trust proxy 1  ->  req.ip = 172.16.0.9    (the intermediate hop)
 *     trust proxy 2  ->  req.ip = 203.0.113.55  (the caller)
 *
 * One is right for a single proxy and wrong for this app's hosted chain,
 * which is Cloudflare in front of Render in front of us — two hops. With
 * it set to one, every hosted request looks like it came from the same
 * place, or from a different place each time, and neither is the caller.
 *
 * It stays at one by default because that is what a shop PC and the
 * existing deployment have always used, and raising it blindly would
 * make a FORGED X-Forwarded-For one hop more believable. Set
 * TRUST_PROXY=2 on a Cloudflare-fronted host, where the proxy overwrites
 * the header and the extra hop is real.
 *
 * Nothing security-critical depends on this being right any more — the
 * rate limiter keys on the session and the login lockout keys on the
 * account — but an accurate address still makes both sharper. */
const TRUST_PROXY = (() => {
  const raw = String(process.env.TRUST_PROXY || "").trim();
  if (!raw) return 1;
  if (/^\d+$/.test(raw)) return Number(raw);
  console.error('[proxy] TRUST_PROXY must be a whole number of hops; ignoring "' + raw + '".');
  return 1;
})();
app.set("trust proxy", TRUST_PROXY);

/* Express announces itself in an X-Powered-By header on every response.
   It is not a vulnerability on its own — nobody breaks in through a
   header — but it hands an attacker the framework and therefore the
   advisory list to try, for nothing in return. Off. */
app.disable("x-powered-by");

/* ------------------------------------------------------------
   SECURITY HEADERS

   Four lines that cost nothing and close four different doors. No
   dependency: helmet would add one to set headers this app can state
   itself, and the zero-build-step design is worth more than the
   convenience.

   The Content-Security-Policy below is written to match what this app
   actually does, because a policy written from a template breaks it
   SILENTLY — no error, just a blank square where an icon was. Every
   directive here was checked against the code:

     script-src 'self'   — and nothing else. No 'unsafe-inline', which
       is the whole point: an injected <script> cannot run. That cost
       two edits to earn — the theme/splash block moved out of the head
       into /js/boot.js, and the print window's two buttons are now
       wired with addEventListener instead of onclick attributes. Do
       not reintroduce either; nothing will look broken until somebody
       tries to print.

     style-src 'self' 'unsafe-inline'  — honest about the app as built.
       There are roughly 1,900 style="..." attributes, and the printed
       sheet is assembled as a string with its own <style>. Inline
       styles cannot carry an XSS on their own, so this is the cheap
       half of the trade.

     img-src 'self' data: blob:  — the tile marks are data: URIs in the
       stylesheet, and so are the letterhead logo and every particular's
       branding artwork, because this host wipes its filesystem on every
       deploy and images have to live in the database. blob: is the PDF
       preview and the CSV download.

     frame-src 'self' blob:  — the print canvas is an iframe the app
       builds itself.

     connect-src 'self'  — this app talks to nobody else. Worth stating:
       it means data cannot be posted out to another origin.

     object-src 'none', base-uri 'self', form-action 'self',
     frame-ancestors 'self'  — closing the doors nothing here uses.
   ------------------------------------------------------------ */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");
app.use((req, res, next) => {
  /* Stops a browser second-guessing a Content-Type — the trick that turns
     an uploaded file served as text into a script. */
  res.setHeader("X-Content-Type-Options", "nosniff");
  /* No framing. A shop's books have no business inside somebody else's
     page, and this is what stops a click on an invisible overlay landing
     on a real button in here. */
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  /* A bill's URL can carry its number. Send the origin to other sites and
     nothing more, so a document id never rides out in a Referer header. */
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  /* Everything this app does not need stays switched off, so a script that
     somehow got in cannot ask for it either.

     THE MICROPHONE IS THE ONE EXCEPTION, and only since the assistant
     could be asked out loud. `(self)` is this origin and nothing else — an
     iframe is still refused, which is what `*` would have given away for
     no benefit.

     It was `microphone=()` when the voice feature shipped, which meant the
     browser refused the microphone before any of that code ran. It did not
     show up in testing because the tests replace the recogniser with a
     fake, and a fake needs no permission. Found by asking the browser
     itself: document.featurePolicy.allowsFeature("microphone") was false
     on a page that had just drawn a microphone button. */
  res.setHeader("Permissions-Policy",
    "camera=(), microphone=(self), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", CSP);

  /* HTTPS ONLY, FROM NOW ON — and only in production. TLS is terminated
     upstream (see trust proxy above), so traffic is already encrypted;
     what this adds is the browser REFUSING plain HTTP next time rather
     than making the request and being redirected. Never set in
     development: a shop PC reaching the app at http://192.168.0.149:3000
     would be locked out of its own till by a header it cannot clear. */
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Raised from Express's 100kb default so a payment's base64-encoded receipt
// attachment (up to 8MB decoded, see attachments.js) fits in one JSON request.
app.use(express.json({ limit: "12mb" }));

/* Sessions in a file, not in memory.

   The thirty days below was never the reason staff got thrown back to the
   PIN screen mid-bill. express-session with no `store` uses an IN-MEMORY
   one, and memory does not survive the process — so every restart, every
   deploy, and every spin-down of a hosted instance logged the whole shop
   out at once. Raising the timeout would have changed nothing.

   Its own file, deliberately: a session is not shop data and does not
   belong in the backup that goes to the cloud every fifteen minutes, and on
   a multi-company copy the shop database changes underneath you when the
   company is switched. */
const { SqliteSessionStore } = require("./sessionStore");
const rateLimit = require("./rateLimit");
app.use(session({
  store: new SqliteSessionStore({
    dir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
                              : path.join(__dirname, "..", "data")
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  /* Every request pushes the expiry back, so somebody billing all day is
     never logged out for having been logged in too long. */
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days — shop staff shouldn't have to re-enter the PIN daily
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction
  }
}));

/* A ceiling on how fast anything can CHANGE this shop's records.
 *
 * MOUNTED AFTER THE SESSION MIDDLEWARE, and that position is the
 * whole fix. The limiter keys on the session when there is one, and
 * req.sessionID does not exist until express-session has run — above
 * it, every request would fall back to the address, which behind this
 * app's Cloudflare -> Render chain is the proxy and not the caller.
 *
 * Reads are deliberately untouched: every screen in this app fires
 * several at once on each navigation, and limiting those would break
 * the counter long before it troubled anybody attacking it.
 *
 * 240 writes a minute is roughly four a second sustained — far above a
 * person billing flat out, and far below what makes a stolen session
 * useful for emptying the customer book. It is now PER SESSION, so one
 * person hammering the app can no longer queue the whole counter
 * behind a single shared limit. The login route keeps its own, much
 * stricter lockout (auth.js); this sits underneath as the general
 * case. */
/* IS THIS RELEASE UP, AND WHOLE?

   Public, because a health check that needs a login cannot be used by the
   host, a monitor, or somebody checking a deploy from their phone. And so
   it says nothing a stranger should not read: the commit, how long it has
   been up, whether the database answers, and a backup TIMESTAMP — no
   bucket, no provider, no path, no error text, no variable names. The
   reasoning is in server/release.js.

   503 when the database will not answer, so Render can be pointed at this
   path as its health check and refuse to cut over to a release that came
   up without its data. That last part is a dashboard setting; see
   RELEASING.md. */
app.get("/api/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const r = release.healthReport(() => db.prepare("SELECT 1 AS ok").get());
  res.status(r.status).json(r.body);
});

app.use("/api", rateLimit.limit({ bucket: "api-write", max: 240, windowMs: 60 * 1000 }));

/* ------------------------------------------------------------
   SUBSCRIPTION GATE
   Once a licence has expired the app goes READ-ONLY rather than
   locking the shop out: they can still log in, look up and print
   old invoices, and download a full backup. Only the actions that
   create or change records are refused.

   That's deliberate. Their invoices are records they're legally
   required to keep, and a shop that cannot reach its own books is
   a support call and a refund, not a renewal. Blocking new billing
   is enough to make renewing the obvious choice.

   Reads (GET/HEAD) always pass. So do the few writes needed to get
   BACK to working: logging in, and saving a new licence key.
   ------------------------------------------------------------ */
const license = require("./license");
const checkin = require("./licenseCheckin");
const tenants = require("./tenants");
const { todayStr } = require("./util");
const LICENCE_EXEMPT = [
  "/api/auth",      // must be able to log in to see the renew screen
  "/api/license",   // entering the new key
  "/api/backup",    // taking their data with them
  "/api/sync"       // and the same for sending it to their own cloud copy
];
app.use("/api", (req, res, next) => {
  if (!license.enabled()) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (LICENCE_EXEMPT.some(p => req.originalUrl.startsWith(p))) return next();

  /* A SHOP THAT SIGNED IN WITH A USER ID HAS ALREADY BEEN JUDGED.
     ------------------------------------------------------------
     It was judged at /shop-login, against the panel, by name — and the
     answer is in the tenant map. It has no activation code of its own and
     was never asked for one, because nobody typed a code to get in.

     This gate used to fall through to the activation check anyway, and did
     it from ABOVE the company binder, so settings() read the DEFAULT
     company's row rather than the shop's. Two consequences, and the second
     is the one customers actually saw:

       - every save came back "Enter the activation code from your
         supplier", because that row's activation_code is empty and always
         will be; and
       - typing the code in Settings did not help. That writes into the
         SHOP's row, correctly, but this gate was still reading the default
         company's — so it asked again, and again, and again, and there was
         no code on earth that would have stopped it.

     Their subscription is still enforced, just from the thing that
     actually knows it. The tenant row is read fresh rather than trusting
     the session copy, so a demo converted to paid takes effect without
     making them sign in again. */
  const t = req.session && req.session.tenant;
  if (t && t.username) {
    let row = null;
    try { row = tenants.get(t.username); } catch (e) { /* map unreadable; the session copy stands */ }
    const until = (row && row.expires_on) || t.expiresOn || "";
    if (!until || until >= todayStr()) return next();
    const plan = (row && row.plan) || t.plan;
    return res.status(403).json({
      /* The words the shopkeeper was promised, unchanged. */
      error: plan === "demo"
        ? "Demo License Expired – Please Contact Admin"
        : "This subscription has ended. Please contact your supplier. "
          + "The app is read-only until this is sorted out — you can still view, print and back up your records.",
      licenseExpired: true,
      licenceStatus: "expired"
    });
  }

  // Through resolveKey, so LICENSE_KEY counts here too. This is the gate that
  // actually holds the app read-only: reading the database directly would keep
  // a host that wipes its disk locked out however the key was supplied.
  /* Two ways a copy can be licensed, and it uses whichever it was sold
     under. A copy pointed at a licence server asks that (its answer can
     be withdrawn); an older copy with a signed key on disk asks the key
     (it cannot). Both end at the same read-only gate below, so there is
     one place where the app decides to stop accepting writes. */
  let st;
  if (checkin.enabled()) {
    st = checkin.state();
    if (!st.blocked) return next();
  } else {
    /* Read from the database rather than a cached value: on a host that
       wipes its disk, a stale in-memory copy would keep a shop locked
       out however the key was actually supplied. */
    const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
    st = license.state(license.resolveKey(row && row.license_key));
    if (!st.expired) return next();
  }
  return res.status(403).json({
    error: `${st.message} The app is read-only until this is sorted out — you can still view, print and back up your records.`,
    licenseExpired: true,
    licenceStatus: st.status
  });
});

/* Bind the request to its business BEFORE any route runs — INCLUDING the
   login. This used to sit below the auth mount, so /api/auth/staff-list
   and /api/auth/login always read the DEFAULT company's staff table. On a
   single-shop install that was invisible; the moment one installation
   serves several shops it means everybody lands in the first shop's books
   and signs in with the first shop's staff list.

   The id comes from the SESSION, never from the request — anything the
   browser can send, the browser can forge, and forging this would open
   another business's books. */
app.use("/api", (req, res, next) => {
  /* A shop that signed in as a tenant is PINNED to its own company here,
     ahead of anything else. businesses.js already refuses to switch a
     tenant elsewhere; this is the second lock on the same door, so that a
     bug in the first one is a bug and not a data breach. On an
     installation serving a hundred shops the cost of being wrong once is
     one shopkeeper reading another's books. */
  const tenant = req.session && req.session.tenant;
  const id = (tenant && tenant.companyId)
    || (req.session && req.session.businessId)
    || db.companies.defaultId();
  db.companies.runAs(id, next);
});

app.use("/api/auth", require("./routes/auth"));

/* DATA & SYNC. Mounted here, without requireAuth, on purpose: /receive is
   the other copy of this app talking rather than a person, and carries a
   sync key instead of a session. Every route a person presses inside it
   is owner-only on its own, so nothing is loosened by the mount.

   Above fyLock and the feature gate deliberately — a sync replaces the
   whole database rather than writing a dated record, so "is this year
   closed" is not a question that applies to it. */
/* The ONE route in this app that a stranger can reach without a session,
   and the one that accepts an entire database. The sync key is 32 random
   bytes compared in constant time, so guessing it is not a strategy —
   but nothing stopped somebody posting at it all day, and each attempt
   costs a scrypt hash and up to 12MB of body. Ten an hour per address is
   far above what a real shop's push needs (it pushes when somebody
   presses the button) and far below what makes this worth attacking. */
app.use("/api/sync", rateLimit.limit({
  bucket: "sync", max: 10, windowMs: 60 * 60 * 1000,
  /* THE CEILING THAT ACTUALLY APPLIES HERE.
     This is the one route a stranger reaches without signing in, so the
     per-caller limit above falls back to the address — which behind a
     proxy the app cannot resolve is not a caller at all. The global
     ceiling does not care: thirty requests an hour to this endpoint from
     anyone, full stop. A real shop pushes when somebody presses the
     button, perhaps a few times a day, so thirty is generous for the
     legitimate case and ends the "no refusal after fourteen tries" that
     was measured against production. */
  globalMax: 30,
  /* EVERY method, not just the writing ones. The general limiter below
     leaves reads alone because the app's own screens fire several per
     navigation — but nothing here is one of those screens. /peek is a
     GET that answers a stranger holding the key with the shop's name
     and its record counts, so leaving it unlimited would have left the
     one unauthenticated read in the app the only unthrottled thing in
     it. A test caught exactly that. */
  methods: "all",
  message: "Too many sync attempts. Try again later."
}), require("./routes/sync"));

/* A closed financial year stops accepting writes. Mounted after /api/auth so
   signing in is never blocked, and before every data route so a bill, payment
   or entry cannot be back-dated into a year already filed. Reads are
   untouched — a closed year stays fully visible, printable and exportable. */
app.use("/api", require("./fyLock").guard);

/* ============================================================
   DELETE IS THE OWNER'S ALONE

   Mounted here rather than added to each route on purpose. Thirteen of
   the eighteen delete routes already checked the role and four did not —
   an e-way bill number could be wiped off an invoice by anyone signed in —
   and the reason is simply that a guard written eighteen times gets
   written seventeen times. A route added next month inherits this one
   without anybody remembering to.

   It sits ahead of every data route and behind /api/auth, so signing in
   still works and nothing that touches the books is reachable without
   passing through it.

   This is the API-level half of the rule. The screens hide their delete
   controls too, but that is a courtesy to the user, not the enforcement:
   a hidden button is still a request anyone can send by hand.
   ============================================================ */
app.use("/api", (req, res, next) => {
  if (req.method !== "DELETE") return next();
  /* An owner previewing as a staff member is refused too. A preview that
     quietly kept the delete button would show the owner a screen no staff
     member will ever see, which is the one thing it exists to prevent.
     Leaving the preview is one tap and restores it. */
  const inPreview = req.session && req.session.role === "owner" && req.session.previewStaffId;
  if (req.session && req.session.loggedIn && req.session.role === "owner" && !inPreview) return next();

  if (inPreview) {
    return res.status(403).json({
      error: "You are viewing the app as a staff member. Stop the preview to delete anything."
    });
  }
  return res.status(403).json({
    error: "Only the shop owner can delete records. Ask the owner, or cancel the document instead."
  });
});
/* What this shop was sold. Mounted here, above every business route and
   below the company binder, so one line covers the whole app rather than
   forty routes each remembering to check. Reads are never refused. */
app.use("/api", require("./featureGate").gate());

/* WHO IS MOVING THE STOCK.
   ------------------------------------------------------------------
   inventory.addStock writes a ledger row for every change, but it only
   knows the size, the place and the amount — not the person. Rather than
   pass a staff name down through thirty-two call sites, the name is put
   into a per-request context here, once, and read at the bottom.

   AsyncLocalStorage rather than a module-level variable: two requests
   overlapping at an await would otherwise write each other's names into
   each other's history, and that is exactly the kind of wrong a stock
   audit must never be. Routes add what they know — the document type and
   its number — on top of this. */
app.use("/api", (req, res, next) => {
  require("./stockLedger").withContext({
    staff: (req.session && req.session.staffName) || ""
  }, next);
});

app.use("/api/license", requireAuth, require("./routes/license"));


app.use("/api/businesses", requireAuth, require("./routes/businesses"));
app.use("/api/settings", requireAuth, require("./routes/settings"));
app.use("/api/products", requireAuth, require("./routes/products"));
app.use("/api/customers", requireAuth, require("./routes/customers"));
app.use("/api/suppliers", requireAuth, require("./routes/suppliers"));
app.use("/api/invoices", requireAuth, require("./routes/invoices"));
app.use("/api/reports", requireAuth, require("./routes/reports"));
app.use("/api/accounting", requireAuth, require("./routes/accounting"));
app.use("/api/ewaybill", requireAuth, require("./routes/ewaybill"));
app.use("/api/ewb", requireAuth, require("./routes/ewb"));
app.use("/api/data-health", requireAuth, require("./routes/dataHealth"));
app.use("/api/gst", requireAuth, require("./routes/gst"));
app.use("/api/product-query", requireAuth, require("./routes/productQuery"));
app.use("/api/export", requireAuth, require("./routes/export"));
app.use("/api/areas", requireAuth, require("./routes/areas"));
app.use("/api/dispatch", requireAuth, require("./routes/dispatch"));
app.use("/api/delivery", requireAuth, require("./routes/delivery"));
app.use("/api/alerts", requireAuth, require("./routes/alerts"));
app.use("/api/reminders", requireAuth, require("./routes/reminders"));
app.use("/api/notes", requireAuth, require("./routes/notes"));
/* The assistant. requireAuth like everything else, and behind the feature
   gate above — it costs the shop money per question, so it is something
   the vendor sells rather than something that is simply on. Every lookup
   it can do is re-checked against this person's own permissions inside
   server/assistant/tools.js; the model decides nothing. */
/* EVERY QUESTION COSTS THE SHOP MONEY.

   The general /api limiter is 240 writes a minute, which is right for a
   till being hammered by a busy counter and wrong for the one route that
   spends on a paid API per press. Left at 240, a stuck key or a bored
   staff member is a bill, and a shop that hits its provider quota loses
   the feature for everybody for the rest of the day.

   20 a minute is far above anyone asking real questions and far below
   anything that costs real money. Keyed per session by the limiter, so
   one person cannot spend another shop's quota. */
app.use("/api/assistant", requireAuth, rateLimit.limit({
  bucket: "assistant", max: 20, windowMs: 60 * 1000,
  message: "That is a lot of questions at once. Give it a minute.",
}), require("./routes/assistant"));
app.use("/api/categories", requireAuth, require("./routes/categories"));
app.use("/api/cashbook", requireAuth, require("./routes/cashbook"));

/* Staff pay: employees, attendance, kharchi, salary. Behind requireAuth
   like everything else, and gated per action inside the router by the
   employee module, which is granted to nobody until the owner grants it. */
/* OWNER ONLY, at the mount rather than inside.

   What people are paid, what they took during the week and what they
   still owe is the owner's business alone in this shop. Gating it here
   means no route inside can be reached by anybody else even if one of
   them is later written without its own check — a hidden menu item is
   not a lock, and a permission somebody could be granted by accident is
   not one either. The employee module stays in the permissions list so
   the screen can still be refused per action, but it can never widen
   past this line. */
app.use("/api/employees", requireAuth, requireRole("owner"), require("./routes/employees"));
app.use("/api/bankbook", requireAuth, require("./routes/bankbook"));
app.use("/api/bank-accounts", requireAuth, require("./routes/bankAccounts"));
app.use("/api/cheques", requireAuth, require("./routes/cheques"));
app.use("/api/inquiries", requireAuth, require("./routes/inquiries"));
app.use("/api/purchases", requireAuth, require("./routes/purchases"));
app.use("/api/purchase-orders", requireAuth, require("./routes/purchaseOrders"));
app.use("/api/selection-slips", requireAuth, require("./routes/selectionSlips"));
app.use("/api/whatsapp", requireAuth, require("./routes/whatsapp"));
/* Tally sync. Owner-only inside the router, and one-way by construction —
   nothing under it reads a value out of Tally into Shop Manager.

   ON THIS SHOP'S OWN COPY ONLY. Tally sync was built for the vendor's own
   shop and was never part of what is sold, and hiding the menu is not
   scoping — a hidden button leaves the routes answering to anyone who types
   the address. So the routes are not MOUNTED on a copy
   that was sold, and the timer is not started. A stamped public key is what
   makes a build a customer's; ours leaves it empty so its licence can never
   lock the shop out, which makes it the one honest test of whose copy this
   is, and it holds whether that copy is hosted or run from a folder. */
if (!require("./license").enabled()) {
  /* The bridge FIRST, and without requireAuth: it is a program on a shop's
     counter PC carrying its own token, not a person with a session. Ahead
     of /api/tally so the session gate below never sees it. */
  app.use("/api/tally-bridge", require("./routes/tallyBridge"));
  app.use("/api/tally", requireAuth, require("./routes/tally"));
  /* The auto-sync timer, started once the tables exist. Wrapped because a
     sync timer must never be able to stop the shop from billing — if this
     throws, the app still serves. */
  try { require("./tally/autosync").reschedule(); }
  catch (e) { console.log("[tally] auto-sync not started: " + e.message); }
}
app.use("/api/gst-filings", requireAuth, require("./routes/gstFilings"));
app.use("/api/price-lists", requireAuth, require("./routes/priceLists"));
app.use("/api/quotations", requireAuth, require("./routes/quotations"));
app.use("/api/sales-orders", requireAuth, require("./routes/salesOrders"));
app.use("/api/sales-returns", requireAuth, require("./routes/salesReturns"));
app.use("/api/purchase-returns", requireAuth, require("./routes/purchaseReturns"));
app.use("/api/stock-ins", requireAuth, require("./routes/stockIns"));
app.use("/api/locations", requireAuth, require("./routes/locations"));
app.use("/api/transfers", requireAuth, require("./routes/transfers"));
app.use("/api/stock-history", requireAuth, require("./routes/stockHistory"));
app.use("/api/position", requireAuth, require("./routes/position"));
app.use("/api/material-flow", requireAuth, require("./routes/materialFlow"));
/* Reading a photo of a bill into a draft purchase. requireAuth only: the
   status check has to answer for any staff member so the purchase screen
   knows whether to draw the button, and setting the key is owner-gated
   inside the router. Writes nothing — see server/billScan.js. */
app.use("/api/bill-scan", requireAuth, require("./routes/billScan"));
/* requireAuth only, not requireRole: /permissions/me is how a staff member's
   own screen learns what to show them, and it is the one thing here a
   non-owner can read. Everything else inside is behind requireRole. */
app.use("/api/permissions", requireAuth, require("./routes/permissions"));
app.use("/api/staff", requireAuth, requireRole("owner"), require("./routes/staff"));
app.use("/api/audit", requireAuth, requireRole("owner"), require("./routes/audit"));
app.use("/api/backup", requireAuth, requireRole("owner"), require("./routes/backup"));
app.use("/api/print", requireAuth, require("./routes/print"));
app.use("/api/print-manager", requireAuth, require("./routes/printManager"));
app.use("/api/numbering", requireAuth, require("./routes/numbering"));
app.use("/api/attachments", requireAuth, require("./routes/attachments"));
app.use("/api/reset", requireAuth, requireRole("owner"), require("./routes/reset"));
app.use("/api/financial-years", requireAuth, requireRole("owner"), require("./routes/financialYears"));
/* Historical import and the opening count. Both are owner-only inside their
   own routers as well as here — the module reads a shop's whole past off a
   spreadsheet, which is not a counter job. */
app.use("/api/imports", requireAuth, require("./routes/imports"));
app.use("/api/opening-stock", requireAuth, require("./routes/openingStock"));

// Belt-and-braces cache busting on top of the no-cache header below: every
// script/stylesheet URL in index.html gets a ?v=<boot time> query string,
// changed on every server restart (i.e. every deploy). A browser that
// ignores Cache-Control entirely and just heuristically caches by URL still
// can't serve a stale file after a deploy, since the URL itself is new —
// this is what actually fixed reports of phones showing a redesign from
// weeks earlier despite the no-cache header already being deployed.
const BOOT_VERSION = Date.now();
const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");
let versionedIndexHtml = null;
function getVersionedIndexHtml() {
  if (!versionedIndexHtml) {
    const html = fs.readFileSync(INDEX_PATH, "utf8");
    versionedIndexHtml = html.replace(
      /(src|href)="(\/(?:js|css)\/[^"]+)"/g,
      (match, attr, url) => `${attr}="${url}?v=${BOOT_VERSION}"`
    );
  }
  return versionedIndexHtml;
}
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(getVersionedIndexHtml());
});



// Cache-Control: no-cache (not no-store) forces a revalidation round-trip on
// EVERY load rather than trusting a locally-cached copy for a while — some
// mobile browsers apply their own heuristic freshness lifetime to static
// files even without an explicit max-age, silently serving a stale app.js/
// style.css after a deploy until that heuristic expires. The revalidation
// itself is cheap (a 304 with no body when the file hasn't changed, via the
// ETag express.static already sets), so this doesn't add real cost. The
// ?v= query string above is the primary defence; this is a second layer for
// any request that somehow reaches these files without going through /.
app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res, filePath) => {
    if (/\.(js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  }
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

/* Not awaited and not blocking: a licence server that is slow to wake
   must never hold up a shop opening its own app. Whatever was cached at
   the last successful check-in applies until it answers. */
checkin.start();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shop Manager running on port ${PORT}`);
  if (!isProduction) {
    console.log(`Open http://localhost:${PORT}`);
    console.log("On other phones/tablets on the same WiFi, use this PC's local IP address instead of localhost.");
  }
  // Automatic rotating snapshots (+ cloud if configured). Started after the
  // server is up so a backup can never delay accepting requests.
  const plan = release.startupPlan(restore);
  backup.startSchedule({ skipStartup: !plan.startupSnapshot });

  /* DID THE DEPLOY THAT STARTED US LOSE ANYTHING?

     Only asked after a cloud restore. A backup newer than the one we
     restored can only be the old container's final save — work this
     container does not have. Said loudly, and held for /api/health, but
     NOT acted on: staff may already be working here, and swapping the
     database under them is a decision for a person. See release.js. */
  if (plan.checkGapAfterMs) {
    setTimeout(async () => {
      try {
        const listing = await backup.listCloud();
        const names = ((listing && listing.runs) || []).flatMap(r => r.files || []);
        const newer = release.newerThanRestored(restore.file, names);
        release.BOOT.gap = newer;
        release.BOOT.gapChecked = true;
        if (newer) {
          console.error(
            `[release] A BACKUP NEWER THAN THE ONE THIS RELEASE RESTORED EXISTS: ${newer}. ` +
            `It was almost certainly saved by the container this deploy replaced, after this ` +
            `one had already restored — so anything entered in that window is in the cloud ` +
            `but NOT in the running shop. Check it with: node tools/verify-backup.js --cloud ` +
            `--stamp ${newer}. Nothing has been restored automatically.`);
        } else {
          console.log("[release] deploy check: no backup newer than the one restored — nothing was lost in the handover");
        }
      } catch (e) {
        release.BOOT.gapChecked = false;
        console.error("[release] deploy check could not list the cloud:", e.message);
      }
    }, plan.checkGapAfterMs).unref?.();
  }
});

// On an ephemeral-disk host (Render), a code deploy kills THIS process and
// boots a brand new container with an empty disk — restore.js then repopulates
// it from whatever the last cloud backup happened to be. Without this hook,
// anything the shop entered live after that last backup and before the deploy
// is silently gone forever the moment the old container is torn down. Render
// sends SIGTERM (with a short grace period) before the hard kill, so taking
// one last snapshot right here closes that gap for the one event that
// actually destroys the disk — routine restarts/spin-downs don't reach this
// (the process just stops, disk survives), only a genuine redeploy does.
let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] SIGTERM received — taking a final backup before exit...");
  const done = () => process.exit(0);
  // Don't let a stalled cloud upload hold up the exit past Render's own grace
  // period — the local VACUUM INTO snapshot (the part that matters most,
  // since restore.js prefers cloud but local-first design assumes it can
  // stand alone) has already landed synchronously inside runBackup by then.
  const forceTimer = setTimeout(done, 8000).unref?.();
  require("./backup").runBackup("pre-shutdown")
    .then(r => console.log(`[shutdown] backup complete: ${r.file} (${r.size} bytes)${r.cloud.ok ? " + cloud" : ""}`))
    .catch(err => console.error("[shutdown] backup FAILED:", err.message))
    .finally(() => { clearTimeout(forceTimer); done(); });
});
}
