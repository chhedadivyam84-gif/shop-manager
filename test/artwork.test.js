/* ============================================================
   PARTICULAR BRANDING ARTWORK

   An image attached to a particular, so the brand's own mark can be
   printed on the paper that goes out with the goods.

   What is worth proving, in the order it would hurt:

     1. A particular WITHOUT artwork behaves exactly as it always did.
        That is the contract of the whole feature.

     2. The image never travels with the catalogue. It is a few hundred
        kilobytes; the product list is fetched on almost every screen, and
        a few hundred products would put tens of megabytes into a response
        whose job is to draw a list of names.

     3. Each particular keeps its own. A challan carrying three brands
        must not print one brand's artwork against another's line.

   Runs the real products router against a scratch database.

   Run:  node test/artwork.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-artwork-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

const CO = db.companies.create({ name: "Artwork Test" });
const inCo = fn => db.companies.runAs(CO.id, fn);

const app = express();
/* A branded design is bigger than the 100kb express defaults. */
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  req.session = { loggedIn: true, staffId: "S1", staffName: "Tester", role: "owner" };
  db.companies.runAs(CO.id, next);
});
app.use("/api/products", require(path.join(ROOT, "server/routes/products.js")));

let BASE;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

/* A real 1x1 PNG, so the format check is being asked a true question. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA==";
const big  = "data:image/png;base64," + "A".repeat(600 * 1024);

(async () => {
  const srv = app.listen(0);
  await new Promise(r => srv.once("listening", r));
  BASE = "http://127.0.0.1:" + srv.address().port;

  const mk = (id, name) => inCo(() => db.prepare(
    "INSERT INTO products (id,name,sku,unit,gst_rate,stock,created_at) VALUES (?,?,?,'Piece',18,0,?)")
    .run(id, name, "SKU-" + id, Date.now()));
  mk("P-A", "Maharashtra Ply 19mm");
  mk("P-B", "Konkan Board 12mm");
  mk("P-C", "Plain Ply 6mm");

  /* ---------------------------------------------------------- */
  console.log("--- the column arrived without disturbing anything");
  const cols = inCo(() => db.prepare("PRAGMA table_info(products)").all().map(c => c.name));
  ok("artwork_data exists", cols.includes("artwork_data"));
  ok("an existing product has it blank, not null",
     inCo(() => db.prepare("SELECT artwork_data FROM products WHERE id='P-A'").get().artwork_data) === "");

  console.log("--- a particular with no artwork is untouched");
  const listBefore = await call("GET", "/api/products");
  ok("the catalogue lists every product", listBefore.j.length === 3, String(listBefore.j.length));
  ok("each says it has no artwork",
     listBefore.j.every(p => p.has_artwork === false), JSON.stringify(listBefore.j.map(p => p.has_artwork)));
  ok("and every other field is still there",
     listBefore.j[0].name && listBefore.j[0].gst === 18 && Array.isArray(listBefore.j[0].sizes),
     JSON.stringify(Object.keys(listBefore.j[0]).slice(0, 8)));

  /* ---------------------------------------------------------- */
  console.log("--- setting artwork");
  const setA = await call("PUT", "/api/products/P-A/artwork", { artwork: PNG });
  ok("a PNG is accepted", setA.status === 200 && setA.j.hasArtwork === true, JSON.stringify(setA.j));
  const setB = await call("PUT", "/api/products/P-B/artwork", { artwork: JPG });
  ok("a JPG is accepted", setB.status === 200, String(setB.status));

  const bad = await call("PUT", "/api/products/P-C/artwork", { artwork: "data:text/html;base64,PHNjcmlwdD4=" });
  ok("something that is not an image is refused", bad.status === 400, String(bad.status));
  const notData = await call("PUT", "/api/products/P-C/artwork", { artwork: "https://example.com/logo.png" });
  ok("a URL is refused too", notData.status === 400, String(notData.status));
  const huge = await call("PUT", "/api/products/P-C/artwork", { artwork: big });
  ok("an oversized image is refused", huge.status === 400, String(huge.status));
  ok("and says how big it was", huge.status === 400 && /KB/.test(huge.j.error), huge.j && huge.j.error);
  ok("none of those refusals stored anything",
     inCo(() => db.prepare("SELECT artwork_data FROM products WHERE id='P-C'").get().artwork_data) === "");

  const missing = await call("PUT", "/api/products/P-GHOST/artwork", { artwork: PNG });
  ok("a product that is not there is a 404", missing.status === 404, String(missing.status));

  /* ---------------------------------------------------------- */
  console.log("--- THE IMAGE NEVER TRAVELS WITH THE CATALOGUE");
  const listAfter = await call("GET", "/api/products");
  ok("the list still answers", listAfter.status === 200 && listAfter.j.length === 3);
  ok("no product carries the image data",
     listAfter.j.every(p => p.artwork_data === undefined), JSON.stringify(listAfter.j.map(p => Object.keys(p).filter(k => /artwork/.test(k)))));
  ok("but each says whether it has one",
     listAfter.j.find(p => p.id === "P-A").has_artwork === true &&
     listAfter.j.find(p => p.id === "P-C").has_artwork === false);
  ok("so the response stays small",
     listAfter.text.length < 4000, listAfter.text.length + " bytes for 3 products");

  /* ---------------------------------------------------------- */
  console.log("--- fetching it when it is actually needed");
  const one = await call("GET", "/api/products/P-A/artwork");
  ok("one particular's artwork comes back whole", one.j.artwork === PNG, String(one.j.artwork || "").slice(0, 40));
  ok("with the name, so a screen can label it", one.j.name === "Maharashtra Ply 19mm", one.j.name);
  const noneYet = await call("GET", "/api/products/P-C/artwork");
  ok("a particular without artwork answers blank, not 404",
     noneYet.status === 200 && noneYet.j.artwork === "", String(noneYet.status));

  console.log("--- and in a batch, the way a document asks");
  const batch = await call("POST", "/api/products/artwork/batch", { ids: ["P-A", "P-B", "P-C"] });
  ok("the batch answers", batch.status === 200, String(batch.status));
  ok("EACH PARTICULAR KEEPS ITS OWN",
     batch.j.artwork["P-A"] === PNG && batch.j.artwork["P-B"] === JPG,
     JSON.stringify(Object.keys(batch.j.artwork)));
  ok("one without artwork is simply absent",
     !("P-C" in batch.j.artwork), JSON.stringify(Object.keys(batch.j.artwork)));
  const empty = await call("POST", "/api/products/artwork/batch", { ids: [] });
  ok("an empty ask is an empty answer, not an error",
     empty.status === 200 && Object.keys(empty.j.artwork).length === 0, String(empty.status));
  const junk = await call("POST", "/api/products/artwork/batch", { ids: [null, 5, {}, "P-A"] });
  ok("junk ids are ignored rather than fatal",
     junk.status === 200 && junk.j.artwork["P-A"] === PNG, String(junk.status));

  /* ---------------------------------------------------------- */
  console.log("--- removing it");
  const clear = await call("PUT", "/api/products/P-A/artwork", { artwork: "" });
  ok("an empty string removes it", clear.status === 200 && clear.j.hasArtwork === false, JSON.stringify(clear.j));
  ok("and it is gone from the batch",
     !("P-A" in (await call("POST", "/api/products/artwork/batch", { ids: ["P-A"] })).j.artwork));
  const clearNull = await call("PUT", "/api/products/P-B/artwork", { artwork: null });
  ok("an explicit null removes it too", clearNull.status === 200 && clearNull.j.hasArtwork === false);

  /* ---------------------------------------------------------- */
  console.log("--- the product itself was never touched by any of this");
  const p = inCo(() => db.prepare("SELECT * FROM products WHERE id='P-A'").get());
  ok("name unchanged", p.name === "Maharashtra Ply 19mm", p.name);
  ok("stock unchanged", p.stock === 0, String(p.stock));
  ok("gst unchanged", p.gst_rate === 18, String(p.gst_rate));
  ok("still active", p.active === 1, String(p.active));

  /* An ordinary edit must not wipe the artwork — the product PUT does not
     know this column exists, and must not need to. */
  await call("PUT", "/api/products/P-C/artwork", { artwork: PNG });
  const edit = await call("PUT", "/api/products/P-C", { name: "Plain Ply 6mm renamed", gst: 12 });
  ok("an ordinary product edit succeeds", edit.status === 200, String(edit.status));
  ok("AND DOES NOT WIPE THE ARTWORK",
     inCo(() => db.prepare("SELECT artwork_data FROM products WHERE id='P-C'").get().artwork_data) === PNG);
  ok("while the edit itself applied",
     inCo(() => db.prepare("SELECT name FROM products WHERE id='P-C'").get().name) === "Plain Ply 6mm renamed");

  console.log("");
  console.log("  " + pass + " passed, " + fail + " failed");
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("  ERROR " + ((e && e.stack) || e)); process.exit(1); });
