/* ============================================================
   THE TALLY BRIDGE — reaching a shop's Tally from a hosted app

   A shop that bills on a hosted copy has its data in a data centre and its
   Tally on a PC behind a shop router. The data centre cannot dial in: the
   PC has no public address, and giving it one is not an option worth
   considering — Tally's XML port has NO password of any kind, so anything
   that can reach it can read every voucher and write new ones.

   So the shop's PC does the dialling. A small program on the counter
   machine holds a request open against the server and waits. When the
   server has XML for Tally it answers that request; the bridge posts the
   XML to Tally on localhost, and sends the reply back. Every connection is
   OUTBOUND from the shop. Nothing is exposed, no router is touched.

   WHY LONG-POLLING RATHER THAN A WEBSOCKET. The same shape either way, and
   this app's dependencies are deliberately three. A websocket server would
   be a fourth, in a program a shop bills on, to do what an open GET already
   does.

   WHY THIS IS ONLY IN MEMORY. A job is worth nothing once its moment has
   passed: the queue row is the durable record and is already on disk. If
   the server restarts mid-flight the job is lost, the queue row stays
   PENDING, and the next run sends it again — which is exactly what happens
   today when Tally is closed.
   ============================================================ */

const crypto = require("crypto");

/* Jobs waiting for a bridge to collect, oldest first. */
const waiting = [];

/* Jobs a bridge has collected and not yet answered, by id. */
const inFlight = new Map();

/* A bridge sitting on an open poll, waiting to be given something. */
let parked = null;

/* When a bridge was last heard from. The dashboard says "connected" from
   this rather than from a flag, so a bridge that dies without saying
   goodbye stops counting as present on its own. */
let lastSeenAt = 0;

/* A bridge that polled within this long is treated as present. Generous
   next to the poll timeout below: one missed poll on a slow line should
   not read as a disconnection. */
const PRESENT_MS = 90 * 1000;

/* How long a poll is held open before answering "nothing yet". Under the
   60s that hosts and proxies tend to cut an idle response at. */
const POLL_MS = 25 * 1000;

/* How long a job waits for a bridge to take it AND answer. Past this the
   caller is told the bridge did not respond, and the queue row stays
   PENDING to be tried again — the same outcome as Tally being closed. */
const JOB_MS = 60 * 1000;

function connected() {
  return Date.now() - lastSeenAt < PRESENT_MS;
}

function status() {
  return {
    connected: connected(),
    lastSeenAt: lastSeenAt || null,
    waiting: waiting.length,
    inFlight: inFlight.size
  };
}

/**
 * Send XML to the shop's Tally and wait for what Tally said.
 *
 * Shaped exactly like connector.post's resolved value, so the caller cannot
 * tell whether it went straight down a socket or around through a shop in
 * another city.
 */
function ask(xml) {
  return new Promise((resolve) => {
    if (!connected()) {
      return resolve({
        ok: false, code: "NO_BRIDGE",
        error: "The Tally Bridge is not running on the shop's computer. " +
               "Start it there, and leave it running while Tally is open."
      });
    }

    const job = { id: crypto.randomUUID(), xml, resolve, at: Date.now() };

    /* Never leave a caller waiting forever on a bridge that took the job
       and then died. */
    job.timer = setTimeout(() => {
      const i = waiting.indexOf(job);
      if (i >= 0) waiting.splice(i, 1);
      inFlight.delete(job.id);
      resolve({
        ok: false, code: "BRIDGE_TIMEOUT",
        error: "The Tally Bridge did not answer in time. It may have stopped, " +
               "or Tally may be busy on a dialog."
      });
    }, JOB_MS);

    waiting.push(job);
    handOut();
  });
}

/** Give the parked bridge the next job, if both exist. */
function handOut() {
  if (!parked || !waiting.length) return;
  const job = waiting.shift();
  const send = parked;
  parked = null;
  inFlight.set(job.id, job);
  send({ jobId: job.id, xml: job.xml });
}

/**
 * A bridge asking for work. Answers immediately if something is waiting,
 * otherwise holds the request open until a job arrives or the poll times
 * out — an empty answer is not a failure, it is "nothing to do, ask again".
 */
function takeJob() {
  lastSeenAt = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const answer = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (parked === answer) parked = null;
      resolve(payload);
    };
    const timer = setTimeout(() => answer(null), POLL_MS);

    /* Only one bridge is expected. If a second appears — an old copy still
       running somewhere — the newer poll takes over rather than both
       hanging, so a forgotten window cannot silently swallow every job. */
    if (parked) parked(null);
    parked = answer;
    handOut();
  });
}

/**
 * What Tally said, coming back from the bridge.
 *
 * An unknown job id is ignored rather than treated as an error: it means
 * the job already timed out, and the caller has been answered.
 */
function reply(jobId, result) {
  lastSeenAt = Date.now();
  const job = inFlight.get(jobId);
  if (!job) return false;
  inFlight.delete(jobId);
  clearTimeout(job.timer);
  job.resolve(result);
  return true;
}

/** A bridge shutting down cleanly, so the dashboard stops saying connected. */
function goodbye() {
  lastSeenAt = 0;
  if (parked) { parked(null); parked = null; }
}

module.exports = { ask, takeJob, reply, status, connected, goodbye, POLL_MS };
