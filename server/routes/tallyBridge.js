/* ============================================================
   THE TALLY BRIDGE — the two endpoints the shop's PC talks to

   Mounted OUTSIDE the ordinary Tally routes on purpose. Those are behind a
   staff session and a Staff Access permission; the bridge has neither. It
   is a program running unattended on a counter PC, so it carries a token
   of its own instead — nobody's PIN sits in a file on that machine.

   Only two routes, and neither can be persuaded to do anything else:

     GET  /poll   held open until there is XML for Tally, or a timeout
     POST /reply  what Tally said, coming back

   THE BRIDGE CANNOT ASK FOR ANYTHING. It does not name a document, a
   voucher or a sync id — it receives whatever the server decided to send
   and hands back the answer. A stolen token lets someone relay the shop's
   own vouchers to their own Tally; it does not let them read a bill, and
   it cannot make the server build a voucher it had not already decided to
   build. That is the whole reason the job carries no identifiers.
   ============================================================ */

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const bridge = require("../tally/bridge");

const router = express.Router();

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

/**
 * Constant-time comparison, so a wrong token cannot be found a character at
 * a time by watching how long the answer takes.
 */
function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * The token this installation accepts.
 *
 * BRIDGE_TOKEN WINS, AND THAT IS THE POINT. The made-in-the-app token lives
 * in tally_settings, which lives in shop.db — and on a host that hands the
 * app a fresh disk on every restart, shop.db comes back from the last cloud
 * snapshot. A token made after that snapshot is simply not in it, so the
 * shop's bridge is refused by a server that has quietly rolled back to a
 * token nobody holds. The shopkeeper sees "not recognised", makes another,
 * and the same thing happens on the next restart.
 *
 * An environment variable is not in the database and cannot roll back with
 * it. Set BRIDGE_TOKEN on the host and the pairing survives every restart,
 * redeploy and restore.
 *
 * The database token is left exactly as it was for installs that do not set
 * one — a shop running from a folder on its own PC never had this problem
 * and should not have to learn what an environment variable is.
 */
function acceptedHash() {
  const fromEnv = String(process.env.BRIDGE_TOKEN || "").trim();
  if (fromEnv) return { hash: hashToken(fromEnv), source: "env" };
  const row = db.prepare("SELECT bridge_token_hash FROM tally_settings WHERE id = 1").get();
  return { hash: (row && row.bridge_token_hash) || "", source: "db" };
}

function authed(req, res, next) {
  const { hash: stored, source } = acceptedHash();
  if (!stored) {
    return res.status(403).json({
      error: "No bridge token has been made yet. In Shop Manager open " +
             "Tally Sync > Setup and create one."
    });
  }
  const sent = String(req.get("x-bridge-token") || "").trim();
  if (!sent || !sameHash(hashToken(sent), stored)) {
    /* Which token was checked, so a mismatch is diagnosable without ever
       printing either of them. */
    return res.status(401).json({
      error: "That bridge token is not recognised.",
      checkedAgainst: source
    });
  }
  next();
}

router.use(authed);

/** Ask for work. Answers null when there is nothing, which is not an error. */
router.get("/poll", async (req, res) => {
  const job = await bridge.takeJob();
  if (!job) return res.json({ job: null, pollAgainMs: 0 });
  res.json({ job });
});

/** What Tally said. */
router.post("/reply", (req, res) => {
  const b = req.body || {};
  if (!b.jobId) return res.status(400).json({ error: "No jobId." });
  /* Shaped like connector.post's answer, because that is what the code
     waiting on the other end expects. */
  bridge.reply(String(b.jobId), {
    ok: !!b.ok,
    status: b.status,
    body: typeof b.body === "string" ? b.body : "",
    error: b.error || "",
    code: b.code || ""
  });
  res.json({ ok: true });
});

/** The bridge closing down, so the shop is told at once rather than in 90s. */
router.post("/goodbye", (req, res) => {
  bridge.goodbye();
  res.json({ ok: true });
});

module.exports = router;
module.exports.hashToken = hashToken;
