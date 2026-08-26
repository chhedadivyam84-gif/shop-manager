/* Party-wise price lists.

   The rules being checked are the ones in the spec, in the spec's order,
   and the last group is the one that matters most: a price list must never
   be able to change what a bill already says. */
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const APP = "C:/Users/prafu/shop-manager";
const PORT = 4489;

let fails = 0, cookie = "";
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}` +
    (ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-"));
const srv = require("child_process").spawn(process.execPath, ["--no-warnings", "server/index.js"], {
  cwd: APP, stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), SESSION_SECRET: "pl-test" }
});
let stderr = ""; srv.stderr.on("data", c => stderr += c);
process.on("exit", () => { try { srv.kill(); } catch (e) {} });

const call = (m, p, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const h = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  if (data) h["content-length"] = Buffer.byteLength(data);
  const r = http.request({ method: m, path: p, port: PORT, host: "127.0.0.1", headers: h }, x => {
    if (x.headers["set-cookie"]) cookie = x.headers["set-cookie"][0].split(";")[0];
    let d = ""; x.on("data", c => d += c);
    x.on("end", () => res({ status: x.statusCode, body: (() => { try { return JSON.parse(d || "{}"); } catch (e) { return d; } })() }));
  });
  r.on("error", rej); if (data) r.write(data); r.end();
});
const wait = async () => {
  for (let i = 0; i < 80; i++) {
    try { await call("GET", "/api/auth/staff-list"); return; }
    catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error("server never came up\n" + stderr);
};

(async () => {
 try {
  await wait();
  await call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "1234" });

  // ---- the shop -------------------------------------------------------
  const prod = (await call("POST", "/api/products", {
    name: "Swagat Ply", brand: "Swagat", category: "Plywood", unit: "Sheet", gstRate: 18,
    sizes: [{ label: "8x4 18mm", price: 2200, stock: 0 }, { label: "8x4 12mm", price: 1700, stock: 0 }]
  })).body;
  const P = prod.id, S18 = prod.sizes[0].id, S12 = prod.sizes[1].id;
  const abc = (await call("POST", "/api/customers", { name: "ABC Traders", phone: "9820000001" })).body;
  const xyz = (await call("POST", "/api/customers", { name: "XYZ Traders", phone: "9820000002" })).body;
  const sup = (await call("POST", "/api/suppliers", { name: "Mill Co", phone: "9820000099" })).body;
  await call("POST", "/api/purchases", { supplierId: sup.id, paymentMethod: "Credit", locationId: "LOC_shop",
    items: [{ productId: P, sizeId: S18, mode: "UNIT", pieces: 500, rate: 1500 }] });

  const rateFor = async (partyId, sizeId, extra = "") =>
    (await call("GET", `/api/price-lists/resolve?productId=${P}&sizeId=${sizeId}${partyId ? "&partyId=" + partyId : ""}${extra}`)).body;

  console.log("\n1-2. With no price list at all, nothing changes\n");
  let r = await rateFor(abc.id, S18);
  check("falls back to the product's own price", r.rate, 2200);
  check("...and says so", r.source, "product");

  console.log("\n6. A party's rate beats the general rate\n");
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, rate: 2200, effectiveFrom: "2026-08-01" });
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, rate: 2100, partyId: abc.id, effectiveFrom: "2026-08-01" });
  r = await rateFor(abc.id, S18);
  check("ABC gets their own 2,100", r.rate, 2100);
  check("...from their own list", r.source, "party");
  check("and the general rate is shown beside it", r.generalRate, 2200);
  check("XYZ, with no rate of their own, gets the general 2,200", (await rateFor(xyz.id, S18)).rate, 2200);
  check("...and it says it is the general one", (await rateFor(xyz.id, S18)).source, "general");

  console.log("\n5. The same product, a different size, is a different rate\n");
  await call("POST", "/api/price-lists", { productId: P, sizeId: S12, rate: 1550, partyId: abc.id, effectiveFrom: "2026-08-01" });
  check("ABC 18mm", (await rateFor(abc.id, S18)).rate, 2100);
  check("ABC 12mm", (await rateFor(abc.id, S12)).rate, 1550);

  console.log("\n4. A RATE CHANGE IS A NEW ROW, AND THE OLD ONE SURVIVES\n");
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, rate: 2150, partyId: abc.id, effectiveFrom: "2026-08-15" });
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, rate: 2250, partyId: abc.id, effectiveFrom: "2026-08-26" });
  check("today ABC pay 2,250", (await rateFor(abc.id, S18, "&date=2026-08-26")).rate, 2250);
  check("on 20 Aug they paid 2,150", (await rateFor(abc.id, S18, "&date=2026-08-20")).rate, 2150);
  check("on 5 Aug they paid 2,100", (await rateFor(abc.id, S18, "&date=2026-08-05")).rate, 2100);
  console.log("    a back-dated bill gets the rate that applied on ITS date");

  const hist = (await call("GET", `/api/price-lists/history?productId=${P}&sizeId=${S18}&partyId=${abc.id}`)).body;
  check("all three rates kept", hist.map(h => h.rate), [2250, 2150, 2100]);
  check("only the newest is current", hist.filter(h => h.current).length, 1);

  console.log("\n8. Quantity bands\n");
  const band = async (q) => (await rateFor(xyz.id, S18, `&qty=${q}`)).rate;
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, partyId: xyz.id, rate: 2200, minQty: 0,  maxQty: 20, effectiveFrom: "2026-08-01" });
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, partyId: xyz.id, rate: 2150, minQty: 21, maxQty: 50, effectiveFrom: "2026-08-01" });
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, partyId: xyz.id, rate: 2100, minQty: 51, effectiveFrom: "2026-08-01" });
  check("10 sheets", await band(10), 2200);
  check("30 sheets", await band(30), 2150);
  check("80 sheets", await band(80), 2100);
  check("before a quantity is typed, the ENTRY rate shows, not the bulk one",
    (await rateFor(xyz.id, S18)).rate, 2200);
  console.log("    quoting 2,100 to somebody who has not ordered 51 is how margin leaks");

  console.log("\n13. What the salesman is shown\n");
  const view = await rateFor(abc.id, S18);
  check("their rate", view.partyRate, 2250);
  check("the general rate", view.generalRate, 2200);
  check("last actually sold at", view.lastRate, null);

  console.log("\n2-3. The rate reaches a real sale, and the bill freezes it\n");
  const inv = (await call("POST", "/api/invoices", {
    customerId: abc.id, paymentMethod: "Credit",
    items: [{ productId: P, sizeId: S18, mode: "UNIT", pieces: 10, rate: view.rate }]
  })).body;
  check("billed at ABC's rate", inv.items[0].rate, 2250);
  const after = await rateFor(abc.id, S18);
  check("and now 'last sold' knows it", after.lastRate, 2250);

  console.log("\n*** THE RULE THAT MATTERS: a price change cannot reach a saved bill ***\n");
  await call("POST", "/api/price-lists", { productId: P, sizeId: S18, rate: 9999, partyId: abc.id, effectiveFrom: "2026-08-01" });
  const reread = (await call("GET", `/api/invoices/${inv.id}`)).body;
  check("the bill still says 2,250", reread.items[0].rate, 2250);
  check("...and its total is untouched", reread.total, inv.total);
  console.log("    the bill stores its own rate and never asks the price list again");

  console.log("\n10. Only the owner or a Sales Manager may change a list\n");
  const staff = (await call("POST", "/api/staff", { name: "Counter", pin: "4321", role: "staff", jobRole: "Sales Staff" })).body;
  await call("POST", "/api/auth/logout");
  await call("POST", "/api/auth/login", { staffId: staff.id, pin: "4321" });
  const refused = await call("POST", "/api/price-lists", { productId: P, sizeId: S18, rate: 1, partyId: abc.id });
  check("sales staff refused", refused.status, 403);
  check("...and told what they CAN do", /single bill/i.test(refused.body.error), true);
  check("but they may still READ the rate", (await call("GET", `/api/price-lists/resolve?productId=${P}&sizeId=${S18}&partyId=${abc.id}`)).status, 200);
  /* Back in as the owner. The cookie cannot simply be kept: logging out
     destroys the session on the server, so the old id is dead. */
  await call("POST", "/api/auth/logout");
  await call("POST", "/api/auth/login", { staffId: "STAFF_owner", pin: "1234" });

  console.log("\n11. Excel import — all or nothing\n");
  const bad = await call("POST", "/api/price-lists/import", { rows: [
    { party: "ABC Traders", sku: prod.sku, size: "8x4 18mm", rate: 2400 },
    { party: "Nobody At All", sku: prod.sku, rate: 1000 }
  ]});
  check("one bad row rejects the whole file", bad.status, 400);
  check("...naming the row", /Row 2/.test(bad.body.problems[0]), true);
  check("and nothing was written", (await rateFor(abc.id, S18)).rate, 9999);

  const good = await call("POST", "/api/price-lists/import", { rows: [
    { party: "ABC Traders", sku: prod.sku, size: "8x4 18mm", rate: 2400, effectiveFrom: "2026-08-27" },
    { party: "XYZ Traders", product: "Swagat Ply", size: "8x4 12mm", rate: 1600, effectiveFrom: "2026-08-27" }
  ]});
  check("a clean file imports", good.status, 200);
  check("...and says what it did", [good.body.added, good.body.replaced], [1, 1]);
  check("ABC's new rate applies from the 27th", (await rateFor(abc.id, S18, "&date=2026-08-27")).rate, 2400);
  check("and the 26th is unchanged", (await rateFor(abc.id, S18, "&date=2026-08-26")).rate, 9999);

  console.log("\n10. Every change is on the record\n");
  const lg = (await call("GET", `/api/price-lists/log?partyId=${abc.id}`)).body;
  check("changes logged", lg.length > 0, true);
  const changed = lg.find(l => l.action === "changed");
  check("with the old rate and the new one", !!(changed && changed.old_rate && changed.new_rate), true);
  check("and who did it", !!(changed && changed.by_name), true);

  console.log("\nA rate is switched off, not deleted\n");
  const rows = (await call("GET", `/api/price-lists?partyId=${abc.id}&productId=${P}`)).body;
  const one = rows.find(x => x.active === 1);
  await call("POST", `/api/price-lists/${one.id}/deactivate`, { reason: "agreed new terms" });
  const still = (await call("GET", `/api/price-lists?partyId=${abc.id}&productId=${P}`)).body;
  check("the row is still there", still.some(x => x.id === one.id), true);
  check("...just switched off", still.find(x => x.id === one.id).active, 0);

  console.log(fails ? `\n${fails} FAILED\n` : "\nAll passed\n");
 } catch (e) {
  console.error("\n  ERROR: " + e.stack + "\n");
  if (stderr) console.error(stderr);
  fails++;
 } finally { try { srv.kill(); } catch (e) {} process.exit(fails ? 1 : 0); }
})();
