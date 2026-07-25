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
  const MARGIN = isA5 ? 5 : 6;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const FS = isA5 ? 0.82 : 1; // font-scale factor so A5 doesn't overflow its narrower sheet
  const fs = n => Math.max(5.5, n * FS);

  const doc = new jsPDF({ unit: "mm", format: isA5 ? "a5" : "a4" });
  let y = MARGIN;

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
    "Email: swagatply@gmail.com", "Website: www.swagatply.com"
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
  // Widths below are the original (pre-HSN-removal) fractions with HSN's
  // share proportionally redistributed across the rest, so every column
  // keeps the same relative ratio to the others as before — not just a gap
  // left where HSN was, or all the freed space dumped into one column.
  const cols = showRate
    ? [{ h: "Sr No.", w: CONTENT_W * 0.05 }, { h: "Product Description", w: CONTENT_W * 0.26 },
       { h: "Brand", w: CONTENT_W * 0.11 }, { h: "Size", w: CONTENT_W * 0.10 },
       { h: "Unit", w: CONTENT_W * 0.075 }, { h: "Qty", w: CONTENT_W * 0.08, align: "right" },
       { h: "Rate", w: CONTENT_W * 0.10, align: "right" }, { h: "GST %", w: CONTENT_W * 0.07, align: "right" },
       { h: "Amount", w: 0, align: "right" }]
    : [{ h: "Sr No.", w: CONTENT_W * 0.07 }, { h: "Product Description", w: CONTENT_W * 0.39 },
       { h: "Brand", w: CONTENT_W * 0.16 }, { h: "Size", w: CONTENT_W * 0.15 },
       { h: "Unit", w: CONTENT_W * 0.10 }, { h: "Qty", w: 0, align: "right" }];
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

  const totalsRows = [];
  totalsRows.push(["Subtotal", fmtPaise(challan ? challanSubtotal : invoice.subtotal)]);
  totalsRows.push(["Discount", (challan ? 0 : invoice.discount_amount) > 0 ? "-" + fmtPaise(invoice.discount_amount) : fmtPaise(0)]);
  totalsRows.push(["Transport", fmtPaise(invoice.transport)]);
  totalsRows.push(["Additional Charges", fmtPaise(invoice.loading)]);
  if (!challan && invoice.tax_type === "IGST") totalsRows.push(["IGST", fmtPaise(invoice.igst)]);
  else { totalsRows.push(["CGST", fmtPaise(challan ? 0 : invoice.cgst)]); totalsRows.push(["SGST", fmtPaise(challan ? 0 : invoice.sgst)]); }
  if (!challan && invoice.round_off) totalsRows.push(["Round Off", (invoice.round_off > 0 ? "+" : "") + fmtPaise(invoice.round_off)]);
  totalsRows.push(["Grand Total", fmtPaise(displayTotal), true]);
  if (!challan && invoice.advance > 0) {
    totalsRows.push(["Advance Paid", "-" + fmtPaise(invoice.advance)]);
    totalsRows.push(["Balance Due", fmtPaise(invoice.balance_due), true]);
  }
  const totalsBoxH = totalsRows.length * fs(4.6);

  const deliveryAddr = invoice.delivery_address || (customer && customer.address) || "";
  const bottomLeftLines = [];
  if (deliveryAddr) doc.splitTextToSize("Delivery Address: " + deliveryAddr, CONTENT_W * 0.58 - 6).forEach(l => bottomLeftLines.push(l));
  if (invoice.remarks) doc.splitTextToSize("Remarks: " + invoice.remarks, CONTENT_W * 0.58 - 6).forEach(l => bottomLeftLines.push(l));
  doc.splitTextToSize("Amount in Words: " + Pricing.amountInWords(displayTotal), CONTENT_W * 0.58 - 6).forEach(l => bottomLeftLines.push(l));
  const bottomBoxH = Math.max(totalsBoxH, bottomLeftLines.length * fs(4) + 4) + 3;

  const signRowH = fs(16);
  const termsText = challan
    ? "This is a delivery challan and not a tax invoice - it is not a demand for payment.\nPLYWOOD, BLACKBOARD, ARE MANUFACTURED FROM NATURAL WOOD WHICH IS BELOW BIO DEGRADEBLE, WE DONOT GUARANTEE AGAINST ANY NATURAL DECAY DEFICIENTY, DETORATION AND LIKE INCLUDING MANUFACTURING DEFACT AND/OR IMPERFACT QUALITY"
    : "NO GURANTEE AND WARRANTY FOR DECORATIVE PRODUCTS AND AIR BUBBLES IN LAMMINATES, ACRYLIC AND PVC LAMINATES OR ANY SHADE VARIATION AFTER INSTALLATION. NO EXCHANGE. NO RETURN IN ANY CONDITION. PLEASE CHECK THE MATERIAL ON DELIVERY.";
  const termLines = doc.splitTextToSize(termsText, CONTENT_W - 6);
  const termsBoxH = termLines.length * fs(3.2) + fs(6);

  const footerReserve = bottomBoxH + signRowH + termsBoxH;
  const tableTargetBottom = PAGE_H - MARGIN - footerReserve;

  // Row height stays CONSTANT regardless of item count — a long order pages
  // onto a continuation sheet instead of squeezing every row down to fit
  // one page (which just made a big order unreadable). Only the page that
  // ends up holding the LAST item also reserves room for the footer below.
  const bodyRowH = idealBodyRowH;

  const drawHeaderRow = (yy) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(fs(7));
    cols.forEach((c, ci) => {
      const x = c.align === "right" ? colX[ci + 1] - 1 : colX[ci] + 1;
      doc.text(c.h.toUpperCase(), x, yy + headerH - fs(1.8), c.align === "right" ? { align: "right" } : undefined);
    });
  };
  const drawItemRow = (values, rowY) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(fs(7.5));
    cols.forEach((c, ci) => {
      const x = c.align === "right" ? colX[ci + 1] - 1 : colX[ci] + 1;
      const text = doc.splitTextToSize(String(values[ci] ?? ""), c.w - 2);
      doc.text(text[0] || "", x, rowY + bodyRowH - fs(1.8), c.align === "right" ? { align: "right" } : undefined);
    });
  };
  const itemValues = (it, i) => {
    const mode = it.mode || "UNIT";
    const unit = it.unit_label || (Pricing.MODES[mode] && Pricing.MODES[mode].unit) || "";
    return showRate
      ? [String(i + 1), it.name, it.brand || "-", it.size_label || "-", unit,
         Pricing.formatQty(it.qty, mode).replace(" " + unit, ""), fmtPaise(it.rate).replace("Rs. ", ""),
         (it.gst_rate || 0) + "%", fmtPaise(it.qty * it.rate).replace("Rs. ", "")]
      : [String(i + 1), it.name, it.brand || "-", it.size_label || "-", unit,
         Pricing.formatQty(it.qty, mode).replace(" " + unit, "")];
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
      const totalQty = Pricing.round2(invoice.items.reduce((s, it) => s + (Number(it.qty) || 0), 0));
      doc.setFont("helvetica", "bold"); doc.setFontSize(fs(7.5));
      doc.text("Total Quantity", colX[5] - 1, y + bodyRowH - fs(1.8), { align: "right" });
      doc.text(String(totalQty), colX[6] - 1, y + bodyRowH - fs(1.8), { align: "right" });
      y += bodyRowH;
      rowsDrawnThisPage++;

      // Stretch (Tally-style): pad the table down to the reserved footer
      // position with real ruled blank rows — not just one big empty cell —
      // so a short item list still reads as a full page of grid, matching
      // the shop's paper form.
      doc.setDrawColor(0);
      const filledBottom = y;
      tableBottom = Math.max(filledBottom, tableTargetBottom);
      for (let fy = filledBottom; fy < tableBottom - 0.01; fy += bodyRowH) {
        line(Math.min(fy + bodyRowH, tableBottom), MARGIN, tableRight);
      }
      let ruleY = bodyTopY;
      for (let i = 0; i <= rowsDrawnThisPage - 1; i++) { line(ruleY, MARGIN, tableRight); ruleY += bodyRowH; }
      colX.forEach(x => doc.line(x, curTableTopY, x, tableBottom));
      doc.rect(MARGIN, curTableTopY, tableRight - MARGIN, tableBottom - curTableTopY);
      y = tableBottom;
      break;
    } else {
      // Close out this page's table box, note it continues, then start a
      // fresh page with its own frame + a compact repeated header.
      doc.setDrawColor(0);
      let ruleY = bodyTopY;
      for (let i = 0; i <= rowsDrawnThisPage; i++) { line(ruleY, MARGIN, tableRight); ruleY += bodyRowH; }
      colX.forEach(x => doc.line(x, curTableTopY, x, y));
      doc.rect(MARGIN, curTableTopY, tableRight - MARGIN, y - curTableTopY);
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

  // ---- Signature row: Receiver / Customer / Stamp / Authorised Signatory ----
  const signTopY = y;
  const signW = CONTENT_W / 4;
  const signLabelY = signTopY + signRowH - fs(3);
  doc.setFont("helvetica", "normal"); doc.setFontSize(fs(7));
  const signLineY = signLabelY - fs(2);
  [
    ["Receiver Signature", MARGIN + signW * 0.5],
    ["Customer Signature", MARGIN + signW * 1.5],
    ["__STAMP__", MARGIN + signW * 2.5],
    ["For " + (settings.business_name || "Shop") + "\nAuthorised Signatory", MARGIN + signW * 3.5]
  ].forEach(([label, cx]) => {
    if (label === "__STAMP__") {
      doc.setDrawColor(160);
      doc.setLineDashPattern([1, 1], 0);
      doc.rect(cx - signW * 0.3, signTopY + fs(3), signW * 0.6, fs(7));
      doc.setLineDashPattern([], 0);
      doc.setTextColor(160); doc.setFontSize(fs(6.5));
      doc.text("Company Stamp", cx, signTopY + fs(3) + fs(4.2), { align: "center" });
      doc.setTextColor(0); doc.setFontSize(fs(7));
    } else {
      doc.line(cx - signW * 0.4, signLineY, cx + signW * 0.4, signLineY);
      doc.text(label, cx, signLabelY, { align: "center" });
    }
    doc.setDrawColor(0);
  });
  doc.rect(MARGIN, signTopY, CONTENT_W, signRowH);
  y = signTopY + signRowH;

  // ---- Terms & conditions, full width ----
  const termsTopY = y;
  doc.setFont("helvetica", "bold"); doc.setFontSize(fs(6.5)); doc.setTextColor(0);
  let ty = termsTopY + fs(3.2);
  termLines.forEach(l => { doc.text(l, PAGE_W / 2, ty, { align: "center" }); ty += fs(3.2); });
  doc.rect(MARGIN, termsTopY, CONTENT_W, termsBoxH);

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { buildInvoicePdf };
