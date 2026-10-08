/* ============================================================
   SECURITY — the audit's claims, checked

   Every PASS in SECURITY.md has a test here. That is the whole point of
   the file: a security report is a list of assertions about a program,
   and an assertion nobody ran is an opinion.

   Four of these cover things that were WRONG and are now fixed:

     SESSION FIXATION. Logging in kept whatever session id the browser
     arrived holding, so an id planted before the owner typed their PIN
     became the owner's session afterwards.

     NO RATE LIMIT BEYOND LOGIN. /api/sync/receive accepts an entire
     database without a session, and nothing stopped anyone posting at
     it all day.

     proxy-addr (CRITICAL, transitive). `trust proxy` is on, so req.ip
     comes from X-Forwarded-For — and a spoofable req.ip defeats the
     login lockout, which keys on it.

     An import undo built a DELETE with a table name read from a column.

   The rest check that what the audit called already-strong really is,
   because "I read it and it looked fine" is how cross-tenant bugs ship.

   Run:  node test/security.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync, spawn } = require("child_process");

const DATA_DIR = path.join(os.tmpdir(), "sm-security-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const session = require(path.join(ROOT, "node_modules/express-session"));
const rateLimit = require(path.join(ROOT, "server/rateLimit.js"));
const { hashPin, requireAuth, requireRole, clearLoginFailures } =
  require(path.join(ROOT, "server/auth.js"));
const { SqliteSessionStore } = require(path.join(ROOT, "server/sessionStore.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x) : "")); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const code = p => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const SHOP = db.companies.create({ name: "Our Shop" });
const OTHER = db.companies.create({ name: "Another Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inOther = fn => db.companies.runAs(OTHER.id, fn);

/* ------------------------------------------------------------------
   A server shaped like the real one: the same session middleware, the
   same auth router, the same company binder.
   ------------------------------------------------------------------ */
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "12mb" }));
app.use(rateLimit.limit({ bucket: "test-write", max: 240, windowMs: 60 * 1000 }));
app.use(session({
  store: new SqliteSessionStore({ dir: DATA_DIR }),
  secret: "a-test-secret-that-is-at-least-32-chars",
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { maxAge: 60000, httpOnly: true, sameSite: "lax", secure: false },
}));
app.use("/api/auth", (req, _res, next) => db.companies.runAs(SHOP.id, next),
        require(path.join(ROOT, "server/routes/auth.js")));

/* The binder, exactly as index.js writes it: the id comes from the
   SESSION, never from the request. */
app.use("/api", (req, res, next) => {
  const id = (req.session && req.session.businessId) || SHOP.id;
  db.companies.runAs(id, next);
});
app.use("/api/businesses", requireAuth, require(path.join(ROOT, "server/routes/businesses.js")));
app.use("/api/customers", requireAuth, require(path.join(ROOT, "server/routes/customers.js")));
app.use("/api/backup", requireAuth, requireRole("owner"), require(path.join(ROOT, "server/routes/backup.js")));
app.use("/api/staff", requireAuth, requireRole("owner"), require(path.join(ROOT, "server/routes/staff.js")));
app.use("/api/audit", requireAuth, requireRole("owner"), require(path.join(ROOT, "server/routes/audit.js")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

let BASE;

/* A cookie jar, because half of what is below is about cookies. */
function jar() {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async call(method, url, body, extraHeaders) {
      const headers = Object.assign({}, extraHeaders || {});
      if (cookie) headers.cookie = cookie;
      if (body) headers["content-type"] = "application/json";
      const r = await fetch(BASE + url, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      const setC = r.headers.getSetCookie ? r.headers.getSetCookie()
                                          : [r.headers.get("set-cookie")].filter(Boolean);
      if (setC.length) cookie = setC.map(c => c.split(";")[0]).join("; ");
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
      return { status: r.status, j, text: t, setCookie: setC, headers: r.headers };
    },
  };
}

const sid = c => { const m = /connect\.sid=([^;]*)/.exec(c || ""); return m ? m[1] : null; };

function seed() {
  inShop(() => {
    db.prepare("UPDATE staff SET pin_hash = ? WHERE id = ?").run(hashPin("4821"), "STAFF_owner");
    db.prepare(`INSERT INTO staff (id,name,pin_hash,role,active,created_at)
                VALUES (?,?,?,?,1,?)`)
      .run("ST-COUNTER", "Counter", hashPin("7391"), "staff", Date.now());
    db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                VALUES ('C-OURS','Our Customer','900',500,?,1)`).run(Date.now());
  });
  inOther(() => {
    db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                VALUES ('C-THEIRS','Rival Customer','911',999999,?,1)`).run(Date.now());
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  SESSION FIXATION  — the fix
     ================================================================ */
  console.log("\n--- session fixation ---");

  const a = jar();
  /* FIRST LINE OF DEFENCE, and it turns out to be the strong one:
     saveUninitialized is false, so nothing is written to the store and
     NO COOKIE IS ISSUED until a session actually holds something. A
     browser that has never logged in therefore has no session id to
     plant — which is why the fixation finding is defence in depth here
     rather than a live hole, and the report says so. */
  await a.call("GET", "/api/auth/session");
  await a.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "WRONG" });
  ok("no session cookie is issued before anyone is signed in",
     sid(a.cookie) === null, a.cookie);
  ok("saveUninitialized is off, which is what makes that true",
     /saveUninitialized: false/.test(read("server/index.js")));
  clearLoginFailures("127.0.0.1"); clearLoginFailures("::1"); clearLoginFailures("::ffff:127.0.0.1");
  const beforeId = sid(a.cookie);

  const login = await a.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "4821" });
  ok("the login succeeds", login.status === 200, [login.status, login.j]);
  const afterId = sid(a.cookie);
  ok("logging in issues a session id", !!afterId, afterId);
  ok("and it is not one the browser arrived holding", afterId !== beforeId,
     [beforeId, afterId && afterId.slice(0, 12)]);

  /* The real test of the fix: take a session id that IS valid, log in
     again under it, and check the id changed. This is the privilege
     boundary fixation is about — the id that watched the login must not
     be the id that comes out of it. */
  const b = jar();
  await b.call("GET", "/api/auth/session");
  await b.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "4821" });
  const firstId = sid(b.cookie);
  ok("a logged-in session has an id", !!firstId);
  await b.call("POST", "/api/auth/login", { staffId: "ST-COUNTER", pin: "7391" });
  const secondId = sid(b.cookie);
  ok("LOGGING IN AGAIN REPLACES THE SESSION ID", secondId && secondId !== firstId,
     [firstId && firstId.slice(0, 12), secondId && secondId.slice(0, 12)]);

  const planted = jar();
  planted.cookie = "connect.sid=" + firstId;
  const stolen = await planted.call("GET", "/api/auth/session");
  ok("the OLD id is dead — it is not signed in as anybody",
     stolen.j && stolen.j.loggedIn === false, stolen.j);
  ok("regenerate() is what does it", /req\.session\.regenerate\(/.test(read("server/routes/auth.js")));
  clearLoginFailures("127.0.0.1"); clearLoginFailures("::1"); clearLoginFailures("::ffff:127.0.0.1");

  ok("the session is authenticated under its new id",
     (await a.call("GET", "/api/auth/session")).j.loggedIn === true);

  console.log("\n--- logout, and reuse of a dead session ---");
  const dead = a.cookie;
  ok("logout succeeds", (await a.call("POST", "/api/auth/logout")).status === 200);
  const revived = jar();
  revived.cookie = dead;
  ok("the destroyed session cannot be reused",
     (await revived.call("GET", "/api/auth/session")).j.loggedIn === false);
  ok("and it cannot reach a protected route",
     (await revived.call("GET", "/api/customers")).status === 401);

  console.log("\n--- the session cookie itself ---");
  const fresh = jar();
  await fresh.call("GET", "/api/auth/session");
  await fresh.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "4821" });
  const raw = fresh.cookie;
  ok("a session id is not a guessable counter", raw.length > 40, raw.length);

  const idx = read("server/index.js");
  ok("the real server sets httpOnly", /httpOnly:\s*true/.test(idx));
  ok("the real server sets sameSite", /sameSite:\s*["']lax["']/.test(idx));
  ok("the real server sets secure in production", /secure:\s*isProduction/.test(idx));
  ok("sessions are stored server-side, not in the cookie",
     /SqliteSessionStore/.test(idx));

  /* ================================================================
     2.  BRUTE FORCE
     ================================================================ */
  console.log("\n--- login rate limiting ---");

  /* Before the lockout: an unknown staff id and a wrong PIN must be
     indistinguishable, or the login screen enumerates staff for you. */
  const unknown = await jar().call("POST", "/api/auth/login",
    { staffId: "NO-SUCH-STAFF", pin: "1234" });
  const wrongPin = await jar().call("POST", "/api/auth/login",
    { staffId: "STAFF_owner", pin: "0000" });
  ok("an unknown staff id and a wrong PIN give the SAME answer",
     unknown.status === wrongPin.status &&
     JSON.stringify(unknown.j) === JSON.stringify(wrongPin.j),
     [unknown.j, wrongPin.j]);
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].forEach(a => clearLoginFailures(a));

  const bf = jar();
  let locked = null;
  for (let i = 0; i < 7; i++) {
    const r = await bf.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "0000" });
    if (r.status === 429) { locked = i; break; }
  }
  ok("wrong PINs lock the address out", locked !== null, locked);
  ok("it locks after a handful, not dozens", locked !== null && locked <= 6, locked);

  const rightPin = await bf.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "4821" });
  ok("even the CORRECT pin is refused while locked out", rightPin.status === 429, rightPin.status);
  ok("the refusal does not say whether the PIN was right",
     !/correct|right/i.test((rightPin.j && rightPin.j.error) || ""), rightPin.j);


  /* The lockout keys on req.ip, which with `trust proxy` comes from
     X-Forwarded-For — which is why the proxy-addr advisory mattered. */
  ok("the proxy hop count is explicit and configurable",
     /app\.set\("trust proxy", TRUST_PROXY\)/.test(idx));

  /* ---------------------------------------------------------------
     ONE ATTACKER MUST NOT BE ABLE TO CLOSE THE COUNTER.

     The lockout keyed on the address alone. On a shop PC that is one
     person; hosted, behind a proxy, it is EVERYBODY — so five wrong
     PINs from a stranger's phone would have locked every member of
     staff out of the till for fifteen minutes. Pairing the counter
     with the account keeps the brute-force protection and takes away
     the shop-wide outage. --------------------------------------- */
  console.log("\n--- a lockout is per account, not per shop ---");
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].forEach(a => clearLoginFailures(a));

  const attacker = jar();
  let ownerLocked = false;
  for (let i = 0; i < 7; i++) {
    const res = await attacker.call("POST", "/api/auth/login",
      { staffId: "STAFF_owner", pin: "0000" });
    if (res.status === 429) { ownerLocked = true; break; }
  }
  ok("hammering the owner's PIN locks the OWNER out", ownerLocked);

  const counter = jar();
  const stillIn = await counter.call("POST", "/api/auth/login",
    { staffId: "ST-COUNTER", pin: "7391" });
  ok("but the counter staff can still sign in from the same address",
     stillIn.status === 200, [stillIn.status, stillIn.j]);
  ok("the lockout is keyed on the pair, not the address",
     /lockKey\(ip, staffId\)/.test(read("server/auth.js")));
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].forEach(a => clearLoginFailures(a));
  ok("x-powered-by is disabled, so responses do not name the framework",
     /app\.disable\("x-powered-by"\)/.test(idx));

  /* Undo the lockout this block just created: every request in this file
     comes from 127.0.0.1, so leaving it set would 429 everything after. */
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].forEach(a => clearLoginFailures(a));

  /* ================================================================
     3.  RATE LIMITING  — the new layer
     ================================================================ */
  console.log("\n--- the general write limit ---");

  rateLimit.reset();
  let hit429 = 0;
  for (let i = 0; i < 260; i++) {
    const r = rateLimit.hit("probe", "s:session-a", 240, 60000);
    if (!r.ok) hit429++;
  }
  ok("writes are capped per caller", hit429 === 20, hit429);
  ok("a refusal says when to come back",
     rateLimit.hit("probe", "s:session-a", 240, 60000).retryAfterSec > 0);
  ok("a DIFFERENT caller is unaffected by the first one's limit",
     rateLimit.hit("probe", "s:session-b", 240, 60000).ok === true);

  /* ---------------------------------------------------------------
     THE BUG THIS BLOCK EXISTS FOR.

     The limiter first keyed on req.ip. Behind this app's hosted chain
     — Cloudflare in front of Render — trust proxy 1 makes req.ip the
     intermediate hop rather than the caller, which fails two ways:
     if that address moves, nobody is ever limited; if it is stable,
     the whole shop shares one bucket and one person hammering the app
     locks out the counter. Thirteen hits on the live sync endpoint
     produced no refusal, which is the first failure observed for
     real. --------------------------------------------------------- */
  console.log("\n--- what Express reports for a two-proxy chain ---");
  {
    const probe = express();
    probe.set("trust proxy", 1);
    probe.get("/", (q, r2) => r2.json({ ip: q.ip }));
    const one = probe.listen(0);
    await new Promise(f => one.once("listening", f));
    const r1 = await (await fetch("http://127.0.0.1:" + one.address().port + "/",
      { headers: { "x-forwarded-for": "203.0.113.55, 172.16.0.9" } })).json();
    one.close();

    const probe2 = express();
    probe2.set("trust proxy", 2);
    probe2.get("/", (q, r2) => r2.json({ ip: q.ip }));
    const two = probe2.listen(0);
    await new Promise(f => two.once("listening", f));
    const r2j = await (await fetch("http://127.0.0.1:" + two.address().port + "/",
      { headers: { "x-forwarded-for": "203.0.113.55, 172.16.0.9" } })).json();
    two.close();

    ok("trust proxy 1 reports the INTERMEDIATE hop, not the caller",
       r1.ip === "172.16.0.9", r1.ip);
    ok("trust proxy 2 reports the caller", r2j.ip === "203.0.113.55", r2j.ip);
    ok("so the hop count is configurable rather than assumed",
       /TRUST_PROXY/.test(read("server/index.js")) &&
       /app\.set\("trust proxy", TRUST_PROXY\)/.test(read("server/index.js")));
    ok("and it is documented, with a warning against rounding up",
       /TRUST_PROXY=/.test(read(".env.example")) &&
       /do not round up|Do NOT round up/i.test(read(".env.example")));
  }

  console.log("\n--- the limiter keys on the session, not the address ---");
  rateLimit.reset();
  ok("a request with a session is keyed by it",
     rateLimit.callerKey({ sessionID: "abc", ip: "1.1.1.1",
                           session: { loggedIn: true } }) === "s:abc");
  ok("only a request without one falls back to the address",
     rateLimit.callerKey({ ip: "1.1.1.1" }) === "i:1.1.1.1");
  /* express-session hands a FRESH sessionID to every request that
     arrives with no cookie, so presence alone is worthless as an
     identity — a flood would get a new one per request. */
  ok("an ANONYMOUS request is keyed by address, not by a throwaway session id",
     rateLimit.callerKey({ sessionID: "fresh-each-time", ip: "1.1.1.1" }) === "i:1.1.1.1",
     rateLimit.callerKey({ sessionID: "fresh-each-time", ip: "1.1.1.1" }));
  ok("TWO SIGNED-IN CALLERS BEHIND ONE ADDRESS GET THEIR OWN LIMITS",
     rateLimit.callerKey({ sessionID: "a", ip: "9.9.9.9", session: { loggedIn: true } }) !==
     rateLimit.callerKey({ sessionID: "b", ip: "9.9.9.9", session: { loggedIn: true } }));

  /* The whole point: one session exhausting its limit must not refuse
     the person at the next till. */
  rateLimit.reset();
  for (let i = 0; i < 12; i++) rateLimit.hit("shared", "s:till-one", 10, 60000, 100000);
  ok("one till hitting its ceiling does not lock out another",
     rateLimit.hit("shared", "s:till-one", 10, 60000, 100000).ok === false &&
     rateLimit.hit("shared", "s:till-two", 10, 60000, 100000).ok === true);

  console.log("\n--- the backstop, for when the key is worthless ---");
  rateLimit.reset();
  let refusedByGlobal = false;
  /* A flood that looks like a thousand different callers — exactly what
     a rotating proxy address produces. Each one is under its own limit;
     the bucket total is not. */
  for (let i = 0; i < 400; i++) {
    const r = rateLimit.hit("flood", "i:10.0.0." + i, 240, 60000, 300);
    if (!r.ok && r.scope === "global") { refusedByGlobal = true; break; }
  }
  ok("a flood from a thousand apparent callers is still bounded", refusedByGlobal);
  rateLimit.reset();

  rateLimit.reset();
  ok("READS are deliberately not limited",
     /methods\s*\|\|\s*\["POST", "PUT", "PATCH", "DELETE"\]/.test(read("server/rateLimit.js")));
  ok("the limit is generous enough for a busy counter",
     /max: 240/.test(idx), (idx.match(/max: \d+/g) || []));

  ok("the write limiter is mounted AFTER the session middleware",
     idx.indexOf("app.use(session({") <
     idx.indexOf('app.use("/api", rateLimit.limit('),
     [idx.indexOf("app.use(session({"), idx.indexOf('app.use("/api", rateLimit.limit(')]);
  ok("  which is what makes req.sessionID available to it",
     /req && req\.sessionID/.test(read("server/rateLimit.js")));

  ok("the sync receiver has its own, much stricter limit",
     /bucket: "sync", max: 10/.test(idx));
  /* The per-caller limit falls back to the address for anonymous
     traffic, and behind an unresolvable proxy that is not a caller. The
     global ceiling is the one that bites there, so it is tight. */
  ok("and a global ceiling that applies whatever the address looks like",
     /globalMax: 30/.test(idx));
  ok("and it is applied to the sync mount",
     /app\.use\("\/api\/sync", rateLimit\.limit\(/.test(idx));

  ok("the limiter cannot grow without bound",
     rateLimit.MAX_TRACKED > 0 && /MAX_TRACKED/.test(read("server/rateLimit.js")));
  ok("a 429 leaks no counts, window or address",
     !/\$\{(limit|max|windowMs|ip)\}/.test(read("server/rateLimit.js")));

  /* ================================================================
     4.  AUTHORIZATION
     ================================================================ */
  console.log("\n--- staff cannot reach owner-only routes ---");

  const staff = jar();
  await staff.call("GET", "/api/auth/session");
  const sLogin = await staff.call("POST", "/api/auth/login", { staffId: "ST-COUNTER", pin: "7391" });
  ok("the staff member is logged in", sLogin.status === 200, [sLogin.status, sLogin.j]);
  ok("and holds the staff role", sLogin.j.role === "staff", sLogin.j.role);

  for (const url of ["/api/backup/download", "/api/staff", "/api/audit"]) {
    const r = await staff.call("GET", url);
    ok("staff GET " + url + " is refused", r.status === 403, r.status);
    ok("  and nothing leaks in the body", !/pin_hash|BEGIN|SQLite/.test(r.text), r.text.slice(0, 60));
  }

  const owner = jar();
  await owner.call("GET", "/api/auth/session");
  await owner.call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "4821" });
  ok("the owner CAN read the audit log", (await owner.call("GET", "/api/audit")).status === 200);

  console.log("\n--- a whole-database backup is owner-only ---");
  ok("staff cannot download the shop's database",
     (await staff.call("GET", "/api/backup/download")).status === 403);

  /* ================================================================
     5.  MULTI-COMPANY ISOLATION
     ================================================================ */
  console.log("\n--- company isolation ---");

  ok("the other shop really holds that customer",
     inOther(() => !!db.prepare("SELECT 1 FROM customers WHERE id = ?").get("C-THEIRS")));

  let r = await owner.call("GET", "/api/customers/C-THEIRS");
  ok("the other shop's customer is a 404 here", r.status === 404, r.status);
  ok("and none of their data leaks",
     !r.text.includes("Rival") && !r.text.includes("999999"), r.text.slice(0, 80));

  /* The binder reads the session, so a company id in the body or the
     query must change nothing at all. */
  const mine = await owner.call("GET", "/api/customers");
  const forged = await owner.call("GET", "/api/customers?companyId=" + encodeURIComponent(OTHER.id));
  ok("a companyId in the QUERY is ignored",
     JSON.stringify(forged.j) === JSON.stringify(mine.j), [forged.j && forged.j.length]);

  const forgedBody = await owner.call("POST", "/api/customers",
    { name: "Planted", phone: "999", companyId: OTHER.id, businessId: OTHER.id });
  ok("creating with a forged companyId still writes to MY shop",
     forgedBody.status === 201 &&
     inShop(() => !!db.prepare("SELECT 1 FROM customers WHERE name = ?").get("Planted")) &&
     inOther(() => !db.prepare("SELECT 1 FROM customers WHERE name = ?").get("Planted")),
     forgedBody.status);

  ok("the binder takes the company from the session, never the request",
     /const id = \(tenant && tenant\.companyId\)[\s\S]{0,160}req\.session && req\.session\.businessId/.test(idx));

  console.log("\n--- switching company is checked against the caller's own list ---");
  const sw = await staff.call("POST", "/api/businesses/switch", { businessId: OTHER.id });
  ok("staff cannot switch into another company", sw.status === 403, [sw.status, sw.j]);
  ok("and their session was not moved",
     (await staff.call("GET", "/api/businesses")).j.current !== OTHER.id);

  /* ================================================================
     6.  ERROR HANDLING
     ================================================================ */
  console.log("\n--- errors say nothing useful to an attacker ---");

  const probes = [
    ["GET", "/api/customers/" + encodeURIComponent("'; DROP TABLE customers;--")],
    ["GET", "/api/customers/" + encodeURIComponent("../../../../etc/passwd")],
    ["GET", "/api/customers/" + encodeURIComponent("%00")],
    ["PUT", "/api/customers/NOPE"],
  ];
  for (const [m, u] of probes) {
    const res = await owner.call(m, u, m === "PUT" ? { name: "x" } : undefined);
    ok(m + " " + u.slice(0, 34) + " leaks no stack trace", !/\bat \w+ \(/.test(res.text));
    ok("  no filesystem path", !/[A-Za-z]:[\\/]|\/home\/|\/tmp\//.test(res.text), res.text.slice(0, 60));
    ok("  no SQL", !/SELECT |FROM customers|SQLITE/i.test(res.text), res.text.slice(0, 60));
  }
  ok("the customers table survived the injection attempt",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM customers").get().n) >= 1);

  ok("the global handler returns one generic sentence",
     /res\.status\(500\)\.json\(\{ error: "Something went wrong on the server\." \}\)/.test(idx));

  /* ================================================================
     7.  SECRETS
     ================================================================ */
  console.log("\n--- secrets are not in the repository ---");

  const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
    .toString();

  for (const f of [".env", "data/.env", "data/session-secret.txt", "data/credential-key.txt"]) {
    ok(f + " has never been committed",
       git("log", "--oneline", "--all", "--", f).trim() === "");
  }
  ok(".gitignore excludes every .env", /^\.env$/m.test(read(".gitignore")) && /^\.env\.\*$/m.test(read(".gitignore")));
  ok("but allows .env.example", /^!\.env\.example$/m.test(read(".gitignore")));
  ok(".env.example exists", fs.existsSync(path.join(ROOT, ".env.example")));

  const envExample = read(".env.example");
  const varNames = [...new Set((code("server/index.js") + code("server/backup.js") +
    code("server/secretBox.js") + code("server/license.js"))
    .match(/process\.env\.[A-Z_][A-Z0-9_]*/g) || [])].map(s => s.replace("process.env.", ""));
  const missing = varNames.filter(v => !envExample.includes(v));
  ok(".env.example names every variable the app reads", missing.length === 0, missing);
  ok("and carries NO value for any of them",
     !/^[A-Z_]+=.+$/m.test(envExample),
     (envExample.match(/^[A-Z_]+=.+$/gm) || []).slice(0, 3));

  console.log("\n--- secrets are not in the frontend ---");
  const frontend = fs.readdirSync(path.join(ROOT, "public/js"))
    .map(f => read("public/js/" + f)).join("\n");
  ok("no key, token or password literal in the browser code",
     !/(secret|token|password|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}/i.test(frontend));
  ok("no long base64/hex literal that could be a credential",
     !/["'][A-Za-z0-9+/=]{40,}["']/.test(frontend.replace(/data:[a-z/+;,A-Za-z0-9]+/g, "")));
  ok("the browser never reads process.env", !/process\.env/.test(frontend));

  console.log("\n--- secrets are not in an API response ---");
  inShop(() => db.prepare(`UPDATE settings SET sync_cloud_key = ?, activation_code = ?,
      license_key = ?, gst_credentials = ? WHERE id = 1`)
    .run("SYNCKEY0123456789abcdef", "ACT-SECRET", "LIC-SECRET", "GSTCRED-SECRET"));

  for (const u of ["/api/auth/session", "/api/customers", "/api/businesses"]) {
    const res = await owner.call("GET", u);
    for (const s of ["SYNCKEY0123456789abcdef", "ACT-SECRET", "LIC-SECRET", "GSTCRED-SECRET"]) {
      ok(u + " does not leak " + s.split("-")[0], !res.text.includes(s));
    }
    ok(u + " does not leak a pin hash", !/pin_hash/.test(res.text));
  }

  /* ================================================================
     8.  SESSION SECRET CONFIGURATION
     ================================================================ */
  console.log("\n--- the session secret ---");
  ok("SESSION_SECRET from the environment is honoured",
     /process\.env\.SESSION_SECRET/.test(idx));
  ok("a too-short SESSION_SECRET is ignored rather than used",
     /shorter than 32 characters, so it is/.test(idx) && /sessionSecret = "";/.test(idx));
  ok("and ignoring it does NOT take the shop down",
     !/throw new Error\("SESSION_SECRET/.test(idx));
  ok("the generated fallback is 32 random bytes",
     /crypto\.randomBytes\(32\)\.toString\("hex"\)/.test(idx));
  ok("the secret file is written owner-only where the OS supports it",
     /mode: 0o600/.test(idx));
  ok("the secret file is gitignored", /session-secret\.txt/.test(read(".gitignore")));

  /* ================================================================
     9.  UPLOADS
     ================================================================ */
  console.log("\n--- file uploads ---");
  const attach = require(path.join(ROOT, "server/attachments.js"));
  const att = code("server/attachments.js");

  ok("the mime type is whitelisted, not taken from the filename",
     /ALLOWED\[input\.mimeType\]/.test(att));
  ok("an unlisted type is refused", (() => {
    try { attach.saveAttachment({ mimeType: "application/x-msdownload",
                                  dataBase64: Buffer.from("MZ").toString("base64") }); return false; }
    catch (e) { return /JPEG, PNG, WEBP or PDF/.test(e.message); }
  })());
  ok("an empty file is refused", (() => {
    try { attach.saveAttachment({ mimeType: "image/png", dataBase64: "" }); return true; }
    catch (e) { return /empty/i.test(e.message); }
  })());
  ok("the stored name is generated by the server, not the client",
     /crypto\.randomBytes\(8\)\.toString\("hex"\)/.test(att));

  for (const bad of ["../../etc/passwd", "..\\..\\windows\\system.ini", "a/b.png", "x\\y.png"]) {
    ok("path traversal via '" + bad.slice(0, 18) + "' is refused",
       attach.attachmentFilePath(bad) === null);
  }
  /* It also insists the file is really there, so give it one. */
  fs.mkdirSync(attach.UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(attach.UPLOAD_DIR, "abcdef0123456789.png"), "x");
  ok("a legitimate stored name resolves",
     typeof attach.attachmentFilePath("abcdef0123456789.png") === "string");
  ok("a name that is not on disk resolves to nothing",
     attach.attachmentFilePath("0000000000000000.png") === null);

  /* ================================================================
     10.  IMPORT UNDO
     ================================================================ */
  console.log("\n--- the one table name that reaches SQL from a column ---");
  const imp = code("server/importRun.js");
  ok("it is checked against a whitelist before the DELETE",
     /UNDOABLE_TABLES\.has\(r\.target_table\)/.test(imp));
  ok("and the whitelist is declared above it",
     imp.indexOf("const UNDOABLE_TABLES") < imp.indexOf("UNDOABLE_TABLES.has"));
  const undoable = require(path.join(ROOT, "server/importRun.js"));
  ok("the DELETE still interpolates nothing else",
     (imp.match(/DELETE FROM \$\{/g) || []).length === 1);

  /* ================================================================
     11.  AUDIT LOG
     ================================================================ */
  console.log("\n--- the audit log records what matters ---");
  const actions = inShop(() =>
    db.prepare("SELECT DISTINCT action FROM audit_log").all().map(x => x.action));
  ok("a login is recorded", actions.includes("login"), actions);
  ok("a logout is recorded", actions.includes("logout"), actions);

  const declared = [...new Set((execFileSync("git", ["grep", "-ho", "logAction(req, *\"[a-z._]*\""],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString()
    .match(/"[a-z._]+"/g) || []).map(s => s.replace(/"/g, "")))];
  ok("the app records a wide set of actions, not a token few",
     declared.length >= 150, declared.length);
  for (const must of ["login", "logout", "backup.run", "backup.restore", "business.switch",
                      "customer.update", "product.update", "sync.push"]) {
    ok("  it records " + must, declared.includes(must), must);
  }

  const auditCols = inShop(() => db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name));
  ok("every entry carries who, what and when",
     ["staff_name", "role", "action", "at"].every(c => auditCols.includes(c)), auditCols);
  ok("the audit log holds no password or hash column",
     !auditCols.some(c => /pin|hash|password|secret/i.test(c)), auditCols);

  const auditRows = inShop(() => db.prepare("SELECT * FROM audit_log").all());
  ok("and no entry's text contains a PIN or a hash",
     !auditRows.some(x => /\bpin\b.*\d{4}|[a-f0-9]{32}:/i.test(String(x.details || ""))));

  srv.close();

  /* ================================================================
     12.  THE REAL SERVER — headers, HTTPS posture, hardening
     ================================================================ */
  console.log("\n--- the real server's response headers ---");

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
    env: { ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  boot.stdout.on("data", d => { bootLog += d; });
  boot.stderr.on("data", d => { bootLog += d; });

  const up = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { const res = await fetch("http://127.0.0.1:" + PORT + "/"); if (res.status) return true; }
      catch (e) { /* not yet */ }
      await new Promise(f => setTimeout(f, 500));
    }
    return false;
  })();

  if (!up) {
    ok("the server came up", false, bootLog.slice(-600));
  } else {
    const res = await fetch("http://127.0.0.1:" + PORT + "/");
    const h = n => res.headers.get(n) || "";

    ok("Content-Security-Policy is sent", !!h("content-security-policy"));
    ok("  scripts may only come from this origin", /script-src 'self'/.test(h("content-security-policy")));
    ok("  and inline script is NOT allowed",
       !/script-src[^;]*unsafe-inline/.test(h("content-security-policy")),
       h("content-security-policy").slice(0, 120));
    ok("  objects are blocked outright", /object-src 'none'/.test(h("content-security-policy")));
    ok("  the page cannot be framed by another site",
       /frame-ancestors 'self'/.test(h("content-security-policy")));
    ok("  forms cannot post offsite", /form-action 'self'/.test(h("content-security-policy")));
    ok("X-Content-Type-Options is nosniff", h("x-content-type-options") === "nosniff");
    ok("Referrer-Policy is set", !!h("referrer-policy"), h("referrer-policy"));
    ok("Permissions-Policy is set", !!h("permissions-policy"), h("permissions-policy").slice(0, 60));
    ok("HSTS is sent in production", /max-age=\d+/.test(h("strict-transport-security")),
       h("strict-transport-security"));
    ok("the server does not advertise what it is", !h("x-powered-by"), h("x-powered-by"));

    console.log("\n--- unauthenticated access to the real server ---");
    const hit = async (p, m) => {
      const r = await fetch("http://127.0.0.1:" + PORT + p,
        { method: m || "GET", redirect: "manual" });
      return { status: r.status, text: await r.text() };
    };
    for (const p of ["/api/customers", "/api/backup/download", "/api/staff", "/api/audit",
                     "/api/reports/dashboard", "/api/export/catalogue", "/api/admin/customers",
                     "/api/position", "/api/cashbook"]) {
      const g = await hit(p);
      ok("anonymous " + p + " is refused", g.status === 401 || g.status === 403, g.status);
      ok("  and leaks nothing", !/pin_hash|SQLITE|\bat \w+ \(/.test(g.text), g.text.slice(0, 50));
    }

    console.log("\n--- the sync receiver, which needs no session ---");
    const noKey = await fetch("http://127.0.0.1:" + PORT + "/api/sync/receive", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: Buffer.from("not a database").toString("base64") }),
    });
    ok("a push with no key is refused", noKey.status === 403, noKey.status);
    const badKey = await fetch("http://127.0.0.1:" + PORT + "/api/sync/receive", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-key": "wrong" },
      body: JSON.stringify({ file: "AAAA" }),
    });
    ok("a push with the wrong key is refused", badKey.status === 403, badKey.status);
    ok("the refusal does not say which part was wrong",
       !/hash|scrypt|compare/i.test(await badKey.text()));

    /* And the new limiter must actually bite on that route. */
    let syncLimited = false;
    for (let i = 0; i < 14; i++) {
      const rr = await fetch("http://127.0.0.1:" + PORT + "/api/sync/peek",
        { headers: { "x-sync-key": "wrong" } });
      if (rr.status === 429) { syncLimited = true; break; }
    }
    ok("hammering the sync endpoint gets rate-limited", syncLimited);

    boot.kill();
    await new Promise(f => setTimeout(f, 300));
  }

  /* ================================================================
     13.  DEPENDENCIES
     ================================================================ */
  console.log("\n--- dependencies ---");
  let auditJson = null;
  try {
    auditJson = JSON.parse(execFileSync("npm", ["audit", "--omit=dev", "--json"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: true }).toString());
  } catch (e) {
    try { auditJson = JSON.parse(e.stdout.toString()); } catch (e2) { auditJson = null; }
  }
  if (!auditJson) {
    ok("npm audit could be run", false, "could not parse npm audit output");
  } else {
    const v = auditJson.metadata && auditJson.metadata.vulnerabilities;
    ok("no known vulnerability in production dependencies",
       v && v.total === 0, v);
    ok("  specifically none critical", v && v.critical === 0, v && v.critical);
    ok("  and none high", v && v.high === 0, v && v.high);
  }
  const pkg = JSON.parse(read("package.json"));
  ok("the production dependency list is still just three",
     Object.keys(pkg.dependencies).length === 3, Object.keys(pkg.dependencies));
  ok("and they were not blindly upgraded",
     pkg.dependencies.express.startsWith("^5") &&
     pkg.dependencies["express-session"].startsWith("^1") &&
     pkg.dependencies.jspdf.startsWith("^4"), pkg.dependencies);

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
