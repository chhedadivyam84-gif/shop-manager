/* ============================================================
   SERVER-SIDE INVOICE / CHALLAN PDF
   ------------------------------------------------------------
   The browser already builds a PDF for "Download PDF" by rasterising
   the on-screen HTML with html2canvas and wrapping the image in
   jsPDF (see public/js/app.js, downloadInvoicePdf). That approach
   needs a live DOM and a user's browser tab — neither exists when the
   PC itself has to silently print a job a phone just submitted.

   This module draws the SAME document (same fields, same section
   order, same amount-in-words / terms / contact footer) directly with
   jsPDF's text/line/rect primitives instead of rasterising HTML. It
   won't be pixel-identical to the browser version, but it is the same
   professional A4 layout with no dependency on a headless browser
   (Puppeteer would drag in a ~300MB bundled Chromium onto a shop PC
   that otherwise runs nothing but Node + SQLite).

   Pricing.js is required directly — it already runs isomorphically in
   both the browser and every server route, so formatting here (Sq.ft
   labels, rate strings, amount-in-words) matches the invoice exactly.
   ============================================================ */
const { jsPDF } = require("jspdf");
const Pricing = require("../../public/js/pricing.js");

const PAGE_W = 210, PAGE_H = 297, MARGIN = 15;
const CONTENT_W = PAGE_W - MARGIN * 2;

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
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  const line = (y1) => doc.line(MARGIN, y1, PAGE_W - MARGIN, y1);
  const rightText = (text, y1, size = 9) => {
    doc.setFontSize(size);
    doc.text(String(text), PAGE_W - MARGIN, y1, { align: "right" });
  };
  // Outer frame around the whole printed sheet, matching the shop's paper
  // form — a fixed rectangle re-drawn on every page, independent of how far
  // the content actually reaches.
  const drawPageFrame = () => {
    doc.setDrawColor(80);
    doc.rect(MARGIN - 5, MARGIN - 5, PAGE_W - (MARGIN - 5) * 2, PAGE_H - (MARGIN - 5) * 2);
    doc.setDrawColor(0);
  };
  const newPageIfNeeded = (need) => {
    if (y + need > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
      drawPageFrame();
      return true;
    }
    return false;
  };
  drawPageFrame();

  // ---- Header ----
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(0);
  doc.text(settings.business_name || "Shop", MARGIN, y);
  y += 5;
  if (settings.tagline) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(90);
    doc.text(settings.tagline, MARGIN, y); y += 4.5;
  }
  if (settings.address) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60);
    const addrLines = doc.splitTextToSize(settings.address, CONTENT_W * 0.6);
    doc.text(addrLines, MARGIN, y); y += addrLines.length * 4;
  }
  doc.setTextColor(0);
  const headerRightY = MARGIN + 5;
  if (settings.phones) rightText("Ph: " + settings.phones, headerRightY);
  if (settings.gstin) rightText("GSTIN: " + settings.gstin, headerRightY + 5);
  y = Math.max(y, headerRightY + 10) + 2;

  // ---- Document banner ----
  const bannerText = challan ? "DELIVERY CHALLAN" : "ESTIMATE CHALLAN";
  line(y); y += 6;
  doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(0);
  doc.text(bannerText, PAGE_W / 2, y, { align: "center" });
  y += 2; line(y); y += 7;

  // ---- Parties row (boxed, sitting flush above the item table so the whole
  // form reads as one continuous bordered document) ----
  const partyBoxTopY = y - 2;
  const docColX = PAGE_W - MARGIN - 55;
  const partyLabel = challan ? "Deliver To" : "Bill To";
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(120);
  doc.text(partyLabel.toUpperCase(), MARGIN + 3, y);
  const docLabel = challan ? "Challan No" : "Estimate No";
  doc.text(docLabel.toUpperCase(), PAGE_W - MARGIN - 3, y, { align: "right" });
  y += 4.5;

  const partyTopY = y;
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(0);
  doc.text(customer ? customer.name : "Walk-in Customer", MARGIN + 3, y);
  doc.setFontSize(10.5);
  doc.text(invoice.challan_no, PAGE_W - MARGIN - 3, y, { align: "right" });
  y += 4.5;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  doc.text("Date: " + invoice.date, PAGE_W - MARGIN - 3, y, { align: "right" });
  y += 4;
  if (invoice.delivery_man) {
    doc.text("D. Man: " + invoice.delivery_man, PAGE_W - MARGIN - 3, y, { align: "right" });
    y += 4;
  }
  y -= 1;

  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60);
  if (customer) {
    const custLine = [customer.type, customer.phone].filter(Boolean).join(" - ");
    if (custLine) { doc.text(custLine, MARGIN + 3, y); y += 4; }
    if (customer.address) {
      const custAddrLines = doc.splitTextToSize(customer.address, docColX - MARGIN - 8);
      doc.text(custAddrLines, MARGIN + 3, y); y += custAddrLines.length * 4;
    }
    if (customer.gst) { doc.text("GSTIN: " + customer.gst, MARGIN + 3, y); y += 4; }
  }
  y = Math.max(y, partyTopY + 8) + 3;

  doc.setDrawColor(153);
  doc.rect(MARGIN, partyBoxTopY, CONTENT_W, y - partyBoxTopY);
  doc.line(docColX, partyBoxTopY, docColX, y);
  doc.setDrawColor(0);
  doc.setTextColor(0);
  y += 3.5;

  // ---- Table (drawn as a full grid: outer border + a line between every
  // column and row — jsPDF has no native table/border primitive, so the
  // lines are placed by hand using each column's known x-position). ----
  const cols = showRate
    ? [{ h: "Sr No.", w: 10 }, { h: "Product Description", w: 44 }, { h: "Code", w: 20 }, { h: "Size", w: 20 }, { h: "Qty", w: 12 },
       { h: "Total", w: 24, align: "right" }, { h: "Rate", w: 26, align: "right" }, { h: "Amount", w: 24, align: "right" }]
    : [{ h: "Sr No.", w: 12 }, { h: "Product Description", w: 62 }, { h: "Code", w: 26 }, { h: "Size", w: 28 }, { h: "Qty", w: 16 },
       { h: "Total", w: CONTENT_W - 12 - 62 - 26 - 28 - 16, align: "right" }];
  const colX = [MARGIN];
  cols.forEach(c => colX.push(colX[colX.length - 1] + c.w));
  const tableRight = colX[colX.length - 1];
  const tableTopY = y - 3.5;

  const drawTableHeader = () => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(60);
    cols.forEach((c, ci) => {
      const x = c.align === "right" ? colX[ci + 1] - 1 : colX[ci] + 1;
      doc.text(c.h.toUpperCase(), x, y, c.align === "right" ? { align: "right" } : undefined);
    });
    y += 2; line(y); y += 4.5;
    doc.setTextColor(0);
  };
  drawTableHeader();

  const drawRow = (values, bold) => {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(8.5);
    cols.forEach((c, ci) => {
      const x = c.align === "right" ? colX[ci + 1] - 1 : colX[ci] + 1;
      const text = doc.splitTextToSize(String(values[ci] ?? ""), c.w - 2);
      doc.text(text, x, y, c.align === "right" ? { align: "right" } : undefined);
    });
    y += 5;
    doc.setDrawColor(210); doc.line(MARGIN, y - 1.5, tableRight, y - 1.5); doc.setDrawColor(0);
  };

  invoice.items.forEach((it, i) => {
    newPageIfNeeded(6);
    if (y === MARGIN) drawTableHeader();
    const mode = it.mode || "UNIT";
    const values = showRate
      ? [String(i + 1), it.name, it.code || "-", it.size_label || "-", String(it.pieces || it.qty),
         Pricing.formatQty(it.qty, mode), Pricing.formatRate(it.rate, mode).replace("₹", "Rs."), fmtPaise(it.qty * it.rate).replace("Rs. ", "")]
      : [String(i + 1), it.name, it.code || "-", it.size_label || "-", String(it.pieces || it.qty), Pricing.formatQty(it.qty, mode)];
    drawRow(values);
  });

  // Total quantity sits right under the Qty column, inside the grid itself.
  const totalQty = invoice.items.reduce((s, it) => s + (Number(it.pieces) || it.qty || 0), 0);
  const totalRowValues = showRate
    ? ["", "Total Quantity", "", "", String(totalQty), "", "", ""]
    : ["", "Total Quantity", "", "", String(totalQty), ""];
  drawRow(totalRowValues, true);

  // Outer border + one vertical line per column boundary, spanning the full
  // header+body+total-quantity height now that it's known.
  doc.setDrawColor(120);
  colX.forEach(x => doc.line(x, tableTopY, x, y - 1.5));
  doc.rect(MARGIN, tableTopY, tableRight - MARGIN, (y - 1.5) - tableTopY);
  doc.setDrawColor(0);
  y += 2;

  // ---- Totals / footer: boxed grid, GSTIN + amount-in-words, then a
  // receiver/stamp/authorised-signatory row — same structure for both
  // document types, matching the shop's paper form. For a challan, CGST/
  // SGST/IGST are always zero and "G. Total" here is a print-only figure
  // (goods value + transport/loading) — it is NEVER what's stored as the
  // invoice's actual total or added to the customer's due (that stays
  // transport+loading only, set server-side), so a challan can never
  // function as a demand for payment regardless of what this box shows. ----
  newPageIfNeeded(45);
  const totalsX = PAGE_W - MARGIN - 65;
  const boxTopY = y - 4;
  const rows = [];
  let displayTotal;
  if (challan) {
    const subtotal = invoice.items.reduce((s, it) => s + (it.qty * it.rate || 0), 0);
    displayTotal = subtotal + invoice.transport + invoice.loading;
    rows.push(["Subtotal", fmtPaise(subtotal)]);
    rows.push(["Transport", fmtPaise(invoice.transport)]);
    rows.push(["Additional Charges", fmtPaise(invoice.loading)]);
    rows.push(["CGST", fmtPaise(0)]);
    rows.push(["SGST", fmtPaise(0)]);
    rows.push(["IGST", fmtPaise(0)]);
    rows.push(["G. Total", fmtPaise(displayTotal), true]);
  } else {
    displayTotal = invoice.total;
    rows.push(["Subtotal", fmtPaise(invoice.subtotal)]);
    if (invoice.discount_amount > 0) rows.push(["Discount", "-" + fmtPaise(invoice.discount_amount)]);
    rows.push(["Transport", fmtPaise(invoice.transport)]);
    rows.push(["Additional Charges", fmtPaise(invoice.loading)]);
    if (invoice.tax_type === "IGST") rows.push(["IGST", fmtPaise(invoice.igst)]);
    else { rows.push(["CGST", fmtPaise(invoice.cgst)]); rows.push(["SGST", fmtPaise(invoice.sgst)]); }
    if (invoice.round_off) rows.push(["Round Off", (invoice.round_off > 0 ? "+" : "") + fmtPaise(invoice.round_off)]);
    rows.push(["G. Total", fmtPaise(invoice.total), true]);
    if (invoice.advance > 0) {
      rows.push(["Advance Paid", "-" + fmtPaise(invoice.advance)]);
      rows.push(["Balance Due", fmtPaise(invoice.balance_due), true]);
    }
  }
  rows.forEach(([label, value, bold]) => {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(bold ? 10 : 8.5);
    doc.text(label, totalsX + 2, y);
    doc.text(value, PAGE_W - MARGIN - 2, y, { align: "right" });
    y += 5;
    doc.setDrawColor(210); doc.line(totalsX, y - 1.5, PAGE_W - MARGIN, y - 1.5); doc.setDrawColor(0);
  });
  doc.setDrawColor(120); doc.rect(totalsX, boxTopY, PAGE_W - MARGIN - totalsX, y - 1.5 - boxTopY); doc.setDrawColor(0);
  y += 3;

  if (settings.gstin) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.text("GSTIN No: " + settings.gstin, MARGIN, y); y += 4;
  }
  doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  doc.text("Amount in words:", MARGIN, y); y += 4;
  doc.setFont("helvetica", "normal");
  const words = doc.splitTextToSize(Pricing.amountInWords(displayTotal), CONTENT_W);
  doc.text(words, MARGIN, y); y += words.length * 4 + 2;

  newPageIfNeeded(30);
  y += 14;
  doc.setFontSize(8.5);
  doc.text("Receiver's Signature", MARGIN + 10, y);
  doc.text("Company Stamp", PAGE_W / 2, y, { align: "center" });
  rightText("For " + (settings.business_name || "Shop") + "\nAuthorised Signatory", y);
  doc.line(MARGIN, y - 2, MARGIN + 45, y - 2);
  doc.line(PAGE_W / 2 - 22, y - 2, PAGE_W / 2 + 22, y - 2);
  doc.line(PAGE_W - MARGIN - 45, y - 2, PAGE_W - MARGIN, y - 2);
  y += 8;

  // ---- Footer: terms + contact ----
  newPageIfNeeded(20);
  line(y); y += 5;
  doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(20);
  const termsText = challan
    ? "This is a delivery challan and not a tax invoice - it is not a demand for payment.\nPLYWOOD, BLACKBOARD, ARE MANUFACTURED FROM NATURAL WOOD WHICH IS BELOW BIO DEGRADEBLE, WE DONOT GUARANTEE AGAINST ANY NATURAL DECAY DEFICIENTY, DETORATION AND LIKE INCLUDING MANUFACTURING DEFACT AND/OR IMPERFACT QUALITY"
    : "NO GURANTEE AND WARRANTY FOR DECORATIVE PRODUCTS AND AIR BUBBLES IN LAMMINATES, ACRYLIC AND PVC LAMINATES OR ANY SHADE VARIATION AFTER INSTALLATION. NO EXCHANGE. NO RETURN IN ANY CONDITION. PLEASE CHECK THE MATERIAL ON DELIVERY.";
  const termLines = doc.splitTextToSize(termsText, CONTENT_W);
  doc.text(termLines, MARGIN, y); y += termLines.length * 3.6 + 3;

  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(20);
  doc.text("Email: swagatply@gmail.com     Website: www.swagatply.com", PAGE_W / 2, y, { align: "center" });

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { buildInvoicePdf };
