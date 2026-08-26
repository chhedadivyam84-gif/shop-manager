const express = require("express");
const db = require("../db");
const { logAction } = require("../util");
const { requireRole } = require("../auth");
const permissions = require("../permissions");

const router = express.Router();

/* ============================================================
   PERMISSION MANAGEMENT

   Reading and writing what each staff member may do. Owner only — every
   route here is mounted behind requireRole("owner") — except /me, which is
   how a staff member's own screen learns what to show them.

   /me is deliberately the ONLY thing a non-owner can read from here, and it
   only ever describes the person asking. A staff member cannot ask what
   somebody else is allowed to do, because knowing the shape of everyone's
   access is itself worth something to a person looking for a way round it.
   ============================================================ */

/** What the signed-in person may do. Drives which screens their app shows. */
router.get("/me", (req, res) => {
  const owner = permissions.isOwner(req);
  const out = {
    staffId: req.session.staffId || null,
    name: req.session.staffName || "",
    role: req.session.role || "",
    isOwner: owner,
    scope: permissions.scopeOf(req),
    modules: {},
    sensitive: {}
  };

  permissions.MODULES.forEach(m => {
    out.modules[m.key] = {};
    permissions.ACTIONS.forEach(a => { out.modules[m.key][a] = permissions.can(req, m.key, a); });
  });
  permissions.SENSITIVE.forEach(s => { out.sensitive[s.key] = permissions.canSee(req, s.key); });

  /* Delete is reported, never granted. The screens read this to decide
     whether to draw a delete control; the server refuses regardless. */
  out.canDelete = owner;

  /* A salesman sees their own name here so their screens can say "your
     sales" rather than making them work out whose data they are looking at. */
  out.salesman = "";
  if (req.session.staffId) {
    try {
      const s = db.prepare("SELECT salesman_name, name FROM staff WHERE id = ?").get(req.session.staffId);
      if (s) out.salesman = String(s.salesman_name || "").trim() || String(s.name || "").trim();
    } catch (e) { /* older copy */ }
  }
  res.json(out);
});

/** The vocabulary the permission screen is built from. */
router.get("/catalogue", requireRole("owner"), (req, res) => {
  res.json({
    modules: permissions.MODULES,
    actions: permissions.ACTIONS,
    sensitive: permissions.SENSITIVE,
    scopes: permissions.SCOPES,
    roles: Object.keys(permissions.ROLE_DEFAULTS),
    /* Said out loud so the screen can print it rather than imply it by
       leaving a column out. */
    deleteNote: "Delete belongs to the owner alone and cannot be granted."
  });
});

/* Ahead of /:id on purpose: Express matches in order, and a literal path
   declared after a parameter route is never reached — the parameter
   swallows it and answers "no such staff member" for a role that exists. */
/** The starting point for a role, for the owner to edit before saving. */
router.get("/role-defaults/:role", requireRole("owner"), (req, res) => {
  const d = permissions.ROLE_DEFAULTS[req.params.role];
  if (!d) return res.status(404).json({ error: "No such role." });
  const modules = {};
  permissions.MODULES.forEach(m => {
    const on = d.modules[m.key] || [];
    modules[m.key] = {
      view: on.includes("view"), add: on.includes("add"),
      edit: on.includes("edit"), print: on.includes("print")
    };
  });
  res.json({ scope: d.scope, modules });
});

/** One staff member's permissions, as the owner sees them. */
router.get("/:id", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Staff member not found." });

  const rows = permissions.rowsFor(s.id);
  const modules = {};
  permissions.MODULES.forEach(m => {
    modules[m.key] = rows[m.key] || { view: false, add: false, edit: false, print: false };
  });

  let assigned = [];
  try {
    assigned = db.prepare("SELECT staff_id FROM staff_assigned WHERE manager_id = ?").all(s.id).map(r => r.staff_id);
  } catch (e) { /* older copy */ }

  res.json({
    id: s.id, name: s.name, role: s.role,
    jobRole: s.job_role || "",
    loginId: s.login_id || "",
    salesman: s.salesman_name || "",
    scope: permissions.SCOPES.includes(String(s.data_scope || "")) ? s.data_scope : "Own Only",
    active: s.active,
    modules, assigned
  });
});

/**
 * Save one staff member's permissions.
 *
 * Replaces the whole set rather than patching it: a half-applied permission
 * change is worse than a rejected one, and "everything the owner just saw on
 * screen" is the only state anybody can reason about.
 */
router.put("/:id", requireRole("owner"), (req, res) => {
  const s = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Staff member not found." });

  /* An owner's permissions are not editable, because they are not consulted.
     Letting the screen write rows for an owner would create a set of
     settings that look meaningful and do nothing. */
  if (s.role === "owner") {
    return res.status(400).json({ error: "The owner already has full access — there is nothing to configure." });
  }

  const body = req.body || {};
  const scope = permissions.SCOPES.includes(String(body.scope || "")) ? body.scope : "Own Only";
  const jobRole = String(body.jobRole || "").trim().slice(0, 40);
  const salesman = String(body.salesman || "").trim().slice(0, 80);
  const loginId = String(body.loginId || "").trim().slice(0, 40);

  const wanted = (body.modules && typeof body.modules === "object") ? body.modules : {};
  const assigned = Array.isArray(body.assigned) ? body.assigned : [];

  const insert = db.prepare(`
    INSERT INTO staff_permissions (staff_id, module, can_view, can_add, can_edit, can_print)
    VALUES (?,?,?,?,?,?)`);

  db.transaction(() => {
    db.prepare("UPDATE staff SET job_role=?, salesman_name=?, login_id=?, data_scope=? WHERE id=?")
      .run(jobRole, salesman, loginId, scope, s.id);

    db.prepare("DELETE FROM staff_permissions WHERE staff_id = ?").run(s.id);
    permissions.MODULES.forEach(m => {
      const w = wanted[m.key] || {};
      const view = w.view ? 1 : 0, add = w.add ? 1 : 0, edit = w.edit ? 1 : 0, print = w.print ? 1 : 0;
      /* A module with nothing ticked is simply absent — no row means no
         permission, and storing four zeroes would say the same thing more
         slowly. */
      if (view || add || edit || print) insert.run(s.id, m.key, view, add, edit, print);
    });

    db.prepare("DELETE FROM staff_assigned WHERE manager_id = ?").run(s.id);
    if (scope === "Assigned Staff") {
      const add = db.prepare("INSERT OR IGNORE INTO staff_assigned (manager_id, staff_id) VALUES (?,?)");
      assigned.filter(id => id && id !== s.id).forEach(id => {
        const exists = db.prepare("SELECT id FROM staff WHERE id = ?").get(id);
        if (exists) add.run(s.id, id);
      });
    }
  })();

  const granted = permissions.MODULES.filter(m => {
    const w = wanted[m.key] || {};
    return w.view || w.add || w.edit || w.print;
  }).length;
  logAction(req, "staff.permissions", `${s.name}: ${granted} module(s), scope ${scope}`);

  res.json({ ok: true });
});


module.exports = router;
