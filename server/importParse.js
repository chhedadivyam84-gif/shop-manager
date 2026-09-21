/* ============================================================
   READING A SPREADSHEET

   Tally, Vyapar, myBillBook and Excel itself all export CSV or .xlsx, so
   those are the two this reads. Nothing else is accepted: a format that is
   half-understood produces a file that imports *almost* correctly, and a
   bill that is almost right is worse than one that was refused.

   WRITTEN HERE RATHER THAN INSTALLED. This app has three dependencies and
   no build step, which is the reason it can be handed to a shop as a
   folder. A parser is a fair thing to own: .xlsx is a ZIP of XML, Node 24
   already has the inflater, and the alternative is dragging in a library
   with its own transitive tree to read two file formats.

   IT ONLY EVER READS. Nothing in this file touches the database, and
   nothing it returns has been interpreted as a sale, a party or a rupee —
   that is the mapping step's job. What comes back is rows of strings.
   ============================================================ */
const zlib = require("node:zlib");

/* A shop's year of bills is a few thousand rows. These are generous for
   that and still far below anything that could exhaust the box. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;   /* zip-bomb ceiling */
const MAX_ROWS = 20000;
const MAX_COLS = 200;

/* ------------------------------------------------------------------ CSV */

/**
 * The separator a file actually uses.
 *
 * An Indian export is very often semicolon-separated, because a machine set
 * to a locale that uses the comma as a decimal point cannot also use it to
 * separate fields. Guessing wrong turns every row into one long cell, so
 * this counts candidates outside quotes on the first few lines and takes
 * the winner rather than assuming a comma.
 */
function sniffDelimiter(text) {
  const lines = text.slice(0, 64 * 1024).split(/\r?\n/)
    .filter(l => l.trim() !== "").slice(0, 25);
  if (!lines.length) return null;

  /* CONSISTENCY DECIDES, not frequency, and not the first line.

     A Tally export opens with the shop's name and a report title before
     the real headings, so "whatever the first line uses" is wrong. And
     "whichever character appears most" is wrong too: one remark holding
     three semicolons would outvote the commas that actually separate the
     columns.

     The separator of a table is the one that cuts EVERY line into the same
     number of pieces. Title lines yield one piece whatever you try, so
     they simply do not vote; the body agrees with itself and wins. */
  const count = (line, d) => {
    let n = 1, q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { q = !q; continue; }
      if (!q && c === d) n++;
    }
    return n;
  };

  let best = null, bestScore = 1, bestCols = 1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map(l => count(l, d)).filter(n => n > 1);
    if (counts.length < 2) continue;          /* one line agreeing is a coincidence */
    const tally = new Map();
    for (const n of counts) tally.set(n, (tally.get(n) || 0) + 1);
    let cols = 1, agree = 0;
    for (const [n, howMany] of tally) if (howMany > agree) { agree = howMany; cols = n; }
    /* more lines agreeing wins; ties go to the wider table, since a file
       split into more real columns is the less likely coincidence */
    if (agree > bestScore || (agree === bestScore && cols > bestCols)) {
      best = d; bestScore = agree; bestCols = cols;
    }
  }
  return best;
}

/**
 * CSV, by the RFC's rules: a field may be quoted, a quoted field may hold
 * the delimiter, a newline, or a doubled quote meaning one quote.
 *
 * Hand-rolled as a character scan rather than a regex because a regex that
 * handles embedded newlines correctly is unreadable, and this is the part
 * where being wrong costs a bill.
 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   /* Excel's BOM */
  const delim = sniffDelimiter(text);
  const rows = [];
  let row = [], field = "", inQuotes = false, truncated = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (delim !== null && c === delim) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field); field = "";
      if (row.length > MAX_COLS) row = row.slice(0, MAX_COLS);
      rows.push(row); row = [];
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      continue;
    }
    field += c;
  }
  if (!truncated && (field.length || row.length)) { row.push(field); rows.push(row); }

  return { rows, delimiter: delim, truncated };
}

/* ----------------------------------------------------------------- XLSX */

/* .xlsx is a ZIP. Only the local file headers are read — the central
   directory is the tidier route but a sheet is always present as a local
   entry, and this way one malformed trailer cannot hide the whole book. */
function unzip(buf) {
  const files = new Map();
  let total = 0;
  for (let i = 0; i + 4 <= buf.length;) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }   /* PK\x03\x04 */
    const method = buf.readUInt16LE(i + 8);
    const flags = buf.readUInt16LE(i + 6);
    let compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nameAt = i + 30;
    const name = buf.toString("utf8", nameAt, nameAt + nameLen);
    const dataAt = nameAt + nameLen + extraLen;

    /* Bit 3 says the sizes live in a trailing descriptor instead of the
       header — written by streaming producers. Rather than hunt for the
       descriptor, inflate to the end of the buffer and let the inflater
       stop itself at the end of the stream. */
    const streamed = (flags & 0x08) !== 0 || compSize === 0;
    const end = streamed ? buf.length : dataAt + compSize;
    if (dataAt >= buf.length) break;

    let data;
    try {
      data = method === 0
        ? buf.subarray(dataAt, end)
        : zlib.inflateRawSync(buf.subarray(dataAt, end), { maxOutputLength: MAX_UNZIPPED_BYTES });
    } catch { i = dataAt; continue; }

    total += data.length;
    if (total > MAX_UNZIPPED_BYTES) throw new Error("That file expands to far more than expected and was not read.");
    if (!files.has(name)) files.set(name, data);
    i = streamed ? dataAt + 1 : end;   /* streamed: rescan for the next header */
  }
  return files;
}

/* The five entities XML defines, and numeric escapes. Nothing else is
   expanded — a spreadsheet has no business declaring an entity, and
   honouring one is how an XML parser gets talked into reading /etc/passwd. */
function xmlText(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A1 -> 0, B1 -> 1, AA1 -> 26. */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Shared strings, in the order the sheet refers to them by number. */
function sharedStrings(files) {
  const raw = files.get("xl/sharedStrings.xml");
  if (!raw) return [];
  const xml = raw.toString("utf8");
  const out = [];
  /* An <si> may hold one <t>, or several inside <r> runs when part of the
     cell was formatted differently. Both are the same string to us. */
  const si = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = si.exec(xml))) {
    let text = "";
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = t.exec(m[1]))) text += tm[1];
    out.push(xmlText(text));
  }
  return out;
}

/* Excel keeps a date as a day count from 1899-12-30, and marks the cell
   with a number format rather than a type. Formats 14-22 and 45-47 are the
   built-in date and time ones; anything custom containing y/m/d counts too. */
function dateFormatIds(files) {
  const raw = files.get("xl/styles.xml");
  const ids = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const custom = new Set();
  if (raw) {
    const xml = raw.toString("utf8");
    const nf = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
    let m;
    while ((m = nf.exec(xml))) {
      const code = xmlText(m[2]).replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
      if (/[ymdYMD]/.test(code) && !/[#0]/.test(code)) custom.add(Number(m[1]));
    }
    /* cellXfs maps a cell's style index to a number format id. */
    const xfs = xml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
    if (xfs) {
      const list = [...xfs[0].matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*>/g)].map(x => Number(x[1]));
      return { styleToFmt: list, dateFmts: new Set([...ids, ...custom]) };
    }
  }
  return { styleToFmt: [], dateFmts: new Set([...ids, ...custom]) };
}

function serialToISO(n) {
  /* 1899-12-30 is the epoch Excel behaves as if it uses, because of the
     1900 leap-year bug it keeps for compatibility with Lotus. */
  const ms = Math.round((Number(n) - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d)) return String(n);
  return d.toISOString().slice(0, 10);
}

/** The sheets in the book, in the order the workbook lists them. */
function sheetList(files) {
  const wb = files.get("xl/workbook.xml");
  const rels = files.get("xl/_rels/workbook.xml.rels");
  if (!wb) return [];
  const relMap = new Map();
  if (rels) {
    const r = rels.toString("utf8");
    for (const m of r.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      relMap.set(m[1], m[2].replace(/^\/?xl\//, "").replace(/^\//, ""));
    }
  }
  const out = [];
  const xml = wb.toString("utf8");
  for (const m of xml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
    const target = relMap.get(m[2]);
    out.push({ name: xmlText(m[1]), path: target ? "xl/" + target : null });
  }
  if (!out.length) {
    /* A book written without relationship ids still has sheet1.xml. */
    for (const key of files.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(key)) out.push({ name: key, path: key });
    }
  }
  return out.filter(s => s.path && files.has(s.path));
}

function parseSheet(files, path, strings, styles) {
  const xml = files.get(path).toString("utf8");
  const rows = [];
  let truncated = false;

  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || "";
      const body = cm[2] || "";
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || "n";
      const styleIdx = Number((attrs.match(/s="(\d+)"/) || [])[1] || -1);

      let value = "";
      if (type === "inlineStr") {
        let t = "";
        for (const tm of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) t += tm[1];
        value = xmlText(t);
      } else {
        const v = (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v === undefined) value = "";
        else if (type === "s") value = strings[Number(v)] ?? "";
        else if (type === "str" || type === "e") value = xmlText(v);
        else {
          /* a plain number — unless its style says it is a date */
          const fmt = styleIdx >= 0 ? styles.styleToFmt[styleIdx] : undefined;
          value = (fmt !== undefined && styles.dateFmts.has(fmt) && Number(v) > 0)
            ? serialToISO(v) : xmlText(v);
        }
      }
      const at = ref !== undefined ? colIndex(ref) : cells.length;
      if (at >= MAX_COLS) continue;
      while (cells.length < at) cells.push("");   /* blanks are skipped in the XML */
      cells[at] = value;
    }
    rows.push(cells);
  }
  return { rows, truncated };
}

function parseXlsx(buf, sheetName) {
  const files = unzip(buf);
  if (!files.size) throw new Error("That file could not be opened as a spreadsheet.");
  const sheets = sheetList(files);
  if (!sheets.length) throw new Error("That workbook has no readable sheet in it.");

  const want = sheetName ? sheets.find(s => s.name === sheetName) : sheets[0];
  if (!want) throw new Error(`The workbook has no sheet called "${sheetName}".`);

  const strings = sharedStrings(files);
  const styles = dateFormatIds(files);
  const { rows, truncated } = parseSheet(files, want.path, strings, styles);
  return { rows, truncated, sheet: want.name, sheets: sheets.map(s => s.name) };
}

/* ---------------------------------------------------------------- entry */

/** Drop wholly empty rows, and square the grid off to the widest row so a
 *  short line does not look like a missing column later. */
function tidy(rows) {
  const kept = rows.filter(r => r.some(c => String(c ?? "").trim() !== ""));
  const width = kept.reduce((w, r) => Math.max(w, r.length), 0);
  return kept.map(r => {
    const out = r.map(c => String(c ?? "").trim());
    while (out.length < width) out.push("");
    return out;
  });
}

/**
 * Read a file into a header row and data rows.
 *
 * `headerRow` is an index into the tidied rows, because exports very often
 * open with a title line, the shop's name and a blank before the real
 * headings — Tally's do. The caller decides which line it is after seeing
 * the first few; nothing here guesses.
 */
function readFile({ filename, buffer, sheet, headerRow = 0 }) {
  if (!Buffer.isBuffer(buffer)) throw new Error("No file was received.");
  if (!buffer.length) throw new Error("That file is empty.");
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`That file is larger than ${Math.round(MAX_FILE_BYTES / 1048576)}MB. Split it and import the parts.`);
  }

  const name = String(filename || "").toLowerCase();
  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
  const looksXlsx = name.endsWith(".xlsx") || name.endsWith(".xlsm") || isZip;

  if (name.endsWith(".xls") && !isZip) {
    throw new Error("That is the older .xls format. Open it in Excel and save as .xlsx or CSV.");
  }

  let parsed;
  if (looksXlsx) {
    parsed = parseXlsx(buffer, sheet);
  } else {
    /* A file the app cannot read must be refused, not parsed into nonsense.
       Text does not contain NUL; binary nearly always does in its first few
       kilobytes, and that is the cheapest honest test available. */
    if (buffer.subarray(0, 8192).includes(0)) {
      throw new Error("That does not look like a CSV or Excel file.");
    }
    const text = buffer.toString("utf8");
    const csv = parseCsv(text);
    parsed = { rows: csv.rows, truncated: csv.truncated, sheet: null, sheets: [],
               delimiter: csv.delimiter };
  }

  const rows = tidy(parsed.rows);
  if (!rows.length) throw new Error("There are no rows in that file.");

  const hr = Math.max(0, Math.min(Number(headerRow) || 0, rows.length - 1));
  const headers = rows[hr].map((h, i) => String(h || "").trim() || `Column ${i + 1}`);
  const data = rows.slice(hr + 1);

  return {
    headers,
    rows: data,
    rowCount: data.length,
    headerRow: hr,
    /* the first lines as-is, so the screen can show what it is looking at
       and let the operator point at the real heading row */
    firstLines: rows.slice(0, Math.min(8, rows.length)),
    sheet: parsed.sheet,
    sheets: parsed.sheets,
    delimiter: parsed.delimiter || null,
    truncated: parsed.truncated,
    limits: { maxRows: MAX_ROWS, maxFileBytes: MAX_FILE_BYTES },
  };
}

module.exports = {
  readFile, parseCsv, parseXlsx, sniffDelimiter, serialToISO,
  MAX_FILE_BYTES, MAX_ROWS,
};
