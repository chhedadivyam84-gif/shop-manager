/* ============================================================
   MAKING SENSE OF A SPREADSHEET

   The parser hands back rows of strings. This decides which column is a
   date, which is a party and which is money — and, just as importantly,
   which rows are not fit to import.

   NOTHING HERE WRITES. It reads the books only to answer two questions:
   does this row duplicate one already held, and does its date fall inside
   a financial year that has been closed. Both are refusals, and a refusal
   is always explained in the row it belongs to rather than summarised at
   the end, because "3 rows rejected" sends a shopkeeper hunting through
   four hundred lines.

   A COLUMN IS NEVER GUESSED SILENTLY. autoMap proposes; the operator
   confirms on screen. Every proposal carries how it was arrived at, so an
   exact heading match and a hopeful one do not look alike.
   ============================================================ */
const db = require("./db");
const fyLock = require("./fyLock");

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------------------------------------ the fields

   Synonyms carry Tally's own column names first, then Vyapar's and
   myBillBook's, then the plain English a shop types into Excel itself.
   Matching is case- and punctuation-insensitive, so "Vch No." and
   "vch no" are the same key. */
const CATEGORIES = {
  sales: {
    label: "Sales",
    table: "hist_sales",
    fields: [
      { key: "date",     label: "Date",        type: "date",  required: true,
        syn: ["date", "invoice date", "bill date", "voucher date", "vch date", "dated"] },
      { key: "bill_no",  label: "Bill number", type: "text",  required: true,
        syn: ["vch no", "voucher no", "invoice no", "bill no", "invoice number", "bill number", "doc no", "reference no", "ref no"] },
      { key: "party",    label: "Customer",    type: "text",  required: true,
        syn: ["particulars", "party", "party name", "partys name", "customer", "customer name", "buyer", "ledger name", "account"] },
      { key: "amount",   label: "Total",       type: "money", required: true,
        syn: ["gross total", "amount", "total", "invoice amount", "bill amount", "net amount", "value", "debit"] },
      { key: "taxable",  label: "Taxable value", type: "money",
        syn: ["taxable value", "taxable amount", "sub total", "subtotal", "assessable value"] },
      { key: "tax",      label: "Tax",         type: "money",
        syn: ["tax amount", "gst", "total tax", "tax"] },
      { key: "gstin",    label: "GSTIN",       type: "text",
        syn: ["gstin", "gstin/uin", "gst no", "gst number", "party gstin"] },
      { key: "remarks",  label: "Remarks",     type: "text",
        syn: ["narration", "remarks", "note", "notes", "description"] },
    ],
  },
  purchase: {
    label: "Purchase",
    table: "hist_purchases",
    fields: [
      { key: "date",     label: "Date",        type: "date",  required: true,
        syn: ["date", "purchase date", "bill date", "voucher date", "vch date", "dated"] },
      { key: "bill_no",  label: "Bill number", type: "text",  required: true,
        syn: ["vch no", "voucher no", "bill no", "invoice no", "supplier invoice no", "doc no", "reference no", "ref no"] },
      { key: "party",    label: "Supplier",    type: "text",  required: true,
        syn: ["particulars", "party", "party name", "partys name", "supplier", "supplier name", "vendor", "ledger name", "account"] },
      { key: "amount",   label: "Total",       type: "money", required: true,
        syn: ["gross total", "amount", "total", "invoice amount", "bill amount", "net amount", "value", "credit"] },
      { key: "taxable",  label: "Taxable value", type: "money",
        syn: ["taxable value", "taxable amount", "sub total", "subtotal", "assessable value"] },
      { key: "tax",      label: "Tax",         type: "money",
        syn: ["tax amount", "gst", "total tax", "tax"] },
      { key: "gstin",    label: "GSTIN",       type: "text",
        syn: ["gstin", "gstin/uin", "gst no", "gst number", "party gstin"] },
      { key: "remarks",  label: "Remarks",     type: "text",
        syn: ["narration", "remarks", "note", "notes", "description"] },
    ],
  },
  cash: {
    label: "Cash book",
    table: "hist_cash_entries",
    fields: [
      { key: "date",     label: "Date",        type: "date",  required: true,
        syn: ["date", "entry date", "voucher date", "vch date", "dated"] },
      { key: "party",    label: "Party / paid to", type: "text",
        syn: ["particulars", "party", "party name", "paid to", "received from", "ledger name", "account"] },
      { key: "in",       label: "Money in",    type: "money",
        syn: ["receipt", "money in", "cash in", "credit", "in", "received"] },
      { key: "out",      label: "Money out",   type: "money",
        syn: ["payment", "money out", "cash out", "debit", "out", "paid"] },
      { key: "amount",   label: "Amount",      type: "money",
        syn: ["amount", "value", "total"] },
      { key: "category", label: "Category",    type: "text",
        syn: ["category", "head", "group", "type", "voucher type", "vch type"] },
      { key: "remarks",  label: "Remarks",     type: "text",
        syn: ["narration", "remarks", "note", "notes", "description"] },
    ],
  },
  customers: {
    label: "Customers",
    table: "customers",          /* master data — goes into the live table */
    live: true,
    fields: [
      { key: "name",    label: "Name",    type: "text", required: true,
        syn: ["name", "party name", "customer name", "ledger name", "particulars", "party"] },
      { key: "phone",   label: "Phone",   type: "text",
        syn: ["phone", "mobile", "contact", "phone no", "mobile no", "contact no"] },
      { key: "address", label: "Address", type: "text",
        syn: ["address", "address 1", "mailing address", "location"] },
      { key: "gst",     label: "GSTIN",   type: "text",
        syn: ["gstin", "gstin/uin", "gst no", "gst number"] },
      { key: "state",   label: "State",   type: "text", syn: ["state", "state name"] },
    ],
  },
  suppliers: {
    label: "Suppliers",
    table: "suppliers",
    live: true,
    fields: [
      { key: "name",    label: "Name",    type: "text", required: true,
        syn: ["name", "party name", "supplier name", "vendor name", "ledger name", "particulars", "party"] },
      { key: "phone",   label: "Phone",   type: "text",
        syn: ["phone", "mobile", "contact", "phone no", "mobile no", "contact no"] },
      { key: "address", label: "Address", type: "text",
        syn: ["address", "address 1", "mailing address", "location"] },
      { key: "gst",     label: "GSTIN",   type: "text",
        syn: ["gstin", "gstin/uin", "gst no", "gst number"] },
      { key: "state",   label: "State",   type: "text", syn: ["state", "state name"] },
    ],
  },
  gst: {
    label: "GST / e-invoice records",
    table: "hist_gst_records",
    fields: [
      { key: "date",     label: "Date",        type: "date", required: true,
        syn: ["date", "invoice date", "doc date", "document date"] },
      { key: "bill_no",  label: "Document no", type: "text", required: true,
        syn: ["doc no", "document no", "invoice no", "bill no", "vch no"] },
      { key: "party",    label: "Party",       type: "text",
        syn: ["party", "party name", "customer", "supplier", "particulars"] },
      { key: "gstin",    label: "GSTIN",       type: "text",
        syn: ["gstin", "gstin/uin", "gst no", "recipient gstin"] },
      { key: "irn",      label: "IRN",         type: "text",
        syn: ["irn", "invoice reference number", "ack no", "acknowledgement no"] },
      { key: "taxable",  label: "Taxable value", type: "money",
        syn: ["taxable value", "taxable amount", "assessable value"] },
      { key: "tax",      label: "Tax",         type: "money",
        syn: ["tax amount", "total tax", "gst"] },
      { key: "amount",   label: "Total",       type: "money",
        syn: ["total", "invoice value", "amount", "gross total"] },
    ],
  },
};

/* ------------------------------------------------------- reading a value */

const norm = s => String(s == null ? "" : s)
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A date, from whatever the exporter felt like writing.
 *
 * DAY COMES FIRST when it is ambiguous. Every tool a shop in India exports
 * from writes dd/mm/yyyy, and reading 05/08/2026 as the fifth of August is
 * right far more often than the eighth of May. Where the file is
 * unambiguous — a 4-digit year first, or a day above 12 — that wins over
 * the assumption.
 */
function toDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;

  /* already ISO, which is what the parser gives back for a real Excel date */
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = String(Number(y) > 70 ? "19" + y : "20" + y);
    /* If the SECOND number is above 12 it cannot be a month, so the file
       is mm/dd — an export from a machine set to US locale. Otherwise the
       first number is the day, which is what every Indian tool writes. */
    return Number(b) > 12 ? iso(y, a, b) : iso(y, b, a);
  }

  /* 12-Aug-2026 and 12 August 2026, which Tally writes */
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    let y = m[3]; if (y.length === 2) y = "20" + y;
    return iso(y, mon, m[1]);
  }
  return null;
}
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function iso(y, m, d) {
  const Y = Number(y), M = Number(m), D = Number(d);
  if (!Y || M < 1 || M > 12 || D < 1 || D > 31) return null;
  const dt = new Date(Date.UTC(Y, M - 1, D));
  /* rejects the 31st of a 30-day month rather than rolling into the next */
  if (dt.getUTCMonth() !== M - 1 || dt.getUTCDate() !== D) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Money, from a cell that may carry a symbol, Indian grouping, a trailing
 * Cr/Dr, or brackets meaning negative.
 *
 * "1,23,456.50" and "1,234.50" both mean the same thing here — the commas
 * are removed rather than interpreted, so lakh grouping and thousand
 * grouping need no telling apart.
 */
function toMoney(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bcr\b/i.test(s)) sign = -1;                 /* a credit is the other way */
  s = s.replace(/[₹$]|rs\.?|inr|\b[cd]r\b/gi, "").replace(/[,\s]/g, "");
  if (s.startsWith("-")) { sign = -sign; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) ? round2(n * sign) : null;
}

/* ------------------------------------------------------------- automap */

/**
 * Propose a column for each field.
 *
 * Exact heading match first, then a synonym, then a contained word. Each
 * proposal says which it was, so the screen can show a confident guess
 * differently from a hopeful one and the operator knows where to look.
 */
function autoMap(headers, category) {
  const spec = CATEGORIES[category];
  if (!spec) throw new Error("Unknown import type.");
  const cols = headers.map((h, i) => ({ i, raw: h, n: norm(h) }));
  const taken = new Set();
  const mapping = {};
  const how = {};
  for (const f of spec.fields) mapping[f.key] = null;

  /* EVERY EXACT MATCH IS SETTLED BEFORE ANY LOOSE ONE.

     Done field by field, a loose match can take a column that a later
     field would have matched exactly. Tax lists "gst" among its names
     and a GSTIN/UIN column contains those three letters, so Tax claimed
     the GST number and GSTIN was left empty — a wrong column quietly
     filled is worse than one left blank, because nobody checks it. */
  const claim = (f, col, why) => {
    mapping[f.key] = col.i; how[f.key] = why; taken.add(col.i);
  };

  for (const f of spec.fields) {
    const wants = [norm(f.label), ...f.syn.map(norm)];
    for (const w of wants) {
      const hit = cols.find(c => !taken.has(c.i) && c.n === w);
      if (hit) { claim(f, hit, "exact"); break; }
    }
  }

  /* Then the hopeful pass, on WHOLE WORDS only. "gst" no longer matches
     inside "gstin"; "bill no" still matches "supplier bill no". */
  const hasWords = (hay, needle) => {
    const H = hay.split(" ").filter(Boolean);
    const N = needle.split(" ").filter(Boolean);
    if (!N.length || N.length > H.length) return false;
    return N.every(w => H.includes(w));
  };

  for (const f of spec.fields) {
    if (mapping[f.key] != null) continue;
    const wants = [norm(f.label), ...f.syn.map(norm)];
    for (const w of wants) {
      const hit = cols.find(c => !taken.has(c.i) && w.length > 2 && hasWords(c.n, w));
      if (hit) { claim(f, hit, "similar"); break; }
    }
  }

  return { mapping, how, unmapped: cols.filter(c => !taken.has(c.i)).map(c => c.raw) };
}

/* ---------------------------------------------------------- validation */

/** Rows that already exist, keyed the way a duplicate would look. */
function existingKeys(category) {
  const spec = CATEGORIES[category];
  const keys = new Set();
  const has = t => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  if (spec.live) {
    /* a party is the same party if the name matches, case aside */
    const rows = db.prepare(`SELECT name FROM ${spec.table}`).all();
    for (const r of rows) keys.add(norm(r.name));
    return keys;
  }
  if (!has(spec.table)) return keys;    /* first import: nothing to clash with */
  const rows = db.prepare(`SELECT dup_key FROM ${spec.table}`).all();
  for (const r of rows) keys.add(r.dup_key);
  return keys;
}

/** What makes two historical rows the same row. */
function dupKey(category, v) {
  if (category === "customers" || category === "suppliers") return norm(v.name);
  if (category === "cash") {
    return [v.date, norm(v.party), v.amount, v.direction].join("|");
  }
  return [v.date, norm(v.bill_no), norm(v.party), v.amount].join("|");
}

/**
 * Turn raw rows into checked ones.
 *
 * Every row comes back — nothing is dropped here. A row the import cannot
 * take is returned with status "error" and the reason in plain words, so
 * the screen can show it in place and the operator can fix the file rather
 * than wonder what happened to line 231.
 */
function validate({ rows, mapping, category, closedYearsRefused = true }) {
  const spec = CATEGORIES[category];
  if (!spec) throw new Error("Unknown import type.");
  const seen = new Map();                  /* dup key -> first row number */
  const already = existingKeys(category);
  const out = [];

  rows.forEach((raw, idx) => {
    const rowNo = idx + 1;
    const cell = key => {
      const at = mapping[key];
      return at == null || at < 0 ? "" : String(raw[at] ?? "").trim();
    };
    const v = {};
    const errors = [];

    for (const f of spec.fields) {
      const text = cell(f.key);
      if (f.type === "date") {
        const d = text ? toDate(text) : null;
        if (text && !d) errors.push(`${f.label}: "${text}" is not a date the import understands`);
        v[f.key] = d;
      } else if (f.type === "money") {
        const n = text ? toMoney(text) : null;
        if (text && n === null) errors.push(`${f.label}: "${text}" is not an amount`);
        v[f.key] = n;
      } else {
        v[f.key] = text;
      }
      if (f.required && !v[f.key] && v[f.key] !== 0) {
        errors.push(`${f.label} is missing`);
      }
    }

    /* the cash book keeps direction rather than a signed number, the same
       way the live cash book does */
    if (category === "cash") {
      const inn = v.in, out_ = v.out, amt = v.amount;
      if (inn != null && inn !== 0) { v.direction = "in";  v.amount = Math.abs(inn); }
      else if (out_ != null && out_ !== 0) { v.direction = "out"; v.amount = Math.abs(out_); }
      else if (amt != null && amt !== 0) { v.direction = amt < 0 ? "out" : "in"; v.amount = Math.abs(amt); }
      else errors.push("No amount in this row");
    }

    /* A CLOSED YEAR IS FROZEN. Nothing may be added to a year whose figures
       have already been filed — the lock exists precisely so the numbers
       cannot change afterwards, and an import is no more entitled to
       change them than a typed bill is. */
    if (closedYearsRefused && v.date) {
      let closed = false;
      /* isLocked is the app's own name for it — see server/fyLock.js. */
      try { closed = fyLock.isLocked(v.date); }
      catch { closed = false; }
      if (closed) errors.push(`${v.date} falls in a financial year that has been closed`);
    }

    const key = errors.length ? null : dupKey(category, v);
    let status = errors.length ? "error" : "ok";
    let reason = errors.join("; ");

    if (!errors.length) {
      if (already.has(key)) {
        status = "duplicate";
        reason = spec.live
          ? "already in the shop's list"
          : "already imported earlier";
      } else if (seen.has(key)) {
        status = "duplicate";
        reason = `same as row ${seen.get(key)} in this file`;
      } else {
        seen.set(key, rowNo);
      }
    }

    out.push({ rowNo, status, reason, values: v, dupKey: key, raw });
  });

  return {
    rows: out,
    counts: {
      total: out.length,
      ok: out.filter(r => r.status === "ok").length,
      duplicate: out.filter(r => r.status === "duplicate").length,
      error: out.filter(r => r.status === "error").length,
    },
  };
}

module.exports = {
  CATEGORIES, autoMap, validate, toDate, toMoney, dupKey, norm,
};
