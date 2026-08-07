/* ============================================================
   SERVER-SIDE INVOICE / CHALLAN PDF
   ------------------------------------------------------------
   The browser already builds a PDF for "Download PDF" by rasterising
   the on-screen HTML with html2canvas and wrapping the image in
   jsPDF (see public/js/app.js, downloadInvoicePdf). That approach
   needs a live DOM and a user's browser tab — neither exists when the
   PC itself has to silently print a job a phone just submitted.

   This module draws the SAME ERP-style document (same fields, same
   section order, same boxed layout as the browser's .erp-* template)
   directly with jsPDF's text/line/rect primitives instead of
   rasterising HTML. It won't be pixel-identical, but it is the same
   bordered, full-page layout with no dependency on a headless browser
   (Puppeteer would drag in a ~300MB bundled Chromium onto a shop PC
   that otherwise runs nothing but Node + SQLite).

   Pricing.js is required directly — it already runs isomorphically in
   both the browser and every server route, so formatting here (Sq.ft
   labels, rate strings, amount-in-words) matches the invoice exactly.
   ============================================================ */
const { jsPDF } = require("jspdf");
const Pricing = require("../../public/js/pricing.js");

function fmt(n) {
  const v = Math.round((Number(n) || 0) + Number.EPSILON);
  return "Rs. " + v.toLocaleString("en-IN");
}
function fmtPaise(n) {
  const v = Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
  return "Rs. " + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * @param invoice  a row from `invoices` (or the same shape) with `.items`
 * @param settings the shop's settings row
 * @param customer the customer row, or null for Walk-in
 * @param opts     { showRate }: only meaningful for doc_type='challan' —
 *                 mirrors the browser's "Show Rate & Amount" print toggle.
 * @returns Buffer containing a complete PDF
 */
function buildInvoicePdf(invoice, settings, customer, opts = {}) {
  const challan = invoice.doc_type === "challan";
  const showRate = !challan || !!opts.showRate;

  // A5 support matches the browser's paper-size toggle — the server print
  // path never had it before; each size gets its own tight margin per spec.
  const isA5 = invoice.paper_size === "A5";
  const PAGE_W = isA5 ? 148 : 210;
  const PAGE_H = isA5 ? 210 : 297;
  const MARGIN = isA5 ? 3 : 6;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const FS = isA5 ? 0.94 : 1.14; // font-scale factor so A5 doesn't overflow its narrower sheet
  const fs = n => Math.max(5.5, n * FS);

  const doc = new jsPDF({ unit: "mm", format: isA5 ? "a5" : "a4" });
  let y = MARGIN;

  // Item table only: teal grid lines + navy item text, matching the shop's
  // reference layout. Every other box (header, parties, totals, signatures)
  // stays plain black — only the item grid itself uses this accent.
  const TABLE_BORDER = [23, 138, 110];
  const TABLE_TEXT = [30, 58, 112];

  const line = (y1, x0 = MARGIN, x1 = PAGE_W - MARGIN) => doc.line(x0, y1, x1, y1);
  const drawPageFrame = () => {
    doc.setDrawColor(0);
    doc.rect(MARGIN, MARGIN, CONTENT_W, PAGE_H - MARGIN * 2);
  };

  // ---- Header: centered business identity, one full-width rule beneath ----
  doc.setFont("helvetica", "bold"); doc.setFontSize(fs(11)); doc.setTextColor(0);
  doc.text((challan ? "DELIVERY CHALLAN" : "ESTIMATE CHALLAN"), PAGE_W / 2, y + 4, { align: "center" });
  y += 4 + fs(2.2);
  line(y, MARGIN + 2, PAGE_W - MARGIN - 2); y += fs(4.5);

  doc.setFont("helvetica", "bold"); doc.setFontSize(fs(13));
  doc.text(settings.business_name || "Shop", PAGE_W / 2, y, { align: "center" }); y += fs(4.5);
  if (settings.tagline) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(fs(8));
    doc.text(settings.tagline, PAGE_W / 2, y, { align: "center" }); y += fs(3.8);
  }
  if (settings.address) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(fs(8));
    const addrLines = doc.splitTextToSize(settings.address, CONTENT_W - 6);
    addrLines.forEach(l => { doc.text(l, PAGE_W / 2, y, { align: "center" }); y += fs(3.6); });
  }
  const contactBits = [
    settings.gstin ? `GSTIN: ${settings.gstin}` : "",
    settings.phones ? `Ph: ${settings.phones}` : "",
    settings.email ? `Email: ${settings.email}` : "",
    settings.website ? `Website: ${settings.website}` : ""
  ].filter(Boolean).join("   |   ");
  doc.setFont("helvetica", "bold"); doc.setFontSize(fs(7));
  doc.text(contactBits, PAGE_W / 2, y, { align: "center" }); y += fs(3.5);
  y += fs(1.5);
  line(y); y += 1;

  // ---- Parties: two boxes, equal height (drawn AFTER both sides' content
  // heights are known, so the shorter side's box still matches the taller). ----
  const docColX = PAGE_W - MARGIN - CONTENT_W * 0.4;
  const partyBoxTopY = y;
  const rowH = fs(3.9);

  // Left (buyer) side — collect lines first so height is known up front.
  const buyerLines = [];
  buyerLines.push({ text: challan ? "Deliver To" : "Buyer", bold: true, size: fs(7), label: true });
  buyerLines.push({ text: customer ? customer.name : "Walk-in Customer", bold: true, size: fs(10) });
  if (customer && customer.address) doc.splitTextToSize(customer.address, docColX - MARGIN - 6).forEach(l => buyerLines.push({ text: l, size: fs(8) }));
  if (customer && customer.phone) buyerLines.push({ text: "Mobile: " + customer.phone, size: fs(8) });
  if (customer && customer.gst) buyerLines.push({ text: "GSTIN: " + customer.gst, size: fs(8) });
  if (customer && customer.state) buyerLines.push({ text: "State: " + customer.state, size: fs(8) });

  // Right (document info) side.
  const docLines = [];
  docLines.push([challan ? "Challan No." : "Estimate No.", invoice.challan_no]);
  docLines.push(["Date", invoice.date]);
  if (invoice.delivery_man) docLines.push(["Salesperson", invoice.delivery_man]);
  if (invoice.vehicle_number) docLines.push(["Vehicle No.", invoice.vehicle_number]);

  const boxContentH = Math.max(buyerLines.length * rowH, docLines.length * rowH) + 3;
  const boxBottomY = partyBoxTopY + boxContentH;

  doc.setTextColor(0);
  let by = partyBoxTopY + rowH;
  buyerLines.forEach(l => {
    doc.setFont("helvetica", l.bold ? "bold" : "normal"); doc.setFontSize(l.size);
    doc.setTextColor(l.label ? 100 : 0);
    doc.text(l.text, MARGIN + 3, by);
    by += rowH;
  });
  doc.setTextColor(0);
  let dy = partyBoxTopY + rowH;
  docLines.forEach(([k, v]) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(fs(8)); doc.setTextColor(90);
    doc.text(k, docColX + 3, dy);
    doc.setFont("helvetica", "bold"); doc.setTextColor(0);
    doc.text(String(v), PAGE_W - MARGIN - 3, dy, { align: "right" });
    dy += rowH;
  });

  doc.setDrawColor(0);
  doc.rect(MARGIN, partyBoxTopY, CONTENT_W, boxContentH);
  doc.line(docColX, partyBoxTopY, docColX, boxBottomY);
  y = boxBottomY;

  // ---- Table columns ----
  // Widths below are the original fractions with GST%'s (and, before that,
  // Brand's and HSN's) share proportionally redistributed across the rest,
  // so every column keeps the same relative ratio to the others as before —
  // not just a gap left where the column was, or all the freed space dumped
  // into one column.
  // Column layout is FIXED regardless of showRate — Rate/Amount columns
  // always exist so the printed page looks identical either way; only their
  // cell CONTENTS go blank in itemValues() below when showRate is off.
  const cols = [
    { h: "Sr No.", w: CONTENT_W * 0.065 }, { h: challan ? "Product / Item" : "Product Description", w: CONTENT_W * 0.33 },
    { h: challan ? "Description" : "Size", w: CONTENT_W * 0.13 }, { h: "Unit", w: CONTENT_W * 0.095 },
    { h: "Qty", w: CONTENT_W * 0.10, align: "right" },
    { h: "Rate", w: CONTENT_W * 0.13, align: "right" },
    { h: "Amount", w: 0, align: "right" }
  ];
  const fixedW = cols.reduce((s, c) => s + c.w, 0);
  cols[cols.length - 1].w = CONTENT_W - fixedW;
  const colX = [MARGIN];
  cols.forEach(c => colX.push(colX[colX.length - 1] + c.w));
  const tableRight = colX[colX.length - 1];
  const tableTopY = y;

  const headerH = fs(6);
  const idealBodyRowH = fs(5.2);

  // ---- Pre-compute the footer block's height BEFORE drawing the table, so
  // the table can be stretched to reach exactly where the footer must start
  // — this is what keeps the footer pinned to the bottom of the page instead
  // of leaving a blank gap under a short item list. ----
  const challanSubtotal = invoice.items.reduce((s, it) => s + (it.qty * it.rate || 0), 0);
  const displayTotal = challan ? (challanSubtotal + invoice.transport + invoice.loading) : invoice.total;

  // Effective rate shown next to the CGST/SGST/IGST label — derived from the
  // actual stored tax and taxable value (a weighted average, so it's still
  // correct on a mixed-rate bill), not hardcoded. A challan never carries
  // real GST, and "Non-GST Invoice" (gst_enabled=0) deliberately has none
  // either — both skip the tax rows entirely.
  const gstEnabled = !challan && invoice.gst_enabled !== 0;
  const cgstAmt = gstEnabled ? (invoice.cgst || 0) : 0, sgstAmt = gstEnabled ? (invoice.sgst || 0) : 0, igstAmt = gstEnabled ? (invoice.igst || 0) : 0;
  const taxableGoods = Math.max(0, (invoice.subtotal || 0) - (invoice.discount_amount || 0));
  const effectiveRatePct = taxableGoods > 0 ? Math.round(((cgstAmt + sgstAmt + igstAmt) / taxableGoods) * 100) : 0;
  const halfRatePct = Math.round(effectiveRatePct / 2);

  // The totals box keeps the SAME layout regardless of showRate — mirrors
  // the browser template (renderInvoicePageContent in public/js/app.js).
  // Only the money values that depend on item pricing (Subtotal, Discount,
  // Grand Total) go blank instead of printing a misleading "0.00" when the
  // rate itself isn't shown. Transport/Additional Charges are real entered
  // rupee amounts independent of any item rate, so they still print.
  const totalsRows = [];
  totalsRows.push(["Subtotal", showRate ? fmtPaise(challan ? challanSubtotal : invoice.subtotal) : ""]);
  totalsRows.push(["Discount", showRate ? ((challan ? 0 : invoice.discount_amount) > 0 ? "-" + fmtPaise(invoice.discount_amount) : fmtPaise(0)) : ""]);
  totalsRows.push(["Transport", fmtPaise(invoice.transport)]);
  if (invoice.loading) totalsRows.push(["Additional Charges", fmtPaise(invoice.loading)]);
  if (gstEnabled) {
    if (invoice.tax_type === "IGST") totalsRows.push([`IGST ${effectiveRatePct}%`, fmtPaise(igstAmt)]);
    else { totalsRows.push([`CGST ${halfRatePct}%`, fmtPaise(cgstAmt)]); totalsRows.push([`SGST ${halfRatePct}%`, fmtPaise(sgstAmt)]); }
  }
  if (!challan && invoice.round_off) totalsRows.push(["Round Off", (invoice.round_off > 0 ? "+" : "") + fmtPaise(invoice.round_off)]);
  totalsRows.push(["Grand Total", showRate ? fmtPaise(displayTotal) : "", true]);
  if (!challan && invoice.advance > 0) {
    totalsRows.push(["Advance Paid", "-" + fmtPaise(invoice.advance)]);
    totalsRows.push(["Balance Due", fmtPaise(invoice.balance_due), true]);
  }
  const totalsBoxH = totalsRows.length * fs(4.6);

  const deliveryAddr = invoice.delivery_address || (customer && customer.address) || "";
  const bottomLeftWidth = CONTENT_W * 0.58;
  const bottomLeftLines = [];
  if (deliveryAddr) doc.splitTextToSize("Delivery Address: " + deliveryAddr, bottomLeftWidth - 6).forEach(l => bottomLeftLines.push(l));
  if (invoice.remarks) doc.splitTextToSize("Remarks: " + invoice.remarks, bottomLeftWidth - 6).forEach(l => bottomLeftLines.push(l));
  if (showRate) doc.splitTextToSize("Amount in Words: " + Pricing.amountInWords(displayTotal), bottomLeftWidth - 6).forEach(l => bottomLeftLines.push(l));
  const bottomBoxH = Math.max(totalsBoxH, bottomLeftLines.length * fs(4) + 4) + 3;

  const termsText = challan
    ? "PLYWOOD, BLACKBOARD, ARE MANUFACTURED FROM NATURAL WOOD WHICH IS BELOW BIO DEGRADEBLE, WE DONOT GUARANTEE AGAINST ANY NATURAL DECAY DEFICIENTY, DETORATION AND LIKE INCLUDING MANUFACTURING DEFACT AND/OR IMPERFACT QUALITY"
    : "NO GURANTEE AND WARRANTY FOR DECORATIVE PRODUCTS AND AIR BUBBLES IN LAMMINATES, ACRYLIC AND PVC LAMINATES OR ANY SHADE VARIATION AFTER INSTALLATION. NO EXCHANGE. NO RETURN IN ANY CONDITION. PLEASE CHECK THE MATERIAL ON DELIVERY.";
  const termLines = doc.splitTextToSize(termsText, CONTENT_W - 6);
  const termsBoxH = termLines.length * fs(3.2) + fs(6);

  const footerReserve = bottomBoxH + termsBoxH;
  const tableTargetBottom = PAGE_H - MARGIN - footerReserve;

  // Row height stays CONSTANT regardless of item count — a long order pages
  // onto a continuation sheet instead of squeezing every row down to fit
  // one page (which just made a big order unreadable). Only the page that
  // ends up holding the LAST item also reserves room for the footer below.
  const bodyRowH = idealBodyRowH;

  const drawHeaderRow = (yy) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(fs(7)); doc.setTextColor(0);
    cols.forEach((c, ci) => {
      const x = c.align === "right" ? colX[ci + 1] - 1 : colX[ci] + 1;
      doc.text(c.h.toUpperCase(), x, yy + headerH - fs(1.8), c.align === "right" ? { align: "right" } : undefined);
    });
  };
  const drawItemRow = (values, rowY) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(fs(7.5)); doc.setTextColor(...TABLE_TEXT);
    cols.forEach((c, ci) => {
      const x = c.align === "right" ? colX[ci + 1] - 1 : colX[ci] + 1;
      const text = doc.splitTextToSize(String(values[ci] ?? ""), c.w - 2);
      doc.text(text[0] || "", x, rowY + bodyRowH - fs(1.8), c.align === "right" ? { align: "right" } : undefined);
    });
    doc.setTextColor(0);
  };
  const itemValues = (it, i) => {
    const mode = it.mode || "UNIT";
    const unit = it.unit_label || (Pricing.MODES[mode] && Pricing.MODES[mode].unit) || "";
    // Area/length modes bill in a different unit than the physical piece
    // count (e.g. 4 sheets at 8x4ft = 32 Sq.ft) — note the piece count
    // inline so "32" doesn't read as a mismatch against "4". A single piece
    // is shown as just "1 pc" instead, since the billed number adds nothing
    // when there's only one piece to begin with. UNIT mode has no such
    // split (qty already IS the piece count), so nothing extra.
    const qtyText = mode !== "UNIT" && it.pieces === 1
      ? "1 pc"
      : Pricing.formatQty(it.qty, mode).replace(" " + unit, "")
        + (mode !== "UNIT" && it.pieces ? ` (${it.pieces}pc)` : "");
    return [String(i + 1), it.name, it.size_label || "-", unit, qtyText,
      showRate ? fmtPaise(it.rate).replace("Rs. ", "") : "",
      showRate ? fmtPaise(it.qty * it.rate).replace("Rs. ", "") : ""];
  };

  let curTableTopY = tableTopY;
  let idx = 0;
  let tableBottom;
  for (;;) {
    drawHeaderRow(y);
    y += headerH;
    const bodyTopY = y;
    let rowsDrawnThisPage = 0;

    // Does everything from here (remaining items + the Total Quantity row)
    // fit on THIS page alongside the footer? If so, this is the last page.
    const remaining = invoice.items.length - idx;
    const roomWithFooter = tableTargetBottom - y;
    const isLastPage = remaining * bodyRowH + bodyRowH <= roomWithFooter + 0.01;

    // Rows this page can hold: reserve room for the footer only if it's the
    // last page; otherwise use the full sheet, minus one row for a
    // "Continued..." note when more pages will follow.
    const maxRowsThisPage = isLastPage
      ? remaining
      : Math.max(1, Math.floor((PAGE_H - MARGIN - y) / bodyRowH) - 1);

    while (rowsDrawnThisPage < maxRowsThisPage && idx < invoice.items.length) {
      drawItemRow(itemValues(invoice.items[idx], idx), y);
      y += bodyRowH;
      idx++;
      rowsDrawnThisPage++;
    }

    if (isLastPage) {
      // Total Quantity is the physical piece count across all items, not the
      // billed area/length sum — matching what gets counted at load/unload,
      // and staying meaningful even when items mix billing units (Sq.ft +
      // Rft + Unit can't be summed together, but pieces always can).
      const totalQty = Pricing.round2(invoice.items.reduce((s, it) => s + (Number(it.pieces) || 0), 0));
      doc.setFont("helvetica", "bold"); doc.setFontSize(fs(7.5));
      doc.text("Total Quantity", colX[4] - 1, y + bodyRowH - fs(1.8), { align: "right" });
      doc.text(String(totalQty), colX[5] - 1, y + bodyRowH - fs(1.8), { align: "right" });
      y += bodyRowH;
      rowsDrawnThisPage++;

      // Stretch: the bordered box (outer rect + vertical column lines) pads
      // down to the reserved footer position, but stays visually BLANK in
      // that gap — exactly as many ruled rows as there are items, nothing
      // more, matching the shop's paper form precisely.
      doc.setDrawColor(...TABLE_BORDER);
      tableBottom = Math.max(y, tableTargetBottom);
      let ruleY = bodyTopY;
      for (let i = 0; i <= rowsDrawnThisPage - 1; i++) { line(ruleY, MARGIN, tableRight); ruleY += bodyRowH; }
      colX.forEach(x => doc.line(x, curTableTopY, x, tableBottom));
      doc.rect(MARGIN, curTableTopY, tableRight - MARGIN, tableBottom - curTableTopY);
      doc.setDrawColor(0);
      y = tableBottom;
      break;
    } else {
      // Close out this page's table box, note it continues, then start a
      // fresh page with its own frame + a compact repeated header.
      doc.setDrawColor(...TABLE_BORDER);
      let ruleY = bodyTopY;
      for (let i = 0; i <= rowsDrawnThisPage; i++) { line(ruleY, MARGIN, tableRight); ruleY += bodyRowH; }
      colX.forEach(x => doc.line(x, curTableTopY, x, y));
      doc.rect(MARGIN, curTableTopY, tableRight - MARGIN, y - curTableTopY);
      doc.setDrawColor(0);
      doc.setFont("helvetica", "italic"); doc.setFontSize(fs(7)); doc.setTextColor(90);
      doc.text("Continued on next page...", PAGE_W - MARGIN, y + fs(4), { align: "right" });
      doc.setTextColor(0);

      doc.addPage();
      drawPageFrame();
      y = MARGIN;
      doc.setFont("helvetica", "bold"); doc.setFontSize(fs(10));
      doc.text((settings.business_name || "Shop") + " — " + invoice.challan_no + " (Contd.)", PAGE_W / 2, y + fs(4), { align: "center" });
      y += fs(4) + fs(3);
      line(y); y += fs(3);
      curTableTopY = y;
    }
  }

  // ---- Bottom: delivery info (left) + boxed totals (right) ----
  const bottomTopY = y;
  const bottomRightX = MARGIN + CONTENT_W * 0.58;
  doc.setFont("helvetica", "normal"); doc.setFontSize(fs(7.5));
  let bl = bottomTopY + fs(4);
  bottomLeftLines.forEach(l => { doc.text(l, MARGIN + 3, bl); bl += fs(4); });

  let tr = bottomTopY;
  totalsRows.forEach(([label, value, bold]) => {
    tr += fs(4.6);
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(bold ? fs(9) : fs(7.5));
    doc.text(label, bottomRightX + 2, tr - fs(1.2));
    doc.text(value, PAGE_W - MARGIN - 2, tr - fs(1.2), { align: "right" });
    doc.setDrawColor(0); line(tr, bottomRightX, PAGE_W - MARGIN);
  });

  doc.setDrawColor(0);
  doc.rect(MARGIN, bottomTopY, CONTENT_W, bottomBoxH);
  doc.line(bottomRightX, bottomTopY, bottomRightX, bottomTopY + bottomBoxH);
  y = bottomTopY + bottomBoxH;

  // ---- Terms & conditions, full width ----
  const termsTopY = y;
  doc.setFont("helvetica", "bold"); doc.setFontSize(fs(6.5)); doc.setTextColor(0);
  let ty = termsTopY + fs(3.2);
  termLines.forEach(l => { doc.text(l, PAGE_W / 2, ty, { align: "center" }); ty += fs(3.2); });
  doc.rect(MARGIN, termsTopY, CONTENT_W, termsBoxH);

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { buildInvoicePdf };
