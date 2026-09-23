/* ============================================================
   SYNC — sending this shop up to the cloud copy

   Two real instances, on two ports, with two separate databases: a SHOP
   holding books and a CLOUD holding almost nothing. The shop pushes; the
   cloud comes back holding the shop's books.

   What is worth proving is mostly about refusal and about damage:

     · a copy with no key issued accepts nothing at all
     · a wrong key is refused, and the attempt is recorded
     · a failed push leaves the SENDER completely untouched — nothing is
       deleted, moved, or marked as sent on the strength of an attempt
     · the receiver keeps the books it is about to lose
     · and nothing is swapped while either side is running

   Run:  node test/sync.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const BASE_DIR = path.join(os.tmpdir(), "sm-sync-" + process.pid);
const SHOP_DIR = path.join(BASE_DIR, "shop");
const CLOUD_DIR = path.join(BASE_DIR, "cloud");
const SHOP_PORT = 4931, CLOUD_PORT = 4932;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

const procs = [];
function boot(dir, port) {
  const p = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), NODE_ENV: "test" },
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {}); p.stderr.on("data", () => {});
  procs.push(p);
  return p;
}
async function waitUp(port, seconds) {
  for (let i = 0; i < (seconds || 40); i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/auth/staff-list`); if (r.ok) return true; }
    catch (e) { /* still starting */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
async function waitDown(port, seconds) {
  for (let i = 0; i < (seconds || 25); i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/auth/staff-list`); }
    catch (e) { return true; }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
const stopAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });

/** Put an owner with a known PIN into a copy, and give it some books. */
function seed(dir, { name, invoices, customers }) {
  const file = path.join(dir, "shop.db");
  const db = new DatabaseSync(file);
  const now = Date.now();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = salt + ":" + crypto.scryptSync("2468", salt, 64).toString("hex");
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const put = (t, r) => {
    const u = cols(t).filter(k => k in r);
    db.prepare(`INSERT OR REPLACE INTO ${t} (${u.join(",")}) VALUES (${u.map(() => "?").join(",")})`)
      .run(...u.map(k => r[k]));
  };
  put("staff", { id: "OWN", name: "Owner", pin_hash: hash, role: "owner", active: 1, created_at: now });
  db.prepare("UPDATE settings SET business_name = ? WHERE id = 1").run(name);
  for (let i = 1; i <= invoices; i++)
    put("invoices", { id: dir.slice(-4) + "-I" + i, challan_no: "SP" + String(i).padStart(7, "0"),
                      doc_type: "invoice", date: "2026-09-01", subtotal: 0, total: 0, voided: 0, created_at: now + i });
  for (let i = 1; i <= customers; i++)
    put("customers", { id: dir.slice(-4) + "-C" + i, name: name + " Customer " + i, created_at: now });
  db.close();
}

function counts(dir) {
  const tmp = path.join(os.tmpdir(), "pk-" + Math.random().toString(36).slice(2) + ".db");
  for (const e of ["", "-wal", "-shm"]) {
    const s = path.join(dir, "shop.db" + e);
    if (fs.existsSync(s)) fs.copyFileSync(s, tmp + e);
  }
  const d = new DatabaseSync(tmp);
  const n = q => { try { return d.prepare(q).get().n; } catch (e) { return -1; } };
  const out = {
    invoices: n("SELECT COUNT(*) n FROM invoices"),
    customers: n("SELECT COUNT(*) n FROM customers"),
    name: (d.prepare("SELECT business_name b FROM settings WHERE id=1").get() || {}).b,
  };
  d.close();
  for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch (_) {} }
  return out;
}

const login = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId: "OWN", pin: "2468" })
  });
  return (r.headers.getSetCookie() || []).map(c => c.split(";")[0]).join("; ");
};
const call = (port, method, p, body, cookie, extra) => fetch(`http://127.0.0.1:${port}${p}`, {
  method,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(extra || {}) },
  body: body ? JSON.stringify(body) : undefined,
});

(async () => {
  fs.mkdirSync(SHOP_DIR, { recursive: true });
  fs.mkdirSync(CLOUD_DIR, { recursive: true });

  /* Both copies built once so the schema exists, then seeded, then run. */
  for (const [dir, port] of [[SHOP_DIR, SHOP_PORT], [CLOUD_DIR, CLOUD_PORT]]) {
    const p = boot(dir, port);
    await waitUp(port, 45);
    p.kill();
    await waitDown(port, 20);
  }
  seed(SHOP_DIR,  { name: "Swagat Ply",   invoices: 37, customers: 12 });
  seed(CLOUD_DIR, { name: "Cloud Copy",   invoices: 1,  customers: 1 });

  boot(SHOP_DIR, SHOP_PORT);
  boot(CLOUD_DIR, CLOUD_PORT);
  ok("the shop copy is up", await waitUp(SHOP_PORT, 45));
  ok("the cloud copy is up", await waitUp(CLOUD_PORT, 45));

  const shopCookie = await login(SHOP_PORT);
  const cloudCookie = await login(CLOUD_PORT);
  ok("signed in to both", !!shopCookie && !!cloudCookie);

  console.log("--- a copy with no key issued accepts nothing");
  const noKey = await call(CLOUD_PORT, "POST", "/api/sync/receive", { file: "AAAA" }, null, { "x-sync-key": "anything" });
  ok("receive is refused outright", noKey.status === 403, String(noKey.status));
  ok("and it says the copy is not set up",
     /not set up to receive/i.test((await noKey.json()).error || ""), "");

  console.log("--- issuing a key");
  const keyRes = await call(CLOUD_PORT, "POST", "/api/sync/key", {}, cloudCookie);
  const { key } = await keyRes.json();
  ok("a key is issued", typeof key === "string" && key.length >= 64, String(key && key.length));
  const stored = (() => { const d = new DatabaseSync(path.join(CLOUD_DIR, "shop.db"), { readOnly: true });
    const v = d.prepare("SELECT sync_accept_hash h FROM settings WHERE id=1").get().h; d.close(); return v; })();
  ok("ONLY ITS HASH IS KEPT, never the key itself",
     stored.includes(":") && !stored.includes(key), stored.slice(0, 24) + "…");

  const wrong = await call(CLOUD_PORT, "POST", "/api/sync/receive", { file: "AAAA" }, null,
                           { "x-sync-key": key.slice(0, -2) + "00" });
  ok("a wrong key is refused", wrong.status === 403, String(wrong.status));

  console.log("--- pointing the shop at the cloud");
  const httpTarget = await call(SHOP_PORT, "PUT", "/api/sync/target",
    { url: "http://cloud.example.com", key }, shopCookie);
  ok("an http address is refused — the key would cross the wire in the clear",
     httpTarget.status === 400, String(httpTarget.status));

  /* The test copies talk over http on localhost, so the target is set
     directly rather than through the route that insists on https. */
  {
    const d = new DatabaseSync(path.join(SHOP_DIR, "shop.db"));
    d.prepare("UPDATE settings SET sync_cloud_url = ?, sync_cloud_key = ? WHERE id = 1")
      .run(`http://127.0.0.1:${CLOUD_PORT}`, key);
    d.close();
  }

  console.log("--- looking before pushing");
  const peek = await call(SHOP_PORT, "GET", "/api/sync/peek-cloud", null, shopCookie);
  const peeked = await peek.json();
  ok("the shop can see what the cloud holds", peek.status === 200, JSON.stringify(peeked).slice(0, 120));
  ok("and it is the cloud's figures, not its own",
     peeked.cloud.counts.invoices === 1 && peeked.local.counts.invoices === 37,
     JSON.stringify({ cloud: peeked.cloud.counts.invoices, local: peeked.local.counts.invoices }));

  const cloudBefore = counts(CLOUD_DIR);
  const shopBefore = counts(SHOP_DIR);

  console.log("--- the push");
  const push = await call(SHOP_PORT, "POST", "/api/sync/push", {}, shopCookie);
  const result = await push.json();
  ok("it succeeds", push.status === 200 && result.ok === true, JSON.stringify(result).slice(0, 160));
  ok("and reports what went across", /37 invoices/.test(result.summary || ""), result.summary);
  ok("THE SHOP IS COMPLETELY UNTOUCHED BY SENDING",
     JSON.stringify(counts(SHOP_DIR)) === JSON.stringify(shopBefore), JSON.stringify(counts(SHOP_DIR)));

  ok("the cloud has NOT swapped yet — it is still running",
     counts(CLOUD_DIR).invoices === cloudBefore.invoices, JSON.stringify(counts(CLOUD_DIR)));
  ok("it has parked the file instead", fs.existsSync(path.join(CLOUD_DIR, "pending-restore.db")));

  console.log("--- the cloud restarts and comes back with the shop's books");
  ok("the cloud went down to swap", await waitDown(CLOUD_PORT, 25));
  boot(CLOUD_DIR, CLOUD_PORT);                       // what a host's supervisor does
  ok("and came back up", await waitUp(CLOUD_PORT, 45));

  const cloudAfter = counts(CLOUD_DIR);
  ok("THE CLOUD NOW HOLDS THE SHOP'S BOOKS",
     cloudAfter.invoices === 37 && cloudAfter.customers === 12, JSON.stringify(cloudAfter));
  ok("including the shop's name", cloudAfter.name === "Swagat Ply", cloudAfter.name);
  ok("nothing left parked", !fs.existsSync(path.join(CLOUD_DIR, "pending-restore.db")));

  const kept = fs.readdirSync(path.join(CLOUD_DIR, "backups")).filter(f => /^before-restore-.*\.db$/.test(f));
  ok("THE CLOUD KEPT THE BOOKS IT LOST", kept.length >= 1, kept.join(", "));
  if (kept.length) {
    const d = new DatabaseSync(path.join(CLOUD_DIR, "backups", kept[0]), { readOnly: true });
    const n = d.prepare("SELECT COUNT(*) n FROM invoices").get().n;
    const nm = d.prepare("SELECT business_name b FROM settings WHERE id=1").get().b;
    d.close();
    ok("and they are the OLD cloud copy", n === cloudBefore.invoices && nm === "Cloud Copy", n + " / " + nm);
  }

  console.log("--- a push that cannot land changes nothing here");
  {
    const d = new DatabaseSync(path.join(SHOP_DIR, "shop.db"));
    d.prepare("UPDATE settings SET sync_cloud_url = ? WHERE id = 1").run("http://127.0.0.1:4999");
    d.close();
  }
  const before = counts(SHOP_DIR);
  const bad = await call(SHOP_PORT, "POST", "/api/sync/push", {}, shopCookie);
  const badBody = await bad.json();
  ok("it fails", bad.status === 400, String(bad.status));
  ok("with something a shopkeeper can act on",
     /could not connect|not answer|reach/i.test(badBody.error || ""), badBody.error);
  ok("AND THE SHOP IS UNTOUCHED", JSON.stringify(counts(SHOP_DIR)) === JSON.stringify(before));

  console.log("--- every attempt is on the record");
  const st = await (await call(SHOP_PORT, "GET", "/api/sync/status", null, shopCookie)).json();
  ok("the history holds both attempts", st.history.length >= 2, String(st.history.length));
  ok("one succeeded and one failed",
     st.history.some(h => h.ok === 1) && st.history.some(h => h.ok === 0),
     JSON.stringify(st.history.map(h => h.ok)));
  ok("and the failure kept its reason",
     st.history.some(h => h.ok === 0 && h.error), "");
  ok("THE KEY IS NOWHERE IN THE LOG",
     !JSON.stringify(st.history).includes(key), "");

  console.log("");
  console.log("  " + pass + " passed, " + fail + " failed");
  stopAll();
  await new Promise(r => setTimeout(r, 600));
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.log("  ERROR " + ((e && e.stack) || e));
  stopAll();
  await new Promise(r => setTimeout(r, 600));
  process.exit(1);
});
