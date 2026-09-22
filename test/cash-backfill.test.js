/* ============================================================
   THE ONE-TIME CASH BOOK VIEW BACKFILL

   Enforcing the Cash Book ticks took the book away from every staff member
   the owner had never explicitly granted it to. The migration in
   db-schema.js hands it back — View only, once, and without overruling
   anything the owner has actually configured.

   Three things are worth proving, and the third is the one that would hurt:

     1. Somebody with no Cash Book row gets View, and only View.
     2. Somebody the owner HAS configured is left alone — including the
        person deliberately switched off, who must not be switched back on.
     3. It never runs twice. A shop that unticks somebody tomorrow must not
        find them ticked again after the next deploy, and on a hosted copy
        a deploy happens whenever anything ships.

   The migration runs when db-schema.js first opens a database, so the test
   opens one, puts it back into the pre-migration state, and opens it again
   in a separate process — which is what a deploy actually does.

   Run:  node test/cash-backfill.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "sm-backfill-" + process.pid);
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

/* Opening a company's database is what runs the migration, and db.js is what
   opens it — so each "deploy" below is a fresh process doing exactly that,
   the same call the server makes on boot. */
const boot = () => execFileSync(process.execPath,
  ["-e", "const db=require(process.argv[2]); db.companies.runAs(db.companies.defaultId(), ()=>{});", DIR, ROOT + "/server/db.js"],
  { encoding: "utf8", env: { ...process.env, DATA_DIR: DIR } });

const DB = path.join(DIR, "shop.db");
const open = () => new DatabaseSync(DB);

/* ---- a shop as it stands before the upgrade ---------------------- */
boot();                                   // builds the schema (and runs the migration on an empty staff table)

let db = open();
const now = Date.now();
const add = (id, name, role) => db.prepare(
  "INSERT INTO staff (id,name,pin_hash,role,active,created_at) VALUES (?,?,'x:y',?,1,?)").run(id, name, role, now);

add("B-OWNER", "The Owner", "owner");
add("B-NONE",  "Never Configured", "staff");
add("B-FULL",  "Has Cash Book", "staff");
add("B-OFF",   "Deliberately Denied", "staff");
add("B-OTHER", "Other Modules Only", "staff");

/* The owner has configured three of them, in the three ways that matter. */
db.prepare("INSERT INTO staff_permissions (staff_id,module,can_view,can_add,can_edit,can_print) VALUES (?,'cash',1,1,1,1)").run("B-FULL");
db.prepare("INSERT INTO staff_permissions (staff_id,module,can_view,can_add,can_edit,can_print) VALUES (?,'cash',0,0,0,0)").run("B-OFF");
db.prepare("INSERT INTO staff_permissions (staff_id,module,can_view,can_add,can_edit,can_print) VALUES (?,'sales',1,1,0,1)").run("B-OTHER");

/* Put it back to before the migration: drop the marker so the next open
   runs it, exactly as a real upgrade would meet this database. */
db.exec("ALTER TABLE settings DROP COLUMN cash_view_backfilled_at");
db.close();

/* ---- the upgrade ------------------------------------------------- */
boot();

db = open();
const cash = id => db.prepare("SELECT * FROM staff_permissions WHERE staff_id=? AND module='cash'").get(id);

console.log("--- who gets the Cash Book back");
const none = cash("B-NONE");
ok("a staff member with no row is granted View", !!none && none.can_view === 1, JSON.stringify(none));
ok("and nothing beyond View",
   !!none && none.can_add === 0 && none.can_edit === 0 && none.can_print === 0, JSON.stringify(none));

const other = cash("B-OTHER");
ok("somebody configured for other modules is granted View too",
   !!other && other.can_view === 1, JSON.stringify(other));
ok("and their other modules are untouched",
   db.prepare("SELECT * FROM staff_permissions WHERE staff_id=? AND module='sales'").get("B-OTHER").can_print === 1);

console.log("--- who is left exactly as the owner set them");
const full = cash("B-FULL");
ok("an existing full grant is unchanged",
   full.can_view === 1 && full.can_add === 1 && full.can_edit === 1 && full.can_print === 1, JSON.stringify(full));

const off = cash("B-OFF");
ok("SOMEBODY DELIBERATELY SWITCHED OFF STAYS OFF",
   off.can_view === 0 && off.can_add === 0 && off.can_edit === 0 && off.can_print === 0, JSON.stringify(off));

ok("the owner gets no row, because none is ever consulted for them",
   !cash("B-OWNER"), JSON.stringify(cash("B-OWNER")));

console.log("--- it is on the record");
const logged = db.prepare("SELECT * FROM audit_log WHERE action='staff.permissions.backfill'").all();
ok("the grant is written to the audit log", logged.length === 1, String(logged.length));
ok("and names who got it",
   logged.length === 1 && /Never Configured/.test(logged[0].details) && /Other Modules Only/.test(logged[0].details),
   logged[0] && logged[0].details);
ok("without naming anyone it did not touch",
   logged.length === 1 && !/Deliberately Denied|Has Cash Book/.test(logged[0].details),
   logged[0] && logged[0].details);

const stamp = db.prepare("SELECT cash_view_backfilled_at n FROM settings WHERE id=1").get().n;
ok("the marker is stamped", stamp > 0, String(stamp));

/* ---- the next deploy, and the one after ------------------------- */
console.log("--- and it never runs again");
/* The shop changes its mind about someone the migration just granted. */
db.prepare("UPDATE staff_permissions SET can_view=0 WHERE staff_id=? AND module='cash'").run("B-NONE");
db.close();

boot();                                   // deploy
boot();                                   // and another

db = open();
ok("SOMEBODY UNTICKED AFTER THE UPGRADE STAYS UNTICKED",
   cash("B-NONE").can_view === 0, JSON.stringify(cash("B-NONE")));
ok("no second audit entry",
   db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='staff.permissions.backfill'").get().n === 1);

/* A staff member hired after the upgrade is the owner's to configure — the
   migration is spent and must not reach them. */
db.prepare("INSERT INTO staff (id,name,pin_hash,role,active,created_at) VALUES ('B-NEW','Hired Later','x:y','staff',1,?)").run(Date.now());
db.close();
boot();
db = open();
ok("a staff member hired afterwards is NOT granted anything",
   !cash("B-NEW"), JSON.stringify(cash("B-NEW")));
db.close();

console.log("");
console.log("  " + pass + " passed, " + fail + " failed");
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
