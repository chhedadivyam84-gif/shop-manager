/* ============================================================
   PURCHASE ORDER PDF
   ------------------------------------------------------------
   The shop sends purchase orders to mills over WhatsApp, and a message full
   of text is not a document a supplier can file, sign, or hand to their
   despatch clerk. This draws the same order as a sheet of paper.

   Deliberately NOT built on buildInvoicePdf. An invoice is addressed to a
   customer and priced for them; a purchase order is addressed to a supplier
   and carries a chain an invoice has no notion of — salesman, the customer
   the material is for, the sales order behind it. Bending one layout to
   serve both would leave every future change to either of them stepping on
   the other.

   Two documents come out of here:

     whole order   every company on one sheet, grouped under headings.
     one company   only that company's lines, so a mill is not handed a
                   sheet quoting a competitor's rates.

   Both carry the SAME purchase order number. A company-wise sheet is a view
   of one order, never a second order.

   jsPDF primitives rather than HTML, for the same reason pdf.js gives: a
   headless browser would drag ~300MB of Chromium onto a shop PC that runs
   nothing but Node and SQLite.
   ============================================================ */
const { jsPDF } = require("jspdf");
const Pricing = require("../../public/js/pricing.js");

function fmt(n) {
  const v = Math.round((Number(n) || 0) + Number.EPSILON);
  return "Rs. " + v.toLocaleString("en-IN");
}

/** Items gathered under their company, in the order the caller supplied. */
function groupByBrand(items) {
  const out = [], seen = new Map();
  for (const it of items) {
    const brand = (it.brand || "").trim() || "Other";
    if (!seen.has(brand)) { const g = { brand, items: [] }; seen.set(brand, g); out.push(g); }
    seen.get(brand).items.push(it);
  }
  return out;
}

function lineTaxable(it) {
  return (Number(it.qty) || 0) * (Number(it.rate) || 0) - (Number(it.discount_amount) || 0);
}

/**
 * @param po        a purchase_orders row with `.items`, plus the resolved
 *                  `against_customer_name` / `so_no` that serialize() adds
 * @param settings  the shop's settings row
 * @param supplier  the suppliers row, or null
 * @param opts      { brand } to restrict the sheet to one company
 * @returns Buffer containing a complete PDF
 */
function buildPurchaseOrderPdf(po, settings, supplier, opts = {}) {
  const onlyBrand = opts.brand || null;
  const items = onlyBrand
    ? po.items.filter(it => ((it.brand || "").trim() || "Other") === onlyBrand)
    : po.items.slice();

  const PAGE_W = 210, PAGE_H = 297, MARGIN = 10;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const TABLE_BORDER = [23, 138, 110];
  const HEAD_FILL = [238, 244, 242];

  let y = MARGIN;
  let page = 1;

  const rule = (yy, x0 = MARGIN, x1 = PAGE_W - MARGIN) => doc.line(x0, yy, x1, yy);
  const bold = size => { doc.setFont("helvetica", "bold"); doc.setFontSize(size); };
  const norm = size => { doc.setFont("helvetica", "normal"); doc.setFontSize(size); };

  /* Every page carries the shop's identity and the order number. A supplier
     receiving page 2 of a five-company order should not have to hunt for
     which order it belongs to. */
  function pageHeader() {
    doc.setDrawColor(0); doc.setTextColor(0);
    y = MARGIN;
    bold(14);
    doc.text("PURCHASE ORDER", PAGE_W / 2, y + 5, { align: "center" });
    y += 5 + 3;
    rule(y); y += 5;

    bold(13);
    doc.text(settings.business_name || "Shop", PAGE_W / 2, y, { align: "center" }); y += 5;
    if (settings.tagline) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(8);
      doc.text(settings.tagline, PAGE_W / 2, y, { align: "center" }); y += 4;
    }
    if (settings.address) {
      norm(8);
      doc.splitTextToSize(settings.address, CONTENT_W - 10)
        .forEach(l => { doc.text(l, PAGE_W / 2, y, { align: "center" }); y += 3.7; });
    }
    const contact = [
      settings.gstin ? `GSTIN: ${settings.gstin}` : "",
      settings.phones ? `Ph: ${settings.phones}` : "",
      settings.email ? `Email: ${settings.email}` : ""
    ].filter(Boolean).join("   |   ");
    if (contact) { bold(7.5); doc.text(contact, PAGE_W / 2, y, { align: "center" }); y += 4; }
    y += 1; rule(y); y += 5;
  }

  function newPage() {
    doc.addPage();
    page += 1;
    pageHeader();
    bold(9);
    doc.text(`${po.po_no}${onlyBrand ? " — " + onlyBrand : ""}  (page ${page})`, MARGIN, y);
    y += 6;
  }

  /** Start a new page when the next `need` mm would run off the sheet. */
  function ensure(need) {
    if (y + need > PAGE_H - MARGIN - 12) newPage();
  }

  pageHeader();

  /* ---- Order identity, and who it is for ------------------------------- */
  const leftX = MARGIN + 2;
  const rightX = MARGIN + CONTENT_W * 0.55;
  const boxTop = y;

  const left = [];
  left.push(["Purchase Order No.", po.po_no || ""]);
  left.push(["Date", po.date || ""]);
  if (onlyBrand) left.push(["Company / Brand", onlyBrand]);
  if (po.required_delivery_date) left.push(["Required By", po.required_delivery_date]);
  if (po.expected_delivery_date) left.push(["Expected Delivery", po.expected_delivery_date]);
  left.push(["Status", po.status || ""]);

  /* The party chain. A supplier reading "Against Party: ABC Traders" knows
     whose requirement they are filling, which is the whole reason the shop
     wanted it on the sheet. */
  const right = [];
  if (supplier) right.push(["Supplier", supplier.name]);
  if (supplier && supplier.address) right.push(["", supplier.address]);
  if (supplier && supplier.phone) right.push(["", "Ph: " + supplier.phone]);
  if (supplier && supplier.gstin) right.push(["", "GSTIN: " + supplier.gstin]);
  if (po.salesman) right.push(["Salesman", po.salesman]);
  if (po.against_customer_name) right.push(["Against Party", po.against_customer_name]);
  if (po.so_no) right.push(["Sales Order", po.so_no]);

  const drawPairs = (pairs, x, wrapW) => {
    let yy = boxTop + 5;
    for (const [label, value] of pairs) {
      if (label) { bold(7.5); doc.text(label.toUpperCase(), x, yy); yy += 3.6; }
      norm(9.5);
      doc.splitTextToSize(String(value), wrapW).forEach(l => { doc.text(l, x, yy); yy += 4; });
      yy += 1;
    }
    return yy;
  };
  const leftEnd = drawPairs(left, leftX, CONTENT_W * 0.5 - 6);
  const rightEnd = drawPairs(right, rightX, CONTENT_W * 0.43 - 4);

  const boxBottom = Math.max(leftEnd, rightEnd) + 1;
  doc.setDrawColor(0);
  doc.rect(MARGIN, boxTop, CONTENT_W, boxBottom - boxTop);
  doc.line(rightX - 4, boxTop, rightX - 4, boxBottom);
  y = boxBottom + 5;

  /* ---- Items --------------------------------------------------------- */
  const COLS = [
    { key: "sr",    label: "#",       w: 8,   align: "left" },
    { key: "name",  label: "Product", w: 58,  align: "left" },
    { key: "size",  label: "Size",    w: 22,  align: "left" },
    { key: "party", label: "For",     w: 30,  align: "left" },
    { key: "qty",   label: "Qty",     w: 22,  align: "right" },
    { key: "rate",  label: "Rate",    w: 22,  align: "right" },
    { key: "amt",   label: "Amount",  w: 28,  align: "right" }
  ];
  /* The "For" column earns its place only on an order that names parties.
     On a stock purchase it would be 30mm of blank down the whole sheet. */
  const showParty = po.po_type === "AgainstCustomer" &&
                    items.some(it => it.against_customer_name);
  const cols = COLS.filter(c => c.key !== "party" || showParty);
  const totalW = cols.reduce((t, c) => t + c.w, 0);
  const scale = CONTENT_W / totalW;
  cols.forEach(c => { c.mm = c.w * scale; });

  function colX(i) {
    let x = MARGIN;
    for (let n = 0; n < i; n++) x += cols[n].mm;
    return x;
  }

  function tableHead() {
    doc.setFillColor(...HEAD_FILL);
    doc.rect(MARGIN, y, CONTENT_W, 7, "F");
    doc.setDrawColor(...TABLE_BORDER);
    doc.rect(MARGIN, y, CONTENT_W, 7);
    bold(8); doc.setTextColor(0);
    cols.forEach((c, i) => {
      const x = colX(i);
      doc.text(c.label, c.align === "right" ? x + c.mm - 2 : x + 2, y + 4.7,
        c.align === "right" ? { align: "right" } : undefined);
      if (i) doc.line(x, y, x, y + 7);
    });
    y += 7;
  }

  function row(cells, height) {
    doc.setDrawColor(...TABLE_BORDER);
    doc.rect(MARGIN, y, CONTENT_W, height);
    cols.forEach((c, i) => {
      const x = colX(i);
      if (i) doc.line(x, y, x, y + height);
      const lines = cells[c.key] || [];
      lines.forEach((t, n) => {
        doc.text(String(t), c.align === "right" ? x + c.mm - 2 : x + 2, y + 4.6 + n * 3.6,
          c.align === "right" ? { align: "right" } : undefined);
      });
    });
    y += height;
  }

  const groups = onlyBrand ? [{ brand: onlyBrand, items }] : groupByBrand(items);
  const manyBrands = groups.length > 1;

  ensure(20);
  tableHead();

  let sr = 0;
  let grandQty = 0;

  for (const g of groups) {
    if (manyBrands) {
      ensure(9);
      doc.setFillColor(...HEAD_FILL);
      doc.rect(MARGIN, y, CONTENT_W, 6, "F");
      doc.setDrawColor(...TABLE_BORDER);
      doc.rect(MARGIN, y, CONTENT_W, 6);
      bold(8.5);
      doc.text(g.brand.toUpperCase(), MARGIN + 2, y + 4.2);
      y += 6;
    }

    for (const it of g.items) {
      sr += 1;
      grandQty += Number(it.qty) || 0;

      norm(8.5);
      const nameCol = cols.find(c => c.key === "name");
      const nameLines = doc.splitTextToSize(it.name || "", nameCol.mm - 4);
      const extra = [];
      if (it.remark) doc.splitTextToSize("Note: " + it.remark, nameCol.mm - 4).forEach(l => extra.push(l));

      const partyCol = cols.find(c => c.key === "party");
      const partyLines = showParty
        ? doc.splitTextToSize(it.against_customer_name || "", partyCol.mm - 4)
        : [];

      const rows = Math.max(nameLines.length + extra.length, partyLines.length, 1);
      const h = Math.max(7, 3 + rows * 3.6);
      ensure(h + 4);

      row({
        sr: [sr],
        name: nameLines.concat(extra),
        size: [it.size_label || ""],
        party: partyLines,
        qty: [Pricing.formatQty(it.qty, it.mode)],
        rate: [fmt(it.rate)],
        amt: [fmt(lineTaxable(it))]
      }, h);
    }
  }

  /* ---- Totals --------------------------------------------------------- */
  ensure(40);
  y += 4;

  const boxW = CONTENT_W * 0.46;
  const boxX = PAGE_W - MARGIN - boxW;
  const totalsTop = y;

  const rows = [];
  rows.push(["Total Quantity", Pricing.formatQty(grandQty, (items[0] || {}).mode || "UNIT")]);

  /* A company-wise sheet must never show the whole order's money — the mill
     would read a total that includes a competitor's material. So it carries
     its own subtotal and nothing else. */
  if (onlyBrand) {
    const sub = items.reduce((t, it) => t + lineTaxable(it), 0);
    const gst = items.reduce((t, it) => t + lineTaxable(it) * ((Number(it.gst_rate) || 0) / 100), 0);
    rows.push(["Subtotal", fmt(sub)]);
    rows.push(["GST", fmt(gst)]);
    rows.push(["Total", fmt(sub + gst)]);
  } else {
    rows.push(["Subtotal", fmt(po.subtotal)]);
    if (po.discount_amount > 0) rows.push(["Discount", "- " + fmt(po.discount_amount)]);
    if (po.freight > 0) rows.push(["Freight", fmt(po.freight)]);
    if (po.other_charges > 0) rows.push(["Other Charges", fmt(po.other_charges)]);
    if (po.tax_type === "IGST") rows.push(["IGST", fmt(po.igst)]);
    else { rows.push(["CGST", fmt(po.cgst)]); rows.push(["SGST", fmt(po.sgst)]); }
    rows.push(["Grand Total", fmt(po.total)]);
  }

  let ty = totalsTop + 5;
  rows.forEach(([label, value], i) => {
    const last = i === rows.length - 1;
    if (last) { bold(10.5); doc.line(boxX, ty - 3.5, PAGE_W - MARGIN, ty - 3.5); }
    else norm(9);
    doc.text(label, boxX + 3, ty);
    doc.text(String(value), PAGE_W - MARGIN - 3, ty, { align: "right" });
    ty += last ? 6 : 4.6;
  });
  doc.setDrawColor(0);
  doc.rect(boxX, totalsTop, boxW, ty - totalsTop - 1);

  /* Terms sit beside the totals, not below, so a short order stays on one
     page instead of pushing the signature onto a second. */
  const termsW = boxX - MARGIN - 4;
  let sy = totalsTop + 5;
  const term = (label, value) => {
    if (!value) return;
    bold(7.5); doc.text(label.toUpperCase(), MARGIN + 3, sy); sy += 3.5;
    norm(8.5);
    doc.splitTextToSize(String(value), termsW - 6).forEach(l => { doc.text(l, MARGIN + 3, sy); sy += 3.6; });
    sy += 1.5;
  };
  term("Payment Terms", po.payment_terms);
  term("Delivery Terms", po.delivery_terms);
  term("Deliver To", po.delivery_address);
  term("Remarks", po.remarks);

  y = Math.max(ty, sy) + 8;

  /* ---- Signature ------------------------------------------------------ */
  ensure(24);
  const sigY = Math.min(y + 10, PAGE_H - MARGIN - 16);
  norm(8.5);
  doc.text("Supplier's Acknowledgement", MARGIN + 3, sigY);
  doc.line(MARGIN + 3, sigY + 10, MARGIN + 63, sigY + 10);
  bold(9);
  doc.text("For " + (settings.business_name || "Shop"), PAGE_W - MARGIN - 3, sigY, { align: "right" });
  doc.line(PAGE_W - MARGIN - 63, sigY + 10, PAGE_W - MARGIN - 3, sigY + 10);
  norm(8);
  doc.text("Authorised Signatory", PAGE_W - MARGIN - 3, sigY + 14, { align: "right" });

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { buildPurchaseOrderPdf };
