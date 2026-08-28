/* ============================================================
   FEATURE ACCESS — the half that is real

   Hiding a tile is tidiness, not a restriction: the screen is still in the
   file and anyone who knows the address can reach it. THIS is the part
   that actually decides, and it is the reason the hiding is allowed to be
   cosmetic.

   The vendor's list travels signed from the panel and is stored per shop
   in the tenant map. A single-shop copy has no tenant and is entitled to
   everything — nothing here changes for a shop that bought the whole app.

   READING IS ALWAYS ALLOWED. Switching a feature off must never take a
   shop's own records away from them: their old quotations stay on their
   reports, stay printable, stay exportable. What stops is CREATING and
   CHANGING — which is what "not sold" actually means.
   ============================================================ */
const tenants = require("./tenants");

/**
 * Which routes belong to which feature.
 *
 * Only what a feature exclusively owns. /api/products is not here, and
 * must not be: barcodes live on products, and gating the whole products
 * route because a shop has no barcodes would stop them adding stock.
 */
const ROUTES = {
  quotation:   ["/api/quotations"],
  so:          ["/api/sales-orders"],
  selection:   ["/api/selection-slips"],
  delivery:    ["/api/delivery", "/api/dispatch"],
  purchase:    ["/api/purchases", "/api/purchase-returns", "/api/stock-ins"],
  po:          ["/api/purchase-orders"],
  psearch:     [],                       /* a screen over data it already has */
  pquery:      ["/api/product-query"],
  barcode:     ["/api/products/scan"],
  cashbook:    ["/api/cashbook"],
  bankbook:    ["/api/bankbook", "/api/bank-accounts"],
  accounts:    ["/api/accounting"],
  outstanding: [],                       /* a view of invoices already made */
  cheque:      ["/api/cheques"],
  ewb:         ["/api/ewb", "/api/ewaybill"],
  inquiries:   ["/api/inquiries"],
  printmgr:    ["/api/print-manager"],
  notes:       ["/api/notes"]
};

/** Never gated, whatever the vendor ticks. */
const CORE = ["billing", "inventory", "reports", "backups"];

/** The keys this shop may not use. */
function offFor(req) {
  const t = req.session && req.session.tenant;
  if (!t || !t.username) return [];
  let row = null;
  try { row = tenants.get(t.username); } catch (e) { /* map unreadable */ }
  const raw = row ? row.features_off : (t.featuresOff || []).join(",");
  return String(raw || "").split(",").map(x => x.trim())
    .filter(k => k && !CORE.includes(k));
}

/**
 * Middleware. Refuses a write to a feature this shop was not sold, and
 * says which one — a bare 403 sends somebody hunting for a fault that is
 * really a commercial decision.
 */
function gate() {
  return function (req, res, next) {
    /* Reading is always allowed. See the note at the top: a shop keeps
       every record it ever made, whatever it stops paying for. */
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

    const off = offFor(req);
    if (!off.length) return next();

    const url = req.originalUrl.split("?")[0];
    for (const key of off) {
      for (const prefix of (ROUTES[key] || [])) {
        if (url === prefix || url.startsWith(prefix + "/")) {
          return res.status(403).json({
            error: "This part of the app is not included in your subscription. "
                 + "Ask your supplier if you would like it switched on.",
            featureBlocked: key
          });
        }
      }
    }
    next();
  };
}

module.exports = { gate, offFor, ROUTES, CORE };
