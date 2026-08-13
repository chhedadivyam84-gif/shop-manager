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

/* Column sets, so the common shapes are named once. */
const GOODS_COLUMNS   = ["sn","name","size","qty","unit","rate","disc","taxable","gstPct","cgst","sgst","igst","amount"];
const GOODS_EXTRAS    = ["category","brand","code","hsn","remarks"];
const CHALLAN_COLUMNS = ["sn","name","size","qty","unit","rate","amount"];

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
    items: ALL_GOODS, supportsRate: true, defaultTitle: "TAX INVOICE"
  },
  {
    key: "delivery_challan", label: "Delivery Challan", group: "Sales", available: true,
    table: "invoices", where: "doc_type = 'challan'", numberCol: "challan_no",
    partyCol: "customer_id", partyKind: "customer", dateCol: "date",
    voidedCol: "voided", locationCol: "location_id", areaCol: "area_id",
    salesmanCol: "delivery_man", totalCol: "total",
    itemsTable: "invoice_items", itemsKey: "invoice_id",
    items: [...CHALLAN_COLUMNS, ...GOODS_EXTRAS], supportsRate: true,
    defaultTitle: "DELIVERY CHALLAN"
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
    return { key, label: f.label, show: onByDefault ? 1 : 0, width: f.width, align: f.align };
  });
  return {
    paper: "A4",
    orientation: "portrait",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    fontSize: 10.5,
    title: doc.defaultTitle || doc.label,
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
