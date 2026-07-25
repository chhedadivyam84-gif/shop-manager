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
  const newPageIfNeeded = (need) => {
    if (y + need > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
      return true;
    }
    return false;
  };

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

  // ---- Parties row ----
  const partyLabel = challan ? "Deliver To" : "Bill To";
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(120);
  doc.text(partyLabel.toUpperCase(), MARGIN, y);
  const docLabel = challan ? "Challan No" : "Estimate No";
  doc.text(docLabel.toUpperCase(), PAGE_W - MARGIN, y, { align: "right" });
  y += 4.5;

  const partyTopY = y;
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(0);
  doc.text(customer ? customer.name : "Walk-in Customer", MARGIN, y);
  rightText(invoice.challan_no, y, 10.5);
  y += 4.5;
  rightText("Date: " + invoice.date, y, 9);
  y += 3;

  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60);
  if (customer) {
    const custLine = [customer.type, customer.phone].filter(Boolean).join(" - ");
    if (custLine) { doc.text(custLine, MARGIN, y); y += 4; }
    if (customer.address) {
      const custAddrLines = doc.splitTextToSize(customer.address, CONTENT_W * 0.55);
      doc.text(custAddrLines, MARGIN, y); y += custAddrLines.length * 4;
    }
    if (customer.gst) { doc.text("GSTIN: " + customer.gst, MARGIN, y); y += 4; }
  }
  y = Math.max(y, partyTopY + 8) + 2;
  line(y); y += 6;

  // ---- Table ----
  const cols = showRate
    ? [{ h: "#", w: 8 }, { h: "Particulars", w: 62 }, { h: "Size", w: 28 }, { h: "Qty", w: 16 },
       { h: "Total", w: 26, align: "right" }, { h: "Rate", w: 26, align: "right" }, { h: "Amount", w: 24, align: "right" }]
    : [{ h: "#", w: 12 }, { h: "Particulars", w: 90 }, { h: "Size", w: 40 }, { h: "Qty", w: 20 },
       { h: "Total", w: CONTENT_W - 12 - 90 - 40 - 20, align: "right" }];

  const drawTableHeader = () => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(60);
    let x = MARGIN;
    cols.forEach(c => {
      doc.text(c.h.toUpperCase(), c.align === "right" ? x + c.w : x, y, c.align === "right" ? { align: "right" } : undefined);
      x += c.w;
    });
    y += 2; line(y); y += 4.5;
    doc.setTextColor(0);
  };
  drawTableHeader();

  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  invoice.items.forEach((it, i) => {
    newPageIfNeeded(6);
    if (y === MARGIN) drawTableHeader();
    const mode = it.mode || "UNIT";
    const values = showRate
      ? [String(i + 1), it.name, it.size_label || "-", String(it.pieces || it.qty),
         Pricing.formatQty(it.qty, mode), Pricing.formatRate(it.rate, mode), fmtPaise(it.qty * it.rate).replace("Rs. ", "")]
      : [String(i + 1), it.name, it.size_label || "-", String(it.pieces || it.qty), Pricing.formatQty(it.qty, mode)];
    let x = MARGIN;
    cols.forEach((c, ci) => {
      const text = doc.splitTextToSize(String(values[ci] ?? ""), c.w - 1);
      doc.text(text, c.align === "right" ? x + c.w : x, y, c.align === "right" ? { align: "right" } : undefined);
      x += c.w;
    });
    y += 5;
    doc.setDrawColor(230); doc.line(MARGIN, y - 1.5, PAGE_W - MARGIN, y - 1.5); doc.setDrawColor(0);
  });
  y += 2;

  // ---- Totals / challan footer ----
  newPageIfNeeded(challan ? 30 : 45);
  if (challan) {
    const totalPieces = invoice.items.reduce((s, it) => s + (Number(it.pieces) || 0), 0);
    const subtotal = invoice.items.reduce((s, it) => s + (it.qty * it.rate || 0), 0);
    if (showRate && subtotal > 0) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      rightText("Subtotal (reference only): " + fmtPaise(subtotal), y); y += 5;
    }
    if (invoice.transport > 0) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      rightText("Transport: " + fmtPaise(invoice.transport), y); y += 5;
    }
    if (invoice.loading > 0) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      rightText("Loading / Labour: " + fmtPaise(invoice.loading), y); y += 5;
    }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    rightText("Total Pieces: " + totalPieces, y); y += 14;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text("Received the above goods in good condition.", MARGIN, y); y += 16;
    doc.setFontSize(8.5);
    doc.text("Receiver's Signature", MARGIN + 10, y);
    rightText("For " + (settings.business_name || "Shop"), y);
    doc.line(MARGIN, y - 2, MARGIN + 45, y - 2);
    doc.line(PAGE_W - MARGIN - 45, y - 2, PAGE_W - MARGIN, y - 2);
    y += 8;
  } else {
    const totalsX = PAGE_W - MARGIN - 65;
    const row = (label, value, bold) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(bold ? 10.5 : 9);
      doc.text(label, totalsX, y);
      doc.text(value, PAGE_W - MARGIN, y, { align: "right" });
      y += bold ? 6 : 5;
    };
    row("Subtotal", fmtPaise(invoice.subtotal));
    if (invoice.discount_amount > 0) row("Discount", "-" + fmtPaise(invoice.discount_amount));
    if (invoice.transport > 0) row("Transport", fmtPaise(invoice.transport));
    if (invoice.loading > 0) row("Loading", fmtPaise(invoice.loading));
    if (invoice.tax_type === "IGST") row("IGST", fmtPaise(invoice.igst));
    else { row("CGST", fmtPaise(invoice.cgst)); row("SGST", fmtPaise(invoice.sgst)); }
    if (invoice.round_off) row("Round Off", (invoice.round_off > 0 ? "+" : "") + fmtPaise(invoice.round_off));
    doc.setDrawColor(0); doc.line(totalsX, y - 4, PAGE_W - MARGIN, y - 4);
    row("Grand Total", fmtPaise(invoice.total), true);
    if (invoice.advance > 0) { row("Advance Paid", "-" + fmtPaise(invoice.advance)); row("Balance Due", fmtPaise(invoice.balance_due), true); }
    y += 2;
    doc.setFont("helvetica", "bold"); doc.setFontSize(8);
    doc.text("Amount in words:", MARGIN, y); y += 4;
    doc.setFont("helvetica", "normal");
    const words = doc.splitTextToSize(Pricing.amountInWords(invoice.total), CONTENT_W);
    doc.text(words, MARGIN, y); y += words.length * 4 + 2;
  }

  // ---- Footer: terms + contact ----
  newPageIfNeeded(20);
  line(y); y += 5;
  doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(20);
  const termsText = challan
    ? "This is a delivery challan and not a tax invoice - it is not a demand for payment."
    : "NO GURANTEE AND WARRANTY FOR DECORATIVE PRODUCTS AND AIR BUBBLES IN LAMMINATES, ACRYLIC AND PVC LAMINATES OR ANY SHADE VARIATION AFTER INSTALLATION. NO EXCHANGE. NO RETURN IN ANY CONDITION. PLEASE CHECK THE MATERIAL ON DELIVERY.";
  const termLines = doc.splitTextToSize(termsText, CONTENT_W);
  doc.text(termLines, MARGIN, y); y += termLines.length * 3.6 + 3;

  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(20);
  doc.text("Email: swagatply@gmail.com     Website: www.swagatply.com", PAGE_W / 2, y, { align: "center" });

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { buildInvoicePdf };
