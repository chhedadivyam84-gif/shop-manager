/* ============================================================
   INPUT CHECKS — numbers that cannot be right are refused, with a reason

   Found 20 Oct 2026, all accepted without a word:
     - a product price of -100
     - a GST rate of 999%
     - a stock count of -50, which silently saved as 0
     - a bill rate of 10^15, giving a bill of more than ₹100 crore
   And the ones that were already right, kept right:
     - price 0, GST 0 / 5 / 18 / 28 / 40, stock 0
     - an ordinary bill

   Routes mounted in-process on a throwaway database, as invoice-create
   does, so the sold copy's activation step does not get in the way.

   Run:  node test/input-checks.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-inputchecks-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const stockLedger = require(path.join(ROOT, "server/stockLedger.js"));
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const SHOP = db.companies.create({ name: "Input Check Shop" });
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use((req, _res, next) => {
  req.session = { loggedIn: true, role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
  db.companies.runAs(SHOP.id, () => stockLedger.withContext({ staff: "Owner" }, next));
});
app.use("/api/products", require(path.join(ROOT, "server/routes/products.js")));
app.use("/api/customers", require(path.join(ROOT, "server/routes/customers.js")));
app.use("/api/invoices", require(path.join(ROOT, "server/routes/invoices.js")));
app.use((err, req, res, next) => { console.error("[test] unhandled:", err && err.message); res.status(500).json({ error: "x" }); });
let BASE;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t };
};
const product = (over, sizes) => call("POST", "/api/products", Object.assign(
  { name: "Ply " + Math.random().toString(36).slice(2, 7), unit: "Sheet", gst: 18, category: "Plywood",
    sizes: sizes || [{ label: "8x4", price: 1000, stock: 10 }] }, over || {}));

const server = app.listen(0, async () => {
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    console.log("\n--- products ---\n");
    let r = await product({}, [{ label: "8x4", price: -100, stock: 5 }]);
    ok("a negative price is refused, and says so", r.s === 400 && /price for 8x4 cannot be negative/.test(r.t), [r.s, r.t]);
    r = await product({}, [{ label: "8x4", price: 100, stock: -50 }]);
    ok("a negative stock is refused (it used to save as 0 without a word)", r.s === 400 && /stock for 8x4 cannot be negative/.test(r.t), [r.s, r.t]);
    r = await product({ gst: 999 });
    ok("a GST rate of 999% is refused", r.s === 400 && /between 0 and 40/.test(r.t), [r.s, r.t]);
    r = await product({ gst: -5 });
    ok("a negative GST rate is refused", r.s === 400, r.s);
    for (const g of [0, 0.25, 3, 5, 12, 18, 28, 40]) {
      r = await product({ gst: g });
      ok(`GST ${g}% is still accepted`, r.s === 201, [r.s, r.t.slice(0, 100)]);
    }
    r = await product({}, [{ label: "Free sample", price: 0, stock: 0 }]);
    ok("a price of 0 and a stock of 0 are still accepted", r.s === 201, [r.s, r.t.slice(0, 100)]);
    const good = (await product({ name: "Edit Me Ply" })).j;
    r = await call("PUT", `/api/products/${good.id}`, { name: "Edit Me Ply", gst: 18, sizes: [{ id: good.sizes[0].id, label: "8x4", price: -1, stock: 10 }] });
    ok("editing a price to negative is refused too", r.s === 400, [r.s, r.t.slice(0, 100)]);
    r = await call("PUT", `/api/products/${good.id}`, { name: "Edit Me Ply", gst: 400 });
    ok("editing GST to 400% is refused too", r.s === 400, [r.s, r.t.slice(0, 100)]);
    r = await call("PUT", `/api/products/${good.id}`, { name: "Edit Me Ply Renamed", gst: 5 });
    ok("an ordinary edit still works", r.s === 200, [r.s, r.t.slice(0, 100)]);

    console.log("\n--- bills ---\n");
    const cust = (await call("POST", "/api/customers", { name: "Check Buyer", phone: "9000007777", type: "Retail Customer" })).j;
    const p = (await product({ name: "Bill Ply" }, [{ label: "8x4", price: 1000, stock: 100 }])).j;
    const line = rate => ({ productId: p.id, sizeId: p.sizes[0].id, name: p.name, sizeLabel: "8x4", pieces: 1, qty: 1, rate, gstRate: 18, unitLabel: "Sheet", mode: "UNIT" });
    const bill = rate => call("POST", "/api/invoices", { customerId: cust.id, paymentMethod: "Credit", advance: 0, date: new Date().toISOString().slice(0, 10), items: [line(rate)] });
    r = await bill(1e15);
    ok("a bill of more than ₹100 crore is refused as a likely typo", r.s === 400 && /100 crore/.test(r.t), [r.s, r.t.slice(0, 120)]);
    r = await bill(1000);
    ok("an ordinary bill still goes through", r.s === 201, [r.s, r.t.slice(0, 120)]);
    r = await bill(5e7);
    ok("a large but real bill (₹5 crore) still goes through", r.s === 201, [r.s, r.t.slice(0, 120)]);
  } catch (e) { console.error(e); fail++; }
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); process.exit(fail ? 1 : 0);
});
