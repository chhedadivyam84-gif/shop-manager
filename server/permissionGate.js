/* ============================================================
   THE PERMISSION GATE — what a staff login may reach, enforced here

   The app has a full permission model (permissions.js): per module, per
   action, plus figures that are the owner's alone. The SCREENS read it and
   hide what a person may not use. Until this file, almost no ROUTE read it
   — measured on a throwaway copy, a staff login with no permissions at all
   could read every customer and supplier with their dues, every bill and
   purchase, the Outstanding report, the bank book and the dashboard's cash
   and bank balances, and could create customers and suppliers. A hidden
   button is not a lock.

   So, mounted once ahead of the business routes:

   1. A login with NO permission at all reaches nothing but signing in,
      its own permissions, its notifications and the app's shell. That is
      the rule permissions.js has always stated — "no row means no
      permission" — now true on the server too.

   2. Each guarded area names the modules that may use it, per action:
      reading needs View (or Add/Edit/Print, which imply it), POST needs
      Add, PUT/PATCH needs Edit. The lists are deliberately the WHOLE set of
      screens that read an area — billing must still be able to read the
      customer list, so a salesman with Sales can read customers without
      being granted the Customer screen. What one may open, one may read
      the data behind.

   3. The owner's figures — cash and bank balances, whole-company totals,
      purchase cost — are taken out of the answers for anybody but the
      owner, exactly as permissions.canSee() says, whatever screen asked.

   The owner passes untouched; an owner PREVIEWING as a staff member is
   judged as that staff member, which is what preview is for. Delete stays
   with the owner alone in index.js, ahead of this. Areas not listed here
   keep the checks their own routes already make.
   ============================================================ */
const permissions = require("./permissions");

const ACTION = { GET: "view", HEAD: "view", POST: "add", PUT: "edit", PATCH: "edit" };

/* The screens that read or change each area. */
const SALES_SIDE = ["sales", "sales_order", "sales_challan", "selection_slip", "quotation",
                    "dispatch", "receipt", "outstanding", "ledger", "customer", "salesman_report"];
/* "stock:add" means Stock with Add, not merely View: whoever records stock
   coming in picks its supplier, but seeing stock levels — which every
   salesman can — does not open the supplier books. Outstanding is not
   here either: its screen reads /accounting, not the supplier list. */
const BUY_SIDE = ["purchase", "purchase_order", "payment", "supplier", "ledger", "stock:add"];

/* [path prefix (under /api), { view, add, edit }]. First match wins, so
   the narrower prefixes come first. */
const RULES = [
  ["/customers/:id/payments", { view: SALES_SIDE, add: ["receipt"], edit: ["receipt"] }],
  ["/customers", { view: SALES_SIDE.concat("reports"),
                   add: ["customer", "sales", "sales_order", "sales_challan", "quotation", "selection_slip"],
                   edit: ["customer"] }],
  ["/suppliers/:id/payments", { view: BUY_SIDE, add: ["payment"], edit: ["payment"] }],
  ["/suppliers", { view: BUY_SIDE.concat("reports"), add: ["supplier", "purchase", "purchase_order"], edit: ["supplier"] }],
  ["/invoices", { view: ["sales", "sales_challan", "dispatch", "receipt", "outstanding", "ledger", "reports",
                         "salesman_report", "customer"],
                  add: ["sales", "sales_challan"], edit: ["sales", "sales_challan", "dispatch"] }],
  ["/purchases", { view: BUY_SIDE.concat("reports"), add: ["purchase"], edit: ["purchase"] }],
  ["/purchase-orders", { view: ["purchase_order", "purchase"], add: ["purchase_order"], edit: ["purchase_order"] }],
  ["/quotations", { view: ["quotation", "sales"], add: ["quotation"], edit: ["quotation"] }],
  ["/sales-orders", { view: ["sales_order", "sales"], add: ["sales_order"], edit: ["sales_order"] }],
  ["/selection-slips", { view: ["selection_slip", "sales"], add: ["selection_slip"], edit: ["selection_slip"] }],
  ["/accounting", { view: ["outstanding", "ledger", "reports", "receipt", "payment"],
                    add: ["outstanding", "ledger", "receipt", "payment"], edit: ["outstanding", "ledger"] }],
  ["/bankbook", { view: ["bank"], add: ["bank"], edit: ["bank"] }],
  ["/bank-accounts", { view: ["bank", "payment", "receipt", "sales", "purchase", "cash"], add: ["bank"], edit: ["bank"] }],
  ["/gst-filings", { view: ["gst"], add: ["gst"], edit: ["gst"] }],
  ["/gst", { view: ["gst", "reports"], add: ["gst"], edit: ["gst"] }],
  /* Billing's previous/next stepper walks these two lists, so a counter
     with Sales keeps it without being given every report. */
  ["/reports/tax-invoices", { view: ["reports", "sales"] }],
  ["/reports/challans", { view: ["reports", "sales", "sales_challan"] }],
  ["/reports/dashboard", { view: ["dashboard", "reports"] }],
  ["/reports", { view: ["reports", "salesman_report"] }]
];

/* Reachable by any signed-in person, including one with no permissions:
   signing in and out, what they may do, their own notifications, the
   subscription notice, and the shell every screen draws inside. */
const OPEN = ["/auth", "/permissions/me", "/notifications", "/license", "/health",
              "/sync", "/settings", "/businesses", "/staff-list"];

function matches(path, prefix) {
  const re = new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:id/g, "[^/]+") + "(/|$)");
  return re.test(path);
}

function anyGranted(req) {
  const staffId = permissions.effectiveStaffId(req);
  if (!staffId) return false;
  const rows = permissions.rowsFor(staffId) || {};
  return Object.values(rows).some(m => m && (m.view || m.add || m.edit || m.print));
}

/* The owner's figures, removed from what anybody else is sent. */
function stripOwnerFigures(req, path, body) {
  if (!body || typeof body !== "object") return body;
  const hideCash = !permissions.canSee(req, "cash_balance");
  const hideTotals = !permissions.canSee(req, "company_totals");
  const hideCost = !permissions.canSee(req, "purchase_cost");
  if (path === "/reports/dashboard" && !Array.isArray(body)) {
    const out = { ...body };
    if (hideCash) { delete out.cashBalance; delete out.bankBalance; }
    if (hideTotals) { delete out.outstandingTotal; delete out.payableTotal; }
    return out;
  }
  if (matches(path, "/bank-accounts") && hideCash) {
    const scrub = a => { if (a && typeof a === "object") { const { balance, opening_balance, ...rest } = a; return rest; } return a; };
    return Array.isArray(body) ? body.map(scrub) : scrub(body);
  }
  if (matches(path, "/products") && hideCost) {
    const scrubSize = s => { if (!s || typeof s !== "object") return s; const { cost_price, purchase_price, ...rest } = s; return rest; };
    const scrub = p => {
      if (!p || typeof p !== "object") return p;
      const { cost_price, purchase_price, ...rest } = p;
      if (Array.isArray(rest.sizes)) rest.sizes = rest.sizes.map(scrubSize);
      return rest;
    };
    return Array.isArray(body) ? body.map(scrub) : scrub(body);
  }
  return body;
}

function gate() {
  return function permissionGate(req, res, next) {
    if (!req.session || !req.session.loggedIn) return next();   // requireAuth answers these
    if (permissions.isOwner(req)) return next();
    const path = req.path;
    if (OPEN.some(p => matches(path, p))) return next();

    /* 1. Nothing granted at all: nothing beyond the shell. */
    if (!anyGranted(req)) {
      return res.status(403).json({ error: "Your login has not been given access to anything yet. Ask the owner to set your permissions.", permission: true });
    }

    /* 2. The area's own rule. */
    const action = ACTION[req.method];
    const rule = RULES.find(([prefix]) => matches(path, prefix));
    if (rule && action) {
      const allowed = (rule[1][action] || (action === "view" ? [] : null));
      if (allowed === null) {
        return res.status(403).json({ error: "You don't have permission to change this.", permission: true });
      }
      if (!allowed.some(spec => { const [m, need] = spec.split(":"); return permissions.can(req, m, need || action); })) {
        return res.status(403).json({
          error: action === "view" ? "You don't have permission to see this." : "You don't have permission to do this.",
          permission: true
        });
      }
    }

    /* 3. Whatever is sent back, minus the owner's figures. */
    const json = res.json.bind(res);
    res.json = body => json(stripOwnerFigures(req, path, body));
    next();
  };
}

module.exports = { gate, RULES, OPEN, _matches: matches, _strip: stripOwnerFigures };
