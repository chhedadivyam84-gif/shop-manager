/* ============================================================
   RESTORING A BACKUP FILE

   This is the feature that replaces a shop's books, so what matters is
   not that it works — it is what it refuses to do, and what it keeps.

     · It never touches the live database during upload. The swap waits
       for a start, because a running process holds shop.db open and its
       -wal beside it; replacing the file under a live handle leaves the
       old log pointing into a file that is gone, and what comes back is
       neither book.

     · It keeps what it replaces. A restore is itself undoable.

     · It removes the OLD -wal and -shm. Left behind, they are replayed
       over the new database — the quiet way a restore half-works.

     · And it refuses anything that is not one of this app's backups,
       before opening it rather than after failing to parse it.

   Run:  node test/restore.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "sm-restore-" + process.pid);
fs.mkdirSync(path.join(DIR, "backups"), { recursive: true });
process.env.DATA_DIR = DIR;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

const R = require(path.join(ROOT, "server/restoreFile.js"));
const LIVE = path.join(DIR, "shop.db");

/* Build a database that looks like one of ours, with a given shape. */
function makeDb(file, opts) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY, business_name TEXT);
    CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE purchases (id TEXT PRIMARY KEY);
    CREATE TABLE cash_entries (id TEXT PRIMARY KEY, voided INTEGER DEFAULT 0);
    CREATE TABLE invoices (id TEXT PRIMARY KEY, challan_no TEXT, doc_type TEXT, created_at INTEGER);
  `);
  db.prepare("INSERT INTO settings (id,business_name) VALUES (1,?)").run(opts.name);
  for (let i = 0; i < (opts.invoices || 0); i++)
    db.prepare("INSERT INTO invoices (id,challan_no,doc_type,created_at) VALUES (?,?,'invoice',?)")
      .run("I" + i, "SP" + String(i + 1).padStart(7, "0"), 1000 + i);
  for (let i = 0; i < (opts.customers || 0); i++)
    db.prepare("INSERT INTO customers (id,name) VALUES (?,?)").run("C" + i, "Customer " + i);
  for (let i = 0; i < (opts.cash || 0); i++)
    db.prepare("INSERT INTO cash_entries (id,voided) VALUES (?,0)").run("K" + i);
  db.close();
}

/* ------------------------------------------------------------------ */
console.log("--- what it refuses, and why");

const notDb = path.join(DIR, "notes.txt");
fs.writeFileSync(notDb, "this is a text file, not a database, but it is long enough to pass a size check ".repeat(20));
let err = "";
try { R.describe(notDb); } catch (e) { err = e.message; }
ok("a file that is not a database is refused", /not a database file/i.test(err), err);
ok("and it is refused by its HEADER, not by a parser error",
   !/SQLITE|syntax|malformed/i.test(err), err);

const tiny = path.join(DIR, "tiny.db");
fs.writeFileSync(tiny, "SQLite format 3\0");
err = "";
try { R.describe(tiny); } catch (e) { err = e.message; }
ok("a truncated file is refused", /too small/i.test(err), err);

const otherApp = path.join(DIR, "other.db");
{ const d = new DatabaseSync(otherApp); d.exec("CREATE TABLE notes (id TEXT)"); d.close(); }
err = "";
try { R.describe(otherApp); } catch (e) { err = e.message; }
ok("somebody else's database is refused", /not a Shop Manager backup/i.test(err), err);
ok("and it names what was missing", /settings|staff|products/.test(err), err);

/* ------------------------------------------------------------------ */
console.log("--- reading a real backup without touching anything");

const incoming = path.join(DIR, "from-cloud.db");
makeDb(incoming, { name: "Swagat Ply", invoices: 412, customers: 63, cash: 697 });
const info = R.describe(incoming);
ok("it reports the business name", info.businessName === "Swagat Ply", info.businessName);
ok("and what is inside",
   info.counts.invoices === 412 && info.counts.customers === 63 && info.counts.cash === 697,
   JSON.stringify(info.counts));
ok("and the last document it issued", info.lastInvoice === "SP0000412", info.lastInvoice);
ok("the file it read is untouched", fs.existsSync(incoming) && fs.statSync(incoming).size > 0);

/* ------------------------------------------------------------------ */
console.log("--- staging does NOT replace the live database");

makeDb(LIVE, { name: "Swagat Ply", invoices: 0, customers: 1, cash: 1 });
/* A -wal beside it, the way a running app leaves one. */
fs.writeFileSync(LIVE + "-wal", Buffer.alloc(4096, 1));
fs.writeFileSync(LIVE + "-shm", Buffer.alloc(1024, 1));
const liveBefore = fs.statSync(LIVE).size;

const staged = path.join(DIR, "upload-copy.db");
fs.copyFileSync(incoming, staged);
R.stagePending(staged, { by: "Owner", filename: "swagat-backup.db" });

ok("the live database is exactly as it was",
   fs.statSync(LIVE).size === liveBefore, liveBefore + " -> " + fs.statSync(LIVE).size);
ok("it still holds the OLD figures",
   (() => { const d = new DatabaseSync(LIVE, { readOnly: true });
            const n = d.prepare("SELECT COUNT(*) n FROM invoices").get().n; d.close(); return n === 0; })());
ok("and the backup is parked, waiting", !!R.pending() && fs.existsSync(R.PENDING));
ok("the marker records what is in it", (R.pending().info || {}).counts.invoices === 412);
ok("and who asked for it", R.pending().by === "Owner", R.pending().by);

console.log("--- a waiting restore can be called off");
const stagedAgain = path.join(DIR, "upload-copy-2.db");
fs.copyFileSync(incoming, stagedAgain);
R.stagePending(stagedAgain, { by: "Owner" });
ok("cancel removes it", R.cancelPending() === true && !R.pending() && !fs.existsSync(R.PENDING));
ok("and the live database is STILL untouched",
   (() => { const d = new DatabaseSync(LIVE, { readOnly: true });
            const n = d.prepare("SELECT COUNT(*) n FROM invoices").get().n; d.close(); return n === 0; })());

/* ------------------------------------------------------------------ */
console.log("--- the swap, at boot");

const staged3 = path.join(DIR, "upload-copy-3.db");
fs.copyFileSync(incoming, staged3);
R.stagePending(staged3, { by: "Owner", filename: "swagat-backup.db" });

const result = R.applyPendingRestore();
ok("it reports success", result.restored === true, JSON.stringify(result));

const after = new DatabaseSync(LIVE, { readOnly: true });
const afterCounts = {
  invoices: after.prepare("SELECT COUNT(*) n FROM invoices").get().n,
  customers: after.prepare("SELECT COUNT(*) n FROM customers").get().n,
};
after.close();
ok("THE BOOKS ARE NOW THE RESTORED ONES",
   afterCounts.invoices === 412 && afterCounts.customers === 63, JSON.stringify(afterCounts));

/* The single most important line in this file. */
ok("THE OLD -wal AND -shm ARE GONE, not left to replay over the new database",
   !fs.existsSync(LIVE + "-wal") && !fs.existsSync(LIVE + "-shm"));

console.log("--- and what it replaced was kept");
ok("a before-restore snapshot exists", !!result.kept, String(result.kept));
const keptPath = path.join(DIR, "backups", result.kept);
ok("it is on disk", fs.existsSync(keptPath));
const kept = new DatabaseSync(keptPath, { readOnly: true });
const keptN = kept.prepare("SELECT COUNT(*) n FROM customers").get().n;
kept.close();
ok("and it holds the OLD shop, so the restore can be undone", keptN === 1, String(keptN));

ok("nothing is left waiting afterwards", !R.pending() && !fs.existsSync(R.PENDING));

console.log("--- a boot with nothing waiting does nothing at all");
const quiet = R.applyPendingRestore();
ok("it says so and changes nothing", quiet.restored === false && /nothing waiting/i.test(quiet.reason), quiet.reason);
ok("the database is still the restored one",
   (() => { const d = new DatabaseSync(LIVE, { readOnly: true });
            const n = d.prepare("SELECT COUNT(*) n FROM invoices").get().n; d.close(); return n === 412; })());

console.log("");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
