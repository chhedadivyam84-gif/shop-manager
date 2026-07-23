const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?").all(limit);
  res.json(rows);
});

module.exports = router;
