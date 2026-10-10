/* ============================================================
   NOTIFICATIONS — the bell, end to end

   Against the real routes, mounted the way index.js mounts them, with
   two businesses side by side so that leaking one into the other would
   show. Every record is invented, in a temp directory.

     - creating, listing, paging, unread counts, read / read-all
     - the same incident twice is one notification
     - one business never sees another's; staff never see the owner's;
       nobody can mark somebody else's as read
     - notices to staff are the owner's alone
     - preferences are enforced by the server, essentials cannot be off
     - stock: a real size crossing a real minimum, once
     - security, licence, supplier notices and backup health
     - email: sent once to a local stand-in provider, never otherwise
     - the real server mounts it behind sign-in

   Run:  node test/notifications.test.js
   ============================================================ */
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
process.env.DATA_DIR = DATA_DIR;
for (const k of ["EMAIL_API_KEY", "EMAIL_FROM", "EMAIL_API_URL", "LICENCE_SERVER", "ASSISTANT_API_KEY"]) delete process.env[k];

const db = require(path.join(ROOT, "server/db.js"));
const express = require(path.join(ROOT, "node_modules/express"));
const session = require(path.join(ROOT, "node_modules/express-session"));
const { hashPin, requireAuth, requireRole } = require(path.join(ROOT, "server/auth.js"));
const { SqliteSessionStore } = require(path.join(ROOT, "server/sessionStore.js"));
const notify = require(path.join(ROOT, "server/notify.js"));
const notifyLicence = require(path.join(ROOT, "server/notifyLicence.js"));
const notifyEmail = require(path.join(ROOT, "server/notifyEmail.js"));
const inventory = require(path.join(ROOT, "server/inventory.js"));
const backup = require(path.join(ROOT, "server/backup.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 400) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOP = db.companies.create({ name: "Bell Shop" });
const OTHER = db.companies.create({ name: "Another Shop" });
const inShop = fn => db.companies.runAs(SHOP.id, fn);
const inOther = fn => db.companies.runAs(OTHER.id, fn);

/* ---- a server shaped like the real one ---------------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(session({
  store: new SqliteSessionStore({ dir: DATA_DIR }),
  secret: "a-test-secret-that-is-at-least-32-chars",
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { maxAge: 60000, httpOnly: true, sameSite: "lax", secure: false },
}));
/* Which business: the test says, through a header, as the shop login would
   through the session. Every route below is bound to it. */
app.use("/api", (req, _res, next) => {
  const id = (req.session && req.session.businessId) || req.headers["x-test-company"] || SHOP.id;
  db.companies.runAs(id, next);
});
app.use("/api/auth", (req, _res, next) => {
  if (req.path === "/login" && req.method === "POST") {
    const id = req.headers["x-test-company"] || SHOP.id;
    const done = () => { req.session.businessId = id; };
    const orig = _res.json.bind(_res);
    _res.json = b => { if (b && b.ok) done(); return orig(b); };
  }
  next();
}, require(path.join(ROOT, "server/routes/auth.js")));
app.use("/api/notifications", requireAuth, require(path.join(ROOT, "server/routes/notifications.js")));
app.use("/api/products", requireAuth, require(path.join(ROOT, "server/routes/products.js")));
app.use("/api/alerts", requireAuth, require(path.join(ROOT, "server/routes/alerts.js")));
app.use("/api/staff", requireAuth, requireRole("owner"), require(path.join(ROOT, "server/routes/staff.js")));

let BASE;
function jar(company) {
  let cookie = "";
  return {
    async call(method, url, body) {
      const headers = { "x-test-company": company || SHOP.id };
      if (cookie) headers.cookie = cookie;
      if (body) headers["content-type"] = "application/json";
      const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
      if (setC.length) cookie = setC.map(c => c.split(";")[0]).join("; ");
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
      return { status: r.status, j, text: t };
    },
  };
}

function seed() {
  for (const run of [inShop, inOther]) run(() => {
    db.prepare("UPDATE staff SET pin_hash = ? WHERE id = ?").run(hashPin("4821"), "STAFF_owner");
  });
  inShop(() => {
    const ins = db.prepare("INSERT INTO staff (id,name,pin_hash,role,active,created_at) VALUES (?,?,?,?,1,?)");
    /* Created a minute in the past, so "since they joined" includes now. */
    ins.run("ST-STOCK", "Stock Keeper", hashPin("7391"), "staff", Date.now() - 60000);
    ins.run("ST-COUNTER", "Counter", hashPin("5552"), "staff", Date.now() - 60000);
    db.prepare(`INSERT INTO staff_permissions (staff_id,module,can_view,can_add,can_edit,can_print)
                VALUES ('ST-STOCK','stock',1,0,0,0)`).run();
    db.prepare(`INSERT INTO products (id,name,brand,category,sku,unit,gst_rate,stock,created_at)
                VALUES ('P-PLY','Century Club Prime','Century','Plywood','CCP-18','Sheet',18,0,?)`).run(Date.now());
    db.prepare("INSERT INTO product_sizes (product_id,label,price,stock) VALUES ('P-PLY','18mm 8x4',3200,0)").run();
  });
}

(async () => {
  seed();
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  const owner = jar(), keeper = jar(), counter = jar(), otherOwner = jar(OTHER.id);
  ok("owner signs in", (await owner.call("POST", "/auth/login", { staffId: "STAFF_owner", pin: "4821" })).status === 200);
  ok("stock keeper signs in", (await keeper.call("POST", "/auth/login", { staffId: "ST-STOCK", pin: "7391" })).status === 200);
  ok("counter signs in", (await counter.call("POST", "/auth/login", { staffId: "ST-COUNTER", pin: "5552" })).status === 200);
  ok("the other business's owner signs in", (await otherOwner.call("POST", "/auth/login", { staffId: "STAFF_owner", pin: "4821" })).status === 200);

  /* ---------------------------------------------------------------- */
  console.log("\n--- creating, and the same incident twice ---\n");
  {
    const a = inShop(() => notify.create({ category: "system", title: "Backups are failing", key: "t:once" }));
    const b = inShop(() => notify.create({ category: "system", title: "Backups are failing", key: "t:once" }));
    ok("a notification is created", a.ok && !a.deduped && /^ntf_/.test(a.id), a);
    ok("the same key again is the same notification, not a second", b.ok && b.deduped && b.id === a.id, b);
    const n = inShop(() => db.prepare("SELECT COUNT(*) c FROM notifications WHERE dedupe_key='t:once'").get().c);
    ok("...one row in the table", n === 1, n);

    const r1 = inShop(() => notify.create({ category: "stock", audience: "perm:stock", title: "x", key: "t:repeat", repeatAfterMs: 50 }));
    const r2 = inShop(() => notify.create({ category: "stock", audience: "perm:stock", title: "x", key: "t:repeat", repeatAfterMs: 50 }));
    await sleep(80);
    const r3 = inShop(() => notify.create({ category: "stock", audience: "perm:stock", title: "x", key: "t:repeat", repeatAfterMs: 50 }));
    ok("inside its repeat window it is still the same incident", r2.deduped && r2.id === r1.id);
    ok("after the window it is a new event", !r3.deduped && r3.id !== r1.id);
    inShop(() => db.prepare("UPDATE notifications SET hidden_at = 1 WHERE dedupe_key = 't:repeat'").run());

    const bad = inShop(() => notify.create({ category: "nonsense", title: "x" }));
    ok("a malformed notification is refused — and create() does not throw", bad.ok === false);
    const badAud = inShop(() => notify.create({ category: "system", title: "x", audience: "everyone-everywhere" }));
    ok("an unknown audience is refused", badAud.ok === false);
    const link = inShop(() => notify.create({ category: "system", title: "Link test", link: "javascript:alert(1)", key: "t:link" }));
    const row = inShop(() => db.prepare("SELECT link_tab FROM notifications WHERE id = ?").get(link.id));
    ok("a link that is not a known screen is dropped, never stored", row.link_tab === "", row);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- who sees what ---\n");
  {
    inShop(() => notify.create({ category: "system", audience: "owner", title: "Owner-only fact", key: "t:owner" }));
    inShop(() => notify.create({ category: "stock", audience: "perm:stock", title: "Stock fact", key: "t:stock" }));
    inShop(() => notify.create({ category: "security", audience: "staff:ST-COUNTER", title: "For the counter only", key: "t:counter" }));
    inOther(() => notify.create({ category: "system", audience: "owner", title: "Another shop's secret", key: "t:other" }));

    const titles = async j => ((await j.call("GET", "/notifications?limit=50")).j.items || []).map(n => n.title);
    const o = await titles(owner), k = await titles(keeper), c = await titles(counter), x = await titles(otherOwner);
    ok("the owner sees owner notices", o.includes("Owner-only fact"));
    ok("the owner sees stock notices", o.includes("Stock fact"));
    ok("the owner does not see a notice addressed to one member of staff", !o.includes("For the counter only"));
    ok("staff allowed to see stock see stock notices", k.includes("Stock fact"), k);
    ok("staff never see owner notices", !k.includes("Owner-only fact") && !c.includes("Owner-only fact"));
    ok("staff without stock permission do not see stock notices", !c.includes("Stock fact"), c);
    ok("a notice addressed to one person reaches them", c.includes("For the counter only"));
    ok("...and nobody else", !k.includes("For the counter only"));
    ok("ONE BUSINESS NEVER SEES ANOTHER'S", !o.includes("Another shop's secret") && x.includes("Another shop's secret"), { o, x });
    ok("...and the other business does not see this one's", !x.includes("Owner-only fact"));

    const stranger = jar();
    ok("no session, no notifications (401)", (await stranger.call("GET", "/notifications")).status === 401);
    ok("no session, no count (401)", (await stranger.call("GET", "/notifications/count")).status === 401);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- unread, read, read-all, and paging ---\n");
  {
    const ownerId = inShop(() => db.prepare("SELECT id FROM notifications WHERE dedupe_key='t:owner'").get().id);
    const before = (await owner.call("GET", "/notifications/count")).j.unread;
    ok("the count is a number above zero", before > 0, before);

    const theirs = await counter.call("POST", "/notifications/read", { ids: [ownerId] });
    ok("staff cannot mark the owner's notice read — nothing is marked", theirs.status === 200 && theirs.j.marked === 0, theirs.j);
    const still = (await owner.call("GET", "/notifications?limit=50")).j.items.find(n => n.id === ownerId);
    ok("...and it is still unread for the owner", still && still.read === false);

    const mine = await owner.call("POST", "/notifications/read", { ids: [ownerId, "ntf_0000000000000000", "not-an-id"] });
    ok("marking read changes exactly the one that exists", mine.j.marked === 1, mine.j);
    ok("the count goes down by one", mine.j.unread === before - 1, { before, after: mine.j.unread });
    const again = await owner.call("POST", "/notifications/read", { ids: [ownerId] });
    ok("marking it again is harmless", again.j.marked === 0 && again.j.unread === before - 1);

    const kBefore = (await keeper.call("GET", "/notifications/count")).j.unread;
    const all = await owner.call("POST", "/notifications/read-all");
    ok("mark all read leaves the owner at zero", all.j.unread === 0 && (await owner.call("GET", "/notifications/count")).j.unread === 0);
    ok("...and does not touch anybody else's", (await keeper.call("GET", "/notifications/count")).j.unread === kBefore, kBefore);

    for (let i = 0; i < 60; i++) inShop(() => notify.create({ category: "system", title: `Page item ${i}`, key: `t:page:${i}` }));
    const p1 = (await owner.call("GET", "/notifications?limit=20")).j;
    const p2 = (await owner.call("GET", "/notifications?limit=20&before=" + encodeURIComponent(p1.next))).j;
    const p3 = (await owner.call("GET", "/notifications?limit=20&before=" + encodeURIComponent(p2.next))).j;
    const ids = [...p1.items, ...p2.items, ...p3.items].map(n => n.id);
    ok("pages are 20 at a time", p1.items.length === 20 && p2.items.length === 20, [p1.items.length, p2.items.length]);
    ok("pages never repeat an item", new Set(ids).size === ids.length);
    ok("newest first, all the way through", ids.length > 45 &&
      [...p1.items, ...p2.items, ...p3.items].every((n, i, a) => i === 0 || a[i - 1].at >= n.at));
    ok("the last page says there is no more", p3.next === null || p3.items.length === 20);
    ok("a limit above 50 is held to 50", (await owner.call("GET", "/notifications?limit=500")).j.items.length === 50);
    ok("a nonsense cursor is ignored, not an error", (await owner.call("GET", "/notifications?before=';DROP")).status === 200);

    const plan = inShop(() => db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM notifications n
      WHERE n.hidden_at IS NULL ORDER BY n.created_at DESC, n.id DESC LIMIT 20`).all()).map(r => r.detail).join(" | ");
    ok("the list is read through its index, not by sorting the table", /idx_notifications_at/.test(plan), plan);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- notices to staff are the owner's ---\n");
  {
    const s = await keeper.call("POST", "/notifications/announce", { title: "Free biryani", body: "from staff" });
    ok("staff cannot post a notice (403)", s.status === 403, s);
    const xss = `<img src=x onerror="alert(1)">Shop shut Sunday`;
    const o = await owner.call("POST", "/notifications/announce", { title: xss, body: "Back Monday." });
    ok("the owner can", o.status === 200 && /^ntf_/.test(o.j.id), o.j);
    const seen = (await counter.call("GET", "/notifications")).j.items.find(n => n.id === o.j.id);
    ok("staff see it", !!seen);
    ok("...stored as plain text, exactly as typed (the screen escapes it)", seen && seen.title === xss);
    ok("...with no link at all", seen && seen.link === "");
    ok("staff cannot withdraw it (403)", (await counter.call("POST", `/notifications/${o.j.id}/withdraw`)).status === 403);
    const sys = inShop(() => db.prepare("SELECT id FROM notifications WHERE dedupe_key='t:owner'").get().id);
    ok("the owner cannot withdraw a notice the system raised (404)", (await owner.call("POST", `/notifications/${sys}/withdraw`)).status === 404);
    ok("the owner can withdraw their own", (await owner.call("POST", `/notifications/${o.j.id}/withdraw`)).status === 200);
    ok("...and then nobody sees it", !(await counter.call("GET", "/notifications")).j.items.some(n => n.id === o.j.id));
    ok("...but it is kept, not deleted", inShop(() => !!db.prepare("SELECT 1 FROM notifications WHERE id = ?").get(o.j.id)));
    ok("an empty heading is refused", (await owner.call("POST", "/notifications/announce", { title: "  " })).status === 400);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- preferences, enforced by the server ---\n");
  {
    inShop(() => notify.create({ category: "announcement", audience: "all", title: "Quiet notice", key: "t:quiet" }));
    ok("staff see an announcement by default", (await counter.call("GET", "/notifications")).j.items.some(n => n.title === "Quiet notice"));
    const off = await counter.call("PUT", "/notifications/prefs/announcement", { inApp: false });
    ok("staff can switch announcements off", off.status === 200);
    ok("...and the server stops returning them", !(await counter.call("GET", "/notifications")).j.items.some(n => n.title === "Quiet notice"));
    ok("...or counting them", (await counter.call("GET", "/notifications/count")).j.unread ===
      (await counter.call("GET", "/notifications")).j.items.filter(n => !n.read).length);
    ok("...for them only", (await keeper.call("GET", "/notifications")).j.items.some(n => n.title === "Quiet notice"));

    const sec = await counter.call("PUT", "/notifications/prefs/security", { inApp: false });
    ok("security notices cannot be switched off (400)", sec.status === 400, sec.j);
    ok("...nor licence (400)", (await owner.call("PUT", "/notifications/prefs/licence", { inApp: false })).status === 400);
    ok("...nor system (400)", (await owner.call("PUT", "/notifications/prefs/system", { inApp: false })).status === 400);
    ok("staff cannot turn on email (403)", (await counter.call("PUT", "/notifications/prefs/security", { email: true })).status === 403);
    ok("announcements can never be emailed, even by the owner (403)",
      (await owner.call("PUT", "/notifications/prefs/announcement", { email: true })).status === 403);
    ok("an unknown kind is refused (400)", (await owner.call("PUT", "/notifications/prefs/whatever", { inApp: false })).status === 400);
    const prefs = (await counter.call("GET", "/notifications/prefs")).j;
    ok("staff without stock permission are not offered a stock preference", !prefs.categories.some(c => c.category === "stock"), prefs);
    ok("staff are not offered email", prefs.categories.every(c => !c.emailAllowed));
    await counter.call("PUT", "/notifications/prefs/announcement", { inApp: true });
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- stock, from a real size and a real minimum ---\n");
  {
    const sizeId = inShop(() => db.prepare("SELECT id FROM product_sizes WHERE product_id='P-PLY'").get().id);
    const shop = inShop(() => inventory.getLocationByCode("shop"));
    inShop(() => { inventory.addStock(sizeId, shop.id, 20); });
    const stockNotes = () => inShop(() => db.prepare(
      "SELECT title, body, audience FROM notifications WHERE category='stock' AND dedupe_key LIKE 'stock-%' ORDER BY created_at").all());

    const kRes = await keeper.call("PUT", `/products/P-PLY/sizes/${sizeId}/min-stock`, { locationId: shop.id, minStock: 10 });
    ok("view-only stock staff cannot set a minimum (403)", kRes.status === 403, kRes.j);
    ok("nonsense minimum refused (400)", (await owner.call("PUT", `/products/P-PLY/sizes/${sizeId}/min-stock`, { locationId: shop.id, minStock: "lots" })).status === 400);
    ok("a negative minimum refused (400)", (await owner.call("PUT", `/products/P-PLY/sizes/${sizeId}/min-stock`, { locationId: shop.id, minStock: -2 })).status === 400);
    const set = await owner.call("PUT", `/products/P-PLY/sizes/${sizeId}/min-stock`, { locationId: shop.id, minStock: 10 });
    ok("the owner sets a minimum of 10", set.status === 200 && set.j.minStock === 10, set.j);
    ok("...it is stored", inShop(() => db.prepare("SELECT min_stock FROM size_location_stock WHERE size_id=? AND location_id=?").get(sizeId, shop.id).min_stock) === 10);
    ok("...and the change is in the audit log", inShop(() => !!db.prepare("SELECT 1 FROM audit_log WHERE action='product.min_stock'").get()));
    ok("setting it notifies nobody — nothing has moved", stockNotes().length === 0);

    await owner.call("PATCH", `/products/P-PLY/sizes/${sizeId}/stock`, { delta: -5, locationId: shop.id });   // 15
    ok("15 left: still above the minimum, nothing said", stockNotes().length === 0);
    await owner.call("PATCH", `/products/P-PLY/sizes/${sizeId}/stock`, { delta: -6, locationId: shop.id });   // 9
    let n = stockNotes();
    ok("falling to 9 — below 10 — raises ONE notice", n.length === 1, n);
    ok("...saying what, where and the minimum", n[0] && /Century Club Prime \(18mm 8x4\)/.test(n[0].title) && /9 left at Shop/.test(n[0].body) && /minimum set is 10/.test(n[0].body), n[0]);
    ok("...for people allowed to see stock", n[0] && n[0].audience === "perm:stock");
    await owner.call("PATCH", `/products/P-PLY/sizes/${sizeId}/stock`, { delta: -1, locationId: shop.id });   // 8
    await owner.call("PATCH", `/products/P-PLY/sizes/${sizeId}/stock`, { delta: -1, locationId: shop.id });   // 7
    ok("selling more below the line says nothing more", stockNotes().length === 1, stockNotes().length);
    const der = (await keeper.call("GET", "/alerts")).j.groups.find(g => g.key === "stock-low");
    ok("the Reminders list shows it below its minimum, worked out from the stock", der && der.items.some(i => /7 at Shop · minimum 10/.test(i.sub)), der);
    ok("...but not to staff who may not see stock", !(await counter.call("GET", "/alerts")).j.groups.some(g => g.key === "stock-low"));

    await owner.call("PATCH", `/products/P-PLY/sizes/${sizeId}/stock`, { stock: 0, locationId: shop.id });     // 0
    n = stockNotes();
    ok("running out raises an out-of-stock notice", n.length === 2 && /^Out of stock: Century Club Prime/.test(n[1].title), n);
    const kSees = (await keeper.call("GET", "/notifications")).j.items.filter(x => x.category === "stock" && /Century/.test(x.title));
    ok("the stock keeper sees both, linked to the product", kSees.length === 2 && kSees.every(x => x.link === "product" && x.linkId === "P-PLY"), kSees);
    ok("the counter, without stock permission, sees neither",
      !(await counter.call("GET", "/notifications")).j.items.some(x => /Century/.test(x.title)));

    /* A rolled-back sale takes its notice with it. */
    inShop(() => inventory.addStock(sizeId, shop.id, 12));
    const beforeTx = stockNotes().length;
    try {
      inShop(() => db.transaction(() => { inventory.addStock(sizeId, shop.id, -12); throw new Error("sale abandoned"); })());
    } catch (e) { /* expected */ }
    ok("a sale that is rolled back leaves no stock notice behind", stockNotes().length === beforeTx, stockNotes().length);
    ok("...and the stock is untouched", inShop(() => inventory.getStock(sizeId, shop.id)) === 12);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- security events ---\n");
  {
    const intruder = jar();
    for (let i = 0; i < 5; i++) await intruder.call("POST", "/auth/login", { staffId: "ST-COUNTER", pin: "0000" });
    for (let i = 0; i < 5; i++) await intruder.call("POST", "/auth/login", { staffId: "ST-COUNTER", pin: "0000" });
    const lock = inShop(() => db.prepare("SELECT * FROM notifications WHERE dedupe_key = 'security:lockout:ST-COUNTER'").all());
    ok("five wrong PINs tell the owner, once — not again on the next five", lock.length === 1, lock.length);
    ok("...naming the account, never the PIN tried", lock[0] && /Counter/.test(lock[0].title) && !/0000/.test(lock[0].title + lock[0].body));
    ok("...to the owner only", lock[0] && lock[0].audience === "owner");

    const chg = await owner.call("PUT", "/staff/ST-COUNTER", { pin: "8642" });
    ok("the owner changes the counter's PIN", chg.status === 200, chg.j);
    const pinNote = (await counter.call("POST", "/auth/login", { staffId: "ST-COUNTER", pin: "8642" }),
                     (await counter.call("GET", "/notifications")).j.items.find(n => n.title === "Your PIN was changed"));
    ok("the counter is told their PIN was changed", !!pinNote);
    ok("...without the PIN in it", pinNote && !/8642/.test(pinNote.title + pinNote.body));
    ok("...and the stock keeper is not", !(await keeper.call("GET", "/notifications")).j.items.some(n => n.title === "Your PIN was changed"));

    const add = await owner.call("POST", "/staff", { name: "New Partner", pin: "13579", role: "owner" });
    ok("adding a second owner", add.status === 201);
    ok("...is a security notice to the owners", (await owner.call("GET", "/notifications")).j.items.some(n => n.title === "New owner login: New Partner" && n.category === "security"));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the subscription ---\n");
  {
    /* From the SHOP's today, which is what the app counts from — not UTC. */
    const { todayStr } = require(path.join(ROOT, "server/util.js"));
    const iso = d => new Date(Date.parse(todayStr() + "T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);
    const lic = () => inShop(() => db.prepare("SELECT title, severity, dedupe_key, audience FROM notifications WHERE category='licence' ORDER BY created_at").all());
    const e5 = iso(5);
    inShop(() => notifyLicence.judge({ kind: "active", expiresOn: e5, plan: "paid" }));
    ok("first sight of a date is not news", lic().length === 1 && /ends in 5 days/.test(lic()[0].title), lic());
    for (let i = 0; i < 5; i++) inShop(() => notifyLicence.judge({ kind: "active", expiresOn: e5, plan: "paid" }));
    ok("...but five days out is a warning, said once however often it is checked", lic().length === 1);
    ok("...to the owner", lic()[0].audience === "owner" && lic()[0].severity === "warning");
    const e1 = iso(1);
    inShop(() => notifyLicence.judge({ kind: "active", expiresOn: e1, plan: "paid" }));
    ok("the last day is its own notice", lic().some(n => /ends tomorrow/.test(n.title)), lic());
    const later = iso(370);
    inShop(() => notifyLicence.judge({ kind: "active", expiresOn: later, plan: "paid" }));
    ok("a later date is a renewal", lic().some(n => n.title === `Subscription renewed until ${later}`), lic());
    inShop(() => notifyLicence.judge({ kind: "expired", expiresOn: iso(-1), plan: "demo" }));
    inShop(() => notifyLicence.judge({ kind: "expired", expiresOn: iso(-1), plan: "demo" }));
    const ended = lic().filter(n => n.title === "Your demo has ended");
    ok("an ended demo is said as a demo, once, critical", ended.length === 1 && ended[0].severity === "critical", lic());
    inShop(() => notifyLicence.judge({ kind: "cancelled", expiresOn: later, plan: "paid" }));
    ok("a cancellation is its own notice", lic().some(n => n.title === "Your subscription has been cancelled"));
    inShop(() => notifyLicence.judge({ kind: "unrecognised", expiresOn: later }));
    const unr = lic().find(n => n.dedupe_key === "licence:unrecognised");
    ok("'not recognised' is a WARNING, worded as not confirmed — not as an ending", unr && unr.severity === "warning" && /still working/.test(
      inShop(() => db.prepare("SELECT body FROM notifications WHERE dedupe_key='licence:unrecognised'").get().body)));
    ok("none of it reached the other business", inOther(() => db.prepare("SELECT COUNT(*) c FROM notifications WHERE category='licence'").get().c) === 0);
    ok("the counter does not see subscription notices", !(await counter.call("GET", "/notifications?limit=50")).j.items.some(n => n.category === "licence"));

    const t = notifyLicence.fromTenant({ company_id: OTHER.id, expires_on: iso(3), plan: "demo", blocked: 0 });
    ok("a shop on a shared installation is judged from its own tenant row", t.kind === "active" && t.expiresOn === iso(3));
    notifyLicence.forTenant({ company_id: OTHER.id, expires_on: iso(3), plan: "demo", blocked: 0 });
    ok("...into its own books only", inOther(() => db.prepare("SELECT COUNT(*) c FROM notifications WHERE category='licence'").get().c) === 1 &&
      !lic().some(n => /demo ends in 3 days/.test(n.title)));
    ok("a blocked tenant is a cancellation", notifyLicence.fromTenant({ expires_on: iso(30), blocked: 1 }).kind === "cancelled");
    ok("the shop's own copy (nothing enforced) sweeps without saying anything",
      (() => { const n0 = inShop(() => db.prepare("SELECT COUNT(*) c FROM notifications").get().c); notifyLicence.sweep();
               return inShop(() => db.prepare("SELECT COUNT(*) c FROM notifications").get().c) === n0; })());
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- what the supplier publishes ---\n");
  {
    inShop(() => notify.syncVendorAnnouncements([{ id: "an_1", title: "Maintenance Sunday 2am", body: "Ten minutes." }], []));
    inShop(() => notify.syncVendorAnnouncements([{ id: "an_1", title: "Maintenance Sunday 2am", body: "Ten minutes." }], []));
    const v = () => inShop(() => db.prepare("SELECT * FROM notifications WHERE dedupe_key='vendor:an_1'").all());
    ok("a supplier notice becomes one notification, however often it is sent", v().length === 1 && v()[0].source === "vendor");
    const seen = (await counter.call("GET", "/notifications")).j.items.find(n => n.title === "Maintenance Sunday 2am");
    ok("...seen by staff, marked as from the supplier", seen && seen.source === "vendor");
    await counter.call("POST", "/notifications/read", { ids: [seen.id] });
    inShop(() => notify.syncVendorAnnouncements([{ id: "an_1", title: "Maintenance Sunday 3am", body: "Moved." }], []));
    const edited = (await counter.call("GET", "/notifications")).j.items.find(n => n.id === seen.id);
    ok("an edit by the supplier changes the words", edited && edited.title === "Maintenance Sunday 3am");
    ok("...without marking it unread again", edited && edited.read === true);
    inShop(() => notify.syncVendorAnnouncements([], ["an_1"]));
    ok("withdrawn by the supplier, it disappears", !(await counter.call("GET", "/notifications")).j.items.some(n => n.id === seen.id));
    ok("...and is kept", v().length === 1 && !!v()[0].hidden_at);
    inShop(() => notify.syncVendorAnnouncements([{ id: "../../etc", title: "bad id" }, null, { title: "no id" }], ["x"]));
    ok("a notice with a malformed id is ignored", inShop(() => !db.prepare("SELECT 1 FROM notifications WHERE title='bad id' OR title='no id'").get()));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- backup health: two failures in a row, once ---\n");
  {
    const sys = () => inShop(() => db.prepare("SELECT title FROM notifications WHERE dedupe_key LIKE 'system:backup-%' ORDER BY created_at").all().map(r => r.title));
    backup._health("failed");
    ok("one failed backup is not reported (it usually fixes itself)", sys().length === 0, sys());
    backup._health("failed");
    ok("two in a row is reported", sys().length === 1 && sys()[0] === "Backups are failing", sys());
    backup._health("failed"); backup._health("failed");
    ok("...once, not on every failure after", sys().length === 1, sys());
    backup._health("ok");
    ok("recovery is reported", sys().length === 2 && sys()[1] === "Backups are working again", sys());
    backup._health("ok");
    ok("...once", sys().length === 2);
    ok("both businesses' owners are told — the backup covers both",
      inOther(() => db.prepare("SELECT COUNT(*) c FROM notifications WHERE dedupe_key LIKE 'system:backup-%'").get().c) === 2);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- email: off unless configured, once when it is ---\n");
  {
    ok("with nothing configured, email is off", notifyEmail.configured() === false);
    const off = inShop(() => notify.create({ category: "security", title: "Not emailed", key: "t:mail-off" }));
    ok("...and delivering does nothing", (await notifyEmail.deliver(SHOP.id, off.id)) === "not-configured");

    /* A stand-in for the provider, on this machine. Nothing leaves it. */
    const got = [];
    let answer = 200;
    const stub = http.createServer((req, res) => {
      let b = ""; req.on("data", d => b += d);
      req.on("end", () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(answer); res.end("{}"); });
    }).listen(0);
    process.env.EMAIL_API_KEY = "re_test_not_a_real_key";
    process.env.EMAIL_FROM = "Shop Manager <alerts@example.test>";
    process.env.EMAIL_API_URL = `http://127.0.0.1:${stub.address().port}/emails`;
    ok("with a key and a sender, email is available", notifyEmail.configured());
    ok("the owner is offered it", (await owner.call("GET", "/notifications/prefs")).j.emailAvailable === true);

    const n1 = inShop(() => notify.create({ category: "security", title: "Not wanted", key: "t:mail-1" }));
    await sleep(150);
    ok("nobody has asked for email yet, so nothing is sent", got.length === 0 && (await notifyEmail.deliver(SHOP.id, n1.id)) === "not-wanted");

    await owner.call("PUT", "/notifications/prefs/security", { email: true });
    inShop(() => db.prepare("UPDATE settings SET email = '' WHERE id = 1").run());
    const n2 = inShop(() => notify.create({ category: "security", title: "No address", key: "t:mail-2" }));
    await sleep(200);   // let its own automatic attempt run while there is still no address
    ok("asked for, but no business email: nothing sent, said why", (await notifyEmail.deliver(SHOP.id, n2.id)) === "no-address");

    inShop(() => db.prepare("UPDATE settings SET email = 'owner@shop.example' WHERE id = 1").run());
    const n3 = inShop(() => notify.create({ category: "security", title: "Someone signed in oddly", body: "Look at the activity log.", key: "t:mail-3" }));
    await sleep(300);
    ok("asked for, with an address: sent once, on its own", got.length === 1, got.length);
    ok("...to the business email", got[0] && JSON.stringify(got[0].body.to) === '["owner@shop.example"]');
    ok("...with the key as a bearer token, never in the body", got[0] && got[0].auth === "Bearer re_test_not_a_real_key" && !JSON.stringify(got[0].body).includes("re_test"));
    ok("...saying what happened", got[0] && /Someone signed in oddly/.test(got[0].body.subject) && /Look at the activity log/.test(got[0].body.text));
    ok("a second attempt for the same notice sends nothing", (await notifyEmail.deliver(SHOP.id, n3.id)) === "skipped" && got.length === 1);

    inShop(() => notify.create({ category: "stock", audience: "perm:stock", title: "Stock, not asked for", key: "t:mail-4" }));
    inShop(() => notify.create({ category: "announcement", audience: "all", title: "Notice, never mailed", key: "t:mail-5" }));
    await sleep(300);
    ok("other kinds are not emailed unless asked for; announcements never", got.length === 1, got.map(g => g.body.subject));
    inOther(() => notify.create({ category: "security", title: "Other shop event", key: "t:mail-6" }));
    await sleep(300);
    ok("one shop's choice does not email another shop's events", got.length === 1);

    answer = 500;
    const n7 = inShop(() => db.prepare("SELECT id FROM notifications WHERE id = ?").get(
      notify.create({ category: "security", title: "Provider down", key: "t:mail-7" }).id).id);
    await sleep(300);
    ok("a provider that refuses: tried once, not in a loop", got.length === 2, got.length);
    ok("...and the notice is left unsent, so it is honest about it",
      inShop(() => db.prepare("SELECT emailed_at FROM notifications WHERE id = ?").get(n7).emailed_at) === null);
    stub.close();
    for (const k of ["EMAIL_API_KEY", "EMAIL_FROM", "EMAIL_API_URL"]) delete process.env[k];
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the real server mounts it behind sign-in ---\n");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-srv-"));
    const p = spawn(process.execPath, ["--no-warnings", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, PORT: "4881",
             SUPABASE_URL: "", SUPABASE_KEY: "", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" },
    });
    let out = "";
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    for (let i = 0; i < 120 && !/running on port 4881/.test(out); i++) await sleep(250);
    ok("the server starts with the new tables", /running on port 4881/.test(out), out.slice(-400));
    const r = await fetch("http://127.0.0.1:4881/api/notifications");
    ok("/api/notifications without a session is refused (401)", r.status === 401, r.status);
    const c = await fetch("http://127.0.0.1:4881/api/notifications/count");
    ok("/api/notifications/count too", c.status === 401);
    const html = await (await fetch("http://127.0.0.1:4881/")).text();
    ok("the bell is labelled for what it now holds", /aria-label="Notifications and reminders"/.test(html));
    p.kill();
    await sleep(400);
    ok("no errors were logged while it ran", !/\[error\]|\[notify\] could not/.test(out), out.slice(-400));
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
