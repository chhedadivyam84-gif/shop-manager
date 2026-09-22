/* ============================================================
   CASH BOOK STAFF ACCESS — the permission and the period

   Two claims are being made and neither is worth taking on trust:

     1. The Cash Book now obeys the View / Add / Edit / Print ticks in
        Staff Access. It did not before — the module existed on the
        permission screen and no route ever asked about it.

     2. A staff member given a date period sees that period and nothing
        else, and cannot get at the rest by asking differently.

   The second is the one that matters, so most of what is below is an
   attempt to break it: widening the query string, searching instead of
   filtering, asking for another month, reading an entry by its id,
   writing into a day outside the window, walking an entry across the
   boundary with an edit, and going round the Cash Book entirely through
   the dashboard, the money position, the Other Entries ledger and the
   report API.

   The real routers are mounted on a scratch database — the code that
   will serve the shop, not a second copy of its rules.

   Run:  node test/cash-access.test.js
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-cashaccess-" + process.pid);
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

const CO = db.companies.create({ name: "Cash Access Test" });
const inCo = fn => db.companies.runAs(CO.id, fn);

/* ------------------------------------------------------------------
   Who is asking. One mutable holder the middleware reads, so a test can
   switch person between two requests without standing up a new server. */
let WHO = null;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = WHO ? { ...WHO, loggedIn: true } : {};
  db.companies.runAs(CO.id, next);
});
app.use("/api/cashbook", require(path.join(ROOT, "server/routes/cashbook.js")));
app.use("/api/permissions", require(path.join(ROOT, "server/routes/permissions.js")));
app.use("/api/reports", require(path.join(ROOT, "server/routes/reports.js")));
app.use("/api/position", require(path.join(ROOT, "server/routes/position.js")));

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

/* ------------------------------------------------------------------ */
const staff = (id, name, role) => {
  inCo(() => db.prepare("INSERT INTO staff (id,name,pin_hash,role,active,created_at) VALUES (?,?,?,?,1,?)")
    .run(id, name, "x:y", role, Date.now()));
  return { staffId: id, staffName: name, role };
};
const grant = (id, acts) => inCo(() =>
  db.prepare("INSERT OR REPLACE INTO staff_permissions (staff_id,module,can_view,can_add,can_edit,can_print) VALUES (?,'cash',?,?,?,?)")
    .run(id, acts.includes("view") ? 1 : 0, acts.includes("add") ? 1 : 0,
         acts.includes("edit") ? 1 : 0, acts.includes("print") ? 1 : 0));
const period = (id, type, a, b) => inCo(() =>
  db.prepare("UPDATE staff SET cash_access_type=?, cash_access_date=?, cash_access_from=?, cash_access_to=? WHERE id=?")
    .run(type, type === "day" ? a : "", type === "range" ? a : "", type === "range" ? b : "", id));

const OWNER  = staff("ST-OWNER",  "Owner",        "owner");
const DAY    = staff("ST-DAY",    "One Day",      "staff");
const RANGE  = staff("ST-RANGE",  "Date Range",   "staff");
const PERMNT = staff("ST-PERM",   "Permanent",    "staff");
const NOVIEW = staff("ST-NOVIEW", "No Cash Book", "staff");
const WRITER = staff("ST-WRITE",  "Writer",       "staff");
const LEGACY = staff("ST-LEGACY", "Already Here", "staff");

grant(DAY.staffId,    ["view"]);                        period(DAY.staffId, "day", "2026-09-10");
grant(RANGE.staffId,  ["view", "print"]);               period(RANGE.staffId, "range", "2026-09-01", "2026-09-10");
grant(PERMNT.staffId, ["view"]);                        period(PERMNT.staffId, "permanent");
grant(WRITER.staffId, ["view", "add", "edit"]);         period(WRITER.staffId, "range", "2026-09-05", "2026-09-10");
grant(LEGACY.staffId, ["view", "add", "edit", "print"]);   /* no period row at all */
/* NOVIEW gets no staff_permissions row at all — the state every staff
   member is in until the owner ticks something. */

/* Five days of a real-looking book, either side of every boundary. */
const DAYS = [
  ["2026-08-25", "in",  1000, "Before",  "Sales"],
  ["2026-09-01", "in",  2000, "Start",   "Sales"],
  ["2026-09-05", "out",  500, "Middle",  "Wages"],
  ["2026-09-10", "in",  3000, "TheDay",  "Sales"],
  ["2026-09-15", "out",  700, "After",   "Wages"],
  ["2026-09-20", "in",   900, "Later",   "Sales"],
];
const IDS = {};
inCo(() => DAYS.forEach(([d, t, amt, party, cat], i) => {
  const id = "CASH-T" + i;
  IDS[d] = id;
  db.prepare("INSERT INTO cash_entries (id,date,type,amount,party,category,remarks,voided,created_at) VALUES (?,?,?,?,?,?,'',0,?)")
    .run(id, d, t, amt, party, cat, Date.now() + i);
}));

const dates = r => (Array.isArray(r.j) ? r.j : []).map(e => e.date).sort();
const uniq = a => [...new Set(a)];

(async () => {
  const srv = app.listen(0);
  await new Promise(r => srv.once("listening", r));
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ================================================================
     3. PERMANENT + VIEW  (and the owner, and the unconfigured staff) */
  console.log("--- 3. Permanent + View sees the whole book");
  const all = await call("GET", "/api/cashbook", null, PERMNT);
  ok("permanent sees every entry", all.j.length === DAYS.length, String(all.j.length));

  const owner = await call("GET", "/api/cashbook", null, OWNER);
  ok("the owner is not limited", owner.j.length === DAYS.length, String(owner.j.length));

  console.log("--- backward compatibility: nobody is restricted until the owner says so");
  const legacy = await call("GET", "/api/cashbook", null, LEGACY);
  ok("a staff member with no period set sees the whole book",
     legacy.j.length === DAYS.length, String(legacy.j.length));
  const legacyAdd = await call("POST", "/api/cashbook",
    { date: "2026-01-01", type: "in", amount: 5, category: "Sales" }, LEGACY);
  ok("and can still write any date", legacyAdd.status === 201, String(legacyAdd.status));
  inCo(() => db.prepare("DELETE FROM cash_entries WHERE id=?").run(legacyAdd.j.id));

  /* ================================================================
     1. ONE DAY + VIEW */
  console.log("--- 1. One Day + View");
  const day = await call("GET", "/api/cashbook", null, DAY);
  ok("only the one date comes back", uniq(dates(day)).join() === "2026-09-10",
     JSON.stringify(uniq(dates(day))));

  const daySum = await call("GET", "/api/cashbook/summary?from=2026-09-10&to=2026-09-10", null, DAY);
  ok("that day's income is the day's own", daySum.j.totalIn === 3000, String(daySum.j.totalIn));
  /* The book begins on their first allowed day. An opening balance carried
     in from before would hand them the sum of everything they cannot see. */
  ok("the opening balance does NOT carry in from before",
     daySum.j.openingBalance === 0, String(daySum.j.openingBalance));
  ok("closing is the day alone", daySum.j.closingBalance === 3000, String(daySum.j.closingBalance));

  /* ================================================================
     2. DATE RANGE + VIEW */
  console.log("--- 2. Date Range + View");
  const rng = await call("GET", "/api/cashbook", null, RANGE);
  ok("only the three dates inside the range",
     uniq(dates(rng)).join() === "2026-09-01,2026-09-05,2026-09-10",
     JSON.stringify(uniq(dates(rng))));
  ok("the day before the range is absent", !dates(rng).includes("2026-08-25"));
  ok("the day after the range is absent", !dates(rng).includes("2026-09-15"));

  /* ================================================================
     4. VIEW DISABLED */
  console.log("--- 4. View disabled: the Cash Book is not reachable at all");
  const READS = ["/api/cashbook", "/api/cashbook/summary", "/api/cashbook/days?month=2026-09",
                 "/api/cashbook/categories-used", "/api/cashbook/parties", "/api/cashbook/by-category",
                 "/api/cashbook/by-party", "/api/cashbook/history?party=TheDay", "/api/cashbook/daily",
                 "/api/cashbook/link-targets", "/api/cashbook/party-balances"];
  let refused = 0;
  for (const u of READS) {
    const r = await call("GET", u, null, NOVIEW);
    if (r.status === 403) refused++; else console.log("      " + u + " -> " + r.status);
  }
  ok("every read route refuses", refused === READS.length, refused + "/" + READS.length);
  const noAdd = await call("POST", "/api/cashbook", { date: "2026-09-10", type: "in", amount: 1 }, NOVIEW);
  ok("and so does writing", noAdd.status === 403, String(noAdd.status));

  /* ================================================================
     5. ADD / EDIT / PRINT */
  console.log("--- 5. Add, Edit and Print are separate grants");
  /* RANGE has view + print, not add or edit. */
  const addNo = await call("POST", "/api/cashbook", { date: "2026-09-05", type: "in", amount: 10 }, RANGE);
  ok("view without Add cannot create", addNo.status === 403, String(addNo.status));
  const editNo = await call("PUT", "/api/cashbook/" + IDS["2026-09-05"], { amount: 999 }, RANGE);
  ok("view without Edit cannot change", editNo.status === 403, String(editNo.status));
  const printYes = await call("GET", "/api/cashbook/export", null, RANGE);
  ok("Print granted can export", printYes.status === 200, String(printYes.status));

  /* DAY has view only. */
  const printNo = await call("GET", "/api/cashbook/export", null, DAY);
  ok("Print withheld refuses the export", printNo.status === 403, String(printNo.status));

  /* WRITER has view + add + edit inside 05–10. */
  const addYes = await call("POST", "/api/cashbook",
    { date: "2026-09-08", type: "in", amount: 250, category: "Sales" }, WRITER);
  ok("Add granted, inside the period, writes", addYes.status === 201, String(addYes.status));
  const editYes = await call("PUT", "/api/cashbook/" + addYes.j.id, { amount: 260 }, WRITER);
  ok("Edit granted, inside the period, changes", editYes.status === 200 && editYes.j.amount === 260,
     String(editYes.status) + " " + (editYes.j && editYes.j.amount));

  /* ================================================================
     6. DATES OUTSIDE THE PERIOD */
  console.log("--- 6. Writing outside the period");
  const addBefore = await call("POST", "/api/cashbook",
    { date: "2026-09-01", type: "in", amount: 10, category: "Sales" }, WRITER);
  ok("a date before the period is refused", addBefore.status === 403, String(addBefore.status));
  const addAfter = await call("POST", "/api/cashbook",
    { date: "2026-09-15", type: "in", amount: 10, category: "Sales" }, WRITER);
  ok("a date after the period is refused", addAfter.status === 403, String(addAfter.status));

  const moveOut = await call("PUT", "/api/cashbook/" + addYes.j.id, { date: "2026-09-20" }, WRITER);
  ok("an entry cannot be WALKED OUT of the period by an edit",
     moveOut.status === 403, String(moveOut.status));
  const stillThere = inCo(() => db.prepare("SELECT date FROM cash_entries WHERE id=?").get(addYes.j.id));
  ok("and the refused edit changed nothing", stillThere.date === "2026-09-08", stillThere.date);

  const editOutside = await call("PUT", "/api/cashbook/" + IDS["2026-09-20"], { amount: 1 }, WRITER);
  ok("an entry outside the period reads as NOT FOUND, not as forbidden",
     editOutside.status === 404, String(editOutside.status));
  const untouched = inCo(() => db.prepare("SELECT amount FROM cash_entries WHERE id=?").get(IDS["2026-09-20"]));
  ok("and it was not modified", untouched.amount === 900, String(untouched.amount));

  /* ================================================================
     7. GOING ROUND IT */
  console.log("--- 7. Asking differently does not widen the period");

  const wide = await call("GET", "/api/cashbook?from=2000-01-01&to=2099-12-31", null, DAY);
  ok("a wide date filter is still the one day",
     uniq(dates(wide)).join() === "2026-09-10", JSON.stringify(uniq(dates(wide))));

  const outside = await call("GET", "/api/cashbook?from=2026-09-15&to=2026-09-20", null, DAY);
  ok("asking only for days outside returns nothing", outside.j.length === 0, String(outside.j.length));

  /* Search deliberately ignores the date range — so it is the obvious way
     round a date restriction, and the one that has to be closed. */
  const searched = await call("GET", "/api/cashbook?q=Later", null, DAY);
  ok("SEARCH cannot reach outside the period", searched.j.length === 0,
     JSON.stringify(dates(searched)));
  const searchAmount = await call("GET", "/api/cashbook?q=900", null, DAY);
  ok("nor can searching by amount", searchAmount.j.length === 0, JSON.stringify(dates(searchAmount)));

  const otherMonth = await call("GET", "/api/cashbook/days?month=2026-08", null, DAY);
  ok("the calendar shows no days in a month they cannot see",
     otherMonth.j.days.length === 0, JSON.stringify(otherMonth.j.days));

  const cats = await call("GET", "/api/cashbook/categories-used", null, DAY);
  const wages = (cats.j || []).find(c => c.name === "Wages");
  ok("category counts do not include entries outside the period", !wages, JSON.stringify(cats.j));

  const parties = await call("GET", "/api/cashbook/parties", null, DAY);
  ok("party list does not name people from outside the period",
     !(parties.j || []).some(p => p.name === "Later" || p.name === "Before"),
     JSON.stringify((parties.j || []).map(p => p.name)));

  const sumWide = await call("GET", "/api/cashbook/summary?from=2000-01-01&to=2099-12-31", null, DAY);
  ok("totals over a wide range are still the period's totals",
     sumWide.j.totalIn === 3000 && sumWide.j.totalOut === 0,
     sumWide.j.totalIn + "/" + sumWide.j.totalOut);

  const byCat = await call("GET", "/api/cashbook/by-category?from=2000-01-01&to=2099-12-31", null, DAY);
  const catNames = ((byCat.j && byCat.j.groups) || byCat.j || []).map(g => g.name);
  ok("the category breakdown holds nothing from outside",
     !catNames.includes("Wages"), JSON.stringify(catNames));

  const hist = await call("GET", "/api/cashbook/history?party=Later", null, DAY);
  ok("a person's history is empty when their entries are outside",
     hist.status === 200 && hist.j.transactions === 0,
     String(hist.status) + " " + (hist.j && hist.j.transactions));

  const daily = await call("GET", "/api/cashbook/daily?date=2026-09-20", null, DAY);
  ok("the day view of a forbidden day shows nothing",
     (daily.j.entries || []).length === 0, JSON.stringify((daily.j.entries || []).length));

  console.log("--- 7b. and neither does leaving the Cash Book");
  const dash = await call("GET", "/api/reports/dashboard", null, DAY);
  ok("the dashboard's cash in hand is the period's, not the book's",
     dash.j.cashBalance === 3000, String(dash.j.cashBalance));
  const dashOwner = await call("GET", "/api/reports/dashboard", null, OWNER);
  ok("and the owner's is still the whole book",
     dashOwner.j.cashBalance !== 3000, String(dashOwner.j.cashBalance));

  /* The money position was already owner-only at the router — staff never
     reach it at all, which is stronger than a window. The window added to
     its cash figure is belt and braces for the day that guard changes. */
  const pos = await call("GET", "/api/position", null, DAY);
  ok("the money position refuses staff outright", pos.status === 403, String(pos.status));
  const posOwner = await call("GET", "/api/position", null, OWNER);
  ok("and answers the owner with the whole book",
     posOwner.status === 200 && posOwner.j.cash !== 3000,
     String(posOwner.status) + " " + (posOwner.j && posOwner.j.cash));

  const other = await call("GET", "/api/reports/other-entries?kind=expense&from=2000-01-01&to=2099-12-31", null, DAY);
  const otherRows = (other.j && (other.j.rows || other.j.entries)) || [];
  ok("Other Entries carries no cash row from outside the period",
     !otherRows.some(r => r.source === "cash" && r.date !== "2026-09-10"),
     JSON.stringify(otherRows.map(r => r.date)));

  const bs = await call("GET", "/api/reports/data?type=BalanceSheet", null, DAY);
  ok("the report API refuses an owner-only report to staff",
     bs.status === 403, String(bs.status));
  const bsOwner = await call("GET", "/api/reports/data?type=BalanceSheet", null, OWNER);
  ok("and still gives it to the owner", bsOwner.status === 200, String(bsOwner.status));

  /* ================================================================
     The owner's side of it */
  console.log("--- the owner sets and clears the period");
  const before = await call("GET", "/api/permissions/" + DAY.staffId, null, OWNER);
  ok("the period reads back", before.j.cashAccess.type === "day" && before.j.cashAccess.date === "2026-09-10",
     JSON.stringify(before.j.cashAccess));

  const half = await call("PUT", "/api/permissions/" + DAY.staffId,
    { ...before.j, cashAccess: { type: "day", date: "" } }, OWNER);
  ok("a half-set period is refused, not stored", half.status === 400, String(half.status));
  const backwards = await call("PUT", "/api/permissions/" + DAY.staffId,
    { ...before.j, cashAccess: { type: "range", from: "2026-09-10", to: "2026-09-01" } }, OWNER);
  ok("a From after a To is refused", backwards.status === 400, String(backwards.status));

  const afterHalf = await call("GET", "/api/permissions/" + DAY.staffId, null, OWNER);
  ok("and the refusals left the old period alone",
     afterHalf.j.cashAccess.date === "2026-09-10", JSON.stringify(afterHalf.j.cashAccess));

  const widen = await call("PUT", "/api/permissions/" + DAY.staffId,
    { ...before.j, cashAccess: { type: "permanent" } }, OWNER);
  ok("the owner can clear a period", widen.status === 200, String(widen.status));
  const nowAll = await call("GET", "/api/cashbook", null, DAY);
  ok("and the staff member sees the whole book immediately",
     nowAll.j.length === DAYS.length + 1, String(nowAll.j.length));

  const notOwner = await call("PUT", "/api/permissions/" + DAY.staffId,
    { ...before.j, cashAccess: { type: "permanent" } }, RANGE);
  ok("a staff member cannot set their own period", notOwner.status === 403, String(notOwner.status));

  console.log("--- what the staff member is told about their own limit");
  const me = await call("GET", "/api/permissions/me", null, RANGE);
  ok("their own window is reported to their screen",
     me.j.cashAccess && me.j.cashAccess.from === "2026-09-01" && me.j.cashAccess.to === "2026-09-10",
     JSON.stringify(me.j.cashAccess));
  const meOwner = await call("GET", "/api/permissions/me", null, OWNER);
  ok("the owner is told they have none", meOwner.j.cashAccess === null, JSON.stringify(meOwner.j.cashAccess));

  console.log("");
  console.log("  " + pass + " passed, " + fail + " failed");
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("  ERROR " + ((e && e.stack) || e)); process.exit(1); });
