/* ============================================================
   ONE SERVER, MANY SHOPS — each shop stays in its own books

   Found on 20 Oct 2026 with two shops on one hosted copy:
     1. after the staff PIN, BOTH shops were in the same default "My Shop",
        and every save was refused ("Enter the activation code")
     2. a shop's owner could list and delete the backup history of every
        shop, and restore a file over the default business
     3. five wrong PINs at one shop locked the owner of EVERY shop out

   Runs the licence panel and this shop app as two processes over HTTP,
   with two dummy shops, on throwaway folders. Nothing real is touched.
   Needs the panel checkout and the vendor key beside this repo, like
   tenant-identity.test.js.

   Run:  node test/shared-server.test.js
   ============================================================ */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PANEL = "C:/Users/prafu/shop-manager-licence";
const KEYS = "C:/Users/prafu/shop-manager-vendor-keys";
const PANEL_PORT = 4516, SHOP_PORT = 4817, VPW = "shared-server-test-panel";
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const panelDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-panel-"));
const shopDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-shop-"));
const noCloud = { SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" };
let out = "";
const panel = spawn(process.execPath, ["--no-warnings", path.join(PANEL, "server.js")], { cwd: PANEL,
  env: { ...process.env, ...noCloud, ADMIN_PASSWORD: VPW, DATA_DIR: panelDir, PORT: String(PANEL_PORT),
         VENDOR_PRIVATE_KEY: fs.readFileSync(path.join(KEYS, "private-key.pem"), "utf8") } });
const shop = spawn(process.execPath, ["--no-warnings", "server/index.js"], { cwd: ROOT,
  env: { ...process.env, ...noCloud, DATA_DIR: shopDir, PORT: String(SHOP_PORT), MULTI_TENANT: "1",
         LICENCE_SERVER: `http://127.0.0.1:${PANEL_PORT}` } });
shop.stdout.on("data", d => out += d); shop.stderr.on("data", d => out += d);
process.on("exit", () => { try { panel.kill(); } catch {} try { shop.kill(); } catch {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = port => { let c = ""; return async (m, u, b, raw) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${u}`, { method: m,
    headers: Object.assign({ "content-type": "application/json" }, c ? { cookie: c } : {}),
    body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.getSetCookie(); if (sc.length) c = sc.map(x => x.split(";")[0]).join("; ");
  if (raw) return { s: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t };
}; };
const waitUp = async port => { for (let i = 0; i < 240; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return; } catch { await sleep(250); } } throw new Error("no answer on " + port + "\n" + out.slice(-600)); };

(async () => {
  await waitUp(PANEL_PORT); await waitUp(SHOP_PORT);
  const v = client(PANEL_PORT);
  await v("POST", "/login", { password: VPW });
  const until = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const sell = async (name, phone) => {
    const m = (await v("POST", "/customers", { shopName: name, phone, username: phone })).j;
    await v("POST", `/customers/${m.id}/approve`, { until });
    return { user: phone, pw: m.password || (m.handover && m.handover.password) };
  };
  const A = await sell("Shared Test Shop A", "9833300001"), B = await sell("Shared Test Shop B", "9833300002");

  const signIn = async cred => {
    const c = client(SHOP_PORT);
    await c("POST", "/auth/shop-login", { username: cred.user, password: cred.pw });
    const pin = await c("POST", "/auth/login", { staffId: "STAFF_owner", pin: cred.pin || "1234" });
    /* On the starting PIN an owner must choose their own first. */
    if (pin.j && pin.j.mustChangePin) { cred.pin = "8" + cred.user.slice(-3); await c("PUT", "/staff/STAFF_owner", { pin: cred.pin }); }
    return { c, pin };
  };

  console.log("\n--- 1. after the PIN, each shop is in its OWN books ---\n");
  const a = await signIn(A), b = await signIn(B);
  ok("shop A's owner signs in", a.pin.s === 200, a.pin.t);
  ok("shop B's owner signs in", b.pin.s === 200, b.pin.t);
  const nameA = (await a.c("GET", "/settings")).j, nameB = (await b.c("GET", "/settings")).j;
  ok("A is in A's business, not the default \"My Shop\"", nameA && nameA.business_name === "Shared Test Shop A", nameA && nameA.business_name);
  ok("B is in B's business", nameB && nameB.business_name === "Shared Test Shop B", nameB && nameB.business_name);
  const ca = await a.c("POST", "/customers", { name: "Only In Shop A", phone: "9000001111", type: "Retail Customer" });
  const cb = await b.c("POST", "/customers", { name: "Only In Shop B", phone: "9000002222", type: "Retail Customer" });
  ok("A can save (it was refused: \"Enter the activation code\")", ca.s === 201, [ca.s, ca.t.slice(0, 120)]);
  const lic = (await a.c("GET", "/license")).j || {};
  ok("...and its screen is not told \"Enter the activation code… read-only\" (the banner said so on every screen)",
     lic.status === "active" && lic.blocked === false && lic.mode === "tenant", lic);
  ok("B can save", cb.s === 201, [cb.s, cb.t.slice(0, 120)]);
  const listA = (await a.c("GET", "/customers")).j || [], listB = (await b.c("GET", "/customers")).j || [];
  ok("A sees only A's customer", listA.map(x => x.name).join() === "Only In Shop A", listA.map(x => x.name));
  ok("B sees only B's customer", listB.map(x => x.name).join() === "Only In Shop B", listB.map(x => x.name));
  ok("B cannot open A's customer by id", (await b.c("GET", `/customers/${ca.j && ca.j.id}`)).s === 404);
  ok("B cannot change A's customer by id", (await b.c("PUT", `/customers/${ca.j && ca.j.id}`, { name: "Changed by B" })).s !== 200);
  ok("...and A's customer is unchanged", ((await a.c("GET", `/customers/${ca.j && ca.j.id}`)).j || {}).name === "Only In Shop A");

  console.log("\n--- 2. an owner cannot reach other shops' backups ---\n");
  for (const [m, u, body] of [["GET", "/backup/cloud"], ["POST", "/backup/cloud/delete", { stamps: ["x"] }],
                               ["POST", "/backup/restore/preview", {}], ["POST", "/backup/restore/apply", {}],
                               ["GET", "/backup/restore/pending"], ["POST", "/backup/restore/cancel", {}],
                               ["POST", "/sync/key", {}], ["POST", "/sync/push", {}], ["GET", "/sync/status"],
                               ["GET", "/sync/peek"], ["POST", "/sync/receive", {}]]) {
    const r = await a.c(m, u, body);
    ok(`${m} ${u} is refused on a shared server`, r.s === 403 && r.j && r.j.sharedServer === true, [r.s, r.t.slice(0, 100)]);
  }
  const dl = await a.c("GET", "/backup/download", undefined, true);
  ok("downloading your own backup still works", dl.s === 200 && dl.buf.length > 1000, dl.s);
  {
    const f = path.join(shopDir, "dl-check.db"); fs.writeFileSync(f, dl.buf);
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(f, { readOnly: true });
    const names = d.prepare("SELECT name FROM customers").all().map(r => r.name);
    d.close();
    ok("...and it holds ONLY that shop's books", names.join() === "Only In Shop A", names);
  }

  console.log("\n--- 3. wrong PINs at one shop do not lock out another ---\n");
  const atk = client(SHOP_PORT);
  await atk("POST", "/auth/shop-login", { username: A.user, password: A.pw });
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await atk("POST", "/auth/login", { staffId: "STAFF_owner", pin: String(4000 + i) })).s);
  ok("shop A's owner is paused after five wrong PINs", tries[5] === 429, tries);
  const b2 = await signIn(B);
  ok("SHOP B's owner can still sign in (they were locked out too)", b2.pin.s === 200, [b2.pin.s, b2.pin.t]);

  console.log(`\n${pass} passed, ${fail} failed`);
  panel.kill(); shop.kill(); await sleep(300);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, out.slice(-600)); process.exit(1); });
