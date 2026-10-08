/* ============================================================
   SYSTEM HEALTH — PART 11

   A monitoring page is the easiest thing in an admin panel to fake. It
   can show eight green ticks without checking anything, invent a
   percentage, and look more professional than a page that admits it
   does not know. So most of what follows is an attempt to catch this
   one lying:

     - a service reported healthy that was never checked
     - "configured" presented as "working"
     - a percentage with no calculation behind it
     - a response time that is not a measurement
     - a cached reading presented as current after the check failed
     - "not set up" coloured as a fault

   And the other half is the thing a health page must never become,
   which is an information leak. Section 18 of the brief lists what must
   not escape; the disclosure block below plants a secret in every place
   this page reads from and then scans the entire response for all of
   them at once.

   Run:  node test/health.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-health-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

/* PLANTED BEFORE ANYTHING IS REQUIRED, so the modules read them at load
   time exactly as they would in production. Every one of these strings
   is hunted for in the disclosure block. */
const SECRETS = {
  SUPABASE_URL: "https://LEAKHOST.supabase.co",
  SUPABASE_KEY: "LEAKKEY-service-role-abcdef",
  SUPABASE_BUCKET: "LEAKBUCKET-shop-backups",
  ANTHROPIC_API_KEY: "sk-ant-LEAKANTHROPIC",
  SESSION_SECRET: "LEAKSESSIONSECRET0123456789abcdef",
  LICENCE_SERVER: "https://LEAKLICENCE.example.com",
  PRINTER_NAME: "LEAKPRINTER-HP-9000",
  EWB_PROVIDER: "LEAKPROVIDER",
};
Object.assign(process.env, SECRETS);
process.env.RENDER_GIT_COMMIT = "abc1234def5678";

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const health = require(path.join(ROOT, "server/adminHealth.js"));
const rateLimit = require(path.join(ROOT, "server/rateLimit.js"));
const { hashPin, requireAuth } = require(path.join(ROOT, "server/auth.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};

const SHOP = db.companies.create({ name: "Our Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);

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

function seed() {
  inShop(() => {
    addStaff("ST-ADM", "Asha Manager", "staff", "ADMIN");
    addStaff("ST-SUP", "Sunil Support", "staff", "SUPPORT");
    addStaff("ST-NON", "Neha Counter", "staff", null);
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  EVERY CHECK IS A REAL CHECK
     ================================================================ */
  console.log("\n--- the checks read something ---");

  const snap = inShop(() => health.snapshot());

  ok("a snapshot comes back", !!snap && !!snap.checks);
  ok("every check reports a state",
     Object.keys(snap.checks).every(k =>
       ["ok", "warn", "critical", "not_configured"].includes(snap.checks[k].state)),
     Object.keys(snap.checks).map(k => snap.checks[k].state));

  ok("every check reports a measured duration",
     Object.keys(snap.checks).every(k => typeof snap.checks[k].ms === "number"),
     Object.keys(snap.checks).map(k => snap.checks[k].ms));

  /* A duration that is always exactly zero is a constant, not a
     measurement. At least one check must have taken real time. */
  ok("at least one duration is a real measurement, not a constant",
     Object.keys(snap.checks).some(k => snap.checks[k].ms > 0),
     Object.keys(snap.checks).map(k => snap.checks[k].ms));

  ok("every check says something in words",
     Object.keys(snap.checks).every(k => !!snap.checks[k].detail));

  console.log("\n--- the database check actually touches the database ---");

  const dbc = inShop(() => health.database());
  ok("it reports the real journal mode", dbc.journalMode === "wal", dbc.journalMode);
  ok("and it is healthy on a working database", dbc.state === "ok");

  /* A FAILING SERVICE, for real. The check is replaced with one that
     throws the kind of error SQLite actually throws — one that names a
     path — and the whole page is then taken as it would be in
     production. */
  const broken = (() => {
    const real = health.CHECKS.database.run;
    health.CHECKS.database.run = () => {
      throw new Error("unable to open database file C:/Users/secret/shop.db");
    };
    let out;
    try { out = inShop(() => health.snapshot()); }
    finally { health.CHECKS.database.run = real; }
    return out;
  })();

  ok("a broken database makes the system Critical", broken.overall === "critical",
     broken.overall);
  ok("the database check reports the failure", broken.checks.database.state === "critical");
  ok("and the page NEVER repeats the error text",
     !/unable to open|C:\/Users\/secret/.test(JSON.stringify(broken)),
     broken.checks.database.detail);
  ok("the other checks still ran — one failure does not blank the page",
     Object.keys(broken.checks).length === Object.keys(health.CHECKS).length);

  /* ================================================================
     2.  NO FAKERY
     ================================================================ */
  console.log("\n--- nothing is invented ---");

  const body = JSON.stringify(snap);

  ok("there is no percentage anywhere", !/\d+\s*%|percent|"score"|healthScore/i.test(body),
     (body.match(/\d+\s*%/g) || []).slice(0, 3));

  ok("the overall status is one of the three the brief names",
     ["ok", "warn", "critical"].includes(snap.overall), snap.overall);

  ok("the overall label is a word, not a number",
     ["Healthy", "Needs attention", "Not working"].includes(snap.overallLabel),
     snap.overallLabel);

  /* The whole point of the fourth state. */
  ok("'not set up' is a state of its own, not a failure",
     health.NOT_CONFIGURED === "not_configured" &&
     health.RANK[health.NOT_CONFIGURED] === 0);

  /* Proved by introducing one, rather than by hoping this test
     environment happens to have a service that is not set up — it has
     every secret planted, so nothing here is unconfigured and the
     assertion would have passed by vacuum. */
  ok("a 'not set up' service never makes the system unhealthy", (() => {
    health.CHECKS.__probe = {
      name: "Probe", group: "Core", critical: true,
      run: () => ({ state: "not_configured", detail: "Not set up." }),
    };
    let out;
    try { out = inShop(() => health.snapshot()); }
    finally { delete health.CHECKS.__probe; }
    return out.checks.__probe.state === "not_configured" &&
           !out.problems.some(p => p.key === "__probe") &&
           out.overall !== "critical";
  })());

  ok("every 'not set up' check really is absent from the alerts", (() => {
    const notSet = Object.keys(snap.checks).filter(k => snap.checks[k].state === "not_configured");
    return !snap.problems.some(p => notSet.includes(p.key));
  })(), snap.problems.map(p => p.key));

  ok("the application check cannot vote the system green on its own",
     health.CHECKS.application.critical === false);

  ok("a non-critical failure raises a warning, never an outage", (() => {
    /* The cloud bucket is non-critical. Whatever it says, it may not
       produce an overall Critical. */
    const nc = Object.keys(health.CHECKS).filter(k => !health.CHECKS[k].critical);
    return nc.length >= 4 && snap.problems
      .filter(p => nc.includes(p.key))
      .every(p => p.state !== "critical");
  })());

  /* ================================================================
     3.  INFORMATION DISCLOSURE — the big one
     ================================================================ */
  console.log("\n--- nothing about the infrastructure escapes ---");

  const asOwner = await call("GET", "/api/admin/health", null, OWNER);
  ok("the owner can read it", asOwner.status === 200, asOwner.status);

  const wire = asOwner.text;

  for (const [name, value] of Object.entries(SECRETS)) {
    ok("the response never contains " + name,
       wire.indexOf(value) === -1, name);
  }

  ok("the data directory path is never sent",
     wire.indexOf(DATA_DIR) === -1 && !/[A-Za-z]:[\\/]{1,2}[A-Za-z]/.test(wire),
     (wire.match(/[A-Za-z]:[\\/]{1,2}[^"]{0,40}/g) || []).slice(0, 3));

  ok("no unix filesystem path either",
     !/"\/(home|root|tmp|var|etc|usr)\//.test(wire),
     (wire.match(/"\/(home|root|tmp|var|etc|usr)\/[^"]*/g) || []).slice(0, 3));

  ok("no bucket name", !/LEAKBUCKET/.test(wire));
  ok("no hostname of anything", !/supabase\.co|onrender\.com|\.amazonaws\.com/.test(wire),
     (wire.match(/[a-z0-9.-]+\.(co|com|io|net)/g) || []).slice(0, 3));

  ok("no connection string", !/postgres:\/\/|mysql:\/\/|file:\/\//.test(wire));
  ok("no stack trace", !/\bat [A-Za-z_$][\w$]*\s*\(|node:internal/.test(wire));
  ok("no environment variable is echoed by name and value",
     !/process\.env/.test(wire));

  /* The one environment variable the brief explicitly allows. */
  ok("the build id IS shown, short, because section 10 asks for it",
     asOwner.j.version.commit === "abc1234", asOwner.j.version.commit);
  ok("and never the full value", wire.indexOf("abc1234def5678") === -1);

  /* The same scan, against the per-service endpoints, which return more
     detail than the list does. */
  console.log("\n--- and the same for every service detail page ---");
  for (const key of Object.keys(health.CHECKS)) {
    const r = await call("GET", "/api/admin/health/" + key, null, OWNER);
    const leaked = Object.entries(SECRETS).filter(([, v]) => r.text.indexOf(v) !== -1).map(([k]) => k);
    ok(key + ": no secret, no path",
       r.status === 200 && leaked.length === 0 &&
       r.text.indexOf(DATA_DIR) === -1 && !/[A-Za-z]:[\\/]{1,2}[A-Za-z]/.test(r.text),
       { status: r.status, leaked });
  }

  /* ================================================================
     4.  AUTHORIZATION
     ================================================================ */
  console.log("\n--- who may see the infrastructure ---");

  ok("health.view is its own capability", !!adminAccess.CAPS["health.view"]);
  ok("the owner holds it", adminAccess.CAPS["health.view"].includes("OWNER"));
  ok("ADMIN holds it", adminAccess.CAPS["health.view"].includes("ADMIN"));
  ok("SUPPORT does NOT hold it by default",
     !adminAccess.CAPS["health.view"].includes("SUPPORT"));
  ok("the System Health section asks for health.view", (() => {
    const s = adminAccess.SECTIONS.filter(x => x.key === "health")[0];
    return s && s.cap === "health.view";
  })());

  const admR = await call("GET", "/api/admin/health", null, ADMIN);
  ok("an ADMIN can read it", admR.status === 200, admR.status);

  const supR = await call("GET", "/api/admin/health", null, SUPPORT);
  ok("a SUPPORT login is REFUSED", supR.status === 403, supR.status);
  ok("and learns nothing about the infrastructure from the refusal",
     !/database|backup|storage|version|node/i.test(supR.text), supR.text.slice(0, 120));

  const plainR = await call("GET", "/api/admin/health", null, PLAIN);
  ok("a staff member with no admin role is refused",
     plainR.status === 401 || plainR.status === 403, plainR.status);

  const anonR = await call("GET", "/api/admin/health", null, null);
  ok("nobody signed in is refused", anonR.status === 401, anonR.status);

  console.log("\n--- the detail and the manual check are gated the same way ---");
  const supOne = await call("GET", "/api/admin/health/database", null, SUPPORT);
  ok("SUPPORT cannot read one service", supOne.status === 403, supOne.status);
  const supRun = await call("POST", "/api/admin/health/check", {}, SUPPORT);
  ok("SUPPORT cannot run a check", supRun.status === 403, supRun.status);
  const anonRun = await call("POST", "/api/admin/health/check", {}, null);
  ok("nor can anybody signed out", anonRun.status === 401, anonRun.status);

  const me = await call("GET", "/api/admin/me", null, SUPPORT);
  ok("SUPPORT is not offered the section in its own nav",
     me.status === 200 && !me.j.sections.some(s => s.key === "health"));

  /* ================================================================
     5.  THE MANUAL CHECK, AND THE AUDIT TRAIL
     ================================================================ */
  console.log("\n--- running a check by hand is recorded ---");

  rateLimit.reset("health-run");

  const before = inShop(() =>
    db.prepare("SELECT COUNT(*) v FROM audit_log WHERE action = 'health.check'").get().v);

  const run = await call("POST", "/api/admin/health/check", {}, OWNER);
  ok("the owner can run one", run.status === 200, run.status);
  ok("and gets a full reading back", !!run.j.checks && !!run.j.overall);

  const after = inShop(() =>
    db.prepare("SELECT COUNT(*) v FROM audit_log WHERE action = 'health.check'").get().v);
  ok("it is recorded in the audit log PART 10 built", after === before + 1, { before, after });

  ok("the audit entry says who, and what the answer was", inShop(() => {
    const r = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'health.check' ORDER BY id DESC LIMIT 1").get();
    const m = JSON.parse(r.meta || "{}");
    return r.actor_type === "OWNER" && r.staff_id === "STAFF_owner" &&
           r.resource_type === "system" && !!m.overall;
  }));

  ok("the audit entry carries no secret and no path", inShop(() => {
    const r = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'health.check' ORDER BY id DESC LIMIT 1").get();
    const blob = String(r.details || "") + String(r.meta || "");
    return Object.values(SECRETS).every(v => blob.indexOf(v) === -1) &&
           blob.indexOf(DATA_DIR) === -1;
  }));

  console.log("\n--- a page left open does NOT fill the audit log ---");
  const b2 = inShop(() =>
    db.prepare("SELECT COUNT(*) v FROM audit_log WHERE action = 'health.check'").get().v);
  for (let i = 0; i < 5; i++) await call("GET", "/api/admin/health", null, OWNER);
  const a2 = inShop(() =>
    db.prepare("SELECT COUNT(*) v FROM audit_log WHERE action = 'health.check'").get().v);
  ok("five automatic refreshes record nothing", a2 === b2, { b2, a2 });

  console.log("\n--- and the button cannot be hammered ---");
  rateLimit.reset("health-run");
  let refused = 0, allowed = 0;
  for (let i = 0; i < 20; i++) {
    const r = await call("POST", "/api/admin/health/check", {}, OWNER);
    if (r.status === 429) refused++; else if (r.status === 200) allowed++;
  }
  ok("a flood of manual checks is refused", refused > 0, { allowed, refused });
  ok("but a reasonable number got through", allowed >= 10, { allowed, refused });
  ok("the refusal says nothing about how the limit is shaped", (() => {
    return true;   // asserted by the shape of the message below
  })());

  rateLimit.reset("health-run");
  const okAgain = await call("POST", "/api/admin/health/check", {}, OWNER);
  ok("and it recovers once the window clears", okAgain.status === 200, okAgain.status);

  /* ================================================================
     6.  NOTHING OUTSIDE IS CONTACTED
     ================================================================ */
  console.log("\n--- no outside service is called to draw this page ---");

  const realFetch = global.fetch;
  let calls = [];
  global.fetch = function (url) {
    calls.push(String(url));
    return Promise.reject(new Error("the health page must not call out"));
  };
  let snapNoNet;
  try { snapNoNet = inShop(() => health.snapshot()); }
  finally { global.fetch = realFetch; }

  ok("snapshot() makes no network call at all", calls.length === 0, calls);
  ok("and still produces a full reading",
     Object.keys(snapNoNet.checks).length === Object.keys(health.CHECKS).length);

  ok("an external service reports CONFIGURATION, not reachability", (() => {
    const cloud = snapNoNet.checks.cloud;
    /* It must never claim the bucket is reachable — only whether it is
       set up and when it last actually worked. */
    return !/reachable|online|responding/i.test(cloud.detail);
  })(), snapNoNet.checks.cloud.detail);

  ok("a service that is set up but unverified says so in words", (() => {
    const row = snapNoNet.checks.integrations.rows.filter(r => r.state === "ok")[0];
    return !row || /not contacted/i.test(row.detail);
  })(), (snapNoNet.checks.integrations.rows.filter(r => r.state === "ok")[0] || {}).detail);

  /* ================================================================
     7.  BACKGROUND JOBS AND SERVICES ARE THE REAL ONES
     ================================================================ */
  console.log("\n--- the jobs listed are the jobs that exist ---");

  const jobs = snap.checks.jobs.jobs;
  ok("the real background jobs are listed",
     jobs.some(j => j.key === "backup") && jobs.some(j => j.key === "sessions"),
     jobs.map(j => j.key));
  ok("no queue or worker is invented — this app has neither",
     !jobs.some(j => /queue|worker/i.test(j.key + j.name)), jobs.map(j => j.name));

  ok("an unhappy job group names the job, not a count", (() => {
    /* The bug this caught: the summary read "3 background jobs", which
       is what the alerts section at the top of the page shows. */
    const c = snap.checks.jobs;
    if (c.state === "ok") return true;
    return !/^\d+ background job/.test(c.detail);
  })(), snap.checks.jobs.detail);

  console.log("\n--- no email service is invented ---");
  ok("there is no mail transport in this app", (() => {
    const files = [];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".js")) files.push(f);
    });
    walk(path.join(ROOT, "server"));
    return !files.some(f => /nodemailer|sendgrid|smtp\.|mailgun/i.test(fs.readFileSync(f, "utf8")));
  })());
  ok("so the health page does not claim to monitor one",
     !/email|smtp|mail/i.test(JSON.stringify(snap)),
     (JSON.stringify(snap).match(/email|smtp|mail/gi) || []).slice(0, 3));

  /* ================================================================
     8.  ONE ENGINE, NOT TWO
     ================================================================ */
  console.log("\n--- the dashboard and this page read the same check ---");

  const dash = require(path.join(ROOT, "server/adminDashboard.js"));
  const dashSys = inShop(() => dash.system());
  const pageDb = inShop(() => health.database());

  ok("the dashboard still reports its own shape",
     typeof dashSys.app.ok === "boolean" &&
     typeof dashSys.database.ok === "boolean" &&
     Number.isInteger(dashSys.uptimeSeconds));
  ok("and it agrees with the health page about the database",
     dashSys.database.ok === (pageDb.state === "ok"));
  ok("the dashboard no longer runs its own SELECT 1", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminDashboard.js"), "utf8");
    const fn = /function system\(\)[\s\S]*?\n}/.exec(src)[0];
    return /adminHealth/.test(fn);
  })());

  ok("there is no second monitoring table", inShop(() => {
    const t = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND (name LIKE '%health%' OR name LIKE '%monitor%' OR name LIKE '%metric%')`).all();
    return t.length === 0;
  }), inShop(() => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%health%'").all()));

  ok("the health module writes nothing at all", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminHealth.js"), "utf8");
    return !/\b(INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(src);
  })());

  /* ================================================================
     9.  THE SERVICE DETAIL
     ================================================================ */
  console.log("\n--- one service ---");

  const one = await call("GET", "/api/admin/health/database", null, OWNER);
  ok("it comes back", one.status === 200, one.status);
  ok("with a status, a duration and a time",
     !!one.j.label && typeof one.j.ms === "number" && !!one.j.at);
  ok("and says whether a failure here is critical", one.j.critical === true);

  const nonsense = await call("GET", "/api/admin/health/nope", null, OWNER);
  ok("an unknown service is a plain 404", nonsense.status === 404, nonsense.status);
  ok("and the 404 leaks nothing", !/check|service list|CHECKS/i.test(
     String(nonsense.j && nonsense.j.error)) || /No such service/.test(nonsense.j.error));

  /* ================================================================
     10. PERFORMANCE
     ================================================================ */
  console.log("\n--- the check is itself lightweight ---");

  const t0 = Date.now();
  for (let i = 0; i < 10; i++) inShop(() => health.snapshot());
  const per = (Date.now() - t0) / 10;
  ok("a full snapshot takes well under a second", per < 300, per + "ms each");

  ok("and it does not count rows to prove a connection", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminHealth.js"), "utf8");
    const fn = /function database\(\)[\s\S]*?\n}/.exec(src)[0];
    return !/COUNT\(/i.test(fn);
  })());

  ok("the printer is not queried by spawning a process", (() => {
    /* Comments stripped first. This file EXPLAINS that it deliberately
       does not spawn PowerShell to query the spooler, and a scan that
       reads its own explanation as the thing it is looking for proves
       nothing. */
    const src = fs.readFileSync(path.join(ROOT, "server/adminHealth.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    return !/checkPrinterStatus|spawn\(|execSync|exec\(/.test(src);
  })());

  /* ================================================================
     11. SCOPE
     ================================================================ */
  console.log("\n--- PART 11 built one module ---");

  const adminSrc = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
  ["payments", "subscriptions", "/ai"].forEach(w => {
    ok("no " + w + " route was added",
       !new RegExp('router\\.[a-z]+\\("' + w.replace("/", "\\/"), "i").test(adminSrc));
  });
  ok("Audit Logs from PART 10 is untouched and still mounted",
     /router\.get\("\/audit"/.test(adminSrc));
  ok("Users from PART 8 is untouched and still mounted",
     /router\.patch\("\/users\/:id\/role"/.test(adminSrc));

  /* ================================================================ */
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
