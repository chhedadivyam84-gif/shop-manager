/* ============================================================
   THE PERMISSION GATE — staff reach what their permissions say, and no more

   Measured before the gate existed: a staff login with no permissions at all
   could read every customer, supplier, bill, purchase, the Outstanding
   report, the bank book and the cash and bank balances, and could create
   customers and suppliers. The screens hid it; the server did not.

   This signs in as each of the app's own default roles (permissions.js
   ROLE_DEFAULTS) and checks both directions:
     - what the role's screens need still works — a salesman can still bill
     - what it was never given is refused, and the owner's figures are
       removed from whatever it is sent
   Invented records in a temp directory.

   Run:  node test/permissions-gate.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-permgate-"));
process.env.DATA_DIR = DATA_DIR;
const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const inventory = require(path.join(ROOT, "server/inventory.js"));
const stockLedger = require(path.join(ROOT, "server/stockLedger.js"));
const permissions = require(path.join(ROOT, "server/permissions.js"));
const { todayStr } = require(path.join(ROOT, "server/util.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};

const SHOP = db.companies.create({ name: "Gate Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);

let WHO = null;
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use((req, _res, next) => {
  req.session = { loggedIn: true, ...WHO };
  db.companies.runAs(SHOP.id, () => stockLedger.withContext({ staff: WHO.staffName }, next));
});
/* The same order as index.js: the gate ahead of the business routes. */
app.use("/api", require(path.join(ROOT, "server/permissionGate.js")).gate());
for (const [mount, file] of [["customers", "customers"], ["suppliers", "suppliers"], ["invoices", "invoices"],
                             ["products", "products"], ["reports", "reports"], ["accounting", "accounting"],
                             ["bank-accounts", "bankAccounts"], ["bankbook", "bankbook"], ["purchases", "purchases"],
                             ["settings", "settings"], ["permissions", "permissions"],
                             ["transfers", "transfers"], ["sales-returns", "salesReturns"],
                             ["purchase-returns", "purchaseReturns"], ["cheques", "cheques"]]) {
  app.use("/api/" + mount, require(path.join(ROOT, "server/routes/" + file + ".js")));
}
app.use((err, req, res, next) => { console.error("[test]", err && err.message); res.status(500).json({ error: "server" }); });

let BASE;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, t };
};

function grantRole(staffId, roleName) {
  inShop(() => {
    db.prepare("DELETE FROM staff_permissions WHERE staff_id = ?").run(staffId);
    const mods = (permissions.ROLE_DEFAULTS[roleName] || { modules: {} }).modules;
    const ins = db.prepare(`INSERT INTO staff_permissions (staff_id,module,can_view,can_add,can_edit,can_print) VALUES (?,?,?,?,?,?)`);
    for (const [m, acts] of Object.entries(mods)) {
      ins.run(staffId, m, +acts.includes("view"), +acts.includes("add"), +acts.includes("edit"), +acts.includes("print"));
    }
  });
}
const as = (staffId, name) => { WHO = { role: "staff", staffId, staffName: name }; };
const asOwner = () => { WHO = { role: "owner", staffId: "STAFF_owner", staffName: "Owner" }; };

(async () => {
  inShop(() => {
    const loc = inventory.getLocationByCode("shop").id;
    const ins = db.prepare("INSERT INTO staff (id,name,pin_hash,role,active,created_at) VALUES (?,?,'x','staff',1,?)");
    for (const id of ["ST-NONE", "ST-SALES", "ST-ACCTS", "ST-BUY", "ST-STOCK"]) ins.run(id, id, Date.now());
    db.prepare("INSERT INTO customers (id,name,phone,due,created_at,active) VALUES ('C1','Gate Customer','9000000001',500,?,1)").run(Date.now());
    db.prepare("INSERT INTO suppliers (id,name,phone,due,created_at) VALUES ('S1','Gate Supplier','9000000002',900,?)").run(Date.now());
    db.prepare("INSERT INTO products (id,name,unit,gst_rate,stock,created_at,active) VALUES ('P1','Gate Ply','Sheet',18,0,?,1)").run(Date.now());
    db.prepare("INSERT INTO product_sizes (id,product_id,label,price,stock,cost_price) VALUES (1,'P1','8x4',3200,0,2500)").run();
    stockLedger.withContext({ staff: "Owner" }, () => inventory.addStock(1, loc, 50));
  });
  grantRole("ST-SALES", "Sales Staff");
  grantRole("ST-ACCTS", "Accounts Staff");
  grantRole("ST-BUY", "Purchase Staff");
  grantRole("ST-STOCK", "Stock Staff");

  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port + "/api";

  /* ---------------------------------------------------------------- */
  console.log("\n--- a login with no permissions reaches nothing but the shell ---\n");
  as("ST-NONE", "Nobody");
  for (const [m, u, b] of [["GET", "/customers"], ["GET", "/customers/C1"], ["GET", "/suppliers"], ["GET", "/invoices"],
                           ["GET", "/purchases"], ["GET", "/products"], ["GET", "/accounting/outstanding-details?side=customer"],
                           ["GET", "/reports/dashboard"], ["GET", "/bankbook"], ["GET", "/bank-accounts"],
                           ["POST", "/customers", { name: "Sneaky", phone: "9111111111" }],
                           ["POST", "/suppliers", { name: "Sneaky", phone: "9111111112" }]]) {
    const r = await call(m, u, b);
    ok(`${m} ${u} is refused (403)`, r.status === 403, [r.status, r.t.slice(0, 80)]);
  }
  ok("...and says why in plain words", /not been given access/.test((await call("GET", "/customers")).j.error));
  ok("it can still read its own permissions", (await call("GET", "/permissions/me")).status === 200);
  ok("...and the app's settings shell", (await call("GET", "/settings")).status === 200);
  ok("nothing it tried was created", inShop(() => !db.prepare("SELECT 1 FROM customers WHERE name='Sneaky'").get()
    && !db.prepare("SELECT 1 FROM suppliers WHERE name='Sneaky'").get()));

  /* ---------------------------------------------------------------- */
  console.log("\n--- a salesman can still do a salesman's job ---\n");
  as("ST-SALES", "Salesman");
  ok("reads the product list for billing", (await call("GET", "/products")).status === 200);
  const prods = (await call("GET", "/products")).j;
  ok("...WITHOUT the purchase cost (owner's figure)", !JSON.stringify(prods).includes("cost_price"), JSON.stringify(prods).slice(0, 200));
  ok("reads the customer list", (await call("GET", "/customers")).status === 200);
  const nc = await call("POST", "/customers", { name: "Walk-up Buyer", phone: "9222222222", type: "Retail Customer" });
  ok("adds a customer from the bill (Customer add)", nc.status === 201, [nc.status, nc.j && nc.j.error]);
  const inv = await call("POST", "/api/invoices".replace("/api", ""), {
    customerId: "C1", paymentMethod: "Cash", advance: 99999, date: todayStr(),
    items: [{ productId: "P1", sizeId: 1, name: "Gate Ply", sizeLabel: "8x4", pieces: 1, qty: 1, rate: 3200, gstRate: 18, unitLabel: "Sheet", mode: "UNIT" }] });
  ok("RAISES A BILL", inv.status === 201, [inv.status, inv.j && inv.j.error]);
  ok("finds bills", (await call("GET", "/invoices/search?no=SP")).status === 200);
  ok("walks billing's previous / next bills", (await call("GET", "/reports/tax-invoices")).status === 200);
  const dash = await call("GET", "/reports/dashboard");
  ok("sees the staff dashboard", dash.status === 200);
  ok("...without the cash and bank balances", dash.j && !("cashBalance" in dash.j) && !("bankBalance" in dash.j), dash.j && Object.keys(dash.j));
  ok("...without the shop-wide outstanding and payable totals", dash.j && !("outstandingTotal" in dash.j) && !("payableTotal" in dash.j));
  ok("...and without profit (already the case)", dash.j && !("todaysProfit" in dash.j));
  ok("is refused the supplier list", (await call("GET", "/suppliers")).status === 403);
  ok("is refused purchases", (await call("GET", "/purchases")).status === 403);
  ok("is refused the bank book", (await call("GET", "/bankbook")).status === 403);
  ok("cannot record a customer payment without Receipt permission",
     (await call("POST", "/customers/C1/payments", { amount: 10, method: "Cash" })).status === 403);
  ok("cannot change a customer without Customer edit... (Sales Staff has it: allowed)",
     (await call("PUT", "/customers/C1", { name: "Gate Customer", phone: "9000000001" })).status !== 403);

  /* ---------------------------------------------------------------- */
  console.log("\n--- accounts staff: receipts and outstanding, not the bank book ---\n");
  as("ST-ACCTS", "Accounts");
  ok("reads customers", (await call("GET", "/customers")).status === 200);
  ok("reads the Outstanding report", (await call("GET", "/accounting/outstanding-details?side=customer")).status === 200);
  const rec = await call("POST", "/customers/C1/payments", { amount: 100, method: "Cash", idempotencyKey: "gate-test-key-0001" });
  ok("records a customer receipt", rec.status === 201, [rec.status, rec.j && rec.j.error]);
  ok("picks a bank account for a UPI receipt", (await call("GET", "/bank-accounts")).status === 200);
  ok("...but does not see account balances", !JSON.stringify((await call("GET", "/bank-accounts")).j).includes("balance"));
  ok("cannot raise a bill", (await call("POST", "/invoices", { customerId: "C1", items: [] })).status === 403);
  ok("cannot add a customer", (await call("POST", "/customers", { name: "X", phone: "9333333333" })).status === 403);
  ok("cannot open the bank book", (await call("GET", "/bankbook")).status === 403);

  /* ---------------------------------------------------------------- */
  console.log("\n--- purchase staff: suppliers and purchases, not customers ---\n");
  as("ST-BUY", "Buyer");
  ok("reads suppliers", (await call("GET", "/suppliers")).status === 200);
  ok("reads purchases", (await call("GET", "/purchases")).status === 200);
  /* Purchase Staff is granted Reports, and reports show customers and
     bills — so reading them is what the owner granted. Changing them is not. */
  ok("reads customers only because its Reports permission covers them", (await call("GET", "/customers")).status === 200);
  ok("cannot add a customer", (await call("POST", "/customers", { name: "Y", phone: "9444444444" })).status === 403);
  ok("cannot raise a bill", (await call("POST", "/invoices", { customerId: "C1", items: [] })).status === 403);
  ok("cannot record a customer receipt", (await call("POST", "/customers/C1/payments", { amount: 5, method: "Cash" })).status === 403);
  ok("cannot pay a supplier without Payment permission", (await call("POST", "/suppliers/S1/payments", { amount: 5, method: "Cash" })).status === 403);

  /* ---------------------------------------------------------------- */
  console.log("\n--- second pass: stock, returns, transfers, cheques ---\n");
  as("ST-SALES", "Salesman");
  const shopLoc = () => inShop(() => inventory.getLocationByCode("shop").id);
  const stockBefore = inShop(() => inventory.getStock(1, shopLoc()));
  ok("a salesman cannot correct stock by hand (403)",
     (await call("PATCH", "/products/P1/sizes/1/stock", { delta: 500 })).status === 403);
  ok("...and the stock did not move", inShop(() => inventory.getStock(1, shopLoc())) === stockBefore);
  ok("a salesman cannot create a product (403)", (await call("POST", "/products", { name: "Fake", sizes: [] })).status === 403);
  ok("a salesman cannot edit a product (403)", (await call("PUT", "/products/P1", { name: "Gate Ply" })).status === 403);
  ok("a salesman cannot move stock between locations (403)", (await call("POST", "/transfers", {})).status === 403);
  ok("a salesman cannot raise a cheque (403)", (await call("POST", "/cheques", {})).status === 403);
  ok("a salesman can see sales returns", (await call("GET", "/sales-returns")).status === 200);
  ok("...but not purchase returns (403)", (await call("GET", "/purchase-returns")).status === 403);
  as("ST-STOCK", "Stock keeper");
  ok("stock staff CAN correct stock", (await call("PATCH", "/products/P1/sizes/1/stock", { delta: 1 })).status === 200);
  ok("...and reach stock transfers", (await call("POST", "/transfers", {})).status !== 403);
  ok("...but cannot raise a sales return (403)", (await call("POST", "/sales-returns", {})).status === 403);
  ok("...nor record a customer receipt (403)", (await call("POST", "/customers/C1/payments", { amount: 5, method: "Cash" })).status === 403);

  console.log("\n--- the owner is untouched; an owner previewing a staff login is not ---\n");
  asOwner();
  ok("the owner reads everything", (await call("GET", "/suppliers")).status === 200 && (await call("GET", "/bankbook")).status === 200);
  const od = (await call("GET", "/reports/dashboard")).j;
  ok("...with the cash, bank and totals", od && "cashBalance" in od && "bankBalance" in od && "outstandingTotal" in od, od && Object.keys(od));
  ok("...and the purchase cost", JSON.stringify((await call("GET", "/products")).j).includes("cost_price"));
  WHO = { role: "owner", staffId: "STAFF_owner", staffName: "Owner", previewStaffId: "ST-NONE" };
  ok("previewing the no-permission login, the owner sees what it would — nothing", (await call("GET", "/customers")).status === 403);
  asOwner();

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
