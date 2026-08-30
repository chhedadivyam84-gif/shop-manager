/* ============================================================
   THE AUTO-SYNC TIMER

   Walks the queue on its own so a shop does not have to remember to press
   Sync now.

   THREE RULES IT KEEPS, all of them learned from what goes wrong when a
   background job talks to a single-threaded desktop program:

   NEVER TWO AT ONCE. Tally handles one request at a time; a second run
   starting while the first is mid-voucher is how a company file gets a
   half-written entry. A plain flag guards it, checked before any work.

   BACK OFF WHEN TALLY IS OFF. A shop that closes Tally at seven should not
   have this hammering a dead port every minute until morning, filling the
   log with the same timeout. Each consecutive failure widens the gap up to
   an hour; one success puts it straight back.

   IT CANNOT AFFECT BILLING. Nothing here touches an invoice, a customer or
   stock. If the whole file throws, sales carry on and the queue keeps the
   work — which is the same promise the queue makes everywhere else.
   ============================================================ */
const svc = require("./service");
const proc = require("./processor");

const EVERY = { "1m": 60e3, "5m": 300e3, "15m": 900e3 };
/* Even "immediately after saving" needs a heartbeat: a bill queued while
   Tally was off has to get a second chance without anybody pressing
   anything. A minute is often enough to feel immediate and rare enough to
   be invisible. */
const IMMEDIATE_TICK = 60e3;
const MAX_BACKOFF = 3600e3;   // an hour

let timer = null;
let running = false;          // never two runs at once
let failures = 0;             // consecutive, for the back-off
let nextAllowedAt = 0;

function interval() {
  const s = svc.settings();
  if (!s.enabled || !s.auto_sync) return 0;
  if (s.auto_mode === "manual") return 0;
  return EVERY[s.auto_mode] || IMMEDIATE_TICK;
}

async function tick() {
  if (running) return;                       // the previous run has not finished
  if (Date.now() < nextAllowedAt) return;    // still backing off

  let s;
  try { s = svc.settings(); } catch (e) { return; }
  if (!s.enabled || !s.auto_sync || s.auto_mode === "manual") return;
  if (!s.company) return;                    // nothing to sync into

  running = true;
  try {
    const r = await proc.runQueue({ limit: 50, staff: "auto-sync" });

    if (r.stoppedEarly || (r.attempted > 0 && r.ok === 0 && r.failed > 0)) {
      failures++;
      /* Doubling, capped. Two minutes, four, eight... up to an hour, so an
         overnight closure costs a handful of log lines instead of six
         hundred identical ones. */
      const wait = Math.min(MAX_BACKOFF, interval() * Math.pow(2, failures));
      nextAllowedAt = Date.now() + wait;
      if (failures === 1 || failures % 10 === 0) {
        /* Logged on the first failure and then rarely. The point of the
           log is to be readable afterwards, and a thousand copies of one
           timeout is not. */
        svc.log({ action: "send", status: "FAILED", staff: "auto-sync",
          message: "auto-sync paused for " + Math.round(wait / 60000) +
                   " min after " + failures + " failed run(s)" });
      }
    } else if (r.attempted > 0) {
      failures = 0;
      nextAllowedAt = 0;
    }
  } catch (e) {
    /* Swallowed on purpose. This runs on a timer with nobody watching, and
       an unhandled rejection here would take the whole server down —
       taking the shop's billing with it, for a sync. */
    failures++;
    nextAllowedAt = Date.now() + Math.min(MAX_BACKOFF, 60e3 * Math.pow(2, failures));
  } finally {
    running = false;
  }
}

/**
 * Start, restart or stop the timer to match the current settings.
 *
 * Called at boot and whenever the settings are saved, so turning auto-sync
 * off in the screen actually stops it rather than leaving a timer running
 * until the next restart.
 */
function reschedule() {
  if (timer) { clearInterval(timer); timer = null; }
  const ms = interval();
  if (!ms) return { running: false };
  timer = setInterval(() => { tick().catch(() => {}); }, ms);
  /* Does not hold the process open. A shop closing the app should not have
     to wait for a sync timer to decide it is finished. */
  if (timer.unref) timer.unref();
  return { running: true, everyMs: ms };
}

/** Queue-and-go, for "immediately after saving". */
function nudge() {
  const s = svc.settings();
  if (!s.enabled || !s.auto_sync || s.auto_mode !== "immediate") return;
  /* On the next turn of the event loop, so the bill's HTTP response is
     already on its way back to the till before any of this starts. */
  setImmediate(() => { tick().catch(() => {}); });
}

function status() {
  return {
    running: !!timer, busy: running, failures,
    nextAllowedAt: nextAllowedAt || null,
    everyMs: interval() || null
  };
}

module.exports = { reschedule, nudge, tick, status };
