/* ============================================================
   /api/notifications — the bell

   Every route here reads who is asking from the session and nothing else.
   There is no staff id, company id or audience in any request body or
   query string that this file believes: a person's list is worked out in
   server/notify.js from who they are signed in as.
   ============================================================ */
const express = require("express");
const notify = require("../notify");
const { requireRole } = require("../auth");
const { logAction } = require("../util");

const router = express.Router();

const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : "Could not do that." });

/** A page of notifications, newest first. ?before=<cursor>&limit=<1..50> */
router.get("/", (req, res) => {
  res.json(notify.list(req, { before: req.query.before, limit: req.query.limit }));
});

/** Just the number on the bell. Cheap: one indexed count. */
router.get("/count", (req, res) => {
  res.json({ unread: notify.unreadCount(req) });
});

router.post("/read", (req, res) => {
  const marked = notify.markRead(req, req.body && req.body.ids);
  res.json({ ok: true, marked, unread: notify.unreadCount(req) });
});

router.post("/read-all", (req, res) => {
  const marked = notify.markAllRead(req);
  res.json({ ok: true, marked, unread: 0 });
});

router.get("/prefs", (req, res) => {
  res.json(notify.prefsOf(req));
});

router.put("/prefs/:category", (req, res) => {
  try {
    const b = req.body || {};
    const prefs = notify.setPref(req, req.params.category, {
      inApp: typeof b.inApp === "boolean" ? b.inApp : undefined,
      email: typeof b.email === "boolean" ? b.email : undefined
    });
    res.json(prefs);
  } catch (e) { fail(res, e); }
});

/* Owner only, at the route as well as inside notify.announce(). */
router.post("/announce", requireRole("owner"), (req, res) => {
  try {
    const id = notify.announce(req, { title: req.body && req.body.title, body: req.body && req.body.body });
    logAction(req, "notification.announce", String(req.body.title || "").slice(0, 80),
      { resourceType: "notification", resourceId: id });
    res.json({ ok: true, id });
  } catch (e) { fail(res, e); }
});

router.post("/:id/withdraw", requireRole("owner"), (req, res) => {
  try {
    notify.withdraw(req, req.params.id);
    logAction(req, "notification.withdraw", "", { resourceType: "notification", resourceId: req.params.id });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = router;
