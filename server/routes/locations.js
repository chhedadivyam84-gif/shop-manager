const express = require("express");
const inventory = require("../inventory");

const router = express.Router();

// Read-only for now — Shop and Warehouse are seeded by db.js. Renaming or
// adding a third location (Godown 2, a branch, ...) is a direct DB edit
// today; a management screen can be added later without touching any of
// the code that already reads this list, since nothing hardcodes location
// names or count.
router.get("/", (req, res) => {
  res.json(inventory.getLocations());
});

module.exports = router;
