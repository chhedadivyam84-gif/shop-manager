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
    console.log(`[restore] Restored database from cloud backup: ${restore.file} (${restore.size} bytes)`);
  } else {
    console.log(`[restore] Skipped: ${restore.reason}`);
  }

  const express = require("express");
  const session = require("express-session");
  const db = require("./db");
  const backup = require("./backup");
  const { requireAuth, requireRole } = require("./auth");

  const app = express();
  const PORT = process.env.PORT || 3000;

// Session secret persists across restarts in data/session-secret so logins
// aren't wiped every time the shop PC reboots the app.
const SECRET_PATH = path.join(__dirname, "..", "data", "session-secret.txt");
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

app.use("/api/auth", require("./routes/auth"));
app.use("/api/settings", requireAuth, require("./routes/settings"));
app.use("/api/products", requireAuth, require("./routes/products"));
app.use("/api/customers", requireAuth, require("./routes/customers"));
app.use("/api/suppliers", requireAuth, require("./routes/suppliers"));
app.use("/api/invoices", requireAuth, require("./routes/invoices"));
app.use("/api/reports", requireAuth, require("./routes/reports"));
app.use("/api/staff", requireAuth, requireRole("owner"), require("./routes/staff"));
app.use("/api/audit", requireAuth, requireRole("owner"), require("./routes/audit"));
app.use("/api/backup", requireAuth, requireRole("owner"), require("./routes/backup"));
app.use("/api/print", requireAuth, require("./routes/print"));
app.use("/api/attachments", requireAuth, require("./routes/attachments"));
app.use("/api/reset", requireAuth, requireRole("owner"), require("./routes/reset"));

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
}
