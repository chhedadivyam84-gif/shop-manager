/* ============================================================
   DUPLICATES AND OVERSIZED NAMES — asked about, not silently saved

   Found 20 Oct 2026: a second customer with the same mobile number, and a
   second product with the same name, were saved without a word — so a
   shop ended up with two "Ramesh Traders", half the bills on each, and
   two stock counts for one plywood. A 5,000-character name was accepted
   too, and broke the layout of every list and bill it appeared on.

   ONE PLACE for what counts as "the same", used by the customer, supplier
   and product routes:
     - a customer: the same mobile number (its last ten digits, so
       "+91 98200 12345" and "9820012345" match). The same NAME alone is
       not a duplicate — two Rameshes are common and both real.
     - a supplier: the same phone number, or the same GSTIN.
     - a product: the same name, ignoring case and extra spaces.

   It is a QUESTION, not a rule: the route answers 409 with what was
   found, the screen asks "add it anyway?", and a yes resends with
   allowDuplicate. Only active records count — an inactive one is not in
   the way. The record being edited never counts as its own duplicate.
   ============================================================ */
const db = require("./db");

/* Long enough for any real shop, firm or product name; short enough that a
   paste of a whole paragraph is caught before it reaches a bill. */
const MAX_NAME = 120;

function nameProblem(name, what) {
  const n = String(name || "").trim();
  if (n.length > MAX_NAME) return `${what} name is too long — keep it under ${MAX_NAME} characters.`;
  return null;
}

/** The last ten digits, which is what identifies an Indian mobile. */
function phoneKey(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 6 ? d.slice(-10) : "";
}

const has = (table, col) => {
  try { return db.prepare(`PRAGMA table_info("${table}")`).all().some(c => c.name === col); }
  catch (e) { return false; }
};

function activeRows(table, exceptId) {
  const activeClause = has(table, "active") ? "WHERE COALESCE(active, 1) = 1" : "";
  return db.prepare(`SELECT * FROM "${table}" ${activeClause}`).all().filter(r => r.id !== exceptId);
}

function sameCustomer(phone, exceptId) {
  const k = phoneKey(phone);
  if (!k) return null;
  const hit = activeRows("customers", exceptId).find(r => phoneKey(r.phone) === k);
  return hit ? { id: hit.id, name: hit.name, phone: hit.phone,
    message: `A customer with this mobile number already exists: ${hit.name} (${hit.phone}).` } : null;
}

function sameSupplier(phone, gst, exceptId) {
  const k = phoneKey(phone);
  const g = String(gst || "").trim().toUpperCase();
  const hit = activeRows("suppliers", exceptId).find(r =>
    (k && phoneKey(r.phone) === k) || (g && String(r.gst || "").trim().toUpperCase() === g));
  if (!hit) return null;
  const by = g && String(hit.gst || "").trim().toUpperCase() === g ? `GSTIN ${hit.gst}` : `phone ${hit.phone}`;
  return { id: hit.id, name: hit.name, message: `A supplier with this ${by} already exists: ${hit.name}.` };
}

const nameKey = n => String(n || "").trim().replace(/\s+/g, " ").toLowerCase();
function sameProduct(name, exceptId) {
  const k = nameKey(name);
  if (!k) return null;
  const hit = activeRows("products", exceptId).find(r => nameKey(r.name) === k);
  return hit ? { id: hit.id, name: hit.name, message: `A product named "${hit.name}" already exists.` } : null;
}

/** The 409 every route sends, so the screen handles them all the same way. */
function askAboutDuplicate(res, found) {
  return res.status(409).json({ error: found.message, duplicate: { id: found.id, name: found.name } });
}

module.exports = { MAX_NAME, nameProblem, phoneKey, sameCustomer, sameSupplier, sameProduct, askAboutDuplicate };
