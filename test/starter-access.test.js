/* ============================================================
   STARTER ACCESS — enforcing permissions must not stop staff billing

   Before the server enforced permissions, nobody needed to set them. The
   vendor's own shop, measured 20 Oct 2026: six staff, each with only
   "view cash". With enforcement and nothing else, none of them could make
   a bill. starterAccess.js gives such staff the Sales Staff set ONCE,
   and gives it to every member of staff added from now on.

   On a throwaway folder, through the real server:
     - a member of staff with only "view cash" from before gets the set,
       and keeps "view cash"; one the owner set up properly is untouched
     - it happens once: an owner who narrows someone later is not overridden
     - a newly added member of staff can make a bill at once, and still
       cannot reach what the set does not include (bank accounts)
     - the owner is told, in the activity log and the bell

   Run:  node test/starter-access.test.js
   ============================================================ */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-starter-"));
const PORT = 4818, PANEL_PORT = 4519, VPW = "starter-access-test-panel";
const PANEL = "C:/Users/prafu/shop-manager-licence", KEYS = "C:/Users/prafu/shop-manager-vendor-keys";
const panelDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-starter-panel-"));
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noCloud = { SUPABASE_URL: "", SUPABASE_KEY: "", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" };
let srv = null, out = "";
const start = () => {
  out = "";
  srv = spawn(process.execPath, ["--no-warnings", "server/index.js"], { cwd: ROOT,
    env: { ...process.env, ...noCloud, DATA_DIR, PORT: String(PORT), MULTI_TENANT: "1",
           LICENCE_SERVER: "http://127.0.0.1:" + PANEL_PORT } });
  srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
};
const stop = () => new Promise(r => { if (!srv) return r(); srv.once("exit", r); srv.kill(); setTimeout(r, 3000); });
const panel = spawn(process.execPath, ["--no-warnings", path.join(PANEL, "server.js")], { cwd: PANEL,
  env: { ...process.env, ...noCloud, SUPABASE_BUCKET: "", ADMIN_PASSWORD: VPW, DATA_DIR: panelDir, PORT: String(PANEL_PORT),
         VENDOR_PRIVATE_KEY: fs.readFileSync(path.join(KEYS, "private-key.pem"), "utf8") } });
process.on("exit", () => { try { srv && srv.kill(); } catch {} try { panel.kill(); } catch {} });
const up = async () => { for (let i = 0; i < 200 && !/running on port/.test(out); i++) await sleep(250); };
const jar = (port = PORT) => { let c = ""; return async (m, u, b) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${u}`, { method: m,
    headers: Object.assign({ "content-type": "application/json" }, c ? { cookie: c } : {}),
    body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.getSetCookie(); if (sc.length) c = sc.map(x => x.split(";")[0]).join("; ");
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; }; };

(async () => {
  /* A hosted shop, sold through the panel and signed in once, so its
     books exist. Then two "old" staff are written straight in, and the
     once-mark cleared: how a shop that predates enforcement looks. */
  for (let i = 0; i < 200; i++) { try { await fetch("http://127.0.0.1:" + PANEL_PORT + "/api/health"); break; } catch { await sleep(250); } }
  const v = jar(PANEL_PORT);
  await v("POST", "/login", { password: VPW });
  const sold = (await v("POST", "/customers", { shopName: "Starter Test Shop", phone: "9844400001", username: "9844400001" })).j;
  await v("POST", "/customers/" + sold.id + "/approve", { until: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) });
  const shopPw = sold.password || (sold.handover && sold.handover.password);
  let ownerPin = "1234";
  const signInOwner = async () => { const o = jar(); await o("POST", "/auth/shop-login", { username: "9844400001", password: shopPw });
    const r = await o("POST", "/auth/login", { staffId: "STAFF_owner", pin: ownerPin });
    /* On the starting PIN an owner must choose their own first. */
    if (r.j && r.j.mustChangePin) { ownerPin = "6420"; await o("PUT", "/staff/STAFF_owner", { pin: ownerPin }); }
    return o; };
  start(); await up(); await signInOwner(); await stop();
  const { DatabaseSync } = require("node:sqlite");
  const reg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "companies.json"), "utf8"));
  const company = reg.companies.find(c => c.name === "Starter Test Shop");
  const file = path.join(DATA_DIR, "companies", company.id, "shop.db");
  {
    const d = new DatabaseSync(file);
    d.exec("CREATE TABLE IF NOT EXISTS once_flags (key TEXT PRIMARY KEY, at INTEGER NOT NULL)"); d.prepare("DELETE FROM once_flags").run();
    const old = Date.UTC(2026, 8, 1);
    d.prepare("INSERT INTO staff (id, name, pin_hash, role, active, created_at) VALUES (?,?,?,?,1,?)").run("STAFF_cashonly", "Cash Only Old", "x", "staff", old);
    d.prepare("INSERT INTO staff_permissions (staff_id, module, can_view) VALUES (?, 'cash', 1)").run("STAFF_cashonly");
    d.prepare("INSERT INTO staff (id, name, pin_hash, role, active, created_at) VALUES (?,?,?,?,1,?)").run("STAFF_setup", "Set Up Old", "x", "staff", old);
    d.prepare("INSERT INTO staff_permissions (staff_id, module, can_view, can_add) VALUES (?, 'purchase', 1, 1)").run("STAFF_setup");
    d.close();
  }

  console.log("\n--- the one-time pass, at start-up ---\n");
  start(); await up();
  const rows = id => { const d = new DatabaseSync(file, { readOnly: true });
    const r = d.prepare("SELECT module, can_view, can_add, can_edit, can_print FROM staff_permissions WHERE staff_id = ? ORDER BY module").all(id); d.close(); return r; };
  const cashOnly = rows("STAFF_cashonly");
  const m = mod => cashOnly.find(r => r.module === mod) || {};
  ok("the cash-only member of staff can now make bills", m("sales").can_add === 1, cashOnly);
  ok("...and add customers", m("customer").can_add === 1);
  ok("...and still sees the cash book, as before", m("cash").can_view === 1);
  ok("...but was given nothing outside the Sales Staff set (no bank, no purchases)", !m("bank").can_view && !m("purchase").can_view);
  const setup = rows("STAFF_setup");
  ok("the member of staff the owner had set up is UNTOUCHED", setup.length === 1 && setup[0].module === "purchase", setup);
  {
    const d = new DatabaseSync(file, { readOnly: true });
    const log = d.prepare("SELECT details FROM audit_log WHERE action = 'permissions.starter'").all();
    const bell = d.prepare("SELECT title FROM notifications WHERE title LIKE 'Staff access is now enforced%'").all();
    d.close();
    ok("the activity log names who was given access", log.length === 1 && /Cash Only Old/.test(log[0].details) && !/Set Up Old/.test(log[0].details), log);
    ok("the owner is told in the bell", bell.length === 1, bell);
  }

  console.log("\n--- only once ---\n");
  await stop();
  { const d = new DatabaseSync(file);
    d.prepare("DELETE FROM staff_permissions WHERE staff_id = 'STAFF_cashonly' AND module <> 'cash'").run(); d.close(); }
  start(); await up();
  ok("an owner who narrows them back to the cash book is NOT overridden at the next start",
     rows("STAFF_cashonly").map(r => r.module).join() === "cash", rows("STAFF_cashonly"));

  console.log("\n--- a member of staff added now ---\n");
  const owner = await signInOwner();
  const added = await owner("POST", "/staff", { name: "New Counter Staff", pin: "4826", role: "staff" });
  ok("the owner adds them", added.s === 201, [added.s, added.t.slice(0, 120)]);
  const staff = jar();
  await staff("POST", "/auth/shop-login", { username: "9844400001", password: shopPw });
  ok("they can sign in", (await staff("POST", "/auth/login", { staffId: added.j && added.j.id, pin: "4826" })).s === 200);
  const c = await staff("POST", "/customers", { name: "Walk-in Buyer", phone: "9000004444", type: "Retail Customer" });
  ok("...add a customer straight away", c.s === 201, [c.s, c.t.slice(0, 120)]);
  ok("...see products", (await staff("GET", "/products")).s === 200);
  await owner("POST", "/bank-accounts", { name: "Shop Current A/c", bankName: "Test Bank", accountNo: "000111222", openingBalance: 50000 });
  const banks = await staff("GET", "/bank-accounts");
  ok("...sees bank account NAMES, to take a payment by bank", banks.s === 200 && Array.isArray(banks.j) && banks.j.length === 1, [banks.s, banks.t.slice(0, 120)]);
  ok("...but NOT their balances, which are the owner's", Array.isArray(banks.j) && banks.j.every(b => b.balance === undefined), banks.j);
  ok("...and NOT the staff list", (await staff("GET", "/staff")).s === 403);

  await stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, out.slice(-600)); try { srv.kill(); } catch {} process.exit(1); });
