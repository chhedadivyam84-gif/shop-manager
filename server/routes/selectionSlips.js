/* ============================================================
   SELECTION SLIPS

   The counter's record of which designs a party picked.

   Almost everything here is a deliberate LOOSENING of the rules the priced
   documents enforce, and each one exists because tightening it would stop
   the slip being written at all:

     - the party need not be a customer
     - a line need not be a product
     - a quantity need not have been decided

   What it does NOT loosen is the number: a slip gets one from the same
   engine every other document uses, so two counters writing slips at the
   same moment cannot land on the same number.

   There is no "convert to quotation" here on purpose. A slip usually has no
   quantities, so it cannot become a priced document without a person typing
   them in. The front end loads the slip's lines into the Quotation screen
   instead, and tells us afterwards which quotation came out of it — see
   POST /:id/converted. That keeps one pricing engine in the app rather than
   a second one in here that would drift from it.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction, bindId } = require("../util");
const docNumber = require("../docNumber");

const router = express.Router();

/* Blank stays blank.

   The shop's rule, and the reason it is a rule: a slip line with no quantity
   means the party has not decided, and a slip line with 0 means they looked
   at it and did not want it. Number("") is 0 and Number(null) is 0, so every
   one of these has to be asked explicitly rather than coerced. */
function blankOrNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function lineAmount(qty, rate) {
  if (qty === null || rate === null) return 0;
  return round2(qty * rate);
}

function serialize(slip) {
  const items = db.prepare(
    "SELECT * FROM selection_slip_items WHERE slip_id = ? ORDER BY sr_no, id"
  ).all(slip.id);
  const customer = slip.customer_id
    ? db.prepare("SELECT id, name, phone FROM customers WHERE id = ?").get(slip.customer_id)
    : null;
  return { ...slip, items, customer };
}

/* A line is accepted as long as it identifies SOMETHING — a linked product,
   or a design number, or a description. A wholly empty row is silently
   dropped rather than refused: the screen always keeps a blank row at the
   bottom for the next design, and saving should not fail because of it. */
function buildItems(rawItems) {
  const out = [];
  let sr = 0;
  for (const raw of rawItems || []) {
    const designNo = String(raw.designNo || "").trim();
    const description = String(raw.description || "").trim();
    const remark = String(raw.remark || "").trim();
    const productId = raw.productId ? bindId(raw.productId) : null;

    if (!productId && !designNo && !description) continue;

    let product = null;
    if (productId) {
      product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
      if (!product) {
        throw { status: 400, error: `The product on line ${sr + 1} no longer exists. Remove it or pick another.` };
      }
    }

    /* A size is optional even when a product is linked. The party picked a
       design; which thickness they want is a later conversation. */
    let size = null;
    if (product && raw.sizeId != null && raw.sizeId !== "") {
      size = db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?")
        .get(bindId(raw.sizeId), product.id);
      if (!size) throw { status: 400, error: `That size is no longer available for ${product.name}.` };
    }

    const qty = blankOrNumber(raw.qty);
    const rate = blankOrNumber(raw.rate);
    if (qty !== null && qty < 0) throw { status: 400, error: `Quantity on line ${sr + 1} can't be negative.` };
    if (rate !== null && rate < 0) throw { status: 400, error: `Rate on line ${sr + 1} can't be negative.` };

    sr += 1;
    out.push({
      srNo: sr,
      productId: product ? product.id : null,
      sizeId: size ? size.id : null,
      /* The design number falls back to the product's SKU so a line picked
         from the product list still prints something in the Design No.
         column, which is the column the party reads back to us. */
      designNo: designNo || (product ? (product.sku || "") : ""),
      description: description || (product ? product.name : ""),
      qty, rate,
      amount: lineAmount(qty, rate),
      remark
    });
  }
  return out;
}

function slipTotal(items) {
  return round2(items.reduce((s, it) => s + it.amount, 0));
}

/* The header fields, cleaned the same way on create and edit. */
function readHeader(body, fallbackDate) {
  const type = String(body.referrerType || "").trim();
  const ALLOWED = ["Architect", "Interior Designer", "Contractor"];
  return {
    customerId: body.customerId || null,
    customerName: String(body.customerName || "").trim(),
    contact: String(body.contact || "").trim(),
    referrerType: ALLOWED.includes(type) ? type : "",
    referrerName: String(body.referrerName || "").trim(),
    referrerContact: String(body.referrerContact || "").trim(),
    siteAddress: String(body.siteAddress || "").trim(),
    salesman: String(body.salesman || "").trim(),
    salesmanContact: String(body.salesmanContact || "").trim(),
    remarks: String(body.remarks || "").trim(),
    date: (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : fallbackDate
  };
}

/* The name is what makes the slip findable weeks later, so it is the one
   thing that is genuinely required. A linked customer supplies it. */
function resolveName(h) {
  if (h.customerName) return h.customerName;
  if (h.customerId) {
    const c = db.prepare("SELECT name FROM customers WHERE id = ?").get(h.customerId);
    if (c) return c.name;
  }
  return "";
}

/* ---------------------------------------------------------------- list */
router.get("/", (req, res) => {
  const { customerId, salesman, status, designNo, from, to, q } = req.query;
  const where = [];
  const params = [];
  if (customerId) { where.push("s.customer_id = ?"); params.push(customerId); }
  if (salesman)   { where.push("s.salesman = ?");    params.push(salesman); }
  if (status)     { where.push("s.status = ?");      params.push(status); }
  if (from)       { where.push("s.date >= ?");       params.push(from); }
  if (to)         { where.push("s.date <= ?");       params.push(to); }
  if (q) {
    where.push("(s.customer_name LIKE ? OR s.contact LIKE ? OR s.slip_no LIKE ? OR s.referrer_name LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  /* Which party picked design 2066HG — the question the shop asks when a
     supplier says a design is discontinued, or when a new batch lands. */
  if (designNo) {
    where.push("EXISTS (SELECT 1 FROM selection_slip_items i WHERE i.slip_id = s.id AND i.design_no LIKE ?)");
    params.push(`%${designNo}%`);
  }

  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM selection_slip_items i WHERE i.slip_id = s.id) AS item_count
    FROM selection_slips s
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY s.created_at DESC
  `).all(...params);
  res.json(rows);
});

/** The number this slip WILL get, shown before it is saved. Peeks without
 *  consuming — an abandoned form must not tear a number out of the book. */
router.get("/next-number", (req, res) => {
  res.json({ slipNo: docNumber.peek("selection") });
});

/** Design numbers already used, so the screen can offer them back rather
 *  than have three staff spell the same laminate three ways. */
router.get("/design-numbers", (req, res) => {
  const rows = db.prepare(`
    SELECT design_no AS designNo, description, COUNT(*) AS times
    FROM selection_slip_items
    WHERE design_no <> ''
    GROUP BY 1
    ORDER BY times DESC, designNo
    LIMIT 400
  `).all();
  res.json(rows);
});

router.get("/:id", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  res.json(serialize(slip));
});

/* -------------------------------------------------------------- create */
router.post("/", (req, res) => {
  const h = readHeader(req.body, todayStr());
  const name = resolveName(h);
  if (!name) return res.status(400).json({ error: "Whose selection is this? Enter the customer's name." });

  let items;
  try { items = buildItems(req.body.items); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }
  if (!items.length) return res.status(400).json({ error: "Add at least one design to the slip." });

  const id = uid("SEL");
  let slipNo;
  try {
    slipNo = docNumber.resolve("selection", {
      manualNumber: req.body.manualNumber, useManual: !!req.body.useManual
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.error });
    throw err;
  }

  const insertItem = db.prepare(`
    INSERT INTO selection_slip_items
      (slip_id, sr_no, product_id, size_id, design_no, description, qty, rate, amount, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO selection_slips
        (id, slip_no, date, created_at, customer_id, customer_name, contact,
         referrer_type, referrer_name, referrer_contact, site_address,
         salesman, salesman_contact, remarks, total, status)
      VALUES (@id, @slipNo, @date, @createdAt, @customerId, @customerName, @contact,
         @referrerType, @referrerName, @referrerContact, @siteAddress,
         @salesman, @salesmanContact, @remarks, @total, 'Open')
    `).run({
      id, slipNo, date: h.date, createdAt: Date.now(),
      customerId: h.customerId, customerName: name, contact: h.contact,
      referrerType: h.referrerType, referrerName: h.referrerName, referrerContact: h.referrerContact,
      siteAddress: h.siteAddress, salesman: h.salesman, salesmanContact: h.salesmanContact,
      remarks: h.remarks, total: slipTotal(items)
    });
    items.forEach(it => insertItem.run(
      id, it.srNo, it.productId, it.sizeId, it.designNo, it.description,
      it.qty, it.rate, it.amount, it.remark
    ));
  })();

  logAction(req, "selection.create", `${slipNo}: ${name}, ${items.length} design(s)`);
  res.status(201).json(serialize(db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(id)));
});

/* ---------------------------------------------------------------- edit */
router.put("/:id", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  if (["Converted", "Cancelled"].includes(slip.status)) {
    return res.status(400).json({ error: `Can't edit a slip that's already ${slip.status}.` });
  }

  const h = readHeader(req.body, slip.date);
  const name = resolveName(h) || slip.customer_name;
  if (!name) return res.status(400).json({ error: "Whose selection is this? Enter the customer's name." });

  let items;
  try { items = buildItems(req.body.items); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ error: err.error }); throw err; }
  if (!items.length) return res.status(400).json({ error: "Add at least one design to the slip." });

  const insertItem = db.prepare(`
    INSERT INTO selection_slip_items
      (slip_id, sr_no, product_id, size_id, design_no, description, qty, rate, amount, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM selection_slip_items WHERE slip_id = ?").run(slip.id);
    items.forEach(it => insertItem.run(
      slip.id, it.srNo, it.productId, it.sizeId, it.designNo, it.description,
      it.qty, it.rate, it.amount, it.remark
    ));
    db.prepare(`
      UPDATE selection_slips SET
        date=@date, customer_id=@customerId, customer_name=@customerName, contact=@contact,
        referrer_type=@referrerType, referrer_name=@referrerName, referrer_contact=@referrerContact,
        site_address=@siteAddress, salesman=@salesman, salesman_contact=@salesmanContact,
        remarks=@remarks, total=@total
      WHERE id=@id
    `).run({
      id: slip.id, date: h.date, customerId: h.customerId, customerName: name, contact: h.contact,
      referrerType: h.referrerType, referrerName: h.referrerName, referrerContact: h.referrerContact,
      siteAddress: h.siteAddress, salesman: h.salesman, salesmanContact: h.salesmanContact,
      remarks: h.remarks, total: slipTotal(items)
    });
  })();

  logAction(req, "selection.edit", `${slip.slip_no}`);
  res.json(serialize(db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(slip.id)));
});

/* -------------------------------------------------------------- states */

/** The slip has been priced and sent. Still editable — the party changes
 *  their mind about a design far more often than about a bill. */
router.post("/:id/quoted", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  if (["Converted", "Cancelled"].includes(slip.status)) {
    return res.status(400).json({ error: `This slip is already ${slip.status}.` });
  }
  db.prepare("UPDATE selection_slips SET status = 'Quoted' WHERE id = ?").run(slip.id);
  logAction(req, "selection.quoted", `${slip.slip_no}`);
  res.json(serialize(db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(slip.id)));
});

/**
 * The front end has just saved a quotation built from this slip, and is
 * telling us which one. We record the link rather than create the quotation
 * ourselves: a slip normally carries no quantities, so a person has to type
 * them, and the moment they do it is the Quotation screen's pricing that
 * must apply — not a second copy of it living here.
 */
router.post("/:id/converted", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  const quotationId = req.body.quotationId;
  const quo = quotationId
    ? db.prepare("SELECT quotation_no FROM quotations WHERE id = ?").get(quotationId)
    : null;
  if (!quo) return res.status(400).json({ error: "That quotation no longer exists." });

  db.prepare("UPDATE selection_slips SET status = 'Converted', converted_quotation_id = ? WHERE id = ?")
    .run(quotationId, slip.id);
  logAction(req, "selection.convert", `${slip.slip_no} -> ${quo.quotation_no}`);
  res.json(serialize(db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(slip.id)));
});

/** Cancelled, not deleted. The slip is evidence that this party came in and
 *  what they looked at, and that stays worth having after the sale is lost. */
router.post("/:id/cancel", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  if (["Converted", "Cancelled"].includes(slip.status)) {
    return res.status(400).json({ error: `This slip is already ${slip.status}.` });
  }
  db.prepare("UPDATE selection_slips SET status = 'Cancelled' WHERE id = ?").run(slip.id);
  logAction(req, "selection.cancel", `${slip.slip_no}`);
  res.json(serialize(db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(slip.id)));
});

/** Reopen a cancelled slip — the party rang back. */
router.post("/:id/reopen", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  if (slip.status !== "Cancelled") {
    return res.status(400).json({ error: "Only a cancelled slip can be reopened." });
  }
  db.prepare("UPDATE selection_slips SET status = 'Open' WHERE id = ?").run(slip.id);
  logAction(req, "selection.reopen", `${slip.slip_no}`);
  res.json(serialize(db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(slip.id)));
});

/* -------------------------------------------------------------- delete
   Owner only, enforced globally for every DELETE under /api (see
   server/index.js). Nothing to reverse: a slip never moved stock or money.
   The number goes back into the book if it was the last one torn out. */
router.delete("/:id", (req, res) => {
  const slip = db.prepare("SELECT * FROM selection_slips WHERE id = ?").get(req.params.id);
  if (!slip) return res.status(404).json({ error: "Selection slip not found." });
  db.prepare("DELETE FROM selection_slips WHERE id = ?").run(slip.id);
  const released = docNumber.releaseIfLatest("selection", slip.slip_no);
  logAction(req, "selection.delete", `${slip.slip_no}${released ? " (number released)" : ""}`);
  res.json({ ok: true });
});

module.exports = router;
