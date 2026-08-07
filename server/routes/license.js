const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { logAction } = require("../util");
const license = require("../license");

const router = express.Router();

function currentKey() {
  const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
  return row ? row.license_key : "";
}

/** Current subscription state — drives the banner and the renew screen. */
router.get("/", (req, res) => {
  res.json(license.state(currentKey()));
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

  const data = license.parse(key);
  if (!data) return res.status(400).json({ error: "That licence key isn't valid. Check it was copied in full." });

  db.prepare("UPDATE settings SET license_key = ? WHERE id = 1").run(key);
  logAction(req, "license.update", `${data.shop || "—"} until ${data.expires}`);
  res.json(license.state(key));
});

module.exports = router;
