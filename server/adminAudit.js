/* ============================================================
   ADMIN AUDIT LOGS — reading the record, and only ever reading it

   THIS MODULE IS READ-ONLY, and unlike adminSales.js — where that was a
   judgement about financial safety — here it is the whole point. An
   audit log that the audit screen can write to is not an audit log. So
   there is no insert, no update, no delete and no export-and-reimport
   anywhere in this file. Writing is auditLog.js's job and nothing in
   the admin panel calls it to invent an event.

   WHAT A QUERY HERE COSTS, measured rather than assumed. Against a
   synthetic log of 1,000,000 events on this machine, with the five
   indexes PART 10 added:

     newest page                        0.7ms
     deepest page (OFFSET 500,000)       57ms
     count of everything                 44ms
     one action, counted                 15ms
     one actor, counted                  12ms
     everything touching one record     0.2ms
     SEARCH INSIDE THE DESCRIPTION    1,549ms   <-- the exception

   That last line is why search here works the way it does. `details` is
   free prose and no index can help a LIKE '%...%' over it, so a naive
   search box that includes it costs a second and a half on a large log
   every time somebody types. The identity fields — who, what action,
   which record, which event — are all indexed and answer in 2ms, and
   those are exactly the fields worth searching. The description is
   searched too, but only once the other filters have narrowed the
   candidates to a size where it is cheap, and when they have not, the
   screen SAYS so rather than quietly leaving matches out.
   ============================================================ */
const db = require("./db");
const audit = require("./auditLog");
const { localDate } = require("./util");

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/* How many candidate rows a free-text scan of `details` is allowed to
   walk. 86,400 rows measured at 123ms, so 100,000 is around 145ms —
   inside what reads as instant, and two orders of magnitude above
   anything this shop will have for years. Above it the description is
   left out of the search and the caller is told, which is the one thing
   a search must never do silently. */
const TEXT_SEARCH_CEILING = 100000;

/* The free-text columns, and the one that is expensive. */
const CHEAP_SEARCH = ["staff_name", "staff_id", "action", "resource_type", "resource_id"];

function likeTerm(q) {
  return "%" + String(q).replace(/[\\%_]/g, c => "\\" + c) + "%";
}

/* ------------------------------------------------------------------
   THE EVENT ID

   The integer primary key, formatted. Deliberately NOT a second
   identifier: the row already has a unique, server-generated,
   never-reused id, and minting an opaque one beside it would mean two
   answers to "which event is this" and a column to keep in step.

   Formatted because "AUD-000241" is something a person can read back
   over a phone, and because it matches how this app already numbers a
   document. Search accepts either form.
   ------------------------------------------------------------------ */
function eventRef(id) {
  return "AUD-" + String(id).padStart(6, "0");
}

/* "AUD-000241", "aud 241" and "241" all mean event 241. Anything else
   is not an event reference and returns null, so a search for a
   customer's name is never read as an id. */
function parseEventRef(q) {
  const s = String(q || "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^aud[-\s_]*0*(\d+)$/i.exec(s);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------
   SORTS

   Newest first by default, because an audit log is read to answer "what
   just happened" far more often than anything else.

   `id` is the tie-breaker on every one of them, and it has to be: `at`
   is milliseconds, several events can share one, and an ORDER BY that
   does not fully determine the order will quietly show the same row on
   two pages and skip another. With OFFSET pagination that is not a
   cosmetic bug — it is an event the reader never sees.
   ------------------------------------------------------------------ */
const SORTS = {
  recent: { label: "Newest first", sql: "a.at DESC, a.id DESC" },
  oldest: { label: "Oldest first", sql: "a.at ASC, a.id ASC" },
  actor:  { label: "By person",    sql: "a.staff_name COLLATE NOCASE ASC, a.at DESC, a.id DESC" },
  action: { label: "By action",    sql: "a.action ASC, a.at DESC, a.id DESC" },
};

/* ------------------------------------------------------------------
   THE FILTER OPTIONS

   Its own call, not part of the list. Measured at 1,000,000 events,
   each GROUP BY over the whole log costs about 240ms even on a covering
   index — so building four of them into every page request would have
   put a second onto every keystroke and every page turn. The screen
   asks for these once when it opens.

   The closed vocabularies are not queried at all. actor_type, result
   and severity can only ever hold what auditLog.js defines, so they
   come from there — complete, in a sensible order, and free. Querying
   them would have cost 240ms each to discover a list already written
   down, and would have hidden the AI filter until the first AI event
   existed, which is backwards for a screen whose job is to show that an
   automated action can be told apart from a person's.

   Action and actor ARE queried, because those are open-ended: 187
   actions today and a staff list that is the shop's own.
   ------------------------------------------------------------------ */
const ACTOR_TYPE_LABELS = {
  OWNER:   "Owner",
  ADMIN:   "Admin",
  SUPPORT: "Support",
  STAFF:   "Staff",
  /* Short enough for a table column. What SYSTEM actually means is
     spelled out on the event detail by actorNote(), which is where
     somebody is working out whether a person or the app did something —
     "The app itself" in a badge blew the column out on a laptop. */
  SYSTEM:  "System",
  /* One word, because this is a badge in a narrow column. "Automated
     agent" overflowed the Kind column and ran into the Action beside
     it — visible the moment the first agent event was on screen. The
     full meaning is on the event detail, via actorNote(). */
  AI:      "Automated",
};

const RESULT_LABELS = {
  SUCCESS: "Succeeded",
  FAILURE: "Failed",
  DENIED:  "Refused",
};

const SEVERITY_LABELS = {
  critical: "Critical",
  warning:  "Warning",
  notice:   "Notice",
  info:     "Routine",
};

function options() {
  /* Guarded individually: a copy whose migration has not run yet has no
     actor_type column, and the screen should still open and list events
     rather than fail whole because a dropdown could not be filled. */
  const actions = safe(() => db.prepare(
    `SELECT action, COUNT(*) AS n FROM audit_log
      GROUP BY action ORDER BY action ASC LIMIT 500`).all(), []);

  const actors = safe(() => db.prepare(
    `SELECT staff_id, staff_name, COUNT(*) AS n FROM audit_log
      WHERE staff_id IS NOT NULL AND staff_id <> ''
      GROUP BY staff_id ORDER BY staff_name COLLATE NOCASE ASC LIMIT 500`).all(), []);

  const resources = safe(() => db.prepare(
    `SELECT resource_type, COUNT(*) AS n FROM audit_log
      WHERE resource_type IS NOT NULL AND resource_type <> ''
      GROUP BY resource_type ORDER BY resource_type ASC LIMIT 200`).all(), []);

  return {
    actions: actions.map(r => ({ key: r.action, label: r.action, n: r.n })),
    actors: actors.map(r => ({ key: r.staff_id, label: r.staff_name || r.staff_id, n: r.n })),
    resources: resources.map(r => ({ key: r.resource_type, label: r.resource_type, n: r.n })),
    actorTypes: audit.ACTOR_TYPES.map(k => ({ key: k, label: ACTOR_TYPE_LABELS[k] || k })),
    results: audit.RESULTS.map(k => ({ key: k, label: RESULT_LABELS[k] || k })),
    severities: audit.SEVERITIES.map(k => ({ key: k, label: SEVERITY_LABELS[k] || k })),
    sorts: Object.keys(SORTS).map(k => ({ key: k, label: SORTS[k].label })),
    pageSize: PAGE_SIZE,
  };
}

function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

/* ------------------------------------------------------------------
   THE ACTOR TYPE OF A ROW WRITTEN BEFORE PART 10

   239 events in this shop's log predate the actor_type column and have
   NULL in it. They are not backfilled — writing a guess into an audit
   log is the one thing this screen must not do — so the type is derived
   for display from the `role` the row did record, and the row is marked
   as derived so the detail view can say so.

   role 'system' was already being written by first-run seeding and by
   the schema's own migrations, so SYSTEM is a fact about those rows
   rather than an assumption.
   ------------------------------------------------------------------ */
function actorTypeOfRow(r) {
  if (r.actor_type) return { type: r.actor_type, derived: false };
  const role = String(r.role || "").toLowerCase();
  if (role === "owner") return { type: "OWNER", derived: true };
  if (role === "system") return { type: "SYSTEM", derived: true };
  if (role === "staff") return { type: "STAFF", derived: true };
  return { type: null, derived: true };
}

/* ------------------------------------------------------------------
   BUILDING THE WHERE

   Every filter is applied in SQL. Nothing is filtered in JavaScript
   after the fact, because a page of 25 filtered in the browser is a
   page of 25 that was already wrong — the count, the pager and the
   other 999,975 rows would all disagree with it.
   ------------------------------------------------------------------ */
function buildWhere(o) {
  const where = [];
  const params = [];

  /* Date range. Compared against `at`, which is epoch milliseconds, so
     the day the user picked has to become the whole of that day in
     local time — an inclusive `to` that stopped at midnight would miss
     everything that happened on the day they asked for. */
  if (o.from) {
    const t = dayStart(o.from);
    if (t !== null) { where.push("a.at >= ?"); params.push(t); }
  }
  if (o.to) {
    const t = dayEnd(o.to);
    if (t !== null) { where.push("a.at <= ?"); params.push(t); }
  }

  /* Exact matches, every one of them a filter and not a search — a LIKE
     here would let a filter on staff id "stf_1" quietly include
     "stf_12". */
  if (o.actor) { where.push("a.staff_id = ?"); params.push(String(o.actor)); }
  if (o.action) { where.push("a.action = ?"); params.push(String(o.action)); }
  if (o.resource) { where.push("a.resource_type = ?"); params.push(String(o.resource)); }
  if (o.resourceId) { where.push("a.resource_id = ?"); params.push(String(o.resourceId)); }
  if (o.result) { where.push("a.result = ?"); params.push(String(o.result)); }

  /* Actor type has to cope with the rows that predate the column, or
     filtering by "Owner" would silently hide this shop's entire history
     before PART 10. So the filter means "recorded as this, OR recorded
     with the role this is derived from". */
  if (o.actorType) {
    const legacy = { OWNER: "owner", STAFF: "staff", SYSTEM: "system" }[o.actorType];
    if (legacy) {
      where.push("(a.actor_type = ? OR (a.actor_type IS NULL AND a.role = ?))");
      params.push(String(o.actorType), legacy);
    } else {
      where.push("a.actor_type = ?");
      params.push(String(o.actorType));
    }
  }

  /* Severity is a classification of the action name rather than a
     column, so it becomes a predicate over action names. See
     auditLog.actionsForSeverity for why "info" is expressed as a
     negative. */
  if (o.severity) {
    const spec = audit.actionsForSeverity(o.severity);
    if (spec) {
      const parts = [];
      if (spec.in && spec.in.length) {
        parts.push("a.action IN (" + spec.in.map(() => "?").join(",") + ")");
        params.push(...spec.in);
      }
      if (spec.like) {
        for (const p of spec.like) { parts.push("a.action LIKE ?"); params.push(p); }
      }
      if (parts.length) where.push("(" + parts.join(" OR ") + ")");

      if (spec.notIn && spec.notIn.length) {
        where.push("a.action NOT IN (" + spec.notIn.map(() => "?").join(",") + ")");
        params.push(...spec.notIn);
      }
      if (spec.notLike) {
        for (const p of spec.notLike) { where.push("a.action NOT LIKE ?"); params.push(p); }
      }
    }
  }

  return { where, params };
}

/* A date the user picked, as the first and last millisecond of that day
   in the shop's own timezone. Not UTC — the same reasoning as
   util.todayStr: India is UTC+5:30, so a UTC day boundary puts
   everything before 5:30am on the wrong date. */
function dayStart(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

function dayEnd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
}

/* ==================================================================
   THE EVENT LIST
   ================================================================== */
function events(opts) {
  const o = opts || {};
  const q = String(o.q || "").trim();
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "recent";
  const size = Math.min(Math.max(Number(o.pageSize) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(o.page) || 1, 1);

  const built = buildWhere(o);
  const where = built.where.slice();
  const params = built.params.slice();

  /* ---- the search -------------------------------------------------
     Decided here, from a measurement rather than a guess: count what
     the filters alone have narrowed the log to, which is indexed and
     cheap, and only walk the descriptions if that number is small
     enough to afford. */
  let textSearched = true;
  let candidates = null;

  if (q) {
    const filterSql = where.length ? " WHERE " + where.join(" AND ") : "";
    candidates = safe(() => db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log a" + filterSql).get(...params).n, 0);

    const or = CHEAP_SEARCH.map(c => "a." + c + " LIKE ? ESCAPE '\\'");
    const term = likeTerm(q);
    const searchParams = CHEAP_SEARCH.map(() => term);

    /* An event reference matches that one event exactly, whatever else
       the term might look like. */
    const ref = parseEventRef(q);
    if (ref !== null) { or.push("a.id = ?"); searchParams.push(ref); }

    if (candidates <= TEXT_SEARCH_CEILING) {
      or.push("a.details LIKE ? ESCAPE '\\'");
      searchParams.push(term);
      or.push("a.meta LIKE ? ESCAPE '\\'");
      searchParams.push(term);
    } else {
      textSearched = false;
    }

    where.push("(" + or.join(" OR ") + ")");
    params.push(...searchParams);
  }

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  const head = safe(() => db.prepare(
    "SELECT COUNT(*) AS n FROM audit_log a" + whereSql).get(...params), null);

  /* No count means no audit_log table at all — a copy this old should
     be told so plainly rather than shown an empty table that reads as
     "nothing has ever happened here". */
  if (head === null) {
    return { available: false,
             reason: "This copy of the app has no audit log table.",
             rows: [], total: 0, page: 1, pages: 1, pageSize: size };
  }

  const pages = Math.max(Math.ceil(head.n / size), 1);
  const safePage = Math.min(page, pages);

  const rows = db.prepare(
    `SELECT a.id, a.at, a.staff_id, a.staff_name, a.role, a.action, a.details,
            a.actor_type, a.resource_type, a.resource_id, a.result, a.meta,
            a.ip, a.user_agent
       FROM audit_log a${whereSql}
      ORDER BY ${SORTS[sort].sql}
      LIMIT ? OFFSET ?`).all(...params, size, (safePage - 1) * size);

  return {
    available: true,
    total: head.n,
    page: safePage, pages, pageSize: size,
    q, sort,
    actor: o.actor || "", actorType: o.actorType || "", action: o.action || "",
    resource: o.resource || "", resourceId: o.resourceId || "",
    result: o.result || "", severity: o.severity || "",
    from: o.from || "", to: o.to || "",
    rows: rows.map(shapeRow),
    /* SAID OUT LOUD WHEN IT APPLIES. If the description could not be
       searched, the reader is told which part of the search ran and how
       to make the rest of it run, rather than being handed a short list
       that looks complete. */
    search: q ? {
      descriptionsSearched: textSearched,
      candidates,
      ceiling: TEXT_SEARCH_CEILING,
      fields: CHEAP_SEARCH.concat(["event id"]),
    } : null,
  };
}

/* One row as the screen needs it. No secret is read here because none
   is stored — see auditLog.js, which redacts on the way in, so there is
   nothing to filter on the way out. */
function shapeRow(r) {
  const actor = actorTypeOfRow(r);
  return {
    id: r.id,
    ref: eventRef(r.id),
    at: r.at,
    when: localDate(r.at),
    time: new Date(r.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    who: r.staff_name || "System",
    whoId: r.staff_id || "",
    actorType: actor.type,
    actorLabel: actor.type ? (ACTOR_TYPE_LABELS[actor.type] || actor.type) : "Unknown",
    actorDerived: actor.derived,
    automated: audit.AUTOMATED.includes(actor.type),
    action: r.action || "",
    resourceType: r.resource_type || "",
    resourceId: r.resource_id || "",
    result: r.result || "",
    resultLabel: r.result ? (RESULT_LABELS[r.result] || r.result) : "",
    severity: audit.severityOf(r.action),
    severityLabel: SEVERITY_LABELS[audit.severityOf(r.action)] || "",
    details: String(r.details || ""),
    hasChange: !!(r.meta && r.meta.indexOf("\"before\"") !== -1),
  };
}

/* ==================================================================
   ONE EVENT

   ANOTHER SHOP'S EVENT IS NOT FOUND, and that is structural rather than
   a check written here. Companies in this app are separate SQLite
   FILES, not rows sharing a company_id, and which file `db` resolves to
   is decided by the binder in index.js from the SESSION. An id from
   another shop pasted into this URL is looked up in the caller's own
   file, is not there, and returns null — there is no query that could
   reach across, and no parameter on this function that could be made to.
   ================================================================== */
function event(id) {
  const n = parseEventRef(id);
  if (n === null) return null;

  const r = safe(() => db.prepare(
    `SELECT a.id, a.at, a.staff_id, a.staff_name, a.role, a.action, a.details,
            a.actor_type, a.resource_type, a.resource_id, a.result, a.meta,
            a.ip, a.user_agent
       FROM audit_log a WHERE a.id = ?`).get(n), null);
  if (!r) return null;

  const base = shapeRow(r);

  /* The structured detail, parsed. Written by auditLog.js, which
     redacted it on the way in — but parsed defensively anyway, because
     a row could have come from a restored backup written by a build
     that is not this one. */
  let meta = null;
  if (r.meta) {
    try { meta = JSON.parse(r.meta); } catch (e) { meta = null; }
  }

  const change = meta && meta.before && meta.after
    ? fieldChanges(meta.before, meta.after)
    : [];

  /* Everything else in meta that is not the change — the preview note,
     an agent's requested-versus-performed, anything a future caller
     adds — listed as it is rather than dropped. */
  const extra = {};
  if (meta) {
    for (const k of Object.keys(meta)) {
      if (k === "before" || k === "after") continue;
      extra[k] = meta[k];
    }
  }

  return Object.assign({}, base, {
    /* The device and address only on the detail view, never in the
       list: a column of browser strings tells a reader nothing and
       spreads a person's device across every page they appear on. */
    ip: r.ip || "",
    userAgent: r.user_agent || "",
    change,
    extra: Object.keys(extra).length ? extra : null,
    /* What the actor type means, in words, since this is the screen
       where somebody is working out whether a person or the app did
       something. */
    actorNote: actorNote(base),
  });
}

/* before/after as a list the screen can render in order, rather than
   two objects it would have to walk in step. */
function fieldChanges(before, after) {
  const names = Object.keys(Object.assign({}, before, after));
  return names.map(f => ({
    field: f,
    before: before[f] === undefined ? null : before[f],
    after: after[f] === undefined ? null : after[f],
  }));
}

/* BOTH FACTS, WHEN BOTH APPLY — and the caveat first.
 *
 * This returned only one note at first, and it checked the actor type
 * before the caveat: a pre-PART-10 row whose type derives to SYSTEM was
 * told confidently that it was the application acting, with no mention
 * that the type had been worked out rather than recorded. On the one
 * screen whose job is to say exactly how much is known about an event,
 * the derivation is the more important half. */
function actorNote(row) {
  const notes = [];

  if (row.actorDerived && row.actorType) {
    notes.push("This event predates the actor-type column, so the kind of actor is shown "
             + "as derived from the role that was recorded at the time. The name, time, "
             + "action and description are exactly as they were written.");
  } else if (row.actorDerived) {
    notes.push("This event predates the actor-type column and recorded no role that the "
             + "kind of actor could be derived from.");
  }

  if (row.actorType === "SYSTEM") {
    notes.push("SYSTEM means the application itself — a timer, a migration or first-run "
             + "setup — rather than a person signed in at a screen.");
  }
  if (row.actorType === "AI") {
    notes.push("Recorded as an automated agent acting on the shop's behalf, not as a person.");
  }

  return notes.join(" ");
}

/* ==================================================================
   EVERYTHING THAT TOUCHED ONE RECORD

   The reason resource_type and resource_id are columns at all. Used by
   the detail view to offer "all 14 events on this invoice", and
   available to any other admin screen that wants a record's history
   without inventing a second query for it. 0.2ms at a million events.
   ================================================================== */
function forResource(type, id, limit) {
  if (!type || !id) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_PAGE_SIZE);
  const rows = safe(() => db.prepare(
    `SELECT a.id, a.at, a.staff_id, a.staff_name, a.role, a.action, a.details,
            a.actor_type, a.resource_type, a.resource_id, a.result, a.meta
       FROM audit_log a
      WHERE a.resource_type = ? AND a.resource_id = ?
      ORDER BY a.at DESC, a.id DESC LIMIT ?`).all(String(type), String(id), n), []);
  return rows.map(shapeRow);
}

module.exports = {
  events, event, options, forResource,
  eventRef, parseEventRef, actorTypeOfRow,
  PAGE_SIZE, MAX_PAGE_SIZE, TEXT_SEARCH_CEILING,
  ACTOR_TYPE_LABELS, RESULT_LABELS, SEVERITY_LABELS, SORTS,
};
