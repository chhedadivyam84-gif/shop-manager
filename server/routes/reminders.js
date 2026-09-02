/* ============================================================
   THE SHOP'S OWN REMINDERS

   Separate from /api/alerts, and separate on purpose. Those reminders are
   worked out of the books every time they are asked for — a challan not yet
   billed, a cheque due — and cannot be edited, because the only honest way
   to clear one is to do the thing it is about.

   These are the shop's own notes. "Call Laxmi Thursday." Nobody can derive
   that from a ledger, so it is stored, and because it is the shop's own
   words it can be changed or thrown away freely.

   OWNER-ONLY DELETE, matching the rest of the app: a staff member can write
   a reminder and tick it done, but removing the record is the owner's.
   ============================================================ */

const express = require("express");
const db = require("../db");
const { uid, logAction, todayStr } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

const MAX_TEXT = 300;

/** What the shop typed, trimmed and bounded. Throws a message fit to show. */
function readBody(b) {
  const text = String((b && b.text) || "").trim();
  if (!text) throw new Error("Write what the reminder is about.");
  if (text.length > MAX_TEXT) throw new Error(`Keep the reminder under ${MAX_TEXT} characters.`);

  const date = String((b && b.dueDate) || "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("That date is not a real date.");

  /* Time without a date is a reminder for no particular day, which is not a
     reminder at all — it would sort nowhere and never come due. */
  const time = String((b && b.dueTime) || "").trim();
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw new Error("That time is not a real time.");
  if (time && !date) throw new Error("Give a date as well as a time.");

  const kind = ["customer", "product", "supplier", ""].includes(b && b.linkKind)
    ? (b.linkKind || "") : "";
  return {
    text, date, time,
    linkKind: kind,
    linkId: kind ? String((b && b.linkId) || "").trim() : "",
    /* The name is COPIED, not looked up later. A reminder to chase Laxmi
       should still read "Laxmi" after Laxmi is renamed or deactivated —
       it is a note about a person, not a join. */
    linkName: kind ? String((b && b.linkName) || "").trim().slice(0, 120) : ""
  };
}

/**
 * Everything not yet done, soonest first, with undated ones last — an
 * undated note is a someday, and a someday should never push a Thursday
 * down the screen. Done ones come after, newest first, so ticking something
 * off moves it out of the way without hiding it.
 */
router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM reminders
     ORDER BY done ASC,
              CASE WHEN done = 1 THEN 0
                   WHEN due_date IS NULL OR due_date = '' THEN 1 ELSE 0 END ASC,
              CASE WHEN done = 1 THEN NULL ELSE due_date END ASC,
              CASE WHEN done = 1 THEN NULL ELSE due_time END ASC,
              created_at DESC
  `).all();
  const today = todayStr();
  res.json(rows.map(r => ({
    ...r,
    done: !!r.done,
    /* Worked out here so every screen agrees on what "overdue" means. */
    overdue: !r.done && !!r.due_date && r.due_date < today,
    dueToday: !r.done && r.due_date === today
  })));
});

router.post("/", (req, res) => {
  let v;
  try { v = readBody(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

  const id = uid("REM");
  db.prepare(`
    INSERT INTO reminders (id, text, due_date, due_time, link_kind, link_id, link_name,
                           done, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, v.text, v.date, v.time, v.linkKind, v.linkId, v.linkName,
         Date.now(), (req.session && req.session.staffName) || "");

  logAction(req, "reminder.create", v.text.slice(0, 80));
  res.status(201).json(db.prepare("SELECT * FROM reminders WHERE id = ?").get(id));
});

/**
 * Change one. The same fields as creating, so the form is the same form —
 * a separate edit shape is how the two drift apart and one of them starts
 * silently dropping a field.
 */
router.put("/:id", (req, res) => {
  const cur = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
  if (!cur) return res.status(404).json({ error: "That reminder no longer exists." });

  let v;
  try { v = readBody(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

  /* done is only touched when it is actually sent, so saving an edit does
     not quietly untick something the shop had already finished. */
  const done = req.body && req.body.done !== undefined ? (req.body.done ? 1 : 0) : cur.done;

  db.prepare(`
    UPDATE reminders SET text = ?, due_date = ?, due_time = ?, link_kind = ?,
                         link_id = ?, link_name = ?, done = ?,
                         done_at = ?, updated_at = ?
     WHERE id = ?
  `).run(v.text, v.date, v.time, v.linkKind, v.linkId, v.linkName, done,
         done ? (cur.done_at || Date.now()) : null, Date.now(), cur.id);

  logAction(req, "reminder.edit", v.text.slice(0, 80));
  res.json(db.prepare("SELECT * FROM reminders WHERE id = ?").get(cur.id));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const cur = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
  if (!cur) return res.status(404).json({ error: "That reminder no longer exists." });
  db.prepare("DELETE FROM reminders WHERE id = ?").run(cur.id);
  logAction(req, "reminder.delete", String(cur.text || "").slice(0, 80));
  res.json({ ok: true });
});

module.exports = router;
