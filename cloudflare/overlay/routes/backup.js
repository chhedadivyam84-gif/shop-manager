/* Backup screen, served from R2. Same paths as server/routes/backup.js so
   the frontend needs no change; the download route is the one thing that
   cannot be honoured, because a Durable Object has no .db file to stream. */
const express = require("express");
const backup = require("../backup");
const { requireRole } = require("../auth");
const runtime = require("../_runtime");

const router = express.Router();

router.get("/", async (req, res) => {
  try { res.json(await backup.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/run", async (req, res) => {
  try { res.json(await backup.runBackup("manual")); }
  catch (err) { res.status(500).json({ error: "Backup failed: " + err.message }); }
});

router.get("/cloud", requireRole("owner"), async (req, res) => {
  try { res.json({ runs: await backup.listCloud() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/download", (req, res) => {
  res.status(501).json({
    error: "This deployment stores backups as JSON snapshots in R2, not as a .db file. " +
           "A Durable Object has no database file to download.",
  });
});

router.post("/restore", requireRole("owner"), async (req, res) => {
  const key = req.body && req.body.key;
  if (!key) return res.status(400).json({ error: "Which backup? Pass { key }." });
  try { res.json(await runtime.self().restoreFromBackup(key)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
