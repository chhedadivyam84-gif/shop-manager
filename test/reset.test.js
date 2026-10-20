/* ============================================================
   CLEAR ALL BILLS / WIPE ALL SHOP DATA — they finish, and they clear what they say

   On 12 Oct 2026 "Wipe All Shop Data" failed on the live shop three times
   with "FOREIGN KEY constraint failed": e-way bills and e-invoices point at
   invoices with no cascade, and they were not on the list, so deleting the
   invoices was refused. The transaction rolled back and nothing was lost —
   and nothing was cleared, and the screen said only "Something went wrong".

   Against the real server on a throwaway data folder, with a bill that has
   an e-way bill and an e-invoice — the exact state that failed:
     - Clear All Bills removes the documents and the book lines their
       payments posted, keeps products / customers / manual book lines
     - Wipe All Shop Data removes all of it and keeps the set-up
     - both leave no row pointing at a deleted one
     - wrong PIN / phrase, or staff, are refused and delete nothing

   Run:  node test/reset.test.js
   ============================================================ */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-reset-"));
const PORT = 4886;
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(process.execPath, ["--no-warnings", "server/index.js"], { cwd: ROOT,
  env: { ...process.env, DATA_DIR, PORT: String(PORT), SUPABASE_URL: "", SUPABASE_KEY: "", R2_ACCOUNT_ID: "" } });
let out = ""; srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
process.on("exit", () => { try { srv.kill(); } catch (e) {} });
function jar() {
  let cookie = "";
  return async (m, u, b) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${u}`, { method: m,
      headers: Object.assign({ "content-type": "application/json" }, cookie ? { cookie } : {}), body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, j, t };
  };
}

(async () => {
  for (let i = 0; i < 120 && !/running on port/.test(out); i++) await sleep(250);
  /* Opened by this process too, on the same file: to seed what has no
     public route (e-way bill and e-invoice records) and to count. */
  process.env.DATA_DIR = DATA_DIR;
  const db = require(path.join(ROOT, "server/db.js"));
  const inDb = fn => db.companies.runAs(db.companies.defaultId(), fn);
  const count = t => inDb(() => db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n);
  /* Fill a row, giving any required column with no default a plain value. */
  const insertRow = (table, values) => inDb(() => {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
    const row = { ...values };
    for (const c of cols) if (c.notnull && c.dflt_value == null && !c.pk && !(c.name in row)) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : "";
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]));
  });

  const owner = jar();
  const firstLogin = await owner("POST", "/auth/login", { staffId: "STAFF_owner", pin: "1234" });
  /* An owner on the starting PIN must choose their own before anything else. */
  if (firstLogin.j && firstLogin.j.mustChangePin) await owner("PUT", "/staff/STAFF_owner", { pin: "9753" });
  const seedShop = async (tag) => {
    const c = (await owner("POST", "/customers", { name: "Reset Customer " + tag, phone: "90000" + String(10000 + tag).slice(-5), type: "Retail Customer" })).j;
    const p = (await owner("POST", "/products", { name: "Reset Ply " + tag, unit: "Sheet", gst: 18, category: "Plywood",
      sizes: [{ label: "8x4", price: 1000, stock: 50 }] })).j;
    const sizeId = p && p.sizes && p.sizes[0] && p.sizes[0].id;
    const inv = (await owner("POST", "/invoices", { customerId: c.id, paymentMethod: "Credit", advance: 0, date: new Date().toISOString().slice(0, 10),
      items: [{ productId: p.id, sizeId, name: p.name, sizeLabel: "8x4", pieces: 2, qty: 2, rate: 1000, gstRate: 18, unitLabel: "Sheet", mode: "UNIT" }] })).j;
    await owner("POST", `/customers/${c.id}/payments`, { amount: 500, method: "Cash", invoiceId: inv.id, idempotencyKey: "reset-test-pay-" + tag + "-abc" });
    insertRow("ewb_bills", { id: "EWB_" + tag, invoice_id: inv.id, created_at: Date.now(), updated_at: Date.now() });
    insertRow("einvoices", { id: "EINV_" + tag, invoice_id: inv.id, created_at: Date.now(), updated_at: Date.now() });
    return { c, p, inv };
  };
  const first = await seedShop(1);
  ok("a bill with an e-way bill and an e-invoice exists — the state that failed live",
     count("invoices") === 1 && count("ewb_bills") === 1 && count("einvoices") === 1, [count("invoices"), count("ewb_bills"), count("einvoices")]);
  ok("its payment posted a cash book line", inDb(() => db.prepare("SELECT COUNT(*) n FROM cash_entries WHERE source_type='payment'").get().n) === 1);
  const manual = await owner("POST", "/cashbook", { date: new Date().toISOString().slice(0, 10), type: "out", amount: 75, category: "Tea", remarks: "typed by hand" });
  ok("a cash book line typed by hand exists", manual.status === 201 || manual.status === 200, [manual.status, manual.j && manual.j.error]);

  console.log("\n--- refused without the owner, the PIN and the words ---\n");
  const before = count("invoices");
  ok("a wrong PIN is refused", (await owner("POST", "/reset", { pin: "0000", confirmText: "DELETE ALL DATA" })).status === 401);
  ok("the wrong words are refused", (await owner("POST", "/reset", { pin: "9753", confirmText: "delete" })).status === 400);
  ok("...and nothing was deleted", count("invoices") === before);

  console.log("\n--- Clear All Bills ---\n");
  let r = await owner("POST", "/reset", { pin: "9753", confirmText: "DELETE ALL BILLS", scope: "bills" });
  ok("IT FINISHES (it failed with FOREIGN KEY before)", r.status === 200 && r.j && r.j.ok, [r.status, r.t.slice(0, 200)]);
  ok("bills, e-way bills and e-invoices are gone", count("invoices") === 0 && count("ewb_bills") === 0 && count("einvoices") === 0);
  ok("payments are gone", count("payments") === 0);
  ok("the cash book line the payment posted is gone", inDb(() => db.prepare("SELECT COUNT(*) n FROM cash_entries WHERE source_type='payment'").get().n) === 0);
  ok("the hand-typed cash book line is kept", inDb(() => db.prepare("SELECT COUNT(*) n FROM cash_entries WHERE remarks='typed by hand'").get().n) === 1);
  ok("customers and products are kept", count("customers") === 1 && count("products") === 1);
  ok("the customer owes nothing now", inDb(() => db.prepare("SELECT due FROM customers").get().due) === 0);
  ok("a safety backup was named", !!(r.j && r.j.backupFile), r.j);
  ok("no row is left pointing at a deleted one", inDb(() => db.prepare("PRAGMA foreign_key_check").all().length) === 0,
     inDb(() => db.prepare("PRAGMA foreign_key_check").all().slice(0, 3)));

  console.log("\n--- Wipe All Shop Data ---\n");
  await sleep(1100);   // safety-backup names are stamped to the second
  await seedShop(2);
  insertRow("selection_slips", { id: "SS_1", slip_no: "SS-1", date: "2026-10-12", created_at: Date.now() });
  r = await owner("POST", "/reset", { pin: "9753", confirmText: "DELETE ALL DATA" });
  ok("IT FINISHES", r.status === 200 && r.j && r.j.ok, [r.status, r.t.slice(0, 200)]);
  for (const t of ["invoices", "ewb_bills", "einvoices", "payments", "customers", "suppliers", "products", "product_sizes",
                   "cash_entries", "selection_slips", "size_location_stock", "stock_ledger", "audit_log"]) {
    ok(`${t} is empty`, count(t) === 0, count(t));
  }
  ok("the set-up is kept: settings, staff, locations", count("settings") === 1 && count("staff") >= 1 && count("locations") >= 1);

  /* THE WIPE MUST STICK. A restart restores the NEWEST backup; before this
     the newest was the pre-wipe safety copy, so the data came back. */
  ok("the reply names the backup of the cleared shop", !!(r.j && r.j.clearedBackupFile) && r.j.clearedBackupSaved === true, r.j);
  const backups = fs.readdirSync(path.join(DATA_DIR, "backups")).filter(n => /^shop-\d{8}-\d{6}.*\.db$/.test(n) && !/tenants/.test(n)).sort();
  const newest = backups[backups.length - 1];
  ok("the NEWEST backup is the cleared shop, not the safety copy", newest && newest.startsWith(r.j.clearedBackupFile.replace(/\.db$/, "")) && r.j.clearedBackupFile > r.j.backupFile,
     { newest, cleared: r.j.clearedBackupFile, safety: r.j.backupFile });
  {
    const { DatabaseSync } = require("node:sqlite");
    const b = new DatabaseSync(path.join(DATA_DIR, "backups", newest), { readOnly: true });
    const n = t => b.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
    ok("...and it opens EMPTY: no bills, customers or products", n("invoices") === 0 && n("customers") === 0 && n("products") === 0,
       [n("invoices"), n("customers"), n("products")]);
    b.close();
  }
  {
    const { DatabaseSync } = require("node:sqlite");
    const b = new DatabaseSync(path.join(DATA_DIR, "backups", r.j.backupFile), { readOnly: true });
    ok("the safety copy from before the wipe is still kept (nothing deleted)", b.prepare("SELECT COUNT(*) n FROM invoices").get().n === 1);
    b.close();
  }
  ok("no row is left pointing at a deleted one", inDb(() => db.prepare("PRAGMA foreign_key_check").all().length) === 0);
  ok("the owner can still sign in", (await jar()("POST", "/auth/login", { staffId: "STAFF_owner", pin: "9753" })).status === 200);

  srv.kill(); await sleep(300);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e, out.slice(-500)); srv.kill(); process.exitCode = 1; });
