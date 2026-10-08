/* ============================================================
   ADMIN PANEL — PART 1, the foundation

   Four claims are being made, and the last two are the ones that would
   actually hurt if they were wrong.

     1. The shell exists: a page at /admin, a sidebar built from a
        server-side table, placeholder sections and nothing else.

     2. Nothing in the shop app was changed. Asserted against git, not
        by reading the diff and believing it.

     3. The panel is shut to anyone who is not the owner, and shutting it
        does not depend on the browser hiding a link. An anonymous
        visitor asking for the page by hand is turned away by the server,
        and so is every API call.

     4. The page will actually run in a browser. Two ways this shell
        could be shipped broken while every other test passed:

          a. The server sends Content-Security-Policy with
             script-src 'self' and NO 'unsafe-inline'. An inline
             <script> or an onclick= would be silently blocked and the
             panel would load as a dead frame.

          b. A class used in the markup that no stylesheet defines. That
             is not hypothetical in this codebase — .inv-flex is used 94
             times in the shop app and has never been defined anywhere.
             So every class this page names is checked against the two
             stylesheets it actually loads.

   The real router is mounted with the real gate on a scratch database,
   and the real server is booted on a spare port for the anonymous case.

   Run:  node test/admin.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync, spawn } = require("child_process");

const DATA_DIR = path.join(os.tmpdir(), "sm-admin-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const { requireAuth } = require(path.join(ROOT, "server/auth.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

/* Several checks below are keyword sweeps — "is there a <main>", "is
   there a gradient", "does this file run a DELETE". Run against the raw
   file they all trip over the COMMENTS, which say at length what the
   file deliberately does not do. So the sweeps run against code with
   the prose taken out; the prose is checked separately where it matters.
   Replaced with a space rather than removed, so two tokens either side
   of a stripped comment cannot be glued into a third. */
const code = p => read(p)
  .replace(/<!--[\s\S]*?-->/g, " ")        /* html */
  .replace(/\/\*[\s\S]*?\*\//g, " ")       /* css and js block */
  .replace(/^\s*\/\/.*$/gm, " ");          /* js line */

const CO = db.companies.create({ name: "Admin Panel Test" });

/* ------------------------------------------------------------------
   Who is asking. The real mount: requireAuth, then the real gate.
   ------------------------------------------------------------------ */
let WHO = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = WHO ? { loggedIn: true, ...WHO } : {};
  db.companies.runAs(CO.id, next);
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

const OWNER   = { role: "owner", staffId: "ST-OWNER", staffName: "Owner" };
const STAFF   = { role: "staff", staffId: "ST-A", staffName: "Counter" };
const PREVIEW = { role: "owner", staffId: "ST-OWNER", staffName: "Owner", previewStaffId: "ST-A" };

(async () => {
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  THE ACCESS MODULE — the only place a permission is decided
     ================================================================ */
  console.log("\n--- adminAccess: who holds a role ---");

  ok("an owner is OWNER", adminAccess.roleOf({ session: { loggedIn: true, role: "owner" } }) === "OWNER");
  ok("a staff member holds no admin role",
     adminAccess.roleOf({ session: { loggedIn: true, role: "staff" } }) === null);
  ok("a logged-out session holds no admin role",
     adminAccess.roleOf({ session: { role: "owner" } }) === null);
  ok("no session at all holds no admin role", adminAccess.roleOf({}) === null);
  ok("a null request holds no admin role", adminAccess.roleOf(null) === null);
  ok("an owner PREVIEWING a staff member holds no admin role",
     adminAccess.roleOf({ session: { loggedIn: true, role: "owner", previewStaffId: "ST-A" } }) === null);

  console.log("\n--- adminAccess: capabilities ---");
  const ownerReq = { session: { loggedIn: true, role: "owner" } };
  const staffReq = { session: { loggedIn: true, role: "staff" } };

  ok("owner holds admin.manage", adminAccess.can(ownerReq, "admin.manage") === true);
  ok("owner holds security.view", adminAccess.can(ownerReq, "security.view") === true);
  ok("owner holds business.view", adminAccess.can(ownerReq, "business.view") === true);
  ok("staff holds nothing", Object.keys(adminAccess.CAPS)
     .every(c => adminAccess.can(staffReq, c) === false));
  ok("an UNKNOWN capability is refused, not allowed",
     adminAccess.can(ownerReq, "nonsense.view") === false);
  ok("an empty capability is refused", adminAccess.can(ownerReq, "") === false);
  ok("a capability on a null request is refused", adminAccess.can(null, "admin.manage") === false);

  console.log("\n--- adminAccess: the nav table is also the permission table ---");
  ok("three roles are declared",
     adminAccess.ADMIN_ROLES.join(",") === "OWNER,ADMIN,SUPPORT", adminAccess.ADMIN_ROLES);
  ok("every section names a capability that exists in CAPS",
     adminAccess.SECTIONS.every(s => Object.prototype.hasOwnProperty.call(adminAccess.CAPS, s.cap)),
     adminAccess.SECTIONS.filter(s => !adminAccess.CAPS[s.cap]).map(s => s.key));
  ok("every capability in CAPS grants only declared roles",
     Object.values(adminAccess.CAPS).every(rs => rs.every(r => adminAccess.ADMIN_ROLES.includes(r))));
  ok("every section sits in a declared group",
     adminAccess.SECTIONS.every(s => adminAccess.GROUPS.includes(s.group)),
     adminAccess.SECTIONS.filter(s => !adminAccess.GROUPS.includes(s.group)).map(s => s.group));
  ok("section keys are unique",
     new Set(adminAccess.SECTIONS.map(s => s.key)).size === adminAccess.SECTIONS.length);
  ok("every declared group actually has a section",
     adminAccess.GROUPS.every(g => adminAccess.SECTIONS.some(s => s.group === g)));

  /* The nav the brief asked for, item by item, so a rename cannot slip
     through unnoticed. */
  const WANT = {
    Overview: ["Dashboard"],
    Business: ["Customers", "Products", "Inventory", "Sales", "Invoices", "Payments"],
    AI: ["AI Assistant", "AI Employees", "AI Activity"],
    Administration: ["Plans & Features", "Users", "Roles & Permissions", "Settings"],
    Security: ["Security Center", "Audit Logs", "System Health"],
  };
  ok("the groups are the five asked for, in order",
     adminAccess.GROUPS.join("|") === Object.keys(WANT).join("|"), adminAccess.GROUPS);
  Object.keys(WANT).forEach(g => {
    const got = adminAccess.SECTIONS.filter(s => s.group === g).map(s => s.label);
    ok("group " + g + " holds exactly its sections", got.join("|") === WANT[g].join("|"), got);
  });
  ok("seventeen sections in total", adminAccess.SECTIONS.length === 17, adminAccess.SECTIONS.length);

  console.log("\n--- adminAccess: what each caller sees ---");
  ok("an owner sees all seventeen", adminAccess.sectionsFor(ownerReq).length === 17);
  ok("a staff member sees none", adminAccess.sectionsFor(staffReq).length === 0);
  ok("an owner in preview sees none",
     adminAccess.sectionsFor({ session: { loggedIn: true, role: "owner", previewStaffId: "X" } }).length === 0);
  ok("a section's href is its key, hash-routed",
     adminAccess.sectionsFor(ownerReq).every(s => s.href === "#/" + s.key));
  ok("a section carries no capability out to the browser",
     adminAccess.sectionsFor(ownerReq).every(s => s.cap === undefined));
  ok("groups are empty when sections are",
     adminAccess.groupsFor(staffReq).length === 0);

  /* ================================================================
     2.  THE API — the real router behind the real gate
     ================================================================ */
  console.log("\n--- /api/admin: the gate ---");

  let r = await call("GET", "/api/admin/me", null, null);
  ok("logged out: /me is 401", r.status === 401, r.status);
  ok("logged out: nothing is leaked in the body", !r.text.includes("Dashboard"), r.text.slice(0, 80));

  r = await call("GET", "/api/admin/me", null, STAFF);
  ok("staff: /me is 403", r.status === 403, r.status);
  ok("staff: no section list comes back", !r.text.includes("Dashboard"), r.text.slice(0, 80));
  ok("staff: the refusal is plain and gives nothing away",
     /don't have access/i.test(r.text) && !/pin|hash|staff_id/i.test(r.text),
     r.text.slice(0, 80));

  r = await call("GET", "/api/admin/me", null, PREVIEW);
  ok("owner in preview: /me is 403", r.status === 403, r.status);

  r = await call("GET", "/api/admin/me", null, OWNER);
  ok("owner: /me is 200", r.status === 200, r.status);
  ok("owner: role is OWNER", r.j && r.j.role === "OWNER", r.j && r.j.role);
  ok("owner: seventeen sections", r.j && r.j.sections.length === 17, r.j && r.j.sections.length);
  ok("owner: five groups", r.j && r.j.groups.length === 5, r.j && r.j.groups);
  ok("owner: every section has key, label, group and href",
     r.j.sections.every(s => s.key && s.label && s.group && s.href));
  ok("owner: previewing is false", r.j.previewing === false, r.j.previewing);
  ok("owner: the staff name comes back", r.j.staffName === "Owner", r.j.staffName);

  console.log("\n--- /api/admin: /me leaks no configuration ---");
  const body = JSON.stringify(r.j);
  ["sync_cloud_key", "sync_accept_hash", "pin_hash", "licence", "SESSION_SECRET",
   "DATA_DIR", "password", "api_key", "apiKey", "secret"].forEach(bad => {
    ok("/me does not mention " + bad, !body.toLowerCase().includes(bad.toLowerCase()));
  });
  ok("/me returns no file path", !/[A-Za-z]:\\|\/home\/|\/tmp\//.test(body));

  console.log("\n--- /api/admin/roles: owner-only, and describes the shape only ---");
  r = await call("GET", "/api/admin/roles", null, STAFF);
  ok("staff: /roles is 403", r.status === 403, r.status);
  r = await call("GET", "/api/admin/roles", null, OWNER);
  ok("owner: /roles is 200", r.status === 200, r.status);
  ok("/roles lists the three roles", r.j && r.j.roles.length === 3, r.j && r.j.roles);
  ok("/roles says only OWNER is live today",
     r.j && r.j.active.length === 1 && r.j.active[0] === "OWNER", r.j && r.j.active);

  console.log("\n--- /api/admin: nothing else is mounted in PART 1 ---");
  for (const p of ["/api/admin/", "/api/admin/settings", "/api/admin/health"]) {
    r = await call("GET", p, null, OWNER);
    ok("GET " + p + " is not a route yet", r.status === 404, r.status);
  }
  for (const m of ["POST", "PUT", "DELETE"]) {
    r = await call(m, "/api/admin/me", null, OWNER);
    ok(m + " /me is not a route (the shell writes nothing)", r.status === 404, r.status);
  }

  srv.close();

  /* ================================================================
     3.  THE PAGE ROUTE — the real server, no session at all

        The security-critical half, and it needs no PIN: an anonymous
        visitor typing /admin must be turned away by the server, not by
        a hidden link.
     ================================================================ */
  console.log("\n--- GET /admin on the real server, anonymous ---");

  /* A staff member, in the DEFAULT company the booted server will open —
     not the scratch company the router tests used. Test credentials, in a
     temp database, for a server on localhost. */
  const { hashPin } = require(path.join(ROOT, "server/auth.js"));
  db.companies.runAs(db.companies.defaultId(), () => {
    db.prepare("INSERT OR REPLACE INTO staff (id,name,pin_hash,role,active,created_at) VALUES (?,?,?,?,1,?)")
      .run("ST-COUNTER", "Counter Staff", hashPin("7391"), "staff", Date.now());
  });

  /* A port the operating system says is free, rather than a number picked
     by hand: a hard-coded one that something else already holds would
     quietly test THAT server instead of the one booted here, and every
     assertion below would still pass. */
  const PORT = await new Promise((resolve, reject) => {
    const probe = require("net").createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const boot = spawn(process.execPath, ["--no-warnings", "server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  boot.stdout.on("data", d => { bootLog += d; });
  boot.stderr.on("data", d => { bootLog += d; });

  const up = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch("http://127.0.0.1:" + PORT + "/", { redirect: "manual" });
        if (res.status) return true;
      } catch (e) { /* not listening yet */ }
      await new Promise(f => setTimeout(f, 500));
    }
    return false;
  })();

  if (!up) {
    ok("the server came up", false, bootLog.slice(-600));
  } else {
    const hit = (p) => fetch("http://127.0.0.1:" + PORT + p, { redirect: "manual" });

    let res = await hit("/admin");
    ok("anonymous GET /admin is a redirect, not the page",
       res.status === 302, res.status);
    ok("anonymous GET /admin redirects to the login screen",
       res.headers.get("location") === "/", res.headers.get("location"));
    const t = await res.text();
    ok("anonymous GET /admin sends no admin markup",
       !t.includes("adm-shell") && !t.includes("Admin Control Centre"), t.slice(0, 120));

    res = await hit("/admin.html");
    ok("/admin.html redirects to /admin", res.status === 302 &&
       res.headers.get("location") === "/admin", res.status + " " + res.headers.get("location"));
    const t2 = await res.text();
    ok("/admin.html never serves the raw file",
       !t2.includes("adm-shell"), t2.slice(0, 120));

    res = await hit("/api/admin/me");
    ok("anonymous /api/admin/me is 401", res.status === 401, res.status);

    /* The shop app is still served, and still served the same way. */
    res = await hit("/");
    ok("the shop app still answers on /", res.status === 200, res.status);
    ok("the shop app still sends Cache-Control: no-store",
       res.headers.get("cache-control") === "no-store", res.headers.get("cache-control"));
    const home = await res.text();
    ok("the shop app still gets its ?v= cache-busting",
       /\/js\/app\.js\?v=\d+/.test(home));
    ok("the shop app page is unchanged — no admin markup in it",
       !home.includes("adm-shell"));

    /* CSP is what makes the inline-script rule below load-bearing. */
    const csp = res.headers.get("content-security-policy") || "";
    ok("CSP still has script-src 'self'", /script-src 'self'/.test(csp), csp.slice(0, 120));
    ok("CSP still has NO 'unsafe-inline' for scripts",
       !/script-src[^;]*unsafe-inline/.test(csp), csp.slice(0, 160));

    /* The two new static files are reachable and versioned. */
    res = await hit("/css/admin.css");
    ok("/css/admin.css is served", res.status === 200, res.status);
    res = await hit("/js/admin.js");
    ok("/js/admin.js is served", res.status === 200, res.status);

    /* ---------------------------------------------------------------
       A REAL STAFF SESSION asking for the panel by hand.

       This is the claim worth proving end to end rather than only in
       unit form: the panel is shut by the server, not by the browser
       declining to draw a link. So: log in for real, keep the cookie,
       and then type the URL.
       --------------------------------------------------------------- */
    console.log("\n--- a logged-in staff member reaches for /admin ---");

    const login = await fetch("http://127.0.0.1:" + PORT + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "ST-COUNTER", pin: "7391" }),
    });
    const cookie = (login.headers.getSetCookie
      ? login.headers.getSetCookie()
      : [login.headers.get("set-cookie") || ""]).map(c => c.split(";")[0]).join("; ");
    ok("the staff member is logged in", login.status === 200, login.status);
    ok("a session cookie came back", /connect\.sid|sid=/.test(cookie), cookie.slice(0, 30));

    const asStaff = (p) => fetch("http://127.0.0.1:" + PORT + p,
      { headers: { cookie }, redirect: "manual" });

    res = await asStaff("/");
    ok("the staff member can still use the shop app", res.status === 200, res.status);

    res = await asStaff("/admin");
    ok("staff GET /admin is turned away by the server", res.status === 302, res.status);
    ok("staff GET /admin redirects to the app, not the panel",
       res.headers.get("location") === "/", res.headers.get("location"));
    const staffPage = await res.text();
    ok("staff GET /admin sends no admin markup", !staffPage.includes("adm-shell"));

    res = await asStaff("/api/admin/me");
    ok("staff /api/admin/me is 403", res.status === 403, res.status);
    const staffApi = await res.text();
    ok("staff /api/admin/me leaks no section list", !staffApi.includes("Dashboard"), staffApi.slice(0, 80));

    res = await asStaff("/api/admin/roles");
    ok("staff /api/admin/roles is 403", res.status === 403, res.status);

    /* The static files are readable by anyone — which is fine, and worth
       stating: they carry no data and no secrets, only layout. */
    res = await asStaff("/js/admin.js");
    ok("admin.js is readable by staff, and that is harmless", res.status === 200, res.status);
    const adminJsServed = await res.text();
    ok("it carries no SQL", !/SELECT\s+\w+\s+FROM/i.test(adminJsServed));
    ok("it carries no key, token or password literal",
       !/(secret|token|password|api[_-]?key|pin)\s*[:=]\s*["'][^"']+["']/i.test(adminJsServed));
    ok("it carries no long hex or base64 literal that could be a credential",
       !/["'][A-Za-z0-9+/=]{32,}["']/.test(adminJsServed));

    boot.kill();
    await new Promise(f => setTimeout(f, 300));
  }

  /* ================================================================
     4.  THE PAGE ITSELF — would it run?
     ================================================================ */
  console.log("\n--- admin.html: content-security-policy survivability ---");
  const html = read("public/admin.html");
  const js = read("public/js/admin.js");
  const css = read("public/css/admin.css");
  const htmlCode = code("public/admin.html");
  const jsCode = code("public/js/admin.js");
  const cssCode = code("public/css/admin.css");

  ok("no inline <script> block", !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
  ok("no on*= handler attribute", !/\son[a-z]+\s*=/i.test(html));
  ok("no javascript: URL", !/javascript:/i.test(html));
  ok("the only scripts are /js/boot.js and /js/admin.js",
     (html.match(/<script[^>]*src="([^"]+)"/g) || []).join(",") ===
     '<script src="/js/boot.js",<script src="/js/admin.js"',
     (html.match(/<script[^>]*src="([^"]+)"/g) || []));
  ok("admin.js adds no inline style or script of its own",
     !/document\.write|new Function|eval\(/.test(js));
  ok("admin.js attaches handlers with addEventListener only",
     /addEventListener/.test(js) && !/\.onclick\s*=/.test(js));

  console.log("\n--- admin.html: it does not inherit the shop app's shell ---");
  ok("style.css is linked BEFORE admin.css",
     html.indexOf('/css/style.css') < html.indexOf('/css/admin.css') &&
     html.includes('/css/admin.css'));
  ["<main", 'id="shell"', 'class="screen', "nav class=\"bottom", "fullscreen"].forEach(bad => {
    ok("no " + bad.replace(/[<"]/g, "") + " on the page", !htmlCode.includes(bad));
  });
  ok("the page says IN WRITING why it avoids <main>", /Deliberately not <main>/.test(html));
  ok("#toast IS reused (a centred capped toast is right here too)",
     html.includes('id="toast"'));
  ok(".scrim IS reused for the drawer", html.includes('class="scrim"'));

  console.log("\n--- admin.css: theme and token discipline ---");
  ok("no html[data-theme] selector — navy-gold has no attribute at all",
     !/data-theme/.test(cssCode));
  ok("and the file says so in writing, so nobody adds one later",
     /data-theme/.test(css));
  ok("body gets an explicit background", /body\.adm-body\{[^}]*background:/.test(css));
  ok("admin-only tokens sit on .adm-shell, never :root",
     !/^\s*:root\s*\{/m.test(css) && /\.adm-shell\{[^}]*--adm-sidebar-bg:/.test(css));
  ok("the three device breakpoints are the app's own",
     (css.match(/@media \(min-width: (768|1024|1440)px\)/g) || []).length === 3,
     (css.match(/@media \(min-width: \d+px\)/g) || []));
  ok("no breakpoint the app does not already use",
     !/@media \(min-width: (?!768px|1024px|1440px)\d+px\)/.test(css));

  /* The burnt-orange budget the brief set: an indicator, one action, a dot. */
  const accentUses = (css.match(/var\(--adm-accent\)/g) || []).length;
  const accentBg = (css.match(/background:\s*var\(--adm-accent\)/g) || []).length;
  /* A budget, not a ban. Each of these is a few pixels — an indicator, a
     dot, or the one primary button on a page. The rule being enforced is
     that the accent never becomes a FILL: no panel, tile, card, row,
     header or sidebar may take it as a background. */
  ok("the accent is a background in exactly four small places",
     accentBg === 4, accentBg);
  const accentBgSelectors = (cssCode.match(/([^{}]+)\{[^}]*background:\s*var\(--adm-accent\)[^}]*\}/g) || [])
    .map(s => s.slice(0, s.indexOf("{")).trim());
  ok("and every one of them is an indicator, a dot or the primary button",
     accentBgSelectors.length === 4 &&
     accentBgSelectors.every(s => /adm-nav-item\.is-active::before|adm-primary|adm-dot|adm-pip\.is-warn/.test(s)),
     accentBgSelectors);
  ok("the accent is never a background on a panel, tile, card or row",
     !/\.adm-(panel|tile|card|row|topbar|sidebar|main)[^{]*\{[^}]*background:\s*var\(--adm-accent\)/.test(cssCode));
  ok("the accent is never a gradient", !/gradient/.test(cssCode));
  ok("the accent is used (indicator, action, dot, and focus rings)", accentUses >= 3, accentUses);
  ok("no oversized radius — the app's own card radius is reused",
     /border-radius:\s*var\(--card-radius\)/.test(css) && !/border-radius:\s*(2[4-9]|[3-9]\d)px/.test(css));

  console.log("\n--- every token this page reads is actually defined ---");
  const styleCss = read("public/css/style.css");
  const defined = new Set();
  (styleCss + css).replace(/(--[a-zA-Z0-9-]+)\s*:/g, (m, t) => { defined.add(t); return m; });
  const usedTokens = [...new Set((css.match(/var\((--[a-zA-Z0-9-]+)/g) || [])
    .map(s => s.slice(4)))];
  const missingTokens = usedTokens.filter(t => !defined.has(t));
  ok("admin.css reads no undefined custom property",
     missingTokens.length === 0, missingTokens);
  ok("it reads real app tokens rather than redeclaring them",
     usedTokens.filter(t => !t.startsWith("--adm-")).length >= 10,
     usedTokens.filter(t => !t.startsWith("--adm-")).length);

  console.log("\n--- every class the page names is actually defined ---");
  /* The .inv-flex lesson: 94 uses in the shop app, defined nowhere. */
  const classSelectors = new Set();
  (styleCss + css).replace(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g, (m, c) => { classSelectors.add(c); return m; });

  const htmlClasses = new Set();
  (html.match(/class="([^"]+)"/g) || []).forEach(m => {
    m.slice(7, -1).split(/\s+/).filter(Boolean).forEach(c => htmlClasses.add(c));
  });
  /* The classes admin.js creates at runtime, which never appear in the markup. */
  ["adm-nav-group", "adm-nav-item", "adm-nav-ic", "adm-nav-label", "adm-section-label",
   "adm-page-head", "adm-page-head-text", "adm-page-title", "adm-page-sub",
   "adm-card", "adm-placeholder", "adm-placeholder-row", "adm-dot", "adm-meta",
   "is-active", "is-collapsed", "is-drawer-open", "ok", "show"].forEach(c => htmlClasses.add(c));

  const missingClasses = [...htmlClasses].filter(c => !classSelectors.has(c));
  ok("no class is used without a rule somewhere",
     missingClasses.length === 0, missingClasses);

  /* And the other direction, for the runtime ones specifically. */
  const jsClasses = [...new Set(
    (js.match(/className = "([^"]+)"|classList\.(?:add|toggle|remove)\("([^"]+)"/g) || [])
      .map(m => m.replace(/.*"([^"]+)".*/, "$1"))
  )].flatMap(s => s.split(/\s+/)).filter(Boolean);
  const missingJsClasses = jsClasses.filter(c => !classSelectors.has(c));
  ok("every class admin.js sets has a rule", missingJsClasses.length === 0, missingJsClasses);

  console.log("\n--- admin.js holds no permission rules of its own ---");
  ok("it does not hard-code the section list",
     !/Plans & Features|Security Center|System Health/.test(js));
  ok("it builds the nav from the server's answer",
     /\/admin\/me/.test(js) && /me\.sections/.test(js));
  ok("it holds no permission table of its own",
     !/CAPS\s*=|ROLE_DEFAULTS|ADMIN_ROLES\s*=/.test(jsCode));
  ok("every change it makes goes through the admin API, where the server decides",
     (jsCode.match(/api\("(PUT|PATCH|POST|DELETE)",\s*"([^"]+)"/g) || [])
       .every(c => /"\/(admin|auth)/.test(c)),
     (jsCode.match(/api\("(PUT|PATCH|POST|DELETE)",\s*"([^"]+)"/g) || []));
  ok("and it never decides a role for itself from the shop's own session",
     !/session\.role/.test(jsCode) && !/permissions\.isOwner/.test(jsCode));
  ok("it holds no capability names", !/admin\.manage|security\.view|business\.view/.test(js));
  /* The original form of this banned the rupee sign outright, which was
     the right proxy while every section was a placeholder and became the
     wrong one the moment the dashboard had real money to format. What
     actually matters is that no AMOUNT is written into the source: a
     currency symbol in a formatter is how real data gets displayed; a
     currency symbol followed by digits is a figure somebody invented. */
  ok("it writes no money amount into the source",
     !/[₹$]\s*[\d]/.test(jsCode), (jsCode.match(/[₹$]\s*[\d][\d,.]*/g) || []).slice(0, 5));
  ok("it ships no sample or demo dataset",
     !/\b(sample|demo|dummy|placeholder|mock|fake)\s*(data|rows|values|customers|invoices)\b/i.test(jsCode));
  ok("every figure it draws comes from the server payload, not a literal",
     /PAINT\[/.test(jsCode) && /loadDashboard/.test(jsCode) &&
     !/const\s+(TOTALS|FIGURES|METRICS|SEED)\s*=/.test(jsCode));

  console.log("\n--- the page is honest about being a shell ---");
  ok("admin.js says sections are not built yet", /Not built yet/.test(js));
  ok("the notifications icon admits it does nothing", /not set up yet/.test(js));
  ok("the search field admits it does nothing",
     (js.match(/not set up yet/g) || []).length >= 2);

  console.log("\n--- icons: one drawn set, no emoji ---");
  ok("there is an icon for every section",
     adminAccess.SECTIONS.every(s => new RegExp("\\b" + s.key + ":\\s*'<").test(js)),
     adminAccess.SECTIONS.filter(s => !new RegExp("\\b" + s.key + ":\\s*'<").test(js)).map(s => s.key));
  /* Emoji live well above the BMP's Latin range; a sweep is more honest
     than listing the ones that came to mind. */
  const emoji = (html + js + css).match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
  ok("no emoji anywhere on the page", emoji.length === 0, emoji.slice(0, 10));

  /* ================================================================
     5.  THE SERVER WIRING — position is load-bearing
     ================================================================ */
  console.log("\n--- server/index.js: where the two new mounts sit ---");
  const idx = read("server/index.js");
  const at = s => idx.indexOf(s);

  const iBinder = at("/* ============================================================");
  const iApiAdmin = at('app.use("/api/admin"');
  const iStaff = at('app.use("/api/staff"');
  const iPageRoute = at('app.get("/admin"');
  const iStatic = at("app.use(express.static(");
  const iErrHandler = at("app.use((err, req, res, next)");
  const iRoot = at('app.get("/", (req, res) => {');

  ok("/api/admin is mounted", iApiAdmin > 0);
  ok("/api/admin sits in the feature-router block beside /api/staff",
     Math.abs(iApiAdmin - iStaff) < 1200, iApiAdmin - iStaff);
  ok("/api/admin is mounted with requireAuth first, then the gate",
     /app\.use\("\/api\/admin", requireAuth, adminAccess\.gate\(\), require\("\.\/routes\/admin"\)\);/.test(idx));
  ok("/api/admin does NOT use requireRole — the gate owns that decision",
     !/app\.use\("\/api\/admin"[^)]*requireRole/.test(idx));

  ok("the /admin page route exists", iPageRoute > 0);
  ok("the /admin page route is declared BEFORE express.static",
     iPageRoute < iStatic, iPageRoute + " vs " + iStatic);
  ok("the /admin page route is declared BEFORE the error handler",
     iPageRoute < iErrHandler, iPageRoute + " vs " + iErrHandler);
  ok("the /admin page route is declared AFTER app.get(\"/\")",
     iPageRoute > iRoot);
  ok("/admin.html redirects rather than being left to express.static",
     /app\.get\("\/admin\.html", \(req, res\) => res\.redirect\("\/admin"\)\);/.test(idx));

  ok("the page route checks the session itself and redirects",
     /app\.get\("\/admin",[\s\S]{0,400}?req\.session\.loggedIn\) return res\.redirect\("\/"\)/.test(idx));
  ok("the page route checks the admin role too",
     /adminAccess\.roleOf\(req\)\) return res\.redirect\("\/"\)/.test(idx));
  ok("the page route does NOT use requireAuth/requireRole (they answer JSON)",
     !/app\.get\("\/admin", require(Auth|Role)/.test(idx));
  ok("the page route sends no-store, as / does",
     /app\.get\("\/admin"[\s\S]{0,500}?Cache-Control", "no-store"/.test(idx));

  console.log("\n--- the versioned-HTML cache was NOT shared with index.html ---");
  ok("a second, separate cache was added",
     /const versionedHtmlCache = new Map\(\)/.test(idx));
  ok("getVersionedIndexHtml still exists and still has its own variable",
     /function getVersionedIndexHtml\(\)/.test(idx) && /let versionedIndexHtml = null/.test(idx));
  ok("app.get(\"/\") still calls getVersionedIndexHtml()",
     /app\.get\("\/", \(req, res\) => \{[\s\S]{0,200}?getVersionedIndexHtml\(\)/.test(idx));
  ok("the new function keys its cache by path, so two pages cannot collide",
     /versionedHtmlCache\.has\(absPath\)/.test(idx) && /versionedHtmlCache\.get\(absPath\)/.test(idx));
  ok("both pages bust on the same BOOT_VERSION",
     (idx.match(/\$\{BOOT_VERSION\}/g) || []).length === 2,
     (idx.match(/\$\{BOOT_VERSION\}/g) || []).length);

  console.log("\n--- the page route touches no database (it has no company scope) ---");
  const pageRouteBlock = idx.slice(iPageRoute, iPageRoute + 400);
  ok("no db call inside the /admin handler", !/\bdb\./.test(pageRouteBlock), pageRouteBlock.slice(0, 120));
  /* adminAccess reads the stored permission table now, so the old
     "this file runs no SQL" claim is gone. The claim that MATTERS is
     narrower and still true: roleOf() itself queries nothing, because
     it answers on the /admin page route which runs outside /api with
     no company binder — a query there would read the default shop. */
  const aaSrc = read("server/adminAccess.js");
  const roleOfBody = aaSrc.slice(aaSrc.indexOf("function roleOf(req)"),
                                aaSrc.indexOf("function overridesFor"));
  ok("roleOf() itself runs no query", !/db\.prepare|db\.exec/.test(roleOfBody),
     roleOfBody.slice(0, 100));
  ok("it answers from the session alone",
     /req\.session\.adminRole/.test(roleOfBody));
  ok("and the page route still calls only roleOf, never can()",
     /adminAccess\.roleOf\(req\)\) return res\.redirect/.test(idx) &&
     !/app\.get\("\/admin",[\s\S]{0,400}?adminAccess\.can\(/.test(idx));

  /* ================================================================
     6.  WHAT WAS PRESERVED — asserted against git, not by eye
     ================================================================ */
  console.log("\n--- nothing in the shop app was changed ---");
  /* Anchored to the shop as it stood BEFORE the admin panel, not to the
     working tree — the first version of this compared against HEAD, which
     meant it quietly stopped checking anything the moment the work was
     committed. The anchor is the commit that introduced adminAccess.js,
     minus one; while the work is still uncommitted there is no such
     commit and HEAD is already the right answer. */
  /* stderr is piped, not inherited: the existence probe below is EXPECTED
     to fail for every new file, and inheriting would print a wall of
     "fatal:" lines in the middle of a passing run. */
  const git = (...a) => execFileSync("git", a,
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  /* --diff-filter=A, so this is the commit that ADDED adminAccess.js and
     not merely the last one to touch it. The first version left the
     filter off, which was fine for exactly as long as that file was
     never edited again: PART 3 added two capabilities to it, the anchor
     slid forward to that commit, and the whole block started comparing
     the panel against itself — reporting its own files as pre-existing.
     The add-commit never moves, so this holds however many parts land. */
  const introduced = git("log", "--diff-filter=A", "-1", "--format=%H",
                         "--", "server/adminAccess.js");
  const BEFORE = introduced ? introduced + "^" : "HEAD";

  /* git diff lists tracked changes only, so a brand-new file that has not
     been committed yet would be invisible here — and "the new file is
     missing" would read as "nothing was added", which is the wrong way
     round for a test whose job is to catch additions. The untracked list
     is folded in so the set is the same before and after a commit. */
  const changed = [...new Set([
    ...git("diff", "--name-only", BEFORE).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].map(s => s.trim()).filter(Boolean))];

  const WANT_NEW = ["server/adminAccess.js", "server/routes/admin.js",
                    "public/admin.html", "public/css/admin.css",
                    "public/js/admin.js", "test/admin.test.js",
                    "server/adminDashboard.js", "test/admin-dashboard.test.js",
                    "server/adminCustomers.js", "test/admin-customers.test.js",
                    "server/adminProducts.js", "test/admin-products.test.js",
                    /* The security pass is a separate, deliberate piece of
                       work in the same repo. It is listed so this block
                       stays a tripwire for the UNEXPECTED rather than
                       quietly absorbing whatever happens to have changed. */
                    "server/rateLimit.js", "test/security.test.js", ".env.example",
                    "server/adminSales.js", "test/admin-sales.test.js",
                    "test/invoice-create.test.js",
                    "server/adminUsers.js", "test/admin-users.test.js",
                    /* PART 10: the audit log. auditLog.js is the writer —
                       the INSERT that util.logAction used to do inline,
                       moved so that the rule about what never reaches
                       the log is enforced in one place. adminAudit.js is
                       the read side, like the other admin* modules. */
                    "server/auditLog.js", "server/adminAudit.js",
                    "test/audit.test.js"];

  /* The two existing files the admin panel is allowed to have touched,
     and the reason each one had to be:
       index.js     — the page route and the /api/admin mount (PART 1)
       alerts.js    — the reminder rules lifted out of the route body so
                      the dashboard shows the same reminders rather than
                      a second copy of them (PART 2)
       customers.js — the edit and switch-off handlers lifted out the same
                      way, so an admin edit IS the shop's edit (PART 3)
       products.js  — the product edit and the stock correction lifted out
                      likewise, so an admin adjustment runs the shop's own
                      transaction, clamp and ledger write (PART 4)
     Anything else appearing here is a scope breach, which is the whole
     point of naming them. */
  const MAY_TOUCH = ["server/index.js", "server/routes/alerts.js",
                     "server/routes/customers.js", "server/routes/products.js",
                     /* Security pass: session regeneration, the rate limiter,
                        the import-undo whitelist, and two patched transitive
                        dependencies. */
                     /* auth.js: the login lockout, which keyed on the address
                        alone and so let one attacker lock the whole shop out
                        of the till. It is paired with the account now. */
                     "server/routes/auth.js", "server/auth.js", "server/importRun.js",
                     /* PART 6: idempotent invoice creation — the key column and
                        its partial UNIQUE index, and the guard that turns a
                        repeated submission back into the first bill. */
                     "server/routes/invoices.js", "server/db-schema.js",
                     /* app.js: the billing screen sends the submission key.
                        Backend idempotency that no client uses is theatre. */
                     "public/js/app.js",
                     /* util.js: logAction's three-argument signature is
                        unchanged and all ~250 call sites still work, but
                        the INSERT it did inline now lives in
                        auditLog.js. One writer, so a credential cannot
                        reach the log through a caller that forgot. */
                     "server/util.js",
                     "package-lock.json"];

  /* A file is new if it did not exist at the anchor. */
  const existedBefore = f => {
    try { git("cat-file", "-e", BEFORE + ":" + f); return true; }
    catch (e) { return false; }
  };

  const touchedExisting = changed.filter(f => !WANT_NEW.includes(f));
  ok("only the two named pre-existing files were touched",
     touchedExisting.length === MAY_TOUCH.length &&
     touchedExisting.every(f => MAY_TOUCH.includes(f)),
     touchedExisting);

  ["public/index.html", "public/css/style.css",
   "public/js/boot.js", "public/css/document.css",
   "server/permissions.js", "server/db.js",
   "server/routes/staff.js",
   "server/routes/permissions.js"].forEach(f => {
    ok(f + " is untouched", !changed.includes(f));
  });

  /* This began as "index.js lost no lines", which was true of the admin
     panel's change to it and stopped being the right question once the
     security pass rewrote the session-secret block in the same file. A
     line count across two workstreams measures neither. What the admin
     panel actually promised is that it ADDED its three pieces and took
     nothing of the shop's away — so check exactly that. */
  const indexSrc = read("server/index.js");
  ok("the admin page route is still mounted",
     /app\.get\("\/admin",/.test(indexSrc));
  ok("the admin API is still mounted inside /api",
     /app\.use\("\/api\/admin", requireAuth, adminAccess\.gate\(\)/.test(indexSrc));
  ok("the admin page still has its own versioned-HTML cache",
     /const versionedHtmlCache = new Map\(\)/.test(indexSrc));
  ok("and the shop app's own route and cache are untouched beside it",
     /function getVersionedIndexHtml\(\)/.test(indexSrc) &&
     /let versionedIndexHtml = null/.test(indexSrc) &&
     /app\.get\("\/", \(req, res\) => \{[\s\S]{0,200}?getVersionedIndexHtml\(\)/.test(indexSrc));

  WANT_NEW.forEach(f => {
    ok(f + " is new", changed.includes(f) && !existedBefore(f),
       changed.includes(f) ? "existed before" : "not in the diff");
  });
  ok("no file was added beyond the ones named above",
     changed.filter(f => !WANT_NEW.includes(f) && !existedBefore(f)).length === 0,
     changed.filter(f => !WANT_NEW.includes(f) && !existedBefore(f)));

  console.log("\n--- the only schema change is additive ---");
  const schema = read("server/db-schema.js");
  /* PART 1 asserted this column did NOT exist, to prove the shell had
     made no schema change. PART 8 is the part that adds it, so the
     claim inverts — and what matters is not that the column exists
     but what it CANNOT hold. */
  ok("the admin role column exists now",
     /addColumn\("staff", "admin_role"/.test(schema));
  ok("AND IT CANNOT HOLD 'OWNER' — the protection is in the schema",
     /CHECK \(admin_role IN \('ADMIN','SUPPORT'\)\)/.test(schema), schema.length);
  ok("the stored role-permission table cannot name OWNER either",
     /CHECK \(role IN \('ADMIN','SUPPORT'\)\)/.test(schema));
  ok("the staff role CHECK is still owner/staff only",
     /CHECK \(role IN \('owner',\s*'staff'\)\)/.test(schema));

  /* PART 6 added one column and one index for idempotent invoice
     creation. That is the whole of it, and "added" has to keep meaning
     added: a DROP or an ALTER ... RENAME in this file would rewrite a
     live shop's books on the next boot. */
  ok("the idempotency column is added with the existing addColumn idiom",
     /addColumn\("invoices", "idempotency_key", "TEXT"\)/.test(schema));
  ok("its unique index is created IF NOT EXISTS, so a reboot is a no-op",
     /CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_idempotency/.test(schema));
  ok("and it is PARTIAL, so every bill raised before it still fits",
     /WHERE idempotency_key IS NOT NULL/.test(schema));
  /* The billing screen is the one file in this app that is in use all
     day. PART 6 added to it and took nothing away — asserted, because
     "I only added a bit" is what everybody says. */
  const appStat = git("diff", "--numstat", BEFORE, "--", "public/js/app.js").split(/\s+/);
  ok("the change to the billing screen removed no lines",
     appStat[1] === "0" || appStat.length === 0, appStat.join(" "));
  ok("and what it added is the submission key, nothing else",
     /newSubmissionKey\(\)/.test(read("public/js/app.js")) &&
     /payload\.idempotencyKey = state\.billSubmissionKey/.test(read("public/js/app.js")));
  ok("the key is kept on failure so a retry is the same submission",
     /A failure deliberately leaves the key in place/.test(read("public/js/app.js")));

  ok("the schema file drops nothing",
     !/DROP TABLE|DROP COLUMN|DROP INDEX/i.test(code("server/db-schema.js")));
  ok("and renames nothing",
     !/ALTER TABLE [a-z_]+ RENAME/i.test(code("server/db-schema.js")));

  const adminRouteCode = code("server/routes/admin.js");
  ok("the admin panel creates no table", !/CREATE TABLE/i.test(adminRouteCode));
  /* It was read-only until PART 8 gave it user management. What it
     writes is now the question, and the answer must stay these three:
     who may open the panel, whether an account is on, and what a role
     grants. Never a bill, a payment, a product or a stock count. */
  /* "DO UPDATE SET" inside an ON CONFLICT clause is not a table name —
     the first pass of this counted "set" as one. */
  const writes = (adminRouteCode.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+[a-z_]+/gi) || [])
    .filter(w => !/UPDATE\s+SET$/i.test(w));
  const writtenTables = [...new Set(writes.map(w =>
    w.replace(/^(INSERT INTO|UPDATE|DELETE FROM)\s+/i, "").toLowerCase()))];
  ok("it writes only to staff and the role-permission table",
     writtenTables.every(t => ["staff", "admin_role_permissions"].includes(t)),
     writtenTables);
  ok("it never writes to a financial or stock table",
     !writtenTables.some(t => /invoice|payment|cash|product|size|stock|customer|purchase/.test(t)),
     writtenTables);
  ok("and it never selects every column of anything",
     !/SELECT\s+\*/i.test(adminRouteCode));
  /* It reads the stored permission table now. It must never WRITE:
     the module that decides access is not the module that grants it. */
  ok("adminAccess decides access and never grants it",
     !/\b(INSERT|UPDATE|DELETE)\b/.test(code("server/adminAccess.js")));

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
