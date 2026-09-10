/* Printing, minus the printer.

   server/routes/print.js drives a Canon LBP2900 over USB by shelling out
   to SumatraPDF.exe. That is local hardware and can never work from
   Cloudflare — it already does not work on Render for the same reason.

   The job LIST is real, because print_jobs is an ordinary table and the
   Print Manager screen reads it. Only the act of printing is refused, and
   it says why rather than failing silently. */
const express = require("express");
const db = require("../db");

const router = express.Router();

const NO_PRINTER = {
  error: "Direct printing needs the shop's own PC — the printer is attached to it. " +
         "Use the browser's print dialog, or the app running on the shop machine.",
};

router.get("/health", (req, res) => res.json({ ok: false, printer: null, reason: NO_PRINTER.error }));
router.post("/", (req, res) => res.status(501).json(NO_PRINTER));
router.get("/purchase-order/:id", (req, res) => res.status(501).json(NO_PRINTER));

router.get("/jobs", (req, res) => {
  res.json(db.prepare("SELECT * FROM print_jobs ORDER BY id DESC LIMIT 200").all());
});
router.get("/jobs/:id", (req, res) => {
  const job = db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such print job." });
  res.json(job);
});

module.exports = router;
