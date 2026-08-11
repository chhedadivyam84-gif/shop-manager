// Generic export endpoint.
//
// The print engine already has the exact rows the user is looking at, with the
// user's own column choices and With/Without Rate applied. Rather than every
// report growing its own server-side export route — which is how the Reports
// screen ended up with 23 report types and only 15 of them exporting — the
// client posts the finished grid here and gets a file back.
//
// That means a new report gets Excel and CSV for free the moment it declares
// its columns, and the download can never disagree with the screen, because
// there is no second query behind it.
const express = require("express");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

function safeName(s) {
  return String(s || "report").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

router.post("/xlsx", (req, res) => {
  const { rows, filename, sheetName } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: "Nothing to export." });
  }
  // Guard against a runaway request turning into a several-hundred-megabyte
  // buffer held in memory on a 512mb container.
  if (rows.length > 50000) {
    return res.status(413).json({ error: "Too many rows to export in one file (limit 50,000)." });
  }
  const name = safeName(filename);
  // Excel refuses a sheet name over 31 chars or containing : \ / ? * [ ]
  const sheet = String(sheetName || "Report").replace(/[:\\/?*\[\]]/g, " ").slice(0, 31) || "Report";

  let buf;
  try {
    buf = buildXlsx(rows, sheet);
  } catch (e) {
    return res.status(500).json({ error: "Could not build the file: " + e.message });
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(buf);
});

module.exports = router;
