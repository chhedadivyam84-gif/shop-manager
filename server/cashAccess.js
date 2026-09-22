/* ============================================================
   WHICH CASH BOOK DAYS A STAFF MEMBER MAY SEE

   Permission answers "may they open the Cash Book at all". This answers
   the second question: "which days of it". A shop hiring help for one
   week's stock-take wants that person to write up that week and read
   nothing else — not the month before, not the year before.

   ONE PLACE, because a window that a route enforces and a report does not
   is not a window. Everything that reads cash_entries on somebody's behalf
   asks here and gets either a filter or nothing.

   THE THREE PERIODS, as the owner sets them:

     One Day     exactly one date. Nothing before it, nothing after.
     Date Range  from and to, both inclusive.
     Permanent   no date limit; the ordinary View/Add/Edit/Print rules
                 alone decide what they see.

   BLANK MEANS PERMANENT, deliberately, and this is the one place in the
   permission system where an unconfigured setting is the permissive one.
   Everywhere else "no row means no permission" is right because the row
   is how access is granted. Here the row only NARROWS access that the
   permission grid has already granted, so treating blank as "deny
   everything" would silently shut the Cash Book for every staff member
   who already has it the day this ships. An owner who wants a limit sets
   one; until then nothing changes for anybody.

   A HALF-SET WINDOW IS NOT THE SAME AS NO WINDOW. "One Day" with no date
   chosen is a configuration someone began and did not finish, and it
   denies rather than allows — the route that saves it refuses to store it
   in the first place, and this is the second lock on that door.

   THE OPENING BALANCE IS THE WINDOW'S, NOT THE BOOK'S. A person limited
   to September reads a book that begins in September: the running total
   starts at zero on their first allowed day. Carrying the true opening
   balance in would hand them the sum of every entry they are not allowed
   to see, which is the restriction leaking out as a single number.
   ============================================================ */
const db = require("./db");
const permissions = require("./permissions");

const TYPES = ["permanent", "day", "range"];

/* Sorts and compares correctly as plain text, which is why every date in
   this app is stored this way and why a window can be a string compare. */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* A window nothing can fall inside. Used when the settings are half-set:
   the safe reading of an unfinished restriction is the strict one. */
const DENY = { type: "blocked", from: "9999-12-31", to: "0001-01-01" };

/** The stored settings for one staff member, or null if there are none. */
function settingsFor(staffId) {
  if (!staffId) return null;
  try {
    const s = db.prepare(`
      SELECT cash_access_type AS type, cash_access_date AS date,
             cash_access_from AS "from", cash_access_to AS "to"
        FROM staff WHERE id = ?`).get(staffId);
    return s || null;
  } catch (e) {
    /* Columns not built on this copy yet — older database, no limits. */
    return null;
  }
}

/**
 * The days this request may read, or null for "no limit".
 *
 * null and a window are different answers and callers must not confuse
 * them: null means add no filter at all, a window means add this one. An
 * empty object would read as false and quietly unrestrict.
 */
function windowFor(req) {
  /* The owner is never limited. An owner locked out of their own cash book
     by a setting meant for somebody else is a worse failure than any this
     prevents — the same rule permissions.js already states for modules. */
  if (permissions.isOwner(req)) return null;
  if (!req || !req.session || !req.session.loggedIn) return DENY;

  const s = settingsFor(permissions.effectiveStaffId(req));
  if (!s) return null;

  const type = String(s.type || "").trim();
  if (!type || type === "permanent") return null;
  if (!TYPES.includes(type)) return DENY;      // something we do not understand

  if (type === "day") {
    const d = String(s.date || "").trim();
    return ISO.test(d) ? { type: "day", from: d, to: d } : DENY;
  }

  const from = String(s.from || "").trim();
  const to = String(s.to || "").trim();
  if (!ISO.test(from) || !ISO.test(to)) return DENY;
  /* Saved the wrong way round. Read it the way it was plainly meant
     rather than refusing — the dates are both there and both valid. */
  return from <= to ? { type: "range", from, to } : { type: "range", from: to, to: from };
}

/**
 * A SQL fragment to AND into any query over cash_entries.
 *
 * Returns an empty fragment when there is no limit, so the caller writes
 * the same two lines either way and cannot forget the unrestricted case.
 */
function sqlAnd(req, col) {
  const w = windowFor(req);
  if (!w) return { sql: "", params: [] };
  const c = col || "date";
  return { sql: ` AND ${c} >= ? AND ${c} <= ?`, params: [w.from, w.to] };
}

/** The same filter for rows already in memory. */
function filterRows(req, rows, key) {
  const w = windowFor(req);
  if (!w) return rows;
  const k = key || "date";
  return rows.filter(r => r && r[k] >= w.from && r[k] <= w.to);
}

/**
 * May this request touch an entry dated `date`?
 *
 * Asked by every write. Someone allowed only the 10th may not add an entry
 * dated the 9th, and may not edit an entry INTO or OUT OF their window —
 * both sides of an edit are checked by the caller, because moving a row
 * across the boundary is how a restriction gets walked around one day at
 * a time.
 */
function allows(req, date) {
  const w = windowFor(req);
  if (!w) return true;
  const d = String(date || "").trim();
  if (!ISO.test(d)) return false;
  return d >= w.from && d <= w.to;
}

/**
 * The range a query should actually use, given what the caller asked for.
 *
 * The asked-for range is narrowed to the window, never widened by it: a
 * staff member who clears the date boxes gets their window, and one who
 * types a date outside it gets nothing rather than everything. `blocked`
 * says the two do not overlap at all, so the caller can answer with an
 * empty result instead of an accidental full one.
 */
function clamp(req, from, to) {
  const w = windowFor(req);
  const asked = { from: String(from || "").trim(), to: String(to || "").trim() };
  if (!w) return { from: asked.from, to: asked.to, blocked: false, limited: false };

  const lo = asked.from && asked.from > w.from ? asked.from : w.from;
  const hi = asked.to && asked.to < w.to ? asked.to : w.to;
  return { from: lo, to: hi, blocked: lo > hi, limited: true };
}

/** What to tell the person, in a sentence, so a short book is not a bug. */
function describe(req) {
  const w = windowFor(req);
  if (!w) return "";
  if (w.type === "blocked") return "Your Cash Book access has not been set up. Ask the owner.";
  if (w.type === "day") return `You can see the Cash Book for ${w.from} only.`;
  return `You can see the Cash Book from ${w.from} to ${w.to}.`;
}

/**
 * Check and tidy what the owner is trying to save.
 *
 * Returns the row to store, or throws with something the owner can act on.
 * A half-set period is refused here rather than stored and denied later,
 * so the owner finds out while they are still looking at the screen.
 */
function validate(input) {
  const raw = input || {};
  const type = String(raw.type || "").trim();
  if (!type || type === "permanent") {
    return { type: "permanent", date: "", from: "", to: "" };
  }
  if (!TYPES.includes(type)) throw new Error("Choose One Day, Date Range or Permanent.");

  if (type === "day") {
    const d = String(raw.date || "").trim();
    if (!ISO.test(d)) throw new Error("Pick the one date this person may see.");
    return { type: "day", date: d, from: "", to: "" };
  }

  const from = String(raw.from || "").trim();
  const to = String(raw.to || "").trim();
  if (!ISO.test(from) || !ISO.test(to)) throw new Error("Pick both a From date and a To date.");
  if (from > to) throw new Error("The From date must not be after the To date.");
  return { type: "range", date: "", from, to };
}

module.exports = {
  TYPES, windowFor, sqlAnd, filterRows, allows, clamp, describe, validate, settingsFor,
};
