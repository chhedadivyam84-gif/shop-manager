const express = require("express");
const db = require("../db");
const { buildInvoicePdf } = require("../printing/pdf");
const { buildPurchaseOrderPdf } = require("../printing/poPdf");
const printer = require("../printing/printer");

const router = express.Router();

function getSettingsRow() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

/**
 * Whether the print pipeline is usable right now: the helper .exe is in
 * place AND the named Windows printer is reachable and not offline/faulted.
 * The phone calls this before offering "Print" at all, and Settings shows it
 * as a status pill — this IS the "can the Android app detect whether the
 * print server is online" requirement; there is no separate server to be
 * "online" or not, since this runs inside the same always-on shop-manager
 * process the phone is already talking to.
 */
router.get("/health", async (req, res) => {
  const fs = require("fs");
  const helperPresent = fs.existsSync(printer.SUMATRA_PATH);
  if (!helperPresent) {
    return res.json({
      online: false,
      reason: `Print helper not installed at ${printer.SUMATRA_PATH}. See README "Setting up silent printing".`
    });
  }
  const status = await printer.checkPrinterStatus();
  res.json({ online: status.online, reason: status.reason || null, printerName: printer.PRINTER_NAME, printerStatus: status.status || null });
});

/**
 * Submit an invoice or challan for silent printing. Body: { invoiceId,
 * showRate }. showRate only matters for a challan (mirrors the browser's
 * print-preview toggle); an invoice always prints with its rates.
 * Returns immediately with a jobId — printing itself can take longer than
 * any sane HTTP timeout, so the phone polls GET /jobs/:id for the outcome.
 */
router.post("/", async (req, res) => {
  const { invoiceId, showRate } = req.body;
  if (!invoiceId) return res.status(400).json({ error: "invoiceId is required." });

  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(invoiceId);
  const settings = getSettingsRow();
  const customer = invoice.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ?").get(invoice.customer_id) : null;

  let pdfBuffer;
  try {
    pdfBuffer = buildInvoicePdf({ ...invoice, items }, settings, customer, { showRate: !!showRate });
  } catch (err) {
    return res.status(500).json({ error: "Could not generate the PDF: " + err.message });
  }

  const jobId = printer.enqueue({
    invoiceId, docType: invoice.doc_type, showRate: !!showRate, pdfBuffer, req
  });
  res.status(202).json({ jobId, status: "queued" });
});

/** Poll this after POST / to find out when printing finished (or failed). */
/* ============================================================
   PURCHASE ORDER AS A PDF

   Streams the sheet straight back rather than queueing a print job: this is
   for handing to a supplier over WhatsApp, not for the shop's own printer.

   `?brand=Swagat` narrows it to one company, which is what the company-wise
   share sends. It is the same order and the same number either way — the
   brand only decides which lines are on the paper.
   ============================================================ */
router.get("/purchase-order/:id", (req, res) => {
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase Order not found." });

  const items = db.prepare(`
    SELECT poi.*,
           CASE WHEN COALESCE(NULLIF(TRIM(poi.size_label),''), '') <> ''
                THEN poi.size_label ELSE COALESCE(ps.label,'') END AS size_label
      FROM purchase_order_items poi
      LEFT JOIN product_sizes ps ON ps.id = poi.size_id
     WHERE poi.po_id = ?
     ORDER BY CASE WHEN COALESCE(poi.brand,'') = '' THEN 1 ELSE 0 END,
              poi.brand COLLATE NOCASE, poi.id`).all(po.id);

  /* The names the sheet prints. Resolved here rather than trusting the
     query string, so a link cannot put someone else's customer on a
     purchase order. */
  const nameOf = id => {
    if (!id) return null;
    const c = db.prepare("SELECT name FROM customers WHERE id = ?").get(id);
    return c ? c.name : null;
  };
  const so = po.so_id ? db.prepare("SELECT so_no FROM sales_orders WHERE id = ?").get(po.so_id) : null;
  const full = {
    ...po,
    against_customer_name: nameOf(po.against_customer_id),
    so_no: so ? so.so_no : null,
    items: items.map(it => ({ ...it, against_customer_name: nameOf(it.against_customer_id) || nameOf(po.against_customer_id) }))
  };

  const brand = (req.query.brand || "").trim() || null;
  if (brand) {
    const has = items.some(it => ((it.brand || "").trim() || "Other") === brand);
    if (!has) return res.status(400).json({ error: `Nothing on this order is from ${brand}.` });
  }

  const supplier = po.supplier_id
    ? db.prepare("SELECT * FROM suppliers WHERE id = ?").get(po.supplier_id)
    : null;

  let pdf;
  try {
    pdf = buildPurchaseOrderPdf(full, getSettingsRow(), supplier, { brand });
  } catch (err) {
    return res.status(500).json({ error: "Could not generate the PDF: " + err.message });
  }

  const safe = s => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `${safe(po.po_no)}${brand ? "-" + safe(brand) : ""}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${name}"`);
  res.setHeader("Content-Length", pdf.length);
  res.send(pdf);
});

router.get("/jobs/:id", (req, res) => {
  const job = printer.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Print job not found." });
  res.json(job);
});

/** Recent print history, for a troubleshooting view in Settings. */
router.get("/jobs", (req, res) => {
  res.json(printer.recentJobs());
});

module.exports = router;
