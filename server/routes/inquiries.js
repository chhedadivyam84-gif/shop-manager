const express = require("express");
const db = require("../db");
const { uid, logAction, todayStr } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

function nextInquiryNo() {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get("inquiry-no");
  const next = row ? row.value + 1 : 1;
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run("inquiry-no", next);
  return `INQ${String(next).padStart(7, "0")}`;
}

function nowTimeStr() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

router.get("/", (req, res) => {
  const { status, from, to, includeVoided } = req.query;
  const voidedClause = includeVoided === "true" ? "" : "AND voided = 0";
  let sql = "SELECT * FROM inquiries WHERE 1=1 " + voidedClause;
  const params = [];
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.get("/:id", (req, res) => {
  const inq = db.prepare("SELECT * FROM inquiries WHERE id = ?").get(req.params.id);
  if (!inq) return res.status(404).json({ error: "Inquiry not found." });
  res.json(inq);
});

router.post("/", (req, res) => {
  const customerName = (req.body.customerName || "").trim();
  if (!customerName) return res.status(400).json({ error: "Enter the customer's name." });
  const mobile = (req.body.mobile || "").trim();
  const companyName = (req.body.companyName || "").trim();
  const salesperson = (req.body.salesperson || "").trim() || (req.session && req.session.staffName) || "";
  const status = ["Open", "Follow-up", "Converted to Sale", "Closed"].includes(req.body.status) ? req.body.status : "Open";
  const date = (req.body.date || "").trim() || todayStr();
  const time = (req.body.time || "").trim() || nowTimeStr();

  const id = uid("INQ");
  const inquiryNo = nextInquiryNo();
  db.prepare(`
    INSERT INTO inquiries (id, inquiry_no, date, time, customer_name, mobile, company_name, salesperson, status, voided, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, inquiryNo, date, time, customerName, mobile, companyName, salesperson, status, Date.now());

  logAction(req, "inquiry.create", `${inquiryNo}: ${customerName}`);
  res.status(201).json(db.prepare("SELECT * FROM inquiries WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const inq = db.prepare("SELECT * FROM inquiries WHERE id = ?").get(req.params.id);
  if (!inq) return res.status(404).json({ error: "Inquiry not found." });
  if (inq.voided) return res.status(400).json({ error: "Can't edit a deleted inquiry." });

  const customerName = (req.body.customerName ?? inq.customer_name).trim();
  if (!customerName) return res.status(400).json({ error: "Enter the customer's name." });
  const mobile = (req.body.mobile ?? inq.mobile).trim();
  const companyName = (req.body.companyName ?? inq.company_name).trim();
  const salesperson = (req.body.salesperson ?? inq.salesperson).trim();
  const status = req.body.status && ["Open", "Follow-up", "Converted to Sale", "Closed"].includes(req.body.status) ? req.body.status : inq.status;
  const date = (req.body.date || "").trim() || inq.date;
  const time = (req.body.time || "").trim() || inq.time;

  db.prepare(`
    UPDATE inquiries SET date=?, time=?, customer_name=?, mobile=?, company_name=?, salesperson=?, status=? WHERE id=?
  `).run(date, time, customerName, mobile, companyName, salesperson, status, inq.id);

  logAction(req, "inquiry.edit", `${inq.inquiry_no}: ${inq.status} -> ${status}`);
  res.json(db.prepare("SELECT * FROM inquiries WHERE id = ?").get(inq.id));
});

// Soft delete only -- never a hard DELETE -- so a mistaken entry still shows
// up in an includeVoided lookup rather than being gone for good.
router.post("/:id/void", requireRole("owner"), (req, res) => {
  const inq = db.prepare("SELECT * FROM inquiries WHERE id = ?").get(req.params.id);
  if (!inq) return res.status(404).json({ error: "Inquiry not found." });
  if (inq.voided) return res.status(400).json({ error: "Inquiry already deleted." });

  db.prepare("UPDATE inquiries SET voided = 1 WHERE id = ?").run(inq.id);
  logAction(req, "inquiry.void", `${inq.inquiry_no}: ${inq.customer_name}`);
  res.json({ ok: true });
});

module.exports = router;
