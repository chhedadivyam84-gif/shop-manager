/* ============================================================
   ONE SERVER, MANY SHOPS — what a shop's owner must not reach

   On the hosted copy every shop shares one process, one data folder and
   one backup bucket. A few owner tools were written for a shop that has
   the machine to itself, and act on all of that rather than on one shop:

     - the cloud backup list and Delete — each run holds EVERY shop's
       files, so one owner could clear every shop's history
     - restore from a backup file, and sync receive — both park a file
       that replaces the DEFAULT business's database at the next restart,
       not the owner's own
     - sync push and its key — meant for a shop PC sending its books to
       its own hosted copy, which a shared server is not

   Found 20 Oct 2026. On a shared server these answer 403 with a plain
   reason; on a shop's own machine nothing changes. Running a backup and
   downloading one's own books still work everywhere — they only ever
   touch the shop that asked.
   ============================================================ */
const tenants = require("./tenants");

const REASON =
  "On the hosted service this is handled by your supplier, so that it can only ever " +
  "touch your own shop. Use Download backup to keep a copy of your books, or ask your supplier.";

function isShared() {
  try { return tenants.multiTenant(); } catch (e) { return true; }   // unsure: treat as shared
}

function notOnSharedServer(req, res, next) {
  if (!isShared()) return next();
  return res.status(403).json({ error: REASON, sharedServer: true });
}

module.exports = { notOnSharedServer, isShared, REASON };
