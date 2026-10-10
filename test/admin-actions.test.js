/* ============================================================
   OWNER ACTIONS STAY THE OWNER'S — even for a staff login given every permission

   Against the real server (server/index.js) on a throwaway data folder:
   the owner gives one staff login EVERY module and action, then that login
   tries each thing only an owner may do. Every one must be refused, and
   nothing it tried may have changed.

   Run:  node test/admin-actions.test.js
   ============================================================ */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-admin-"));
const PORT = 4885;
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 200) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(process.execPath, ["--no-warnings", "server/index.js"], { cwd: ROOT,
  env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), SUPABASE_URL: "", SUPABASE_KEY: "", R2_ACCOUNT_ID: "" } });
let out = ""; srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
process.on("exit", () => { try { srv.kill(); } catch (e) {} });
function jar() {
  let cookie = "";
  return async (m, u, b) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${u}`, { method: m,
      headers: Object.assign({ "content-type": "application/json" }, cookie ? { cookie } : {}), body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, j };
  };
}

(async () => {
  for (let i = 0; i < 120 && !/running on port/.test(out); i++) await sleep(250);
  const owner = jar(), staff = jar();
  await owner("POST", "/auth/login", { staffId: "STAFF_owner", pin: "1234" });
  const cust = (await owner("POST", "/customers", { name: "Admin Test Customer", phone: "9000044444", type: "Retail Customer" })).j;
  const s = (await owner("POST", "/staff", { name: "Everything Staff", pin: "2468", role: "staff" })).j;
  const meta = (await owner("GET", "/permissions/catalogue")).j || {};
  const keys = (meta.modules || []).map(m => m.key || m);
  const all = { view: true, add: true, edit: true, print: true };
  const modules = Object.fromEntries((keys.length ? keys : ["sales", "customer", "supplier", "product", "stock", "purchase", "reports", "bank", "cash", "payment", "receipt", "outstanding", "ledger", "gst", "dashboard"]).map(k => [k, all]));
  const pu = await owner("PUT", `/permissions/${s.id}`, { scope: "All Data", jobRole: "Manager", modules });
  ok("the owner gives one staff login every permission", pu.status === 200, pu);
  ok("that login signs in", (await staff("POST", "/auth/login", { staffId: s.id, pin: "2468" })).status === 200);
  ok("...and really has broad access (reads customers)", (await staff("GET", "/customers")).status === 200);

  console.log("\n--- every owner action is refused ---\n");
  const tries = [
    ["POST", "/staff", { name: "Made By Staff", pin: "1111", role: "owner" }, "add a login (as owner)"],
    ["PUT", `/staff/${s.id}`, { role: "owner" }, "promote itself to owner"],
    ["PUT", `/staff/STAFF_owner`, { pin: "0000" }, "change the owner's PIN"],
    ["PUT", `/permissions/${s.id}`, { scope: "All Data", modules }, "change its own permissions"],
    ["POST", `/permissions/preview/${s.id}`, {}, "start an owner preview"],
    ["PUT", "/settings/app-theme", { theme: "plum-rose" }, "change the shop's colour"],
    ["POST", "/backup/run", {}, "run a backup"],
    ["POST", "/reset", { pin: "2468", confirmText: "RESET", scope: "bills" }, "wipe the bills"],
    ["POST", "/businesses", { name: "Second Books" }, "create a business"],
    ["GET", "/employees", null, "read staff pay"],
    ["GET", "/audit", null, "read the activity log"],
    ["DELETE", `/customers/${cust.id}`, null, "delete a customer"],
    ["POST", "/notifications/announce", { title: "From staff" }, "post a notice to everyone"],
    ["POST", "/license/activate", { code: "SM-TEST-TEST-0000" }, "activate a licence code"]
  ];
  for (const [m, u, b, what] of tries) {
    const r = await staff(m, u, b);
    ok(`staff cannot ${what} (${m} ${u}) — ${r.status}`, r.status === 403 || r.status === 401 || r.status === 409, r.status);
  }

  console.log("\n--- and nothing it tried changed anything ---\n");
  const staffList = (await owner("GET", "/staff")).j || [];
  ok("no login was added", !staffList.some(x => x.name === "Made By Staff"));
  ok("it is still staff, not owner", (staffList.find(x => x.id === s.id) || {}).role === "staff");
  ok("the owner can still sign in with the old PIN", (await jar()("POST", "/auth/login", { staffId: "STAFF_owner", pin: "1234" })).status === 200);
  ok("the customer still exists", (await owner("GET", `/customers/${cust.id}`)).status === 200);
  ok("no second business was created", ((await owner("GET", "/businesses")).j.businesses || []).length === 1);

  srv.kill(); await sleep(300);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e, out.slice(-400)); srv.kill(); process.exitCode = 1; });
