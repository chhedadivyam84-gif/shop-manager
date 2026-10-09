/* DOES A SHOP KEEP ITS BOOKS WHEN THE VENDOR REISSUES ITS CODE?
 *
 * The panel has no delete, so this never looked like data loss there —
 * the customer row was always still sitting in the list. It was the SHOP
 * that lost everything, by concluding it had never met this customer and
 * starting a second, empty company beside the real one.
 *
 * Why it happened: a sold copy found its own company by the activation
 * code stamped inside the books. The vendor can replace that code. The
 * moment they did, nothing matched, and the only remaining branch was
 * "a genuinely new shop".
 *
 * So this runs BOTH halves for real — the licence panel and the shop app,
 * two processes talking over HTTP — and does the one thing that used to
 * break it: signs a shop in, reissues the code, signs in again.
 *
 * The assertion that matters is the company count. One shop must mean one
 * company, no matter how many times its code is replaced.
 *
 * Nothing here touches real data: both halves run in fresh temp
 * directories and are thrown away at the end.
 *
 * Run:  node test/tenant-identity.test.js
 */
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const SHOP = path.join(__dirname, "..");
const PANEL = "C:/Users/prafu/shop-manager-licence";
const KEYS = "C:/Users/prafu/shop-manager-vendor-keys";

/* Deliberately not 3000 (the live pm2 app) and not 3210. */
const PANEL_PORT = 4506, SHOP_PORT = 4811;
const VENDOR_PW = "identity-e2e-panel";

let fails = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}` +
    (ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

function request(port, method, p, body, cookie) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { "content-type": "application/json" };
    if (cookie) h.cookie = cookie;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const r = http.request({ method, path: p, port, host: "127.0.0.1", headers: h }, x => {
      let d = ""; x.on("data", c => d += c);
      x.on("end", () => res({
        status: x.statusCode,
        cookie: (x.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; "),
        body: (() => { try { return JSON.parse(d || "{}"); } catch (e) { return d; } })(),
      }));
    });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}

const panelDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-panel-"));
const shopDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-shop-"));
let panel = null, shop = null, panelOut = "", shopOut = "";

function startPanel() {
  panel = spawn(process.execPath, ["--no-warnings", path.join(PANEL, "server.js")], {
    cwd: PANEL,
    env: { ...process.env, ADMIN_PASSWORD: VENDOR_PW, DATA_DIR: panelDir, PORT: String(PANEL_PORT),
           SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "",
           R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
           VENDOR_PRIVATE_KEY: fs.readFileSync(path.join(KEYS, "private-key.pem"), "utf8") },
  });
  panel.stdout.on("data", d => panelOut += d);
  panel.stderr.on("data", d => panelOut += d);
}

function startShop() {
  shop = spawn(process.execPath, ["--no-warnings", path.join(SHOP, "server/index.js")], {
    cwd: SHOP,
    env: { ...process.env, DATA_DIR: shopDir, PORT: String(SHOP_PORT),
           MULTI_TENANT: "1",
           LICENCE_SERVER: `http://127.0.0.1:${PANEL_PORT}`,
           /* Never let the test reach a real object store. */
           SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "",
           R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" },
  });
  shop.stdout.on("data", d => shopOut += d);
  shop.stderr.on("data", d => shopOut += d);
}

const waitFor = async (port, p) => {
  for (let i = 0; i < 240; i++) {
    try { await request(port, "GET", p); return; }
    catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`nothing answered on ${port}${p}\n--- panel ---\n${panelOut}\n--- shop ---\n${shopOut}`);
};

const stop = c => new Promise(r => { if (!c) return r(); c.once("exit", r); c.kill("SIGTERM"); setTimeout(r, 4000); });
process.on("exit", () => { try { panel && panel.kill(); } catch (e) {} try { shop && shop.kill(); } catch (e) {} });

/** The shop's own registry of companies — a second entry is the bug. */
const companies = () => {
  try { return JSON.parse(fs.readFileSync(path.join(shopDir, "companies.json"), "utf8")).companies || []; }
  catch (e) { return []; }
};

/** Which company the tenant map has this shop bound to. */
function boundCompany(username) {
  const f = path.join(shopDir, "tenants.db");
  if (!fs.existsSync(f)) return null;
  const d = new DatabaseSync(f, { readOnly: true });
  try {
    const r = d.prepare("SELECT company_id, customer_id FROM tenants WHERE username = ?").get(username);
    return r || null;
  } catch (e) { return null; }
  finally { try { d.close(); } catch (e) {} }
}

/* An install that already had data/shop.db keeps it exactly where it was
   and becomes company 1 there; every company made later lives under
   companies/<id>/. Both shapes are normal, so both are looked for. */
function marks(companyId) {
  let f = path.join(shopDir, "companies", companyId, "shop.db");
  if (!fs.existsSync(f)) f = path.join(shopDir, "shop.db");
  if (!fs.existsSync(f)) return null;
  const d = new DatabaseSync(f, { readOnly: true });
  try { return d.prepare("SELECT tenant_code, tenant_customer_id FROM settings WHERE id = 1").get() || null; }
  catch (e) { return null; }
  finally { try { d.close(); } catch (e) {} }
}

(async () => {
 try {
  startPanel(); await waitFor(PANEL_PORT, "/api/health");

  console.log("\nThe vendor sells a licence\n");
  const vendor = (await request(PANEL_PORT, "POST", "/api/login", { password: VENDOR_PW })).cookie;
  const made = (await request(PANEL_PORT, "POST", "/api/customers", {
    shopName: "Orphan Test Stores", phone: "9820099999", username: "9820099999",
  }, vendor)).body;
  const customerId = made.id, codeA = made.code;
  const shopPassword = made.password || (made.handover && made.handover.password);
  check("a customer exists", !!customerId && !!codeA, true);

  const until = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  check("approved", (await request(PANEL_PORT, "POST",
    `/api/customers/${customerId}/approve`, { until }, vendor)).status, 200);

  startShop(); await waitFor(SHOP_PORT, "/api/auth/me");

  /* A fresh install adopts the data/shop.db it finds as company 1, so the
     baseline is whatever is already registered — not zero. What matters
     is that this number does not grow when a code is replaced. */
  const baseline = companies().length;
  console.log(`    (the install starts with ${baseline} company already registered)\n`);

  console.log("\nThe shopkeeper signs in for the first time\n");
  const first = await request(SHOP_PORT, "POST", "/api/auth/shop-login",
    { username: "9820099999", password: shopPassword });
  check("signed in", first.status, 200);

  check("exactly one new company was made for them", companies().length, baseline + 1);
  const bound1 = boundCompany("9820099999");
  const theirCompany = bound1 && bound1.company_id;
  check("the tenant map binds them to a company", !!theirCompany, true);
  check("...and remembers who the vendor says they are", bound1 && bound1.customer_id, customerId);

  const m1 = marks(theirCompany);
  check("their books remember the code", m1 && m1.tenant_code, codeA);
  check("...AND the id that outlives it", m1 && m1.tenant_customer_id, customerId);

  console.log("\n*** THE VENDOR ISSUES A NEW CODE — this is what used to orphan them ***\n");
  const reissued = (await request(PANEL_PORT, "POST",
    `/api/customers/${customerId}/new-code`, {}, vendor)).body;
  const codeB = reissued.code;
  check("the code really changed", codeB !== codeA, true);

  console.log("\nThe same shopkeeper signs in again\n");
  const second = await request(SHOP_PORT, "POST", "/api/auth/shop-login",
    { username: "9820099999", password: shopPassword });
  check("signed in again", second.status, 200);

  check("NO NEW COMPANY APPEARED — their books were not orphaned",
        companies().length, baseline + 1);
  const bound2 = boundCompany("9820099999");
  check("...and they are still bound to the SAME company",
        bound2 && bound2.company_id, theirCompany);

  /* The stamped CODE deliberately lags here. This sign-in was decided
     offline from the map and never asked the vendor, which is the
     behaviour that keeps a shop working while the licence server is
     asleep. That is exactly why the code is the wrong thing to identify
     them by, and why the id is written beside it. */
  const m2 = marks(theirCompany);
  check("the identity in the books is unchanged", m2 && m2.tenant_customer_id, customerId);
  check("...and the stamped code is still one they have held",
        [codeA, codeB].includes(m2 && m2.tenant_code), true);

  console.log("\n*** THE CASE THAT ACTUALLY BROKE: the tenant map is gone ***\n");
  /* A returning shop is decided offline from the map and never asks the
     vendor, so the checks above never reach the binding code at all.
     The bug fires when the map CANNOT answer — a reinstall, a new PC, or
     a map restored a run out of step — because only then does the app go
     and ask who this is, and only then can it decide it has never met
     them. That is the moment a second empty company used to appear. */
  await stop(shop);
  fs.rmSync(path.join(shopDir, "tenants.db"), { force: true });
  fs.rmSync(path.join(shopDir, "tenants.db-wal"), { force: true });
  fs.rmSync(path.join(shopDir, "tenants.db-shm"), { force: true });
  check("the map really is gone", fs.existsSync(path.join(shopDir, "tenants.db")), false);

  /* And the code is replaced again while the map is missing, so NOTHING
     the old lookup knew about still matches: not the map, not the code
     stamped in the books. Only the customer id can answer now. */
  const codeC = (await request(PANEL_PORT, "POST",
    `/api/customers/${customerId}/new-code`, {}, vendor)).body.code;
  check("a third code was issued", codeC !== codeB && codeC !== codeA, true);

  startShop(); await waitFor(SHOP_PORT, "/api/auth/me");
  const rebuilt = await request(SHOP_PORT, "POST", "/api/auth/shop-login",
    { username: "9820099999", password: shopPassword });
  check("they can still sign in", rebuilt.status, 200);

  check("NO NEW COMPANY — found by identity alone", companies().length, baseline + 1);
  check("...and it is their original company, books and all",
        boundCompany("9820099999").company_id, theirCompany);
  check("...with the map rebuilt against the same identity",
        boundCompany("9820099999").customer_id, customerId);
  check("...and the books now stamped with the newest code",
        marks(theirCompany).tenant_code, codeC);

  await stop(shop); await stop(panel);
  console.log(fails ? `\n${fails} FAILED\n` : "\nAll passed\n");
  process.exit(fails ? 1 : 0);
 } catch (e) {
  console.error("\nTEST ERROR: " + e.message);
  try { await stop(shop); await stop(panel); } catch (x) {}
  process.exit(1);
 }
})();
