// Generic export endpoint.
//
// The print engine already has the exact rows the user is looking at, with the
// user's own column choices and With/Without Rate applied. Rather than every
// report growing its own server-side export route — which is how the Reports
// screen ended up with 23 report types and only 15 of them exporting — the
// client posts the finished grid here and gets a file back.
//
// That means a new report gets Excel and CSV for free the moment it declares
// its columns, and the download can never disagree with the screen, because
// there is no second query behind it.
const express = require("express");
const db = require("../db");
const { buildXlsx } = require("../xlsx");
const { requireRole } = require("../auth");

const router = express.Router();

function safeName(s) {
  return String(s || "report").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

/** One spreadsheet out of a header row and some rows. Every export below
 *  ends here, so they cannot disagree about headers, limits or filenames. */
function sendSheet(res, filename, header, rows) {
  const out = [header, ...rows];
  if (out.length > 50000) {
    return res.status(413).json({ error: "Too many rows to export in one file (limit 50,000)." });
  }
  const name = safeName(filename);
  let buf;
  try { buf = buildXlsx(out, name.slice(0, 31)); }
  catch (e) { return res.status(500).json({ error: "Could not build the file: " + e.message }); }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(buf);
}

/** An optional YYYY-MM-DD range, as SQL and parameters. */
function range(req, col) {
  const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
  const from = iso(req.query.from), to = iso(req.query.to);
  let sql = "", params = [];
  if (from) { sql += ` AND ${col} >= ?`; params.push(from); }
  if (to) { sql += ` AND ${col} <= ?`; params.push(to); }
  return { sql, params, label: from || to ? `${from || "start"}-to-${to || "date"}` : "all" };
}

router.post("/xlsx", (req, res) => {
  const { rows, filename, sheetName } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: "Nothing to export." });
  }
  // Guard against a runaway request turning into a several-hundred-megabyte
  // buffer held in memory on a 512mb container.
  if (rows.length > 50000) {
    return res.status(413).json({ error: "Too many rows to export in one file (limit 50,000)." });
  }
  const name = safeName(filename);
  // Excel refuses a sheet name over 31 chars or containing : \ / ? * [ ]
  const sheet = String(sheetName || "Report").replace(/[:\\/?*\[\]]/g, " ").slice(0, 31) || "Report";

  let buf;
  try {
    buf = buildXlsx(rows, sheet);
  } catch (e) {
    return res.status(500).json({ error: "Could not build the file: " + e.message });
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(buf);
});

/* ============================================================
   THE CATALOGUE

   Everything that can leave this shop as a file, in one list.

   The exports themselves were never the problem — there are already
   thirty-odd of them. Finding them was: most live behind the Reports
   screen, the Cash Book has its own, so does the Bank Book, and the
   whole-database backup is in Settings. Nobody would guess that, and a
   shop that cannot find its own data may as well not have it.

   So this is a REGISTRY, not a second set of exports. Every entry points
   at the route that already does the work — the same file the Reports
   screen downloads, byte for byte — except the last two, which had no
   export at all until now.

   Adding an export later means one entry here, and it appears on the
   screen with everything else.
   ============================================================ */
const CATALOGUE = [
  { group: "Parties", items: [
    { key: "customers", label: "Customers", url: "/api/reports/export?type=Customer",
      note: "Every customer with their total business and outstanding." },
    { key: "suppliers", label: "Suppliers", url: "/api/reports/export?type=Supplier",
      note: "Every supplier with what is owed to them." },
    { key: "party-wise", label: "Party-wise business", url: "/api/reports/export?type=Party",
      dated: true, note: "What each party bought or supplied over a period." },
  ]},
  { group: "Stock", items: [
    { key: "stock", label: "Products & stock", url: "/api/reports/export?type=Stock",
      note: "The catalogue with quantities." },
    { key: "stock-location", label: "Stock by location", url: "/api/reports/export?type=LocationStock",
      note: "Shop and warehouse separately." },
    { key: "brand", label: "Brand-wise stock", url: "/api/reports/export?type=Brand" },
  ]},
  { group: "Sales & Purchase", items: [
    { key: "sales", label: "Sales", url: "/api/reports/export?type=Sales", dated: true },
    { key: "invoices", label: "Tax invoices", url: "/api/reports/export?type=TaxInvoice", dated: true },
    { key: "challans", label: "Delivery challans", url: "/api/reports/export?type=Challan", dated: true },
    { key: "purchases", label: "Purchases", url: "/api/reports/export?type=Purchase", dated: true },
    { key: "purchase-bills", label: "Purchase bills", url: "/api/reports/export?type=PurchaseBill", dated: true },
  ]},
  { group: "Money", items: [
    { key: "cashbook", label: "Cash Book", url: "/api/cashbook/export", dated: true,
      note: "The cash ledger with running balance." },
    { key: "bankbook", label: "Bank Book", url: "/api/bankbook/export", dated: true },
    { key: "sale-payments", label: "Money received", url: "/api/reports/export?type=SalePayments", dated: true },
    { key: "purchase-payments", label: "Money paid", url: "/api/reports/export?type=PurchasePayments", dated: true },
    { key: "gst", label: "GST", url: "/api/reports/export?type=GST", dated: true },
  ]},
  /* NEW. These two had no export at all — see the routes below. */
  { group: "Staff Pay", ownerOnly: true, items: [
    { key: "employees", label: "Employees", url: "/api/export/employees",
      note: "Names, role, joining date and salary. Owner only, because it is what people are paid." },
    { key: "attendance", label: "Attendance", url: "/api/export/attendance", dated: true },
    { key: "kharchi", label: "Kharchi taken", url: "/api/export/kharchi", dated: true },
    { key: "salary-paid", label: "Salary paid", url: "/api/export/salary", dated: true },
  ]},
  { group: "Reminders", items: [
    { key: "reminders", label: "Reminders", url: "/api/export/reminders",
      note: "Everything still to do, and what has been ticked off." },
  ]},
  { group: "Everything", items: [
    { key: "backup", label: "Whole database backup", url: "/api/backup/download", ownerOnly: true,
      note: "One file holding the entire shop — the one to keep somewhere safe." },
  ]},
];

/** What this person may be offered. The routes themselves refuse again;
 *  this only decides what is worth drawing. */
router.get("/catalogue", (req, res) => {
  const owner = !!(req.session && req.session.role === "owner");
  const groups = CATALOGUE
    .map(g => ({
      group: g.group,
      items: g.items.filter(i => owner || (!i.ownerOnly && !g.ownerOnly))
    }))
    .filter(g => g.items.length);
  res.json({ owner, groups });
});

/* ------------------------------------------------------------------
   STAFF PAY

   Owner only, every one of them. permissions.js says salary is the
   owner's alone, and a spreadsheet is the easiest thing there is to
   carry out of a shop — so the file follows the same rule the screen
   does. /api/employees is already mounted behind requireRole("owner");
   these live here instead, so the whole catalogue is in one file, and
   they carry the same guard explicitly rather than inheriting one.
   ------------------------------------------------------------------ */
const ownerOnly = requireRole("owner");

router.get("/employees", ownerOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT name, mobile, job_role, joining_date, monthly_salary, salary_type, active, notes
      FROM employees ORDER BY active DESC, name`).all();
  sendSheet(res, "employees",
    ["Name", "Mobile", "Role", "Joined", "Salary", "Paid", "Status", "Notes"],
    rows.map(r => [r.name, r.mobile || "", r.job_role || "", r.joining_date || "",
                   r.monthly_salary || 0, r.salary_type || "", r.active ? "Active" : "Inactive",
                   r.notes || ""]));
});

router.get("/attendance", ownerOnly, (req, res) => {
  const r = range(req, "a.date");
  const rows = db.prepare(`
    SELECT a.date, e.name, a.status, a.note, a.marked_by
      FROM attendance a JOIN employees e ON e.id = a.employee_id
     WHERE 1=1${r.sql}
     ORDER BY a.date DESC, e.name`).all(...r.params);
  sendSheet(res, `attendance-${r.label}`,
    ["Date", "Employee", "Status", "Note", "Marked by"],
    rows.map(x => [x.date, x.name, x.status, x.note || "", x.marked_by || ""]));
});

router.get("/kharchi", ownerOnly, (req, res) => {
  const r = range(req, "k.date");
  const rows = db.prepare(`
    SELECT k.date, e.name, k.amount, k.reason, k.method, k.recorded_by, k.voided
      FROM kharchi_transactions k JOIN employees e ON e.id = k.employee_id
     WHERE 1=1${r.sql}
     ORDER BY k.date DESC, e.name`).all(...r.params);
  sendSheet(res, `kharchi-${r.label}`,
    ["Date", "Employee", "Amount", "Reason", "Paid by", "Given by", "Status"],
    rows.map(x => [x.date, x.name, x.amount || 0, x.reason || "", x.method || "",
                   x.recorded_by || "", x.voided ? "Cancelled" : "Taken"]));
});

router.get("/salary", ownerOnly, (req, res) => {
  const r = range(req, "p.date");
  const rows = db.prepare(`
    SELECT p.date, e.name, p.month, p.amount, p.method, p.notes, p.recorded_by, p.voided
      FROM salary_payments p JOIN employees e ON e.id = p.employee_id
     WHERE 1=1${r.sql}
     ORDER BY p.date DESC, e.name`).all(...r.params);
  sendSheet(res, `salary-paid-${r.label}`,
    ["Date", "Employee", "For month", "Amount", "Paid by", "Notes", "Paid out by", "Status"],
    rows.map(x => [x.date, x.name, x.month || "", x.amount || 0, x.method || "",
                   x.notes || "", x.recorded_by || "", x.voided ? "Cancelled" : "Paid"]));
});

/* ------------------------------------------------------------------
   REMINDERS

   Not owner-only: a reminder is somebody's job for today, and the people
   who do the jobs are the ones who need the list. Matches the guard on
   /api/reminders itself, which is signed-in and nothing more.
   ------------------------------------------------------------------ */
router.get("/reminders", (req, res) => {
  const r = range(req, "due_date");
  const rows = db.prepare(`
    SELECT text, due_date, due_time, link_kind, link_name, done, done_at, created_by
      FROM reminders WHERE 1=1${r.sql}
      ORDER BY done ASC, due_date ASC, due_time ASC`).all(...r.params);
  const when = ms => {
    const d = new Date(Number(ms) || 0);
    return isNaN(d) || !ms ? "" : d.toISOString().slice(0, 10);
  };
  sendSheet(res, `reminders-${r.label}`,
    ["Status", "Due", "Time", "Reminder", "About", "Name", "Done on", "Added by"],
    rows.map(x => [x.done ? "Done" : "Pending", x.due_date || "", x.due_time || "",
                   x.text, x.link_kind || "", x.link_name || "", when(x.done_at), x.created_by || ""]));
});

module.exports = router;
