/* ============================================================
   REMINDERS

   What the shop has left undone, worked out from the books rather than kept
   as its own list. Nothing here is stored: a reminder that has to be ticked
   off by hand is a second set of records to forget to update, and the day it
   disagrees with the ledger it becomes worse than useless.

   So every line below is a question asked of live data. Bill it and the
   reminder goes; deliver it and the reminder goes.
   ============================================================ */
const express = require("express");
const db = require("../db");
const backup = require("../backup");

const router = express.Router();

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Days from an ISO date to today. Positive = overdue. */
function daysOverdue(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const then = Date.parse(iso + "T00:00:00");
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.parse(todayISO() + "T00:00:00") - then) / 86400000);
}

router.get("/", (req, res) => {
  const today = todayISO();
  const groups = [];
  const add = (key, title, tone, items) => {
    if (items.length) groups.push({ key, title, tone, count: items.length, items });
  };
  const money = n => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");

  /* ---- goods gone out with no bill raised ------------------------------ */
  const salesChallans = db.prepare(`
    SELECT i.id, i.challan_no, i.date, c.name AS party
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.doc_type = 'challan' AND i.voided = 0 AND i.converted_invoice_id IS NULL
     ORDER BY i.date ASC LIMIT 50`).all();
  add("sales-unbilled", "Challans waiting to be billed", "warn",
    salesChallans.map(r => {
      const d = daysOverdue(r.date);
      return { id: r.id, line: `${r.challan_no} · ${r.party || "—"}`,
        sub: d > 0 ? `${d} day${d === 1 ? "" : "s"} old` : "today", goto: "billing" };
    }));

  /* ---- goods received with no supplier bill --------------------------- */
  const purchaseChallans = db.prepare(`
    SELECT p.id, p.purchase_no, p.date, s.name AS party
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.doc_type = 'challan' AND p.voided = 0 AND p.converted_purchase_id IS NULL
     ORDER BY p.date ASC LIMIT 50`).all();
  add("purchase-unbilled", "Purchase challans waiting for a supplier bill", "warn",
    purchaseChallans.map(r => {
      const d = daysOverdue(r.date);
      return { id: r.id, line: `${r.purchase_no} · ${r.party || "—"}`,
        sub: d > 0 ? `${d} day${d === 1 ? "" : "s"} old` : "today", goto: "purchase" };
    }));

  /* ---- money owed to the shop, past its due date ----------------------- */
  const overdueIn = db.prepare(`
    SELECT i.id, i.challan_no, i.due_date, i.balance_due, c.name AS party
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.voided = 0 AND i.doc_type = 'invoice'
       AND COALESCE(i.balance_due, 0) > 0
       AND i.due_date IS NOT NULL AND i.due_date <> '' AND i.due_date < ?
     ORDER BY i.due_date ASC LIMIT 50`).all(today);
  add("receivable-overdue", "Payments overdue from customers", "bad",
    overdueIn.map(r => ({ id: r.id,
      line: `${r.party || "—"} · ${money(r.balance_due)}`,
      sub: `${r.challan_no} · ${daysOverdue(r.due_date)} day(s) past due`, goto: "outstanding" })));

  /* ---- money the shop owes, past its due date -------------------------- */
  const overdueOut = db.prepare(`
    SELECT p.id, p.purchase_no, p.due_date, p.total, s.name AS party
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.voided = 0 AND p.payment_method = 'Credit'
       AND p.due_date IS NOT NULL AND p.due_date <> '' AND p.due_date < ?
     ORDER BY p.due_date ASC LIMIT 50`).all(today);
  add("payable-overdue", "Payments due to suppliers", "bad",
    overdueOut.map(r => ({ id: r.id,
      line: `${r.party || "—"} · ${money(r.total)}`,
      sub: `${r.purchase_no} · ${daysOverdue(r.due_date)} day(s) past due`, goto: "accounts" })));

  /* ---- cheques coming up or already dated ------------------------------ */
  const cheques = db.prepare(`
    SELECT id, cheque_no, payee_name, amount, cheque_date, status
      FROM cheques
     WHERE voided = 0 AND status NOT IN ('Cleared', 'Cancelled', 'Bounced')
       AND cheque_date IS NOT NULL AND cheque_date <> ''
     ORDER BY cheque_date ASC LIMIT 50`).all();
  add("cheques-due", "Cheques to watch", "warn",
    cheques.filter(c => {
      const d = daysOverdue(c.cheque_date);
      return d !== null && d >= -7;          // dated, or due within a week
    }).map(c => {
      const d = daysOverdue(c.cheque_date);
      return { id: c.id, line: `${c.cheque_no} · ${c.payee_name || "—"} · ${money(c.amount)}`,
        sub: d > 0 ? `dated ${c.cheque_date}, ${d} day(s) ago` : `due ${c.cheque_date}`,
        goto: "cheque" };
    }));

  /* ---- goods sold but not yet delivered -------------------------------- */
  let undelivered = [];
  try {
    undelivered = db.prepare(`
      SELECT dd.id, dd.customer_name, dd.status, d.dispatch_no, a.area AS area
        FROM dispatch_drops dd
        JOIN dispatches d ON d.id = dd.dispatch_id
        LEFT JOIN areas a ON a.id = dd.area_id
       WHERE dd.status IN ('Pending', 'Ready', 'Out')
       ORDER BY d.dispatch_at ASC LIMIT 50`).all();
  } catch { /* dispatch module not built on this copy */ }
  add("dispatch-open", "Deliveries still out", "info",
    undelivered.map(r => ({ id: r.id,
      line: `${r.customer_name || "—"} · ${r.area || "no area"}`,
      sub: `${r.dispatch_no} · ${r.status}`, goto: "delivery" })));

  /* ---- stock that has run down ----------------------------------------- */
  let lowStock = [];
  try {
    lowStock = db.prepare(`
      SELECT p.id, p.name, p.stock FROM products p
       WHERE p.active = 1 AND COALESCE(p.stock, 0) <= 0
       ORDER BY p.name LIMIT 30`).all();
  } catch { /* older schema */ }
  add("stock-out", "Products showing no stock", "info",
    lowStock.map(r => ({ id: r.id, line: r.name, sub: "nothing on the racks", goto: "inventory" })));


  /* ---- the backup store filling up --------------------------------------

     Asked for by the shop after a full bucket took the app down: warn while
     there is still time to do something, not once uploads have started
     failing. Read from the measurement rotation already took — no network
     call happens while this screen is drawn. */
  /* Owner only: the Backups screen it points at is owner only, and a warning
     nobody at the counter can act on is just noise. */
  const usage = req.session.role === "owner" ? backup.cloudUsage() : null;
  if (usage && usage.limit) {
    const pct = Math.round(usage.used * 100);
    const mb = Math.round(usage.bytes / 1048576);
    const gb = (usage.limit / 1073741824).toFixed(usage.limit >= 1073741824 ? 0 : 1);
    if (usage.used >= 0.7) {
      add("backup-storage", "Backup storage is filling up", usage.used >= 0.9 ? "bad" : "warn", [{
        id: "storage",
        line: `${usage.label} is ${pct}% full — ${mb} MB of ${gb} GB`,
        sub: usage.used >= 0.9
          ? "Uploads stop when it is full. Clear old backups now."
          : "Clear some old backups before it runs out.",
        goto: "backups"
      }]);
    }
  }

  res.json({
    generatedAt: Date.now(),
    total: groups.reduce((t, g) => t + g.count, 0),
    groups
  });
});

module.exports = router;
