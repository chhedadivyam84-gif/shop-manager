const express = require("express");
const { attachmentFilePath } = require("../attachments");

const router = express.Router();

// Auth only (no role check) — any logged-in staff can view a payment they
// can already see on a customer/supplier ledger.
router.get("/:filename", (req, res) => {
  const full = attachmentFilePath(req.params.filename);
  if (!full) return res.status(404).json({ error: "Attachment not found." });
  res.sendFile(full);
});

module.exports = router;
