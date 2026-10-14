/* ============================================================
   THE EMPTY-DATABASE GUARD MUST NOT THROW AWAY A SHOP'S LOGINS

   On 14 Oct 2026 the hosted copy logged "[backup] REFUSED … no business
   has any products, customers …" at every run and "no backups found in
   bucket yet" at every boot. Shops had signed up and added staff but no
   products, the guard called that empty, and each time the free host
   slept every shop's sign-in and staff were lost.

   On a throwaway data folder, with no cloud:
     - a really empty install is still refused (the guard still works)
     - a shop sign-in (a tenant row) is backed up
     - a staff member beyond the seeded owner is backed up
     - a product is backed up, as before

   Run:  node test/backup-guard.test.js
   ============================================================ */
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-guard-"));
for (const k of ["SUPABASE_URL", "SUPABASE_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) process.env[k] = "";

(async () => {
  const db = require(path.join(ROOT, "server/db.js"));
  const backup = require(path.join(ROOT, "server/backup.js"));
  const tenants = require(path.join(ROOT, "server/tenants.js"));
  const inDb = fn => db.companies.runAs(db.companies.defaultId(), fn);

  let r = await backup.runBackup("test-empty");
  ok("a really empty install is still refused", r && r.refused === true, r);

  tenants.upsert({ username: "9000000001", companyId: db.companies.defaultId(), shopName: "Test Shop",
                   code: "TESTCODE", plan: "paid", passwordHash: tenants.hash("pw-for-test") });
  r = await backup.runBackup("test-tenant");
  ok("a shop sign-in alone is now backed up", r && !r.refused, r && r.reason);
  ok("...and the backup includes the sign-ins file",
     fs.readdirSync(path.join(process.env.DATA_DIR, "backups")).some(n => /--tenants\.db$/.test(n)));

  /* Staff only, no tenant: the single-shop install. */
  tenants.open().exec("DELETE FROM tenants");
  ok("(no tenant left for the next check)", tenants.count() === 0);
  r = await backup.runBackup("test-empty-again");
  ok("empty again is refused again", r && r.refused === true, r);
  inDb(() => {
    const cols = db.prepare("PRAGMA table_info(staff)").all();
    const row = { id: "STAFF_test1", name: "Counter Staff" };
    for (const c of cols) if (c.notnull && c.dflt_value == null && !c.pk && !(c.name in row)) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : "x";
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO staff (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]));
  });
  await sleep(1100);   // backup names are stamped to the second
  r = await backup.runBackup("test-staff");
  ok("a staff member beyond the seeded owner is backed up", r && !r.refused, r && r.reason);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
