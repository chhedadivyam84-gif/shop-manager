/* ============================================================
   THE STARTING PIN — an owner on 1234 must choose their own first

   Every new copy and every new hosted shop starts its owner on PIN 1234,
   and nothing used to make anybody change it: anyone who learnt a shop's
   sign-in was one guess from being its owner (found 20 Oct 2026).

   A hosted shop, through the real licence panel, on throwaway folders:
     - signing in with 1234 works, and says a new PIN is needed
     - until then the books cannot be read or written
     - 1234 itself is refused as the new PIN
     - after choosing one, everything works, and 1234 no longer signs in
     - an owner with their own PIN is never asked

   Run:  node test/default-pin.test.js
   ============================================================ */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PANEL = "C:/Users/prafu/shop-manager-licence", KEYS = "C:/Users/prafu/shop-manager-vendor-keys";
const PANEL_PORT = 4521, SHOP_PORT = 4822 + 1, VPW = "default-pin-test-panel";
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const noCloud = { SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" };
const panelDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-panel-")), shopDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-shop-"));
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
const client = port => { let c = ""; return async (m, u, b) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${u}`, { method: m,
    headers: Object.assign({ "content-type": "application/json" }, c ? { cookie: c } : {}),
    body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.getSetCookie(); if (sc.length) c = sc.map(x => x.split(";")[0]).join("; ");
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; }; };
const waitUp = async port => { for (let i = 0; i < 240; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return; } catch { await sleep(250); } } throw new Error("no answer " + port + out.slice(-400)); };

(async () => {
  await waitUp(PANEL_PORT); await waitUp(SHOP_PORT);
  const v = client(PANEL_PORT);
  await v("POST", "/login", { password: VPW });
  const sold = (await v("POST", "/customers", { shopName: "Default Pin Shop", phone: "9855500001", username: "9855500001" })).j;
  await v("POST", `/customers/${sold.id}/approve`, { until: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) });
  const pw = sold.password || (sold.handover && sold.handover.password);
  const shopIn = async () => { const c = client(SHOP_PORT); await c("POST", "/auth/shop-login", { username: "9855500001", password: pw }); return c; };

  console.log("\n--- first sign-in, on 1234 ---\n");
  const o = await shopIn();
  const login = await o("POST", "/auth/login", { staffId: "STAFF_owner", pin: "1234" });
  ok("signing in with 1234 works", login.s === 200, login.t);
  ok("...and says a new PIN is needed", login.j && login.j.mustChangePin === true, login.j);
  ok("...and so does the session, for a page that is reopened",
     (await o("GET", "/auth/session")).j.mustChangePin === true);
  const read = await o("GET", "/customers");
  ok("until then the books cannot be READ", read.s === 403 && read.j && read.j.mustChangePin === true, [read.s, read.t.slice(0, 100)]);
  const write = await o("POST", "/customers", { name: "Should Not Save", phone: "9000005555", type: "Retail Customer" });
  ok("...or WRITTEN", write.s === 403, write.s);
  ok("...nor another member of staff's PIN changed", (await o("POST", "/staff", { name: "X", pin: "8642", role: "staff" })).s === 403);
  const same = await o("PUT", "/staff/STAFF_owner", { pin: "1234" });
  ok("1234 itself is refused as the new PIN", same.s === 400 && /other than 1234/.test(same.t), [same.s, same.t]);
  const set = await o("PUT", "/staff/STAFF_owner", { pin: "7391" });
  ok("choosing their own PIN works", set.s === 200, [set.s, set.t.slice(0, 120)]);
  ok("...and the books open at once, without signing in again", (await o("GET", "/customers")).s === 200);
  ok("...and can be written", (await o("POST", "/customers", { name: "Saved After New Pin", phone: "9000006666", type: "Retail Customer" })).s === 201);

  console.log("\n--- afterwards ---\n");
  const o2 = await shopIn();
  ok("1234 no longer signs the owner in", (await o2("POST", "/auth/login", { staffId: "STAFF_owner", pin: "1234" })).s === 401);
  const o3 = await shopIn();
  const again = await o3("POST", "/auth/login", { staffId: "STAFF_owner", pin: "7391" });
  ok("their own PIN does", again.s === 200, again.t);
  ok("...and is never asked to change it again", again.j && again.j.mustChangePin === false, again.j);

  console.log(`\n${pass} passed, ${fail} failed`);
  panel.kill(); shop.kill(); await sleep(300);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, out.slice(-600)); process.exit(1); });
