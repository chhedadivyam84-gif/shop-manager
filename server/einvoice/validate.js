/* ============================================================
   E-INVOICE READINESS CHECK

   Runs entirely offline, before any API call. The portal rejects a whole
   invoice for one missing PIN code, and a rejection round-trip tells you
   about one problem at a time — so everything is checked here at once and
   reported together, in the shop's language rather than the schema's.

   This is deliberately separate from the payload builder. The builder
   assumes valid input; this decides whether the input IS valid. Keeping
   them apart means the same check can run on a Settings screen, on a
   customer record, or as a pre-flight on one invoice.
   ============================================================ */
const { stateCode, stateCodeFromGstin, uqc, looksLikeGstin } = require("./gstCodes");

const problem = (field, says, fix) => ({ field, says, fix });

/**
 * Everything wrong with the SHOP's own details. These block every invoice,
 * so they are worth showing on the Settings screen rather than surfacing
 * one bill at a time.
 */
function checkSupplier(settings) {
  const s = settings || {};
  const out = [];
  if (!s.gstin) {
    out.push(problem("Shop GSTIN", "missing", "Settings → GSTIN"));
  } else if (!looksLikeGstin(s.gstin)) {
    out.push(problem("Shop GSTIN", `"${s.gstin}" is not a valid GSTIN format`, "Settings → GSTIN"));
  }
  if (!s.business_name) out.push(problem("Legal Name", "missing", "Settings → Business Name"));

  const code = stateCode(s.state);
  if (!s.state) {
    out.push(problem("Shop State", "missing", "Settings → Shop State"));
  } else if (!code) {
    out.push(problem("Shop State", `"${s.state}" is not a recognised GST state`, "Settings → Shop State"));
  } else {
    const fromGstin = stateCodeFromGstin(s.gstin);
    if (fromGstin && fromGstin !== code) {
      out.push(problem("Shop State", `state says ${s.state} (${code}) but the GSTIN begins ${fromGstin}`,
                       "one of the two is wrong — check Settings"));
    }
  }
  if (!s.address) out.push(problem("Shop Address", "missing", "Settings → Address"));
  if (!s.pin_code) out.push(problem("Shop PIN code", "missing — the portal requires it",
                                    "Settings → PIN code"));
  else if (!/^\d{6}$/.test(String(s.pin_code).trim()))
    out.push(problem("Shop PIN code", `"${s.pin_code}" is not six digits`, "Settings → PIN code"));
  return out;
}

/**
 * The BUYER's details for one invoice. A B2C sale below the threshold does
 * not need a buyer GSTIN, so a missing one is only a problem when the sale
 * is B2B — which is why `requireGstin` is decided by the caller, not here.
 */
function checkBuyer(customer, requireGstin) {
  const c = customer || {};
  const out = [];
  if (!c.name) out.push(problem("Customer name", "missing", "the customer record"));

  if (requireGstin) {
    if (!c.gst) out.push(problem("Customer GSTIN", "missing for a B2B invoice", "the customer record"));
    else if (!looksLikeGstin(c.gst))
      out.push(problem("Customer GSTIN", `"${c.gst}" is not a valid GSTIN format`, "the customer record"));
  }
  if (!c.state) out.push(problem("Customer state", "missing — it sets the Place of Supply", "the customer record"));
  else if (!stateCode(c.state))
    out.push(problem("Customer state", `"${c.state}" is not a recognised GST state`, "the customer record"));

  if (c.gst && c.state) {
    const fromGstin = stateCodeFromGstin(c.gst), fromState = stateCode(c.state);
    if (fromGstin && fromState && fromGstin !== fromState)
      out.push(problem("Customer state", `state says ${c.state} (${fromState}) but their GSTIN begins ${fromGstin}`,
                       "the customer record"));
  }
  if (!c.address) out.push(problem("Customer address", "missing", "the customer record"));
  if (!c.pin_code) out.push(problem("Customer PIN code", "missing — the portal requires it",
                                    "the customer record"));
  else if (!/^\d{6}$/.test(String(c.pin_code).trim()))
    out.push(problem("Customer PIN code", `"${c.pin_code}" is not six digits`, "the customer record"));
  return out;
}

/** Line items: HSN and a mappable unit are both mandatory. */
function checkItems(items) {
  const out = [];
  (items || []).forEach((it, i) => {
    const where = `line ${i + 1} (${it.name || "unnamed"})`;
    if (!it.hsn_code) out.push(problem(where, "no HSN/SAC code", "the product record"));
    else if (!/^\d{4}(\d{2})?(\d{2})?$/.test(String(it.hsn_code).trim()))
      out.push(problem(where, `HSN "${it.hsn_code}" must be 4, 6 or 8 digits`, "the product record"));

    const unit = it.unit_label || it.unit;
    if (!unit) out.push(problem(where, "no unit", "the product record"));
    else if (!uqc(unit))
      out.push(problem(where, `unit "${unit}" has no GST unit code (UQC)`,
                       "set the product's UQC — e.g. Sq.ft → SQF, Piece → PCS"));

    if (!(Number(it.qty) > 0)) out.push(problem(where, "quantity is zero or missing", "the invoice line"));
  });
  if (!(items || []).length) out.push(problem("Items", "the invoice has no lines", "the invoice"));
  return out;
}

/**
 * One invoice, end to end. Returns { ready, problems } — `ready` false means
 * the portal would reject it, and every problem names where to fix it.
 */
function checkInvoice({ settings, customer, invoice, items }) {
  const inv = invoice || {};
  const problems = [
    ...checkSupplier(settings),
    // A sale carrying GST to a registered buyer is B2B; a GSTIN-less sale is
    // B2C and needs no buyer GSTIN, so the requirement follows the data.
    ...checkBuyer(customer, !!(customer && customer.gst)),
    ...checkItems(items)
  ];

  if (!inv.challan_no) problems.push(problem("Invoice number", "missing", "the invoice"));
  if (!inv.date) problems.push(problem("Invoice date", "missing", "the invoice"));
  if (inv.gst_enabled === 0)
    problems.push(problem("GST", "this is a Non-GST invoice — an e-invoice cannot be raised for it",
                          "raise it as a GST invoice"));
  if (inv.doc_type === "challan")
    problems.push(problem("Document", "a delivery challan is not an invoice",
                          "convert it to a tax invoice first"));

  return { ready: problems.length === 0, problems };
}

module.exports = { checkInvoice, checkSupplier, checkBuyer, checkItems };
