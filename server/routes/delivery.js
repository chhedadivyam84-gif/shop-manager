/* ============================================================
   DELIVERY

   Goods ARRIVING with the customer. Dispatch (routes/dispatch.js) is goods
   LEAVING. Separate registers, separate numbering, separate reports — a load
   that goes out Tuesday and lands Thursday belongs to two different days, and
   one table with a status column answers neither question cleanly.

   Nothing here touches stock: the invoice deducted it at the sale. A delivery
   raised from a dispatch drop copies the goods across; it does not move them
   a second time.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { uid, logAction, bindId } = require("../util");
const docNumber = require("../docNumber");

const router = express.Router();

const STATUSES = ["Pending", "Out", "Delivered", "Partial", "Cancelled", "Returned"];

function logStatus(deliveryId, status, req, note) {
  db.prepare(`INSERT INTO delivery_status_log (id, delivery_id, status, at, by, note)
              VALUES (?,?,?,?,?,?)`).run(
    uid("DLL"), deliveryId, status, Date.now(),
    (req.session && req.session.staffName) || "", note || "");
}

function load(id) {
  const d = db.prepare(`
    SELECT dl.*, a.area AS area_name, a.station, a.side, a.zone,
           i.challan_no AS invoice_no, ds.dispatch_no
      FROM deliveries dl
      LEFT JOIN areas a ON a.id = dl.area_id
      LEFT JOIN invoices i ON i.id = dl.invoice_id
      LEFT JOIN dispatches ds ON ds.id = dl.dispatch_id
     WHERE dl.id = ?`).get(bindId(id));
  if (!d) return null;
  d.items = db.prepare("SELECT * FROM delivery_items WHERE delivery_id = ? ORDER BY rowid").all(d.id);
  d.log = db.prepare(
    "SELECT * FROM delivery_status_log WHERE delivery_id = ? ORDER BY at DESC").all(d.id);
  return d;
}

/* ---------------------------------------------------------- the register

   One query behind every report. Each named report on the Delivery menu is
   this filtered and grouped a different way, which is why they can never
   disagree with each other about what was delivered. */
function registerRows(q) {
  const where = ["1=1"];
  const args = [];
  if (q.from)     { where.push("dl.delivery_at >= ?"); args.push(Date.parse(q.from + "T00:00:00")); }
  if (q.to)       { where.push("dl.delivery_at <= ?"); args.push(Date.parse(q.to + "T23:59:59")); }
  if (q.areaId)   { where.push("dl.area_id = ?");      args.push(q.areaId); }
  if (q.customerId) { where.push("dl.customer_id = ?"); args.push(q.customerId); }
  if (q.status)   { where.push("dl.status = ?");       args.push(q.status); }
  if (q.route)    { where.push("dl.route = ?");        args.push(q.route); }
  if (q.zone)     { where.push("a.zone = ?");          args.push(q.zone); }
  if (q.line)     { where.push("EXISTS (SELECT 1 FROM area_lines al WHERE al.area_id = dl.area_id AND al.line = ?)"); args.push(q.line); }

  return db.prepare(`
    SELECT dl.*, a.area AS area_name, a.station, a.side, a.zone,
           i.challan_no AS invoice_no
      FROM deliveries dl
      LEFT JOIN areas a ON a.id = dl.area_id
      LEFT JOIN invoices i ON i.id = dl.invoice_id
     WHERE ${where.join(" AND ")}
     ORDER BY dl.delivery_at DESC, dl.rowid DESC
     LIMIT 1000`).all(...args);
}

router.get("/", (req, res) => {
  const rows = registerRows(req.query);
  res.json({ deliveries: rows, count: rows.length });
});

router.get("/:id", (req, res) => {
  const d = load(req.params.id);
  if (!d) return res.status(404).json({ error: "No such delivery." });
  res.json(d);
});

/* ---------------------------------------------------------- create */

router.post("/", requireRole("owner", "manager", "staff"), (req, res) => {
  const b = req.body || {};
  const now = Date.now();
  let id;
  try {
    id = db.transaction(() => {
      const newId = uid("DEL");
      let src = {};

      /* Raised from a dispatch drop: the customer, address, area and goods are
         taken from what actually went on the van, so the delivery note cannot
         quietly describe a different load than the one that left. */
      if (b.dropId) {
        const drop = db.prepare("SELECT * FROM dispatch_drops WHERE id = ?").get(bindId(b.dropId));
        if (!drop) throw new Error("That dispatch drop no longer exists.");
        src = drop;
      }

      db.prepare(`INSERT INTO deliveries
        (id, delivery_no, delivery_at, dispatch_id, drop_id, invoice_id, order_id, customer_id,
         customer_name, customer_mobile, customer_gstin, delivery_address, landmark, pincode,
         area_id, sub_area, route, transporter, vehicle_no, driver_name, driver_mobile,
         status, remarks, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        newId, docNumber.allocate("delivery"),
        b.deliveryAt ? Number(b.deliveryAt) : now,
        bindId(src.dispatch_id || b.dispatchId), bindId(b.dropId),
        bindId(src.invoice_id || b.invoiceId), bindId(b.orderId),
        bindId(src.customer_id || b.customerId),
        String(b.customerName || src.customer_name || "").trim(),
        String(b.customerMobile || src.customer_mobile || "").trim(),
        String(b.customerGstin || src.customer_gstin || "").trim(),
        String(b.deliveryAddress || src.delivery_address || "").trim(),
        String(b.landmark || src.landmark || "").trim(),
        String(b.pincode || src.pincode || "").trim(),
        bindId(b.areaId || src.area_id),
        String(b.subArea || "").trim(), String(b.route || "").trim(),
        String(b.transporter || "").trim(), String(b.vehicleNo || "").trim(),
        String(b.driverName || "").trim(), String(b.driverMobile || "").trim(),
        "Pending", String(b.remarks || "").trim(), now,
        (req.session && req.session.staffName) || "");

      const addItem = db.prepare(`INSERT INTO delivery_items
        (id, delivery_id, invoice_item_id, product_id, product_name, brand, size_label, unit, qty, remarks)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);

      if (b.dropId) {
        // Only what actually went: a line loaded as zero was not delivered.
        const sent = db.prepare(
          "SELECT * FROM dispatch_items WHERE drop_id = ? AND qty_dispatched > 0").all(bindId(b.dropId));
        for (const it of sent) {
          addItem.run(uid("DLI"), newId, bindId(it.invoice_item_id), bindId(it.product_id),
            it.product_name, "", it.size_label, it.unit, it.qty_dispatched, "");
        }
      } else {
        for (const it of (Array.isArray(b.items) ? b.items : [])) {
          const qty = Number(it.qty);
          if (!Number.isFinite(qty) || qty <= 0) throw new Error("Each line needs a quantity above zero.");
          addItem.run(uid("DLI"), newId, bindId(it.invoiceItemId), bindId(it.productId),
            String(it.productName || "").trim(), String(it.brand || "").trim(),
            String(it.sizeLabel || "").trim(), String(it.unit || "").trim(),
            qty, String(it.remarks || "").trim());
        }
      }

      logStatus(newId, "Pending", req, b.dropId ? "Raised from dispatch" : "Entered directly");
      return newId;
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const full = load(id);
  logAction(req, "delivery.create", `${full.delivery_no} — ${full.customer_name}`);
  res.status(201).json(full);
});

router.put("/:id", requireRole("owner", "manager", "staff"), (req, res) => {
  const d = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(bindId(req.params.id));
  if (!d) return res.status(404).json({ error: "No such delivery." });
  const v = (key, cur) => req.body[key] === undefined ? cur : String(req.body[key]).trim();

  db.prepare(`UPDATE deliveries SET delivery_address = ?, landmark = ?, pincode = ?,
                area_id = ?, sub_area = ?, route = ?, transporter = ?, vehicle_no = ?,
                driver_name = ?, driver_mobile = ?, remarks = ? WHERE id = ?`).run(
    v("deliveryAddress", d.delivery_address), v("landmark", d.landmark), v("pincode", d.pincode),
    req.body.areaId === undefined ? bindId(d.area_id) : bindId(req.body.areaId),
    v("subArea", d.sub_area), v("route", d.route), v("transporter", d.transporter),
    v("vehicleNo", d.vehicle_no), v("driverName", d.driver_name),
    v("driverMobile", d.driver_mobile), v("remarks", d.remarks), d.id);

  logAction(req, "delivery.update", d.delivery_no);
  res.json(load(d.id));
});

router.post("/:id/status", requireRole("owner", "manager", "staff"), (req, res) => {
  const d = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(bindId(req.params.id));
  if (!d) return res.status(404).json({ error: "No such delivery." });
  const status = String(req.body.status || "");
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status." });

  const arriving = status === "Delivered" || status === "Partial";
  db.transaction(() => {
    db.prepare(`UPDATE deliveries SET status = ?, delivered_at = ?, received_by = ?,
                  signature = ?, remarks = ? WHERE id = ?`).run(
      status,
      arriving ? Date.now() : bindId(d.delivered_at),
      req.body.receivedBy !== undefined ? String(req.body.receivedBy).trim() : d.received_by,
      req.body.signature !== undefined ? String(req.body.signature) : d.signature,
      req.body.remarks !== undefined ? String(req.body.remarks).trim() : d.remarks,
      d.id);
    logStatus(d.id, status, req, String(req.body.note || ""));
  })();

  logAction(req, "delivery.status", `${d.delivery_no} → ${status}`);
  res.json(load(d.id));
});

/* ---------------------------------------------------------- reports

   Seven named reports, every one of them the register above grouped a
   different way. Sharing registerRows() is what stops "Area-wise" and
   "Date-wise" ever disagreeing about the same week.

   Each accepts the same filters: from, to, areaId, customerId, status, route,
   zone, line.
*/
function summarise(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r) || "—";
    if (!groups.has(key)) {
      groups.set(key, { key, label: labelOf ? labelOf(r) : key, deliveries: 0, qty: 0, statuses: {} });
    }
    const g = groups.get(key);
    g.deliveries++;
    g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
  }
  return [...groups.values()].sort((a, b) => b.deliveries - a.deliveries);
}

/** Quantities per delivery, for the reports that count goods not notes. */
function withQty(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const qty = new Map();
  const chunk = 400;                       // SQLite has a bound-parameter ceiling
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    db.prepare(`SELECT delivery_id, SUM(qty) AS q FROM delivery_items
                 WHERE delivery_id IN (${slice.map(() => "?").join(",")})
                 GROUP BY delivery_id`).all(...slice)
      .forEach(r => qty.set(r.delivery_id, r.q || 0));
  }
  rows.forEach(r => { r.totalQty = qty.get(r.id) || 0; });
  return rows;
}

router.get("/reports/area-wise", (req, res) => {
  const rows = withQty(registerRows(req.query));
  res.json({ report: "Area-wise Delivery", rows,
    groups: summarise(rows, r => r.area_name) });
});

router.get("/reports/date-wise", (req, res) => {
  const rows = withQty(registerRows(req.query));
  res.json({ report: "Date-wise Delivery", rows,
    groups: summarise(rows, r => new Date(r.delivery_at).toISOString().slice(0, 10)) });
});

router.get("/reports/customer-wise", (req, res) => {
  const rows = withQty(registerRows(req.query));
  res.json({ report: "Customer-wise Delivery", rows,
    groups: summarise(rows, r => r.customer_name) });
});

router.get("/reports/route-wise", (req, res) => {
  const rows = withQty(registerRows(req.query));
  res.json({ report: "Route-wise Delivery", rows,
    groups: summarise(rows, r => r.route) });
});

/* Product-wise counts GOODS, so it groups the item lines rather than the
   notes — one delivery of three products is three rows here, which is the
   whole point of the report. */
router.get("/reports/product-wise", (req, res) => {
  const rows = registerRows(req.query);
  const byProduct = new Map();
  if (rows.length) {
    const ids = rows.map(r => r.id);
    for (let i = 0; i < ids.length; i += 400) {
      const slice = ids.slice(i, i + 400);
      db.prepare(`SELECT product_name, brand, size_label, unit,
                         SUM(qty) AS qty, COUNT(*) AS lines
                    FROM delivery_items
                   WHERE delivery_id IN (${slice.map(() => "?").join(",")})
                   GROUP BY product_name, brand, size_label, unit`).all(...slice)
        .forEach(r => {
          const key = [r.product_name, r.brand, r.size_label].join("|");
          const cur = byProduct.get(key) || { ...r, qty: 0, lines: 0 };
          cur.qty += r.qty || 0; cur.lines += r.lines || 0;
          byProduct.set(key, cur);
        });
    }
  }
  res.json({ report: "Product-wise Delivery",
    groups: [...byProduct.values()].sort((a, b) => b.qty - a.qty) });
});

router.get("/reports/pending", (req, res) => {
  const rows = withQty(registerRows({ ...req.query, status: "" }))
    .filter(r => r.status === "Pending" || r.status === "Out" || r.status === "Partial");
  res.json({ report: "Pending Delivery", rows, count: rows.length });
});

router.get("/reports/delivered", (req, res) => {
  const rows = withQty(registerRows({ ...req.query, status: "Delivered" }));
  res.json({ report: "Delivered", rows, count: rows.length });
});

module.exports = router;
