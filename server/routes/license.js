const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { logAction } = require("../util");
const license = require("../license");

const router = express.Router();

function currentKey() {
  const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
  // LICENSE_KEY wins: on a host that resets the disk, the stored copy is the
  // one that goes missing, and re-entering it daily is the symptom.
  return license.resolveKey(row ? row.license_key : "");
}

/** Current subscription state — drives the banner and the renew screen. */
router.get("/", (req, res) => {
  res.json({ ...license.state(currentKey()), fromEnv: license.keyIsFromEnv() });
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
