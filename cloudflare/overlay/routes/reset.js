/* Reset — deliberately refused on this deployment.

   server/routes/reset.js clears bills and other records, taking a
   pre-reset backup to disk first (data/reset-log.txt records those). It is
   the single most destructive route in the app.

   Porting it needs its safety net ported with equal care, and a
   half-ported destructive route is the worst possible thing to get wrong:
   the damage is silent, immediate and to real books. So it refuses here
   until it has been reviewed on its own, rather than being carried across
   with the other 55 files as though it were ordinary.

   Nothing is lost by refusing — the same action is available on the shop's
   existing system, where the backup path is proven. */
const express = require("express");
const { requireRole } = require("../auth");

const router = express.Router();

router.post("/", requireRole("owner"), (req, res) => {
  res.status(501).json({
    error: "Reset is disabled on the Cloudflare deployment. It clears real records, " +
           "and its pre-reset backup path has not been ported and verified yet.",
  });
});

module.exports = router;
