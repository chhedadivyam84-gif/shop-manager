/* ============================================================
   WHICH RELEASE IS THIS, AND DID IT COME UP WHOLE?

   Small on purpose. It holds what this boot knows about itself — which
   commit it is, when it started, what it restored from — and answers two
   questions with it: is the app healthy, and did the deploy that started
   it lose anything.

   THE SECOND QUESTION IS THE REASON THIS FILE EXISTS.

   Render starts the NEW container before it stops the OLD one. Watched in
   the logs on 9 Oct 2026:

     19:11:18  new  restored shop-20261009-190315.db
     19:11:30  old  SIGTERM — taking a final backup
     19:11:33  old  final backup  shop-20261009-191130.db
     19:11:33  new  startup snapshot  shop-20261009-191130.db   <- same name

   Two things go wrong there. The new container is running on the 19:03
   data, so anything billed between 19:03 and the deploy is missing from
   the live shop. And then its own startup snapshot — of that OLDER data —
   is written under the same second-resolution name as the old container's
   final backup, so whichever lands last wins. If it is the new one, the
   only copy of those bills is overwritten.

   Fixed here in two parts:

     - after a restore, no startup snapshot. The data it would upload is,
       by construction, already in the cloud; the only thing the upload can
       do is collide with the old container's final backup.

     - a minute and a half after a restore, look in the cloud. A backup
       NEWER than the one restored can only have come from the container
       this one replaced, saving work this one does not have. That is
       reported loudly and shown in /api/health, so it is a thing an
       operator is told about rather than a thing nobody ever finds out.

   It does NOT restore again on its own. By the time the newer backup
   lands, staff may have started working on this container, and replacing
   the database under them would trade one loss for another. Deciding
   which copy wins is a person's job.
   ============================================================ */

/* The first 7 of the commit Render built from, or "local" on a machine
   that is not Render. Never shells out to git: a release identifier that
   needs a working git binary in the container is one that will say
   "unknown" on the day it matters. */
function version() {
  const sha = String(process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || "").trim();
  return sha ? sha.slice(0, 7) : "local";
}

const BOOT = {
  startedAt: new Date().toISOString(),
  version: version(),
  restore: { restored: false, from: null },
  /* Set if a newer backup turns up after the restore. null means nobody
     has looked yet OR nothing was found — `gapChecked` says which. */
  gap: null,
  gapChecked: false,
  /* True only while taking in a newer backup — /api is held off. */
  catchingUp: false,
  /* What happened about the gap: "none", "taken-in", or why not. */
  gapOutcome: null,
};

/** shop-20261009-191130.db (or --company / --registry parts) → "20261009-191130". */
function stampOf(name) {
  const m = /shop-(\d{8}-\d{6})/.exec(String(name || ""));
  return m ? m[1] : null;
}

/**
 * What to do at startup, given how the restore went.
 *
 * Pure, so the decision can be tested without timers and a cloud.
 */
function startupPlan(restore) {
  const restored = !!(restore && restore.restored);
  return {
    /* After a restore the snapshot would upload data the cloud already
       holds — and it is the write that collides. See the top of the file. */
    startupSnapshot: !restored,
    /* Long enough for the old container's SIGTERM backup (8s budget) and
       Render's handover to finish, short enough to report while somebody
       is still looking at the deploy. DEPLOY_CHECK_AFTER_MS exists so the
       handover can be tested without a ninety-second wait. */
    checkGapAfterMs: restored ? checkDelay() : 0,
  };
}

function checkDelay() {
  const v = Number(process.env.DEPLOY_CHECK_AFTER_MS);
  return Number.isFinite(v) && v > 0 ? v : 90 * 1000;
}

/**
 * Should a newer backup be taken in automatically?
 *
 * Only when doing so cannot lose anything: nothing written here since we
 * started. `changedSince` is how many rows have been written since the
 * baseline; anything above zero means work has begun on THIS container,
 * and two diverged copies of a shop's books are a person's to reconcile.
 * DEPLOY_CATCHUP=off turns it off entirely, leaving only the warning.
 */
function catchupDecision(newer, changedSince) {
  if (!newer) return { act: false, why: "none" };
  if (String(process.env.DEPLOY_CATCHUP || "").toLowerCase() === "off") {
    return { act: false, why: "automatic catch-up is switched off (DEPLOY_CATCHUP=off)" };
  }
  if (changedSince !== 0) {
    return { act: false, why: "work has already been entered on this container, so the two copies have diverged" };
  }
  return { act: true, why: "nothing has been written here, so the newer backup only adds" };
}

/**
 * Is there a backup in the cloud newer than the one this boot restored?
 *
 * Stamps sort as strings because they are fixed-width digits. Returns the
 * newest such stamp, or null.
 */
function newerThanRestored(restoredFile, cloudNames) {
  const base = stampOf(restoredFile);
  if (!base) return null;
  let newest = null;
  for (const n of cloudNames || []) {
    const s = stampOf(typeof n === "string" ? n : n && n.name);
    if (s && s > base && (!newest || s > newest)) newest = s;
  }
  return newest;
}

/**
 * The public health answer.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: no bucket, no provider, no path, no
 * error message, no environment variable — not even their names. It is
 * unauthenticated, and everything here is something a stranger may read.
 * The restore filename is a timestamp and nothing else. A failed database
 * probe says "error", not why.
 *
 * `probe` is a function that touches the database and throws if it cannot.
 */
function healthReport(probe) {
  let db = "ok";
  try { probe(); } catch (e) { db = "error"; }

  const body = {
    ok: db === "ok",
    version: BOOT.version,
    startedAt: BOOT.startedAt,
    uptimeSec: Math.round(process.uptime()),
    db,
    restoredFrom: BOOT.restore.restored ? stampOf(BOOT.restore.from) : null,
    /* The deploy-gap finding, if there is one. A stamp, nothing more. */
    newerBackupThanRunning: BOOT.gap,
    gapChecked: BOOT.gapChecked,
    /* "none", "taken-in", or a sentence saying why it was left alone. */
    gapOutcome: BOOT.gapOutcome,
  };
  return { status: body.ok ? 200 : 503, body };
}

module.exports = { BOOT, version, stampOf, startupPlan, newerThanRestored, healthReport, catchupDecision };
