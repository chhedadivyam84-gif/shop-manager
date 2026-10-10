/* ============================================================
   SALES, INVOICES AND PAYMENTS — the whole path, end to end

   A bill raised at the counter, paid in part or in full or not at all,
   paid later in one go or in pieces, retried, cancelled — and every
   screen that reports on it agreeing about what is still owed.

   Two businesses, so a bill in one can be shown to be invisible from the
   other. Invented records in a temp directory; nothing real is read.

   Run:  node test/sales.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-sales-"));
process.env.DATA_DIR = DATA_DIR;
const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const inventory = require(path.join(ROOT, "server/inventory.js"));
const stockLedger = require(path.join(ROOT, "server/stockLedger.js"));
const { todayStr } = require(path.join(ROOT, "server/util.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 400) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOP = db.companies.create({ name: "Sales Shop" });
const OTHER = db.companies.create({ name: "Other Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inOther = fn => db.companies.runAs(OTHER.id, fn);

let WHO = { role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use((req, _res, next) => {
  req.session = { loggedIn: true, ...WHO };
  const company = req.headers["x-company"] || SHOP.id;
  db.companies.runAs(company, () => stockLedger.withContext({ staff: req.session.staffName }, next));
});
app.use("/api/invoices", require(path.join(ROOT, "server/routes/invoices.js")));
app.use("/api/customers", require(path.join(ROOT, "server/routes/customers.js")));
app.use("/api/alerts", require(path.join(ROOT, "server/routes/alerts.js")));
app.use("/api/reports", require(path.join(ROOT, "server/routes/reports.js")));
app.use("/api/accounting", require(path.join(ROOT, "server/routes/accounting.js")));
app.use((err, req, res, next) => { console.error("[test] unhandled:", err && err.message); res.status(500).json({ error: "server" }); });

let BASE;
const call = async (method, url, body, company) => {
  const r = await fetch(BASE + url, {
    method,
    headers: Object.assign(body ? { "content-type": "application/json" } : {}, company ? { "x-company": company } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

const iso = d => new Date(Date.parse(todayStr() + "T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);
let LOC;
function seed() {
  for (const run of [inShop, inOther]) run(() => {
    LOC = inventory.getLocationByCode("shop").id;
    const ins = db.prepare("INSERT INTO customers (id,name,phone,due,created_at,active) VALUES (?,?,?,0,?,1)");
    ins.run("C-LAXMI", "Laxmi Interiors", "9000000001", Date.now());
    ins.run("C-PATEL", "Patel Furniture", "9000000002", Date.now());
    ins.run("C-OM", "Om Sai Carpenters", "9000000003", Date.now());
    db.prepare("INSERT INTO products (id,name,unit,gst_rate,stock,created_at,active) VALUES ('P-PLY','Century Club Prime 18mm','Sheet',18,0,?,1)").run(Date.now());
    db.prepare("INSERT INTO product_sizes (id,product_id,label,price,stock,cost_price) VALUES (1,'P-PLY','8x4',3200,0,2500)").run();
    stockLedger.withContext({ staff: "Owner" }, () => {
      stockLedger.setContext({ movement: "opening", refType: "Opening Stock" });
      inventory.addStock(1, LOC, 100);
    });
  });
}
const line = (pieces, rate) => ({ productId: "P-PLY", sizeId: 1, name: "Century Club Prime 18mm", sizeLabel: "8x4",
  pieces, qty: pieces, rate: rate || 3200, gstRate: 18, unitLabel: "Sheet", mode: "UNIT" });
const bill = (extra) => Object.assign({ customerId: "C-LAXMI", items: [line(2)], paymentMethod: "Credit",
  advance: 0, date: todayStr(), taxTypeOverride: "CGST_SGST" }, extra || {});
const due = id => inShop(() => db.prepare("SELECT due FROM customers WHERE id = ?").get(id).due);
const stock = () => inShop(() => inventory.getStock(1, LOC));
const key = n => "test-key-" + String(n).padStart(4, "0") + "-abcdef";

(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ---------------------------------------------------------------- */
  console.log("\n--- a sale is created, totalled on the server, numbered once ---\n");
  const s0 = stock();
  let r = await call("POST", "/api/invoices", bill({ items: [line(2, 3200)], discountType: "pct", discountValue: 10 }));
  ok("a credit sale is saved", r.status === 201, [r.status, r.j && r.j.error]);
  const INV1 = r.j;
  ok("subtotal is quantity × rate, worked out on the server (2 × 3200)", INV1.subtotal === 6400, INV1.subtotal);
  ok("a 10% discount is ₹640", INV1.discount_amount === 640, INV1.discount_amount);
  ok("GST 18% is charged on the discounted 5760, split CGST + SGST 9% each (518.40 each)",
     INV1.cgst === 518.4 && INV1.sgst === 518.4 && INV1.igst === 0, [INV1.cgst, INV1.sgst, INV1.igst]);
  ok("total = 5760 + 1036.80 = 6796.80, to the paisa (no rounding unless the bill asks for it)", INV1.total === 6796.8 && INV1.round_off === 0, [INV1.total, INV1.round_off]);
  const rounded = await call("POST", "/api/invoices", bill({ customerId: "C-OM", items: [line(1, 1000)], roundOff: true }));
  ok("asked to round, 1180 stays 1180 and the round-off is recorded", rounded.j.total === Math.round(rounded.j.total) && typeof rounded.j.round_off === "number", [rounded.j.total, rounded.j.round_off]);
  ok("the server ignores a total the browser might send", (await call("POST", "/api/invoices", bill({ total: 1, subtotal: 1 }))).j.total > 1);
  ok("stock fell by exactly the sheets sold — 2 + 2 + 1 across the three bills", s0 - stock() === 5, [s0, stock()]);
  ok("the customer now owes both credit bills in full (6796.80 + 7552)", due("C-LAXMI") === round2(6796.8 + 7552), due("C-LAXMI"));
  const n1 = INV1.challan_no;
  const n2 = (await call("POST", "/api/invoices", bill({ customerId: "C-PATEL" }))).j.challan_no;
  ok("each bill gets its own number from the server", n1 && n2 && n1 !== n2, [n1, n2]);

  console.log("\n--- validation ---\n");
  ok("no items is refused", (await call("POST", "/api/invoices", bill({ items: [] }))).status === 400);
  ok("more than the stock is refused, and nothing moves", await (async () => {
    const b = stock(); const x = await call("POST", "/api/invoices", bill({ items: [line(5000)] }));
    return x.status === 400 && /Not enough/i.test(x.j.error) && stock() === b; })());
  ok("a negative quantity is refused", (await call("POST", "/api/invoices", bill({ items: [line(-3)] }))).status === 400);
  ok("a customer that does not exist is refused", (await call("POST", "/api/invoices", bill({ customerId: "C-NOBODY" }))).status === 400);
  const capped = await call("POST", "/api/invoices", bill({ customerId: "C-OM", items: [line(1, 1000)], discountType: "flat", discountValue: 99999 }));
  ok("a flat discount larger than the bill is held at the bill's value, never negative", capped.status === 201 && capped.j.discount_amount === 1000 && capped.j.total >= 0, capped.j && [capped.j.discount_amount, capped.j.total]);

  /* ---------------------------------------------------------------- */
  console.log("\n--- payment status follows the money, not the day of the bill ---\n");
  const cashSale = await call("POST", "/api/invoices", bill({ customerId: "C-PATEL", paymentMethod: "Cash", advance: 99999, items: [line(1, 1000)] }));
  ok("a cash sale is saved fully received (the counter's rule)", cashSale.j.advance === cashSale.j.total && cashSale.j.balance_due === 0);
  let d = (await call("GET", `/api/invoices/${cashSale.j.id}`)).j;
  ok("...and reads as Paid", d.payment && d.payment.state === "paid" && d.payment.balance === 0, d.payment);
  const partSale = await call("POST", "/api/invoices", bill({ customerId: "C-OM", paymentMethod: "Credit", advance: 500, items: [line(1, 1000)] }));
  d = (await call("GET", `/api/invoices/${partSale.j.id}`)).j;
  ok("₹500 paid at the counter on a ₹1180 bill reads as Partly paid, ₹680 owed",
     d.payment.state === "partial" && d.payment.paid === 500 && d.payment.balance === 680, d.payment);
  d = (await call("GET", `/api/invoices/${INV1.id}`)).j;
  ok("an unpaid credit bill reads as Unpaid, with the whole total owed", d.payment.state === "unpaid" && d.payment.balance === 6796.8, d.payment);
  ok("...and its stored balance_due is untouched (what the paper bill says)", d.balance_due === 6796.8);

  /* ---------------------------------------------------------------- */
  console.log("\n--- recording payments, in full and in part ---\n");
  const laxmiDue0 = due("C-LAXMI");
  r = await call("POST", "/api/customers/C-LAXMI/payments", { amount: 3000, method: "Cash", invoiceId: INV1.id, date: todayStr(), idempotencyKey: key(1) });
  ok("a part payment against the bill is recorded", r.status === 201, [r.status, r.j && r.j.error]);
  ok("the customer's due falls by exactly 3000", round2(laxmiDue0 - due("C-LAXMI")) === 3000, [laxmiDue0, due("C-LAXMI")]);
  d = (await call("GET", `/api/invoices/${INV1.id}`)).j;
  ok("the bill is now Partly paid with 3796.80 owed", d.payment.state === "partial" && d.payment.balance === 3796.8, d.payment);
  ok("the receipt is listed against the bill", d.linkedPayments.length === 1 && d.linkedPayments[0].amount === 3000);
  ok("its status is no longer 'Pending' from the old stored figure", d.status === "Partially Completed", d.status);

  r = await call("POST", "/api/customers/C-LAXMI/payments", { amount: 3796.8, method: "Cash", invoiceId: INV1.id, date: todayStr(), idempotencyKey: key(2) });
  ok("the rest is recorded, to the paisa", r.status === 201, [r.status, r.j && r.j.error]);
  d = (await call("GET", `/api/invoices/${INV1.id}`)).j;
  ok("paying the rest makes it Paid", d.payment.state === "paid" && d.payment.balance === 0, d.payment);
  ok("...and only a real payment did it — two receipts now name the bill", d.linkedPayments.length === 2);

  console.log("\n--- payments that name no bill settle the oldest first ---\n");
  const balances = async () => new Map((await call("GET", "/api/invoices?customerId=C-OM")).j
    .filter(i => i.payment).map(i => [i.id, { bal: i.payment.balance, at: i.created_at, no: i.challan_no }]));
  const before1 = await balances();
  r = await call("POST", "/api/customers/C-OM/payments", { amount: 100, method: "Cash", date: todayStr(), idempotencyKey: key(4) });
  const after1 = await balances();
  const changed = [...before1].filter(([id, b]) => after1.get(id).bal !== b.bal);
  const oldestOwing = [...before1].filter(([, b]) => b.bal > 0).sort((a, b) => a[1].at - b[1].at)[0];
  ok("an unlinked ₹100 settles ONE bill — the oldest still owing — by exactly 100",
     changed.length === 1 && changed[0][0] === oldestOwing[0] && round2(changed[0][1].bal - after1.get(changed[0][0]).bal) === 100,
     { changed: changed.map(([id, b]) => [b.no, b.bal, after1.get(id).bal]), oldest: oldestOwing && oldestOwing[1].no });

  /* ---------------------------------------------------------------- */
  console.log("\n--- a retried payment is recorded once ---\n");
  const patelDue0 = due("C-PATEL");
  const countPays = () => inShop(() => db.prepare("SELECT COUNT(*) n FROM payments WHERE customer_id = 'C-PATEL'").get().n);
  const p0 = countPays();
  const body = { amount: 1000, method: "Cash", date: todayStr(), idempotencyKey: key(10) };
  const first = await call("POST", "/api/customers/C-PATEL/payments", body);
  const again = await call("POST", "/api/customers/C-PATEL/payments", body);
  ok("the first save records it (201)", first.status === 201);
  ok("the same key again is answered, not recorded (200, duplicate)", again.status === 200 && again.j.duplicate === true, again.j);
  const together = await Promise.all([1, 2, 3].map(() => call("POST", "/api/customers/C-PATEL/payments", { ...body, idempotencyKey: key(11) })));
  ok("three identical retries at the same moment make ONE receipt",
     together.filter(x => x.status === 201).length === 1 && together.every(x => x.status === 201 || x.status === 200), together.map(x => x.status));
  ok("in all, two receipts were recorded", countPays() - p0 === 2, countPays() - p0);
  ok("and the due fell by 2000, not 5000", round2(patelDue0 - due("C-PATEL")) === Math.min(patelDue0, 2000), [patelDue0, due("C-PATEL")]);
  ok("a key reused for a different customer is refused (409)",
     (await call("POST", "/api/customers/C-OM/payments", { ...body, idempotencyKey: key(10) })).status === 409);
  ok("no key at all still works (older screens)", (await call("POST", "/api/customers/C-OM/payments", { amount: 1, method: "Cash" })).status === 201);
  ok("a zero payment is refused", (await call("POST", "/api/customers/C-OM/payments", { amount: 0, method: "Cash" })).status === 400);
  ok("a negative payment is refused", (await call("POST", "/api/customers/C-OM/payments", { amount: -50, method: "Cash" })).status === 400);
  ok("an impossible date is refused", (await call("POST", "/api/customers/C-OM/payments", { amount: 5, method: "Cash", date: "2026-02-30" })).status === 400);
  ok("a bill that is not this customer's cannot be paid through them",
     (await call("POST", "/api/customers/C-OM/payments", { amount: 5, method: "Cash", invoiceId: INV1.id })).status === 400);

  /* ---------------------------------------------------------------- */
  console.log("\n--- overdue, and the lists that report what is owed ---\n");
  const late = (await call("POST", "/api/invoices", bill({ customerId: "C-OM", items: [line(1, 2000)], dueDate: iso(-5), date: iso(-20) }))).j;
  const paidLate = (await call("POST", "/api/invoices", bill({ customerId: "C-PATEL", items: [line(1, 2000)], dueDate: iso(-5), date: iso(-20) }))).j;
  await call("POST", "/api/customers/C-PATEL/payments", { amount: paidLate.total, method: "Cash", invoiceId: paidLate.id, idempotencyKey: key(20) });
  d = (await call("GET", `/api/invoices/${late.id}`)).j;
  ok("an unpaid bill past its due date is Overdue", d.payment.overdue === true && d.payment.balance > 0, d.payment);
  d = (await call("GET", `/api/invoices/${paidLate.id}`)).j;
  ok("a bill past its due date but paid is NOT overdue", d.payment.overdue === false && d.payment.state === "paid", d.payment);

  const alerts = (await call("GET", "/api/alerts")).j;
  const overdueGroup = (alerts.groups || []).find(g => g.key === "receivable-overdue");
  ok("the Reminders list shows the unpaid overdue bill", overdueGroup && overdueGroup.items.some(i => i.id === late.id), overdueGroup);
  ok("THE PAID ONE IS GONE FROM IT (it stayed for ever before)", !overdueGroup || !overdueGroup.items.some(i => i.id === paidLate.id));

  let s = (await call("GET", "/api/invoices/search?status=overdue")).j.rows;
  ok("bill search can list exactly the overdue bills", s.length >= 1 && s.every(x => x.payment && x.payment.overdue) && s.some(x => x.id === late.id), s.map(x => x.challan_no));
  s = (await call("GET", "/api/invoices/search?status=outstanding&customerId=C-OM")).j.rows;
  ok("...and everything still owed by one customer", s.length >= 1 && s.every(x => x.payment.balance > 0 && x.customer_name === "Om Sai Carpenters"), s.map(x => [x.challan_no, x.payment.balance]));
  s = (await call("GET", "/api/invoices/search?status=paid")).j.rows;
  ok("...and the paid ones", s.some(x => x.id === cashSale.j.id) && s.every(x => x.payment.state === "paid"));

  const rep = (await call("GET", "/api/reports/tax-invoices")).j;
  const rCash = rep.find(x => x.id === cashSale.j.id), rLate = rep.find(x => x.id === late.id), r1 = rep.find(x => x.id === INV1.id);
  ok("the Tax Invoice report shows what is still owed, not the day-of-bill figure",
     r1.outstanding === 0 && r1.balance_due === 6796.8 && r1.payment_status === "Paid", r1);
  ok("...a cash sale as Paid", rCash.outstanding === 0 && rCash.payment_status === "Paid", rCash);
  ok("...and an overdue one as Overdue", rLate.payment_status === "Overdue" && rLate.outstanding > 0, rLate);

  console.log("\n--- the Outstanding screen agrees with the customer's balance ---\n");
  const out = (await call("GET", "/api/accounting/outstanding-details?side=customer")).j;
  for (const p of out.parties) {
    ok(`${p.name}: the bill-by-bill total equals the balance owed (${p.balance})`, Math.abs(p.billwiseTotal - p.balance) < 0.01, [p.billwiseTotal, p.balance]);
    ok(`${p.name}: opening + bills − received = balance`, Math.abs(round2(p.openingOutstanding + p.totalBills - p.totalPaid) - p.balance) < 0.01,
       [p.openingOutstanding, p.totalBills, p.totalPaid, p.balance]);
  }
  ok("a cash sale is NOT listed as owed on the Outstanding screen",
     !out.parties.some(p => p.bills.some(b => b.id === cashSale.j.id && b.balance > 0)));

  /* ---------------------------------------------------------------- */
  console.log("\n--- cancelling and failure leave nothing half-done ---\n");
  const toVoid = (await call("POST", "/api/invoices", bill({ customerId: "C-PATEL", items: [line(3, 1000)] }))).j;
  const sBefore = stock(), dBefore = due("C-PATEL");
  r = await call("POST", `/api/invoices/${toVoid.id}/void`, { reason: "test" });
  ok("the owner can cancel a bill", r.status === 200, [r.status, r.j && r.j.error]);
  ok("cancelling returns its stock exactly once", stock() - sBefore === 3, [sBefore, stock()]);
  ok("...and takes its balance off the customer", round2(dBefore - due("C-PATEL")) === toVoid.balance_due, [dBefore, due("C-PATEL"), toVoid.balance_due]);
  ok("cancelling twice does not return the stock twice", await (async () => { const b = stock(); await call("POST", `/api/invoices/${toVoid.id}/void`, {}); return stock() === b; })());
  d = (await call("GET", `/api/invoices/${toVoid.id}`)).j;
  ok("a cancelled bill carries no payment demand", d.status === "Cancelled" && d.payment === null, [d.status, d.payment]);

  WHO = { role: "staff", staffId: "ST-COUNTER", staffName: "Counter" };
  ok("a member of staff cannot cancel a bill (403)", (await call("POST", `/api/invoices/${late.id}/void`, {})).status === 403);
  ok("...nor void a payment (403)", (await call("POST", "/api/customers/C-OM/payments/PAY_x/void", {})).status === 403);
  WHO = { role: "owner", staffId: "ST-OWNER", staffName: "Owner" };

  const failStock = stock(), failCount = inShop(() => db.prepare("SELECT COUNT(*) n FROM invoices").get().n);
  r = await call("POST", "/api/invoices", bill({ items: [line(1), { ...line(1), sizeId: 999 }] }));
  ok("a bill with one bad line is refused whole", r.status === 400);
  ok("...no invoice, no stock moved", stock() === failStock && inShop(() => db.prepare("SELECT COUNT(*) n FROM invoices").get().n) === failCount);

  /* ---------------------------------------------------------------- */
  console.log("\n--- one business never reaches another's bills ---\n");
  ok("the other business cannot open this one's bill", (await call("GET", `/api/invoices/${INV1.id}`, null, OTHER.id)).status === 404);
  ok("...nor list it", !(await call("GET", "/api/invoices", null, OTHER.id)).j.some(i => i.id === INV1.id));
  ok("...nor record a payment against it",
     (await call("POST", "/api/customers/C-LAXMI/payments", { amount: 10, method: "Cash", invoiceId: INV1.id }, OTHER.id)).status === 400);
  ok("its customers' balances are its own", inOther(() => db.prepare("SELECT SUM(due) d FROM customers").get().d) === 0);

  /* ---------------------------------------------------------------- */
  console.log("\n--- the real server keeps it behind sign-in ---\n");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-sales-srv-"));
    const p = spawn(process.execPath, ["--no-warnings", "server/index.js"], { cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, PORT: "4884", SUPABASE_URL: "", SUPABASE_KEY: "", R2_ACCOUNT_ID: "" } });
    let o = ""; p.stdout.on("data", x => o += x); p.stderr.on("data", x => o += x);
    for (let i = 0; i < 120 && !/running on port 4884/.test(o); i++) await sleep(250);
    for (const [m, u] of [["GET", "/api/invoices"], ["GET", "/api/invoices/search?status=overdue"], ["POST", "/api/customers/C1/payments"], ["GET", "/api/reports/tax-invoices"]]) {
      const x = await fetch("http://127.0.0.1:4884" + u, { method: m });
      ok(`${m} ${u} without signing in is refused (401)`, x.status === 401, x.status);
    }
    p.kill(); await sleep(300);
  }

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
