/* Call every report endpoint and look for the units bug by its fingerprint.
   Ground truth for 35MM FLUSH DOOR MR (7 x 3 = 21 sq.ft a piece):
       sold        2 pieces   = 42 sq.ft billed
       stock left  8 pieces   = 168 sq.ft
   So any field whose NAME says it is a count (units, qty, pieces, stock,
   sold, count) but whose VALUE is one of the sq.ft figures is the bug. */
const BASE = "http://127.0.0.1:3150";
const COUNT_KEY = /^(units?|qty|quantity|pieces|pcs|stock|closing|opening|stockIn|stockOut|sold|count|totalQty)$/i;
const SQFT_VALUES = new Set([42, 21, 168, 4.2]);   // area figures for this product
const PIECE_VALUES = new Set([2, 8, 10]);

(async () => {
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ staffId: "STAFF_owner", pin: "1111" })
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const ENDPOINTS = ["/api/reports/dashboard", "/api/reports/sales-by-payment", "/api/reports/gst", "/api/reports/stock-by-brand", "/api/reports/customer-dues", "/api/reports/supplier-dues", "/api/reports/stock-by-location", "/api/reports/daily-movement", "/api/reports/supplier-wise", "/api/reports/sale-payments", "/api/reports/purchase-payments", "/api/reports/purchases", "/api/reports/challans", "/api/reports/orders", "/api/reports/tax-invoices", "/api/reports/purchase-bills", "/api/reports/salesman-wise", "/api/reports/brand-wise", "/api/reports/area-wise", "/api/reports/party-wise", "/api/reports/party-product", "/api/reports/profit", "/api/reports/profit-by-invoice", "/api/reports/other-entries", "/api/reports/pnl", "/api/reports/balance-sheet", "/api/reports/data", "/api/product-query", "/api/products", "/api/accounting/outstanding"];

  const suspects = [], checked = [];
  const walk = (node, path, hits) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, hits)); return; }
    const label = JSON.stringify(node.name || node.product || node.productName || "");
    const mentionsDoor = /FLUSH DOOR MR/i.test(label);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "object") { walk(v, `${path}.${k}`, hits); continue; }
      if (typeof v !== "number") continue;
      if (!COUNT_KEY.test(k)) continue;
      if (mentionsDoor && SQFT_VALUES.has(v)) hits.push(`${path}.${k} = ${v}  (${label}) <- area in a count field`);
    }
  };

  for (const ep of ENDPOINTS) {
    let res, body;
    try { res = await fetch(BASE + ep, { headers: { cookie } }); body = await res.text(); }
    catch { continue; }
    if (res.status !== 200) { checked.push(`${ep}: ${res.status}`); continue; }
    let json; try { json = JSON.parse(body); } catch { continue; }
    const hits = [];
    walk(json, ep, hits);
    checked.push(`${ep}: ok${hits.length ? " — " + hits.length + " SUSPECT" : ""}`);
    suspects.push(...hits);
  }

  console.log("endpoints checked:");
  checked.forEach(c => console.log("  " + c));
  console.log(`\nSUSPECT FIELDS (${suspects.length}):`);
  suspects.forEach(s => console.log("  " + s));
  if (!suspects.length) console.log("  none — no count-named field holds an area figure");
})();
