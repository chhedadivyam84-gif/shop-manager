/* ============================================================
   PAYMENT PHOTOS COME BACK AFTER A RESTART

   Every receipt or cheque photo is copied to the backup store when it is
   saved. On a host that wipes its disk at every restart (Render's free
   plan) the server's own copy was then gone, and the photo showed as
   "unavailable" for good, although the backed-up copy existed (found
   20 Oct 2026).

   Against a stand-in for Supabase Storage on this machine:
     - a photo whose server copy is gone is fetched back and served
     - ...and put back on the server, so the next view needs no fetch
     - a file this shop does not own is refused WITHOUT asking the store
     - a stored file that is not the image it claims to be is not served

   Run:  node test/attachment-restore.test.js
   ============================================================ */
const http = require("http");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- a stand-in for Supabase Storage ---- */
const buckets = new Map(); const gets = [];
const fake = http.createServer((req, res) => {
  const chunks = []; req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks), url = decodeURIComponent(req.url);
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let m;
    if (req.method === "POST" && url === "/storage/v1/bucket") {
      const b = JSON.parse(body.toString() || "{}");
      if (buckets.has(b.id)) return json(409, { message: "The resource already exists" });
      buckets.set(b.id, new Map()); return json(200, { name: b.id });
    }
    if ((m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url))) {
      const b = buckets.get(m[1]);
      if (!b) return json(400, { error: "Bucket not found", code: "NoSuchBucket" });
      if (req.method === "POST") { b.set(m[2], body); return json(200, { Key: m[2] }); }
      if (req.method === "GET") { gets.push(m[2]); if (!b.has(m[2])) return json(400, { error: "not_found" });
        res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(b.get(m[2])); }
    }
    json(404, { error: "unexpected" });
  });
});

(async () => {
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-attach-"));
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) process.env[k] = "";
  process.env.SUPABASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.SUPABASE_KEY = "stand-in-key-for-a-local-fake";
  process.env.SUPABASE_BUCKET = "shop-backups";

  const db = require(path.join(ROOT, "server/db.js"));
  const express = require(path.join(ROOT, "node_modules/express"));
  const attachments = require(path.join(ROOT, "server/attachments.js"));
  const SHOP = db.companies.create({ name: "Attachment Shop" });
  const inShop = fn => db.companies.runAs(SHOP.id, fn);
  const insertRow = (table, values) => inShop(() => {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
    const row = { ...values };
    for (const c of cols) if (c.notnull && c.dflt_value == null && !c.pk && !(c.name in row)) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : "x";
    const keys = Object.keys(row);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(`INSERT INTO "${table}" (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]));
    db.exec("PRAGMA foreign_keys = ON");
  });

  const app = express();
  app.use((req, _res, next) => { req.session = { loggedIn: true, role: "owner", staffId: "ST-OWNER" }; db.companies.runAs(SHOP.id, next); });
  app.use("/api/attachments", require(path.join(ROOT, "server/routes/attachments.js")));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}/api/attachments/`;

  /* A real PNG: the eight fixed bytes, then some data. */
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from("a receipt photo")]);
  const saved = inShop(() => attachments.saveAttachment({ filename: "receipt.png", mimeType: "image/png", dataBase64: png.toString("base64") }));
  for (let i = 0; i < 40 && !(buckets.get("shop-backups") || new Map()).has("uploads/" + saved.path); i++) await sleep(100);
  ok("(the photo was copied to the backup store when saved)", (buckets.get("shop-backups") || new Map()).has("uploads/" + saved.path));
  insertRow("payments", { id: "PAY_ATTACH_1", attachment_path: saved.path, attachment_name: "receipt.png", amount: 100, created_at: Date.now() });

  console.log("\n--- the server's copy is wiped, as a restart does ---\n");
  const local = path.join(attachments.UPLOAD_DIR, saved.path);
  fs.unlinkSync(local);
  let r = await fetch(BASE + saved.path);
  const got = Buffer.from(await r.arrayBuffer());
  ok("the photo is still shown (it used to say \"unavailable\")", r.status === 200 && got.equals(png), r.status);
  ok("...and is back on the server", fs.existsSync(local));
  const before = gets.length;
  r = await fetch(BASE + saved.path);
  ok("...so the next view does not ask the backup store again", r.status === 200 && gets.length === before);

  console.log("\n--- it only works for the shop that owns the photo ---\n");
  const stranger = "0123456789abcdef.png";
  buckets.get("shop-backups").set("uploads/" + stranger, png);
  const g0 = gets.length;
  r = await fetch(BASE + stranger);
  ok("a photo this shop has no payment for is refused", r.status === 404);
  ok("...WITHOUT asking the backup store for it", gets.length === g0, gets.slice(g0));

  console.log("\n--- a stored file that is not what it claims ---\n");
  const fakeName = "fedcba9876543210.png";
  buckets.get("shop-backups").set("uploads/" + fakeName, Buffer.from("<html>not an image</html>"));
  insertRow("payments", { id: "PAY_ATTACH_2", attachment_path: fakeName, attachment_name: "x.png", amount: 1, created_at: Date.now() });
  r = await fetch(BASE + fakeName);
  ok("is not served", r.status === 404, r.status);
  ok("...and not written to the server", !fs.existsSync(path.join(attachments.UPLOAD_DIR, fakeName)));

  server.close(); fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
