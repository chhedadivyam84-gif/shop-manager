/* ============================================================
   THE AUDIT LOG — the one place an event is written

   PART 10. This file did not introduce audit logging to this app: the
   `audit_log` table and `logAction()` have been here since the shop had
   two staff members, and 187 different actions across 56 areas already
   write to them. Building a second event system beside that would have
   produced two half-answers to "who changed this", which is worse than
   the one plain answer there was before.

   So this module TAKES OVER the writing that util.logAction() was doing
   and widens the record. logAction keeps its exact three-argument
   signature, because 217 call sites across 53 files use it and every
   one of them must keep working untouched — they now simply record
   more than they used to:

     actor_type    OWNER / ADMIN / SUPPORT / STAFF / SYSTEM / AI
     resource_type what kind of thing was acted on
     resource_id   which one
     result        SUCCESS / FAILURE / DENIED
     meta          before/after and other structured detail, as JSON
     ip            the caller's address, when the app can resolve one
     user_agent    the browser or device, trimmed

   WHAT THE SERVER DECIDES, AND THE BROWSER NEVER CAN
   --------------------------------------------------
   The timestamp is this machine's clock. The actor is read from the
   SESSION. The action is a literal written in the route's own source.
   None of the three can be posted in, which is the whole point: an
   audit entry that the thing being audited could choose is decoration.

   There is deliberately no endpoint anywhere that accepts an event from
   a client. Searching for one is how you check this claim.

   APPEND-ONLY
   -----------
   Nothing in this file updates or deletes a row, and nothing anywhere
   else in the app does either — with one named exception, the owner's
   Factory Reset, which wipes the whole shop behind a PIN, an exact
   confirmation phrase and a mandatory backup. A database trigger
   refuses every UPDATE outright; see db-schema.js for why DELETE is
   left to that one controlled path rather than blocked.
   ============================================================ */
const db = require("./db");

/* ------------------------------------------------------------------
   WHO ACTED

   Six kinds, and the distinction that matters is the last two: work
   this app did on its own, and work an automated agent did on the
   shop's behalf. Those must never be filed under the name of whichever
   human happened to be signed in when the timer fired.

   STAFF is here because the shop app has far more actors than the admin
   panel does — a counter clerk raising a bill is not an ADMIN.
   ------------------------------------------------------------------ */
const ACTOR_TYPES = ["OWNER", "ADMIN", "SUPPORT", "STAFF", "SYSTEM", "AI"];

/* An automated actor is one of exactly these two, and neither can be
   reached from a request — see the note on record(). */
const AUTOMATED = ["SYSTEM", "AI"];

const RESULTS = ["SUCCESS", "FAILURE", "DENIED"];

/**
 * Which kind of actor this request carries.
 *
 * FROM THE SESSION, NEVER FROM THE REQUEST. There is no argument here
 * that a caller could supply, and record() does not accept one — the
 * only way to write SYSTEM or AI is through the two functions below,
 * which take no `req` at all and so cannot be reached by a browser.
 *
 * A request with no session is SYSTEM: that is first-run seeding and
 * the schema's own migrations, which really are this app acting alone.
 */
function actorTypeOf(req) {
  const s = req && req.session;
  if (!s || !s.loggedIn) return "SYSTEM";

  /* The owner stays the owner while previewing the app as a staff
     member. The person who pressed the button is the one on the record,
     and the fact that they were previewing goes in `meta` instead —
     filing it under the previewed staff member's name would put an
     action on a clerk's history that they did not perform. */
  if (s.role === "owner") return "OWNER";

  /* The admin-panel carrier from PART 8, if this staff member has one. */
  if (s.adminRole === "ADMIN" || s.adminRole === "SUPPORT") return s.adminRole;

  return "STAFF";
}

/* ------------------------------------------------------------------
   WHAT WAS ACTED ON

   Every action in this app is already named `thing.verb` —
   invoice.create, customer.update, product.stock_adjust — so the thing
   is sitting in the action and does not need to be passed again at
   every one of those call sites. A handful of prefixes are not the name
   of a record, and those are mapped by hand rather than left to produce
   a resource type of "login".
   ------------------------------------------------------------------ */
const NOT_A_RESOURCE = new Set(["login", "logout", "reset", "sync", "backup",
                                "import", "settings", "license", "gst", "tally",
                                "whatsapp", "print", "fy_close", "fy_create",
                                "fy_reopen", "admin"]);

function resourceTypeOf(action, given) {
  if (given) return String(given);
  const head = String(action || "").split(".")[0];
  if (!head || NOT_A_RESOURCE.has(head)) return null;
  return head;
}

/* ------------------------------------------------------------------
   SECRETS NEVER GO IN

   An audit log is read by more people than the thing it audits, and it
   is kept for years. A credential that reaches it has been copied into
   the one table nobody thinks to clean.

   The existing 187 actions were already written this way by hand — the
   one that issues a sync key records "A new sync key was issued" and
   not the key. This makes that discipline structural for the new `meta`
   column, so a future caller cannot leak a secret by passing a whole
   row into before/after.

   MATCHED ON THE FIELD NAME, as a substring, case-insensitively. That
   catches pin_hash, bridge_token_hash, apiKey and SESSION_SECRET alike
   without needing to know every column this app will ever grow.
   ------------------------------------------------------------------ */
const SECRET_NAMES = [
  "pin", "password", "passwd", "secret", "token", "key", "hash",
  "credential", "auth", "cookie", "session", "signature", "private",
  "cvv", "card", "otp", "salt",
];

const REDACTED = "[redacted]";

function isSecretName(name) {
  const n = String(name).toLowerCase();
  return SECRET_NAMES.some(s => n.includes(s));
}

/* Depth and breadth are bounded because `meta` is a column, not a
   dumping ground: a caller that hands over a deeply nested object gets
   it trimmed rather than filling the shop's disk with one event. */
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_STRING = 500;
const MAX_META = 4000;

/**
 * A value on its way into `meta`, with anything that looks like a
 * credential replaced by a marker.
 *
 * The marker rather than silent removal, deliberately: "the PIN was
 * among the fields that changed" is itself worth knowing, and a key
 * that simply vanished reads as a field that was never touched.
 */
function redact(value, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    if (d >= MAX_DEPTH) return "[…]";
    return value.slice(0, MAX_KEYS).map(v => redact(v, d + 1));
  }
  if (typeof value === "object") {
    if (d >= MAX_DEPTH) return "{…}";
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n++ >= MAX_KEYS) { out["…"] = "more fields not recorded"; break; }
      out[k] = isSecretName(k) ? REDACTED : redact(value[k], d + 1);
    }
    return out;
  }
  /* A function or a symbol is not a record of anything. */
  return null;
}

/**
 * The fields that actually changed, before and after — and ONLY the
 * fields named.
 *
 * Handing a whole database row to before/after is how an audit log ends
 * up holding a copy of the thing it is auditing, growing without limit
 * and carrying every column that was never the point. So the caller
 * names the fields it means, and a field whose value did not change is
 * dropped: "price 1000 -> 1200" rather than forty columns of which one
 * moved.
 */
function changes(before, after, fields) {
  const names = fields && fields.length
    ? fields
    : Object.keys(Object.assign({}, before || {}, after || {}));

  const b = {}, a = {};
  let any = false;
  for (const f of names.slice(0, MAX_KEYS)) {
    const was = before ? before[f] : undefined;
    const now = after ? after[f] : undefined;
    /* Loose on purpose: 1000 from a form and 1000 from SQLite differ by
       type more often than by value, and "changed" would then be true
       for every field on every save. */
    if (String(was === undefined || was === null ? "" : was) ===
        String(now === undefined || now === null ? "" : now)) continue;
    any = true;
    b[f] = isSecretName(f) ? REDACTED : redact(was, 1);
    a[f] = isSecretName(f) ? REDACTED : redact(now, 1);
  }
  return any ? { before: b, after: a } : null;
}

/* ------------------------------------------------------------------
   HOW SERIOUS IT WAS

   Derived from the action, not stored as a column — and that is the
   point. There are 187 actions already in this app and 239 events in
   this shop's log written before PART 10 existed; a severity column
   would be null for every one of them, so the screen would grade this
   week's events and shrug at the whole history. A classification of the
   action name works identically for a row written last year and one
   written a second ago.

   It is honest about what it is: a view of the action, not a fact that
   was recorded at the time. Nothing is inferred about the outcome.
   ------------------------------------------------------------------ */
const CRITICAL = new Set([
  /* Who may do what. */
  "admin.user.role", "admin.user.disable", "admin.role.permissions",
  "staff.create", "staff.delete", "staff.permissions",
  /* The keys and the licence. */
  "sync.key.issue", "sync.key.revoke", "tally.bridge.token",
  "license.activate", "license.deactivate",
  /* Wiping the shop. */
  "reset.bills", "reset.all",
]);

const WARNING = new Set([
  "admin.user.enable", "staff.update", "staff.preview.start",
  "invoice.void", "invoice.delete", "invoice.edit",
  "challan.delete", "challan.edit",
  "customer.delete", "supplier.delete",
  "product.delete", "product.stock_adjust",
  "stock_in.force_delete", "import.undo",
  "fy_close", "fy_reopen",
  "return.void", "supplier.opening_balance_void",
]);

const NOTICE = new Set([
  "login", "logout", "staff.preview.stop",
  "backup.run", "backup.restore", "sync.push", "sync.push.failed",
  "customer.deactivate", "customer.activate",
]);

/* The order is the ranking, loudest first — the screen leads with the
   worst thing present and this is where that order is decided. */
const SEVERITIES = ["critical", "warning", "notice", "info"];

/* A destructive verb nobody has classified yet is still not routine.
   Better to over-report one than to file the next destructive action
   this app grows under "info". */
const DESTRUCTIVE = /\.(delete|void|revoke|force_delete)$/;
const DESTRUCTIVE_LIKE = ["%.delete", "%.void", "%.revoke", "%.force_delete"];

function severityOf(action) {
  const a = String(action || "");
  if (CRITICAL.has(a)) return "critical";
  if (WARNING.has(a)) return "warning";
  if (NOTICE.has(a)) return "notice";
  if (DESTRUCTIVE.test(a)) return "warning";
  return "info";
}

/* Which action names fall under a severity — the SQL side of the same
   table, so the filter on the screen is server-side like every other
   one. The two open-ended severities are expressed as what they are
   NOT, because "info" is every action nobody has named. */
function actionsForSeverity(key) {
  if (key === "critical") return { in: Array.from(CRITICAL) };
  if (key === "notice") return { in: Array.from(NOTICE) };
  if (key === "warning") {
    return { in: Array.from(WARNING), like: DESTRUCTIVE_LIKE };
  }
  if (key === "info") {
    return { notIn: Array.from(CRITICAL).concat(Array.from(WARNING), Array.from(NOTICE)),
             notLike: DESTRUCTIVE_LIKE };
  }
  return null;
}

/* ------------------------------------------------------------------
   THE ADDRESS AND THE DEVICE

   Both are recorded only when the app can actually resolve them, and
   both are trimmed. `req.ip` behind a proxy depends on TRUST_PROXY
   being set correctly — when it is not, what arrives is the proxy's own
   address, which is a fact about the hosting and not about the caller.
   It is stored as given rather than guessed at.

   The user agent is cut at 200 characters. A full modern agent string
   is a paragraph of version numbers and none of it identifies anything
   the shop needs; the first 200 say which browser on which system.
   ------------------------------------------------------------------ */
function addressOf(req) {
  if (!req) return null;
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "";
  return ip ? String(ip).slice(0, 60) : null;
}

function deviceOf(req) {
  if (!req || !req.get) return null;
  const ua = req.get("user-agent") || "";
  return ua ? String(ua).slice(0, 200) : null;
}

/* ------------------------------------------------------------------
   THE WRITE
   ------------------------------------------------------------------ */
const INSERT = `INSERT INTO audit_log
  (at, staff_id, staff_name, role, action, details,
   actor_type, resource_type, resource_id, result, meta, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/* The seven columns PART 10 added did not exist before it, and this app
   upgrades a shop's database in place rather than rebuilding it. A copy
   that has not run the migration yet — a restored backup from an older
   build, mid-upgrade — must still be able to record an action, so a
   failure to write the wide row falls back to the six columns that have
   always been there. Losing the new detail is a far smaller thing than
   losing the event. */
const INSERT_NARROW = `INSERT INTO audit_log
  (at, staff_id, staff_name, role, action, details) VALUES (?, ?, ?, ?, ?, ?)`;

function metaJson(meta) {
  if (!meta) return null;
  let text;
  try { text = JSON.stringify(redact(meta, 0)); }
  catch (e) { return null; }          // circular, or otherwise not a record
  if (!text || text === "{}" || text === "null") return null;
  return text.length > MAX_META ? text.slice(0, MAX_META - 1) + "}" : text;
}

/* Everything the two human-facing writers share: the actor from the
   session, the change set, and the preview note. Written once so
   record() and recordOrThrow() cannot drift apart — they must disagree
   about nothing except what happens when the write fails. */
function humanRow(req, action, details, o) {
  const s = (req && req.session) || null;

  let meta = o.meta ? Object.assign({}, o.meta) : null;
  const change = changes(o.before, o.after, o.fields);
  if (change) meta = Object.assign(meta || {}, change);

  /* An owner acting while previewing the app as a staff member. On the
     record as the owner, with the preview stated, so the entry cannot
     be read as the clerk having done it. */
  if (s && s.role === "owner" && s.previewStaffId) {
    meta = Object.assign(meta || {}, { previewingStaffId: s.previewStaffId });
  }

  return [
    Date.now(),                                   // the server's clock, always
    (s && s.staffId) || null,
    (s && s.staffName) || "System",
    (s && s.role) || "system",                    // the original column, unchanged
    String(action),
    details === undefined || details === null ? "" : String(details),
    actorTypeOf(req),
    resourceTypeOf(action, o.resourceType),
    o.resourceId === undefined || o.resourceId === null ? null : String(o.resourceId),
    RESULTS.includes(o.result) ? o.result : "SUCCESS",
    metaJson(meta),
    addressOf(req),
    deviceOf(req),
  ];
}

/**
 * Record one event.
 *
 * THIS IS THE ONLY WAY A HUMAN ACTION IS WRITTEN, and it reads the
 * actor from `req.session`. There is no actorType option: a caller
 * holding a request cannot declare itself SYSTEM or AI, because the
 * only functions that set those take no request at all.
 *
 * opts:
 *   resourceType / resourceId   what was acted on
 *   result                      SUCCESS (default) / FAILURE / DENIED
 *   before, after, fields       the change, via changes()
 *   meta                        anything else structured, redacted
 */
function record(req, action, details, opts) {
  const row = humanRow(req, action, details, opts || {});
  try {
    db.prepare(INSERT).run(...row);
  } catch (e) {
    /* Older database, missing the wide columns. Keep the event. */
    db.prepare(INSERT_NARROW).run(row[0], row[1], row[2], row[3], row[4], row[5]);
  }
}

/**
 * Record one event, and THROW if it could not be recorded.
 *
 * For the handful of actions where an unrecorded change is worse than a
 * refused one — granting admin access, rewriting a role's permissions,
 * switching an account off. The caller runs this inside the same
 * transaction as the change itself, so if the event cannot be written
 * the change is rolled back and the operator is told, rather than the
 * shop being left with a silent alteration to who may do what.
 *
 * See routes/admin.js for the three places that use it, and the note
 * there on why the ordinary business actions do NOT.
 */
function recordOrThrow(req, action, details, opts) {
  /* NO FALLBACK AND NO CATCH, unlike record(). The caller asked for a
     guarantee; swallowing the error here would hand back a promise this
     function had not kept. */
  db.prepare(INSERT).run(...humanRow(req, action, details, opts || {}));
}

/**
 * Record something this app did on its own — a timer, a migration, a
 * scheduled backup.
 *
 * NO REQUEST ARGUMENT, and that is the design: there is no way to reach
 * this from a browser, so an automated action cannot be filed under a
 * human's name and a human's action cannot be filed under SYSTEM.
 */
function recordSystem(action, details, opts) {
  return writeAutomated("SYSTEM", null, action, details, opts);
}

/**
 * Record something an automated agent did on the shop's behalf.
 *
 * NOTHING IN THIS APP CALLS THIS YET, and PART 10 deliberately builds
 * no agent to call it. It exists so that when one arrives its work is
 * already distinguishable from a person's at the point of writing,
 * rather than being backfilled into a column that cannot tell the
 * difference. The three fields an automated action needs beyond a
 * human's are what it was ASKED to do, what it ACTUALLY did, and on
 * whose authority.
 */
function recordAgent(agent, action, details, opts) {
  const o = opts || {};
  const meta = Object.assign({}, o.meta || {}, {
    agent: String(agent || "unnamed"),
    requested: o.requested === undefined ? null : o.requested,
    performed: o.performed === undefined ? null : o.performed,
    onBehalfOf: o.onBehalfOf === undefined ? null : o.onBehalfOf,
  });
  return writeAutomated("AI", String(agent || "agent"), action, details,
                        Object.assign({}, o, { meta }));
}

function writeAutomated(actorType, name, action, details, opts) {
  const o = opts || {};
  let meta = o.meta || null;
  const change = changes(o.before, o.after, o.fields);
  if (change) meta = Object.assign(meta || {}, change);

  const row = [
    Date.now(), null, name || "System", "system", String(action),
    details === undefined || details === null ? "" : String(details),
    actorType,
    resourceTypeOf(action, o.resourceType),
    o.resourceId === undefined || o.resourceId === null ? null : String(o.resourceId),
    RESULTS.includes(o.result) ? o.result : "SUCCESS",
    metaJson(meta),
    null,            // no address: nothing connected
    null,            // no device either
  ];
  try { db.prepare(INSERT).run(...row); }
  catch (e) { db.prepare(INSERT_NARROW).run(row[0], row[1], row[2], row[3], row[4], row[5]); }
}

module.exports = {
  record, recordOrThrow, recordSystem, recordAgent,
  actorTypeOf, resourceTypeOf, severityOf, actionsForSeverity,
  redact, changes, isSecretName,
  ACTOR_TYPES, AUTOMATED, RESULTS, SEVERITIES, REDACTED,
};
