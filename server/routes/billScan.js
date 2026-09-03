/* ============================================================
   BILL SCANNER — the API

   Two things live here: the owner's setup of the key, and the scan
   itself. The scan deliberately returns a DRAFT and writes nothing. See
   the note at the top of server/billScan.js for why that is not
   negotiable — a photograph of a handwritten bill is not a document to
   post stock from unread.
   ============================================================ */
const express = require("express");
const { requireRole } = require("../auth");
const { logAction } = require("../util");
const scan = require("../billScan");
const attachments = require("../attachments");

const router = express.Router();

/**
 * Is the feature available, and who may set it up?
 *
 * Readable by any signed-in staff member, because the purchase screen has
 * to know whether to draw the button at all — and "is it switched on" is
 * not a secret. The key itself is never returned by anything here.
 */
router.get("/status", (req, res) => {
  res.json({
    configured: scan.configured(),
    fromEnv: scan.keyFromEnv(),
    model: scan.MODEL,
    maxBytes: scan.MAX_BYTES
  });
});

/** Set the key. Owner only — it spends the shop's money on every scan. */
router.put("/key", requireRole("owner"), (req, res) => {
  const key = String(req.body && req.body.apiKey || "").trim();
  if (!key) return res.status(400).json({ error: "Paste the key first." });
  if (scan.keyFromEnv()) {
    return res.status(400).json({
      error: "The key is set on this server by whoever installed it, and that one wins. Ask them to change it."
    });
  }
  scan.saveKey(key);
  /* The key is never logged, here or anywhere. The audit trail records
     that it changed and nothing about what it changed to. */
  logAction(req, "billscan.key.saved", "");
  res.json({ ok: true, configured: scan.configured() });
});

router.delete("/key", requireRole("owner"), (req, res) => {
  scan.clearKey();
  logAction(req, "billscan.key.cleared", "");
  res.json({ ok: true, configured: scan.configured() });
});

/**
 * Read a photo of a bill and propose a purchase.
 *
 * WRITES NOTHING. No purchase, no item, no stock movement, no supplier.
 * The answer is a draft for the purchase screen to show; saving is the
 * ordinary purchase route, reached by the shop pressing Save after
 * looking at what was read.
 *
 * The photo is kept, because a bill worth scanning is a bill worth having
 * a picture of afterwards — and it is stored through the same attachment
 * path everything else uses rather than a second one invented here.
 */
router.post("/", async (req, res) => {
  const b = req.body || {};
  const mimeType = String(b.mimeType || "");
  const dataBase64 = String(b.dataBase64 || "");

  let read;
  try {
    read = await scan.readBill(dataBase64, mimeType);
  } catch (e) {
    /* A thrown status means this module decided the answer — a missing
       key, an unreadable picture. Anything else came from the network or
       the model and is reported as a bad gateway, because the shop's own
       app is fine and the outside is not. */
    const status = e.status || 502;
    return res.status(status).json({ error: e.message });
  }

  /* Saved after the read, not before: a picture that could not be read is
     not worth keeping, and a failed scan should leave nothing behind. */
  let attachment = null;
  try {
    attachment = attachments.saveAttachment({
      filename: b.filename || "bill", mimeType, dataBase64
    });
  } catch (e) { attachment = null; /* the draft matters more than the copy */ }

  logAction(req, "billscan.read",
    (read.supplierName || "unknown supplier") + " — " + (read.items || []).length + " line(s)");

  res.json({
    ...read,
    items: scan.matchToCatalogue(read.items),
    supplierMatch: scan.matchSupplier(read.supplierName),
    attachment,
    /* Said in the response, not only on the screen, so nothing that
       consumes this can present it as a finished entry. */
    basis: "Read from a photograph. Check every line before saving — nothing has been saved yet."
  });
});

module.exports = router;
