/* ============================================================
   ADMIN PANEL — the API behind the panel

   PART 1 is the shell, so this router exposes exactly ONE thing:
   /me, which tells the page who it is talking to and what sections it
   may draw. That is the same role GET /permissions/me plays for the
   shop app, and it is deliberately the ONLY contract the page reads:
   the sidebar is built from the server's answer, so a section can never
   appear on screen that the server would then refuse.

   No business data is read or written here. Nothing in this file
   touches an invoice, a product, a cash entry or a customer.

   Mounted in index.js as:
     app.use("/api/admin", requireAuth, adminAccess.gate(), router)
   which puts it below the company binder, the licence gate, the
   financial-year lock, the owner-only DELETE gate and the feature gate
   — all five for free, and all five lost if it were ever moved out of
   /api. See the note on the mount.
   ============================================================ */
const express = require("express");
const adminAccess = require("../adminAccess");
const dashboard = require("../adminDashboard");
const customers = require("../adminCustomers");
const products = require("../adminProducts");
const sales = require("../adminSales");

const router = express.Router();

/* Hoisted to module scope, as routes/cashbook.js does, so the gate a
   route uses is visible on the route's own line. */
const mayManage = adminAccess.require("admin.manage");

/* ------------------------------------------------------------------
   WHO AM I

   Literal route, declared above anything with a parameter.
   ------------------------------------------------------------------ */
router.get("/me", (req, res) => {
  const me = adminAccess.describe(req);
  res.json({
    role: me.role,
    caps: me.caps,
    sections: me.sections,
    groups: me.groups,
    previewing: me.previewing,
    /* The shop's own name, for the sidebar lockup. Safe to read here —
       this router is inside /api, so the company binder applies. */
    businessName: businessName(),
    staffName: (req.session && req.session.staffName) || "",
  });
});

/* ------------------------------------------------------------------
   THE DASHBOARD

   ONE REQUEST draws the whole screen. Eight separate calls would mean
   eight sessions of round trips on a shop's broadband and eight chances
   to half-load; `?only=` exists so a single panel can be retried on its
   own after a failure without refetching the other seven.

   EACH SECTION IS ISOLATED. A section that throws is reported as a
   failed section and the other seven still render — the brief asks for
   that explicitly, and it is also the difference between "Payments
   could not be loaded" and a blank screen.

   WHAT NEVER CROSSES THIS BOUNDARY: the error a section threw. A SQLite
   message can name a file path on the shop's PC and a stack trace names
   the whole tree, so the browser is told which section failed and
   nothing else. The real error goes to the server log, where the person
   fixing it can read it.

   NO BUSINESS LOGIC LIVES HERE. Every figure is worked out in
   adminDashboard.js; this route checks who is asking, walks the section
   table and assembles the envelope.
   ------------------------------------------------------------------ */
router.get("/dashboard", (req, res) => {
  const only = String((req.query && req.query.only) || "").trim();
  const names = Object.keys(dashboard.SECTIONS);

  if (only && !Object.prototype.hasOwnProperty.call(dashboard.SECTIONS, only)) {
    return res.status(400).json({ error: "No such dashboard section." });
  }
  const wanted = only ? [only] : names;

  const sections = {};
  for (const name of wanted) {
    const spec = dashboard.SECTIONS[name];

    /* Server-side, per section, every time — never from a query
       parameter and never from anything the browser claims. A section
       this login may not read is reported as refused, not omitted, so
       the panel can say so rather than silently showing less. */
    if (!adminAccess.can(req, spec.cap)) {
      sections[name] = { ok: false, refused: true,
                         error: "You don't have permission to see this." };
      continue;
    }

    try {
      sections[name] = { ok: true, data: spec.build(req) };
    } catch (err) {
      console.error("[admin dashboard] section " + name + " failed:", err);
      sections[name] = { ok: false, refused: false,
                         error: "This section could not be loaded." };
    }
  }

  res.json({ generatedAt: Date.now(), sections });
});

/* ==================================================================
   CUSTOMERS

   A reading room over the shop's own customer book, plus the two
   changes the shop already supports safely.

   THERE IS NO DELETE HERE, on purpose. The shop app has one, and it
   already refuses any customer linked to an invoice or a payment — but
   it still permanently removes an unused record, and nothing on an
   admin screen needs that. Switching a customer off is reversible,
   leaves the history intact and is what "stop using this record"
   actually means. A customer who genuinely must go can still be
   removed from the customer's own page in Shop Manager, by the owner,
   with that route's existing guard in front of it.

   NOTHING HERE TOUCHES A FINANCIAL RECORD. No invoice, payment, cash
   entry or opening balance is written, voided or removed by any route
   below, whatever happens to the customer attached to it.

   CHANGING A CUSTOMER GOES THROUGH THE SHOP'S OWN HANDLER, not a copy
   of it — see routes/customers.js. Same validation, same audit entry.
   ================================================================== */
const mayReadCustomers = adminAccess.require("customers.view");
const mayEditCustomers = adminAccess.require("customers.edit");

/* Literal route, declared above the /:id ones below. */
router.get("/customers", mayReadCustomers, (req, res) => {
  const q = req.query || {};
  res.json(customers.list({
    q: q.q, filter: q.filter, sort: q.sort,
    page: q.page, pageSize: q.pageSize,
  }));
});

/**
 * One customer.
 *
 * THE IDOR ANSWER IS THE COMPANY BINDER, not a check written here.
 * `db` resolves to the database of the company this session is in
 * (index.js, the /api-scoped binder), and each shop is a physically
 * separate SQLite file with no company_id column to forget. An id
 * belonging to another shop is not "hidden" — it is not in the file
 * being read, so it comes back 404 exactly as a typo would.
 *
 * That is also why this router must stay mounted under /api. Outside
 * it there is no binder and `db` falls back to the default company,
 * which would turn this route into precisely the cross-tenant read it
 * is supposed to be immune to.
 */
router.get("/customers/:id", mayReadCustomers, (req, res) => {
  const detail = customers.profile(String(req.params.id || ""));
  if (!detail) return res.status(404).json({ error: "Customer not found." });
  res.json(detail);
});

/* Edit. The handler is the shop's own, so this is one line by design:
   anything more would be a second set of rules. */
router.put("/customers/:id", mayEditCustomers, (req, res) =>
  require("./customers").updateCustomer(req, res));

/* Switch off / switch back on. Reversible, and the only status this
   app has — there is no BLOCKED state in the schema and inventing one
   is not something an admin shell should do on its own. */
router.patch("/customers/:id/active", mayEditCustomers, (req, res) =>
  require("./customers").setCustomerActive(req, res));

/* ==================================================================
   PRODUCTS AND INVENTORY

   Reading the catalogue and the shelves, plus the two changes the shop
   already supports: editing a product, and correcting one size's count
   at one location.

   BOTH WRITES ARE THE SHOP'S OWN HANDLERS, not copies. That matters
   more here than anywhere else in this panel, because the stock path
   carries rules that are easy to get subtly wrong and expensive to get
   wrong at all:

     - it runs inside db.transaction, so the count and the
       product-level total cannot end up disagreeing
     - it writes through inventory.addStock, whose UPDATE is
       `quantity = quantity + ?` — arithmetic in SQLite, not
       read-then-overwrite in JavaScript, so two people correcting the
       same size at the same moment cannot lose one another's change
     - it clamps at zero, so an adjustment cannot drive a shelf negative
     - it records a stock_ledger row with the count BEFORE and AFTER

   WHAT THIS ADDS is the one thing the shop's own screen does not: a
   REASON. The ledger has always had a remarks column and a movement
   called "adjustment"; nothing was filling them for a manual
   correction, so a corrected count said "stock_in" with no note. One
   line of ledger context before delegating fixes that, for this path
   only, and changes no stock logic whatsoever.
   ================================================================== */
const mayReadProducts = adminAccess.require("products.view");
const mayEditProducts = adminAccess.require("products.edit");
const mayAdjustStock  = adminAccess.require("inventory.adjust");

router.get("/products", mayReadProducts, (req, res) => {
  const q = req.query || {};
  res.json(products.list({
    q: q.q, filter: q.filter, sort: q.sort, category: q.category,
    page: q.page, pageSize: q.pageSize,
  }));
});

/* Literal routes first, so /products/meta is never read as an id. */
router.get("/inventory", mayReadProducts, (req, res) => {
  res.json(products.overview());
});

router.get("/inventory/history", mayReadProducts, (req, res) => {
  const q = req.query || {};
  res.json(products.historyFor({
    productId: q.productId, sizeId: q.sizeId, movement: q.movement,
    from: q.from, to: q.to, page: q.page, limit: q.limit,
    }));
});

router.get("/inventory/movements", mayReadProducts, (req, res) => {
  res.json({ movements: products.movementTypes() });
});

router.get("/products/:id", mayReadProducts, (req, res) => {
  const detail = products.profile(String(req.params.id || ""));
  if (!detail) return res.status(404).json({ error: "Product not found." });

  /* What THIS login may do with it, decided here and sent as two
     booleans. The alternative is the browser holding a list of
     capability names and reasoning about them, which puts a copy of
     the permission model in the one place it cannot be trusted. The
     server refuses the write regardless; this only stops the page
     offering a button that would be refused. */
  detail.abilities = {
    mayEdit: adminAccess.can(req, "products.edit"),
    mayAdjust: adminAccess.can(req, "inventory.adjust"),
  };
  res.json(detail);
});

/* Edit. The handler is the shop's own. */
router.put("/products/:id", mayEditProducts, (req, res) =>
  require("./products").updateProduct(req, res));

/**
 * Correct one size's count at one location.
 *
 * Owner-only, and deliberately narrower than editing a product: this
 * moves a number the shop bills against.
 *
 * A REASON IS REQUIRED. The shop's own screen does not ask for one and
 * that is its business; an admin reaching past the counter to change a
 * count should have to say why, and the ledger has always had somewhere
 * to put it. The reason, the movement type and a reference are set on
 * the request's ledger context — which AsyncLocalStorage gave to this
 * request alone — and the shop's handler then records them without
 * knowing anything changed.
 *
 * Nothing about HOW the stock moves is reimplemented here. The handler
 * below does the transaction, the clamp and the ledger write exactly as
 * it does for the counter.
 */
router.patch("/products/:id/sizes/:sizeId/stock", mayAdjustStock, (req, res) => {
  const reason = String((req.body && req.body.reason) || "").trim();
  if (!reason) {
    return res.status(400).json({ error: "Give a reason for the correction." });
  }
  if (reason.length > 200) {
    return res.status(400).json({ error: "Keep the reason under 200 characters." });
  }

  /* Validated here rather than left to the handler's Number(), which
     would turn "abc" into NaN and a blank body into a silent no-op. */
  const hasStock = req.body.stock !== undefined;
  const hasDelta = req.body.delta !== undefined;
  if (hasStock === hasDelta) {
    return res.status(400).json({ error: "Give either a new count or a change, not both." });
  }

  const raw = hasStock ? req.body.stock : req.body.delta;
  /* Number(null) is 0, Number("") is 0, Number(true) is 1 and Number([])
     is 0 — so a bare Number() check accepts all four and quietly sets a
     shelf to zero. A test sent {"stock": null} and wiped a count of 40
     without a word, which is exactly the silent stock change the brief
     rules out. Only a real number, or a string that is entirely one,
     gets through. */
  const numeric = typeof raw === "number" ||
    (typeof raw === "string" && raw.trim() !== "" && !isNaN(Number(raw)));
  if (!numeric) {
    return res.status(400).json({ error: "That is not a number." });
  }
  const figure = Number(raw);
  if (!Number.isFinite(figure)) {
    return res.status(400).json({ error: "That is not a number." });
  }
  if (hasStock && figure < 0) {
    return res.status(400).json({ error: "A stock count cannot be negative." });
  }
  if (Math.abs(figure) > 10000000) {
    return res.status(400).json({ error: "That quantity is out of range." });
  }

  require("../stockLedger").setContext({
    movement: "adjustment",
    refType: "Admin correction",
    remarks: reason,
  });

  return require("./products").adjustSizeStock(req, res);
});

/* ==================================================================
   SALES AND INVOICES

   READ-ONLY, and deliberately so. There is no PUT, PATCH or DELETE
   below and there is no capability that would allow one.

   An invoice is not a customer record. It has been printed, handed
   over and filed in a GST return, and the shop app surrounds a change
   to one with the things that make it safe: the financial-year lock
   that refuses a write into a filed period, the stock that has to come
   back, the customer balance that has to move with it, and the audit
   entry. A second door onto that from here would mean reimplementing
   all of it or quietly skipping some — and the second is how a set of
   books ends up disagreeing with a return that has already been filed.

   So the panel reads, and anyone who needs to change something is sent
   to the screen built to do it.
   ================================================================== */
const mayReadSales = adminAccess.require("sales.view");

/* Literal routes above the /:id one. */
router.get("/sales", mayReadSales, (req, res) => {
  const q = req.query || {};
  res.json(sales.summary({ from: q.from, to: q.to }));
});

router.get("/invoices", mayReadSales, (req, res) => {
  const q = req.query || {};
  res.json(sales.documents({
    q: q.q, type: q.type, status: q.status, sort: q.sort,
    customerId: q.customerId,
    from: q.from, to: q.to, page: q.page, pageSize: q.pageSize,
  }));
});

router.get("/invoices/:id", mayReadSales, (req, res) => {
  const doc = sales.document(String(req.params.id || ""));
  if (!doc) return res.status(404).json({ error: "Document not found." });
  res.json(doc);
});

/* The roles the panel is structured for, and which capabilities each
   holds. Read-only, and owner-only: it describes the shape of the
   permission system, which is not something a support login needs. */
router.get("/roles", mayManage, (req, res) => {
  res.json({
    roles: adminAccess.ADMIN_ROLES,
    caps: adminAccess.CAPS,
    /* Which of them can actually be held today. See adminAccess.js for
       why the other two have no carrier yet. */
    active: ["OWNER"],
  });
});

function businessName() {
  try {
    const db = require("../db");
    const s = db.prepare("SELECT business_name FROM settings WHERE id = 1").get() || {};
    return s.business_name || "";
  } catch (e) {
    return "";
  }
}

module.exports = router;
