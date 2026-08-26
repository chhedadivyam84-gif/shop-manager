const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { logAction } = require("../util");
const license = require("../license");
const checkin = require("../licenseCheckin");

const router = express.Router();

function currentKey() {
  const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
  // LICENSE_KEY wins: on a host that resets the disk, the stored copy is the
  // one that goes missing, and re-entering it daily is the symptom.
  return license.resolveKey(row ? row.license_key : "");
}

/** Current subscription state — drives the banner and the renew screen. */
/** Current subscription state — drives the banner and the renew screen. */
router.get("/", (req, res) => {
  /* A copy sold under the licence server reports what the server last
     said; an older one reports what its key says. The screen does not
     need to know which — it reads `mode` if it wants to word things
     differently, and `blocked` either way. */
  if (checkin.enabled()) {
    const st = checkin.state();
    const last = checkin.lastAttempt();
    return res.json({
      ...st, mode: "server", blocked: !!st.blocked, expired: !!st.blocked,
      server: checkin.serverUrl(),
      lastAttemptAt: last.at || null,
      lastAttemptError: last.error || ""
    });
  }
  res.json({ ...license.state(currentKey()), mode: "key", fromEnv: license.keyIsFromEnv() });
});

/**
 * Enter the activation code the supplier gave them.
 *
 * Reachable while blocked, like the key route and for the same reason: a
 * copy that cannot be activated because it is not activated is a support
 * call nobody can resolve.
 *
 * Owner-only. It is a commercial matter, not routine data entry.
 */
router.post("/activate", requireRole("owner"), async (req, res) => {
  if (!checkin.enabled()) {
    return res.status(409).json({
      error: "This copy does not use activation codes."
    });
  }
  const r = await checkin.activate(String(req.body.code || ""));
  if (!r.ok) return res.status(400).json({ error: r.error });
  logAction(req, "license.activate", `${r.state.licensedTo || "—"} until ${r.state.expiresOn || "—"}`);
  res.json({ ok: true, state: r.state });
});

/**
 * Ask the licence server again, now.
 *
 * For the shopkeeper on the phone to their supplier: renewed a minute
 * ago, does not want to wait six hours for the next scheduled check.
 * Not owner-only — anybody who can see the blocked screen should be able
 * to retry it, and it grants nothing the timer would not.
 */
router.post("/recheck", async (req, res) => {
  if (!checkin.enabled()) return res.status(409).json({ error: "This copy does not use activation codes." });
  const r = await checkin.checkIn("asked by hand");
  const st = checkin.state();
  res.json({ ok: r.ok, error: r.error || "", state: st });
});

/**
 * Save a new/renewed key. Deliberately reachable even while expired (see
 * the licence gate in index.js) — otherwise renewing would be impossible.
 * Owner-only: it's a commercial decision, not routine data entry.
 *
 * A key that doesn't verify is rejected rather than stored, so a typo
 * can't silently replace a still-valid subscription with a dead one.
 */
router.post("/", requireRole("owner"), (req, res) => {
  const key = String(req.body.key || "").trim();
  if (!key) return res.status(400).json({ error: "Paste the licence key you were sent." });

  /* Refused rather than stored: with LICENSE_KEY set the environment wins, so
     storing this would look accepted and change nothing. */
  if (license.keyIsFromEnv()) {
    return res.status(409).json({
      error: "This app takes its licence key from its LICENSE_KEY setting. Update it there instead."
    });
  }

  const data = license.parse(key);
  if (!data) return res.status(400).json({ error: "That licence key isn't valid. Check it was copied in full." });

  db.prepare("UPDATE settings SET license_key = ? WHERE id = 1").run(key);
  logAction(req, "license.update", `${data.shop || "—"} until ${data.expires}`);
  res.json(license.state(key));
});

module.exports = router;
