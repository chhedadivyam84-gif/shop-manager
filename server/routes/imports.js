/* ============================================================
   HISTORICAL IMPORT — the API

   Owner only. This reads a shop's whole past off a spreadsheet and writes
   it into the books; it is not a counter job, and it deliberately does not
   add a new row to the Staff Access screen — the existing screen is not
   this module's to change.

   UPLOAD, THEN LOOK, THEN CHOOSE, THEN WRITE. Four separate requests, and
   the only one that writes anything is the last. A file that has been read
   has changed nothing, and a preview can be asked for as many times as the
   operator likes while they get the column mapping right.

   THE PARSED FILE IS HELD IN MEMORY, NOT ON DISK AND NOT IN THE DATABASE.
   It is scratch: the operator may reject the whole thing. Writing it to
   disk would leave a shop's turnover lying in a temp folder, and putting
   it in the database would mean a half-done import looked like a done one.
   It expires on its own, and it belongs to the session and the company
   that uploaded it — see COMPANY, below.

   COMPANY. Isolation in this app is physical: one SQLite file per company,
   chosen by the request's own scope. No route here accepts a company id
   from the caller, so there is nothing to forge. The id is recorded at
   upload only so a held file cannot be replayed into a DIFFERENT company
   if the operator switches shops in another tab.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, logAction } = require("../util");
const { requireRole } = require("../auth");
const parse = require("../importParse");
const M = require("../importMap");
const R = require("../importRun");

const router = express.Router();
router.use(requireRole("owner"));

/* ------------------------------------------------------- the held file */

const HELD = new Map();
const HOLD_MS = 30 * 60 * 1000;
const MAX_HELD = 12;

function sweep() {
  const cutoff = Date.now() - HOLD_MS;
  for (const [id, u] of HELD) if (u.at < cutoff) HELD.delete(id);
  /* A cap as well as a clock: a shop uploading file after file without
     importing must not be able to fill the box. */
  while (HELD.size > MAX_HELD) HELD.delete(HELD.keys().next().value);
}

function hold(req, data) {
  sweep();
  const id = uid("UP");
  HELD.set(id, {
    at: Date.now(),
    sid: req.sessionID || "",
    companyId: db.companies.currentId(),
    ...data,
  });
  return id;
}

/** The held file, or a refusal that says which of the three reasons it is. */
function take(req, uploadId) {
  sweep();
  const u = HELD.get(String(uploadId || ""));
  if (!u) throw new Error("That file is no longer held — upload it again.");
  if (u.sid !== (req.sessionID || "")) throw new Error("That file belongs to another session.");
  if (u.companyId !== db.companies.currentId()) {
    throw new Error("That file was read for a different company. Upload it again in this one.");
  }
  return u;
}

/* ------------------------------------------------------------- reading */

/** The field list each category expects, so the mapping screen can be built
 *  from the same definitions the validator uses rather than a second copy. */
router.get("/categories", (req, res) => {
  res.json(Object.entries(M.CATEGORIES).map(([key, c]) => ({
    key, label: c.label, live: !!c.live,
    fields: c.fields.map(f => ({ key: f.key, label: f.label, type: f.type, required: !!f.required })),
  })));
});

/**
 * Read a file. Writes nothing, anywhere.
 *
 * The body carries the file base64-encoded, the same way attachments
 * already arrive — this app has no multipart handling and adding one for
 * a single screen would be a new dependency for no gain.
 */
router.post("/read", (req, res) => {
  const b = req.body || {};
  if (!b.dataBase64) return res.status(400).json({ error: "No file was received." });

  let buffer;
  try { buffer = Buffer.from(String(b.dataBase64), "base64"); }
  catch { return res.status(400).json({ error: "That file could not be decoded." }); }

  let file;
  try {
    file = parse.readFile({
      filename: b.filename, buffer,
      sheet: b.sheet, headerRow: b.headerRow,
    });
  } catch (err) {
    /* The operator's own words back at them; nothing about the contents is
       logged, which is the rule for a file full of a shop's turnover. */
    return res.status(400).json({ error: err.message });
  }

  const category = M.CATEGORIES[b.category] ? b.category : null;
  const auto = category ? M.autoMap(file.headers, category) : null;

  const uploadId = hold(req, {
    filename: String(b.filename || "file"),
    headers: file.headers,
    rows: file.rows,
  });

  logAction(req, "import.read", `${b.filename || "file"}: ${file.rowCount} row(s)`);
  res.json({
    uploadId,
    filename: String(b.filename || "file"),
    headers: file.headers,
    rowCount: file.rowCount,
    headerRow: file.headerRow,
    firstLines: file.firstLines,
    sheet: file.sheet, sheets: file.sheets,
    delimiter: file.delimiter,
    truncated: file.truncated,
    limits: file.limits,
    /* the first handful, so the screen can show what it is looking at
       before anyone has chosen a category */
    sample: file.rows.slice(0, 5),
    mapping: auto ? auto.mapping : null,
    how: auto ? auto.how : null,
    unmapped: auto ? auto.unmapped : null,
  });
});

/* ----------------------------------------------------------- filtering

   Applied AFTER validation, never before: a row that fails to read must
   still be visible when the operator narrows to the week it is in, or it
   looks as though the file simply had fewer rows than it does. */
function applyFilters(rows, f) {
  if (!f) return rows;
  const q = String(f.q || "").trim().toLowerCase();
  const party = String(f.party || "").trim().toLowerCase();
  const bill = String(f.billNo || "").trim().toLowerCase();
  const from = String(f.from || "").trim();
  const to = String(f.to || "").trim();
  const only = String(f.status || "").trim();

  return rows.filter(r => {
    const v = r.values || {};
    if (only && r.status !== only) return false;
    if (from && (!v.date || v.date < from)) return false;
    if (to && (!v.date || v.date > to)) return false;
    if (party && !String(v.party || v.name || "").toLowerCase().includes(party)) return false;
    if (bill && !String(v.bill_no || "").toLowerCase().includes(bill)) return false;
    if (q) {
      /* the raw line too, so a search finds a word in a column nobody
         mapped — which is often exactly how an operator hunts a row */
      const hay = [...Object.values(v), ...(r.raw || [])].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Check a held file against a category and a mapping.
 *
 * Returns a page of rows plus the counts for the WHOLE file, because the
 * summary must describe the import, not the page being looked at.
 */
router.post("/preview", (req, res) => {
  const b = req.body || {};
  let u;
  try { u = take(req, b.uploadId); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  if (!M.CATEGORIES[b.category]) return res.status(400).json({ error: "Choose what this file holds." });

  let checked;
  try {
    checked = M.validate({
      rows: u.rows,
      mapping: b.mapping || {},
      category: b.category,
      closedYearsRefused: true,
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }

  const filtered = applyFilters(checked.rows, b.filters);
  const page = Math.max(0, Number(b.page) || 0);
  const size = Math.min(Math.max(Number(b.pageSize) || 100, 10), 500);

  res.json({
    counts: checked.counts,
    filtered: {
      total: filtered.length,
      ok: filtered.filter(r => r.status === "ok").length,
      duplicate: filtered.filter(r => r.status === "duplicate").length,
      error: filtered.filter(r => r.status === "error").length,
    },
    /* the row numbers the current filter covers, so "select all" means all
       of what is on screen rather than all of the file */
    rowNos: filtered.map(r => r.rowNo),
    page, pageSize: size,
    rows: filtered.slice(page * size, page * size + size).map(r => ({
      rowNo: r.rowNo, status: r.status, reason: r.reason, values: r.values, raw: r.raw,
    })),
  });
});

/* ------------------------------------------------------------- writing */

router.post("/run", (req, res) => {
  const b = req.body || {};
  let u;
  try { u = take(req, b.uploadId); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  if (!M.CATEGORIES[b.category]) return res.status(400).json({ error: "Choose what this file holds." });
  const take_ = Array.isArray(b.take) ? b.take.map(Number).filter(n => n > 0) : [];
  if (!take_.length) return res.status(400).json({ error: "Nothing was selected to import." });

  let checked;
  try {
    /* VALIDATED AGAIN, SERVER-SIDE, IMMEDIATELY BEFORE WRITING. The
       preview the operator approved was a separate request; between the
       two, a party may have been added or a year closed. The screen's
       verdict is never the one that decides — this one is. */
    checked = M.validate({
      rows: u.rows, mapping: b.mapping || {}, category: b.category,
      closedYearsRefused: true,
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }

  let out;
  try {
    out = R.run({
      category: b.category,
      filename: u.filename,
      rows: checked.rows,
      take: take_,
      mapping: b.mapping || {},
      staff: (req.session && req.session.staffName) || "",
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }

  logAction(req, "import.run",
    `${b.category} from ${u.filename}: ${out.counts.imported} imported, ` +
    `${out.counts.duplicate} duplicate, ${out.counts.error} rejected`);

  /* The file is done with. Holding it after a successful import invites a
     second run of the same rows. */
  HELD.delete(String(b.uploadId));
  res.status(201).json(out);
});

/* ------------------------------------------------------------- history */

router.get("/history", (req, res) => {
  res.json({ batches: R.listBatches(req.query.limit) });
});

router.get("/history/:id", (req, res) => {
  const d = R.batchDetail(req.params.id, req.query.limit);
  if (!d) return res.status(404).json({ error: "That import was not found." });
  res.json(d);
});

router.post("/history/:id/reverse", (req, res) => {
  let r;
  try { r = R.reverse(req.params.id, (req.session && req.session.staffName) || ""); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  logAction(req, "import.reverse", `${req.params.id}: ${r.removed} removed, ${r.kept} kept`);
  res.json(r);
});

module.exports = router;
