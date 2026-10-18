/* ============================================================
   DISASTER RECOVERY — the three ways the hosted copy lost data in Oct 2026

   1. THE BUCKET DID NOT EXIST. Listing it answered "empty", every upload
      failed with "Bucket not found", and a shop that signed in on 18 Oct
      was gone at the next restart. Against a stand-in for Supabase
      Storage on this machine: the first upload makes the bucket (private)
      and succeeds, and a boot says the bucket was missing.
   2. ONLY ONE DAY OF HISTORY. Every copy older than 96 runs was deleted.
      Now the newest run of each of 30 days and 12 months is kept too.
   3. SEALED CREDENTIALS DIED WITH THE DISK. The key file is made afresh
      on a host with no disk. CREDENTIAL_KEY keeps the key across a
      restart, and values sealed under the old key file still open.

   Nothing here reaches a real object store.
   Run:  node test/disaster-recovery.test.js
   ============================================================ */
const http = require("http");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};

/* ---- a stand-in for Supabase Storage: buckets, objects, list, delete ---- */
const buckets = new Map();   // name -> { public, objects: Map(name -> Buffer) }
const seen = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = decodeURIComponent(req.url);
    seen.push(req.method + " " + url);
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const missing = () => json(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found", code: "NoSuchBucket" });
    let m;
    if (req.method === "POST" && url === "/storage/v1/bucket") {
      const b = JSON.parse(body.toString() || "{}");
      if (buckets.has(b.id)) return json(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      buckets.set(b.id, { public: !!b.public, objects: new Map() });
      return json(200, { name: b.id });
    }
    if (req.method === "POST" && (m = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(url))) {
      const b = buckets.get(m[1]);
      if (!b) return json(200, []);           // what the real one did: a missing bucket lists as empty
      return json(200, [...b.objects].map(([name, buf]) => ({ name, metadata: { size: buf.length } })));
    }
    if ((m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url))) {
      const b = buckets.get(m[1]);
      if (!b) return missing();
      if (req.method === "POST") { b.objects.set(m[2], body); return json(200, { Key: m[2] }); }
      if (req.method === "GET") {
        if (!b.objects.has(m[2])) return json(400, { error: "not_found" });
        res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(b.objects.get(m[2]));
      }
    }
    if (req.method === "DELETE" && (m = /^\/storage\/v1\/object\/([^/]+)$/.exec(url))) {
      const b = buckets.get(m[1]);
      if (!b) return missing();
      for (const n of JSON.parse(body.toString()).prefixes || []) b.objects.delete(n);
      return json(200, []);
    }
    json(404, { error: "unexpected " + req.method + " " + url });
  });
});

(async () => {
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  const PORT = fake.address().port;

  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-dr-"));
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CREDENTIAL_KEY"]) process.env[k] = "";
  process.env.SUPABASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.SUPABASE_KEY = "stand-in-key-for-a-local-fake";
  process.env.SUPABASE_BUCKET = "shop-backups";

  console.log("\n--- 1. the bucket does not exist ---\n");
  const cloudStore = require(path.join(ROOT, "server/cloudStore.js"));
  ok("(no bucket to begin with — the state found live)", buckets.size === 0);
  const up = await cloudStore.upload("shop-20261018-152209.db", Buffer.from("a shop's books"));
  ok("an upload into a missing bucket now SUCCEEDS", up.ok === true, up);
  ok("...because the bucket was created", buckets.has("shop-backups"));
  ok("...as a PRIVATE bucket, never public", buckets.get("shop-backups") && buckets.get("shop-backups").public === false);
  ok("...and the file is in it", buckets.get("shop-backups").objects.has("shop-20261018-152209.db"));
  const again = await cloudStore.ensureBucket();
  ok("asking again is fine: already-exists is not a failure", again.ok === true && again.created === false, again);

  /* A boot against a project whose bucket was deleted: it says so. */
  buckets.clear();
  const restore = require(path.join(ROOT, "server/restore.js"));
  const r = await restore.restoreIfNeeded();
  ok("a boot with no bucket says the bucket was missing, not just 'no backups'",
     r && r.restored === false && /bucket did not exist/.test(r.reason || ""), r);
  ok("...and has created it, so the next backup lands", buckets.has("shop-backups"));

  console.log("\n--- 2. history beyond one day ---\n");
  const backup = require(path.join(ROOT, "server/backup.js"));
  const stamps = [];
  const t0 = Date.UTC(2026, 9, 18, 12, 0, 0);
  const pad = n => String(n).padStart(2, "0");
  for (let i = 0; i < 400 * 96; i++) {          // 400 days of fifteen-minute runs
    const d = new Date(t0 - i * 15 * 60000);
    stamps.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`);
  }
  const kept = backup.keptStamps(stamps);
  ok("the newest run is always kept", kept.has(stamps[0]));
  ok("the last 96 runs (a full day) are all kept", stamps.slice(0, 96).every(s => kept.has(s)));
  const keptDays = new Set([...kept].map(s => s.slice(0, 8)));
  ok("a copy from 29 days ago is still there", keptDays.has(stamps[29 * 96].slice(0, 8)), stamps[29 * 96]);
  const keptMonths = new Set([...kept].map(s => s.slice(0, 6)));
  ok("a copy from about 11 months ago is still there", keptMonths.has(stamps[330 * 96].slice(0, 6)), stamps[330 * 96]);
  ok("nothing older than 12 months is kept", !keptMonths.has(stamps[399 * 96].slice(0, 6)));
  ok("the total stays small (under 150 runs)", kept.size <= 150, kept.size);

  console.log("\n--- 3. credentials across a restart ---\n");
  const sbPath = path.join(ROOT, "server/secretBox.js");
  const fresh = () => { delete require.cache[require.resolve(sbPath)]; return require(sbPath); };
  let sb = fresh();
  const oldSealed = sb.seal("the AI key typed before the change");
  ok("(sealed under the key file, as before)", sb.isSealed(oldSealed));

  process.env.CREDENTIAL_KEY = "a-long-random-value-set-on-the-host-0123456789";
  sb = fresh();
  ok("a value sealed under the OLD key file still opens once CREDENTIAL_KEY is set",
     sb.open(oldSealed) === "the AI key typed before the change");
  const newSealed = sb.seal("the GST password");

  /* The restart on a host with no disk: the key file is gone. */
  fs.unlinkSync(sb.keyPath());
  sb = fresh();
  ok("AFTER A RESTART THAT WIPED THE DISK, the value still opens", sb.open(newSealed) === "the GST password");

  process.env.CREDENTIAL_KEY = "";
  sb = fresh();
  ok("without CREDENTIAL_KEY it behaves as before (a wiped key file means it cannot open)", sb.open(newSealed) === "");

  fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fake.close(); } catch (x) {} process.exit(1); });
