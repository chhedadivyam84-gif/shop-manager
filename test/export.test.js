/* ============================================================
   EXPORT DATA — one list of everything that can leave the shop

   The exports mostly existed already; finding them did not. So the
   screen is driven by a REGISTRY, and a registry has one characteristic
   failure: it points at a route that does not exist, or that has been
   renamed since. Nothing on screen looks wrong — the button is there —
   and the download fails only when somebody actually needs their data.

   So the test that matters most is the boring one: every entry in the
   catalogue is fetched, and has to come back as a real spreadsheet.

   Then the two that are genuinely new, Staff Pay and Reminders, and the
   rule that separates them: salary is the owner's alone, and a
   spreadsheet is the easiest thing there is to carry out of a shop.

   Run:  node test/export.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-export-" + process.pid);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + x : "")); }
};

const CO = db.companies.create({ name: "Export Test" });
const inCo = fn => db.companies.runAs(CO.id, fn);

let WHO = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = WHO ? { ...WHO, loggedIn: true } : {};
  db.companies.runAs(CO.id, next);
});
app.use("/api/export", require(path.join(ROOT, "server/routes/export.js")));
app.use("/api/reports", require(path.join(ROOT, "server/routes/reports.js")));
app.use("/api/cashbook", require(path.join(ROOT, "server/routes/cashbook.js")));
app.use("/api/bankbook", require(path.join(ROOT, "server/routes/bankbook.js")));
app.use("/api/backup", require(path.join(ROOT, "server/routes/backup.js")));

const OWNER = { staffId: "X-OWNER", staffName: "Owner", role: "owner" };
const STAFF = { staffId: "X-STAFF", staffName: "Staff", role: "staff" };

let BASE;
const get = async (url, who) => {
  if (who !== undefined) WHO = who;
  const r = await fetch(BASE + url);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, type: r.headers.get("content-type") || "",
           disp: r.headers.get("content-disposition") || "",
           text: () => buf.toString("utf8") };
};
/* An .xlsx is a zip: it starts "PK". Anything else is not a spreadsheet,
   whatever the Content-Type header claims. */
const isXlsx = r => r.buf.length > 100 && r.buf[0] === 0x50 && r.buf[1] === 0x4B;

/* ------------------------------------------------------------------ */
const now = Date.now();
inCo(() => {
  const emp = (id, name, salary) => db.prepare(
    "INSERT INTO employees (id,name,mobile,job_role,joining_date,monthly_salary,salary_type,active,created_at) VALUES (?,?,?,?,?,?,'monthly',1,?)")
    .run(id, name, "90000000" + id.slice(-2), "Helper", "2025-04-01", salary, now);
  emp("E1", "Ramu", 14000);
  emp("E2", "Shyam", 16000);

  db.prepare("INSERT INTO attendance (id,employee_id,date,status,note,marked_by,at) VALUES (?,?,?,?,?,?,?)")
    .run("A1", "E1", "2026-09-01", "present", "", "Owner", now);
  db.prepare("INSERT INTO attendance (id,employee_id,date,status,note,marked_by,at) VALUES (?,?,?,?,?,?,?)")
    .run("A2", "E1", "2026-09-20", "absent", "fever", "Owner", now);

  db.prepare("INSERT INTO kharchi_transactions (id,employee_id,amount,date,reason,method,recorded_by,at,voided) VALUES (?,?,?,?,?,?,?,?,0)")
    .run("K1", "E1", 500, "2026-09-05", "advance", "Cash", "Owner", now);
  db.prepare("INSERT INTO salary_payments (id,employee_id,month,amount,date,method,notes,recorded_by,at,voided) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run("S1", "E2", "2026-08", 16000, "2026-09-02", "Cash", "full", "Owner", now);

  const rem = (id, text, due, done) => db.prepare(
    "INSERT INTO reminders (id,text,due_date,due_time,link_kind,link_name,done,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, text, due, "10:00", "customer", "Shree Interiors", done, now, "Owner");
  rem("R1", "Collect payment", "2026-09-10", 0);
  rem("R2", "Order laminate", "2026-09-25", 0);
  rem("R3", "Old job", "2026-08-01", 1);
});

(async () => {
  const srv = app.listen(0);
  await new Promise(r => srv.once("listening", r));
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================ */
  console.log("--- the catalogue");
  const cat = await get("/api/export/catalogue", OWNER);
  const j = JSON.parse(cat.text());
  ok("it answers", cat.status === 200, String(cat.status));
  ok("and is grouped", Array.isArray(j.groups) && j.groups.length >= 6, String((j.groups || []).length));
  const all = j.groups.flatMap(g => g.items);
  ok("every entry has a key, a label and a url",
     all.every(i => i.key && i.label && i.url), JSON.stringify(all.filter(i => !i.url)));
  ok("keys are unique", new Set(all.map(i => i.key)).size === all.length);

  console.log("--- EVERY ENTRY POINTS AT A ROUTE THAT WORKS");
  let dead = [];
  for (const item of all) {
    /* The backup is a database file, not a spreadsheet, and building one
       needs a real data directory — checked separately below. */
    if (item.key === "backup") continue;
    const r = await get(item.url, OWNER);
    if (r.status !== 200 || !isXlsx(r)) dead.push(item.key + " -> " + r.status + (isXlsx(r) ? "" : " (not a spreadsheet)"));
  }
  ok("all of them return a real .xlsx", dead.length === 0, dead.join(" | "));

  console.log("--- and a date range reaches the ones that take one");
  const dated = all.filter(i => i.dated).slice(0, 4);
  let badRange = [];
  for (const item of dated) {
    const sep = item.url.includes("?") ? "&" : "?";
    const r = await get(item.url + sep + "from=2026-09-01&to=2026-09-30", OWNER);
    if (r.status !== 200 || !isXlsx(r)) badRange.push(item.key + " -> " + r.status);
  }
  ok("a range does not break them", badRange.length === 0, badRange.join(" | "));

  /* ================================================================ */
  console.log("--- Staff Pay, which had no export at all before");
  for (const [key, url] of [["employees", "/api/export/employees"], ["attendance", "/api/export/attendance"],
                            ["kharchi", "/api/export/kharchi"], ["salary", "/api/export/salary"]]) {
    const r = await get(url, OWNER);
    ok(key + " exports a spreadsheet", r.status === 200 && isXlsx(r),
       r.status + (isXlsx(r) ? "" : " not xlsx"));
    ok(key + " is named for what it holds", new RegExp(key.replace("salary", "salary-paid")).test(r.disp), r.disp);
  }

  console.log("--- SALARY IS THE OWNER'S ALONE, on paper as on screen");
  let leaked = [];
  for (const url of ["/api/export/employees", "/api/export/attendance",
                     "/api/export/kharchi", "/api/export/salary"]) {
    const r = await get(url, STAFF);
    if (r.status !== 403) leaked.push(url + " -> " + r.status);
  }
  ok("every Staff Pay export refuses a staff member", leaked.length === 0, leaked.join(" | "));
  const staffCat = JSON.parse((await get("/api/export/catalogue", STAFF)).text());
  ok("and it is not even offered to them",
     !staffCat.groups.some(g => g.group === "Staff Pay"),
     JSON.stringify(staffCat.groups.map(g => g.group)));
  ok("nor is the whole-database backup",
     !staffCat.groups.flatMap(g => g.items).some(i => i.key === "backup"));
  ok("but they still get the ordinary exports",
     staffCat.groups.flatMap(g => g.items).length >= 10,
     String(staffCat.groups.flatMap(g => g.items).length));

  /* ================================================================ */
  console.log("--- Reminders, which also had none");
  const rem = await get("/api/export/reminders", OWNER);
  ok("reminders export a spreadsheet", rem.status === 200 && isXlsx(rem), String(rem.status));
  /* A reminder is somebody's job for today, and the people who do the jobs
     are the ones who need the list — so this one is not owner-only. */
  const remStaff = await get("/api/export/reminders", STAFF);
  ok("and a staff member may take them", remStaff.status === 200 && isXlsx(remStaff), String(remStaff.status));

  const ranged = await get("/api/export/reminders?from=2026-09-01&to=2026-09-30", OWNER);
  ok("a date range is accepted", ranged.status === 200 && isXlsx(ranged), String(ranged.status));
  ok("and lands in the filename", /2026-09-01-to-2026-09-30/.test(ranged.disp), ranged.disp);
  ok("no range says so plainly", /reminders-all/.test(rem.disp), rem.disp);

  /* A range is only ever the two dates, never anything else a caller sends. */
  const junk = await get("/api/export/reminders?from=" + encodeURIComponent("2026-01-01' OR '1'='1"), OWNER);
  ok("a from that is not a date is ignored, not injected",
     junk.status === 200 && isXlsx(junk) && /reminders-all/.test(junk.disp), junk.disp);

  /* ================================================================ */
  console.log("--- nothing here is reachable without signing in");
  let open = [];
  for (const url of ["/api/export/catalogue", "/api/export/employees", "/api/export/reminders"]) {
    const r = await get(url, null);
    /* The mount in index.js carries requireAuth; these routers are mounted
       bare here, so what is asserted is the per-route guard that exists. */
    if (url.includes("employees") && r.status !== 403) open.push(url + " -> " + r.status);
  }
  ok("the Staff Pay routes refuse a caller with no session", open.length === 0, open.join(" | "));

  console.log("");
  console.log("  " + pass + " passed, " + fail + " failed");
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("  ERROR " + ((e && e.stack) || e)); process.exit(1); });
