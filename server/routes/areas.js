// Areas — the geographic State → City → Area a bill belongs to.
//
// Not to be confused with server/routes/locations.js, which is Shop and
// Warehouse: where the goods physically sit. See the note in db.js.
//
// The list is a master an owner can extend — a shop that starts trading in
// a new suburb should not need a developer.
const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

function rowsFor(includeInactive) {
  return db.prepare(
    `SELECT * FROM areas ${includeInactive ? "" : "WHERE active = 1"}
     ORDER BY state ASC, city ASC, sort_order ASC, area ASC`
  ).all();
}

/* Flat list plus a state -> city -> area tree, so the three cascading
   dropdowns can be built without the browser regrouping the list itself. */
router.get("/", (req, res) => {
  const rows = rowsFor(req.query.all === "true");

  /* Which lines each area sits on, fetched in ONE query and stitched on.
     Asked per area this would be a query per row — 193 of them on a screen
     that opens constantly. */
  const lines = new Map();
  db.prepare("SELECT area_id, line FROM area_lines").all().forEach(r => {
    if (!lines.has(r.area_id)) lines.set(r.area_id, []);
    lines.get(r.area_id).push(r.line);
  });
  rows.forEach(r => { r.lines = lines.get(r.id) || []; });

  const tree = {};
  rows.forEach(r => {
    tree[r.state] = tree[r.state] || {};
    tree[r.state][r.city] = tree[r.state][r.city] || [];
    tree[r.state][r.city].push({ id: r.id, area: r.area });
  });

  /* The distinct values already in use, so the Delivery and Dispatch screens
     can offer them as a picker instead of asking the shop to retype "Malad
     Route 2" and spell it differently the second time. */
  const distinct = col => db.prepare(
    `SELECT DISTINCT ${col} AS v FROM areas WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map(r => r.v);

  res.json({
    areas: rows, tree,
    zones: distinct("zone"),
    routes: distinct("route"),
    subAreas: distinct("sub_area"),
    lines: db.prepare("SELECT DISTINCT line AS v FROM area_lines ORDER BY v").all().map(r => r.v)
  });
});

router.post("/", requireRole("owner"), (req, res) => {
  const state = String(req.body.state || "").trim();
  const city = String(req.body.city || "").trim();
  const area = String(req.body.area || "").trim();
  if (!state || !city || !area) {
    return res.status(400).json({ error: "State, City and Area are all required." });
  }
  const existing = db.prepare(
    "SELECT * FROM areas WHERE state = ? AND city = ? AND area = ?"
  ).get(state, city, area);
  if (existing) {
    // Re-adding one that was retired is the same intent as switching it back on.
    if (existing.active === 0) {
      db.prepare("UPDATE areas SET active = 1 WHERE id = ?").run(existing.id);
      logAction(req, "area.activate", `${state} / ${city} / ${area}`);
      return res.json(db.prepare("SELECT * FROM areas WHERE id = ?").get(existing.id));
    }
    return res.status(400).json({ error: `"${area}" already exists under ${city}.` });
  }
  // uid() takes the prefix itself — "AREA_" + uid() would give AREA_undefined_…
  const id = uid("AREA");
  const maxSort = db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS n FROM areas WHERE state = ? AND city = ?"
  ).get(state, city).n;
  db.prepare(`INSERT INTO areas
      (id, state, city, area, station, side, zone, sub_area, route, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, state, city, area,
    String(req.body.station || "").trim() || null,
    String(req.body.side || "").trim() || null,
    String(req.body.zone || "").trim(),
    String(req.body.subArea || "").trim(),
    String(req.body.route || "").trim(),
    maxSort + 1, Date.now());
  setLines(id, req.body.lines);
  logAction(req, "area.create", `${state} / ${city} / ${area}`);
  res.status(201).json(db.prepare("SELECT * FROM areas WHERE id = ?").get(id));
});

/** Replaces an area's line membership. Absent leaves it untouched. */
function setLines(areaId, lines) {
  if (!Array.isArray(lines)) return;
  db.prepare("DELETE FROM area_lines WHERE area_id = ?").run(areaId);
  const add = db.prepare("INSERT OR IGNORE INTO area_lines (area_id, line) VALUES (?, ?)");
  lines.map(l => String(l).trim()).filter(Boolean).forEach(l => add.run(areaId, l));
}

/* Edit the round-planning fields. The area's own name, state and city are NOT
   editable here: they identify the area on every bill that already carries it,
   and renaming one would rewrite history. Retire it and add the right one. */
router.put("/:id", requireRole("owner"), (req, res) => {
  const a = db.prepare("SELECT * FROM areas WHERE id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Area not found." });

  const val = (key, current) =>
    req.body[key] === undefined ? current : String(req.body[key]).trim();

  db.prepare(`UPDATE areas SET zone = ?, sub_area = ?, route = ?, station = ?, side = ?
              WHERE id = ?`).run(
    val("zone", a.zone), val("subArea", a.sub_area), val("route", a.route),
    val("station", a.station) || null, val("side", a.side) || null, a.id);
  setLines(a.id, req.body.lines);

  logAction(req, "area.update", `${a.area} — zone/route`);
  res.json(db.prepare("SELECT * FROM areas WHERE id = ?").get(a.id));
});

/* Retired, never deleted — an area sits on historical bills, and removing it
   would blank the area on last year's sales. Same rule as customers,
   suppliers and products. */
router.patch("/:id/active", requireRole("owner"), (req, res) => {
  const a = db.prepare("SELECT * FROM areas WHERE id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Area not found." });
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE areas SET active = ? WHERE id = ?").run(active, a.id);
  logAction(req, active ? "area.activate" : "area.deactivate", `${a.state} / ${a.city} / ${a.area}`);
  res.json(db.prepare("SELECT * FROM areas WHERE id = ?").get(a.id));
});

module.exports = router;
