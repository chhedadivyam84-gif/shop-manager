#!/usr/bin/env node
/* ============================================================
   BUILD A COPY TO SELL

     node tools/build-buyer-copy.js --stock 3
     node tools/build-buyer-copy.js "ABC Traders" 2027-08-21 [businesses]
     node tools/build-buyer-copy.js --verify <folder>

   TWO WAYS TO SELL, and they want different builds.

   --stock N makes N identical UNBRANDED folders. Nothing in them names a
   buyer, because with the admin panel holding the licence there is nothing
   in a copy that needs to differ between buyers: the ACTIVATION CODE is
   what identifies them, it is created in the panel at the moment of sale,
   and it can be extended or cancelled from there afterwards. Copies made
   this way never need rebuilding — not to renew, not to cancel, not when
   a shop changes its name. The buyer types their own shop name into
   Settings the first time they open it.

   Naming a buyer builds ONE folder branded as them — login screen, tab
   title, first-run business name. Worth doing when a shop is paying for it
   to look like theirs. It still takes an activation code; branding and
   licensing are unrelated.

   WHAT THE BUILD REFUSES TO DO. The same four mistakes are the ones that
   matter, and a person doing this by hand at the end of a long day will
   eventually make one of them —

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

/* Where a sold copy asks what its activation code is worth.

   Baked in rather than left for the buyer to set. They have no reason to
   know it, and a copy that does not know where to ask is a copy that
   quietly never asks — which looks exactly like everything working, right
   up until the vendor tries to cancel somebody.

   Still overridable by the environment on the buyer's host, so a licence
   server that has to move does not need every sold copy rebuilt. Set it to
   an empty string to build an OFFLINE copy, which falls back to a signed
   key with a fixed expiry that cannot be withdrawn. */
const LICENCE_SERVER = process.env.LICENCE_SERVER === undefined
  ? "https://admin-panel-lsty.onrender.com"
  : String(process.env.LICENCE_SERVER).trim();

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

  /* A copy that says one thing and enforces another sends the buyer to the
     wrong box on their first day. Whichever scheme this copy was built
     under, the note in it must describe THAT scheme and no other. */
  const readme = path.join(dir, "READ ME FIRST.txt");
  const checkinFile = path.join(dir, "server", "licenseCheckin.js");
  if (fs.existsSync(readme) && fs.existsSync(checkinFile)) {
    const note = fs.readFileSync(readme, "utf8");
    const onServer = /const SERVER_URL = String\(process\.env\.LICENCE_SERVER \|\| "http/
      .test(fs.readFileSync(checkinFile, "utf8"));
    if (onServer && /[A-Za-z0-9_-]{60,}\.[A-Za-z0-9_-]{40,}/.test(note))
      bad.push("the note tells the buyer to paste a signed KEY, but this copy is licensed by ACTIVATION CODE");
    if (!onServer && /activation code/i.test(note))
      bad.push("the note asks for an ACTIVATION CODE, but this copy has no licence server to check it against");
  }

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
  console.log("  data, no stray logs, enforcement on, and the note matches the");
  console.log("  licensing this copy actually uses.\n");
  console.log("  Safe to send.\n");
  process.exit(0);
}

/* ------------------------------------------------------------ arguments */
const argv = process.argv.slice(2);

if (argv[0] === "--verify") {
  if (!argv[1]) { console.error("Usage: node tools/build-buyer-copy.js --verify <folder>"); process.exit(1); }
  verifyFolder(path.resolve(argv[1]));
}

const usage = () => {
  console.error("Usage:");
  console.error('  node tools/build-buyer-copy.js --stock <count>');
  console.error('      unbranded copies to sell to whoever comes. The activation code');
  console.error('      you create in the admin panel is what makes one theirs.');
  console.error("");
  console.error('  node tools/build-buyer-copy.js "<Shop Name>" <YYYY-MM-DD> [businesses|unlimited]');
  console.error('      one copy branded as that shop.');
  console.error("");
  console.error("  node tools/build-buyer-copy.js --verify <folder>");
  process.exit(1);
};

let STOCK = 0, buyerName = "", expires = "", businessesArg = "";
if (argv[0] === "--stock") {
  STOCK = Math.floor(Number(argv[1]) || 0);
  if (!(STOCK >= 1 && STOCK <= 20)) {
    console.error("How many? e.g.  node tools/build-buyer-copy.js --stock 3   (1 to 20)");
    process.exit(1);
  }
} else {
  [buyerName, expires, businessesArg] = argv;
  if (!buyerName || !expires) usage();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    console.error("Expiry must look like 2027-08-21");
    process.exit(1);
  }
}

/* An offline copy has no server to withdraw its licence, so it falls back
   to a signed key — and a key needs a name and an expiry to be minted
   against. Stock copies have neither, by design. */
const ONLINE = LICENCE_SERVER.length > 0;
if (STOCK && !ONLINE) {
  console.error("\n  --stock builds copies that are licensed from the admin panel, but");
  console.error("  LICENCE_SERVER was set empty, which builds an offline copy instead.");
  console.error("  An offline copy needs a buyer name and an expiry date to mint a key\n" +
                "  against, so build those one at a time.\n");
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

/**
 * Build one folder.
 *
 * `name` is the shop it is branded as, or "" for a stock copy. Everything
 * that differs between the two is decided from that one value, so the two
 * kinds of build cannot drift apart into two half-tested paths.
 */
function build(OUT, name) {
  const label = name || "Shop Manager";

  // -------------------------------------------------------------- 1. copy
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) { console.error(`  missing from the source: ${item}`); process.exit(1); }
    copyInto(src, path.join(OUT, item));
  }

  // --------------------------------------------------- 2. enforcement ON
  /* The public key is both the switch and the tool: it turns enforcement on,
     AND it is what the check-in uses to verify that a verdict really came
     from the vendor. Without it a copy would believe anything it was told. */
  const licPath = path.join(OUT, "server", "license.js");
  let lic = fs.readFileSync(licPath, "utf8");
  const pubKey = fs.readFileSync(path.join(ROOT, "tools", "vendor-public-key.pem"), "utf8").trim();
  lic = lic.replace("const PUBLIC_KEY = ``;", "const PUBLIC_KEY = `" + pubKey + "`;");
  fs.writeFileSync(licPath, lic);

  // ------------------------------------------- 3. where it will check in
  const checkinPath = path.join(OUT, "server", "licenseCheckin.js");
  if (ONLINE) {
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
  }

  // ------------------------------------------------- 4. the buyer's name
  if (name) {
    const schemaPath = path.join(OUT, "server", "db-schema.js");
    let schema = fs.readFileSync(schemaPath, "utf8");
    schema = schema.replace(
      "business_name TEXT NOT NULL DEFAULT 'My Shop'",
      `business_name TEXT NOT NULL DEFAULT '${name.replace(/'/g, "''")}'`);
    fs.writeFileSync(schemaPath, schema);

    const htmlPath = path.join(OUT, "public", "index.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    const esc = name.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    html = html.replace('<title>Shop Manager</title>', `<title>${esc}</title>`);
    html = html.replace('<h1 id="login-title">Shop Manager</h1>', `<h1 id="login-title">${esc}</h1>`);
    fs.writeFileSync(htmlPath, html);
  }

  /* ------------------------------------------- 5. mint a key, or do not

     Only an OFFLINE copy gets one. A copy that checks in is governed by
     what the panel says, so a signed key sitting beside it would grant
     nothing, expire on its own schedule, and — worst of the three — send
     the buyer looking for a box the app no longer shows them. */
  let key = "";
  if (!ONLINE) {
    try {
      const out = execFileSync(process.execPath,
        [path.join(ROOT, "tools", "make-license.js"), VENDOR_KEY, name, expires,
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
  }

  /* ------------------------------------------------- 6. refuse to ship a
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
  if (ONLINE && !/const SERVER_URL = String\(process\.env\.LICENCE_SERVER \|\| "http/.test(fs.readFileSync(checkinPath, "utf8")))
    problems.push("the licence server URL did not make it into the build — this copy would never check in");

  if (problems.length) {
    console.error("\nREFUSED TO BUILD:\n");
    problems.forEach(p => console.error("  - " + p));
    console.error("\nNothing was shipped. Fix the above and run it again.\n");
    process.exit(1);
  }

  /* ------------------------------------------------- 7. two files to click

     A shopkeeper is not going to open a terminal, and should not have to. So
     the buyer gets two things they can double-click, and the installer solves
     the problem that would otherwise bring them back to you: the app stops
     when the PC restarts.

     Windows is assumed — that is what is on the counter. */
  fs.writeFileSync(path.join(OUT, "Install (run once).bat"),
`@echo off
title ${label} - Setup
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
title ${label}
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

  /* ------------------------------------------- 8. a note for the buyer

     Written to match the scheme this copy was actually built under. The
     verify step checks that it does, because a note pointing at the wrong
     box is a support call on the buyer's very first day. */
  const licenceNote = ONLINE
? `YOUR ACTIVATION CODE
  Your supplier will give you a short code that looks like

      ABCD-EFGH-JKLM

  The first time you open the app it will ask for it. If you want to
  enter it later, it is in  Settings -> Subscription.

  Keep the code. It is what your subscription is held against, and you
  will need it again if you ever move to a new computer.

  The app checks in with your supplier a few times a day to confirm the
  subscription is still running. If the internet is down it carries on
  working — it only needs to get through occasionally.`
: `YOUR LICENCE
  Paste this into Settings -> Subscription the first time you open the app.

${key}

  Valid until ${expires}.
  You will be warned inside the app two weeks before it runs out.`;

  fs.writeFileSync(path.join(OUT, "READ ME FIRST.txt"),
`${label}
${"=".repeat(label.length)}

TO START
  1. Install Node from  https://nodejs.org  (choose LTS)
  2. Double-click  "Install (run once).bat"

  That is all. It sets everything up and opens the app.

  From then on Shop Manager starts by itself whenever the computer is
  switched on. To open it any time, double-click "Start Shop Manager.bat".

  On the phones and tablets in your shop, use this computer's local IP
  address instead of "localhost" — they must be on the same WiFi.

${name ? "" : `YOUR SHOP'S NAME
  Open  Settings -> Business Details  and put your shop's name, address,
  GST number and phone in. That is what prints on every bill, so it is
  worth doing before you raise the first one.

`}${licenceNote}

YOUR DATA
  Everything lives in the "data" folder that appears next to this file.
  The app backs itself up there on start-up, on a schedule, and when it
  shuts down. Copy that folder to keep a copy of your books.
`);

  return { out: OUT, key };
}

/* ---------------------------------------------------------------- run it */
const BUILDS = path.join(ROOT, "..", "shop-manager-builds");

if (STOCK) {
  console.log(`\nBuilding ${STOCK} unbranded ${STOCK === 1 ? "copy" : "copies"} to sell\n`);
  const made = [];
  for (let i = 1; i <= STOCK; i++) {
    const out = path.join(BUILDS, `stock-${i}`);
    build(out, "");
    made.push(out);
    console.log(`  ${i}. ${out}`);
  }
  console.log("\n" + "-".repeat(62));
  console.log("  Checked: no database, no private key, no minting tool,");
  console.log("           no other shop's data, enforcement on, and the note");
  console.log("           matches how these are actually licensed.");
  console.log("-".repeat(62));
  console.log(`\n  These copies are identical and carry no buyer's name. What makes`);
  console.log(`  one of them somebody's is the ACTIVATION CODE, which you create`);
  console.log(`  when you sell it:\n`);
  console.log(`    1. open  ${LICENCE_SERVER}`);
  console.log(`    2. New customer — shop name, phone, how many installations`);
  console.log(`    3. Approve it, and set how long they have paid for`);
  console.log(`    4. Send them the folder and the code it gives you\n`);
  console.log(`  To renew, extend them in the panel. To stop them, cancel there.`);
  console.log(`  Neither needs a new build, and neither needs their copy touched.\n`);
  console.log(`  Before sending one, run:`);
  console.log(`    node tools/build-buyer-copy.js --verify "${made[0]}"\n`);
} else {
  console.log(`\nBuilding a copy for: ${buyerName}\n`);
  const slug = buyerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const { out, key } = build(path.join(BUILDS, slug), buyerName);

  console.log("  copied server, public and the build files");
  console.log("  licence enforcement switched on");
  if (ONLINE) console.log(`  will check in with ${LICENCE_SERVER}`);
  console.log(`  branded as "${buyerName}" — login screen, tab title and first-run business name`);
  console.log("\n" + "-".repeat(58));
  console.log(`  Built: ${out}`);
  console.log(`  Buyer: ${buyerName}`);
  console.log("-".repeat(58));
  if (ONLINE) {
    console.log(`\n  Licensed from the panel. Create this shop at`);
    console.log(`  ${LICENCE_SERVER} and send them the activation code it gives you.`);
    console.log(`  Set how long they have paid for there — and cancel there too.\n`);
  } else {
    console.log(`  Valid: until ${expires}`);
    console.log(`  Plan : ${businessesArg || 1} business${businessesArg === "unlimited" || Number(businessesArg) > 1 ? "es" : ""}`);
    console.log("\n  Licence key (also in READ ME FIRST.txt):\n");
    console.log("  " + key + "\n");
    console.log(`  To renew next year, run this again with a later date —\n` +
                `  the buyer pastes the new key into Settings, nothing else changes.\n`);
  }
  console.log("  Checked: no database, no private key, no minting tool,");
  console.log("           no other shop's data, enforcement on.\n");
}
