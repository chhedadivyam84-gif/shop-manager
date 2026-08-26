#!/usr/bin/env node
/* ============================================================
   BUILD A COPY FOR ONE BUYER

     node tools/build-buyer-copy.js "ABC Traders" 2027-08-21 [businesses]

   Produces a folder the buyer can run, carrying their name, with licensing
   switched on and a key already minted for them.

   What makes this worth having as a script rather than a checklist: the same
   four mistakes are the ones that matter, and a person doing this by hand at
   the end of a long day will eventually make one of them —

     - shipping the shop's own database with it
     - shipping the licence MINTING tool, which lets the buyer issue
       themselves a free licence forever
     - shipping the private signing key, which lets them issue licences to
       anyone
     - forgetting to switch enforcement on, so the licence is decorative

   So the build refuses to finish unless it has checked all four. A refusal
   here costs a minute; any of these leaving the building costs the product.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const VENDOR_KEY = "C:/Users/prafu/shop-manager-vendor-keys/private-key.pem";

/* ---------------------------------------------------------- verify mode

   The checks below run at BUILD time, but the dangerous moment is later:
   you build a copy, run it once to make sure it works, and running it
   creates a data folder with a database in it. Ship that folder now and the
   buyer receives a database — the exact thing the build refused to include.

   So the same checks can be pointed at a finished folder, to be run in the
   minute before it is sent. */
function verifyFolder(dir) {
  if (!fs.existsSync(dir)) { console.error("No such folder: " + dir); process.exit(1); }
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === "node_modules" ? [] : walk(p)) : [p];
  });
  const files = walk(dir);
  const bad = [];

  const dbs = files.filter(f => /\.(db|db-wal|db-shm|sqlite)$/i.test(f));
  if (dbs.length) bad.push(`${dbs.length} database file(s) — probably from running it: ${path.relative(dir, dbs[0])}`);

  const dataDir = path.join(dir, "data");
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length)
    bad.push(`data/ is not empty — delete it before sending`);

  const pk = files.filter(f => /private.*\.pem$/i.test(f));
  if (pk.length) bad.push(`the PRIVATE signing key is here: ${path.relative(dir, pk[0])}`);

  if (fs.existsSync(path.join(dir, "tools"))) bad.push("tools/ is here — that includes the minting tool");
  if (fs.existsSync(path.join(dir, "server", "seed-areas.js"))) bad.push("seed-areas.js is here");

  const traces = files.filter(f => {
    if (!/\.(js|html|css|json|md|txt)$/i.test(f)) return false;
    try { return /swagat/i.test(fs.readFileSync(f, "utf8")); } catch { return false; }
  });
  if (traces.length) bad.push(`"Swagat" appears in ${traces.length} file(s): ${path.relative(dir, traces[0])}`);

  const licFile = path.join(dir, "server", "license.js");
  if (!fs.existsSync(licFile) || !/const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----/.test(fs.readFileSync(licFile, "utf8")))
    bad.push("licence enforcement is NOT on");

  const logs = files.filter(f => /\.log$/i.test(f));
  if (logs.length) bad.push(`${logs.length} log file(s) — tidy: ${path.relative(dir, logs[0])}`);

  console.log(`\nChecking: ${dir}\n`);
  if (bad.length) {
    console.error("DO NOT SEND THIS:\n");
    bad.forEach(b => console.error("  - " + b));
    console.error("");
    process.exit(1);
  }
  console.log("  no database, no private key, no minting tool, no other shop's");
  console.log("  data, no stray logs, enforcement on.\n");
  console.log("  Safe to send.\n");
  process.exit(0);
}

const [, , buyerName, expires, businessesArg] = process.argv;

if (buyerName === "--verify") {
  if (!expires) { console.error("Usage: node tools/build-buyer-copy.js --verify <folder>"); process.exit(1); }
  verifyFolder(path.resolve(expires));
}

if (!buyerName || !expires) {
  console.error('Usage: node tools/build-buyer-copy.js "<Shop Name>" <YYYY-MM-DD> [businesses|unlimited]');
  console.error('   e.g. node tools/build-buyer-copy.js "ABC Traders" 2027-08-21 1');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error("Expiry must look like 2027-08-21");
  process.exit(1);
}

/* Everything the buyer's copy is made of. Anything NOT listed here simply
   never reaches them — which is why tools/ and data/ are absent by omission
   rather than by being deleted afterwards. */
const INCLUDE = ["server", "public", "package.json", "package-lock.json", "Dockerfile"];

/* Files that must never travel, even though they live inside an included
   folder. seed-areas.js is one shop's delivery rounds; nobody else's. */
const EXCLUDE = [
  path.join("server", "seed-areas.js")
];

const slug = buyerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const OUT = path.join(ROOT, "..", "shop-manager-builds", slug);

function copyInto(src, dest) {
  const rel = path.relative(ROOT, src);
  if (EXCLUDE.includes(rel)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (["node_modules", ".git", "data", "backups"].includes(path.basename(src))) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) copyInto(path.join(src, f), path.join(dest, f));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log(`\nBuilding a copy for: ${buyerName}\n`);

// ---------------------------------------------------------------- 1. copy
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) { console.error(`  missing from the source: ${item}`); process.exit(1); }
  copyInto(src, path.join(OUT, item));
}
console.log("  copied server, public and the build files");

// ------------------------------------------------- 2. enforcement ON
const licPath = path.join(OUT, "server", "license.js");
let lic = fs.readFileSync(licPath, "utf8");
const pubKey = fs.readFileSync(path.join(ROOT, "tools", "vendor-public-key.pem"), "utf8").trim();
lic = lic.replace("const PUBLIC_KEY = ``;", "const PUBLIC_KEY = `" + pubKey + "`;");
fs.writeFileSync(licPath, lic);
console.log("  licence enforcement switched on");

/* Where this copy will check in.

   Baked in rather than left for the buyer to set. They have no reason to
   know it, and a copy that does not know where to ask is a copy that
   quietly never asks — which looks exactly like everything working, right
   up until the vendor tries to cancel somebody.

   Still overridable by the environment on the buyer's host, so a licence
   server that has to move does not need every sold copy rebuilt. */
const LICENCE_SERVER = process.env.LICENCE_SERVER || "https://admin-panel-lsty.onrender.com";
const checkinPath = path.join(OUT, "server", "licenseCheckin.js");
let ck = fs.readFileSync(checkinPath, "utf8");
const before = ck;
ck = ck.replace(
  'const SERVER_URL = String(process.env.LICENCE_SERVER || "").trim().replace(/\\/+$/, "");',
  'const SERVER_URL = String(process.env.LICENCE_SERVER || ' + JSON.stringify(LICENCE_SERVER) + ').trim().replace(/\\/+$/, "");');
if (ck === before) {
  console.error("\n  Could not point this copy at the licence server — licenseCheckin.js has changed shape.");
  console.error("  Refusing to ship a copy that would never check in.\n");
  process.exit(1);
}
fs.writeFileSync(checkinPath, ck);
console.log(`  will check in with ${LICENCE_SERVER}`);

// ------------------------------------------------- 3. the buyer's name
const schemaPath = path.join(OUT, "server", "db-schema.js");
let schema = fs.readFileSync(schemaPath, "utf8");
schema = schema.replace(
  "business_name TEXT NOT NULL DEFAULT 'My Shop'",
  `business_name TEXT NOT NULL DEFAULT '${buyerName.replace(/'/g, "''")}'`);
fs.writeFileSync(schemaPath, schema);

const htmlPath = path.join(OUT, "public", "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
const esc = buyerName.replace(/&/g, "&amp;").replace(/</g, "&lt;");
html = html.replace('<title>Shop Manager</title>', `<title>${esc}</title>`);
html = html.replace('<h1 id="login-title">Shop Manager</h1>', `<h1 id="login-title">${esc}</h1>`);
fs.writeFileSync(htmlPath, html);
console.log(`  branded as "${buyerName}" — login screen, tab title and first-run business name`);

// ------------------------------------------------- 4. mint their licence
let key = "";
try {
  const out = execFileSync(process.execPath,
    [path.join(ROOT, "tools", "make-license.js"), VENDOR_KEY, buyerName, expires,
     ...(businessesArg ? [String(businessesArg)] : [])],
    { encoding: "utf8" });
  key = (out.split("\n").map(s => s.trim())
    .find(s => /^[A-Za-z0-9_-]{60,}\.[A-Za-z0-9_-]+$/.test(s))) || "";
} catch (e) {
  console.error("\n  could not mint the licence: " + e.message);
  console.error("  is the private key at " + VENDOR_KEY + " ?");
  process.exit(1);
}
if (!key) { console.error("\n  the minting tool produced no key"); process.exit(1); }
console.log("  licence minted");

/* ------------------------------------------------- 5. refuse to ship a
   copy that would give the product away, or that carries another shop's
   trade with it. Each check names what it found rather than only failing. */
const problems = [];
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const files = walk(OUT);

const dbs = files.filter(f => /\.(db|db-wal|db-shm|sqlite)$/i.test(f));
if (dbs.length) problems.push(`${dbs.length} database file(s) would ship: ${dbs[0]}`);

const keys = files.filter(f => /private.*\.pem$/i.test(f));
if (keys.length) problems.push(`the PRIVATE signing key would ship: ${keys[0]}`);

if (fs.existsSync(path.join(OUT, "tools")))
  problems.push("tools/ would ship — that includes the licence minting tool");

if (fs.existsSync(path.join(OUT, "server", "seed-areas.js")))
  problems.push("seed-areas.js would ship — that is one shop's delivery rounds");

const shopTraces = files.filter(f => {
  if (!/\.(js|html|css|json|md)$/i.test(f)) return false;
  try { return /swagat/i.test(fs.readFileSync(f, "utf8")); } catch { return false; }
});
if (shopTraces.length) problems.push(`"Swagat" appears in ${shopTraces.length} file(s): ${path.relative(OUT, shopTraces[0])}`);

if (!/const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----/.test(fs.readFileSync(licPath, "utf8")))
  problems.push("licence enforcement is NOT on — the key would be decorative");

/* A copy that cannot check in is worse than one that is not licensed at
   all: it works for ever and the vendor never finds out. */
if (!/const SERVER_URL = String\(process\.env\.LICENCE_SERVER \|\| "http/.test(fs.readFileSync(checkinPath, "utf8")))
  problems.push("the licence server URL did not make it into the build — this copy would never check in");

if (problems.length) {
  console.error("\nREFUSED TO BUILD:\n");
  problems.forEach(p => console.error("  - " + p));
  console.error("\nNothing was shipped. Fix the above and run it again.\n");
  process.exit(1);
}

/* ------------------------------------------------- 6. two files to click

   A shopkeeper is not going to open a terminal, and should not have to. So
   the buyer gets two things they can double-click, and the installer solves
   the problem that would otherwise bring them back to you: the app stops
   when the PC restarts.

   Windows is assumed — that is what is on the counter. */
fs.writeFileSync(path.join(OUT, "Install (run once).bat"),
`@echo off
title ${buyerName} - Shop Manager Setup
cd /d "%~dp0"

echo.
echo   Setting up Shop Manager. This takes a minute.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node is not installed on this computer.
  echo.
  echo   Install it from  https://nodejs.org  ^(choose the LTS version^),
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

echo   Installing...
call npm ci --omit=dev
if errorlevel 1 (
  echo.
  echo   Installation failed. Check the internet connection and try again.
  pause
  exit /b 1
)

rem  Start again by itself whenever this user logs in, so a restart of the
rem  computer does not quietly leave the shop without billing.
schtasks /create /tn "Shop Manager" /tr "\\"%~dp0Start Shop Manager.bat\\"" /sc onlogon /rl highest /f >nul 2>&1

echo.
echo   Done. Shop Manager will now start by itself when this
echo   computer is switched on.
echo.
echo   Opening it now...
start "" "%~dp0Start Shop Manager.bat"
timeout /t 6 >nul
start "" "http://localhost:3000"
echo.
pause
`);

fs.writeFileSync(path.join(OUT, "Start Shop Manager.bat"),
`@echo off
title ${buyerName} - Shop Manager
cd /d "%~dp0"

rem  Already running? Then just open it rather than starting a second one.
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  start "" "http://localhost:3000"
  exit /b 0
)

echo.
echo   Shop Manager is running.
echo.
echo   On this computer:      http://localhost:3000
echo   On phones and tablets: use this computer's IP address, same WiFi
echo.
echo   Keep this window open while you are using it.
echo   Closing it stops the app.
echo.
node --no-warnings server/index.js
pause
`);

// ------------------------------------------------- 7. a note for the buyer
fs.writeFileSync(path.join(OUT, "READ ME FIRST.txt"),
`${buyerName} — Shop Manager
${"=".repeat(buyerName.length + 15)}

TO START
  1. Install Node from  https://nodejs.org  (choose LTS)
  2. Double-click  "Install (run once).bat"

  That is all. It sets everything up and opens the app.

  From then on Shop Manager starts by itself whenever the computer is
  switched on. To open it any time, double-click "Start Shop Manager.bat".

  On the phones and tablets in your shop, use this computer's local IP
  address instead of "localhost" — they must be on the same WiFi.

YOUR LICENCE
  Paste this into Settings -> Subscription the first time you open the app.

${key}

  Valid until ${expires}.
  You will be warned inside the app two weeks before it runs out.

YOUR DATA
  Everything lives in the "data" folder that appears next to this file.
  The app backs itself up there on start-up, on a schedule, and when it
  shuts down. Copy that folder to keep a copy of your books.
`);

// ------------------------------------------------- 7. done
console.log("\n" + "-".repeat(58));
console.log(`  Built: ${OUT}`);
console.log(`  Buyer: ${buyerName}`);
console.log(`  Valid: until ${expires}`);
console.log(`  Plan : ${businessesArg || 1} business${businessesArg === "unlimited" || Number(businessesArg) > 1 ? "es" : ""}`);
console.log("-".repeat(58));
console.log("\n  Licence key (also in READ ME FIRST.txt):\n");
console.log("  " + key + "\n");
console.log("  Checked: no database, no private key, no minting tool,");
console.log("           no other shop's data, enforcement on.\n");
console.log(`  To renew next year, run this again with a later date —\n` +
            `  the buyer pastes the new key into Settings, nothing else changes.\n`);
