/* ============================================================
   ADMIN CUSTOMER MANAGEMENT — PART 3

   The module reads the shop's own customer book and offers the two
   changes the shop already supports safely. So the tests are mostly
   attempts to make it misbehave as a reading room:

     - find a customer belonging to ANOTHER SHOP by pasting their id
     - make the search box lie, by typing a % or an _
     - pull the whole book down in one request
     - read a customer without being allowed to
     - EDIT a customer with only read permission
     - reach a delete that this module deliberately does not have
     - move a rupee of anybody's money by switching a customer off

   And the ordinary ones that matter just as much: a customer with no
   transactions at all, one with far more than a page of them, a
   nonexistent id, and the exact figures for a customer whose books are
   known down to the rupee.

   Run:  node test/admin-customers.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-admincust-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const adminCustomers = require(path.join(ROOT, "server/adminCustomers.js"));
const { requireAuth } = require(path.join(ROOT, "server/auth.js"));
const { localDate } = require(path.join(ROOT, "server/util.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

/* TWO SHOPS. Separate SQLite files, which is how this app keeps tenants
   apart — there is no company_id column to forget in a WHERE clause. */
const SHOP = db.companies.create({ name: "Our Shop" });
const OTHER = db.companies.create({ name: "Another Shop" });

let CO = SHOP.id;
let WHO = null;

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

const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inOther = fn => db.companies.runAs(OTHER.id, fn);

const dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const TODAY = localDate(new Date());

/* ------------------------------------------------------------------
   THE BOOKS
   ------------------------------------------------------------------ */
const addCustomer = (id, name, o) => db.prepare(`
  INSERT INTO customers (id,name,type,phone,whatsapp,address,gst,state,pin_code,
                         credit_limit,due,created_at,active)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  id, name, (o && o.type) || "Retail Customer", (o && o.phone) || "",
  (o && o.whatsapp) || "", (o && o.address) || "", (o && o.gst) || "",
  (o && o.state) || "", (o && o.pin) || "",
  (o && o.limit) || 0, (o && o.due) || 0,
  (o && o.created) || Date.now(), o && o.active === 0 ? 0 : 1);

const addInvoice = (id, no, cust, date, total, opts) => db.prepare(`
  INSERT INTO invoices (id,challan_no,doc_type,date,created_at,customer_id,
                        subtotal,total,balance_due,voided)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
  id, no, (opts && opts.docType) || "invoice", date,
  (opts && opts.at) || Date.now(), cust, total, total,
  (opts && opts.balanceDue) || 0, (opts && opts.voided) || 0);

const addPayment = (id, cust, amount, method, opts) => db.prepare(`
  INSERT INTO payments (id,customer_id,amount,method,reference_no,voided,created_at)
  VALUES (?,?,?,?,?,?,?)`).run(
  id, cust, amount, method, (opts && opts.ref) || "",
  (opts && opts.voided) || 0, (opts && opts.at) || Date.now());

function seed() {
  inShop(() => {
    const now = Date.now();

    /* A customer whose books are known to the rupee. */
    addCustomer("C-BUSY", "Patel Timber", {
      type: "Dealer", phone: "9000000001", whatsapp: "9000000009",
      address: "12 Market Road", gst: "27AAAAA0000A1Z5", state: "Maharashtra",
      pin: "400001", limit: 50000, due: 12000, created: now - 86400000 * 200,
    });
    addInvoice("I1", "SP0000001", "C-BUSY", localDate(dayAgo(10)), 10000);
    addInvoice("I2", "SP0000002", "C-BUSY", localDate(dayAgo(3)), 6000);
    addInvoice("I3", "SP0000003", "C-BUSY", TODAY, 99999, { voided: 1 });   // must not count
    addInvoice("I4", "DC0000001", "C-BUSY", TODAY, 0, { docType: "challan" });
    addPayment("P1", "C-BUSY", 4000, "Cash");
    addPayment("P2", "C-BUSY", 7777, "UPI", { voided: 1 });                 // must not count

    /* A customer with nothing attached at all. */
    addCustomer("C-NEW", "Brand New Buyer", { phone: "9000000002", created: now });

    /* Switched off, and over an agreed limit. */
    addCustomer("C-OFF", "Closed Account", { phone: "9000000003", active: 0,
                                             created: now - 86400000 * 400 });
    addCustomer("C-OVER", "Shah Interiors", { phone: "9000000004", limit: 10000,
                                              due: 25000, created: now - 86400000 * 400 });

    /* A name with LIKE metacharacters in it. */
    addCustomer("C-PCT", "Fifty 50% Traders", { phone: "9000000005" });
    addCustomer("C-UND", "A_B Hardware", { phone: "9000000006" });

    /* Enough to need more than one page, and one of them with more
       invoices than a profile will show. */
    for (let i = 0; i < 40; i++) {
      addCustomer("C-BULK" + String(i).padStart(2, "0"), "Bulk Customer " + String(i).padStart(2, "0"),
                  { phone: "98000000" + String(i).padStart(2, "0"),
                    created: now - 86400000 * (300 - i) });
    }
    for (let i = 0; i < 30; i++) {
      addInvoice("IB" + i, "SP900" + String(i).padStart(4, "0"), "C-BULK00",
                 localDate(dayAgo(i)), 100 + i, { at: now - i * 1000 });
    }
  });

  /* The other shop's customer. Same shape, different database. */
  inOther(() => {
    addCustomer("C-SECRET", "Rival Shop Client", {
      phone: "9111111111", address: "Somewhere else", due: 999999,
    });
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  THE LIST
     ================================================================ */
  console.log("\n--- the customer list ---");

  let r = await call("GET", "/api/admin/customers", null, OWNER);
  ok("the list loads", r.status === 200, r.status);
  ok("it reports the whole book's size", r.j.total === 46, r.j.total);
  ok("but sends ONE PAGE of rows", r.j.rows.length === 25, r.j.rows.length);
  ok("and says how many pages that is", r.j.pages === 2, r.j.pages);
  ok("the page size is stated", r.j.pageSize === 25, r.j.pageSize);
  ok("filters and sorts are offered by the server, not guessed at",
     r.j.options.filters.length > 0 && r.j.options.sorts.length > 0);
  ok("the windows the filters mean are stated",
     r.j.options.windows.newDays === 30 && r.j.options.windows.dormantDays === 90,
     r.j.options.windows);

  const busy = (await call("GET", "/api/admin/customers?q=Patel", null, OWNER)).j.rows[0];
  ok("a row carries the fields the shop actually has",
     busy.name === "Patel Timber" && busy.phone === "9000000001" &&
     busy.gst === "27AAAAA0000A1Z5" && busy.type === "Dealer", busy);
  ok("purchases exclude the voided bill and the challan",
     busy.sales === 16000, busy.sales);
  ok("the bill count does too", busy.bills === 2, busy.bills);
  ok("outstanding is the customer's own due", busy.due === 12000, busy.due);
  ok("the last sale date is real", busy.lastSale === localDate(dayAgo(3)), busy.lastSale);

  console.log("\n--- a list row carries no more personal data than it needs ---");
  ok("no address on a list row", !("address" in busy), Object.keys(busy));
  ok("no PIN code on a list row", !("pinCode" in busy) && !("pin_code" in busy));
  ok("no WhatsApp number on a list row", !("whatsapp" in busy));
  ok("there is no email field, because this shop stores none",
     !("email" in busy), Object.keys(busy));

  console.log("\n--- pagination ---");
  r = await call("GET", "/api/admin/customers?page=2", null, OWNER);
  ok("page 2 returns the rest", r.j.rows.length === 21, r.j.rows.length);
  ok("and says it is page 2", r.j.page === 2, r.j.page);

  const p1 = (await call("GET", "/api/admin/customers?page=1", null, OWNER)).j.rows.map(c => c.id);
  const p2 = r.j.rows.map(c => c.id);
  ok("the two pages do not overlap",
     p1.every(id => !p2.includes(id)), p1.filter(id => p2.includes(id)));
  ok("between them they are the whole book",
     new Set([...p1, ...p2]).size === 46, new Set([...p1, ...p2]).size);

  r = await call("GET", "/api/admin/customers?page=99", null, OWNER);
  ok("asking past the end lands on the last page, not an empty one",
     r.j.page === 2 && r.j.rows.length > 0, [r.j.page, r.j.rows.length]);
  r = await call("GET", "/api/admin/customers?page=-5", null, OWNER);
  ok("a negative page is clamped, not an error", r.status === 200 && r.j.page === 1, r.j.page);
  r = await call("GET", "/api/admin/customers?pageSize=100000", null, OWNER);
  ok("a huge pageSize cannot pull the whole database",
     r.j.rows.length <= adminCustomers.MAX_PAGE_SIZE, r.j.rows.length);

  /* ================================================================
     2.  SEARCH
     ================================================================ */
  console.log("\n--- search, on the server ---");

  const find = async q => (await call("GET", "/api/admin/customers?q=" +
    encodeURIComponent(q), null, OWNER)).j;

  ok("by name", (await find("Patel")).total === 1);
  ok("by part of a name, any case", (await find("patel tim")).total === 1);
  ok("by phone", (await find("9000000004")).total === 1);
  ok("by part of a phone", (await find("90000000")).total >= 5);
  ok("by GSTIN", (await find("27AAAAA0000A1Z5")).total === 1);
  ok("by customer id", (await find("C-BUSY")).total === 1);
  ok("by WhatsApp number", (await find("9000000009")).total === 1);
  ok("a search with no match returns none, and says so",
     (await find("zzzznothing")).total === 0);

  console.log("\n--- the search box cannot be made to lie ---");
  const pct = await find("50%");
  ok("a literal % matches only the name containing it",
     pct.total === 1 && pct.rows[0].id === "C-PCT", pct.rows.map(c => c.id));
  const und = await find("A_B");
  ok("a literal _ is not a wildcard",
     und.total === 1 && und.rows[0].id === "C-UND", und.rows.map(c => c.id));
  ok("a bare % does not match every customer",
     (await find("%")).total === 1, (await find("%")).total);
  ok("a bare _ does not match every customer",
     (await find("_")).total === 1, (await find("_")).total);
  ok("a backslash is harmless", (await find("\\")).total === 0);

  /* ================================================================
     3.  FILTERS
     ================================================================ */
  console.log("\n--- filters, each answerable from real data ---");

  const filt = async f => (await call("GET", "/api/admin/customers?filter=" + f +
    "&pageSize=100", null, OWNER)).j;

  ok("active excludes the switched-off one",
     (await filt("active")).rows.every(c => c.active === true));
  const off = await filt("inactive");
  ok("inactive finds exactly the switched-off one",
     off.total === 1 && off.rows[0].id === "C-OFF", off.rows.map(c => c.id));
  const owing = await filt("owing");
  ok("owing finds only customers with a due",
     owing.rows.every(c => c.due > 0) && owing.total === 2, owing.rows.map(c => c.id));
  const over = await filt("overlimit");
  ok("over-limit counts only where a limit was agreed",
     over.total === 1 && over.rows[0].id === "C-OVER", over.rows.map(c => c.id));
  ok("a customer with a 50,000 limit and 12,000 owing is NOT over it",
     !over.rows.some(c => c.id === "C-BUSY"));
  const fresh = await filt("new");
  ok("recently added finds the new one", fresh.rows.some(c => c.id === "C-NEW"));
  ok("and not one added 400 days ago", !fresh.rows.some(c => c.id === "C-OFF"));
  const dormant = await filt("dormant");
  ok("no-recent-sale includes a customer who has never bought",
     dormant.rows.some(c => c.id === "C-NEW"), dormant.total);
  ok("and excludes one who bought three days ago",
     !dormant.rows.some(c => c.id === "C-BUSY"));

  r = await call("GET", "/api/admin/customers?filter=nonsense", null, OWNER);
  ok("an unknown filter falls back to all, it does not throw",
     r.status === 200 && r.j.filter === "all", [r.status, r.j.filter]);
  r = await call("GET", "/api/admin/customers?sort=nonsense", null, OWNER);
  ok("an unknown sort falls back to name", r.status === 200 && r.j.sort === "name", r.j.sort);

  console.log("\n--- sorting cannot be used to inject SQL ---");
  for (const bad of ["name; DROP TABLE customers", "c.due DESC--", "__proto__"]) {
    r = await call("GET", "/api/admin/customers?sort=" + encodeURIComponent(bad), null, OWNER);
    ok("sort=" + bad.slice(0, 20) + " is ignored", r.status === 200 && r.j.sort === "name", r.j.sort);
  }
  ok("the customers table is still there",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM customers").get().n) === 46);

  /* ================================================================
     4.  THE PROFILE
     ================================================================ */
  console.log("\n--- a customer with books ---");

  r = await call("GET", "/api/admin/customers/C-BUSY", null, OWNER);
  ok("the profile loads", r.status === 200, r.status);
  const d = r.j;

  ok("it carries the stored details",
     d.customer.name === "Patel Timber" && d.customer.address === "12 Market Road" &&
     d.customer.pinCode === "400001" && d.customer.whatsapp === "9000000009", d.customer);
  ok("the customer id is shown as-is — it is the app's own identifier",
     d.customer.id === "C-BUSY");
  ok("purchases exclude the voided bill", d.summary.sales === 16000, d.summary.sales);
  ok("the bill count excludes the challan", d.summary.bills === 2, d.summary.bills);
  ok("the challan is counted separately", d.summary.challans === 1, d.summary.challans);
  ok("payments exclude the voided one", d.summary.paid === 4000, d.summary.paid);
  ok("the payment count does too", d.summary.payments === 1, d.summary.payments);
  ok("outstanding is the customer's due", d.summary.outstanding === 12000);
  ok("the average bill is worked out from the real two", d.summary.averageBill === 8000,
     d.summary.averageBill);
  ok("first and last sale are real dates",
     d.summary.firstSale === localDate(dayAgo(10)) &&
     d.summary.lastSale === localDate(dayAgo(3)), d.summary);

  ok("recent invoices include the challan, marked as one",
     d.recentInvoices.some(i => i.docType === "challan"));
  ok("recent invoices exclude the voided bill",
     !d.recentInvoices.some(i => i.total === 99999));
  ok("recent payments exclude the voided one",
     !d.recentPayments.some(p => p.amount === 7777));
  ok("usage says what is attached to this customer",
     d.usage.invoices === 4 && d.usage.payments === 2, d.usage);

  console.log("\n--- activity is built from linked records, not guessed ---");
  ok("it says it is not an event feed yet", d.activity.fromEventSystem === false);
  ok("the customer being added is the oldest event",
     d.activity.events[d.activity.events.length - 1].kind === "created",
     d.activity.events.map(e => e.kind));
  ok("invoices appear", d.activity.events.some(e => e.kind === "invoice"));
  ok("payments appear", d.activity.events.some(e => e.kind === "payment"));
  ok("the challan appears, as a challan", d.activity.events.some(e => e.kind === "challan"));
  ok("newest first", d.activity.events.every((e, i, a) => i === 0 || a[i - 1].at >= e.at));

  console.log("\n--- a customer with nothing attached ---");
  r = await call("GET", "/api/admin/customers/C-NEW", null, OWNER);
  ok("the profile still loads", r.status === 200, r.status);
  ok("totals are real zeros", r.j.summary.sales === 0 && r.j.summary.bills === 0);
  ok("the average bill is not 0/0", r.j.summary.averageBill === null, r.j.summary.averageBill);
  ok("there are no invoices or payments to list",
     r.j.recentInvoices.length === 0 && r.j.recentPayments.length === 0);
  ok("but the customer-added event is still there",
     r.j.activity.events.length === 1 && r.j.activity.events[0].kind === "created");
  ok("nothing is attached", r.j.usage.invoices === 0 && r.j.usage.payments === 0);

  console.log("\n--- a customer with far more than a page of records ---");
  r = await call("GET", "/api/admin/customers/C-BULK00", null, OWNER);
  ok("the totals count every one of the thirty", r.j.summary.bills === 30, r.j.summary.bills);
  ok("but only ten are sent", r.j.recentInvoices.length === 10, r.j.recentInvoices.length);
  ok("and they are the most recent ten",
     r.j.recentInvoices.every((i, n, a) => n === 0 || a[n - 1].at >= i.at));
  ok("the activity list is capped too", r.j.activity.events.length <= 20,
     r.j.activity.events.length);

  console.log("\n--- an id that is not there ---");
  for (const bad of ["NOPE", "C-DOESNOTEXIST", "../settings", "'; DROP TABLE customers;--"]) {
    r = await call("GET", "/api/admin/customers/" + encodeURIComponent(bad), null, OWNER);
    ok("id " + bad.slice(0, 18) + " is a plain 404", r.status === 404, r.status);
  }
  ok("and the table survived the injection attempt",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM customers").get().n) === 46);

  /* ================================================================
     5.  ANOTHER SHOP'S CUSTOMER
     ================================================================ */
  console.log("\n--- pasting another shop's customer id ---");

  const otherExists = inOther(() =>
    db.prepare("SELECT name FROM customers WHERE id = ?").get("C-SECRET"));
  ok("the other shop really does have that customer",
     otherExists && otherExists.name === "Rival Shop Client", otherExists);

  r = await call("GET", "/api/admin/customers/C-SECRET", null, OWNER);
  ok("but this shop's owner gets 404, not their data", r.status === 404, r.status);
  ok("and not one byte of it leaks",
     !r.text.includes("Rival") && !r.text.includes("999999") &&
     !r.text.includes("Somewhere else"), r.text.slice(0, 120));

  r = await call("GET", "/api/admin/customers?q=Rival", null, OWNER);
  ok("searching for them finds nothing here", r.j.total === 0, r.j.total);

  r = await call("PUT", "/api/admin/customers/C-SECRET", { name: "Hijacked" }, OWNER);
  ok("and they cannot be edited from here either", r.status === 404, r.status);
  ok("the other shop's record is untouched",
     inOther(() => db.prepare("SELECT name FROM customers WHERE id = ?").get("C-SECRET").name)
       === "Rival Shop Client");

  /* ================================================================
     6.  WHO MAY DO WHAT
     ================================================================ */
  console.log("\n--- authorization ---");

  for (const [label, who] of [["logged out", null], ["staff", STAFF],
                              ["owner in preview", { ...OWNER, previewStaffId: "ST-A" }]]) {
    r = await call("GET", "/api/admin/customers", null, who);
    ok(label + ": the list is refused", r.status === 401 || r.status === 403, r.status);
    ok(label + ": no customer name leaks", !r.text.includes("Patel"), r.text.slice(0, 80));

    r = await call("GET", "/api/admin/customers/C-BUSY", null, who);
    ok(label + ": the profile is refused", r.status === 401 || r.status === 403, r.status);
    ok(label + ": no detail leaks", !r.text.includes("Market Road"), r.text.slice(0, 80));

    r = await call("PUT", "/api/admin/customers/C-BUSY", { name: "Hacked" }, who);
    ok(label + ": the edit is refused", r.status === 401 || r.status === 403, r.status);
  }
  ok("after all that, the name is unchanged",
     inShop(() => db.prepare("SELECT name FROM customers WHERE id = ?").get("C-BUSY").name)
       === "Patel Timber");

  console.log("\n--- reading and changing are separate permissions ---");
  ok("customers.view and customers.edit both exist",
     !!adminAccess.CAPS["customers.view"] && !!adminAccess.CAPS["customers.edit"]);
  ok("SUPPORT may read the book", adminAccess.CAPS["customers.view"].includes("SUPPORT"));
  ok("SUPPORT may NOT change it", !adminAccess.CAPS["customers.edit"].includes("SUPPORT"));

  /* Withhold edit from the owner for one request and confirm the split
     is real, not just declared. */
  const realEdit = adminAccess.CAPS["customers.edit"];
  adminAccess.CAPS["customers.edit"] = ["ADMIN"];
  r = await call("PUT", "/api/admin/customers/C-BUSY", { name: "Nope" }, OWNER);
  const rPatch = await call("PATCH", "/api/admin/customers/C-BUSY/active", { active: false }, OWNER);
  const rRead = await call("GET", "/api/admin/customers/C-BUSY", null, OWNER);
  adminAccess.CAPS["customers.edit"] = realEdit;

  ok("without customers.edit, an edit is 403", r.status === 403, r.status);
  ok("without customers.edit, switching off is 403", rPatch.status === 403, rPatch.status);
  ok("but reading still works", rRead.status === 200, rRead.status);
  ok("and the record did not change",
     inShop(() => db.prepare("SELECT name, active FROM customers WHERE id = ?").get("C-BUSY").name)
       === "Patel Timber");

  /* ================================================================
     7.  THE TWO SAFE ACTIONS
     ================================================================ */
  console.log("\n--- editing goes through the shop's own handler ---");

  const customersRouter = require(path.join(ROOT, "server/routes/customers.js"));
  ok("routes/customers.js still exports a working router",
     typeof customersRouter === "function");
  ok("and now also exports the edit handler", typeof customersRouter.updateCustomer === "function");
  ok("and the switch-off handler", typeof customersRouter.setCustomerActive === "function");

  r = await call("PUT", "/api/admin/customers/C-BUSY",
    { name: "Patel Timber & Sons", type: "Dealer", phone: "9000000001",
      address: "12 Market Road", gst: "27AAAAA0000A1Z5", state: "Maharashtra",
      pinCode: "400001", creditLimit: 60000, whatsapp: "9000000009" }, OWNER);
  ok("the edit succeeds", r.status === 200, r.status);
  const after = inShop(() => db.prepare("SELECT * FROM customers WHERE id = ?").get("C-BUSY"));
  ok("the name changed", after.name === "Patel Timber & Sons", after.name);
  ok("the credit limit changed", after.credit_limit === 60000, after.credit_limit);
  ok("the due was NOT touched by an edit", after.due === 12000, after.due);

  ok("the edit was written to the audit log, by the shop's own handler",
     inShop(() => db.prepare(
       "SELECT COUNT(*) n FROM audit_log WHERE action = 'customer.update'").get().n) === 1);

  /* The blank-clears-WhatsApp rule belongs to the shop's handler; this
     proves the admin panel inherited it rather than reimplementing it. */
  await call("PUT", "/api/admin/customers/C-BUSY",
    { name: "Patel Timber & Sons", phone: "9000000001", whatsapp: "" }, OWNER);
  ok("a blank WhatsApp CLEARS the number, exactly as the shop's rule says",
     inShop(() => db.prepare("SELECT whatsapp FROM customers WHERE id = ?").get("C-BUSY").whatsapp)
       === "", inShop(() => db.prepare("SELECT whatsapp FROM customers WHERE id = ?").get("C-BUSY")));

  console.log("\n--- switching a customer off, and back on ---");
  r = await call("PATCH", "/api/admin/customers/C-BUSY/active", { active: false }, OWNER);
  ok("switching off succeeds", r.status === 200, r.status);
  ok("the flag is set",
     inShop(() => db.prepare("SELECT active FROM customers WHERE id = ?").get("C-BUSY").active) === 0);
  ok("it is audited",
     inShop(() => db.prepare(
       "SELECT COUNT(*) n FROM audit_log WHERE action = 'customer.deactivate'").get().n) === 1);

  r = await call("PATCH", "/api/admin/customers/C-BUSY/active", { active: true }, OWNER);
  ok("switching back on succeeds — it is reversible", r.status === 200, r.status);
  ok("the flag is back",
     inShop(() => db.prepare("SELECT active FROM customers WHERE id = ?").get("C-BUSY").active) === 1);

  r = await call("PATCH", "/api/admin/customers/NOPE/active", { active: false }, OWNER);
  ok("switching off a customer who is not there is a 404", r.status === 404, r.status);

  /* ================================================================
     8.  WHAT THIS MODULE REFUSES TO DO
     ================================================================ */
  console.log("\n--- there is no delete here ---");

  for (const target of ["C-NEW", "C-BUSY"]) {
    r = await call("DELETE", "/api/admin/customers/" + target, null, OWNER);
    ok("DELETE " + target + " is not a route", r.status === 404, r.status);
  }
  ok("the unused customer is still on the books",
     inShop(() => !!db.prepare("SELECT 1 FROM customers WHERE id = ?").get("C-NEW")));

  const adminRouteSrc = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
  ok("routes/admin.js declares no delete route",
     !/router\.delete\(/.test(adminRouteSrc.replace(/\/\*[\s\S]*?\*\//g, " ")));

  const svc = fs.readFileSync(path.join(ROOT, "server/adminCustomers.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("the customer service writes nothing at all",
     !/\b(INSERT|UPDATE|DELETE)\s/i.test(svc));
  ok("and never does SELECT *", !/SELECT\s+\*/i.test(svc));

  console.log("\n--- not one rupee moves ---");
  const money = () => inShop(() => ({
    invoices: db.prepare("SELECT COUNT(*) n FROM invoices").get().n,
    invoiceTotal: db.prepare("SELECT COALESCE(SUM(total),0) t FROM invoices").get().t,
    payments: db.prepare("SELECT COUNT(*) n FROM payments").get().n,
    paymentTotal: db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payments").get().t,
    due: db.prepare("SELECT COALESCE(SUM(due),0) d FROM customers").get().d,
    cash: db.prepare("SELECT COUNT(*) n FROM cash_entries").get().n,
  }));

  const before = money();
  await call("GET", "/api/admin/customers?pageSize=100", null, OWNER);
  await call("GET", "/api/admin/customers/C-BUSY", null, OWNER);
  await call("PATCH", "/api/admin/customers/C-BUSY/active", { active: false }, OWNER);
  await call("PATCH", "/api/admin/customers/C-BUSY/active", { active: true }, OWNER);
  await call("PUT", "/api/admin/customers/C-BUSY",
    { name: "Patel Timber & Sons", phone: "9000000001" }, OWNER);
  const afterMoney = money();

  ok("no invoice was added, removed or altered",
     before.invoices === afterMoney.invoices && before.invoiceTotal === afterMoney.invoiceTotal,
     [before, afterMoney]);
  ok("no payment was either",
     before.payments === afterMoney.payments && before.paymentTotal === afterMoney.paymentTotal);
  ok("no customer's balance moved", before.due === afterMoney.due, [before.due, afterMoney.due]);
  ok("the cash book was not touched", before.cash === afterMoney.cash);

  /* ================================================================
     9.  PRIVACY
     ================================================================ */
  console.log("\n--- nothing secret crosses the wire ---");

  inShop(() => db.prepare(
    "UPDATE settings SET sync_cloud_key = ?, activation_code = ? WHERE id = 1")
    .run("KEYVALUE0123456789abcdef", "ACTIVATION-SECRET"));

  const listText = (await call("GET", "/api/admin/customers?pageSize=100", null, OWNER)).text;
  const profText = (await call("GET", "/api/admin/customers/C-BUSY", null, OWNER)).text;

  for (const blob of [listText, profText]) {
    ok("no sync key", !blob.includes("KEYVALUE0123456789abcdef"));
    ok("no activation code", !blob.includes("ACTIVATION-SECRET"));
    ok("no pin hash", !/pin_hash/i.test(blob));
    ok("no filesystem path", !/[A-Za-z]:[\\/]|\/home\/|\/tmp\//.test(blob));
    ok("no SQL", !/SELECT |FROM customers/i.test(blob));
    ok("no stack trace", !/\bat \w+ \(/.test(blob));
  }

  /* ================================================================
     10.  THE SHOP'S OWN SCREENS STILL WORK
     ================================================================ */
  console.log("\n--- the shop app's customers API is unchanged ---");

  const shopApp = express();
  shopApp.use(express.json());
  shopApp.use((req, _res, next) => {
    req.session = { loggedIn: true, role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
    db.companies.runAs(SHOP.id, next);
  });
  shopApp.use("/api/customers", customersRouter);
  const shopSrv = shopApp.listen(0);
  const shopBase = "http://127.0.0.1:" + shopSrv.address().port;

  let sr = await fetch(shopBase + "/api/customers");
  const shopList = await sr.json();
  ok("GET /api/customers still returns the full list it always did",
     sr.status === 200 && Array.isArray(shopList) && shopList.length === 46,
     [sr.status, shopList.length]);

  sr = await fetch(shopBase + "/api/customers/C-BUSY");
  const shopDetail = await sr.json();
  ok("GET /api/customers/:id still returns the full detail shape",
     sr.status === 200 && Array.isArray(shopDetail.ledger) &&
     Array.isArray(shopDetail.history) && Array.isArray(shopDetail.payments),
     Object.keys(shopDetail || {}).slice(0, 10));
  ok("including the running-balance ledger the shop screen draws",
     shopDetail.ledger.every(l => typeof l.runningBalance === "number"));

  sr = await fetch(shopBase + "/api/customers/C-BUSY", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Patel Timber & Sons", phone: "9000000001" }),
  });
  ok("PUT /api/customers/:id still works from the shop app", sr.status === 200, sr.status);

  sr = await fetch(shopBase + "/api/customers/C-BUSY/usage");
  ok("the usage endpoint the delete confirmation relies on still works",
     sr.status === 200, sr.status);

  shopSrv.close();
  srv.close();

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
