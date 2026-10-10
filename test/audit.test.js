/* ============================================================
   SECURITY AUDIT, 10 Oct 2026 — the fixes that are not the permission gate

   - an attachment is served only to the business whose record names it
   - an attachment must BE the type it claims (its first bytes are checked)
   - a sync address inside a private network is refused, when saved and
     when used

   Invented records, two businesses, a temp directory.
   Run:  node test/audit.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-audit-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.SYNC_ALLOW_PRIVATE_TARGET;
const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const attach = require(path.join(ROOT, "server/attachments.js"));
const sync = require(path.join(ROOT, "server/sync.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const throwsMsg = fn => { try { fn(); return ""; } catch (e) { return e.message; } };

const A = db.companies.create({ name: "Shop A" });
const B = db.companies.create({ name: "Shop B" });
const app = express();
app.use((req, _res, next) => {
  req.session = { loggedIn: true, role: "owner", staffId: "STAFF_owner", staffName: "Owner" };
  db.companies.runAs(req.headers["x-company"], next);
});
app.use("/api/attachments", require(path.join(ROOT, "server/routes/attachments.js")));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.4\n%fake but well-formed header\n");

(async () => {
  console.log("\n--- an attachment must be what it says ---\n");
  ok("a real PNG is accepted", !throwsMsg(() => attach.saveAttachment({ mimeType: "image/png", dataBase64: PNG.toString("base64"), filename: "r.png" })));
  ok("a real PDF is accepted", !throwsMsg(() => attach.saveAttachment({ mimeType: "application/pdf", dataBase64: PDF.toString("base64") })));
  ok("a web page labelled image/png is refused",
     /not the type it claims/.test(throwsMsg(() => attach.saveAttachment({ mimeType: "image/png", dataBase64: Buffer.from("<html><script>alert(1)</script>").toString("base64") }))));
  ok("a PDF labelled as a JPEG is refused",
     /not the type it claims/.test(throwsMsg(() => attach.saveAttachment({ mimeType: "image/jpeg", dataBase64: PDF.toString("base64") }))));
  ok("a type that is not allowed at all is refused",
     /must be a JPEG/.test(throwsMsg(() => attach.saveAttachment({ mimeType: "text/html", dataBase64: PNG.toString("base64") }))));

  console.log("\n--- an attachment belongs to the business that recorded it ---\n");
  const saved = attach.saveAttachment({ mimeType: "image/png", dataBase64: PNG.toString("base64"), filename: "cheque.png" });
  db.companies.runAs(A.id, () => {
    db.prepare("INSERT INTO customers (id,name,phone,due,created_at,active) VALUES ('C1','A customer','9000000001',0,?,1)").run(Date.now());
    db.prepare(`INSERT INTO payments (id, customer_id, amount, method, note, payment_date, voided, created_at, attachment_path, attachment_name)
                VALUES ('PAY_1','C1',100,'Cheque','',?,0,?,?,?)`).run("2026-10-10", Date.now(), saved.path, saved.name);
  });
  const srv = app.listen(0);
  const base = "http://127.0.0.1:" + srv.address().port + "/api/attachments/";
  const get = async (name, company) => (await fetch(base + name, { headers: { "x-company": company } })).status;
  ok("the business whose payment names it can open it", await get(saved.path, A.id) === 200);
  ok("ANOTHER BUSINESS CANNOT, EVEN KNOWING THE NAME (404)", await get(saved.path, B.id) === 404);
  const orphan = attach.saveAttachment({ mimeType: "image/png", dataBase64: PNG.toString("base64") });
  ok("a file no record names is not served to anybody", await get(orphan.path, A.id) === 404 && await get(orphan.path, B.id) === 404);
  ok("a path with .. is refused", await get("..%2F..%2Fcompanies.json", A.id) === 404);
  srv.close();

  console.log("\n--- a sync address must be a public https address ---\n");
  await db.companies.runAs(A.id, async () => {
    for (const bad of ["https://localhost:4000", "https://127.0.0.1", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5",
                       "https://192.168.1.20", "https://172.16.0.1", "https://[::1]", "https://intranet", "https://user:pw@example.com"]) {
      ok(`refused when saved: ${bad}`, !!throwsMsg(() => sync.setTarget(bad, "k")), bad);
    }
    ok("plain http is still refused", /https/.test(throwsMsg(() => sync.setTarget("http://example.com", "k"))));
    ok("a public https address is accepted", !throwsMsg(() => sync.setTarget("https://shop-copy.example.com", "k")));
    db.prepare("UPDATE settings SET sync_cloud_url = ?, sync_cloud_key = 'k' WHERE id = 1").run("https://169.254.169.254");
    const r = await sync.askCloud("/api/sync/peek");
    ok("an address saved BEFORE this check is refused when used", r.ok === false && /private network/.test(r.error), r);

    /* A public-looking NAME that points at a private address. The lookup is
       stood in for here, so nothing leaves this machine. */
    const dns = require("dns");
    const realLookup = dns.promises.lookup;
    dns.promises.lookup = async (host) => host === "rebind.example.com"
      ? [{ address: "10.1.2.3", family: 4 }] : [{ address: "93.184.215.14", family: 4 }];
    try {
      db.prepare("UPDATE settings SET sync_cloud_url = ?, sync_cloud_key = 'k' WHERE id = 1").run("https://rebind.example.com");
      const r2 = await sync.askCloud("/api/sync/peek");
      ok("a public name that RESOLVES to a private address is refused before connecting", r2.ok === false && /points inside a private network/.test(r2.error), r2);
      const p2 = await sync.push({ staff: "test" });
      ok("...for a push too", p2.ok === false && /points inside a private network/.test(p2.error), p2);
    } finally { dns.promises.lookup = realLookup; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
