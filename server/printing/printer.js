/* ============================================================
   SILENT WINDOWS PRINTING
   ------------------------------------------------------------
   The Canon LBP2900 is a laser printer using Canon's CAPT driver —
   there is no raw command language (unlike a thermal ESC/POS
   printer) to write straight to the USB port. The ONLY reliable way
   to print to it programmatically is through the Windows print
   spooler, using the driver that's already installed.

   Node has no built-in way to do that, so this shells out to a small
   portable helper — SumatraPDF (sumatrapdfreader.org), the standard,
   widely-used tool for exactly this ("silently print a PDF to a named
   Windows printer from a script"). It is NOT bundled with this app:
   Claude is not permitted to download or run an installer/executable
   on the user's behalf, so the one-time setup step of fetching the
   portable .exe and placing it at the configured path is documented
   in the README instead. Once it's in place, everything from here on
   is fully automatic.

   Jobs are processed ONE AT A TIME through an in-memory FIFO queue —
   a shop PC printing a few invoices a day has no need for real
   concurrency, and serialising avoids two SumatraPDF processes
   fighting over the same printer.
   ============================================================ */
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const db = require("../db");
const { uid, logAction } = require("../util");

const SUMATRA_PATH = process.env.SUMATRA_PATH || path.join(__dirname, "..", "..", "data", "tools", "SumatraPDF.exe");
const PRINTER_NAME = process.env.PRINTER_NAME || "Canon LBP2900";
/* THE ARCHIVE BELONGS WITH THE DATA, NOT WITH THE CODE.
   This was built from __dirname, so it ignored DATA_DIR and wrote the PDFs
   into the application folder instead. On a host whose disk is ephemeral
   that is exactly the folder wiped on every redeploy, so a shop kept an
   archive that quietly disappeared each time the app was updated — and a
   test boot pointed at some other data directory still littered this one.

   Resolved the same way the database resolves it, so the two always live
   together. With DATA_DIR unset the path is unchanged, which is every
   install that keeps its data beside the code.

   Paths already written into print_jobs are absolute and are read back as
   they were stored, so anything archived under the old path still prints. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "..", "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "print-archive");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const queue = [];
let processing = false;

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ""), stderr: String(stderr || err ? err.message : "") });
    });
  });
}

/**
 * Best-effort read of the named printer's Windows spooler state via
 * PowerShell's Get-Printer, so an "offline" or "paused" printer produces a
 * meaningful error BEFORE a job is sent to it, rather than a generic failure
 * afterward. This cannot see physical faults a driver doesn't report to the
 * spooler (a laser printer's actual "out of paper" surfacing depends on the
 * CAPT driver, and isn't guaranteed here) — that limitation is real and
 * worth knowing rather than claiming false confidence.
 */
async function checkPrinterStatus(printerName = PRINTER_NAME) {
  const script = `
    $p = Get-Printer -Name "${printerName.replace(/"/g, '`"')}" -ErrorAction SilentlyContinue
    if ($null -eq $p) { Write-Output "NOT_FOUND"; exit 0 }
    Write-Output ("STATUS:" + $p.PrinterStatus)
    Write-Output ("OFFLINE:" + $p.WorkOffline)
  `;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8000);
  if (!r.ok) return { online: false, reason: "Could not query Windows print spooler: " + r.stderr };
  if (r.stdout.includes("NOT_FOUND")) {
    return { online: false, reason: `No printer named "${printerName}" is installed on this PC. Check the exact name in Windows Settings → Printers, and set PRINTER_NAME in data/.env to match.` };
  }
  const offline = /OFFLINE:True/i.test(r.stdout);
  const statusMatch = r.stdout.match(/STATUS:(\w+)/);
  const status = statusMatch ? statusMatch[1] : "Unknown";
  if (offline) return { online: false, reason: `Printer "${printerName}" is set to Work Offline in Windows.`, status };
  if (/Error|PaperOut|PaperJam|Offline/i.test(status)) {
    return { online: false, reason: `Printer "${printerName}" reports status "${status}" — check paper and cover.`, status };
  }
  return { online: true, status };
}

function updateJob(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE print_jobs SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

/**
 * Enqueue a print job. `pdfBuffer` is archived to disk immediately (this is
 * the "PDF invoice storage" the owner asked for) so the file exists even if
 * printing itself later fails — an owner can always find and re-print it.
 */
function enqueue({ invoiceId, docType, showRate, pdfBuffer, req }) {
  const id = uid("PJ");
  const fname = `${id}.pdf`;
  const pdfPath = path.join(ARCHIVE_DIR, fname);
  fs.writeFileSync(pdfPath, pdfBuffer);

  db.prepare(`
    INSERT INTO print_jobs (id, invoice_id, doc_type, show_rate, printer_name, pdf_path, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(id, invoiceId || null, docType, showRate ? 1 : 0, PRINTER_NAME, pdfPath, Date.now());

  logAction(req, "print.enqueue", `${docType} ${invoiceId || ""} -> ${PRINTER_NAME}`);
  queue.push(id);
  processQueue();
  return id;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const id = queue.shift();
    const job = db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(id);
    if (!job) continue;

    updateJob(id, { status: "printing" });

    if (!fs.existsSync(SUMATRA_PATH)) {
      updateJob(id, {
        status: "failed",
        error: `Print helper not found at ${SUMATRA_PATH}. See README "Setting up silent printing" — download SumatraPDF portable and place it there.`,
        finished_at: Date.now()
      });
      continue;
    }

    const status = await checkPrinterStatus(job.printer_name);
    if (!status.online) {
      updateJob(id, { status: "failed", error: status.reason, finished_at: Date.now() });
      continue;
    }

    // -print-to-default would use Windows' default printer; -print-to targets
    // the exact installed name so this works even if the shop PC's default
    // printer is something else (a PDF printer, another device, etc).
    const args = ["-print-to", job.printer_name, "-silent", job.pdf_path];
    const r = await run(SUMATRA_PATH, args, 30000);

    if (r.ok) {
      updateJob(id, { status: "done", finished_at: Date.now() });
    } else {
      updateJob(id, {
        status: "failed",
        error: `Print command failed (exit ${r.code}): ${r.stderr || "no further detail from the print helper"}`,
        finished_at: Date.now()
      });
    }
  }
  processing = false;
}

function getJob(id) {
  return db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(id);
}
function recentJobs(limit = 50) {
  return db.prepare("SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
}

module.exports = {
  enqueue, getJob, recentJobs, checkPrinterStatus,
  PRINTER_NAME, SUMATRA_PATH, ARCHIVE_DIR
};
