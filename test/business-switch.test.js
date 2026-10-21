/* ============================================================
   SWITCHING BUSINESS RELOADS THAT BUSINESS'S OWN DETAILS

   Reported 21 Oct 2026: after switching from Swagat Ply to a second
   business, Settings — and so every bill printed there — still showed
   Swagat Ply's name, address and GSTIN. The switch reloaded the lists but
   not the business details, which were read once at sign-in.

   Checked in a browser on 21 Oct 2026 (both directions, and after a
   reload). This guards the wiring in public/js/app.js so it cannot quietly
   come undone:
     - both ways of switching (choosing one, and adding a new one) go
       through afterBusinessSwitch()
     - afterBusinessSwitch() runs initApp(), which re-reads /settings
     - initApp() re-reads /settings on every run, not only the first
     - a half-made bill is cleared, so its lines and customer cannot be
       billed in the business just switched to

   Run:  node test/business-switch.test.js
   ============================================================ */
const fs = require("fs"), path = require("path");
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 200) : "")); }
};
const src = fs.readFileSync(path.join(__dirname, "..", "public/js/app.js"), "utf8").replace(/\r\n/g, "\n");
const body = name => {
  const i = src.search(new RegExp("(async )?function " + name + "\\("));
  if (i < 0) return "";
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  return "";
};

const switcher = body("openBusinesses");
ok("choosing a business goes through afterBusinessSwitch()",
   /api\("POST", "\/businesses\/switch", \{ businessId: id \}\)[\s\S]{0,400}?await afterBusinessSwitch\(\)/.test(switcher));
ok("adding a business goes through afterBusinessSwitch() too",
   /api\("POST", "\/businesses\/switch", \{ businessId: made\.id \}\)[\s\S]{0,400}?await afterBusinessSwitch\(\)/.test(switcher));
ok("...and neither reloads only the lists any more (that was the bug)",
   !/await loadBusinesses\(\);\s*await renderAll\(\);/.test(switcher));

const after = body("afterBusinessSwitch");
ok("afterBusinessSwitch() runs initApp()", /await initApp\(\)/.test(after), after.slice(0, 120));
ok("...after clearing the half-made bill", /resetBillDraftForSwitch\(\)/.test(after) && after.indexOf("resetBillDraftForSwitch") < after.indexOf("initApp"));

const init = body("initApp");
const reread = init.indexOf('state.settings = await api("GET","/settings")');
const once = init.indexOf("if(appInited)");
ok("initApp() re-reads the business details on EVERY run, before its run-once guard",
   reread >= 0 && once > reread, { reread, once });

const reset = body("resetBillDraftForSwitch");
for (const f of ["cart", "selectedCustomerId", "editingInvoiceId", "docNo", "billSubmissionKey", "advance", "deliveryAddress"]) {
  ok(`the bill's ${f} is cleared on switch`, new RegExp("state\\." + f + "\\s*=").test(reset));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
