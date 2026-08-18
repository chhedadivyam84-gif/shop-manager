/* ============================================================
   DELIVERY DISPATCH

   The workflow the shop actually runs:

     Sales Invoice -> Pending Delivery -> Dispatch -> Out for Delivery
       -> Delivered (or Partial, and the rest stays pending)

   A dispatch is one VEHICLE TRIP. Five customers on one van is one dispatch
   with five drops: the vehicle and driver are entered once, and each customer
   still gets their own status, delivery time and signature.

   Two rules hold the module together:

     - Dispatch NEVER moves stock. The invoice deducted it at the point of
       sale; touching it again here would take the same goods out twice.

     - What is still owed is DERIVED, never stored as a flag. Outstanding is
       the invoice quantity minus everything already dispatched against it, so
       a bill cannot drift into saying "delivered" while goods sit in the shop.
   ============================================================ */
const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { uid, logAction, bindId } = require("../util");
const docNumber = require("../docNumber");

const router = express.Router();

/* The statuses a dispatch or a drop can be in. Kept in one place so the UI,
   the log and the guards below cannot drift apart. */
const STATUSES = ["Pending", "Ready", "Out", "Delivered", "Partial", "Cancelled", "Returned"];
const OPEN_STATUSES = ["Pending", "Ready", "Out", "Partial"];

/** Quantities already sent against an invoice, per invoice_item.
 *  A cancelled dispatch never counted — those goods never left. */
function dispatchedByItem(invoiceId) {
  const rows = db.prepare(`
    SELECT di.invoice_item_id AS item_id, SUM(di.qty_dispatched) AS sent
      FROM dispatch_items di
      JOIN dispatch_drops dd ON dd.id = di.drop_id
      JOIN dispatches d ON d.id = dd.dispatch_id
     WHERE dd.invoice_id = ?
       AND d.status <> 'Cancelled'
       AND dd.status <> 'Cancelled'
     GROUP BY di.invoice_item_id`).all(bindId(invoiceId));
  // Keyed as strings on both sides: the ids are rowids, and a number that
  // came back from SQLite as a string must still find its line.
  const map = new Map();
  rows.forEach(r => map.set(String(r.item_id), r.sent || 0));
  return map;
}

/** One invoice with what is still owed on each line. */
function outstandingFor(invoiceId) {
  const sent = dispatchedByItem(invoiceId);
  return db.prepare(`
    SELECT id, product_id, name, size_label, qty, pieces, unit_label
      FROM invoice_items WHERE invoice_id = ? ORDER BY rowid`).all(bindId(invoiceId))
    .map(it => {
      const already = sent.get(String(it.id)) || 0;
      return {
        invoiceItemId: it.id,
        productId: it.product_id,
        name: it.name,
        sizeLabel: it.size_label || "",
        unit: it.unit_label || "",
        qty: it.qty || 0,
        pieces: it.pieces || 0,
        dispatched: already,
        outstanding: Math.max(0, (it.qty || 0) - already)
      };
    });
}

/* ---------------------------------------------------------- pending

   Bills whose goods have not all gone out yet. This is the queue the
   dispatcher works from, so it deliberately shows partly-sent bills too —
   a bill half delivered is still a delivery waiting to happen. */
router.get("/pending", (req, res) => {
  const line = String(req.query.line || "").trim();
  const areaId = String(req.query.areaId || "").trim();

  const invoices = db.prepare(`
    SELECT i.id, i.challan_no, i.date, i.doc_type, i.customer_id, i.delivery_address,
           i.area_id, c.name AS customer_name, c.phone AS customer_mobile,
           c.gst AS customer_gstin, c.address AS customer_address, c.pin_code AS pincode,
           a.area AS area_name, a.station, a.side
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      LEFT JOIN areas a ON a.id = i.area_id
     WHERE i.voided = 0
     ORDER BY i.date DESC, i.rowid DESC
     LIMIT 400`).all();

  const out = [];
  for (const inv of invoices) {
    if (areaId && inv.area_id !== areaId) continue;
    if (line) {
      const onLine = inv.area_id && db.prepare(
        "SELECT 1 FROM area_lines WHERE area_id = ? AND line = ?").get(inv.area_id, line);
      if (!onLine) continue;
    }
    const items = outstandingFor(inv.id);
    const pending = items.filter(it => it.outstanding > 0.0001);
    if (!pending.length) continue;
    out.push({
      ...inv,
      items: pending,
      anyDispatched: items.some(it => it.dispatched > 0)
    });
  }
  res.json({ invoices: out });
});

/* ---------------------------------------------------------- read */

function loadDispatch(id) {
  const d = db.prepare("SELECT * FROM dispatches WHERE id = ?").get(bindId(id));
  if (!d) return null;
  d.drops = db.prepare(`
    SELECT dd.*, a.area AS area_name, a.station, a.side, i.challan_no
      FROM dispatch_drops dd
      LEFT JOIN areas a ON a.id = dd.area_id
      LEFT JOIN invoices i ON i.id = dd.invoice_id
     WHERE dd.dispatch_id = ? ORDER BY dd.seq, dd.rowid`).all(bindId(id));
  for (const drop of d.drops) {
    drop.items = db.prepare(
      "SELECT * FROM dispatch_items WHERE drop_id = ? ORDER BY rowid").all(drop.id);
    drop.lines = drop.area_id
      ? db.prepare("SELECT line FROM area_lines WHERE area_id = ?").all(drop.area_id).map(r => r.line)
      : [];
  }
  d.log = db.prepare(
    "SELECT * FROM dispatch_status_log WHERE dispatch_id = ? ORDER BY at DESC").all(bindId(id));
  return d;
}

router.get("/", (req, res) => {
  const status = String(req.query.status || "").trim();
  const rows = db.prepare(`
    SELECT d.*,
           (SELECT COUNT(*) FROM dispatch_drops x WHERE x.dispatch_id = d.id) AS drops,
           (SELECT COUNT(*) FROM dispatch_drops x
             WHERE x.dispatch_id = d.id AND x.status = 'Delivered') AS delivered
      FROM dispatches d
     ${status === "open" ? `WHERE d.status IN (${OPEN_STATUSES.map(s => `'${s}'`).join(",")})` : ""}
     ORDER BY d.dispatch_at DESC, d.rowid DESC LIMIT 200`).all();
  res.json({ dispatches: rows });
});

router.get("/:id", (req, res) => {
  const d = loadDispatch(req.params.id);
  if (!d) return res.status(404).json({ error: "No such dispatch." });
  res.json(d);
});

/* ---------------------------------------------------------- create

   Built from the invoices the dispatcher ticked. Each becomes a drop, and
   every outstanding line becomes an item pre-filled with the full quantity —
   the common case is that everything goes, and the driver edits the exceptions.
*/
router.post("/", requireRole("owner", "manager", "staff"), (req, res) => {
  const invoiceIds = Array.isArray(req.body.invoiceIds) ? req.body.invoiceIds : [];
  if (!invoiceIds.length) return res.status(400).json({ error: "Choose at least one bill to dispatch." });

  const now = Date.now();
  let created;
  try {
    const make = db.transaction(() => {
      const id = uid("DSP");
      db.prepare(`INSERT INTO dispatches
        (id, dispatch_no, dispatch_at, vehicle_no, driver_name, driver_mobile, status, notes, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, docNumber.allocate("dispatch"), now,
        String(req.body.vehicleNo || "").trim(),
        String(req.body.driverName || "").trim(),
        String(req.body.driverMobile || "").trim(),
        "Pending", String(req.body.notes || "").trim(), now,
        (req.session && req.session.staffName) || "");

      let seq = 0;
      for (const invId of invoiceIds) {
        const inv = db.prepare(`
          SELECT i.*, c.name AS cname, c.phone AS cphone, c.gst AS cgstin,
                 c.address AS caddr, c.pin_code AS cpin
            FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
           WHERE i.id = ?`).get(bindId(invId));
        if (!inv) throw new Error("A chosen bill no longer exists.");
        if (inv.voided) throw new Error(`${inv.challan_no} has been cancelled and cannot be dispatched.`);

        const pending = outstandingFor(invId).filter(it => it.outstanding > 0.0001);
        if (!pending.length) throw new Error(`${inv.challan_no} has already gone out in full.`);

        const dropId = uid("DRP");
        db.prepare(`INSERT INTO dispatch_drops
          (id, dispatch_id, seq, invoice_id, order_id, customer_id, customer_name,
           customer_mobile, customer_gstin, delivery_address, landmark, pincode,
           area_id, status, remarks)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          dropId, id, seq++, invId, null, inv.customer_id,
          inv.cname || "", inv.cphone || "", inv.cgstin || "",
          inv.delivery_address || inv.caddr || "", "", inv.cpin || "",
          bindId(inv.area_id), "Pending", "");

        for (const it of pending) {
          db.prepare(`INSERT INTO dispatch_items
            (id, drop_id, invoice_item_id, product_id, product_name, size_label, unit,
             qty_ordered, qty_dispatched, remarks)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            uid("DIT"), dropId, it.invoiceItemId, bindId(it.productId), it.name,
            it.sizeLabel, it.unit, it.outstanding, it.outstanding, "");
        }
      }

      db.prepare(`INSERT INTO dispatch_status_log (id, dispatch_id, drop_id, status, at, by, note)
        VALUES (?,?,?,?,?,?,?)`).run(uid("DLG"), id, null, "Pending", now,
        (req.session && req.session.staffName) || "", "Dispatch created");
      return id;
    });
    created = make();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const full = loadDispatch(created);
  logAction(req, "dispatch.create", `${full.dispatch_no} — ${full.drops.length} drop(s)`);
  res.status(201).json(full);
});

/* ---------------------------------------------------------- edit the trip */

router.put("/:id", requireRole("owner", "manager", "staff"), (req, res) => {
  const d = db.prepare("SELECT * FROM dispatches WHERE id = ?").get(bindId(req.params.id));
  if (!d) return res.status(404).json({ error: "No such dispatch." });
  db.prepare(`UPDATE dispatches SET vehicle_no = ?, driver_name = ?, driver_mobile = ?, notes = ?
              WHERE id = ?`).run(
    String(req.body.vehicleNo ?? d.vehicle_no).trim(),
    String(req.body.driverName ?? d.driver_name).trim(),
    String(req.body.driverMobile ?? d.driver_mobile).trim(),
    String(req.body.notes ?? d.notes).trim(), d.id);
  logAction(req, "dispatch.update", d.dispatch_no);
  res.json(loadDispatch(d.id));
});

/** What actually went on the van, line by line. */
router.put("/drops/:dropId/items", requireRole("owner", "manager", "staff"), (req, res) => {
  const drop = db.prepare("SELECT * FROM dispatch_drops WHERE id = ?").get(bindId(req.params.dropId));
  if (!drop) return res.status(404).json({ error: "No such drop." });
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  try {
    db.transaction(() => {
      for (const row of items) {
        const item = db.prepare("SELECT * FROM dispatch_items WHERE id = ? AND drop_id = ?")
          .get(bindId(row.id), drop.id);
        if (!item) continue;
        const qty = Number(row.qtyDispatched);
        if (!Number.isFinite(qty) || qty < 0) throw new Error("A quantity is not a valid number.");
        if (qty > item.qty_ordered + 0.0001) {
          throw new Error(`Cannot send ${qty} of ${item.product_name} — only ${item.qty_ordered} is outstanding.`);
        }
        db.prepare("UPDATE dispatch_items SET qty_dispatched = ?, remarks = ? WHERE id = ?")
          .run(qty, String(row.remarks || "").trim(), item.id);
      }
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(loadDispatch(drop.dispatch_id));
});

/* ---------------------------------------------------------- status

   Every change is logged with its time, which is what makes "when did it
   leave" and "when was it signed for" answerable months later. */
function recordStatus(dispatchId, dropId, status, req, note) {
  db.prepare(`INSERT INTO dispatch_status_log (id, dispatch_id, drop_id, status, at, by, note)
    VALUES (?,?,?,?,?,?,?)`).run(uid("DLG"), dispatchId, bindId(dropId), status, Date.now(),
    (req.session && req.session.staffName) || "", note || "");
}

/** A trip's own status follows its drops, so the two can never disagree. */
function resettleDispatch(dispatchId, req) {
  const drops = db.prepare("SELECT status FROM dispatch_drops WHERE dispatch_id = ?").all(dispatchId);
  if (!drops.length) return;
  const all = s => drops.every(d => d.status === s);
  const any = s => drops.some(d => d.status === s);

  let status;
  if (all("Cancelled")) status = "Cancelled";
  else if (all("Returned")) status = "Returned";
  else if (all("Delivered")) status = "Delivered";
  else if (any("Delivered") || any("Partial")) status = "Partial";
  else if (any("Out")) status = "Out";
  else if (all("Ready")) status = "Ready";
  else status = "Pending";

  const cur = db.prepare("SELECT status FROM dispatches WHERE id = ?").get(dispatchId);
  if (cur && cur.status !== status) {
    db.prepare("UPDATE dispatches SET status = ? WHERE id = ?").run(status, dispatchId);
    recordStatus(dispatchId, null, status, req, "Follows the drops");
  }
}

router.post("/:id/status", requireRole("owner", "manager", "staff"), (req, res) => {
  const d = db.prepare("SELECT * FROM dispatches WHERE id = ?").get(bindId(req.params.id));
  if (!d) return res.status(404).json({ error: "No such dispatch." });
  const status = String(req.body.status || "");
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status." });

  const now = Date.now();
  db.transaction(() => {
    db.prepare("UPDATE dispatches SET status = ? WHERE id = ?").run(status, d.id);
    recordStatus(d.id, null, status, req, String(req.body.note || ""));
    /* Ready and Out are decisions about the whole van, so they carry to every
       drop still open. Delivered is never applied this way: each customer
       signs for their own goods. */
    if (status === "Ready" || status === "Out" || status === "Cancelled") {
      const open = db.prepare(
        `SELECT id FROM dispatch_drops WHERE dispatch_id = ? AND status IN ('Pending','Ready','Out')`).all(d.id);
      for (const drop of open) {
        db.prepare("UPDATE dispatch_drops SET status = ? WHERE id = ?").run(status, drop.id);
        recordStatus(d.id, drop.id, status, req, "With the van");
      }
    }
  })();

  logAction(req, "dispatch.status", `${d.dispatch_no} → ${status}`);
  res.json(loadDispatch(d.id));
});

/** One customer's own status, signature and delivery time. */
router.post("/drops/:dropId/status", requireRole("owner", "manager", "staff"), (req, res) => {
  const drop = db.prepare("SELECT * FROM dispatch_drops WHERE id = ?").get(bindId(req.params.dropId));
  if (!drop) return res.status(404).json({ error: "No such drop." });
  const status = String(req.body.status || "");
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status." });

  const delivering = status === "Delivered" || status === "Partial";
  db.transaction(() => {
    db.prepare(`UPDATE dispatch_drops
                   SET status = ?, delivered_at = ?, received_by = ?, signature = ?, remarks = ?
                 WHERE id = ?`).run(
      status,
      delivering ? Date.now() : bindId(drop.delivered_at),
      req.body.receivedBy !== undefined ? String(req.body.receivedBy).trim() : drop.received_by,
      req.body.signature !== undefined ? String(req.body.signature) : drop.signature,
      req.body.remarks !== undefined ? String(req.body.remarks).trim() : drop.remarks,
      drop.id);
    recordStatus(drop.dispatch_id, drop.id, status, req, String(req.body.note || ""));
  })();

  resettleDispatch(drop.dispatch_id, req);
  logAction(req, "dispatch.drop.status", `${drop.customer_name} → ${status}`);
  res.json(loadDispatch(drop.dispatch_id));
});

module.exports = router;
