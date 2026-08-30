/* ============================================================
   WHATSAPP — GROUPS AND SEND HISTORY

   WHAT WHATSAPP ACTUALLY ALLOWS, because the design of this whole feature
   follows from it and it is easy to promise otherwise:

     wa.me/<number>?text=...   opens a chat with ONE PERSON, message
                               pre-filled. This is what the app already
                               uses everywhere and it works.

     chat.whatsapp.com/<code>  is a group INVITE. It can make somebody JOIN
                               a group. It cannot open one, cannot pre-fill
                               a message, and cannot post.

     WhatsApp Business API     does NOT support groups. Not "not yet" — the
                               Cloud API is strictly one business to one
                               customer. Paying for it would not buy this.

   So there is no link, and no API at any price, that posts into a group
   from a web page. The only genuine route is the operator's own device:
   navigator.share() raises the OS share sheet, they tap WhatsApp and pick
   the group. One extra tap, and it really does reach the group.

   THIS FILE THEREFORE STORES TWO THINGS AND SENDS NOTHING. It keeps the
   groups a customer has, so the operator picks from a list instead of
   remembering, and it keeps a log of what was handed to WhatsApp. The
   handing over happens in the browser, because that is the only place it
   can happen.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
const permissions = require("../permissions");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* groups                                                              */
/* ------------------------------------------------------------------ */

/** Every group for one customer. Inactive ones come too, greyed in the UI —
 *  the owner has to be able to see one in order to switch it back on. */
router.get("/groups/:customerId", permissions.require("whatsapp", "view"), (req, res) => {
  res.json(db.prepare(
    "SELECT * FROM customer_wa_groups WHERE customer_id = ? ORDER BY active DESC, name"
  ).all(req.params.customerId));
});

/** Active groups for every customer at once, so the send dialog does not
 *  need a round trip per customer. */
router.get("/groups", permissions.require("whatsapp", "view"), (req, res) => {
  res.json(db.prepare(
    "SELECT * FROM customer_wa_groups WHERE active = 1 ORDER BY customer_id, name"
  ).all());
});

router.post("/groups", permissions.require("whatsapp", "edit"), (req, res) => {
  const customerId = String(req.body.customerId || "").trim();
  const name = String(req.body.name || "").trim();
  if (!customerId || !name) return res.status(400).json({ error: "Customer and group name are both needed." });

  const cust = db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId);
  if (!cust) return res.status(404).json({ error: "Customer not found." });

  const clash = db.prepare(
    "SELECT id FROM customer_wa_groups WHERE customer_id = ? AND name = ?"
  ).get(customerId, name);
  if (clash) return res.status(400).json({ error: `"${name}" is already a group for this customer.` });

  const id = uid("WAG");
  db.prepare(`
    INSERT INTO customer_wa_groups (id, customer_id, name, purpose, invite_link, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, customerId, name, String(req.body.purpose || "").trim(),
         String(req.body.inviteLink || "").trim(), Date.now());

  logAction(req, "whatsapp.group.add", name);
  res.status(201).json(db.prepare("SELECT * FROM customer_wa_groups WHERE id = ?").get(id));
});

router.put("/groups/:id", permissions.require("whatsapp", "edit"), (req, res) => {
  const g = db.prepare("SELECT * FROM customer_wa_groups WHERE id = ?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Group not found." });

  const name = req.body.name === undefined ? g.name : String(req.body.name).trim();
  if (!name) return res.status(400).json({ error: "Give the group a name." });
  const clash = db.prepare(
    "SELECT id FROM customer_wa_groups WHERE customer_id = ? AND name = ? AND id <> ?"
  ).get(g.customer_id, name, g.id);
  if (clash) return res.status(400).json({ error: `"${name}" is already a group for this customer.` });

  db.prepare(`
    UPDATE customer_wa_groups SET name = ?, purpose = ?, invite_link = ?, active = ? WHERE id = ?
  `).run(name,
         req.body.purpose === undefined ? g.purpose : String(req.body.purpose).trim(),
         req.body.inviteLink === undefined ? g.invite_link : String(req.body.inviteLink).trim(),
         req.body.active === undefined ? g.active : (req.body.active ? 1 : 0),
         g.id);

  logAction(req, "whatsapp.group.update", name);
  res.json(db.prepare("SELECT * FROM customer_wa_groups WHERE id = ?").get(g.id));
});

/**
 * Switched off, never deleted.
 *
 * A group that stops being used is still the destination named against
 * every send already in the log. Removing the row would turn that history
 * into a reference to nothing, and the history is the point of keeping it.
 */
router.post("/groups/:id/deactivate", permissions.require("whatsapp", "edit"), (req, res) => {
  const g = db.prepare("SELECT * FROM customer_wa_groups WHERE id = ?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Group not found." });
  db.prepare("UPDATE customer_wa_groups SET active = ? WHERE id = ?").run(g.active ? 0 : 1, g.id);
  const now = db.prepare("SELECT * FROM customer_wa_groups WHERE id = ?").get(g.id);
  logAction(req, "whatsapp.group." + (now.active ? "activate" : "deactivate"), g.name);
  res.json(now);
});

/* ------------------------------------------------------------------ */
/* send history                                                        */
/* ------------------------------------------------------------------ */

/* The only statuses this app can honestly claim. There is no "delivered"
   and no "read": WhatsApp gives a web page no callback whatsoever, so
   either would be a fact nobody here is in a position to know. */
const STATUSES = ["opened", "shared", "copied", "cancelled", "failed"];

/**
 * Records that a message was handed to WhatsApp.
 *
 * Never blocks the send — same rule as the print log. A failed log write
 * must not stop a customer getting their order, so the client fires this
 * and does not wait on it.
 */
router.post("/log", (req, res) => {
  const b = req.body || {};
  const status = STATUSES.includes(b.status) ? b.status : "opened";
  const id = uid("WAL");
  db.prepare(`
    INSERT INTO wa_send_log
      (id, at, customer_id, customer_name, doc_type, doc_id, doc_no,
       dest_type, dest_name, dest_ref, status, staff_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, Date.now(),
    b.customerId || null,
    String(b.customerName || "").slice(0, 120),
    String(b.docType || "").slice(0, 40),
    String(b.docId || "").slice(0, 60),
    String(b.docNo || "").slice(0, 60),
    b.destType === "group" ? "group" : "individual",
    String(b.destName || "").slice(0, 120),
    /* The number or the group name, as it was at the time. Not a foreign
       key: a group can be renamed and this has to keep saying where the
       message actually went. */
    String(b.destRef || "").slice(0, 120),
    status,
    (req.session && req.session.staffName) || "");
  res.status(201).json({ ok: true, id });
});

/** The history screen. Newest first, with the usual filters. */
router.get("/log", permissions.require("whatsapp", "view"), (req, res) => {
  const where = [];
  const params = [];
  if (req.query.customerId) { where.push("customer_id = ?"); params.push(req.query.customerId); }
  if (req.query.destType)   { where.push("dest_type = ?");   params.push(req.query.destType); }
  if (req.query.status)     { where.push("status = ?");      params.push(req.query.status); }
  if (req.query.q) {
    where.push("(customer_name LIKE ? OR doc_no LIKE ? OR dest_name LIKE ?)");
    const like = `%${req.query.q}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT * FROM wa_send_log
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY at DESC LIMIT 500
  `).all(...params);
  res.json({ rows, total: rows.length });
});

module.exports = router;
