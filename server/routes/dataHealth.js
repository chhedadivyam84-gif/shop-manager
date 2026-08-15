/* Read-only diagnostics. Owner-only: it exposes every line of every
   document, which is the shop's whole trading history in one response. */
const express = require("express");
const { scan } = require("../dataHealth");
const { requireRole } = require("../auth");

const router = express.Router();

router.get("/units", requireRole("owner"), (req, res) => {
  res.json(scan());
});

module.exports = router;
