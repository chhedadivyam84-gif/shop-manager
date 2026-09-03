/* ============================================================
   CHECKING IN WITH THE LICENCE SERVER

   A buyer copy holds an ACTIVATION CODE, which grants nothing on its own.
   Every few hours it asks the vendor's server what that code is worth
   today, and caches the signed answer. The vendor cancels somebody in
   their panel; this copy finds out at its next check-in.

   THE RULE THIS FILE EXISTS TO KEEP

   Not being able to reach the licence server is NEVER treated as being
   refused by it. The vendor's server sleeping, their database lost, the
   shop's line down at 9am — none of those may stop a shop billing. The
   last signed answer is trusted for its grace period, and only when that
   runs out does the app go read-only, saying plainly that it could not
   reach the licence server rather than implying the shop did something
   wrong.

   Grace covers NOT KNOWING. It does not cover knowing something bad: a
   verdict that says cancelled is acted on at once, because there is
   nothing uncertain about it.

   WHAT STOPS A CUSTOMER CHEATING

   The verdict is signed with the vendor key and verified here with the
   public key this copy was built with, so:

     - pointing the app at a server of their own gets an unsigned answer,
       which is refused;
     - replaying an old "active" for ever fails, because the signature
       covers a timestamp and this file will not trust one past its grace;
     - using another shop's verdict fails, because the signature covers
       the activation code.

   It is a business control, not DRM. Somebody with the source can patch
   it out. It stops the ordinary case: not paying and carrying on.

   DORMANT IN THE SHOP'S OWN COPY. license.js ships with an empty public
   key, and everything here is switched off without one — the shop that
   built this must never be locked out of its own books by a mechanism
   meant for buyers.
   ============================================================ */
const crypto = require("crypto");
const db = require("./db");
const license = require("./license");

/* Where to ask. Set on the host when a copy is sold; absent in the shop's
   own copy, which is what keeps this dormant there. */
const SERVER_URL = String(process.env.LICENCE_SERVER || "").trim().replace(/\/+$/, "");

/* Six hours. Often enough that a cancellation lands the same day, rare
   enough that a hundred shops are not a load worth thinking about. */
const EVERY_MS = 6 * 3600 * 1000;

/* FORTY-FIVE SECONDS, AND THE OLD FIFTEEN WAS THE DEMO BUG.
   ----------------------------------------------------------------------
   The licence server sleeps when nobody has used it for a quarter of an
   hour, and the first request afterwards has to wait for it to start.
   Measured, not guessed: after a 26-minute idle window the first response
   took 13.3 seconds, and the server's own start time was stamped ten
   seconds AFTER the request went out — so that request was what woke it.

   Against a fifteen-second limit that leaves 1.7 seconds of headroom, so
   a check-in succeeded on a good day and failed on a slow one. Which is
   exactly how it behaved: intermittent, worst on a copy being used for
   the first time, and fine when tried again a minute later.

   Worse, the margin was shrinking. The panel restores its whole database
   from cloud storage before it answers, so every customer sold makes that
   boot slower.

   Forty-five seconds is roughly three times the measured cold start.
   Nothing waits on this — the boot check is deliberately not awaited and
   the timer runs in the background — so a long timeout costs a shop
   nothing at all. A shop that is offline still gets its answer from the
   cache and its grace days, exactly as before. */
const REQUEST_TIMEOUT_MS = 45000;

/* One retry, because the first request is the one that pays for the
   wake-up and the second arrives at a server already running. Retrying is
   only right for a TIMEOUT: an answer of "no such code" is an answer, and
   asking again would just be asking a question that has been answered. */
const RETRY_DELAY_MS = 2000;
const DEFAULT_GRACE_DAYS = 14;

function enabled() {
  return license.enabled() && SERVER_URL.length > 0;
}

/* ---- what this copy remembers ----------------------------------------- */

function settings() {
  try { return db.prepare("SELECT * FROM settings WHERE id = 1").get() || {}; }
  catch (e) { return {}; }
}

/** A stable id for this installation, made once and kept. */
function installId() {
  const s = settings();
  if (s.install_id) return s.install_id;
  const id = crypto.randomBytes(12).toString("hex");
  try { db.prepare("UPDATE settings SET install_id = ? WHERE id = 1").run(id); } catch (e) {}
  return id;
}

/** The code the shopkeeper typed in. The environment wins, for the same
 *  reason it does for the old key: a host that wipes its disk would
 *  otherwise ask for it again after every restart. */
function activationCode() {
  const fromEnv = String(process.env.ACTIVATION_CODE || "").trim();
  if (fromEnv) return normalise(fromEnv);
  return normalise(settings().activation_code || "");
}

const normalise = v => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ---- reading a verdict ------------------------------------------------- */

const b64urlToBuf = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verify a signed verdict and return its contents, or null.
 *
 * Null for anything at all wrong — bad signature, wrong shape, or issued
 * for a different code than this copy holds. A verdict that cannot be
 * fully trusted is treated as no verdict, never as a partial one.
 */
function openVerdict(signed, expectCode) {
  if (!signed || typeof signed !== "string" || !signed.includes(".")) return null;
  const [p, s] = signed.trim().split(".");
  if (!p || !s) return null;
  try {
    const payload = b64urlToBuf(p);
    if (!crypto.verify(null, payload, license.publicKey(), b64urlToBuf(s))) return null;
    const data = JSON.parse(payload.toString("utf8"));
    if (!data || typeof data.status !== "string" || !data.at) return null;
    /* Issued for somebody else. Refusing this is what stops one shop's
       answer being copied into another's database. */
    if (expectCode && normalise(data.code) !== normalise(expectCode)) return null;
    return data;
  } catch (e) { return null; }
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysSince = ms => Math.floor((Date.now() - ms) / 86400000);

/* ---- the state the rest of the app asks about -------------------------- */

/**
 * What this copy is entitled to right now.
 *
 * `blocked` is the only field the subscription gate needs; the rest is for
 * telling the shopkeeper something true about why.
 */
function state() {
  if (!enabled()) {
    return { enforced: false, status: "unlicensed-build", blocked: false, companyLimit: null };
  }

  const code = activationCode();
  if (!code) {
    return {
      enforced: true, status: "needs-activation", blocked: true, companyLimit: 1,
      message: "Enter the activation code from your supplier to start using this copy."
    };
  }

  const s = settings();
  const v = openVerdict(s.last_verdict, code);

  if (!v) {
    /* Never checked in, or the stored answer is not for this code — which
       is what happens the moment a new code is entered. Not an accusation:
       the copy simply has not been told anything yet. */
    return {
      enforced: true, status: "not-checked-in", blocked: true, companyLimit: 1,
      code,
      message: "This copy has not been able to confirm its subscription yet. It will keep trying — check the internet connection."
    };
  }

  const ageDays = daysSince(Date.parse(v.at));
  const grace = Number(v.graceDays) || DEFAULT_GRACE_DAYS;
  const companyLimit = v.companies === "unlimited" ? null : (Number(v.companies) || 1);

  /* Known bad. Grace covers not knowing, not knowing something bad, so
     these are acted on the moment they arrive and stay acted on. */
  /* Somebody has installed this copy a second time on one subscription.

     Known bad, so no grace: the server has told us plainly, and the shop
     it refuses is the NEW installation — the original keeps working, which
     is why the server decides this rather than the copy. */
  if (v.status === "too-many-installs") {
    return { enforced: true, status: "too-many-installs", blocked: true, companyLimit, code,
             message: v.message || "This subscription is already in use on another installation. Contact your supplier." };
  }

  if (v.status === "cancelled") {
    return { enforced: true, status: "cancelled", blocked: true, companyLimit, code,
             message: v.message || "This subscription has been cancelled. Please contact your supplier." };
  }
  /* Never approved. Blocked, and correctly so — this copy has no history
     of ever having worked. */
  if (v.status === "pending") {
    return { enforced: true, status: "not-approved", blocked: true, companyLimit, code,
             message: v.message || "This copy has not been approved yet. Please contact your supplier." };
  }

  /* The licence server does not recognise this code.

     Two very different things look identical from here: a code that is
     genuinely wrong, and a code the server has FORGOTTEN because it lost
     its own database — which on a host with no persistent disk happens
     on every redeploy.

     The vendor panel has no delete, so a code that was active yesterday
     cannot legitimately stop existing today. When this copy holds proof
     that its code was good recently, that proof outweighs a bare 'not
     recognised', and the grace period runs instead of an immediate stop.

     The asymmetry is deliberate. A shop wrongly cut off because its
     supplier's hosting had a bad night is a catastrophe; a shop granted
     an extra fortnight after a code was reissued is a phone call. */
  if (v.status === "unknown") {
    const good = openVerdict(s.last_good_verdict, code);
    const goodAge = s.last_good_at ? daysSince(s.last_good_at) : null;
    if (good && goodAge !== null && goodAge <= (Number(good.graceDays) || DEFAULT_GRACE_DAYS)) {
      return {
        enforced: true, status: "vendor-unreachable", blocked: false,
        companyLimit: good.companies === "unlimited" ? null : (Number(good.companies) || 1),
        code, expiresOn: good.expires || "", lastConfirmedDaysAgo: goodAge,
        graceDays: Number(good.graceDays) || DEFAULT_GRACE_DAYS,
        message: "Your supplier's licence server did not recognise this copy. It is still working — please tell them, so it can be sorted out."
      };
    }
    return { enforced: true, status: "not-approved", blocked: true, companyLimit, code,
             message: v.message || "This activation code is not recognised. Please contact your supplier." };
  }

  /* The end date is checked here as well as on the server. A copy that
     goes offline a week before its subscription ends would otherwise ride
     its grace period straight past the date it was paid up to. */
  if (v.expires && v.expires < todayStr()) {
    return { enforced: true, status: "expired", blocked: true, companyLimit, code,
             expiresOn: v.expires,
             message: `Subscription ended on ${v.expires}. Please contact your supplier to renew.` };
  }
  if (v.status === "expired") {
    return { enforced: true, status: "expired", blocked: true, companyLimit, code,
             expiresOn: v.expires, message: v.message || "Subscription has ended." };
  }

  /* Active, and the question is only how long ago we were told so. */
  if (ageDays > grace) {
    return {
      enforced: true, status: "lapsed", blocked: true, companyLimit, code,
      expiresOn: v.expires, lastConfirmedDaysAgo: ageDays,
      message: `This copy has not been able to reach the licence server for ${ageDays} days. ` +
               `Check the internet connection — your records are all still here and can be printed and backed up.`
    };
  }

  const daysLeft = v.expires
    ? Math.round((Date.parse(v.expires + "T00:00:00Z") - Date.parse(todayStr() + "T00:00:00Z")) / 86400000)
    : null;

  return {
    enforced: true,
    status: ageDays >= 1 ? "active-cached" : "active",
    blocked: false,
    companyLimit, code,
    expiresOn: v.expires || "",
    daysLeft,
    licensedTo: v.shop || "",
    lastConfirmedDaysAgo: ageDays,
    graceDays: grace,
    message: v.message || "Subscription active."
  };
}

/* ---- talking to the server -------------------------------------------- */

let lastAttemptAt = 0;
let lastError = "";

/**
 * One check-in. Never throws, never blocks anything on failure.
 *
 * A failed check-in leaves the cached verdict exactly as it was, which is
 * the whole point: the shop carries on with what it last knew.
 */
async function checkIn(reason) {
  if (!enabled()) return { ok: false, skipped: "not a licensed build" };
  const code = activationCode();
  if (!code) return { ok: false, skipped: "no activation code yet" };

  lastAttemptAt = Date.now();
  try {
    /* Asked at most twice. The first request is the one that pays for
       waking a sleeping server; a second one two seconds later arrives at
       a server that is already running. Only a TIMEOUT is retried — a
       refusal is an answer, and asking again would not change it. */
    const ask = () => fetch(`${SERVER_URL}/api/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        installId: installId(),
        version: require("../package.json").version || ""
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    let res;
    try {
      res = await ask();
    } catch (first) {
      if (first && (first.name === "TimeoutError" || first.name === "AbortError")) {
        console.warn(`[licence] no answer in ${REQUEST_TIMEOUT_MS / 1000}s (${reason}); asking once more`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        res = await ask();
      } else {
        throw first;
      }
    }
    if (!res.ok) throw new Error(`licence server answered ${res.status}`);

    const body = await res.json();
    const v = openVerdict(body && body.verdict, code);
    if (!v) throw new Error("the answer was not signed by the vendor");

    db.prepare("UPDATE settings SET last_verdict = ?, last_verdict_at = ? WHERE id = 1")
      .run(String(body.verdict), Date.now());

    /* Kept separately, and only when it was good. This is the copy's
       evidence that its code was real — evidence it needs if the
       licence server later fails to recognise it. */
    if (v.status === "active") {
      db.prepare("UPDATE settings SET last_good_verdict = ?, last_good_at = ? WHERE id = 1")
        .run(String(body.verdict), Date.now());
    }
    lastError = "";
    console.log(`[licence] checked in (${reason}): ${v.status}${v.expires ? ", until " + v.expires : ""}`);
    return { ok: true, status: v.status };
  } catch (e) {
    lastError = e.message;
    /* Logged, not raised. The caller is a timer or a boot sequence and
       there is nothing useful for either to do about it. */
    console.warn(`[licence] could not check in (${reason}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Boot check plus a timer. Started from index.js, safe to call when off. */
function start() {
  if (!enabled()) return;
  /* Not awaited: a licence server that is slow to wake must not hold up a
     shop opening its own app. Whatever is cached applies until it answers. */
  checkIn("startup");
  const t = setInterval(() => checkIn("scheduled"), EVERY_MS);
  if (t.unref) t.unref();
}

/** Save a code the shopkeeper has just typed, and try it at once. */
async function activate(rawCode) {
  const code = normalise(rawCode);
  if (code.length < 8) return { ok: false, error: "That code looks too short. Check it with your supplier." };

  /* The old verdict is cleared, not kept. It was issued for a different
     code and openVerdict would refuse it anyway — but leaving it there
     would mean a wrong code silently inherited the last one's access. */
  db.prepare("UPDATE settings SET activation_code = ?, last_verdict = NULL, last_verdict_at = NULL WHERE id = 1")
    .run(code);

  const r = await checkIn("activation");
  if (!r.ok) {
    return { ok: false, error: "Saved, but the licence server could not be reached. It will keep trying." };
  }
  const st = state();
  if (st.blocked) return { ok: false, error: st.message };
  return { ok: true, state: st };
}

module.exports = {
  enabled, state, checkIn, start, activate, activationCode, installId,
  serverUrl: () => SERVER_URL,
  lastAttempt: () => ({ at: lastAttemptAt, error: lastError })
};
