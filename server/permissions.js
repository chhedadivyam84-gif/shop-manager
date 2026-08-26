/* ============================================================
   WHO MAY DO WHAT

   One place that answers it, so a screen, a route and a query cannot each
   answer it differently. Everything else asks here.

   THE RULES, IN ORDER

     1. The owner may do anything. There is no permission row for an owner
        and none is consulted — an owner locked out of their own shop by a
        misconfigured row is a worse failure than any it would prevent.

     2. Delete belongs to the owner alone. It is not a module action, it is
        not configurable, and it is refused ahead of every route in
        index.js. Nothing here can grant it.

     3. Everyone else is judged by their own row. Not by their role: a shop
        with four salesmen wants three identical and one allowed to see
        outstanding, and a role-only model forces a new role to be invented
        for that one person. The role only supplies the defaults the owner
        starts from.

     4. No row means no permission. An unconfigured login sees nothing
        rather than everything — the failure that costs a shop is the one
        where a new staff member can read the whole ledger on their first
        morning, not the one where they have to ask for access.

   DATA SCOPE is the second question, asked only after the first is
   answered yes. "May they view Sales" and "whose sales" are different, and
   collapsing them is how a salesman ends up reading the whole company's
   book because somebody ticked View.
   ============================================================ */
const db = require("./db");

/* Every module the owner can grant. The key is what the code checks; the
   label is what the owner reads on the permission screen. Ordered as the
   shop thinks about them, not alphabetically. */
const MODULES = [
  { key: "dashboard",     label: "Dashboard" },
  { key: "sales",         label: "Sales / Invoice" },
  { key: "sales_order",   label: "Sales Order" },
  { key: "sales_challan", label: "Sales Challan" },
  { key: "quotation",     label: "Quotation" },
  { key: "purchase",      label: "Purchase" },
  { key: "purchase_order",label: "Purchase Order" },
  { key: "dispatch",      label: "Delivery / Dispatch" },
  { key: "payment",       label: "Payment" },
  { key: "receipt",       label: "Receipt" },
  { key: "customer",      label: "Customer" },
  { key: "supplier",      label: "Supplier" },
  { key: "product",       label: "Product" },
  { key: "stock",         label: "Stock" },
  { key: "stock_transfer",label: "Stock Transfer" },
  { key: "cash",          label: "Cash Book" },
  { key: "bank",          label: "Bank Book" },
  { key: "outstanding",   label: "Outstanding" },
  { key: "ledger",        label: "Ledger" },
  { key: "gst",           label: "GST" },
  { key: "reports",       label: "Reports" },
  { key: "salesman_report", label: "Salesman Reports" }
];

const ACTIONS = ["view", "add", "edit", "print"];

/* Sensitive figures. Not modules — they cut across modules, and the shop's
   rule is about the NUMBER, not the screen it appears on. A salesman may
   open a bill and must not see what the goods cost. Owner only, always,
   until the owner says otherwise for one person. */
const SENSITIVE = [
  { key: "profit",          label: "Profit and margin" },
  { key: "purchase_cost",   label: "Purchase rate and cost" },
  { key: "stock_value",     label: "Stock valuation" },
  { key: "cash_balance",    label: "Cash and bank balances" },
  { key: "company_totals",  label: "Whole-company totals" }
];

const SCOPES = ["Own Only", "Assigned Staff", "All Staff", "All Data"];

/* What a role starts with. A starting point the owner edits, never a rule:
   nothing in this file reads these once a staff member has been saved. */
const ROLE_DEFAULTS = {
  "Sales Staff": {
    scope: "Own Only",
    modules: {
      dashboard: ["view"],
      sales: ["view", "add", "edit", "print"],
      sales_order: ["view", "add", "edit", "print"],
      sales_challan: ["view", "add", "edit", "print"],
      quotation: ["view", "add", "edit", "print"],
      customer: ["view", "add", "edit"],
      product: ["view"],
      stock: ["view"],
      outstanding: ["view"],
      salesman_report: ["view", "print"]
    }
  },
  "Sales Manager": {
    scope: "Assigned Staff",
    modules: {
      dashboard: ["view"],
      sales: ["view", "add", "edit", "print"],
      sales_order: ["view", "add", "edit", "print"],
      sales_challan: ["view", "add", "edit", "print"],
      quotation: ["view", "add", "edit", "print"],
      customer: ["view", "add", "edit"],
      product: ["view"],
      stock: ["view"],
      outstanding: ["view", "print"],
      reports: ["view", "print"],
      salesman_report: ["view", "print"]
    }
  },
  "Purchase Staff": {
    scope: "All Data",
    modules: {
      dashboard: ["view"],
      purchase: ["view", "add", "edit", "print"],
      purchase_order: ["view", "add", "edit", "print"],
      supplier: ["view", "add", "edit"],
      product: ["view", "add", "edit"],
      stock: ["view"],
      reports: ["view", "print"]
    }
  },
  "Accounts Staff": {
    scope: "All Data",
    modules: {
      dashboard: ["view"],
      payment: ["view", "add", "edit", "print"],
      receipt: ["view", "add", "edit", "print"],
      ledger: ["view", "print"],
      outstanding: ["view", "print"],
      customer: ["view"],
      supplier: ["view"],
      reports: ["view", "print"]
    }
  },
  "Stock Staff": {
    scope: "All Data",
    modules: {
      dashboard: ["view"],
      stock: ["view", "add", "edit", "print"],
      stock_transfer: ["view", "add", "edit"],
      product: ["view", "add", "edit"],
      reports: ["view", "print"]
    }
  },
  "Dispatch Staff": {
    scope: "All Data",
    modules: {
      dashboard: ["view"],
      sales_order: ["view"],
      sales_challan: ["view", "add", "edit", "print"],
      dispatch: ["view", "add", "edit", "print"],
      customer: ["view"]
    }
  }
};

const isOwner = req => !!(req && req.session && req.session.loggedIn && req.session.role === "owner");

/** The permission rows for one staff member, keyed by module. */
function rowsFor(staffId) {
  const out = {};
  if (!staffId) return out;
  try {
    db.prepare("SELECT * FROM staff_permissions WHERE staff_id = ?").all(staffId)
      .forEach(r => {
        out[r.module] = {
          view: !!r.can_view, add: !!r.can_add, edit: !!r.can_edit, print: !!r.can_print
        };
      });
  } catch (e) { /* table not built on this copy yet */ }
  return out;
}

/**
 * May this request do `action` on `module`?
 *
 * The single question every gate asks. Delete is never answered yes here,
 * whatever is passed in — it is not a module permission and index.js has
 * already refused it before any route runs.
 */
function can(req, module, action) {
  if (action === "delete") return isOwner(req);
  if (isOwner(req)) return true;
  if (!req || !req.session || !req.session.loggedIn) return false;
  if (!ACTIONS.includes(action)) return false;

  const perms = rowsFor(req.session.staffId);
  const m = perms[module];
  if (!m) return false;

  /* Add, edit and print each imply being able to see it. Granting Add
     without View produces a screen that can create what it cannot show,
     which is not a state the owner ever means to configure. */
  if (action === "view") return m.view || m.add || m.edit || m.print;
  return !!m[action];
}

/** May this request see a figure the shop treats as the owner's business? */
function canSee(req, what) {
  if (isOwner(req)) return true;
  if (!req || !req.session) return false;
  /* Deliberately no per-staff override yet. Every one of these is
     owner-only by default and the spec says so; the day the owner wants to
     show margin to one manager, it belongs in its own table with its own
     screen rather than smuggled in as a module. */
  return false;
}

/** Own Only | Assigned Staff | All Staff | All Data — never blank. */
function scopeOf(req) {
  if (isOwner(req)) return "All Data";
  if (!req || !req.session || !req.session.staffId) return "Own Only";
  try {
    const s = db.prepare("SELECT data_scope FROM staff WHERE id = ?").get(req.session.staffId);
    const v = s && String(s.data_scope || "").trim();
    return SCOPES.includes(v) ? v : "Own Only";
  } catch (e) { return "Own Only"; }
}

/**
 * The salesman names this request may see data for.
 *
 * null means "no restriction" — the caller adds no filter at all. An empty
 * array means "nobody", which is a real answer and must not be confused
 * with null: a query given [] should return nothing, and a query given null
 * should return everything. Getting those two the same way round is how a
 * scope bug turns into a data leak.
 */
function visibleSalesmen(req) {
  const scope = scopeOf(req);
  if (scope === "All Data" || scope === "All Staff") return null;

  const me = req && req.session ? req.session.staffId : null;
  if (!me) return [];

  const nameOf = id => {
    try {
      const s = db.prepare("SELECT salesman_name, name FROM staff WHERE id = ?").get(id);
      if (!s) return null;
      return (String(s.salesman_name || "").trim() || String(s.name || "").trim()) || null;
    } catch (e) { return null; }
  };

  const mine = nameOf(me);
  if (scope === "Own Only") return mine ? [mine] : [];

  /* Assigned Staff: the manager's own name plus everyone assigned to them.
     Their own is included because a manager who also sells would otherwise
     be unable to see the orders they took themselves. */
  const out = new Set();
  if (mine) out.add(mine);
  try {
    db.prepare("SELECT staff_id FROM staff_assigned WHERE manager_id = ?").all(me)
      .forEach(r => { const n = nameOf(r.staff_id); if (n) out.add(n); });
  } catch (e) { /* table not built yet */ }
  return [...out];
}

/** Express gate. `permissions.require("sales", "add")` on a route. */
function require_(module, action) {
  return function (req, res, next) {
    if (can(req, module, action)) return next();
    const label = (MODULES.find(m => m.key === module) || {}).label || module;
    return res.status(403).json({
      error: `You don't have permission to ${action} in ${label}. Ask the owner if you need it.`
    });
  };
}

module.exports = {
  MODULES, ACTIONS, SENSITIVE, SCOPES, ROLE_DEFAULTS,
  isOwner, can, canSee, scopeOf, visibleSalesmen, rowsFor,
  require: require_
};
