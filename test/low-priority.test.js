/* ============================================================
   THE LOW-PRIORITY ITEMS FROM THE 20 OCT 2026 REVIEW

     - a second customer with the same mobile, a second supplier with the
       same phone or GSTIN, and a second product with the same name were
       saved without a word. Now the screen is asked first (409 with what
       was found); "save anyway" still works.
     - the same NAME alone is not a duplicate customer — two Rameshes are real
     - a 5,000-character name was accepted
     - a bill date that is not a real day was swapped for today silently

   Routes mounted in-process on a throwaway database.
   Run:  node test/low-priority.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-lowprio-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
for (const k of ["SUPABASE_URL", "SUPABASE_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) process.env[k] = "";
const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const stockLedger = require(path.join(ROOT, "server/stockLedger.js"));
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const SHOP = db.companies.create({ name: "Low Priority Shop" });
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use((req, _res, next) => {
  req.session = { loggedIn: true, role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
  db.companies.runAs(SHOP.id, () => stockLedger.withContext({ staff: "Owner" }, next));
});
for (const r of ["customers", "suppliers", "products", "invoices"]) app.use("/api/" + r, require(path.join(ROOT, "server/routes/" + r + ".js")));
let BASE;
const call = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t };
};

const server = app.listen(0, async () => {
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  try {
    console.log("\n--- customers ---\n");
    const a = await call("POST", "/customers", { name: "Ramesh Traders", phone: "9820012345", type: "Retail Customer" });
    ok("(a first customer)", a.s === 201, a.t.slice(0, 100));
    let r = await call("POST", "/customers", { name: "Ramesh T.", phone: "+91 98200 12345", type: "Retail Customer" });
    ok("the same mobile, written differently, is asked about", r.s === 409 && r.j.duplicate && r.j.duplicate.name === "Ramesh Traders", [r.s, r.t.slice(0, 160)]);
    ok("...and the question names who is already there", /already exists: Ramesh Traders/.test(r.j && r.j.error));
    r = await call("POST", "/customers", { name: "Ramesh T.", phone: "+91 98200 12345", type: "Retail Customer", allowDuplicate: true });
    ok("\"save anyway\" still saves it", r.s === 201, [r.s, r.t.slice(0, 100)]);
    r = await call("POST", "/customers", { name: "Ramesh Traders", phone: "9000099999", type: "Retail Customer" });
    ok("the same NAME with a different mobile is NOT asked about (two Rameshes are real)", r.s === 201, [r.s, r.t.slice(0, 100)]);
    const b = r.j;
    r = await call("PUT", `/customers/${b.id}`, { phone: "9820012345" });
    ok("changing a customer's mobile to one another customer has is asked about", r.s === 409, [r.s, r.t.slice(0, 120)]);
    r = await call("PUT", `/customers/${b.id}`, { address: "New Address" });
    ok("an ordinary edit is not asked about", r.s === 200, [r.s, r.t.slice(0, 120)]);
    r = await call("POST", "/customers", { name: "X".repeat(5000), phone: "9111111111" });
    ok("a 5,000-character name is refused, with the reason", r.s === 400 && /too long/.test(r.t), [r.s, r.t.slice(0, 120)]);
    r = await call("POST", "/customers", { name: "M/s Shree Ganesh Plywood & Hardware Traders Pvt. Ltd.", phone: "9222222222", type: "Retail Customer" });
    ok("a long but real firm name is fine", r.s === 201, [r.s, r.t.slice(0, 100)]);

    console.log("\n--- suppliers ---\n");
    await call("POST", "/suppliers", { name: "Century Ply Depot", phone: "9833300000", gst: "27AAACC1234A1Z5" });
    r = await call("POST", "/suppliers", { name: "Century Depot (2)", phone: "9000000001", gst: "27aaacc1234a1z5" });
    ok("the same GSTIN is asked about", r.s === 409 && /GSTIN/.test(r.t), [r.s, r.t.slice(0, 120)]);
    r = await call("POST", "/suppliers", { name: "Another Depot", phone: "98333 00000" });
    ok("the same phone is asked about", r.s === 409, [r.s, r.t.slice(0, 120)]);
    r = await call("POST", "/suppliers", { name: "Different Depot", phone: "9000000002", gst: "27BBBBB1234B1Z5" });
    ok("a different supplier is saved as usual", r.s === 201, [r.s, r.t.slice(0, 100)]);

    console.log("\n--- products ---\n");
    const prod = (name, extra) => call("POST", "/products", Object.assign({ name, unit: "Sheet", gst: 18, sizes: [{ label: "8x4", price: 1000, stock: 10 }] }, extra || {}));
    const p1 = await prod("Century Club Prime 18mm");
    ok("(a first product)", p1.s === 201, p1.t.slice(0, 100));
    r = await prod("  century club prime  18MM ");
    ok("the same name, different case and spaces, is asked about", r.s === 409 && r.j.duplicate.name === "Century Club Prime 18mm", [r.s, r.t.slice(0, 120)]);
    r = await prod("century club prime 18mm", { allowDuplicate: true });
    ok("\"save anyway\" still saves it", r.s === 201, [r.s, r.t.slice(0, 100)]);
    const p2 = await prod("Greenply 12mm");
    r = await call("PUT", `/products/${p2.j.id}`, { name: "Century Club Prime 18mm", gst: 18 });
    ok("renaming to a name another product has is asked about", r.s === 409, [r.s, r.t.slice(0, 120)]);
    r = await call("PUT", `/products/${p2.j.id}`, { name: "Greenply 12mm", gst: 5 });
    ok("an edit that keeps its own name is not asked about", r.s === 200, [r.s, r.t.slice(0, 120)]);
    r = await prod("P".repeat(400));
    ok("an oversized product name is refused", r.s === 400 && /too long/.test(r.t), [r.s, r.t.slice(0, 100)]);

    console.log("\n--- bill dates ---\n");
    const size = p1.j.sizes[0].id;
    const bill = date => call("POST", "/invoices", Object.assign({ customerId: a.j.id, paymentMethod: "Credit", advance: 0,
      items: [{ productId: p1.j.id, sizeId: size, name: p1.j.name, sizeLabel: "8x4", pieces: 1, qty: 1, rate: 1000, gstRate: 18, unitLabel: "Sheet", mode: "UNIT" }] },
      date === undefined ? {} : { date }));
    r = await bill("2026-02-30");
    ok("30 February is refused (it used to become today, silently)", r.s === 400 && /not a real date/.test(r.t), [r.s, r.t.slice(0, 120)]);
    r = await bill("not-a-date");
    ok("text that is not a date is refused too", r.s === 400, r.s);
    r = await bill("2026-10-21");
    ok("a real date is used as given", r.s === 201 && (r.j.date === "2026-10-21"), [r.s, r.j && r.j.date]);
    r = await bill(undefined);
    ok("no date at all still means today", r.s === 201, [r.s, r.t.slice(0, 100)]);
  } catch (e) { console.error(e); fail++; }
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); process.exit(fail ? 1 : 0);
});
