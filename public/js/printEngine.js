/* ============================================================
   PRINT ENGINE
   One renderer for every tabular report in the app.

   A report does not describe how it should look. It describes WHAT it is —
   a title, a period, the filters that produced it, its columns and its rows —
   and this file turns that into a printed sheet, a PDF, an .xlsx or a .csv.

   The point is that there is exactly one place where page margins, the
   company letterhead, page numbering, column alignment, page breaks and
   repeated headings are decided. Before this existed there were eleven
   hand-rolled print functions, each subtly different and each needing the
   same bug fixed separately.

   A report declaration looks like:

     {
       id:      "stock-report",          // stable — saved preferences key off it
       title:   "Stock Report",
       period:  { from: "2026-04-01", to: "2026-06-30" },   // optional
       filters: ["Brand: VOX", "Location: Shop"],           // optional
       columns: [
         { key:"name",  label:"Product",  width:20 },
         { key:"qty",   label:"Qty",      width:8,  align:"right", type:"number" },
         { key:"rate",  label:"Rate",     width:10, align:"right", type:"money", rate:true },
       ],
       rows:    [ {name:"…", qty:5, rate:250}, … ],
       totals:  { qty:5, rate:250 },       // optional, keyed by column
       landscape: true                      // default orientation hint
     }

   `width` values are relative and get normalised to 100%, so a report can
   express "this column deserves twice the room" without doing arithmetic.

   Columns marked `rate:true` are the ones that empty out in Without Rate
   mode. They are left BLANK there, never zero — a printed 0.00 next to a
   customer's goods reads as "free", which is the opposite of "not shown".
   ============================================================ */
(function (global) {
  "use strict";

  /* Paper sizes in CSS pixels at 96dpi, portrait, before margins. */
  const PAPER = {
    A4: { w: 794, h: 1123, label: "A4" },
    A5: { w: 559, h: 794, label: "A5" }
  };
  const MARGIN_PRESETS = { narrow: 6, normal: 10, wide: 16 }; // mm

  const MM_PX = 96 / 25.4;

  /* Shrinking past this stops being useful — the type is smaller than about
     3.5pt and unreadable at arm's length. Beyond it the report paginates
     instead, which is honest rather than pretty. */
  const MIN_SCALE = 0.62;

  const DEFAULTS = {
    paper: "A4",
    landscape: null,      // null = follow the report's own hint
    margin: "normal",
    header: true,
    footer: true,
    logo: true,
    withRate: true,
    fit: "auto",          // auto = one page if it can be read, else paginate
    hidden: []            // column keys the user switched off
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtMoney(n) {
    const v = Number(n) || 0;
    return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNumber(n) {
    const v = Number(n) || 0;
    return (Math.round(v * 1000) / 1000).toLocaleString("en-IN");
  }
  function fmtDate(d) {
    if (!d) return "";
    const t = new Date(String(d).length <= 10 ? d + "T00:00:00" : d);
    return isNaN(t) ? String(d) : t.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  /* The printed value of one cell. Returns "" — not "0" — for a rate column
     that has been switched off, and for genuinely empty values. */
  function cellText(col, row, opts) {
    if (col.rate && !opts.withRate) return "";
    let v = typeof col.value === "function" ? col.value(row) : row[col.key];
    if (v === null || v === undefined || v === "") return "";
    switch (col.type) {
      case "money":  return fmtMoney(v);
      case "number": return fmtNumber(v);
      case "date":   return fmtDate(v);
      default:       return String(v);
    }
  }

  function visibleColumns(doc, opts) {
    return doc.columns.filter(c => opts.hidden.indexOf(c.key) === -1);
  }

  /* ---------------------------------------------------------------- prefs */

  function loadPrefs(reportId) {
    let all = {};
    try {
      const raw = (global.__printPrefsSource && global.__printPrefsSource()) || "{}";
      all = JSON.parse(raw) || {};
    } catch (e) { all = {}; }
    return Object.assign({}, DEFAULTS, all[reportId] || {});
  }

  function savePrefs(reportId, opts) {
    if (typeof global.__printPrefsSave !== "function") return;
    let all = {};
    try { all = JSON.parse((global.__printPrefsSource && global.__printPrefsSource()) || "{}") || {}; }
    catch (e) { all = {}; }
    all[reportId] = opts;
    global.__printPrefsSave(JSON.stringify(all));
  }

  /* ---------------------------------------------------------------- header */

  function shopHeaderHtml(cfg, opts) {
    if (!opts.header) return "";
    const logo = opts.logo && cfg.logo_data
      ? `<img src="${esc(cfg.logo_data)}" class="pe-logo" alt="">` : "";
    const contact = [
      cfg.gstin ? "GSTIN: " + esc(cfg.gstin) : "",
      cfg.phones ? "Ph: " + esc(cfg.phones) : "",
      cfg.email ? esc(cfg.email) : ""
    ].filter(Boolean).join("  |  ");
    return `
      <div class="pe-letterhead">
        ${logo}
        <div class="pe-shop">
          <div class="pe-shop-name">${esc(cfg.business_name || "")}</div>
          ${cfg.address ? `<div class="pe-shop-line">${esc(cfg.address)}</div>` : ""}
          ${contact ? `<div class="pe-shop-line">${contact}</div>` : ""}
        </div>
      </div>`;
  }

  function metaHtml(doc, opts) {
    const bits = [];
    if (doc.period && (doc.period.from || doc.period.to)) {
      bits.push("Period: " + (doc.period.from ? fmtDate(doc.period.from) : "Start")
        + " to " + (doc.period.to ? fmtDate(doc.period.to) : "Date"));
    }
    bits.push("Printed: " + new Date().toLocaleString("en-IN"));
    if (!opts.withRate) bits.push("WITHOUT RATE");
    const filters = (doc.filters || []).length
      ? `<div class="pe-filters"><b>Filters:</b> ${doc.filters.map(esc).join(" &nbsp;|&nbsp; ")}</div>` : "";
    return `
      <div class="pe-title">${esc(doc.title || "Report")}</div>
      <div class="pe-meta">${bits.map(esc).join(" &nbsp;·&nbsp; ")}</div>
      ${filters}`;
  }

  /* ---------------------------------------------------------------- table */

  function tableHtml(doc, opts) {
    const cols = visibleColumns(doc, opts);
    const totalWidth = cols.reduce((s, c) => s + (c.width || 10), 0) || 1;
    const colgroup = `<colgroup>${cols.map(c =>
      `<col style="width:${((c.width || 10) / totalWidth * 100).toFixed(3)}%">`).join("")}</colgroup>`;

    const head = `<thead><tr>${cols.map(c =>
      `<th class="${c.align === "right" ? "pe-r" : c.align === "center" ? "pe-c" : ""}">${esc(c.label)}</th>`
    ).join("")}</tr></thead>`;

    const body = `<tbody>${doc.rows.map(row =>
      `<tr>${cols.map(c => {
        const cls = c.align === "right" ? "pe-r" : c.align === "center" ? "pe-c" : "";
        return `<td class="${cls}">${esc(cellText(c, row, opts))}</td>`;
      }).join("")}</tr>`
    ).join("")}</tbody>`;

    let foot = "";
    if (doc.totals) {
      foot = `<tfoot><tr>${cols.map((c, i) => {
        const cls = c.align === "right" ? "pe-r" : c.align === "center" ? "pe-c" : "";
        if (i === 0) return `<td class="${cls}">Total — ${doc.rows.length} line${doc.rows.length !== 1 ? "s" : ""}</td>`;
        if (!(c.key in doc.totals)) return `<td class="${cls}"></td>`;
        if (c.rate && !opts.withRate) return `<td class="${cls}"></td>`;
        return `<td class="${cls}">${esc(
          c.type === "money" ? fmtMoney(doc.totals[c.key]) : fmtNumber(doc.totals[c.key])
        )}</td>`;
      }).join("")}</tr></tfoot>`;
    }
    return `<table class="pe-table">${colgroup}${head}${body}${foot}</table>`;
  }

  function sheetCss(dims, opts) {
    return `
      @page peReport { size: ${dims.pageW}mm ${dims.pageH}mm; margin: ${dims.marginMm}mm; }
      #fs-print-engine{ page: peReport; }
      #pe-content{ font-family: Arial, Helvetica, sans-serif; color:#000; }
      #pe-content .pe-letterhead{
        display:flex; align-items:center; gap:10px;
        border-bottom:2px solid #000; padding-bottom:6px; margin-bottom:8px;
      }
      #pe-content .pe-logo{ height:42px; width:auto; object-fit:contain; }
      #pe-content .pe-shop{ flex:1; text-align:center; }
      #pe-content .pe-shop-name{ font-size:17px; font-weight:800; letter-spacing:.3px; }
      #pe-content .pe-shop-line{ font-size:9.5px; color:#222; margin-top:1px; }
      #pe-content .pe-title{ font-size:13px; font-weight:800; margin-top:2px; }
      #pe-content .pe-meta{ font-size:9px; color:#333; margin-top:1px; }
      #pe-content .pe-filters{ font-size:9px; margin-top:3px; margin-bottom:5px; }
      #pe-content table.pe-table{
        width:100%; table-layout:fixed; border-collapse:collapse; font-size:${dims.font}px;
      }
      #pe-content .pe-table th, #pe-content .pe-table td{
        border:1px solid #000; padding:${dims.pad}px 3px; text-align:left;
        overflow-wrap:break-word; word-break:break-word; vertical-align:top;
      }
      #pe-content .pe-table th{ background:#eee; font-weight:700; }
      #pe-content .pe-table tbody td{ line-height:1.15; }
      #pe-content .pe-r{ text-align:right; }
      #pe-content .pe-c{ text-align:center; }
      #pe-content .pe-table tfoot td{ font-weight:700; background:#f2f2f2; }
      /* Headings repeat on every sheet, and a row is never sliced in half by
         a page break — half a row of figures is worse than none. */
      #pe-content thead{ display:table-header-group; }
      #pe-content tfoot{ display:table-footer-group; }
      #pe-content tr{ page-break-inside:avoid; }
      #pe-scale{ transform-origin: top left; }
      #pe-content .pe-footer{
        margin-top:6px; padding-top:4px; border-top:1px solid #999;
        font-size:8.5px; color:#333; display:flex; justify-content:space-between;
      }
    `;
  }

  /** Page geometry for the chosen paper, orientation and margins. */
  function geometry(opts, doc) {
    const paper = PAPER[opts.paper] || PAPER.A4;
    const landscape = opts.landscape === null
      ? !!doc.landscape
      : !!opts.landscape;
    const marginMm = MARGIN_PRESETS[opts.margin] != null ? MARGIN_PRESETS[opts.margin] : 10;
    const wPx = landscape ? paper.h : paper.w;
    const hPx = landscape ? paper.w : paper.h;
    const mPx = marginMm * MM_PX;
    // A5 is half the area of A4, so it needs smaller type to hold the same
    // number of columns without wrapping every cell into a tower.
    const font = opts.paper === "A5" ? 6.5 : 7.5;
    return {
      landscape,
      marginMm,
      pageW: Math.round((landscape ? 297 : 210) * (opts.paper === "A5" ? 0.707 : 1)),
      pageH: Math.round((landscape ? 210 : 297) * (opts.paper === "A5" ? 0.707 : 1)),
      innerW: wPx - mPx * 2,
      innerH: hPx - mPx * 2,
      font,
      pad: opts.paper === "A5" ? 1 : 1.5
    };
  }

  /* ---------------------------------------------------------------- render */

  function renderSheet(doc, opts, cfg) {
    const dims = geometry(opts, doc);
    const footer = opts.footer
      ? `<div class="pe-footer"><span>${esc(cfg.business_name || "")} — ${esc(doc.title || "")}</span>
         <span>Page 1</span></div>`
      : "";
    return {
      dims,
      html: `<style>${sheetCss(dims, opts)}</style>
        <div id="pe-scale">
          ${shopHeaderHtml(cfg, opts)}
          ${metaHtml(doc, opts)}
          ${tableHtml(doc, opts)}
          ${footer}
        </div>`
    };
  }

  /* ---------------------------------------------------------------- CSV */

  function toCsv(doc, opts) {
    const cols = visibleColumns(doc, opts);
    const q = v => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(c => q(c.label)).join(",")];
    doc.rows.forEach(row => {
      lines.push(cols.map(c => {
        if (c.rate && !opts.withRate) return "";
        // Raw values, not the formatted ones: a CSV is for loading into
        // something else, and "1,234.00" would arrive as two columns.
        const v = typeof c.value === "function" ? c.value(row) : row[c.key];
        return q(v == null ? "" : v);
      }).join(","));
    });
    if (doc.totals) {
      lines.push("");
      lines.push(cols.map((c, i) => {
        if (i === 0) return q("Total (" + doc.rows.length + " lines)");
        if (c.rate && !opts.withRate) return "";
        return c.key in doc.totals ? q(doc.totals[c.key]) : "";
      }).join(","));
    }
    (doc.filters || []).forEach(f => lines.push(q("Filter: " + f)));
    return lines.join("\r\n");
  }

  /* ---------------------------------------------------------------- PDF
     Drawn with jsPDF's text APIs, never html2canvas — the output has to be
     real selectable, searchable text, not a picture of a table. */

  function toPdf(doc, opts, cfg) {
    const JsPDF = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
    if (!JsPDF) throw new Error("jsPDF not loaded");

    const dims = geometry(opts, doc);
    const pdf = new JsPDF({
      orientation: dims.landscape ? "landscape" : "portrait",
      unit: "mm",
      format: (opts.paper || "A4").toLowerCase()
    });

    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const m = dims.marginMm;
    const usableW = pw - m * 2;
    const cols = visibleColumns(doc, opts);
    const totalWidth = cols.reduce((s, c) => s + (c.width || 10), 0) || 1;
    const colW = cols.map(c => (c.width || 10) / totalWidth * usableW);

    let FONT = opts.paper === "A5" ? 5.2 : 6.2;
    let LINE = FONT * 0.42;        // mm per wrapped line
    let CELL_PAD = 0.8;

    /* Measure the whole document before drawing a single line, so the PDF can
       make the same fit-on-one-page decision the HTML preview made. Without
       this the preview would promise one page and the PDF would quietly
       deliver two — the two must not disagree about the same report. */
    if (opts.fit === "auto") {
      const chromeH = (opts.header ? 22 : 0) + 14; // letterhead + title block
      const measure = (f) => {
        const ln = f * 0.42;
        let h = chromeH + ln + 1.6;                // header row
        doc.rows.forEach(row => {
          pdf.setFontSize(f);
          const lines = Math.max(1, ...cols.map((c, i) =>
            pdf.splitTextToSize(cellText(c, row, opts), colW[i] - 1.6).length));
          h += lines * ln + 1.6;
        });
        if (doc.totals) h += ln + 1.6;
        return h;
      };
      const avail = ph - m * 2 - 4;
      const needed = measure(FONT);
      if (needed > avail) {
        const scale = Math.max(MIN_SCALE, avail / needed);
        if (avail / needed >= MIN_SCALE) {
          FONT = FONT * scale; LINE = FONT * 0.42; CELL_PAD = 0.8 * scale;
        }
      }
    }

    let y = m;
    let pageNo = 0;

    function drawLetterhead() {
      if (!opts.header) return;
      let top = y;
      if (opts.logo && cfg.logo_data) {
        try { pdf.addImage(cfg.logo_data, "PNG", m, top, 14, 14); } catch (e) { /* skip a bad logo */ }
      }
      pdf.setFont("helvetica", "bold").setFontSize(12);
      pdf.text(String(cfg.business_name || ""), pw / 2, top + 5, { align: "center" });
      pdf.setFont("helvetica", "normal").setFontSize(6.5);
      let line = top + 9;
      if (cfg.address) { pdf.text(String(cfg.address), pw / 2, line, { align: "center" }); line += 3; }
      const contact = [
        cfg.gstin ? "GSTIN: " + cfg.gstin : "",
        cfg.phones ? "Ph: " + cfg.phones : "",
        cfg.email || ""
      ].filter(Boolean).join("  |  ");
      if (contact) { pdf.text(contact, pw / 2, line, { align: "center" }); line += 3; }
      pdf.setLineWidth(0.4).line(m, line, pw - m, line);
      y = line + 3;
    }

    function drawTitleBlock() {
      pdf.setFont("helvetica", "bold").setFontSize(9);
      pdf.text(String(doc.title || "Report"), m, y); y += 3.5;
      pdf.setFont("helvetica", "normal").setFontSize(6);
      const bits = [];
      if (doc.period && (doc.period.from || doc.period.to)) {
        bits.push("Period: " + (doc.period.from ? fmtDate(doc.period.from) : "Start")
          + " to " + (doc.period.to ? fmtDate(doc.period.to) : "Date"));
      }
      bits.push("Printed: " + new Date().toLocaleString("en-IN"));
      if (!opts.withRate) bits.push("WITHOUT RATE");
      pdf.text(bits.join("   ·   "), m, y); y += 3;
      if ((doc.filters || []).length) {
        const txt = "Filters: " + doc.filters.join("  |  ");
        pdf.splitTextToSize(txt, usableW).forEach(l => { pdf.text(l, m, y); y += 2.6; });
      }
      y += 1;
    }

    function drawHeaderRow() {
      const h = LINE + CELL_PAD * 2;
      pdf.setFillColor(232, 232, 232).rect(m, y, usableW, h, "F");
      pdf.setFont("helvetica", "bold").setFontSize(FONT).setTextColor(0);
      let x = m;
      cols.forEach((c, i) => {
        pdf.rect(x, y, colW[i], h);
        const tx = c.align === "right" ? x + colW[i] - CELL_PAD : x + CELL_PAD;
        pdf.text(String(c.label), tx, y + LINE + CELL_PAD * 0.4,
          { align: c.align === "right" ? "right" : "left", maxWidth: colW[i] - CELL_PAD * 2 });
        x += colW[i];
      });
      y += h;
    }

    function newPage(first) {
      if (!first) pdf.addPage();
      pageNo++;
      y = m;
      drawLetterhead();
      if (pageNo === 1) drawTitleBlock();
      drawHeaderRow();   // headings repeat on every page
    }

    function footerOnEveryPage() {
      if (!opts.footer) return;
      const total = pdf.internal.getNumberOfPages();
      for (let p = 1; p <= total; p++) {
        pdf.setPage(p);
        pdf.setFont("helvetica", "normal").setFontSize(6).setTextColor(60);
        pdf.text(`${cfg.business_name || ""} — ${doc.title || ""}`, m, ph - m + 3);
        pdf.text(`Page ${p} of ${total}`, pw - m, ph - m + 3, { align: "right" });
      }
    }

    newPage(true);

    pdf.setFont("helvetica", "normal").setFontSize(FONT).setTextColor(0);
    doc.rows.forEach(row => {
      // Wrap first so the row's true height is known before committing to it;
      // this is what stops a tall row being sliced across a page break.
      const wrapped = cols.map((c, i) =>
        pdf.splitTextToSize(cellText(c, row, opts), colW[i] - CELL_PAD * 2));
      const lines = Math.max(1, ...wrapped.map(w => w.length));
      const h = lines * LINE + CELL_PAD * 2;

      if (y + h > ph - m - 4) { newPage(false); pdf.setFont("helvetica", "normal").setFontSize(FONT); }

      let x = m;
      cols.forEach((c, i) => {
        pdf.rect(x, y, colW[i], h);
        const tx = c.align === "right" ? x + colW[i] - CELL_PAD : x + CELL_PAD;
        wrapped[i].forEach((ln, li) => {
          pdf.text(ln, tx, y + CELL_PAD + LINE * (li + 0.8),
            { align: c.align === "right" ? "right" : "left" });
        });
        x += colW[i];
      });
      y += h;
    });

    if (doc.totals) {
      const h = LINE + CELL_PAD * 2;
      if (y + h > ph - m - 4) newPage(false);
      pdf.setFillColor(242, 242, 242).rect(m, y, usableW, h, "F");
      pdf.setFont("helvetica", "bold").setFontSize(FONT);
      let x = m;
      cols.forEach((c, i) => {
        pdf.rect(x, y, colW[i], h);
        let txt = "";
        if (i === 0) txt = `Total — ${doc.rows.length} line${doc.rows.length !== 1 ? "s" : ""}`;
        else if ((c.key in doc.totals) && !(c.rate && !opts.withRate)) {
          txt = c.type === "money" ? fmtMoney(doc.totals[c.key]) : fmtNumber(doc.totals[c.key]);
        }
        const tx = c.align === "right" ? x + colW[i] - CELL_PAD : x + CELL_PAD;
        pdf.text(txt, tx, y + LINE + CELL_PAD * 0.4,
          { align: c.align === "right" ? "right" : "left", maxWidth: colW[i] - CELL_PAD * 2 });
        x += colW[i];
      });
      y += h;
    }

    footerOnEveryPage();
    return pdf;
  }

  global.PrintEngine = {
    PAPER, MARGIN_PRESETS, DEFAULTS, MIN_SCALE,
    loadPrefs, savePrefs,
    visibleColumns, cellText, geometry,
    renderSheet, toCsv, toPdf,
    fmtMoney, fmtNumber, fmtDate, esc
  };
})(window);
