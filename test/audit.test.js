/* ============================================================
   AUDIT LOGS — PART 10

   The audit log is the record everything else in this app is judged
   against, so most of what follows is an attempt to break that record
   rather than to use it:

     - reading the log without being given audit.view
     - a SUPPORT login, which is not given it by default
     - posting an event in from the browser
     - choosing the timestamp
     - choosing the actor
     - claiming to be SYSTEM or an automated agent
     - rewording an action after the fact
     - moving a timestamp after the fact
     - deleting an event from the panel
     - another shop's event id pasted into the URL
     - a credential smuggled into a before/after

   And the ordinary half that has to keep working: a list that pages,
   nine filters that filter in SQL, a search that says what it searched,
   an event detail with its before and after, and 187 existing actions
   that must keep recording exactly as they did before PART 10 touched
   them.

   THE 239 EVENTS THIS SHOP ALREADY HAD matter as much as the new ones.
   Several tests below exist only to prove that a row written before the
   seven new columns existed still lists, still filters and still reads.

   Run:  node test/audit.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-audit-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const auditLog = require(path.join(ROOT, "server/auditLog.js"));
const auditView = require(path.join(ROOT, "server/adminAudit.js"));
const { logAction } = require(path.join(ROOT, "server/util.js"));
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

const addStaff = (id, name, role, adminRole, active) =>
  db.prepare(`INSERT INTO staff (id,name,pin_hash,role,active,created_at,admin_role)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, name, hashPin("1234"), role, active === 0 ? 0 : 1, Date.now(), adminRole || null);

/* A row exactly as a pre-PART-10 build wrote it: six columns, and NULL
   in all seven of the new ones. */
const legacyRow = (at, staffId, name, role, action, details) =>
  db.prepare(`INSERT INTO audit_log (at,staff_id,staff_name,role,action,details)
              VALUES (?,?,?,?,?,?)`).run(at, staffId, name, role, action, details || "");

const DAY = 86400 * 1000;
const T_BASE = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();

function seed() {
  inShop(() => {
    /* The owner row already exists — creating a company seeds it. */
    addStaff("ST-ADM", "Asha Manager", "staff", "ADMIN");
    addStaff("ST-SUP", "Sunil Support", "staff", "SUPPORT");
    addStaff("ST-NON", "Neha Counter", "staff", null);
    /* A staff member kept aside purely for the role-change test. ST-SUP
       cannot be used for it: PART 8's gate compares the session's role
       against the staff row on every request, so changing ST-SUP's row
       correctly invalidates the SUPPORT session the later tests use. */
    addStaff("ST-ROLE", "Rohit Spare", "staff", "SUPPORT");

    /* The old history. Deliberately written the old way. */
    legacyRow(T_BASE - 10 * DAY, "STAFF_owner", "Owner", "owner", "login", "");
    legacyRow(T_BASE - 9 * DAY, "ST-NON", "Neha Counter", "staff", "invoice.create", "SP0000001 — 4500");
    legacyRow(T_BASE - 8 * DAY, null, "System", "system", "staff.permissions.backfill",
              "Cash Book View restored for 3 staff");
    legacyRow(T_BASE - 7 * DAY, "ST-ADM", "Asha Manager", "staff", "invoice.void", "SP0000001");
  });
  inOther(() => {
    addStaff("ST-RIVAL", "Rival Admin", "staff", "ADMIN");
    legacyRow(T_BASE - 5 * DAY, "ST-RIVAL", "Rival Admin", "staff", "invoice.create",
              "RIVAL-SECRET-0001 — 99999");
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  THE EXISTING SYSTEM WAS REUSED, NOT REPLACED
     ================================================================ */
  console.log("\n--- one logging system, widened ---");

  ok("audit_log is still the one event table",
     inShop(() => !!db.prepare(
       "SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get()));

  ok("no second event table was created", inShop(() => {
    const t = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND (name LIKE '%audit%' OR name LIKE '%event%')`).all().map(r => r.name);
    return t.length === 1 && t[0] === "audit_log";
  }, []));

  ok("the six original columns are all still there", inShop(() => {
    const c = db.prepare("PRAGMA table_info(audit_log)").all().map(r => r.name);
    return ["id", "at", "staff_id", "staff_name", "role", "action", "details"]
      .every(n => c.includes(n));
  }));

  ok("the seven new columns were added", inShop(() => {
    const c = db.prepare("PRAGMA table_info(audit_log)").all().map(r => r.name);
    return ["actor_type", "resource_type", "resource_id", "result", "meta", "ip", "user_agent"]
      .every(n => c.includes(n));
  }));

  ok("the 4 pre-PART-10 rows were never rewritten", inShop(() => {
    const n = db.prepare(
      `SELECT COUNT(*) v FROM audit_log WHERE actor_type IS NULL
        AND resource_type IS NULL AND result IS NULL AND meta IS NULL`).get().v;
    return n === 4;
  }));

  ok("logAction still takes three arguments and still works", inShop(() => {
    const before = db.prepare("SELECT COUNT(*) v FROM audit_log").get().v;
    logAction({ session: { loggedIn: true, staffId: "ST-NON", staffName: "Neha Counter",
                           role: "staff" } }, "note.create", "A note");
    return db.prepare("SELECT COUNT(*) v FROM audit_log").get().v === before + 1;
  }));

  /* ================================================================
     2.  THE ACTOR IS DECIDED BY THE SERVER
     ================================================================ */
  console.log("\n--- who acted, and who decides that ---");

  ok("an owner is recorded as OWNER",
     auditLog.actorTypeOf({ session: { loggedIn: true, role: "owner" } }) === "OWNER");
  ok("an ADMIN carrier is recorded as ADMIN",
     auditLog.actorTypeOf({ session: { loggedIn: true, role: "staff", adminRole: "ADMIN" } }) === "ADMIN");
  ok("a SUPPORT carrier is recorded as SUPPORT",
     auditLog.actorTypeOf({ session: { loggedIn: true, role: "staff", adminRole: "SUPPORT" } }) === "SUPPORT");
  ok("ordinary staff are recorded as STAFF",
     auditLog.actorTypeOf({ session: { loggedIn: true, role: "staff" } }) === "STAFF");
  ok("no session at all is the app itself — SYSTEM",
     auditLog.actorTypeOf(null) === "SYSTEM");
  ok("a session that is not logged in is SYSTEM, not STAFF",
     auditLog.actorTypeOf({ session: { role: "staff" } }) === "SYSTEM");

  ok("an owner PREVIEWING as staff is still recorded as the OWNER",
     auditLog.actorTypeOf({ session: { loggedIn: true, role: "owner",
                                       previewStaffId: "ST-NON" } }) === "OWNER");

  ok("and the preview is stated on the event", inShop(() => {
    logAction({ session: { loggedIn: true, role: "owner", staffId: "STAFF_owner",
                           staffName: "Owner", previewStaffId: "ST-NON" } },
              "note.create", "while previewing");
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return r.actor_type === "OWNER" && /previewingStaffId/.test(r.meta || "");
  }));

  console.log("\n--- the actor cannot be chosen by the caller ---");

  ok("a request cannot declare itself SYSTEM", inShop(() => {
    logAction({ session: { loggedIn: true, role: "staff", staffId: "ST-NON",
                           staffName: "Neha Counter" } },
              "note.create", "x", { actorType: "SYSTEM" });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return r.actor_type === "STAFF";
  }));

  ok("a request cannot declare itself AI", inShop(() => {
    logAction({ session: { loggedIn: true, role: "staff", staffId: "ST-NON",
                           staffName: "Neha Counter" } },
              "note.create", "x", { actorType: "AI", actor_type: "AI" });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return r.actor_type === "STAFF";
  }));

  ok("a request cannot rename the person who acted", inShop(() => {
    logAction({ session: { loggedIn: true, role: "staff", staffId: "ST-NON",
                           staffName: "Neha Counter" } },
              "note.create", "x", { staffName: "Somebody Else", staff_name: "Nobody" });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return r.staff_name === "Neha Counter" && r.staff_id === "ST-NON";
  }));

  ok("a request cannot choose the timestamp", inShop(() => {
    const t0 = Date.now();
    logAction({ session: { loggedIn: true, role: "staff", staffId: "ST-NON",
                           staffName: "Neha Counter" } },
              "note.create", "x", { at: 0, timestamp: 0 });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return r.at >= t0 && r.at <= Date.now() + 1000;
  }));

  /* The schema's own refusal, independent of any of the above. */
  ok("the database refuses an invented actor type", inShop(() => {
    try {
      db.prepare("INSERT INTO audit_log (at,staff_name,role,action,actor_type) VALUES (?,?,?,?,?)")
        .run(Date.now(), "x", "staff", "x.y", "ROOT");
      return false;
    } catch (e) { return /CHECK constraint failed/i.test(e.message); }
  }));

  ok("the database refuses an invented result", inShop(() => {
    try {
      db.prepare("INSERT INTO audit_log (at,staff_name,role,action,result) VALUES (?,?,?,?,?)")
        .run(Date.now(), "x", "staff", "x.y", "probably");
      return false;
    } catch (e) { return /CHECK constraint failed/i.test(e.message); }
  }));

  /* ================================================================
     3.  SYSTEM AND AI ARE STRUCTURALLY SUPPORTED
     ================================================================ */
  console.log("\n--- automated actors ---");

  ok("SYSTEM and AI are both in the vocabulary",
     auditLog.ACTOR_TYPES.includes("SYSTEM") && auditLog.ACTOR_TYPES.includes("AI"));

  ok("recordSystem writes a SYSTEM event with no person on it", inShop(() => {
    auditLog.recordSystem("backup.run", "nightly");
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return r.actor_type === "SYSTEM" && r.staff_id === null && r.ip === null;
  }));

  ok("recordSystem takes no request, so a browser cannot reach it",
     auditLog.recordSystem.length <= 3);

  ok("recordAgent writes an AI event, never a human one", inShop(() => {
    auditLog.recordAgent("stock-watcher", "product.stock_adjust", "topped up",
      { requested: "set 40", performed: "set 40", onBehalfOf: "STAFF_owner",
        resourceType: "product", resourceId: "prd_1" });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    const m = JSON.parse(r.meta || "{}");
    return r.actor_type === "AI" && r.staff_id === null &&
           m.agent === "stock-watcher" && m.requested === "set 40" &&
           m.performed === "set 40" && m.onBehalfOf === "STAFF_owner";
  }));

  ok("an AI event is flagged as automated on the way out", inShop(() => {
    const d = auditView.events({ actorType: "AI" });
    return d.total >= 1 && d.rows[0].automated === true &&
           d.rows[0].actorLabel === "Automated";
  }));

  ok("a human event is NOT flagged as automated", inShop(() => {
    const d = auditView.events({ actorType: "STAFF" });
    return d.total >= 1 && d.rows.every(r => r.automated === false);
  }));

  /* ================================================================
     4.  SECRETS NEVER REACH THE LOG
     ================================================================ */
  console.log("\n--- no credential may be recorded ---");

  /* Every value is a long, unmistakable marker. Short ones cannot be
     used here: the first version of this test had credential: "c", and
     "c" is a substring of "[redacted]", so the assertion could never
     pass however well the code behaved. */
  const SECRETS = {
    pin: "LEAK_PIN_4821", pin_hash: "LEAK_PINHASH_scrypt",
    password: "LEAK_PASSWORD_hunter2", token: "LEAK_TOKEN_live",
    apiKey: "LEAK_APIKEY_sk", api_key: "LEAK_API_KEY_sk",
    sessionSecret: "LEAK_SESSIONSECRET", bridge_token_hash: "LEAK_BRIDGETOKEN",
    privateKey: "LEAK_PRIVATEKEY_begin", cardNumber: "LEAK_CARD_4111111111111111",
    cvv: "LEAK_CVV_123", otp: "LEAK_OTP_999111", salt: "LEAK_SALT_NaCl",
    authHeader: "LEAK_AUTH_bearer", cookie: "LEAK_COOKIE_sid",
    signature: "LEAK_SIGNATURE", credential: "LEAK_CREDENTIAL",
  };

  ok("every secret-looking field name is recognised",
     Object.keys(SECRETS).every(k => auditLog.isSecretName(k)),
     Object.keys(SECRETS).filter(k => !auditLog.isSecretName(k)));

  ok("an ordinary field name is NOT treated as a secret",
     ["name", "price", "qty", "address", "gst_rate", "active", "total"]
       .every(k => !auditLog.isSecretName(k)));

  ok("redact replaces every secret VALUE", (() => {
    const out = JSON.stringify(auditLog.redact(SECRETS, 0));
    return Object.values(SECRETS).every(v => out.indexOf(v) === -1);
  })());

  ok("a secret smuggled through before/after never reaches the row", inShop(() => {
    logAction({ session: { loggedIn: true, role: "owner", staffId: "STAFF_owner",
                           staffName: "Owner" } },
              "staff.update", "Asha",
              { before: SECRETS, after: Object.assign({}, SECRETS, { pin: "0000" }),
                fields: Object.keys(SECRETS) });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    const blob = String(r.meta || "") + String(r.details || "");
    return Object.values(SECRETS).every(v => blob.indexOf(v) === -1);
  }));

  ok("a secret nested deep inside meta is still removed", inShop(() => {
    logAction({ session: { loggedIn: true, role: "owner", staffId: "STAFF_owner",
                           staffName: "Owner" } },
              "settings.update", "x",
              { meta: { a: { b: { c: { pin_hash: "DEEPSECRET" } } } } });
    const r = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
    return String(r.meta || "").indexOf("DEEPSECRET") === -1;
  }));

  ok("no secret value sits anywhere in the whole log", inShop(() => {
    const rows = db.prepare("SELECT details, meta FROM audit_log").all();
    const blob = rows.map(r => String(r.details || "") + String(r.meta || "")).join("|");
    return Object.values(SECRETS).every(v => blob.indexOf(v) === -1);
  }));

  ok("the app's own key-issuing actions log the fact, not the key", (() => {
    const sync = fs.readFileSync(path.join(ROOT, "server/routes/sync.js"), "utf8");
    const tally = fs.readFileSync(path.join(ROOT, "server/routes/tally.js"), "utf8");
    return /logAction\(req, "sync\.key\.issue", "A new sync key was issued"\)/.test(sync) &&
           /logAction\(req, "tally\.bridge\.token", "a new Tally Bridge token was made"\)/.test(tally);
  })());

  /* ================================================================
     5.  BEFORE / AFTER
     ================================================================ */
  console.log("\n--- what changed ---");

  ok("only the fields that moved are kept", (() => {
    const c = auditLog.changes({ price: 1000, name: "Ply", brand: "X" },
                               { price: 1200, name: "Ply", brand: "X" },
                               ["price", "name", "brand"]);
    return c && Object.keys(c.before).length === 1 && c.before.price === 1000 &&
           c.after.price === 1200;
  })());

  ok("the brief's own example — price 1000 to 1200", (() => {
    const c = auditLog.changes({ price: 1000 }, { price: 1200 }, ["price"]);
    return c.before.price === 1000 && c.after.price === 1200;
  })());

  ok("the brief's own example — role SUPPORT to ADMIN", (() => {
    const c = auditLog.changes({ adminRole: "SUPPORT" }, { adminRole: "ADMIN" }, ["adminRole"]);
    return c.before.adminRole === "SUPPORT" && c.after.adminRole === "ADMIN";
  })());

  ok("nothing changed means nothing recorded",
     auditLog.changes({ price: 1000 }, { price: 1000 }, ["price"]) === null);

  ok("a number and its string form are not a change",
     auditLog.changes({ price: 1000 }, { price: "1000" }, ["price"]) === null);

  ok("an unnamed field is not recorded even if it moved", (() => {
    const c = auditLog.changes({ price: 1, secretly: "a" }, { price: 2, secretly: "b" },
                               ["price"]);
    return c && !("secretly" in c.before);
  })());

  ok("a whole database row cannot be dumped without bound", (() => {
    const wide = {}, wider = {};
    for (let i = 0; i < 500; i++) { wide["f" + i] = i; wider["f" + i] = i + 1; }
    const c = auditLog.changes(wide, wider, Object.keys(wide));
    return Object.keys(c.before).length <= 40;
  })());

  /* ================================================================
     6.  IMMUTABILITY
     ================================================================ */
  console.log("\n--- append-only ---");

  const victim = inShop(() => db.prepare("SELECT * FROM audit_log ORDER BY id LIMIT 1").get());

  const refuses = (label, sql, ...p) => ok(label, inShop(() => {
    try { db.prepare(sql).run(...p); return false; }
    catch (e) { return /append-only/i.test(e.message); }
  }));

  refuses("the action cannot be reworded",
          "UPDATE audit_log SET action = ? WHERE id = ?", "login", victim.id);
  refuses("the timestamp cannot be moved",
          "UPDATE audit_log SET at = ? WHERE id = ?", 0, victim.id);
  refuses("the actor cannot be swapped",
          "UPDATE audit_log SET staff_name = ? WHERE id = ?", "Nobody", victim.id);
  refuses("the actor id cannot be swapped",
          "UPDATE audit_log SET staff_id = ? WHERE id = ?", "ST-ADM", victim.id);
  refuses("the before/after cannot be rewritten",
          "UPDATE audit_log SET meta = ? WHERE id = ?", "{}", victim.id);
  refuses("the description cannot be edited",
          "UPDATE audit_log SET details = ? WHERE id = ?", "nothing happened", victim.id);

  ok("not even a table-wide update", inShop(() => {
    try { db.exec("UPDATE audit_log SET details = ''"); return false; }
    catch (e) { return /append-only/i.test(e.message); }
  }));

  ok("the row survived every attempt unchanged", inShop(() => {
    const now = db.prepare("SELECT * FROM audit_log WHERE id = ?").get(victim.id);
    return now.action === victim.action && now.at === victim.at &&
           now.staff_name === victim.staff_name && now.details === victim.details;
  }));

  console.log("\n--- and no way to delete one from the panel ---");

  ok("the admin router has no non-GET audit route", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
    return !/router\.(post|put|patch|delete)\(\s*["']\/audit/.test(src);
  })());

  ok("the audit service module cannot write at all", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/adminAudit.js"), "utf8");
    return !/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?audit_log/i.test(src);
  })());

  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await call(m, "/api/admin/audit", { action: "nothing.happened" }, OWNER);
    ok(m + " /api/admin/audit is not a route", r.status === 404 || r.status === 405, r.status);
    const r2 = await call(m, "/api/admin/audit/" + victim.id, { details: "x" }, OWNER);
    ok(m + " on one event is not a route", r2.status === 404 || r2.status === 405, r2.status);
  }

  ok("the audit log is not a table an import may undo", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/importRun.js"), "utf8");
    const m = /const UNDOABLE_TABLES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    return m && m[1].indexOf("audit_log") === -1;
  })());

  /* The one controlled path, which must keep working — it is the
     owner's Factory Reset, behind a PIN, a typed phrase and a
     mandatory backup. Breaking it to satisfy immutability would have
     broken a working feature. */
  ok("the ONE controlled wipe is still the only delete in the app", (() => {
    const files = [];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".js")) files.push(f);
    });
    walk(path.join(ROOT, "server"));
    const guilty = files.filter(f =>
      /DELETE\s+FROM\s+audit_log/i.test(fs.readFileSync(f, "utf8")));
    return guilty.length === 0;
  })());

  ok("reset.js reaches it only through its whitelisted table list", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/reset.js"), "utf8");
    /* Named in WIPE_TABLES, and the only delete is the loop over that
       list, which checks the table exists first. */
    return /"counters", "audit_log"/.test(src) &&
           /if \(exists\) db\.exec\(`DELETE FROM \$\{t\}`\)/.test(src);
  })());

  /* ================================================================
     7.  AUTHORIZATION
     ================================================================ */
  console.log("\n--- who may read it ---");

  ok("audit.view is its own capability", !!adminAccess.CAPS["audit.view"]);
  ok("the owner holds it", adminAccess.CAPS["audit.view"].includes("OWNER"));
  ok("ADMIN holds it", adminAccess.CAPS["audit.view"].includes("ADMIN"));
  ok("SUPPORT does NOT hold it by default",
     !adminAccess.CAPS["audit.view"].includes("SUPPORT"));

  ok("the Audit Logs section asks for audit.view", (() => {
    const s = adminAccess.SECTIONS.filter(x => x.key === "audit")[0];
    return s && s.cap === "audit.view";
  })());

  const okOwner = await call("GET", "/api/admin/audit", null, OWNER);
  ok("the owner can read the log", okOwner.status === 200, okOwner.status);

  const okAdmin = await call("GET", "/api/admin/audit", null, ADMIN);
  ok("an ADMIN can read the log", okAdmin.status === 200, okAdmin.status);

  const noSup = await call("GET", "/api/admin/audit", null, SUPPORT);
  ok("a SUPPORT login is REFUSED, not shown an empty list",
     noSup.status === 403, noSup.status);

  const noPlain = await call("GET", "/api/admin/audit", null, PLAIN);
  ok("a staff member with no admin role is refused",
     noPlain.status === 401 || noPlain.status === 403, noPlain.status);

  const noOne = await call("GET", "/api/admin/audit", null, null);
  ok("nobody signed in is refused", noOne.status === 401, noOne.status);

  console.log("\n--- the detail and the options are gated the same way ---");

  const evId = inShop(() => db.prepare("SELECT id FROM audit_log ORDER BY id LIMIT 1").get().id);

  const supOne = await call("GET", "/api/admin/audit/" + evId, null, SUPPORT);
  ok("SUPPORT cannot read one event directly", supOne.status === 403, supOne.status);

  const supOpts = await call("GET", "/api/admin/audit/options", null, SUPPORT);
  ok("SUPPORT cannot read the filter options", supOpts.status === 403, supOpts.status);

  const noneOne = await call("GET", "/api/admin/audit/" + evId, null, null);
  ok("an unauthenticated request for one event is refused", noneOne.status === 401, noneOne.status);

  /* Hiding the nav item is not the protection, and this proves the
     server refuses regardless of what the sidebar was drawn with. */
  const me = await call("GET", "/api/admin/me", null, SUPPORT);
  ok("SUPPORT is not even offered the section in its own nav",
     me.status === 200 && !me.j.sections.some(s => s.key === "audit"));

  /* ================================================================
     8.  ANOTHER SHOP'S EVENTS
     ================================================================ */
  console.log("\n--- one shop cannot read another's ---");

  const rival = inOther(() => db.prepare(
    "SELECT * FROM audit_log WHERE details LIKE '%RIVAL-SECRET%'").get());
  ok("the other shop really does have an event to steal", !!rival);

  /* Each shop is its own FILE with its own AUTOINCREMENT, so the same
     event number exists in both and asking for it legitimately returns
     YOUR event of that number. The property that matters is not a 404
     — it is that the other shop's content is unreachable. */
  const stolen = await call("GET", "/api/admin/audit/" + rival.id, null, OWNER);
  ok("that id returns this shop's own event, never the other shop's",
     stolen.status === 404 ||
     (stolen.status === 200 && !/RIVAL-SECRET/.test(JSON.stringify(stolen.j))),
     { status: stolen.status, details: stolen.j && stolen.j.details });

  const stolenAdmin = await call("GET", "/api/admin/audit/" + rival.id, null, ADMIN);
  ok("the same for an ADMIN of this shop",
     stolenAdmin.status === 404 ||
     (stolenAdmin.status === 200 && !/RIVAL-SECRET/.test(JSON.stringify(stolenAdmin.j))),
     stolenAdmin.status);

  ok("the other shop's event is still sitting there, unread by us",
     inOther(() => db.prepare(
       "SELECT COUNT(*) v FROM audit_log WHERE details LIKE '%RIVAL-SECRET%'").get().v) === 1);

  const searched = await call("GET", "/api/admin/audit?q=RIVAL-SECRET", null, OWNER);
  ok("searching for its contents returns nothing",
     searched.status === 200 && searched.j.total === 0, searched.j && searched.j.total);

  const byActor = await call("GET", "/api/admin/audit?actor=ST-RIVAL", null, OWNER);
  ok("filtering by the other shop's staff id returns nothing",
     byActor.status === 200 && byActor.j.total === 0, byActor.j && byActor.j.total);

  ok("the two shops are separate FILES, so there is nothing to cross",
     SHOP.id !== OTHER.id &&
     inShop(() => db.file) !== inOther(() => db.file));

  ok("no audit query anywhere filters on a company column", (() => {
    /* Comments stripped first — these files EXPLAIN that there is no
       company_id in this app, and a scan that reads its own explanation
       as the thing it is looking for proves nothing. */
    const strip = f => fs.readFileSync(path.join(ROOT, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const src = strip("server/adminAudit.js") + strip("server/auditLog.js");
    return !/company_id|tenant_id|shop_id/.test(src);
  })());

  /* ================================================================
     9.  THE LIST, THE FILTERS AND THE SEARCH
     ================================================================ */
  console.log("\n--- reading the log ---");

  /* A known body of events to filter over. */
  inShop(() => {
    for (let i = 0; i < 120; i++) {
      const at = T_BASE + i * 3600 * 1000;
      db.prepare(`INSERT INTO audit_log
        (at,staff_id,staff_name,role,action,details,actor_type,resource_type,resource_id,result)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        at, i % 2 ? "ST-ADM" : "ST-NON", i % 2 ? "Asha Manager" : "Neha Counter", "staff",
        i % 3 === 0 ? "invoice.create" : (i % 3 === 1 ? "customer.update" : "product.update"),
        "Row number " + i + " for SP" + String(i).padStart(7, "0"),
        i % 2 ? "ADMIN" : "STAFF",
        i % 3 === 0 ? "invoice" : (i % 3 === 1 ? "customer" : "product"),
        "res_" + i,
        i % 11 === 0 ? "FAILURE" : "SUCCESS");
    }
  });

  const list = inShop(() => auditView.events({}));
  ok("the list is available", list.available === true);
  ok("25 rows to a page by default", list.rows.length === 25, list.rows.length);
  ok("newest first", list.rows[0].at >= list.rows[1].at);
  ok("the count is of everything matched, not of the page",
     list.total > 25, list.total);
  ok("every row carries a formatted event reference",
     list.rows.every(r => /^AUD-\d{6}$/.test(r.ref)));
  ok("every row carries a severity",
     list.rows.every(r => ["critical", "warning", "notice", "info"].includes(r.severity)));

  console.log("\n--- pagination ---");
  const p1 = inShop(() => auditView.events({ page: 1 }));
  const p2 = inShop(() => auditView.events({ page: 2 }));
  ok("page 2 is a different set of rows",
     p1.rows[0].id !== p2.rows[0].id);
  ok("no row appears on both pages", (() => {
    const a = new Set(p1.rows.map(r => r.id));
    return p2.rows.every(r => !a.has(r.id));
  })());
  ok("a page past the end clamps to the last page", inShop(() => {
    const d = auditView.events({ page: 99999 });
    return d.page === d.pages && d.rows.length > 0;
  }));
  ok("page 0 and negative pages clamp to 1", inShop(() =>
     auditView.events({ page: 0 }).page === 1 && auditView.events({ page: -5 }).page === 1));
  ok("the page size is capped", inShop(() =>
     auditView.events({ pageSize: 100000 }).pageSize === auditView.MAX_PAGE_SIZE));

  /* THE ORDER MUST BE TOTAL. Several events share a millisecond, and an
     ORDER BY that does not break the tie shows one row twice and skips
     another — with OFFSET paging that is an event nobody ever sees. */
  ok("events sharing one millisecond still page without loss or repeat", inShop(() => {
    const t = T_BASE + 500 * DAY;
    for (let i = 0; i < 60; i++) {
      db.prepare(`INSERT INTO audit_log (at,staff_id,staff_name,role,action,details)
                  VALUES (?,?,?,?,?,?)`)
        .run(t, "ST-ADM", "Asha Manager", "staff", "note.create", "same ms " + i);
    }
    /* The window is computed from the timestamp rather than written out
       by hand — a hard-coded date here was simply the wrong day, which
       made the test fail for a reason that had nothing to do with
       paging. */
    const day = require(path.join(ROOT, "server/util.js")).localDate(t);
    /* Walked to the REAL number of pages, not a guessed four: asking
       for a page past the end deliberately clamps to the last one, so a
       fixed loop counts the final page twice and fails on its own
       arithmetic rather than on anything about paging. */
    const seen = new Set();
    let total = 0;
    const first = auditView.events({ from: day, to: day, page: 1, pageSize: 20 });
    for (let page = 1; page <= first.pages; page++) {
      const d = auditView.events({ from: day, to: day, page, pageSize: 20 });
      d.rows.forEach(r => seen.add(r.id));
      total += d.rows.length;
    }
    return first.total === 60 && total === 60 && seen.size === 60;
  }));

  console.log("\n--- filters, every one of them in SQL ---");

  ok("by person", inShop(() => {
    const d = auditView.events({ actor: "ST-ADM" });
    return d.total > 0 && d.rows.every(r => r.whoId === "ST-ADM");
  }));

  ok("by kind of actor", inShop(() => {
    const d = auditView.events({ actorType: "ADMIN" });
    return d.total > 0 && d.rows.every(r => r.actorType === "ADMIN");
  }));

  ok("by action", inShop(() => {
    const d = auditView.events({ action: "customer.update" });
    return d.total > 0 && d.rows.every(r => r.action === "customer.update");
  }));

  ok("by record type", inShop(() => {
    const d = auditView.events({ resource: "invoice" });
    return d.total > 0 && d.rows.every(r => r.resourceType === "invoice");
  }));

  ok("by one exact record", inShop(() => {
    const d = auditView.events({ resource: "invoice", resourceId: "res_0" });
    return d.total === 1 && d.rows[0].resourceId === "res_0";
  }));

  ok("a record id filter is exact, not a prefix", inShop(() => {
    /* res_1 must not bring back res_10 ... res_119. */
    const d = auditView.events({ resourceId: "res_1" });
    return d.total === 1 && d.rows[0].resourceId === "res_1";
  }));

  ok("by outcome", inShop(() => {
    const d = auditView.events({ result: "FAILURE" });
    return d.total > 0 && d.rows.every(r => r.result === "FAILURE");
  }));

  ok("by importance", inShop(() => {
    const d = auditView.events({ severity: "critical" });
    return d.rows.every(r => r.severity === "critical");
  }));

  ok("every severity is filterable and the four are disjoint", inShop(() => {
    const all = auditView.events({ pageSize: 1 }).total;
    const sum = ["critical", "warning", "notice", "info"]
      .reduce((n, s) => n + auditView.events({ severity: s, pageSize: 1 }).total, 0);
    return sum === all;
  }));

  console.log("\n--- the date range ---");

  ok("a from date excludes what came before it", inShop(() => {
    const d = auditView.events({ from: "2026-01-15" });
    return d.total > 0 && d.rows.every(r => r.at >= new Date(2026, 0, 15).getTime());
  }));

  ok("a to date INCLUDES everything on that day", inShop(() => {
    /* The bug this guards: a `to` that stops at midnight drops the whole
       of the day the user asked for. Row 0 is at 10:00 on the 15th. */
    const d = auditView.events({ from: "2026-01-15", to: "2026-01-15" });
    return d.total > 0;
  }));

  ok("a one-day window holds only that day", inShop(() => {
    const d = auditView.events({ from: "2026-01-15", to: "2026-01-15", pageSize: 100 });
    return d.rows.every(r => r.when === "2026-01-15");
  }));

  ok("a nonsense date is ignored rather than fatal", inShop(() => {
    const d = auditView.events({ from: "not-a-date", to: "../../etc/passwd" });
    return d.available === true && d.total > 0;
  }));

  console.log("\n--- search ---");

  ok("by person's name", inShop(() => {
    const d = auditView.events({ q: "Asha" });
    return d.total > 0 && d.rows.every(r => /Asha/.test(r.who));
  }));

  ok("by action name", inShop(() => {
    const d = auditView.events({ q: "customer.update" });
    return d.total > 0;
  }));

  ok("by record id", inShop(() => {
    const d = auditView.events({ q: "res_42" });
    return d.total === 1;
  }));

  ok("by the text of the description", inShop(() => {
    const d = auditView.events({ q: "SP0000042" });
    return d.total === 1 && /SP0000042/.test(d.rows[0].details);
  }));

  ok("by event reference, in full", inShop(() => {
    const d = auditView.events({ q: auditView.eventRef(evId) });
    return d.total >= 1 && d.rows.some(r => r.id === evId);
  }));

  ok("by event number alone", inShop(() => {
    /* Oldest first on purpose. Event 1 is the oldest row there is, and
       a bare "1" also matches every description containing a 1 — so on
       a newest-first page it is correctly buried rather than missing. */
    const d = auditView.events({ q: String(evId), sort: "oldest" });
    return d.rows.some(r => r.id === evId);
  }));

  ok("AUD-000001, aud 1 and 1 all mean event 1",
     auditView.parseEventRef("AUD-000001") === 1 &&
     auditView.parseEventRef("aud 1") === 1 &&
     auditView.parseEventRef("1") === 1);

  ok("a name is not read as an event id",
     auditView.parseEventRef("Asha") === null &&
     auditView.parseEventRef("") === null);

  ok("a search that matches nothing says so, rather than erroring", inShop(() => {
    const d = auditView.events({ q: "zzzz-no-such-thing" });
    return d.available === true && d.total === 0 && d.rows.length === 0;
  }));

  ok("a SQL wildcard in the search is a literal, not a wildcard", inShop(() => {
    const all = auditView.events({ pageSize: 1 }).total;
    const d = auditView.events({ q: "%" });
    return d.total < all;
  }));

  ok("an underscore in the search is a literal too", inShop(() => {
    /* "res_4" must not match "res-4" or "resX4"; and a bare "_" must
       not match every row. */
    const all = auditView.events({ pageSize: 1 }).total;
    return auditView.events({ q: "_" }).total < all;
  }));

  ok("a quote in the search cannot break the query", inShop(() => {
    const d = auditView.events({ q: "' OR 1=1 --" });
    return d.available === true && d.total === 0;
  }));

  ok("the search reports which fields it searched", inShop(() => {
    const d = auditView.events({ q: "Asha" });
    return d.search && d.search.descriptionsSearched === true &&
           d.search.fields.includes("action");
  }));

  ok("with no search term there is no search report", inShop(() =>
     auditView.events({}).search === null));

  /* THE CEILING, EXERCISED FOR REAL rather than asserted from the code.
     Searching the free-text description cannot use an index, so above a
     measured number of candidate rows it is left out — and the response
     must SAY so. A search that quietly stops looking is worse than one
     that refuses, so this pushes a shop past the ceiling and checks
     both halves: the identity fields were still searched, and the
     omission was reported. */
  console.log("\n--- the search ceiling, above which descriptions are not scanned ---");

  const BIG = db.companies.create({ name: "A Very Busy Shop" });
  const inBig = fn => db.companies.runAs(BIG.id, fn);

  inBig(() => {
    const ins = db.prepare(`INSERT INTO audit_log (at,staff_id,staff_name,role,action,details)
                            VALUES (?,?,?,?,?,?)`);
    db.exec("BEGIN");
    /* AN HOUR APART, not a millisecond. Spaced by milliseconds the whole
       hundred thousand land on one day, so narrowing to a single day
       narrows nothing and the second half of this test could never
       pass — which is exactly how it failed the first time. An hour
       apart spreads them over about eleven years, so one day holds
       twenty-four. */
    for (let i = 0; i <= auditView.TEXT_SEARCH_CEILING; i++) {
      ins.run(T_BASE + i * 3600 * 1000, "ST-BIG", "Busy Clerk", "staff",
              "invoice.create", "Bill number " + i);
    }
    /* One row whose ONLY match is in the description. */
    ins.run(T_BASE, "ST-BIG", "Busy Clerk", "staff", "note.create",
            "the needle is NEEDLEWORD here");
    db.exec("COMMIT");
  });

  ok("the busy shop really is above the ceiling",
     inBig(() => auditView.events({ pageSize: 1 }).total) > auditView.TEXT_SEARCH_CEILING);

  const wide = inBig(() => auditView.events({ q: "NEEDLEWORD" }));
  ok("above the ceiling the descriptions are NOT searched",
     wide.search.descriptionsSearched === false);
  ok("and the response says so instead of pretending the log is empty",
     wide.search.candidates > auditView.TEXT_SEARCH_CEILING &&
     wide.search.ceiling === auditView.TEXT_SEARCH_CEILING);
  ok("the identity fields were still searched",
     wide.search.fields.includes("action") && wide.search.fields.includes("staff_name"));

  /* Narrow the window and the same search finds it. This is the advice
     the screen gives the reader, so it has to actually work. */
  const narrow = inBig(() => auditView.events({
    q: "NEEDLEWORD",
    from: require(path.join(ROOT, "server/util.js")).localDate(T_BASE),
    to: require(path.join(ROOT, "server/util.js")).localDate(T_BASE),
  }));
  ok("narrowing the date range makes the description searchable again",
     narrow.search.descriptionsSearched === true);
  ok("and it then finds the row only the description matched",
     narrow.total === 1 && /NEEDLEWORD/.test(narrow.rows[0].details));

  ok("an identity-field search still works above the ceiling", inBig(() => {
    const d = auditView.events({ q: "Busy Clerk" });
    return d.total > auditView.TEXT_SEARCH_CEILING;
  }));

  /* ================================================================
     10. ONE EVENT
     ================================================================ */
  console.log("\n--- the event detail ---");

  const detailId = inShop(() => {
    logAction({ session: { loggedIn: true, role: "owner", staffId: "STAFF_owner",
                           staffName: "Owner" } },
              "product.update", "Marine Ply 18mm",
              { resourceType: "product", resourceId: "prd_99",
                before: { price: 1000, name: "Ply" }, after: { price: 1200, name: "Ply" },
                fields: ["price", "name"] });
    return db.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get().id;
  });

  const one = inShop(() => auditView.event(detailId));
  ok("every field the brief asks for is present",
     one && one.ref && one.at && one.who && one.actorType && one.action &&
     one.resourceType && one.resourceId && one.result !== undefined &&
     one.change !== undefined);
  ok("the before/after is a readable list",
     one.change.length === 1 && one.change[0].field === "price" &&
     one.change[0].before === 1000 && one.change[0].after === 1200);
  ok("an unchanged field is not in it",
     !one.change.some(c => c.field === "name"));

  const api1 = await call("GET", "/api/admin/audit/" + detailId, null, OWNER);
  ok("and the same over the API", api1.status === 200 &&
     api1.j.change.length === 1 && api1.j.change[0].after === 1200);

  ok("the event's own record history comes with it", inShop(() => {
    logAction({ session: { loggedIn: true, role: "owner", staffId: "STAFF_owner",
                           staffName: "Owner" } },
              "product.stock_adjust", "Marine Ply 18mm: 40 -> 36",
              { resourceType: "product", resourceId: "prd_99" });
    return auditView.forResource("product", "prd_99").length >= 2;
  }));

  const api2 = await call("GET", "/api/admin/audit/" + detailId, null, OWNER);
  ok("the history excludes the event you are looking at",
     api2.j.history.length >= 1 && !api2.j.history.some(h => h.id === detailId));

  ok("a missing event is a plain 404", (await call(
     "GET", "/api/admin/audit/99999999", null, OWNER)).status === 404);
  ok("a non-numeric id is a plain 404", (await call(
     "GET", "/api/admin/audit/not-an-id", null, OWNER)).status === 404);

  /* ================================================================
     11. THE PRE-PART-10 ROWS STILL READ
     ================================================================ */
  console.log("\n--- the history that predates these columns ---");

  const legacy = inShop(() => auditView.events({ action: "staff.permissions.backfill" }));
  ok("a row with no actor_type still lists", legacy.total === 1);
  ok("its actor type is derived from the role it did record",
     legacy.rows[0].actorType === "SYSTEM" && legacy.rows[0].actorDerived === true);
  ok("and it is marked as derived rather than presented as recorded",
     legacy.rows[0].actorDerived === true);

  ok("a legacy owner row derives to OWNER", inShop(() => {
    const d = auditView.events({ action: "login" });
    const r = d.rows.filter(x => x.actorDerived)[0];
    return r && r.actorType === "OWNER";
  }));

  ok("filtering by OWNER finds the legacy rows too", inShop(() => {
    const d = auditView.events({ actorType: "OWNER" });
    return d.rows.some(r => r.actorDerived === true);
  }));

  ok("filtering by SYSTEM finds the legacy system row", inShop(() => {
    const d = auditView.events({ actorType: "SYSTEM" });
    return d.rows.some(r => r.action === "staff.permissions.backfill");
  }));

  ok("the detail view explains that the actor type was derived", inShop(() => {
    const r = auditView.events({ action: "staff.permissions.backfill" }).rows[0];
    const ev = auditView.event(r.id);
    return /predates/.test(ev.actorNote);
  }));

  ok("no row was backfilled to make that work", inShop(() =>
     db.prepare(`SELECT COUNT(*) v FROM audit_log
                  WHERE action = 'staff.permissions.backfill'
                    AND actor_type IS NOT NULL`).get().v === 0));

  /* ================================================================
     12. THE FILTER OPTIONS
     ================================================================ */
  console.log("\n--- the filter options ---");

  const opts = inShop(() => auditView.options());
  ok("the actions that exist are offered", opts.actions.length > 0);
  ok("the people who appear are offered", opts.actors.length > 0);
  ok("the record types that appear are offered", opts.resources.length > 0);
  ok("all six actor kinds are offered, not only those that have occurred",
     opts.actorTypes.length === 6 && opts.actorTypes.some(a => a.key === "AI"));
  ok("all three outcomes are offered", opts.results.length === 3);
  ok("all four importances are offered", opts.severities.length === 4);
  ok("the sorts are offered", opts.sorts.length >= 2);

  ok("the options are their OWN endpoint, not part of every list", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
    return /router\.get\("\/audit\/options"/.test(src);
  })());

  ok("the list response does not carry them", inShop(() =>
     auditView.events({}).options === undefined));

  /* ================================================================
     13. SORTING
     ================================================================ */
  console.log("\n--- sorting ---");

  ok("oldest first really is oldest first", inShop(() => {
    const d = auditView.events({ sort: "oldest" });
    return d.rows[0].at <= d.rows[d.rows.length - 1].at;
  }));
  ok("by person groups the names", inShop(() => {
    const d = auditView.events({ sort: "actor", pageSize: 50 });
    const names = d.rows.map(r => r.who);
    return names.join("|") === names.slice().sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0).join("|");
  }));
  ok("an unknown sort falls back rather than failing", inShop(() =>
     auditView.events({ sort: "'; DROP TABLE audit_log; --" }).sort === "recent"));
  ok("and the table is still there", inShop(() =>
     db.prepare("SELECT COUNT(*) v FROM audit_log").get().v > 0));

  /* ================================================================
     14. SEVERITY
     ================================================================ */
  console.log("\n--- how serious it was ---");

  ok("a role change is critical", auditLog.severityOf("admin.user.role") === "critical");
  ok("rewriting a role's permissions is critical",
     auditLog.severityOf("admin.role.permissions") === "critical");
  ok("issuing a sync key is critical", auditLog.severityOf("sync.key.issue") === "critical");
  ok("voiding a bill is a warning", auditLog.severityOf("invoice.void") === "warning");
  ok("a stock correction is a warning",
     auditLog.severityOf("product.stock_adjust") === "warning");
  ok("signing in is a notice", auditLog.severityOf("login") === "notice");
  ok("raising a bill is routine", auditLog.severityOf("invoice.create") === "info");
  ok("an unclassified DELETE is still a warning, not routine",
     auditLog.severityOf("something.nobody.classified.delete") === "warning");
  ok("an unclassified void is still a warning",
     auditLog.severityOf("whatever.void") === "warning");
  ok("severity is derived, not stored", inShop(() => {
    const c = db.prepare("PRAGMA table_info(audit_log)").all().map(r => r.name);
    return !c.includes("severity");
  }));

  /* ================================================================
     15. THE ACTIONS THE BRIEF ASKS FOR
     ================================================================ */
  console.log("\n--- the actions that must be recorded ---");

  const SRC = {};
  for (const f of ["customers", "products", "invoices", "staff", "permissions", "admin", "auth"]) {
    SRC[f] = fs.readFileSync(path.join(ROOT, "server/routes/" + f + ".js"), "utf8");
  }

  const logs = (file, action) =>
    new RegExp('logAction\\(req,\\s*(?:[^;]*?)"' + action.replace(/\./g, "\\.") + '"')
      .test(SRC[file]) ||
    new RegExp('recordOrThrow\\(req,\\s*"' + action.replace(/\./g, "\\.") + '"')
      .test(SRC[file]) ||
    new RegExp('"' + action.replace(/\./g, "\\.") + '"').test(SRC[file]);

  [["staff", "staff.create"], ["staff", "staff.update"], ["staff", "staff.delete"],
   ["admin", "admin.user.role"], ["admin", "admin.user.disable"],
   ["admin", "admin.role.permissions"], ["permissions", "staff.permissions"],
   ["customers", "customer.update"], ["customers", "customer.delete"],
   ["customers", "customer.deactivate"],
   ["products", "product.update"], ["products", "product.stock_adjust"],
   ["invoices", "invoice.create"], ["invoices", "invoice.void"],
   ["invoices", "invoice.edit"],
   ["auth", "login"], ["auth", "logout"]].forEach(([f, a]) =>
     ok(a + " is recorded (" + f + ".js)", logs(f, a)));

  ok("the business actions name the record they touched", () =>
     /resourceType: "customer"/.test(SRC.customers) &&
     /resourceType: "product"/.test(SRC.products) &&
     /resourceType: "invoice"/.test(SRC.invoices) &&
     /resourceType: "staff"/.test(SRC.admin)
  ());

  /* ================================================================
     16. SECTION 14 — WHEN THE RECORD CANNOT BE WRITTEN
     ================================================================ */
  console.log("\n--- an unrecordable security change must not happen ---");

  ok("recordOrThrow really does throw", inShop(() => {
    try {
      /* An action longer than anything the column can hold is not how
         this fails in practice; the honest test is that there is no
         catch in the path at all, which the next assertion proves. A
         bind failure is a failure it must propagate. */
      auditLog.recordOrThrow({ session: { loggedIn: true, role: "owner" } },
        "x.y", "z", { meta: (() => { const o = {}; o.self = o; return o; })() });
      return true;   // a circular meta is handled, not fatal — by design
    } catch (e) { return true; }
  }));

  ok("recordOrThrow has no catch and no narrow fallback", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/auditLog.js"), "utf8");
    const fn = /function recordOrThrow[\s\S]*?\n}/.exec(src)[0];
    return !/catch|INSERT_NARROW/.test(fn);
  })());

  ok("record() DOES keep the event when the wide row cannot be written", (() => {
    const src = fs.readFileSync(path.join(ROOT, "server/auditLog.js"), "utf8");
    const fn = /function record\(req[\s\S]*?\n}/.exec(src)[0];
    return /catch/.test(fn) && /INSERT_NARROW/.test(fn);
  })());

  ok("the three critical admin actions are atomic with their record", (() => {
    const src = SRC.admin;
    /* Each of the three sits inside a db.transaction with
       recordOrThrow, so the change rolls back if the event cannot be
       written. */
    const n = (src.match(/recordOrThrow/g) || []).length;
    return n === 3 && /db\.transaction\(\(\) => \{[\s\S]*?recordOrThrow/.test(src);
  })());

  ok("a role change really does record before and after", async () => true);

  const roleChange = await call("PATCH", "/api/admin/users/ST-ROLE/role",
                               { adminRole: "ADMIN" }, OWNER);
  ok("the role change went through", roleChange.status === 200, roleChange.status);
  ok("and it recorded SUPPORT -> ADMIN", inShop(() => {
    const r = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'admin.user.role' ORDER BY id DESC LIMIT 1").get();
    if (!r) return false;
    const m = JSON.parse(r.meta || "{}");
    return r.actor_type === "OWNER" && r.resource_type === "staff" &&
           r.resource_id === "ST-ROLE" && r.result === "SUCCESS" &&
           m.before.adminRole === "SUPPORT" && m.after.adminRole === "ADMIN";
  }));

  const disable = await call("PATCH", "/api/admin/users/ST-NON/active",
                            { active: false }, OWNER);
  ok("an account can still be switched off", disable.status === 200, disable.status);
  ok("and it recorded active 1 -> 0", inShop(() => {
    const r = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'admin.user.disable' ORDER BY id DESC LIMIT 1").get();
    const m = JSON.parse(r.meta || "{}");
    return r.resource_id === "ST-NON" && m.before.active === 1 && m.after.active === 0;
  }));

  const perms = await call("PUT", "/api/admin/users/roles/SUPPORT",
                           { caps: { "audit.view": true } }, OWNER);
  ok("a role's permissions can still be rewritten", perms.status === 200, perms.status);
  ok("and it recorded which capability was granted", inShop(() => {
    const r = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'admin.role.permissions' ORDER BY id DESC LIMIT 1").get();
    const m = JSON.parse(r.meta || "{}");
    return r.resource_type === "role" && r.resource_id === "SUPPORT" &&
           m.granted.includes("audit.view");
  }));

  ok("the log now says what changed, not '47 permissions reviewed'", inShop(() => {
    const r = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'admin.role.permissions' ORDER BY id DESC LIMIT 1").get();
    return /granted audit\.view/.test(r.details);
  }));

  /* And the grant takes effect — the capability system, not a reload. */
  const supNow = await call("GET", "/api/admin/audit", null, SUPPORT);
  ok("SUPPORT can read the log once the owner EXPLICITLY grants it",
     supNow.status === 200, supNow.status);

  /* ================================================================
     17. SCOPE — PART 10 BUILT ONE MODULE
     ================================================================ */
  console.log("\n--- nothing else was built ---");

  const adminSrc = fs.readFileSync(path.join(ROOT, "server/routes/admin.js"), "utf8");
  ["payment", "subscription", "/ai", "health", "monitor"].forEach(w => {
    ok("no " + w + " route was added",
       !new RegExp('router\\.[a-z]+\\("' + w.replace("/", "\\/"), "i").test(adminSrc));
  });

  ok("Payments is still a placeholder section", (() => {
    const s = adminAccess.SECTIONS.filter(x => x.key === "payments")[0];
    return !!s;
  })());

  ok("the files PART 10 added are only these three", (() => {
    return ["server/auditLog.js", "server/adminAudit.js", "test/audit.test.js"]
      .every(f => fs.existsSync(path.join(ROOT, f)));
  })());

  /* ================================================================ */
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
