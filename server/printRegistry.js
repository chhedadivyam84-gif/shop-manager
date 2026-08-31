/* ============================================================
   PRINT REGISTRY

   One declaration per printable document. Everything else in the print
   system — the template store, the Print Management screen, the search,
   the designer's field list — is generated from this file. Adding a new
   document type later means adding ONE entry here, not touching the print
   system again. That is the whole point of it existing.

   `available: false` marks a document the app cannot produce yet. It still
   appears, greyed, with the reason — a shop owner who was promised Credit
   Notes deserves to see where they stand rather than wonder why the list
   is short. Nothing can be printed for it until its module is built, and
   the screen says so rather than offering a button that fails.

   Field keys used in a template config are the keys declared here, so a
   template can never reference a column its document does not have.
   ============================================================ */

/* The item-table columns a document can show. Not every document has every
   one — `items` on each entry lists which apply. Renaming and reordering
   happen in the template, never here: this is what EXISTS, the template
   decides what is SHOWN. */
const ITEM_FIELDS = {
  sn:        { label: "Sr. No.",        align: "center", width: 26 },
  category:  { label: "Category",       align: "left",   width: 70 },
  brand:     { label: "Brand",          align: "left",   width: 70 },
  name:      { label: "Product",        align: "left",   width: 0 },
  code:      { label: "Product Code",   align: "left",   width: 62 },
  hsn:       { label: "HSN/SAC",        align: "left",   width: 58 },
  size:      { label: "Size",           align: "left",   width: 90 },
  /* The length actually billed on this line, in feet.
     Not the same thing as Size beside it: Size is the variant the board
     came from ("8x4"), while this is what was measured and charged for,
     and in a shop that sells by the square foot those two differ on most
     lines. Blank on a line sold by the piece, which has no length. */
  length:    { label: "Length (ft)",    align: "right",  width: 56 },
  /* Width and Thickness carry their unit IN THE CELL, unlike Length above,
     because theirs changes with how the line was priced: width is feet on a
     Sq.ft line and inches on a CFT one, and a bill can hold both at once.
     A header saying "(ft)" over a column holding inches is not a cosmetic
     problem — it is a wrong measurement on a document a customer keeps.
     Length is always feet, so its unit can safely live in the header. */
  width:     { label: "Width",          align: "right",  width: 56 },
  thickness: { label: "Thickness",      align: "right",  width: 62 },
  qty:       { label: "Quantity",       align: "right",  width: 48 },
  unit:      { label: "Unit",           align: "left",   width: 44 },
  rate:      { label: "Rate",           align: "right",  width: 74, money: true, hideWithoutRate: true },
  disc:      { label: "Discount %",     align: "right",  width: 46, hideWithoutRate: true },
  taxable:   { label: "Taxable Amount", align: "right",  width: 78, money: true, hideWithoutRate: true },
  gstPct:    { label: "GST %",          align: "right",  width: 44 },
  cgst:      { label: "CGST",           align: "right",  width: 62, money: true, hideWithoutRate: true },
  sgst:      { label: "SGST",           align: "right",  width: 62, money: true, hideWithoutRate: true },
  igst:      { label: "IGST",           align: "right",  width: 62, money: true, hideWithoutRate: true },
  amount:    { label: "Amount",         align: "right",  width: 78, money: true, hideWithoutRate: true },
  remarks:   { label: "Remarks",        align: "left",   width: 80 }
};

/* Column sets, so the common shapes are named once.
   Unit precedes Qty to match the order the bill actually prints in. */
const GOODS_COLUMNS   = ["sn","name","size","unit","qty","rate","disc","taxable","gstPct","cgst","sgst","igst","amount"];
/* Length joins the EXTRAS, not the default set: a column appearing on every
   shop's bills without being asked for is a change to their paperwork that
   nobody chose. It is one tick away in the template. */
const GOODS_EXTRAS    = ["category","brand","code","hsn","length","width","thickness","remarks"];
const CHALLAN_COLUMNS = ["sn","name","size","unit","qty","rate","amount"];

const ALL_GOODS = [...GOODS_COLUMNS, ...GOODS_EXTRAS];

/**
 * Every document the print system knows about.
 *
 *  key        stable id, used in doc_templates.doc_type — never renamed
 *  table      where the documents live (null when not built yet)
 *  where      extra SQL predicate, for tables holding more than one type
 *  numberCol  the human document number
 *  partyCol   customer_id or supplier_id, decides which master is joined
 *  items      which ITEM_FIELDS this document can offer
 *  supportsRate  whether a "Without Rate" template makes sense
 */
const DOCUMENTS = [
  {
    key: "sales_invoice", label: "Sales Invoice", group: "Sales", available: true,
    table: "invoices", where: "doc_type = 'invoice'", numberCol: "challan_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: "voided", locationCol: "location_id", areaCol: "area_id",
    salesmanCol: "delivery_man", totalCol: "total",
    itemsTable: "invoice_items", itemsKey: "invoice_id",
    /* Every other document here is titled what it IS — QUOTATION, SALES
       ORDER, PURCHASE INVOICE. This one said "ESTIMATE CHALLAN", so the
       template seeded for every new shop headed its tax invoices as
       estimates, over the top of the "TAX INVOICE" the app itself puts in
       settings.invoice_title. On a sheet carrying CGST, SGST and a grand
       total that is not a wording preference: an estimate is not a tax
       invoice, and a buyer cannot claim input credit against one. */
    items: ALL_GOODS, supportsRate: true, defaultTitle: "TAX INVOICE",
    // The wording the bill has always printed. Without these a default
    // template would relabel the shop's own headers ("Sr. No.", "Product",
    // "Quantity") the moment templates drive the page.
    labels: { sn: "Sr No.", name: "Product Description", size: "Size", qty: "Qty" },
    autoWidths: true
  },
  {
    key: "delivery_challan", label: "Delivery Challan", group: "Sales", available: true,
    table: "invoices", where: "doc_type = 'challan'", numberCol: "challan_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: "voided", locationCol: "location_id", areaCol: "area_id",
    salesmanCol: "delivery_man", totalCol: "total",
    itemsTable: "invoice_items", itemsKey: "invoice_id",
    items: [...CHALLAN_COLUMNS, ...GOODS_EXTRAS], supportsRate: true,
    defaultTitle: "DELIVERY CHALLAN",
    // A challan words two of these differently from the invoice.
    labels: { sn: "Sr No.", name: "Product / Item", size: "Description", qty: "Qty" },
    autoWidths: true
  },
  {
    key: "purchase_invoice", label: "Purchase Invoice", group: "Purchase", available: true,
    table: "purchases", where: null, numberCol: "purchase_no",
    partyCol: "supplier_id", partyKind: "supplier", dateCol: "date",
    voidedCol: "voided", locationCol: "location_id", areaCol: "area_id",
    salesmanCol: null, totalCol: "total",
    itemsTable: "purchase_items", itemsKey: "purchase_id",
    items: ALL_GOODS, supportsRate: true, defaultTitle: "PURCHASE INVOICE"
  },
  {
    key: "sales_quotation", label: "Sales Quotation", group: "Sales", available: true,
    table: "quotations", where: null, numberCol: "quotation_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: null, locationCol: null, areaCol: null,
    salesmanCol: null, totalCol: "total",
    itemsTable: "quotation_items", itemsKey: "quotation_id",
    items: ALL_GOODS, supportsRate: true, defaultTitle: "QUOTATION"
  },
  {
    /* Not a priced document, so no tax columns: the rate on a selection
       slip is what the party was quoted across the counter, and the
       quantity beside it is usually still blank. It has its own printed
       layout (printSelectionSlip in app.js) rather than a designable
       template, because what the shop wants is the pad it already uses. */
    key: "selection_slip", label: "Selection Slip", group: "Sales", available: true,
    table: "selection_slips", where: null, numberCol: "slip_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: null, locationCol: null, areaCol: null,
    salesmanCol: "salesman", totalCol: "total",
    itemsTable: "selection_slip_items", itemsKey: "slip_id",
    items: ["sn","code","name","qty","rate","amount","remarks"], supportsRate: true,
    defaultTitle: "SELECTION SLIP",
    /* The paper slip names these columns its own way, and the staff read
       them by those names. */
    labels: { sn: "Sr. No.", code: "Design No.", name: "Description", qty: "Qty", remarks: "Note" }
  },
  {
    key: "sales_order", label: "Sales Order", group: "Sales", available: true,
    table: "sales_orders", where: null, numberCol: "so_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: null, locationCol: null, areaCol: null,
    salesmanCol: null, totalCol: "total",
    itemsTable: "sales_order_items", itemsKey: "sales_order_id",
    items: ALL_GOODS, supportsRate: true, defaultTitle: "SALES ORDER"
  },
  {
    key: "purchase_order", label: "Purchase Order", group: "Purchase", available: true,
    table: "purchase_orders", where: null, numberCol: "po_no",
    partyCol: "supplier_id", partyKind: "supplier", dateCol: "date",
    voidedCol: null, locationCol: null, areaCol: null,
    salesmanCol: null, totalCol: "total",
    itemsTable: "purchase_order_items", itemsKey: "purchase_order_id",
    items: ALL_GOODS, supportsRate: true, defaultTitle: "PURCHASE ORDER"
  },
  {
    key: "sales_return", label: "Sales Return", group: "Returns", available: true,
    table: "sales_returns", where: null, numberCol: "return_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: "voided", locationCol: "location_id", areaCol: null,
    salesmanCol: null, totalCol: "total",
    itemsTable: "sales_return_items", itemsKey: "sales_return_id",
    items: ALL_GOODS, supportsRate: true, defaultTitle: "SALES RETURN"
  },
  {
    key: "purchase_return", label: "Purchase Return", group: "Returns", available: true,
    table: "purchase_returns", where: null, numberCol: "return_no",
    partyCol: "supplier_id", partyKind: "supplier", dateCol: "date",
    voidedCol: "voided", locationCol: "location_id", areaCol: null,
    salesmanCol: null, totalCol: "total",
    itemsTable: "purchase_return_items", itemsKey: "purchase_return_id",
    items: ALL_GOODS, supportsRate: true, defaultTitle: "PURCHASE RETURN"
  },

  /* ---- Declared, not yet buildable ----
     These have no module behind them: no entry screen, no numbering, no
     rows to print. Their templates can be designed in advance and will
     work the moment the module lands, but nothing can be printed for them
     today and the screen says exactly that instead of offering a dead
     button. */
  { key: "proforma_invoice", label: "Proforma Invoice", group: "Sales", available: false,
    items: ALL_GOODS, supportsRate: true, defaultTitle: "PROFORMA INVOICE",
    unavailableReason: "No Proforma Invoice module yet — nothing to print." },
  { key: "credit_note", label: "Credit Note", group: "Returns", available: false,
    items: ALL_GOODS, supportsRate: true, defaultTitle: "CREDIT NOTE",
    unavailableReason: "No Credit Note module yet. Sales Return is the nearest thing you can print today." },
  { key: "debit_note", label: "Debit Note", group: "Returns", available: false,
    items: ALL_GOODS, supportsRate: true, defaultTitle: "DEBIT NOTE",
    unavailableReason: "No Debit Note module yet. Purchase Return is the nearest thing you can print today." },
  { key: "purchase_challan", label: "Purchase Delivery Challan", group: "Purchase", available: false,
    items: [...CHALLAN_COLUMNS, ...GOODS_EXTRAS], supportsRate: true, defaultTitle: "PURCHASE CHALLAN",
    unavailableReason: "Goods received are recorded as a Purchase, not a separate challan." },
  { key: "purchase_quotation", label: "Purchase Quotation", group: "Purchase", available: false,
    items: ALL_GOODS, supportsRate: true, defaultTitle: "PURCHASE QUOTATION",
    unavailableReason: "No Purchase Quotation module yet — a Purchase Order is the nearest thing." },
  { key: "payment_receipt", label: "Payment Receipt", group: "Money", available: false,
    items: [], supportsRate: false, defaultTitle: "RECEIPT",
    unavailableReason: "Receipts are recorded against a party, but there is no printable receipt document yet." },
  { key: "payment_voucher", label: "Payment Voucher", group: "Money", available: false,
    items: [], supportsRate: false, defaultTitle: "PAYMENT VOUCHER",
    unavailableReason: "No voucher document yet — payments are recorded in the Cash and Bank Books." },
  { key: "receipt_voucher", label: "Receipt Voucher", group: "Money", available: false,
    items: [], supportsRate: false, defaultTitle: "RECEIPT VOUCHER",
    unavailableReason: "No voucher document yet — receipts are recorded in the Cash and Bank Books." },
  { key: "stock_transfer", label: "Stock Transfer", group: "Stock", available: false,
    items: ["sn","name","size","qty","unit"], supportsRate: false, defaultTitle: "STOCK TRANSFER",
    unavailableReason: "Transfers are recorded between Shop and Warehouse but have no printable note yet." }
];

const BY_KEY = new Map(DOCUMENTS.map(d => [d.key, d]));

function getDoc(key) { return BY_KEY.get(key) || null; }
function availableDocs() { return DOCUMENTS.filter(d => d.available); }

/** The default template config for a document — what a shop gets before
 *  anyone opens the designer. Sensible, complete, and never shared between
 *  document types: each call builds a fresh object. */
function defaultConfig(doc) {
  const cols = (doc.items || []).map(key => {
    const f = ITEM_FIELDS[key];
    // Tax and extra columns start hidden: a bill that prints eighteen
    // columns by default is unreadable, and turning one on is one tick.
    const onByDefault = ["sn", "name", "size", "qty", "unit", "rate", "amount"].includes(key);
    const label = (doc.labels && doc.labels[key]) || f.label;
    return { key, label, show: onByDefault ? 1 : 0,
             width: doc.autoWidths ? 0 : f.width, align: f.align };
  });
  return {
    paper: "A4",
    // 0 = inherit the stylesheet, which is what the bill has always used.
    // Only documents without their own stylesheet carry real numbers here.
    orientation: "portrait",
    margins: doc.autoWidths ? { top: 0, right: 0, bottom: 0, left: 0 }
                            : { top: 10, right: 10, bottom: 10, left: 10 },
    fontSize: doc.autoWidths ? 0 : 10.5,
    title: doc.defaultTitle || doc.label,
    /* The height of one row in the item table, in the same pixels the
       column widths use. 0 means "whatever the text needs", which is how
       every bill has printed until now — so a template nobody has dragged
       looks exactly as it always did. */
    rowHeight: 0,
    /* And the heights of INDIVIDUAL rows, keyed by the row's position in
       the table: { "0": 34, "3": 22 }. A row with no entry falls back to
       rowHeight above, and rowHeight of 0 falls back to what the text
       needs — so a template nobody has dragged still prints exactly as it
       always did, and one where only the third line was pulled taller
       keeps every other line where it was.

       Keyed by POSITION, not by any line's id. The template is printed
       against a different document every time; "the third row" is the only
       thing that means anything across all of them. */
    rowHeights: {},
    /* Locked layouts cannot be dragged or typed into until an owner
       unlocks them. It stops a layout somebody spent an afternoon getting
       right from being nudged by a thumb on a phone. */
    locked: 0,
    /* Only read when paper is "custom". Millimetres, because that is what
       paper is sold in and what @page takes. */
    paperW: 0,
    paperH: 0,
    /* Designer aids. They change nothing that prints — they are how the
       page is worked on, not what comes out of it — but they belong to the
       template so a shop that likes a 5mm grid keeps it. */
    gridOn: 0,
    snapOn: 1,
    gridSize: 5,
    showRate: true,
    showLogo: true,
    showCompany: true,
    showParty: true,
    showTotals: true,
    showTax: true,
    showAmountInWords: true,
    showSignature: true,
    signatureText: "Authorised Signature",
    showPageNumbers: false,
    showBorders: true,
    header: "",
    footer: "",
    terms: "",
    customText: "",
    columns: cols
  };
}

module.exports = { DOCUMENTS, ITEM_FIELDS, getDoc, availableDocs, defaultConfig };
