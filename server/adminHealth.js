/* ============================================================
   SYSTEM HEALTH — what this box can actually prove about itself

   PART 11. Every check below reads something real. There is no check
   here that returns "Healthy" because a module exists, no percentage,
   no invented uptime figure, and no service that is reported on
   because a monitoring page looks better with more rows.

   THE RULE THAT SHAPED THIS FILE: "configured" is not "reachable", and
   the two are never printed as if they were the same thing. This app
   talks to a handful of outside services — a cloud bucket for backups,
   a licence server, an AI endpoint for reading a photo of a bill, a GST
   provider. Pinging all of them every time somebody opens a page would
   cost money, leak the fact that this shop exists to four third
   parties on a timer, and still only prove they were up a moment ago.

   So an external service reports two separate facts:

     is it set up          — read from configuration, free, certain
     when did it last work — the real result of the last real attempt

   and the screen says so in those words. A shop whose backup has not
   run for a week learns that from the second fact, which is the one
   that actually matters, and nothing is pinged to find it out.

   WHAT IS DELIBERATELY NOT CHECKED
   --------------------------------
   The printer. printing/printer.js can query the Windows print spooler,
   but it does it by spawning PowerShell with an eight-second timeout —
   far too expensive for a page that refreshes, and meaningless on the
   hosted copy, which has no printer at all. Configuration is reported;
   the live spool query stays on the print screen where somebody has
   asked a specific question and can wait for it.

   Email. There is none. This app has no mail transport, no address
   column on a staff row and no notification system, so there is no
   email service to monitor and this file does not invent one.

   WHAT NEVER CROSSES THIS BOUNDARY — see section 18 of the brief and
   the same note in routes/admin.js: no filesystem path, no bucket name,
   no hostname, no environment variable's VALUE, no credential, no
   connection string, no stack trace. Several of the modules read below
   do return those things to their own callers; this file takes the fact
   and drops the detail. test/health.test.js checks that by scanning the
   whole response for the data directory and for every secret it can get
   its hands on.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const db = require("./db");

/* ------------------------------------------------------------------
   HOW A CHECK REPORTS ITSELF

   Four states, and the fourth is the one that keeps this page honest.
   "not_configured" is not a failure and must never be coloured as one:
   a shop with no cloud bucket has not broken anything, it has simply
   not bought that. Reporting it as a fault trains people to ignore the
   page, which is how a real fault goes unnoticed.
   ------------------------------------------------------------------ */
const OK = "ok";
const WARN = "warn";
const CRITICAL = "critical";
const NOT_CONFIGURED = "not_configured";

/* Loudest first. The overall status is the worst state present among
   the checks that are allowed to set it — see snapshot(). */
const RANK = { [CRITICAL]: 3, [WARN]: 2, [OK]: 1, [NOT_CONFIGURED]: 0 };

const STATE_LABELS = {
  [OK]: "Healthy",
  [WARN]: "Needs attention",
  [CRITICAL]: "Not working",
  [NOT_CONFIGURED]: "Not set up",
};

/* ------------------------------------------------------------------
   TIMING

   process.hrtime.bigint() rather than Date.now(): these checks finish
   in single-digit milliseconds and Date.now() has nothing useful to say
   about a span that short. Rounded to a tenth of a millisecond, because
   any more precision than that is noise a reader would be invited to
   read meaning into.
   ------------------------------------------------------------------ */
function timed(fn) {
  const started = process.hrtime.bigint();
  let out;
  try {
    out = fn();
  } catch (e) {
    /* A check that throws is a failed check, never a failed page. The
       message is NOT passed through — a SQLite or fs error names a path
       on the shop's PC. The screen says it failed; the server log says
       why. */
    console.error("[health] check failed: " + e.message);
    out = { state: CRITICAL, detail: "This check could not be completed." };
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  out.ms = Math.round(ms * 10) / 10;
  return out;
}

/* How long ago, in words a person reads rather than a timestamp they
   have to subtract. */
function ago(at) {
  if (!at) return null;
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return s + " second" + (s === 1 ? "" : "s") + " ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " minute" + (m === 1 ? "" : "s") + " ago";
  const h = Math.floor(m / 60);
  if (h < 48) return h + " hour" + (h === 1 ? "" : "s") + " ago";
  const d = Math.floor(h / 24);
  return d + " day" + (d === 1 ? "" : "s") + " ago";
}

function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

/* ==================================================================
   THE CHECKS

   Each returns { state, detail, ... } and each is allowed to be slow
   exactly once — on the first call after a restart, when a module it
   reads is being required for the first time.
   ================================================================== */

/* ---- the application itself -------------------------------------- */
/* This one is close to tautological — if it can answer, it is running —
   and it is here anyway because the uptime and the version are the two
   things somebody asks for first when something is wrong. It is NEVER
   allowed to be the reason the overall status is green; see snapshot(). */
function application() {
  return {
    state: OK,
    detail: "Running",
    uptimeSeconds: Math.floor(process.uptime()),
    uptime: humanUptime(process.uptime()),
    startedAt: Date.now() - Math.floor(process.uptime() * 1000),
  };
}

function humanUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m";
  return s + "s";
}

/* ---- the shop's database ------------------------------------------ */
/* SELECT 1 and a PRAGMA. Deliberately not a COUNT of anything: the
   brief asks for a lightweight check, and counting rows to prove a
   connection works is paying for an answer nobody asked for. */
function database() {
  db.prepare("SELECT 1 AS v").get();
  const mode = safe(() =>
    (db.prepare("PRAGMA journal_mode").get() || {}).journal_mode, null);
  const fk = safe(() =>
    (db.prepare("PRAGMA foreign_keys").get() || {}).foreign_keys, null);

  /* WAL matters enough to say out loud: without it a read during
     billing can block the write that is finishing the bill. */
  const wal = String(mode || "").toLowerCase() === "wal";

  return {
    state: OK,
    detail: wal ? "Connected" : "Connected, but not in WAL mode",
    /* The journal mode is a SQLite setting, not a credential, and it is
       the one piece of database configuration worth seeing here. The
       file path is not reported, by design. */
    journalMode: mode || "unknown",
    foreignKeys: fk === 1 || fk === true,
    walEnabled: wal,
  };
}

/* ---- sessions, which is what authentication actually rests on ----- */
/* The session STORE is checked, not the login flow. Attempting a real
   sign-in to prove authentication works would mean this page holding a
   credential, which is the last thing it should do. What can be proved
   without one is that the store is readable and writable, and that is
   the part that silently broke before — an in-memory store that lost
   every session on each restart. */
function authentication() {
  const dir = db.dataDir;
  const file = path.join(dir, "sessions.db");

  if (!fs.existsSync(file)) {
    return {
      state: WARN,
      /* No path in the message. */
      detail: "No session store found — staff would be signed out on every restart.",
      live: null,
    };
  }

  const { DatabaseSync } = require("node:sqlite");
  const s = new DatabaseSync(file, { readOnly: true });
  try {
    const now = Date.now();
    const live = s.prepare(
      "SELECT COUNT(*) AS v FROM sessions WHERE expires_at > ?").get(now).v;
    const expired = s.prepare(
      "SELECT COUNT(*) AS v FROM sessions WHERE expires_at <= ?").get(now).v;

    return {
      state: OK,
      detail: "Sessions are stored on disk and survive a restart",
      /* How many people are signed in. A count, never a name, never an
         id and never a session token. */
      live,
      /* Expired rows waiting for the hourly sweep. Worth seeing only
         because a large number means the sweep has stopped. */
      awaitingCleanup: expired,
    };
  } finally {
    safe(() => s.close());
  }
}

/* ---- local storage ------------------------------------------------ */
/* Writability is tested with fs.accessSync(W_OK) rather than by writing
   a probe file. A health check that writes is a health check that can
   fill a disk, and on the hosted copy it would be writing to a
   filesystem that is wiped on every deploy anyway. */
function localStorage_() {
  const dir = db.dataDir;
  const parts = [];
  let state = OK;

  let writable = false;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    writable = true;
  } catch (e) {
    state = CRITICAL;
  }
  if (!writable) {
    return { state: CRITICAL,
             detail: "The data folder cannot be written to.",
             writable: false };
  }

  /* Backups: how many and how old the newest is. Names and paths are
     not reported — the age is the fact that matters. */
  const backupDir = path.join(dir, "backups");
  let backups = 0, newestAt = 0;
  if (fs.existsSync(backupDir)) {
    const files = safe(() => fs.readdirSync(backupDir).filter(f => f.endsWith(".db")), []);
    backups = files.length;
    for (const f of files) {
      const t = safe(() => fs.statSync(path.join(backupDir, f)).mtimeMs, 0);
      if (t > newestAt) newestAt = t;
    }
  }

  if (!backups) {
    state = WARN;
    parts.push("no local backup has been taken");
  } else {
    parts.push(backups + " local backup" + (backups === 1 ? "" : "s"));
    if (newestAt) parts.push("newest " + ago(newestAt));
  }

  const uploads = fs.existsSync(path.join(dir, "uploads"));

  return {
    state,
    detail: parts.join(", "),
    writable: true,
    backups,
    newestBackupAt: newestAt || 0,
    newestBackupAgo: ago(newestAt),
    uploadsFolder: uploads,
  };
}

/* ---- the cloud backup bucket -------------------------------------- */
/* NOT PINGED. The bucket is reported from configuration plus the result
   of the last real upload, which the backup module already records.
   Listing the bucket to prove it is reachable would be a billed request
   on every page load to answer a question the last upload already
   answered. */
function cloudBackup() {
  const backup = require("./backup");
  const cfg = safe(() => backup.cloudConfig(), { enabled: false });

  if (!cfg.enabled) {
    return {
      state: NOT_CONFIGURED,
      detail: "No cloud backup is set up. Backups are kept on this machine only.",
      configured: false,
    };
  }

  const last = safe(() => backup.status().lastRun, null);

  /* The provider's NAME — "Supabase Storage" — and never the bucket,
     which is infrastructure configuration. */
  const where = cfg.label || "a cloud bucket";

  if (!last) {
    return {
      state: WARN,
      detail: "Set up with " + where + ", but no backup has run since this copy started.",
      configured: true, provider: where,
    };
  }

  const cloudOk = !!(last.cloud && last.cloud.ok);
  return {
    state: cloudOk ? OK : WARN,
    detail: cloudOk
      ? "Last upload to " + where + " succeeded " + ago(last.at)
      : "The last upload to " + where + " did not succeed (" + ago(last.at) + ")",
    configured: true,
    provider: where,
    lastAt: last.at,
    lastAgo: ago(last.at),
    lastOk: cloudOk,
  };
}

/* ---- the audit log, which PART 10 built ---------------------------- */
/* Reachable, and how recently anything was recorded. A log that has
   stopped being written to is a fault nobody would otherwise see — the
   app carries on working perfectly while the record of what it did
   quietly stops. */
function auditLog() {
  const total = db.prepare("SELECT COUNT(*) AS v FROM audit_log").get().v;
  const newest = safe(() =>
    (db.prepare("SELECT MAX(at) AS v FROM audit_log").get() || {}).v, 0);

  /* The append-only trigger PART 10 added. Its absence is not a failure
     of this box, but it is worth knowing — it means the one
     database-level protection on the record is not in place. */
  const trigger = safe(() => !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'trigger'
      AND name = 'audit_log_is_append_only'`).get(), false);

  return {
    state: OK,
    detail: total + " event" + (total === 1 ? "" : "s") + " recorded"
          + (newest ? ", newest " + ago(newest) : ""),
    events: total,
    newestAt: newest || 0,
    newestAgo: ago(newest),
    appendOnlyEnforced: trigger,
  };
}

/* ==================================================================
   BACKGROUND JOBS

   Four timers, all of them real, all started in this process. Nothing
   here is a queue or a worker — this app has neither — and none is
   invented to fill the section out.
   ================================================================== */
function backgroundJobs() {
  const jobs = [];

  /* 1. The scheduled backup. */
  const backup = safe(() => require("./backup"), null);
  const st = backup ? safe(() => backup.status(), null) : null;
  jobs.push({
    key: "backup",
    name: "Scheduled backup",
    state: st ? (st.lastRun ? OK : WARN) : WARN,
    detail: st
      ? (st.lastRun
          ? "Last ran " + ago(st.lastRun.at) + " (" + st.lastRun.trigger + ")"
          : "Has not run since this copy started")
      : "Not available",
    lastAt: st && st.lastRun ? st.lastRun.at : 0,
  });

  /* 2. The licence check-in — only on a copy that is licensed at all.
        Reported from its last attempt; the licence server is not
        contacted to draw this page. */
  const lic = safe(() => require("./licenseCheckin"), null);
  if (lic && safe(() => lic.enabled(), false)) {
    const attempt = safe(() => lic.lastAttempt(), { at: 0, error: null });
    jobs.push({
      key: "licence",
      name: "Licence check-in",
      state: attempt.error ? WARN : (attempt.at ? OK : WARN),
      detail: attempt.at
        ? (attempt.error
            ? "Last attempt " + ago(attempt.at) + " did not succeed"
            : "Last checked in " + ago(attempt.at))
        : "Has not checked in since this copy started",
      lastAt: attempt.at || 0,
    });
  } else {
    jobs.push({
      key: "licence",
      name: "Licence check-in",
      state: NOT_CONFIGURED,
      detail: "This copy is not licence-enforced.",
      lastAt: 0,
    });
  }

  /* 3. The hourly session sweep. Its effect is observable — expired
        rows left in the store — so that is what is reported rather
        than the existence of a timer. */
  const auth = safe(() => authentication(), null);
  jobs.push({
    key: "sessions",
    name: "Session cleanup",
    state: auth && auth.awaitingCleanup > 500 ? WARN : OK,
    detail: auth && auth.awaitingCleanup !== null
      ? (auth.awaitingCleanup
          ? auth.awaitingCleanup + " expired session(s) waiting for the next hourly sweep"
          : "Nothing waiting to be cleared")
      : "Not available",
    lastAt: 0,
  });

  /* 4. Tally auto-sync. Mounted only on the vendor's own copy — see the
        note on the mount in index.js — so it is reported only when the
        module is actually present rather than as a permanently
        "not configured" row on every shop's screen. */
  const autosync = safe(() => require("./tally/autosync"), null);
  if (autosync) {
    const s = safe(() => autosync.status(), null);
    if (s && s.running) {
      jobs.push({
        key: "tally",
        name: "Tally auto-sync",
        state: s.failures > 0 ? WARN : OK,
        detail: s.failures > 0
          ? s.failures + " recent failure(s)"
          : (s.busy ? "Running now" : "Scheduled"),
        lastAt: 0,
      });
    }
  }

  const worst = jobs.reduce((w, j) => (RANK[j.state] > RANK[w] ? j.state : w), OK);

  /* THE SUMMARY NAMES THE PROBLEM, not the group.
     This first read "3 background jobs", which is a count rather than a
     diagnosis — and that string is what the alerts section at the top
     of the page shows, so a shopkeeper was being told something was
     wrong and then handed a number instead of a reason. When something
     is unhappy the summary says which job and what it said. */
  const unhappy = jobs.filter(j => j.state === WARN || j.state === CRITICAL);

  return {
    state: worst,
    detail: unhappy.length
      ? unhappy.map(j => j.name + ": " + lowerFirst(j.detail)).join(" · ")
      : jobs.length + " background job" + (jobs.length === 1 ? "" : "s") + ", all running",
    jobs,
  };
}

/* "Has not run since this copy started" reads wrong after a colon. */
function lowerFirst(s) {
  const t = String(s || "");
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/* ==================================================================
   OUTSIDE SERVICES

   Configuration only. None of these is called to draw this page, and
   the brief says so explicitly — "Do NOT make unnecessary API calls
   just for monitoring". Each row says whether it is set up, and where a
   real result exists it says when that was.
   ================================================================== */
function integrations() {
  const rows = [];

  /* Reading a photo of a bill. Configured or not — the key is never
     read out, only its presence. */
  const scan = safe(() => require("./billScan"), null);
  rows.push({
    key: "billScan",
    name: "Bill scanning",
    state: scan && safe(() => scan.configured(), false) ? OK : NOT_CONFIGURED,
    detail: scan && safe(() => scan.configured(), false)
      ? "Set up. Not contacted to draw this page."
      : "Not set up. Purchases are entered by hand.",
  });

  /* The GST / e-way bill provider. "mock" is this app's own stand-in
     and is reported as what it is rather than as a working provider,
     because a shop seeing a green tick beside a mock would believe its
     e-way bills were going somewhere. */
  const ewbCfg = safe(() => require("./ewb/config"), null);
  if (ewbCfg) {
    const provider = safe(() => ewbCfg.provider(), "mock");
    const env = safe(() => ewbCfg.environment(), "sandbox");
    const isMock = provider === "mock";
    rows.push({
      key: "gst",
      name: "E-way bill provider",
      state: isMock ? NOT_CONFIGURED : OK,
      detail: isMock
        ? "No real provider is set up — e-way bills are simulated."
        : "Set up (" + env + "). Not contacted to draw this page.",
    });
  }

  /* The printer. Configuration only, deliberately — see the note at the
     top of this file on why the spooler is not queried here. */
  const printer = safe(() => require("./printing/printer"), null);
  if (printer) {
    const named = !!printer.PRINTER_NAME;
    rows.push({
      key: "printer",
      name: "Printer",
      state: named ? OK : NOT_CONFIGURED,
      /* The printer's NAME is configuration a shopkeeper typed and is
         shown on the print screen, but it is not infrastructure this
         page needs to repeat. */
      detail: named
        ? "A printer is configured. Its live status is on the print screen."
        : "No printer configured on this copy. Documents download as PDF.",
    });
  }

  const worst = rows.reduce((w, r) => (RANK[r.state] > RANK[w] ? r.state : w), NOT_CONFIGURED);
  return {
    state: worst === NOT_CONFIGURED ? NOT_CONFIGURED : OK,
    detail: rows.filter(r => r.state === OK).length + " of " + rows.length + " set up",
    rows,
  };
}

/* ==================================================================
   VERSION

   The brief allows "if already available" and asks for a simple safe
   mechanism otherwise. What is already available:

     package.json version   static, and honest about being static
     process start time     which IS the deployment timestamp on the
                            hosted copy, because a deploy restarts it
     the host's commit id   Render sets RENDER_GIT_COMMIT itself

   ONE named environment variable is read, for the one purpose section
   10 asks for, and only its first seven characters are shown. The page
   never enumerates the environment and never prints any other value
   from it — see section 18 and the test that enforces it.
   ================================================================== */
function version() {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  } catch (e) { pkg = {}; }

  const commit = String(process.env.RENDER_GIT_COMMIT || "").trim();
  const startedAt = Date.now() - Math.floor(process.uptime() * 1000);

  return {
    app: pkg.version || "unknown",
    /* Short form. A full SHA is no more useful here and a short one is
       what anybody would paste into a search. */
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : null,
    node: process.version,
    startedAt,
    startedAgo: ago(startedAt),
  };
}

/* ==================================================================
   THE CHECK TABLE

   One place that says what a check is called, which group it sits in,
   whether it may set the overall status, and how to run it. The route
   walks this; it does not hold a list of its own — the same shape the
   dashboard's section table uses.

   `critical: true` means a failure here makes the whole system
   Critical. Three checks have it, and the application row deliberately
   does not: it cannot fail without the page failing with it, so letting
   it vote would mean the overall status was partly decided by a check
   that is always green.
   ================================================================== */
const CHECKS = {
  application: { name: "Application", group: "Core",       critical: false, run: application },
  database:    { name: "Database",    group: "Core",       critical: true,  run: database },
  auth:        { name: "Sessions",    group: "Core",       critical: true,  run: authentication },
  storage:     { name: "Local storage", group: "Storage",  critical: true,  run: localStorage_ },
  cloud:       { name: "Cloud backup", group: "Storage",   critical: false, run: cloudBackup },
  audit:       { name: "Audit log",   group: "Records",    critical: false, run: auditLog },
  jobs:        { name: "Background jobs", group: "Jobs",   critical: false, run: backgroundJobs },
  integrations:{ name: "Outside services", group: "Services", critical: false, run: integrations },
};

const GROUPS = ["Core", "Storage", "Records", "Jobs", "Services"];

/* The last snapshot this process took, held in memory only.
 *
 * NOT A MONITORING DATABASE, which the brief rules out in as many
 * words. It lets the page say "last checked 40 seconds ago" without
 * writing a row, and it is gone on restart, which is correct — a health
 * reading from before a restart describes a process that no longer
 * exists. The durable history is the audit log: a MANUAL health check
 * is recorded there by routes/admin.js, and automatic refreshes are
 * not, so opening this page cannot flood the shop's audit trail. */
let lastSnapshot = null;

/**
 * Run every check and assemble the page.
 *
 * Each check is isolated: one that throws is reported as a failed check
 * and the rest still render, the same contract the dashboard's eight
 * sections have. A health page that goes blank when one service is down
 * is a health page that is useless exactly when it is needed.
 */
function snapshot() {
  const started = process.hrtime.bigint();
  const at = Date.now();
  const results = {};

  for (const key of Object.keys(CHECKS)) {
    const def = CHECKS[key];
    const out = timed(def.run);
    results[key] = Object.assign({
      key,
      name: def.name,
      group: def.group,
      critical: def.critical,
      label: STATE_LABELS[out.state] || out.state,
    }, out);
  }

  /* THE OVERALL STATUS, from the checks that are allowed to vote.
     No percentage: section 3 forbids inventing one, and there is no
     real calculation behind "97% healthy" that would mean anything to
     a shopkeeper. */
  let overall = OK;
  const problems = [];

  for (const key of Object.keys(results)) {
    const r = results[key];
    if (r.state === NOT_CONFIGURED) continue;        // never a fault
    if (r.state === OK) continue;

    /* A non-critical check that is unhappy can raise a Warning but
       never a Critical — a cloud bucket that did not upload is a
       problem, not an outage. */
    const effective = r.critical ? r.state : (r.state === CRITICAL ? WARN : r.state);
    if (RANK[effective] > RANK[overall]) overall = effective;

    problems.push({
      key, name: r.name, state: effective,
      label: STATE_LABELS[effective],
      detail: r.detail,
    });
  }

  /* Loudest first, so the thing to deal with is at the top. */
  problems.sort((a, b) => RANK[b.state] - RANK[a.state]);

  const totalMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6 * 10) / 10;

  lastSnapshot = {
    at,
    ago: null,              // filled in on the way out, see describe()
    overall,
    overallLabel: STATE_LABELS[overall],
    tookMs: totalMs,
    problems,
    checks: results,
    groups: GROUPS.filter(g => Object.keys(results).some(k => results[k].group === g)),
    version: version(),
  };
  return describe(lastSnapshot);
}

/** The last reading this process took, or null if it has taken none. */
function last() {
  return lastSnapshot ? describe(lastSnapshot) : null;
}

/* `ago` is computed on the way out rather than stored, so a snapshot
   held for thirty seconds does not keep claiming it was taken "just
   now". */
function describe(s) {
  return Object.assign({}, s, { ago: ago(s.at) });
}

/** One service, for the detail view. */
function one(key) {
  if (!Object.prototype.hasOwnProperty.call(CHECKS, key)) return null;
  const def = CHECKS[key];
  const out = timed(def.run);
  return Object.assign({
    key, name: def.name, group: def.group, critical: def.critical,
    label: STATE_LABELS[out.state] || out.state,
    at: Date.now(),
  }, out);
}

module.exports = {
  snapshot, last, one, version,
  CHECKS, GROUPS, STATE_LABELS,
  OK, WARN, CRITICAL, NOT_CONFIGURED, RANK,
  /* Exported for the dashboard, so its System panel and this page
     cannot drift into describing the same box differently. */
  database, authentication, application,
};
