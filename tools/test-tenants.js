/* Two shops, one installation.

   The question this answers is the one that decides whether demos can be
   handed out at all: can shop A reach shop B's books? Everything else here
   is scaffolding for that. */
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const { spawn } = require("child_process");
const APP = "C:/Users/prafu/shop-manager";
const LIC = "C:/Users/prafu/shop-manager-licence";
const KEYS = "C:/Users/prafu/shop-manager-vendor-keys";
const APP_PORT = 4499, PANEL_PORT = 4500, PANEL_PW = "tenant-suite-password";

let fails = 0;
const check = (w, g, e) => {
  const ok = JSON.stringify(g) === JSON.stringify(e);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${w}` + (ok ? "" : `\n          got  ${JSON.stringify(g)}\n          want ${JSON.stringify(e)}`));
};

/* Each shop keeps its own cookie jar, the way two browsers would. */
const jar = { A: "", B: "", V: "" };
const req = (who, port, m, p, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const h = { "content-type": "application/json" };
  if (jar[who]) h.cookie = jar[who];
  if (data) h["content-length"] = Buffer.byteLength(data);
  const r = http.request({ method: m, path: p, port, host: "127.0.0.1", headers: h }, x => {
    if (x.headers["set-cookie"]) jar[who] = x.headers["set-cookie"][0].split(";")[0];
    let d = ""; x.on("data", c => d += c);
    x.on("end", () => res({ status: x.statusCode, body: (() => { try { return JSON.parse(d || "{}"); } catch (e) { return d; } })() }));
  });
  r.on("error", rej); if (data) r.write(data); r.end();
});
const app = (who, m, p, b) => req(who, APP_PORT, m, p, b);
const panel = (m, p, b) => req("V", PANEL_PORT, m, p, b);

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-app-"));
const panDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-pan-"));
const KEY = fs.readFileSync(path.join(KEYS, "private-key.pem"), "utf8");

let panelSrv, appSrv, panelOut = "", appOut = "";
panelSrv = spawn(process.execPath, ["server.js"], { cwd: LIC, stdio: ["ignore","pipe","pipe"],
  env: { ...process.env, VENDOR_PRIVATE_KEY: KEY, ADMIN_PASSWORD: PANEL_PW, DATA_DIR: panDir, PORT: String(PANEL_PORT) } });
panelSrv.stdout.on("data", c => panelOut += c); panelSrv.stderr.on("data", c => panelOut += c);

appSrv = spawn(process.execPath, ["--no-warnings", "server/index.js"], { cwd: APP, stdio: ["ignore","pipe","pipe"],
  env: { ...process.env, DATA_DIR: appDir, PORT: String(APP_PORT), SESSION_SECRET: "mt",
         LICENCE_SERVER: `http://127.0.0.1:${PANEL_PORT}` } });
appSrv.stdout.on("data", c => appOut += c); appSrv.stderr.on("data", c => appOut += c);

process.on("exit", () => { try { panelSrv.kill(); } catch(e){} try { appSrv.kill(); } catch(e){} });
const stopPanel = () => new Promise(r => { if(!panelSrv) return r();
  panelSrv.once("exit", r); panelSrv.kill(); setTimeout(r, 3000); });
const waitFor = async (fn, what) => {
  for (let i = 0; i < 100; i++) { try { await fn(); return; } catch (e) { await new Promise(r => setTimeout(r, 250)); } }
  throw new Error(what + " never came up\n" + panelOut + "\n" + appOut);
};

(async () => {
 try {
  await waitFor(() => panel("GET", "/api/health"), "panel");
  await waitFor(() => app("A", "GET", "/api/auth/mode"), "app");

  console.log("\nThe vendor issues two demos\n");
  await panel("POST", "/api/login", { password: PANEL_PW });
  const A = (await panel("POST", "/api/customers/demo", { shopName: "ABC Plywood", phone: "9820011111", days: 30 })).body;
  const B = (await panel("POST", "/api/customers/demo", { shopName: "XYZ Traders", phone: "9820022222", days: 30 })).body;
  check("two shops, two logins", A.handover.login !== B.handover.login, true);

  console.log("\nBefore anybody signs in, there is one shop and no shop step\n");
  check("single-shop install shows no shop login", (await app("A", "GET", "/api/auth/mode")).body.multiTenant, false);

  console.log("\nShop A signs in\n");
  const inA = await app("A", "POST", "/api/auth/shop-login", { username: A.handover.login, password: A.handover.password });
  check("accepted", inA.status, 200);
  check("...into their own shop", inA.body.shop, "ABC Plywood");
  check("...and NOT signed in as a person yet", (await app("A", "GET", "/api/auth/session")).body.loggedIn, false);
  check("now the install knows it serves more than one", (await app("B", "GET", "/api/auth/mode")).body.multiTenant, true);

  /* Stage 2 for A. */
  const staffA = (await app("A", "GET", "/api/auth/staff-list")).body;
  await app("A", "POST", "/api/auth/login", { staffId: staffA[0].id, pin: "1234" });
  await app("A", "POST", "/api/products", { name: "A-ONLY PLY", brand: "Aaa", unit: "Pc", gstRate: 18, sizes: [{ label: "8x4", price: 1111, stock: 0 }] });
  await app("A", "POST", "/api/customers", { name: "A-ONLY CUSTOMER", phone: "9000000001" });

  console.log("\nShop B signs in\n");
  const inB = await app("B", "POST", "/api/auth/shop-login", { username: B.handover.login, password: B.handover.password });
  check("accepted", inB.status, 200);
  check("...into THEIR shop", inB.body.shop, "XYZ Traders");
  const staffB = (await app("B", "GET", "/api/auth/staff-list")).body;
  await app("B", "POST", "/api/auth/login", { staffId: staffB[0].id, pin: "1234" });
  await app("B", "POST", "/api/products", { name: "B-ONLY PLY", brand: "Bbb", unit: "Pc", gstRate: 18, sizes: [{ label: "8x4", price: 2222, stock: 0 }] });

  console.log("\n*** CAN EITHER SEE THE OTHER? ***\n");
  const prodA = (await app("A", "GET", "/api/products")).body.map(p => p.name);
  const prodB = (await app("B", "GET", "/api/products")).body.map(p => p.name);
  check("A sees only its own product", prodA, ["A-ONLY PLY"]);
  check("B sees only its own product", prodB, ["B-ONLY PLY"]);

  const custA = (await app("A", "GET", "/api/customers")).body.map(c => c.name);
  const custB = (await app("B", "GET", "/api/customers")).body.map(c => c.name);
  check("A's customer is A's", custA, ["A-ONLY CUSTOMER"]);
  check("B has none of A's customers", custB, []);

  console.log("\nAnd neither can switch into the other\n");
  const listA = (await app("A", "GET", "/api/businesses")).body;
  const rowsA = Array.isArray(listA) ? listA : (listA.businesses || []);
  check("A is offered exactly one business", rowsA.length, 1);
  const bCompany = (await app("B", "GET", "/api/businesses")).body;
  const rowsB = Array.isArray(bCompany) ? bCompany : (bCompany.businesses || []);
  const bId = rowsB[0] && rowsB[0].id;
  const forced = await app("A", "POST", "/api/businesses/switch", { businessId: bId });
  check("A forcing a switch to B's id is REFUSED", forced.status, 403);
  check("...and A is still in its own books",
    (await app("A", "GET", "/api/products")).body.map(p => p.name), ["A-ONLY PLY"]);
  console.log("    this is the line that makes one address safe for a hundred shops");

  console.log("\nA wrong password does not become a second chance at the panel\n");
  check("refused", (await app("A", "POST", "/api/auth/shop-login", { username: A.handover.login, password: "nope" })).status, 401);

  console.log("\nA cached date is not a verdict\n");
  const { DatabaseSync } = require("node:sqlite");
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const expireLocally = () => {
    const t = new DatabaseSync(path.join(appDir, "tenants.db"));
    t.prepare("UPDATE tenants SET expires_on = ? WHERE username = ?")
     .run(yesterday, A.handover.login.toLowerCase());
    t.close();
  };
  const signIn = () => app("A", "POST", "/api/auth/shop-login",
    { username: A.handover.login, password: A.handover.password });

  /* THE CONVERSION CASE. This copy still holds the old demo date, but the
     vendor has been paid. Refusing on the cache alone would lock a
     customer out on the very day they started paying. */
  expireLocally();
  check("a stale date does not refuse while the vendor says otherwise",
    (await signIn()).status, 200);
  console.log("    the vendor is asked again before anybody is turned away");

  /* AND WHEN THE VENDOR AGREES IT HAS ENDED. */
  await panel("POST", "/api/login", { password: PANEL_PW });
  const pdb = new DatabaseSync(path.join(panDir, "licences.db"));
  pdb.prepare("UPDATE customers SET expires_on = ? WHERE id = ?").run(yesterday, A.id);
  pdb.close();
  expireLocally();
  const dead = await signIn();
  check("a finished demo is refused", dead.status, 403);
  check("IN THE WORDS PROMISED", dead.body.error, "Demo License Expired – Please Contact Admin");

  /* AND WITH THE VENDOR UNREACHABLE the cached date stands, so an expired
     demo cannot be revived by pulling the plug. */
  await stopPanel();
  expireLocally();
  check("with the vendor asleep, the cached date still refuses",
    (await signIn()).status, 403);

  console.log(fails ? `\n${fails} FAILED\n` : "\nAll passed\n");
 } catch (e) {
  console.error("\n  ERROR: " + e.stack + "\n--- panel ---\n" + panelOut + "\n--- app ---\n" + appOut + "\n");
  fails++;
 } finally {
  try { panelSrv.kill(); } catch(e){} try { appSrv.kill(); } catch(e){}
  try { fs.rmSync(appDir, { recursive: true, force: true }); } catch(e){}
  try { fs.rmSync(panDir, { recursive: true, force: true }); } catch(e){}
  process.exit(fails ? 1 : 0);
 }
})();
