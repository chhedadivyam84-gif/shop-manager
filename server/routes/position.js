/* ============================================================
   LIVE BUSINESS POSITION — one screen answering "where do I stand"

   Every figure here already existed somewhere in the app. What did not
   exist was all of them in one place, on one date, agreeing with each
   other. So nothing is recomputed in a new way: the same rules the ledgers
   already use are reused, which is what stops a card and the report behind
   it from disagreeing.

   MONEY OWED AND GOODS-NOT-YET-BILLED ARE SEPARATE FIGURES, deliberately.
   A challan is not a demand for payment — the app excludes it from
   outstanding on purpose — so folding it in would inflate what a party owes
   by the value of goods nobody has been billed for. They are two questions
   and they get two cards.

   Owner only. Every number here is one the shop's rules call confidential:
   cost, stock value, profit, and whole-company totals.
   ============================================================ */

const express = require("express");
const db = require("../db");
const { round2 } = require("../util");
const { requireRole } = require("../auth");
const { challanOutstanding } = require("../outstanding");

const router = express.Router();

router.use(requireRole("owner"));

/**
 * What a product cost the shop, most recently.
 *
 * Reads the newer multi-line purchases first and falls back to the older
 * stock_ins, because a shop that has used both should still get a cost for
 * everything it holds.
 */
function latestCost(productId) {
  const p = db.prepare(`
    SELECT pi.rate, pi.discount_amount, pi.pieces
      FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
     WHERE pi.product_id = ? AND p.voided = 0
     ORDER BY p.created_at DESC LIMIT 1
  `).get(productId);
  if (p && Number(p.pieces)) {
    const net = (Number(p.rate) || 0) * Number(p.pieces) - (Number(p.discount_amount) || 0);
    return net / Number(p.pieces);
  }
  const s = db.prepare(
    "SELECT cost_price FROM stock_ins WHERE product_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(productId);
  return s ? Number(s.cost_price) || 0 : 0;
}

router.get("/", (req, res) => {
  /* Stock valued at what it COST, not what it might fetch. A shop asking
     "what is my stock worth" means what it has tied up in it. */
  const sizes = db.prepare("SELECT stock, product_id FROM product_sizes").all();
  const costCache = new Map();
  let stockQty = 0, stockValue = 0;
  for (const s of sizes) {
    const qty = Number(s.stock) || 0;
    stockQty += qty;
    if (!costCache.has(s.product_id)) costCache.set(s.product_id, latestCost(s.product_id));
    stockValue += qty * costCache.get(s.product_id);
  }

  /* Movement totals come from the stock ledger, so they agree with the
     Stock History screen line for line rather than being counted twice by
     a second method. */
  const moved = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END), 0) AS inQty,
           COALESCE(SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END), 0) AS outQty
      FROM stock_ledger
  `).get();

  /* ---- purchases and sales, split by document and then added up --------
     A challan and an invoice are two different promises, so the shop is
     shown both and their sum rather than one figure that quietly means one
     of them. Delivered-but-unbilled is a real number a shop needs to see.

     TWO THINGS MAKE THIS EASY TO GET WRONG.

     1. CONVERSION DOUBLE-COUNTS. Turning a challan into an invoice COPIES
        its lines onto the new document and both keep them. Add every
        challan to every invoice and each converted one is counted twice —
        the dashboard would show goods that never moved. A challan that has
        been converted is therefore left out; its invoice speaks for it.
        Same rule material flow already uses, for the same reason.

     2. A SALES CHALLAN CARRIES NO HEADER TOTAL. invoices.total is 0 on
        one, because a delivery challan is a list of goods rather than a
        demand for money. Read straight, the card would show zero and look
        broken. The value comes from its own item lines instead. Written
        the same way on both sides so neither can drift, and harmless where
        a header total does exist — NULLIF only falls through on zero. */
  const salesInvoiceTotal = round2(db.prepare(
    "SELECT COALESCE(SUM(total),0) n FROM invoices WHERE voided = 0 AND doc_type = 'invoice'"
  ).get().n);
  const salesChallanTotal = round2(db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(i.total, 0), (
             SELECT ROUND(SUM(ii.qty * ii.rate * (1 - COALESCE(ii.discount_pct, 0) / 100.0)), 2)
               FROM invoice_items ii WHERE ii.invoice_id = i.id
           ), 0)), 0) AS n
      FROM invoices i
     WHERE i.voided = 0 AND i.doc_type = 'challan'
       AND (i.converted_invoice_id IS NULL OR i.converted_invoice_id = '')
  `).get().n);

  const purchaseInvoiceTotal = round2(db.prepare(
    "SELECT COALESCE(SUM(total),0) n FROM purchases WHERE voided = 0 AND (doc_type IS NULL OR doc_type <> 'challan')"
  ).get().n);
  const purchaseChallanTotal = round2(db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(p.total, 0), (
             SELECT ROUND(SUM(pi.qty * pi.rate - COALESCE(pi.discount_amount, 0)), 2)
               FROM purchase_items pi WHERE pi.purchase_id = p.id
           ), 0)), 0) AS n
      FROM purchases p
     WHERE p.voided = 0 AND p.doc_type = 'challan'
       AND (p.converted_purchase_id IS NULL OR p.converted_purchase_id = '')
  `).get().n);

  const salesTotal = round2(salesInvoiceTotal + salesChallanTotal);
  const purchaseTotal = round2(purchaseInvoiceTotal + purchaseChallanTotal);

  const receivable = round2(db.prepare("SELECT COALESCE(SUM(due),0) n FROM customers").get().n);
  const payable = round2(db.prepare("SELECT COALESCE(SUM(due),0) n FROM suppliers").get().n);
  const salesChallan = challanOutstanding("customer");
  const purchaseChallan = challanOutstanding("supplier");

  const cash = round2(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS n
      FROM cash_entries WHERE voided = 0
  `).get().n);

  const bank = round2(db.prepare("SELECT * FROM bank_accounts WHERE active = 1").all()
    .reduce((sum, a) => {
      const net = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS n
          FROM bank_entries WHERE bank_account_id = ? AND voided = 0
      `).get(a.id).n;
      return sum + (Number(a.opening_balance) || 0) + net;
    }, 0));

  /* Money that left the shop and was NOT a purchase or a supplier payment:
     rent, tea, freight. Those carry a source_type because the app posted
     them itself; an expense is one the shop typed. */
  const expenses = round2(db.prepare(`
    SELECT COALESCE(SUM(amount),0) n FROM cash_entries
     WHERE voided = 0 AND type = 'out'
       AND (source_type IS NULL OR TRIM(source_type) = '')
  `).get().n);

  const gs = db.prepare(`
    SELECT COALESCE(SUM(cgst),0) c, COALESCE(SUM(sgst),0) s, COALESCE(SUM(igst),0) i
      FROM invoices WHERE voided = 0 AND doc_type = 'invoice'
  `).get();
  const gp = db.prepare(`
    SELECT COALESCE(SUM(cgst),0) c, COALESCE(SUM(sgst),0) s, COALESCE(SUM(igst),0) i
      FROM purchases WHERE voided = 0
  `).get();
  const gstOnSales = round2(gs.c + gs.s + gs.i);
  const gstOnPurchases = round2(gp.c + gp.s + gp.i);

  res.json({
    stockValue: round2(stockValue),
    stockQty: round2(stockQty),
    stockIn: round2(moved.inQty),
    stockOut: round2(moved.outQty),

    /* Both halves and their sum, on both sides. The shop asks "what did I
       buy" and "how much of it is still only on a challan" as two
       questions, so it is shown two answers and the total — rather than one
       number that silently means whichever half somebody chose. */
    purchaseInvoiceTotal,
    purchaseChallanTotal,
    purchaseTotal,

    purchaseInvoiceOutstanding: payable,
    purchaseChallanOutstanding: purchaseChallan.total,
    purchaseChallanCount: purchaseChallan.count,
    purchaseOutstandingTotal: round2(payable + purchaseChallan.total),
    /* The old name for the invoice half, still answered so nothing that
       already reads it starts showing a blank. */
    purchaseOutstanding: payable,

    salesInvoiceTotal,
    salesChallanTotal,
    salesTotal,

    salesInvoiceOutstanding: receivable,
    salesChallanOutstanding: salesChallan.total,
    salesChallanCount: salesChallan.count,
    salesOutstandingTotal: round2(receivable + salesChallan.total),
    salesOutstanding: receivable,

    cash, bank, expenses,
    gstOnSales, gstOnPurchases, gstNet: round2(gstOnSales - gstOnPurchases),

    /* GROSS, and said so on the card. Sales less what the goods cost less
       the expenses above. This is not a profit and loss account —
       /reports/profit-loss is that, and the card links to it rather than
       pretending to replace it.

       INVOICES ONLY, DELIBERATELY, and this is the one figure on this
       screen that must not use the combined totals above. A challan is
       goods delivered and not yet billed: no bill, no revenue. Counting it
       here would book profit on money nobody has asked for yet, and the
       figure would fall again the moment the challan was converted and
       stopped being counted twice. The totals above answer "what has
       moved"; this one answers "what have I earned", and those are not the
       same question. */
    grossProfit: round2(salesInvoiceTotal - purchaseInvoiceTotal - expenses)
  });
});

module.exports = router;
