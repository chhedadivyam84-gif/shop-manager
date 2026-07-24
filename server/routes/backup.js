const express = require("express");
const fs = require("fs");
const backup = require("../backup");
const db = require("../db");
const { logAction } = require("../util");

const router = express.Router();

/** Current backup status for the Settings screen. */
router.get("/", (req, res) => {
  res.json(backup.status());
});

/** Run a backup right now (local + cloud if configured). */
router.post("/run", async (req, res) => {
  try {
    const result = await backup.runBackup("manual");
    logAction(req, "backup.run", result.cloud.ok ? "local+cloud" : "local");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Backup failed: " + err.message });
  }
});

/**
 * Stream a fresh, consistent snapshot as a download. Named after the shop and
 * timestamped so a phone's Downloads folder stays readable. The temp file is
 * deleted once the response finishes, whether it succeeded or the client
 * aborted mid-download.
 */
router.get("/download", (req, res) => {
  let tmpPath;
  try {
    tmpPath = backup.snapshotForDownload();
  } catch (err) {
    return res.status(500).json({ error: "Couldn't prepare backup: " + err.message });
  }

  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  const slug = (settings.business_name || "shop").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "shop";
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  const fname = `${slug}-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;

  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch (_) {} };
  res.download(tmpPath, fname, err => {
    cleanup();
    if (err && !res.headersSent) res.status(500).end();
  });
  logAction(req, "backup.download", fname);
});

module.exports = router;
