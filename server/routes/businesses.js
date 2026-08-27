/* ============================================================
   BUSINESSES

   The controls for the multi-business engine in db.js.

   The chosen business lives in the SESSION, on the server. It is never taken
   from the request body or a header, because anything the browser can send,
   the browser can forge — and forging it would read another business's books.
   Switching is therefore a deliberate POST that checks access first; every
   request after it is bound automatically.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { logAction } = require("../util");
const license = require("../license");

const router = express.Router();
const C = db.companies;

/* ---------------------------------------------------------- the licence gate

   How many businesses this installation may hold. The licence belongs to the
   INSTALLATION, not to a business, so the key is always read from the default
   business — otherwise a buyer could create a business and drop a fresh key
   into it to raise their own limit.

   An unlicensed build (the shop's own copy, PUBLIC_KEY empty) reports an
   unlimited allowance and nothing below ever blocks. */
function licensedLimit() {
  let key = "";
  try {
    C.runAs(C.defaultId(), () => {
      const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
      key = (row && row.license_key) || "";
    });
  } catch { /* a settings row that predates the column: treat as unlicensed */ }
  return license.state(license.resolveKey(key));
}

/** Whether another business may be created, and the reason if not. */
function canAddBusiness() {
  const lic = licensedLimit();
  if (lic.companyLimit === null) return { ok: true, limit: null };

  const used = C.list().filter(b => b.active).length;

  /* An expired subscription stops NEW businesses. It never touches the ones
     that exist — their data, stock and ledgers stay exactly as they are. */
  if (lic.enforced && lic.expired) {
    return { ok: false, limit: lic.companyLimit, used, upgrade: true,
      error: "Your subscription needs renewing before you can add another business. Your existing businesses and their data are unaffected." };
  }
  if (used >= lic.companyLimit) {
    return { ok: false, limit: lic.companyLimit, used, upgrade: true,
      error: lic.companyLimit === 1
        ? "Your current plan allows only 1 business. Please activate Multi-Business Access to add another."
        : `Your current plan allows ${lic.companyLimit} businesses. Please upgrade to add another.` };
  }
  return { ok: true, limit: lic.companyLimit, used };
}

/** Businesses this session may see.
 *
 *  Only the owner moves between businesses. Staff belong to the one they are
 *  signed in to — a second business's stock, customers, bills and profit are
 *  not theirs to read. Narrowing the list here is what enforces that: the
 *  switch below refuses anything this function did not return, so hiding the
 *  chip in the browser is a courtesy, not the lock. */
function visibleTo(req) {
  const active = C.list().filter(b => b.active);

  /* A SHOP THAT SIGNED IN AS A TENANT SEES ONLY ITS OWN BOOKS, whatever role
     it holds inside them.

     This is the line that makes one installation safe to serve a hundred
     shops. Every shopkeeper is the OWNER of their own shop, so the rule
     below would have handed each of them the whole list — and the switch
     route trusts this function to say what is allowed. One tap and a demo
     customer would have been reading another shop's customers, purchases
     and margins.

     Checked before the owner rule, deliberately: being an owner is about
     what you may do INSIDE a business, never about which businesses exist. */
  const tenant = req.session && req.session.tenant;
  if (tenant && tenant.companyId) return active.filter(b => b.id === tenant.companyId);

  if (req.session.role === "owner") return active;
  const current = req.session.businessId || C.defaultId();
  return active.filter(b => b.id === current);
}

router.get("/", (req, res) => {
  const current = req.session.businessId || C.defaultId();
  const gate = canAddBusiness();
  res.json({
    current,
    businesses: visibleTo(req).map(b => ({ ...b, isCurrent: b.id === current })),
    /* The browser uses these to word the Add panel. It is not the control —
       the POST below re-checks, so a forged request gains nothing. */
    canAdd: gate.ok,
    companyLimit: gate.limit,
    upgradeMessage: gate.ok ? "" : gate.error
  });
});

/** Switch. Refuses anything not on the caller's own visible list. */
router.post("/switch", (req, res) => {
  const target = String(req.body.businessId || "");
  const allowed = visibleTo(req).some(b => b.id === target);
  if (!allowed) return res.status(403).json({ error: "That business is not available to you." });

  req.session.businessId = target;
  logAction(req, "business.switch", C.get(target).name);
  res.json({ ok: true, current: target, name: C.get(target).name });
});

/** A new business is an empty database with the schema applied. Owner only:
 *  it creates books that will hold real money. */
router.post("/", requireRole("owner"), (req, res) => {
  /* Checked HERE, on the server, before anything is written. Hiding the
     button is a courtesy; this is the rule. */
  const gate = canAddBusiness();
  if (!gate.ok) return res.status(403).json({ error: gate.error, upgrade: true });
  try {
    const created = C.create({ name: req.body.name });
    logAction(req, "business.create", created.name);
    res.status(201).json(created);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put("/:id", requireRole("owner"), (req, res) => {
  try {
    const updated = C.update(req.params.id, { name: req.body.name, active: req.body.active });
    logAction(req, "business.update", updated.name);
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
