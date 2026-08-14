/* ============================================================
   EWayBillService

   Everything between the routes and the provider: build a payload from an
   invoice, validate it offline, submit exactly once, translate whatever
   comes back into something a shop owner can act on, and log the raw
   exchange where only the server can read it.

   Routes never touch an adapter directly, so swapping GSP changes nothing
   above this file.
   ============================================================ */
const crypto = require("crypto");
const db = require("../db");
const { currentAdapter } = require("./adapters");
const { stateCode, uqc, looksLikeGstin } = require("../einvoice/gstCodes");
const { logAction } = require("../util");

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const clean = v => String(v == null ? "" : v).trim();

/* ---------- audit of every provider call ---------- */
function recordCall(ewbId, operation, request, result) {
  db.prepare(`
    INSERT INTO ewb_requests
      (ewb_id, provider, operation, endpoint, request_json, response_json,
       http_status, error_code, ok, at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    ewbId || null, currentAdapter().id, operation, "",
    // Stored server-side only; this is the record that makes a disputed
    // generation answerable months later.
    JSON.stringify(request || {}), JSON.stringify(result && result.raw || {}),
    (result && result.raw && result.raw.status) || null,
    (result && result.error && result.error.code) || "",
    result && result.ok ? 1 : 0, Date.now()
  );
}

/* ---------- build ---------- */

/**
 * An e-way bill payload assembled from an invoice the shop already has.
 * Nothing here is asked of the user twice: only transport details, which
 * genuinely are not on the invoice, come from the form.
 */
function buildFromInvoice(invoiceId, transport) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND voided = 0").get(invoiceId);
  if (!inv) throw new Error("Invoice not found.");
  if (inv.doc_type !== "invoice") throw new Error("An e-way bill is raised against an invoice, not a challan.");

  const s = db.prepare("SELECT * FROM settings").get() || {};
  const cust = inv.customer_id
    ? db.prepare("SELECT * FROM customers WHERE id = ?").get(inv.customer_id)
    : null;
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
  const t = transport || {};

  const lines = items.map(it => {
    const gross = (Number(it.qty) || 0) * (Number(it.rate) || 0);
    const net = gross * (1 - (Number(it.discount_pct) || 0) / 100);
    const rate = Number(it.gst_rate) || 0;
    const tax = inv.gst_enabled === 0 ? 0 : net * (rate / 100);
    const igst = inv.tax_type === "IGST";
    // The product is consulted only where the LINE is blank — the same rule
    // the printed bill follows, so a bill and its e-way bill never disagree.
    const prod = it.product_id
      ? db.prepare("SELECT hsn_code, unit, uqc FROM products WHERE id = ?").get(it.product_id)
      : null;
    return {
      product_id: it.product_id,
      name: it.name,
      hsn: clean(it.hsn_code || (prod && prod.hsn_code)),
      qty: Number(it.qty) || 0,
      uqc: clean((prod && prod.uqc)) || uqc(it.unit_label || (prod && prod.unit)) || "",
      taxable_value: round2(net),
      gst_rate: rate,
      cgst: round2(igst ? 0 : tax / 2),
      sgst: round2(igst ? 0 : tax / 2),
      igst: round2(igst ? tax : 0),
      cess: 0,
      total: round2(net + tax)
    };
  });

  const sum = k => round2(lines.reduce((a, l) => a + l[k], 0));

  return {
    invoice_id: inv.id,
    doc_type: "invoice",
    supply_type: "Outward",
    sub_type: "Supply",
    doc_no: inv.challan_no,
    doc_date: inv.date,
    doc_value: round2(inv.total),

    from_gstin: clean(s.gstin),
    from_name: clean(s.legal_name || s.business_name),
    from_addr: clean(s.address),
    from_place: clean(s.city || ""),
    from_pin: clean(s.pin_code),
    from_state_code: stateCode(s.state) || "",

    to_gstin: clean(cust && cust.gst),
    to_name: clean(cust && cust.name) || "Walk-in Customer",
    to_addr: clean(inv.delivery_address || (cust && cust.address)),
    to_place: clean((cust && cust.city) || ""),
    to_pin: clean(cust && cust.pin_code),
    to_state_code: stateCode(cust && cust.state) || "",

    transporter_id: t.transporterId || null,
    transporter_name: clean(t.transporterName || inv.transporter_name),
    trans_id: clean(t.transId || inv.transporter_id),
    trans_mode: clean(t.transMode || inv.transport_mode),
    vehicle_no: clean(t.vehicleNo || inv.vehicle_number).toUpperCase(),
    vehicle_type: clean(t.vehicleType || inv.vehicle_type),
    trans_doc_no: clean(t.transDocNo || inv.lr_number),
    trans_doc_date: clean(t.transDocDate || inv.lr_date),
    distance_km: Number(t.distanceKm || inv.distance_km) || 0,

    taxable_value: sum("taxable_value"),
    cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), cess: sum("cess"),
    total_value: sum("total"),
    items: lines
  };
}

/* ---------- validate ---------- */

const problem = (field, message) => ({ field, message });

/**
 * Everything the portal would reject, reported at once and in the shop's
 * language. Deliberately does NOT encode rules that belong to the
 * government and change — thresholds, distance-to-validity, which sub-types
 * need what. Those are the provider's to enforce; guessing them here would
 * refuse bills the portal would have accepted.
 */
function validate(p) {
  const out = [];

  if (!p.doc_no) out.push(problem("docNo", "The invoice has no number."));
  if (!p.doc_date) out.push(problem("docDate", "The invoice has no date."));
  if (!(p.doc_value > 0)) out.push(problem("docValue", "The invoice value is zero."));

  if (!p.from_gstin) out.push(problem("fromGstin", "Your shop's GSTIN is missing — Settings → GSTIN."));
  else if (!looksLikeGstin(p.from_gstin)) out.push(problem("fromGstin", `"${p.from_gstin}" is not a valid GSTIN.`));
  if (!p.from_pin) out.push(problem("fromPin", "Your shop's PIN code is missing — Settings → PIN code."));
  else if (!/^\d{6}$/.test(p.from_pin)) out.push(problem("fromPin", "The shop PIN code must be six digits."));
  if (!p.from_state_code) out.push(problem("fromState", "Your shop's state is not set or not recognised."));

  // A buyer GSTIN is required only when the sale is to a registered party.
  // An unregistered buyer is legitimate, so a missing GSTIN is not an error
  // by itself — a malformed one is.
  if (p.to_gstin && !looksLikeGstin(p.to_gstin))
    out.push(problem("toGstin", `The customer's GSTIN "${p.to_gstin}" is not valid.`));
  if (!p.to_pin) out.push(problem("toPin", "The customer's PIN code is missing — add it to the customer."));
  else if (!/^\d{6}$/.test(p.to_pin)) out.push(problem("toPin", "The customer PIN code must be six digits."));
  if (!p.to_state_code) out.push(problem("toState", "The customer's state is not set or not recognised."));
  if (!p.to_addr) out.push(problem("toAddr", "There is no delivery address on the invoice or the customer."));

  if (!p.items.length) out.push(problem("items", "The invoice has no items."));
  p.items.forEach((l, i) => {
    const where = `item ${i + 1} (${l.name})`;
    if (!l.hsn) out.push(problem("items", `${where} has no HSN code — set it on the product.`));
    else if (!/^\d{4}(\d{2})?(\d{2})?$/.test(l.hsn))
      out.push(problem("items", `${where}: HSN "${l.hsn}" must be 4, 6 or 8 digits.`));
    if (!l.uqc) out.push(problem("items", `${where} has no GST unit code — set the product's UQC.`));
    if (!(l.qty > 0)) out.push(problem("items", `${where} has no quantity.`));
  });

  /* Transport: at least one of a vehicle number or a transport document is
     needed for goods to actually move. Which one depends on the mode, and
     that rule is the portal's — so this asks only that the operator supplied
     something rather than deciding which. */
  if (!p.trans_mode) out.push(problem("transMode", "Choose how the goods are being sent."));
  if (!p.vehicle_no && !p.trans_doc_no)
    out.push(problem("vehicleNo", "Enter either a vehicle number or a transport document number."));
  if (p.vehicle_no && !/^[A-Z]{2}[0-9A-Z]{4,12}$/.test(p.vehicle_no))
    out.push(problem("vehicleNo", `"${p.vehicle_no}" does not look like a vehicle number (e.g. MH02AB1234).`));
  if (!(p.distance_km > 0)) out.push(problem("distanceKm", "Enter the approximate distance in km."));

  // Arithmetic the app owns, and therefore must get right.
  const lineSum = round2(p.items.reduce((a, l) => a + l.taxable_value, 0));
  if (Math.abs(lineSum - p.taxable_value) > 0.02)
    out.push(problem("taxableValue", `Taxable values do not add up (${lineSum} vs ${p.taxable_value}).`));

  return out;
}

/* ---------- persist ---------- */

function saveDraft(payload, staff) {
  const id = "EWB_" + crypto.randomBytes(6).toString("hex");
  const now = Date.now();
  const cols = Object.keys(payload).filter(k => k !== "items");
  db.prepare(`
    INSERT INTO ewb_bills (id, status, created_by, created_at, updated_at, ${cols.join(", ")})
    VALUES (?,?,?,?,?, ${cols.map(() => "?").join(", ")})
  `).run(id, "Draft", (staff && staff.id) || null, now, now, ...cols.map(c => payload[c]));

  const ins = db.prepare(`
    INSERT INTO ewb_items (ewb_id, product_id, name, hsn, qty, uqc, taxable_value,
                           gst_rate, cgst, sgst, igst, cess, total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const l of payload.items)
    ins.run(id, l.product_id, l.name, l.hsn, l.qty, l.uqc, l.taxable_value,
            l.gst_rate, l.cgst, l.sgst, l.igst, l.cess, l.total);
  return id;
}

function getBill(id) {
  const b = db.prepare("SELECT * FROM ewb_bills WHERE id = ?").get(id);
  if (!b) return null;
  b.items = db.prepare("SELECT * FROM ewb_items WHERE ewb_id = ?").all(id);
  return b;
}

/* ---------- submit ---------- */

/**
 * Generate, exactly once.
 *
 * The bill is moved to Submitting and stamped with a client_ref BEFORE the
 * call goes out, inside the same statement that checks it is still a Draft.
 * A second request therefore finds no Draft to claim and stops, rather than
 * both requests racing to the provider — which is the failure that produces
 * two e-way bills for one invoice and cannot be undone afterwards.
 */
async function generate(id, req) {
  const bill = getBill(id);
  if (!bill) throw new Error("E-way bill not found.");
  if (bill.status === "Generated") return { alreadyDone: true, bill };

  const clientRef = bill.client_ref || (id + "-" + Date.now().toString(36));
  const claimed = db.prepare(`
    UPDATE ewb_bills SET status = 'Submitting', client_ref = ?, updated_at = ?
    WHERE id = ? AND status IN ('Draft','Validated','Failed')
  `).run(clientRef, Date.now(), id);
  if (claimed.changes === 0) {
    return { busy: true, bill: getBill(id) };
  }

  const payload = { ...bill, toGstin: bill.to_gstin, docNo: bill.doc_no,
                    vehicleNo: bill.vehicle_no, distanceKm: bill.distance_km,
                    clientRef };
  let result;
  try {
    result = await currentAdapter().generate(payload);
  } catch (e) {
    result = { ok: false, error: { code: "EXCEPTION", message: e.message }, raw: {} };
  }
  recordCall(id, "generate", payload, result);

  if (!result.ok) {
    db.prepare("UPDATE ewb_bills SET status='Failed', last_error=?, updated_at=? WHERE id=?")
      .run(result.error.message || "Submission failed.", Date.now(), id);
    logAction(req, "ewb.failed", `${bill.doc_no}: ${result.error.code} ${result.error.message}`);
    return { failed: true, error: result.error, bill: getBill(id) };
  }

  const d = result.data;
  db.prepare(`
    UPDATE ewb_bills SET status='Generated', ewb_no=?, ewb_date=?, valid_until=?,
                         last_error='', updated_at=? WHERE id=?
  `).run(d.ewbNo, d.ewbDate, d.validUntil, Date.now(), id);

  // The invoice keeps its denormalised copy so printing needs no join.
  if (bill.invoice_id) {
    db.prepare(`
      UPDATE invoices SET eway_bill_no=?, eway_bill_date=?, eway_valid_until=?,
                          eway_status='Generated' WHERE id=?
    `).run(d.ewbNo, d.ewbDate, d.validUntil, bill.invoice_id);
  }
  logAction(req, "ewb.generated", `${bill.doc_no}: ${d.ewbNo}`);
  return { bill: getBill(id) };
}

async function cancel(id, reason, req) {
  const bill = getBill(id);
  if (!bill) throw new Error("E-way bill not found.");
  if (bill.status !== "Generated") throw new Error("Only a generated e-way bill can be cancelled.");

  const result = await currentAdapter().cancel({ ewbNo: bill.ewb_no, reason });
  recordCall(id, "cancel", { ewbNo: bill.ewb_no, reason }, result);
  if (!result.ok) return { failed: true, error: result.error, bill };

  db.prepare(`
    UPDATE ewb_bills SET status='Cancelled', cancelled_at=?, cancel_reason=?, updated_at=?
    WHERE id=?
  `).run(Date.now(), reason, Date.now(), id);
  if (bill.invoice_id)
    db.prepare("UPDATE invoices SET eway_status='Cancelled' WHERE id=?").run(bill.invoice_id);
  logAction(req, "ewb.cancelled", `${bill.doc_no}: ${bill.ewb_no} — ${reason}`);
  return { bill: getBill(id) };
}

module.exports = { buildFromInvoice, validate, saveDraft, getBill, generate, cancel, recordCall };
