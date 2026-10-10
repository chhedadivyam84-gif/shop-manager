/* ============================================================
   NOTIFICATIONS — the one service every module calls

   Something happened that a person should hear about: the subscription
   runs out on Friday, five wrong PINs were typed for Ramesh, a board fell
   below the level the owner set. A module calls create() and carries on.

   THREE RULES THIS FILE KEEPS

   1. A notification never breaks the thing it is about. create() cannot
      throw. A sale that drops a board below its minimum is still a sale if
      the notification fails to write — the failure is logged and that is
      the end of it.

   2. The same incident is one notification, not fifty. Every caller names
      its incident with a key, and create() decides here whether this is a
      new event or the same one again. A request that is retried, a sweep
      that runs every hour, a size sold one piece at a time below its
      minimum — none of them produce a second row.

   3. Who may see a notification is decided here, on the server, for every
      read. The screen is told nothing it should not have; it cannot ask
      for somebody else's list, and it cannot mark somebody else's as read.

   Scoped to a company by db.js like every other table: each business is
   its own SQLite file, so one shop's notifications are not in the same
   database as another's to be leaked.
   ============================================================ */
const crypto = require("crypto");
const db = require("./db");
const permissions = require("./permissions");
const { describeError } = require("./logSafe");

const CATEGORIES = ["licence", "security", "stock", "announcement", "system"];
/* Cannot be switched off. A shop that has silenced "your subscription ends
   tomorrow" or "five wrong PINs for the owner" has not made a choice, it
   has made a mistake it finds out about too late. */
const ESSENTIAL = ["licence", "security", "system"];
const OPTIONAL = ["stock", "announcement"];
/* Sent by email only if the owner asks for it, and announcements never:
   a notice from the supplier is not something this app should be mailing
   on its behalf. */
const EMAILABLE = ["licence", "security", "system", "stock"];
const SEVERITIES = ["info", "warning", "critical"];

/* The only places a notification may send somebody. A link is a NAME from
   this list, never a URL — so a notice, whoever wrote it, cannot point the
   app at another site or at a javascript: address. The screen holds the
   same list and opens nothing that is not on it. */
const LINKS = new Set([
  "alerts", "inventory", "product", "backups", "settings", "staff", "audit"
]);

/* Audiences that are a permission rather than a person. Seeing a stock
   notification is exactly as wide as being allowed to see stock. */
const PERM_AUDIENCES = ["stock"];

const MAX_TITLE = 140;
const MAX_BODY = 600;

/** Plain text, bounded, with control characters gone. Newlines survive. */
function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function validAudience(a) {
  if (a === "owner" || a === "all") return true;
  const perm = /^perm:([a-z_]+)$/.exec(a);
  if (perm) return PERM_AUDIENCES.includes(perm[1]);
  return /^staff:[A-Za-z0-9_-]{1,64}$/.test(a);
}

/**
 * Record a notification. Never throws.
 *
 *   key           names the incident. Omit only for something that cannot
 *                 recur (an announcement already has its own id).
 *   repeatAfterMs if the same key fires again after this long, it is a new
 *                 event. Omitted, a key fires once, ever.
 *
 * Returns { ok, id, deduped } — or { ok:false } having logged why.
 */
function create(n) {
  try {
    const category = String(n.category || "");
    if (!CATEGORIES.includes(category)) throw new Error("unknown category " + category);
    const severity = SEVERITIES.includes(n.severity) ? n.severity : "info";
    const title = clean(n.title, MAX_TITLE);
    if (!title) throw new Error("a notification needs a title");
    const audience = String(n.audience || "owner");
    if (!validAudience(audience)) throw new Error("unknown audience " + audience);
    const link = LINKS.has(n.link) ? n.link : "";
    const key = n.key ? clean(n.key, 200) : null;
    const now = Date.now();

    if (key) {
      const last = db.prepare(
        "SELECT id, created_at FROM notifications WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1"
      ).get(key);
      if (last && (n.repeatAfterMs == null || now - last.created_at < n.repeatAfterMs)) {
        return { ok: true, id: last.id, deduped: true };
      }
    }

    const id = "ntf_" + crypto.randomBytes(8).toString("hex");
    db.prepare(`INSERT INTO notifications
        (id, created_at, category, severity, title, body, link_tab, link_id,
         audience, dedupe_key, source, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, now, category, severity, title, clean(n.body, MAX_BODY), link,
           link ? clean(n.linkId, 64) : "", audience, key,
           ["system", "vendor", "owner"].includes(n.source) ? n.source : "system",
           clean(n.createdBy, 64));

    /* After the row exists, outside whatever transaction the caller is in,
       and in this company — the email module reads the shop's own address
       and the owner's own preference. */
    if (EMAILABLE.includes(category)) {
      const companyId = db.companies.currentId();
      setImmediate(() => {
        try { require("./notifyEmail").deliver(companyId, id); }
        catch (e) { console.error("[notify] email hand-off failed", JSON.stringify(describeError(e))); }
      });
    }
    return { ok: true, id, deduped: false };
  } catch (e) {
    console.error("[notify] could not record a notification", JSON.stringify(describeError(e)));
    return { ok: false };
  }
}

/** The same notification in every business this installation holds.
 *  For things that belong to the installation rather than a shop — its
 *  licence, its backups. */
function createEverywhere(n) {
  const out = [];
  for (const c of db.companies.list()) {
    if (c.active === false) continue;
    out.push(db.companies.runAs(c.id, () => create(n)));
  }
  return out;
}

/* ---------------------------------------------------------- state */

function getState(k) {
  try {
    const r = db.prepare("SELECT v FROM notification_state WHERE k = ?").get(k);
    return r ? r.v : null;
  } catch (e) { return null; }
}
function setState(k, v) {
  try {
    db.prepare(`INSERT INTO notification_state (k, v, updated_at) VALUES (?,?,?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`)
      .run(k, v == null ? null : String(v), Date.now());
  } catch (e) { /* the next sweep will try again */ }
}

/* ---------------------------------------------------------- who sees what */

/**
 * What THIS signed-in person may see, worked out from the session alone.
 * Nothing the browser sends is consulted.
 */
function viewerOf(req) {
  const s = req && req.session;
  if (!s || !s.loggedIn || !s.staffId) return null;
  const owner = permissions.isOwner(req);
  const audiences = ["all", "staff:" + s.staffId];
  if (owner) audiences.push("owner");
  for (const m of PERM_AUDIENCES) {
    if (owner || permissions.can(req, m, "view")) audiences.push("perm:" + m);
  }
  let since = 0, off = [];
  try {
    const me = db.prepare("SELECT created_at FROM staff WHERE id = ?").get(s.staffId);
    /* Somebody who joined on Monday is not told about last month. Not for
       the owner, who is the one who needs the history. */
    if (me && !owner) since = me.created_at || 0;
    off = db.prepare("SELECT category FROM notification_prefs WHERE staff_id = ? AND in_app = 0")
      .all(s.staffId).map(r => r.category).filter(c => OPTIONAL.includes(c));
  } catch (e) { /* defaults: everything since the start */ }
  return { staffId: s.staffId, owner, audiences, since, off };
}

function visibleWhere(v) {
  const parts = ["n.hidden_at IS NULL", "n.created_at >= ?"];
  const args = [v.since];
  parts.push(`n.audience IN (${v.audiences.map(() => "?").join(",")})`);
  args.push(...v.audiences);
  if (v.off.length) {
    parts.push(`n.category NOT IN (${v.off.map(() => "?").join(",")})`);
    args.push(...v.off);
  }
  return { sql: parts.join(" AND "), args };
}

function shape(r) {
  return {
    id: r.id, at: r.created_at, category: r.category, severity: r.severity,
    title: r.title, body: r.body,
    link: r.link_tab || "", linkId: r.link_id || "",
    source: r.source, read: !!r.read_at,
    /* So the owner's screen can offer "withdraw" on their own notices and
       nothing else. */
    mine: r.source === "owner"
  };
}

/** A page, newest first. `before` is the cursor the last page returned. */
function list(req, { before, limit } = {}) {
  const v = viewerOf(req);
  if (!v) return { items: [], next: null, unread: 0 };
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const w = visibleWhere(v);
  let sql = `SELECT n.*, r.read_at FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.staff_id = ?
    WHERE ${w.sql}`;
  const args = [v.staffId, ...w.args];
  const cur = /^(\d{1,15}):(ntf_[0-9a-f]{16})$/.exec(String(before || ""));
  if (cur) {
    sql += " AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))";
    args.push(Number(cur[1]), Number(cur[1]), cur[2]);
  }
  sql += " ORDER BY n.created_at DESC, n.id DESC LIMIT ?";
  args.push(n + 1);
  const rows = db.prepare(sql).all(...args);
  const more = rows.length > n;
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return {
    items: page.map(shape),
    next: more && last ? `${last.created_at}:${last.id}` : null,
    unread: unreadCount(req)
  };
}

function unreadCount(req) {
  const v = viewerOf(req);
  if (!v) return 0;
  const w = visibleWhere(v);
  return db.prepare(`SELECT COUNT(*) AS c FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.staff_id = ?
    WHERE ${w.sql} AND r.read_at IS NULL`).get(v.staffId, ...w.args).c;
}

/** Mark these as read FOR THIS PERSON. Ids they cannot see are ignored —
 *  silently, so the answer does not say whether such an id exists. */
function markRead(req, ids) {
  const v = viewerOf(req);
  if (!v) return 0;
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))]
    .filter(id => /^ntf_[0-9a-f]{16}$/.test(id)).slice(0, 200);
  if (!wanted.length) return 0;
  const w = visibleWhere(v);
  const r = db.prepare(`INSERT OR IGNORE INTO notification_reads (notification_id, staff_id, read_at)
    SELECT n.id, ?, ? FROM notifications n
     WHERE ${w.sql} AND n.id IN (${wanted.map(() => "?").join(",")})`)
    .run(v.staffId, Date.now(), ...w.args, ...wanted);
  return Number(r.changes) || 0;
}

function markAllRead(req) {
  const v = viewerOf(req);
  if (!v) return 0;
  const w = visibleWhere(v);
  const r = db.prepare(`INSERT OR IGNORE INTO notification_reads (notification_id, staff_id, read_at)
    SELECT n.id, ?, ? FROM notifications n WHERE ${w.sql}`)
    .run(v.staffId, Date.now(), ...w.args);
  return Number(r.changes) || 0;
}

/* ---------------------------------------------------------- preferences */

function prefsOf(req) {
  const v = viewerOf(req);
  if (!v) return null;
  const rows = db.prepare("SELECT category, in_app, email FROM notification_prefs WHERE staff_id = ?")
    .all(v.staffId);
  const by = new Map(rows.map(r => [r.category, r]));
  const emailReady = require("./notifyEmail").configured();
  return {
    emailAvailable: v.owner && emailReady,
    emailConfigured: emailReady,
    categories: CATEGORIES
      /* A permission they do not have is not a preference they get. */
      .filter(c => c !== "stock" || v.audiences.includes("perm:stock"))
      .map(c => ({
        category: c,
        essential: ESSENTIAL.includes(c),
        inApp: ESSENTIAL.includes(c) ? true : (by.has(c) ? !!by.get(c).in_app : true),
        /* Email is the owner's, and only for the kinds that may be mailed. */
        emailAllowed: v.owner && EMAILABLE.includes(c),
        email: v.owner && EMAILABLE.includes(c) && by.has(c) ? !!by.get(c).email : false
      }))
  };
}

/**
 * Change one category. Refuses — rather than quietly ignoring — anything
 * that would switch off an essential kind, so a screen that offers it
 * cannot appear to have worked.
 */
function setPref(req, category, { inApp, email }) {
  const v = viewerOf(req);
  if (!v) throw Object.assign(new Error("Sign in first."), { status: 401 });
  if (!CATEGORIES.includes(category)) throw Object.assign(new Error("No such kind of notification."), { status: 400 });
  if (inApp === false && ESSENTIAL.includes(category)) {
    throw Object.assign(new Error("Licence, security and system notices cannot be turned off."), { status: 400 });
  }
  if (email === true && !(v.owner && EMAILABLE.includes(category))) {
    throw Object.assign(new Error("Only the owner can have these emailed."), { status: 403 });
  }
  const cur = db.prepare("SELECT in_app, email FROM notification_prefs WHERE staff_id = ? AND category = ?")
    .get(v.staffId, category) || { in_app: 1, email: 0 };
  const nextInApp = ESSENTIAL.includes(category) ? 1 : (inApp === undefined ? cur.in_app : (inApp ? 1 : 0));
  const nextEmail = email === undefined ? cur.email : (email ? 1 : 0);
  db.prepare(`INSERT INTO notification_prefs (staff_id, category, in_app, email, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(staff_id, category) DO UPDATE SET in_app = excluded.in_app, email = excluded.email,
      updated_at = excluded.updated_at`)
    .run(v.staffId, category, nextInApp, nextEmail, Date.now());
  return prefsOf(req);
}

/* ---------------------------------------------------------- announcements */

/** A notice from the owner to everybody in this shop. Owner only — checked
 *  by the route AND here, because this is the one way to put words in front
 *  of every member of staff. */
function announce(req, { title, body }) {
  if (!permissions.isOwner(req)) throw Object.assign(new Error("Only the owner can post a notice."), { status: 403 });
  const t = clean(title, MAX_TITLE);
  if (!t) throw Object.assign(new Error("Give the notice a heading."), { status: 400 });
  const r = create({
    category: "announcement", severity: "info", audience: "all", source: "owner",
    title: t, body, createdBy: req.session.staffId
  });
  if (!r.ok) throw new Error("Could not post the notice.");
  return r.id;
}

/** Withdraw a notice the owner posted. Hidden for everybody; kept. */
function withdraw(req, id) {
  if (!permissions.isOwner(req)) throw Object.assign(new Error("Only the owner can withdraw a notice."), { status: 403 });
  const r = db.prepare(`UPDATE notifications SET hidden_at = ?
     WHERE id = ? AND source = 'owner' AND hidden_at IS NULL`).run(Date.now(), String(id || ""));
  if (!Number(r.changes)) throw Object.assign(new Error("No such notice of yours."), { status: 404 });
}

/**
 * What the supplier has published, as the licence server last sent it.
 * Each announcement becomes one notification, once; one the supplier has
 * since withdrawn is hidden. Run inside the company it is for.
 */
function syncVendorAnnouncements(active, withdrawn) {
  try {
    for (const a of Array.isArray(active) ? active.slice(0, 20) : []) {
      if (!a || !/^[A-Za-z0-9_-]{1,64}$/.test(String(a.id || ""))) continue;
      const key = "vendor:" + a.id;
      const r = create({
        category: "announcement", severity: a.severity === "warning" ? "warning" : "info",
        audience: "all", source: "vendor", key, title: a.title, body: a.body
      });
      /* An edit by the supplier changes the words, not whether it was read. */
      if (r.ok && r.deduped) {
        db.prepare("UPDATE notifications SET title = ?, body = ? WHERE id = ? AND source = 'vendor'")
          .run(clean(a.title, MAX_TITLE) || "Notice", clean(a.body, MAX_BODY), r.id);
      }
    }
    for (const id of Array.isArray(withdrawn) ? withdrawn.slice(0, 100) : []) {
      db.prepare("UPDATE notifications SET hidden_at = ? WHERE dedupe_key = ? AND source = 'vendor' AND hidden_at IS NULL")
        .run(Date.now(), "vendor:" + String(id));
    }
  } catch (e) {
    console.error("[notify] could not apply the supplier's notices", JSON.stringify(describeError(e)));
  }
}

module.exports = {
  CATEGORIES, ESSENTIAL, OPTIONAL, EMAILABLE, LINKS,
  create, createEverywhere, getState, setState,
  list, unreadCount, markRead, markAllRead,
  prefsOf, setPref, announce, withdraw, syncVendorAnnouncements,
  _clean: clean
};
