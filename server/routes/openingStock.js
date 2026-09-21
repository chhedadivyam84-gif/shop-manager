/* ============================================================
   OPENING STOCK — the count you start from

   A shop arriving with three years of bills has no history of what was on
   the racks on any given day, and cannot reconstruct one: the bills say
   what left, not what was there. So the honest starting point is not a
   calculation, it is a count — somebody walks the godown today and writes
   down what is on it.

   THIS IS THE ONLY PLACE HISTORICAL IMPORT IS ALLOWED NEAR STOCK, and it
   is not really the import at all: it is a person entering a figure they
   measured. Imported bills never reach here. That separation is the whole
   answer to "my historical purchases must not double-count", because a
   historical purchase has no path to a quantity at all.

   IT SETS, IT DOES NOT ADD. Adding would be a trap: run it twice and the
   racks double. Setting an absolute figure is idempotent — the second run
   of the same count leaves the same number, which is the behaviour a
   nervous operator deserves.

   NOTHING IS OVERWRITTEN SILENTLY. A size that already carries stock is
   reported back and left alone unless the owner says otherwise in the same
   breath, and every change writes a stock_ledger row saying where the
   figure came from. The ledger is how a shop later answers "who set this
   to 40, and when".
   ============================================================ */
const express = require("express");
const db = require("../db");
const { logAction } = require("../util");
const { requireRole } = require("../auth");
const inventory = require("../inventory");
const stockLedger = require("../stockLedger");

const router = express.Router();
router.use(requireRole("owner"));

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * What a count would be entered against: every size, with where it stands
 * now, so the screen can show "currently 4" beside the box being typed in.
 */
router.get("/sheet", (req, res) => {
  const locationId = String(req.query.location || "").trim() || null;
  const loc = locationId
    ? inventory.getLocationById(locationId)
    : inventory.getLocationByCode("shop") || inventory.getLocations()[0];
  if (!loc) return res.status(400).json({ error: "This shop has no stock location set up yet." });

  const q = String(req.query.q || "").trim().toLowerCase();
  const rows = db.prepare(`
    SELECT ps.id AS size_id, ps.product_id, ps.label AS size_label,
           p.name AS product_name, p.brand,
           COALESCE(sls.quantity, 0) AS quantity
      FROM product_sizes ps
      JOIN products p ON p.id = ps.product_id
      LEFT JOIN size_location_stock sls
             ON sls.size_id = ps.id AND sls.location_id = ?
     ORDER BY p.name COLLATE NOCASE, ps.label COLLATE NOCASE
  `).all(loc.id);

  const filtered = q
    ? rows.filter(r => `${r.product_name} ${r.brand || ""} ${r.size_label}`.toLowerCase().includes(q))
    : rows;

  res.json({
    location: { id: loc.id, name: loc.name, code: loc.code },
    locations: inventory.getLocations().map(l => ({ id: l.id, name: l.name, code: l.code })),
    total: rows.length,
    rows: filtered.slice(0, 500),
    truncated: filtered.length > 500,
  });
});

/**
 * Apply a count.
 *
 * `lines` are { sizeId, quantity }. `overwrite` must be sent explicitly to
 * change a size that already carries stock — without it those lines come
 * back untouched and named, so the owner can see exactly what they were
 * about to walk over before they decide to.
 */
router.post("/apply", (req, res) => {
  const b = req.body || {};
  const locationId = String(b.location || "").trim();
  const loc = inventory.getLocationById(locationId);
  if (!loc) return res.status(400).json({ error: "Choose which location this count is for." });

  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) return res.status(400).json({ error: "Nothing was entered to set." });

  const overwrite = b.overwrite === true;
  const staff = (req.session && req.session.staffName) || "";

  const applied = [];
  const held = [];
  const missing = [];

  try {
    db.transaction(() => {
      for (const line of lines) {
        const sizeId = Number(line.sizeId);
        const qty = round2(line.quantity);
        if (!sizeId || !isFinite(qty) || qty < 0) { missing.push({ sizeId: line.sizeId, reason: "not a quantity" }); continue; }

        const size = db.prepare(`
          SELECT ps.id, ps.label, ps.product_id, p.name AS product_name
            FROM product_sizes ps JOIN products p ON p.id = ps.product_id
           WHERE ps.id = ?`).get(sizeId);
        if (!size) { missing.push({ sizeId, reason: "that size no longer exists" }); continue; }

        inventory.ensureRow(sizeId, loc.id);
        const before = round2(inventory.getStock(sizeId, loc.id));

        /* ALREADY COUNTED, OR ALREADY TRADING. Either way the figure on
           file was put there by somebody, and replacing it is a decision
           rather than a default. */
        if (before !== 0 && !overwrite) {
          held.push({ sizeId, product: size.product_name, size: size.label,
                      current: before, proposed: qty });
          continue;
        }
        if (before === qty) { applied.push({ sizeId, quantity: qty, changed: false }); continue; }

        /* SET, VIA THE ENGINE THAT ALREADY EXISTS. inventory.addStock
           takes a delta, keeps size_location_stock and the size's own
           total in step, and writes the stock_ledger row itself. Doing
           the UPDATE here instead would be a second way to move stock —
           one that could drift from the first, and that a reader of
           inventory.js would never know about. The count is absolute, so
           the delta is simply the difference from what is on file. */
        stockLedger.setContext({
          movement: "opening",
          refType: "Opening Stock",
          refNo: "",
          refId: "",
          staff,
          remarks: before !== 0 ? `opening count; replaced ${before}` : "opening count",
        });
        inventory.addStock(sizeId, loc.id, round2(qty - before));

        applied.push({ sizeId, quantity: qty, changed: true, from: before });
      }
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  logAction(req, "stock.opening",
    `${loc.name}: ${applied.filter(a => a.changed).length} set, ${held.length} left alone`);

  res.json({
    location: { id: loc.id, name: loc.name },
    applied: applied.length,
    changed: applied.filter(a => a.changed).length,
    unchanged: applied.filter(a => !a.changed).length,
    /* named, not counted: the owner is being asked to look at these */
    held, missing,
    note: held.length
      ? "These sizes already carry stock and were left exactly as they were. Send them again with overwrite to replace them."
      : "",
  });
});

module.exports = router;
