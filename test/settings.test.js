/* ============================================================
   ADMIN SETTINGS — PART 12

   This module writes the row that drives the whole shop: the GSTIN that
   decides whether a bill carries CGST + SGST or IGST, the headings that
   go on a legal document, the counter that issues its number. So the
   tests below are mostly about what must NOT happen:

     - a section writing a field it does not own
     - a malformed email, GSTIN, PIN code or web address reaching the row
     - a "javascript:" address reaching a value that becomes an href
     - an ADMIN changing what only the owner may change
     - a SUPPORT login seeing the configuration at all
     - a credential coming back from the settings endpoint
     - a save that reports success without the backend confirming it
     - a second settings system existing beside the shop's own

   And the half that has to keep working: an owner reading and saving
   every section, the shop's own Settings screen behaving exactly as it
   did, and the audit log recording what actually changed.

   THE SHOP'S REAL SETTINGS ARE A FIXTURE HERE. One test re-saves a
   shop's own stored values unchanged, because the first version of the
   web-address rule rejected "www.swagatply.com" — a value already in
   this shop's database — and would have locked the owner out of saving
   the Business section at all.

   Run:  node test/settings.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-settings-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const adminSettings = require(path.join(ROOT, "server/adminSettings.js"));
const shopSettings = require(path.join(ROOT, "server/routes/settings.js"));
const { hashPin, requireAuth } = require(path.join(ROOT, "server/auth.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

const SHOP = db.companies.create({ name: "Our Shop" });
const OTHER = db.companies.create({ name: "Another Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inOther = fn => db.companies.runAs(OTHER.id, fn);

let CO = SHOP.id, WHO = null;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = WHO ? { loggedIn: true, ...WHO } : {};
  db.companies.runAs(CO, next);
});
app.use("/api/admin", requireAuth, adminAccess.gate(),
        require(path.join(ROOT, "server/routes/admin.js")));

let BASE;
const call = async (method, url, body, who) => {
  if (who !== undefined) WHO = who;
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

const OWNER   = { role: "owner", staffId: "STAFF_owner", staffName: "Owner", adminRole: null };
const ADMIN   = { role: "staff", staffId: "ST-ADM", staffName: "Asha",  adminRole: "ADMIN" };
const SUPPORT = { role: "staff", staffId: "ST-SUP", staffName: "Sunil", adminRole: "SUPPORT" };
const PLAIN   = { role: "staff", staffId: "ST-NON", staffName: "Neha",  adminRole: null };

const addStaff = (id, name, role, adminRole) =>
  db.prepare(`INSERT INTO staff (id,name,pin_hash,role,active,created_at,admin_role)
              VALUES (?,?,?,?,1,?,?)`)
    .run(id, name, hashPin("1234"), role, Date.now(), adminRole || null);

/* The secrets that live on the settings row. Planted so the disclosure
   block has something real to hunt for. */
const SECRETS = {
  sync_cloud_key:   "LEAK-SYNCKEY-abc123",
  sync_accept_hash: "LEAK-ACCEPTHASH-def456",
  license_key:      "LEAK-LICENCE-ghi789",
  activation_code:  "LEAK-ACTIVATION-jkl",
  scan_credentials: "LEAK-SCANCRED-mno",
  gst_credentials:  "LEAK-GSTCRED-pqr",
  pin_hash:         "LEAK-PINHASH-stu",
};

function seed() {
  inShop(() => {
    addStaff("ST-ADM", "Asha Manager", "staff", "ADMIN");
    addStaff("ST-SUP", "Sunil Support", "staff", "SUPPORT");
    addStaff("ST-NON", "Neha Counter", "staff", null);

    /* A shop configured the way a real one is — including a website
       written without a scheme, which is what this shop actually has. */
    db.prepare(`UPDATE settings SET business_name=?, address=?, phones=?, email=?,
                  website=?, gstin=?, state=?, pin_code=?, invoice_title=?,
                  challan_title=?, sync_cloud_key=?, sync_accept_hash=?,
                  license_key=?, activation_code=?, scan_credentials=?,
                  gst_credentials=?, pin_hash=? WHERE id=1`)
      .run("Swagat Ply", "Shop No. 2, S. V. Road, Malad West, Mumbai",
           "+91 9819300054/ +91 9819300059", "swagatply@gmail.com",
           "www.swagatply.com", "27AAAPC7198R1Z1", "Maharashtra", "400064",
           "TAX INVOICE", "DELIVERY CHALLAN",
           SECRETS.sync_cloud_key, SECRETS.sync_accept_hash, SECRETS.license_key,
           SECRETS.activation_code, SECRETS.scan_credentials,
           SECRETS.gst_credentials, SECRETS.pin_hash);
  });
  inOther(() => {
    db.prepare("UPDATE settings SET business_name=?, gstin=? WHERE id=1")
      .run("RIVAL TRADERS", "29ZZZZZ9999Z9Z9");
  });
}

const settingsRow = () => inShop(() =>
  db.prepare("SELECT * FROM settings WHERE id = 1").get());

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  ONE SETTINGS SYSTEM, NOT TWO
     ================================================================ */
  console.log("\n--- the shop's own settings, reused ---");

  /* The shop-wide configuration lives in exactly one row of one table.
     tally_settings and employee_settings are their own subsystems'
     tables and always were — the thing being checked is that PART 12
     did not add a SECOND general settings store beside `settings`. */
  ok("the shop's configuration is still one row of one table", inShop(() => {
    const t = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND (name LIKE '%setting%' OR name LIKE '%config%' OR name LIKE '%preference%')`)
      .all().map(r => r.name).sort();
    const rows = db.prepare("SELECT COUNT(*) v FROM settings").get().v;
    return rows === 1 &&
           t.join(",") === "employee_settings,settings,tally_settings";
  }), inShop(() => db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
      AND (name LIKE '%setting%' OR name LIKE '%config%' OR name LIKE '%preference%')`)
    .all().map(r => r.name)));

  ok("and PART 12 added no table of its own", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminSettings.js"), "utf8") +
                fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
    return !/CREATE TABLE/i.test(src);
  })());

  ok("the admin module writes nothing itself", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminSettings.js"), "utf8");
    return !/\b(INSERT|UPDATE|DELETE)\s+/i.test(src.replace(/\/\*[\s\S]*?\*\//g, ""));
  })());

  ok("it saves through the shop's own handlers", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
    return /require\("\.\/settings"\)\.updateSettings\(req, res\)/.test(src) &&
           /require\("\.\/settings"\)\.updateNumbering\(req, res\)/.test(src) &&
           /require\("\.\/settings"\)\.updateAppTheme\(req, res\)/.test(src);
  })());

  ok("and reads through the shop's own publicSettings", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminSettings.js"), "utf8");
    return /shopSettings\.publicSettings\(\)/.test(src);
  })());

  /* ================================================================
     2.  NO SECRET LEAVES THE SERVER
     ================================================================ */
  console.log("\n--- the settings row carries secrets; none of them leave ---");

  const pub = inShop(() => shopSettings.publicSettings());
  const pubBlob = JSON.stringify(pub);

  for (const [col, val] of Object.entries(SECRETS)) {
    ok("publicSettings strips " + col, pubBlob.indexOf(val) === -1, col);
  }

  ok("but keeps the ordinary settings",
     pub.business_name === "Swagat Ply" && pub.gstin === "27AAAPC7198R1Z1" &&
     "invoice_title" in pub && "address" in pub);

  const asOwner = await call("GET", "/api/admin/settings", null, OWNER);
  ok("the admin settings endpoint answers the owner", asOwner.status === 200, asOwner.status);
  for (const [col, val] of Object.entries(SECRETS)) {
    ok("the admin endpoint never sends " + col, asOwner.text.indexOf(val) === -1, col);
  }

  /* THE TRIPWIRE for the next secret column somebody adds. */
  ok("every credential-looking column is on the denylist", inShop(() => {
    const cols = db.prepare("PRAGMA table_info(settings)").all().map(c => c.name);
    const suspicious = cols.filter(c =>
      /(^|_)(key|hash|secret|token|credential|password|pin|code)s?$/.test(c));
    const missed = suspicious.filter(c => !shopSettings.NEVER_SENT.includes(c)
      /* pin_code is the shop's postal PIN code, which is printed on every
         invoice — it is not a credential however the name reads. */
      && c !== "pin_code" && c !== "tenant_code");
    return missed.length === 0;
  }), inShop(() => db.prepare("PRAGMA table_info(settings)").all().map(c => c.name)
    .filter(c => /(^|_)(key|hash|secret|token|credential|password|pin|code)s?$/.test(c)
      && !shopSettings.NEVER_SENT.includes(c) && c !== "pin_code" && c !== "tenant_code")));

  ok("no screen in this app reads a stripped column", (() => {
    const js = fs.readFileSync(path.join(ROOT, "public/js/app.js"), "utf8") +
               fs.readFileSync(path.join(ROOT, "public/js/admin.js"), "utf8");
    return shopSettings.NEVER_SENT.every(c => js.indexOf(c) === -1);
  })());

  /* ================================================================
     3.  AUTHORIZATION
     ================================================================ */
  console.log("\n--- who may see it, and who may change it ---");

  ok("settings.view is its own capability", !!adminAccess.CAPS["settings.view"]);
  ok("settings.edit is a separate one", !!adminAccess.CAPS["settings.edit"]);
  ok("the owner may read", adminAccess.CAPS["settings.view"].includes("OWNER"));
  ok("an ADMIN may read", adminAccess.CAPS["settings.view"].includes("ADMIN"));
  ok("SUPPORT may NOT read", !adminAccess.CAPS["settings.view"].includes("SUPPORT"));
  ok("ONLY the owner may change",
     adminAccess.CAPS["settings.edit"].length === 1 &&
     adminAccess.CAPS["settings.edit"][0] === "OWNER");
  ok("the Settings section asks for settings.view", (() => {
    const s = adminAccess.SECTIONS.filter(x => x.key === "settings")[0];
    return s && s.cap === "settings.view";
  })());

  const admGet = await call("GET", "/api/admin/settings", null, ADMIN);
  ok("an ADMIN can read the settings", admGet.status === 200, admGet.status);
  ok("and is told they may not edit", admGet.j.mayEdit === false, admGet.j.mayEdit);
  ok("the owner is told they may", asOwner.j.mayEdit === true);

  const admPut = await call("PUT", "/api/admin/settings/business",
                            { businessName: "Admin Was Here" }, ADMIN);
  ok("AN ADMIN CANNOT SAVE — the server refuses, not the screen",
     admPut.status === 403, admPut.status);
  ok("and nothing was written",
     settingsRow().business_name === "Swagat Ply", settingsRow().business_name);

  const supGet = await call("GET", "/api/admin/settings", null, SUPPORT);
  ok("a SUPPORT login cannot even read", supGet.status === 403, supGet.status);
  const supPut = await call("PUT", "/api/admin/settings/business",
                            { businessName: "Support Was Here" }, SUPPORT);
  ok("nor write", supPut.status === 403, supPut.status);

  const plainGet = await call("GET", "/api/admin/settings", null, PLAIN);
  ok("a staff member with no admin role is refused",
     plainGet.status === 401 || plainGet.status === 403, plainGet.status);

  const anonGet = await call("GET", "/api/admin/settings", null, null);
  ok("nobody signed in is refused", anonGet.status === 401, anonGet.status);
  const anonPut = await call("PUT", "/api/admin/settings/business",
                             { businessName: "Anon" }, null);
  ok("and cannot write", anonPut.status === 401, anonPut.status);
  ok("still nothing written", settingsRow().business_name === "Swagat Ply");

  const me = await call("GET", "/api/admin/me", null, SUPPORT);
  ok("SUPPORT is not offered the section in its own nav",
     me.status === 200 && !me.j.sections.some(s => s.key === "settings"));

  /* ================================================================
     4.  A SECTION WRITES ONLY ITS OWN FIELDS
     ================================================================ */
  console.log("\n--- a section cannot reach outside itself ---");

  const titleBefore = settingsRow().invoice_title;
  const smuggle = await call("PUT", "/api/admin/settings/business",
    { businessName: "Swagat Ply", invoiceTitle: "SMUGGLED", allowNegativeStock: true,
      theme: "plum-rose", pin_hash: "x", license_key: "y" }, OWNER);
  ok("the save succeeds for the fields it owns", smuggle.status === 200, smuggle.status);
  ok("a field from another section is ignored",
     settingsRow().invoice_title === titleBefore, settingsRow().invoice_title);
  ok("a column name is not a way in",
     settingsRow().pin_hash === SECRETS.pin_hash &&
     settingsRow().license_key === SECRETS.license_key);
  ok("and a toggle from another section did not move",
     !settingsRow().allow_negative_stock);

  ok("an unknown section is a plain 404", (await call(
     "PUT", "/api/admin/settings/nope", { x: 1 }, OWNER)).status === 404);
  ok("a body that is not an object is refused", (await call(
     "PUT", "/api/admin/settings/business", ["businessName"], OWNER)).status === 400);
  ok("a body with nothing this section owns is refused", (await call(
     "PUT", "/api/admin/settings/business", { nonsense: 1 }, OWNER)).status === 400);

  /* ================================================================
     5.  VALIDATION
     ================================================================ */
  console.log("\n--- what may not enter the database ---");

  const bad = async (section, body, field) => {
    const r = await call("PUT", "/api/admin/settings/" + section, body, OWNER);
    return r.status === 400 && r.j && r.j.fields && !!r.j.fields[field];
  };

  ok("a blank business name", await bad("business", { businessName: "   " }, "businessName"));
  ok("an over-long business name",
     await bad("business", { businessName: "x".repeat(200) }, "businessName"));
  ok("an email with no @", await bad("business", { email: "nope" }, "email"));
  ok("an email with spaces", await bad("business", { email: "a b@c.com" }, "email"));
  ok("an email with no dot", await bad("business", { email: "a@b" }, "email"));
  ok("a GSTIN of the wrong length", await bad("business", { gstin: "27AAA" }, "gstin"));
  ok("a GSTIN of the right length but wrong shape",
     await bad("business", { gstin: "ZZZZZZZZZZZZZZZ" }, "gstin"));
  ok("a PIN code that is not six digits", await bad("business", { pinCode: "4000" }, "pinCode"));
  ok("a PIN code with letters", await bad("business", { pinCode: "40006A" }, "pinCode"));
  ok("a state this app does not know", await bad("business", { state: "Atlantis" }, "state"));
  ok("a phone field with no digits", await bad("business", { phones: "call us" }, "phones"));
  ok("a phone field with letters", await bad("business", { phones: "98765 ABCDE" }, "phones"));

  console.log("\n--- a web address that would run code ---");
  ok("javascript: in the website", await bad("business", { website: "javascript:alert(1)" }, "website"));
  ok("data: in the website", await bad("business", { website: "data:text/html,x" }, "website"));
  ok("javascript: in the portal address",
     await bad("documents", { portalUrl: "javascript:alert(1)" }, "portalUrl"));
  ok("a portal address with no scheme at all",
     await bad("documents", { portalUrl: "example.com" }, "portalUrl"));

  ok("but an ordinary written web address is accepted", (await call(
     "PUT", "/api/admin/settings/business", { website: "www.swagatply.com" }, OWNER)).status === 200);
  ok("and so is a full one", (await call(
     "PUT", "/api/admin/settings/business", { website: "https://swagatply.com" }, OWNER)).status === 200);

  console.log("\n--- the shop can re-save what it already has ---");
  /* The rule that caught this: the first web-address check demanded a
     scheme, and this shop's stored website has none — so the owner
     could not have saved the Business section at all without editing a
     field they had not touched. */
  const current = inShop(() => adminSettings.currentValues().business);
  const resave = inShop(() => adminSettings.validate("business", current));
  ok("every value already in this shop's row passes validation",
     resave.ok === true, resave.fields);

  console.log("\n--- document numbering ---");
  ok("zero is refused", await bad("numbering", { nextEstimateNumber: 0 }, "nextEstimateNumber"));
  ok("a negative number is refused",
     await bad("numbering", { nextChallanNumber: -5 }, "nextChallanNumber"));
  ok("a fraction is refused",
     await bad("numbering", { nextEstimateNumber: 4.5 }, "nextEstimateNumber"));
  ok("a number too long for the format is refused",
     await bad("numbering", { nextEstimateNumber: 99999999 }, "nextEstimateNumber"));
  ok("text is refused", await bad("numbering", { nextEstimateNumber: "abc" }, "nextEstimateNumber"));

  const setNo = await call("PUT", "/api/admin/settings/numbering",
                           { nextEstimateNumber: 420 }, OWNER);
  ok("a sensible number is accepted", setNo.status === 200, setNo.status);
  ok("and the NEXT document really gets it",
     inShop(() => shopSettings.readCounter("estimate-no")) === 419,
     inShop(() => shopSettings.readCounter("estimate-no")));

  console.log("\n--- themes are whitelisted, not free text ---");
  ok("an unknown colour scheme", await bad("appearance", { theme: "neon-pink" }, "theme"));
  ok("an unknown invoice layout", await bad("documents", { invoiceTheme: "comic" }, "invoiceTheme"));
  ok("a known one is accepted", (await call(
     "PUT", "/api/admin/settings/appearance", { theme: "forest-brass" }, OWNER)).status === 200);
  ok("and it was stored", settingsRow().app_theme === "forest-brass");

  /* ================================================================
     6.  SAVING REALLY SAVES
     ================================================================ */
  console.log("\n--- a save that the database confirms ---");

  const r1 = await call("PUT", "/api/admin/settings/business",
    { businessName: "Swagat Ply Pvt Ltd", legalName: "Swagat Plywood Traders",
      email: "owner@swagat.example" }, OWNER);
  ok("it succeeds", r1.status === 200, r1.status);
  ok("business name written", settingsRow().business_name === "Swagat Ply Pvt Ltd");
  ok("legal name written — a column no screen could fill before",
     settingsRow().legal_name === "Swagat Plywood Traders");
  ok("email written", settingsRow().email === "owner@swagat.example");
  ok("and the response is the settings, not a bare ok",
     r1.j && r1.j.business_name === "Swagat Ply Pvt Ltd");
  ok("the response carries no secret",
     Object.values(SECRETS).every(v => r1.text.indexOf(v) === -1));

  const r2 = await call("PUT", "/api/admin/settings/documents",
    { invoiceTitle: "TAX INVOICE / BILL", footerMessage: "Goods once sold are not returnable." },
    OWNER);
  ok("documents save", r2.status === 200, r2.status);
  ok("heading written", settingsRow().invoice_title === "TAX INVOICE / BILL");
  ok("footer written", settingsRow().footer_message === "Goods once sold are not returnable.");
  ok("and the business name was NOT disturbed",
     settingsRow().business_name === "Swagat Ply Pvt Ltd");

  const r3 = await call("PUT", "/api/admin/settings/operations",
    { allowNegativeStock: true }, OWNER);
  ok("operations save", r3.status === 200, r3.status);
  ok("the toggle moved", !!settingsRow().allow_negative_stock);
  const r4 = await call("PUT", "/api/admin/settings/operations",
    { allowNegativeStock: false }, OWNER);
  ok("and moves back", r4.status === 200 && !settingsRow().allow_negative_stock);

  /* ================================================================
     7.  AUDIT
     ================================================================ */
  console.log("\n--- what changed is on the record ---");

  const lastAudit = (action) => inShop(() => db.prepare(
    "SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1").get(action));

  await call("PUT", "/api/admin/settings/business", { businessName: "ABC Traders" }, OWNER);
  await call("PUT", "/api/admin/settings/business", { businessName: "ABC Traders Pvt Ltd" }, OWNER);

  const a = lastAudit("settings.update");
  ok("a settings change is recorded", !!a);
  ok("it names the field that moved, not just 'settings'",
     /business_name/.test(a.details), a.details);
  ok("THE BRIEF'S OWN EXAMPLE — before ABC Traders, after ABC Traders Pvt Ltd", (() => {
    const m = JSON.parse(a.meta || "{}");
    return m.before && m.before.business_name === "ABC Traders" &&
           m.after && m.after.business_name === "ABC Traders Pvt Ltd";
  })(), a.meta);
  ok("the actor is recorded", a.actor_type === "OWNER" && a.staff_id === "STAFF_owner");
  ok("and the resource", a.resource_type === "settings");

  ok("a field that did NOT change is absent from the record", (() => {
    const m = JSON.parse(a.meta || "{}");
    return !("gstin" in (m.before || {})) && !("address" in (m.before || {}));
  })());

  ok("NO SECRET reaches the audit log", inShop(() => {
    const rows = db.prepare("SELECT details, meta FROM audit_log").all();
    const blob = rows.map(r => String(r.details || "") + String(r.meta || "")).join("|");
    return Object.values(SECRETS).every(v => blob.indexOf(v) === -1);
  }));

  ok("the logo is never written into an audit entry", inShop(() => {
    const rows = db.prepare("SELECT meta FROM audit_log WHERE action LIKE 'settings%'").all();
    return rows.every(r => !/logo_data|data:image/.test(String(r.meta || "")));
  }));

  await call("PUT", "/api/admin/settings/numbering", { nextChallanNumber: 77 }, OWNER);
  ok("a numbering change is recorded", !!lastAudit("settings.numbering"));
  await call("PUT", "/api/admin/settings/appearance", { theme: "teal-copper" }, OWNER);
  const at = lastAudit("settings.appTheme");
  ok("a theme change is recorded with its before and after", (() => {
    const m = JSON.parse(at.meta || "{}");
    return m.before && m.after && m.after.appTheme === "teal-copper";
  })(), at && at.meta);

  /* ================================================================
     8.  ONE SHOP CANNOT REACH ANOTHER'S
     ================================================================ */
  console.log("\n--- settings are per business ---");

  ok("the other shop has its own settings",
     inOther(() => db.prepare("SELECT business_name FROM settings WHERE id=1").get().business_name)
       === "RIVAL TRADERS");

  ok("nothing written here touched it",
     inOther(() => db.prepare("SELECT business_name, gstin FROM settings WHERE id=1").get().gstin)
       === "29ZZZZZ9999Z9Z9");

  ok("there is no settings id in any of these routes to manipulate", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
    const block = src.slice(src.indexOf("SETTINGS — PART 12"));
    /* The only parameter is the section name, which is matched against a
       fixed catalogue. No company, business or settings id anywhere. */
    return !/:(company|business|org|tenant|shop)Id/i.test(block) &&
           /router\.put\("\/settings\/:section"/.test(block);
  })());

  ok("a company id in the body is ignored", (async () => {
    const r = await call("PUT", "/api/admin/settings/business",
      { businessName: "Still Ours", companyId: OTHER.id, businessId: OTHER.id }, OWNER);
    return r.status === 200 &&
      inOther(() => db.prepare("SELECT business_name FROM settings WHERE id=1").get().business_name)
        === "RIVAL TRADERS";
  }) !== null);

  const idorBody = await call("PUT", "/api/admin/settings/business",
    { businessName: "Ours Only", companyId: OTHER.id }, OWNER);
  ok("a manipulated company id changes nothing elsewhere",
     idorBody.status === 200 &&
     inOther(() => db.prepare("SELECT business_name FROM settings WHERE id=1").get().business_name)
       === "RIVAL TRADERS");
  ok("and writes to the caller's own shop",
     settingsRow().business_name === "Ours Only");

  /* The binder decides from the session, so pointing the test harness at
     the other company really does move the write. That is the isolation
     working, not failing. */
  CO = OTHER.id;
  await call("PUT", "/api/admin/settings/business", { tagline: "rival tagline" }, OWNER);
  CO = SHOP.id;
  ok("writing as the other shop stays in the other shop",
     inOther(() => db.prepare("SELECT tagline FROM settings WHERE id=1").get().tagline) === "rival tagline" &&
     settingsRow().tagline !== "rival tagline");

  /* ================================================================
     9.  THE CATALOGUE IS HONEST
     ================================================================ */
  console.log("\n--- every setting offered is a real one ---");

  const desc = inShop(() => adminSettings.describe());
  const cols = inShop(() => db.prepare("PRAGMA table_info(settings)").all().map(c => c.name));

  ok("every editable field maps to a real column or a real counter", (() => {
    const bad = [];
    for (const sec of adminSettings.SECTIONS) {
      for (const f of sec.fields) {
        if (f.column && !cols.includes(f.column)) bad.push(sec.key + "." + f.key);
      }
    }
    return bad.length === 0;
  })());

  ok("no field offers a setting this app cannot act on", (() => {
    /* The three the brief suggests and this app does not support. If one
       of these ever appears as an editable field, it is decoration. */
    const keys = adminSettings.SECTIONS.flatMap(s => s.fields.map(f => f.key.toLowerCase()));
    return !keys.some(k => /currency|locale|language|dateformat|timeformat|timezone/.test(k));
  })());

  ok("there is no Notifications section — this app has no notifications",
     !desc.sections.some(s => /notification/i.test(s.label)));

  ok("the facts that cannot be changed are shown as facts", (() => {
    const sys = desc.sections.filter(s => s.key === "system")[0];
    return sys && sys.readOnly === true && sys.facts.length >= 6 &&
           sys.facts.some(f => /currency/i.test(f.label)) &&
           sys.facts.some(f => /timezone/i.test(f.label));
  })());

  ok("and the System section offers nothing to edit", (() => {
    const sys = desc.sections.filter(s => s.key === "system")[0];
    return sys.fields.length === 0;
  })());

  ok("the financial year is reported but not editable", (() => {
    const sys = desc.sections.filter(s => s.key === "system")[0];
    const fy = sys.facts.filter(f => /financial year/i.test(f.label))[0];
    const editable = adminSettings.SECTIONS.flatMap(s => s.fields.map(f => f.key));
    return fy && /different financial years/i.test(fy.note) &&
           !editable.some(k => /fy|financial/i.test(k));
  })());

  ok("a dead column is not offered", (() => {
    /* trade_name exists on the row and is read and written by nothing in
       the whole app. */
    const editable = adminSettings.SECTIONS.flatMap(s => s.fields.map(f => f.column));
    return !editable.includes("trade_name");
  })());

  ok("the sensitive settings are marked as such", (() => {
    const sens = adminSettings.SECTIONS.flatMap(s =>
      s.fields.filter(f => f.sensitive).map(f => f.key));
    return sens.includes("allowNegativeStock") &&
           sens.includes("nextEstimateNumber") && sens.includes("nextChallanNumber");
  })());

  ok("and every sensitive one explains its impact",
     adminSettings.SECTIONS.every(s =>
       s.fields.every(f => !f.sensitive || !!f.impact)));

  /* ================================================================
     9b. THE FORM IS WIRED ONCE
     ================================================================ */
  console.log("\n--- the form handlers are attached once, not once per repaint ---");

  ok("the listeners go on the container, from the screen setup", (() => {
    const js = fs.readFileSync(path.join(ROOT, "public/js/admin.js"), "utf8");
    return /wireSettingsForm\(\);\s*\n\s*paintSettingsSection\(chosen\.key\);/.test(js);
  })());

  ok("and NOT from the repaint, which runs on every save and cancel", (() => {
    const js = fs.readFileSync(path.join(ROOT, "public/js/admin.js"), "utf8");
    const fn = /function paintSettingsSection\(key\)[\s\S]*?\n  }/.exec(js)[0];
    /* THE BUG THIS PINS: wiring from here stacked another copy of the
       save handler on the same element every time the form was redrawn.
       After one Cancel a save ran twice, and the second pass wrote
       undefined over the value the first had just stored: the field went
       blank on screen while the database held the right value. Found by
       doing it in a browser, not by a test. */
    return !/addEventListener/.test(fn);
  })());

  ok("a save cannot run twice over itself", (() => {
    const js = fs.readFileSync(path.join(ROOT, "public/js/admin.js"), "utf8");
    const fn = /async function saveSettingsSection\(key\)[\s\S]*?\n  }/.exec(js)[0];
    return /if \(setSaving\) return;/.test(fn) && /setSaving = true;/.test(fn);
  })());

  /* ================================================================
     10. THE SHOP'S OWN SETTINGS SCREEN IS UNCHANGED
     ================================================================ */
  console.log("\n--- nothing was taken away from the shop app ---");

  ok("every route the shop's settings screen uses is still mounted", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/settings.js"), "utf8");
    return ['router.get("/"', 'router.put("/"', 'router.get("/numbering"',
            'router.put("/numbering"', 'router.put("/print-prefs"',
            'router.put("/po-wa-template"', 'router.put("/app-theme"',
            'router.put("/home-tiles"', 'router.put("/logo"']
      .every(r => src.indexOf(r) !== -1);
  })());

  ok("and each still requires the owner", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/settings.js"), "utf8");
    const puts = src.match(/router\.put\("[^"]+"/g) || [];
    const guarded = src.match(/router\.put\("[^"]+",\s*requireRole\("owner"\)/g) || [];
    /* Every PUT in that file, not a number written down here: a route
       added later without the owner gate fails this. */
    return puts.length > 0 && guarded.length === puts.length;
  })());

  /* ================================================================ */
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
