/* ============================================================
   USERS, ROLES & PERMISSIONS — PART 8

   This module decides who may open the admin panel. So almost all of
   what follows is an attempt to get access that was not given:

     - a SUPPORT user making themselves ADMIN
     - an ADMIN making themselves OWNER
     - anybody at all touching the shop owner's row
     - an owner quietly rewriting their own access
     - "OWNER" posted straight into the role field
     - a disabled account carrying on with the session it already had
     - a revoked role carrying on with the session it already had
     - another shop's staff id pasted into the URL

   And the ordinary half that has to keep working: a list that pages and
   searches, a profile, a role change that takes effect, an account
   switched off and back on, and a permission matrix an owner can edit.

   THE OWNER PROTECTION IS CHECKED AT THREE LEVELS on purpose — the
   schema, the handler, and the session — because one lock in security
   code is a lock nobody checked.

   Run:  node test/admin-users.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");

const DATA_DIR = path.join(os.tmpdir(), "sm-adminusers-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const adminAccess = require(path.join(ROOT, "server/adminAccess.js"));
const adminUsers = require(path.join(ROOT, "server/adminUsers.js"));
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

/* A session is what the app would have made at login. adminRole is the
   value read from the staff row at that moment. */
const OWNER   = { role: "owner", staffId: "STAFF_owner", staffName: "Owner", adminRole: null };
const ADMIN   = { role: "staff", staffId: "ST-ADM", staffName: "Asha",  adminRole: "ADMIN" };
const SUPPORT = { role: "staff", staffId: "ST-SUP", staffName: "Sunil", adminRole: "SUPPORT" };
const PLAIN   = { role: "staff", staffId: "ST-NON", staffName: "Neha",  adminRole: null };

const addStaff = (id, name, role, adminRole, active) =>
  db.prepare(`INSERT INTO staff (id,name,pin_hash,role,active,created_at,admin_role)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, name, hashPin("1234"), role, active === 0 ? 0 : 1, Date.now(), adminRole || null);

function seed() {
  inShop(() => {
    addStaff("ST-ADM", "Asha Manager", "staff", "ADMIN");
    addStaff("ST-SUP", "Sunil Support", "staff", "SUPPORT");
    addStaff("ST-NON", "Neha Counter", "staff", null);
    addStaff("ST-OFF", "Old Hand", "staff", null, 0);
    for (let i = 0; i < 30; i++) addStaff("ST-B" + i, "Bulk Staff " + i, "staff", null);
    db.prepare(`INSERT INTO audit_log (at,staff_id,staff_name,role,action,details)
                VALUES (?,?,?,?,?,?)`)
      .run(Date.now(), "ST-ADM", "Asha Manager", "staff", "login", "");
  });
  inOther(() => {
    addStaff("ST-RIVAL", "Rival Admin", "staff", "ADMIN");
  });
}

/* ================================================================== */
(async () => {
  seed();
  const srv = app.listen(0);
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     1.  THE CARRIER
     ================================================================ */
  console.log("\n--- the column that carries an admin role ---");

  ok("ADMIN and SUPPORT can be stored",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM staff WHERE admin_role IS NOT NULL").get().n) === 2);

  ok("'OWNER' CANNOT BE STORED IN IT — the database refuses", inShop(() => {
    try { addStaff("ST-EVIL", "Climber", "staff", "OWNER"); return false; }
    catch (e) { return /CHECK constraint failed/i.test(e.message); }
  }));
  ok("nor can any other word", inShop(() => {
    try { addStaff("ST-EVIL2", "Climber", "staff", "SUPERUSER"); return false; }
    catch (e) { return /CHECK constraint failed/i.test(e.message); }
  }));
  ok("NULL means no admin access, which is what every old row has",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM staff WHERE admin_role IS NULL").get().n) > 0);

  console.log("\n--- the three roles resolve ---");
  ok("an owner is OWNER", adminAccess.roleOf({ session: { loggedIn: true, role: "owner" } }) === "OWNER");
  ok("an ADMIN session is ADMIN",
     adminAccess.roleOf({ session: { loggedIn: true, role: "staff", adminRole: "ADMIN" } }) === "ADMIN");
  ok("a SUPPORT session is SUPPORT",
     adminAccess.roleOf({ session: { loggedIn: true, role: "staff", adminRole: "SUPPORT" } }) === "SUPPORT");
  ok("plain staff are nobody",
     adminAccess.roleOf({ session: { loggedIn: true, role: "staff" } }) === null);
  ok("A FORGED adminRole IN THE SESSION IS STILL NOT OWNER",
     adminAccess.roleOf({ session: { loggedIn: true, role: "staff", adminRole: "OWNER" } }) === null);
  ok("nor is any other invented word",
     adminAccess.roleOf({ session: { loggedIn: true, role: "staff", adminRole: "root" } }) === null);
  ok("an owner previewing a staff member is not an admin",
     adminAccess.roleOf({ session: { loggedIn: true, role: "owner", previewStaffId: "ST-NON" } }) === null);

  /* ================================================================
     2.  WHAT EACH ROLE MAY DO
     ================================================================ */
  console.log("\n--- permissions per role ---");

  const req = who => ({ session: { loggedIn: true, ...who } });
  ok("SUPPORT may read customers", adminAccess.can(req(SUPPORT), "customers.view") === true);
  ok("SUPPORT may NOT edit them", adminAccess.can(req(SUPPORT), "customers.edit") === false);
  ok("SUPPORT may NOT manage users", adminAccess.can(req(SUPPORT), "admin.manage") === false);
  ok("ADMIN may edit customers", adminAccess.can(req(ADMIN), "customers.edit") === true);
  ok("ADMIN may NOT adjust stock — that is owner-only",
     adminAccess.can(req(ADMIN), "inventory.adjust") === false);
  ok("ADMIN MAY NOT MANAGE USERS either",
     adminAccess.can(req(ADMIN), "admin.manage") === false);
  ok("the owner may", adminAccess.can(req(OWNER), "admin.manage") === true);
  ok("an unknown capability is refused for everyone",
     !adminAccess.can(req(OWNER), "nonsense.view") &&
     !adminAccess.can(req(ADMIN), "nonsense.view"));

  ok("every capability is resource.action",
     Object.keys(adminAccess.CAPS).every(c => /^[a-z]+\.[a-z]+$/.test(c)),
     Object.keys(adminAccess.CAPS).filter(c => !/^[a-z]+\.[a-z]+$/.test(c)));

  /* ================================================================
     3.  WHO MAY OPEN THESE SCREENS
     ================================================================ */
  console.log("\n--- managing users is owner-only ---");

  let r = await call("GET", "/api/admin/users", null, OWNER);
  ok("the owner can list users", r.status === 200, r.status);

  for (const [label, who] of [["ADMIN", ADMIN], ["SUPPORT", SUPPORT],
                              ["plain staff", PLAIN], ["logged out", null]]) {
    for (const u of ["/api/admin/users", "/api/admin/users/roles", "/api/admin/users/ST-ADM"]) {
      const res = await call("GET", u, null, who);
      ok(label + " GET " + u.replace("/api/admin", "") + " is refused",
         res.status === 401 || res.status === 403, res.status);
    }
    const w = await call("PATCH", "/api/admin/users/ST-NON/role", { adminRole: "ADMIN" }, who);
    ok(label + " cannot grant a role", w.status === 401 || w.status === 403, w.status);
  }
  ok("after all that, nobody gained a role",
     inShop(() => db.prepare("SELECT admin_role FROM staff WHERE id = ?").get("ST-NON").admin_role) === null);

  /* ================================================================
     4.  SELF-ESCALATION
     ================================================================ */
  console.log("\n--- a user cannot promote themselves ---");

  r = await call("PATCH", "/api/admin/users/ST-SUP/role", { adminRole: "ADMIN" }, SUPPORT);
  ok("SUPPORT cannot make themselves ADMIN", r.status === 403, r.status);
  r = await call("PATCH", "/api/admin/users/ST-ADM/role", { adminRole: "ADMIN" }, ADMIN);
  ok("ADMIN cannot edit their own row either", r.status === 403, r.status);
  ok("neither role changed",
     inShop(() => db.prepare("SELECT admin_role FROM staff WHERE id='ST-SUP'").get().admin_role) === "SUPPORT" &&
     inShop(() => db.prepare("SELECT admin_role FROM staff WHERE id='ST-ADM'").get().admin_role) === "ADMIN");

  console.log("\n--- and not even the owner edits their own access ---");
  r = await call("PATCH", "/api/admin/users/STAFF_owner/role", { adminRole: "SUPPORT" }, OWNER);
  ok("the owner's own row is refused", r.status === 403, [r.status, r.j && r.j.error]);
  ok("the message says it is the owner, not a generic refusal",
     /owner/i.test((r.j && r.j.error) || ""), r.j);

  /* ================================================================
     5.  "OWNER" POSTED STRAIGHT IN
     ================================================================ */
  console.log("\n--- posting OWNER into the role field ---");

  for (const value of ["OWNER", "owner", "Owner", "OWNER ", "root", "admin", 1, true, {}]) {
    r = await call("PATCH", "/api/admin/users/ST-NON/role", { adminRole: value }, OWNER);
    ok("adminRole=" + JSON.stringify(value) + " is refused", r.status === 400, r.status);
  }
  ok("the refusal for OWNER names the reason rather than being generic",
     /ownership is not granted/i.test(
       ((await call("PATCH", "/api/admin/users/ST-NON/role", { adminRole: "OWNER" }, OWNER)).j || {}).error || ""));
  ok("and nobody became anything",
     inShop(() => db.prepare("SELECT admin_role FROM staff WHERE id='ST-NON'").get().admin_role) === null);

  ok("there is NO owner anywhere but staff.role",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM staff WHERE admin_role = 'OWNER'").get().n) === 0);

  /* ================================================================
     6.  THE OWNER'S ACCOUNT
     ================================================================ */
  console.log("\n--- the owner cannot be taken over ---");

  r = await call("PATCH", "/api/admin/users/STAFF_owner/active", { active: false }, OWNER);
  ok("the owner's account cannot be disabled", r.status === 403, r.status);
  ok("and is still active",
     inShop(() => db.prepare("SELECT active FROM staff WHERE id='STAFF_owner'").get().active) === 1);

  r = await call("PUT", "/api/admin/users/roles/OWNER", { caps: { "admin.manage": false } }, OWNER);
  ok("the owner's permissions cannot be limited", r.status === 403, [r.status, r.j && r.j.error]);
  ok("the owner still holds admin.manage",
     inShop(() => adminAccess.can(req(OWNER), "admin.manage")) === true);

  /* ================================================================
     7.  A ROLE CHANGE THAT IS ALLOWED
     ================================================================ */
  console.log("\n--- the owner grants and revokes ---");

  r = await call("PATCH", "/api/admin/users/ST-NON/role", { adminRole: "SUPPORT" }, OWNER);
  ok("the owner can give SUPPORT", r.status === 200, [r.status, r.j && r.j.error]);
  ok("the row changed",
     inShop(() => db.prepare("SELECT admin_role FROM staff WHERE id='ST-NON'").get().admin_role) === "SUPPORT");
  ok("it is written to the audit log",
     inShop(() => db.prepare(
       "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.user.role'").get().n) >= 1);

  r = await call("PATCH", "/api/admin/users/ST-NON/role", { adminRole: null }, OWNER);
  ok("and can take it away again", r.status === 200, r.status);
  ok("the row is NULL once more",
     inShop(() => db.prepare("SELECT admin_role FROM staff WHERE id='ST-NON'").get().admin_role) === null);

  console.log("\n--- an account switched off ---");
  r = await call("PATCH", "/api/admin/users/ST-OFF/active", { active: true }, OWNER);
  ok("it can be switched back on", r.status === 200, r.status);
  r = await call("PATCH", "/api/admin/users/ST-OFF/active", { active: false }, OWNER);
  ok("and off again", r.status === 200, r.status);
  ok("the row is kept, never deleted",
     inShop(() => !!db.prepare("SELECT 1 FROM staff WHERE id='ST-OFF'").get()));
  ok("there is no route that deletes a user at all",
     (await call("DELETE", "/api/admin/users/ST-OFF", null, OWNER)).status === 404);

  /* ================================================================
     8.  A SESSION DOES NOT OUTLIVE THE DECISION
     ================================================================ */
  console.log("\n--- revoking takes effect at once, not at next login ---");

  /* Asha is signed in as ADMIN. Take the role away in the database and
     her existing session must stop working immediately. */
  ok("she can reach the panel now",
     (await call("GET", "/api/admin/customers", null, ADMIN)).status === 200);

  inShop(() => db.prepare("UPDATE staff SET admin_role = NULL WHERE id = 'ST-ADM'").run());
  r = await call("GET", "/api/admin/customers", null, ADMIN);
  ok("WITH THE ROLE REVOKED, HER OLD SESSION IS REFUSED", r.status === 403, r.status);

  inShop(() => db.prepare("UPDATE staff SET admin_role = 'ADMIN' WHERE id = 'ST-ADM'").run());
  ok("restoring it lets her back in",
     (await call("GET", "/api/admin/customers", null, ADMIN)).status === 200);

  console.log("\n--- a disabled account cannot use the session it had ---");
  inShop(() => db.prepare("UPDATE staff SET active = 0 WHERE id = 'ST-ADM'").run());
  r = await call("GET", "/api/admin/customers", null, ADMIN);
  ok("a disabled admin is refused", r.status === 403, r.status);
  inShop(() => db.prepare("UPDATE staff SET active = 1 WHERE id = 'ST-ADM'").run());

  console.log("\n--- a session claiming a role the row does not have ---");
  r = await call("GET", "/api/admin/customers", null,
    { role: "staff", staffId: "ST-SUP", staffName: "Sunil", adminRole: "ADMIN" });
  ok("a SUPPORT row with an ADMIN session is refused", r.status === 403, r.status);
  r = await call("GET", "/api/admin/customers", null,
    { role: "staff", staffId: "ST-NOBODY", staffName: "Ghost", adminRole: "ADMIN" });
  ok("a session for a staff id that does not exist is refused", r.status === 403, r.status);

  /* ================================================================
     9.  ANOTHER SHOP'S STAFF
     ================================================================ */
  console.log("\n--- another shop's user ---");

  ok("the other shop really has them",
     inOther(() => !!db.prepare("SELECT 1 FROM staff WHERE id='ST-RIVAL'").get()));
  r = await call("GET", "/api/admin/users/ST-RIVAL", null, OWNER);
  ok("they are a 404 here", r.status === 404, r.status);
  ok("and nothing leaks", !r.text.includes("Rival"), r.text.slice(0, 60));
  r = await call("PATCH", "/api/admin/users/ST-RIVAL/role", { adminRole: null }, OWNER);
  ok("and their role cannot be changed from here", r.status === 404, r.status);
  ok("their row is untouched",
     inOther(() => db.prepare("SELECT admin_role FROM staff WHERE id='ST-RIVAL'").get().admin_role) === "ADMIN");

  /* ================================================================
     10.  THE PERMISSION MATRIX
     ================================================================ */
  console.log("\n--- editing what a role may do ---");

  r = await call("GET", "/api/admin/users/roles", null, OWNER);
  ok("the matrix loads", r.status === 200, r.status);
  ok("it lists all three roles", r.j.roles.length === 3, r.j.roles.map(x => x.key));
  ok("the owner's row is marked not editable",
     r.j.roles.find(x => x.key === "OWNER").editable === false);
  ok("ADMIN and SUPPORT are editable",
     r.j.roles.filter(x => x.key !== "OWNER").every(x => x.editable === true));
  ok("the catalogue groups capabilities by resource",
     r.j.catalogue.length > 0 && r.j.catalogue.every(g => g.resource && g.caps.length));

  /* Give SUPPORT something it does not have by default. */
  /* can() consults the stored matrix, which belongs to a company — so a
     direct call has to be made inside one, exactly as a request is.
     That is the design: each shop decides its own roles. */
  ok("SUPPORT cannot edit customers to begin with",
     inShop(() => adminAccess.can(req(SUPPORT), "customers.edit")) === false);
  r = await call("PUT", "/api/admin/users/roles/SUPPORT",
    { caps: { "customers.edit": true } }, OWNER);
  ok("the change is accepted", r.status === 200, [r.status, r.j && r.j.error]);
  ok("AND IT TAKES EFFECT — SUPPORT can now edit customers",
     inShop(() => adminAccess.can(req(SUPPORT), "customers.edit")) === true);
  ok("without touching any other role",
     inShop(() => adminAccess.can(req(ADMIN), "customers.edit")) === true &&
     inShop(() => adminAccess.can(req(PLAIN), "customers.edit")) === false);
  ok("and the change belongs to THIS shop only — another has its own matrix",
     inOther(() => adminAccess.can(req(SUPPORT), "customers.edit")) === false);

  /* And a real request must obey it. */
  inShop(() => db.prepare(`INSERT INTO customers (id,name,phone,due,created_at,active)
                           VALUES ('C1','A Customer','900',0,?,1)`).run(Date.now()));
  r = await call("PUT", "/api/admin/customers/C1", { name: "Renamed", phone: "900" }, SUPPORT);
  ok("a SUPPORT user can now actually make that edit", r.status === 200, [r.status, r.j && r.j.error]);

  /* Take it away again and the same request must fail. */
  r = await call("PUT", "/api/admin/users/roles/SUPPORT",
    { caps: { "customers.edit": false } }, OWNER);
  ok("it can be revoked", r.status === 200, r.status);
  ok("the capability is gone",
     inShop(() => adminAccess.can(req(SUPPORT), "customers.edit")) === false);
  r = await call("PUT", "/api/admin/customers/C1", { name: "Again", phone: "900" }, SUPPORT);
  ok("AND THE SAME REQUEST IS NOW REFUSED", r.status === 403, r.status);
  ok("the customer kept the name from the allowed edit",
     inShop(() => db.prepare("SELECT name FROM customers WHERE id='C1'").get().name) === "Renamed");

  console.log("\n--- back to the default forgets the override ---");
  r = await call("PUT", "/api/admin/users/roles/SUPPORT",
    { caps: { "customers.view": true } }, OWNER);   /* already the default */
  ok("setting a capability to its default stores nothing",
     inShop(() => db.prepare(
       "SELECT COUNT(*) n FROM admin_role_permissions WHERE role='SUPPORT' AND cap='customers.view'")
       .get().n) === 0);

  console.log("\n--- the matrix refuses nonsense ---");
  for (const [label, role, body] of [
    ["an unknown role", "WIZARD", { caps: {} }],
    ["the owner", "OWNER", { caps: {} }],
  ]) {
    r = await call("PUT", "/api/admin/users/roles/" + role, body, OWNER);
    ok(label + " is refused", r.status === 400 || r.status === 403, r.status);
  }
  r = await call("PUT", "/api/admin/users/roles/ADMIN", { caps: { "made.up": true } }, OWNER);
  ok("an unknown capability is refused", r.status === 400, [r.status, r.j && r.j.error]);
  r = await call("PUT", "/api/admin/users/roles/ADMIN", { caps: ["customers.view"] }, OWNER);
  ok("caps sent as an array is refused", r.status === 400, r.status);
  ok("nothing of ADMIN's changed through any of that",
     inShop(() => adminAccess.can(req(ADMIN), "customers.edit")) === true);

  /* ================================================================
     11.  THE LIST AND THE PROFILE
     ================================================================ */
  console.log("\n--- the user list ---");

  r = await call("GET", "/api/admin/users", null, OWNER);
  ok("it pages rather than sending everyone",
     r.j.rows.length === 25 && r.j.total > 25, [r.j.rows.length, r.j.total]);
  ok("page 2 holds the rest",
     (await call("GET", "/api/admin/users?page=2", null, OWNER)).j.rows.length === r.j.total - 25);
  ok("a huge pageSize cannot pull everyone",
     (await call("GET", "/api/admin/users?pageSize=99999", null, OWNER)).j.rows.length
       <= adminUsers.MAX_PAGE_SIZE);

  const find = async q => (await call("GET", "/api/admin/users?q=" + encodeURIComponent(q) +
    "&pageSize=100", null, OWNER)).j;
  ok("search by name", (await find("Asha")).total === 1);
  ok("search by id", (await find("ST-SUP")).total === 1);
  ok("a bare % does not match everyone", (await find("%")).total === 0);
  /* The owner's id is STAFF_owner, so a literal underscore really does
     match one row. That IS the escape working: unescaped it would match
     every id, which is thirty-odd. */
  const underscore = await find("_");
  ok("a bare _ matches only the id that truly contains one",
     underscore.total === 1 && underscore.rows[0].id === "STAFF_owner",
     underscore.rows.map(u => u.id));

  const admins = (await call("GET", "/api/admin/users?filter=admin&pageSize=100", null, OWNER)).j;
  ok("the admin filter finds the owner and the two role-holders",
     admins.rows.every(u => u.isOwner || u.adminRole), admins.rows.map(u => u.name));
  const off = (await call("GET", "/api/admin/users?filter=disabled&pageSize=100", null, OWNER)).j;
  ok("the disabled filter finds the switched-off account",
     off.rows.every(u => !u.active) && off.total >= 1, off.rows.map(u => u.name));
  ok("an unknown filter falls back to everyone",
     (await call("GET", "/api/admin/users?filter=nonsense", null, OWNER)).j.filter === "all");
  ok("an unknown sort falls back to name",
     (await call("GET", "/api/admin/users?sort=name;DROP TABLE staff", null, OWNER)).j.sort === "name");
  ok("the staff table survived",
     inShop(() => db.prepare("SELECT COUNT(*) n FROM staff").get().n) > 30);

  console.log("\n--- a user's profile ---");
  r = await call("GET", "/api/admin/users/ST-ADM", null, OWNER);
  ok("it loads", r.status === 200, r.status);
  ok("it names the role", r.j.role === "ADMIN", r.j.role);
  ok("it lists the permissions that role grants",
     Array.isArray(r.j.permissions) && r.j.permissions.includes("customers.edit"),
     r.j.permissions);
  ok("the permissions match what the server would actually allow",
     inShop(() => r.j.permissions.every(c => adminAccess.can(req(ADMIN), c))), r.j.permissions);
  ok("it shows recent activity from the audit log",
     Array.isArray(r.j.activity.recent) && r.j.activity.recent.length >= 1);

  for (const bad of ["NOPE", "../settings", "'; DROP TABLE staff;--"]) {
    const res = await call("GET", "/api/admin/users/" + encodeURIComponent(bad), null, OWNER);
    ok("id " + bad.slice(0, 16) + " is a plain 404", res.status === 404, res.status);
  }

  /* ================================================================
     12.  NOTHING ABOUT A PASSWORD EVER LEAVES
     ================================================================ */
  console.log("\n--- no credential crosses the wire ---");

  const blobs = [
    (await call("GET", "/api/admin/users?pageSize=100", null, OWNER)).text,
    (await call("GET", "/api/admin/users/ST-ADM", null, OWNER)).text,
    (await call("GET", "/api/admin/users/roles", null, OWNER)).text,
  ];
  for (const blob of blobs) {
    ok("no pin_hash field", !/pin_hash/i.test(blob));
    ok("no scrypt-shaped hash value", !/[a-f0-9]{32}:[a-f0-9]{64,}/i.test(blob));
    ok("no filesystem path", !/[A-Za-z]:[\\/]|\/home\/|\/tmp\//.test(blob));
    ok("no SQL", !/SELECT |FROM staff/i.test(blob));
    ok("no stack trace", !/\bat \w+ \(/.test(blob));
  }
  const svc = fs.readFileSync(path.join(ROOT, "server/adminUsers.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  ok("the service never selects pin_hash", !/pin_hash/.test(svc));
  ok("and never writes anything", !/\b(INSERT|UPDATE|DELETE)\s/i.test(svc));

  srv.close();

  console.log("\n==============================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
