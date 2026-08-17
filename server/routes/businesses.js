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

const router = express.Router();
const C = db.companies;

/** Businesses this session may see. Today every signed-in user sees them all;
 *  when per-staff access arrives, this is the one place that narrows. */
function visibleTo(req) {
  return C.list().filter(b => b.active);
}

router.get("/", (req, res) => {
  const current = req.session.businessId || C.defaultId();
  res.json({
    current,
    businesses: visibleTo(req).map(b => ({ ...b, isCurrent: b.id === current }))
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
