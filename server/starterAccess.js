/* ============================================================
   STARTER ACCESS — what a member of staff can do before the owner says

   Permissions were only ever SHOWN, not enforced, so nobody needed to set
   them: a new member of staff had no permission rows at all and could
   still make bills. Once the server enforces them (permissionGate.js), a
   member of staff with no rows can do nothing. Measured on the vendor's
   own shop, 20 Oct 2026: six staff, each with "view cash" and nothing
   else — every one of them would have been refused billing.

   So, one rule, in one place:
     - a member of staff ADDED from now on starts with the built-in
       "Sales Staff" set (bills, orders, quotations, challans, customers;
       sees products, stock and what is owed). Never delete, never the
       owner's figures. The owner changes it in Staff -> Permissions.
     - once per business, staff who existed before enforcement and have
       nothing beyond the cash book are given the same set, ADDED to what
       they have. Their data scope and cash-book settings are untouched.
       The owner is told who, in the bell and in the activity log.

   Only ever adds, and only once: a business that has been through this
   is marked, so an owner who later narrows someone's access is never
   overridden. Owners are never touched — they are not consulted.
   ============================================================ */
const db = require("./db");
const permissions = require("./permissions");

const STARTER_ROLE = "Sales Staff";

/* Staff created before this moment had no way to get permissions except
   by the owner setting them, which nothing required. Anyone created after
   it was given the starter set when added. */
const ENFORCED_FROM = Date.UTC(2026, 9, 22);

function starterModules() {
  const d = permissions.ROLE_DEFAULTS[STARTER_ROLE];
  return d ? d.modules : {};
}

/** Add the starter set to one member of staff. Only ever turns things ON. */
function grant(staffId) {
  const mods = starterModules();
  const upsert = db.prepare(`
    INSERT INTO staff_permissions (staff_id, module, can_view, can_add, can_edit, can_print)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(staff_id, module) DO UPDATE SET
      can_view  = MAX(can_view,  excluded.can_view),
      can_add   = MAX(can_add,   excluded.can_add),
      can_edit  = MAX(can_edit,  excluded.can_edit),
      can_print = MAX(can_print, excluded.can_print)`);
  for (const [module, actions] of Object.entries(mods)) {
    const has = a => actions.includes(a) ? 1 : 0;
    upsert.run(staffId, module, has("view"), has("add"), has("edit"), has("print"));
  }
  try {
    db.prepare("UPDATE staff SET job_role = ? WHERE id = ? AND COALESCE(job_role, '') = ''")
      .run(STARTER_ROLE, staffId);
  } catch (e) { /* older copy without the column: the permissions are what matter */ }
}

/** Does this member of staff have anything at all beyond the cash book? */
function hasRealAccess(staffId) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM staff_permissions
    WHERE staff_id = ? AND module <> 'cash'
      AND (can_view = 1 OR can_add = 1 OR can_edit = 1 OR can_print = 1)`).get(staffId);
  return r.n > 0;
}

/**
 * The one-time pass, for the business the caller is bound to.
 * Returns the names given access, [] when nothing needed doing, or null
 * when this business has already been through it.
 */
function backfillOnce() {
  db.exec("CREATE TABLE IF NOT EXISTS once_flags (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  const KEY = "starter-access-v1";
  if (db.prepare("SELECT 1 FROM once_flags WHERE key = ?").get(KEY)) return null;

  const given = [];
  db.transaction(() => {
    const staff = db.prepare(
      "SELECT id, name FROM staff WHERE role <> 'owner' AND active = 1 AND created_at < ?").all(ENFORCED_FROM);
    for (const s of staff) {
      if (hasRealAccess(s.id)) continue;
      grant(s.id);
      given.push(s.name);
    }
    db.prepare("INSERT INTO once_flags (key, at) VALUES (?, ?)").run(KEY, Date.now());
    if (given.length) {
      db.prepare(`INSERT INTO audit_log (at, staff_id, staff_name, role, action, details)
                  VALUES (?, NULL, 'System', 'system', 'permissions.starter', ?)`)
        .run(Date.now(), `Given the ${STARTER_ROLE} set because staff permissions are now enforced: ${given.join(", ")}`);
    }
  })();

  if (given.length) {
    try {
      require("./notify").create({
        category: "security", severity: "warning", audience: "owner",
        key: "security:starter-access",
        title: `Staff access is now enforced — ${given.length} staff given the ${STARTER_ROLE} set`,
        body: `${given.join(", ")} had no permissions saved, so they could not have kept making bills. ` +
              `Each was given ${STARTER_ROLE} (bills, orders, quotations, challans, customers). ` +
              "Check or change it in Staff → Permissions.",
        link: "staff"
      });
    } catch (e) { /* the access is given; the notice is a courtesy */ }
  }
  return given;
}

/** Every business on this installation, once each. Never throws. */
function backfillEverywhere() {
  const out = [];
  for (const c of db.companies.list()) {
    try {
      const given = db.companies.runAs(c.id, backfillOnce);
      if (given && given.length) out.push(`${c.name || c.id}: ${given.length}`);
    } catch (e) {
      console.error(`[permissions] starter access for ${c.id} failed: ${e.message}`);
    }
  }
  if (out.length) console.log(`[permissions] starter access given — ${out.join("; ")}`);
  return out;
}

module.exports = { grant, backfillOnce, backfillEverywhere, STARTER_ROLE, ENFORCED_FROM };
