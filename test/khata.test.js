/* ============================================================
   THE KHATA — what the cash book alone says a party owes.

   Runs the real cashbook router against a scratch database, so the
   assertions are about the code that will actually serve the shop rather
   than a re-implementation of it. Nothing here touches a real book: the
   whole thing lives in a temp DATA_DIR built and thrown away per run.
   ============================================================ */
const fs = require("fs"), path = require("path"), os = require("os");
const DATA_DIR = path.join(os.tmpdir(), "sm-khata-" + process.pid);
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

const CO = db.companies.create({ name: "Khata Test" });

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = { staffId: "S1", staffName: "Tester", role: "owner" };
  db.companies.runAs(CO.id, next);
});
app.use("/api/cashbook", require(path.join(ROOT, "server/routes/cashbook.js")));

const inCo = fn => db.companies.runAs(CO.id, fn);

let BASE;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

(async () => {
  const srv = app.listen(0);
  await new Promise(r => srv.once("listening", r));
  BASE = "http://127.0.0.1:" + srv.address().port;

  /* ---------------------------------------------------------- */
  console.log("--- the columns arrived without disturbing anything");
  const cols = inCo(() => db.prepare("PRAGMA table_info(cash_entries)").all().map(c => c.name));
  ok("party_type exists", cols.includes("party_type"));
  ok("party_id exists", cols.includes("party_id"));

  /* An entry written the old way, before any of this existed. */
  const OLD = "CASH-OLD-1";
  inCo(() => db.prepare("INSERT INTO cash_entries (id,date,type,amount,party,category,remarks,voided,created_at) VALUES (?,?,?,?,?,?,?,0,?)")
    .run(OLD, "2025-01-05", "in", 500, "walk-in", "Sales", "", Date.now()));
  const oldRow = inCo(() => db.prepare("SELECT * FROM cash_entries WHERE id=?").get(OLD));
  ok("an unlinked row is blank, not null", oldRow.party_type === "" && oldRow.party_id === "",
     JSON.stringify([oldRow.party_type, oldRow.party_id]));

  const CUST = "C-RAMESH";
  const SUPP = "S-GREENPLY";
  inCo(() => {
    const now = Date.now();
    db.prepare("INSERT INTO customers (id,name,phone,created_at) VALUES (?,?,?,?)").run(CUST, "Ramesh Lodha", "9000000001", now);
    db.prepare("INSERT INTO suppliers (id,name,phone,created_at) VALUES (?,?,?,?)").run(SUPP, "Greenply Depot", "9000000002", now);
  });

  /* ---------------------------------------------------------- */
  console.log("--- the dropdown offers both sides");
  const targets = await call("GET", "/api/cashbook/link-targets");
  ok("link targets answer", targets.status === 200, String(targets.status));
  ok("the customer is offered", targets.j.some(t => t.id === CUST && t.type === "customer"));
  ok("the supplier is offered", targets.j.some(t => t.id === SUPP && t.type === "supplier"));

  /* ---------------------------------------------------------- */
  console.log("--- a link is refused unless it resolves");
  const badType = await call("POST", "/api/cashbook",
    { date: "2025-02-01", type: "out", amount: 100, partyType: "vendor", partyId: CUST });
  ok("an unknown party type is refused", badType.status === 400, String(badType.status));
  const badId = await call("POST", "/api/cashbook",
    { date: "2025-02-01", type: "out", amount: 100, partyType: "customer", partyId: "C-GHOST" });
  ok("a party that is not there is refused", badId.status === 400, String(badId.status));
  ok("neither refusal wrote a row",
     inCo(() => db.prepare("SELECT COUNT(*) n FROM cash_entries").get().n) === 1);

  /* ---------------------------------------------------------- */
  console.log("--- an entry with no party at all still works");
  const plain = await call("POST", "/api/cashbook",
    { date: "2025-02-02", type: "out", amount: 250, party: "chai", category: "Staff Welfare" });
  ok("a nameless entry is accepted", plain.status === 201, String(plain.status));
  ok("and carries no link", plain.j.party_type === "" && plain.j.party_id === "",
     JSON.stringify([plain.j.party_type, plain.j.party_id]));

  /* ---------------------------------------------------------- */
  console.log("--- the sign rule: out means they owe more, in means less");
  const mk = (type, amount, date, partyType, partyId) =>
    call("POST", "/api/cashbook",
      { date, type, amount, partyType, partyId, category: type === "in" ? "Sales" : "Purchase" });

  const g1 = await mk("out", 25000, "2025-03-01", "customer", CUST);
  ok("goods given on credit recorded", g1.status === 201, String(g1.status));
  ok("the real name is written into the party column", g1.j.party === "Ramesh Lodha", g1.j.party);
  await mk("in", 10000, "2025-03-10", "customer", CUST);

  const bal = await call("GET", "/api/cashbook/party/customer/" + CUST);
  ok("the customer's khata answers", bal.status === 200, String(bal.status));
  ok("given 25000", bal.j.given === 25000, String(bal.j.given));
  ok("received 10000", bal.j.received === 10000, String(bal.j.received));
  ok("owes 15000", bal.j.balance === 15000, String(bal.j.balance));
  ok("entries is a COUNT, not the list", bal.j.entries === 2, JSON.stringify(bal.j.entries));
  ok("the rows live under history", Array.isArray(bal.j.history) && bal.j.history.length === 2,
     JSON.stringify((bal.j.history || []).length));
  ok("the running total reads down the page",
     bal.j.history[0].balance === 25000 && bal.j.history[1].balance === 15000,
     JSON.stringify(bal.j.history.map(h => h.balance)));

  /* A supplier paid before the goods arrive is the shop out of pocket. */
  await mk("out", 40000, "2025-03-05", "supplier", SUPP);
  const sbal = await call("GET", "/api/cashbook/party/supplier/" + SUPP);
  ok("a supplier paid in advance carries the figure", sbal.j.balance === 40000, String(sbal.j.balance));

  const gone = await call("GET", "/api/cashbook/party/customer/C-GHOST");
  ok("a party that is not there is a 404, not a zero", gone.status === 404, String(gone.status));

  /* ---------------------------------------------------------- */
  console.log("--- money already counted elsewhere is left out");
  /* What bankLink.js writes when a payment is recorded on the Customers
     screen: it has already moved customers.due, so counting it here would
     take the same receipt off the party twice. */
  inCo(() => db.prepare("INSERT INTO cash_entries (id,date,type,amount,party,category,remarks,voided,party_type,party_id,source_type,source_id,created_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)")
    .run("CASH-AUTO-1", "2025-03-12", "in", 5000, "Ramesh Lodha", "Sales", "", "customer", CUST, "payment", "PAY-1", Date.now()));
  const afterAuto = await call("GET", "/api/cashbook/party/customer/" + CUST);
  ok("an auto-posted receipt does not move the khata", afterAuto.j.balance === 15000, String(afterAuto.j.balance));
  ok("nor does it join the count", afterAuto.j.entries === 2, String(afterAuto.j.entries));

  inCo(() => db.prepare("INSERT INTO cash_entries (id,date,type,amount,party,category,remarks,voided,party_type,party_id,created_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)")
    .run("CASH-VOID-1", "2025-03-13", "out", 9999, "Ramesh Lodha", "Purchase", "", "customer", CUST, Date.now()));
  const afterVoid = await call("GET", "/api/cashbook/party/customer/" + CUST);
  ok("a voided row does not move the khata", afterVoid.j.balance === 15000, String(afterVoid.j.balance));

  /* ---------------------------------------------------------- */
  console.log("--- editing a link");
  const eid = g1.j.id;
  const keep = await call("PUT", "/api/cashbook/" + eid, { amount: 26000 });
  ok("an edit that says nothing about the party keeps the link",
     keep.j.party_type === "customer" && keep.j.party_id === CUST,
     JSON.stringify([keep.j.party_type, keep.j.party_id]));
  const keptBal = await call("GET", "/api/cashbook/party/customer/" + CUST);
  ok("and the balance follows the new amount", keptBal.j.balance === 16000, String(keptBal.j.balance));

  const cleared = await call("PUT", "/api/cashbook/" + eid, { partyType: "", partyId: "", party: "someone else" });
  ok("sending it empty clears the link",
     cleared.j.party_type === "" && cleared.j.party_id === "",
     JSON.stringify([cleared.j.party_type, cleared.j.party_id]));
  const clearedBal = await call("GET", "/api/cashbook/party/customer/" + CUST);
  ok("the khata drops what is no longer linked", clearedBal.j.balance === -10000, String(clearedBal.j.balance));

  await call("PUT", "/api/cashbook/" + eid, { partyType: "customer", partyId: CUST, amount: 25000 });
  const restored = await call("GET", "/api/cashbook/party/customer/" + CUST);
  ok("and takes it back when it is re-linked", restored.j.balance === 15000, String(restored.j.balance));

  /* ---------------------------------------------------------- */
  console.log("--- the list of everyone");
  const all = await call("GET", "/api/cashbook/party-balances");
  ok("party balances answer", all.status === 200, String(all.status));
  ok("both parties are listed", all.j.parties.length === 2, String(all.j.parties.length));
  ok("heaviest first", Math.abs(all.j.parties[0].balance) >= Math.abs(all.j.parties[1].balance),
     JSON.stringify(all.j.parties.map(p => p.balance)));
  ok("names are attached", all.j.parties.every(p => p.name && p.name !== "(deleted party)"),
     JSON.stringify(all.j.parties.map(p => p.name)));
  ok("owed to the shop adds up", all.j.owedToShop === 55000, String(all.j.owedToShop));
  ok("owed by the shop adds up", all.j.owedByShop === 0, String(all.j.owedByShop));

  const custOnly = await call("GET", "/api/cashbook/party-balances?type=customer");
  ok("filtering to customers works",
     custOnly.j.parties.length === 1 && custOnly.j.parties[0].partyId === CUST,
     JSON.stringify(custOnly.j.parties.map(p => p.partyId)));
  const badFilter = await call("GET", "/api/cashbook/party-balances?type=vendor");
  ok("an unknown type is refused", badFilter.status === 400, String(badFilter.status));

  /* A party removed after the money moved keeps its figure. */
  inCo(() => db.prepare("DELETE FROM suppliers WHERE id=?").run(SUPP));
  const afterDelete = await call("GET", "/api/cashbook/party-balances");
  const orphan = afterDelete.j.parties.find(p => p.partyId === SUPP);
  ok("a removed party's money does not vanish", !!orphan && orphan.balance === 40000,
     JSON.stringify(orphan));
  ok("and it is labelled rather than left blank",
     !!orphan && orphan.name === "(deleted party)", orphan && orphan.name);

  /* ---------------------------------------------------------- */
  console.log("--- the person screen says whether this is an account or just a name");
  const linkedHist = await call("GET", "/api/cashbook/history?party=" + encodeURIComponent("Ramesh Lodha"));
  ok("a linked name carries a khata", !!linkedHist.j.khata && linkedHist.j.khata.balance === 15000,
     JSON.stringify(linkedHist.j.khata));
  ok("and it is named", linkedHist.j.khata && linkedHist.j.khata.name === "Ramesh Lodha",
     linkedHist.j.khata && linkedHist.j.khata.name);

  const plainHist = await call("GET", "/api/cashbook/history?party=chai");
  ok("a name that is only a name has NO khata", plainHist.j.khata === null, JSON.stringify(plainHist.j.khata));
  ok("but still has its figures", plainHist.j.expense === 250, String(plainHist.j.expense));

  const noneHist = await call("GET", "/api/cashbook/history?party=(none)");
  ok("the nameless group can be asked for", noneHist.status === 200, String(noneHist.status));
  const neither = await call("GET", "/api/cashbook/history");
  ok("asking for nothing is still refused", neither.status === 400, String(neither.status));

  /* ---------------------------------------------------------- */
  console.log("--- the cash book itself is unchanged by all of it");
  const list = await call("GET", "/api/cashbook");
  const sum = await call("GET", "/api/cashbook/summary?from=2000-01-01&to=2099-12-31");
  const n2 = v => Math.round((Number(v) || 0) * 100) / 100;
  const rows = list.j.filter(e => !e.voided);
  const tIn = n2(rows.filter(e => e.type === "in").reduce((s, e) => s + e.amount, 0));
  const tOut = n2(rows.filter(e => e.type === "out").reduce((s, e) => s + e.amount, 0));
  ok("the summary still equals the entries",
     n2(sum.j.totalIn) === tIn && n2(sum.j.totalOut) === tOut,
     sum.j.totalIn + "/" + sum.j.totalOut + " vs " + tIn + "/" + tOut);
  ok("closing = opening + in - out",
     n2(sum.j.closingBalance) === n2(sum.j.openingBalance + sum.j.totalIn - sum.j.totalOut),
     JSON.stringify({ o: sum.j.openingBalance, i: sum.j.totalIn, u: sum.j.totalOut, c: sum.j.closingBalance }));
  ok("a linked entry is an ORDINARY cash entry to the book",
     list.j.some(e => e.party === "Ramesh Lodha" && e.type === "out" && e.amount === 25000));

  console.log("");
  console.log("  " + pass + " passed, " + fail + " failed");
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("  ERROR " + ((e && e.stack) || e)); process.exit(1); });
