/* ============================================================
   ADMIN PRODUCTS & INVENTORY — PART 4

   Stock is the one thing in this app where being wrong costs money, so
   most of what is below tries to make it wrong:

     - correct a size belonging to a DIFFERENT product
     - correct a product belonging to a DIFFERENT SHOP
     - drive a shelf negative
     - send "abc", Infinity, NaN or a billion as a count
     - correct stock without saying why
     - correct stock without the permission to
     - two people correcting the same size at the same moment
     - make the search box lie with a % or an _
     - get a low-stock verdict where nobody set a minimum

   And the ones that prove it works: that a correction writes a ledger
   row carrying the count BEFORE and AFTER, the reason, the staff name
   and the movement type; that the product-level total stays in step
   with the sum of its sizes; and that nothing it does touches an
   invoice.

   Run:  node test/admin-products.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-adminprod-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const adminProducts = require(path.join(ROOT, "server/adminProducts.js"));
const inventory = require(path.join(ROOT, "server/inventory.js"));
const stockLedger = require(path.join(ROOT, "server/stockLedger.js"));
const { requireAuth } = require(path.join(ROOT, "server/auth.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

const SHOP = db.companies.create({ name: "Our Shop" });
const OTHER = db.companies.create({ name: "Another Shop" });

let CO = SHOP.id;
let WHO = null;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = WHO ? { loggedIn: true, ...WHO } : {};
  /* Mirrors index.js: the company binder, then the per-request ledger
     context that carries the staff name. Without the second one a
     correction would record an empty staff. */
  db.companies.runAs(CO, () =>
    stockLedger.withContext({ staff: (req.session && req.session.staffName) || "" }, next));
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

let SHOP_LOC, OTHER_LOC;

/* ------------------------------------------------------------------
   THE CATALOGUE
   ------------------------------------------------------------------ */
const addProduct = (id, name, o) => db.prepare(`
  INSERT INTO products (id,name,brand,category,sku,unit,gst_rate,stock,created_at,active,code)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
  id, name, (o && o.brand) || "", (o && o.category) || "", (o && o.sku) || null,
  (o && o.unit) || "Piece", 18, 0, (o && o.created) || Date.now(),
  o && o.active === 0 ? 0 : 1, (o && o.code) || "");

const addSize = (id, productId, label, price, cost) => db.prepare(
  "INSERT INTO product_sizes (id,product_id,label,price,stock,cost_price) VALUES (?,?,?,?,0,?)")
  .run(id, productId, label, price, cost || 0);

function seed() {
  inShop(() => {
    SHOP_LOC = inventory.getLocationByCode("shop").id;

    addProduct("P-PLY", "Marine Ply 18mm", { brand: "Century", category: "Plywood",
                                             sku: "SKU-PLY-18", unit: "Sq.ft", code: "MP18" });
    addSize(1, "P-PLY", "8x4", 2400, 1800);
    addSize(2, "P-PLY", "7x4", 2100, 1600);

    addProduct("P-HDL", "Door Handle 50% Off", { brand: "Hettich", category: "Hardware",
                                                 sku: "SKU-HDL", unit: "Piece" });
    addSize(3, "P-HDL", "Standard", 180, 120);

    addProduct("P_UND", "A_B Bracket", { category: "Hardware", sku: "SKU-UND", unit: "Piece" });
    addSize(4, "P_UND", "Small", 45, 30);

    addProduct("P-NONE", "Catalogue Only", { category: "", unit: "Piece" });   /* no sizes */

    addProduct("P-OFF", "Discontinued Board", { category: "Plywood", unit: "Sq.ft", active: 0 });
    addSize(5, "P-OFF", "6x3", 900, 700);

    for (let i = 0; i < 30; i++) {
      addProduct("P-B" + String(i).padStart(2, "0"), "Bulk Item " + String(i).padStart(2, "0"),
                 { category: "Sundries", unit: "Piece" });
      addSize(100 + i, "P-B" + String(i).padStart(2, "0"), "Each", 10 + i, 5);
    }

    /* Real stock, through the real write path. */
    inventory.addStock(1, SHOP_LOC, 40);        /* plenty, no minimum  */
    inventory.addStock(2, SHOP_LOC, 3);         /* below its minimum   */
    inventory.setMinStock(2, SHOP_LOC, 10);
    inventory.addStock(4, SHOP_LOC, 25);
    inventory.setMinStock(4, SHOP_LOC, 5);      /* comfortably above   */
    /* size 3 and size 5 deliberately left at zero */

    /* addStock keeps product_sizes.stock in step but leaves
       products.stock to its caller — see the comment on
       syncSizeStockTotal. Every route that moves stock resyncs it
       afterwards, so the fixture does too; otherwise the seeded
       catalogue starts out in a drifted state no real write produces. */
    ["P-PLY", "P-HDL", "P_UND", "P-OFF"].forEach(id => {
      const total = db.prepare(
        "SELECT COALESCE(SUM(stock),0) t FROM product_sizes WHERE product_id = ?").get(id).t;
      db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(total, id);
    });
  });

  inOther(() => {
    OTHER_LOC = inventory.getLocationByCode("shop").id;
    addProduct("P-SECRET", "Rival Secret Board", { category: "Plywood", unit: "Sq.ft" });
    addSize(900, "P-SECRET", "9x5", 5555);
    inventory.addStock(900, OTHER_LOC, 777);
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  THE PRODUCT LIST
     ================================================================ */
  console.log("\n--- the product list ---");

  let r = await call("GET", "/api/admin/products", null, OWNER);
  ok("the list loads", r.status === 200, r.status);
  ok("it counts the whole catalogue", r.j.total === 35, r.j.total);
  ok("but sends one page", r.j.rows.length === 25, r.j.rows.length);
  ok("and says how many pages", r.j.pages === 2, r.j.pages);
  ok("categories come from the data, not a hard-coded list",
     r.j.options.categories.some(c => c.name === "Plywood") &&
     r.j.options.categories.some(c => c.name === "Hardware"),
     r.j.options.categories.map(c => c.name));
  ok("locations are offered", r.j.options.locations.length >= 1, r.j.options.locations);

  const ply = (await call("GET", "/api/admin/products?q=Marine", null, OWNER)).j.rows[0];
  ok("a row carries the fields the shop has",
     ply.name === "Marine Ply 18mm" && ply.brand === "Century" &&
     ply.category === "Plywood" && ply.sku === "SKU-PLY-18" && ply.unit === "Sq.ft", ply);
  ok("stock is the sum of its sizes (40 + 3)", ply.qty === 43, ply.qty);
  ok("the unit travels with the quantity", ply.unitLabel === "Sq.ft", ply.unitLabel);
  ok("two sizes are reported", ply.sizes === 2, ply.sizes);
  ok("one of them is low", ply.lowSizes === 1, ply.lowSizes);
  ok("the price is a range across its sizes",
     ply.priceFrom === 2100 && ply.priceTo === 2400, [ply.priceFrom, ply.priceTo]);

  console.log("\n--- pagination ---");
  const p1 = (await call("GET", "/api/admin/products?page=1", null, OWNER)).j.rows.map(x => x.id);
  const p2r = (await call("GET", "/api/admin/products?page=2", null, OWNER)).j;
  ok("page 2 holds the rest", p2r.rows.length === 10, p2r.rows.length);
  ok("the pages do not overlap",
     p1.every(id => !p2r.rows.some(x => x.id === id)));
  ok("asking past the end lands on the last page",
     (await call("GET", "/api/admin/products?page=99", null, OWNER)).j.page === 2);
  ok("a huge pageSize cannot pull the catalogue",
     (await call("GET", "/api/admin/products?pageSize=999999", null, OWNER)).j.rows.length
       <= adminProducts.MAX_PAGE_SIZE);

  /* ================================================================
     2.  SEARCH AND FILTERS
     ================================================================ */
  console.log("\n--- search, on the server ---");
  const find = async q => (await call("GET", "/api/admin/products?q=" +
    encodeURIComponent(q), null, OWNER)).j;

  ok("by name", (await find("Marine")).total === 1);
  ok("by SKU", (await find("SKU-PLY-18")).total === 1);
  ok("by code", (await find("MP18")).total === 1);
  ok("by brand", (await find("Hettich")).total === 1);
  ok("by category", (await find("Plywood")).total === 2);
  ok("by product id", (await find("P-PLY")).total === 1);
  ok("nothing matches nothing", (await find("zzzznope")).total === 0);

  console.log("\n--- the search box cannot be made to lie ---");
  const pct = await find("50%");
  ok("a literal % finds only the name containing it",
     pct.total === 1 && pct.rows[0].id === "P-HDL", pct.rows.map(x => x.id));
  const und = await find("A_B");
  ok("a literal _ is not a wildcard",
     und.total === 1 && und.rows[0].id === "P_UND", und.rows.map(x => x.id));
  ok("a bare % does not match the catalogue", (await find("%")).total === 1);
  ok("a bare _ matches only the two ids containing one",
     (await find("_")).total === 1, (await find("_")).rows.map(x => x.id));

  console.log("\n--- filters ---");
  const filt = async f => (await call("GET", "/api/admin/products?filter=" + f +
    "&pageSize=100", null, OWNER)).j;

  const outs = await filt("out");
  ok("out-of-stock finds the handle, the catalogue-only item and the discontinued board",
     outs.rows.some(x => x.id === "P-HDL") &&
     outs.rows.some(x => x.id === "P-NONE") &&
     outs.rows.some(x => x.id === "P-OFF"), outs.rows.map(x => x.id));
  const lows = await filt("low");
  ok("low finds only the product with a size under its own minimum",
     lows.total === 1 && lows.rows[0].id === "P-PLY", lows.rows.map(x => x.id));
  ok("25 against a minimum of 5 is NOT low", !lows.rows.some(x => x.id === "P_UND"));
  ok("switched-off products are found by their own filter",
     (await filt("inactive")).rows.map(x => x.id).join() === "P-OFF");
  const nomin = await filt("nomin");
  ok("'no minimum set' finds the products nobody has configured",
     nomin.rows.some(x => x.id === "P-HDL") && !nomin.rows.some(x => x.id === "P_UND"),
     nomin.total);

  r = await call("GET", "/api/admin/products?category=Hardware&pageSize=100", null, OWNER);
  ok("filtering by category works", r.j.rows.every(x => x.category === "Hardware"), r.j.total);

  console.log("\n--- an unknown filter or sort cannot inject SQL ---");
  for (const bad of ["nonsense", "name; DROP TABLE products", "__proto__"]) {
    const a = await call("GET", "/api/admin/products?sort=" + encodeURIComponent(bad), null, OWNER);
    const b = await call("GET", "/api/admin/products?filter=" + encodeURIComponent(bad), null, OWNER);
    ok("sort=" + bad.slice(0, 16) + " falls back to name", a.j.sort === "name", a.j.sort);
    ok("filter=" + bad.slice(0, 16) + " falls back to all", b.j.filter === "all", b.j.filter);
  }
  ok("the products table is intact",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM products").get().n) === 35);

  /* ================================================================
     3.  STOCK STATUS — the rule, and where there is no rule
     ================================================================ */
  console.log("\n--- stock status comes from minimums somebody actually set ---");

  ok("nothing on the shelf is out of stock", adminProducts.statusOf(0, 10) === "out");
  ok("at or below a real minimum is low", adminProducts.statusOf(10, 10) === "low");
  ok("below it is low", adminProducts.statusOf(3, 10) === "low");
  ok("above it is in stock", adminProducts.statusOf(25, 5) === "in");
  ok("WITH NO MINIMUM there is no verdict, only 'unset'",
     adminProducts.statusOf(40, 0) === "unset");
  ok("and zero with no minimum is still out of stock",
     adminProducts.statusOf(0, 0) === "out");

  const src = fs.readFileSync(path.join(ROOT, "server/adminProducts.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("the shop dashboard's hard-coded 'stock < 15' is not copied here",
     !/<\s*15\b/.test(src));
  ok("the service writes nothing at all", !/\b(INSERT|UPDATE|DELETE)\s/i.test(src));
  ok("and never does SELECT *", !/SELECT\s+\*/i.test(src));

  /* ================================================================
     4.  ONE PRODUCT
     ================================================================ */
  console.log("\n--- a product with sizes and stock ---");

  r = await call("GET", "/api/admin/products/P-PLY", null, OWNER);
  ok("the profile loads", r.status === 200, r.status);
  const d = r.j;
  ok("it carries the stored details",
     d.product.name === "Marine Ply 18mm" && d.product.sku === "SKU-PLY-18" &&
     d.product.unit === "Sq.ft", d.product);
  ok("both sizes are listed", d.sizes.length === 2, d.sizes.length);

  const s84 = d.sizes.filter(z => z.label === "8x4")[0];
  const s74 = d.sizes.filter(z => z.label === "7x4")[0];
  ok("8x4 holds 40 with no minimum, so it is 'unset'",
     s84.qty === 40 && s84.minStock === 0 && s84.status === "unset", s84);
  ok("7x4 holds 3 against a minimum of 10, so it is low",
     s74.qty === 3 && s74.minStock === 10 && s74.status === "low", s74);
  ok("each size says WHERE its stock is",
     s84.locations.length >= 1 && s84.locations[0].quantity === 40, s84.locations);
  ok("cost prices come through where they were entered",
     s84.cost === 1800 && s74.cost === 1600, [s84.cost, s74.cost]);

  ok("the summary totals the sizes", d.summary.qty === 43, d.summary.qty);
  ok("the summary names the unit", d.summary.unit === "Sq.ft");
  ok("one size is low, none is out", d.summary.low === 1 && d.summary.out === 0, d.summary);
  ok("the denormalised product total agrees with the sum of its sizes",
     d.product.denormalisedStock === d.summary.qty,
     [d.product.denormalisedStock, d.summary.qty]);

  /* The denormalised total is shown beside the sum of the sizes so a
     drift between them is visible. Force one and check it shows. */
  inShop(() => db.prepare("UPDATE products SET stock = 999 WHERE id = ?").run("P-PLY"));
  const drifted = (await call("GET", "/api/admin/products/P-PLY", null, OWNER)).j;
  ok("a drift between the product total and its sizes is visible, not hidden",
     drifted.product.denormalisedStock === 999 && drifted.summary.qty === 43,
     [drifted.product.denormalisedStock, drifted.summary.qty]);
  inShop(() => db.prepare("UPDATE products SET stock = 43 WHERE id = ?").run("P-PLY"));

  ok("the movement history is on the profile", d.history.length >= 2, d.history.length);
  ok("every movement line records the count before and after",
     d.history.every(h => typeof h.before === "number" && typeof h.after === "number"),
     d.history[0]);

  ok("what this login may do is decided by the server",
     d.abilities && d.abilities.mayEdit === true && d.abilities.mayAdjust === true,
     d.abilities);

  console.log("\n--- a product with no sizes, and one with none in stock ---");
  r = await call("GET", "/api/admin/products/P-NONE", null, OWNER);
  ok("a product with no sizes still opens", r.status === 200, r.status);
  ok("and says so rather than showing a zero that looks like stock",
     r.j.sizes.length === 0 && r.j.summary.qty === 0);
  r = await call("GET", "/api/admin/products/P-HDL", null, OWNER);
  ok("a size at zero is out of stock", r.j.sizes[0].status === "out", r.j.sizes[0]);

  console.log("\n--- an id that is not there ---");
  for (const bad of ["NOPE", "../settings", "'; DROP TABLE products;--"]) {
    r = await call("GET", "/api/admin/products/" + encodeURIComponent(bad), null, OWNER);
    ok("id " + bad.slice(0, 18) + " is a plain 404", r.status === 404, r.status);
  }
  ok("the catalogue survived",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM products").get().n) === 35);

  /* ================================================================
     5.  INVENTORY OVERVIEW
     ================================================================ */
  console.log("\n--- the inventory overview ---");

  r = await call("GET", "/api/admin/inventory", null, OWNER);
  ok("it loads", r.status === 200, r.status);
  const inv = r.j;
  ok("active products are counted", inv.products === 34, inv.products);
  ok("sizes are counted", inv.sizes === 35, inv.sizes);
  ok("low stock IS available, because minimums exist", inv.lowAvailable === true);
  ok("and it counts the one size under its minimum", inv.lowSizes === 1, inv.lowSizes);
  ok("two minimums have been set", inv.minimumsSet === 2, inv.minimumsSet);

  ok("QUANTITIES ARE REPORTED PER UNIT, never as one total",
     Array.isArray(inv.byUnit) && inv.byUnit.length >= 2, inv.byUnit);
  ok("square feet are kept apart from pieces",
     inv.byUnit.some(u => u.unit === "Sq.ft" && u.qty === 43) &&
     inv.byUnit.some(u => u.unit === "Piece"), inv.byUnit);
  ok("there is no single grand total anywhere in the payload",
     !("totalQty" in inv) && !("totalStock" in inv), Object.keys(inv));
  ok("stock is broken down by location", inv.byLocation.length >= 1, inv.byLocation);
  ok("and a LOCATION carries counts of sizes, never a cross-unit quantity",
     inv.byLocation.every(l => typeof l.sizes === "number" &&
       typeof l.stocked === "number" && !("qty" in l)), inv.byLocation);

  /* With no minimum anywhere, low stock must refuse rather than say 0. */
  const savedMins = inShop(() =>
    db.prepare("SELECT size_id, location_id, min_stock FROM size_location_stock WHERE min_stock > 0").all());
  inShop(() => db.prepare("UPDATE size_location_stock SET min_stock = 0").run());
  r = await call("GET", "/api/admin/inventory", null, OWNER);
  ok("WITH NO MINIMUM ANYWHERE, low stock is unavailable rather than zero",
     r.j.lowAvailable === false && r.j.lowSizes === null, [r.j.lowAvailable, r.j.lowSizes]);
  ok("but out-of-stock is still a real figure", r.j.outSizes > 0, r.j.outSizes);
  inShop(() => savedMins.forEach(m =>
    db.prepare("UPDATE size_location_stock SET min_stock = ? WHERE size_id = ? AND location_id = ?")
      .run(m.min_stock, m.size_id, m.location_id)));

  /* ================================================================
     6.  CORRECTING A COUNT
     ================================================================ */
  console.log("\n--- a correction must say why ---");

  const adjust = (productId, sizeId, body, who) =>
    call("PATCH", "/api/admin/products/" + productId + "/sizes/" + sizeId + "/stock", body, who);

  r = await adjust("P-PLY", 1, { stock: 50 }, OWNER);
  ok("no reason is a 400", r.status === 400, r.status);
  ok("and the message says what is missing", /reason/i.test(r.j.error), r.j.error);
  r = await adjust("P-PLY", 1, { stock: 50, reason: "   " }, OWNER);
  ok("a blank reason is a 400 too", r.status === 400, r.status);
  r = await adjust("P-PLY", 1, { stock: 50, reason: "x".repeat(400) }, OWNER);
  ok("an absurdly long reason is refused", r.status === 400, r.status);
  ok("the count did not move",
     inShop(() => inventory.getStock(1, SHOP_LOC)) === 40,
     inShop(() => inventory.getStock(1, SHOP_LOC)));

  console.log("\n--- the quantity must be a real quantity ---");
  for (const bad of [{ stock: "abc" }, { stock: null }, { stock: -5 },
                     { stock: 1e12 }, { delta: "x" }, {},
                     { stock: "" }, { stock: true }, { stock: [] },
                     { stock: {} }, { delta: null }]) {
    r = await adjust("P-PLY", 1, { ...bad, reason: "trying it on" }, OWNER);
    ok(JSON.stringify(bad) + " is refused", r.status === 400, [r.status, r.j && r.j.error]);
  }
  r = await adjust("P-PLY", 1, { stock: 50, delta: 5, reason: "both" }, OWNER);
  ok("giving both a count and a change is refused", r.status === 400, r.status);
  ok("after all of that the count is still 40",
     inShop(() => inventory.getStock(1, SHOP_LOC)) === 40);

  console.log("\n--- a correction that is allowed ---");
  const beforeCount = inShop(() => inventory.getStock(1, SHOP_LOC));
  r = await adjust("P-PLY", 1, { stock: 37, locationId: SHOP_LOC,
                                 reason: "Counted the rack, three short" }, OWNER);
  ok("it succeeds", r.status === 200, [r.status, r.j && r.j.error]);
  ok("the count is now 37", inShop(() => inventory.getStock(1, SHOP_LOC)) === 37,
     inShop(() => inventory.getStock(1, SHOP_LOC)));
  ok("the product total was kept in step",
     inShop(() => db.prepare("SELECT stock FROM products WHERE id = ?").get("P-PLY").stock) === 40,
     inShop(() => db.prepare("SELECT stock FROM products WHERE id = ?").get("P-PLY").stock));

  console.log("\n--- and it is written down, in full ---");
  const led = inShop(() => db.prepare(
    "SELECT * FROM stock_ledger WHERE size_id = ? ORDER BY at DESC LIMIT 1").get(1));
  ok("a ledger row was written", !!led);
  ok("it names the movement as an adjustment", led.movement === "adjustment", led.movement);
  ok("it records the count BEFORE", led.prev_qty === beforeCount, [led.prev_qty, beforeCount]);
  ok("and the count AFTER", led.new_qty === 37, led.new_qty);
  ok("and the difference", led.qty === -3, led.qty);
  ok("it records WHO", led.staff === "Owner", led.staff);
  ok("it records WHY", led.remarks === "Counted the rack, three short", led.remarks);
  ok("it records WHEN", typeof led.at === "number" && led.at > 0 && !!led.date);
  ok("it says this came from the admin panel", /Admin/i.test(led.ref_type), led.ref_type);
  ok("it names the product and the location",
     led.product_id === "P-PLY" && led.location_id === SHOP_LOC, led);

  console.log("\n--- a shelf cannot be driven negative ---");
  r = await adjust("P-PLY", 1, { delta: -1000, reason: "trying to go below zero" }, OWNER);
  ok("the request is accepted", r.status === 200, r.status);
  const after = inShop(() => inventory.getStock(1, SHOP_LOC));
  ok("but the count stops at zero, it does not go negative", after === 0, after);
  const led2 = inShop(() => db.prepare(
    "SELECT * FROM stock_ledger WHERE size_id = ? ORDER BY at DESC LIMIT 1").get(1));
  ok("and the ledger records the real movement, not the one asked for",
     led2.prev_qty === 37 && led2.new_qty === 0 && led2.qty === -37, led2);
  /* put it back */
  await adjust("P-PLY", 1, { stock: 40, reason: "restoring for the rest of the tests" }, OWNER);

  console.log("\n--- a size belonging to another product ---");
  r = await adjust("P-PLY", 3, { stock: 99, reason: "wrong product" }, OWNER);
  ok("correcting P-HDL's size through P-PLY is a 404", r.status === 404, r.status);
  ok("and the handle's stock is untouched",
     inShop(() => inventory.getStock(3, SHOP_LOC)) === 0);

  /* ================================================================
     7.  TWO PEOPLE AT ONCE
     ================================================================ */
  console.log("\n--- two corrections landing together ---");

  /* addStock writes `quantity = quantity + ?` — arithmetic in SQLite,
     not read-then-overwrite in JavaScript — so two deltas applied at
     the same moment both survive. A read-calculate-write would lose
     one of them, which is the exact failure this checks for. */
  await adjust("P-PLY", 2, { stock: 100, reason: "baseline for the concurrency check" }, OWNER);

  const results = await Promise.all([
    adjust("P-PLY", 2, { delta: -10, reason: "sold ten off the floor" }, OWNER),
    adjust("P-PLY", 2, { delta: -7, reason: "damaged seven" }, OWNER),
    adjust("P-PLY", 2, { delta: 4, reason: "four came back" }, OWNER),
  ]);
  ok("all three succeed", results.every(x => x.status === 200), results.map(x => x.status));
  const net = inShop(() => inventory.getStock(2, SHOP_LOC));
  ok("NOT ONE UPDATE IS LOST: 100 - 10 - 7 + 4 = 87", net === 87, net);

  const trail = inShop(() => db.prepare(
    "SELECT prev_qty, new_qty, qty FROM stock_ledger WHERE size_id = ? ORDER BY at ASC, id ASC").all(2));
  const adjRows = trail.slice(-3);
  ok("each of the three is written down separately", adjRows.length === 3);
  ok("and the before/after chain has no gap",
     adjRows.every(x => x.new_qty === x.prev_qty + x.qty), adjRows);

  ok("the shop's own stock write is arithmetic in SQL, not read-then-overwrite",
     /quantity = quantity \+ \?/.test(
       fs.readFileSync(path.join(ROOT, "server/inventory.js"), "utf8")));

  /* ================================================================
     8.  AUTHORIZATION
     ================================================================ */
  console.log("\n--- who may read, edit and correct ---");

  ok("three capabilities exist",
     !!adminAccess.CAPS["products.view"] && !!adminAccess.CAPS["products.edit"] &&
     !!adminAccess.CAPS["inventory.adjust"]);
  ok("SUPPORT may read the catalogue", adminAccess.CAPS["products.view"].includes("SUPPORT"));
  ok("SUPPORT may not edit a product", !adminAccess.CAPS["products.edit"].includes("SUPPORT"));
  ok("CORRECTING STOCK IS OWNER-ONLY",
     adminAccess.CAPS["inventory.adjust"].join() === "OWNER",
     adminAccess.CAPS["inventory.adjust"]);

  for (const [label, who] of [["logged out", null], ["staff", STAFF],
                              ["owner in preview", { ...OWNER, previewStaffId: "ST-A" }]]) {
    r = await call("GET", "/api/admin/products", null, who);
    ok(label + ": the list is refused", r.status === 401 || r.status === 403, r.status);
    ok(label + ": no product name leaks", !r.text.includes("Marine"), r.text.slice(0, 70));
    r = await adjust("P-PLY", 1, { stock: 1, reason: "should not work" }, who);
    ok(label + ": a correction is refused", r.status === 401 || r.status === 403, r.status);
  }
  ok("the count was never touched by any of that",
     inShop(() => inventory.getStock(1, SHOP_LOC)) === 40);

  /* Withhold the adjust capability from the owner and confirm the split
     is real rather than merely declared. */
  const realAdjust = adminAccess.CAPS["inventory.adjust"];
  adminAccess.CAPS["inventory.adjust"] = ["ADMIN"];
  const rAdj = await adjust("P-PLY", 1, { stock: 5, reason: "no permission" }, OWNER);
  const rRead = await call("GET", "/api/admin/products/P-PLY", null, OWNER);
  adminAccess.CAPS["inventory.adjust"] = realAdjust;

  ok("without inventory.adjust, a correction is 403", rAdj.status === 403, rAdj.status);
  ok("reading still works", rRead.status === 200, rRead.status);
  ok("and the page is told not to offer the control",
     rRead.j.abilities.mayAdjust === false, rRead.j.abilities);
  ok("the count is unchanged", inShop(() => inventory.getStock(1, SHOP_LOC)) === 40);

  /* ================================================================
     9.  ANOTHER SHOP'S STOCK
     ================================================================ */
  console.log("\n--- another shop's product ---");

  ok("the other shop really has it",
     inOther(() => !!db.prepare("SELECT 1 FROM products WHERE id = ?").get("P-SECRET")));

  r = await call("GET", "/api/admin/products/P-SECRET", null, OWNER);
  ok("this shop's owner gets a 404", r.status === 404, r.status);
  ok("and nothing leaks", !r.text.includes("Rival") && !r.text.includes("5555"), r.text.slice(0, 80));
  r = await call("GET", "/api/admin/products?q=Rival", null, OWNER);
  ok("searching finds nothing here", r.j.total === 0, r.j.total);

  r = await adjust("P-SECRET", 900, { stock: 0, reason: "reaching across shops" }, OWNER);
  ok("and their stock cannot be corrected from here", r.status === 404, r.status);
  ok("their count is untouched",
     inOther(() => inventory.getStock(900, OTHER_LOC)) === 777,
     inOther(() => inventory.getStock(900, OTHER_LOC)));

  /* ================================================================
     10.  EDITING A PRODUCT
     ================================================================ */
  console.log("\n--- editing goes through the shop's own handler ---");

  const productsRouter = require(path.join(ROOT, "server/routes/products.js"));
  ok("routes/products.js still exports a working router", typeof productsRouter === "function");
  ok("and now also exports the edit handler", typeof productsRouter.updateProduct === "function");
  ok("and the stock-correction handler", typeof productsRouter.adjustSizeStock === "function");

  r = await call("PUT", "/api/admin/products/P-PLY",
    { name: "Marine Ply 18mm BWP", brand: "Century", category: "Plywood", unit: "Sq.ft" }, OWNER);
  ok("the edit succeeds", r.status === 200, [r.status, r.j && r.j.error]);
  const edited = inShop(() => db.prepare("SELECT * FROM products WHERE id = ?").get("P-PLY"));
  ok("the name changed", edited.name === "Marine Ply 18mm BWP", edited.name);
  ok("THE SIZES WERE NOT TOUCHED, because none were sent",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM product_sizes WHERE product_id = ?")
       .get("P-PLY").n) === 2);
  ok("and neither was the stock", inShop(() => inventory.getStock(1, SHOP_LOC)) === 40);
  ok("the edit is in the audit log",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'product.update'")
       .get().n) >= 1);

  /* ================================================================
     11.  HISTORY
     ================================================================ */
  console.log("\n--- the movement history ---");

  r = await call("GET", "/api/admin/inventory/history", null, OWNER);
  ok("it loads", r.status === 200, r.status);
  ok("it is available, because this app has always had a stock ledger",
     r.j.available === true);
  ok("it is paginated", r.j.pageSize <= adminProducts.MAX_PAGE_SIZE && r.j.pages >= 1, r.j.pageSize);
  ok("every line carries before, after and the difference",
     r.j.rows.every(h => typeof h.before === "number" && typeof h.after === "number" &&
                         typeof h.qty === "number"), r.j.rows[0]);
  ok("a product's name is joined live, so a rename reads through its past",
     r.j.rows.some(h => h.product === "Marine Ply 18mm BWP"),
     r.j.rows.slice(0, 3).map(h => h.product));

  r = await call("GET", "/api/admin/inventory/history?movement=adjustment", null, OWNER);
  ok("it can be filtered to adjustments only",
     r.j.rows.every(h => h.movement === "adjustment"), r.j.rows.map(h => h.movement));
  ok("and those adjustments carry their reasons",
     r.j.rows.some(h => /Counted the rack/.test(h.remarks)), r.j.rows.map(h => h.remarks));

  r = await call("GET", "/api/admin/inventory/history?productId=P-HDL", null, OWNER);
  ok("it can be filtered to one product", r.j.rows.every(h => h.productId === "P-HDL"));

  r = await call("GET", "/api/admin/inventory/movements", null, OWNER);
  ok("the movement vocabulary comes from the shop's own ledger module",
     r.j.movements.some(m => m.key === "adjustment") &&
     r.j.movements.some(m => m.key === "sale"), r.j.movements.map(m => m.key));

  /* ================================================================
     12.  NOTHING FINANCIAL MOVES
     ================================================================ */
  console.log("\n--- corrections do not touch the books ---");

  inShop(() => {
    db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                VALUES ('C1','A Customer','900',0,?,1)`).run(Date.now());
    db.prepare(`INSERT INTO invoices (id,challan_no,doc_type,date,created_at,customer_id,
                subtotal,total,balance_due,voided)
                VALUES ('I1','SP0000001','invoice','2026-10-01',?,'C1',5000,5000,0,0)`)
      .run(Date.now());
  });

  const books = () => inShop(() => ({
    invoices: db.prepare("SELECT COUNT(*) n FROM invoices").get().n,
    invoiceTotal: db.prepare("SELECT COALESCE(SUM(total),0) t FROM invoices").get().t,
    payments: db.prepare("SELECT COUNT(*) n FROM payments").get().n,
    due: db.prepare("SELECT COALESCE(SUM(due),0) d FROM customers").get().d,
    cash: db.prepare("SELECT COUNT(*) n FROM cash_entries").get().n,
  }));

  const b4 = books();
  await call("GET", "/api/admin/products?pageSize=100", null, OWNER);
  await call("GET", "/api/admin/inventory", null, OWNER);
  await adjust("P-PLY", 1, { stock: 12, reason: "stock count" }, OWNER);
  await adjust("P-PLY", 1, { delta: 3, reason: "three found behind the rack" }, OWNER);
  await call("PUT", "/api/admin/products/P-PLY", { name: "Marine Ply 18mm BWP" }, OWNER);
  const b5 = books();

  ok("no invoice was added, removed or altered",
     b4.invoices === b5.invoices && b4.invoiceTotal === b5.invoiceTotal, [b4, b5]);
  ok("no payment was either", b4.payments === b5.payments);
  ok("no customer balance moved", b4.due === b5.due);
  ok("the cash book was not touched", b4.cash === b5.cash);
  ok("but the stock DID move, to 15", inShop(() => inventory.getStock(1, SHOP_LOC)) === 15,
     inShop(() => inventory.getStock(1, SHOP_LOC)));

  /* ================================================================
     13.  PRIVACY
     ================================================================ */
  console.log("\n--- nothing secret crosses the wire ---");

  inShop(() => db.prepare(
    "UPDATE settings SET sync_cloud_key = ?, activation_code = ? WHERE id = 1")
    .run("KEYVALUE0123456789abcdef", "ACTIVATION-SECRET"));

  const blobs = [
    (await call("GET", "/api/admin/products?pageSize=100", null, OWNER)).text,
    (await call("GET", "/api/admin/products/P-PLY", null, OWNER)).text,
    (await call("GET", "/api/admin/inventory", null, OWNER)).text,
    (await call("GET", "/api/admin/inventory/history", null, OWNER)).text,
  ];
  for (const blob of blobs) {
    ok("no sync key", !blob.includes("KEYVALUE0123456789abcdef"));
    ok("no activation code", !blob.includes("ACTIVATION-SECRET"));
    ok("no filesystem path", !/[A-Za-z]:[\\/]|\/home\/|\/tmp\//.test(blob));
    ok("no SQL", !/SELECT |FROM products/i.test(blob));
    ok("no stack trace", !/\bat \w+ \(/.test(blob));
  }

  /* ================================================================
     14.  THE SHOP'S OWN SCREENS STILL WORK
     ================================================================ */
  console.log("\n--- the shop app's product and stock APIs are unchanged ---");

  const shopApp = express();
  shopApp.use(express.json());
  shopApp.use((req, _res, next) => {
    req.session = { loggedIn: true, role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
    db.companies.runAs(SHOP.id, () => stockLedger.withContext({ staff: "Owner" }, next));
  });
  shopApp.use("/api/products", productsRouter);
  const shopSrv = shopApp.listen(0);
  const shopBase = "http://127.0.0.1:" + shopSrv.address().port;

  let sr = await fetch(shopBase + "/api/products");
  const shopList = await sr.json();
  ok("GET /api/products still returns the catalogue it always did",
     sr.status === 200 && Array.isArray(shopList) && shopList.length === 35,
     [sr.status, shopList.length]);
  ok("and each product still carries its sizes and the gst alias",
     shopList.every(x => Array.isArray(x.sizes)) && "gst" in shopList[0],
     Object.keys(shopList[0] || {}).slice(0, 12));

  sr = await fetch(shopBase + "/api/products/P-PLY/sizes/1/stock", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stock: 20 }),
  });
  ok("the shop's OWN stock correction still works, with no reason required",
     sr.status === 200, sr.status);
  ok("and it moved the count", inShop(() => inventory.getStock(1, SHOP_LOC)) === 20);
  const shopLed = inShop(() => db.prepare(
    "SELECT * FROM stock_ledger WHERE size_id = ? ORDER BY at DESC LIMIT 1").get(1));
  ok("the shop's own correction is still recorded without an admin reason",
     shopLed.remarks === "" && shopLed.movement !== "adjustment",
     [shopLed.movement, shopLed.remarks]);

  shopSrv.close();
  srv.close();

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
