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
/* Used ONLY by can() and the user-management helpers, never by
   roleOf(). roleOf runs outside /api on the page route, where there is
   no company binder and a query would answer from the default shop —
   see the note on it. Everything in this file that DOES query is
   reached only from inside /api. */
const db = require("./db");

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
  { key: "users",     label: "Users",            group: "Administration", cap: "admin.manage" },
  { key: "roles",     label: "Roles & Permissions", group: "Administration", cap: "admin.manage" },
  { key: "settings",  label: "Settings",         group: "Administration", cap: "admin.manage" },

  { key: "security",  label: "Security Center",  group: "Security",       cap: "security.view" },
  /* Its own capability rather than sharing security.view — see the note
     beside it in CAPS. */
  { key: "audit",     label: "Audit Logs",       group: "Security",       cap: "audit.view" },
  /* Its own capability, for the reason given beside it in CAPS. */
  { key: "health",    label: "System Health",    group: "Security",       cap: "health.view" },
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
  /* READING THE AUDIT LOG IS ITS OWN PERMISSION, separate from the rest
     of the Security group, because it is a different kind of access.
     The Security Center describes how the app is configured; the audit
     log is a record of what every named person in the shop actually
     did, going back years. A shop may well want an ADMIN who can check
     the security posture without being able to read the owner's own
     history, or the reverse — and sharing one capability made that
     choice impossible to express.

     Same two roles as before by default, so no existing login gains or
     loses anything the day this ships. SUPPORT is not among them: a
     support login exists to answer "what does this customer owe", and
     the staff's own activity history is not part of that job unless the
     owner explicitly grants it on the Roles screen. */
  "audit.view":    ["OWNER", "ADMIN"],
  /* WHETHER THE MACHINE IS WORKING is a different question from either
     of the two above, and a shop may well want different people
     answering it. The person who needs to know the backup stopped
     running is whoever keeps the shop open on a Sunday; that is not
     necessarily the person trusted to read two years of everybody's
     actions, and it is certainly not the same as changing settings.

     Same two roles by default, so nothing changes for an existing
     login the day this ships. SUPPORT is excluded because a health page
     describes the infrastructure, and section 17 of the brief asks
     specifically that unauthorised users not learn about it. */
  "health.view":   ["OWNER", "ADMIN"],
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

  /* ADMIN and SUPPORT, carried in the SESSION rather than read from the
     staff row here — for the same reason the comment above gives. The
     value is put there at login (routes/auth.js), inside the company
     the person signed in to, so it is already the right shop's answer.
     Anything other than the two known words is nobody.

     An owner PREVIEWING a staff member is not an admin either: preview
     exists to show the owner what a staff member sees, and a preview
     that kept admin powers would be showing them a screen no staff
     member will ever get. */
  if (!req || !req.session || !req.session.loggedIn) return null;
  if (permissions.previewing(req)) return null;
  const carried = req.session.adminRole;
  return carried === "ADMIN" || carried === "SUPPORT" ? carried : null;
}

/* ------------------------------------------------------------------
   WHAT A ROLE MAY DO

   CAPS above is the default. A shop can tighten or widen ADMIN and
   SUPPORT from the panel, and those decisions live in
   admin_role_permissions — only the rows that DIFFER from the default,
   so an untouched shop has an empty table and CAPS remains the single
   description of what a role is.

   OWNER IS NEVER CONSULTED. An owner holds every capability by
   definition; a stored row that could take one away is a row that could
   lock the shop out of its own panel.
   ------------------------------------------------------------------ */
function overridesFor(role) {
  if (role === "OWNER") return {};
  try {
    const out = {};
    db.prepare("SELECT cap, allowed FROM admin_role_permissions WHERE role = ?")
      .all(role).forEach(r => { out[r.cap] = r.allowed === 1; });
    return out;
  } catch (e) {
    /* No table yet, or no company bound. The defaults still apply, which
       is the safe direction: a shop keeps the access it was shipped
       with rather than silently losing or gaining any. */
    return {};
  }
}

/** The default answer for a role, before any stored override. */
function defaultAllows(role, cap) {
  const allowed = CAPS[cap];
  return !!allowed && allowed.includes(role);
}

/** Does this request hold this capability? */
function can(req, cap) {
  const role = roleOf(req);
  if (!role) return false;
  if (!CAPS[cap]) return false;              // an unknown cap is refused, never allowed
  /* The owner is not subject to the table, by design. */
  if (role === "OWNER") return defaultAllows(role, cap);

  const over = overridesFor(role);
  return Object.prototype.hasOwnProperty.call(over, cap)
    ? over[cap]
    : defaultAllows(role, cap);
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
    const role = roleOf(req);
    if (!role) {
      return res.status(403).json({ error: "You don't have access to the admin panel." });
    }

    /* THE SESSION IS NOT THE LAST WORD.
     *
     * roleOf() reads the session because it must answer on the page
     * route, outside the company binder. Here we ARE inside /api, so
     * the staff row is readable and is the truth — and checking it on
     * every request is what makes "take that person's access away"
     * mean NOW rather than "next time they sign in". A session issued
     * an hour ago cannot outlive the decision.
     *
     * The owner is exempt from the row check for the same reason the
     * owner is exempt from the permission table: owner-ness is
     * staff.role, already established at login, and a failed lookup
     * here must never be able to lock the owner out of their own shop.
     */
    if (role === "OWNER") return next();

    let row = null;
    try {
      row = db.prepare("SELECT active, admin_role FROM staff WHERE id = ?")
        .get(req.session.staffId);
    } catch (e) { row = null; }

    if (!row || !row.active || row.admin_role !== role) {
      return res.status(403).json({ error: "You don't have access to the admin panel." });
    }
    return next();
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
