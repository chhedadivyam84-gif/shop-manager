/* ============================================================
   PRINT MANAGEMENT

   Two jobs, both driven entirely by server/printRegistry.js:

     1. Templates — create, edit, duplicate, rename, delete, set default,
        per document type, with no route able to touch another type.
     2. Search — find any document of any registered type, with the
        filters the Print Management screen offers, in one query shape
        generated from the registry.

   Nothing here names a document type in code. Adding one later means one
   entry in the registry; this file does not change.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
const { requireRole } = require("../auth");
const reg = require("../printRegistry");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* the document list                                                    */
/* ------------------------------------------------------------------ */

/** Every registered document with its template count — what the Print
 *  Management screen lists down its left side. */
router.get("/documents", (req, res) => {
  const counts = db.prepare(
    "SELECT doc_type, COUNT(*) AS n FROM doc_templates GROUP BY doc_type"
  ).all();
  const byType = new Map(counts.map(c => [c.doc_type, c.n]));
  res.json(reg.DOCUMENTS.map(d => ({
    key: d.key,
    label: d.label,
    group: d.group,
    available: !!d.available,
    unavailableReason: d.unavailableReason || null,
    supportsRate: !!d.supportsRate,
    templateCount: byType.get(d.key) || 0
  })));
});

/** The item columns a given document can offer, for the designer. */
router.get("/documents/:key/fields", (req, res) => {
  const doc = reg.getDoc(req.params.key);
  if (!doc) return res.status(404).json({ error: "Unknown document type." });
  res.json({
    key: doc.key,
    label: doc.label,
    supportsRate: !!doc.supportsRate,
    fields: (doc.items || []).map(k => ({ key: k, ...reg.ITEM_FIELDS[k] }))
  });
});

/* ------------------------------------------------------------------ */
/* templates                                                            */
/* ------------------------------------------------------------------ */

function templatesFor(docType) {
  return db.prepare(
    "SELECT * FROM doc_templates WHERE doc_type = ? ORDER BY is_default DESC, name"
  ).all(docType).map(t => ({ ...t, config: JSON.parse(t.config) }));
}

router.get("/templates/:docType", (req, res) => {
  if (!reg.getDoc(req.params.docType)) return res.status(404).json({ error: "Unknown document type." });
  res.json(templatesFor(req.params.docType));
});

/**
 * Create a template for ONE document type.
 *
 * The doc_type comes from the URL and is checked against the registry, so a
 * request cannot smuggle in a different type through the body and land a
 * template under a document the user was not editing.
 */
router.post("/templates/:docType", requireRole("owner"), (req, res) => {
  const doc = reg.getDoc(req.params.docType);
  if (!doc) return res.status(404).json({ error: "Unknown document type." });

  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Give the template a name." });

  const existing = db.prepare(
    "SELECT id FROM doc_templates WHERE doc_type = ? AND name = ?"
  ).get(doc.key, name);
  if (existing) return res.status(400).json({ error: `"${name}" already exists for ${doc.label}.` });

  // Copied from another template of the SAME document, or from the
  // registry's defaults. Copying across document types is not offered:
  // an Invoice's columns are not a Challan's, and silently dropping the
  // ones that do not apply would be a confusing way to find that out.
  let config;
  if (req.body.copyFrom) {
    const src = db.prepare(
      "SELECT config FROM doc_templates WHERE id = ? AND doc_type = ?"
    ).get(req.body.copyFrom, doc.key);
    if (!src) return res.status(400).json({ error: "The template being copied was not found." });
    config = JSON.parse(src.config);
  } else {
    config = reg.defaultConfig(doc);
  }
  if (req.body.config && typeof req.body.config === "object") {
    config = { ...config, ...req.body.config };
  }

  const id = uid("TPL");
  const isFirst = db.prepare(
    "SELECT COUNT(*) AS n FROM doc_templates WHERE doc_type = ?"
  ).get(doc.key).n === 0;
  db.prepare(`
    INSERT INTO doc_templates (id, doc_type, name, config, is_default, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, doc.key, name, JSON.stringify(config), isFirst ? 1 : 0, Date.now());

  logAction(req, "print.template.create", `${doc.label} / ${name}`);
  res.status(201).json({ ...db.prepare("SELECT * FROM doc_templates WHERE id = ?").get(id), config });
});

router.put("/templates/:id", requireRole("owner"), (req, res) => {
  const t = db.prepare("SELECT * FROM doc_templates WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Template not found." });
  const doc = reg.getDoc(t.doc_type);

  const name = req.body.name === undefined ? t.name : String(req.body.name).trim();
  if (!name) return res.status(400).json({ error: "Give the template a name." });
  const clash = db.prepare(
    "SELECT id FROM doc_templates WHERE doc_type = ? AND name = ? AND id <> ?"
  ).get(t.doc_type, name, t.id);
  if (clash) return res.status(400).json({ error: `"${name}" already exists for ${doc ? doc.label : t.doc_type}.` });

  let config = JSON.parse(t.config);
  if (req.body.config && typeof req.body.config === "object") {
    config = { ...config, ...req.body.config };
    /* Columns are replaced wholesale, not merged. They are an ORDERED list
       and the designer's whole job is reordering them — merging index by
       index would quietly resurrect the old order. */
    if (Array.isArray(req.body.config.columns)) {
      const allowed = new Set(doc ? doc.items : []);
      config.columns = req.body.config.columns
        .filter(c => c && allowed.has(c.key))
        .map(c => ({
          key: c.key,
          label: String(c.label || "").slice(0, 40) || reg.ITEM_FIELDS[c.key].label,
          show: c.show ? 1 : 0,
          width: Math.max(0, Math.min(400, Number(c.width) || 0)),
          align: ["left", "right", "center"].includes(c.align) ? c.align : reg.ITEM_FIELDS[c.key].align
        }));
    }
  }

  db.prepare("UPDATE doc_templates SET name = ?, config = ?, updated_at = ? WHERE id = ?")
    .run(name, JSON.stringify(config), Date.now(), t.id);
  logAction(req, "print.template.update", `${doc ? doc.label : t.doc_type} / ${name}`);
  res.json({ ...db.prepare("SELECT * FROM doc_templates WHERE id = ?").get(t.id), config });
});

/** Set as this document's default. Scoped by doc_type, so making a Challan
 *  template the default cannot disturb the Invoice's. */
router.post("/templates/:id/default", requireRole("owner"), (req, res) => {
  const t = db.prepare("SELECT * FROM doc_templates WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Template not found." });
  db.transaction(() => {
    db.prepare("UPDATE doc_templates SET is_default = 0 WHERE doc_type = ?").run(t.doc_type);
    db.prepare("UPDATE doc_templates SET is_default = 1 WHERE id = ?").run(t.id);
  })();
  logAction(req, "print.template.default", `${t.doc_type} / ${t.name}`);
  res.json(templatesFor(t.doc_type));
});

/**
 * Delete a template.
 *
 * The last template of a document cannot go: something has to print. The
 * default can go, and the oldest survivor takes over rather than leaving
 * the document with no default at all.
 */
router.delete("/templates/:id", requireRole("owner"), (req, res) => {
  const t = db.prepare("SELECT * FROM doc_templates WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Template not found." });
  const total = db.prepare("SELECT COUNT(*) AS n FROM doc_templates WHERE doc_type = ?").get(t.doc_type).n;
  if (total <= 1) {
    return res.status(400).json({ error: "This is the only template for this document — every document needs one." });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM doc_templates WHERE id = ?").run(t.id);
    if (t.is_default) {
      const next = db.prepare(
        "SELECT id FROM doc_templates WHERE doc_type = ? ORDER BY created_at LIMIT 1"
      ).get(t.doc_type);
      if (next) db.prepare("UPDATE doc_templates SET is_default = 1 WHERE id = ?").run(next.id);
    }
  })();
  logAction(req, "print.template.delete", `${t.doc_type} / ${t.name}`);
  res.json(templatesFor(t.doc_type));
});

/* ------------------------------------------------------------------ */
/* search                                                               */
/* ------------------------------------------------------------------ */

/**
 * Finds documents across every available type, built from the registry.
 *
 * Each type contributes one SELECT with a common shape, and the results are
 * merged and sorted by date. A type that lacks a filter's column simply
 * cannot match it — a Quotation has no warehouse, so filtering by warehouse
 * excludes quotations rather than throwing or, worse, ignoring the filter.
 */
router.get("/search", (req, res) => {
  const q = req.query;
  const wantTypes = q.docType && q.docType !== "all"
    ? String(q.docType).split(",").map(s => s.trim()).filter(Boolean)
    : reg.availableDocs().map(d => d.key);

  const rows = [];
  const warnings = [];

  for (const key of wantTypes) {
    const doc = reg.getDoc(key);
    if (!doc) continue;
    if (!doc.available) {
      warnings.push(`${doc.label}: ${doc.unavailableReason}`);
      continue;
    }

    const where = [];
    const params = [];
    if (doc.where) where.push(doc.where);

    if (q.number) { where.push(`d.${doc.numberCol} LIKE ?`); params.push(`%${q.number}%`); }
    if (q.from)   { where.push(`d.${doc.dateCol} >= ?`); params.push(q.from); }
    if (q.to)     { where.push(`d.${doc.dateCol} <= ?`); params.push(q.to); }

    // Party name and mobile both search the joined master, so one box can
    // find "Shree" or "98765" without the user choosing which they typed.
    if (q.party)  { where.push("(p.name LIKE ? OR p.phone LIKE ?)"); params.push(`%${q.party}%`, `%${q.party}%`); }
    if (q.mobile) { where.push("p.phone LIKE ?"); params.push(`%${q.mobile}%`); }

    if (q.salesman) {
      if (!doc.salesmanCol) continue;          // this type cannot match
      where.push(`d.${doc.salesmanCol} LIKE ?`); params.push(`%${q.salesman}%`);
    }
    if (q.locationId) {
      if (!doc.locationCol) continue;
      where.push(`d.${doc.locationCol} = ?`); params.push(q.locationId);
    }
    if (q.areaId) {
      if (!doc.areaCol) continue;
      where.push(`d.${doc.areaCol} = ?`); params.push(q.areaId);
    }
    // Cancelled / Active. A type with no voided column has no cancelled
    // documents, so "cancelled only" correctly returns none of them.
    if (q.status === "cancelled") {
      if (!doc.voidedCol) continue;
      where.push(`d.${doc.voidedCol} = 1`);
    } else if (q.status === "active" && doc.voidedCol) {
      where.push(`d.${doc.voidedCol} = 0`);
    }

    const partyJoin = doc.partyCol
      ? `LEFT JOIN ${doc.partyKind === "supplier" ? "suppliers" : "customers"} p ON p.id = d.${doc.partyCol}`
      : "LEFT JOIN (SELECT NULL AS id, NULL AS name, NULL AS phone) p ON 1 = 0";

    const sql = `
      SELECT d.id AS id,
             d.${doc.numberCol} AS docNo,
             d.${doc.dateCol} AS date,
             ${doc.totalCol ? `d.${doc.totalCol}` : "0"} AS total,
             ${doc.voidedCol ? `d.${doc.voidedCol}` : "0"} AS voided,
             p.name AS partyName, p.phone AS partyPhone
      FROM ${doc.table} d
      ${partyJoin}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY d.${doc.dateCol} DESC
      LIMIT 400
    `;
    let found;
    try {
      found = db.prepare(sql).all(...params);
    } catch (e) {
      // A registry entry pointing at a column that does not exist is a bug
      // worth surfacing, not swallowing into an empty result.
      warnings.push(`${doc.label}: ${e.message}`);
      continue;
    }
    found.forEach(r => rows.push({
      ...r,
      docType: doc.key,
      docTypeLabel: doc.label,
      partyName: r.partyName || "Walk-in",
      cancelled: !!r.voided
    }));
  }

  // Printed / Not printed, applied after the merge so one lookup covers
  // every type rather than a join repeated per document table.
  const printed = new Set(
    db.prepare("SELECT DISTINCT doc_type || '|' || doc_id AS k FROM doc_print_log").all().map(r => r.k)
  );
  let out = rows.map(r => ({ ...r, printed: printed.has(r.docType + "|" + r.id) }));
  if (q.printed === "yes") out = out.filter(r => r.printed);
  else if (q.printed === "no") out = out.filter(r => !r.printed);

  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  res.json({ rows: out.slice(0, 500), total: out.length, warnings });
});

/** Records that a document went out, so Printed / Not Printed means
 *  something. Never blocks the print itself — see the client. */
router.post("/log", (req, res) => {
  const { docType, docId, templateId, method } = req.body;
  if (!docType || !docId) return res.status(400).json({ error: "docType and docId are required." });
  db.prepare(`
    INSERT INTO doc_print_log (doc_type, doc_id, template_id, method, staff_name, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(docType, docId, templateId || null, String(method || "print"),
        (req.session && req.session.staffName) || null, Date.now());
  res.json({ ok: true });
});

module.exports = router;
