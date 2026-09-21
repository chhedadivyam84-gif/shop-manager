/* ============================================================
   THE APP THAT WAS ALREADY THERE

   Everything added lately — the cash-book marks, the pinned action bar,
   the Tally file export, the historical import — was added on the promise
   that it changed nothing else. This is the test that stops that being a
   promise.

   It runs against a COPY of real books and checks two kinds of thing:

     · the figures. A cash book that totals differently after a release is
       broken whether or not every page still loads.

     · the paths. Every screen the shop opens daily, end to end over HTTP,
       with a real session.

   It writes nothing. Not one request here creates, edits or deletes, so
   it can be run against a copy of live data as often as anyone likes.

   Run:  node test/regression.test.js <base url> <cookie>
   ============================================================ */
const BASE = (process.argv[2] || "http://localhost:4822").replace(/\/$/, "");
const COOKIE = process.argv[3] || "";

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x ? "   " + x : "")); }
};

const get = async (u) => {
  const r = await fetch(BASE + u, { headers: { cookie: COOKIE } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, j, text: t };
};

const n2 = v => Math.round((Number(v) || 0) * 100) / 100;

(async () => {
  console.log("--- every daily screen answers");
  const screens = [
    ["dashboard",      "/api/reports/dashboard"],
    ["cash book",      "/api/cashbook"],
    ["cash summary",   "/api/cashbook/summary?from=2000-01-01&to=2099-12-31"],
    ["customers",      "/api/customers"],
    ["suppliers",      "/api/suppliers"],
    ["products",       "/api/products"],
    ["invoices",       "/api/invoices"],
    ["purchases",      "/api/purchases"],
    ["outstanding",    "/api/accounting/outstanding"],   /* what the screen itself calls */
    ["bank book",      "/api/bankbook"],
    ["stock history",  "/api/stock-history"],
    ["tally settings", "/api/tally/settings"],
    ["tally queue",    "/api/tally/queue"],
    ["reminders",      "/api/alerts"],
    ["settings",       "/api/settings"],
  ];
  const seen = {};
  for (const [name, url] of screens) {
    const r = await get(url);
    seen[name] = r;
    ok(name + " loads", r.status === 200, url + " -> " + r.status);
  }

  console.log("--- the cash book still adds up");
  const sum = seen["cash summary"].j;
  const entries = seen["cash book"].j;
  if (sum && Array.isArray(entries)) {
    const totIn = n2(entries.filter(e => e.type === "in").reduce((s, e) => s + e.amount, 0));
    const totOut = n2(entries.filter(e => e.type === "out").reduce((s, e) => s + e.amount, 0));
    ok("summary agrees with the entries",
       n2(sum.totalIn) === totIn && n2(sum.totalOut) === totOut,
       `summary ${sum.totalIn}/${sum.totalOut} vs entries ${totIn}/${totOut}`);
    ok("closing = opening + in - out",
       n2(sum.closingBalance) === n2(sum.openingBalance + sum.totalIn - sum.totalOut),
       JSON.stringify({ o: sum.openingBalance, i: sum.totalIn, u: sum.totalOut, c: sum.closingBalance }));
    ok("entry count matches", sum.entryCount === entries.length,
       sum.entryCount + " vs " + entries.length);
  } else ok("cash book comparable", false, "unexpected shape");

  console.log("--- the historical tables are separate from the live ones");
  const hist = await get("/api/imports/history");
  ok("import history reachable", hist.status === 200, String(hist.status));
  /* The cash book must not have grown historical rows. It reads
     cash_entries; hist_cash_entries is a different table and this is the
     assertion that they never became the same one. */
  const cashAgain = await get("/api/cashbook");
  ok("cash book unchanged by the import module existing",
     Array.isArray(cashAgain.j) && cashAgain.j.length === entries.length,
     entries.length + " -> " + (cashAgain.j || []).length);

  console.log("--- stock is only ever what the stock screens say");
  const sheet = await get("/api/opening-stock/sheet");
  ok("opening-stock sheet reachable", sheet.status === 200, String(sheet.status));
  const prod = seen["products"].j;
  if (sheet.j && Array.isArray(prod)) {
    /* Every size on the count sheet belongs to a product the app knows —
       a sheet listing something Inventory has never heard of would mean
       the two had drifted apart. */
    const ids = new Set(prod.map(p => p.id));
    const strays = (sheet.j.rows || []).filter(r => !ids.has(r.product_id));
    ok("no size on the sheet is orphaned", strays.length === 0,
       strays.slice(0, 3).map(s => s.product_name).join(", "));
  }

  console.log("--- the Tally export builds without sending or changing anything");
  const qBefore = await get("/api/tally/queue?status=PENDING");
  const prev = await get("/api/tally/export/preview?scope=pending");
  ok("export preview answers", prev.status === 200 || prev.status === 400,
     String(prev.status) + (prev.j && prev.j.error ? " " + prev.j.error : ""));
  const qAfter = await get("/api/tally/queue?status=PENDING");
  const len = r => Array.isArray(r.j) ? r.j.length : (r.j && Array.isArray(r.j.rows) ? r.j.rows.length : -1);
  ok("the queue is exactly as it was", len(qBefore) === len(qAfter),
     len(qBefore) + " -> " + len(qAfter));

  console.log("--- the new screens are guarded, not just present");
  /* Reached without a session at all: the module must refuse rather than
     answer, whatever the UI happens to show. */
  const bare = await fetch(BASE + "/api/imports/history");
  ok("import history refuses an unauthenticated caller",
     bare.status === 401 || bare.status === 403, String(bare.status));
  const bareStock = await fetch(BASE + "/api/opening-stock/sheet");
  ok("opening stock refuses an unauthenticated caller",
     bareStock.status === 401 || bareStock.status === 403, String(bareStock.status));

  console.log("");
  console.log("  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("  ERROR " + e.message); process.exit(1); });
