#!/usr/bin/env node
/* ============================================================
   IS THE BACKUP ACTUALLY RESTORABLE?

   The backup system here writes, rotates and uploads, and it refuses to
   save an empty database. All of that is about the WRITE side, and the
   write side has never been the thing that loses the books.

   What loses the books is a store that accepts a write while failing a
   read. "The backup is healthy" and "the data is gone" are then both
   true at the same moment, and nobody finds out until the morning they
   need it. That is not hypothetical — it is how the vendor's own licence
   panel lost sixteen customers on 14 September 2026, and the backups
   looked fine the whole time because nothing had ever opened one.

   So this opens one. It downloads a run, opens every part of it, asks
   SQLite whether the file is sound, checks the tables a shop lives on,
   and then checks the RELATIONSHIPS between them — because a count
   proves a row exists, not that it still points at anything.

   IT NEVER WRITES ANYWHERE BUT ITS OWN TEMP DIRECTORY, which it removes
   on the way out. It cannot touch the live database, a backup, or the
   cloud: nothing here opens anything except read-only, and the only
   cloud call it makes is a download.

   USAGE

     node tools/verify-backup.js              the newest local run
     node tools/verify-backup.js --cloud      the newest run in the cloud
     node tools/verify-backup.js --stamp S    one particular run
     node tools/verify-backup.js --all-local  every local run

   Exit code 0 only when everything passed, so it can be run from a
   scheduler and shout when it cannot.
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

process.env.DATA_DIR = process.env.DATA_DIR || undefined;

const ROOT = path.join(__dirname, "..");
const backup = require(path.join(ROOT, "server/backup.js"));
const cloud = require(path.join(ROOT, "server/cloudStore.js"));

const ARGS = process.argv.slice(2);
const has = f => ARGS.includes(f);
const valueOf = f => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : null; };

const FROM_CLOUD = has("--cloud");
const ALL_LOCAL = has("--all-local");
const WANT_STAMP = valueOf("--stamp");

let problems = 0, warnings = 0;

/**
 * A detail line fit to print.
 *
 * SQLite's complaint about a corrupt file can carry bytes straight out of
 * the page it choked on — which in this application is somebody's customer
 * list. A diagnostic that pastes a shop's records into a terminal, a log
 * file, or whatever a scheduler mails to an operator has turned a
 * corruption into a disclosure.
 *
 * Found by corrupting a real backup and watching a hundred kilobytes of
 * file contents come back out. So: printable characters only, and short.
 */
function clean(detail, max = 200) {
  let s = String(detail == null ? "" : detail)
    .replace(/[^\x20-\x7E]+/g, " ")   // control bytes and raw page data
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max) + "… (truncated)";
  return s;
}

const bad = (m, detail) => {
  problems++;
  const d = clean(detail);
  console.log("  FAIL  " + m + (d ? "\n          " + d : ""));
};
const warn = m => { warnings++; console.log("  warn  " + clean(m, 300)); };
const good = m => console.log("  ok    " + m);

/* The tables a shop's livelihood actually sits in. A backup missing one
   of these is not a backup of this application. */
const REQUIRED = ["products", "customers", "invoices", "invoice_items", "settings"];

/* Counted, and reported, but an empty one is not a failure on its own —
   a brand new shop has no invoices and its backup is still correct. */
const COUNTED = ["products", "customers", "suppliers", "invoices", "invoice_items",
                 "purchases", "cash_entries", "product_sizes"];

/* ------------------------------------------------------------------ */

function isSqlite(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return head.toString("utf8", 0, 15) === "SQLite format 3";
  } catch (e) { return false; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) {} }
}

function openReadOnly(file) {
  /* readOnly so a verification run can never become a write, even by
     accident, even on a file SQLite would otherwise want to recover. */
  return new DatabaseSync(file, { readOnly: true });
}

function tablesIn(d) {
  return d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
}

/**
 * One company database, examined.
 *
 * Returns false the moment it finds something that means this file could
 * not be restored — there is no point counting rows in a database SQLite
 * has already said is corrupt.
 */
function checkCompanyDb(file, label) {
  console.log("\n  " + label);

  const size = fs.statSync(file).size;
  if (size === 0) { bad(label + " is a ZERO BYTE file"); return false; }
  if (!isSqlite(file)) { bad(label + " is not a SQLite database", "first bytes are not the SQLite header"); return false; }
  good("it is a SQLite file, " + (size / 1024).toFixed(0) + " KB");

  let d;
  try { d = openReadOnly(file); }
  catch (e) { bad(label + " could not be opened", e.message); return false; }

  try {
    /* THE QUESTION NOTHING WAS ASKING. A file can be the right size, have
       the right header, and still be a database SQLite will not restore. */
    const integrity = d.prepare("PRAGMA integrity_check").get();
    const verdict = integrity && (integrity.integrity_check || Object.values(integrity)[0]);
    if (String(verdict).toLowerCase() !== "ok") {
      bad(label + " FAILS SQLite's integrity check", String(verdict));
      return false;
    }
    good("SQLite integrity check passed");

    const present = new Set(tablesIn(d));
    const missing = REQUIRED.filter(t => !present.has(t));
    if (missing.length) {
      bad(label + " is missing tables a shop cannot work without", missing.join(", "));
      return false;
    }
    good("all " + REQUIRED.length + " required tables are present (" + present.size + " tables in total)");

    const counts = {};
    for (const t of COUNTED) {
      if (!present.has(t)) continue;
      try { counts[t] = d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n; }
      catch (e) { bad("could not count " + t, e.message); return false; }
    }
    console.log("        " + Object.entries(counts).map(([k, v]) => k + " " + v).join(" · "));

    const everything = Object.values(counts).reduce((a, b) => a + b, 0);
    if (everything === 0) warn("this company's backup is EMPTY — correct for a new shop, alarming for an old one");

    /* ---- relationships ------------------------------------------
       A COUNT PROVES A ROW EXISTS, NOT THAT IT STILL POINTS AT
       ANYTHING. These are the joins the app makes on every screen; a
       backup where they have come apart restores into an application
       that opens and then shows a bill belonging to nobody. */
    const orphans = [];
    const countOrphans = (name, sql) => {
      try { const n = d.prepare(sql).get().n; if (n > 0) orphans.push(name + ": " + n); }
      catch (e) { warn("could not check " + name + " (" + e.message + ")"); }
    };

    countOrphans("bills whose customer no longer exists", `
      SELECT COUNT(*) AS n FROM invoices i
      WHERE i.customer_id IS NOT NULL AND i.customer_id <> ''
        AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = i.customer_id)`);

    countOrphans("bill lines whose bill no longer exists", `
      SELECT COUNT(*) AS n FROM invoice_items it
      WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = it.invoice_id)`);

    countOrphans("bill lines whose product no longer exists", `
      SELECT COUNT(*) AS n FROM invoice_items it
      WHERE it.product_id IS NOT NULL AND it.product_id <> ''
        AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = it.product_id)`);

    if (present.has("product_sizes")) {
      countOrphans("sizes whose product no longer exists", `
        SELECT COUNT(*) AS n FROM product_sizes s
        WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = s.product_id)`);
    }

    if (orphans.length) {
      bad(label + " has records pointing at things that are not there", orphans.join("; "));
      return false;
    }
    good("every bill, line and size still points at something that exists");

    return true;
  } catch (e) {
    /* A CORRUPT DATABASE IS A FINDING, NOT A CRASH.

       SQLite does not necessarily complain when the file is opened — it
       parses the schema lazily, so the first statement is where a damaged
       file actually blows up, and that is inside this block rather than
       the open above. Without this catch the whole check died there and
       reported itself as a broken tool instead of a broken backup, which
       is the one conclusion an operator must not be led to.

       Found by corrupting a real backup and watching the checker crash. */
    bad(label + " could not be read — it looks corrupt", e.message);
    return false;
  } finally {
    try { d.close(); } catch (e) {}
  }
}

/** The registry and the tenant map, which decide WHOSE books these are. */
function checkRegistryAndTenants(dir, stamp, companyFiles) {
  let ok = true;

  const regFile = path.join(dir, `shop-${stamp}--registry.json`);
  let registry = null;
  console.log("\n  the registry (which companies exist)");
  if (!fs.existsSync(regFile)) {
    /* A single-company install predates the registry, so this is a
       warning rather than a failure — but on a multi-company install it
       is the difference between restoring books and restoring books
       nobody can be matched to. */
    warn("no registry in this run — correct only if this install has one company");
  } else {
    try {
      registry = JSON.parse(fs.readFileSync(regFile, "utf8"));
      const list = (registry && registry.companies) || [];
      if (!Array.isArray(list) || !list.length) { bad("the registry names no companies"); ok = false; }
      else good(list.length + " company(ies): " + list.map(c => c.name).join(", "));
    } catch (e) { bad("the registry is not readable JSON", e.message); ok = false; }
  }

  const tenFile = path.join(dir, `shop-${stamp}--tenants.db`);
  console.log("\n  the tenant map (which shop owns which books)");
  if (!fs.existsSync(tenFile)) {
    warn("no tenant map in this run — correct only if no shop signs in by login");
    return ok;
  }
  if (!isSqlite(tenFile)) { bad("the tenant map is not a SQLite database"); return false; }

  let t;
  try { t = openReadOnly(tenFile); }
  catch (e) { bad("the tenant map could not be opened", e.message); return false; }

  try {
    const verdict = Object.values(t.prepare("PRAGMA integrity_check").get())[0];
    if (String(verdict).toLowerCase() !== "ok") { bad("the tenant map fails its integrity check", String(verdict)); return false; }

    const rows = t.prepare("SELECT username, company_id FROM tenants").all();
    good(rows.length + " shop login(s) recorded");

    /* THE ORPHANING THIS WHOLE FILE EXISTS TO CATCH. A tenant pointing at
       a company that is not in this run restores into an app that cannot
       find the shop's books, decides it has never met them, and starts an
       empty company beside the real one. */
    const known = new Set(companyFiles.map(f => f.companyId).filter(Boolean));
    if (registry && registry.companies) for (const c of registry.companies) known.add(c.id);

    const lost = rows.filter(r => r.company_id && !known.has(r.company_id));
    if (lost.length) {
      bad("shop logins pointing at books that are NOT in this backup",
          lost.map(r => r.username + " → " + r.company_id).join(", "));
      ok = false;
    } else if (rows.length) {
      good("every login points at a company present in this run");
    }
  } finally { try { t.close(); } catch (e) {} }

  return ok;
}

/* ------------------------------------------------------------------ */

function partsFor(dir, stamp) {
  return fs.readdirSync(dir)
    .filter(f => f.startsWith("shop-" + stamp))
    .map(name => {
      const m = /^shop-.+?--(.+)\.db$/.exec(name);
      const isRegistry = name.endsWith("--registry.json");
      const isTenants = name.endsWith("--tenants.db");
      return {
        name,
        file: path.join(dir, name),
        isCompany: name.endsWith(".db") && !isTenants,
        companyId: isTenants || !m ? null : m[1],
      };
    });
}

function verifyRun(dir, stamp) {
  console.log("\n" + "=".repeat(62));
  console.log("  RUN  " + stamp);
  console.log("=".repeat(62));

  const parts = partsFor(dir, stamp);
  const companies = parts.filter(p => p.isCompany);
  if (!companies.length) { bad("this run contains no company database at all"); return false; }

  let ok = true;
  for (const p of companies) {
    if (!checkCompanyDb(p.file, p.name)) ok = false;
  }
  if (!checkRegistryAndTenants(dir, stamp, companies)) ok = false;
  return ok;
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log("\nVERIFYING A BACKUP BY OPENING IT\n");
  console.log("Nothing here writes anywhere but a temporary directory, and");
  console.log("every database is opened read-only.\n");

  let dir, stamps, temp = null;

  if (FROM_CLOUD) {
    if (!cloud.configured()) {
      console.error("\nNo cloud backup store is configured — nothing to fetch.\n" +
                    "Set the backup credentials, or run without --cloud to check the local copies.\n");
      process.exit(2);
    }
    console.log("Fetching from " + cloud.describe() + "\n");

    let listing;
    try { listing = await backup.listCloud(); }
    catch (e) {
      console.error("\nCould not list the cloud backups: " + e.message + "\n" +
                    "THAT IS ITSELF THE FINDING. A store that cannot be listed cannot be restored from.\n");
      process.exit(1);
    }
    const runs = (listing && listing.runs) || [];
    if (!runs.length) {
      console.error("\nThe cloud store is reachable and HAS NO BACKUPS IN IT.\n");
      process.exit(1);
    }

    const run = WANT_STAMP ? runs.find(r => r.stamp === WANT_STAMP) : runs[0];
    if (!run) { console.error("\nNo cloud run with stamp " + WANT_STAMP + "\n"); process.exit(2); }

    temp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-backup-"));
    dir = temp;
    console.log("Run " + run.stamp + ", " + run.files.length + " file(s)\n");
    for (const name of run.files) {
      let bytes = null;
      try { bytes = await cloud.download(name); }
      catch (e) { bad("could not download " + name, e.message); continue; }
      if (!bytes) { bad("could not download " + name, "the store returned nothing"); continue; }
      fs.writeFileSync(path.join(temp, path.basename(name)), Buffer.from(bytes));
    }
    stamps = [run.stamp];
  } else {
    dir = backup.BACKUP_DIR;
    if (!fs.existsSync(dir)) {
      console.error("\nThere is no local backup directory at all: " + dir + "\n");
      process.exit(1);
    }
    const runs = backup.listLocal();
    if (!runs.length) { console.error("\nNo local backups exist yet.\n"); process.exit(1); }
    /* listLocal reports files, newest first; the stamp is in the name. */
    const all = runs.map(r => (/^shop-(.+)\.db$/.exec(r.file) || [])[1]).filter(Boolean);
    if (!all.length) { console.error("\nNo local backups could be read by name.\n"); process.exit(1); }
    stamps = WANT_STAMP ? [WANT_STAMP] : (ALL_LOCAL ? all : [all[0]]);
    console.log("Checking " + stamps.length + " of " + all.length + " local run(s)\n");
  }

  let allOk = true;
  for (const s of stamps) if (!verifyRun(dir, s)) allOk = false;

  if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {} }

  console.log("\n" + "=".repeat(62));
  if (problems) {
    console.log("  " + problems + " PROBLEM(S) — this backup should not be relied on.");
    console.log("  Do not delete whatever you still have. Fix the cause first.");
  } else {
    console.log("  Verified: every part opened, passed SQLite's own integrity");
    console.log("  check, held the tables a shop needs, and its records still");
    console.log("  point at each other.");
  }
  if (warnings) console.log("  " + warnings + " warning(s) above.");
  console.log("=".repeat(62) + "\n");

  process.exitCode = allOk && !problems ? 0 : 1;
})().catch(e => {
  console.error("\nThe check itself failed: " + clean(e && e.message) + "\n");
  process.exitCode = 1;
});
