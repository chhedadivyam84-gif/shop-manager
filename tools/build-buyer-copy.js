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

if (problems.length) {
  console.error("\nREFUSED TO BUILD:\n");
  problems.forEach(p => console.error("  - " + p));
  console.error("\nNothing was shipped. Fix the above and run it again.\n");
  process.exit(1);
}

// ------------------------------------------------- 6. a note for the buyer
fs.writeFileSync(path.join(OUT, "READ ME FIRST.txt"),
`${buyerName} — Shop Manager
${"=".repeat(buyerName.length + 15)}

TO START
  1. Install Node 24 or newer from nodejs.org
  2. Open this folder in a terminal
  3. Run:  npm ci --omit=dev
  4. Run:  npm start
  5. Open http://localhost:3000 in a browser

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
