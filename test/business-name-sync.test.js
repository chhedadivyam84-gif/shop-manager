/* ============================================================
   ONE NAME PER BUSINESS — the switcher and Settings agree

   The switcher lists businesses by the registry name; Settings and every
   bill use settings.business_name. A rename in the switcher wrote both,
   but a rename in Settings wrote only its own, so the two drifted apart
   (raised 21 Oct 2026).

   Routes mounted in-process on a throwaway database:
     - renaming in Settings renames the business in the switcher too
     - renaming in the switcher still renames it in Settings
     - names that drifted apart earlier are matched up when the list is
       read, to the Settings name (the one printed on bills)
     - each business keeps its own name: renaming one leaves the other

   Run:  node test/business-name-sync.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-bizname-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
for (const k of ["SUPABASE_URL", "SUPABASE_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) process.env[k] = "";
const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const C = db.companies;
const first = C.defaultId();
const second = C.create({ name: "Creative creation" }).id;
let current = first, role = "owner";
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = { loggedIn: true, role, staffId: "STAFF_owner", staffName: "Owner", businessId: current };
  C.runAs(current, next);
});
app.use("/api/settings", require(path.join(ROOT, "server/routes/settings.js")));
app.use("/api/businesses", require(path.join(ROOT, "server/routes/businesses.js")));
let BASE;
const call = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t };
};
const listed = async () => Object.fromEntries(((await call("GET", "/api/businesses")).j.businesses || []).map(b => [b.id, b.name]));
const settingsName = id => C.runAs(id, () => db.prepare("SELECT business_name FROM settings WHERE id = 1").get().business_name);

const server = app.listen(0, async () => {
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    console.log("\n--- renaming in Settings ---\n");
    current = first;
    let r = await call("PUT", "/api/settings", { businessName: "Swagat Ply" });
    ok("Settings saves", r.s === 200, [r.s, r.t.slice(0, 120)]);
    let names = await listed();
    ok("...and the switcher shows the new name (it used to keep the old one)", names[first] === "Swagat Ply", names);
    ok("...and the other business is untouched", names[second] === "Creative creation", names);

    console.log("\n--- renaming in the switcher (already worked; must still) ---\n");
    r = await call("PUT", `/api/businesses/${second}`, { name: "Creative Creations Pvt" });
    ok("the switcher rename saves", r.s === 200, [r.s, r.t.slice(0, 120)]);
    ok("...and Settings of that business shows it", settingsName(second) === "Creative Creations Pvt", settingsName(second));
    ok("...and the first business's Settings is untouched", settingsName(first) === "Swagat Ply", settingsName(first));

    console.log("\n--- names that drifted apart before this fix ---\n");
    C.runAs(second, () => db.prepare("UPDATE settings SET business_name = ? WHERE id = 1").run("Creative Creation (Malad)"));
    names = await listed();
    ok("the list is matched to the Settings name, which is on the bills", names[second] === "Creative Creation (Malad)", names);
    ok("...and the registry itself now holds it", C.list().find(b => b.id === second).name === "Creative Creation (Malad)");
    const before = fs.statSync(path.join(DATA_DIR, "companies.json")).mtimeMs;
    await new Promise(res => setTimeout(res, 30));
    await listed();
    ok("...and reading the list again writes nothing when the names agree",
       fs.statSync(path.join(DATA_DIR, "companies.json")).mtimeMs === before);

    console.log("\n--- only the businesses the caller can see are looked at ---\n");
    C.runAs(second, () => db.prepare("UPDATE settings SET business_name = ? WHERE id = 1").run("Drifted Again"));
    role = "staff";
    const staffSees = await listed();
    ok("a staff login sees only its own business", Object.keys(staffSees).join() === first, staffSees);
    ok("...and the OTHER business, which it cannot see, is not touched",
       C.list().find(b => b.id === second).name === "Creative Creation (Malad)", C.list());
    role = "owner";

    console.log("\n--- an empty name changes nothing ---\n");
    r = await call("PUT", "/api/settings", { businessName: "" });
    names = await listed();
    ok("saving Settings without a name keeps the business's name", names[first] === "Swagat Ply" && settingsName(first) === "Swagat Ply", names);
  } catch (e) { console.error(e); fail++; }
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); process.exit(fail ? 1 : 0);
});
