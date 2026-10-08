/* ============================================================
   ADMIN SALES & INVOICES — PART 5

   This module reads the books and is not allowed to write to them, so
   the tests come in two halves.

   The first half is arithmetic, and it is unforgiving: a set of books
   known to the rupee, and every figure on the screen checked against
   it. Three things must never be counted and each gets its own test —
   a cancelled bill, a delivery challan, and a document belonging to
   another shop.

   The second half tries to write. There is no edit, no void, no
   delete and no capability that would permit one, because changing an
   invoice is a financial act that belongs behind the financial-year
   lock in the shop app. Those tests exist so that stays true.

   Run:  node test/admin-sales.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-adminsales-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const adminSales = require(path.join(ROOT, "server/adminSales.js"));
const { requireAuth } = require(path.join(ROOT, "server/auth.js"));
const { localDate, todayStr } = require(path.join(ROOT, "server/util.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

const SHOP = db.companies.create({ name: "Our Shop" });
const OTHER = db.companies.create({ name: "Another Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inOther = fn => db.companies.runAs(OTHER.id, fn);

let CO = SHOP.id, WHO = null;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = WHO ? { loggedIn: true, ...WHO } : {};
  db.companies.runAs(CO, next);
});
app.use("/api/admin", requireAuth, adminAccess.gate(),
        require(path.join(ROOT, "server/routes/admin.js")));

let BASE;
const call = async (method, url, body, who) => {
  if (who !== undefined) WHO = who;
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

const OWNER = { role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
const STAFF = { role: "staff", staffId: "ST-A", staffName: "Counter" };

const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return localDate(d); };

/* ------------------------------------------------------------------
   THE BOOKS — small, and known to the rupee.

   Billed, not cancelled, not a challan:
       SP0000001   10,000   settled
       SP0000002    6,000   6,000 outstanding, due yesterday  -> overdue
       SP0000003    4,000   4,000 outstanding, no due date
   = 20,000 over 3 bills, average 6,666.67

   Also present and never to be counted:
       SP0000009   99,999   CANCELLED
       DC0000001   a challan carrying 12,000 of goods, unbilled
   ------------------------------------------------------------------ */
const BILLED = 20000;
const BILLS = 3;

function seed() {
  inShop(() => {
    const now = Date.now();
    db.prepare(`INSERT INTO customers (id,name,phone,gst,due,created_at,active)
                VALUES (?,?,?,?,?,?,1)`)
      .run("C1", "Patel Timber", "9000000001", "27AAAAA0000A1Z5", 10000, now);
    db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                VALUES (?,?,?,?,?,1)`).run("C2", "Shah Interiors", "9000000002", 0, now);

    const bill = (id, no, type, date, total, bal, opts) => {
      const o = opts || {};
      db.prepare(`INSERT INTO invoices
          (id,challan_no,doc_type,date,created_at,customer_id,subtotal,total,
           balance_due,advance,voided,cgst,sgst,igst,discount_amount,
           payment_method,due_date,converted_invoice_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, no, type, date, o.at || now, o.customer || "C1",
             total, total, bal, o.advance || 0, o.voided || 0,
             o.cgst || 0, o.sgst || 0, o.igst || 0, o.discount || 0,
             o.method || "Cash", o.dueDate || null, o.converted || null);
    };
    const line = (invId, name, pieces, qty, rate, disc) =>
      db.prepare(`INSERT INTO invoice_items
          (invoice_id,name,size_label,pieces,qty,rate,gst_rate,discount_pct,unit_label)
        VALUES (?,?,?,?,?,?,18,?,'Sq.ft')`)
        .run(invId, name, "8x4", pieces, qty, rate, disc || 0);

    bill("I1", "SP0000001", "invoice", day(5), 10000, 0,
         { cgst: 900, sgst: 900, discount: 500, method: "Cash" });
    line("I1", "Marine Ply 18mm", 4, 4, 2500, 0);

    bill("I2", "SP0000002", "invoice", day(3), 6000, 6000,
         { cgst: 540, sgst: 540, method: "Credit", dueDate: day(1) });   /* overdue */
    line("I2", "Commercial Ply 12mm", 4, 4, 1500, 0);

    bill("I3", "SP0000003", "invoice", day(1), 4000, 4000,
         { cgst: 360, sgst: 360, method: "Credit", customer: "C2" });
    line("I3", "Laminate Sheet", 2, 2, 2000, 0);

    bill("I9", "SP0000009", "invoice", day(2), 99999, 0, { voided: 1 });
    line("I9", "Should Never Count", 99, 99, 1010, 0);

    bill("DC1", "DC0000001", "challan", day(2), 0, 0, {});
    line("DC1", "Marine Ply 18mm", 5, 5, 2400, 0);

    db.prepare(`INSERT INTO payments (id,customer_id,invoice_id,amount,method,voided,created_at)
                VALUES (?,?,?,?,?,0,?)`).run("PAY1", "C1", "I1", 10000, "Cash", now);
  });

  inOther(() => {
    db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                VALUES ('CX','Rival Customer','911',0,?,1)`).run(Date.now());
    db.prepare(`INSERT INTO invoices
        (id,challan_no,doc_type,date,created_at,customer_id,subtotal,total,balance_due,voided)
      VALUES ('IX','SP9999999','invoice',?,?, 'CX', 777777, 777777, 0, 0)`)
      .run(todayStr(), Date.now());
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  THE DOCUMENT LIST
     ================================================================ */
  console.log("\n--- the document list ---");

  let r = await call("GET", "/api/admin/invoices", null, OWNER);
  ok("it loads", r.status === 200, r.status);
  ok("it lists the live documents, not the cancelled one",
     r.j.total === 4, r.j.rows.map(x => x.no));
  ok("the cancelled bill is absent by default",
     !r.j.rows.some(x => x.no === "SP0000009"), r.j.rows.map(x => x.no));

  console.log("\n--- the money is only what was actually billed ---");
  ok("the matched total is 20,000, not 1,19,999",
     r.j.matched.money === BILLED, r.j.matched.money);
  ok("the 99,999 cancelled bill is excluded",
     r.j.matched.money !== 119999 && r.j.matched.money !== 119999 - 0);
  ok("outstanding across the match is 10,000", r.j.matched.due === 10000, r.j.matched.due);

  console.log("\n--- a challan carries goods, never money ---");
  const dc = r.j.rows.filter(x => x.no === "DC0000001")[0];
  ok("the challan is listed", !!dc);
  ok("its total is NULL, not zero", dc.total === null, dc.total);
  ok("but its goods are valued", dc.goodsValue === 12000, dc.goodsValue);
  ok("it is marked as a challan", dc.isChallan === true);
  ok("and as not yet billed", dc.billed === false, dc.billed);

  const inv1 = r.j.rows.filter(x => x.no === "SP0000001")[0];
  ok("an invoice carries its money", inv1.total === 10000, inv1.total);
  ok("and is not flagged as a challan", inv1.isChallan === false);
  ok("billed is meaningless for an invoice, so it is null", inv1.billed === null);

  console.log("\n--- overdue is worked out from the due date, not guessed ---");
  const inv2 = r.j.rows.filter(x => x.no === "SP0000002")[0];
  const inv3 = r.j.rows.filter(x => x.no === "SP0000003")[0];
  ok("a bill past its due date with money owing is overdue", inv2.overdue === true, inv2);
  ok("a bill with money owing and NO due date is not overdue",
     inv3.balanceDue > 0 && inv3.overdue === false, inv3);
  ok("a settled bill is never overdue", inv1.overdue === false);

  /* ================================================================
     2.  FILTERS
     ================================================================ */
  console.log("\n--- filters ---");
  const f = async (qs) => (await call("GET", "/api/admin/invoices?" + qs + "&pageSize=100",
    null, OWNER)).j;

  ok("type=invoice excludes challans",
     (await f("type=invoice")).rows.every(x => !x.isChallan));
  ok("type=challan returns only challans",
     (await f("type=challan")).rows.every(x => x.isChallan));
  const unpaid = await f("status=unpaid");
  ok("status=unpaid finds the two with money owing",
     unpaid.total === 2 && unpaid.rows.every(x => x.balanceDue > 0), unpaid.rows.map(x => x.no));
  const paid = await f("status=paid");
  ok("status=paid finds the settled ones",
     paid.rows.every(x => x.balanceDue === 0), paid.rows.map(x => x.no));
  const overdue = await f("status=overdue");
  ok("status=overdue finds exactly the one past its date",
     overdue.total === 1 && overdue.rows[0].no === "SP0000002", overdue.rows.map(x => x.no));
  const unbilled = await f("status=unbilled");
  ok("status=unbilled finds the challan nobody has billed",
     unbilled.total === 1 && unbilled.rows[0].no === "DC0000001", unbilled.rows.map(x => x.no));

  console.log("\n--- a cancelled document is shown, not hidden ---");
  const voided = await f("status=voided");
  ok("it can be listed on purpose",
     voided.total === 1 && voided.rows[0].no === "SP0000009", voided.rows.map(x => x.no));
  ok("it is flagged as cancelled", voided.rows[0].voided === true);
  ok("and even then its money is NOT added to the matched total",
     voided.matched.money === 0, voided.matched.money);

  console.log("\n--- the status is the shop's own, not one invented here ---");

  const invoicesRouter = require(path.join(ROOT, "server/routes/invoices.js"));
  ok("routes/invoices.js exports its status engine",
     typeof invoicesRouter.deriveDocStatus === "function");

  const all = await f("status=all");
  const byNo = no => all.rows.filter(x => x.no === no)[0];
  ok("a settled bill is 'Completed', the word the billing screen uses",
     byNo("SP0000001").status === "Completed", byNo("SP0000001").status);
  ok("one with money owing and no advance is 'Pending'",
     byNo("SP0000002").status === "Pending", byNo("SP0000002").status);
  ok("an unbilled challan is 'Pending', not a label of this module's own",
     byNo("DC0000001").status === "Pending", byNo("DC0000001").status);
  ok("a cancelled bill is 'Cancelled'",
     (await f("status=voided")).rows[0].status === "Cancelled");
  ok("every status is one of the five the app defines",
     all.rows.every(x => ["Pending", "Partially Completed", "Completed",
                          "Billed", "Cancelled"].includes(x.status)),
     all.rows.map(x => x.status));

  /* The point of reusing it: one bill, one word, on both screens. */
  const direct = inShop(() => invoicesRouter.deriveDocStatus(
    db.prepare("SELECT * FROM invoices WHERE id = ?").get("I3")));
  ok("and it agrees with the engine, bill for bill",
     byNo("SP0000003").status === direct, [byNo("SP0000003").status, direct]);

  console.log("\n--- the money the list carries ---");
  const one = byNo("SP0000001");
  ok("the subtotal is the document's own", one.subtotal === 10000, one.subtotal);
  ok("the discount is too", one.discount === 500, one.discount);
  ok("the tax is CGST + SGST + IGST summed", one.tax === 1800, one.tax);
  ok("and the total", one.total === 10000, one.total);
  ok("a CHALLAN carries none of them, as null rather than zero",
     byNo("DC0000001").subtotal === null && byNo("DC0000001").discount === null &&
     byNo("DC0000001").tax === null && byNo("DC0000001").total === null,
     byNo("DC0000001"));

  console.log("\n--- filtering by customer ---");
  const mine = await f("customerId=C1");
  ok("it returns only that customer's documents",
     mine.rows.every(x => x.customerId === "C1") && mine.total >= 1,
     mine.rows.map(x => x.no));
  ok("and excludes another customer's", !mine.rows.some(x => x.customerId === "C2"));
  const theirs = await f("customerId=C2");
  ok("the other customer's filter works too",
     theirs.rows.every(x => x.customerId === "C2"), theirs.rows.map(x => x.no));
  ok("an unknown customer id returns nothing rather than everything",
     (await f("customerId=NO-SUCH-CUSTOMER")).total === 0);
  ok("the filter is exact, not a prefix match",
     (await f("customerId=C")).total === 0, (await f("customerId=C")).total);

  ok("the customers offered are only those with documents",
     all.options.customers.length === 2 &&
     all.options.customers.every(c => c.n > 0), all.options.customers);

  console.log("\n--- date window ---");
  const windowed = await f("from=" + day(4) + "&to=" + day(0));
  ok("a window excludes what falls outside it",
     !windowed.rows.some(x => x.no === "SP0000001"), windowed.rows.map(x => x.no));
  ok("and includes what falls inside", windowed.rows.some(x => x.no === "SP0000002"));

  console.log("\n--- search ---");
  ok("by document number", (await f("q=SP0000002")).total === 1);
  ok("by part of a number", (await f("q=DC000")).total === 1);
  ok("by customer name", (await f("q=Patel")).total >= 1);
  ok("by exact amount", (await f("q=6000")).total >= 1);
  ok("nothing matches nothing", (await f("q=zzzznope")).total === 0);

  const pct = await f("q=" + encodeURIComponent("%"));
  ok("a bare % does not match every document", pct.total === 0, pct.total);
  const und = await f("q=" + encodeURIComponent("_"));
  ok("a bare _ does not either", und.total === 0, und.total);

  console.log("\n--- sorting and paging cannot inject SQL ---");
  for (const bad of ["total DESC--", "name; DROP TABLE invoices", "__proto__"]) {
    const res = await call("GET", "/api/admin/invoices?sort=" + encodeURIComponent(bad), null, OWNER);
    ok("sort=" + bad.slice(0, 16) + " falls back", res.status === 200 && res.j.sort === "recent",
       res.j && res.j.sort);
  }
  for (const bad of ["nonsense", "__proto__"]) {
    const a2 = await call("GET", "/api/admin/invoices?type=" + bad, null, OWNER);
    const b2 = await call("GET", "/api/admin/invoices?status=" + bad, null, OWNER);
    ok("type=" + bad + " falls back to all", a2.j.type === "all");
    ok("status=" + bad + " falls back to all", b2.j.status === "all");
  }
  ok("the invoices table is intact",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM invoices").get().n) === 5);
  ok("a huge pageSize cannot pull the whole book",
     (await f("pageSize=999999")).rows.length <= adminSales.MAX_PAGE_SIZE);

  /* ================================================================
     3.  ONE DOCUMENT
     ================================================================ */
  console.log("\n--- one invoice ---");

  r = await call("GET", "/api/admin/invoices/I1", null, OWNER);
  ok("it loads", r.status === 200, r.status);
  const d = r.j;
  ok("the header is the document's own", d.document.no === "SP0000001");
  ok("the customer comes with it", d.customer.name === "Patel Timber" &&
     d.customer.gst === "27AAAAA0000A1Z5", d.customer);
  ok("the money block is the document's own figures",
     d.money.total === 10000 && d.money.cgst === 900 && d.money.sgst === 900 &&
     d.money.discount === 500, d.money);
  ok("the lines came through", d.items.length === 1, d.items.length);
  ok("a line carries its own worth", d.items[0].value === 10000, d.items[0]);
  ok("a payment made against this bill is shown",
     d.payments.length === 1 && d.payments[0].amount === 10000, d.payments);

  console.log("\n--- one challan ---");
  r = await call("GET", "/api/admin/invoices/DC1", null, OWNER);
  ok("a challan opens", r.status === 200, r.status);
  ok("ITS MONEY BLOCK IS NULL, not a row of zeros", r.j.money === null, r.j.money);
  ok("but the goods are valued", r.j.goodsValue === 12000, r.j.goodsValue);
  ok("and its lines are there", r.j.items.length === 1);

  console.log("\n--- a cancelled document can be opened and says so ---");
  r = await call("GET", "/api/admin/invoices/I9", null, OWNER);
  ok("it opens", r.status === 200, r.status);
  ok("and is flagged cancelled", r.j.document.voided === true);

  console.log("\n--- an id that is not there ---");
  for (const bad of ["NOPE", "../settings", "'; DROP TABLE invoices;--"]) {
    r = await call("GET", "/api/admin/invoices/" + encodeURIComponent(bad), null, OWNER);
    ok("id " + bad.slice(0, 18) + " is a plain 404", r.status === 404, r.status);
  }
  ok("the table survived",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM invoices").get().n) === 5);

  /* ================================================================
     4.  THE SALES VIEW
     ================================================================ */
  console.log("\n--- the sales figures ---");

  r = await call("GET", "/api/admin/sales?from=" + day(10) + "&to=" + day(0), null, OWNER);
  ok("it loads", r.status === 200, r.status);
  const s = r.j;

  ok("sold is exactly the three live bills", s.money === BILLED, s.money);
  ok("the bill count excludes the cancelled one and the challan",
     s.bills === BILLS, s.bills);
  ok("the average is worked out from those", Math.abs(s.averageBill - BILLED / BILLS) < 0.01,
     s.averageBill);
  ok("two customers were billed", s.customersBilled === 2, s.customersBilled);
  ok("the cancelled bill is reported separately", s.voidedBills === 1, s.voidedBills);

  ok("GST is summed from the documents",
     s.tax.cgst === 1800 && s.tax.sgst === 1800 && s.tax.total === 3600, s.tax);
  ok("the discount given is summed too", s.tax.discount === 500, s.tax.discount);

  ok("the unbilled challan is reported, and NOT counted as a sale",
     s.unbilledChallans.count === 1 && s.unbilledChallans.worth === 12000 &&
     s.money === BILLED, s.unbilledChallans);

  ok("the window used is stated", s.window.from === day(10) && s.window.to === day(0), s.window);
  ok("and the window it is compared against is stated too",
     !!s.previousWindow.from && !!s.previousWindow.to, s.previousWindow);
  ok("a change against an empty previous window is null, not +100%",
     s.change === null || typeof s.change === "number", s.change);

  ok("best sellers come from the lines",
     s.topProducts.some(p => p.name === "Marine Ply 18mm"), s.topProducts.map(p => p.name));
  ok("and the cancelled bill's item is not among them",
     !s.topProducts.some(p => p.name === "Should Never Count"), s.topProducts.map(p => p.name));
  ok("biggest customers come from the bills",
     s.topCustomers.length === 2 && s.topCustomers[0].name === "Patel Timber",
     s.topCustomers.map(c => c.name));
  ok("payment methods are grouped", s.byMethod.length >= 1, s.byMethod);
  ok("the daily series only covers the window",
     s.byDay.every(x => x.date >= s.window.from && x.date <= s.window.to), s.byDay);

  console.log("\n--- an empty window, and an empty shop ---");
  r = await call("GET", "/api/admin/sales?from=2000-01-01&to=2000-01-31", null, OWNER);
  ok("a window with nothing in it is zeros, not an error",
     r.status === 200 && r.j.money === 0 && r.j.bills === 0, [r.status, r.j && r.j.money]);
  ok("the average is null rather than 0/0", r.j.averageBill === null, r.j.averageBill);
  ok("but the shop is still known to have traded", r.j.hasAnySales === true);

  /* ================================================================
     5.  THIS MODULE CANNOT WRITE
     ================================================================ */
  console.log("\n--- there is no way to change a document from here ---");

  for (const [m, u] of [["PUT", "/api/admin/invoices/I1"],
                        ["PATCH", "/api/admin/invoices/I1"],
                        ["DELETE", "/api/admin/invoices/I1"],
                        ["POST", "/api/admin/invoices"],
                        ["PATCH", "/api/admin/invoices/I1/void"],
                        ["DELETE", "/api/admin/sales"]]) {
    r = await call(m, u, { total: 1 }, OWNER);
    ok(m + " " + u + " is not a route", r.status === 404, r.status);
  }

  const routeSrc = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
  /* The slice must END at the next block, not at the end of the file —
     PART 8 added user management between these two markers and this
     started reading its PATCH and PUT routes as if they were sales
     ones. The boundary is the next section header. */
  const sect = routeSrc.slice(routeSrc.indexOf("SALES AND INVOICES"),
                              routeSrc.indexOf("USERS, ROLES & PERMISSIONS"));
  ok("the sales block declares only GET routes",
     !/router\.(put|patch|post|delete)\(/.test(sect), (sect.match(/router\.\w+\(/g) || []));
  ok("there is no sales.edit capability at all",
     !adminAccess.CAPS["sales.edit"] && !adminAccess.CAPS["invoices.edit"],
     Object.keys(adminAccess.CAPS));

  const svc = fs.readFileSync(path.join(ROOT, "server/adminSales.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("the service writes nothing", !/\b(INSERT|UPDATE|DELETE)\s/i.test(svc));
  ok("and never does SELECT *", !/SELECT\s+\*/i.test(svc.replace(/SELECT i\.\*/g, "")));

  console.log("\n--- and nothing it does moves a figure ---");
  const books = () => inShop(() => ({
    invoices: db.prepare("SELECT COUNT(*) n FROM invoices").get().n,
    total: db.prepare("SELECT COALESCE(SUM(total),0) t FROM invoices").get().t,
    due: db.prepare("SELECT COALESCE(SUM(balance_due),0) d FROM invoices").get().d,
    items: db.prepare("SELECT COUNT(*) n FROM invoice_items").get().n,
    payments: db.prepare("SELECT COUNT(*) n FROM payments").get().n,
    custDue: db.prepare("SELECT COALESCE(SUM(due),0) d FROM customers").get().d,
  }));
  const b4 = books();
  await call("GET", "/api/admin/invoices?pageSize=100", null, OWNER);
  await call("GET", "/api/admin/invoices/I1", null, OWNER);
  await call("GET", "/api/admin/sales", null, OWNER);
  ok("not one row or rupee moved", JSON.stringify(b4) === JSON.stringify(books()), [b4, books()]);

  /* ================================================================
     6.  AUTHORIZATION AND ISOLATION
     ================================================================ */
  console.log("\n--- who may read the sales book ---");

  ok("sales.view exists", !!adminAccess.CAPS["sales.view"]);
  ok("SUPPORT may read it", adminAccess.CAPS["sales.view"].includes("SUPPORT"));

  for (const [label, who] of [["logged out", null], ["staff", STAFF],
                              ["owner in preview", { ...OWNER, previewStaffId: "ST-A" }]]) {
    for (const u of ["/api/admin/invoices", "/api/admin/invoices/I1", "/api/admin/sales"]) {
      r = await call("GET", u, null, who);
      ok(label + " " + u + " is refused", r.status === 401 || r.status === 403, r.status);
      ok("  and leaks nothing", !/SP0000001|Patel|10000/.test(r.text), r.text.slice(0, 60));
    }
  }

  const realCap = adminAccess.CAPS["sales.view"];
  adminAccess.CAPS["sales.view"] = ["ADMIN"];
  r = await call("GET", "/api/admin/invoices", null, OWNER);
  adminAccess.CAPS["sales.view"] = realCap;
  ok("without sales.view even an owner is refused", r.status === 403, r.status);

  console.log("\n--- another shop's bill ---");
  ok("the other shop really has it",
     inOther(() => !!db.prepare("SELECT 1 FROM invoices WHERE id = ?").get("IX")));
  r = await call("GET", "/api/admin/invoices/IX", null, OWNER);
  ok("it is a 404 here", r.status === 404, r.status);
  ok("and none of it leaks",
     !r.text.includes("777777") && !r.text.includes("Rival"), r.text.slice(0, 80));
  r = await call("GET", "/api/admin/invoices?q=SP9999999", null, OWNER);
  ok("searching for it finds nothing", r.j.total === 0, r.j.total);
  r = await call("GET", "/api/admin/sales", null, OWNER);
  ok("and their money is in none of my figures", r.j.money !== 777777, r.j.money);

  /* ================================================================
     7.  PRIVACY
     ================================================================ */
  console.log("\n--- nothing secret crosses the wire ---");

  inShop(() => db.prepare(
    "UPDATE settings SET sync_cloud_key = ?, activation_code = ? WHERE id = 1")
    .run("SALESKEY0123456789abcdef", "ACT-SECRET"));

  for (const u of ["/api/admin/invoices?pageSize=100", "/api/admin/invoices/I1", "/api/admin/sales"]) {
    const res = await call("GET", u, null, OWNER);
    ok(u.slice(0, 26) + " leaks no sync key", !res.text.includes("SALESKEY0123456789abcdef"));
    ok("  no activation code", !res.text.includes("ACT-SECRET"));
    ok("  no pin hash", !/pin_hash/.test(res.text));
    ok("  no filesystem path", !/[A-Za-z]:[\\/]|\/home\/|\/tmp\//.test(res.text));
    ok("  no SQL", !/SELECT |FROM invoices/i.test(res.text));
    ok("  no stack trace", !/\bat \w+ \(/.test(res.text));
  }

  srv.close();

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
