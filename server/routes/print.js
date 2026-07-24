const express = require("express");
const db = require("../db");
const { buildInvoicePdf } = require("../printing/pdf");
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
