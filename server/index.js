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

async function start() {
  // Must happen before anything requires ./db — on an ephemeral-disk host
  // (Render free tier resets the filesystem on every redeploy) this is what
  // puts shop.db back in place from the last cloud snapshot, before the
  // database module opens (and would otherwise create empty) the file.
  const restore = await require("./restore").restoreIfNeeded();
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
    const { added, moved } = require("./seed-areas").seedCentralLineAreas(db);
    if (added) console.log(`[areas] added ${added} station delivery areas`);
    if (moved) console.log(`[areas] reordered ${moved} areas into line order`);
  } catch (err) {
    // Never block start-up over a convenience: billing matters more.
    console.error("[areas] seed skipped:", err.message);
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
let sessionSecret;
if (fs.existsSync(SECRET_PATH)) {
  sessionSecret = fs.readFileSync(SECRET_PATH, "utf8").trim();
} else {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_PATH, sessionSecret);
}

const isProduction = process.env.NODE_ENV === "production";

// Behind Fly.io's proxy, TLS is terminated upstream and requests reach us
// over plain HTTP with X-Forwarded-Proto set — trust it so secure cookies work.
app.set("trust proxy", 1);

// Raised from Express's 100kb default so a payment's base64-encoded receipt
// attachment (up to 8MB decoded, see attachments.js) fits in one JSON request.
app.use(express.json({ limit: "12mb" }));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days — shop staff shouldn't have to re-enter the PIN daily
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction
  }
}));

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
const LICENCE_EXEMPT = [
  "/api/auth",      // must be able to log in to see the renew screen
  "/api/license",   // entering the new key
  "/api/backup"     // taking their data with them
];
app.use("/api", (req, res, next) => {
  if (!license.enabled()) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (LICENCE_EXEMPT.some(p => req.originalUrl.startsWith(p))) return next();

  // Through resolveKey, so LICENSE_KEY counts here too. This is the gate that
  // actually holds the app read-only: reading the database directly would keep
  // a host that wipes its disk locked out however the key was supplied.
  const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
  const st = license.state(license.resolveKey(row && row.license_key));
  if (!st.expired) return next();
  return res.status(403).json({
    error: `${st.message} The app is read-only until it's renewed — you can still view, print and back up your records.`,
    licenseExpired: true
  });
});

app.use("/api/auth", require("./routes/auth"));

/* A closed financial year stops accepting writes. Mounted after /api/auth so
   signing in is never blocked, and before every data route so a bill, payment
   or entry cannot be back-dated into a year already filed. Reads are
   untouched — a closed year stays fully visible, printable and exportable. */
app.use("/api", require("./fyLock").guard);
app.use("/api/license", requireAuth, require("./routes/license"));
/* Bind the request to its business BEFORE any route runs, so every
   db.prepare() inside a handler already speaks to the right database. The id
   comes from the SESSION, never from the request — anything the browser can
   send, the browser can forge, and forging this would open another
   business's books. */
app.use("/api", (req, res, next) => {
  const id = (req.session && req.session.businessId) || db.companies.defaultId();
  db.companies.runAs(id, next);
});

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
app.use("/api/categories", requireAuth, require("./routes/categories"));
app.use("/api/cashbook", requireAuth, require("./routes/cashbook"));
app.use("/api/bankbook", requireAuth, require("./routes/bankbook"));
app.use("/api/bank-accounts", requireAuth, require("./routes/bankAccounts"));
app.use("/api/cheques", requireAuth, require("./routes/cheques"));
app.use("/api/inquiries", requireAuth, require("./routes/inquiries"));
app.use("/api/purchases", requireAuth, require("./routes/purchases"));
app.use("/api/purchase-orders", requireAuth, require("./routes/purchaseOrders"));
app.use("/api/quotations", requireAuth, require("./routes/quotations"));
app.use("/api/sales-orders", requireAuth, require("./routes/salesOrders"));
app.use("/api/sales-returns", requireAuth, require("./routes/salesReturns"));
app.use("/api/purchase-returns", requireAuth, require("./routes/purchaseReturns"));
app.use("/api/stock-ins", requireAuth, require("./routes/stockIns"));
app.use("/api/locations", requireAuth, require("./routes/locations"));
app.use("/api/transfers", requireAuth, require("./routes/transfers"));
app.use("/api/staff", requireAuth, requireRole("owner"), require("./routes/staff"));
app.use("/api/audit", requireAuth, requireRole("owner"), require("./routes/audit"));
app.use("/api/backup", requireAuth, requireRole("owner"), require("./routes/backup"));
app.use("/api/print", requireAuth, require("./routes/print"));
app.use("/api/print-manager", requireAuth, require("./routes/printManager"));
app.use("/api/numbering", requireAuth, require("./routes/numbering"));
app.use("/api/attachments", requireAuth, require("./routes/attachments"));
app.use("/api/reset", requireAuth, requireRole("owner"), require("./routes/reset"));
app.use("/api/financial-years", requireAuth, requireRole("owner"), require("./routes/financialYears"));

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shop Manager running on port ${PORT}`);
  if (!isProduction) {
    console.log(`Open http://localhost:${PORT}`);
    console.log("On other phones/tablets on the same WiFi, use this PC's local IP address instead of localhost.");
  }
  // Automatic rotating snapshots (+ cloud if configured). Started after the
  // server is up so a backup can never delay accepting requests.
  backup.startSchedule();
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
