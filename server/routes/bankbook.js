const express = require("express");
const db = require("../db");
const { uid, logAction, round2, todayStr } = require("../util");
const { requireRole } = require("../auth");
const { buildXlsx } = require("../xlsx");

const router = express.Router();

/**
 * Every non-voided entry ever made, oldest-first, each annotated with the
 * running bank balance immediately after it — the balance is a running
 * total over ALL history, never just whatever date range is being viewed,
 * so a filtered day still shows the true balance at that point in time.
 * Mirrors cashbook.js's chronoWithBalance() exactly, over bank_entries.
 */
function chronoWithBalance() {
  const rows = db.prepare(`
    SELECT * FROM bank_entries WHERE voided = 0 ORDER BY date ASC, created_at ASC
  `).all();
  let running = 0;
  return rows.map(r => {
    running = round2(running + (r.type === "in" ? r.amount : -r.amount));
    return { ...r, runningBalance: running };
  });
}

router.get("/", (req, res) => {
  const { from, to } = req.query;
  let rows = chronoWithBalance();
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);
  res.json(rows.reverse());
});

router.get("/summary", (req, res) => {
  const { from, to } = req.query;
  const date = req.query.date || todayStr();
  const rangeFrom = from || date;
  const rangeTo = to || date;

  const all = chronoWithBalance();
  const before = all.filter(r => r.date < rangeFrom);
  const inRange = all.filter(r => r.date >= rangeFrom && r.date <= rangeTo);

  const openingBalance = before.length ? before[before.length - 1].runningBalance : 0;
  const totalIn = round2(inRange.filter(r => r.type === "in").reduce((s, r) => s + r.amount, 0));
  const totalOut = round2(inRange.filter(r => r.type === "out").reduce((s, r) => s + r.amount, 0));
  const closingBalance = round2(openingBalance + totalIn - totalOut);

  res.json({
    from: rangeFrom, to: rangeTo,
    openingBalance, totalIn, totalOut, closingBalance,
    netCashFlow: round2(totalIn - totalOut),
    entryCount: inRange.length
  });
});

router.get("/export", (req, res) => {
  const { from, to } = req.query;
  let rows = chronoWithBalance();
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);

  const out = [["Date", "Type", "Party", "Category", "Remarks", "Bank In", "Bank Out", "Running Balance"]];
  rows.forEach(r => {
    out.push([
      r.date, r.type === "in" ? "Bank In" : "Bank Out", r.party || "", r.category || "", r.remarks || "",
      r.type === "in" ? r.amount : "", r.type === "out" ? r.amount : "", r.runningBalance
    ]);
  });
  const filename = `bank-book-${(from || "all")}-to-${(to || "date")}`;
  const buf = buildXlsx(out, filename);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

router.post("/", (req, res) => {
  const { date, type, party, category, remarks } = req.body;
  const amount = round2(Number(req.body.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  if (type !== "in" && type !== "out") return res.status(400).json({ error: "Choose Bank In or Bank Out." });
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr();

  const id = uid("BANK");
  db.prepare(`
    INSERT INTO bank_entries (id, date, type, amount, party, category, remarks, voided, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, entryDate, type, amount, (party || "").trim(), (category || "").trim(), (remarks || "").trim(), Date.now());

  logAction(req, "bankbook.create", `${type === "in" ? "+" : "-"}${amount} on ${entryDate}${party ? " (" + party + ")" : ""}`);
  res.status(201).json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const e = db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Can't edit a deleted entry." });

  const { date, type, party, category, remarks } = req.body;
  const amount = req.body.amount !== undefined ? round2(Number(req.body.amount)) : e.amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const entryType = (type === "in" || type === "out") ? type : e.type;
  const entryDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : e.date;

  db.prepare(`
    UPDATE bank_entries SET date=?, type=?, amount=?, party=?, category=?, remarks=? WHERE id=?
  `).run(entryDate, entryType, amount, (party ?? e.party).trim(), (category ?? e.category).trim(), (remarks ?? e.remarks).trim(), e.id);

  logAction(req, "bankbook.edit", `${e.id}: ${e.amount} -> ${amount}`);
  res.json(db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(e.id));
});

router.post("/:id/void", requireRole("owner"), (req, res) => {
  const e = db.prepare("SELECT * FROM bank_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Entry not found." });
  if (e.voided) return res.status(400).json({ error: "Entry already deleted." });

  db.prepare("UPDATE bank_entries SET voided = 1 WHERE id = ?").run(e.id);
  logAction(req, "bankbook.void", `${e.type === "in" ? "+" : "-"}${e.amount} on ${e.date}`);
  res.json({ ok: true });
});

module.exports = router;
