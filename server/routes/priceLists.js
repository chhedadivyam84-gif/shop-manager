/**
 * Price lists — the party-wise rates behind every sale and purchase.
 *
 * Owner and Sales Manager only, and that is a commercial decision rather
 * than a technical one: a rate is what the shop earns, and a salesman who
 * can rewrite the list can give the shop's margin away without anyone
 * having to approve it. They can still override a rate on one bill, which
 * shows up on that bill with their name on it — the difference is that a
 * list change is silent and permanent.
 *
 * A RATE IS NEVER EDITED IN PLACE. Changing a price closes the current row
 * and inserts a new one, so what was charged in March is still answerable
 * in September, and a back-dated bill still gets March's rate. See
 * server/priceList.js for the resolution that depends on it.
 */
const express = require("express");
const db = require("../db");
const { uid, todayStr, round2, logAction } = require("../util");
const { requireRole } = require("../auth");
const priceList = require("../priceList");

const router = express.Router();

/* Who may change a rate. Kept here as one predicate rather than repeated
   on each route, so a new route cannot be added without it. */
function mayEditPrices(req) {
  if (!req.session || !req.session.loggedIn) return false;
  if (req.session.previewStaffId) return false;      // owner previewing as staff
  if (req.session.role === "owner") return true;
  const s = db.prepare("SELECT job_role FROM staff WHERE id = ?").get(req.session.staffId);
  return !!(s && s.job_role === "Sales Manager");
}
function requirePriceEditor(req, res, next) {
  if (mayEditPrices(req)) return next();
  return res.status(403).json({
    error: "Only the owner or a Sales Manager can change a price list. "
         + "You can still change the rate on a single bill."
  });
}

const SIDES = ["sale", "purchase"];
const cleanSide = v => (SIDES.includes(String(v || "")) ? String(v) : "sale");
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

function decorate(row) {
  const p = row.product_id ? db.prepare("SELECT name, brand, category, unit FROM products WHERE id = ?").get(row.product_id) : null;
  const party = row.party_id
    ? db.prepare(`SELECT name FROM ${row.side === "purchase" ? "suppliers" : "customers"} WHERE id = ?`).get(row.party_id)
    : null;
  return {
    ...row,
    product_name: p ? p.name : "(product removed)",
    party_name: party ? party.name : "",
    /* Said plainly rather than left for the screen to infer from a null. */
    scope: row.party_id ? "party" : "general",
    current: !row.effective_to && row.active === 1
  };
}

function log(req, action, row, oldRate, reason) {
  const p = row.product_id ? db.prepare("SELECT name FROM products WHERE id = ?").get(row.product_id) : null;
  const party = row.party_id
    ? db.prepare(`SELECT name FROM ${row.side === "purchase" ? "suppliers" : "customers"} WHERE id = ?`).get(row.party_id)
    : null;
  db.prepare(`
    INSERT INTO price_list_log (id, at, side, party_id, party_name, product_id, product_name,
      size_label, action, old_rate, new_rate, reason, by_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(uid("PLL"), Date.now(), row.side, row.party_id || null, party ? party.name : "",
    row.product_id, p ? p.name : "", row.size_label || "", action,
    oldRate == null ? null : oldRate, row.rate, reason || "",
    (req.session && req.session.staffName) || "");
}

/* ------------------------------------------------------------------ read */

/** The list, filtered however the screen is showing it. */
router.get("/", (req, res) => {
  const side = cleanSide(req.query.side);
  const { partyId, productId, scope } = req.query;
  const where = ["side = ?"];
  const params = [side];
  if (partyId) { where.push("party_id = ?"); params.push(partyId); }
  else if (scope === "general") where.push("party_id IS NULL");
  if (productId) { where.push("product_id = ?"); params.push(productId); }
  if (req.query.currentOnly === "1") where.push("active = 1 AND (effective_to IS NULL OR effective_to = '')");

  const rows = db.prepare(`
    SELECT * FROM price_list WHERE ${where.join(" AND ")}
    ORDER BY effective_from DESC, created_at DESC
  `).all(...params);
  res.json(rows.map(decorate));
});

/**
 * What rate applies right now — asked by the billing screen the moment a
 * product is chosen. Returns the party's rate, the general rate and what
 * they were last actually charged, all three, because a salesman deciding
 * whether to override needs to see them together.
 */
router.get("/resolve", (req, res) => {
  const side = cleanSide(req.query.side);
  const partyId = req.query.partyId || null;
  const productId = req.query.productId;
  const sizeId = req.query.sizeId ? Number(req.query.sizeId) : null;
  if (!productId) return res.status(400).json({ error: "Which product?" });

  const r = priceList.resolve({
    side, partyId, productId, sizeId,
    date: isDate(req.query.date) ? req.query.date : todayStr(),
    qty: req.query.qty === undefined || req.query.qty === "" ? null : Number(req.query.qty)
  });
  const last = priceList.lastSoldRate({ side, partyId, productId, sizeId });
  res.json({ ...r, lastRate: last ? last.rate : null, lastOn: last ? last.date : null, lastDoc: last ? last.number : null });
});

/**
 * Every rate that applies to one party, resolved, in one call.
 *
 * The billing screen needs a rate the instant a product is tapped, and
 * asking the server per tap would put a network round trip between the
 * counter and the price appearing. So the whole answer is fetched once when
 * the customer is chosen.
 *
 * THE SERVER RESOLVES, NOT THE CLIENT. What comes back is already the
 * decision — party beats general, specific size beats any size, latest
 * effective wins — keyed by size. The screen looks up a size and shows what
 * it is told. Re-implementing the priority rules in the browser would be
 * the same rules twice, and the copy in the browser is the one that would
 * quietly fall behind.
 *
 * Quantity bands come back with each entry rather than resolved, because
 * the quantity is not known until it is typed.
 */
router.get("/for-party", (req, res) => {
  const side = cleanSide(req.query.side);
  const partyId = req.query.partyId || null;
  const on = isDate(req.query.date) ? req.query.date : todayStr();

  /* Only products that actually have a rate somewhere. A shop with three
     thousand products and nine price-list rows should get nine. */
  const productIds = db.prepare(`
    SELECT DISTINCT product_id FROM price_list
    WHERE side = ? AND active = 1 AND (party_id IS NULL OR party_id = ?)
  `).all(side, partyId || "").map(r => r.product_id);

  const bySize = {};
  const byProduct = {};
  productIds.forEach(pid => {
    const sizes = db.prepare("SELECT id FROM product_sizes WHERE product_id = ?").all(pid);
    /* Resolved per size, because a rate may be written for one size and not
       another, and the screen asks by size. */
    sizes.forEach(s => {
      const r = priceList.resolve({ side, partyId, productId: pid, sizeId: s.id, date: on });
      if (r.rate != null && r.source !== "product") {
        bySize[s.id] = {
          rate: r.rate, source: r.source,
          partyRate: r.partyRate, generalRate: r.generalRate, bands: r.bands
        };
      }
    });
    /* And once for the product with no size, so a rate written without a
       size still reaches a product whose sizes changed afterwards. */
    const pr = priceList.resolve({ side, partyId, productId: pid, sizeId: null, date: on });
    if (pr.rate != null && pr.source !== "product") {
      byProduct[pid] = { rate: pr.rate, source: pr.source, partyRate: pr.partyRate, generalRate: pr.generalRate, bands: pr.bands };
    }
  });

  res.json({ partyId, side, date: on, bySize, byProduct });
});

/** Every rate ever set for this party and product — the Price History. */
router.get("/history", (req, res) => {
  const rows = priceList.history({
    side: cleanSide(req.query.side),
    partyId: req.query.partyId || null,
    productId: req.query.productId,
    sizeId: req.query.sizeId ? Number(req.query.sizeId) : null
  });
  res.json(rows.map(decorate));
});

/** What was changed, by whom, and why. */
router.get("/log", (req, res) => {
  const where = ["1=1"];
  const params = [];
  if (req.query.partyId) { where.push("party_id = ?"); params.push(req.query.partyId); }
  if (req.query.productId) { where.push("product_id = ?"); params.push(req.query.productId); }
  res.json(db.prepare(
    `SELECT * FROM price_list_log WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT 300`
  ).all(...params));
});

/* ----------------------------------------------------------------- write */

/**
 * Set a rate.
 *
 * If a current row already exists for the same party, product, size and
 * quantity band, it is CLOSED rather than changed — its effective_to is set
 * to the day before the new one starts — and a new row is inserted. That is
 * the whole of rule 1, and it is why a bill dated last month still prices
 * at last month's rate.
 */
router.post("/", requirePriceEditor, (req, res) => {
  const side = cleanSide(req.body.side);
  const productId = req.body.productId;
  if (!productId) return res.status(400).json({ error: "Which product is this rate for?" });
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
  if (!product) return res.status(400).json({ error: "That product no longer exists." });

  const rate = Number(req.body.rate);
  if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "Enter a rate." });

  const partyId = req.body.partyId || null;
  if (partyId) {
    const table = side === "purchase" ? "suppliers" : "customers";
    const party = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(partyId);
    if (!party) return res.status(400).json({ error: "That party no longer exists." });
  }

  const sizeId = req.body.sizeId ? Number(req.body.sizeId) : null;
  let size = null;
  if (sizeId != null) {
    size = db.prepare("SELECT * FROM product_sizes WHERE id = ? AND product_id = ?").get(sizeId, productId);
    if (!size) return res.status(400).json({ error: "That size does not belong to this product." });
  }

  const minQty = Math.max(0, Number(req.body.minQty) || 0);
  const maxQty = req.body.maxQty === "" || req.body.maxQty == null ? null : Number(req.body.maxQty);
  if (maxQty != null && maxQty < minQty) {
    return res.status(400).json({ error: "The maximum quantity cannot be below the minimum." });
  }

  const from = isDate(req.body.effectiveFrom) ? req.body.effectiveFrom : todayStr();
  const to = isDate(req.body.effectiveTo) ? req.body.effectiveTo : null;
  if (to && to < from) return res.status(400).json({ error: "Effective To cannot be before Effective From." });

  /* The row this one replaces, if any. Matched on what makes a rate the
     same rate: same party, same product, same size, same band. */
  const currentRow = db.prepare(`
    SELECT * FROM price_list
    WHERE side = ? AND product_id = ? AND active = 1
      AND (party_id IS ${partyId ? "?" : "NULL"})
      AND (size_id IS ${sizeId == null ? "NULL" : "?"})
      AND min_qty = ?
      AND (effective_to IS NULL OR effective_to = '')
    ORDER BY effective_from DESC LIMIT 1
  `).get(...[side, productId, ...(partyId ? [partyId] : []), ...(sizeId == null ? [] : [sizeId]), minQty]);

  const id = uid("PL");
  const now = Date.now();
  const who = (req.session && req.session.staffName) || "";

  db.transaction(() => {
    if (currentRow) {
      /* Closed the day before the new rate starts, so the two never both
         apply on the same day. A same-day change closes it on its own
         start date, which resolution breaks by preferring the later
         effective_from. */
      const closeOn = from > currentRow.effective_from
        ? new Date(new Date(from + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10)
        : from;
      db.prepare("UPDATE price_list SET effective_to = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .run(closeOn, now, who, currentRow.id);
    }
    db.prepare(`
      INSERT INTO price_list (id, side, party_id, product_id, size_id, brand, category, size_label,
        thickness, unit, rate, min_qty, max_qty, effective_from, effective_to, active, remark,
        created_at, created_by)
      VALUES (@id, @side, @partyId, @productId, @sizeId, @brand, @category, @sizeLabel,
        @thickness, @unit, @rate, @minQty, @maxQty, @from, @to, 1, @remark, @createdAt, @createdBy)
    `).run({
      id, side, partyId, productId, sizeId,
      brand: product.brand || "", category: product.category || "",
      sizeLabel: size ? size.label : "",
      thickness: String(req.body.thickness || "").trim(),
      unit: product.unit || "",
      rate: round2(rate), minQty, maxQty,
      from, to, remark: String(req.body.remark || "").trim(),
      createdAt: now, createdBy: who
    });
  })();

  const saved = db.prepare("SELECT * FROM price_list WHERE id = ?").get(id);
  log(req, currentRow ? "changed" : "added", saved, currentRow ? currentRow.rate : null, req.body.reason);
  logAction(req, "priceList.set",
    `${side} ${product.name}${size ? " " + size.label : ""} → ${round2(rate)}${partyId ? " (party)" : " (general)"}`);
  res.status(201).json(decorate(saved));
});

/**
 * Stop using a rate.
 *
 * Deactivated, never deleted. The row is what a past bill's rate can be
 * explained by, and a deleted row makes "why was he charged 2,050" a
 * question with no answer.
 */
router.post("/:id/deactivate", requirePriceEditor, (req, res) => {
  const row = db.prepare("SELECT * FROM price_list WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "That rate was not found." });
  if (!row.active) return res.status(400).json({ error: "That rate is already switched off." });
  db.prepare("UPDATE price_list SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?")
    .run(Date.now(), (req.session && req.session.staffName) || "", row.id);
  log(req, "deactivated", row, row.rate, req.body && req.body.reason);
  logAction(req, "priceList.deactivate", row.id);
  res.json(decorate(db.prepare("SELECT * FROM price_list WHERE id = ?").get(row.id)));
});

router.post("/:id/reactivate", requirePriceEditor, (req, res) => {
  const row = db.prepare("SELECT * FROM price_list WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "That rate was not found." });
  if (row.active) return res.status(400).json({ error: "That rate is already in use." });
  db.prepare("UPDATE price_list SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?")
    .run(Date.now(), (req.session && req.session.staffName) || "", row.id);
  log(req, "reactivated", row, row.rate, req.body && req.body.reason);
  logAction(req, "priceList.reactivate", row.id);
  res.json(decorate(db.prepare("SELECT * FROM price_list WHERE id = ?").get(row.id)));
});

/**
 * Many rates at once, from a spreadsheet.
 *
 * Rows are matched to products by SKU first and by name second — a shop's
 * own SKU is unambiguous, a name is what their supplier's price sheet
 * actually carries, and refusing the second would mean retyping the lot.
 *
 * NOTHING IS WRITTEN UNLESS EVERY ROW RESOLVES. A part-applied price list
 * is worse than a rejected one: the shop believes the new rates are in and
 * has no way to see which twelve of two hundred are missing.
 */
router.post("/import", requirePriceEditor, (req, res) => {
  const side = cleanSide(req.body.side);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "There is nothing in that file." });

  const partyTable = side === "purchase" ? "suppliers" : "customers";
  const problems = [];
  const prepared = [];

  rows.forEach((raw, i) => {
    const line = i + 1;
    const rate = Number(raw.rate);
    if (!Number.isFinite(rate) || rate < 0) { problems.push(`Row ${line}: no rate.`); return; }

    let partyId = null;
    const partyName = String(raw.party || "").trim();
    if (partyName) {
      const p = db.prepare(`SELECT id FROM ${partyTable} WHERE LOWER(name) = LOWER(?)`).get(partyName);
      if (!p) { problems.push(`Row ${line}: no ${side === "purchase" ? "supplier" : "customer"} called "${partyName}".`); return; }
      partyId = p.id;
    }

    const sku = String(raw.sku || "").trim();
    const name = String(raw.product || "").trim();
    let product = null;
    if (sku) product = db.prepare("SELECT * FROM products WHERE LOWER(sku) = LOWER(?)").get(sku);
    if (!product && name) product = db.prepare("SELECT * FROM products WHERE LOWER(name) = LOWER(?)").get(name);
    if (!product) { problems.push(`Row ${line}: no product matching "${sku || name || "(blank)"}".`); return; }

    let sizeId = null, sizeLabel = "";
    const wantSize = String(raw.size || "").trim();
    if (wantSize) {
      const s = db.prepare("SELECT * FROM product_sizes WHERE product_id = ? AND LOWER(label) = LOWER(?)").get(product.id, wantSize);
      if (!s) { problems.push(`Row ${line}: ${product.name} has no size "${wantSize}".`); return; }
      sizeId = s.id; sizeLabel = s.label;
    }

    const from = isDate(raw.effectiveFrom) ? raw.effectiveFrom : todayStr();
    prepared.push({
      side, partyId, product, sizeId, sizeLabel, rate: round2(rate),
      minQty: Math.max(0, Number(raw.minQty) || 0),
      maxQty: raw.maxQty === "" || raw.maxQty == null ? null : Number(raw.maxQty),
      from, thickness: String(raw.thickness || "").trim(), remark: String(raw.remark || "").trim()
    });
  });

  if (problems.length) {
    return res.status(400).json({
      error: `${problems.length} row${problems.length === 1 ? "" : "s"} could not be matched, so nothing was imported.`,
      problems: problems.slice(0, 25),
      more: Math.max(0, problems.length - 25)
    });
  }

  const now = Date.now();
  const who = (req.session && req.session.staffName) || "";
  let added = 0, replaced = 0;

  db.transaction(() => {
    prepared.forEach(p => {
      const currentRow = db.prepare(`
        SELECT * FROM price_list
        WHERE side = ? AND product_id = ? AND active = 1
          AND (party_id IS ${p.partyId ? "?" : "NULL"})
          AND (size_id IS ${p.sizeId == null ? "NULL" : "?"})
          AND min_qty = ? AND (effective_to IS NULL OR effective_to = '')
        ORDER BY effective_from DESC LIMIT 1
      `).get(...[p.side, p.product.id, ...(p.partyId ? [p.partyId] : []), ...(p.sizeId == null ? [] : [p.sizeId]), p.minQty]);

      if (currentRow) {
        if (currentRow.rate === p.rate) return;      // unchanged; leave it alone
        const closeOn = p.from > currentRow.effective_from
          ? new Date(new Date(p.from + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10)
          : p.from;
        db.prepare("UPDATE price_list SET effective_to = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .run(closeOn, now, who, currentRow.id);
        replaced += 1;
      } else added += 1;

      const id = uid("PL");
      db.prepare(`
        INSERT INTO price_list (id, side, party_id, product_id, size_id, brand, category, size_label,
          thickness, unit, rate, min_qty, max_qty, effective_from, effective_to, active, remark, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)
      `).run(id, p.side, p.partyId, p.product.id, p.sizeId, p.product.brand || "", p.product.category || "",
        p.sizeLabel, p.thickness, p.product.unit || "", p.rate, p.minQty, p.maxQty, p.from, p.remark, now, who);

      log(req, "imported", db.prepare("SELECT * FROM price_list WHERE id = ?").get(id),
        currentRow ? currentRow.rate : null, "Excel import");
    });
  })();

  logAction(req, "priceList.import", `${side}: ${added} added, ${replaced} changed`);
  res.json({ ok: true, added, replaced, unchanged: prepared.length - added - replaced });
});

module.exports = router;
