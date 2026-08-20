/* ============================================================
   NOTEPAD

   Anyone signed in can write a note and edit their shop's notes — this is the
   pad by the till, not a document store. Deleting is the one thing kept to
   the owner, because a note someone relied on should not vanish quietly.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, logAction, bindId } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

const clean = (v, fallback = "") => (v === undefined ? fallback : String(v));

router.get("/", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  let rows = db.prepare(
    "SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT 300").all();
  if (q) {
    rows = rows.filter(n =>
      (n.title || "").toLowerCase().includes(q) || (n.body || "").toLowerCase().includes(q));
  }
  res.json({ notes: rows });
});

router.get("/:id", (req, res) => {
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(bindId(req.params.id));
  if (!n) return res.status(404).json({ error: "That note no longer exists." });
  res.json(n);
});

router.post("/", (req, res) => {
  const b = req.body || {};
  const title = clean(b.title).trim();
  const body = clean(b.body);
  const ink = clean(b.ink);

  // A note with neither words nor ink is nothing; saving it would litter the pad.
  if (!title && !body.trim() && !ink) {
    return res.status(400).json({ error: "Write something first." });
  }

  const id = uid("NOTE");
  const now = Date.now();
  db.prepare(`INSERT INTO notes (id, title, body, ink, ink_height, pinned, created_at, updated_at, created_by)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, title, body, ink, Number(b.inkHeight) || 0, b.pinned ? 1 : 0, now, now,
    (req.session && req.session.staffName) || "");

  logAction(req, "note.create", title || "(untitled)");
  res.status(201).json(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(bindId(req.params.id));
  if (!n) return res.status(404).json({ error: "That note no longer exists." });
  const b = req.body || {};

  /* Each field falls back to what is already stored, so a screen that only
     sends the ink cannot blank the typed text, and the other way round. */
  db.prepare(`UPDATE notes SET title = ?, body = ?, ink = ?, ink_height = ?, pinned = ?, updated_at = ?
              WHERE id = ?`).run(
    clean(b.title, n.title).trim(), clean(b.body, n.body), clean(b.ink, n.ink),
    b.inkHeight === undefined ? n.ink_height : (Number(b.inkHeight) || 0),
    b.pinned === undefined ? n.pinned : (b.pinned ? 1 : 0),
    Date.now(), n.id);

  logAction(req, "note.update", n.title || "(untitled)");
  res.json(db.prepare("SELECT * FROM notes WHERE id = ?").get(n.id));
});

router.delete("/:id", requireRole("owner"), (req, res) => {
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(bindId(req.params.id));
  if (!n) return res.status(404).json({ error: "That note no longer exists." });
  db.prepare("DELETE FROM notes WHERE id = ?").run(n.id);
  logAction(req, "note.delete", n.title || "(untitled)");
  res.json({ ok: true });
});

module.exports = router;
