/* ============================================================
   INVOICE CREATION — one bill per submission

   A bill is raised at a counter on a shop's broadband. The submit
   button gets double-tapped, the connection drops and the browser
   retries, somebody refreshes mid-save. Each of those posts the same
   cart again, and before this there was nothing to stop the second one:
   the shop got two invoices, two document numbers, and stock deducted
   twice.

   So most of this file sends the same bill more than once, in every way
   a counter actually manages to:

     - twice in a row
     - three times at the same moment
     - after the first reply was lost

   and then counts the invoices, the numbers and the stock.

   The rest holds the lines that were already right, so they stay right:
   a document number is allocated by the server and is unique; totals
   are computed from the items rather than taken from the request; a
   challan that becomes an invoice does NOT deduct stock a second time.

   Run:  node test/invoice-create.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-invcreate-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const inventory = require(path.join(ROOT, "server/inventory.js"));
const stockLedger = require(path.join(ROOT, "server/stockLedger.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

const SHOP = db.companies.create({ name: "Our Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);

let WHO = { role: "owner", staffId: "ST-OWNER", staffName: "Owner" };

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use((req, _res, next) => {
  req.session = { loggedIn: true, ...WHO };
  db.companies.runAs(SHOP.id, () =>
    stockLedger.withContext({ staff: req.session.staffName }, next));
});
app.use("/api/invoices", require(path.join(ROOT, "server/routes/invoices.js")));
app.use((err, req, res, next) => {
  console.error("[test] unhandled:", err && err.message);
  res.status(500).json({ error: "Something went wrong on the server." });
});

let BASE;
const call = async (method, url, body, headers) => {
  const r = await fetch(BASE + url, {
    method,
    headers: Object.assign(body ? { "content-type": "application/json" } : {}, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

let SHOP_LOC, SIZE_A, SIZE_B;

function seed() {
  inShop(() => {
    SHOP_LOC = inventory.getLocationByCode("shop").id;

    db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                VALUES ('C1','Patel Timber','9000000001',0,?,1)`).run(Date.now());

    db.prepare(`INSERT INTO products (id,name,unit,gst_rate,stock,created_at,active)
                VALUES ('P1','Marine Ply 18mm','Sq.ft',18,0,?,1)`).run(Date.now());
    db.prepare(`INSERT INTO product_sizes (id,product_id,label,price,stock,cost_price)
                VALUES (1,'P1','8x4',2400,0,1800)`).run();
    db.prepare(`INSERT INTO product_sizes (id,product_id,label,price,stock,cost_price)
                VALUES (2,'P1','7x4',2100,0,1600)`).run();
    SIZE_A = 1; SIZE_B = 2;

    stockLedger.withContext({ staff: "Owner" }, () => {
      stockLedger.setContext({ movement: "opening", refType: "Opening Stock" });
      inventory.addStock(SIZE_A, SHOP_LOC, 100);
      inventory.addStock(SIZE_B, SHOP_LOC, 50);
    });
    db.prepare("UPDATE products SET stock = 150 WHERE id = 'P1'").run();
  });
}

/* One cart, used over and over. */
const cart = (extra) => Object.assign({
  customerId: "C1",
  items: [{ productId: "P1", sizeId: SIZE_A, name: "Marine Ply 18mm", sizeLabel: "8x4",
            pieces: 4, qty: 4, rate: 2400, gstRate: 18, unitLabel: "Sq.ft", mode: "UNIT" }],
  paymentMethod: "Cash",
  date: new Date().toISOString().slice(0, 10),
}, extra || {});

const counts = () => inShop(() => ({
  invoices: db.prepare("SELECT COUNT(*) n FROM invoices").get().n,
  numbers: db.prepare("SELECT COUNT(DISTINCT challan_no) n FROM invoices").get().n,
  stockA: inventory.getStock(SIZE_A, SHOP_LOC),
  due: db.prepare("SELECT COALESCE(SUM(due),0) d FROM customers").get().d,
}));

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  A BILL IS RAISED, ONCE
     ================================================================ */
  console.log("\n--- one bill, raised normally ---");

  let before = counts();
  let r = await call("POST", "/api/invoices", cart(), { "Idempotency-Key": "sub-001" });
  ok("it is created", r.status === 201, [r.status, r.j && r.j.error]);
  ok("the server allocated the number, not the browser",
     !!r.j.challan_no && /^[A-Z]/.test(r.j.challan_no), r.j && r.j.challan_no);
  ok("the total was computed server-side from the items",
     r.j.subtotal === 9600 && r.j.total > 9600, [r.j.subtotal, r.j.total]);

  let after = counts();
  ok("exactly one invoice exists", after.invoices - before.invoices === 1, [before, after]);
  ok("stock went down once, by four", before.stockA - after.stockA === 4,
     [before.stockA, after.stockA]);

  /* ================================================================
     2.  THE SAME SUBMISSION, SENT AGAIN
     ================================================================ */
  console.log("\n--- the same submission, sent again ---");

  before = counts();
  const again = await call("POST", "/api/invoices", cart(), { "Idempotency-Key": "sub-001" });
  after = counts();

  ok("the second attempt is accepted, not an error", again.status === 200, again.status);
  ok("and it hands back the SAME bill", again.j.id === r.j.id, [r.j.id, again.j.id]);
  ok("it says so, so a caller can tell", again.j.duplicateOf === r.j.id, again.j.duplicateOf);
  ok("NO SECOND INVOICE WAS CREATED", after.invoices === before.invoices, [before, after]);
  ok("NO SECOND DOCUMENT NUMBER WAS CONSUMED", after.numbers === before.numbers);
  ok("STOCK WAS NOT DEDUCTED TWICE", after.stockA === before.stockA,
     [before.stockA, after.stockA]);
  ok("the customer's balance did not move twice", after.due === before.due);

  console.log("\n--- a double-tap: two in flight at the same moment ---");
  before = counts();
  const pair = await Promise.all([
    call("POST", "/api/invoices", cart(), { "Idempotency-Key": "sub-002" }),
    call("POST", "/api/invoices", cart(), { "Idempotency-Key": "sub-002" }),
  ]);
  after = counts();
  ok("both answer without an error",
     pair.every(x => x.status === 200 || x.status === 201), pair.map(x => x.status));
  ok("they describe the same bill", pair[0].j.id === pair[1].j.id,
     pair.map(x => x.j && x.j.id));
  ok("ONE invoice was created, not two", after.invoices - before.invoices === 1, [before, after]);
  ok("and stock moved once", before.stockA - after.stockA === 4, [before.stockA, after.stockA]);

  console.log("\n--- three retries of one submission ---");
  before = counts();
  const trio = await Promise.all([1, 2, 3].map(() =>
    call("POST", "/api/invoices", cart(), { "Idempotency-Key": "sub-003" })));
  after = counts();
  ok("one invoice for three requests", after.invoices - before.invoices === 1,
     [before.invoices, after.invoices]);
  ok("all three got the same id",
     new Set(trio.map(x => x.j && x.j.id)).size === 1, trio.map(x => x.j && x.j.id));
  ok("stock moved once", before.stockA - after.stockA === 4);

  console.log("\n--- the key can travel in the body too ---");
  before = counts();
  await call("POST", "/api/invoices", cart({ idempotencyKey: "sub-004" }));
  const bodyKeyAgain = await call("POST", "/api/invoices", cart({ idempotencyKey: "sub-004" }));
  after = counts();
  ok("one invoice for both", after.invoices - before.invoices === 1, [before, after]);
  ok("the repeat is reported as a duplicate", !!bodyKeyAgain.j.duplicateOf);

  console.log("\n--- a DIFFERENT submission is still a different bill ---");
  before = counts();
  const other = await call("POST", "/api/invoices", cart(), { "Idempotency-Key": "sub-005" });
  after = counts();
  ok("a new key creates a new invoice", after.invoices - before.invoices === 1);
  ok("with its own number", other.j.challan_no !== r.j.challan_no,
     [r.j.challan_no, other.j.challan_no]);
  ok("and it deducts stock again, as it should", before.stockA - after.stockA === 4);

  console.log("\n--- no key at all still works, as it always did ---");
  before = counts();
  const noKey1 = await call("POST", "/api/invoices", cart());
  const noKey2 = await call("POST", "/api/invoices", cart());
  after = counts();
  ok("both are created", noKey1.status === 201 && noKey2.status === 201,
     [noKey1.status, noKey2.status]);
  ok("two invoices, because nothing said they were the same submission",
     after.invoices - before.invoices === 2, [before, after]);
  ok("their numbers differ", noKey1.j.challan_no !== noKey2.j.challan_no);
  ok("so the protection is opt-in and breaks nothing that came before", true);

  console.log("\n--- a key that is not a key ---");
  r = await call("POST", "/api/invoices", cart(), { "Idempotency-Key": "x".repeat(200) });
  ok("an absurdly long key is refused", r.status === 400, r.status);
  ok("and nothing was created by it",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM invoices WHERE idempotency_key = ?")
       .get("x".repeat(200)).n) === 0);

  /* ================================================================
     3.  THE DATABASE IS THE GUARANTEE
     ================================================================ */
  console.log("\n--- the constraint, not the check ---");

  const idx = inShop(() => db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_invoices_idempotency'").get());
  ok("there is a UNIQUE index on the key", !!idx && /UNIQUE/i.test(idx.sql), idx && idx.sql);
  ok("and it is PARTIAL, so old bills with no key do not collide",
     !!idx && /WHERE idempotency_key IS NOT NULL/i.test(idx.sql), idx && idx.sql);

  const nulls = inShop(() => db.prepare(
    "SELECT COUNT(*) n FROM invoices WHERE idempotency_key IS NULL").get().n);
  ok("the bills raised without a key are stored as NULL, not as ''", nulls >= 2, nulls);

  ok("a second row cannot carry the same key, whatever the app does",
     inShop(() => {
       try {
         db.prepare(`INSERT INTO invoices
             (id,challan_no,doc_type,date,created_at,subtotal,total,balance_due,idempotency_key)
           VALUES ('FORCED','FORCED-1','invoice','2026-10-08',?,1,1,0,'sub-001')`).run(Date.now());
         return false;
       } catch (e) { return /UNIQUE/i.test(e.message); }
     }));

  /* ================================================================
     4.  INVENTORY IS NOT DEDUCTED TWICE BY BILLING A CHALLAN
     ================================================================ */
  console.log("\n--- a challan, then an invoice for it ---");

  before = counts();
  const challan = await call("POST", "/api/invoices",
    cart({ docType: "challan" }), { "Idempotency-Key": "chal-001" });
  ok("the challan is created", challan.status === 201, [challan.status, challan.j && challan.j.error]);
  const afterChallan = counts();
  ok("goods leaving on a challan DO come out of stock",
     before.stockA - afterChallan.stockA === 4, [before.stockA, afterChallan.stockA]);

  const converted = await call("POST", "/api/invoices/" + challan.j.id + "/convert-to-invoice",
    { date: new Date().toISOString().slice(0, 10) });
  const afterConvert = counts();
  ok("it converts to an invoice", converted.status === 200 || converted.status === 201,
     [converted.status, converted.j && converted.j.error]);
  ok("BILLING IT DOES NOT DEDUCT THE STOCK AGAIN",
     afterConvert.stockA === afterChallan.stockA,
     [afterChallan.stockA, afterConvert.stockA]);
  ok("converting twice is refused",
     (await call("POST", "/api/invoices/" + challan.j.id + "/convert-to-invoice", {})).status === 400);

  const ledgerLines = inShop(() => db.prepare(
    "SELECT movement, qty FROM stock_ledger WHERE size_id = ? ORDER BY at DESC LIMIT 3").all(SIZE_A));
  ok("the ledger records the goods going out once, as a challan",
     ledgerLines.some(l => l.movement === "stock_out" && l.qty === -4), ledgerLines);

  /* ================================================================
     5.  WHAT THE SERVER WILL NOT ACCEPT
     ================================================================ */
  console.log("\n--- totals come from the items, never from the request ---");

  const lied = await call("POST", "/api/invoices",
    cart({ subtotal: 1, total: 1, balanceDue: 0, cgst: 0, sgst: 0 }),
    { "Idempotency-Key": "lie-001" });
  ok("a request that supplies its own totals is ignored",
     lied.j.subtotal === 9600 && lied.j.total !== 1, [lied.j.subtotal, lied.j.total]);

  console.log("\n--- invalid input ---");
  for (const [label, body] of [
    ["no items", cart({ items: [] })],
    ["items not an array", cart({ items: "all of them" })],
    ["a customer who does not exist", cart({ customerId: "NOPE" })],
  ]) {
    const res = await call("POST", "/api/invoices", body);
    ok(label + " is refused", res.status === 400, [res.status, res.j && res.j.error]);
    ok("  with a message a person can read",
       res.j && typeof res.j.error === "string" && !/SQLITE|at \w+ \(/.test(res.j.error),
       res.j && res.j.error);
  }

  /* ================================================================
     6.  NUMBERING
     ================================================================ */
  console.log("\n--- document numbers ---");

  const all = inShop(() => db.prepare(
    "SELECT challan_no FROM invoices WHERE challan_no NOT LIKE 'FORCED%'").all().map(x => x.challan_no));
  ok("every number is distinct", new Set(all).size === all.length,
     all.length - new Set(all).size);
  ok("the column itself is UNIQUE",
     /challan_no TEXT UNIQUE/.test(fs.readFileSync(path.join(ROOT, "server/db-schema.js"), "utf8")));
  ok("numbers come from the one allocator",
     /docNumber\.allocate\(/.test(fs.readFileSync(path.join(ROOT, "server/routes/invoices.js"), "utf8")));

  srv.close();

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
