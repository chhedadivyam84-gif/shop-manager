/* ============================================================
   COMPANY ISOLATION, AND THE APP THAT WAS ALREADY THERE

   Two things this proves, because both are claims the import module makes
   about itself and neither is worth taking on trust:

   1. Importing into one company cannot be seen from another. Isolation
      here is physical — a separate SQLite file per company — so the claim
      is really "no code path reaches across", and the way to test that is
      to import into A and then go and look in B.

   2. The app that existed before still behaves. A module that leaves the
      invoices readable but quietly changes what a cash book totals to has
      broken the shop just as surely as one that crashes.

   Run:  node test/import-isolation.test.js <a scratch DATA_DIR>
   It builds its own companies and never touches a real one.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = process.argv[2] || path.join(os.tmpdir(), "sm-isolation-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const root = path.join(__dirname, "..");
const db = require(path.join(root, "server/db.js"));
const P = require(path.join(root, "server/importParse.js"));
const M = require(path.join(root, "server/importMap.js"));
const R = require(path.join(root, "server/importRun.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x ? "   " + x : "")); }
};
const inCo = (id, fn) => db.companies.runAs(id, fn);
const csv = s => Buffer.from(s, "utf8");

/* ------------------------------------------------------------------ */
console.log("--- two companies, side by side");

const A = db.companies.create({ name: "Isolation Test A" });
const B = db.companies.create({ name: "Isolation Test B" });
ok("two companies exist", A.id !== B.id, A.id + " / " + B.id);
ok("each has its own file",
   db.companies.file(A.id) !== db.companies.file(B.id),
   db.companies.file(A.id));

const countsIn = id => inCo(id, () => ({
  hist:      db.prepare("SELECT COUNT(*) n FROM hist_sales").get().n,
  batches:   db.prepare("SELECT COUNT(*) n FROM import_batches").get().n,
  customers: db.prepare("SELECT COUNT(*) n FROM customers").get().n,
  stock:     db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM size_location_stock").get().q,
}));

const before = { A: countsIn(A.id), B: countsIn(B.id) };
ok("both start empty of history",
   before.A.hist === 0 && before.B.hist === 0 && before.A.batches === 0 && before.B.batches === 0,
   JSON.stringify(before));

/* ------------------------------------------------------------------ */
console.log("--- an import into A is invisible from B");

const salesCsv = [
  "Date,Vch No.,Particulars,Gross Total",
  "12-Aug-2024,ISO-1,Company A Customer,\"1,00,000.00\"",
  "13-Aug-2024,ISO-2,Another A Party,\"25,000.00\"",
].join("\n");

const importInto = (id, category, text) => inCo(id, () => {
  const f = P.readFile({ filename: "iso.csv", buffer: csv(text) });
  const { mapping } = M.autoMap(f.headers, category);
  const v = M.validate({ rows: f.rows, mapping, category, closedYearsRefused: true });
  return R.run({ category, filename: "iso.csv", rows: v.rows,
                 take: v.rows.filter(r => r.status !== "error").map(r => r.rowNo),
                 mapping, staff: "ISO" });
});

const runA = importInto(A.id, "sales", salesCsv);
ok("A took both rows", runA.counts.imported === 2, JSON.stringify(runA.counts));

const afterFirst = { A: countsIn(A.id), B: countsIn(B.id) };
ok("A now holds the history", afterFirst.A.hist === 2, String(afterFirst.A.hist));
ok("B HOLDS NOTHING", afterFirst.B.hist === 0 && afterFirst.B.batches === 0,
   JSON.stringify(afterFirst.B));
ok("B's customers untouched", afterFirst.B.customers === before.B.customers,
   before.B.customers + " -> " + afterFirst.B.customers);

/* The batch id from A must not be reachable, readable or reversible from B.
   This is the one that would matter if isolation were a filter rather than
   a file: a forged id is the obvious way in. */
const seenFromB = inCo(B.id, () => R.batchDetail(runA.batchId));
ok("A's batch cannot be READ from B", seenFromB === null, JSON.stringify(seenFromB));

let reverseErr = "";
try { inCo(B.id, () => R.reverse(runA.batchId, "ISO")); }
catch (e) { reverseErr = e.message; }
ok("A's batch cannot be UNDONE from B", /not found/i.test(reverseErr), reverseErr);
ok("A's history survived the attempt", countsIn(A.id).hist === 2, String(countsIn(A.id).hist));

/* ------------------------------------------------------------------ */
console.log("--- and the other way round");

const runB = importInto(B.id, "sales", [
  "Date,Vch No.,Particulars,Gross Total",
  "01-Sep-2024,B-1,Company B Customer,\"7,000.00\"",
].join("\n"));
ok("B took its own row", runB.counts.imported === 1, JSON.stringify(runB.counts));

const both = { A: countsIn(A.id), B: countsIn(B.id) };
ok("A still has exactly its own two", both.A.hist === 2, String(both.A.hist));
ok("B has exactly its own one", both.B.hist === 1, String(both.B.hist));

const partiesA = inCo(A.id, () => db.prepare("SELECT party FROM hist_sales ORDER BY party").all().map(r => r.party));
const partiesB = inCo(B.id, () => db.prepare("SELECT party FROM hist_sales ORDER BY party").all().map(r => r.party));
ok("no row crossed over",
   !partiesA.some(p => /Company B/.test(p)) && !partiesB.some(p => /Company A/.test(p)),
   JSON.stringify({ partiesA, partiesB }));

/* A party created by an import belongs to one company only. */
const custCsv = "Name,Phone\nIsolation Party,9876500000\n";
importInto(A.id, "customers", custCsv);
const inA = inCo(A.id, () => db.prepare("SELECT COUNT(*) n FROM customers WHERE name='Isolation Party'").get().n);
const inB = inCo(B.id, () => db.prepare("SELECT COUNT(*) n FROM customers WHERE name='Isolation Party'").get().n);
ok("a party imported into A exists in A", inA === 1, String(inA));
ok("and does not exist in B", inB === 0, String(inB));

/* ------------------------------------------------------------------ */
console.log("--- undoing in A leaves B alone");

const rev = inCo(A.id, () => R.reverse(runA.batchId, "ISO"));
ok("A's first batch undone", rev.removed === 2, JSON.stringify(rev));
const end = { A: countsIn(A.id), B: countsIn(B.id) };
ok("A back to its remaining rows", end.A.hist === 0, String(end.A.hist));
ok("B still has its one row", end.B.hist === 1, String(end.B.hist));

/* ------------------------------------------------------------------ */
console.log("--- stock is untouched in both, by everything above");

ok("A's stock never moved", end.A.stock === before.A.stock, before.A.stock + " -> " + end.A.stock);
ok("B's stock never moved", end.B.stock === before.B.stock, before.B.stock + " -> " + end.B.stock);

/* ------------------------------------------------------------------ */
console.log("");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
