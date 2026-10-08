/* ============================================================
   ADMIN ACCESS — who may open the admin panel, and what they see

   ONE place decides all of it. Nothing in routes/admin.js, admin.js or
   admin.html carries a permission rule of its own: the nav the browser
   draws is the nav this file hands it, so a section can never appear on
   screen that the server would refuse to serve. That is the whole point
   of keeping NAVIGATION and PERMISSION in the same table below.

   THREE ROLES ARE DECLARED, ONE IS WIRED. OWNER works today. ADMIN and
   SUPPORT exist in the tables with no carrier yet, deliberately:

     staff.role is  CHECK (role IN ('owner','staff'))  — db-schema.js:330,
     the only role CHECK in the schema. SQLite cannot ALTER a CHECK, so
     admitting a third value means a create-copy-drop-rename rebuild of
     the staff table on every live shop's database, and the two write
     clamps in routes/staff.js would still coerce it back to 'staff'.
     db-schema.js records that this codebase already hit that wall once
     and chose a side column instead.

   So the shell needs NO schema change and NO migration. roleOf() is the
   single seam where ADMIN and SUPPORT get wired on later — a validated
   staff.admin_role column added with the existing addColumn idiom, NOT
   staff.job_role, which is unvalidated free text a typo could use to
   grant itself admin.

   Shaped like cashAccess.js on purpose: one module, the owner test
   delegated to permissions.js, and helpers that return a decision rather
   than a flag, so no caller can forget to check.
   ============================================================ */
const permissions = require("./permissions");

/* The ladder. Order is meaningful — a role admits everything its own
   entry lists, and nothing else; there is no implicit inheritance. */
const ADMIN_ROLES = ["OWNER", "ADMIN", "SUPPORT"];

/* ------------------------------------------------------------------
   THE NAV TABLE — and the permission table, which are the same table

   `cap` is what a route asks for with require(). `group` is the heading
   it sits under in the sidebar. Everything in PART 1 is a placeholder:
   no page here reads or writes a single row yet.
   ------------------------------------------------------------------ */
const SECTIONS = [
  { key: "dashboard", label: "Dashboard",        group: "Overview",       cap: "overview.view" },

  { key: "customers", label: "Customers",        group: "Business",       cap: "business.view" },
  { key: "products",  label: "Products",         group: "Business",       cap: "business.view" },
  { key: "inventory", label: "Inventory",        group: "Business",       cap: "business.view" },
  { key: "sales",     label: "Sales",            group: "Business",       cap: "business.view" },
  { key: "invoices",  label: "Invoices",         group: "Business",       cap: "business.view" },
  { key: "payments",  label: "Payments",         group: "Business",       cap: "business.view" },

  { key: "ai",        label: "AI Assistant",     group: "AI",             cap: "ai.view" },
  { key: "employees", label: "AI Employees",     group: "AI",             cap: "ai.view" },
  { key: "activity",  label: "AI Activity",      group: "AI",             cap: "ai.view" },

  { key: "plans",     label: "Plans & Features", group: "Administration", cap: "admin.manage" },
  { key: "users",     label: "Users & Roles",    group: "Administration", cap: "admin.manage" },
  { key: "settings",  label: "Settings",         group: "Administration", cap: "admin.manage" },

  { key: "security",  label: "Security Center",  group: "Security",       cap: "security.view" },
  { key: "audit",     label: "Audit Logs",       group: "Security",       cap: "security.view" },
  { key: "health",    label: "System Health",    group: "Security",       cap: "security.view" },
];

/* The order groups appear in the sidebar. Driven from here rather than
   from the order rows happen to sit in above. */
const GROUPS = ["Overview", "Business", "AI", "Administration", "Security"];

/* Which roles hold which capability. The only permission table in the
   admin panel; nothing is granted anywhere else. */
const CAPS = {
  "overview.view": ["OWNER", "ADMIN", "SUPPORT"],
  "business.view": ["OWNER", "ADMIN", "SUPPORT"],
  /* Reading the customer book is a support job; CHANGING a customer is
     not. Split so that when SUPPORT gets a carrier it can answer "what
     does this customer owe" without being able to rename them or switch
     them off. */
  "customers.view": ["OWNER", "ADMIN", "SUPPORT"],
  "customers.edit": ["OWNER", "ADMIN"],
  /* Three, not two. Reading the catalogue, changing a product's details
     and CHANGING A STOCK COUNT are different levels of trust: the last
     one moves a figure the shop bills against, so it is owner-only
     until there is a reason to widen it. */
  "products.view":    ["OWNER", "ADMIN", "SUPPORT"],
  "products.edit":    ["OWNER", "ADMIN"],
  "inventory.adjust": ["OWNER"],
  /* Reading the sales book. There is no matching .edit, and that is
     deliberate — see routes/admin.js: changing an invoice is a
     financial act and belongs behind the financial-year lock in the
     shop app, not on an admin screen. */
  "sales.view":       ["OWNER", "ADMIN", "SUPPORT"],
  "ai.view":       ["OWNER", "ADMIN"],
  "admin.manage":  ["OWNER"],
  "security.view": ["OWNER", "ADMIN"],
};

/* ------------------------------------------------------------------
   THE DECISION
   ------------------------------------------------------------------ */

/**
 * Which admin role this request carries, or null for none.
 *
 * SESSION-ONLY BY CONSTRUCTION, and it has to stay that way: the /admin
 * page route lives outside /api, where there is no company binder, so a
 * database read here would silently answer from the DEFAULT company.
 * permissions.isOwner reads session.loggedIn and session.role, and
 * previewing() reads session.role and session.previewStaffId. No query.
 *
 * Preview is inherited for free — isOwner() answers no while an owner is
 * previewing a staff member, so the panel closes for the duration, which
 * is what the global DELETE gate already does.
 */
function roleOf(req) {
  if (permissions.isOwner(req)) return "OWNER";
  return null;                                   // ADMIN / SUPPORT: no carrier yet
}

/** Does this request hold this capability? */
function can(req, cap) {
  const role = roleOf(req);
  if (!role) return false;
  const allowed = CAPS[cap];
  if (!allowed) return false;                    // an unknown cap is refused, never allowed
  return allowed.includes(role);
}

/** The sections this request may see — what the sidebar is built from. */
function sectionsFor(req) {
  if (!roleOf(req)) return [];
  return SECTIONS
    .filter(s => can(req, s.cap))
    .map(s => ({ key: s.key, label: s.label, group: s.group, href: "#/" + s.key }));
}

/** The groups that still have at least one visible section, in order. */
function groupsFor(req) {
  const live = sectionsFor(req);
  return GROUPS.filter(g => live.some(s => s.group === g));
}

/* ------------------------------------------------------------------
   THE GATES
   ------------------------------------------------------------------ */

/**
 * Mount gate. Used instead of requireRole("owner") so that admitting
 * ADMIN or SUPPORT later is one line in this file rather than an edit to
 * index.js: requireRole is a flat whitelist on the literal session role
 * with no way to express "owner or above".
 */
function gate() {
  return function (req, res, next) {
    if (roleOf(req)) return next();
    return res.status(403).json({ error: "Only the shop owner can open the admin panel." });
  };
}

/** Per-route gate, hoisted to module scope by its caller. */
function require_(cap) {
  return function (req, res, next) {
    if (can(req, cap)) return next();
    return res.status(403).json({ error: "You don't have permission to do this." });
  };
}

/** For /me, and for anything that needs to explain itself to a person. */
function describe(req) {
  const role = roleOf(req);
  return {
    role,
    caps: Object.keys(CAPS).filter(c => can(req, c)),
    sections: sectionsFor(req),
    groups: groupsFor(req),
    previewing: !!permissions.previewing(req),
  };
}

module.exports = {
  ADMIN_ROLES, SECTIONS, GROUPS, CAPS,
  roleOf, can, sectionsFor, groupsFor, gate, require: require_, describe,
};
