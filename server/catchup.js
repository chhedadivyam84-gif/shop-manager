/* ============================================================
   TAKING IN THE BILLS THE OLD CONTAINER SAVED AFTER WE RESTORED

   Render starts the new container before it stops the old one, so the new
   one restores, and only afterwards does the old one save its last work.
   server/release.js notices that. This file is what happens next.

   THE ONLY CASE IT ACTS IN is the one where acting cannot lose anything:
   the newer backup has been saved by the container this one replaced, and
   NOTHING has been written here since we started. Then the newer backup is
   a strict superset of what we hold, and taking it in only adds.

   If anything has been written here — a bill, a sign-in, anything at all —
   it does nothing but say so. Merging two diverged copies of a shop's books
   is not something code should guess at.

   HOW, without swapping a database under a live connection (which the
   restore tests exist to forbid):

     1. while still running, download every part of the newer run into
        DATA_DIR/catchup/ and VERIFY each one — SQLite's own integrity
        check, the tables a shop needs. A backup that does not verify is
        never applied.
     2. check again that nothing has been written, with requests held off
     3. mark the staging READY, close every connection, and exit. The host
        restarts the process.
     4. at the next boot, BEFORE anything opens a database, applyStaged()
        moves the current files into DATA_DIR/superseded-<time>/ — kept,
        never deleted — and moves the staged ones into place.

   If the host replaces the container instead of restarting it, the staging
   is gone with the disk — and the cloud restore then picks the newest run,
   which is the same newer backup. Either way the shop ends up on it.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const REQUIRED = ["products", "customers", "invoices", "invoice_items", "settings"];

const stagingDir = dataDir => path.join(dataDir, "catchup");

/** Where a part of a run goes, in the layout the app reads. */
function placeFor(name, stamp) {
  if (name === `shop-${stamp}.db`) return "shop.db";
  if (name === `shop-${stamp}--tenants.db`) return "tenants.db";
  if (name === `shop-${stamp}--registry.json`) return "companies.json";
  const m = new RegExp(`^shop-${stamp}--(.+)\\.db$`).exec(name);
  return m ? path.join("companies", m[1], "shop.db") : null;
}

/** Does this file look like a database a shop could run on? */
function verifyDb(file, isCompany) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString("utf8", 0, 15) !== "SQLite format 3") return "not a SQLite database";
  } catch (e) { return "unreadable"; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) {} }

  let d;
  try { d = new DatabaseSync(file, { readOnly: true }); }
  catch (e) { return "will not open"; }
  try {
    const verdict = Object.values(d.prepare("PRAGMA integrity_check").get())[0];
    if (String(verdict).toLowerCase() !== "ok") return "fails SQLite's integrity check";
    if (isCompany) {
      const have = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      const missing = REQUIRED.filter(t => !have.has(t));
      if (missing.length) return "missing tables: " + missing.join(", ");
    }
    return null;
  } catch (e) {
    /* SQLite parses the schema lazily, so a damaged file often throws here
       rather than on open. It is a finding, not a crash. */
    return "looks corrupt";
  } finally { try { d.close(); } catch (e) {} }
}

/**
 * Download one run into DATA_DIR/catchup and verify every part of it.
 *
 * Does NOT mark it ready — that is markReady(), called only after the
 * last check that nothing has been written here. Returns { ok, parts }
 * or { ok:false, error }.
 */
async function stageRun(cloud, dataDir, stamp, names) {
  const dir = stagingDir(dataDir);
  try { fs.rmSync(path.join(dir, "READY"), { force: true }); } catch (e) {}
  fs.mkdirSync(dir, { recursive: true });

  const parts = (names || []).filter(n => placeFor(n, stamp));
  if (!parts.includes(`shop-${stamp}.db`)) return { ok: false, error: "the newer run has no first business in it" };

  for (const name of parts) {
    const rel = placeFor(name, stamp);
    const dest = path.join(dir, rel);
    let bytes;
    try { bytes = await cloud.download(name); }
    catch (e) { return { ok: false, error: "could not download " + name }; }
    if (!bytes || !bytes.length) return { ok: false, error: name + " came back empty" };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(bytes));

    if (rel.endsWith(".db")) {
      const why = verifyDb(dest, rel !== "tenants.db");
      if (why) return { ok: false, error: name + " " + why };
    } else {
      try { JSON.parse(fs.readFileSync(dest, "utf8")); }
      catch (e) { return { ok: false, error: name + " is not readable JSON" }; }
    }
  }
  return { ok: true, stamp, parts: parts.length };
}

/** The last step before exiting: tell the next boot to apply the staging. */
function markReady(dataDir, stamp) {
  fs.writeFileSync(path.join(stagingDir(dataDir), "READY"),
    JSON.stringify({ stamp, at: new Date().toISOString() }));
}

/** Called off. The staging stays on disk but will never be applied. */
function discard(dataDir) {
  try { fs.rmSync(path.join(stagingDir(dataDir), "READY"), { force: true }); } catch (e) {}
}

/* The live files a run replaces, with their write-ahead logs — left behind,
   an old -wal would be replayed over the new database. */
const LIVE = ["shop.db", "shop.db-wal", "shop.db-shm", "companies", "companies.json",
              "tenants.db", "tenants.db-wal", "tenants.db-shm"];

/**
 * At boot, before any database is opened: if a verified run is waiting,
 * put it in place. Everything it replaces is MOVED into
 * DATA_DIR/superseded-<time>/ and kept.
 *
 * If a move fails half way, what was moved is moved back, so the shop
 * starts on exactly what it had rather than on a mixture of the two.
 */
function applyStaged(dataDir) {
  const dir = stagingDir(dataDir);
  const ready = path.join(dir, "READY");
  if (!fs.existsSync(ready)) return { applied: false };

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(ready, "utf8")); } catch (e) {}

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const aside = path.join(dataDir, "superseded-" + stamp);
  fs.mkdirSync(aside, { recursive: true });

  const movedAside = [], movedIn = [];
  try {
    for (const n of LIVE) {
      const from = path.join(dataDir, n);
      if (fs.existsSync(from)) { fs.renameSync(from, path.join(aside, n)); movedAside.push(n); }
    }
    for (const n of fs.readdirSync(dir)) {
      if (n === "READY") continue;
      fs.renameSync(path.join(dir, n), path.join(dataDir, n));
      movedIn.push(n);
    }
  } catch (e) {
    /* Put it all back the way it was. */
    for (const n of movedIn.reverse()) {
      try { fs.renameSync(path.join(dataDir, n), path.join(dir, n)); } catch (x) {}
    }
    for (const n of movedAside.reverse()) {
      try { fs.renameSync(path.join(aside, n), path.join(dataDir, n)); } catch (x) {}
    }
    return { applied: false, error: "could not move the files into place — nothing was changed" };
  }

  try { fs.rmSync(ready, { force: true }); } catch (e) {}
  try { fs.rmdirSync(dir); } catch (e) { /* not empty is fine: it is ours */ }
  return { applied: true, stamp: meta.stamp || null, keptAs: path.basename(aside) };
}

module.exports = { stageRun, markReady, discard, applyStaged, placeFor, verifyDb, stagingDir };
