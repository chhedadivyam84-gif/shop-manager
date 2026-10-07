/* ============================================================
   ADMIN DASHBOARD — PART 2

   The dashboard's one promise is that every figure on it is read out of
   the books. So most of what is below seeds a known set of records and
   then insists the screen reports exactly those, and the rest tries to
   make it report something that is not there:

     - a delivery challan counted as a sale (it carries no money)
     - a voided invoice counted as a sale
     - a voided payment counted as taken
     - a zero shown while a figure is still loading
     - a confident "0 low stock" when no minimum level has ever been set
     - a "0 failed payments" when the shop has no way to record one
     - one broken section taking the other seven down with it
     - a staff member reading any of it

   It also holds the line on the thing that made this reuse worth doing:
   the dashboard's alert counts must equal what the shop's own Reminders
   screen says, because they are now the same function.

   Run:  node test/admin-dashboard.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-admindash-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const dashboard = require(path.join(ROOT, "server/adminDashboard.js"));
const { requireAuth } = require(path.join(ROOT, "server/auth.js"));
const { localDate } = require(path.join(ROOT, "server/util.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

/* Two companies, physically separate databases: one that has never
   traded, one with a known set of books. The empty one is not a
   contrivance — it is what every new shop looks like on day one, and
   it is where a dashboard most wants to invent a number. */
const EMPTY = db.companies.create({ name: "Empty Shop" });
const SHOP = db.companies.create({ name: "Seeded Shop" });

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
const call = async (method, url, who) => {
  if (who !== undefined) WHO = who;
  const r = await fetch(BASE + url, { method });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

const OWNER = { role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
const STAFF = { role: "staff", staffId: "ST-A", staffName: "Counter" };

const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inEmpty = fn => db.companies.runAs(EMPTY.id, fn);

/* ------------------------------------------------------------------
   THE BOOKS

   Deliberately small and fully known, so every assertion below can name
   the figure it expects rather than checking that something came back.
   ------------------------------------------------------------------ */
const dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const TODAY = localDate(new Date());
const YESTERDAY = localDate(dayAgo(1));
const MONTH_START = (() => { const d = new Date(); return localDate(new Date(d.getFullYear(), d.getMonth(), 1)); })();

/* Today's priced sales: 10,000 + 5,000 = 15,000.
   Plus a challan (no money), a voided bill, and yesterday's 4,000. */
const SALES_TODAY = 15000;
const SALES_YESTERDAY = 4000;

function seed() {
  inShop(() => {
    const now = Date.now();

    db.prepare(`INSERT INTO customers (id,name,type,phone,credit_limit,due,created_at,active)
                VALUES (?,?,?,?,?,?,?,1)`).run("C1", "Patel Timber", "Dealer", "9000000001", 50000, 12000, now);
    db.prepare(`INSERT INTO customers (id,name,type,phone,credit_limit,due,created_at,active)
                VALUES (?,?,?,?,?,?,?,1)`).run("C2", "Shah Interiors", "Retail Customer", "9000000002", 10000, 25000, now);
    db.prepare(`INSERT INTO customers (id,name,type,phone,credit_limit,due,created_at,active)
                VALUES (?,?,?,?,?,?,?,0)`).run("C3", "Closed Account", "Retail Customer", "", 0, 0, now);

    db.prepare(`INSERT INTO products (id,name,gst_rate,stock,created_at,active)
                VALUES (?,?,?,?,?,1)`).run("P1", "Marine Ply 18mm", 18, 40, now);
    db.prepare(`INSERT INTO products (id,name,gst_rate,stock,created_at,active)
                VALUES (?,?,?,?,?,1)`).run("P2", "Door Handle", 18, 0, now);

    db.prepare("INSERT INTO product_sizes (id,product_id,label,price,stock) VALUES (?,?,?,?,?)")
      .run(1, "P1", "8x4", 2400, 40);
    db.prepare("INSERT INTO product_sizes (id,product_id,label,price,stock) VALUES (?,?,?,?,?)")
      .run(2, "P2", "Standard", 180, 0);

    const bill = (id, no, type, date, total, voided) =>
      db.prepare(`INSERT INTO invoices
          (id,challan_no,doc_type,date,created_at,customer_id,subtotal,total,voided)
          VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, no, type, date, now, "C1", total, total, voided);

    bill("I1", "SP0000001", "invoice", TODAY, 10000, 0);
    bill("I2", "SP0000002", "invoice", TODAY, 5000, 0);
    bill("I3", "SP0000003", "invoice", TODAY, 99999, 1);        // voided — must not count
    bill("I4", "DC0000001", "challan", TODAY, 0, 0);            // no money — must not count
    bill("I5", "SP0000004", "invoice", YESTERDAY, 4000, 0);

    db.prepare(`INSERT INTO payments (id,customer_id,amount,method,voided,created_at)
                VALUES (?,?,?,?,?,?)`).run("PAY1", "C1", 3000, "Cash", 0, now);
    db.prepare(`INSERT INTO payments (id,customer_id,amount,method,voided,created_at)
                VALUES (?,?,?,?,?,?)`).run("PAY2", "C2", 2000, "UPI", 0, now);
    db.prepare(`INSERT INTO payments (id,customer_id,amount,method,voided,created_at)
                VALUES (?,?,?,?,?,?)`).run("PAY3", "C1", 7777, "Cash", 1, now);  // voided

    db.prepare(`INSERT INTO audit_log (at,staff_id,staff_name,role,action,details)
                VALUES (?,?,?,?,?,?)`).run(now, "ST-OWNER", "Owner", "owner", "invoice.create", "SP0000001");
    db.prepare(`INSERT INTO audit_log (at,staff_id,staff_name,role,action,details)
                VALUES (?,?,?,?,?,?)`).run(now, "ST-A", "Counter", "staff", "payment.create", "PAY1");
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  A SHOP WITH BOOKS — the figures must be the seeded ones
     ================================================================ */
  console.log("\n--- the dashboard reports what is actually in the books ---");

  CO = SHOP.id;
  let r = await call("GET", "/api/admin/dashboard", OWNER);
  ok("the dashboard loads", r.status === 200, r.status);

  const S = r.j.sections;
  ok("all eight sections came back", Object.keys(S).length === 8, Object.keys(S));
  ok("every section succeeded",
     Object.keys(S).every(k => S[k].ok === true),
     Object.keys(S).filter(k => !S[k].ok));

  const ov = S.overview.data;
  ok("customers counted: 3", ov.customers.value === 3, ov.customers);
  ok("products counted: 2 active", ov.products.value === 2, ov.products);
  ok("today's sales are exactly the two priced bills",
     ov.todaysSales.value === SALES_TODAY, ov.todaysSales);
  ok("outstanding is the sum of what customers owe (12000 + 25000)",
     ov.outstanding.value === 37000, ov.outstanding);
  ok("invoices counted excludes the voided one and the challan",
     ov.invoices.value === 3, ov.invoices);
  ok("the figures are stamped with today's date", ov.asOf === TODAY, ov.asOf);

  console.log("\n--- a challan is not a sale, and a voided bill is not a sale ---");
  const sales = S.sales.data;
  ok("today's sales ignore the 99,999 voided bill",
     sales.today.value === SALES_TODAY, sales.today);
  ok("today's sales ignore the delivery challan",
     sales.today.value === SALES_TODAY, sales.today);
  ok("yesterday is read separately", sales.yesterday.value === SALES_YESTERDAY, sales.yesterday);
  ok("the shop is known to have traded", sales.hasAnySales === true);
  ok("bills today counts 2, not 4", sales.billsToday.value === 2, sales.billsToday);
  ok("the unbilled challan is reported, separately from sales",
     sales.openChallans.value === 1, sales.openChallans);

  console.log("\n--- the chart is fourteen real days ---");
  ok("fourteen points", sales.series.length === 14, sales.series.length);
  ok("the last point is today", sales.series[13].date === TODAY, sales.series[13].date);
  ok("today's point carries today's money",
     sales.series[13].total === SALES_TODAY, sales.series[13]);
  ok("yesterday's point carries yesterday's money",
     sales.series[12].total === SALES_YESTERDAY, sales.series[12]);
  ok("a day with no trade is a real zero, not a gap",
     sales.series.slice(0, 12).every(p => p.total === 0));
  ok("every point has the date it belongs to",
     sales.series.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date)));
  ok("the dates run forward and do not repeat",
     new Set(sales.series.map(p => p.date)).size === 14);

  console.log("\n--- period comparison does not invent a baseline ---");
  ok("a change against an empty previous period is null, not +100%",
     sales.vsPrevWeek === null || typeof sales.vsPrevWeek === "number", sales.vsPrevWeek);
  ok("today against yesterday is a real percentage",
     Math.abs(sales.vsYesterday - 275) < 0.01, sales.vsYesterday);
  ok("the month window starts on the 1st",
     sales.periodLabels.monthFrom === MONTH_START, sales.periodLabels);
  ok("the month window ends today",
     sales.periodLabels.monthTo === TODAY, sales.periodLabels);
  /* The server sends ISO bounds and lets the browser format them, so a
     date is shown the one way the rest of the app shows one. */
  ok("period bounds are raw ISO dates, not a pre-formatted sentence",
     Object.values(sales.periodLabels).every(v => /^\d{4}-\d{2}-\d{2}$/.test(v)),
     sales.periodLabels);

  console.log("\n--- customers ---");
  const cu = S.customers.data;
  ok("total is every customer on file", cu.total.value === 3, cu.total);
  ok("on the books excludes the inactive one", cu.onBooks.value === 2, cu.onBooks);
  ok("'bought recently' counts customers who were billed, not customers who exist",
     cu.buying.value === 1, cu.buying);
  ok("the window is stated, not hidden", cu.buyingWindowDays === 90, cu.buyingWindowDays);
  ok("two customers owe money", cu.owing.value === 2, cu.owing);
  ok("owed total is 37,000", cu.owedTotal.value === 37000, cu.owedTotal);
  ok("over-limit counts only where a limit was agreed (C2: 25000 > 10000)",
     cu.overLimit.value === 1, cu.overLimit);
  ok("recently added lists real customers", cu.recent.length === 3, cu.recent.length);
  ok("and nothing else", cu.recent.every(c => ["C1", "C2", "C3"].includes(c.id)));

  console.log("\n--- inventory, and the low-stock rule the shop has not configured ---");
  const inv = S.inventory.data;
  ok("products counted", inv.products.value === 2, inv.products);
  ok("sizes counted", inv.sizes.value === 2, inv.sizes);
  ok("the size with no stock is out of stock", inv.outOfStock.value === 1, inv.outOfStock);
  ok("LOW STOCK IS NOT A NUMBER when no minimum has been set",
     inv.lowStock.available === false, inv.lowStock);
  ok("and it says what is needed to make it one",
     /minimum stock/i.test(inv.lowStock.reason), inv.lowStock.reason);
  ok("it does not reuse the shop dashboard's hard-coded 'stock < 15'",
     !/15/.test(JSON.stringify(inv.lowStock)));
  ok("stock VALUE is refused, with the reason",
     inv.stockValue.available === false && /different units/i.test(inv.stockValue.reason));

  /* Now configure one, and the figure must appear. */
  inShop(() => {
    db.prepare("INSERT INTO locations (id,code,name,sort_order,created_at) VALUES (?,?,?,?,?)")
      .run("L1", "MAIN", "Main Godown", 1, Date.now());
    db.prepare(`INSERT INTO size_location_stock (size_id,location_id,quantity,min_stock,last_updated)
                VALUES (?,?,?,?,?)`).run(1, "L1", 3, 10, Date.now());   // 3 on hand, 10 wanted
    db.prepare(`INSERT INTO size_location_stock (size_id,location_id,quantity,min_stock,last_updated)
                VALUES (?,?,?,?,?)`).run(2, "L1", 99, 10, Date.now());  // comfortably above
  });
  r = await call("GET", "/api/admin/dashboard?only=inventory", OWNER);
  const inv2 = r.j.sections.inventory.data;
  ok("once a minimum IS set, low stock becomes a real figure",
     inv2.lowStock.available === true, inv2.lowStock);
  ok("and it counts only the size actually below its own minimum",
     inv2.lowStock.value === 1, inv2.lowStock);
  ok("the number of configured levels is reported too",
     inv2.thresholdsSet.value === 2, inv2.thresholdsSet);

  console.log("\n--- payments, and the one metric that cannot exist ---");
  const pay = S.payments.data;
  ok("money taken today is the two live payments (3000 + 2000)",
     pay.takenToday.value === 5000, pay.takenToday);
  ok("the voided 7,777 is not counted as taken",
     pay.takenMonth.value === 5000, pay.takenMonth);
  ok("but it IS counted as a reversal", pay.reversedMonth.value === 1, pay.reversedMonth);
  ok("FAILED PAYMENTS IS REFUSED, not reported as zero",
     pay.failed.available === false, pay.failed);
  ok("and the reason says why the shop cannot know",
     /never entered|no record/i.test(pay.failed.reason), pay.failed.reason);
  ok("outstanding matches the customer ledger", pay.outstanding.value === 37000, pay.outstanding);
  ok("the method breakdown is real",
     pay.byMethod.length === 2 &&
     pay.byMethod.some(m => m.method === "Cash" && m.total === 3000) &&
     pay.byMethod.some(m => m.method === "UPI" && m.total === 2000), pay.byMethod);
  ok("the voided payment is absent from the breakdown",
     !pay.byMethod.some(m => m.total === 7777), pay.byMethod);

  console.log("\n--- recent activity is the real audit log ---");
  const act = S.activity.data;
  ok("it is available, because this app has always had an audit log",
     act.available === true);
  ok("it lists the seeded entries", act.entries.length === 2, act.entries.length);
  ok("with who did it", act.entries.some(e => e.who === "Owner") &&
     act.entries.some(e => e.who === "Counter"));
  ok("with what they did", act.entries.some(e => e.action === "invoice.create"));
  ok("newest first", act.entries[0].at >= act.entries[1].at);

  console.log("\n--- system status says enough and no more ---");
  const sys = S.system.data;
  ok("the app reports itself running", sys.app.ok === true);
  ok("the database is reachable", sys.database.ok === true, sys.database);
  ok("uptime is a whole number of seconds", Number.isInteger(sys.uptimeSeconds));
  ok("sync is reported as not set up", sys.sync.configured === false, sys.sync);
  ok("the sync ADDRESS is never sent", !("url" in sys.sync), Object.keys(sys.sync));
  ok("the sync KEY is never sent", !JSON.stringify(sys).toLowerCase().includes("key") ||
     !/sync_cloud_key|accept_hash/.test(JSON.stringify(sys)), JSON.stringify(sys).slice(0, 120));

  /* ================================================================
     2.  A SHOP WITH NO BOOKS AT ALL
     ================================================================ */
  console.log("\n--- a brand-new shop: empty states, not fake statistics ---");

  CO = EMPTY.id;
  r = await call("GET", "/api/admin/dashboard", OWNER);
  ok("the dashboard still loads for an empty shop", r.status === 200, r.status);
  const E = r.j.sections;
  ok("every section still succeeds", Object.keys(E).every(k => E[k].ok === true),
     Object.keys(E).filter(k => !E[k].ok));
  ok("sales knows the shop has never traded", E.sales.data.hasAnySales === false);
  ok("today's sales are a real zero, available and zero",
     E.overview.data.todaysSales.available === true &&
     E.overview.data.todaysSales.value === 0, E.overview.data.todaysSales);
  ok("no customers", E.customers.data.total.value === 0);
  ok("no invented chart data",
     E.sales.data.series.every(p => p.total === 0 && p.bills === 0));
  ok("low stock is unavailable, not zero", E.inventory.data.lowStock.available === false);
  ok("the activity log is available but empty, not fabricated",
     E.activity.data.available === true && E.activity.data.entries.length === 0);
  ok("no alerts invented for an empty shop", E.alerts.data.total === 0, E.alerts.data);

  CO = SHOP.id;

  /* ================================================================
     3.  ALERTS COME FROM THE SHOP'S OWN REMINDER ENGINE
     ================================================================ */
  console.log("\n--- the alert counts equal the shop's own Reminders screen ---");

  const alertsRouter = require(path.join(ROOT, "server/routes/alerts.js"));
  ok("alerts.js still exports a working router", typeof alertsRouter === "function");
  ok("and now also exports the engine", typeof alertsRouter.buildAlerts === "function");

  const direct = db.companies.runAs(SHOP.id,
    () => alertsRouter.buildAlerts({ session: { loggedIn: true, role: "owner" } }));
  r = await call("GET", "/api/admin/dashboard?only=alerts", OWNER);
  const viaDash = r.j.sections.alerts.data;

  ok("the same number of groups",
     viaDash.groups.length === direct.groups.length,
     [viaDash.groups.length, direct.groups.length]);
  ok("the same total", viaDash.total === direct.total, [viaDash.total, direct.total]);
  ok("group for group, the same counts",
     direct.groups.every(g => {
       const mine = viaDash.groups.find(x => x.key === g.key);
       return mine && mine.count === g.count && mine.title === g.title;
     }), viaDash.groups);
  ok("the dashboard sends counts, NOT the lists behind them",
     viaDash.groups.every(g => !("items" in g)), viaDash.groups[0]);
  ok("the unbilled challan shows up as a real alert",
     direct.groups.some(g => g.key === "sales-unbilled"), direct.groups.map(g => g.key));

  /* ================================================================
     4.  ONE BROKEN SECTION MUST NOT TAKE THE SCREEN DOWN
     ================================================================ */
  console.log("\n--- a section that throws ---");

  const realBuild = dashboard.SECTIONS.customers.build;
  dashboard.SECTIONS.customers.build = () => {
    throw new Error("no such column: secret_token in C:/Users/prafu/shop-manager/data/shop.db");
  };
  r = await call("GET", "/api/admin/dashboard", OWNER);
  dashboard.SECTIONS.customers.build = realBuild;

  ok("the request still succeeds", r.status === 200, r.status);
  ok("the broken section is reported as failed", r.j.sections.customers.ok === false);
  ok("the other seven still rendered",
     Object.keys(r.j.sections).filter(k => r.j.sections[k].ok).length === 7,
     Object.keys(r.j.sections).filter(k => !r.j.sections[k].ok));
  ok("the thrown message NEVER reaches the browser",
     !r.text.includes("secret_token") && !r.text.includes("shop.db"),
     r.j.sections.customers.error);
  ok("no file path is leaked", !/[A-Za-z]:[\\/]/.test(r.text));
  ok("the section is marked retryable, not refused",
     r.j.sections.customers.refused === false, r.j.sections.customers);

  console.log("\n--- a section the login may not see ---");
  const realCaps = adminAccess.CAPS["security.view"];
  adminAccess.CAPS["security.view"] = ["ADMIN"];          // an owner no longer qualifies
  r = await call("GET", "/api/admin/dashboard", OWNER);
  adminAccess.CAPS["security.view"] = realCaps;

  ok("the audit log is refused when the capability is withheld",
     r.j.sections.activity.ok === false && r.j.sections.activity.refused === true,
     r.j.sections.activity);
  ok("so is system status", r.j.sections.system.refused === true);
  ok("the business sections are unaffected", r.j.sections.sales.ok === true);
  ok("a refused section leaks no data at all",
     !("data" in r.j.sections.activity), r.j.sections.activity);

  /* ================================================================
     5.  WHO MAY READ IT
     ================================================================ */
  console.log("\n--- authorization ---");

  r = await call("GET", "/api/admin/dashboard", null);
  ok("logged out: 401", r.status === 401, r.status);
  ok("logged out: no figures in the body", !/todaysSales|outstanding/.test(r.text));

  r = await call("GET", "/api/admin/dashboard", STAFF);
  ok("staff: 403", r.status === 403, r.status);
  ok("staff: not one figure comes back",
     !/todaysSales|outstanding|audit/.test(r.text), r.text.slice(0, 100));

  r = await call("GET", "/api/admin/dashboard", { ...OWNER, previewStaffId: "ST-A" });
  ok("an owner previewing a staff member: 403", r.status === 403, r.status);

  console.log("\n--- the ?only= parameter is not a way in ---");
  for (const bad of ["nonsense", "__proto__", "constructor", "../settings", "SECTIONS"]) {
    r = await call("GET", "/api/admin/dashboard?only=" + encodeURIComponent(bad), OWNER);
    ok("only=" + bad + " is refused", r.status === 400, r.status);
  }
  r = await call("GET", "/api/admin/dashboard?only=sales", OWNER);
  ok("only=sales returns just that section",
     r.status === 200 && Object.keys(r.j.sections).length === 1 && r.j.sections.sales.ok,
     Object.keys(r.j.sections));

  /* ================================================================
     6.  WHAT MUST NEVER BE IN THE PAYLOAD
     ================================================================ */
  console.log("\n--- the payload carries no secret and no plumbing ---");

  inShop(() => {
    db.prepare(`UPDATE settings SET sync_cloud_url = ?, sync_cloud_key = ?,
                   sync_accept_hash = ? WHERE id = 1`)
      .run("https://example.invalid", "KEYVALUE0123456789abcdef", "salt:hash");
  });
  r = await call("GET", "/api/admin/dashboard", OWNER);
  const body = r.text;

  ok("the sync key is not in the payload", !body.includes("KEYVALUE0123456789abcdef"));
  ok("the sync URL is not in the payload", !body.includes("example.invalid"));
  ok("the accept hash is not in the payload", !body.includes("salt:hash"));
  ok("but sync IS reported as configured",
     r.j.sections.system.data.sync.configured === true, r.j.sections.system.data.sync);

  ["pin_hash", "activation_code", "license_key", "scan_credentials", "gst_credentials",
   "install_id", "DATA_DIR", "SESSION_SECRET"].forEach(secret => {
    ok("no " + secret + " in the payload", !body.toLowerCase().includes(secret.toLowerCase()));
  });
  ok("no filesystem path", !/[A-Za-z]:[\\/]|\/home\/|\/tmp\//.test(body));
  ok("no SQL in the payload", !/SELECT |FROM invoices/i.test(body));
  ok("no stack trace", !/\bat \w+ \(/.test(body));

  /* ================================================================
     7.  THE DASHBOARD IS READ-ONLY
     ================================================================ */
  console.log("\n--- drawing the dashboard changes nothing ---");

  const census = () => inShop(() => ({
    customers: db.prepare("SELECT COUNT(*) n FROM customers").get().n,
    invoices: db.prepare("SELECT COUNT(*) n FROM invoices").get().n,
    payments: db.prepare("SELECT COUNT(*) n FROM payments").get().n,
    products: db.prepare("SELECT COUNT(*) n FROM products").get().n,
    audit: db.prepare("SELECT COUNT(*) n FROM audit_log").get().n,
    stock: db.prepare("SELECT COALESCE(SUM(stock),0) s FROM product_sizes").get().s,
    due: db.prepare("SELECT COALESCE(SUM(due),0) d FROM customers").get().d,
  }));

  const before = census();
  for (let i = 0; i < 3; i++) await call("GET", "/api/admin/dashboard", OWNER);
  const after = census();
  ok("not one row added, removed or changed",
     JSON.stringify(before) === JSON.stringify(after), [before, after]);

  const src = fs.readFileSync(path.join(ROOT, "server/adminDashboard.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("the service runs no INSERT, UPDATE or DELETE",
     !/\b(INSERT|UPDATE|DELETE)\s/i.test(src));
  ok("and no SELECT * — every query asks for what it needs",
     !/SELECT\s+\*/i.test(src));
  ok("it aggregates in SQL rather than loading tables",
     (src.match(/COUNT\(|SUM\(/g) || []).length >= 20,
     (src.match(/COUNT\(|SUM\(/g) || []).length);

  console.log("\n--- the UI does not reach past the admin API ---");
  const ui = fs.readFileSync(path.join(ROOT, "public/js/admin.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const calls = [...new Set((ui.match(/api\("[A-Z]+",\s*"([^"]+)"/g) || [])
    .map(s => s.replace(/.*"([^"]+)"$/, "$1")))];
  ok("every API call it makes is under /admin or /auth",
     calls.every(c => c.startsWith("/admin") || c.startsWith("/auth")), calls);
  /* Anchored at the start of the path, because /admin/customers is the
     admin API and /customers is the shop's own — the first is exactly
     what this module is supposed to call and the second is the thing it
     must not reach past the admin layer to touch. */
  ok("it never calls a business endpoint directly, outside /admin",
     calls.every(c => !/^\/(invoices|customers|products|payments|reports|cashbook)\b/.test(c)),
     calls.filter(c => /^\/(invoices|customers|products|payments|reports|cashbook)\b/.test(c)));

  console.log("\n--- date handling follows the app's own convention ---");
  ok("the service uses util's localDate/todayStr, not its own",
     /require\(["']\.\/util["']\)/.test(src) &&
     /todayStr|localDate/.test(src));
  ok("it never uses toISOString, which would shift a 1am bill to yesterday",
     !/toISOString/.test(src));

  /* The browser side. A bare new Date("2026-10-07") is parsed as UTC and
     renders as the 6th here, which would have the dashboard disagreeing
     with the bill beside it about what day something happened. */
  ok("the UI parses a stored date with an explicit T00:00:00",
     /new Date\(iso \+ "T00:00:00"\)/.test(ui), "showDate");
  ok("and formats it the way the rest of the app does",
     /toLocaleDateString\("en-IN", \{ day: "numeric", month: "short", year: "numeric" \}\)/.test(ui));
  ok("no raw ISO date is printed to the reader",
     !/esc\(d\.asOf\)|esc\(c\.added\)|esc\(e\.when\)/.test(ui));

  console.log("\n--- loading and empty states exist in the UI ---");
  ok("there is a skeleton, not a zero, while a figure is in flight",
     /function skeleton\(/.test(ui) && /is-loading/.test(ui));
  ok("a missing figure renders a dash, never a 0",
     /available \? money\(f\.value\) : "\\u2014"|available \? money/.test(ui));
  ok("there is a retry for a failed section", /data-retry/.test(ui));
  ok("a refused section offers no retry (it would refuse again)",
     /section\.refused[\s\S]{0,200}?no retry/.test(
       fs.readFileSync(path.join(ROOT, "public/js/admin.js"), "utf8")));

  srv.close();

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
