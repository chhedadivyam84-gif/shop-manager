/* ============================================================
   DOES THE BACKUP CHECKER ACTUALLY CATCH ANYTHING?

   A verifier that passes everything is worse than no verifier, because
   somebody then believes it. So this file does not check that a good
   backup passes — that is the easy half, and it is here for completeness.
   It breaks a backup in each of the ways a backup actually breaks, and
   insists the checker says so and exits non-zero.

   Every scenario works on a COPY, in its own temporary directory. No
   production data is read, written, or reachable from here: the fixture
   is a shop invented three lines below.

   Run:  node test/backup-verify.test.js
   ============================================================ */
const fs = require("fs"), os = require("os"), path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools/verify-backup.js");

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};

/* ------------------------------------------------------------------ */
/* One good backup, made once, then copied for each scenario           */
/* ------------------------------------------------------------------ */

const SEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dr-seed-"));

const SEED = `
const db = require(${JSON.stringify(path.join(ROOT, "server/db.js"))});
const backup = require(${JSON.stringify(path.join(ROOT, "server/backup.js"))});
const c = db.companies.list()[0];
db.companies.runAs(c.id, () => {
  db.prepare("INSERT INTO products (id,name,brand,category,sku,unit,gst_rate,stock,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("P1","Green Gold Ply","Greenply","Plywood","GG1","Sheet",18,10,Date.now());
  db.prepare("INSERT INTO customers (id,name,phone,due,created_at,active) VALUES (?,?,?,?,?,1)")
    .run("C1","Ramesh Traders","98200",500,Date.now());
  db.prepare("INSERT INTO invoices (id,challan_no,doc_type,date,created_at,customer_id,subtotal,total,balance_due) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("I1","B-1","invoice","2026-10-09",Date.now(),"C1",1000,1000,500);
  db.prepare("INSERT INTO invoice_items (invoice_id,product_id,name,mode,qty,rate) VALUES (?,?,?,?,?,?)")
    .run("I1","P1","Green Gold Ply","UNIT",1,1000);
});
backup.runBackup("test").then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
`;

execFileSync(process.execPath, ["-e", SEED], {
  env: { ...process.env, DATA_DIR: SEED_DIR }, stdio: "pipe",
});

const SEED_BACKUPS = path.join(SEED_DIR, "backups");
const GOOD = fs.readdirSync(SEED_BACKUPS);
const DB_FILE = GOOD.find(f => f.endsWith(".db") && !f.includes("--"));
const STAMP = (/^shop-(.+)\.db$/.exec(DB_FILE) || [])[1];

/** A fresh DATA_DIR holding a copy of the good backup, ready to be broken. */
function scenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-case-"));
  const backups = path.join(dir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  for (const f of GOOD) fs.copyFileSync(path.join(SEED_BACKUPS, f), path.join(backups, f));
  return { dir, backups, db: path.join(backups, DB_FILE) };
}

/** Run the checker against a directory and report how it went. */
function check(dir, args) {
  const r = spawnSync(process.execPath, [TOOL, ...(args || [])], {
    env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/* ------------------------------------------------------------------ */

console.log("\n--- a backup that is actually fine ---\n");
{
  const s = scenario();
  const r = check(s.dir);
  ok("it passes", r.code === 0, r.out.slice(-400));
  ok("...and says what it checked", /integrity check passed/.test(r.out));
  ok("...including that the records still point at each other",
     /points at something that exists/.test(r.out));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- a backup that never finished writing ---\n");
{
  const s = scenario();
  fs.writeFileSync(s.db, "");                       // zero bytes
  const r = check(s.dir);
  ok("an empty file is caught", r.code !== 0, r.code);
  ok("...and named as empty", /ZERO BYTE/i.test(r.out), r.out.slice(-300));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- something that is not a database at all ---\n");
{
  const s = scenario();
  fs.writeFileSync(s.db, "<!DOCTYPE html><h1>403 Forbidden</h1>");
  /* Not invented: a store that answers an error page with HTTP 200 is how
     a "backup" becomes a web page nobody looked at. */
  const r = check(s.dir);
  ok("an error page saved as a backup is caught", r.code !== 0, r.code);
  ok("...and named as not-a-database", /not a SQLite database/i.test(r.out), r.out.slice(-300));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- a file that is corrupt in the middle ---\n");
{
  const s = scenario();
  const buf = fs.readFileSync(s.db);
  /* The header is left intact ON PURPOSE. A check that only reads the
     first sixteen bytes would pass this, which is the entire reason
     SQLite is asked for its own opinion. */
  buf.fill(0x5a, 40000, 140000);
  fs.writeFileSync(s.db, buf);
  const r = check(s.dir);
  ok("corruption past the header is caught", r.code !== 0, r.code);
  ok("...by SQLite's own integrity check, not by guesswork",
     /integrity check|could not be opened|could not be read|could not count/i.test(r.out), r.out.slice(-400));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- a database missing a table a shop cannot work without ---\n");
{
  const s = scenario();
  const d = new DatabaseSync(s.db);
  d.exec("DROP TABLE invoice_items");
  d.close();
  const r = check(s.dir);
  ok("a dropped table is caught", r.code !== 0, r.code);
  ok("...and named", /missing tables|invoice_items/i.test(r.out), r.out.slice(-300));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- THE ONE A ROW COUNT WOULD MISS ---\n");
{
  /* Every table present, every count healthy, and the bill belongs to a
     customer who is not in the file. This is what "do not rely on record
     counts alone" means in practice. */
  const s = scenario();
  const d = new DatabaseSync(s.db);
  d.exec("PRAGMA foreign_keys = OFF");
  d.exec("DELETE FROM customers WHERE id = 'C1'");
  d.close();

  const after = new DatabaseSync(s.db, { readOnly: true });
  const stillThere = after.prepare("SELECT COUNT(*) AS n FROM invoices").get().n;
  after.close();
  ok("the bill is still counted, so counts alone look fine", stillThere === 1, stillThere);

  const r = check(s.dir);
  ok("BUT THE BROKEN RELATIONSHIP IS CAUGHT", r.code !== 0, r.code);
  ok("...and described in words an operator can act on",
     /customer no longer exists/i.test(r.out), r.out.slice(-400));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- a bill line pointing at a product that is gone ---\n");
{
  const s = scenario();
  const d = new DatabaseSync(s.db);
  d.exec("PRAGMA foreign_keys = OFF");
  d.exec("DELETE FROM products WHERE id = 'P1'");
  d.close();
  const r = check(s.dir);
  ok("it is caught", r.code !== 0, r.code);
  ok("...and named", /product no longer exists/i.test(r.out), r.out.slice(-300));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- a registry that cannot be read ---\n");
{
  const s = scenario();
  const reg = path.join(s.backups, `shop-${STAMP}--registry.json`);
  if (fs.existsSync(reg)) {
    fs.writeFileSync(reg, "{ this is not json");
    const r = check(s.dir);
    ok("a damaged registry is caught", r.code !== 0, r.code);
    ok("...and named", /registry is not readable/i.test(r.out), r.out.slice(-300));
  } else {
    ok("a damaged registry is caught (no registry in fixture — skipped)", true);
    ok("...and named (skipped)", true);
  }
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- a shop login pointing at books that are not in the backup ---\n");
{
  /* The orphaning that loses a shop its history: the tenant map survives,
     the company it names does not, and the app starts an empty company
     beside the real one. */
  const s = scenario();
  const ten = path.join(s.backups, `shop-${STAMP}--tenants.db`);
  const t = new DatabaseSync(ten);
  t.exec(`CREATE TABLE IF NOT EXISTS tenants (
            username TEXT PRIMARY KEY, company_id TEXT NOT NULL, shop_name TEXT DEFAULT '',
            code TEXT DEFAULT '', plan TEXT DEFAULT 'paid', expires_on TEXT DEFAULT '',
            password_hash TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0,
            last_seen_at INTEGER, blocked INTEGER NOT NULL DEFAULT 0, features_off TEXT DEFAULT '')`);
  t.prepare("INSERT OR REPLACE INTO tenants (username,company_id,created_at) VALUES (?,?,?)")
    .run("9820011111", "company-that-is-not-here", Date.now());
  t.close();

  const r = check(s.dir);
  ok("A LOGIN WITH NO BOOKS IS CAUGHT", r.code !== 0, r.code);
  ok("...and the login is named, so it can be chased",
     /9820011111|NOT in this backup/i.test(r.out), r.out.slice(-400));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- nothing to check at all ---\n");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-empty-"));
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
  const r = check(dir);
  ok("an empty backup directory is a failure, not a pass", r.code !== 0, r.code);
  ok("...and says so plainly", /No local backups/i.test(r.out), r.out.slice(-200));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n--- asking the cloud when no cloud is configured ---\n");
{
  const s = scenario();
  const r = spawnSync(process.execPath, [TOOL, "--cloud"], {
    env: {
      ...process.env, DATA_DIR: s.dir,
      SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "",
      R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
    },
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  ok("missing credentials do not look like a healthy backup", r.status !== 0, r.status);
  ok("...and the message says what is missing", /No cloud backup store is configured/i.test(out), out.slice(-300));
  ok("...without printing any credential", !/AIza|sk-|eyJ|ya29\./.test(out));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log("\n--- the checker itself is harmless ---\n");
{
  const src = fs.readFileSync(TOOL, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("it never deletes from the cloud", !/\bremove\s*\(|deleteCloudRuns/.test(src));
  ok("it never uploads", !/\bupload\s*\(/.test(src));
  ok("it never runs a backup", !/runBackup/.test(src));
  ok("it opens databases read-only", /readOnly:\s*true/.test(src));

  /* It must not have left anything behind in the seed directory either. */
  const before = fs.readdirSync(SEED_BACKUPS).sort().join("|");
  check(SEED_DIR);
  const after = fs.readdirSync(SEED_BACKUPS).sort().join("|");
  ok("running it changes nothing on disk", before === after);
}

fs.rmSync(SEED_DIR, { recursive: true, force: true });
console.log(`\n==============================================`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`==============================================\n`);
process.exitCode = fail ? 1 : 0;
