/* ============================================================
   ADMIN USERS, ROLES & PERMISSIONS

   THERE IS NO SECOND USER SYSTEM HERE. A user in this shop is a row in
   `staff` — the same row the till logs in against, the same row every
   permission in the app already hangs off. This module reads that table
   and changes two things on it: whether somebody may open the admin
   panel, and whether their account is switched on.

   THREE ROLES, AND ONLY ONE OF THEM LIVES IN THIS MODULE'S COLUMN:

     OWNER    staff.role = 'owner'. The app's own idea of ownership,
              decided at login, untouched by anything here.
     ADMIN    staff.admin_role = 'ADMIN'
     SUPPORT  staff.admin_role = 'SUPPORT'

   The column is CHECK (admin_role IN ('ADMIN','SUPPORT')), so it CANNOT
   hold 'OWNER'. That is the owner protection, and it is in the schema
   rather than in a validation somebody can forget: no request, no bug
   and no injected value above this line can promote anyone to owner
   through it. Everything below is a second and third lock on the same
   door, because one lock in security code is a lock nobody checked.

   WHAT IS NEVER SENT OUT: pin_hash, and nothing else is a secret on
   this row. Every read below names its columns rather than SELECT *,
   so a column added later cannot leak by accident.
   ============================================================ */
const db = require("./db");
const adminAccess = require("./adminAccess");
const { localDate } = require("./util");

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/* The roles a person can be given FROM HERE. OWNER is absent on
   purpose: it is not this module's to grant. */
const ASSIGNABLE = ["ADMIN", "SUPPORT"];

function likeTerm(q) {
  return "%" + String(q).replace(/[\\%_]/g, c => "\\" + c) + "%";
}

/* ------------------------------------------------------------------
   FILTERS
   ------------------------------------------------------------------ */
const FILTERS = {
  all:      { label: "Everyone",            where: null },
  admin:    { label: "Admin panel access",  where: "s.admin_role IS NOT NULL OR s.role = 'owner'" },
  none:     { label: "No admin access",     where: "s.admin_role IS NULL AND s.role <> 'owner'" },
  active:   { label: "Active",              where: "s.active = 1" },
  disabled: { label: "Disabled",            where: "s.active = 0" },
};

const SORTS = {
  name:   { label: "Name",        sql: "s.name COLLATE NOCASE ASC" },
  role:   { label: "Role",        sql: "s.role DESC, s.admin_role ASC, s.name COLLATE NOCASE ASC" },
  recent: { label: "Newest",      sql: "s.created_at DESC" },
  seen:   { label: "Last active", sql: "last_at DESC NULLS LAST, s.name COLLATE NOCASE ASC" },
};

/* Last activity, from the audit log this app has always written. One
   grouped pass rather than a query per user — the N+1 the brief warns
   about is exactly what a per-row lookup here would be. */
const ACTIVITY_JOIN = `
  LEFT JOIN (
    SELECT staff_id, MAX(at) AS last_at, COUNT(*) AS actions
      FROM audit_log WHERE staff_id IS NOT NULL AND staff_id <> ''
     GROUP BY staff_id
  ) a ON a.staff_id = s.id`;

function describeOptions() {
  return {
    filters: Object.keys(FILTERS).map(k => ({ key: k, label: FILTERS[k].label })),
    sorts: Object.keys(SORTS).map(k => ({ key: k, label: SORTS[k].label })),
    assignableRoles: ASSIGNABLE,
    pageSize: PAGE_SIZE,
  };
}

/** What role a staff row carries, in the panel's vocabulary. */
function roleOfRow(row) {
  if (row.role === "owner") return "OWNER";
  if (row.admin_role === "ADMIN" || row.admin_role === "SUPPORT") return row.admin_role;
  return null;
}

/* ------------------------------------------------------------------
   THE LIST
   ------------------------------------------------------------------ */
function list(opts) {
  const o = opts || {};
  const q = String(o.q || "").trim();
  const filter = Object.prototype.hasOwnProperty.call(FILTERS, o.filter) ? o.filter : "all";
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "name";

  const size = Math.min(Math.max(Number(o.pageSize) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(o.page) || 1, 1);

  const where = [];
  const params = [];

  if (q) {
    /* The fields a staff row actually has. There is no email column on
       staff — this shop signs people in by name and PIN — so there is
       no email to search and none is pretended. */
    where.push("(s.name LIKE ? ESCAPE '\\' OR s.login_id LIKE ? ESCAPE '\\'" +
               " OR s.job_role LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')");
    const t = likeTerm(q);
    params.push(t, t, t, t);
  }
  if (FILTERS[filter].where) where.push("(" + FILTERS[filter].where + ")");

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const FROM = `FROM staff s ${ACTIVITY_JOIN}`;

  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM}${whereSql}`).get(...params).n;
  const pages = Math.max(Math.ceil(total / size), 1);
  const safePage = Math.min(page, pages);

  const rows = db.prepare(`
    SELECT s.id, s.name, s.login_id, s.job_role, s.role, s.admin_role,
           s.active, s.created_at, a.last_at, a.actions
      ${FROM}${whereSql}
     ORDER BY ${SORTS[sort].sql}
     LIMIT ? OFFSET ?`).all(...params, size, (safePage - 1) * size);

  return {
    total, page: safePage, pages, pageSize: size,
    q, filter, sort,
    rows: rows.map(shapeRow),
    options: describeOptions(),
  };
}

function shapeRow(r) {
  return {
    id: r.id,
    name: r.name,
    /* The shop signs people in by name and PIN. login_id is an optional
       alternative handle, not an email, and is shown as what it is. */
    loginId: r.login_id || "",
    jobRole: r.job_role || "",
    isOwner: r.role === "owner",
    adminRole: roleOfRow(r),
    active: !!r.active,
    created: localDate(r.created_at),
    lastActive: r.last_at ? localDate(r.last_at) : null,
    actions: r.actions || 0,
  };
}

/* ------------------------------------------------------------------
   ONE USER
   ------------------------------------------------------------------ */
function profile(id) {
  const s = db.prepare(`
    SELECT id, name, login_id, job_role, salesman_name, role, admin_role,
           active, created_at, data_scope
      FROM staff WHERE id = ?`).get(id);
  if (!s) return null;

  const activity = db.prepare(`
    SELECT MAX(at) AS last_at, COUNT(*) AS actions
      FROM audit_log WHERE staff_id = ?`).get(id) || {};

  const recent = db.prepare(`
    SELECT at, action, details FROM audit_log
     WHERE staff_id = ? ORDER BY at DESC LIMIT 10`).all(id)
    .map(r => ({ at: r.at, when: localDate(r.at), action: r.action,
                 details: String(r.details || "").slice(0, 160) }));

  const role = roleOfRow(s);

  /* What this person's role actually grants, worked out the same way a
     request is judged — so the screen cannot describe access the
     server would not give. */
  const caps = role ? effectiveCaps(role) : [];

  /* The shop-floor permissions are a separate, older system (modules
     with view/add/edit/print, server/permissions.js). They are named
     here rather than duplicated, so nobody reads this page and thinks
     it is the whole picture. */
  let shopModules = 0;
  try {
    shopModules = db.prepare(
      "SELECT COUNT(*) AS n FROM staff_permissions WHERE staff_id = ?").get(id).n;
  } catch (e) { shopModules = 0; }

  return {
    user: {
      id: s.id,
      name: s.name,
      loginId: s.login_id || "",
      jobRole: s.job_role || "",
      salesman: s.salesman_name || "",
      isOwner: s.role === "owner",
      adminRole: role,
      active: !!s.active,
      created: localDate(s.created_at),
      dataScope: s.data_scope || "",
    },
    role,
    /* resource.action, the format the whole panel speaks. */
    permissions: caps,
    activity: {
      lastActive: activity.last_at ? localDate(activity.last_at) : null,
      actions: activity.actions || 0,
      recent,
    },
    shopPermissionModules: shopModules,
  };
}

/* ------------------------------------------------------------------
   ROLES AND WHAT THEY GRANT
   ------------------------------------------------------------------ */

/** Every capability the panel knows about, grouped for a screen. */
function catalogue() {
  const caps = Object.keys(adminAccess.CAPS).sort();
  const groups = {};
  caps.forEach(cap => {
    const resource = cap.split(".")[0];
    if (!groups[resource]) groups[resource] = [];
    groups[resource].push({
      cap,
      action: cap.split(".").slice(1).join("."),
      /* Which roles hold it by default, before this shop changed
         anything — so a screen can show what was altered. */
      defaults: adminAccess.CAPS[cap],
    });
  });
  return Object.keys(groups).sort().map(resource => ({
    resource, caps: groups[resource],
  }));
}

/** What a role holds right now, defaults with this shop's changes applied. */
function effectiveCaps(role) {
  if (role === "OWNER") {
    return Object.keys(adminAccess.CAPS).filter(c => adminAccess.CAPS[c].includes("OWNER")).sort();
  }
  const over = {};
  try {
    db.prepare("SELECT cap, allowed FROM admin_role_permissions WHERE role = ?")
      .all(role).forEach(r => { over[r.cap] = r.allowed === 1; });
  } catch (e) { /* defaults only */ }

  return Object.keys(adminAccess.CAPS).filter(cap =>
    Object.prototype.hasOwnProperty.call(over, cap)
      ? over[cap]
      : adminAccess.CAPS[cap].includes(role)).sort();
}

/** The whole matrix, for the Roles & Permissions screen. */
function roleMatrix() {
  const roles = adminAccess.ADMIN_ROLES;
  const held = {};
  roles.forEach(r => { held[r] = effectiveCaps(r); });

  return {
    roles: roles.map(r => ({
      key: r,
      /* The owner's row is shown and cannot be edited — see the note at
         the top of this file. */
      editable: r !== "OWNER",
      caps: held[r],
    })),
    catalogue: catalogue(),
    /* Which of this shop's settings differ from what it shipped with. */
    changed: changedCaps(),
  };
}

function changedCaps() {
  try {
    return db.prepare("SELECT role, cap, allowed, changed_at, changed_by FROM admin_role_permissions")
      .all().map(r => ({ role: r.role, cap: r.cap, allowed: r.allowed === 1,
                         when: localDate(r.changed_at), by: r.changed_by || "" }));
  } catch (e) { return []; }
}

module.exports = {
  PAGE_SIZE, MAX_PAGE_SIZE, ASSIGNABLE, FILTERS, SORTS,
  list, profile, catalogue, effectiveCaps, roleMatrix, changedCaps,
  roleOfRow, describeOptions, likeTerm,
};
