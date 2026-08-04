(function(){
"use strict";

const INDIAN_STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat",
"Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur",
"Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura",
"Uttar Pradesh","Uttarakhand","West Bengal","Andaman and Nicobar Islands","Chandigarh",
"Dadra and Nagar Haveli and Daman and Diu","Delhi","Jammu and Kashmir","Ladakh","Lakshadweep","Puducherry"];

/* ============================================================
   API HELPER
   ============================================================ */
async function api(method, path, body){
  const opts = { method, headers:{}, credentials:"same-origin" };
  if(body !== undefined){ opts.headers["Content-Type"]="application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch("/api"+path, opts);
  if(res.status === 401){ showLogin(); throw new Error("Session expired. Please log in again."); }
  let data = null;
  const ct = res.headers.get("content-type")||"";
  if(ct.includes("application/json")) data = await res.json();
  if(!res.ok){ throw new Error((data && data.error) || "Request failed."); }
  return data;
}
function toast(msg, kind){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = kind==="ok" ? "ok" : "";
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{ el.style.display="none"; }, 3200);
}

/* ============================================================
   STATE
   ============================================================ */
let state = {
  products: [], customers: [], suppliers: [], invoices: [], settings: null, dashboard: null,
  cart: [], selectedCustomerId: null,
  // Per-invoice GST Type override — null means "use the selected customer's
  // Customer Master default (currentTaxType())"; set to "CGST_SGST"/"IGST"
  // once staff explicitly picks one for THIS invoice, without touching the
  // customer's stored default. Reset back to null whenever the customer
  // changes or a new invoice starts, so it never silently leaks between bills.
  taxTypeOverride: null,
  discountType: "pct", discountValue: 0, advance: 0, paymentMethod: "Cash",
  transport: 0, loading: 0, roundOff: true, docType: "invoice", challanShowRate: false, gstOnCharges: true, gstEnabled: true, deliveryMan: "",
  vehicleNumber: "", deliveryAddress: "", remarks: "",
  invBrandFilter: "All", reportType: "Sales", partyMode: "customer",
  // Which location a Bill/Challan sells from — "shop" is every invoice's
  // long-standing default; "warehouse" is opt-in per sale (requirement:
  // "sale to warehouse"). Stored as a location ID once locations load.
  billingLocationId: null,
  paperSize: "A5", editingInvoiceId: null, docNo: null,
  cbFrom: "", cbTo: "", cbEntries: [],
  bbFrom: "", bbTo: "", bbEntries: [], bankAccounts: [], bbAccountId: null,
  inqStatus: "All", inquiries: [], staffNames: [],
  // Purchase Entry (Phase 1) — a standalone cart, separate from state.cart
  // (Billing's sales cart), since a purchase invoice's line shape (per-line
  // discount, GST computed forward not backed-out, no stock cap) differs from
  // a sales line.
  pur: {
    docType: "purchase", supplierId: null, purchaseType: "Local", paymentMethod: "Credit",
    date: "", invoiceNo: "", dueDate: "", vehicleNumber: "", transportName: "", lrNumber: "", remarks: "",
    transport: 0, loading: 0, otherCharges: 0, roundOff: true, cart: [], editingPurchaseId: null, locationId: null,
    gstEnabled: true, purchaseNo: null
  },
  po: {
    supplierId: null, purchaseType: "Local", date: "", deliveryAddress: "", expectedDeliveryDate: "",
    paymentTerms: "", deliveryTerms: "", remarks: "", freight: 0, otherCharges: 0, roundOff: true,
    cart: [], editingPoId: null
  },
  quotation: {
    customerId: null, saleType: "Local", date: "", validUntil: "", terms: "", remarks: "",
    discountType: "pct", discountValue: 0, transport: 0, loading: 0, gstOnCharges: true, roundOff: true,
    cart: [], editingQuotationId: null, quotationNo: null
  },
  so: {
    customerId: null, saleType: "Local", date: "", deliveryAddress: "", expectedDeliveryDate: "", remarks: "",
    discountType: "pct", discountValue: 0, transport: 0, loading: 0, gstOnCharges: true, roundOff: true,
    cart: [], editingSoId: null
  },
  locations: [], invLocationCode: null, invStockFilter: "all",
  me: { staffName: "", role: "" },
  ctx: {}
};
function isOwner(){ return state.me.role === "owner"; }

function fmt(n){
  n = Math.round(n||0);
  return "₹" + n.toLocaleString("en-IN");
}
/* Rupees WITH paise, for line amounts and invoice totals — an area calculation
   rarely lands on a whole rupee, and hiding the paise makes the printed column
   fail to add up to the printed total. */
function fmtPaise(n){
  const v = Math.round(((n||0) + Number.EPSILON) * 100) / 100;
  return "₹" + v.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2});
}
function stockLevel(stock){
  if(stock<=0) return "danger";
  if(stock<5) return "danger";
  if(stock<15) return "warn";
  return "ok";
}
function stockLabel(stock){
  if(stock<=0) return "Out of stock";
  if(stock<5) return "Low: "+stock;
  if(stock<15) return "Medium: "+stock;
  return "In stock: "+stock;
}
/* Rounding comes from the shared pricing module rather than a local copy, so
   the browser and the server round identically at every step. */
const round2 = Pricing.round2;
/** "2026-07-24" in the browser's local timezone — for date input defaults. */
function todayISO(){
  const d = new Date();
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
}

/* Reads an optional input that may not be in the DOM at all — the dimension
   boxes are rendered per mode, so Rft genuinely has no width field. */
function val(id){
  const el = document.getElementById(id);
  return el && el.value !== "" ? el.value : "";
}
function initials(name){
  return (name||"?").split(" ").map(w=>w[0]).filter(Boolean).slice(0,2).join("").toUpperCase();
}

/* ============================================================
   BOOT / LOGIN
   ============================================================ */
async function boot(){
  const sess = await fetch("/api/auth/session").then(r=>r.json()).catch(()=>({loggedIn:false}));
  if(sess.loggedIn){
    state.me = { staffName: sess.staffName, role: sess.role };
    document.getElementById("login").style.display="none";
    document.getElementById("app").style.display="block";
    await initApp();
  } else {
    document.getElementById("login-title").textContent = sess.businessName || "Shop Manager";
    document.getElementById("login-logo").textContent = initials(sess.businessName||"Shop Manager");
    await initLogin();
  }
}
boot();

let pinEntry = "";
let staffList = [];
let selectedStaff = null;
async function initLogin(){
  document.getElementById("login-step-pin").style.display = "none";
  document.getElementById("login-step-staff").style.display = "block";
  document.getElementById("login-error").textContent = "";
  try{
    staffList = await fetch("/api/auth/staff-list").then(r=>r.json());
  }catch(e){ staffList = []; }

  const wrap = document.getElementById("staff-picker");
  wrap.innerHTML = staffList.length ? staffList.map(s=>`
    <button class="qa-btn" data-staff="${s.id}">
      <span class="ic avatar" style="width:34px;height:34px;font-size:13px;display:inline-flex;flex-shrink:0;">${initials(s.name)}</span>
      ${escapeHtml(s.name)}${s.role==="owner" ? " (Owner)" : ""}
    </button>`).join("") : `<div class="empty-hint">Couldn't reach the server. Check the app is running.</div>`;
  wrap.querySelectorAll("[data-staff]").forEach(b=>{
    b.addEventListener("click", ()=>selectStaff(b.dataset.staff));
  });

  // iOS-style keypad: big number, small letter caption underneath (purely
  // decorative here — nothing in this app maps letters to digits) so the
  // pad reads like the passcode screen everyone already knows, rather than
  // a generic dialpad.
  const PIN_KEYS = [
    {k:"1", letters:""},   {k:"2", letters:"ABC"},  {k:"3", letters:"DEF"},
    {k:"4", letters:"GHI"},{k:"5", letters:"JKL"},  {k:"6", letters:"MNO"},
    {k:"7", letters:"PQRS"},{k:"8", letters:"TUV"}, {k:"9", letters:"WXYZ"},
    {k:"", blank:true},    {k:"0", letters:""},     {k:"⌫", backspace:true}
  ];
  const pad = document.getElementById("pinpad");
  pad.innerHTML = "";
  PIN_KEYS.forEach(({k, letters, blank, backspace})=>{
    const b = document.createElement("button");
    if(blank){
      b.className = "pk-blank";
    } else if(backspace){
      b.className = "pk-backspace";
      b.setAttribute("aria-label", "Delete");
      b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z"/></svg>`;
    } else {
      b.innerHTML = `<span class="pk-num">${k}</span>${letters ? `<span class="pk-letters">${letters}</span>` : ""}`;
    }
    b.addEventListener("click", ()=>handleKey(k));
    pad.appendChild(b);
  });
  document.getElementById("login-back-link").addEventListener("click", (e)=>{ e.preventDefault(); initLogin(); });
}
function selectStaff(staffId){
  selectedStaff = staffList.find(s=>s.id===staffId);
  if(!selectedStaff) return;
  pinEntry = "";
  document.getElementById("login-pin-prompt").textContent = "Enter PIN for "+selectedStaff.name+".";
  document.getElementById("login-error").textContent = "";
  document.getElementById("login-step-staff").style.display = "none";
  document.getElementById("login-step-pin").style.display = "block";
  const dotsWrap = document.getElementById("pin-dots");
  dotsWrap.innerHTML = "";
  for(let i=0;i<4;i++){ const s=document.createElement("span"); dotsWrap.appendChild(s); }
  renderDots();
}
function renderDots(){
  const dots = document.querySelectorAll("#pin-dots span");
  dots.forEach((d,i)=> d.classList.toggle("filled", i < pinEntry.length));
}
async function handleKey(k){
  const errEl = document.getElementById("login-error");
  if(k==="⌫"){ pinEntry = pinEntry.slice(0,-1); errEl.textContent=""; renderDots(); return; }
  if(k==="" || pinEntry.length>=4 || !selectedStaff) return;
  pinEntry += k;
  renderDots();
  if(pinEntry.length===4){
    try{
      const res = await fetch("/api/auth/login", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({staffId: selectedStaff.id, pin:pinEntry})
      });
      const data = await res.json();
      if(res.ok){
        state.me = { staffName: data.staffName, role: data.role };
        document.getElementById("login").style.display="none";
        document.getElementById("app").style.display="block";
        pinEntry="";
        await initApp();
      } else {
        errEl.textContent = data.error || "Incorrect PIN. Try again.";
        setTimeout(()=>{ pinEntry=""; renderDots(); },400);
      }
    }catch(e){
      errEl.textContent = "Couldn't reach the server. Check the app is running.";
      setTimeout(()=>{ pinEntry=""; renderDots(); },600);
    }
  }
}
async function showLogin(){
  document.getElementById("app").style.display="none";
  document.getElementById("login").style.display="flex";
  appInited = false;
  pinEntry=""; selectedStaff=null;
  await initLogin();
}

/* ============================================================
   APP INIT (post-login)
   ============================================================ */
let appInited = false;
async function initApp(){
  state.settings = await api("GET","/settings");
  document.title = state.settings.business_name + " — Shop Manager";
  document.getElementById("avatar-btn").textContent = initials(state.settings.business_name);

  if(appInited){ await renderAll(); return; }
  appInited = true;

  // Marks #screen-home "active" (every .screen starts display:none in CSS
  // until switchTab does this) — without it, a fresh login renders a blank
  // Home screen until the user happens to tap a nav tab themselves.
  document.getElementById("screen-home").classList.add("active");
  document.getElementById("hdr-main").textContent = greeting();
  document.getElementById("hdr-sub").textContent = isOwner()?"Owner Dashboard":"Staff Dashboard";
  document.getElementById("avatar-btn").addEventListener("click", openSettings);
  document.getElementById("refresh-btn").addEventListener("click", async ()=>{ await renderAll(); toast("Refreshed", "ok"); });

  document.querySelectorAll("nav.bottom .tab").forEach(tab=>{
    tab.addEventListener("click", ()=>switchTab(tab.dataset.tab));
  });
  document.querySelectorAll("[data-goto]").forEach(el=>{
    el.addEventListener("click", ()=>switchTab(el.dataset.goto));
  });
  document.querySelectorAll("[data-inv-location-goto]").forEach(el=>{
    el.addEventListener("click", async ()=>{
      state.invLocationCode = el.dataset.invLocationGoto;
      await switchTab("inventory");
    });
  });
  document.getElementById("qa-payment").addEventListener("click", openQuickPayment);
  document.getElementById("wa-fab-btn").addEventListener("click", ()=>openWhatsApp());

  document.querySelectorAll("[data-close-fs]").forEach(b=>{
    b.addEventListener("click", ()=>closeFullscreen(b.dataset.closeFs));
  });

  document.getElementById("billing-search").addEventListener("input", renderBillingProducts);
  document.getElementById("billing-customer-search").addEventListener("input", renderBillingCustomers);
  document.querySelectorAll('[data-disc]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.discountType = b.dataset.disc;
      document.querySelectorAll('[data-disc]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderTotals();
    });
  });
  document.querySelectorAll('[data-gsttype]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.taxTypeOverride = b.dataset.gsttype;
      renderGstTypeChips();
      renderTotals();
    });
  });
  document.querySelectorAll('[data-gstenabled]').forEach(b=>{
    b.addEventListener("click", ()=>{
      setGstEnabled(b.dataset.gstenabled === "true");
    });
  });
  document.getElementById("discount-value").addEventListener("input", (e)=>{
    state.discountValue = parseFloat(e.target.value)||0; renderTotals();
  });
  document.getElementById("advance-input").addEventListener("input", (e)=>{
    state.advance = parseFloat(e.target.value)||0; renderTotals();
  });
  document.getElementById("transport-input").addEventListener("input", (e)=>{
    state.transport = Math.max(0, parseFloat(e.target.value)||0); renderTotals();
  });
  document.getElementById("loading-input").addEventListener("input", (e)=>{
    state.loading = Math.max(0, parseFloat(e.target.value)||0); renderTotals();
  });
  document.getElementById("roundoff-toggle").addEventListener("change", (e)=>{
    state.roundOff = e.target.checked; renderTotals();
  });
  document.getElementById("delivery-man-input").addEventListener("input", (e)=>{
    state.deliveryMan = e.target.value;
  });
  document.getElementById("vehicle-number-input").addEventListener("input", (e)=>{
    state.vehicleNumber = e.target.value;
  });
  document.getElementById("delivery-address-input").addEventListener("input", (e)=>{
    state.deliveryAddress = e.target.value;
  });
  document.getElementById("remarks-input").addEventListener("input", (e)=>{
    state.remarks = e.target.value;
  });
  document.getElementById("gst-on-charges-toggle").addEventListener("change", (e)=>{
    state.gstOnCharges = e.target.checked; renderTotals();
  });
  document.querySelectorAll('[data-pay]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.paymentMethod = b.dataset.pay;
      document.querySelectorAll('[data-pay]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
    });
  });
  document.querySelectorAll('[data-doctype]').forEach(b=>{
    b.addEventListener("click", ()=>setDocType(b.dataset.doctype));
  });
  document.getElementById("complete-sale-btn").addEventListener("click", completeSale);
  document.getElementById("preview-invoice-btn").addEventListener("click", ()=>openInvoicePreview(null));

  document.getElementById("inv-search").addEventListener("input", renderInventoryList);
  document.getElementById("inv-add-btn").addEventListener("click", ()=>openAddProduct("inventory"));
  document.querySelectorAll('[data-inv-stock-filter]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.invStockFilter = b.dataset.invStockFilter;
      document.querySelectorAll('[data-inv-stock-filter]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderInventoryList();
    });
  });

  document.getElementById("cust-search").addEventListener("input", renderCustomersList);
  document.getElementById("cust-add-btn").addEventListener("click", ()=>{
    if(state.partyMode==="supplier") openAddSupplier(); else openAddCustomer();
  });
  document.querySelectorAll('[data-party-mode]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.partyMode = b.dataset.partyMode;
      document.querySelectorAll('[data-party-mode]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      document.getElementById("cust-search").value = "";
      renderCustomersList();
    });
  });

  document.querySelectorAll('[data-report]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.reportType = b.dataset.report;
      document.querySelectorAll('[data-report]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderReport();
    });
  });
  document.getElementById("export-csv-btn").addEventListener("click", ()=>{
    window.open("/api/reports/export?type="+encodeURIComponent(state.reportType), "_blank");
  });

  document.getElementById("cb-add-in").addEventListener("click", ()=>openCashEntry("in"));
  document.getElementById("cb-add-out").addEventListener("click", ()=>openCashEntry("out"));
  document.getElementById("cb-filter-from").addEventListener("change", (e)=>{ state.cbFrom = e.target.value; renderCashBook(); });
  document.getElementById("cb-filter-to").addEventListener("change", (e)=>{ state.cbTo = e.target.value; renderCashBook(); });
  document.getElementById("cb-filter-today").addEventListener("click", ()=>{
    const t = todayISO(); state.cbFrom = t; state.cbTo = t; renderCashBook();
  });
  document.getElementById("cb-filter-clear").addEventListener("click", ()=>{
    state.cbFrom = ""; state.cbTo = ""; renderCashBook();
  });
  document.getElementById("cb-print-btn").addEventListener("click", printCashBook);
  document.getElementById("cb-export-btn").addEventListener("click", ()=>{
    const q = cashBookQuery();
    window.open("/api/cashbook/export" + (q?"?"+q:""), "_blank");
  });

  document.getElementById("bb-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
  document.getElementById("bb-manage-accounts-link").addEventListener("click", (e)=>{ e.preventDefault(); openManageBankAccounts(); });
  document.getElementById("bb-add-entry").addEventListener("click", ()=>openBankEntry());
  document.getElementById("bb-filter-from").addEventListener("change", (e)=>{ state.bbFrom = e.target.value; renderBankBook(); });
  document.getElementById("bb-filter-to").addEventListener("change", (e)=>{ state.bbTo = e.target.value; renderBankBook(); });
  document.getElementById("bb-filter-today").addEventListener("click", ()=>{
    const t = todayISO(); state.bbFrom = t; state.bbTo = t; renderBankBook();
  });
  document.getElementById("bb-filter-clear").addEventListener("click", ()=>{
    state.bbFrom = ""; state.bbTo = ""; renderBankBook();
  });
  document.getElementById("bb-print-btn").addEventListener("click", printBankBook);
  document.getElementById("bb-export-btn").addEventListener("click", ()=>{
    const q = bankBookQuery();
    window.open("/api/bankbook/export" + (q?"?"+q:""), "_blank");
  });

  document.getElementById("inq-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
  document.getElementById("inq-add-btn").addEventListener("click", ()=>openInquiry());

  document.getElementById("pur-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
  document.getElementById("pur-clear-link").addEventListener("click", (e)=>{ e.preventDefault(); clearPurchaseForm(); });
  document.querySelectorAll('[data-pur-doctype]').forEach(b=>{
    b.addEventListener("click", ()=>setPurDocType(b.dataset.purDoctype));
  });
  document.getElementById("pur-supplier-search").addEventListener("input", renderPurchaseSuppliers);
  document.getElementById("pur-search").addEventListener("input", renderPurchaseProducts);
  document.getElementById("pur-date").addEventListener("change", (e)=>{ state.pur.date = e.target.value; });
  document.getElementById("pur-invoice-no").addEventListener("input", (e)=>{ state.pur.invoiceNo = e.target.value; });
  document.getElementById("pur-due-date").addEventListener("change", (e)=>{ state.pur.dueDate = e.target.value; });
  document.getElementById("pur-vehicle").addEventListener("input", (e)=>{ state.pur.vehicleNumber = e.target.value; });
  document.getElementById("pur-transport-name").addEventListener("input", (e)=>{ state.pur.transportName = e.target.value; });
  document.getElementById("pur-lr").addEventListener("input", (e)=>{ state.pur.lrNumber = e.target.value; });
  document.getElementById("pur-remarks").addEventListener("input", (e)=>{ state.pur.remarks = e.target.value; });
  document.querySelectorAll('[data-pur-type]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.pur.purchaseType = b.dataset.purType;
      document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderPurchaseTotals();
    });
  });
  document.querySelectorAll('[data-pur-gstenabled]').forEach(b=>{
    b.addEventListener("click", ()=>{
      setPurGstEnabled(b.dataset.purGstenabled === "true");
    });
  });
  document.querySelectorAll('[data-pur-pay]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.pur.paymentMethod = b.dataset.purPay;
      document.querySelectorAll('[data-pur-pay]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderPurchaseDueDateVisibility();
    });
  });
  document.getElementById("pur-transport-input").addEventListener("input", (e)=>{
    state.pur.transport = Math.max(0, parseFloat(e.target.value)||0); renderPurchaseTotals();
  });
  document.getElementById("pur-loading-input").addEventListener("input", (e)=>{
    state.pur.loading = Math.max(0, parseFloat(e.target.value)||0); renderPurchaseTotals();
  });
  document.getElementById("pur-other-input").addEventListener("input", (e)=>{
    state.pur.otherCharges = Math.max(0, parseFloat(e.target.value)||0); renderPurchaseTotals();
  });
  document.getElementById("pur-roundoff-toggle").addEventListener("change", (e)=>{
    state.pur.roundOff = e.target.checked; renderPurchaseTotals();
  });
  document.getElementById("pur-save-btn").addEventListener("click", savePurchase);

  document.getElementById("po-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
  document.getElementById("po-supplier-search").addEventListener("input", renderPoSuppliers);
  document.getElementById("po-search").addEventListener("input", renderPoProducts);
  document.getElementById("po-date").addEventListener("change", (e)=>{ state.po.date = e.target.value; });
  document.getElementById("po-expected-date").addEventListener("change", (e)=>{ state.po.expectedDeliveryDate = e.target.value; });
  document.getElementById("po-delivery-address").addEventListener("input", (e)=>{ state.po.deliveryAddress = e.target.value; });
  document.getElementById("po-payment-terms").addEventListener("input", (e)=>{ state.po.paymentTerms = e.target.value; });
  document.getElementById("po-delivery-terms").addEventListener("input", (e)=>{ state.po.deliveryTerms = e.target.value; });
  document.getElementById("po-remarks").addEventListener("input", (e)=>{ state.po.remarks = e.target.value; });
  document.querySelectorAll('[data-po-type]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.po.purchaseType = b.dataset.poType;
      document.querySelectorAll('[data-po-type]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderPoTotals();
    });
  });
  document.getElementById("po-freight-input").addEventListener("input", (e)=>{
    state.po.freight = Math.max(0, parseFloat(e.target.value)||0); renderPoTotals();
  });
  document.getElementById("po-other-input").addEventListener("input", (e)=>{
    state.po.otherCharges = Math.max(0, parseFloat(e.target.value)||0); renderPoTotals();
  });
  document.getElementById("po-roundoff-toggle").addEventListener("change", (e)=>{
    state.po.roundOff = e.target.checked; renderPoTotals();
  });
  document.getElementById("po-save-btn").addEventListener("click", ()=>savePo(false));
  document.getElementById("po-save-draft-btn").addEventListener("click", ()=>savePo(true));

  document.getElementById("quotation-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
  document.getElementById("quotation-customer-search").addEventListener("input", renderQuotationCustomers);
  document.getElementById("quotation-search").addEventListener("input", renderQuotationProducts);
  document.getElementById("quotation-date").addEventListener("change", (e)=>{ state.quotation.date = e.target.value; });
  document.getElementById("quotation-valid-until").addEventListener("change", (e)=>{ state.quotation.validUntil = e.target.value; });
  document.getElementById("quotation-terms").addEventListener("input", (e)=>{ state.quotation.terms = e.target.value; });
  document.getElementById("quotation-remarks").addEventListener("input", (e)=>{ state.quotation.remarks = e.target.value; });
  document.querySelectorAll('[data-quotation-type]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.quotation.saleType = b.dataset.quotationType;
      document.querySelectorAll('[data-quotation-type]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderQuotationTotals();
    });
  });
  document.querySelectorAll('[data-quotation-disc-type]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.quotation.discountType = b.dataset.quotationDiscType;
      document.querySelectorAll('[data-quotation-disc-type]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderQuotationTotals();
    });
  });
  document.getElementById("quotation-disc-value").addEventListener("input", (e)=>{
    state.quotation.discountValue = Math.max(0, parseFloat(e.target.value)||0); renderQuotationTotals();
  });
  document.getElementById("quotation-transport-input").addEventListener("input", (e)=>{
    state.quotation.transport = Math.max(0, parseFloat(e.target.value)||0); renderQuotationTotals();
  });
  document.getElementById("quotation-loading-input").addEventListener("input", (e)=>{
    state.quotation.loading = Math.max(0, parseFloat(e.target.value)||0); renderQuotationTotals();
  });
  document.getElementById("quotation-gst-on-charges-toggle").addEventListener("change", (e)=>{
    state.quotation.gstOnCharges = e.target.checked; renderQuotationTotals();
  });
  document.getElementById("quotation-roundoff-toggle").addEventListener("change", (e)=>{
    state.quotation.roundOff = e.target.checked; renderQuotationTotals();
  });
  document.getElementById("quotation-save-btn").addEventListener("click", ()=>saveQuotation(false));
  document.getElementById("quotation-save-draft-btn").addEventListener("click", ()=>saveQuotation(true));

  document.getElementById("so-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
  document.getElementById("so-customer-search").addEventListener("input", renderSoCustomers);
  document.getElementById("so-search").addEventListener("input", renderSoProducts);
  document.getElementById("so-date").addEventListener("change", (e)=>{ state.so.date = e.target.value; });
  document.getElementById("so-expected-date").addEventListener("change", (e)=>{ state.so.expectedDeliveryDate = e.target.value; });
  document.getElementById("so-delivery-address").addEventListener("input", (e)=>{ state.so.deliveryAddress = e.target.value; });
  document.getElementById("so-remarks").addEventListener("input", (e)=>{ state.so.remarks = e.target.value; });
  document.querySelectorAll('[data-so-type]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.so.saleType = b.dataset.soType;
      document.querySelectorAll('[data-so-type]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderSoTotals();
    });
  });
  document.querySelectorAll('[data-so-disc-type]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.so.discountType = b.dataset.soDiscType;
      document.querySelectorAll('[data-so-disc-type]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      renderSoTotals();
    });
  });
  document.getElementById("so-disc-value").addEventListener("input", (e)=>{
    state.so.discountValue = Math.max(0, parseFloat(e.target.value)||0); renderSoTotals();
  });
  document.getElementById("so-transport-input").addEventListener("input", (e)=>{
    state.so.transport = Math.max(0, parseFloat(e.target.value)||0); renderSoTotals();
  });
  document.getElementById("so-loading-input").addEventListener("input", (e)=>{
    state.so.loading = Math.max(0, parseFloat(e.target.value)||0); renderSoTotals();
  });
  document.getElementById("so-gst-on-charges-toggle").addEventListener("change", (e)=>{
    state.so.gstOnCharges = e.target.checked; renderSoTotals();
  });
  document.getElementById("so-roundoff-toggle").addEventListener("change", (e)=>{
    state.so.roundOff = e.target.checked; renderSoTotals();
  });
  document.getElementById("so-save-btn").addEventListener("click", ()=>saveSo(false));
  document.getElementById("so-save-draft-btn").addEventListener("click", ()=>saveSo(true));

  document.getElementById("scrim").addEventListener("click", closeAllSheets);

  document.getElementById("paper-a5").addEventListener("click", ()=>setPaper("A5"));
  document.getElementById("paper-a4").addEventListener("click", ()=>setPaper("A4"));
  document.getElementById("inv-download").addEventListener("click", downloadInvoicePdf);
  document.getElementById("inv-print").addEventListener("click", ()=>window.print());
  document.getElementById("inv-whatsapp-pdf").addEventListener("click", shareInvoicePdfWhatsApp);
  document.getElementById("inv-server-print").addEventListener("click", printViaServer);

  await renderAll();
}
function greeting(){
  const h = new Date().getHours();
  if(h<12) return "Good Morning";
  if(h<17) return "Good Afternoon";
  return "Good Evening";
}
async function switchTab(tab){
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  document.getElementById("screen-"+tab).classList.add("active");
  document.querySelectorAll("nav.bottom .tab").forEach(t=>t.classList.toggle("active", t.dataset.tab===tab));
  const subMap = {home:(isOwner()?"Owner Dashboard":"Staff Dashboard"),billing:"Create Invoice",inventory:"Inventory",customers:"Customers",reports:"Reports",cashbook:"Cash Book",bankbook:"Bank Book",inquiries:"Customer Inquiry Book",purchase:"New Purchase",po:"Purchase Order",quotation:"Quotation",so:"Sales Order"};
  document.getElementById("hdr-sub").textContent = subMap[tab];
  document.getElementById("hdr-main").textContent = tab==="home" ? greeting() : subMap[tab];
  if(tab==="billing") await renderBilling();
  if(tab==="inventory") await renderInventoryList();
  if(tab==="customers") await renderCustomersList();
  if(tab==="reports") await renderReport();
  if(tab==="cashbook") await renderCashBook();
  if(tab==="bankbook") await renderBankBook();
  if(tab==="inquiries") await renderInquiries();
  if(tab==="purchase") await renderPurchaseScreen();
  if(tab==="po") await renderPoScreen();
  if(tab==="quotation") await renderQuotationScreen();
  if(tab==="so") await renderSoScreen();
}

async function renderAll(){
  await Promise.all([loadProducts(), loadCustomers(), loadSuppliers(), loadLocations(), loadBankAccounts(), loadStaffNames()]);
  await renderHome();
  const activeTab = document.querySelector("nav.bottom .tab.active");
  const tab = activeTab ? activeTab.dataset.tab : "home";
  if(tab==="billing") await renderBilling();
  if(tab==="inventory") await renderInventoryList();
  if(tab==="customers") await renderCustomersList();
  if(tab==="reports") await renderReport();
}
async function loadProducts(){ state.products = await api("GET","/products"); }
async function loadCustomers(){ state.customers = await api("GET","/customers"); }
async function loadSuppliers(){ state.suppliers = await api("GET","/suppliers"); }
async function loadLocations(){ state.locations = await api("GET","/locations"); }
async function loadBankAccounts(){ state.bankAccounts = await api("GET","/bank-accounts"); }
// Public regardless of login flow (the login screen's own staffList variable
// isn't guaranteed populated when boot() resumes an existing session without
// ever showing the PIN screen), so the Inquiry Book's salesperson picker
// fetches its own copy here instead of relying on that one.
async function loadStaffNames(){ state.staffNames = await api("GET","/auth/staff-list").catch(()=>[]); }

/* ============================================================
   HOME
   ============================================================ */
async function renderHome(){
  let d;
  try{ d = await api("GET","/reports/dashboard"); } catch(e){ toast(e.message); return; }
  state.dashboard = d;

  document.getElementById("stat-sales").textContent = fmt(d.todaysSales);
  document.getElementById("stat-profit").textContent = fmt(d.todaysProfit);
  document.getElementById("stat-outstanding").textContent = fmt(d.outstandingTotal) + (d.outstandingCount? " · "+d.outstandingCount+" cust.":"");
  document.getElementById("stat-payable").textContent = fmt(d.payableTotal) + (d.payableCount? " · "+d.payableCount+" supp.":"");
  document.getElementById("stat-cash").textContent = fmt(d.cashBalance);
  document.getElementById("stat-bank").textContent = fmt(d.bankBalance);
  document.getElementById("stat-lowstock").textContent = d.lowStockCount;

  const max = Math.max(1, ...d.revenueChart.map(x=>x.total));
  document.getElementById("revenue-chart").innerHTML = d.revenueChart.map(x=>`
    <div class="bar-wrap">
      <div class="bar" style="height:${Math.max(4,(x.total/max)*100)}%;" title="${fmt(x.total)}"></div>
      <div class="bar-lbl">${x.label}</div>
    </div>`).join("");

  document.getElementById("best-sellers").innerHTML = d.bestSellers.length ? d.bestSellers.map(v=>`
    <div class="list-row"><div><div class="row-title">${escapeHtml(v.name)}</div><div class="row-sub">${v.units} units sold</div></div>
    <div class="row-right row-title">${fmt(v.revenue)}</div></div>`).join("")
    : `<div class="empty-hint">No sales yet — complete an invoice to see best sellers.</div>`;

  document.getElementById("top-customers").innerHTML = d.topCustomers.filter(c=>c.total>0).length ? d.topCustomers.filter(c=>c.total>0).map(c=>`
    <div class="list-row"><div class="avatar" style="width:32px;height:32px;font-size:11px;">${initials(c.name)}</div>
    <div><div class="row-title">${escapeHtml(c.name)}</div><div class="row-sub">${escapeHtml(c.type||"")}</div></div>
    <div class="row-right row-title">${fmt(c.total)}</div></div>`).join("") : `<div class="empty-hint">No customer purchases yet.</div>`;

  document.getElementById("recent-invoices").innerHTML = d.recentInvoices.length ? d.recentInvoices.map(inv=>{
    // A challan carries no money, so it shows a "Challan" tag and no amount
    // rather than a misleading ₹0 / Paid pill.
    const challan = inv.doc_type === "challan";
    const status = challan ? "Challan" : (inv.balance_due<=0 ? "Paid" : (inv.advance>0 ? "Partial":"Due"));
    const cls = challan ? "" : (status==="Paid"?"ok":status==="Partial"?"warn":"danger");
    return `<div class="list-row" data-open-invoice="${inv.id}" style="cursor:pointer;"><div><div class="row-title">${inv.challan_no}</div><div class="row-sub">${escapeHtml(inv.customer_name||"Walk-in")} · ${inv.date}</div></div>
    <div class="row-right"><div class="row-title">${challan?"":fmt(inv.total)}</div><span class="pill ${cls}">${status}</span></div></div>`;
  }).join("") : `<div class="empty-hint">No invoices yet. Tap "New Invoice" to create your first one.</div>`;
  document.querySelectorAll("[data-open-invoice]").forEach(el=>{
    el.addEventListener("click", ()=>openExistingInvoice(el.dataset.openInvoice));
  });
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ============================================================
   BILLING
   ============================================================ */
async function renderBilling(){
  renderBillingCustomers();
  renderBillingLocationChips();
  renderBillingProducts();
  // Re-applies the document-type UI (which section is hidden, button labels)
  // and calls renderCart + renderTotals itself, so a challan-in-progress
  // survives any re-render and a fresh screen starts as a Tax Invoice.
  setDocType(state.docType);
}
function renderBillingCustomers(){
  const wrap = document.getElementById("billing-customers");
  const searchEl = document.getElementById("billing-customer-search");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  // The currently selected customer always stays visible even if a search
  // filters it out of view elsewhere — losing sight of who you're billing to
  // mid-search would be worse than a slightly redundant chip.
  const selected = state.customers.find(c=>c.id===state.selectedCustomerId);
  let list = state.customers;
  if(q) list = list.filter(c=>c.name.toLowerCase().includes(q) || (c.phone||"").includes(q));
  if(selected && !list.includes(selected)) list = [selected, ...list];

  const walkInChip = !q ? `<button class="chip ${!state.selectedCustomerId?'selected':''}" data-cust="">Walk-in</button>` : "";
  wrap.innerHTML = walkInChip + list.map(c=>`
    <button class="chip ${state.selectedCustomerId===c.id?'selected':''}" data-cust="${c.id}">${escapeHtml(c.name)}</button>
  `).join("") || `<div class="empty-hint" style="padding:8px 4px;">No customer matches "${escapeHtml(q)}".</div>`;

  wrap.querySelectorAll("[data-cust]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.selectedCustomerId=b.dataset.cust||null;
      // A new customer means a fresh GST Type default (their Customer Master
      // setting) — any override picked for the previous customer shouldn't
      // silently carry over.
      state.taxTypeOverride = null;
      renderBillingCustomers(); renderTotals();
    });
  });
}
/** A sale can only ever draw from Shop — this is that size's Shop-specific
 *  quantity, falling back to the cross-location total if byLocation wasn't
 *  loaded for some reason (defensive; shouldn't happen once locations exist). */
function sizeShopStock(size){
  const row = (size.byLocation||[]).find(l=>l.code==="shop");
  return row ? row.quantity : size.stock;
}
function sizeWarehouseStock(size){
  const row = (size.byLocation||[]).find(l=>l.code==="warehouse");
  return row ? row.quantity : 0;
}
/** Stock at whichever location Billing currently has selected to sell
 *  from — defaults to Shop until state.billingLocationId is set (right
 *  after locations load), matching every invoice's behaviour before this
 *  picker existed. */
function billingLocationStock(size){
  const loc = state.locations.find(l=>l.id===state.billingLocationId);
  if(!loc || loc.code==="shop") return sizeShopStock(size);
  const row = (size.byLocation||[]).find(l=>l.location_id===state.billingLocationId);
  return row ? row.quantity : 0;
}
function renderBillingLocationChips(){
  const wrap = document.getElementById("billing-location-chips");
  if(!wrap) return;
  if(!state.billingLocationId){
    const shop = state.locations.find(l=>l.code==="shop");
    if(shop) state.billingLocationId = shop.id;
  }
  wrap.innerHTML = state.locations.map(l=>`
    <button class="chip ${state.billingLocationId===l.id?'selected':''}" data-billing-location="${l.id}">${escapeHtml(l.name)}</button>
  `).join("");
  wrap.querySelectorAll("[data-billing-location]").forEach(b=>{
    b.addEventListener("click", ()=>{
      if(state.cart.length && b.dataset.billingLocation!==state.billingLocationId){
        if(!confirm("Change location? Items already added were checked against the OLD location's stock — you may need to re-check quantities.")) return;
      }
      state.billingLocationId = b.dataset.billingLocation;
      renderBillingLocationChips();
      renderBillingProducts();
    });
  });
}
function renderBillingProducts(){
  const q = (document.getElementById("billing-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("billing-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    // Billing deducts from whichever location is selected above (Sell from) —
    // both totals are shown regardless, purely for visibility, so staff can
    // see "0 in Shop, 20 in Warehouse" and know to switch or transfer first.
    const shopTotal = p.sizes.reduce((s,sz)=>s+sizeShopStock(sz),0);
    const warehouseTotal = p.sizes.reduce((s,sz)=>s+sizeWarehouseStock(sz),0);
    const sellableTotal = p.sizes.reduce((s,sz)=>s+billingLocationStock(sz),0);
    const out = sellableTotal<=0;
    const stockLine = `&#127978; Shop: ${shopTotal}${warehouseTotal>0?` · &#127974; Warehouse: ${warehouseTotal}`:""}`;
    return `<div class="list-row" data-open-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div><div class="row-sub">${stockLine}</div></div>
      <div class="row-right">${out?'<span class="pill danger">Out of stock</span>':'<button class="gold-fab" data-quickadd="'+p.id+'" style="width:30px;height:30px;">+</button>'}</div>
    </div>`;
  }).join("") || `<div class="empty-hint">No matching products.</div>`;

  wrap.querySelectorAll("[data-open-product]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest("[data-quickadd]")) return;
      openProductDetail(el.dataset.openProduct, "billing");
    });
  });
  wrap.querySelectorAll("[data-quickadd]").forEach(b=>{
    b.addEventListener("click", (e)=>{ e.stopPropagation(); openProductDetail(b.dataset.quickadd, "billing"); });
  });
}
/* A cart line mirrors what the server stores: geometry + pieces + rate, with
   the billed quantity always DERIVED (never typed), so the screen can't drift
   from the invoice. `pieces` is the physical count that leaves stock. */
function addToCart(productId, sizeIdx){
  const p = state.products.find(x=>x.id===productId);
  if(!p) return false;
  // A product with no size/price row can't be sold until a price is set. Guard
  // here so a bad product (e.g. one whose last size was removed in an edit)
  // toasts a clear fix instead of throwing on `size.price`.
  if(!p.sizes.length){ toast(`"${p.name}" has no price yet — open it and tap Edit to add one.`); return false; }
  const size = p.sizes[sizeIdx] || p.sizes[0];
  // Stock is tracked per SIZE — an "8x4" sheet and a "7x4" sheet are counted
  // separately, so the cap check and the identity of a cart line both key off
  // the specific size, not the product as a whole.
  const existing = state.cart.find(c=>c.sizeId===size.id);
  const piecesForSize = state.cart.filter(c=>c.sizeId===size.id).reduce((s,c)=>s+(c.pieces||0),0);
  if(piecesForSize >= billingLocationStock(size)){ return false; }
  if(existing){ existing.pieces += 1; }
  else{
    state.cart.push({
      productId, sizeId: size.id, sizeIdx,
      name: p.name + (p.sizes.length>1 ? " ("+size.label+")" : ""),
      // Pre-fill the size the product master was set up with — counter staff
      // shouldn't retype 8 × 4 on every sale — but leave every field editable.
      mode: Pricing.normaliseMode(p.default_mode),
      lengthFt: p.length_ft || "",
      widthVal: p.width_val || "",
      thicknessIn: p.thickness_in || "",
      pieces: 1,
      rate: size.price,
      gstRate: p.gst
    });
  }
  renderCart(); renderTotals();
  return true;
}

/**
 * Re-sync the open bill against the product master after an edit, duplicate or
 * delete, then recompute every total.
 *
 * The GST rate is pulled across unconditionally — tax correctness is not the
 * counter staff's call. The line RATE is deliberately left alone: it is
 * routinely negotiated per customer, and silently resetting a agreed price
 * because someone corrected the list price would be worse than a stale figure.
 * Lines whose product no longer exists are dropped, since the server would
 * reject the sale anyway.
 */
function refreshCartFromProducts(){
  const before = state.cart.length;
  state.cart = state.cart.filter(c=>{
    const p = state.products.find(x=>x.id===c.productId);
    if(!p) return false;
    // The specific size a line was billing might itself have been removed in
    // an edit even though the product survives — that line has nothing left
    // to price or deduct stock from.
    if(c.sizeId != null && !p.sizes.some(s=>s.id===c.sizeId)) return false;
    c.gstRate = p.gst;
    return true;
  });
  if(state.cart.length !== before){
    toast("Removed "+(before-state.cart.length)+" bill line(s) — that product or size was deleted.");
  }
  renderCart(); renderTotals();
}

/** True when the billing screen is composing a no-price delivery challan. */
function isChallanMode(){ return state.docType === "challan"; }

/**
 * Switch between Tax Invoice and Delivery Challan. A challan hides everything
 * price-related in one move (the #billing-pricing wrapper) and rewords the
 * action buttons, but leaves the item list — including sizes and quantities —
 * exactly as-is, since a challan still needs those.
 */
/**
 * "GST Invoice" vs "Non-GST Invoice" — a per-invoice toggle independent of
 * doc type. When off, the GST Type chips (CGST+SGST/IGST) and the "Apply GST
 * on Transport & Loading" checkbox are moot, so both hide along with them;
 * computeTotals()/renderTotals() do the actual skip of tax calculation.
 */
function setGstEnabled(on){
  state.gstEnabled = on;
  document.querySelectorAll('[data-gstenabled]').forEach(b=>
    b.classList.toggle("selected", (b.dataset.gstenabled === "true") === on));
  const gstTypeSection = document.getElementById("gst-type-section");
  if(gstTypeSection) gstTypeSection.style.display = on ? "" : "none";
  const gstChargesRow = document.getElementById("gst-on-charges-row");
  if(gstChargesRow) gstChargesRow.style.display = (on && !isChallanMode()) ? "flex" : "none";
  renderTotals();
}
function setDocType(type){
  state.docType = type === "challan" ? "challan" : "invoice";
  const challan = isChallanMode();
  document.querySelectorAll('[data-doctype]').forEach(b=>
    b.classList.toggle("selected", b.dataset.doctype === state.docType));
  const pricing = document.getElementById("billing-pricing");
  if(pricing) pricing.style.display = challan ? "none" : "";
  // Round-off and the GST-on-charges toggle only mean something against a
  // GST grand total — hide both for a challan, but Transport & Loading stay
  // visible either way (see index.html).
  const roundoffRow = document.getElementById("roundoff-toggle-row");
  if(roundoffRow) roundoffRow.style.display = challan ? "none" : "flex";
  const gstChargesRow = document.getElementById("gst-on-charges-row");
  if(gstChargesRow) gstChargesRow.style.display = (challan || !state.gstEnabled) ? "none" : "flex";
  const note = document.getElementById("challan-note");
  if(note) note.style.display = challan ? "block" : "none";
  const itemsTitle = document.getElementById("items-title");
  if(itemsTitle) itemsTitle.textContent = challan ? "Challan items" : "Invoice items";
  const completeBtn = document.getElementById("complete-sale-btn");
  if(completeBtn) completeBtn.textContent = state.editingInvoiceId
    ? (challan ? "Update Delivery Challan" : "Update Invoice")
    : (challan ? "Create Delivery Challan" : "Complete Sale & Update Stock");
  const previewBtn = document.getElementById("preview-invoice-btn");
  if(previewBtn) previewBtn.textContent = challan ? "Preview / Print Challan" : "Preview / Print Invoice";
  // Which document TYPE this is can't change once saved — the number series
  // and print banner are fixed at creation — so lock the toggle while editing.
  const toggleWrap = document.getElementById("doctype-toggle");
  if(toggleWrap) toggleWrap.style.pointerEvents = state.editingInvoiceId ? "none" : "";
  if(toggleWrap) toggleWrap.style.opacity = state.editingInvoiceId ? "0.55" : "";
  renderCart();
  renderTotals();
  renderBillingNumber();
}
/**
 * Shows the number THIS document will get before it's saved. Editing an
 * existing invoice/challan already knows its real number (set by
 * editExistingInvoice via state.docNo); a brand-new one asks the server for
 * a live peek at the next number in the CURRENT doc type's series (see GET
 * /invoices/next-number) — switching Tax Invoice <-> Delivery Challan
 * re-peeks since each doc type has its own independent counter.
 */
async function renderBillingNumber(){
  const el = document.getElementById("billing-number-display");
  const label = document.getElementById("billing-number-label");
  if(!el) return;
  const challan = isChallanMode();
  if(label) label.textContent = challan ? "Challan No." : "Estimate No.";
  if(state.editingInvoiceId && state.docNo){
    el.textContent = state.docNo;
    return;
  }
  el.textContent = "…";
  try{
    const { challanNo } = await api("GET", `/invoices/next-number?docType=${state.docType}`);
    state.docNo = challanNo;
    el.textContent = challanNo;
  }catch{
    el.textContent = "—";
  }
}

/** Small dismissible banner shown atop Billing while an existing document is being edited. */
function renderEditModeBanner(){
  const el = document.getElementById("edit-mode-banner");
  if(!el) return;
  if(!state.editingInvoiceId){ el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="card" style="background:var(--warn-bg);border-color:var(--warn-text);margin-bottom:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="font-size:12px;font-weight:700;color:var(--warn-text);">✎ Editing an existing document — Complete Sale below will UPDATE it, not create a new one.</div>
      <a href="#" id="cancel-edit-link" style="font-size:12px;font-weight:800;color:var(--warn-text);white-space:nowrap;">Cancel</a>
    </div>
  `;
  document.getElementById("cancel-edit-link").addEventListener("click", (e)=>{
    e.preventDefault();
    state.editingInvoiceId = null;
    state.docNo = null;
    state.cart = []; state.selectedCustomerId = null; state.taxTypeOverride = null; state.advance = 0; state.discountValue = 0;
    state.transport = 0; state.loading = 0; state.deliveryMan = "";
    state.vehicleNumber = ""; state.deliveryAddress = ""; state.remarks = ""; state.gstEnabled = true;
    const set = (id, val) => { const inp=document.getElementById(id); if(inp) inp.value = val; };
    set("advance-input", 0); set("discount-value", 0); set("transport-input", 0); set("loading-input", 0);
    set("delivery-man-input", ""); set("vehicle-number-input", ""); set("delivery-address-input", ""); set("remarks-input", "");
    setGstEnabled(true);
    renderEditModeBanner();
    renderBilling();
    toast("Edit cancelled.");
  });
}

/**
 * Loads a saved (non-voided) invoice/challan's items and settings back into
 * the Billing screen for editing. Saving from here PUTs to the same
 * document instead of creating a new one — see completeSale().
 */
async function editExistingInvoice(inv){
  if(inv.voided){ toast("A voided document can't be edited."); return; }
  await Promise.all([loadProducts(), loadCustomers()]);
  state.cart = inv.items.map(it=>{
    const product = state.products.find(p=>p.id===it.product_id);
    const sizeIdx = product ? product.sizes.findIndex(s=>s.id===it.size_id) : -1;
    return {
      productId: it.product_id, sizeId: it.size_id, sizeIdx: sizeIdx>=0 ? sizeIdx : 0,
      name: it.name, mode: it.mode, lengthFt: it.length_ft||"", widthVal: it.width_val||"",
      thicknessIn: it.thickness_in||"", pieces: it.pieces, rate: it.rate, gstRate: it.gst_rate
    };
  });
  state.selectedCustomerId = inv.customer_id || null;
  // Reflect what's actually stored on THIS invoice, not the customer's
  // possibly-since-changed Customer Master default — editing shouldn't
  // silently re-derive a different tax type than what was billed.
  state.taxTypeOverride = inv.tax_type === "IGST" ? "IGST" : "CGST_SGST";
  state.docType = inv.doc_type;
  state.docNo = inv.challan_no;
  state.discountType = inv.discount_type || "pct";
  state.discountValue = inv.discount_value || 0;
  state.advance = 0; // the original advance was already applied at creation time
  state.paymentMethod = inv.payment_method || "Cash";
  state.paperSize = inv.paper_size || "A5";
  state.transport = inv.transport || 0;
  state.loading = inv.loading || 0;
  state.gstOnCharges = inv.gst_on_charges !== 0;
  state.gstEnabled = inv.gst_enabled !== 0;
  state.deliveryMan = inv.delivery_man || "";
  state.vehicleNumber = inv.vehicle_number || "";
  state.deliveryAddress = inv.delivery_address || "";
  state.remarks = inv.remarks || "";
  state.editingInvoiceId = inv.id;
  // Reflect what this invoice actually deducted from, not whatever was last
  // selected on the Billing screen — falls back to Shop for a document saved
  // before this picker existed.
  state.billingLocationId = inv.location_id || (state.locations.find(l=>l.code==="shop")||{}).id;

  closeAllSheets();
  closeFullscreen("fs-invoice");
  switchTab("billing");
  await renderBilling();

  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set("discount-value", state.discountValue);
  set("advance-input", 0);
  set("transport-input", state.transport);
  set("loading-input", state.loading);
  set("delivery-man-input", state.deliveryMan);
  set("vehicle-number-input", state.vehicleNumber);
  set("delivery-address-input", state.deliveryAddress);
  set("remarks-input", state.remarks);
  document.querySelectorAll('[data-disc]').forEach(b=>b.classList.toggle("selected", b.dataset.disc===state.discountType));
  const gstChargesToggle = document.getElementById("gst-on-charges-toggle");
  if(gstChargesToggle) gstChargesToggle.checked = state.gstOnCharges;
  setGstEnabled(state.gstEnabled);
  renderEditModeBanner();
  renderTotals();
  toast(`Editing ${inv.challan_no} — make your changes, then save.`, "ok");
}

/** Live figures for a cart line, straight from the shared pricing module. */
function lineCalc(c){
  return Pricing.computeLine({
    mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
    thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate
  });
}
function renderCart(){
  const wrap = document.getElementById("cart-list");
  if(!state.cart.length){
    wrap.innerHTML = `<div class="empty-hint">No items yet. Add products above.</div>`;
    return;
  }
  wrap.innerHTML = state.cart.map((c,idx)=>{
    const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
    const r = lineCalc(c);
    const cartProduct = state.products.find(p=>p.id===c.productId);
    const cartSize = cartProduct && cartProduct.sizes.find(s=>s.id===c.sizeId);
    const stock = cartSize ? cartSize.stock : undefined;

    // Only the dimensions this mode actually uses are shown. Rft has no width,
    // and only CFT asks for thickness — showing dead inputs invites wrong data.
    const dim = (label, unit, key, val) => `
      <label class="dim">
        <span>${label}${unit?` <em>(${unit})</em>`:""}</span>
        <input type="number" inputmode="decimal" step="any" min="0"
               value="${val===0||val?val:""}" data-line-field="${key}" data-line="${idx}" placeholder="0">
      </label>`;

    return `<div class="bill-line" data-line-row="${idx}">
      <div class="bill-line-head">
        <div class="bill-line-name">${escapeHtml(c.name)}</div>
        <div class="line-actions">
          <a href="#" data-dup="${idx}">Duplicate</a>
          <a href="#" data-remove="${idx}" class="btn-danger-link">Remove</a>
        </div>
      </div>

      <div class="mode-row">
        ${Pricing.MODE_KEYS.map(k=>`
          <button class="chip sm ${k===m.key?'selected':''}" data-line-mode="${k}" data-line="${idx}"
                  title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>
        `).join("")}
      </div>

      <div class="dim-grid">
        ${m.needsThickness ? dim("Thickness", m.thicknessUnit, "thicknessIn", c.thicknessIn) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", c.lengthFt) : ""}
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", c.widthVal) : ""}
        ${dim("Qty", "pcs", "pieces", c.pieces)}
        ${dim("Rate", "₹/"+m.unit+(isChallanMode()?" · optional":""), "rate", c.rate)}
      </div>

      <div class="line-calc">
        <div class="line-calc-formula">
          ${r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : ""}
          ${m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : ""}
          <strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>
          × ${Pricing.formatRate(r.rate, r.mode)}
        </div>
        <div class="line-calc-amount">${fmtPaise(r.amount)}</div>
      </div>
      ${stock!==undefined && r.pieces>stock
        ? `<div class="line-warn">Only ${stock} in stock — this line needs ${r.pieces}.</div>` : ""}
    </div>`;
  }).join("");

  // Switching unit re-prices the line rather than silently changing the amount:
  // Sq.ft <-> Sq.m carries the rate across so the customer pays the same.
  wrap.querySelectorAll("[data-line-mode]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.cart[b.dataset.line];
    const next = b.dataset.lineMode;
    if(c.mode === next) return;
    // Sq.ft <-> Sq.m carries the rate across so the customer pays the same.
    // Any other switch measures a different thing entirely (₹322/Sq.m is not
    // ₹322/CFT), so the rate is CLEARED rather than silently reused — a blank
    // box and a ₹0.00 line are obvious; a plausible-looking wrong rate is not.
    c.rate = Pricing.isRateConvertible(c.mode, next)
      ? Pricing.convertLineRate({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
                                 thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate}, next)
      : "";
    c.mode = next;
    renderCart(); renderTotals();
  }));

  wrap.querySelectorAll("[data-line-field]").forEach(inp=>{
    // `input` (not `change`) so every totals figure updates as it is typed.
    inp.addEventListener("input", ()=>{
      const c = state.cart[inp.dataset.line];
      const v = inp.value === "" ? "" : Math.max(0, parseFloat(inp.value)||0);
      c[inp.dataset.lineField] = v;
      renderLineCalc(inp.dataset.line);
      renderTotals();
    });
    // Re-render fully on blur so cleared fields settle back to a real number.
    inp.addEventListener("blur", ()=>{ renderCart(); renderTotals(); });
  });

  // Duplicating a line is the quickest route to "same board, other size" — the
  // copy is inserted directly beneath so the two stay side by side for editing.
  wrap.querySelectorAll("[data-dup]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault();
    const i = Number(a.dataset.dup);
    state.cart.splice(i+1, 0, Object.assign({}, state.cart[i]));
    renderCart(); renderTotals();
  }));

  wrap.querySelectorAll("[data-remove]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault(); state.cart.splice(a.dataset.remove,1); renderCart(); renderTotals();
  }));
}

/* Repaint just one line's derived figures while typing. Re-rendering the whole
   cart on every keystroke would tear the focused input out from under the
   caret, so the inputs are deliberately left untouched here. */
function renderLineCalc(idx){
  const row = document.querySelector(`[data-line-row="${idx}"]`);
  if(!row) return;
  const c = state.cart[idx];
  const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
  const r = lineCalc(c);
  const f = row.querySelector(".line-calc-formula");
  const a = row.querySelector(".line-calc-amount");
  if(f) f.innerHTML =
    (r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : "") +
    (m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : "") +
    `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>` +
    ` × ${Pricing.formatRate(r.rate, r.mode)}`;
  if(a) a.textContent = fmtPaise(r.amount);
}
// GST Type defaults from the selected customer's Customer Master record, but
// staff can override it for just this one invoice via the GST Type chips in
// Billing (state.taxTypeOverride) without changing the customer's default.
function currentTaxType(){
  if(state.taxTypeOverride === "IGST" || state.taxTypeOverride === "CGST_SGST") return state.taxTypeOverride;
  const cust = state.customers.find(c=>c.id===state.selectedCustomerId);
  return (cust && cust.gst_type === "IGST") ? "IGST" : "CGST_SGST";
}
function renderGstTypeChips(){
  const wrap = document.getElementById("gst-type-chips");
  if(!wrap) return;
  const current = currentTaxType();
  wrap.querySelectorAll("[data-gsttype]").forEach(b=>{
    b.classList.toggle("selected", b.dataset.gsttype===current);
  });
}
/* Mirrors computeTotals() in server/routes/invoices.js exactly, including the
   order of rounding — the preview must match what the server will store. */
function computeTotals(){
  const lines = state.cart.map(lineCalc);
  const subtotal = round2(lines.reduce((s,r)=>s+r.amount,0));
  let discount = 0;
  if(state.discountType==="pct") discount = subtotal * (Math.min(100,Math.max(0,state.discountValue))/100);
  else discount = state.discountValue;
  discount = round2(Math.min(Math.max(0,discount), subtotal));

  const taxType = currentTaxType();
  // "Non-GST Invoice" (state.gstEnabled === false) skips tax entirely — no
  // goods tax, no ancillary tax, no CGST/SGST/IGST — mirrors
  // server/routes/invoices.js's computeTotals().
  let goodsTax = 0;
  if(state.gstEnabled){
    lines.forEach((r,i)=>{
      const share = subtotal>0 ? (r.amount/subtotal)*discount : 0;
      const taxable = Math.max(0, r.amount-share);
      goodsTax += taxable * ((state.cart[i].gstRate||18)/100);
    });
    goodsTax = round2(goodsTax);
  }

  // Whether Transport/Loading are taxed is a per-invoice toggle
  // (state.gstOnCharges). When on, they're taxed at the invoice's own
  // EFFECTIVE rate (goods tax ÷ taxable goods value) — there's no separate
  // GST% typed in for a freight charge. GST is computed LAST, once
  // transport/loading are known, mirroring server/routes/invoices.js exactly
  // so the preview and the saved invoice can never disagree.
  const transport = round2(Math.max(0, state.transport||0));
  const loading = round2(Math.max(0, state.loading||0));
  const taxableGoods = round2(subtotal - discount);
  const effectiveRate = taxableGoods>0 ? goodsTax/taxableGoods : 0;
  const ancillaryTax = (state.gstEnabled && state.gstOnCharges) ? round2((transport+loading) * effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst=0, sgst=0, igst=0;
  if(state.gstEnabled){
    if(taxType==="IGST") igst = totalTax; else { cgst = round2(totalTax/2); sgst = round2(totalTax-cgst); }
  }

  // Transport/loading now sit BEFORE GST — GST is the last line before the
  // grand total, computed on top of them rather than added after tax.
  const preRound = subtotal - discount + transport + loading + cgst + sgst + igst;
  const total = round2(state.roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  const advance = round2(Math.min(Math.max(0,state.advance||0), total));
  const balanceDue = round2(total - advance);

  // Effective rate for display only (e.g. "CGST (9%)") — a weighted average
  // of whatever the cart's items actually carry, same as the printed invoice,
  // not hardcoded to 18% (a mixed-rate cart still shows its true rate here).
  // Before anything's in the cart there's nothing to average, so show the
  // shop's standard 18% instead of a misleading "(0%)".
  const effectiveRatePct = taxableGoods>0 ? Math.round(effectiveRate*100) : 18;

  return {subtotal, discount, taxType, cgst, sgst, igst, transport, loading,
          roundOffAmount, total, advance, balanceDue, taxableGoods, effectiveRatePct};
}
function renderTotals(){
  renderGstTypeChips();
  const t = computeTotals();
  const halfRatePct = Math.round(t.effectiveRatePct/2);
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;

  // A challan hides the GST totals card entirely, so Transport & Loading need
  // their own small total here — the only "money" a challan carries.
  const challanTotalBox = document.getElementById("challan-charge-total");
  if(challanTotalBox){
    if(isChallanMode() && (t.transport>0 || t.loading>0)){
      challanTotalBox.style.display = "block";
      challanTotalBox.innerHTML =
        (t.transport>0 ? row("Transport", fmtPaise(t.transport)) : "") +
        (t.loading>0 ? row("Loading / Labour", fmtPaise(t.loading)) : "") +
        `<div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total charges</span><span>${fmtPaise(t.transport+t.loading)}</span></div>`;
    } else {
      challanTotalBox.style.display = "none";
      challanTotalBox.innerHTML = "";
    }
  }

  document.getElementById("totals-card").innerHTML = `
    ${row("Subtotal", fmtPaise(t.subtotal))}
    ${t.discount>0 ? row("Discount", "-"+fmtPaise(t.discount), "color:var(--danger);") : ""}
    ${t.transport>0 ? row("Transport", fmtPaise(t.transport)) : ""}
    ${t.loading>0 ? row("Loading", fmtPaise(t.loading)) : ""}
    ${!state.gstEnabled ? "" : t.taxType==="IGST"
      ? row(`IGST (${t.effectiveRatePct}%)`, fmtPaise(t.igst))
      : row(`CGST (${halfRatePct}%)`, fmtPaise(t.cgst)) + row(`SGST (${halfRatePct}%)`, fmtPaise(t.sgst))}
    ${t.roundOffAmount!==0 ? row("Round off", (t.roundOffAmount>0?"+":"")+fmtPaise(t.roundOffAmount)) : ""}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Grand Total</span><span>${fmtPaise(t.total)}</span></div>
    <div class="amount-words">${Pricing.amountInWords(t.total)}</div>
    ${t.advance>0?`<div class="inv-flex" style="margin-top:4px;color:var(--ok);"><span>Advance paid</span><span>-${fmtPaise(t.advance)}</span></div>
    <div class="inv-flex" style="font-weight:800;color:var(--danger);"><span>Balance due</span><span>${fmtPaise(t.balanceDue)}</span></div>`:""}
  `;
}
async function completeSale(){
  const challan = isChallanMode();
  if(!state.cart.length){ toast(`Add at least one item to the ${challan?"challan":"invoice"} first.`); return; }
  // Catch bad lines here so the user gets the message next to the field rather
  // than as a server rejection after the fact. A blank/0 rate is valid on a
  // challan — the rate is optional there, shown only if the print screen's
  // "Show Rate" toggle is on.
  for(const c of state.cart){
    const bad = Pricing.validateLine({
      mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
      thicknessIn:c.thicknessIn, pieces:c.pieces, rate: c.rate
    }, c.name);
    if(bad){ toast(bad); return; }
  }
  const btn = document.getElementById("complete-sale-btn");
  btn.disabled = true;
  const editingId = state.editingInvoiceId;
  try{
    const payload = {
      customerId: state.selectedCustomerId,
      docType: state.docType,
      // Only the raw inputs are sent — the server recomputes every derived
      // figure itself, so a tampered client cannot invent a billed quantity.
      items: state.cart.map(c=>({
        productId:c.productId, sizeId:c.sizeId, name:c.name, mode:c.mode,
        lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
        pieces:c.pieces, rate: c.rate
      })),
      discountType: state.discountType, discountValue: state.discountValue,
      advance: state.advance, paymentMethod: state.paymentMethod, paperSize: state.paperSize,
      transport: state.transport, loading: state.loading, roundOff: state.roundOff,
      gstOnCharges: state.gstOnCharges, gstEnabled: state.gstEnabled, deliveryMan: state.deliveryMan,
      vehicleNumber: state.vehicleNumber, deliveryAddress: state.deliveryAddress, remarks: state.remarks,
      // Only sent when staff explicitly picked a GST Type for this invoice —
      // omitted (undefined) falls back to the customer's Customer Master
      // default server-side, same as before this override existed.
      taxType: state.taxTypeOverride || undefined,
      locationId: state.billingLocationId
    };
    const invoice = editingId
      ? await api("PUT", `/invoices/${editingId}`, payload)
      : await api("POST", "/invoices", payload);
    state.cart = []; state.advance = 0; state.discountValue = 0; state.taxTypeOverride = null;
    state.transport = 0; state.loading = 0; state.deliveryMan = "";
    state.vehicleNumber = ""; state.deliveryAddress = ""; state.remarks = ""; state.gstEnabled = true;
    state.editingInvoiceId = null;
    state.docNo = null;
    document.getElementById("advance-input").value = 0;
    document.getElementById("discount-value").value = 0;
    const tIn = document.getElementById("transport-input"); if(tIn) tIn.value = 0;
    const lIn = document.getElementById("loading-input"); if(lIn) lIn.value = 0;
    const dmIn = document.getElementById("delivery-man-input"); if(dmIn) dmIn.value = "";
    const vnIn = document.getElementById("vehicle-number-input"); if(vnIn) vnIn.value = "";
    const daIn = document.getElementById("delivery-address-input"); if(daIn) daIn.value = "";
    const rmIn = document.getElementById("remarks-input"); if(rmIn) rmIn.value = "";
    setGstEnabled(true);
    renderEditModeBanner();
    await Promise.all([loadProducts(), loadCustomers()]);
    await renderBilling(); await renderHome();
    toast(`${challan?"Delivery Challan":"Sale"} ${editingId?"updated":"created"} — ${invoice.challan_no}`, "ok");
    openExistingInvoice(invoice.id);
  }catch(e){
    toast(e.message);
  }finally{
    btn.disabled = false;
  }
}

/* ============================================================
   INVENTORY
   ============================================================ */
function renderBrandFilter(){
  const brands = ["All", ...new Set(state.products.map(p=>p.brand).filter(Boolean))];
  document.getElementById("brand-filter").innerHTML = brands.map(b=>`
    <button class="chip ${state.invBrandFilter===b?'selected':''}" data-brand="${escapeHtml(b)}">${escapeHtml(b)}</button>
  `).join("");
  document.querySelectorAll("[data-brand]").forEach(b=>{
    b.addEventListener("click", ()=>{ state.invBrandFilter=b.dataset.brand; renderInventoryList(); });
  });
}
/** A product's total quantity AT one location — summed across every size,
 *  since a product's sizes/variants are still tracked separately even
 *  within the same location. */
function productLocationStock(p, locationCode){
  return p.sizes.reduce((sum, s) => {
    const row = (s.byLocation||[]).find(l=>l.code===locationCode);
    return sum + (row ? row.quantity : 0);
  }, 0);
}
function renderInventoryLocationToggle(){
  const wrap = document.getElementById("inv-location-toggle");
  if(!wrap) return;
  if(!state.invLocationCode && state.locations.length) state.invLocationCode = state.locations[0].code;
  const icon = code => code==="shop" ? "&#127978;" : code==="warehouse" ? "&#127974;" : "&#128230;";
  wrap.innerHTML = state.locations.map(l=>`
    <button class="doctype-btn ${state.invLocationCode===l.code?'selected':''}" data-inv-location="${l.code}">${icon(l.code)} ${escapeHtml(l.name)} Stock</button>
  `).join("");
  wrap.querySelectorAll("[data-inv-location]").forEach(b=>{
    b.addEventListener("click", ()=>{ state.invLocationCode = b.dataset.invLocation; renderInventoryList(); });
  });
}
async function renderInventoryList(){
  renderInventoryLocationToggle();
  renderBrandFilter();
  const q = (document.getElementById("inv-search").value||"").toLowerCase();
  let list = state.products;
  if(state.invBrandFilter!=="All") list = list.filter(p=>p.brand===state.invBrandFilter);
  if(q) list = list.filter(p=>p.name.toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q));
  // Low/Out filters read the CURRENT location tab's quantity specifically —
  // a product low in Shop but fine in Warehouse only shows under the Shop tab.
  if(state.invStockFilter==="low") list = list.filter(p=>{ const s=productLocationStock(p,state.invLocationCode); return s>0 && s<5; });
  else if(state.invStockFilter==="out") list = list.filter(p=>productLocationStock(p,state.invLocationCode)<=0);
  document.getElementById("product-count").textContent = list.length + " product" + (list.length!==1?"s":"");
  document.getElementById("inventory-list").innerHTML = `<div class="card">` + (list.length ? list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    const locStock = productLocationStock(p, state.invLocationCode);
    return `<div class="list-row" data-open-inv-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div></div>
      <div class="row-right">
        <span class="pill ${stockLevel(locStock)}">${stockLabel(locStock)}</span>
        <div class="muted" style="font-size:10px;margin-top:2px;">Total: ${p.stock}</div>
      </div>
    </div>`;
  }).join("") : `<div class="empty-hint">No products found.</div>`) + `</div>`;
  document.querySelectorAll("[data-open-inv-product]").forEach(el=>{
    el.addEventListener("click", ()=>openProductDetail(el.dataset.openInvProduct, "inventory"));
  });
}

/* ============================================================
   CUSTOMERS
   ============================================================ */
async function renderCustomersList(){
  if(state.partyMode==="supplier") return renderSuppliersList();
  const q = (document.getElementById("cust-search").value||"").toLowerCase();
  let list = state.customers;
  if(q) list = list.filter(c=>c.name.toLowerCase().includes(q) || (c.phone||"").includes(q) || (c.gst||"").toLowerCase().includes(q));
  document.getElementById("customers-list").innerHTML = `<div class="card">` + (list.length ? list.map(c=>{
    return `<div class="list-row" data-open-cust="${c.id}" style="cursor:pointer;${c.active===0?'opacity:0.55;':''}">
      <div class="avatar" style="width:34px;height:34px;font-size:12px;">${initials(c.name)}</div>
      <div><div class="row-title">${escapeHtml(c.name)}${c.active===0?' <span class="pill">Inactive</span>':''}</div><div class="row-sub">${escapeHtml(c.type||"")} · ${escapeHtml(c.phone||"")}</div></div>
      <div class="row-right ${c.due>0?'':'muted'}" style="font-weight:800;${c.due>0?'color:var(--danger);':''}">${fmt(c.due)}</div>
    </div>`;
  }).join("") : `<div class="empty-hint">No customers found.</div>`) + `</div>`;
  document.querySelectorAll("[data-open-cust]").forEach(el=>{
    el.addEventListener("click", ()=>openCustomerDetail(el.dataset.openCust));
  });
}

/* ============================================================
   SUPPLIERS — same list/detail/ledger/payment pattern as Customers,
   just pointed at the money the shop owes rather than what it's owed.
   ============================================================ */
async function renderSuppliersList(){
  const q = (document.getElementById("cust-search").value||"").toLowerCase();
  let list = state.suppliers;
  if(q) list = list.filter(s=>s.name.toLowerCase().includes(q) || (s.phone||"").includes(q) || (s.gst||"").toLowerCase().includes(q));
  document.getElementById("customers-list").innerHTML = `<div class="card">` + (list.length ? list.map(s=>{
    return `<div class="list-row" data-open-supplier="${s.id}" style="cursor:pointer;${s.active===0?'opacity:0.55;':''}">
      <div class="avatar" style="width:34px;height:34px;font-size:12px;">${initials(s.name)}</div>
      <div><div class="row-title">${escapeHtml(s.name)}${s.active===0?' <span class="pill">Inactive</span>':''}</div><div class="row-sub">${escapeHtml(s.phone||"")}</div></div>
      <div class="row-right ${s.due>0?'':'muted'}" style="font-weight:800;${s.due>0?'color:var(--danger);':''}">${fmt(s.due)}</div>
    </div>`;
  }).join("") : `<div class="empty-hint">No suppliers found.</div>`) + `</div>`;
  document.querySelectorAll("[data-open-supplier]").forEach(el=>{
    el.addEventListener("click", ()=>openSupplierDetail(el.dataset.openSupplier));
  });
}

/* ============================================================
   SHEETS: Product Detail
   ============================================================ */
function openProductDetail(productId, context){
  const p = state.products.find(x=>x.id===productId);
  if(!p) return;
  state.ctx.productId = productId;
  state.ctx.selectedSizeIdx = 0;
  renderProductDetailSheet(context);
  showSheet("sheet-product-detail");
}
function renderProductDetailSheet(context){
  const p = state.products.find(x=>x.id===state.ctx.productId);
  const sheet = document.getElementById("sheet-product-detail");
  const selectedSize = p.sizes[state.ctx.selectedSizeIdx] || p.sizes[0];
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(p.name)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px;">${escapeHtml(p.brand||"")} · ${escapeHtml(p.category||"")}</div>
    <span class="pill ${stockLevel(p.stock)}">${p.stock} ${escapeHtml(p.unit||"")} total, all sizes</span>

    <div class="chip-row" style="margin:12px 0;">
      ${p.sizes.map((s,i)=>{
        // Billing shows what's actually sellable at the selected location —
        // every other context shows the cross-location total.
        const qty = context==="billing" ? billingLocationStock(s) : s.stock;
        const billingLocName = (state.locations.find(l=>l.id===state.billingLocationId)||{}).name || "Shop";
        const qtyLabel = context==="billing" ? qty+" in "+billingLocName : qty+" in stock";
        return `<button class="chip ${i===state.ctx.selectedSizeIdx?'selected':''}" data-size="${i}">${escapeHtml(s.label)} · ${fmt(s.price)} · ${qtyLabel}</button>`;
      }).join("")}
    </div>

    <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11.5px;">
      <div><span class="muted">SKU</span><br>${escapeHtml(p.sku||"")}</div>
      <div><span class="muted">Product Code</span><br>${escapeHtml(p.code||"—")}</div>
      <div><span class="muted">HSN Code</span><br>${escapeHtml(p.hsn_code||"—")}</div>
      <div><span class="muted">Unit</span><br>${escapeHtml(p.unit||"")}</div>
      <div><span class="muted">GST%</span><br>${p.gst}%</div>
      <div><span class="muted">Godown</span><br>${escapeHtml(p.godown||"—")}</div>
      <div><span class="muted">Rack</span><br>${escapeHtml(p.rack||"—")}</div>
    </div>

    <div id="stock-editor-area" style="margin-top:14px;"></div>
    ${context==="inventory" ? `
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn btn-outline" id="stock-in-btn" style="flex:1;">+ Record Stock In</button>
        <button class="btn btn-outline" id="transfer-stock-btn" style="flex:1;">&#8646; Transfer Stock</button>
      </div>
      <button class="btn btn-outline" id="opening-stock-btn" style="width:100%;margin-top:8px;">+ Opening Stock Balance</button>
      <div class="section-title">Recent Purchases</div>
      <div class="card" id="stock-in-history"><div class="empty-hint">Loading…</div></div>
    ` : ""}

    ${context==="billing" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-invoice-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-invoice-btn" style="margin-top:14px;" ${billingLocationStock(selectedSize)<=0?"disabled":""}>${billingLocationStock(selectedSize)<=0?"Out of stock at this location":"Add to Invoice"}</button>`
    ) : ""}
    ${context==="purchase" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-purchase-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-purchase-btn" style="margin-top:14px;">Add to Purchase</button>`
    ) : ""}
    ${context==="po" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-po-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-po-btn" style="margin-top:14px;">Add to Order</button>`
    ) : ""}
    ${context==="quotation" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-quotation-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-quotation-btn" style="margin-top:14px;">Add to Quotation</button>`
    ) : ""}
    ${context==="so" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-so-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-so-btn" style="margin-top:14px;">Add to Order</button>`
    ) : ""}

    <div class="action-row">
      <button class="btn btn-outline" id="edit-product-btn">✎ Edit</button>
      <button class="btn btn-outline" id="duplicate-product-btn">⧉ Duplicate</button>
    </div>
    ${isOwner() ? `<div style="margin-top:12px;text-align:center;">
      <a href="#" id="delete-product-link" class="btn-danger-link">Delete this product</a>
    </div>` : `<div class="muted" style="margin-top:12px;font-size:11px;text-align:center;">Only the owner can delete a product.</div>`}
  `;
  const stockArea = sheet.querySelector("#stock-editor-area");
  if(context==="inventory"){
    // Every size × location gets its own +/- — Manual Adjustment always says
    // which location, same as every other stock action in this app. Icons
    // mirror the Inventory screen's own location toggle (🏪/🏬/📦).
    const locIcon = code => code==="shop" ? "&#127978;" : code==="warehouse" ? "&#127974;" : "&#128230;";
    stockArea.innerHTML = `
      <label class="field-label">Stock on hand, per size and location</label>
      ${p.sizes.map(s=>`
        <div class="card" style="margin-bottom:8px;padding:10px 12px;">
          <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">${escapeHtml(s.label)} <span class="muted" style="font-weight:400;">· Total ${s.stock}</span></div>
          ${(s.byLocation||[]).map(loc=>`
            <div class="list-row" style="padding:4px 0;">
              <div style="flex:1;font-size:12px;">${locIcon(loc.code)} ${escapeHtml(loc.name)}</div>
              <div class="qty-step">
                <button data-loc-dec="${s.id}" data-loc-id="${loc.location_id}">−</button>
                <input type="number" value="${loc.quantity}" data-loc-stock-input="${s.id}" data-loc-id="${loc.location_id}" style="width:60px;">
                <button data-loc-inc="${s.id}" data-loc-id="${loc.location_id}">+</button>
              </div>
            </div>`).join("")}
        </div>`).join("") || `<div class="empty-hint">No sizes on this product.</div>`}
    `;
    stockArea.querySelectorAll("[data-loc-dec]").forEach(b=>b.addEventListener("click", async ()=>{
      const updated = await api("PATCH", `/products/${p.id}/sizes/${b.dataset.locDec}/stock`, {delta:-1, locationId:b.dataset.locId});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    }));
    stockArea.querySelectorAll("[data-loc-inc]").forEach(b=>b.addEventListener("click", async ()=>{
      const updated = await api("PATCH", `/products/${p.id}/sizes/${b.dataset.locInc}/stock`, {delta:1, locationId:b.dataset.locId});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    }));
    stockArea.querySelectorAll("[data-loc-stock-input]").forEach(inp=>inp.addEventListener("change", async (e)=>{
      const updated = await api("PATCH", `/products/${p.id}/sizes/${inp.dataset.locStockInput}/stock`, {stock: parseInt(e.target.value)||0, locationId:inp.dataset.locId});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    }));
    sheet.querySelector("#stock-in-btn").addEventListener("click", ()=>openStockIn(p));
    sheet.querySelector("#transfer-stock-btn").addEventListener("click", ()=>openTransferStock(p));
    sheet.querySelector("#opening-stock-btn").addEventListener("click", ()=>openOpeningStock(p));
    loadStockInHistory(p.id);
  } else {
    // Every doc type acts on a chosen location (Shop by default for a sale,
    // Warehouse by default for a purchase) — showing both here is for
    // visibility only, so staff aren't misled by the single denormalised
    // total into thinking stock sitting in the OTHER location is available
    // without switching locations first.
    const shopQty = selectedSize ? sizeShopStock(selectedSize) : 0;
    const warehouseQty = selectedSize ? sizeWarehouseStock(selectedSize) : 0;
    stockArea.innerHTML = `<div class="muted" style="font-size:11.5px;">${selectedSize ? `&#127978; Shop: ${shopQty} · &#127974; Warehouse: ${warehouseQty} ${escapeHtml(p.unit||"")} (${escapeHtml(selectedSize.label)})` : ""} · edit stock levels from Inventory</div>`;
  }
  sheet.querySelectorAll("[data-size]").forEach(b=>{
    b.addEventListener("click", ()=>{ state.ctx.selectedSizeIdx = parseInt(b.dataset.size); renderProductDetailSheet(context); });
  });
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  const addBtn = sheet.querySelector("#add-to-invoice-btn");
  if(addBtn){
    addBtn.addEventListener("click", ()=>{
      const ok = addToCart(p.id, state.ctx.selectedSizeIdx);
      if(ok){ closeAllSheets(); renderBillingProducts(); }
      else toast("Can't add more — that's all the stock we have for this size at the selected location.");
    });
  }
  const addPurBtn = sheet.querySelector("#add-to-purchase-btn");
  if(addPurBtn){
    addPurBtn.addEventListener("click", ()=>{
      addToPurchaseCart(p.id, state.ctx.selectedSizeIdx);
      closeAllSheets();
      renderPurchaseProducts();
    });
  }
  const addPoBtn = sheet.querySelector("#add-to-po-btn");
  if(addPoBtn){
    addPoBtn.addEventListener("click", ()=>{
      addToPoCart(p.id, state.ctx.selectedSizeIdx);
      closeAllSheets();
      renderPoProducts();
    });
  }
  const addQuotationBtn = sheet.querySelector("#add-to-quotation-btn");
  if(addQuotationBtn){
    addQuotationBtn.addEventListener("click", ()=>{
      addToQuotationCart(p.id, state.ctx.selectedSizeIdx);
      closeAllSheets();
      renderQuotationProducts();
    });
  }
  const addSoBtn = sheet.querySelector("#add-to-so-btn");
  if(addSoBtn){
    addSoBtn.addEventListener("click", ()=>{
      addToSoCart(p.id, state.ctx.selectedSizeIdx);
      closeAllSheets();
      renderSoProducts();
    });
  }
  sheet.querySelector("#edit-product-btn").addEventListener("click", ()=>{
    openProductForm(context, p);
  });

  sheet.querySelector("#duplicate-product-btn").addEventListener("click", async (e)=>{
    const btn = e.currentTarget;
    btn.disabled = true;
    try{
      const copy = await api("POST", `/products/${p.id}/duplicate`);
      await loadProducts();
      renderInventoryList(); renderBillingProducts();
      // Land straight in the edit form for the copy: a duplicate almost always
      // needs one field changed (usually thickness or grade) before it is real.
      openProductForm(context, state.products.find(x=>x.id===copy.id) || copy);
      toast("Duplicated — opening stock starts at 0.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });

  const deleteProductLink = sheet.querySelector("#delete-product-link");
  if(deleteProductLink) deleteProductLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    // Ask the server what this product carries first, so the confirmation can
    // state the actual consequence instead of a generic warning — and so a
    // product already used in a sale is refused here rather than after a
    // confirm dialog the user just clicked through.
    let warn = "", invoiceCount = 0;
    try{
      const u = await api("GET", `/products/${p.id}/usage`);
      invoiceCount = u.invoiceCount || 0;
      if(invoiceCount === 0){
        const bits = [];
        if(u.stockInCount) bits.push(`${u.stockInCount} purchase record${u.stockInCount>1?"s":""}`);
        if(u.stock > 0) bits.push(`${u.stock} still in stock`);
        if(bits.length) warn = "\n\nThis product has " + bits.join(", ") + ".";
      }
    }catch(_){ /* fall back to the plain confirmation; server still enforces the rule */ }

    if(invoiceCount > 0){
      const step1 = confirm(
        `"${p.name}" has been used in ${invoiceCount} sale line${invoiceCount>1?"s":""} and normally can't be deleted, to keep those invoices accurate.\n\n` +
        `Force Delete removes it anyway. Those ${invoiceCount} past invoice${invoiceCount>1?"s":""} will still print exactly as issued (they keep their own copy of the name, size and rate) — but they'll lose their live link to this product, which can affect future profit/cost lookups for those sale lines.\n\n` +
        `This cannot be undone. Force delete "${p.name}"?`
      );
      if(!step1) return;
      const step2 = confirm(`Last check — permanently delete "${p.name}" and detach it from ${invoiceCount} past sale${invoiceCount>1?"s":""}? This is not reversible.`);
      if(!step2) return;
      try{
        await api("DELETE", `/products/${p.id}?force=true`);
        await loadProducts();
        closeAllSheets(); renderInventoryList(); renderBillingProducts();
        refreshCartFromProducts();
        toast("Product force-deleted.", "ok");
      }catch(err){ toast(err.message); }
      return;
    }

    if(confirm("Delete " + p.name + "? This can't be undone." + warn)){
      try{
        await api("DELETE", `/products/${p.id}`);
        await loadProducts();
        closeAllSheets(); renderInventoryList(); renderBillingProducts();
        refreshCartFromProducts();
        toast("Product deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
}
async function loadStockInHistory(productId){
  const area = document.getElementById("stock-in-history");
  if(!area) return;
  try{
    const rows = await api("GET", `/products/${productId}/stock-in`);
    if(!area.isConnected) return;
    area.innerHTML = rows.length ? rows.map(r=>{
      const dt = new Date(r.created_at);
      const sizeBit = r.size_label ? escapeHtml(r.size_label)+" · " : "";
      const qtyBit = Pricing.formatQty(r.billed_qty||r.qty, r.mode||"UNIT");
      return `<div class="list-row"><div>
        <div class="row-title">+${r.qty} pcs received${r.supplier?" from "+escapeHtml(r.supplier):""}</div>
        <div class="row-sub">${dt.toLocaleDateString("en-IN")}${r.invoice_no?" · Inv# "+escapeHtml(r.invoice_no):""}${r.purchase_date?" · "+escapeHtml(r.purchase_date):""}</div>
        <div class="row-sub">${sizeBit}${qtyBit}${r.rate?" @ "+fmt(r.rate):""} · Grand Total ${fmt(r.grand_total||r.cost_price*r.qty)}</div>
      </div></div>`;
    }).join("") : `<div class="empty-hint">No purchases recorded yet.</div>`;
  }catch(e){ if(area.isConnected) area.innerHTML = `<div class="empty-hint">Couldn't load purchase history.</div>`; }
}

/**
 * Factory Reset confirmation sheet. Two independent gates, both required:
 * the owner's PIN (re-typed here even though they're already logged in) and
 * a phrase typed out in full — a checkbox is too easy to click through
 * without reading. Both are re-verified server-side; this client-side gate
 * only exists to make the moment feel as serious as it is.
 */
const RESET_CONFIRM_PHRASE = "DELETE ALL DATA";
function openFactoryResetSheet(){
  const sheet = document.getElementById("sheet-factory-reset");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title" style="color:var(--danger);">⚠ Factory Reset</div>
    <p class="muted" style="font-size:12.5px;line-height:1.5;margin-top:4px;">
      This permanently deletes every <strong>product, customer, invoice, delivery challan, purchase record, and payment</strong>.
      Your business profile (name, GSTIN, address) and staff logins are kept.
    </p>
    <p class="muted" style="font-size:12.5px;line-height:1.5;">
      A full backup is taken automatically right before this runs, so the data isn't gone forever — but restoring it means replacing this file by hand later. This is not something to click through casually.
    </p>
    <label class="field-label">Enter your PIN</label>
    <input type="password" inputmode="numeric" id="fr-pin" placeholder="••••" maxlength="6">
    <label class="field-label">Type <strong>${RESET_CONFIRM_PHRASE}</strong> to confirm</label>
    <input type="text" id="fr-phrase" placeholder="${RESET_CONFIRM_PHRASE}" autocomplete="off" autocapitalize="characters">
    <button class="btn" id="fr-submit" style="background:var(--danger);color:#fff;width:100%;margin-top:16px;" disabled>Wipe All Shop Data</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);

  const pinEl = sheet.querySelector("#fr-pin");
  const phraseEl = sheet.querySelector("#fr-phrase");
  const submitBtn = sheet.querySelector("#fr-submit");
  const updateEnabled = () => {
    submitBtn.disabled = !(pinEl.value.length>=4 && phraseEl.value.trim()===RESET_CONFIRM_PHRASE);
  };
  pinEl.addEventListener("input", updateEnabled);
  phraseEl.addEventListener("input", updateEnabled);

  submitBtn.addEventListener("click", async ()=>{
    // Last checkpoint before the irreversible network call — a second, more
    // explicit confirm() on top of the two typed gates above.
    if(!confirm("This is the final step. Everything except your business profile and staff logins will be permanently deleted. Continue?")) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Wiping…";
    try{
      const r = await api("POST", "/reset", { pin: pinEl.value, confirmText: phraseEl.value.trim() });
      closeAllSheets();
      toast(`Shop data wiped. Backup saved: ${r.backupFile}`, "ok");
      await Promise.all([loadProducts(), loadCustomers()]);
      await renderAll();
    }catch(err){
      toast(err.message);
      submitBtn.textContent = "Wipe All Shop Data";
      updateEnabled();
    }
  });
  showSheet("sheet-factory-reset");
}

/**
 * Full Purchase Entry sheet: date, supplier, invoice number, the same size/
 * mode picker billing uses (with live Sq.ft auto-calc), GST and transport,
 * ending in a Grand Total — mirrors a sales invoice line but for stock coming
 * IN rather than going out.
 *
 * `editingSi` (optional) is an existing stock_ins row to edit in place —
 * Save then PUTs to that record instead of creating a new one, and a Delete
 * link appears (owner-only, enforced server-side either way).
 */
function openStockIn(p, editingSi){
  const sheet = document.getElementById("sheet-stock-in");
  const warehouseLoc = state.locations.find(l=>l.code==="warehouse");
  const ctx = editingSi ? {
    sizeId: editingSi.size_id,
    mode: Pricing.normaliseMode(editingSi.mode),
    lengthFt: editingSi.length_ft || "", widthVal: editingSi.width_val || "", thicknessIn: editingSi.thickness_in || "",
    pieces: editingSi.qty, rate: editingSi.rate, gst: editingSi.gst_rate, transport: editingSi.transport,
    locationId: editingSi.location_id || (warehouseLoc && warehouseLoc.id)
  } : {
    // Stock lands on one specific size — auto-picked when there's only one,
    // otherwise the counter staff must say which so it can't land nowhere.
    sizeId: p.sizes.length===1 ? p.sizes[0].id : null,
    mode: Pricing.normaliseMode(p.default_mode),
    lengthFt: p.length_ft || "", widthVal: p.width_val || "", thicknessIn: p.thickness_in || "",
    pieces: 1, rate: 0, gst: p.gst, transport: 0,
    locationId: warehouseLoc && warehouseLoc.id
  };

  function calc(){
    return Pricing.computeLine({
      mode: ctx.mode, lengthFt: ctx.lengthFt, widthVal: ctx.widthVal,
      thicknessIn: ctx.thicknessIn, pieces: ctx.pieces, rate: ctx.rate
    });
  }

  // GST Type is an explicit field on the supplier record (Supplier Master),
  // the source of truth here — matched against whatever's typed in the
  // Supplier box, mirroring what the server independently computes at save
  // time. A supplier not yet on file (still being typed) defaults CGST_SGST.
  function stockInTaxType(){
    const typed = (sheet.querySelector("#si-supplier")?.value || "").trim().toLowerCase();
    const sup = state.suppliers.find(s=>s.name.trim().toLowerCase()===typed);
    return (sup && sup.gst_type === "IGST") ? "IGST" : "CGST_SGST";
  }
  function splitGst(gstAmt){
    if(stockInTaxType()==="IGST") return {cgst:0, sgst:0, igst:gstAmt};
    const cgst = round2(gstAmt/2);
    return {cgst, sgst: round2(gstAmt-cgst), igst:0};
  }

  function render(){
    const m = Pricing.MODES[ctx.mode];
    const r = calc();
    const gstAmt = round2(r.amount * ((parseFloat(ctx.gst)||0)/100));
    const transportAmt = Math.max(0, parseFloat(ctx.transport)||0);
    const grandTotal = round2(r.amount + gstAmt + transportAmt);
    const split = splitGst(gstAmt);

    const dim = (label, unit, key, val) => `
      <label class="dim">
        <span>${label}${unit?` <em>(${unit})</em>`:""}</span>
        <input type="number" inputmode="decimal" step="any" min="0" value="${val===0||val?val:""}" data-si-field="${key}" placeholder="0">
      </label>`;

    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">${editingSi?"Edit Purchase":"Record Purchase"}</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(p.name)} · Current stock: ${p.stock} ${escapeHtml(p.unit||"")}</div>

      <div class="charge-grid">
        <label class="dim"><span>Purchase Date</span><input type="date" id="si-date" value="${editingSi?editingSi.purchase_date:todayISO()}"></label>
        <label class="dim"><span>Invoice No.</span><input type="text" id="si-invoice" value="${escapeHtml(editingSi?editingSi.invoice_no||"":"")}" placeholder="Supplier's invoice #"></label>
      </div>
      <label class="field-label">Supplier</label>
      <input type="text" id="si-supplier" list="si-supplier-datalist" value="${escapeHtml(editingSi?editingSi.supplier||"":"")}" placeholder="e.g. Century Ply Distributor">
      <datalist id="si-supplier-datalist">${state.suppliers.map(s=>`<option value="${escapeHtml(s.name)}">`).join("")}</datalist>

      <label class="field-label">Which size received this stock?</label>
      <div class="chip-row" id="si-size-chips">
        ${p.sizes.map(s=>`<button class="chip ${s.id===ctx.sizeId?'selected':''}" data-si-size="${s.id}">${escapeHtml(s.label)} · ${s.stock} in stock</button>`).join("") || `<span class="muted" style="font-size:12px;">No sizes on this product yet — add one via Edit first.</span>`}
      </div>

      <label class="field-label">Stock goes to</label>
      <div class="chip-row" id="si-location-chips">
        ${state.locations.map(l=>`<button class="chip ${l.id===ctx.locationId?'selected':''}" data-si-location="${l.id}">${escapeHtml(l.name)}</button>`).join("")}
      </div>

      <label class="field-label">Billing mode</label>
      <div class="mode-row">
        ${Pricing.MODE_KEYS.map(k=>`<button class="chip sm ${k===ctx.mode?'selected':''}" data-si-mode="${k}" title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>`).join("")}
      </div>

      <div class="dim-grid">
        ${m.needsThickness ? dim("Thickness", m.thicknessUnit, "thicknessIn", ctx.thicknessIn) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", ctx.lengthFt) : ""}
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", ctx.widthVal) : ""}
        ${dim("Qty received", "pcs", "pieces", ctx.pieces)}
        ${dim("Rate", "₹/"+m.unit, "rate", ctx.rate)}
      </div>

      <div class="line-calc">
        <div class="line-calc-formula">
          ${r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : ""}
          ${m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : ""}
          <strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong> × ${Pricing.formatRate(r.rate, r.mode)}
        </div>
        <div class="line-calc-amount">${fmtPaise(r.amount)}</div>
      </div>

      <div class="charge-grid" style="margin-top:10px;">
        <label class="dim"><span>GST %</span><input type="number" id="si-gst" value="${ctx.gst}" data-si-field="gst"></label>
        <label class="dim"><span>Transport / Other (₹)</span><input type="number" id="si-transport" value="${ctx.transport}" data-si-field="transport"></label>
      </div>

      <div class="line-calc" style="margin-top:10px;">
        <div class="line-calc-formula">Amount ${fmtPaise(r.amount)} + ${split.igst ? `IGST ${fmtPaise(split.igst)}` : `CGST ${fmtPaise(split.cgst)} + SGST ${fmtPaise(split.sgst)}`} + Transport ${fmtPaise(transportAmt)}</div>
        <div class="line-calc-amount">Grand Total ${fmtPaise(grandTotal)}</div>
      </div>

      <label class="field-label">Note (optional)</label>
      <input type="text" id="si-note" value="${escapeHtml(editingSi?editingSi.note||"":"")}" placeholder="e.g. LR number, remarks">
      <button class="btn btn-primary" id="si-save" style="margin-top:16px;">${editingSi?"Update Purchase":"Save Purchase"}</button>
      ${editingSi && isOwner() ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="si-delete-link" class="btn-danger-link">Delete this purchase</a></div>` : ""}
    `;

    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-si-size]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.sizeId = Number(b.dataset.siSize); render();
    }));
    sheet.querySelectorAll("[data-si-mode]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.mode = b.dataset.siMode; render();
    }));
    sheet.querySelectorAll("[data-si-location]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.locationId = b.dataset.siLocation; render();
    }));
    sheet.querySelector("#si-supplier").addEventListener("input", renderCalcOnly);
    sheet.querySelectorAll("[data-si-field]").forEach(inp=>inp.addEventListener("input", ()=>{
      ctx[inp.dataset.siField] = inp.value;
      renderCalcOnly();
    }));
    sheet.querySelector("#si-save").addEventListener("click", async ()=>{
      if(ctx.sizeId == null){ toast("Choose which size received this stock."); return; }
      const bad = Pricing.validateLine({
        mode: ctx.mode, lengthFt: ctx.lengthFt, widthVal: ctx.widthVal,
        thicknessIn: ctx.thicknessIn, pieces: ctx.pieces, rate: ctx.rate
      }, p.name);
      if(bad){ toast(bad); return; }
      const btn = document.getElementById("si-save");
      btn.disabled = true;
      try{
        const payload = {
          sizeId: ctx.sizeId,
          purchaseDate: document.getElementById("si-date").value,
          invoiceNo: document.getElementById("si-invoice").value.trim(),
          supplier: document.getElementById("si-supplier").value.trim(),
          note: document.getElementById("si-note").value.trim(),
          mode: ctx.mode, lengthFt: ctx.lengthFt, widthVal: ctx.widthVal, thicknessIn: ctx.thicknessIn,
          pieces: ctx.pieces, rate: ctx.rate, gst: ctx.gst, transport: ctx.transport, locationId: ctx.locationId
        };
        if(editingSi){
          await api("PUT", `/products/${p.id}/stock-in/${editingSi.id}`, payload);
          await Promise.all([loadProducts(), loadSuppliers()]);
          closeAllSheets();
          toast("Purchase updated.", "ok");
        } else {
          const result = await api("POST", `/products/${p.id}/stock-in`, payload);
          Object.assign(p, result.product);
          await Promise.all([loadProducts(), loadSuppliers()]);
          closeAllSheets();
          openProductDetail(p.id, "inventory");
          renderInventoryList();
          toast(`Purchase recorded — Grand Total ${fmt(result.purchase.grand_total)}`, "ok");
        }
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; }
    });
    const deleteLink = sheet.querySelector("#si-delete-link");
    if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
      e.preventDefault();
      if(confirm(`Delete this purchase permanently? Stock and the supplier's due will be reversed. This can't be undone.`)){
        try{
          await api("DELETE", `/products/${p.id}/stock-in/${editingSi.id}`);
          await Promise.all([loadProducts(), loadSuppliers()]);
          closeAllSheets();
          toast("Purchase deleted.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
  }

  // Repaint just the live-calc figures on every keystroke, without rebuilding
  // the whole form (which would steal focus from the input being typed in).
  function renderCalcOnly(){
    const m = Pricing.MODES[ctx.mode];
    const r = calc();
    const gstAmt = round2(r.amount * ((parseFloat(ctx.gst)||0)/100));
    const transportAmt = Math.max(0, parseFloat(ctx.transport)||0);
    const grandTotal = round2(r.amount + gstAmt + transportAmt);
    const split = splitGst(gstAmt);
    const blocks = sheet.querySelectorAll(".line-calc");
    if(blocks[0]){
      blocks[0].querySelector(".line-calc-formula").innerHTML =
        (r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : "") +
        (m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : "") +
        `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong> × ${Pricing.formatRate(r.rate, r.mode)}`;
      blocks[0].querySelector(".line-calc-amount").textContent = fmtPaise(r.amount);
    }
    if(blocks[1]){
      blocks[1].querySelector(".line-calc-formula").textContent = `Amount ${fmtPaise(r.amount)} + ${split.igst ? `IGST ${fmtPaise(split.igst)}` : `CGST ${fmtPaise(split.cgst)} + SGST ${fmtPaise(split.sgst)}`} + Transport ${fmtPaise(transportAmt)}`;
      blocks[1].querySelector(".line-calc-amount").textContent = `Grand Total ${fmtPaise(grandTotal)}`;
    }
  }

  render();
  showSheet("sheet-stock-in");
}

/**
 * Opening Stock Balance — a deliberately stripped-down alternative to
 * Record Stock In, for setting up a product's starting quantity/cost with
 * no GST, supplier, or billing-mode geometry to think about: just Product
 * (already chosen via the sheet it's opened from), Location, Opening Date,
 * Opening Quantity and Purchase Cost, with Total Opening Value shown live.
 * Saves through the exact same stock-in endpoint as Record Stock In —
 * always as a plain per-piece UNIT line (qty × cost = total), regardless of
 * the product's normal selling mode, since an opening balance doesn't need
 * area/length billing math, only a starting count and its cost.
 */
function openOpeningStock(p){
  const sheet = document.getElementById("sheet-opening-stock");
  const warehouseLoc = state.locations.find(l=>l.code==="warehouse");
  const ctx = {
    sizeId: p.sizes.length===1 ? p.sizes[0].id : null,
    locationId: warehouseLoc && warehouseLoc.id,
    date: todayISO(), qty: "", cost: ""
  };

  function render(){
    const total = round2((parseFloat(ctx.qty)||0) * (parseFloat(ctx.cost)||0));
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">Opening Stock Balance</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(p.name)}</div>

      ${p.sizes.length>1 ? `
      <label class="field-label">Size / Variant</label>
      <div class="chip-row" id="os-size-chips">
        ${p.sizes.map(s=>`<button class="chip ${s.id===ctx.sizeId?'selected':''}" data-os-size="${s.id}">${escapeHtml(s.label)}</button>`).join("")}
      </div>` : ""}

      <label class="field-label">Warehouse <span class="muted" style="font-weight:400;">— optional, defaults to Warehouse</span></label>
      <div class="chip-row" id="os-location-chips">
        ${state.locations.map(l=>`<button class="chip ${l.id===ctx.locationId?'selected':''}" data-os-location="${l.id}">${escapeHtml(l.name)}</button>`).join("")}
      </div>

      <label class="field-label">Opening Date</label>
      <input type="date" id="os-date" value="${ctx.date}">

      <label class="field-label">Opening Quantity</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="os-qty" value="${ctx.qty}" placeholder="0">

      <label class="field-label">Purchase Cost <span class="muted" style="font-weight:400;">— per unit</span></label>
      <input type="number" inputmode="decimal" step="any" min="0" id="os-cost" value="${ctx.cost}" placeholder="0">

      <div class="card" style="margin-top:12px;">
        <div class="inv-flex" style="font-weight:800;"><span>Total Opening Value</span><span>${fmt(total)}</span></div>
      </div>

      <button class="btn btn-primary" id="os-save" style="margin-top:16px;width:100%;">Save Opening Stock</button>
    `;
    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-os-size]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.sizeId = Number(b.dataset.osSize); render();
    }));
    sheet.querySelectorAll("[data-os-location]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.locationId = b.dataset.osLocation; render();
    }));
    sheet.querySelector("#os-date").addEventListener("change", e=>{ ctx.date = e.target.value; });
    sheet.querySelector("#os-qty").addEventListener("input", e=>{ ctx.qty = e.target.value; renderTotalOnly(); });
    sheet.querySelector("#os-cost").addEventListener("input", e=>{ ctx.cost = e.target.value; renderTotalOnly(); });
    sheet.querySelector("#os-save").addEventListener("click", save);
  }
  // Recompute just the total on every keystroke without a full re-render —
  // a full render() would steal focus from the input mid-type.
  function renderTotalOnly(){
    const total = round2((parseFloat(ctx.qty)||0) * (parseFloat(ctx.cost)||0));
    const el = sheet.querySelector(".card .inv-flex span:last-child");
    if(el) el.textContent = fmt(total);
  }
  async function save(){
    const qty = parseFloat(ctx.qty);
    const cost = parseFloat(ctx.cost);
    if(!qty || qty<=0){ toast("Enter a valid opening quantity."); return; }
    if(cost===null || isNaN(cost) || cost<0){ toast("Enter a valid purchase cost."); return; }
    if(!ctx.sizeId){ toast("Choose which size/variant this opening stock is for."); return; }
    const btn = sheet.querySelector("#os-save");
    btn.disabled = true;
    try{
      await api("POST", `/products/${p.id}/stock-in`, {
        purchaseDate: ctx.date, sizeId: ctx.sizeId, locationId: ctx.locationId,
        mode: "UNIT", pieces: qty, rate: cost, gst: 0
      });
      await loadProducts();
      closeAllSheets();
      renderInventoryList();
      toast("Opening stock saved.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  }

  render();
  showSheet("sheet-opening-stock");
}

/* ============================================================
   SHEETS: Customer Detail
   ============================================================ */
async function openCustomerDetail(customerId){
  const [detail, quotations, salesOrders, salesReturns] = await Promise.all([
    api("GET", `/customers/${customerId}`),
    api("GET", `/quotations?customerId=${customerId}`),
    api("GET", `/sales-orders?customerId=${customerId}`),
    api("GET", `/sales-returns?customerId=${customerId}`)
  ]);
  const sheet = document.getElementById("sheet-customer-detail");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(detail.name)} ${detail.active===0?'<span class="pill">Inactive</span>':''}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(detail.type||"")} · ${escapeHtml(detail.phone||"")}${detail.gst?" · GST "+escapeHtml(detail.gst):""}${detail.state?" · "+escapeHtml(detail.state):""}${detail.address?"<br>"+escapeHtml(detail.address):""}</div>
    <div class="stat-grid">
      <div class="stat-card plain"><div class="label">Total Sales</div><div class="value">${fmt(detail.totalSales)}</div></div>
      <div class="stat-card plain"><div class="label">Total Received</div><div class="value">${fmt(detail.totalPaymentReceived)}</div></div>
      <div class="stat-card plain"><div class="label">Credit Limit</div><div class="value">${fmt(detail.credit_limit)}</div></div>
      <div class="stat-card plain"><div class="label">Outstanding Due</div><div class="value red">${fmt(detail.outstandingReceivable)}</div></div>
    </div>
    <div class="action-row" style="margin-top:10px;">
      <button class="btn btn-outline" id="edit-cust-btn">✎ Edit</button>
      ${detail.due>0 ? `<button class="btn btn-gold" id="record-payment-btn">Sale Payment</button>` : ""}
      ${detail.phone ? `<button class="btn btn-outline" id="wa-chat-cust-btn">💬 Chat on WhatsApp</button>` : ""}
      <button class="btn btn-outline" id="print-ledger-btn">Print Ledger</button>
      <button class="btn btn-outline" id="export-ledger-btn">Export Excel</button>
      ${isOwner() ? `<button class="btn btn-outline" id="opening-balance-btn">Opening Outstanding</button>` : ""}
    </div>
    ${quotations.length ? `
    <div class="section-title">Quotations</div>
    <div class="card">${quotations.map(q=>`
      <div class="list-row" data-open-quotation="${q.id}" style="cursor:pointer;">
        <div><div class="row-title">${escapeHtml(q.quotation_no)}</div><div class="row-sub">${q.date}</div></div>
        <div class="row-right"><div class="row-title">${fmt(q.total)}</div><span class="pill ${QUOTATION_STATUS_PILL[q.status]||''}">${escapeHtml(q.status)}</span></div>
      </div>`).join("")}
    </div>` : ""}
    ${salesOrders.length ? `
    <div class="section-title">Sales Orders</div>
    <div class="card">${salesOrders.map(so=>`
      <div class="list-row" data-open-so="${so.id}" style="cursor:pointer;">
        <div><div class="row-title">${escapeHtml(so.so_no)}</div><div class="row-sub">${so.date}</div></div>
        <div class="row-right"><div class="row-title">${fmt(so.total)}</div><span class="pill ${SO_STATUS_PILL[so.status]||''}">${escapeHtml(so.status)}</span></div>
      </div>`).join("")}
    </div>` : ""}
    ${salesReturns.length ? `
    <div class="section-title">Sales Returns</div>
    <div class="card">${salesReturns.map(sr=>`
      <div class="list-row" data-open-sales-return="${sr.id}" style="cursor:pointer;">
        <div><div class="row-title">${escapeHtml(sr.return_no)}</div><div class="row-sub">${sr.date}${sr.voided?" · Voided":""}</div></div>
        <div class="row-right row-title">${fmt(sr.total)}</div>
      </div>`).join("")}
    </div>` : ""}
    <div class="section-title">Ledger</div>
    <div class="card">${detail.ledger.length ? detail.ledger.map(l=>renderPartyLedgerRow(l,"customer",detail.id)).join("") : `<div class="empty-hint">No activity yet.</div>`}</div>
    ${isOwner() ? `<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;align-items:center;">
      <a href="#" id="toggle-active-cust-link">${detail.active===0?"Reactivate this customer":"Deactivate this customer"}</a>
      <a href="#" id="delete-cust-link" class="btn-danger-link">Delete this customer</a>
    </div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#edit-cust-btn").addEventListener("click", ()=>{ closeAllSheets(); openAddCustomer(detail); });
  sheet.querySelectorAll("[data-open-invoice]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openExistingInvoice(el.dataset.openInvoice); });
  });
  sheet.querySelectorAll("[data-open-quotation]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openQuotationDetail(el.dataset.openQuotation); });
  });
  sheet.querySelectorAll("[data-open-so]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openSoDetail(el.dataset.openSo); });
  });
  sheet.querySelectorAll("[data-open-sales-return]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openSalesReturnDetail(el.dataset.openSalesReturn); });
  });
  const recordPaymentBtn = sheet.querySelector("#record-payment-btn");
  if(recordPaymentBtn) recordPaymentBtn.addEventListener("click", ()=>openRecordPayment(detail));
  const waChatCustBtn = sheet.querySelector("#wa-chat-cust-btn");
  if(waChatCustBtn) waChatCustBtn.addEventListener("click", ()=>openWhatsApp(detail.phone));
  const openingBalanceBtn = sheet.querySelector("#opening-balance-btn");
  if(openingBalanceBtn) openingBalanceBtn.addEventListener("click", ()=>openCustomerOpeningBalance(detail));
  sheet.querySelector("#print-ledger-btn").addEventListener("click", ()=>printPartyLedger(detail,"Customer"));
  sheet.querySelector("#export-ledger-btn").addEventListener("click", ()=>{
    window.open(`/api/customers/${detail.id}/ledger/export`, "_blank");
  });
  wirePartyLedgerActions(sheet, detail, "customer");
  const toggleActiveCustLink = sheet.querySelector("#toggle-active-cust-link");
  if(toggleActiveCustLink) toggleActiveCustLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    const nextActive = detail.active===0;
    try{
      await api("PATCH", `/customers/${detail.id}/active`, {active: nextActive});
      await loadCustomers();
      closeAllSheets(); renderCustomersList(); renderBillingCustomers();
      toast(nextActive?"Customer reactivated.":"Customer deactivated.", "ok");
    }catch(err){ toast(err.message); }
  });
  const deleteCustLink = sheet.querySelector("#delete-cust-link");
  if(deleteCustLink) deleteCustLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    // Ask the server what this customer carries first, so a linked record is
    // refused here with the real reason rather than after a confirm dialog
    // the user just clicked through — mirrors the product delete flow.
    try{
      const u = await api("GET", `/customers/${detail.id}/usage`);
      if(u.total > 0){
        toast("This Customer cannot be deleted because it is linked to existing transactions. You may deactivate or edit the record instead.");
        return;
      }
    }catch(_){ /* fall back to the plain confirmation; server still enforces the rule */ }
    if(confirm("Delete "+detail.name+"? This can't be undone.")){
      try{
        await api("DELETE", `/customers/${detail.id}`);
        await loadCustomers();
        closeAllSheets(); renderCustomersList(); renderBillingCustomers();
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-customer-detail");
}

/* ============================================================
   SHARED: Party Ledger row rendering + actions (Customers & Suppliers)
   ============================================================ */
function renderPartyLedgerRow(l, partyType, partyId){
  const isReceivable = partyType==="customer";
  const debitLabel = isReceivable ? "invoice" : "purchase";
  if(l.type===debitLabel){
    // Suppliers have two purchase sources (see suppliers.js): the newer
    // multi-line kind (`source:"purchases"`, opens the New Purchase
    // Edit/Void/Delete flow) and the older single-line stock_ins
    // (`source:"stock_in"`, opens the Record Purchase sheet in edit mode).
    let openAttr = "";
    if(isReceivable) openAttr = `data-open-invoice="${l.id}"`;
    else if(l.source==="purchases") openAttr = `data-open-purchase="${l.id}"`;
    else if(l.source==="stock_in") openAttr = `data-open-stock-in="${l.id}" data-product-id="${l.productId||""}"`;
    return `<div class="list-row" ${openAttr} style="cursor:pointer;">
      <div><div class="row-title">${escapeHtml(l.label)}</div><div class="row-sub">${l.date} · ${isReceivable?"Invoice":"Purchase"}</div></div>
      <div class="row-right"><div class="row-title" style="color:var(--danger);">+${fmt(l.amount)}</div><div class="muted" style="font-size:10.5px;">Bal ${fmt(l.runningBalance)}</div></div>
    </div>`;
  }
  if(l.type==="opening_balance"){
    // Sign follows Payable (raises due, red) vs Advance (lowers due, green) —
    // amount is already stored signed the same way a purchase/payment would be.
    const isDebit = l.amount >= 0;
    return `<div class="list-row"><div>
        <div class="row-title">Opening Balance — ${escapeHtml(l.label)}${l.note?" — "+escapeHtml(l.note):""}</div>
        <div class="row-sub">${escapeHtml(l.date)}</div>
      </div>
      <div class="row-right" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <div class="row-title" style="color:${isDebit?"var(--danger)":"var(--ok)"};">${isDebit?"+":""}${fmt(l.amount)}</div>
        <div class="muted" style="font-size:10.5px;">Bal ${fmt(l.runningBalance)}</div>
        ${isOwner() ? `<div style="display:flex;gap:8px;">
          <a href="#" data-edit-opening-balance="${l.id}" class="btn-danger-link" style="font-size:11px;color:var(--navy);">Edit</a>
          <a href="#" data-void-opening-balance="${l.id}" class="btn-danger-link" style="font-size:11px;">Void</a>
        </div>` : ""}
      </div></div>`;
  }
  const subParts = [l.date, l.label];
  if(l.againstInvoiceNo) subParts.push("against "+l.againstInvoiceNo);
  if(l.referenceNo) subParts.push("Ref# "+l.referenceNo);
  if(l.bankName) subParts.push("Bank: "+l.bankName);
  if(l.upiId) subParts.push("UPI: "+l.upiId);
  const verb = isReceivable ? "Payment received" : "Payment made";
  return `<div class="list-row"><div>
      <div class="row-title">${verb}${l.note?" — "+escapeHtml(l.note):""}</div>
      <div class="row-sub">${subParts.map(escapeHtml).join(" · ")}</div>
      ${l.attachmentPath ? `<a href="/api/attachments/${l.attachmentPath}" target="_blank" style="font-size:11px;">📎 ${escapeHtml(l.attachmentName||"Attachment")}</a>` : ""}
    </div>
    <div class="row-right" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
      <div><span class="row-title" style="color:var(--ok);">${fmt(-l.amount)}</span></div>
      <div class="muted" style="font-size:10.5px;">Bal ${fmt(l.runningBalance)}</div>
      <div style="display:flex;gap:8px;">
        <a href="#" data-share-payment-whatsapp="${l.id}" class="btn-danger-link" style="font-size:11px;color:#128c4a;">💬 Share</a>
        <a href="#" data-edit-payment="${l.id}" class="btn-danger-link" style="font-size:11px;color:var(--navy);">Edit</a>
        ${isOwner() ? `<a href="#" data-void-payment="${l.id}" class="btn-danger-link" style="font-size:11px;">Void</a>` : ""}
      </div>
    </div></div>`;
}

function wirePartyLedgerActions(sheet, detail, partyType){
  const base = partyType==="customer" ? "customers" : "suppliers";
  const reopen = partyType==="customer" ? openCustomerDetail : openSupplierDetail;
  const reload = partyType==="customer" ? loadCustomers : loadSuppliers;
  sheet.querySelectorAll("[data-void-payment]").forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      if(confirm("Void this payment? The balance will go back up.")){
        try{
          await api("POST", `/${base}/${detail.id}/payments/${a.dataset.voidPayment}/void`);
          await reload();
          await reopen(detail.id);
          toast("Payment voided.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
  });
  sheet.querySelectorAll("[data-share-payment-whatsapp]").forEach(a=>{
    a.addEventListener("click", (e)=>{
      e.preventDefault();
      const entry = detail.ledger.find(l=>l.type==="payment" && String(l.id)===a.dataset.sharePaymentWhatsapp);
      if(!entry) return;
      const verb = partyType==="customer" ? "Payment received from" : "Payment made to";
      const lines = [
        `Receipt`,
        `${verb} ${detail.name}`,
        `Date: ${entry.date}`,
        `Amount: ${fmt(Math.abs(entry.amount))}`,
        `Mode: ${entry.label}`,
        entry.referenceNo ? `Ref#: ${entry.referenceNo}` : "",
        entry.note ? `Note: ${entry.note}` : ""
      ].filter(Boolean);
      openWhatsApp(detail.phone, lines.join("\n"));
    });
  });
  sheet.querySelectorAll("[data-edit-payment]").forEach(a=>{
    a.addEventListener("click", (e)=>{
      e.preventDefault();
      const entry = detail.ledger.find(l=>l.type==="payment" && String(l.id)===a.dataset.editPayment);
      if(!entry) return;
      if(partyType==="customer") openRecordPayment(detail, entry);
      else openRecordPurchasePayment(detail, entry);
    });
  });
  sheet.querySelectorAll("[data-edit-opening-balance]").forEach(a=>{
    a.addEventListener("click", (e)=>{
      e.preventDefault();
      const entry = detail.ledger.find(l=>l.type==="opening_balance" && String(l.id)===a.dataset.editOpeningBalance);
      if(!entry) return;
      if(partyType==="customer") openCustomerOpeningBalance(detail, entry);
      else openSupplierOpeningBalance(detail, entry);
    });
  });
  sheet.querySelectorAll("[data-void-opening-balance]").forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      if(confirm("Void this opening balance entry? The due will be reversed back.")){
        try{
          await api("POST", `/${base}/${detail.id}/opening-balance/${a.dataset.voidOpeningBalance}/void`);
          await reload();
          await reopen(detail.id);
          toast("Opening balance voided.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
  });
}

/** Opens a formatted print view of the ledger in a new tab and triggers Browser Print. */
function printPartyLedger(detail, partyLabel){
  const rows = [...detail.ledger].reverse();
  const isReceivable = partyLabel==="Customer";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(detail.name)} — Ledger</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
      .totals{margin-top:10px;font-size:12px;}
      /* This opens as its own blank browser tab (window.open), so it needs
         its own way back — there's no app header/nav here to fall back on.
         Hidden on the printed page itself; only shown on screen. */
      .back-link{display:inline-block;margin-bottom:12px;font-size:12px;color:#1e2a4a;text-decoration:none;}
      @media print{ .back-link{display:none;} }
    </style></head><body>
    <a href="#" class="back-link" onclick="window.close();return false;">&larr; Back to Home</a>
    <h1>${escapeHtml(detail.name)} — Party Ledger</h1>
    <div class="sub">${partyLabel} · ${detail.phone?escapeHtml(detail.phone):""}${detail.gst?" · GST "+escapeHtml(detail.gst):""}</div>
    <table><thead><tr><th>Date</th><th>Type</th><th>Invoice No</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th><th>Remarks</th></tr></thead>
    <tbody>${rows.map(l=>{
      const debitType = isReceivable ? "invoice" : "purchase";
      const isDebit = l.type===debitType;
      return `<tr><td>${l.date}</td><td>${isDebit?(isReceivable?"Invoice":"Purchase"):"Payment"}</td><td>${escapeHtml(l.label||"")}</td>
        <td class="num">${isDebit?fmt(l.amount):""}</td><td class="num">${isDebit?"":fmt(-l.amount)}</td>
        <td class="num">${fmt(l.runningBalance)}</td><td>${escapeHtml(l.note||"")}</td></tr>`;
    }).join("")}</tbody></table>
    <div class="totals">
      ${isReceivable ? `Total Sales: ${fmt(detail.totalSales)} &nbsp; Total Received: ${fmt(detail.totalPaymentReceived)} &nbsp; <strong>Outstanding Receivable: ${fmt(detail.outstandingReceivable)}</strong>`
        : `Total Purchases: ${fmt(detail.totalPurchases)} &nbsp; Total Paid: ${fmt(detail.totalPaymentPaid)} &nbsp; <strong>Outstanding Payable: ${fmt(detail.outstandingPayable)}</strong>`}
    </div>
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}

/** Reads a <input type=file> into {filename, mimeType, dataBase64} for the payment attachment field, or null if empty. */
function readAttachmentInput(inputEl){
  return new Promise((resolve, reject)=>{
    const file = inputEl && inputEl.files && inputEl.files[0];
    if(!file){ resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.slice(dataUrl.indexOf(",")+1);
      resolve({ filename: file.name, mimeType: file.type, dataBase64: base64 });
    };
    reader.onerror = () => reject(new Error("Could not read the attached file."));
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   SHEET: Quick Payment — dashboard shortcut that jumps straight to
   Record Payment (Sale or Purchase) without going through the full
   Customer/Supplier detail screen first.
   ============================================================ */
let quickPaymentMode = "sale"; // "sale" | "purchase"
async function openQuickPayment(){
  quickPaymentMode = "sale";
  await Promise.all([loadCustomers(), loadSuppliers()]);
  renderQuickPayment();
  showSheet("sheet-quick-payment");
}
function renderQuickPayment(){
  const sheet = document.getElementById("sheet-quick-payment");
  const isSale = quickPaymentMode === "sale";
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">Record Payment</div>
    <div class="chip-row" id="qp-mode-chips" style="margin-bottom:10px;">
      <button class="chip ${isSale?'selected':''}" data-qp-mode="sale">Sale Payment — from customer</button>
      <button class="chip ${!isSale?'selected':''}" data-qp-mode="purchase">Purchase Payment — to supplier</button>
    </div>
    <div class="searchbar">
      <span>&#128269;</span><input type="text" id="qp-search" placeholder="Search ${isSale?"customer":"supplier"} by name or phone">
    </div>
    <div class="card" id="qp-results" style="max-height:340px;overflow-y:auto;margin-top:8px;"></div>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-qp-mode]").forEach(b=>b.addEventListener("click", ()=>{
    quickPaymentMode = b.dataset.qpMode;
    renderQuickPayment();
  }));
  sheet.querySelector("#qp-search").addEventListener("input", renderQuickPaymentResults);
  renderQuickPaymentResults();
}
function renderQuickPaymentResults(){
  const isSale = quickPaymentMode === "sale";
  const q = (document.getElementById("qp-search").value||"").toLowerCase();
  let list = isSale ? state.customers : state.suppliers;
  if(q) list = list.filter(p=>p.name.toLowerCase().includes(q) || (p.phone||"").includes(q));
  const results = document.getElementById("qp-results");
  results.innerHTML = list.length ? list.map(p=>`
    <div class="list-row" data-qp-pick="${p.id}" style="cursor:pointer;">
      <div class="avatar" style="width:34px;height:34px;font-size:12px;">${initials(p.name)}</div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.phone||"")}</div></div>
      <div class="row-right ${p.due>0?'':'muted'}" style="font-weight:800;${p.due>0?'color:var(--danger);':''}">${fmt(p.due)}</div>
    </div>
  `).join("") : `<div class="empty-hint">No ${isSale?"customers":"suppliers"} found${q?` matching "${escapeHtml(q)}"`:""}.</div>`;
  results.querySelectorAll("[data-qp-pick]").forEach(el=>{
    el.addEventListener("click", async ()=>{
      const id = el.dataset.qpPick;
      try{
        const detail = await api("GET", `/${isSale?"customers":"suppliers"}/${id}`);
        closeAllSheets();
        if(isSale) openRecordPayment(detail);
        else openRecordPurchasePayment(detail);
      }catch(err){ toast(err.message); }
    });
  });
}

/* ============================================================
   SHEET: Sale Payment (against customer due)
   ============================================================ */
const PAYMENT_MODES = ["Cash","UPI","Bank Transfer","Cheque","Credit Card","Other"];

/** Shared by Sale Payment / Purchase Payment / Bank Entry sheets — a bank
 *  account chip row that only matters once the Payment Mode isn't Cash, and
 *  which the payment auto-posts into (see server/bankLink.js). */
function bankAccountChipsHtml(prefix, selectedId){
  const accounts = (state.bankAccounts||[]).filter(a=>a.active);
  return `
    <label class="field-label" id="${prefix}-label" style="display:none;">Bank Account</label>
    <div class="chip-row" id="${prefix}-chips" style="display:none;">
      ${accounts.length ? accounts.map((a,i)=>`<button class="chip ${selectedId?(selectedId===a.id?'selected':''):(i===0?'selected':'')}" data-bankacct="${a.id}">${escapeHtml(a.name)}</button>`).join("")
        : `<span class="muted" style="font-size:12px;">No bank accounts yet — add one from Bank Book.</span>`}
    </div>
  `;
}
function toggleBankAccountChips(sheet, prefix, method){
  const show = method !== "Cash";
  const label = sheet.querySelector(`#${prefix}-label`);
  const chips = sheet.querySelector(`#${prefix}-chips`);
  if(label) label.style.display = show ? "" : "none";
  if(chips) chips.style.display = show ? "" : "none";
}
function wireBankAccountChips(sheet, prefix){
  sheet.querySelectorAll(`#${prefix}-chips [data-bankacct]`).forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll(`#${prefix}-chips [data-bankacct]`).forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected");
  }));
}
function getSelectedBankAccountId(sheet, prefix){
  const sel = sheet.querySelector(`#${prefix}-chips [data-bankacct].selected`);
  return sel ? sel.dataset.bankacct : null;
}

/** `editEntry` is a ledger entry (type:"payment") to edit in place, or omitted for a new payment. */
function openRecordPayment(customer, editEntry){
  const sheet = document.getElementById("sheet-record-payment");
  const today = new Date().toISOString().slice(0,10);
  const e = editEntry;
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${e?"Edit Sale Payment":"Sale Payment"}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(customer.name)} · Due: ${fmt(customer.due)}</div>
    <label class="field-label">Date</label>
    <input type="date" id="rp-date" value="${e?e.date:today}">
    <label class="field-label">Against Sales Invoice <span class="muted" style="font-weight:400;">— optional, leave blank for a general payment</span></label>
    <select id="rp-invoice" ${e?"disabled":""}>
      <option value="">— General payment (not tied to one invoice) —</option>
      ${customer.history.map(h=>`<option value="${h.id}" ${e&&e.againstInvoiceNo===h.challan_no?"selected":""}>${escapeHtml(h.challan_no)} · ${h.date} · ${fmt(h.total)}</option>`).join("")}
    </select>
    <label class="field-label">Amount received (₹)</label>
    <input type="number" id="rp-amount" min="0" value="${e?Math.abs(e.amount):customer.due}">
    <label class="field-label">Payment Mode</label>
    <div class="chip-row" id="rp-method-chips">
      ${PAYMENT_MODES.map((m,i)=>`<button class="chip ${(e?e.label===m:i===0)?'selected':''}" data-method="${m}">${m}</button>`).join("")}
    </div>
    ${bankAccountChipsHtml("rp-bankacct", e?e.bankAccountId:null)}
    <label class="field-label">Bank Name <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="rp-bank" value="${escapeHtml(e?e.bankName||"":"")}" placeholder="e.g. HDFC Bank">
    <label class="field-label">UPI ID <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="rp-upi" value="${escapeHtml(e?e.upiId||"":"")}" placeholder="e.g. shop@okhdfcbank">
    <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional, e.g. cheque, UTR or UPI transaction id</span></label>
    <input type="text" id="rp-reference" value="${escapeHtml(e?e.referenceNo||"":"")}" placeholder="e.g. 000123 or UPI txn id">
    <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional, receipt/cheque photo or screenshot</span></label>
    <input type="file" id="rp-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    ${e&&e.attachmentPath ? `<div class="muted" style="font-size:11px;margin-top:2px;">Current: <a href="/api/attachments/${e.attachmentPath}" target="_blank">${escapeHtml(e.attachmentName||"attachment")}</a> — choose a new file to replace it.</div>` : ""}
    <label class="field-label">Remarks (optional)</label>
    <input type="text" id="rp-note" value="${escapeHtml(e?e.note||"":"")}" placeholder="e.g. Advance against next order">
    <button class="btn btn-primary" id="rp-save" style="margin-top:16px;">${e?"Update Payment":"Save Payment"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-method]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-method]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
    toggleBankAccountChips(sheet, "rp-bankacct", b.dataset.method);
  }));
  toggleBankAccountChips(sheet, "rp-bankacct", sheet.querySelector("[data-method].selected").dataset.method);
  wireBankAccountChips(sheet, "rp-bankacct");
  sheet.querySelector("#rp-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("rp-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
    const method = sheet.querySelector("[data-method].selected").dataset.method;
    const bankAccountId = getSelectedBankAccountId(sheet, "rp-bankacct");
    if(method!=="Cash" && !bankAccountId){ toast("Choose a bank account for this payment mode."); return; }
    const btn = document.getElementById("rp-save");
    btn.disabled = true;
    try{
      const attachment = await readAttachmentInput(document.getElementById("rp-attachment"));
      const body = {
        amount, method,
        date: document.getElementById("rp-date").value,
        referenceNo: document.getElementById("rp-reference").value.trim(),
        bankName: document.getElementById("rp-bank").value.trim(),
        upiId: document.getElementById("rp-upi").value.trim(),
        note: document.getElementById("rp-note").value.trim(),
        bankAccountId: method==="Cash" ? null : bankAccountId,
        attachment
      };
      if(e) await api("PUT", `/customers/${customer.id}/payments/${e.id}`, body);
      else await api("POST", `/customers/${customer.id}/payments`, { ...body, invoiceId: document.getElementById("rp-invoice").value || null });
      await loadCustomers();
      closeAllSheets();
      await openCustomerDetail(customer.id);
      toast(e?"Payment updated.":"Payment recorded.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });
  showSheet("sheet-record-payment");
}

/* ============================================================
   SHEET: Customer Opening Balance — mirrors openSupplierOpeningBalance
   below, for the Debtor side. Receivable raises due, Advance lowers it.
   ============================================================ */
/** `editEntry` is a ledger entry (type:"opening_balance") to edit in place, or omitted for a new one. */
function openCustomerOpeningBalance(customer, editEntry){
  const sheet = document.getElementById("sheet-customer-opening-balance");
  const e = editEntry;
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${e?"Edit Opening Outstanding":"Customer Opening Outstanding"}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(customer.name)} · Current Due: ${fmt(customer.due)}</div>
    <label class="field-label">Opening Date</label>
    <input type="date" id="cob-date" value="${e?e.date:todayISO()}">
    <label class="field-label">Opening Outstanding Amount (₹)</label>
    <input type="number" inputmode="decimal" step="any" min="0" id="cob-amount" value="${e?Math.abs(e.amount):""}" placeholder="0">
    <label class="field-label">Type</label>
    <div class="chip-row" id="cob-type-chips">
      <button class="chip ${(e?e.label==="Receivable":true)?'selected':''}" data-cob-type="Receivable">Receivable (Debit)</button>
      <button class="chip ${e&&e.label==="Advance"?'selected':''}" data-cob-type="Advance">Advance</button>
    </div>
    <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="cob-remarks" value="${escapeHtml(e?e.note||"":"")}" placeholder="e.g. Carried forward from previous system">
    <button class="btn btn-primary" id="cob-save" style="margin-top:16px;">${e?"Update Opening Outstanding":"Save Opening Outstanding"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-cob-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-cob-type]").forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected");
  }));
  sheet.querySelector("#cob-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("cob-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid opening balance amount."); return; }
    const btn = document.getElementById("cob-save");
    btn.disabled = true;
    try{
      const body = {
        date: document.getElementById("cob-date").value,
        amount, balanceType: sheet.querySelector("[data-cob-type].selected").dataset.cobType,
        remarks: document.getElementById("cob-remarks").value.trim()
      };
      if(e) await api("PUT", `/customers/${customer.id}/opening-balance/${e.id}`, body);
      else await api("POST", `/customers/${customer.id}/opening-balance`, body);
      await loadCustomers();
      closeAllSheets();
      await openCustomerDetail(customer.id);
      toast(e?"Opening outstanding updated.":"Opening outstanding saved.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });
  showSheet("sheet-customer-opening-balance");
}

/* ============================================================
   SHEET: Supplier Detail (ledger + Purchase Payment)
   ============================================================ */
async function openSupplierDetail(supplierId){
  const [detail, pos, purchaseReturns] = await Promise.all([
    api("GET", `/suppliers/${supplierId}`),
    api("GET", `/purchase-orders?supplierId=${supplierId}`),
    api("GET", `/purchase-returns?supplierId=${supplierId}`)
  ]);
  const sheet = document.getElementById("sheet-supplier-detail");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(detail.name)} ${detail.active===0?'<span class="pill">Inactive</span>':''}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(detail.phone||"")}${detail.gst?" · GST "+escapeHtml(detail.gst):""}${detail.state?" · "+escapeHtml(detail.state):""}${detail.address?"<br>"+escapeHtml(detail.address):""}</div>
    <div class="stat-grid">
      <div class="stat-card plain"><div class="label">Total Purchases</div><div class="value">${fmt(detail.totalPurchases)}</div></div>
      <div class="stat-card plain"><div class="label">Total Paid</div><div class="value">${fmt(detail.totalPaymentPaid)}</div></div>
      <div class="stat-card plain"><div class="label">Outstanding Due</div><div class="value red">${fmt(detail.outstandingPayable)}</div></div>
    </div>
    <div class="action-row" style="margin-top:10px;">
      <button class="btn btn-outline" id="edit-supplier-btn">✎ Edit</button>
      ${detail.due>0 ? `<button class="btn btn-gold" id="record-purchase-payment-btn">Purchase Payment</button>` : ""}
      ${detail.phone ? `<button class="btn btn-outline" id="wa-chat-cust-btn">💬 Chat on WhatsApp</button>` : ""}
      <button class="btn btn-outline" id="print-ledger-btn">Print Ledger</button>
      <button class="btn btn-outline" id="export-ledger-btn">Export Excel</button>
      ${isOwner() ? `<button class="btn btn-outline" id="opening-balance-btn">Opening Outstanding</button>` : ""}
    </div>
    ${pos.length ? `
    <div class="section-title">Purchase Orders</div>
    <div class="card">${pos.map(po=>`
      <div class="list-row" data-open-po="${po.id}" style="cursor:pointer;">
        <div><div class="row-title">${escapeHtml(po.po_no)}</div><div class="row-sub">${po.date}</div></div>
        <div class="row-right"><div class="row-title">${fmt(po.total)}</div><span class="pill ${PO_STATUS_PILL[po.status]||''}">${escapeHtml(po.status)}</span></div>
      </div>`).join("")}
    </div>` : ""}
    ${purchaseReturns.length ? `
    <div class="section-title">Purchase Returns</div>
    <div class="card">${purchaseReturns.map(pr=>`
      <div class="list-row" data-open-purchase-return="${pr.id}" style="cursor:pointer;">
        <div><div class="row-title">${escapeHtml(pr.return_no)}</div><div class="row-sub">${pr.date}${pr.voided?" · Voided":""}</div></div>
        <div class="row-right row-title">${fmt(pr.total)}</div>
      </div>`).join("")}
    </div>` : ""}
    <div class="section-title">Ledger</div>
    <div class="card">${detail.ledger.length ? detail.ledger.map(l=>renderPartyLedgerRow(l,"supplier",detail.id)).join("") : `<div class="empty-hint">No activity yet.</div>`}</div>
    ${isOwner() ? `<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;align-items:center;">
      <a href="#" id="toggle-active-supplier-link">${detail.active===0?"Reactivate this supplier":"Deactivate this supplier"}</a>
      <a href="#" id="delete-supplier-link" class="btn-danger-link">Delete this supplier</a>
    </div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#edit-supplier-btn").addEventListener("click", ()=>{ closeAllSheets(); openAddSupplier(detail); });
  const recordPaymentBtn = sheet.querySelector("#record-purchase-payment-btn");
  if(recordPaymentBtn) recordPaymentBtn.addEventListener("click", ()=>openRecordPurchasePayment(detail));
  const waChatCustBtn = sheet.querySelector("#wa-chat-cust-btn");
  if(waChatCustBtn) waChatCustBtn.addEventListener("click", ()=>openWhatsApp(detail.phone));
  const openingBalanceBtn = sheet.querySelector("#opening-balance-btn");
  if(openingBalanceBtn) openingBalanceBtn.addEventListener("click", ()=>openSupplierOpeningBalance(detail));
  sheet.querySelector("#print-ledger-btn").addEventListener("click", ()=>printPartyLedger(detail,"Supplier"));
  sheet.querySelector("#export-ledger-btn").addEventListener("click", ()=>{
    window.open(`/api/suppliers/${detail.id}/ledger/export`, "_blank");
  });
  sheet.querySelectorAll("[data-open-po]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openPoDetail(el.dataset.openPo); });
  });
  wirePartyLedgerActions(sheet, detail, "supplier");
  sheet.querySelectorAll("[data-open-purchase]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openPurchaseDetail(el.dataset.openPurchase); });
  });
  sheet.querySelectorAll("[data-open-purchase-return]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openPurchaseReturnDetail(el.dataset.openPurchaseReturn); });
  });
  sheet.querySelectorAll("[data-open-stock-in]").forEach(el=>{
    el.addEventListener("click", async ()=>{
      const productId = el.dataset.productId;
      if(!productId){ toast("That product no longer exists — can't open this purchase."); return; }
      try{
        await loadProducts();
        const product = state.products.find(x=>x.id===productId);
        if(!product){ toast("That product no longer exists — can't open this purchase."); return; }
        const si = await api("GET", `/products/${productId}/stock-in/${el.dataset.openStockIn}`);
        closeAllSheets();
        openStockIn(product, si);
      }catch(err){ toast(err.message); }
    });
  });
  const toggleActiveSupplierLink = sheet.querySelector("#toggle-active-supplier-link");
  if(toggleActiveSupplierLink) toggleActiveSupplierLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    const nextActive = detail.active===0;
    try{
      await api("PATCH", `/suppliers/${detail.id}/active`, {active: nextActive});
      await loadSuppliers();
      closeAllSheets(); renderSuppliersList();
      toast(nextActive?"Supplier reactivated.":"Supplier deactivated.", "ok");
    }catch(err){ toast(err.message); }
  });
  const deleteSupplierLink = sheet.querySelector("#delete-supplier-link");
  if(deleteSupplierLink) deleteSupplierLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    try{
      const u = await api("GET", `/suppliers/${detail.id}/usage`);
      if(u.total > 0){
        toast("This Supplier cannot be deleted because it is linked to existing transactions. You may deactivate or edit the record instead.");
        return;
      }
    }catch(_){ /* fall back to the plain confirmation; server still enforces the rule */ }
    if(confirm("Delete "+detail.name+"? This can't be undone.")){
      try{
        await api("DELETE", `/suppliers/${detail.id}`);
        await loadSuppliers();
        closeAllSheets(); renderSuppliersList();
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-supplier-detail");
}

/* ============================================================
   SHEET: Purchase Payment (against supplier due)
   ============================================================ */
/** `editEntry` is a ledger entry (type:"payment") to edit in place, or omitted for a new payment. */
function openRecordPurchasePayment(supplier, editEntry){
  const sheet = document.getElementById("sheet-record-purchase-payment");
  const today = new Date().toISOString().slice(0,10);
  const e = editEntry;
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${e?"Edit Purchase Payment":"Purchase Payment"}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(supplier.name)} · Due: ${fmt(supplier.due)}</div>
    <label class="field-label">Date</label>
    <input type="date" id="pp-date" value="${e?e.date:today}">
    <label class="field-label">Against Purchase Invoice <span class="muted" style="font-weight:400;">— optional, leave blank for a general payment</span></label>
    <select id="pp-stockin" ${e?"disabled":""}>
      <option value="">— General payment (not tied to one purchase) —</option>
      ${supplier.history.map(h=>`<option value="${h.id}" ${e&&e.againstInvoiceNo===(h.invoice_no||h.product_name)?"selected":""}>${escapeHtml(h.invoice_no||h.product_name)} · ${h.date} · ${fmt(h.total)}</option>`).join("")}
    </select>
    <label class="field-label">Amount paid (₹)</label>
    <input type="number" id="pp-amount" min="0" value="${e?Math.abs(e.amount):supplier.due}">
    <label class="field-label">Payment Mode</label>
    <div class="chip-row" id="pp-method-chips">
      ${PAYMENT_MODES.map((m,i)=>`<button class="chip ${(e?e.label===m:i===0)?'selected':''}" data-method="${m}">${m}</button>`).join("")}
    </div>
    ${bankAccountChipsHtml("pp-bankacct", e?e.bankAccountId:null)}
    <label class="field-label">Bank Name <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="pp-bank" value="${escapeHtml(e?e.bankName||"":"")}" placeholder="e.g. HDFC Bank">
    <label class="field-label">UPI ID <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="pp-upi" value="${escapeHtml(e?e.upiId||"":"")}" placeholder="e.g. shop@okhdfcbank">
    <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional, e.g. cheque, UTR or UPI transaction id</span></label>
    <input type="text" id="pp-reference" value="${escapeHtml(e?e.referenceNo||"":"")}" placeholder="e.g. 000123 or UPI txn id">
    <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional, receipt/cheque photo or screenshot</span></label>
    <input type="file" id="pp-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    ${e&&e.attachmentPath ? `<div class="muted" style="font-size:11px;margin-top:2px;">Current: <a href="/api/attachments/${e.attachmentPath}" target="_blank">${escapeHtml(e.attachmentName||"attachment")}</a> — choose a new file to replace it.</div>` : ""}
    <label class="field-label">Remarks (optional)</label>
    <input type="text" id="pp-note" value="${escapeHtml(e?e.note||"":"")}" placeholder="e.g. Part payment against May bill">
    <button class="btn btn-primary" id="pp-save" style="margin-top:16px;">${e?"Update Payment":"Save Payment"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-method]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-method]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
    toggleBankAccountChips(sheet, "pp-bankacct", b.dataset.method);
  }));
  toggleBankAccountChips(sheet, "pp-bankacct", sheet.querySelector("[data-method].selected").dataset.method);
  wireBankAccountChips(sheet, "pp-bankacct");
  sheet.querySelector("#pp-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("pp-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
    const method = sheet.querySelector("[data-method].selected").dataset.method;
    const bankAccountId = getSelectedBankAccountId(sheet, "pp-bankacct");
    if(method!=="Cash" && !bankAccountId){ toast("Choose a bank account for this payment mode."); return; }
    const btn = document.getElementById("pp-save");
    btn.disabled = true;
    try{
      const attachment = await readAttachmentInput(document.getElementById("pp-attachment"));
      const body = {
        amount, method,
        date: document.getElementById("pp-date").value,
        referenceNo: document.getElementById("pp-reference").value.trim(),
        bankName: document.getElementById("pp-bank").value.trim(),
        upiId: document.getElementById("pp-upi").value.trim(),
        note: document.getElementById("pp-note").value.trim(),
        bankAccountId: method==="Cash" ? null : bankAccountId,
        attachment
      };
      if(e) await api("PUT", `/suppliers/${supplier.id}/payments/${e.id}`, body);
      else await api("POST", `/suppliers/${supplier.id}/payments`, { ...body, stockInId: document.getElementById("pp-stockin").value || null });
      await loadSuppliers();
      closeAllSheets();
      await openSupplierDetail(supplier.id);
      toast(e?"Payment updated.":"Payment recorded.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });
  showSheet("sheet-record-purchase-payment");
}

/* ============================================================
   SHEET: Supplier Opening Balance — a starting Payable/Advance for a
   supplier just added to the system with an existing real-world balance.
   Feeds straight into the same due/ledger/Total Payables/Dashboard figures
   a real purchase or payment already does.
   ============================================================ */
/** `editEntry` is a ledger entry (type:"opening_balance") to edit in place, or omitted for a new one. */
function openSupplierOpeningBalance(supplier, editEntry){
  const sheet = document.getElementById("sheet-supplier-opening-balance");
  const e = editEntry;
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${e?"Edit Opening Outstanding":"Supplier Opening Outstanding"}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(supplier.name)} · Current Due: ${fmt(supplier.due)}</div>
    <label class="field-label">Opening Date</label>
    <input type="date" id="sob-date" value="${e?e.date:todayISO()}">
    <label class="field-label">Opening Outstanding Amount (₹)</label>
    <input type="number" inputmode="decimal" step="any" min="0" id="sob-amount" value="${e?Math.abs(e.amount):""}" placeholder="0">
    <label class="field-label">Type</label>
    <div class="chip-row" id="sob-type-chips">
      <button class="chip ${(e?e.label==="Payable":true)?'selected':''}" data-sob-type="Payable">Payable (Credit)</button>
      <button class="chip ${e&&e.label==="Advance"?'selected':''}" data-sob-type="Advance">Advance</button>
    </div>
    <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="sob-remarks" value="${escapeHtml(e?e.note||"":"")}" placeholder="e.g. Carried forward from previous system">
    <button class="btn btn-primary" id="sob-save" style="margin-top:16px;">${e?"Update Opening Outstanding":"Save Opening Outstanding"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-sob-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-sob-type]").forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected");
  }));
  sheet.querySelector("#sob-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("sob-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid opening balance amount."); return; }
    const btn = document.getElementById("sob-save");
    btn.disabled = true;
    try{
      const body = {
        date: document.getElementById("sob-date").value,
        amount, balanceType: sheet.querySelector("[data-sob-type].selected").dataset.sobType,
        remarks: document.getElementById("sob-remarks").value.trim()
      };
      if(e) await api("PUT", `/suppliers/${supplier.id}/opening-balance/${e.id}`, body);
      else await api("POST", `/suppliers/${supplier.id}/opening-balance`, body);
      await loadSuppliers();
      closeAllSheets();
      await openSupplierDetail(supplier.id);
      toast(e?"Opening outstanding updated.":"Opening outstanding saved.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });
  showSheet("sheet-supplier-opening-balance");
}

/* ============================================================
   SHEET: Add Supplier
   ============================================================ */
/** One form serves both "New Supplier" and "Edit Supplier" — `editing` is the
 *  existing supplier row to prefill and PUT back, or omitted for a new one. */
function openAddSupplier(editing){
  const sheet = document.getElementById("sheet-add-supplier");
  const gstType = editing ? editing.gst_type : "CGST_SGST";
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${editing ? "Edit Supplier" : "New Supplier"}</div>
    <label class="field-label">Name</label><input type="text" id="ns-name" value="${editing?escapeHtml(editing.name):""}">
    <label class="field-label">Phone</label><input type="tel" id="ns-phone" value="${editing?escapeHtml(editing.phone||""):""}">
    <label class="field-label">Address</label><textarea id="ns-address" rows="2">${editing?escapeHtml(editing.address||""):""}</textarea>
    <label class="field-label">State (for GST)</label>
    <select id="ns-state"><option value="">${state.settings.state ? "Same as shop ("+escapeHtml(state.settings.state)+")" : "Select state"}</option>${INDIAN_STATES.map(s=>`<option value="${s}" ${editing&&editing.state===s?'selected':''}>${s}</option>`).join("")}</select>
    <label class="field-label">GST Type</label>
    <div class="chip-row" id="ns-gsttype-chips">
      <button class="chip ${gstType==="CGST_SGST"?'selected':''}" data-gsttype="CGST_SGST">CGST + SGST (9% + 9%)</button>
      <button class="chip ${gstType==="IGST"?'selected':''}" data-gsttype="IGST">IGST (18%)</button>
    </div>
    <label class="field-label">GSTIN (optional)</label><input type="text" id="ns-gst" value="${editing?escapeHtml(editing.gst||""):""}">
    ${!editing && isOwner() ? `
    <div class="section-title" style="margin-top:16px;">Opening Outstanding <span class="muted" style="font-weight:400;">— optional, owner only, set once when adding the supplier</span></div>
    <label class="field-label">Opening Outstanding Amount (₹)</label>
    <input type="number" inputmode="decimal" step="any" min="0" id="ns-opening-amount" placeholder="0">
    <label class="field-label">Type</label>
    <div class="chip-row" id="ns-opening-type-chips">
      <button class="chip selected" data-ns-opening-type="Payable">Payable (Credit)</button>
      <button class="chip" data-ns-opening-type="Advance">Advance</button>
    </div>
    <label class="field-label">Opening Date</label>
    <input type="date" id="ns-opening-date" value="${todayISO()}">
    <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="ns-opening-remarks" placeholder="e.g. Carried forward from previous system">
    ` : ""}
    <button class="btn btn-primary" id="ns-save" style="margin-top:16px;">${editing?"Update Supplier":"Save Supplier"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-gsttype]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-gsttype]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelectorAll("[data-ns-opening-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-ns-opening-type]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#ns-save").addEventListener("click", async ()=>{
    const name = document.getElementById("ns-name").value.trim();
    if(!name){ toast("Supplier name is required."); return; }
    const openingAmountEl = document.getElementById("ns-opening-amount");
    const payload = {
      name, phone: document.getElementById("ns-phone").value.trim(),
      address: document.getElementById("ns-address").value.trim(),
      gst: document.getElementById("ns-gst").value.trim(),
      state: document.getElementById("ns-state").value || state.settings.state,
      gstType: sheet.querySelector("[data-gsttype].selected").dataset.gsttype
    };
    if(openingAmountEl && parseFloat(openingAmountEl.value)>0){
      payload.openingBalance = parseFloat(openingAmountEl.value);
      payload.openingBalanceType = sheet.querySelector("[data-ns-opening-type].selected").dataset.nsOpeningType;
      payload.openingDate = document.getElementById("ns-opening-date").value;
      payload.openingRemarks = document.getElementById("ns-opening-remarks").value.trim();
    }
    try{
      if(editing) await api("PUT", `/suppliers/${editing.id}`, payload);
      else await api("POST","/suppliers", payload);
      await loadSuppliers();
      closeAllSheets(); renderSuppliersList();
      toast(editing ? "Supplier updated." : "Supplier added.", "ok");
    }catch(err){ toast(err.message); }
  });
  showSheet("sheet-add-supplier");
}

/* ============================================================
   SHEETS: Add Product
   ============================================================ */
const UNIT_OPTIONS = ["Sheet","Piece","Sq.ft","Sq.mtr","Cu.mtr","Running ft"];

/**
 * One form serves both "New Product" and "Edit Product". Editing shares every
 * field and validation rule with creation, so a corrected product can never end
 * up in a shape that creation would have rejected.
 * Pass a product to edit it; pass nothing to create.
 */
function openProductForm(context, product){
  state.ctx.editingProductId = product ? product.id : null;
  // `id` is carried along for existing sizes so the server can update the
  // row in place (see PUT /products/:id) rather than delete-and-reinsert,
  // which would otherwise sever the link a past sale/purchase keeps to it.
  state.ctx.addProductSizes = product && product.sizes.length
    ? product.sizes.map(s=>({id:s.id, label:s.label, price:s.price, stock:s.stock}))
    : [{label:"", price:"", stock:0}];
  renderAddProductSheet(context);
  showSheet("sheet-add-product");
}
/* Kept as a thin alias so existing "+" buttons keep working. */
function openAddProduct(context){ openProductForm(context, null); }

function renderAddProductSheet(context){
  const sheet = document.getElementById("sheet-add-product");
  const sizes = state.ctx.addProductSizes;
  const editing = state.ctx.editingProductId
    ? state.products.find(p=>p.id===state.ctx.editingProductId)
    : null;
  const v = (field, fallback) => editing ? escapeHtml(String(editing[field] ?? "")) : (fallback ?? "");
  const curMode = editing ? Pricing.normaliseMode(editing.default_mode) : Pricing.MODE_KEYS[0];
  const curUnit = editing && editing.unit ? editing.unit : UNIT_OPTIONS[0];

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${editing ? "Edit Product" : "New Product"}</div>
    ${editing ? `<div class="muted" style="font-size:11.5px;margin-bottom:8px;">SKU ${escapeHtml(editing.sku||"")} · changes apply to future bills only — past invoices keep the price they were issued at.</div>` : ""}
    <label class="field-label">Product name</label><input type="text" id="np-name" value="${v("name")}">
    <label class="field-label">Product Code <span class="muted" style="font-weight:400;">— printed on invoices, e.g. LV-888-CAA</span></label><input type="text" id="np-code" value="${v("code")}">
    <label class="field-label">Brand</label><input type="text" id="np-brand" value="${v("brand")}">
    <label class="field-label">Category</label><input type="text" id="np-category" value="${v("category")}" placeholder="Plywood, Laminate, MDF, Veneer…">
    <label class="field-label">Unit of measure</label>
    <div class="chip-row" id="np-unit-chips">
      ${UNIT_OPTIONS.map(u=>`<button class="chip ${u===curUnit?'selected':''}" data-unit="${u}">${u}</button>`).join("")}
    </div>
    <label class="field-label">HSN Code</label><input type="text" id="np-hsn" value="${v("hsn_code")}" placeholder="e.g. 4412">
    <label class="field-label">GST %</label><input type="number" id="np-gst" value="${editing ? editing.gst : 18}">

    <label class="field-label">Default billing mode</label>
    <div class="chip-row" id="np-mode-chips">
      ${Pricing.MODE_KEYS.map(k=>`<button class="chip ${k===curMode?'selected':''}" data-mode="${k}" title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>`).join("")}
    </div>
    <label class="field-label">Standard size <span class="muted" style="font-weight:400;">— pre-filled on every bill, still editable there</span></label>
    <div class="charge-grid" id="np-dims"></div>
    <label class="field-label">Size / variant, stock &amp; price <span class="muted" style="font-weight:400;">— every size keeps its own stock count</span></label>
    <div id="np-sizes"></div>
    <a href="#" id="np-add-size" style="font-size:12px;font-weight:700;">+ Add another size</a>
    ${editing ? `<p class="muted" style="font-size:11px;margin-top:8px;">Correcting a miscount here is fine. For goods actually received, use “Record Stock In” so the purchase is kept in the history.</p>` : ""}
    <label class="field-label">Godown / Rack</label><input type="text" id="np-godown" placeholder="e.g. Godown A / R3" value="${v("godown")}">
    <button class="btn btn-primary" id="np-save" style="margin-top:16px;">${editing ? "Update Product" : "Save Product"}</button>
  `;
  function renderSizes(){
    document.getElementById("np-sizes").innerHTML = sizes.map((s,i)=>`
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
        <input type="text" placeholder="Label (e.g. 8x4 ft)" value="${escapeHtml(s.label)}" data-size-label="${i}" style="flex:1.4;">
        <input type="number" placeholder="Stock" min="0" value="${s.stock ?? 0}" data-size-stock="${i}" style="width:64px;" title="Stock">
        <input type="number" placeholder="Price" value="${s.price}" data-size-price="${i}" style="width:80px;" title="Price">
        ${sizes.length>1?`<a href="#" data-size-remove="${i}" class="btn-danger-link">✕</a>`:""}
      </div>`).join("");
    document.querySelectorAll("[data-size-label]").forEach(inp=>inp.addEventListener("input", e=>sizes[e.target.dataset.sizeLabel].label=e.target.value));
    document.querySelectorAll("[data-size-stock]").forEach(inp=>inp.addEventListener("input", e=>sizes[e.target.dataset.sizeStock].stock=e.target.value));
    document.querySelectorAll("[data-size-price]").forEach(inp=>inp.addEventListener("input", e=>sizes[e.target.dataset.sizePrice].price=e.target.value));
    document.querySelectorAll("[data-size-remove]").forEach(a=>a.addEventListener("click", e=>{ e.preventDefault(); sizes.splice(e.target.dataset.sizeRemove,1); renderSizes(); }));
  }
  // Only the dimension boxes the chosen mode actually consumes are shown, and
  // they carry the trade's units (inches for CFT width/thickness, feet else).
  function renderDims(){
    const mode = sheet.querySelector("[data-mode].selected").dataset.mode;
    const m = Pricing.MODES[mode];
    // Preserve whatever is already typed across a mode switch, falling back to
    // the saved product, so changing mode never silently wipes a size.
    const keep = id => { const el = document.getElementById(id); return el ? el.value : null; };
    const prev = {thk: keep("np-thk"), wid: keep("np-wid"), len: keep("np-len")};
    const box = (label, unit, id, value) => `
      <label class="dim">
        <span>${label} <em>(${unit})</em></span>
        <input type="number" inputmode="decimal" step="any" min="0" id="${id}" placeholder="0" value="${value ?? ""}">
      </label>`;
    const el = document.getElementById("np-dims");
    el.innerHTML =
      (m.needsThickness ? box("Thickness", m.thicknessUnit, "np-thk", prev.thk ?? (editing && editing.thickness_in) ?? "") : "") +
      (m.needsLength ? box("Length", m.lengthUnit, "np-len", prev.len ?? (editing && editing.length_ft) ?? "") : "") +
      (m.needsWidth ? box("Width", m.widthUnit, "np-wid", prev.wid ?? (editing && editing.width_val) ?? "") : "");
    el.style.display = el.innerHTML ? "" : "none";
  }
  renderSizes();
  renderDims();
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-unit]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-unit]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-mode]").forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected"); renderDims();
  }));
  sheet.querySelector("#np-add-size").addEventListener("click", (e)=>{ e.preventDefault(); sizes.push({label:"",price:"",stock:0}); renderSizes(); });
  sheet.querySelector("#np-save").addEventListener("click", async ()=>{
    const name = document.getElementById("np-name").value.trim();
    if(!name){ toast("Enter a product name."); return; }
    const unit = sheet.querySelector("[data-unit].selected").dataset.unit;
    const payload = {
      name, code: document.getElementById("np-code").value.trim(),
      brand: document.getElementById("np-brand").value.trim(),
      category: document.getElementById("np-category").value.trim(),
      unit, hsnCode: document.getElementById("np-hsn").value.trim(),
      gst: parseFloat(document.getElementById("np-gst").value)||18,
      godown: document.getElementById("np-godown").value.trim(),
      defaultMode: sheet.querySelector("[data-mode].selected").dataset.mode,
      lengthFt: val("np-len"), widthVal: val("np-wid"), thicknessIn: val("np-thk"),
      sizes
    };
    const saveBtn = document.getElementById("np-save");
    saveBtn.disabled = true;
    try{
      // Each size row carries its own stock now, so create/update both send
      // it as part of `sizes` — no separate stock call needed either way.
      if(editing) await api("PUT", `/products/${editing.id}`, payload);
      else await api("POST","/products", payload);
      await loadProducts();
      closeAllSheets();
      renderInventoryList(); renderBillingProducts();
      // A price or GST change alters every line already in the bill, so the
      // running totals have to be recomputed rather than left stale.
      refreshCartFromProducts();
      toast(editing ? "Product updated." : "Product added.", "ok");
    }catch(err){ toast(err.message); }
    finally{ saveBtn.disabled = false; }
  });
}

/* ============================================================
   SHEETS: Add Customer
   ============================================================ */
/** One form serves both "New Customer" and "Edit Customer" — `editing` is the
 *  existing customer row to prefill and PUT back, or omitted for a new one. */
function openAddCustomer(editing){
  const sheet = document.getElementById("sheet-add-customer");
  const types = ["Retail Customer","Contractor","Architect","Interior Designer","Builder","Wholesaler","Dealer"];
  const gstType = editing ? editing.gst_type : "CGST_SGST";
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${editing ? "Edit Customer" : "New Customer"}</div>
    <label class="field-label">Name</label><input type="text" id="nc-name" value="${editing?escapeHtml(editing.name):""}">
    <label class="field-label">Party type</label>
    <div class="chip-row" id="nc-type-chips">${types.map(t=>`<button class="chip ${(editing?editing.type===t:t===types[0])?'selected':''}" data-type="${t}">${t}</button>`).join("")}</div>
    <label class="field-label">Phone / WhatsApp</label><input type="tel" id="nc-phone" value="${editing?escapeHtml(editing.phone||""):""}">
    <label class="field-label">Address</label><textarea id="nc-address" rows="2" placeholder="Shop / site address — shown on the invoice">${editing?escapeHtml(editing.address||""):""}</textarea>
    <label class="field-label">State (for GST)</label>
    <select id="nc-state"><option value="">${state.settings.state ? "Same as shop ("+escapeHtml(state.settings.state)+")" : "Select state"}</option>${INDIAN_STATES.map(s=>`<option value="${s}" ${editing&&editing.state===s?'selected':''}>${s}</option>`).join("")}</select>
    <label class="field-label">GST Type</label>
    <div class="chip-row" id="nc-gsttype-chips">
      <button class="chip ${gstType==="CGST_SGST"?'selected':''}" data-gsttype="CGST_SGST">CGST + SGST (9% + 9%)</button>
      <button class="chip ${gstType==="IGST"?'selected':''}" data-gsttype="IGST">IGST (18%)</button>
    </div>
    <label class="field-label">GSTIN (optional)</label><input type="text" id="nc-gst" value="${editing?escapeHtml(editing.gst||""):""}">
    <label class="field-label">Credit limit</label><input type="number" id="nc-credit" value="${editing?editing.credit_limit:0}">
    ${!editing && isOwner() ? `
    <div class="section-title" style="margin-top:16px;">Opening Outstanding <span class="muted" style="font-weight:400;">— optional, owner only, set once when adding the customer</span></div>
    <label class="field-label">Opening Outstanding Amount (₹)</label>
    <input type="number" inputmode="decimal" step="any" min="0" id="nc-opening-amount" placeholder="0">
    <label class="field-label">Type</label>
    <div class="chip-row" id="nc-opening-type-chips">
      <button class="chip selected" data-nc-opening-type="Receivable">Receivable (Debit)</button>
      <button class="chip" data-nc-opening-type="Advance">Advance</button>
    </div>
    <label class="field-label">Opening Date</label>
    <input type="date" id="nc-opening-date" value="${todayISO()}">
    <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="nc-opening-remarks" placeholder="e.g. Carried forward from previous system">
    ` : ""}
    <button class="btn btn-primary" id="nc-save" style="margin-top:16px;">${editing?"Update Customer":"Save Customer"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-type]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelectorAll("[data-gsttype]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-gsttype]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelectorAll("[data-nc-opening-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-nc-opening-type]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#nc-save").addEventListener("click", async ()=>{
    const name = document.getElementById("nc-name").value.trim();
    const phone = document.getElementById("nc-phone").value.trim();
    if(!name || !phone){ toast("Name and phone are required."); return; }
    const openingAmountEl = document.getElementById("nc-opening-amount");
    const payload = {
      name, type: sheet.querySelector("[data-type].selected").dataset.type, phone,
      address: document.getElementById("nc-address").value.trim(),
      gst: document.getElementById("nc-gst").value.trim(),
      state: document.getElementById("nc-state").value || state.settings.state,
      gstType: sheet.querySelector("[data-gsttype].selected").dataset.gsttype,
      creditLimit: parseFloat(document.getElementById("nc-credit").value)||0
    };
    if(openingAmountEl && parseFloat(openingAmountEl.value)>0){
      payload.openingBalance = parseFloat(openingAmountEl.value);
      payload.openingBalanceType = sheet.querySelector("[data-nc-opening-type].selected").dataset.ncOpeningType;
      payload.openingDate = document.getElementById("nc-opening-date").value;
      payload.openingRemarks = document.getElementById("nc-opening-remarks").value.trim();
    }
    try{
      if(editing) await api("PUT", `/customers/${editing.id}`, payload);
      else await api("POST","/customers", payload);
      await loadCustomers();
      closeAllSheets(); renderCustomersList(); renderBillingCustomers();
      toast(editing ? "Customer updated." : "Customer added.", "ok");
    }catch(err){ toast(err.message); }
  });
  showSheet("sheet-add-customer");
}

/* ============================================================
   SETTINGS SHEET
   ============================================================ */
function openSettings(){
  const sheet = document.getElementById("sheet-settings");
  const cfg = state.settings;
  const owner = isOwner();
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">Settings</div>
    <p class="muted" style="font-size:12px;margin-top:-6px;">Logged in as <strong>${escapeHtml(state.me.staffName||"")}</strong> (${owner?"Owner":"Staff"})</p>

    ${owner ? `
      <label class="field-label">Business name</label><input type="text" id="st-name" value="${escapeHtml(cfg.business_name)}">
      <label class="field-label">Tagline</label><input type="text" id="st-tagline" value="${escapeHtml(cfg.tagline||"")}">
      <label class="field-label">Address</label><input type="text" id="st-address" value="${escapeHtml(cfg.address||"")}">
      <label class="field-label">Phone(s)</label><input type="text" id="st-phones" value="${escapeHtml(cfg.phones||"")}">
      <label class="field-label">GSTIN</label><input type="text" id="st-gstin" value="${escapeHtml(cfg.gstin||"")}">
      <label class="field-label">Shop State (for CGST/SGST vs IGST)</label>
      <select id="st-state"><option value="">Select state</option>${INDIAN_STATES.map(s=>`<option value="${s}" ${cfg.state===s?"selected":""}>${s}</option>`).join("")}</select>
      <label class="field-label">UPI ID</label><input type="text" id="st-upi" value="${escapeHtml(cfg.upi_id||"")}">
      <button class="btn btn-primary" id="st-save" style="margin-top:16px;">Save Settings</button>

      <div class="section-title">Staff Access</div>
      <button class="btn btn-outline" id="st-manage-staff">Manage Staff &amp; PINs</button>
      <button class="btn btn-outline" id="st-audit-log" style="margin-top:8px;">Activity Log</button>

      <div class="section-title">Backup &amp; Restore</div>
      <div class="card" id="backup-status"><div class="empty-hint">Loading backup status…</div></div>
      <button class="btn btn-primary" id="st-download-backup" style="margin-top:10px;">⬇ Download Backup Now</button>
      <button class="btn btn-outline" id="st-run-backup" style="margin-top:8px;">Back Up Now</button>
      <p class="muted" style="font-size:11px;margin-top:8px;">Your whole shop lives in one file. Automatic snapshots are kept on this PC daily. Use <strong>Download Backup</strong> to keep a copy on your phone or a USB drive — that's your safety net if this PC is ever lost.</p>

      <div class="section-title">Printing</div>
      <div class="card" id="print-server-status"><div class="empty-hint">Checking printer…</div></div>
      <button class="btn btn-outline" id="st-recheck-print" style="margin-top:10px;">Recheck Printer</button>
      <p class="muted" style="font-size:11px;margin-top:8px;">Any phone can print an invoice straight to the shop's printer — no drivers needed on the phone. This checks whether the shop PC can currently reach it.</p>

      <div class="section-title">Document Numbering</div>
      <div class="card" id="numbering-status"><div class="empty-hint">Loading…</div></div>
      <div class="charge-grid" style="margin-top:10px;">
        <label class="dim"><span>Next Estimate No.</span><input type="number" min="1" id="st-next-estimate" placeholder="e.g. 250"></label>
        <label class="dim"><span>Next Challan No.</span><input type="number" min="1" id="st-next-challan" placeholder="e.g. 80"></label>
      </div>
      <button class="btn btn-outline" id="st-save-numbering" style="margin-top:8px;">Set Starting Number</button>
      <p class="muted" style="font-size:11px;margin-top:8px;">Only fill in what you want to change — leave the other blank. Use this once, e.g. to continue from where your paper records left off. Setting it wrong can create duplicate or out-of-order numbers, so double-check before saving.</p>

      <div class="section-title" style="color:var(--danger);">Danger Zone</div>
      <div class="card" style="border-color:var(--danger);">
        <div class="row-title" style="font-size:12.5px;">Factory Reset</div>
        <p class="muted" style="font-size:11px;margin:4px 0 10px;">Permanently erases every product, customer, invoice, challan, purchase and payment. A backup is taken automatically right before — your business profile and staff logins are kept, everything else is not.</p>
        <button class="btn" id="st-factory-reset" style="background:var(--danger);color:#fff;width:100%;">⚠ Wipe All Shop Data</button>
      </div>
    ` : `<div class="card"><div class="empty-hint">Business details and staff accounts can only be changed by the owner.</div></div>`}

    <button class="btn btn-outline" id="st-logout" style="margin-top:16px;">Log out of this device</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  const saveBtn = sheet.querySelector("#st-save");
  if(saveBtn) saveBtn.addEventListener("click", async ()=>{
    try{
      state.settings = await api("PUT","/settings", {
        businessName: document.getElementById("st-name").value.trim(),
        tagline: document.getElementById("st-tagline").value.trim(),
        address: document.getElementById("st-address").value.trim(),
        phones: document.getElementById("st-phones").value.trim(),
        gstin: document.getElementById("st-gstin").value.trim(),
        state: document.getElementById("st-state").value,
        upiId: document.getElementById("st-upi").value.trim()
      });
      document.getElementById("avatar-btn").textContent = initials(state.settings.business_name);
      closeAllSheets();
      toast("Settings saved.", "ok");
    }catch(err){ toast(err.message); }
  });
  const manageStaffBtn = sheet.querySelector("#st-manage-staff");
  if(manageStaffBtn) manageStaffBtn.addEventListener("click", openStaffManage);
  const auditLogBtn = sheet.querySelector("#st-audit-log");
  if(auditLogBtn) auditLogBtn.addEventListener("click", openAuditLog);

  if(owner){
    renderBackupStatus();
    // Download streams a fresh snapshot straight to the browser. A hidden
    // <iframe> lets the file download without navigating away from the sheet,
    // and keeps the session cookie (unlike opening a new tab on some phones).
    sheet.querySelector("#st-download-backup").addEventListener("click", ()=>{
      toast("Preparing your backup file…", "ok");
      let frame = document.getElementById("backup-dl-frame");
      if(!frame){
        frame = document.createElement("iframe");
        frame.id = "backup-dl-frame"; frame.style.display = "none";
        document.body.appendChild(frame);
      }
      frame.src = "/api/backup/download?t=" + Date.now();
    });
    sheet.querySelector("#st-run-backup").addEventListener("click", async (e)=>{
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Backing up…";
      try{
        const r = await api("POST", "/backup/run");
        const cloudMsg = r.cloud.ok ? " and uploaded to cloud"
          : (r.cloud.attempted ? " (cloud upload failed — check internet)" : "");
        toast("Backup saved on this PC" + cloudMsg + ".", r.cloud.attempted && !r.cloud.ok ? "" : "ok");
        renderBackupStatus();
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; btn.textContent = "Back Up Now"; }
    });
    renderPrintServerStatus();
    sheet.querySelector("#st-recheck-print").addEventListener("click", renderPrintServerStatus);
    renderNumberingStatus();
    sheet.querySelector("#st-save-numbering").addEventListener("click", async (e)=>{
      const nextEstimateNumber = document.getElementById("st-next-estimate").value.trim();
      const nextChallanNumber = document.getElementById("st-next-challan").value.trim();
      if(!nextEstimateNumber && !nextChallanNumber){ toast("Enter at least one number to change."); return; }
      const parts = [];
      if(nextEstimateNumber) parts.push(`the next Estimate will be SP${nextEstimateNumber.padStart(7,"0")}`);
      if(nextChallanNumber) parts.push(`the next Challan will be DC-${new Date().getFullYear()}-${nextChallanNumber.padStart(4,"0")}`);
      if(!confirm(`Confirm: ${parts.join(" and ")}. This can create duplicate or out-of-order numbers if set incorrectly. Continue?`)) return;
      const btn = e.currentTarget; btn.disabled = true;
      try{
        await api("PUT", "/settings/numbering", { nextEstimateNumber, nextChallanNumber });
        document.getElementById("st-next-estimate").value = "";
        document.getElementById("st-next-challan").value = "";
        await renderNumberingStatus();
        toast("Numbering updated.", "ok");
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; }
    });
    sheet.querySelector("#st-factory-reset").addEventListener("click", openFactoryResetSheet);
  }
  sheet.querySelector("#st-logout").addEventListener("click", async ()=>{
    await api("POST","/auth/logout");
    closeAllSheets();
    await showLogin();
  });
  showSheet("sheet-settings");
}

async function renderBackupStatus(){
  const box = document.getElementById("backup-status");
  if(!box) return;
  try{
    const s = await api("GET", "/backup");
    if(!box.isConnected) return;
    const last = s.lastRun;
    const when = last ? new Date(last.at) : null;
    const lastLine = last
      ? `Last backup: <strong>${when.toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"})}</strong> (${last.trigger})`
      : `No backup yet this session — one runs automatically shortly after startup.`;
    const cloudLine = s.cloudEnabled
      ? `<span class="pill ok">Cloud backup on</span>`
      : `<span class="pill warn">Cloud off — local only</span>`;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
        <div class="row-title" style="font-size:12.5px;">${lastLine}</div>
        ${cloudLine}
      </div>
      <div class="muted" style="font-size:11.5px;">
        ${s.localCount} snapshot${s.localCount!==1?"s":""} kept on this PC (last ${s.keepLocal} days).
        ${last && last.cloud && last.cloud.attempted && !last.cloud.ok ? `<br><span style="color:var(--danger);">Last cloud upload failed: ${escapeHtml(last.cloud.error||"")}</span>` : ""}
      </div>`;
  }catch(e){
    if(box.isConnected) box.innerHTML = `<div class="empty-hint">Couldn't load backup status.</div>`;
  }
}

async function renderPrintServerStatus(){
  const box = document.getElementById("print-server-status");
  if(!box) return;
  box.innerHTML = `<div class="empty-hint">Checking printer…</div>`;
  try{
    const s = await api("GET", "/print/health");
    if(!box.isConnected) return;
    const pill = s.online
      ? `<span class="pill ok">Online</span>`
      : `<span class="pill danger">Offline</span>`;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div class="row-title" style="font-size:12.5px;">${escapeHtml(s.printerName||"Printer")}</div>
        ${pill}
      </div>
      ${s.reason ? `<div class="muted" style="font-size:11.5px;margin-top:4px;">${escapeHtml(s.reason)}</div>` : ""}
    `;
  }catch(e){
    if(box.isConnected) box.innerHTML = `<div class="empty-hint">Couldn't reach the print service.</div>`;
  }
}

async function renderNumberingStatus(){
  const box = document.getElementById("numbering-status");
  if(!box) return;
  try{
    const s = await api("GET", "/settings/numbering");
    if(!box.isConnected) return;
    box.innerHTML = `
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Next Estimate</span><span style="font-weight:700;">${escapeHtml(s.nextEstimateNo)}</span></div>
      <div class="inv-flex"><span class="muted">Next Challan</span><span style="font-weight:700;">${escapeHtml(s.nextChallanNo)}</span></div>
    `;
  }catch(e){
    if(box.isConnected) box.innerHTML = `<div class="empty-hint">Couldn't load numbering.</div>`;
  }
}

/* ============================================================
   SHEET: Manage Staff (owner only)
   ============================================================ */
async function openStaffManage(){
  const staff = await api("GET", "/staff");
  const sheet = document.getElementById("sheet-staff");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">Manage Staff</div>
    <div class="card" id="staff-list-area">${staff.map(s=>`
      <div class="list-row">
        <div class="avatar" style="width:32px;height:32px;font-size:11px;">${initials(s.name)}</div>
        <div><div class="row-title">${escapeHtml(s.name)}${!s.active?" (Inactive)":""}</div><div class="row-sub">${s.role==="owner"?"Owner":"Staff"}</div></div>
        <div class="row-right">
          <a href="#" data-edit-staff="${s.id}" style="font-size:12px;font-weight:700;">Edit</a>
        </div>
      </div>`).join("") || `<div class="empty-hint">No staff yet.</div>`}
    </div>
    <button class="btn btn-primary" id="staff-add-btn" style="margin-top:14px;">+ Add Staff Member</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#staff-add-btn").addEventListener("click", ()=>openAddStaff(null));
  sheet.querySelectorAll("[data-edit-staff]").forEach(a=>{
    a.addEventListener("click", (e)=>{ e.preventDefault(); openAddStaff(staff.find(s=>s.id===a.dataset.editStaff)); });
  });
  showSheet("sheet-staff");
}
function openAddStaff(existing){
  const sheet = document.getElementById("sheet-add-staff");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${existing ? "Edit Staff Member" : "Add Staff Member"}</div>
    <label class="field-label">Name</label><input type="text" id="ns-name" value="${existing?escapeHtml(existing.name):""}">
    <label class="field-label">Role</label>
    <div class="chip-row" id="ns-role-chips">
      <button class="chip ${(!existing||existing.role==="staff")?"selected":""}" data-role="staff">Staff</button>
      <button class="chip ${existing&&existing.role==="owner"?"selected":""}" data-role="owner">Owner</button>
    </div>
    <label class="field-label">${existing ? "New PIN (leave blank to keep current)" : "PIN (4-6 digits)"}</label>
    <input type="text" id="ns-pin" maxlength="6" placeholder="4-6 digits">
    ${existing ? `
      <label class="field-label">Status</label>
      <div class="chip-row" id="ns-active-chips">
        <button class="chip ${existing.active?"selected":""}" data-active="1">Active</button>
        <button class="chip ${!existing.active?"selected":""}" data-active="0">Inactive</button>
      </div>` : ""}
    <button class="btn btn-primary" id="ns-save" style="margin-top:16px;">${existing?"Save Changes":"Add Staff Member"}</button>
    ${existing ? `<div style="margin-top:16px;text-align:center;"><a href="#" id="ns-delete" class="btn-danger-link">Remove this staff member</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-role]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-role]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  const activeChips = sheet.querySelectorAll("[data-active]");
  activeChips.forEach(b=>b.addEventListener("click", ()=>{
    activeChips.forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#ns-save").addEventListener("click", async ()=>{
    const name = document.getElementById("ns-name").value.trim();
    const pin = document.getElementById("ns-pin").value.trim();
    if(!name){ toast("Enter a name."); return; }
    if(!existing && !/^\d{4,6}$/.test(pin)){ toast("Enter a 4-6 digit PIN."); return; }
    if(pin && !/^\d{4,6}$/.test(pin)){ toast("PIN must be 4-6 digits."); return; }
    const role = sheet.querySelector("[data-role].selected").dataset.role;
    try{
      if(existing){
        const active = sheet.querySelector("[data-active].selected").dataset.active === "1";
        await api("PUT", `/staff/${existing.id}`, { name, role, active, pin: pin || undefined });
      } else {
        await api("POST", "/staff", { name, role, pin });
      }
      closeAllSheets();
      await openStaffManage();
      toast("Staff saved.", "ok");
    }catch(err){ toast(err.message); }
  });
  const deleteLink = sheet.querySelector("#ns-delete");
  if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm("Remove "+existing.name+"? They will no longer be able to log in.")){
      try{
        await api("DELETE", `/staff/${existing.id}`);
        closeAllSheets();
        await openStaffManage();
        toast("Staff member removed.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-add-staff");
}

/* ============================================================
   SHEET: Activity Log (owner only)
   ============================================================ */
async function openAuditLog(){
  const rows = await api("GET", "/audit?limit=200");
  const sheet = document.getElementById("sheet-audit-log");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">Activity Log</div>
    <div class="card">${rows.length ? rows.map(r=>{
      const dt = new Date(r.at);
      return `<div class="list-row">
        <div><div class="row-title">${escapeHtml(r.staff_name)} <span class="muted" style="font-weight:400;">(${r.role})</span></div>
        <div class="row-sub">${escapeHtml(r.action)}${r.details?" — "+escapeHtml(r.details):""}</div></div>
        <div class="row-right muted" style="font-size:11px;">${dt.toLocaleDateString("en-IN")}<br>${dt.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}</div>
      </div>`;
    }).join("") : `<div class="empty-hint">No activity recorded yet.</div>`}</div>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  showSheet("sheet-audit-log");
}

/* ============================================================
   SHEET / SCRIM UTIL
   ============================================================ */
function showSheet(id){
  document.getElementById("scrim").classList.add("show");
  document.getElementById(id).classList.add("show");
}
function closeAllSheets(){
  document.getElementById("scrim").classList.remove("show");
  document.querySelectorAll(".sheet").forEach(s=>s.classList.remove("show"));
}
function closeFullscreen(id){ document.getElementById(id).classList.remove("show"); }

/* ============================================================
   INVOICE PREVIEW
   ============================================================ */
/**
 * Named @page rules with a `page:` property per element are unreliable
 * across browsers (especially the Android Chrome most staff will actually
 * print from), so the selected paper size's @page block is injected fresh
 * here instead — always exactly one @page rule in effect at print time.
 */
function applyPageSizeStyle(){
  const style = document.getElementById("page-size-style");
  if(!style) return;
  const isA4 = state.paperSize === "A4";
  const pageH = isA4 ? 297 : 210, margin = isA4 ? 6 : 3;
  // A real safety margin, not just the @page margin — a physical printer's
  // own default margins, "shrink to fit" being off, or a paper-size
  // mismatch (Letter vs A4) can all shrink the actual printable area below
  // what @page alone promises. Targeting slightly less than the full
  // theoretical content height means real content that measures as exactly
  // fitting on screen still has room to spare once it hits a real printer,
  // instead of spilling one line onto a second page.
  const safetyBuffer = isA4 ? 5 : 4;
  const contentH = pageH - margin * 2 - safetyBuffer;
  // min-height fills the whole sheet, Tally-style, even with just one item —
  // the table's flex-grow (see .erp-table-wrap) is what actually stretches
  // to reach it. flex-shrink stays disabled everywhere in this chain so a
  // LONG item list is still free to grow past one page rather than being
  // squeezed to fit (that was the "shit" print the row-shrinking caused).
  style.textContent = `
    @page{ size:${isA4 ? "A4" : "A5"} portrait; margin:${margin}mm; }
    .invoice-page{ min-height:${contentH}mm; }
  `;
}
function setPaper(size){
  state.paperSize = size;
  document.getElementById("paper-a5").classList.toggle("selected", size==="A5");
  document.getElementById("paper-a4").classList.toggle("selected", size==="A4");
  applyPageSizeStyle();
  renderInvoicePageContent();
}
let lastPreviewInvoice = null;
function openInvoicePreview(existingInvoice){
  if(!existingInvoice && !state.cart.length){ toast("Add items to the invoice first."); return; }
  if(existingInvoice){
    lastPreviewInvoice = existingInvoice;
  } else {
    const t = computeTotals();
    lastPreviewInvoice = {
      challan_no: "(unsaved preview)", date: new Date().toISOString().slice(0,10),
      doc_type: state.docType,
      customer_id: state.selectedCustomerId,
      // Shape matches a row from the API so one template renders both an
      // unsaved preview and a saved invoice re-opened from history.
      items: state.cart.map(c=>{
        const r = lineCalc(c);
        const p = state.products.find(p=>p.id===c.productId);
        return {
          name:c.name, code:(p&&p.code)||"", brand:(p&&p.brand)||"", hsn_code:(p&&p.hsn_code)||"",
          gst_rate:c.gstRate||0,
          mode:r.mode, size_label:r.sizeLabel,
          length_ft:r.lengthFt, width_val:r.widthVal, thickness_in:r.thicknessIn,
          pieces:r.pieces, per_piece:r.perPiece, unit_label:r.unit,
          qty:r.billedQty, rate:r.rate
        };
      }),
      tax_type: t.taxType, discount_amount:t.discount, subtotal:t.subtotal,
      cgst:t.cgst, sgst:t.sgst, igst:t.igst,
      transport:t.transport, loading:t.loading, round_off:t.roundOffAmount,
      total:t.total, advance:t.advance, balance_due:t.balanceDue,
      delivery_man: state.deliveryMan || "",
      vehicle_number: state.vehicleNumber || "",
      delivery_address: state.deliveryAddress || "",
      remarks: state.remarks || ""
    };
  }
  const challan = lastPreviewInvoice.doc_type === "challan";
  const fsTitle = document.querySelector("#fs-invoice .fs-title");
  if(fsTitle) fsTitle.textContent = challan ? "Delivery Challan" : "Invoice Preview";

  // "Delivery Challan (With Rate)" vs "(Without Rate)" is a PRINT-TIME choice
  // on the same saved document — the item rate is stored either way (see
  // server/routes/invoices.js), this toggle only controls whether it's shown.
  // Resets to off (the original, still-default behaviour) each time a fresh
  // challan is opened, rather than remembering the last choice.
  const toggleRow = document.getElementById("challan-rate-toggle-row");
  if(toggleRow){
    toggleRow.style.display = challan ? "flex" : "none";
    state.challanShowRate = false;
    toggleRow.querySelectorAll("[data-challan-rate]").forEach(b=>{
      b.classList.toggle("selected", b.dataset.challanRate === "false");
      b.onclick = () => {
        state.challanShowRate = b.dataset.challanRate === "true";
        toggleRow.querySelectorAll("[data-challan-rate]").forEach(x=>
          x.classList.toggle("selected", x === b));
        renderInvoicePageContent();
      };
    });
  }

  // Silent printing needs a real, saved invoice to look up server-side — an
  // unsaved live preview (still being composed) has nothing to print yet.
  const serverPrintBtn = document.getElementById("inv-server-print");
  const statusRow = document.getElementById("print-status-row");
  if(statusRow){ statusRow.style.display = "none"; statusRow.textContent = ""; }
  if(serverPrintBtn){
    const canPrint = !!(existingInvoice && existingInvoice.id);
    serverPrintBtn.disabled = !canPrint;
    serverPrintBtn.title = canPrint ? "" : "Complete the sale first — printing needs a saved invoice.";
  }

// Remove any edit/void/delete buttons left over from a previously-opened
// document before deciding which ones this one needs — the set differs by
// doc type and whether it's already voided.
["inv-edit", "inv-void", "inv-delete", "inv-return"].forEach(id => { const el = document.getElementById(id); if(el) el.remove(); });
  if(existingInvoice && existingInvoice.id && !existingInvoice.voided){
    const actionsBar = document.querySelector(".inv-actions");
    const editBtn = document.createElement("button");
    editBtn.id = "inv-edit"; editBtn.textContent = "✎ Edit";
    editBtn.onclick = ()=>{ closeFullscreen("fs-invoice"); editExistingInvoice(existingInvoice); };
    actionsBar.appendChild(editBtn);

    if(!challan){
      const returnBtn = document.createElement("button");
      returnBtn.id = "inv-return"; returnBtn.textContent = "Return Items";
      returnBtn.onclick = ()=>{ closeFullscreen("fs-invoice"); openSalesReturn(existingInvoice); };
      actionsBar.appendChild(returnBtn);
    }
  }
  if(existingInvoice && existingInvoice.id && isOwner()){
    const actionsBar = document.querySelector(".inv-actions");
    const afterDelete = async (msg) => {
      toast(msg, "ok");
      closeFullscreen("fs-invoice");
      await Promise.all([loadProducts(), loadCustomers()]);
      await renderHome();
    };

    if(challan){
      // A Delivery Challan carries no GST or financial record worth
      // preserving, so it only gets a real Delete — Void's benefit (keeping
      // a numbered record intact) doesn't apply here.
      const del = document.createElement("button");
      del.id = "inv-delete"; del.textContent = "Delete Challan";
      del.onclick = async ()=>{
        if(!confirm("Delete this challan? Stock will be restored and this cannot be undone.")) return;
        try{ await api("DELETE", `/invoices/${lastPreviewInvoice.id}`); await afterDelete("Challan deleted."); }
        catch(err){ toast(err.message); }
      };
      actionsBar.appendChild(del);
    } else {
      // A Tax Invoice/Estimate is a numbered GST record — Void (reverses
      // stock/dues, keeps the record marked voided) is the button to reach
      // for. Delete is offered too, but only with a much sharper warning:
      // it leaves a gap in the SP0000001... sequence, which can look
      // irregular in a GST audit.
      const voidBtn = document.createElement("button");
      voidBtn.id = "inv-void"; voidBtn.textContent = "Void Invoice";
      voidBtn.onclick = async ()=>{
        if(!confirm("Void this invoice? Stock and customer dues will be reversed. The record stays visible as voided.")) return;
        try{
          await api("POST", `/invoices/${lastPreviewInvoice.id}/void`);
          await afterDelete("Invoice voided.");
        }catch(err){ toast(err.message); }
      };
      actionsBar.appendChild(voidBtn);

      const del = document.createElement("button");
      del.id = "inv-delete"; del.textContent = "Delete Invoice";
      del.onclick = async ()=>{
        if(!confirm(`Permanently delete ${lastPreviewInvoice.challan_no}? Stock and customer dues will be reversed, and the record will be GONE — not just voided. This leaves a gap in your estimate number sequence, which can look irregular in a GST audit. This cannot be undone.`)) return;
        try{ await api("DELETE", `/invoices/${lastPreviewInvoice.id}`); await afterDelete("Invoice deleted."); }
        catch(err){ toast(err.message); }
      };
      actionsBar.appendChild(del);
    }
  }
  // Sheet must be visible (display:none has no layout box at all) BEFORE
  // setPaper()'s render measures real element heights to decide how many
  // blank filler rows the table needs — measuring while hidden reads 0 for
  // everything, which previously ran away adding thousands of rows.
  document.getElementById("fs-invoice").classList.add("show");
  setPaper(state.paperSize);
}
async function openExistingInvoice(invoiceId){
  try{
    const inv = await api("GET", `/invoices/${invoiceId}`);
    inv.customer_id = inv.customer_id;
    openInvoicePreview(inv);
  }catch(e){ toast(e.message); }
}
function renderInvoicePageContent(){
  const inv = lastPreviewInvoice; if(!inv) return;
  const cfg = state.settings;
  const cust = state.customers.find(c=>c.id===inv.customer_id);
  const isA4 = state.paperSize==="A4";
  const challan = inv.doc_type === "challan";
  document.getElementById("invoice-page-content").classList.toggle("size-a5", !isA4);

  // A challan's item table and totals box keep EXACTLY the same layout
  // whether "Show Rate" is on or off — only the Rate/Amount cell CONTENTS
  // (and the money values in the totals box below) go blank, never hidden
  // columns and never a "0.00", so staff can write the real figures in by
  // hand after printing. "Delivery Challan (With Rate)" vs "(Without Rate)"
  // is a PRINT-TIME choice on the same saved document — the item rate is
  // stored either way (see server/routes/invoices.js), this toggle only
  // controls whether it's PRINTED.
  const showRate = !challan || state.challanShowRate;
  const head = `<th class="c-sn">Sr No.</th><th>${challan ? "Product / Item" : "Product Description"}</th><th class="c-size">${challan ? "Description" : "Size"}</th><th class="c-unit">Unit</th><th class="c-num">Qty</th><th class="c-num">Rate</th><th class="c-num c-amt">Amount</th>`;
  const rows = inv.items.map((it,i)=>{
    const mode = it.mode || "UNIT";
    const unit = it.unit_label || (Pricing.MODES[mode] && Pricing.MODES[mode].unit) || "";
    // Area/length modes bill in a different unit than the physical piece
    // count (e.g. 4 sheets at 8x4ft = 32 Sq.ft) — show both so "32" doesn't
    // read as a mismatch against "4". A single piece is shown as just
    // "1 pc" instead, since the billed number adds nothing when there's
    // only one piece. UNIT mode has no such split (qty already IS the
    // piece count), so nothing extra.
    const qtyCell = mode !== "UNIT" && it.pieces === 1
      ? "1 pc"
      : `${Pricing.formatQty(it.qty, mode).replace(" "+unit,"")}${mode !== "UNIT" && it.pieces ? `<div class="c-pieces">(${it.pieces} pc)</div>` : ""}`;
    const base = `<td class="c-sn">${i+1}</td><td>${escapeHtml(it.name)}</td><td class="c-size">${escapeHtml(it.size_label||"—")}</td><td class="c-unit">${escapeHtml(unit)}</td><td class="c-num">${qtyCell}</td>`;
    return `<tr>${base}<td class="c-num">${showRate ? fmtPaise(it.rate).replace("Rs. ","") : ""}</td><td class="c-num c-amt">${showRate ? fmtPaise(it.qty*it.rate) : ""}</td></tr>`;
  }).join("");
  // Total Quantity is the physical piece count across all items, not the
  // billed area/length sum — matching what gets counted at load/unload,
  // and staying meaningful even when items mix billing units (Sq.ft +
  // Rft + Unit can't be summed together, but pieces always can).
  const totalQtyForFoot = round2(inv.items.reduce((s,it)=>s+(Number(it.pieces)||0),0));
  const tfoot = `<tfoot><tr>
    <td colspan="4" style="text-align:right;">Total Quantity</td>
    <td class="c-num">${totalQtyForFoot}</td>
    <td colspan="3"></td>
  </tr></tfoot>`;

  // Priced invoice: full totals. Challan: same boxed layout for visual
  // consistency with the shop's paper form, but CGST/SGST/IGST stay at zero
  // here — a challan never carries real GST regardless of what the box
  // shows, and this "Grand Total" is a print-only figure (goods value +
  // transport/loading) that is NEVER what's stored as the invoice's actual
  // total or added to the customer's due — that stays transport+loading only,
  // set server-side, so a challan can never function as a demand for payment.
  const challanSubtotal = inv.items.reduce((s,it)=>s+(it.qty*it.rate||0),0);
  const displayTotal = challan ? (challanSubtotal + inv.transport + inv.loading) : inv.total;
  const discountAmt = challan ? 0 : (inv.discount_amount || 0);
  // A challan never carries real GST, and "Non-GST Invoice" (gst_enabled=0)
  // deliberately has none either — both skip the tax rows entirely.
  const gstEnabled = !challan && inv.gst_enabled !== 0;
  const cgst = gstEnabled ? (inv.cgst || 0) : 0, sgst = gstEnabled ? (inv.sgst || 0) : 0, igst = gstEnabled ? (inv.igst || 0) : 0;
  const isIGST = gstEnabled && inv.tax_type === "IGST";
  // Effective rate shown next to the CGST/SGST/IGST label — derived from the
  // actual stored tax and taxable value (works for a mixed-rate bill too,
  // since it's a weighted average, not any single item's GST%), not hardcoded.
  const taxableGoods = Math.max(0, (inv.subtotal||0) - (inv.discount_amount||0));
  const effectiveRatePct = taxableGoods > 0 ? Math.round(((cgst+sgst+igst) / taxableGoods) * 100) : 0;
  const halfRatePct = Math.round(effectiveRatePct / 2);

  // The totals box keeps the SAME layout regardless of showRate — only the
  // money values that depend on item pricing (Subtotal, Discount, Grand
  // Total) go blank instead of printing a misleading "0.00" when the rate
  // itself isn't shown. Transport/Additional Charges are real entered
  // rupee amounts independent of any item rate, so they still print.
  const totalsBox = `<div class="erp-totals-box">
    <div class="erp-tb-row"><span>Subtotal</span><span>${showRate ? fmtPaise(challan?challanSubtotal:inv.subtotal) : ""}</span></div>
    <div class="erp-tb-row"><span>Discount</span><span>${showRate ? (discountAmt>0?"-":"")+fmtPaise(discountAmt) : ""}</span></div>
    <div class="erp-tb-row"><span>Transport</span><span>${fmtPaise(inv.transport)}</span></div>
    ${inv.loading ? `<div class="erp-tb-row"><span>Additional Charges</span><span>${fmtPaise(inv.loading)}</span></div>` : ""}
    ${!gstEnabled ? "" : isIGST
      ? `<div class="erp-tb-row"><span>IGST ${effectiveRatePct}%</span><span>${fmtPaise(igst)}</span></div>`
      : `<div class="erp-tb-row"><span>CGST ${halfRatePct}%</span><span>${fmtPaise(cgst)}</span></div><div class="erp-tb-row"><span>SGST ${halfRatePct}%</span><span>${fmtPaise(sgst)}</span></div>`}
    ${!challan && inv.round_off ? `<div class="erp-tb-row"><span>Round Off</span><span>${inv.round_off>0?"+":""}${fmtPaise(inv.round_off)}</span></div>` : ""}
    <div class="erp-tb-row erp-tb-grand"><span>Grand Total</span><span>${showRate ? fmtPaise(displayTotal) : ""}</span></div>
    ${!challan && inv.advance>0 ? `<div class="erp-tb-row"><span>Advance Paid</span><span>-${fmtPaise(inv.advance)}</span></div>
    <div class="erp-tb-row" style="font-weight:800;"><span>Balance Due</span><span>${fmtPaise(inv.balance_due)}</span></div>` : ""}
  </div>`;

  const deliveryAddr = inv.delivery_address || (cust && cust.address) || "";
  const bottomLeft = `<div class="erp-bottom-left">
    ${deliveryAddr ? `<div><b>Delivery Address:</b> ${escapeHtml(deliveryAddr)}</div>` : ""}
    ${inv.remarks ? `<div><b>Remarks:</b> ${escapeHtml(inv.remarks)}</div>` : ""}
    ${showRate ? `<div><b>Amount in Words:</b> ${Pricing.amountInWords(displayTotal)}</div>` : ""}
  </div>`;

  const bannerText = challan ? "DELIVERY CHALLAN" : "ESTIMATE CHALLAN";
  document.getElementById("invoice-page-content").innerHTML = `
    <div class="erp-banner">${bannerText}</div>
    <div class="erp-header">
      <div class="erp-biz-name">${escapeHtml(cfg.business_name)}</div>
      ${cfg.tagline ? `<div class="erp-tag">${escapeHtml(cfg.tagline)}</div>` : ""}
      ${cfg.address ? `<div class="erp-addr">${escapeHtml(cfg.address)}</div>` : ""}
      <div class="erp-contact-line">${[
        cfg.gstin ? `GSTIN: ${escapeHtml(cfg.gstin)}` : "",
        cfg.phones ? `Ph: ${escapeHtml(cfg.phones)}` : "",
        "Email: swagatply@gmail.com", "Website: www.swagatply.com"
      ].filter(Boolean).join("  |  ")}</div>
    </div>

    <div class="erp-parties">
      <div class="erp-party-box">
        <div class="erp-box-label">${challan ? "Deliver To" : "Buyer"}</div>
        <div class="erp-box-name">${cust?escapeHtml(cust.name):"Walk-in Customer"}</div>
        ${cust&&cust.address ? `<div>${escapeHtml(cust.address)}</div>` : ""}
        ${cust&&cust.phone ? `<div>Mobile: ${escapeHtml(cust.phone)}</div>` : ""}
        ${cust&&cust.gst ? `<div>GSTIN: ${escapeHtml(cust.gst)}</div>` : ""}
        ${cust&&cust.state ? `<div>State: ${escapeHtml(cust.state)}</div>` : ""}
      </div>
      <div class="erp-doc-box">
        <div class="erp-kv"><span>${challan ? "Challan No." : "Estimate No."}</span><b>${inv.challan_no}</b></div>
        <div class="erp-kv"><span>Date</span><b>${inv.date}</b></div>
        ${inv.delivery_man ? `<div class="erp-kv"><span>Salesperson</span><b>${escapeHtml(inv.delivery_man)}</b></div>` : ""}
        ${inv.vehicle_number ? `<div class="erp-kv"><span>Vehicle No.</span><b>${escapeHtml(inv.vehicle_number)}</b></div>` : ""}
      </div>
    </div>

    <div class="erp-table-wrap">
      <table class="erp-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
        ${tfoot}
      </table>
    </div>

    <div class="erp-bottom">
      ${bottomLeft}
      ${totalsBox}
    </div>

    <div class="erp-terms">${challan
      ? `<strong>PLYWOOD, BLACKBOARD, ARE MANUFACTURED FROM NATURAL WOOD WHICH IS BELOW BIO DEGRADEBLE, WE DONOT GUARANTEE AGAINST ANY NATURAL DECAY DEFICIENTY, DETORATION AND LIKE INCLUDING MANUFACTURING DEFACT AND/OR IMPERFACT QUALITY</strong>`
      : `<strong>NO GURANTEE AND WARRANTY FOR DECORATIVE PRODUCTS AND AIR BUBBLES IN LAMMINATES, ACRYLIC AND PVC LAMINATES OR ANY SHADE VARIATION AFTER INSTALLATION. NO EXCHANGE. NO RETURN IN ANY CONDITION. PLEASE CHECK THE MATERIAL ON DELIVERY.</strong>`}</div>
  `;
}
/**
 * Rasterises the on-screen invoice/challan into a jsPDF document and hands
 * back both the pdf object and a sensible filename — shared by the Download
 * button and the Share-as-PDF-on-WhatsApp button below, so there's exactly
 * one place that knows how to turn the preview into a PDF.
 */
async function buildInvoicePdf(){
  if(typeof html2canvas === "undefined" || typeof window.jspdf === "undefined"){
    throw new Error("PDF libraries not loaded");
  }
  const node = document.getElementById("invoice-page-content");
  const { jsPDF } = window.jspdf;
  const isA4 = state.paperSize==="A4";
  const pdf = new jsPDF({unit:"mm", format: isA4 ? "a4" : "a5"});
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgWidth = pageWidth;
  // The printed page itself uses only hex colours (see .invoice-page in
  // style.css), but html2canvas 1.4.1 also walks and resolves styles on
  // ANCESTOR elements (body, the fullscreen wrapper, :root) for layout
  // context, and those still use the app's oklch() theme — which this old
  // html2canvas build cannot parse, so it throws before any image is drawn.
  // `onclone` lets us patch the OFF-SCREEN CLONE that html2canvas rasterises
  // — never the live page the user is looking at — by overriding the theme
  // variables with plain hex equivalents just for that clone.
  const canvas = await html2canvas(node, {
    scale:2, backgroundColor:"#ffffff", useCORS:true,
    onclone: (clonedDoc) => {
      const style = clonedDoc.createElement("style");
      style.textContent = `:root{
        --navy:#1e2a4a; --navy-2:#182140; --gold:#d4a94a; --gold-2:#c2963c;
        --bg:#fbfaf8; --bg-outer:#f0efeb; --card:#ffffff; --border:#e0dfda;
        --text:#262b38; --muted:#6b7280; --ok:#2e9e5b; --ok-bg:#dcf3e4;
        --warn-bg:#f5e7c9; --warn-text:#8a6a1f; --danger:#c0392b; --danger-bg:#f6dcd8;
      }
      /* This PDF path rasterises the on-screen card as-is, bypassing the
         @media print rules entirely — reset the screen-only rounded-corner
         card look here too so the downloaded PDF frames like a printed
         sheet, not a floating app card. */
      #invoice-page-content{border-radius:0 !important;box-shadow:none !important;border:1.5px solid #333 !important;}
      /* #fs-invoice's 460px max-width and .size-a5's 360px max-width are
         both screen-preview caps (keep the on-screen card phone-width and
         centred) — harmless on screen, but this capture is later stretched
         to fill the PDF's full page width (addImage always draws it at
         imgWidth=pageWidth). Left in place, that stretch scales height by
         the SAME factor as width (pageWidth / 360px), which for A5 inflates
         a legitimate one-page-tall layout by ~1.55x and spills it onto a
         second page. Forcing the captured width to the real page width
         up front (mirroring what @media print already does for the browser
         print path) makes the later scale factor ~1:1, so the capture's
         proportions match the physical page instead of being stretched. */
      #fs-invoice{max-width:none !important;}
      #invoice-page-content{max-width:none !important;width:${pageWidth}mm !important;margin-left:0 !important;margin-right:0 !important;}`;
      clonedDoc.head.appendChild(style);
    }
  });
  // A long item list can make the captured canvas taller than one page —
  // slice it into page-height chunks and add each as its own PDF page,
  // rather than the previous Math.min(), which silently cropped anything
  // past the first page instead of continuing onto a second one.
  const pxPerMm = canvas.width / imgWidth;
  const pageHeightPx = Math.round(pageHeight * pxPerMm);
  let renderedPx = 0, firstPage = true;
  while (renderedPx < canvas.height) {
    const sliceHeightPx = Math.min(pageHeightPx, canvas.height - renderedPx);
    const sliceCanvas = document.createElement("canvas");
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = sliceHeightPx;
    sliceCanvas.getContext("2d").drawImage(
      canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx
    );
    if (!firstPage) pdf.addPage();
    pdf.addImage(sliceCanvas.toDataURL("image/png"), "PNG", 0, 0, imgWidth, sliceHeightPx / pxPerMm);
    renderedPx += sliceHeightPx;
    firstPage = false;
  }
  const fname = (lastPreviewInvoice && lastPreviewInvoice.challan_no ? lastPreviewInvoice.challan_no : "invoice") + ".pdf";
  return { pdf, fname };
}
async function downloadInvoicePdf(){
  const btn = document.getElementById("inv-download");
  const originalText = btn.textContent;
  btn.textContent = "⏳ Preparing...";
  btn.disabled = true;
  try{
    const { pdf, fname } = await buildInvoicePdf();
    pdf.save(fname);
  }catch(e){
    console.error("PDF generation failed, falling back to print dialog", e);
    toast("Couldn't build a PDF directly — opening the print dialog instead.");
    window.print();
  }finally{
    btn.textContent = originalText;
    btn.disabled = false;
  }
}
/**
 * "Share as PDF" on WhatsApp — the ONLY way a web page can hand an actual
 * file to WhatsApp specifically (wa.me only ever pre-fills text, it has no
 * concept of an attachment) is the native Web Share API, which opens the
 * device's own share sheet; the user picks WhatsApp (Messenger OR Business —
 * both show up there if installed, which is the OS's job, not this page's)
 * from whatever's registered to accept a PDF. Desktop browsers and older
 * mobile browsers don't support sharing files this way, so this falls back
 * to just downloading the PDF and telling the user to attach it manually.
 */
async function shareInvoicePdfWhatsApp(){
  const btn = document.getElementById("inv-whatsapp-pdf");
  if(!btn) return;
  const originalText = btn.textContent;
  btn.textContent = "⏳ Preparing...";
  btn.disabled = true;
  try{
    const { pdf, fname } = await buildInvoicePdf();
    const blob = pdf.output("blob");
    const file = new File([blob], fname, { type: "application/pdf" });
    if(navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ files: [file], title: fname });
    } else {
      pdf.save(fname);
      toast("Your browser can't hand a file straight to WhatsApp — the PDF downloaded instead, attach it from there.");
    }
  }catch(e){
    if(e && e.name === "AbortError") return; // user cancelled the share sheet — not an error
    console.error("Share-as-PDF failed", e);
    toast("Couldn't share the PDF. Try Download PDF and attach it manually.");
  }finally{
    btn.textContent = originalText;
    btn.disabled = false;
  }
}
/**
 * "Print to Shop Printer" — asks the SAME server this phone is already
 * talking to, to silently print the invoice on the shop PC's USB printer
 * (see server/routes/print.js). Shows Printing… while the job is queued/
 * running, then Printed Successfully or the specific reason it failed
 * (printer offline, out of paper, helper not installed, etc) — polling
 * rather than waiting on one long request, since real printing can take
 * longer than any request should stay open.
 */
async function printViaServer(){
  const inv = lastPreviewInvoice;
  if(!inv || !inv.id){ toast("Complete the sale first — printing needs a saved invoice."); return; }
  const btn = document.getElementById("inv-server-print");
  const statusRow = document.getElementById("print-status-row");
  const setStatus = (text, cls) => {
    if(!statusRow) return;
    statusRow.style.display = "block";
    statusRow.textContent = text;
    statusRow.className = "print-status-row" + (cls ? " "+cls : "");
  };

  btn.disabled = true;
  setStatus("🖨 Printing…");
  try{
    const job = await api("POST", "/print", { invoiceId: inv.id, showRate: state.challanShowRate });
    const jobId = job.jobId;

    // Poll every 1s for up to 30s — a real print job is typically done in a
    // few seconds, but a slow/busy printer shouldn't be cut off early.
    for(let i=0; i<30; i++){
      await new Promise(r=>setTimeout(r,1000));
      const status = await api("GET", `/print/jobs/${jobId}`);
      if(status.status === "done"){
        setStatus("✅ Printed successfully.", "ok");
        btn.disabled = false;
        return;
      }
      if(status.status === "failed"){
        setStatus("❌ "+(status.error||"Printing failed."), "error");
        btn.disabled = false;
        return;
      }
      // still queued/printing — keep waiting
    }
    setStatus("⏳ Still printing — check the shop PC if this doesn't finish.", "");
  }catch(err){
    setStatus("❌ "+err.message, "error");
  }finally{
    btn.disabled = false;
  }
}

/**
 * Single entry point for every WhatsApp link in the app — `phone` (any
 * format, digits extracted and prefixed with the India country code) opens
 * that chat directly, without needing the number saved as a contact; omit
 * it to open WhatsApp's own chat list. `text`, if given, arrives pre-filled
 * in the message box.
 *
 * wa.me already degrades sensibly on its own: no WhatsApp Desktop app on a
 * PC falls back to WhatsApp Web in a new tab, and on a phone the OS (not
 * this page) owns whatever happens when no WhatsApp app is registered for
 * the link — a web page has no API to ask "is WhatsApp installed?", so
 * this doesn't try to fake that check. The one failure a page CAN detect
 * is a popup blocker silently eating window.open, which is what the toast
 * below actually covers.
 */
function openWhatsApp(phone, text){
  const num = phone ? "91" + String(phone).replace(/\D/g,"") : "";
  const url = "https://wa.me/" + num + (text ? ("?text=" + encodeURIComponent(text)) : "");
  const win = window.open(url, "_blank");
  if(!win) toast("Couldn't open WhatsApp — allow pop-ups for this site, or install WhatsApp to use this.");
}

/* ============================================================
   REPORTS
   ============================================================ */
async function renderReport(){
  const body = document.getElementById("report-body");
  try{
    if(state.reportType==="Purchase") return renderPurchaseReport(body);
    if(state.reportType==="Challan") return renderChallanReport(body);
    if(state.reportType==="Orders") return renderOrdersReport(body);
    if(state.reportType==="TaxInvoice") return renderTaxInvoiceReport(body);
    if(state.reportType==="PurchaseBill") return renderPurchaseBillReport(body);
    if(state.reportType==="Salesman") return renderSalesmanReport(body);
    if(state.reportType==="Party") return renderPartyReport(body);
    if(state.reportType==="PartyProduct") return renderPartyProductReport(body);
    if(state.reportType==="Profit") return renderProfitReport(body);
    if(state.reportType==="ProfitByInvoice") return renderProfitByInvoiceReport(body);
    if(state.reportType==="Supplier") return renderSupplierReport(body);
    if(state.reportType==="SalePayments") return renderSalePaymentsReport(body);
    if(state.reportType==="PurchasePayments") return renderPurchasePaymentsReport(body);
    if(state.reportType==="LocationStock") return renderLocationStockReport(body);
    if(state.reportType==="Transfers") return renderTransfersReport(body);
    if(state.reportType==="DailyMovement") return renderDailyMovementReport(body);

    let title="", subtitle="", rows=[];
    if(state.reportType==="Sales"){
      title = "Sales by Payment Method"; subtitle="Total invoice value";
      rows = await api("GET","/reports/sales-by-payment");
    } else if(state.reportType==="GST"){
      title="GST Collected"; subtitle="CGST + SGST + IGST across all invoices";
      const g = await api("GET","/reports/gst");
      rows = [{label:"CGST", value:g.cgst}, {label:"SGST", value:g.sgst}, {label:"IGST", value:g.igst}].filter(r=>r.value>0);
    } else if(state.reportType==="Stock"){
      title="Stock by Brand"; subtitle="Units currently on hand";
      rows = await api("GET","/reports/stock-by-brand");
    } else if(state.reportType==="Brand"){
      title="Sales by Brand"; subtitle="Revenue from priced invoices, by product brand";
      rows = await api("GET","/reports/brand-wise");
    } else {
      title="Customer Outstanding"; subtitle="Dues by customer";
      rows = await api("GET","/reports/customer-dues");
    }
    const max = Math.max(1, ...rows.map(r=>r.value));
    body.innerHTML = `<div style="font-weight:800;font-size:14px;">${title}</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">${subtitle}</div>` +
      (rows.length ? rows.map(r=>`
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:4px;"><span>${escapeHtml(r.label)}</span><span>${state.reportType==="Stock"?r.value+" units":fmt(r.value)}</span></div>
          <div style="height:8px;background:var(--bg-outer);border-radius:100px;"><div style="height:100%;width:${(r.value/max)*100}%;background:var(--navy);border-radius:100px;"></div></div>
        </div>`).join("") : `<div class="empty-hint">No data yet for this report.</div>`);
  }catch(e){ toast(e.message); }
}

async function renderPurchaseReport(body){
  const rows = await api("GET","/reports/purchases");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Purchase Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every stock-in recorded, newest first</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.product_name)}${r.size_label?" · "+escapeHtml(r.size_label):""}</div>
        <div class="row-sub">${escapeHtml(r.purchase_date||"")}${r.invoice_no?" · Inv# "+escapeHtml(r.invoice_no):""}${r.supplier?" · "+escapeHtml(r.supplier):""}</div>
        <div class="row-sub">${r.qty} pcs${r.billed_qty&&r.billed_qty!==r.qty?" · "+Pricing.formatQty(r.billed_qty, r.mode||"UNIT"):""}</div>
      </div><div class="row-right row-title">${fmt(r.grand_total)}</div></div>
    `).join("") : `<div class="empty-hint">No purchases recorded yet.</div>`);
}

async function renderChallanReport(body){
  const rows = await api("GET","/reports/challans");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Challan Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every Delivery Challan (sales) and Purchase Challan (goods received), newest first — tap a row to open it</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row" style="cursor:pointer;" ${r.type==="Sales"?`data-open-invoice="${r.id}"`:`data-open-purchase="${r.id}"`}><div>
        <div class="row-title">${escapeHtml(r.challan_no)} <span class="pill ${r.type==="Sales"?"ok":"warn"}" style="font-size:9.5px;">${r.type}</span></div>
        <div class="row-sub">${escapeHtml(r.date)} · ${escapeHtml(r.party_name||(r.type==="Sales"?"Walk-in":"Unknown Supplier"))}</div>
        <div class="row-sub">${r.item_count} item${r.item_count!==1?"s":""} · ${r.total_pieces} pcs${(r.transport||r.loading)?" · Transport+Loading "+fmt((r.transport||0)+(r.loading||0)):""}</div>
      </div></div>
    `).join("") : `<div class="empty-hint">No challans recorded yet.</div>`);
  body.querySelectorAll("[data-open-invoice]").forEach(el=>{
    el.addEventListener("click", ()=>openExistingInvoice(el.dataset.openInvoice));
  });
  body.querySelectorAll("[data-open-purchase]").forEach(el=>{
    el.addEventListener("click", ()=>openPurchaseDetail(el.dataset.openPurchase));
  });
}
async function renderOrdersReport(body){
  const rows = await api("GET","/reports/orders");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Orders Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every Purchase Order and Sales Order, newest first — tap a row to open it</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row" style="cursor:pointer;" ${r.type==="Sales"?`data-open-so="${r.id}"`:`data-open-po="${r.id}"`}><div>
        <div class="row-title">${escapeHtml(r.order_no)} <span class="pill ${r.type==="Sales"?"ok":"warn"}" style="font-size:9.5px;">${r.type}</span></div>
        <div class="row-sub">${escapeHtml(r.date)} · ${escapeHtml(r.party_name||(r.type==="Sales"?"Walk-in":"Unknown Supplier"))}</div>
      </div><div class="row-right"><div class="row-title">${fmt(r.total)}</div><span class="pill ${(r.type==="Sales"?SO_STATUS_PILL:PO_STATUS_PILL)[r.status]||''}">${escapeHtml(r.status)}</span></div></div>
    `).join("") : `<div class="empty-hint">No orders recorded yet.</div>`);
  body.querySelectorAll("[data-open-po]").forEach(el=>{
    el.addEventListener("click", ()=>openPoDetail(el.dataset.openPo));
  });
  body.querySelectorAll("[data-open-so]").forEach(el=>{
    el.addEventListener("click", ()=>openSoDetail(el.dataset.openSo));
  });
}
async function renderTaxInvoiceReport(body){
  const rows = await api("GET","/reports/tax-invoices");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Tax Invoice Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every Tax Invoice issued, newest first — tap a row to open it</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row" style="cursor:pointer;" data-open-invoice="${r.id}"><div>
        <div class="row-title">${escapeHtml(r.challan_no)}</div>
        <div class="row-sub">${escapeHtml(r.date)} · ${escapeHtml(r.customer_name||"Walk-in")} · ${escapeHtml(r.payment_method)}</div>
        ${r.balance_due>0?`<div class="row-sub" style="color:var(--danger);">Due ${fmt(r.balance_due)}</div>`:""}
      </div><div class="row-right row-title">${fmt(r.total)}</div></div>
    `).join("") : `<div class="empty-hint">No tax invoices issued yet.</div>`);
  body.querySelectorAll("[data-open-invoice]").forEach(el=>{
    el.addEventListener("click", ()=>openExistingInvoice(el.dataset.openInvoice));
  });
}
async function renderPurchaseBillReport(body){
  const rows = await api("GET","/reports/purchase-bills");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Purchase Bill Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every purchase bill recorded, newest first — tap a row to open it</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row" ${r.source==="purchase"?`style="cursor:pointer;" data-open-purchase="${r.id}"`:""}><div>
        <div class="row-title">${escapeHtml(r.bill_no||"—")}</div>
        <div class="row-sub">${escapeHtml(r.date||"")} · ${escapeHtml(r.supplier_name||"Unknown Supplier")} · ${r.item_count} item${r.item_count!==1?"s":""}</div>
      </div><div class="row-right row-title">${fmt(r.grand_total)}</div></div>
    `).join("") : `<div class="empty-hint">No purchase bills recorded yet.</div>`);
  body.querySelectorAll("[data-open-purchase]").forEach(el=>{
    el.addEventListener("click", ()=>openPurchaseDetail(el.dataset.openPurchase));
  });
}
async function renderSalesmanReport(body){
  const rows = await api("GET","/reports/salesman-wise");
  const max = Math.max(1, ...rows.map(r=>r.value));
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Salesman-wise Sales</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Tax Invoice revenue by salesperson</div>` +
    (rows.length ? rows.map(r=>`
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:4px;"><span>${escapeHtml(r.label)}</span><span>${fmt(r.value)} · ${r.invoices} inv.</span></div>
        <div style="height:8px;background:var(--bg-outer);border-radius:100px;"><div style="height:100%;width:${max>0?(r.value/max)*100:0}%;background:var(--navy);border-radius:100px;"></div></div>
      </div>`).join("") : `<div class="empty-hint">No sales recorded yet.</div>`);
}
async function renderLocationStockReport(body){
  const rows = await api("GET","/reports/stock-by-location");
  const codeIcon = code => code==="shop" ? "&#127978;" : code==="warehouse" ? "&#127974;" : "&#128230;";
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Shop / Warehouse Stock</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every product's quantity at each location</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.label)}</div>
        <div class="row-sub">${escapeHtml(r.brand||"")}${r.byLocation.map(l=>` · ${codeIcon(l.code)} ${escapeHtml(l.name)}: ${l.quantity}`).join("")}</div>
      </div><div class="row-right row-title">Total: ${r.total}</div></div>
    `).join("") : `<div class="empty-hint">No products yet.</div>`);
}
async function renderTransfersReport(body){
  const rows = await api("GET","/transfers");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Transfer History</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Stock moved between locations, newest first</div>` +
    (rows.length ? rows.map(r=>{
      const fromName = (state.locations.find(l=>l.id===r.from_location_id)||{}).name || "?";
      const toName = (state.locations.find(l=>l.id===r.to_location_id)||{}).name || "?";
      return `<div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.product_name)}${r.size_label?" · "+escapeHtml(r.size_label):""}</div>
        <div class="row-sub">${new Date(r.created_at).toLocaleDateString("en-IN")} · ${escapeHtml(fromName)} &rarr; ${escapeHtml(toName)}${r.staff_name?" · "+escapeHtml(r.staff_name):""}${r.reason?" · "+escapeHtml(r.reason):""}</div>
      </div><div class="row-right row-title">${r.quantity}</div></div>`;
    }).join("") : `<div class="empty-hint">No transfers recorded yet.</div>`);
}
async function renderDailyMovementReport(body){
  const days = await api("GET","/reports/daily-movement");
  const max = Math.max(1, ...days.map(d=>Math.max(d.purchasesIn, d.salesOut)));
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Daily Movement</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Purchases in vs. sales out, last 14 days (pieces)</div>` +
    days.map(d=>`
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:4px;">
          <span>${escapeHtml(d.label)}</span>
          <span style="color:var(--ok);">+${d.purchasesIn}</span>
          <span style="color:var(--danger);">-${d.salesOut}</span>
          ${d.transferred>0?`<span class="muted">&#8646; ${d.transferred}</span>`:""}
        </div>
        <div style="display:flex;gap:2px;height:8px;">
          <div style="flex:${Math.max(1,d.purchasesIn)};background:var(--ok);border-radius:100px;opacity:${d.purchasesIn>0?1:0.15};"></div>
          <div style="flex:${Math.max(1,d.salesOut)};background:var(--danger);border-radius:100px;opacity:${d.salesOut>0?1:0.15};"></div>
        </div>
      </div>`).join("");
}
async function renderPartyReport(body){
  const rows = await api("GET","/reports/party-wise");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Party-wise Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Total business per customer</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.label)}</div>
        <div class="row-sub">${escapeHtml(r.type||"")} · ${r.invoices} invoice${r.invoices!==1?"s":""}${r.due>0?" · Due "+fmt(r.due):""}</div>
      </div><div class="row-right row-title">${fmt(r.value)}</div></div>
    `).join("") : `<div class="empty-hint">No customers yet.</div>`);
}

async function renderPartyProductReport(body){
  const kind = state.partyProductType || "sales";
  const rows = await api("GET", `/reports/party-product?type=${kind}`);
  body.innerHTML = `
    <div style="font-weight:800;font-size:14px;">Party-wise Product Report</div>
    <div class="muted" style="font-size:11.5px;margin-bottom:10px;">Every product ${kind==="sales"?"sold to each customer":"bought from each supplier"}</div>
    <div class="chip-row" id="party-product-type-chips" style="margin-bottom:10px;">
      <button class="chip ${kind==="sales"?"selected":""}" data-pp-type="sales">Sales</button>
      <button class="chip ${kind==="purchases"?"selected":""}" data-pp-type="purchases">Purchases</button>
    </div>
    ${rows.length ? rows.map(p=>`
      <div class="section-title" style="margin-top:14px;display:flex;justify-content:space-between;">
        <span>${escapeHtml(p.party)}</span><span>${fmt(p.total)}</span>
      </div>
      <div class="card">${p.products.map(pr=>`
        <div class="list-row">
          <div><div class="row-title">${escapeHtml(pr.product)}</div><div class="row-sub">${pr.qty} ${escapeHtml(pr.unit||"")}</div></div>
          <div class="row-right row-title">${fmt(pr.amount)}</div>
        </div>`).join("")}
      </div>
    `).join("") : `<div class="empty-hint">No ${kind} recorded yet.</div>`}
  `;
  body.querySelectorAll("[data-pp-type]").forEach(b=>b.addEventListener("click", ()=>{
    state.partyProductType = b.dataset.ppType;
    renderPartyProductReport(body);
  }));
}
async function renderSupplierReport(body){
  const rows = await api("GET","/reports/supplier-wise");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Supplier Report</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Total purchases and outstanding due per supplier</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.label)}</div>
        <div class="row-sub">${r.purchases} purchase${r.purchases!==1?"s":""}${r.due>0?" · Due "+fmt(r.due):""}</div>
      </div><div class="row-right row-title">${fmt(r.value)}</div></div>
    `).join("") : `<div class="empty-hint">No suppliers yet.</div>`);
}

async function renderSalePaymentsReport(body){
  const rows = await api("GET","/reports/sale-payments");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Sale Payments (Receipts)</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Payments received from customers, newest first</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.customer_name)}</div>
        <div class="row-sub">${escapeHtml(r.payment_date||"")} · ${escapeHtml(r.method)}${r.reference_no?" · Ref# "+escapeHtml(r.reference_no):""}${r.note?" · "+escapeHtml(r.note):""}</div>
      </div>
      <div class="row-right" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <div class="row-title" style="color:var(--ok);">${fmt(r.amount)}</div>
        ${isOwner() ? `<a href="#" data-void-sale-payment="${r.id}" data-customer-id="${r.customer_id}" class="btn-danger-link" style="font-size:11px;">Void</a>` : ""}
      </div></div>
    `).join("") : `<div class="empty-hint">No payments recorded yet.</div>`);
  body.querySelectorAll("[data-void-sale-payment]").forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      if(confirm("Void this payment? The customer's due will go back up.")){
        try{
          await api("POST", `/customers/${a.dataset.customerId}/payments/${a.dataset.voidSalePayment}/void`);
          await loadCustomers();
          await renderSalePaymentsReport(body);
          toast("Payment voided.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
  });
}

async function renderPurchasePaymentsReport(body){
  const rows = await api("GET","/reports/purchase-payments");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Purchase Payments</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Payments made to suppliers, newest first</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.supplier_name)}</div>
        <div class="row-sub">${escapeHtml(r.payment_date||"")} · ${escapeHtml(r.method)}${r.reference_no?" · Ref# "+escapeHtml(r.reference_no):""}${r.note?" · "+escapeHtml(r.note):""}</div>
      </div>
      <div class="row-right" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <div class="row-title" style="color:var(--danger);">${fmt(r.amount)}</div>
        ${isOwner() ? `<a href="#" data-void-purchase-payment="${r.id}" data-supplier-id="${r.supplier_id}" class="btn-danger-link" style="font-size:11px;">Void</a>` : ""}
      </div></div>
    `).join("") : `<div class="empty-hint">No payments recorded yet.</div>`);
  body.querySelectorAll("[data-void-purchase-payment]").forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      if(confirm("Void this payment? The supplier's due will go back up.")){
        try{
          await api("POST", `/suppliers/${a.dataset.supplierId}/payments/${a.dataset.voidPurchasePayment}/void`);
          await loadSuppliers();
          await renderPurchasePaymentsReport(body);
          toast("Payment voided.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
  });
}

async function renderProfitReport(body){
  const d = await api("GET","/reports/profit");
  const missingCost = d.rows.some(r=>!r.hasCost && r.pieces>0);
  // GST is deliberately excluded from every profit figure below — it's tax
  // collected and remitted, not margin — but shown alongside each amount so
  // the two totals (Total = amount + GST) still tie out to what actually
  // changed hands.
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  body.innerHTML = `
    <div style="font-weight:800;font-size:14px;">Profit Report</div>
    <div class="muted" style="font-size:11.5px;margin-bottom:10px;">Sales Amount minus Purchase Amount, both excluding GST</div>
    <div class="card" style="margin-bottom:12px;">
      ${row("Purchase Amount (Excl. GST)", fmt(d.purchaseAmount))}
      ${row("Purchase GST", fmt(d.purchaseGst))}
      ${row("Purchase Total", fmt(d.purchaseTotal), "font-weight:700;border-bottom:1px solid var(--border);padding-bottom:6px;")}
      ${row("Sales Amount (Excl. GST)", fmt(d.salesAmount))}
      ${row("Sales GST", fmt(d.salesGst))}
      ${row("Sales Total", fmt(d.salesTotal), "font-weight:700;border-bottom:1px solid var(--border);padding-bottom:6px;")}
      <div class="inv-flex" style="font-weight:800;font-size:15px;padding-top:4px;"><span>Gross Profit</span><span style="color:${d.grossProfit>=0?'var(--ok)':'var(--danger)'};">${fmt(d.grossProfit)}</span></div>
      ${d.profitPct!=null ? row("Profit %", d.profitPct+"%") : ""}
    </div>
    ${missingCost ? `<div class="muted" style="font-size:11px;margin-bottom:8px;">⚠ Some items sold have no purchase on file, so their purchase side is counted as ₹0 — record a Purchase entry for accurate profit.</div>` : ""}
    <div class="section-title" style="margin-top:0;">Per Sale</div>
    ${d.rows.length ? d.rows.slice(0,50).map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.name)}${!r.hasCost&&r.pieces>0?' <span class="pill warn">no cost on file</span>':""}</div>
        <div class="row-sub">${r.date} · ${escapeHtml(r.challan_no)}</div>
        <div class="row-sub">Sales ${fmt(r.salesAmount)} − Purchase ${fmt(r.purchaseAmount)}${r.pieces>0?" · "+fmt(r.profitPerUnit)+"/unit":""}${r.profitPct!=null?" · "+r.profitPct+"%":""}</div>
      </div><div class="row-right row-title" style="color:${r.grossProfit>=0?'var(--ok)':'var(--danger)'};">${fmt(r.grossProfit)}</div></div>
    `).join("") : `<div class="empty-hint">No sales yet.</div>`}
  `;
}

async function renderProfitByInvoiceReport(body){
  const d = await api("GET","/reports/profit-by-invoice");
  body.innerHTML = `
    <div style="font-weight:800;font-size:14px;">Profit per Invoice</div>
    <div class="muted" style="font-size:11.5px;margin-bottom:10px;">Total profit for each sale, Sales Amount minus Purchase Amount excl. GST</div>
    <div class="card" style="margin-bottom:12px;">
      <div class="inv-flex" style="font-weight:800;font-size:15px;"><span>Gross Profit (All Invoices)</span><span style="color:${d.grossProfit>=0?'var(--ok)':'var(--danger)'};">${fmt(d.grossProfit)}</span></div>
      ${d.profitPct!=null ? `<div class="inv-flex muted" style="font-size:12px;"><span>Profit %</span><span>${d.profitPct}%</span></div>` : ""}
    </div>
    ${d.rows.length ? d.rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.challan_no)}${!r.hasCost?' <span class="pill warn">no cost on file</span>':""}</div>
        <div class="row-sub">${escapeHtml(r.date)} · ${escapeHtml(r.customer)} · ${r.itemCount} item${r.itemCount!==1?"s":""}</div>
        <div class="row-sub">Sales ${fmt(r.salesAmount)} − Purchase ${fmt(r.purchaseAmount)}${r.profitPct!=null?" · "+r.profitPct+"%":""}</div>
      </div><div class="row-right row-title" style="color:${r.grossProfit>=0?'var(--ok)':'var(--danger)'};">${fmt(r.grossProfit)}</div></div>
    `).join("") : `<div class="empty-hint">No sales yet.</div>`}
  `;
}

/* ============================================================
   CASH BOOK
   A standalone running cash ledger — independent of invoices, customers or
   suppliers — for everyday cash in/out (petty cash, wages, expenses) the
   shop still wants tracked. The running balance is always computed over
   ALL history server-side (see server/routes/cashbook.js), so a filtered
   date range still shows the true balance at each point.
   ============================================================ */
function cashBookQuery(){
  const p = new URLSearchParams();
  if(state.cbFrom) p.set("from", state.cbFrom);
  if(state.cbTo) p.set("to", state.cbTo);
  return p.toString();
}
async function renderCashBook(){
  const fromEl = document.getElementById("cb-filter-from");
  const toEl = document.getElementById("cb-filter-to");
  if(fromEl) fromEl.value = state.cbFrom;
  if(toEl) toEl.value = state.cbTo;

  const q = cashBookQuery();
  try{
    const [summary, entries] = await Promise.all([
      api("GET", "/cashbook/summary" + (q?"?"+q:"")),
      api("GET", "/cashbook" + (q?"?"+q:""))
    ]);
    state.cbEntries = entries;
    renderCashBookSummary(summary);
    renderCashBookList(entries);
  }catch(e){ toast(e.message); }
}
function renderCashBookSummary(s){
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("cashbook-summary").innerHTML = `
    <div style="font-weight:800;font-size:14px;margin-bottom:6px;">${s.from===s.to ? s.from : s.from+" to "+s.to}</div>
    ${row("Opening Balance", fmt(s.openingBalance))}
    ${row("Total Cash In", "+"+fmt(s.totalIn), "color:var(--ok);")}
    ${row("Total Cash Out", "-"+fmt(s.totalOut), "color:var(--danger);")}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Closing Balance</span><span>${fmt(s.closingBalance)}</span></div>
  `;
}
function renderCashBookList(entries){
  document.getElementById("cashbook-list").innerHTML = entries.length ? entries.map(e=>`
    <div class="list-row" data-cb-entry="${e.id}" style="cursor:pointer;">
      <div>
        <div class="row-title">${escapeHtml(e.party || e.category || (e.type==="in"?"Cash In":"Cash Out"))}</div>
        <div class="row-sub">${e.date}${e.category && e.party ? " · "+escapeHtml(e.category) : ""}${e.remarks ? " · "+escapeHtml(e.remarks) : ""}</div>
        <div class="row-sub">Balance ${fmt(e.runningBalance)}</div>
      </div>
      <div class="row-right row-title" style="color:${e.type==="in"?"var(--ok)":"var(--danger)"};">${e.type==="in"?"+":"-"}${fmt(e.amount)}</div>
    </div>
  `).join("") : `<div class="empty-hint">No cash entries in this range yet.</div>`;
  document.querySelectorAll("[data-cb-entry]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const entry = state.cbEntries.find(e=>e.id===el.dataset.cbEntry);
      if(entry) openCashEntry(entry.type, entry);
    });
  });
}
/** One sheet serves both "add" (editEntry omitted) and "edit" of a cash entry. */
function openCashEntry(type, editEntry){
  const sheet = document.getElementById("sheet-cash-entry");
  const isIn = type==="in";
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${editEntry ? "Edit " : ""}${isIn ? "Cash In" : "Cash Out"}</div>
    <label class="field-label">Date</label>
    <input type="date" id="cbe-date" value="${editEntry ? editEntry.date : todayISO()}">
    <label class="field-label">Amount (₹)</label>
    <input type="number" inputmode="decimal" step="any" min="0" id="cbe-amount" value="${editEntry ? editEntry.amount : ""}" placeholder="0">
    <label class="field-label">Party / Person <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="cbe-party" value="${editEntry ? escapeHtml(editEntry.party||"") : ""}" placeholder="e.g. Ramesh, Electricity Board">
    <label class="field-label">Category <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="cbe-category" value="${editEntry ? escapeHtml(editEntry.category||"") : ""}" placeholder="e.g. Wages, Electricity, Petty Cash">
    <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="cbe-remarks" value="${editEntry ? escapeHtml(editEntry.remarks||"") : ""}" placeholder="e.g. Advance for June">
    <button class="btn btn-primary" id="cbe-save" style="margin-top:16px;">${editEntry ? "Update Entry" : "Save Entry"}</button>
    ${editEntry && isOwner() ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="cbe-delete-link" class="btn-danger-link">Delete this entry</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#cbe-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("cbe-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
    const payload = {
      date: document.getElementById("cbe-date").value,
      type,
      amount,
      party: document.getElementById("cbe-party").value.trim(),
      category: document.getElementById("cbe-category").value.trim(),
      remarks: document.getElementById("cbe-remarks").value.trim()
    };
    const btn = document.getElementById("cbe-save");
    btn.disabled = true;
    try{
      if(editEntry) await api("PUT", `/cashbook/${editEntry.id}`, payload);
      else await api("POST", "/cashbook", payload);
      closeAllSheets();
      await renderCashBook();
      toast(editEntry ? "Entry updated." : "Entry saved.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });
  const deleteLink = sheet.querySelector("#cbe-delete-link");
  if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm("Delete this cash entry? This can't be undone from here.")){
      try{
        await api("POST", `/cashbook/${editEntry.id}/void`);
        closeAllSheets();
        await renderCashBook();
        toast("Entry deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-cash-entry");
}
function printCashBook(){
  const rows = [...state.cbEntries].reverse();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cash Book</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
    </style></head><body>
    <h1>Cash Book</h1>
    <div class="sub">${state.cbFrom || state.cbTo ? (state.cbFrom||"…")+" to "+(state.cbTo||"…") : "All entries"}</div>
    <table><thead><tr><th>Date</th><th>Party</th><th>Category</th><th>Remarks</th><th class="num">Cash In</th><th class="num">Cash Out</th><th class="num">Balance</th></tr></thead>
    <tbody>${rows.map(e=>`<tr><td>${e.date}</td><td>${escapeHtml(e.party||"")}</td><td>${escapeHtml(e.category||"")}</td><td>${escapeHtml(e.remarks||"")}</td>
      <td class="num">${e.type==="in"?fmt(e.amount):""}</td><td class="num">${e.type==="out"?fmt(e.amount):""}</td><td class="num">${fmt(e.runningBalance)}</td></tr>`).join("")}</tbody></table>
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}

/* ============================================================
   BANK BOOK — identical structure to Cash Book above, a separate running
   balance for the bank account instead of the cash drawer.
   ============================================================ */
function bankBookQuery(){
  const p = new URLSearchParams();
  if(state.bbAccountId) p.set("accountId", state.bbAccountId);
  if(state.bbFrom) p.set("from", state.bbFrom);
  if(state.bbTo) p.set("to", state.bbTo);
  return p.toString();
}
function renderBankAccountChips(){
  const wrap = document.getElementById("bb-account-chips");
  if(!wrap) return;
  const accounts = (state.bankAccounts||[]).filter(a=>a.active);
  if(!state.bbAccountId || !accounts.find(a=>a.id===state.bbAccountId)){
    state.bbAccountId = accounts.length ? accounts[0].id : null;
  }
  wrap.innerHTML = accounts.length ? accounts.map(a=>`
    <button class="chip ${state.bbAccountId===a.id?'selected':''}" data-bb-account="${a.id}">${escapeHtml(a.name)}</button>
  `).join("") : `<div class="empty-hint" style="padding:8px 4px;">No bank accounts yet — tap "Manage Accounts" to add one.</div>`;
  wrap.querySelectorAll("[data-bb-account]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.bbAccountId = b.dataset.bbAccount;
      renderBankBook();
    });
  });
}
async function renderBankBook(){
  await loadBankAccounts();
  renderBankAccountChips();
  const fromEl = document.getElementById("bb-filter-from");
  const toEl = document.getElementById("bb-filter-to");
  if(fromEl) fromEl.value = state.bbFrom;
  if(toEl) toEl.value = state.bbTo;

  if(!state.bbAccountId){
    document.getElementById("bankbook-summary").innerHTML = "";
    document.getElementById("bankbook-list").innerHTML = `<div class="empty-hint">Add a bank account above to get started.</div>`;
    state.bbEntries = [];
    return;
  }

  const q = bankBookQuery();
  try{
    const [summary, entries] = await Promise.all([
      api("GET", "/bankbook/summary" + (q?"?"+q:"")),
      api("GET", "/bankbook" + (q?"?"+q:""))
    ]);
    state.bbEntries = entries;
    renderBankBookSummary(summary);
    renderBankBookList(entries);
  }catch(e){ toast(e.message); }
}
function renderBankBookSummary(s){
  const account = (state.bankAccounts||[]).find(a=>a.id===state.bbAccountId);
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("bankbook-summary").innerHTML = `
    <div style="font-weight:800;font-size:14px;margin-bottom:2px;">${account?escapeHtml(account.name):""}</div>
    <div class="muted" style="font-size:11.5px;margin-bottom:6px;">${s.from===s.to ? s.from : s.from+" to "+s.to}</div>
    ${row("Opening Balance", fmt(s.openingBalance))}
    ${row("Total Bank In", "+"+fmt(s.totalIn), "color:var(--ok);")}
    ${row("Total Bank Out", "-"+fmt(s.totalOut), "color:var(--danger);")}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Closing Balance</span><span>${fmt(s.closingBalance)}</span></div>
  `;
}
/** A row auto-posted from a Customer Receipt/Supplier Payment, or one leg of
 *  a Deposit/Withdrawal/Transfer, can't be edited or voided from here (the
 *  backend rejects it) — those rows render without a click handler and with
 *  a small note instead, matching what the API will actually let you do. */
function renderBankBookList(entries){
  document.getElementById("bankbook-list").innerHTML = entries.length ? entries.map(e=>{
    const editable = !e.source_type && !e.link_id;
    const title = e.party || e.txn_type || e.category || (e.type==="in"?"Bank In":"Bank Out");
    const subParts = [e.date];
    if(e.txn_type) subParts.push(e.txn_type); else if(e.category) subParts.push(e.category);
    if(e.payment_mode) subParts.push(e.payment_mode);
    if(e.reference_no) subParts.push("Ref "+e.reference_no);
    return `
    <div class="list-row" ${editable?`data-bb-entry="${e.id}" style="cursor:pointer;"`:""}>
      <div>
        <div class="row-title">${escapeHtml(title)}</div>
        <div class="row-sub">${subParts.map(escapeHtml).join(" · ")}</div>
        ${e.remarks ? `<div class="row-sub">${escapeHtml(e.remarks)}</div>` : ""}
        <div class="row-sub">Balance ${fmt(e.runningBalance)}${!editable?` · <span class="muted">auto-posted, not editable here</span>`:""}</div>
      </div>
      <div class="row-right row-title" style="color:${e.type==="in"?"var(--ok)":"var(--danger)"};">${e.type==="in"?"+":"-"}${fmt(e.amount)}</div>
    </div>
  `;
  }).join("") : `<div class="empty-hint">No bank entries in this range yet.</div>`;
  document.querySelectorAll("[data-bb-entry]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const entry = state.bbEntries.find(e=>e.id===el.dataset.bbEntry);
      if(entry) openBankEntry(entry);
    });
  });
}

/* ------------------------------------------------------------------
   SHEET: Bank Entry — one unified form for every Bank Entry Module
   transaction type. Deposit/Withdrawal/Transfer post straight to
   bankbook.js; Customer Receipt/Supplier Payment post through the
   existing customer/supplier payment routes (see server/bankLink.js)
   so due and the ledger stay a single source of truth; the rest are
   plain bankbook.js entries with a fixed direction.
   ------------------------------------------------------------------ */
const BANK_TXN_TYPES = ["Bank Deposit","Bank Withdrawal","Bank Transfer","Customer Receipt","Supplier Payment","Bank Charges","Interest Received","Refund"];
function wireChipGroup(sheet, containerSel, itemSel){
  sheet.querySelectorAll(`${containerSel} ${itemSel}`).forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll(`${containerSel} ${itemSel}`).forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
}
function bankAccountChipsInner(selectedId){
  const accounts = (state.bankAccounts||[]).filter(a=>a.active);
  if(!accounts.length) return `<span class="muted" style="font-size:12px;">No bank accounts yet — add one via "Manage Accounts".</span>`;
  return accounts.map((a,i)=>`<button class="chip ${selectedId?(selectedId===a.id?'selected':''):(i===0?'selected':'')}" data-be-account="${a.id}">${escapeHtml(a.name)}</button>`).join("");
}
function renderBankEntryTypeFields(sheet, type){
  const wrap = sheet.querySelector("#be-fields");
  const defaultAccount = state.bbAccountId;

  if(type==="Bank Deposit" || type==="Bank Withdrawal"){
    wrap.innerHTML = `
      <label class="field-label">${type==="Bank Deposit"?"Deposit into":"Withdraw from"} Account</label>
      <div class="chip-row" id="be-account-chips">${bankAccountChipsInner(defaultAccount)}</div>
      <label class="field-label">Amount (₹)</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="be-amount" placeholder="0">
      <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-reference" placeholder="e.g. deposit slip no.">
      <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-remarks" placeholder="">
      <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="file" id="be-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    `;
    wireChipGroup(sheet, "#be-account-chips", "[data-be-account]");
    return;
  }

  if(type==="Bank Transfer"){
    wrap.innerHTML = `
      <label class="field-label">From Account</label>
      <div class="chip-row" id="be-from-chips">${bankAccountChipsInner(defaultAccount)}</div>
      <label class="field-label">To Account</label>
      <div class="chip-row" id="be-to-chips">${(state.bankAccounts||[]).filter(a=>a.active).map(a=>`<button class="chip" data-be-to="${a.id}">${escapeHtml(a.name)}</button>`).join("")}</div>
      <label class="field-label">Amount (₹)</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="be-amount" placeholder="0">
      <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-reference" placeholder="">
      <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-remarks" placeholder="">
      <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="file" id="be-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    `;
    wireChipGroup(sheet, "#be-from-chips", "[data-be-account]");
    wireChipGroup(sheet, "#be-to-chips", "[data-be-to]");
    return;
  }

  if(type==="Customer Receipt" || type==="Supplier Payment"){
    const isCust = type==="Customer Receipt";
    const list = isCust ? state.customers : state.suppliers;
    wrap.innerHTML = `
      <label class="field-label">${isCust?"Customer":"Supplier"}</label>
      <div class="searchbar" style="margin-top:0;"><span>&#128269;</span><input type="text" id="be-party-search" placeholder="Search by name${isCust?' or phone':''}"></div>
      <div class="chip-row" id="be-party-chips" style="margin-top:8px;"></div>
      <label class="field-label">Amount (₹)</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="be-amount" placeholder="0">
      <label class="field-label">Payment Mode</label>
      <div class="chip-row" id="be-method-chips">
        ${PAYMENT_MODES.map((m,i)=>`<button class="chip ${i===0?'selected':''}" data-be-method="${m}">${m}</button>`).join("")}
      </div>
      <label class="field-label" id="be-bankacct-label" style="display:none;">Bank Account</label>
      <div class="chip-row" id="be-bankacct-chips" style="display:none;">${bankAccountChipsInner(defaultAccount)}</div>
      <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-reference" placeholder="">
      <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-remarks" placeholder="">
      <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="file" id="be-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    `;
    let selectedPartyId = null;
    const renderPartyChips = (q) => {
      q = (q||"").toLowerCase();
      let matches = list;
      if(q) matches = list.filter(x=>x.name.toLowerCase().includes(q) || (isCust && (x.phone||"").includes(q)));
      matches = matches.slice(0,8);
      const chipsEl = sheet.querySelector("#be-party-chips");
      chipsEl.innerHTML = matches.length ? matches.map(x=>`<button class="chip ${selectedPartyId===x.id?'selected':''}" data-be-party="${x.id}">${escapeHtml(x.name)}</button>`).join("")
        : `<span class="muted" style="font-size:12px;">No match.</span>`;
      chipsEl.querySelectorAll("[data-be-party]").forEach(b=>b.addEventListener("click", ()=>{
        selectedPartyId = b.dataset.beParty;
        chipsEl.querySelectorAll("[data-be-party]").forEach(x=>x.classList.remove("selected"));
        b.classList.add("selected");
      }));
    };
    renderPartyChips("");
    sheet.querySelector("#be-party-search").addEventListener("input", (ev)=>renderPartyChips(ev.target.value));
    sheet._beSelectedPartyId = () => selectedPartyId;
    sheet.querySelectorAll("[data-be-method]").forEach(b=>b.addEventListener("click", ()=>{
      sheet.querySelectorAll("[data-be-method]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
      const show = b.dataset.beMethod !== "Cash";
      sheet.querySelector("#be-bankacct-label").style.display = show?"":"none";
      sheet.querySelector("#be-bankacct-chips").style.display = show?"":"none";
    }));
    wireChipGroup(sheet, "#be-bankacct-chips", "[data-be-account]");
    return;
  }

  if(type==="Bank Charges" || type==="Interest Received"){
    wrap.innerHTML = `
      <label class="field-label">Bank Account</label>
      <div class="chip-row" id="be-account-chips">${bankAccountChipsInner(defaultAccount)}</div>
      <label class="field-label">Amount (₹)</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="be-amount" placeholder="0">
      <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-reference" placeholder="">
      <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-remarks" placeholder="">
      <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="file" id="be-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    `;
    wireChipGroup(sheet, "#be-account-chips", "[data-be-account]");
    return;
  }

  if(type==="Refund"){
    wrap.innerHTML = `
      <label class="field-label">Bank Account</label>
      <div class="chip-row" id="be-account-chips">${bankAccountChipsInner(defaultAccount)}</div>
      <label class="field-label">Direction</label>
      <div class="chip-row" id="be-dir-chips">
        <button class="chip" data-be-dir="in">Money In (received)</button>
        <button class="chip selected" data-be-dir="out">Money Out (refunded)</button>
      </div>
      <label class="field-label">Party <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-party" placeholder="e.g. customer or supplier name">
      <label class="field-label">Amount (₹)</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="be-amount" placeholder="0">
      <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-reference" placeholder="">
      <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="be-remarks" placeholder="">
      <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="file" id="be-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
    `;
    wireChipGroup(sheet, "#be-account-chips", "[data-be-account]");
    wireChipGroup(sheet, "#be-dir-chips", "[data-be-dir]");
    return;
  }
}
async function saveBankEntry(sheet, type){
  const btn = sheet.querySelector("#be-save");
  const date = document.getElementById("be-date").value;
  const amount = parseFloat((document.getElementById("be-amount")||{}).value);
  if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
  btn.disabled = true;
  try{
    const attachment = await readAttachmentInput(document.getElementById("be-attachment"));
    const remarks = (document.getElementById("be-remarks")||{}).value?.trim() || "";
    const referenceNo = (document.getElementById("be-reference")||{}).value?.trim() || "";

    if(type==="Bank Deposit" || type==="Bank Withdrawal"){
      const accEl = sheet.querySelector("#be-account-chips [data-be-account].selected");
      if(!accEl){ toast("Choose a bank account."); btn.disabled=false; return; }
      const endpoint = type==="Bank Deposit" ? "/bankbook/deposit" : "/bankbook/withdrawal";
      await api("POST", endpoint, { date, accountId: accEl.dataset.beAccount, amount, referenceNo, remarks, attachment });

    } else if(type==="Bank Transfer"){
      const fromEl = sheet.querySelector("#be-from-chips [data-be-account].selected");
      const toEl = sheet.querySelector("#be-to-chips [data-be-to].selected");
      if(!fromEl || !toEl){ toast("Choose both accounts to transfer between."); btn.disabled=false; return; }
      if(fromEl.dataset.beAccount === toEl.dataset.beTo){ toast("Choose two different accounts."); btn.disabled=false; return; }
      await api("POST", "/bankbook/transfer", { date, fromAccountId: fromEl.dataset.beAccount, toAccountId: toEl.dataset.beTo, amount, referenceNo, remarks, attachment });

    } else if(type==="Customer Receipt" || type==="Supplier Payment"){
      const isCust = type==="Customer Receipt";
      const partyId = sheet._beSelectedPartyId ? sheet._beSelectedPartyId() : null;
      if(!partyId){ toast(`Choose a ${isCust?"customer":"supplier"}.`); btn.disabled=false; return; }
      const method = sheet.querySelector("#be-method-chips [data-be-method].selected").dataset.beMethod;
      const bankAccEl = sheet.querySelector("#be-bankacct-chips [data-be-account].selected");
      if(method!=="Cash" && !bankAccEl){ toast("Choose a bank account for this payment mode."); btn.disabled=false; return; }
      const path = isCust ? `/customers/${partyId}/payments` : `/suppliers/${partyId}/payments`;
      await api("POST", path, { amount, method, bankAccountId: method==="Cash"?null:bankAccEl.dataset.beAccount, referenceNo, note: remarks, date, attachment });

    } else if(type==="Bank Charges" || type==="Interest Received"){
      const accEl = sheet.querySelector("#be-account-chips [data-be-account].selected");
      if(!accEl){ toast("Choose a bank account."); btn.disabled=false; return; }
      await api("POST", "/bankbook", { date, accountId: accEl.dataset.beAccount, type: type==="Bank Charges"?"out":"in", txnType: type, amount, referenceNo, remarks, attachment });

    } else if(type==="Refund"){
      const accEl = sheet.querySelector("#be-account-chips [data-be-account].selected");
      if(!accEl){ toast("Choose a bank account."); btn.disabled=false; return; }
      const dir = sheet.querySelector("#be-dir-chips [data-be-dir].selected").dataset.beDir;
      const party = (document.getElementById("be-party")||{}).value?.trim() || "";
      await api("POST", "/bankbook", { date, accountId: accEl.dataset.beAccount, type: dir, txnType: "Refund", party, referenceNo, remarks, attachment });
    }

    closeAllSheets();
    await renderBankBook();
    await renderHome();
    toast("Entry saved.", "ok");
  }catch(err){ toast(err.message); }
  finally{ btn.disabled = false; }
}
/** ADD mode (no editEntry): full transaction-type switcher, dispatching to
 *  whichever endpoint that type actually needs (see saveBankEntry). EDIT
 *  mode only ever reaches a plain, directly-entered row — renderBankBookList
 *  never attaches a click handler to a source-linked or paired one — so it's
 *  a fixed, simpler form straight onto PUT /bankbook/:id. */
function openBankEntry(editEntry){
  const sheet = document.getElementById("sheet-bank-entry");
  const e = editEntry;

  if(e){
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">Edit ${escapeHtml(e.txn_type || e.category || (e.type==="in"?"Bank In":"Bank Out"))}</div>
      <label class="field-label">Date</label>
      <input type="date" id="bbe-date" value="${e.date}">
      <label class="field-label">Bank Account</label>
      <div class="chip-row" id="bbe-account-chips">${bankAccountChipsInner(e.bank_account_id)}</div>
      <label class="field-label">Type</label>
      <div class="chip-row" id="bbe-dir-chips">
        <button class="chip ${e.type==='in'?'selected':''}" data-dir="in">Bank In</button>
        <button class="chip ${e.type==='out'?'selected':''}" data-dir="out">Bank Out</button>
      </div>
      <label class="field-label">Amount (₹)</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="bbe-amount" value="${e.amount}">
      <label class="field-label">Party <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="bbe-party" value="${escapeHtml(e.party||"")}">
      <label class="field-label">Payment Mode <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="bbe-mode" value="${escapeHtml(e.payment_mode||"")}">
      <label class="field-label">Reference No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="bbe-reference" value="${escapeHtml(e.reference_no||"")}">
      <label class="field-label">Remarks <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="bbe-remarks" value="${escapeHtml(e.remarks||"")}">
      <label class="field-label">Attachment <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="file" id="bbe-attachment" accept="image/jpeg,image/png,image/webp,application/pdf">
      ${e.attachment_path ? `<div class="muted" style="font-size:11px;margin-top:2px;">Current: <a href="/api/attachments/${e.attachment_path}" target="_blank">${escapeHtml(e.attachment_name||"attachment")}</a> — choose a new file to replace it.</div>` : ""}
      <button class="btn btn-primary" id="bbe-save" style="margin-top:16px;">Update Entry</button>
      ${isOwner() ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="bbe-delete-link" class="btn-danger-link">Delete this entry</a></div>` : ""}
    `;
    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    wireChipGroup(sheet, "#bbe-account-chips", "[data-be-account]");
    wireChipGroup(sheet, "#bbe-dir-chips", "[data-dir]");
    sheet.querySelector("#bbe-save").addEventListener("click", async ()=>{
      const amount = parseFloat(document.getElementById("bbe-amount").value);
      if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
      const accountEl = sheet.querySelector("#bbe-account-chips [data-be-account].selected");
      if(!accountEl){ toast("Choose a bank account."); return; }
      const btn = document.getElementById("bbe-save");
      btn.disabled = true;
      try{
        const attachment = await readAttachmentInput(document.getElementById("bbe-attachment"));
        await api("PUT", `/bankbook/${e.id}`, {
          date: document.getElementById("bbe-date").value,
          accountId: accountEl.dataset.beAccount,
          type: sheet.querySelector("#bbe-dir-chips [data-dir].selected").dataset.dir,
          amount,
          party: document.getElementById("bbe-party").value.trim(),
          paymentMode: document.getElementById("bbe-mode").value.trim(),
          referenceNo: document.getElementById("bbe-reference").value.trim(),
          remarks: document.getElementById("bbe-remarks").value.trim(),
          attachment
        });
        closeAllSheets();
        await renderBankBook();
        toast("Entry updated.", "ok");
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; }
    });
    const deleteLink = sheet.querySelector("#bbe-delete-link");
    if(deleteLink) deleteLink.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      if(confirm("Delete this bank entry? This can't be undone from here.")){
        try{
          await api("POST", `/bankbook/${e.id}/void`);
          closeAllSheets();
          await renderBankBook();
          toast("Entry deleted.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
    showSheet("sheet-bank-entry");
    return;
  }

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">New Bank Entry</div>
    <label class="field-label">Transaction Type</label>
    <div class="chip-row" id="be-type-chips">
      ${BANK_TXN_TYPES.map((t,i)=>`<button class="chip ${i===0?'selected':''}" data-type="${t}">${t}</button>`).join("")}
    </div>
    <label class="field-label">Date</label>
    <input type="date" id="be-date" value="${todayISO()}">
    <div id="be-fields"></div>
    <button class="btn btn-primary" id="be-save" style="margin-top:16px;">Save Entry</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  let currentType = BANK_TXN_TYPES[0];
  renderBankEntryTypeFields(sheet, currentType);
  sheet.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-type]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
    currentType = b.dataset.type;
    renderBankEntryTypeFields(sheet, currentType);
  }));
  sheet.querySelector("#be-save").addEventListener("click", ()=>saveBankEntry(sheet, currentType));
  showSheet("sheet-bank-entry");
}

/* ------------------------------------------------------------------
   SHEET: Manage Bank Accounts — list with live balances, add new,
   archive/reactivate (archived accounts drop out of every picker but
   keep their history and balance).
   ------------------------------------------------------------------ */
function openManageBankAccounts(){
  const sheet = document.getElementById("sheet-bank-account");
  let editingId = null;
  const renderList = () => {
    const accounts = state.bankAccounts||[];
    const editing = editingId ? accounts.find(a=>a.id===editingId) : null;
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">Bank Accounts</div>
      <div class="card" id="bam-list" style="margin-bottom:14px;">
        ${accounts.length ? accounts.map(a=>`
          <div class="list-row">
            <div>
              <div class="row-title">${escapeHtml(a.name)}${a.active?"":' <span class="pill">Archived</span>'}</div>
              <div class="row-sub">${escapeHtml(a.bank_name||"")}${a.account_no?" · "+escapeHtml(a.account_no):""}</div>
            </div>
            <div class="row-right" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
              <div class="row-title">${fmt(a.balance)}</div>
              <div style="display:flex;gap:10px;">
                <a href="#" data-bam-edit="${a.id}" style="font-size:11px;">Edit</a>
                ${isOwner() ? `<a href="#" data-bam-toggle="${a.id}" data-bam-active="${a.active}" style="font-size:11px;">${a.active?"Archive":"Reactivate"}</a>` : ""}
              </div>
            </div>
          </div>
        `).join("") : `<div class="empty-hint">No bank accounts yet.</div>`}
      </div>
      <div class="section-title" style="margin-top:0;">${editing?"Edit Account":"Add Account"}</div>
      <label class="field-label">Account Name</label>
      <input type="text" id="bam-name" value="${editing?escapeHtml(editing.name):""}" placeholder="e.g. HDFC Current A/c">
      <label class="field-label">Bank Name <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="bam-bank-name" value="${editing?escapeHtml(editing.bank_name||""):""}" placeholder="e.g. HDFC Bank">
      <label class="field-label">Account No. <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="bam-account-no" value="${editing?escapeHtml(editing.account_no||""):""}" placeholder="">
      <label class="field-label">Opening Balance (₹) <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="number" inputmode="decimal" step="any" id="bam-opening" value="${editing?editing.opening_balance:""}" placeholder="0">
      <button class="btn btn-primary" id="bam-save" style="margin-top:16px;">${editing?"Update Account":"Add Account"}</button>
      ${editing ? `<div style="margin-top:10px;text-align:center;"><a href="#" id="bam-cancel-edit">Cancel edit</a></div>` : ""}
    `;
    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-bam-edit]").forEach(link=>link.addEventListener("click", (ev)=>{
      ev.preventDefault();
      editingId = link.dataset.bamEdit;
      renderList();
    }));
    const cancelLink = sheet.querySelector("#bam-cancel-edit");
    if(cancelLink) cancelLink.addEventListener("click", (ev)=>{
      ev.preventDefault();
      editingId = null;
      renderList();
    });
    sheet.querySelectorAll("[data-bam-toggle]").forEach(link=>link.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      const nowActive = link.dataset.bamActive !== "1";
      try{
        await api("POST", `/bank-accounts/${link.dataset.bamToggle}/active`, { active: nowActive });
        await loadBankAccounts();
        renderList();
        renderBankAccountChips();
        toast(nowActive?"Account reactivated.":"Account archived.", "ok");
      }catch(err){ toast(err.message); }
    }));
    sheet.querySelector("#bam-save").addEventListener("click", async ()=>{
      const name = document.getElementById("bam-name").value.trim();
      if(!name){ toast("Enter an account name."); return; }
      const btn = document.getElementById("bam-save");
      btn.disabled = true;
      try{
        const payload = {
          name,
          bankName: document.getElementById("bam-bank-name").value.trim(),
          accountNo: document.getElementById("bam-account-no").value.trim(),
          openingBalance: parseFloat(document.getElementById("bam-opening").value) || 0
        };
        if(editing) await api("PUT", `/bank-accounts/${editing.id}`, payload);
        else await api("POST", "/bank-accounts", payload);
        editingId = null;
        await loadBankAccounts();
        renderList();
        renderBankAccountChips();
        toast(editing?"Bank account updated.":"Bank account added.", "ok");
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; }
    });
  };
  renderList();
  showSheet("sheet-bank-account");
}
function printBankBook(){
  const rows = [...state.bbEntries].reverse();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bank Book</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
    </style></head><body>
    <h1>Bank Book</h1>
    <div class="sub">${state.bbFrom || state.bbTo ? (state.bbFrom||"…")+" to "+(state.bbTo||"…") : "All entries"}</div>
    <table><thead><tr><th>Date</th><th>Party</th><th>Category</th><th>Remarks</th><th class="num">Bank In</th><th class="num">Bank Out</th><th class="num">Balance</th></tr></thead>
    <tbody>${rows.map(e=>`<tr><td>${e.date}</td><td>${escapeHtml(e.party||"")}</td><td>${escapeHtml(e.category||"")}</td><td>${escapeHtml(e.remarks||"")}</td>
      <td class="num">${e.type==="in"?fmt(e.amount):""}</td><td class="num">${e.type==="out"?fmt(e.amount):""}</td><td class="num">${fmt(e.runningBalance)}</td></tr>`).join("")}</tbody></table>
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}

/* ============================================================
   CUSTOMER INQUIRY BOOK
   ============================================================ */
const INQUIRY_STATUSES = ["Open","Follow-up","Converted to Sale","Closed"];
function inquiryStatusPillClass(status){
  if(status==="Converted to Sale") return "ok";
  if(status==="Closed") return "";
  return "warn"; // Open, Follow-up — both still need action
}
function nowTimeInputValue(){
  const d = new Date();
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}
async function renderInquiries(){
  const wrap = document.getElementById("inq-status-chips");
  wrap.innerHTML = ["All",...INQUIRY_STATUSES].map(s=>`
    <button class="chip ${state.inqStatus===s?'selected':''}" data-inq-status="${escapeHtml(s)}">${escapeHtml(s)}</button>
  `).join("");
  wrap.querySelectorAll("[data-inq-status]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.inqStatus = b.dataset.inqStatus;
      renderInquiries();
    });
  });

  const q = state.inqStatus!=="All" ? "?status="+encodeURIComponent(state.inqStatus) : "";
  try{ state.inquiries = await api("GET", "/inquiries"+q); }
  catch(e){ toast(e.message); return; }
  renderInquiryList(state.inquiries);
}
function renderInquiryList(list){
  document.getElementById("inquiries-list").innerHTML = list.length ? list.map(i=>`
    <div class="list-row" data-inq="${i.id}" style="cursor:pointer;">
      <div>
        <div class="row-title">${escapeHtml(i.customer_name)}</div>
        <div class="row-sub">${escapeHtml(i.inquiry_no)} · ${i.date}${i.time?" "+i.time:""}</div>
        <div class="row-sub">${[i.mobile, i.company_name, i.salesperson].filter(Boolean).map(escapeHtml).join(" · ")}</div>
      </div>
      <div class="row-right"><span class="pill ${inquiryStatusPillClass(i.status)}">${escapeHtml(i.status)}</span></div>
    </div>
  `).join("") : `<div class="empty-hint">No inquiries yet. Tap "+ New Inquiry" to log one.</div>`;
  document.querySelectorAll("[data-inq]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const inq = state.inquiries.find(i=>i.id===el.dataset.inq);
      if(inq) openInquiry(inq);
    });
  });
}
/** One sheet serves both "add" (editEntry omitted) and "edit" of an inquiry. */
function openInquiry(editEntry){
  const sheet = document.getElementById("sheet-inquiry");
  const e = editEntry;
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${e?"Edit Inquiry":"New Inquiry"}</div>
    ${e?`<div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(e.inquiry_no)}</div>`:""}
    <div class="charge-grid">
      <label class="dim"><span>Date</span><input type="date" id="inq-date" value="${e?e.date:todayISO()}"></label>
      <label class="dim"><span>Time</span><input type="time" id="inq-time" value="${e?e.time:nowTimeInputValue()}"></label>
    </div>
    <label class="field-label">Customer Name</label>
    <input type="text" id="inq-customer" value="${e?escapeHtml(e.customer_name):""}" placeholder="e.g. Ramesh Sharma">
    <label class="field-label">Mobile Number</label>
    <input type="tel" id="inq-mobile" value="${e?escapeHtml(e.mobile||""):""}" placeholder="e.g. 9876543210">
    <label class="field-label">Company Name <span class="muted" style="font-weight:400;">— optional</span></label>
    <input type="text" id="inq-company" value="${e?escapeHtml(e.company_name||""):""}" placeholder="e.g. ABC Constructions">
    <label class="field-label">Salesperson</label>
    <div class="chip-row" id="inq-salesperson-chips">
      ${state.staffNames.map(s=>`<button class="chip ${(e?e.salesperson===s.name:s.name===state.me.staffName)?'selected':''}" data-inq-salesperson="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`).join("")}
    </div>
    <label class="field-label">Status</label>
    <div class="chip-row" id="inq-status-form-chips">
      ${INQUIRY_STATUSES.map(s=>`<button class="chip ${(e?e.status:"Open")===s?'selected':''}" data-inq-status-form="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
    </div>
    <button class="btn btn-primary" id="inq-save" style="margin-top:16px;">${e?"Update Inquiry":"Save Inquiry"}</button>
    ${e && isOwner() ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="inq-delete-link" class="btn-danger-link">Delete this inquiry</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  wireChipGroup(sheet, "#inq-salesperson-chips", "[data-inq-salesperson]");
  wireChipGroup(sheet, "#inq-status-form-chips", "[data-inq-status-form]");
  sheet.querySelector("#inq-save").addEventListener("click", async ()=>{
    const customerName = document.getElementById("inq-customer").value.trim();
    if(!customerName){ toast("Enter the customer's name."); return; }
    const btn = document.getElementById("inq-save");
    btn.disabled = true;
    try{
      const salespersonEl = sheet.querySelector("#inq-salesperson-chips [data-inq-salesperson].selected");
      const statusEl = sheet.querySelector("#inq-status-form-chips [data-inq-status-form].selected");
      const payload = {
        date: document.getElementById("inq-date").value,
        time: document.getElementById("inq-time").value,
        customerName,
        mobile: document.getElementById("inq-mobile").value.trim(),
        companyName: document.getElementById("inq-company").value.trim(),
        salesperson: salespersonEl ? salespersonEl.dataset.inqSalesperson : "",
        status: statusEl ? statusEl.dataset.inqStatusForm : "Open"
      };
      if(e) await api("PUT", `/inquiries/${e.id}`, payload);
      else await api("POST", "/inquiries", payload);
      closeAllSheets();
      await renderInquiries();
      toast(e?"Inquiry updated.":"Inquiry saved.", "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  });
  const deleteLink = sheet.querySelector("#inq-delete-link");
  if(deleteLink) deleteLink.addEventListener("click", async (ev)=>{
    ev.preventDefault();
    if(confirm("Delete this inquiry? This can't be undone from here.")){
      try{
        await api("POST", `/inquiries/${e.id}/void`);
        closeAllSheets();
        await renderInquiries();
        toast("Inquiry deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-inquiry");
}

/* ============================================================
   PURCHASE ENTRY (Phase 1 — core multi-line invoice)
   ============================================================ */
async function renderPurchaseScreen(){
  if(!state.pur.date) state.pur.date = todayISO();
  const dateEl = document.getElementById("pur-date");
  if(dateEl && !dateEl.value) dateEl.value = state.pur.date;
  if(!state.pur.locationId){
    const warehouse = state.locations.find(l=>l.code==="warehouse");
    if(warehouse) state.pur.locationId = warehouse.id;
  }
  renderPurchaseEditBanner();
  renderPurchaseLocationChips();
  renderPurchaseSuppliers();
  renderPurchaseSupplierInfo();
  renderPurchaseProducts();
  renderPurchaseCart();
  setPurDocType(state.pur.docType);
}
/**
 * Shows the number THIS purchase will get before it's saved — mirrors
 * renderQuotationNumber(). Editing an existing purchase already knows its
 * real purchase_no (set by editExistingPurchase); a brand-new one asks the
 * server for a live peek at the next number (see GET /purchases/next-number).
 */
async function renderPurchaseNumber(){
  const el = document.getElementById("pur-number-display");
  if(!el) return;
  const label = document.getElementById("pur-number-label");
  if(label) label.textContent = state.pur.docType === "challan" ? "Challan No." : "Purchase No.";
  if(state.pur.editingPurchaseId && state.pur.purchaseNo){
    el.textContent = state.pur.purchaseNo;
    return;
  }
  el.textContent = "…";
  try{
    const { purchaseNo } = await api("GET", `/purchases/next-number?docType=${state.pur.docType}`);
    state.pur.purchaseNo = purchaseNo;
    el.textContent = purchaseNo;
  }catch{
    el.textContent = "—";
  }
}
function renderPurchaseLocationChips(){
  const wrap = document.getElementById("pur-location-chips");
  if(!wrap) return;
  wrap.innerHTML = state.locations.map(l=>`
    <button class="chip ${state.pur.locationId===l.id?'selected':''}" data-pur-location="${l.id}">${escapeHtml(l.name)}</button>
  `).join("");
  wrap.querySelectorAll("[data-pur-location]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.pur.locationId = b.dataset.purLocation;
      renderPurchaseLocationChips();
    });
  });
}
/** Small dismissible banner shown atop New Purchase while an existing
 *  purchase is being edited — mirrors renderEditModeBanner() on Billing. */
function renderPurchaseEditBanner(){
  const el = document.getElementById("pur-edit-mode-banner");
  if(!el) return;
  if(!state.pur.editingPurchaseId){ el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="card" style="background:var(--warn-bg);border-color:var(--warn-text);margin-bottom:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="font-size:12px;font-weight:700;color:var(--warn-text);">✎ Editing an existing purchase — Save below will UPDATE it, not create a new one.</div>
      <a href="#" id="cancel-purchase-edit-link" style="font-size:12px;font-weight:800;color:var(--warn-text);white-space:nowrap;">Cancel</a>
    </div>
  `;
  document.getElementById("cancel-purchase-edit-link").addEventListener("click", (e)=>{
    e.preventDefault();
    state.pur = {
      docType: "purchase", supplierId: null, purchaseType: "Local", paymentMethod: "Credit",
      date: "", invoiceNo: "", dueDate: "", vehicleNumber: "", transportName: "", lrNumber: "", remarks: "",
      transport: 0, loading: 0, otherCharges: 0, roundOff: true, cart: [], editingPurchaseId: null, locationId: null,
      gstEnabled: true, purchaseNo: null
    };
    const set = (id, val) => { const inp=document.getElementById(id); if(inp) inp.value = val; };
    set("pur-invoice-no", ""); set("pur-due-date", ""); set("pur-vehicle", "");
    set("pur-transport-name", ""); set("pur-lr", ""); set("pur-remarks", "");
    set("pur-transport-input", 0); set("pur-loading-input", 0); set("pur-other-input", 0);
    document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.toggle("selected", x.dataset.purType==="Local"));
    document.querySelectorAll('[data-pur-pay]').forEach(x=>x.classList.toggle("selected", x.dataset.purPay==="Credit"));
    setPurGstEnabled(true);
    setPurDocType("purchase");
    renderPurchaseScreen();
    toast("Edit cancelled.");
  });
}
function renderPurchaseSuppliers(){
  const wrap = document.getElementById("pur-suppliers");
  const searchEl = document.getElementById("pur-supplier-search");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  const selected = state.suppliers.find(s=>s.id===state.pur.supplierId);
  let list = state.suppliers;
  if(q) list = list.filter(s=>s.name.toLowerCase().includes(q) || (s.phone||"").includes(q));
  if(selected && !list.includes(selected)) list = [selected, ...list];

  wrap.innerHTML = list.map(s=>`
    <button class="chip ${state.pur.supplierId===s.id?'selected':''}" data-pur-sup="${s.id}">${escapeHtml(s.name)}</button>
  `).join("") || `<div class="empty-hint" style="padding:8px 4px;">${q ? `No supplier matches "${escapeHtml(q)}".` : "No suppliers yet — add one from the Suppliers tab."}</div>`;

  wrap.querySelectorAll("[data-pur-sup]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.pur.supplierId = b.dataset.purSup;
      // Default Purchase Type from the supplier's own GST Type, same first-guess
      // pattern Billing uses for a customer — staff can still override via chips.
      const sup = state.suppliers.find(s=>s.id===state.pur.supplierId);
      state.pur.purchaseType = (sup && sup.gst_type === "IGST") ? "Interstate" : "Local";
      document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.toggle("selected", x.dataset.purType===state.pur.purchaseType));
      renderPurchaseSuppliers();
      renderPurchaseSupplierInfo();
      renderPurchaseTotals();
    });
  });
}
function renderPurchaseSupplierInfo(){
  const box = document.getElementById("pur-supplier-info");
  const sup = state.suppliers.find(s=>s.id===state.pur.supplierId);
  if(!sup){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div><strong>${escapeHtml(sup.name)}</strong></div>
    ${sup.phone ? `<div class="muted">${escapeHtml(sup.phone)}</div>` : ""}
    ${sup.gst ? `<div class="muted">GST: ${escapeHtml(sup.gst)}</div>` : ""}
    ${sup.state ? `<div class="muted">${escapeHtml(sup.state)}</div>` : ""}
    ${sup.address ? `<div class="muted">${escapeHtml(sup.address)}</div>` : ""}
    ${sup.due>0 ? `<div style="color:var(--danger);font-weight:700;margin-top:4px;">Payable due: ${fmt(sup.due)}</div>` : ""}
  `;
}
function renderPurchaseProducts(){
  const q = (document.getElementById("pur-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("pur-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    return `<div class="list-row" data-open-pur-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel} · ${p.stock} ${escapeHtml(p.unit||"")} in stock</div></div>
      <div class="row-right"><button class="gold-fab" data-pur-quickadd="${p.id}" style="width:30px;height:30px;">+</button></div>
    </div>`;
  }).join("") || `<div class="empty-hint">No matching products.</div>`;

  wrap.querySelectorAll("[data-open-pur-product]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest("[data-pur-quickadd]")) return;
      openProductDetail(el.dataset.openPurProduct, "purchase");
    });
  });
  wrap.querySelectorAll("[data-pur-quickadd]").forEach(b=>{
    b.addEventListener("click", (e)=>{ e.stopPropagation(); openProductDetail(b.dataset.purQuickadd, "purchase"); });
  });
}
/* A purchase line always gets pushed as a NEW row rather than merged into an
   existing one for the same size — a real supplier invoice can legitimately
   list the same product/size twice at different rates (different batch),
   and merging would silently lose that. */
function addToPurchaseCart(productId, sizeIdx){
  const p = state.products.find(x=>x.id===productId);
  if(!p) return false;
  if(!p.sizes.length){ toast(`"${p.name}" has no price yet — open it and tap Edit to add one.`); return false; }
  const size = p.sizes[sizeIdx] || p.sizes[0];
  state.pur.cart.push({
    productId, sizeId: size.id, sizeIdx,
    name: p.name + (p.sizes.length>1 ? " ("+size.label+")" : ""),
    mode: Pricing.normaliseMode(p.default_mode),
    lengthFt: p.length_ft || "", widthVal: p.width_val || "", thicknessIn: p.thickness_in || "",
    pieces: 1, rate: size.price, gstRate: p.gst,
    discountType: "pct", discountValue: 0
  });
  renderPurchaseCart(); renderPurchaseTotals();
  return true;
}
/* Live figures for a purchase line — mirrors computeTotals() in
   server/routes/purchases.js exactly: discount is resolved to a rupee amount
   first (pct of line amount, or a flat value clamped to the line amount),
   then GST is computed forward on the taxable (post-discount) value. */
function purchaseLineCalc(c){
  const r = Pricing.computeLine({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate});
  const discountAmount = c.discountType === "flat"
    ? round2(Math.min(Math.max(0, c.discountValue||0), r.amount))
    : round2(r.amount * (Math.min(100, Math.max(0, c.discountValue||0))/100));
  const taxable = round2(r.amount - discountAmount);
  const gstAmt = round2(taxable * ((c.gstRate||18)/100));
  const finalAmt = round2(taxable + gstAmt);
  return {...r, discountAmount, taxable, gstAmt, finalAmt};
}
function renderPurchaseCart(){
  const wrap = document.getElementById("pur-cart-list");
  if(!state.pur.cart.length){
    wrap.innerHTML = `<div class="empty-hint">No items yet. Add products above.</div>`;
    return;
  }
  wrap.innerHTML = state.pur.cart.map((c,idx)=>{
    const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
    const r = purchaseLineCalc(c);

    const dim = (label, unit, key, val) => `
      <label class="dim">
        <span>${label}${unit?` <em>(${unit})</em>`:""}</span>
        <input type="number" inputmode="decimal" step="any" min="0"
               value="${val===0||val?val:""}" data-pur-line-field="${key}" data-pur-line="${idx}" placeholder="0">
      </label>`;

    return `<div class="bill-line" data-pur-line-row="${idx}">
      <div class="bill-line-head">
        <div class="bill-line-name">${escapeHtml(c.name)}</div>
        <div class="line-actions">
          <a href="#" data-pur-dup="${idx}">Duplicate</a>
          <a href="#" data-pur-remove="${idx}" class="btn-danger-link">Remove</a>
        </div>
      </div>

      <div class="mode-row">
        ${Pricing.MODE_KEYS.map(k=>`
          <button class="chip sm ${k===m.key?'selected':''}" data-pur-line-mode="${k}" data-pur-line="${idx}"
                  title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>
        `).join("")}
      </div>

      <div class="dim-grid">
        ${m.needsThickness ? dim("Thickness", m.thicknessUnit, "thicknessIn", c.thicknessIn) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", c.lengthFt) : ""}
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", c.widthVal) : ""}
        ${dim("Qty", "pcs", "pieces", c.pieces)}
        ${dim("Rate", "₹/"+m.unit, "rate", c.rate)}
      </div>

      <div class="chip-row" style="margin-top:8px;">
        <button class="chip sm ${c.discountType==="pct"?'selected':''}" data-pur-disc-type="pct" data-pur-line="${idx}">Discount %</button>
        <button class="chip sm ${c.discountType==="flat"?'selected':''}" data-pur-disc-type="flat" data-pur-line="${idx}">Discount ₹</button>
      </div>
      <div class="dim-grid">
        ${dim(c.discountType==="flat"?"Discount":"Discount", c.discountType==="flat"?"₹":"%", "discountValue", c.discountValue)}
        <label class="dim"><span>GST <em>(%)</em></span><input type="number" value="${c.gstRate}" disabled style="opacity:0.6;"></label>
      </div>

      <div class="line-calc">
        <div class="line-calc-formula">
          ${r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : ""}
          ${m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : ""}
          <strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>
          × ${Pricing.formatRate(r.rate, r.mode)}
          ${r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : ""}
          + ${fmtPaise(r.gstAmt)} GST
        </div>
        <div class="line-calc-amount">${fmtPaise(r.finalAmt)}</div>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-pur-line-mode]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.pur.cart[b.dataset.purLine];
    const next = b.dataset.purLineMode;
    if(c.mode === next) return;
    c.rate = Pricing.isRateConvertible(c.mode, next)
      ? Pricing.convertLineRate({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
                                 thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate}, next)
      : "";
    c.mode = next;
    renderPurchaseCart(); renderPurchaseTotals();
  }));

  wrap.querySelectorAll("[data-pur-disc-type]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.pur.cart[b.dataset.purLine];
    c.discountType = b.dataset.purDiscType;
    renderPurchaseCart(); renderPurchaseTotals();
  }));

  wrap.querySelectorAll("[data-pur-line-field]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const c = state.pur.cart[inp.dataset.purLine];
      const v = inp.value === "" ? "" : Math.max(0, parseFloat(inp.value)||0);
      c[inp.dataset.purLineField] = v;
      renderPurchaseLineCalc(inp.dataset.purLine);
      renderPurchaseTotals();
    });
    // Re-render fully on blur so cleared fields settle back to a real number.
    inp.addEventListener("blur", ()=>{ renderPurchaseCart(); renderPurchaseTotals(); });
  });

  wrap.querySelectorAll("[data-pur-dup]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault();
    const i = Number(a.dataset.purDup);
    state.pur.cart.splice(i+1, 0, Object.assign({}, state.pur.cart[i]));
    renderPurchaseCart(); renderPurchaseTotals();
  }));

  wrap.querySelectorAll("[data-pur-remove]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault(); state.pur.cart.splice(a.dataset.purRemove,1); renderPurchaseCart(); renderPurchaseTotals();
  }));
}
/* Repaint just one line's derived figures while typing — mirrors
   renderLineCalc() on the Billing side, same reasoning: rebuilding the whole
   cart on every keystroke would tear the focused input out from under the
   caret. */
function renderPurchaseLineCalc(idx){
  const row = document.querySelector(`[data-pur-line-row="${idx}"]`);
  if(!row) return;
  const c = state.pur.cart[idx];
  const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
  const r = purchaseLineCalc(c);
  const f = row.querySelector(".line-calc-formula");
  const a = row.querySelector(".line-calc-amount");
  if(f) f.innerHTML =
    (r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : "") +
    (m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : "") +
    `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>` +
    ` × ${Pricing.formatRate(r.rate, r.mode)}` +
    (r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : "") +
    ` + ${fmtPaise(r.gstAmt)} GST`;
  if(a) a.textContent = fmtPaise(r.finalAmt);
}
function renderPurchaseDueDateVisibility(){
  const row = document.getElementById("pur-due-date-row");
  if(row) row.style.display = (state.pur.paymentMethod === "Credit" && state.pur.docType !== "challan") ? "block" : "none";
}
/** Wipes the New Purchase form back to blank — supplier, items, charges,
 *  and any in-progress edit — without touching anything already saved.
 *  Same reset used after a successful save / cancelled edit, just
 *  reachable on demand instead of only as a side effect of those. */
function clearPurchaseForm(){
  state.pur = {
    docType: "purchase", supplierId: null, purchaseType: "Local", paymentMethod: "Credit",
    date: "", invoiceNo: "", dueDate: "", vehicleNumber: "", transportName: "", lrNumber: "", remarks: "",
    transport: 0, loading: 0, otherCharges: 0, roundOff: true, cart: [], editingPurchaseId: null, locationId: null,
    gstEnabled: true, purchaseNo: null
  };
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set("pur-invoice-no", ""); set("pur-due-date", ""); set("pur-vehicle", "");
  set("pur-transport-name", ""); set("pur-lr", ""); set("pur-remarks", "");
  set("pur-transport-input", 0); set("pur-loading-input", 0); set("pur-other-input", 0);
  const searchEl = document.getElementById("pur-supplier-search"); if(searchEl) searchEl.value = "";
  document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.toggle("selected", x.dataset.purType==="Local"));
  document.querySelectorAll('[data-pur-pay]').forEach(x=>x.classList.toggle("selected", x.dataset.purPay==="Credit"));
  setPurGstEnabled(true);
  setPurDocType("purchase");
  renderPurchaseScreen();
  toast("Form cleared.");
}
function isPurChallanMode(){ return state.pur.docType === "challan"; }
/**
 * Switch between Purchase Entry and Purchase Challan — mirrors setDocType()
 * on Billing. A challan is a goods-received note with no GST/pricing/due
 * impact (see server/routes/purchases.js), so this hides the GST/Purchase
 * Type/Payment Type/round-off controls in one move; the item list — sizes
 * and quantities — stays exactly as-is, since a challan still needs those.
 */
function setPurDocType(type){
  state.pur.docType = type === "challan" ? "challan" : "purchase";
  const challan = isPurChallanMode();
  document.querySelectorAll('[data-pur-doctype]').forEach(b=>
    b.classList.toggle("selected", b.dataset.purDoctype === state.pur.docType));
  const pricing = document.getElementById("pur-pricing");
  if(pricing) pricing.style.display = challan ? "none" : "";
  const payment = document.getElementById("pur-payment");
  if(payment) payment.style.display = challan ? "none" : "";
  const roundoffRow = document.getElementById("pur-roundoff-row");
  if(roundoffRow) roundoffRow.style.display = challan ? "none" : "flex";
  // Which document TYPE this is can't change once saved — number series and
  // stock/due behaviour are fixed at creation — so lock the toggle while editing.
  const toggleWrap = document.getElementById("pur-doctype-toggle");
  if(toggleWrap) toggleWrap.style.pointerEvents = state.pur.editingPurchaseId ? "none" : "";
  if(toggleWrap) toggleWrap.style.opacity = state.pur.editingPurchaseId ? "0.55" : "";
  const saveBtn = document.getElementById("pur-save-btn");
  if(saveBtn) saveBtn.textContent = state.pur.editingPurchaseId
    ? (challan ? "Update Purchase Challan" : "Update Purchase & Update Stock")
    : (challan ? "Save Purchase Challan & Update Stock" : "Save Purchase & Update Stock");
  renderPurchaseDueDateVisibility();
  renderPurchaseTotals();
  renderPurchaseNumber();
}
/**
 * "GST Purchase" vs "Non-GST Purchase" — mirrors setGstEnabled() on the
 * Billing screen. When off, Purchase Type (which only decides CGST+SGST vs
 * IGST) is moot, so its chip row hides along with the tax rows.
 */
function setPurGstEnabled(on){
  state.pur.gstEnabled = on;
  document.querySelectorAll('[data-pur-gstenabled]').forEach(b=>
    b.classList.toggle("selected", (b.dataset.purGstenabled === "true") === on));
  const typeSection = document.getElementById("pur-type-section");
  if(typeSection) typeSection.style.display = on ? "" : "none";
  renderPurchaseTotals();
}
/* Mirrors computeTotals() in server/routes/purchases.js exactly, including
   the order of rounding — the preview must match what the server will store. */
function computePurchaseTotals(){
  const transport = round2(Math.max(0, state.pur.transport||0));
  const loading = round2(Math.max(0, state.pur.loading||0));
  const otherCharges = round2(Math.max(0, state.pur.otherCharges||0));
  // A Purchase Challan is a goods-received note: no GST, no discount, no
  // supplier due — only Transport/Loading/Other Charges are real, exactly
  // like a Delivery Challan on the sales side (see server/routes/purchases.js).
  if(isPurChallanMode()){
    const total = round2(transport + loading + otherCharges);
    return {subtotal:0, discountAmount:0, cgst:0, sgst:0, igst:0, transport, loading, otherCharges, roundOffAmount:0, total};
  }
  const lines = state.pur.cart.map(purchaseLineCalc);
  const subtotal = round2(lines.reduce((s,r)=>s+r.amount,0));
  const discountAmount = round2(lines.reduce((s,r)=>s+r.discountAmount,0));
  // "Non-GST Purchase" (state.pur.gstEnabled === false) skips tax entirely —
  // mirrors server/routes/purchases.js's computeTotals().
  const goodsTax = state.pur.gstEnabled ? round2(lines.reduce((s,r)=>s+r.gstAmt,0)) : 0;

  let cgst=0, sgst=0, igst=0;
  if(state.pur.gstEnabled){
    if(state.pur.purchaseType==="Interstate") igst = goodsTax;
    else { cgst = round2(goodsTax/2); sgst = round2(goodsTax-cgst); }
  }

  const preRound = subtotal - discountAmount + cgst + sgst + igst + transport + loading + otherCharges;
  const total = round2(state.pur.roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return {subtotal, discountAmount, cgst, sgst, igst, transport, loading, otherCharges, roundOffAmount, total};
}
function renderPurchaseTotals(){
  const t = computePurchaseTotals();
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("pur-totals-card").innerHTML = `
    ${row("Subtotal", fmtPaise(t.subtotal))}
    ${t.discountAmount>0 ? row("Total Discount", "-"+fmtPaise(t.discountAmount), "color:var(--danger);") : ""}
    ${t.transport>0 ? row("Transport", fmtPaise(t.transport)) : ""}
    ${t.loading>0 ? row("Loading / Unloading", fmtPaise(t.loading)) : ""}
    ${t.otherCharges>0 ? row("Other Charges", fmtPaise(t.otherCharges)) : ""}
    ${(isPurChallanMode() || !state.pur.gstEnabled) ? "" : state.pur.purchaseType==="Interstate"
      ? row("IGST", fmtPaise(t.igst))
      : row("CGST", fmtPaise(t.cgst)) + row("SGST", fmtPaise(t.sgst))}
    ${t.roundOffAmount!==0 ? row("Round off", (t.roundOffAmount>0?"+":"")+fmtPaise(t.roundOffAmount)) : ""}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Grand Total</span><span>${fmtPaise(t.total)}</span></div>
    <div class="amount-words">${Pricing.amountInWords(t.total)}</div>
  `;
}
async function savePurchase(){
  if(!state.pur.supplierId){ toast("Select a supplier first."); return; }
  if(!state.pur.cart.length){ toast("Add at least one product to the purchase."); return; }
  for(const c of state.pur.cart){
    const bad = Pricing.validateLine({
      mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
      thicknessIn:c.thicknessIn, pieces:c.pieces, rate: c.rate
    }, c.name);
    if(bad){ toast(bad); return; }
  }
  const btn = document.getElementById("pur-save-btn");
  btn.disabled = true;
  try{
    const payload = {
      docType: state.pur.docType,
      supplierId: state.pur.supplierId,
      supplierInvoiceNo: state.pur.invoiceNo,
      date: document.getElementById("pur-date").value || state.pur.date,
      purchaseType: state.pur.purchaseType,
      paymentMethod: state.pur.paymentMethod,
      dueDate: state.pur.dueDate,
      vehicleNumber: state.pur.vehicleNumber,
      transportName: state.pur.transportName,
      lrNumber: state.pur.lrNumber,
      remarks: state.pur.remarks,
      transport: state.pur.transport,
      loading: state.pur.loading,
      otherCharges: state.pur.otherCharges,
      roundOff: state.pur.roundOff,
      locationId: state.pur.locationId,
      gstEnabled: state.pur.gstEnabled,
      // Only the raw inputs are sent — the server recomputes every derived
      // figure itself, same principle as completeSale() on the Billing side.
      items: state.pur.cart.map(c=>({
        productId:c.productId, sizeId:c.sizeId, name:c.name, mode:c.mode,
        lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
        pieces:c.pieces, rate:c.rate, gstRate:c.gstRate,
        discountType:c.discountType, discountValue:c.discountValue
      }))
    };
    const editingId = state.pur.editingPurchaseId;
    const saved = editingId
      ? await api("PUT", `/purchases/${editingId}`, payload)
      : await api("POST", "/purchases", payload);
    state.pur = {
      docType: "purchase", supplierId: null, purchaseType: "Local", paymentMethod: "Credit",
      date: "", invoiceNo: "", dueDate: "", vehicleNumber: "", transportName: "", lrNumber: "", remarks: "",
      transport: 0, loading: 0, otherCharges: 0, roundOff: true, cart: [], editingPurchaseId: null, locationId: null,
      gstEnabled: true, purchaseNo: null
    };
    const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
    set("pur-invoice-no", ""); set("pur-due-date", ""); set("pur-vehicle", "");
    set("pur-transport-name", ""); set("pur-lr", ""); set("pur-remarks", "");
    set("pur-transport-input", 0); set("pur-loading-input", 0); set("pur-other-input", 0);
    document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.toggle("selected", x.dataset.purType==="Local"));
    document.querySelectorAll('[data-pur-pay]').forEach(x=>x.classList.toggle("selected", x.dataset.purPay==="Credit"));
    setPurGstEnabled(true);
    setPurDocType("purchase");
    renderPurchaseEditBanner();
    await Promise.all([loadProducts(), loadSuppliers()]);
    await renderHome();
    toast(`${saved.doc_type==="challan"?"Purchase Challan":"Purchase"} ${saved.purchase_no} ${editingId?"updated":"saved"}${saved.doc_type==="challan"?"":" — Grand Total "+fmt(saved.total)}`, "ok");
    switchTab("home");
  }catch(e){
    toast(e.message);
  }finally{
    btn.disabled = false;
  }
}

/* ============================================================
   SHEET: Purchase Detail (view + Edit/Void/Delete)
   ============================================================ */
async function openPurchaseDetail(purchaseId){
  const p = await api("GET", `/purchases/${purchaseId}`);
  const sheet = document.getElementById("sheet-purchase-detail");
  const challan = p.doc_type === "challan";
  const lineTotal = it => {
    if(challan) return 0;
    const taxable = round2(it.qty*it.rate - it.discount_amount);
    return round2(taxable + taxable*(it.gst_rate/100));
  };
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(p.purchase_no)} ${challan?'<span class="pill">Purchase Challan</span>':''} ${p.voided?'<span class="pill danger">Voided</span>':`<span class="pill ${p.status==='Completed'?'ok':p.status==='Pending'?'warn':''}">${escapeHtml(p.status)}</span>`}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${p.date} · ${escapeHtml(p.supplier_invoice_no||"(no invoice no.)")}${challan?"":" · "+escapeHtml(p.purchase_type)+" · "+escapeHtml(p.payment_method)}</div>
    <div class="card">${p.items.map(it=>`
      <div class="list-row">
        <div><div class="row-title">${escapeHtml(it.name)}</div><div class="row-sub">${escapeHtml(it.size_label||"")} · ${it.pieces} ${escapeHtml(it.unit_label||"")}${challan?"":" × "+fmt(it.rate)+(it.discount_amount>0?" · disc. "+fmt(it.discount_amount):"")}</div></div>
        ${challan?"":`<div class="row-right row-title">${fmt(lineTotal(it))}</div>`}
      </div>`).join("")}
    </div>
    ${challan ? `
    <div class="card" style="margin-top:8px;">
      ${p.transport>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Transport</span><span>${fmt(p.transport)}</span></div>`:""}
      ${p.loading>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Loading</span><span>${fmt(p.loading)}</span></div>`:""}
      ${p.other_charges>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Other Charges</span><span>${fmt(p.other_charges)}</span></div>`:""}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(p.total)}</span></div>
    </div>` : `
    <div class="card" style="margin-top:8px;">
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(p.subtotal)}</span></div>
      ${p.discount_amount>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Discount</span><span>-${fmt(p.discount_amount)}</span></div>`:""}
      ${p.transport>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Transport</span><span>${fmt(p.transport)}</span></div>`:""}
      ${p.loading>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Loading</span><span>${fmt(p.loading)}</span></div>`:""}
      ${p.other_charges>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Other Charges</span><span>${fmt(p.other_charges)}</span></div>`:""}
      ${p.tax_type==="IGST"
        ? `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">IGST</span><span>${fmt(p.igst)}</span></div>`
        : `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">CGST</span><span>${fmt(p.cgst)}</span></div><div class="inv-flex" style="margin-bottom:4px;"><span class="muted">SGST</span><span>${fmt(p.sgst)}</span></div>`}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(p.total)}</span></div>
    </div>`}
    <div class="action-row" style="margin-top:14px;">
      ${!p.voided?'<button class="btn btn-outline" id="edit-purchase-btn">✎ Edit</button>':''}
      ${!p.voided?'<button class="btn btn-outline" id="return-purchase-btn">Return Items</button>':''}
      ${isOwner() && !p.voided ? '<button class="btn btn-outline" id="void-purchase-btn">Void</button>' : ''}
    </div>
    ${isOwner() ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="delete-purchase-link" class="btn-danger-link">Delete this purchase</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  const editBtn = sheet.querySelector("#edit-purchase-btn");
  if(editBtn) editBtn.addEventListener("click", ()=>{ closeAllSheets(); editExistingPurchase(p); });
  const returnBtn = sheet.querySelector("#return-purchase-btn");
  if(returnBtn) returnBtn.addEventListener("click", ()=>{ closeAllSheets(); openPurchaseReturn(p); });
  const voidBtn = sheet.querySelector("#void-purchase-btn");
  if(voidBtn) voidBtn.addEventListener("click", async ()=>{
    if(confirm(`Void ${p.purchase_no}? Stock and the supplier's due will be reversed.`)){
      try{
        await api("POST", `/purchases/${p.id}/void`);
        await Promise.all([loadProducts(), loadSuppliers()]);
        closeAllSheets();
        toast("Purchase voided.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  const deleteLink = sheet.querySelector("#delete-purchase-link");
  if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    const warn = p.voided ? "" : " Stock and the supplier's due will be reversed.";
    if(confirm(`Delete ${p.purchase_no} permanently?${warn} This can't be undone.`)){
      try{
        await api("DELETE", `/purchases/${p.id}`);
        await Promise.all([loadProducts(), loadSuppliers()]);
        closeAllSheets();
        toast("Purchase deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-purchase-detail");
}

/**
 * Loads a saved (non-voided) purchase's items and settings back into the
 * New Purchase screen for editing. Saving from here PUTs to the same
 * purchase instead of creating a new one — see savePurchase().
 * A line's original discountType/discountValue aren't stored (the server
 * only persists the resolved rupee discount_amount), so an edited line
 * starts as a flat ₹ discount equal to what was actually applied — the
 * amount is exactly right even though the original % entry, if any, isn't
 * recoverable.
 */
async function editExistingPurchase(p){
  if(p.voided){ toast("A voided purchase can't be edited."); return; }
  await Promise.all([loadProducts(), loadSuppliers()]);
  state.pur.cart = p.items.map(it=>{
    const product = state.products.find(x=>x.id===it.product_id);
    const sizeIdx = product ? product.sizes.findIndex(s=>s.id===it.size_id) : -1;
    return {
      productId: it.product_id, sizeId: it.size_id, sizeIdx: sizeIdx>=0 ? sizeIdx : 0,
      name: it.name, mode: it.mode, lengthFt: it.length_ft||"", widthVal: it.width_val||"",
      thicknessIn: it.thickness_in||"", pieces: it.pieces, rate: it.rate, gstRate: it.gst_rate,
      discountType: it.discount_amount>0 ? "flat" : "pct", discountValue: it.discount_amount>0 ? it.discount_amount : 0
    };
  });
  state.pur.docType = p.doc_type === "challan" ? "challan" : "purchase";
  state.pur.supplierId = p.supplier_id;
  state.pur.purchaseType = p.purchase_type;
  state.pur.paymentMethod = p.payment_method;
  state.pur.date = p.date;
  state.pur.invoiceNo = p.supplier_invoice_no || "";
  state.pur.dueDate = p.due_date || "";
  state.pur.vehicleNumber = p.vehicle_number || "";
  state.pur.transportName = p.transport_name || "";
  state.pur.lrNumber = p.lr_number || "";
  state.pur.remarks = p.remarks || "";
  state.pur.transport = p.transport || 0;
  state.pur.loading = p.loading || 0;
  state.pur.otherCharges = p.other_charges || 0;
  state.pur.roundOff = true;
  state.pur.editingPurchaseId = p.id;
  state.pur.purchaseNo = p.purchase_no;
  state.pur.locationId = p.location_id || null;
  state.pur.gstEnabled = p.gst_enabled !== 0;

  closeAllSheets();
  switchTab("purchase");
  await renderPurchaseScreen();

  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set("pur-date", state.pur.date);
  set("pur-invoice-no", state.pur.invoiceNo);
  set("pur-due-date", state.pur.dueDate);
  set("pur-vehicle", state.pur.vehicleNumber);
  set("pur-transport-name", state.pur.transportName);
  set("pur-lr", state.pur.lrNumber);
  set("pur-remarks", state.pur.remarks);
  set("pur-transport-input", state.pur.transport);
  set("pur-loading-input", state.pur.loading);
  set("pur-other-input", state.pur.otherCharges);
  document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.toggle("selected", x.dataset.purType===state.pur.purchaseType));
  document.querySelectorAll('[data-pur-pay]').forEach(x=>x.classList.toggle("selected", x.dataset.purPay===state.pur.paymentMethod));
  setPurGstEnabled(state.pur.gstEnabled);
  setPurDocType(state.pur.docType);
  renderPurchaseDueDateVisibility();
  renderPurchaseEditBanner();
  toast(`Editing ${p.purchase_no} — make your changes, then save.`, "ok");
}

/* ============================================================
   PURCHASE ORDER — pre-transaction request to a supplier. No stock or due
   impact until Convert to Purchase Entry runs; mirrors New Purchase's cart
   pattern closely (see above) but with its own status lifecycle
   (Draft/Pending/Approved/Completed/Cancelled) instead of an immediate save.
   ============================================================ */
async function renderPoScreen(){
  if(!state.po.date) state.po.date = todayISO();
  const dateEl = document.getElementById("po-date");
  if(dateEl && !dateEl.value) dateEl.value = state.po.date;
  renderPoEditBanner();
  renderPoSuppliers();
  renderPoSupplierInfo();
  renderPoProducts();
  renderPoCart();
  renderPoTotals();
}
function renderPoEditBanner(){
  const el = document.getElementById("po-edit-mode-banner");
  if(!el) return;
  if(!state.po.editingPoId){ el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="card" style="background:var(--warn-bg);border-color:var(--warn-text);margin-bottom:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="font-size:12px;font-weight:700;color:var(--warn-text);">✎ Editing an existing Purchase Order — Save below will UPDATE it, not create a new one.</div>
      <a href="#" id="cancel-po-edit-link" style="font-size:12px;font-weight:800;color:var(--warn-text);white-space:nowrap;">Cancel</a>
    </div>
  `;
  document.getElementById("cancel-po-edit-link").addEventListener("click", (e)=>{
    e.preventDefault();
    resetPoState();
    renderPoScreen();
    toast("Edit cancelled.");
  });
}
function resetPoState(){
  state.po = {
    supplierId: null, purchaseType: "Local", date: "", deliveryAddress: "", expectedDeliveryDate: "",
    paymentTerms: "", deliveryTerms: "", remarks: "", freight: 0, otherCharges: 0, roundOff: true,
    cart: [], editingPoId: null
  };
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set("po-delivery-address", ""); set("po-expected-date", ""); set("po-payment-terms", "");
  set("po-delivery-terms", ""); set("po-remarks", ""); set("po-freight-input", 0); set("po-other-input", 0);
  document.querySelectorAll('[data-po-type]').forEach(x=>x.classList.toggle("selected", x.dataset.poType==="Local"));
}
function renderPoSuppliers(){
  const wrap = document.getElementById("po-suppliers");
  const searchEl = document.getElementById("po-supplier-search");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  const selected = state.suppliers.find(s=>s.id===state.po.supplierId);
  let list = state.suppliers;
  if(q) list = list.filter(s=>s.name.toLowerCase().includes(q) || (s.phone||"").includes(q));
  if(selected && !list.includes(selected)) list = [selected, ...list];

  wrap.innerHTML = list.map(s=>`
    <button class="chip ${state.po.supplierId===s.id?'selected':''}" data-po-sup="${s.id}">${escapeHtml(s.name)}</button>
  `).join("") || `<div class="empty-hint" style="padding:8px 4px;">${q ? `No supplier matches "${escapeHtml(q)}".` : "No suppliers yet — add one from the Suppliers tab."}</div>`;

  wrap.querySelectorAll("[data-po-sup]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.po.supplierId = b.dataset.poSup;
      const sup = state.suppliers.find(s=>s.id===state.po.supplierId);
      state.po.purchaseType = (sup && sup.gst_type === "IGST") ? "Interstate" : "Local";
      document.querySelectorAll('[data-po-type]').forEach(x=>x.classList.toggle("selected", x.dataset.poType===state.po.purchaseType));
      renderPoSuppliers();
      renderPoSupplierInfo();
      renderPoTotals();
    });
  });
}
function renderPoSupplierInfo(){
  const box = document.getElementById("po-supplier-info");
  const sup = state.suppliers.find(s=>s.id===state.po.supplierId);
  if(!sup){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div><strong>${escapeHtml(sup.name)}</strong></div>
    ${sup.phone ? `<div class="muted">${escapeHtml(sup.phone)}</div>` : ""}
    ${sup.gst ? `<div class="muted">GST: ${escapeHtml(sup.gst)}</div>` : ""}
    ${sup.state ? `<div class="muted">${escapeHtml(sup.state)}</div>` : ""}
    ${sup.address ? `<div class="muted">${escapeHtml(sup.address)}</div>` : ""}
  `;
}
function renderPoProducts(){
  const q = (document.getElementById("po-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("po-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    return `<div class="list-row" data-open-po-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div></div>
      <div class="row-right"><button class="gold-fab" data-po-quickadd="${p.id}" style="width:30px;height:30px;">+</button></div>
    </div>`;
  }).join("") || `<div class="empty-hint">No matching products.</div>`;

  wrap.querySelectorAll("[data-open-po-product]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest("[data-po-quickadd]")) return;
      openProductDetail(el.dataset.openPoProduct, "po");
    });
  });
  wrap.querySelectorAll("[data-po-quickadd]").forEach(b=>{
    b.addEventListener("click", (e)=>{ e.stopPropagation(); openProductDetail(b.dataset.poQuickadd, "po"); });
  });
}
function addToPoCart(productId, sizeIdx){
  const p = state.products.find(x=>x.id===productId);
  if(!p) return false;
  if(!p.sizes.length){ toast(`"${p.name}" has no price yet — open it and tap Edit to add one.`); return false; }
  const size = p.sizes[sizeIdx] || p.sizes[0];
  state.po.cart.push({
    productId, sizeId: size.id, sizeIdx,
    name: p.name + (p.sizes.length>1 ? " ("+size.label+")" : ""),
    mode: Pricing.normaliseMode(p.default_mode),
    lengthFt: p.length_ft || "", widthVal: p.width_val || "", thicknessIn: p.thickness_in || "",
    pieces: 1, rate: size.price, gstRate: p.gst,
    discountType: "pct", discountValue: 0
  });
  renderPoCart(); renderPoTotals();
  return true;
}
function poLineCalc(c){
  const r = Pricing.computeLine({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate});
  const discountAmount = c.discountType === "flat"
    ? round2(Math.min(Math.max(0, c.discountValue||0), r.amount))
    : round2(r.amount * (Math.min(100, Math.max(0, c.discountValue||0))/100));
  const taxable = round2(r.amount - discountAmount);
  const gstAmt = round2(taxable * ((c.gstRate||18)/100));
  const finalAmt = round2(taxable + gstAmt);
  return {...r, discountAmount, taxable, gstAmt, finalAmt};
}
function renderPoCart(){
  const wrap = document.getElementById("po-cart-list");
  if(!state.po.cart.length){
    wrap.innerHTML = `<div class="empty-hint">No items yet. Add products above.</div>`;
    return;
  }
  wrap.innerHTML = state.po.cart.map((c,idx)=>{
    const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
    const r = poLineCalc(c);

    const dim = (label, unit, key, val) => `
      <label class="dim">
        <span>${label}${unit?` <em>(${unit})</em>`:""}</span>
        <input type="number" inputmode="decimal" step="any" min="0"
               value="${val===0||val?val:""}" data-po-line-field="${key}" data-po-line="${idx}" placeholder="0">
      </label>`;

    return `<div class="bill-line" data-po-line-row="${idx}">
      <div class="bill-line-head">
        <div class="bill-line-name">${escapeHtml(c.name)}</div>
        <div class="line-actions">
          <a href="#" data-po-dup="${idx}">Duplicate</a>
          <a href="#" data-po-remove="${idx}" class="btn-danger-link">Remove</a>
        </div>
      </div>

      <div class="mode-row">
        ${Pricing.MODE_KEYS.map(k=>`
          <button class="chip sm ${k===m.key?'selected':''}" data-po-line-mode="${k}" data-po-line="${idx}"
                  title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>
        `).join("")}
      </div>

      <div class="dim-grid">
        ${m.needsThickness ? dim("Thickness", m.thicknessUnit, "thicknessIn", c.thicknessIn) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", c.lengthFt) : ""}
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", c.widthVal) : ""}
        ${dim("Qty", "pcs", "pieces", c.pieces)}
        ${dim("Rate", "₹/"+m.unit, "rate", c.rate)}
      </div>

      <div class="chip-row" style="margin-top:8px;">
        <button class="chip sm ${c.discountType==="pct"?'selected':''}" data-po-disc-type="pct" data-po-line="${idx}">Discount %</button>
        <button class="chip sm ${c.discountType==="flat"?'selected':''}" data-po-disc-type="flat" data-po-line="${idx}">Discount ₹</button>
      </div>
      <div class="dim-grid">
        ${dim("Discount", c.discountType==="flat"?"₹":"%", "discountValue", c.discountValue)}
        <label class="dim"><span>GST <em>(%)</em></span><input type="number" value="${c.gstRate}" disabled style="opacity:0.6;"></label>
      </div>

      <div class="line-calc">
        <div class="line-calc-formula">
          ${r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : ""}
          ${m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : ""}
          <strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>
          × ${Pricing.formatRate(r.rate, r.mode)}
          ${r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : ""}
          + ${fmtPaise(r.gstAmt)} GST
        </div>
        <div class="line-calc-amount">${fmtPaise(r.finalAmt)}</div>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-po-line-mode]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.po.cart[b.dataset.poLine];
    const next = b.dataset.poLineMode;
    if(c.mode === next) return;
    c.rate = Pricing.isRateConvertible(c.mode, next)
      ? Pricing.convertLineRate({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
                                 thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate}, next)
      : "";
    c.mode = next;
    renderPoCart(); renderPoTotals();
  }));

  wrap.querySelectorAll("[data-po-disc-type]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.po.cart[b.dataset.poLine];
    c.discountType = b.dataset.poDiscType;
    renderPoCart(); renderPoTotals();
  }));

  wrap.querySelectorAll("[data-po-line-field]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const c = state.po.cart[inp.dataset.poLine];
      const v = inp.value === "" ? "" : Math.max(0, parseFloat(inp.value)||0);
      c[inp.dataset.poLineField] = v;
      renderPoLineCalc(inp.dataset.poLine);
      renderPoTotals();
    });
    inp.addEventListener("blur", ()=>{ renderPoCart(); renderPoTotals(); });
  });

  wrap.querySelectorAll("[data-po-dup]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault();
    const i = Number(a.dataset.poDup);
    state.po.cart.splice(i+1, 0, Object.assign({}, state.po.cart[i]));
    renderPoCart(); renderPoTotals();
  }));

  wrap.querySelectorAll("[data-po-remove]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault(); state.po.cart.splice(a.dataset.poRemove,1); renderPoCart(); renderPoTotals();
  }));
}
function renderPoLineCalc(idx){
  const row = document.querySelector(`[data-po-line-row="${idx}"]`);
  if(!row) return;
  const c = state.po.cart[idx];
  const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
  const r = poLineCalc(c);
  const f = row.querySelector(".line-calc-formula");
  const a = row.querySelector(".line-calc-amount");
  if(f) f.innerHTML =
    (r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : "") +
    (m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : "") +
    `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>` +
    ` × ${Pricing.formatRate(r.rate, r.mode)}` +
    (r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : "") +
    ` + ${fmtPaise(r.gstAmt)} GST`;
  if(a) a.textContent = fmtPaise(r.finalAmt);
}
function computePoTotals(){
  const lines = state.po.cart.map(poLineCalc);
  const subtotal = round2(lines.reduce((s,r)=>s+r.amount,0));
  const discountAmount = round2(lines.reduce((s,r)=>s+r.discountAmount,0));
  const goodsTax = round2(lines.reduce((s,r)=>s+r.gstAmt,0));

  const freight = round2(Math.max(0, state.po.freight||0));
  const otherCharges = round2(Math.max(0, state.po.otherCharges||0));

  let cgst=0, sgst=0, igst=0;
  if(state.po.purchaseType==="Interstate") igst = goodsTax;
  else { cgst = round2(goodsTax/2); sgst = round2(goodsTax-cgst); }

  const preRound = subtotal - discountAmount + cgst + sgst + igst + freight + otherCharges;
  const total = round2(state.po.roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return {subtotal, discountAmount, cgst, sgst, igst, freight, otherCharges, roundOffAmount, total};
}
function renderPoTotals(){
  const t = computePoTotals();
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("po-totals-card").innerHTML = `
    ${row("Subtotal", fmtPaise(t.subtotal))}
    ${t.discountAmount>0 ? row("Total Discount", "-"+fmtPaise(t.discountAmount), "color:var(--danger);") : ""}
    ${t.freight>0 ? row("Freight", fmtPaise(t.freight)) : ""}
    ${t.otherCharges>0 ? row("Other Charges", fmtPaise(t.otherCharges)) : ""}
    ${state.po.purchaseType==="Interstate"
      ? row("IGST", fmtPaise(t.igst))
      : row("CGST", fmtPaise(t.cgst)) + row("SGST", fmtPaise(t.sgst))}
    ${t.roundOffAmount!==0 ? row("Round off", (t.roundOffAmount>0?"+":"")+fmtPaise(t.roundOffAmount)) : ""}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Grand Total</span><span>${fmtPaise(t.total)}</span></div>
    <div class="amount-words">${Pricing.amountInWords(t.total)}</div>
  `;
}
function poPayload(){
  return {
    supplierId: state.po.supplierId,
    date: document.getElementById("po-date").value || state.po.date,
    deliveryAddress: state.po.deliveryAddress,
    expectedDeliveryDate: state.po.expectedDeliveryDate,
    purchaseType: state.po.purchaseType,
    freight: state.po.freight, otherCharges: state.po.otherCharges, roundOff: state.po.roundOff,
    paymentTerms: state.po.paymentTerms, deliveryTerms: state.po.deliveryTerms, remarks: state.po.remarks,
    items: state.po.cart.map(c=>({
      productId:c.productId, sizeId:c.sizeId, name:c.name, mode:c.mode,
      lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
      pieces:c.pieces, rate:c.rate, gstRate:c.gstRate,
      discountType:c.discountType, discountValue:c.discountValue
    }))
  };
}
async function savePo(asDraft){
  if(!state.po.supplierId){ toast("Select a supplier first."); return; }
  if(!state.po.cart.length){ toast("Add at least one product to the order."); return; }
  for(const c of state.po.cart){
    const bad = Pricing.validateLine({
      mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
      thicknessIn:c.thicknessIn, pieces:c.pieces, rate: c.rate
    }, c.name);
    if(bad){ toast(bad); return; }
  }
  const saveBtn = document.getElementById("po-save-btn");
  const draftBtn = document.getElementById("po-save-draft-btn");
  saveBtn.disabled = true; draftBtn.disabled = true;
  try{
    const payload = { ...poPayload(), saveAsDraft: !!asDraft };
    const editingId = state.po.editingPoId;
    const saved = editingId
      ? await api("PUT", `/purchase-orders/${editingId}`, payload)
      : await api("POST", "/purchase-orders", payload);
    resetPoState();
    renderPoEditBanner();
    await Promise.all([loadProducts(), loadSuppliers()]);
    toast(`Purchase Order ${saved.po_no} ${editingId?"updated":"saved"} (${saved.status})`, "ok");
    switchTab("home");
  }catch(e){
    toast(e.message);
  }finally{
    saveBtn.disabled = false; draftBtn.disabled = false;
  }
}

/* ============================================================
   SHEET: Purchase Order Detail (view + status-driven actions)
   ============================================================ */
const PO_STATUS_PILL = {
  Draft: "", Pending: "warn", Approved: "ok", "Partially Completed": "warn", Completed: "ok", Cancelled: "danger"
};
async function openPoDetail(poId){
  const po = await api("GET", `/purchase-orders/${poId}`);
  const sheet = document.getElementById("sheet-po-detail");
  const lineTotal = it => {
    const taxable = round2(it.qty*it.rate - it.discount_amount);
    return round2(taxable + taxable*(it.gst_rate/100));
  };
  const canEdit = ["Draft","Pending"].includes(po.status);
  const canApprove = ["Draft","Pending"].includes(po.status);
  const canConvert = po.status === "Approved";
  const canClose = !["Completed","Cancelled"].includes(po.status);
  const canDelete = po.status === "Draft";
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(po.po_no)} <span class="pill ${PO_STATUS_PILL[po.status]||''}">${escapeHtml(po.status)}</span></div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${po.date}${po.expected_delivery_date?" · Expected "+po.expected_delivery_date:""}${po.delivery_address?"<br>"+escapeHtml(po.delivery_address):""}</div>
    <div class="card">${po.items.map(it=>`
      <div class="list-row">
        <div><div class="row-title">${escapeHtml(it.name)}</div><div class="row-sub">${escapeHtml(it.size_label||"")} · ${it.pieces} ${escapeHtml(it.unit_label||"")} × ${fmt(it.rate)}${it.discount_amount>0?" · disc. "+fmt(it.discount_amount):""}</div></div>
        <div class="row-right row-title">${fmt(lineTotal(it))}</div>
      </div>`).join("")}
    </div>
    <div class="card" style="margin-top:8px;">
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(po.subtotal)}</span></div>
      ${po.discount_amount>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Discount</span><span>-${fmt(po.discount_amount)}</span></div>`:""}
      ${po.freight>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Freight</span><span>${fmt(po.freight)}</span></div>`:""}
      ${po.other_charges>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Other Charges</span><span>${fmt(po.other_charges)}</span></div>`:""}
      ${po.tax_type==="IGST"
        ? `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">IGST</span><span>${fmt(po.igst)}</span></div>`
        : `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">CGST</span><span>${fmt(po.cgst)}</span></div><div class="inv-flex" style="margin-bottom:4px;"><span class="muted">SGST</span><span>${fmt(po.sgst)}</span></div>`}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(po.total)}</span></div>
    </div>
    ${po.payment_terms||po.delivery_terms||po.remarks ? `<div class="card" style="margin-top:8px;font-size:12px;">
      ${po.payment_terms?`<div><span class="muted">Payment Terms:</span> ${escapeHtml(po.payment_terms)}</div>`:""}
      ${po.delivery_terms?`<div><span class="muted">Delivery Terms:</span> ${escapeHtml(po.delivery_terms)}</div>`:""}
      ${po.remarks?`<div><span class="muted">Remarks:</span> ${escapeHtml(po.remarks)}</div>`:""}
    </div>` : ""}
    ${po.converted_purchase_id ? `<div class="muted" style="font-size:11.5px;margin-top:8px;">Converted to Purchase Entry.</div>` : ""}
    ${canConvert ? `
    <label class="field-label" style="margin-top:14px;">Stock goes to</label>
    <div class="chip-row" id="po-convert-location-chips">
      ${state.locations.map((l,i)=>`<button class="chip ${l.code==='warehouse'?'selected':''}" data-po-convert-loc="${l.id}">${escapeHtml(l.name)}</button>`).join("")}
    </div>` : ""}
    <div class="action-row" style="margin-top:14px;">
      ${canEdit ? `<button class="btn btn-outline" id="edit-po-btn">✎ Edit</button>` : ""}
      ${canApprove ? `<button class="btn btn-outline" id="approve-po-btn">Approve</button>` : ""}
      ${canConvert ? `<button class="btn btn-gold" id="convert-po-btn">Convert to Purchase Entry</button>` : ""}
      <button class="btn btn-outline" id="print-po-btn">Print</button>
      <button class="btn btn-outline" id="share-po-btn">Share (WhatsApp)</button>
    </div>
    ${canClose ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="close-po-link" class="btn-danger-link">Close / Cancel this order</a></div>` : ""}
    ${canDelete ? `<div style="margin-top:8px;text-align:center;"><a href="#" id="delete-po-link" class="btn-danger-link">Delete this draft</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  const editBtn = sheet.querySelector("#edit-po-btn");
  if(editBtn) editBtn.addEventListener("click", ()=>{ closeAllSheets(); editExistingPo(po); });
  const approveBtn = sheet.querySelector("#approve-po-btn");
  if(approveBtn) approveBtn.addEventListener("click", async ()=>{
    try{
      await api("POST", `/purchase-orders/${po.id}/approve`);
      closeAllSheets();
      toast("Purchase Order approved.", "ok");
    }catch(err){ toast(err.message); }
  });
  sheet.querySelectorAll("[data-po-convert-loc]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-po-convert-loc]").forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected");
  }));
  const convertBtn = sheet.querySelector("#convert-po-btn");
  if(convertBtn) convertBtn.addEventListener("click", async ()=>{
    const selectedLoc = sheet.querySelector("[data-po-convert-loc].selected");
    if(!confirm(`Convert ${po.po_no} to a real Purchase Entry? This will increase ${selectedLoc?selectedLoc.textContent:"Warehouse"} stock and the supplier's due.`)) return;
    try{
      const result = await api("POST", `/purchase-orders/${po.id}/convert`, {
        paymentMethod: "Credit",
        locationId: selectedLoc ? selectedLoc.dataset.poConvertLoc : undefined
      });
      await Promise.all([loadProducts(), loadSuppliers()]);
      closeAllSheets();
      toast(`Converted to ${result.purchase.purchase_no}.`, "ok");
    }catch(err){ toast(err.message); }
  });
  sheet.querySelector("#print-po-btn").addEventListener("click", ()=>printPurchaseOrder(po));
  sheet.querySelector("#share-po-btn").addEventListener("click", ()=>sharePoWhatsApp(po));
  const closeLink = sheet.querySelector("#close-po-link");
  if(closeLink) closeLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm(`Close/Cancel ${po.po_no}? This can't be undone.`)){
      try{
        await api("POST", `/purchase-orders/${po.id}/close`);
        closeAllSheets();
        toast("Purchase Order cancelled.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  const deleteLink = sheet.querySelector("#delete-po-link");
  if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm(`Delete this draft permanently? This can't be undone.`)){
      try{
        await api("DELETE", `/purchase-orders/${po.id}`);
        closeAllSheets();
        toast("Draft deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-po-detail");
}
function editExistingPo(po){
  state.po.cart = po.items.map(it=>{
    const product = state.products.find(x=>x.id===it.product_id);
    const sizeIdx = product ? product.sizes.findIndex(s=>s.id===it.size_id) : -1;
    return {
      productId: it.product_id, sizeId: it.size_id, sizeIdx: sizeIdx>=0 ? sizeIdx : 0,
      name: it.name, mode: it.mode, lengthFt: it.length_ft||"", widthVal: it.width_val||"",
      thicknessIn: it.thickness_in||"", pieces: it.pieces, rate: it.rate, gstRate: it.gst_rate,
      discountType: it.discount_amount>0 ? "flat" : "pct", discountValue: it.discount_amount>0 ? it.discount_amount : 0
    };
  });
  state.po.supplierId = po.supplier_id;
  state.po.purchaseType = po.purchase_type;
  state.po.date = po.date;
  state.po.deliveryAddress = po.delivery_address || "";
  state.po.expectedDeliveryDate = po.expected_delivery_date || "";
  state.po.paymentTerms = po.payment_terms || "";
  state.po.deliveryTerms = po.delivery_terms || "";
  state.po.remarks = po.remarks || "";
  state.po.freight = po.freight || 0;
  state.po.otherCharges = po.other_charges || 0;
  state.po.roundOff = true;
  state.po.editingPoId = po.id;

  switchTab("po");
  renderPoScreen().then(()=>{
    const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
    set("po-date", state.po.date);
    set("po-expected-date", state.po.expectedDeliveryDate);
    set("po-delivery-address", state.po.deliveryAddress);
    set("po-payment-terms", state.po.paymentTerms);
    set("po-delivery-terms", state.po.deliveryTerms);
    set("po-remarks", state.po.remarks);
    set("po-freight-input", state.po.freight);
    set("po-other-input", state.po.otherCharges);
    document.querySelectorAll('[data-po-type]').forEach(x=>x.classList.toggle("selected", x.dataset.poType===state.po.purchaseType));
    renderPoEditBanner();
    toast(`Editing ${po.po_no} — make your changes, then save.`, "ok");
  });
}
/** Simple print view — mirrors printCashBook()/printPartyLedger(); no dedicated PDF pipeline for POs yet. */
function printPurchaseOrder(po){
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(po.po_no)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
      .totals{margin-top:10px;font-size:12px;text-align:right;}
    </style></head><body>
    <h1>Purchase Order — ${escapeHtml(po.po_no)}</h1>
    <div class="sub">${po.date} · Status: ${escapeHtml(po.status)}${po.expected_delivery_date?" · Expected delivery "+po.expected_delivery_date:""}</div>
    <div class="sub">${po.delivery_address?"Deliver to: "+escapeHtml(po.delivery_address):""}</div>
    <table><thead><tr><th>#</th><th>Product</th><th>Size</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc.</th><th class="num">GST%</th><th class="num">Amount</th></tr></thead>
    <tbody>${po.items.map((it,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.size_label||"")}</td>
      <td class="num">${it.pieces}</td><td class="num">${fmt(it.rate)}</td><td class="num">${fmt(it.discount_amount)}</td>
      <td class="num">${it.gst_rate}%</td><td class="num">${fmt(round2(it.qty*it.rate-it.discount_amount))}</td></tr>`).join("")}</tbody></table>
    <div class="totals">
      Subtotal: ${fmt(po.subtotal)}<br>
      ${po.discount_amount>0?`Discount: -${fmt(po.discount_amount)}<br>`:""}
      ${po.freight>0?`Freight: ${fmt(po.freight)}<br>`:""}
      ${po.other_charges>0?`Other: ${fmt(po.other_charges)}<br>`:""}
      ${po.tax_type==="IGST"?`IGST: ${fmt(po.igst)}<br>`:`CGST: ${fmt(po.cgst)}<br>SGST: ${fmt(po.sgst)}<br>`}
      <strong>Grand Total: ${fmt(po.total)}</strong>
    </div>
    ${po.payment_terms?`<div class="sub" style="margin-top:10px;">Payment Terms: ${escapeHtml(po.payment_terms)}</div>`:""}
    ${po.delivery_terms?`<div class="sub">Delivery Terms: ${escapeHtml(po.delivery_terms)}</div>`:""}
    ${po.remarks?`<div class="sub">Remarks: ${escapeHtml(po.remarks)}</div>`:""}
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}
/** Same share-as-text-link pattern as an invoice's WhatsApp share — there is no real email/SMTP integration in this app. */
function sharePoWhatsApp(po){
  const sup = state.suppliers.find(s=>s.id===po.supplier_id);
  const lines = [
    `Purchase Order ${po.po_no}`,
    `Date: ${po.date}`,
    sup ? `Supplier: ${sup.name}` : "",
    ...po.items.map(it=>`${it.name} (${it.size_label||""}) x${it.pieces} @ ${fmt(it.rate)}`),
    `Grand Total: ${fmt(po.total)}`
  ].filter(Boolean);
  openWhatsApp(sup && sup.phone, lines.join("\n"));
}

/* ============================================================
   SALES QUOTATION — mirrors the Purchase Order screen above almost
   exactly (customer instead of supplier, transport/loading/discount
   instead of freight/other, since it prices the same way an Invoice does).
   ============================================================ */
async function renderQuotationScreen(){
  if(!state.quotation.date) state.quotation.date = todayISO();
  const dateEl = document.getElementById("quotation-date");
  if(dateEl && !dateEl.value) dateEl.value = state.quotation.date;
  renderQuotationEditBanner();
  renderQuotationCustomers();
  renderQuotationCustomerInfo();
  renderQuotationProducts();
  renderQuotationCart();
  renderQuotationTotals();
  await renderQuotationNumber();
}
/**
 * Shows the number THIS quotation will get before it's saved. Editing an
 * existing quotation already knows its real quotation_no (set by
 * editExistingQuotation); a brand-new one asks the server for a live peek
 * at the next number in the series (see GET /quotations/next-number) so it
 * never has to be invented or hardcoded client-side.
 */
async function renderQuotationNumber(){
  const el = document.getElementById("quotation-number-display");
  if(!el) return;
  if(state.quotation.editingQuotationId && state.quotation.quotationNo){
    el.textContent = state.quotation.quotationNo;
    return;
  }
  el.textContent = "…";
  try{
    const { quotationNo } = await api("GET", "/quotations/next-number");
    state.quotation.quotationNo = quotationNo;
    el.textContent = quotationNo;
  }catch{
    el.textContent = "—";
  }
}
function renderQuotationEditBanner(){
  const el = document.getElementById("quotation-edit-mode-banner");
  if(!el) return;
  if(!state.quotation.editingQuotationId){ el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="card" style="background:var(--warn-bg);border-color:var(--warn-text);margin-bottom:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="font-size:12px;font-weight:700;color:var(--warn-text);">✎ Editing an existing Quotation — Save below will UPDATE it, not create a new one.</div>
      <a href="#" id="cancel-quotation-edit-link" style="font-size:12px;font-weight:800;color:var(--warn-text);white-space:nowrap;">Cancel</a>
    </div>
  `;
  document.getElementById("cancel-quotation-edit-link").addEventListener("click", (e)=>{
    e.preventDefault();
    resetQuotationState();
    renderQuotationScreen();
    toast("Edit cancelled.");
  });
}
function resetQuotationState(){
  state.quotation = {
    customerId: null, saleType: "Local", date: "", validUntil: "", terms: "", remarks: "",
    discountType: "pct", discountValue: 0, transport: 0, loading: 0, gstOnCharges: true, roundOff: true,
    cart: [], editingQuotationId: null, quotationNo: null
  };
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set("quotation-valid-until", ""); set("quotation-terms", ""); set("quotation-remarks", "");
  set("quotation-disc-value", 0); set("quotation-transport-input", 0); set("quotation-loading-input", 0);
  document.querySelectorAll('[data-quotation-type]').forEach(x=>x.classList.toggle("selected", x.dataset.quotationType==="Local"));
  document.querySelectorAll('[data-quotation-disc-type]').forEach(x=>x.classList.toggle("selected", x.dataset.quotationDiscType==="pct"));
  const gstToggle = document.getElementById("quotation-gst-on-charges-toggle"); if(gstToggle) gstToggle.checked = true;
  const roToggle = document.getElementById("quotation-roundoff-toggle"); if(roToggle) roToggle.checked = true;
}
function renderQuotationCustomers(){
  const wrap = document.getElementById("quotation-customers");
  const searchEl = document.getElementById("quotation-customer-search");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  const selected = state.customers.find(c=>c.id===state.quotation.customerId);
  let list = state.customers;
  if(q) list = list.filter(c=>c.name.toLowerCase().includes(q) || (c.phone||"").includes(q));
  if(selected && !list.includes(selected)) list = [selected, ...list];

  wrap.innerHTML = list.map(c=>`
    <button class="chip ${state.quotation.customerId===c.id?'selected':''}" data-quotation-cust="${c.id}">${escapeHtml(c.name)}</button>
  `).join("") || `<div class="empty-hint" style="padding:8px 4px;">${q ? `No customer matches "${escapeHtml(q)}".` : "No customers yet — add one from the Customers tab."}</div>`;

  wrap.querySelectorAll("[data-quotation-cust]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.quotation.customerId = b.dataset.quotationCust;
      const cust = state.customers.find(c=>c.id===state.quotation.customerId);
      state.quotation.saleType = (cust && cust.gst_type === "IGST") ? "Interstate" : "Local";
      document.querySelectorAll('[data-quotation-type]').forEach(x=>x.classList.toggle("selected", x.dataset.quotationType===state.quotation.saleType));
      renderQuotationCustomers();
      renderQuotationCustomerInfo();
      renderQuotationTotals();
    });
  });
}
function renderQuotationCustomerInfo(){
  const box = document.getElementById("quotation-customer-info");
  const cust = state.customers.find(c=>c.id===state.quotation.customerId);
  if(!cust){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div><strong>${escapeHtml(cust.name)}</strong></div>
    ${cust.phone ? `<div class="muted">${escapeHtml(cust.phone)}</div>` : ""}
    ${cust.gst ? `<div class="muted">GST: ${escapeHtml(cust.gst)}</div>` : ""}
    ${cust.state ? `<div class="muted">${escapeHtml(cust.state)}</div>` : ""}
    ${cust.address ? `<div class="muted">${escapeHtml(cust.address)}</div>` : ""}
  `;
}
function renderQuotationProducts(){
  const q = (document.getElementById("quotation-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("quotation-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    return `<div class="list-row" data-open-quotation-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div></div>
      <div class="row-right"><button class="gold-fab" data-quotation-quickadd="${p.id}" style="width:30px;height:30px;">+</button></div>
    </div>`;
  }).join("") || `<div class="empty-hint">No matching products.</div>`;

  wrap.querySelectorAll("[data-open-quotation-product]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest("[data-quotation-quickadd]")) return;
      openProductDetail(el.dataset.openQuotationProduct, "quotation");
    });
  });
  wrap.querySelectorAll("[data-quotation-quickadd]").forEach(b=>{
    b.addEventListener("click", (e)=>{ e.stopPropagation(); openProductDetail(b.dataset.quotationQuickadd, "quotation"); });
  });
}
function addToQuotationCart(productId, sizeIdx){
  const p = state.products.find(x=>x.id===productId);
  if(!p) return false;
  if(!p.sizes.length){ toast(`"${p.name}" has no price yet — open it and tap Edit to add one.`); return false; }
  const size = p.sizes[sizeIdx] || p.sizes[0];
  state.quotation.cart.push({
    productId, sizeId: size.id, sizeIdx,
    name: p.name + (p.sizes.length>1 ? " ("+size.label+")" : ""),
    mode: Pricing.normaliseMode(p.default_mode),
    lengthFt: p.length_ft || "", widthVal: p.width_val || "", thicknessIn: p.thickness_in || "",
    pieces: 1, rate: size.price, gstRate: p.gst,
    discountType: "pct", discountValue: 0
  });
  renderQuotationCart(); renderQuotationTotals();
  return true;
}
function quotationLineCalc(c){
  const r = Pricing.computeLine({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate});
  const discountAmount = c.discountType === "flat"
    ? round2(Math.min(Math.max(0, c.discountValue||0), r.amount))
    : round2(r.amount * (Math.min(100, Math.max(0, c.discountValue||0))/100));
  const taxable = round2(r.amount - discountAmount);
  const gstAmt = round2(taxable * ((c.gstRate||18)/100));
  const finalAmt = round2(taxable + gstAmt);
  return {...r, discountAmount, taxable, gstAmt, finalAmt};
}
function renderQuotationCart(){
  const wrap = document.getElementById("quotation-cart-list");
  if(!state.quotation.cart.length){
    wrap.innerHTML = `<div class="empty-hint">No items yet. Add products above.</div>`;
    return;
  }
  wrap.innerHTML = state.quotation.cart.map((c,idx)=>{
    const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
    const r = quotationLineCalc(c);

    const dim = (label, unit, key, val) => `
      <label class="dim">
        <span>${label}${unit?` <em>(${unit})</em>`:""}</span>
        <input type="number" inputmode="decimal" step="any" min="0"
               value="${val===0||val?val:""}" data-quotation-line-field="${key}" data-quotation-line="${idx}" placeholder="0">
      </label>`;

    return `<div class="bill-line" data-quotation-line-row="${idx}">
      <div class="bill-line-head">
        <div class="bill-line-name">${escapeHtml(c.name)}</div>
        <div class="line-actions">
          <a href="#" data-quotation-dup="${idx}">Duplicate</a>
          <a href="#" data-quotation-remove="${idx}" class="btn-danger-link">Remove</a>
        </div>
      </div>

      <div class="mode-row">
        ${Pricing.MODE_KEYS.map(k=>`
          <button class="chip sm ${k===m.key?'selected':''}" data-quotation-line-mode="${k}" data-quotation-line="${idx}"
                  title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>
        `).join("")}
      </div>

      <div class="dim-grid">
        ${m.needsThickness ? dim("Thickness", m.thicknessUnit, "thicknessIn", c.thicknessIn) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", c.lengthFt) : ""}
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", c.widthVal) : ""}
        ${dim("Qty", "pcs", "pieces", c.pieces)}
        ${dim("Rate", "₹/"+m.unit, "rate", c.rate)}
      </div>

      <div class="chip-row" style="margin-top:8px;">
        <button class="chip sm ${c.discountType==="pct"?'selected':''}" data-quotation-line-disc-type="pct" data-quotation-line="${idx}">Discount %</button>
        <button class="chip sm ${c.discountType==="flat"?'selected':''}" data-quotation-line-disc-type="flat" data-quotation-line="${idx}">Discount ₹</button>
      </div>
      <div class="dim-grid">
        ${dim("Discount", c.discountType==="flat"?"₹":"%", "discountValue", c.discountValue)}
        <label class="dim"><span>GST <em>(%)</em></span><input type="number" value="${c.gstRate}" disabled style="opacity:0.6;"></label>
      </div>

      <div class="line-calc">
        <div class="line-calc-formula">
          ${r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : ""}
          ${m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : ""}
          <strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>
          × ${Pricing.formatRate(r.rate, r.mode)}
          ${r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : ""}
          + ${fmtPaise(r.gstAmt)} GST
        </div>
        <div class="line-calc-amount">${fmtPaise(r.finalAmt)}</div>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-quotation-line-mode]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.quotation.cart[b.dataset.quotationLine];
    const next = b.dataset.quotationLineMode;
    if(c.mode === next) return;
    c.rate = Pricing.isRateConvertible(c.mode, next)
      ? Pricing.convertLineRate({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
                                 thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate}, next)
      : "";
    c.mode = next;
    renderQuotationCart(); renderQuotationTotals();
  }));

  wrap.querySelectorAll("[data-quotation-line-disc-type]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.quotation.cart[b.dataset.quotationLine];
    c.discountType = b.dataset.quotationLineDiscType;
    renderQuotationCart(); renderQuotationTotals();
  }));

  wrap.querySelectorAll("[data-quotation-line-field]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const c = state.quotation.cart[inp.dataset.quotationLine];
      const v = inp.value === "" ? "" : Math.max(0, parseFloat(inp.value)||0);
      c[inp.dataset.quotationLineField] = v;
      renderQuotationLineCalc(inp.dataset.quotationLine);
      renderQuotationTotals();
    });
    inp.addEventListener("blur", ()=>{ renderQuotationCart(); renderQuotationTotals(); });
  });

  wrap.querySelectorAll("[data-quotation-dup]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault();
    const i = Number(a.dataset.quotationDup);
    state.quotation.cart.splice(i+1, 0, Object.assign({}, state.quotation.cart[i]));
    renderQuotationCart(); renderQuotationTotals();
  }));

  wrap.querySelectorAll("[data-quotation-remove]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault(); state.quotation.cart.splice(a.dataset.quotationRemove,1); renderQuotationCart(); renderQuotationTotals();
  }));
}
function renderQuotationLineCalc(idx){
  const row = document.querySelector(`[data-quotation-line-row="${idx}"]`);
  if(!row) return;
  const c = state.quotation.cart[idx];
  const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
  const r = quotationLineCalc(c);
  const f = row.querySelector(".line-calc-formula");
  const a = row.querySelector(".line-calc-amount");
  if(f) f.innerHTML =
    (r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : "") +
    (m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : "") +
    `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>` +
    ` × ${Pricing.formatRate(r.rate, r.mode)}` +
    (r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : "") +
    ` + ${fmtPaise(r.gstAmt)} GST`;
  if(a) a.textContent = fmtPaise(r.finalAmt);
}
function computeQuotationTotals(){
  const lines = state.quotation.cart.map(quotationLineCalc);
  const subtotal = round2(lines.reduce((s,r)=>s+r.amount,0));
  let discountAmount = 0;
  if(state.quotation.discountType === "flat") discountAmount = Number(state.quotation.discountValue)||0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(state.quotation.discountValue)||0))/100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let goodsTax = 0;
  lines.forEach(r=>{
    const share = subtotal>0 ? (r.amount/subtotal)*discountAmount : 0;
    const taxable = Math.max(0, r.amount - share);
    goodsTax += taxable * ((r.gstRate||18)/100);
  });
  goodsTax = round2(goodsTax);

  const transport = round2(Math.max(0, state.quotation.transport||0));
  const loading = round2(Math.max(0, state.quotation.loading||0));
  const taxableGoods = round2(subtotal - discountAmount);
  const effectiveRate = taxableGoods>0 ? goodsTax/taxableGoods : 0;
  const ancillaryTax = state.quotation.gstOnCharges ? round2((transport+loading)*effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst=0, sgst=0, igst=0;
  if(state.quotation.saleType==="Interstate") igst = totalTax;
  else { cgst = round2(totalTax/2); sgst = round2(totalTax-cgst); }

  const preRound = subtotal - discountAmount + transport + loading + cgst + sgst + igst;
  const total = round2(state.quotation.roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return {subtotal, discountAmount, cgst, sgst, igst, transport, loading, roundOffAmount, total};
}
function renderQuotationTotals(){
  const t = computeQuotationTotals();
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("quotation-totals-card").innerHTML = `
    ${row("Subtotal", fmtPaise(t.subtotal))}
    ${t.discountAmount>0 ? row("Total Discount", "-"+fmtPaise(t.discountAmount), "color:var(--danger);") : ""}
    ${t.transport>0 ? row("Transport", fmtPaise(t.transport)) : ""}
    ${t.loading>0 ? row("Loading", fmtPaise(t.loading)) : ""}
    ${state.quotation.saleType==="Interstate"
      ? row("IGST", fmtPaise(t.igst))
      : row("CGST", fmtPaise(t.cgst)) + row("SGST", fmtPaise(t.sgst))}
    ${t.roundOffAmount!==0 ? row("Round off", (t.roundOffAmount>0?"+":"")+fmtPaise(t.roundOffAmount)) : ""}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Grand Total</span><span>${fmtPaise(t.total)}</span></div>
    <div class="amount-words">${Pricing.amountInWords(t.total)}</div>
  `;
}
function quotationPayload(){
  return {
    customerId: state.quotation.customerId,
    date: document.getElementById("quotation-date").value || state.quotation.date,
    validUntil: state.quotation.validUntil, saleType: state.quotation.saleType,
    discountType: state.quotation.discountType, discountValue: state.quotation.discountValue,
    transport: state.quotation.transport, loading: state.quotation.loading,
    gstOnCharges: state.quotation.gstOnCharges, roundOff: state.quotation.roundOff,
    terms: state.quotation.terms, remarks: state.quotation.remarks,
    items: state.quotation.cart.map(c=>({
      productId:c.productId, sizeId:c.sizeId, name:c.name, mode:c.mode,
      lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
      pieces:c.pieces, rate:c.rate, gstRate:c.gstRate,
      discountType:c.discountType, discountValue:c.discountValue
    }))
  };
}
async function saveQuotation(asDraft){
  if(!state.quotation.cart.length){ toast("Add at least one product to the quotation."); return; }
  for(const c of state.quotation.cart){
    const bad = Pricing.validateLine({
      mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
      thicknessIn:c.thicknessIn, pieces:c.pieces, rate: c.rate
    }, c.name);
    if(bad){ toast(bad); return; }
  }
  const saveBtn = document.getElementById("quotation-save-btn");
  const draftBtn = document.getElementById("quotation-save-draft-btn");
  saveBtn.disabled = true; draftBtn.disabled = true;
  try{
    const payload = { ...quotationPayload(), saveAsDraft: !!asDraft };
    const editingId = state.quotation.editingQuotationId;
    const saved = editingId
      ? await api("PUT", `/quotations/${editingId}`, payload)
      : await api("POST", "/quotations", payload);
    resetQuotationState();
    renderQuotationEditBanner();
    await loadCustomers();
    toast(`Quotation ${saved.quotation_no} ${editingId?"updated":"saved"} (${saved.status})`, "ok");
    switchTab("home");
  }catch(e){
    toast(e.message);
  }finally{
    saveBtn.disabled = false; draftBtn.disabled = false;
  }
}

/* ============================================================
   SHEET: Quotation Detail (view + status-driven actions)
   ============================================================ */
const QUOTATION_STATUS_PILL = { Draft: "", Sent: "warn", Accepted: "ok", Converted: "ok", Cancelled: "danger" };
async function openQuotationDetail(quotationId){
  const q = await api("GET", `/quotations/${quotationId}`);
  const sheet = document.getElementById("sheet-quotation-detail");
  const lineTotal = it => {
    const taxable = round2(it.qty*it.rate - it.discount_amount);
    return round2(taxable + taxable*(it.gst_rate/100));
  };
  const canEdit = ["Draft","Sent"].includes(q.status);
  const canAccept = ["Draft","Sent"].includes(q.status);
  const canConvert = q.status === "Accepted";
  const canCancel = !["Converted","Cancelled"].includes(q.status);
  // A Draft can be deleted by any staff; any other status is owner-only —
  // mirrors the server-side check in DELETE /quotations/:id.
  const canDelete = q.status === "Draft" || isOwner();
  const cust = state.customers.find(c=>c.id===q.customer_id);
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(q.quotation_no)} <span class="pill ${QUOTATION_STATUS_PILL[q.status]||''}">${escapeHtml(q.status)}</span></div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${q.date}${q.valid_until?" · Valid until "+q.valid_until:""}${cust?"<br>"+escapeHtml(cust.name):""}</div>
    <div class="card">${q.items.map(it=>`
      <div class="list-row">
        <div><div class="row-title">${escapeHtml(it.name)}</div><div class="row-sub">${escapeHtml(it.size_label||"")} · ${it.pieces} ${escapeHtml(it.unit_label||"")} × ${fmt(it.rate)}${it.discount_amount>0?" · disc. "+fmt(it.discount_amount):""}</div></div>
        <div class="row-right row-title">${fmt(lineTotal(it))}</div>
      </div>`).join("")}
    </div>
    <div class="card" style="margin-top:8px;">
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(q.subtotal)}</span></div>
      ${q.discount_amount>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Discount</span><span>-${fmt(q.discount_amount)}</span></div>`:""}
      ${q.transport>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Transport</span><span>${fmt(q.transport)}</span></div>`:""}
      ${q.loading>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Loading</span><span>${fmt(q.loading)}</span></div>`:""}
      ${q.tax_type==="IGST"
        ? `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">IGST</span><span>${fmt(q.igst)}</span></div>`
        : `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">CGST</span><span>${fmt(q.cgst)}</span></div><div class="inv-flex" style="margin-bottom:4px;"><span class="muted">SGST</span><span>${fmt(q.sgst)}</span></div>`}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(q.total)}</span></div>
    </div>
    ${q.terms||q.remarks ? `<div class="card" style="margin-top:8px;font-size:12px;">
      ${q.terms?`<div><span class="muted">Terms &amp; Conditions:</span><div style="white-space:pre-line;">${escapeHtml(q.terms)}</div></div>`:""}
      ${q.remarks?`<div><span class="muted">Remarks:</span> ${escapeHtml(q.remarks)}</div>`:""}
    </div>` : ""}
    ${q.converted_invoice_id ? `<div class="muted" style="font-size:11.5px;margin-top:8px;">Converted to Tax Invoice.</div>` : ""}
    ${canConvert ? `
    <label class="field-label" style="margin-top:14px;">Sell from</label>
    <div class="chip-row" id="quotation-convert-location-chips">
      ${state.locations.map(l=>`<button class="chip ${l.code==='shop'?'selected':''}" data-quotation-convert-loc="${l.id}">${escapeHtml(l.name)}</button>`).join("")}
    </div>` : ""}
    <div class="action-row" style="margin-top:14px;">
      ${canEdit ? `<button class="btn btn-outline" id="edit-quotation-btn">✎ Edit</button>` : ""}
      ${canAccept ? `<button class="btn btn-outline" id="accept-quotation-btn">Mark Accepted</button>` : ""}
      ${canConvert ? `<button class="btn btn-gold" id="convert-quotation-btn">Convert to Invoice</button>` : ""}
      <button class="btn btn-outline" id="print-quotation-btn">Print</button>
      <button class="btn btn-outline" id="share-quotation-btn">Share (WhatsApp)</button>
    </div>
    ${canCancel ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="cancel-quotation-link" class="btn-danger-link">Cancel this quotation</a></div>` : ""}
    ${canDelete ? `<div style="margin-top:8px;text-align:center;"><a href="#" id="delete-quotation-link" class="btn-danger-link">${q.status==="Draft"?"Delete this draft":"Delete this quotation"}</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  const editBtn = sheet.querySelector("#edit-quotation-btn");
  if(editBtn) editBtn.addEventListener("click", ()=>{ closeAllSheets(); editExistingQuotation(q); });
  const acceptBtn = sheet.querySelector("#accept-quotation-btn");
  if(acceptBtn) acceptBtn.addEventListener("click", async ()=>{
    try{
      await api("POST", `/quotations/${q.id}/accept`);
      closeAllSheets();
      toast("Quotation marked Accepted.", "ok");
    }catch(err){ toast(err.message); }
  });
  sheet.querySelectorAll("[data-quotation-convert-loc]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-quotation-convert-loc]").forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected");
  }));
  const convertBtn = sheet.querySelector("#convert-quotation-btn");
  if(convertBtn) convertBtn.addEventListener("click", async ()=>{
    const selectedLoc = sheet.querySelector("[data-quotation-convert-loc].selected");
    const locName = selectedLoc ? selectedLoc.textContent : "Shop";
    if(!confirm(`Convert ${q.quotation_no} to a real Tax Invoice? This will deduct ${locName} stock and raise the customer's due.`)) return;
    try{
      const result = await api("POST", `/quotations/${q.id}/convert`, {
        paymentMethod: "Cash", advance: 0,
        locationId: selectedLoc ? selectedLoc.dataset.quotationConvertLoc : undefined
      });
      await Promise.all([loadProducts(), loadCustomers()]);
      closeAllSheets();
      toast(`Converted to ${result.invoice.challan_no}.`, "ok");
    }catch(err){ toast(err.message); }
  });
  sheet.querySelector("#print-quotation-btn").addEventListener("click", ()=>printQuotation(q));
  sheet.querySelector("#share-quotation-btn").addEventListener("click", ()=>shareQuotationWhatsApp(q));
  const cancelLink = sheet.querySelector("#cancel-quotation-link");
  if(cancelLink) cancelLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm(`Cancel ${q.quotation_no}? This can't be undone.`)){
      try{
        await api("POST", `/quotations/${q.id}/cancel`);
        closeAllSheets();
        toast("Quotation cancelled.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  const deleteLink = sheet.querySelector("#delete-quotation-link");
  if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    const msg = q.status==="Draft"
      ? "Delete this draft permanently? This can't be undone."
      : `Permanently delete ${q.quotation_no} (${q.status})? This can't be undone and leaves a gap in the quotation number series.`;
    if(confirm(msg)){
      try{
        await api("DELETE", `/quotations/${q.id}`);
        closeAllSheets();
        toast(q.status==="Draft" ? "Draft deleted." : "Quotation deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-quotation-detail");
}
function editExistingQuotation(q){
  state.quotation.cart = q.items.map(it=>{
    const product = state.products.find(x=>x.id===it.product_id);
    const sizeIdx = product ? product.sizes.findIndex(s=>s.id===it.size_id) : -1;
    return {
      productId: it.product_id, sizeId: it.size_id, sizeIdx: sizeIdx>=0 ? sizeIdx : 0,
      name: it.name, mode: it.mode, lengthFt: it.length_ft||"", widthVal: it.width_val||"",
      thicknessIn: it.thickness_in||"", pieces: it.pieces, rate: it.rate, gstRate: it.gst_rate,
      discountType: it.discount_amount>0 ? "flat" : "pct", discountValue: it.discount_amount>0 ? it.discount_amount : 0
    };
  });
  state.quotation.customerId = q.customer_id;
  state.quotation.saleType = q.sale_type;
  state.quotation.date = q.date;
  state.quotation.validUntil = q.valid_until || "";
  state.quotation.terms = q.terms || "";
  state.quotation.remarks = q.remarks || "";
  state.quotation.discountType = q.discount_type;
  state.quotation.discountValue = q.discount_value;
  state.quotation.transport = q.transport || 0;
  state.quotation.loading = q.loading || 0;
  state.quotation.gstOnCharges = !!q.gst_on_charges;
  state.quotation.roundOff = true;
  state.quotation.editingQuotationId = q.id;
  state.quotation.quotationNo = q.quotation_no;

  switchTab("quotation");
  renderQuotationScreen().then(()=>{
    const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
    set("quotation-date", state.quotation.date);
    set("quotation-valid-until", state.quotation.validUntil);
    set("quotation-terms", state.quotation.terms);
    set("quotation-remarks", state.quotation.remarks);
    set("quotation-disc-value", state.quotation.discountValue);
    set("quotation-transport-input", state.quotation.transport);
    set("quotation-loading-input", state.quotation.loading);
    document.querySelectorAll('[data-quotation-type]').forEach(x=>x.classList.toggle("selected", x.dataset.quotationType===state.quotation.saleType));
    document.querySelectorAll('[data-quotation-disc-type]').forEach(x=>x.classList.toggle("selected", x.dataset.quotationDiscType===state.quotation.discountType));
    document.getElementById("quotation-gst-on-charges-toggle").checked = state.quotation.gstOnCharges;
    renderQuotationEditBanner();
    toast(`Editing ${q.quotation_no} — make your changes, then save.`, "ok");
  });
}
/** Shop name/address/GSTIN/phone block shared by every print view that
 *  represents something FROM the shop TO a party (Quotation, Sales Order,
 *  Sales Return) — Purchase Order omits this since it's addressed to a
 *  supplier and the recipient already knows who they're dealing with. */
function printShopHeaderHtml(){
  const cfg = state.settings || {};
  return `
    <div class="shop-header">
      <div class="shop-name">${escapeHtml(cfg.business_name||"")}</div>
      ${cfg.tagline ? `<div class="shop-tag">${escapeHtml(cfg.tagline)}</div>` : ""}
      ${cfg.address ? `<div class="shop-addr">${escapeHtml(cfg.address)}</div>` : ""}
      <div class="shop-contact">${[
        cfg.gstin ? `GSTIN: ${escapeHtml(cfg.gstin)}` : "",
        cfg.phones ? `Ph: ${escapeHtml(cfg.phones)}` : ""
      ].filter(Boolean).join("  |  ")}</div>
    </div>`;
}
const SHOP_HEADER_CSS = `
  .shop-header{text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px;}
  .shop-name{font-size:20px;font-weight:800;}
  .shop-tag{font-size:11px;color:#555;}
  .shop-addr{font-size:11px;color:#333;margin-top:2px;}
  .shop-contact{font-size:11px;color:#333;margin-top:2px;}
`;
function printQuotation(q){
  const cust = state.customers.find(c=>c.id===q.customer_id);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(q.quotation_no)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
      .totals{margin-top:10px;font-size:12px;text-align:right;}
      ${SHOP_HEADER_CSS}
    </style></head><body>
    ${printShopHeaderHtml()}
    <h1>Quotation — ${escapeHtml(q.quotation_no)}</h1>
    <div class="sub">${q.date}${q.valid_until?" · Valid until "+q.valid_until:""} · Status: ${escapeHtml(q.status)}</div>
    <div class="sub">${cust?"To: "+escapeHtml(cust.name):""}</div>
    <table><thead><tr><th>#</th><th>Product</th><th>Size</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc.</th><th class="num">GST%</th><th class="num">Amount</th></tr></thead>
    <tbody>${q.items.map((it,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.size_label||"")}</td>
      <td class="num">${it.pieces}</td><td class="num">${fmt(it.rate)}</td><td class="num">${fmt(it.discount_amount)}</td>
      <td class="num">${it.gst_rate}%</td><td class="num">${fmt(round2(it.qty*it.rate-it.discount_amount))}</td></tr>`).join("")}</tbody></table>
    <div class="totals">
      Subtotal: ${fmt(q.subtotal)}<br>
      ${q.discount_amount>0?`Discount: -${fmt(q.discount_amount)}<br>`:""}
      ${q.transport>0?`Transport: ${fmt(q.transport)}<br>`:""}
      ${q.loading>0?`Loading: ${fmt(q.loading)}<br>`:""}
      ${q.tax_type==="IGST"?`IGST: ${fmt(q.igst)}<br>`:`CGST: ${fmt(q.cgst)}<br>SGST: ${fmt(q.sgst)}<br>`}
      <strong>Grand Total: ${fmt(q.total)}</strong>
    </div>
    ${q.terms?`<div class="sub" style="margin-top:10px;white-space:pre-line;"><strong>Terms &amp; Conditions:</strong><br>${escapeHtml(q.terms)}</div>`:""}
    ${q.remarks?`<div class="sub">Remarks: ${escapeHtml(q.remarks)}</div>`:""}
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}
function shareQuotationWhatsApp(q){
  const cust = state.customers.find(c=>c.id===q.customer_id);
  const lines = [
    `Quotation ${q.quotation_no}`,
    `Date: ${q.date}`,
    cust ? `To: ${cust.name}` : "",
    ...q.items.map(it=>`${it.name} (${it.size_label||""}) x${it.pieces} @ ${fmt(it.rate)}`),
    `Grand Total: ${fmt(q.total)}`
  ].filter(Boolean);
  openWhatsApp(cust && cust.phone, lines.join("\n"));
}

/* ============================================================
   SALES ORDER — same structure as Quotation, with delivery
   address/expected-date instead of valid-until/terms.
   ============================================================ */
async function renderSoScreen(){
  if(!state.so.date) state.so.date = todayISO();
  const dateEl = document.getElementById("so-date");
  if(dateEl && !dateEl.value) dateEl.value = state.so.date;
  renderSoEditBanner();
  renderSoCustomers();
  renderSoCustomerInfo();
  renderSoProducts();
  renderSoCart();
  renderSoTotals();
}
function renderSoEditBanner(){
  const el = document.getElementById("so-edit-mode-banner");
  if(!el) return;
  if(!state.so.editingSoId){ el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="card" style="background:var(--warn-bg);border-color:var(--warn-text);margin-bottom:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="font-size:12px;font-weight:700;color:var(--warn-text);">✎ Editing an existing Sales Order — Save below will UPDATE it, not create a new one.</div>
      <a href="#" id="cancel-so-edit-link" style="font-size:12px;font-weight:800;color:var(--warn-text);white-space:nowrap;">Cancel</a>
    </div>
  `;
  document.getElementById("cancel-so-edit-link").addEventListener("click", (e)=>{
    e.preventDefault();
    resetSoState();
    renderSoScreen();
    toast("Edit cancelled.");
  });
}
function resetSoState(){
  state.so = {
    customerId: null, saleType: "Local", date: "", deliveryAddress: "", expectedDeliveryDate: "", remarks: "",
    discountType: "pct", discountValue: 0, transport: 0, loading: 0, gstOnCharges: true, roundOff: true,
    cart: [], editingSoId: null
  };
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set("so-delivery-address", ""); set("so-expected-date", ""); set("so-remarks", "");
  set("so-disc-value", 0); set("so-transport-input", 0); set("so-loading-input", 0);
  document.querySelectorAll('[data-so-type]').forEach(x=>x.classList.toggle("selected", x.dataset.soType==="Local"));
  document.querySelectorAll('[data-so-disc-type]').forEach(x=>x.classList.toggle("selected", x.dataset.soDiscType==="pct"));
  const gstToggle = document.getElementById("so-gst-on-charges-toggle"); if(gstToggle) gstToggle.checked = true;
  const roToggle = document.getElementById("so-roundoff-toggle"); if(roToggle) roToggle.checked = true;
}
function renderSoCustomers(){
  const wrap = document.getElementById("so-customers");
  const searchEl = document.getElementById("so-customer-search");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  const selected = state.customers.find(c=>c.id===state.so.customerId);
  let list = state.customers;
  if(q) list = list.filter(c=>c.name.toLowerCase().includes(q) || (c.phone||"").includes(q));
  if(selected && !list.includes(selected)) list = [selected, ...list];

  wrap.innerHTML = list.map(c=>`
    <button class="chip ${state.so.customerId===c.id?'selected':''}" data-so-cust="${c.id}">${escapeHtml(c.name)}</button>
  `).join("") || `<div class="empty-hint" style="padding:8px 4px;">${q ? `No customer matches "${escapeHtml(q)}".` : "No customers yet — add one from the Customers tab."}</div>`;

  wrap.querySelectorAll("[data-so-cust]").forEach(b=>{
    b.addEventListener("click", ()=>{
      state.so.customerId = b.dataset.soCust;
      const cust = state.customers.find(c=>c.id===state.so.customerId);
      state.so.saleType = (cust && cust.gst_type === "IGST") ? "Interstate" : "Local";
      document.querySelectorAll('[data-so-type]').forEach(x=>x.classList.toggle("selected", x.dataset.soType===state.so.saleType));
      renderSoCustomers();
      renderSoCustomerInfo();
      renderSoTotals();
    });
  });
}
function renderSoCustomerInfo(){
  const box = document.getElementById("so-customer-info");
  const cust = state.customers.find(c=>c.id===state.so.customerId);
  if(!cust){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div><strong>${escapeHtml(cust.name)}</strong></div>
    ${cust.phone ? `<div class="muted">${escapeHtml(cust.phone)}</div>` : ""}
    ${cust.gst ? `<div class="muted">GST: ${escapeHtml(cust.gst)}</div>` : ""}
    ${cust.state ? `<div class="muted">${escapeHtml(cust.state)}</div>` : ""}
    ${cust.address ? `<div class="muted">${escapeHtml(cust.address)}</div>` : ""}
  `;
}
function renderSoProducts(){
  const q = (document.getElementById("so-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("so-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    return `<div class="list-row" data-open-so-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div></div>
      <div class="row-right"><button class="gold-fab" data-so-quickadd="${p.id}" style="width:30px;height:30px;">+</button></div>
    </div>`;
  }).join("") || `<div class="empty-hint">No matching products.</div>`;

  wrap.querySelectorAll("[data-open-so-product]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest("[data-so-quickadd]")) return;
      openProductDetail(el.dataset.openSoProduct, "so");
    });
  });
  wrap.querySelectorAll("[data-so-quickadd]").forEach(b=>{
    b.addEventListener("click", (e)=>{ e.stopPropagation(); openProductDetail(b.dataset.soQuickadd, "so"); });
  });
}
function addToSoCart(productId, sizeIdx){
  const p = state.products.find(x=>x.id===productId);
  if(!p) return false;
  if(!p.sizes.length){ toast(`"${p.name}" has no price yet — open it and tap Edit to add one.`); return false; }
  const size = p.sizes[sizeIdx] || p.sizes[0];
  state.so.cart.push({
    productId, sizeId: size.id, sizeIdx,
    name: p.name + (p.sizes.length>1 ? " ("+size.label+")" : ""),
    mode: Pricing.normaliseMode(p.default_mode),
    lengthFt: p.length_ft || "", widthVal: p.width_val || "", thicknessIn: p.thickness_in || "",
    pieces: 1, rate: size.price, gstRate: p.gst,
    discountType: "pct", discountValue: 0
  });
  renderSoCart(); renderSoTotals();
  return true;
}
function soLineCalc(c){
  const r = Pricing.computeLine({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate});
  const discountAmount = c.discountType === "flat"
    ? round2(Math.min(Math.max(0, c.discountValue||0), r.amount))
    : round2(r.amount * (Math.min(100, Math.max(0, c.discountValue||0))/100));
  const taxable = round2(r.amount - discountAmount);
  const gstAmt = round2(taxable * ((c.gstRate||18)/100));
  const finalAmt = round2(taxable + gstAmt);
  return {...r, discountAmount, taxable, gstAmt, finalAmt};
}
function renderSoCart(){
  const wrap = document.getElementById("so-cart-list");
  if(!state.so.cart.length){
    wrap.innerHTML = `<div class="empty-hint">No items yet. Add products above.</div>`;
    return;
  }
  wrap.innerHTML = state.so.cart.map((c,idx)=>{
    const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
    const r = soLineCalc(c);

    const dim = (label, unit, key, val) => `
      <label class="dim">
        <span>${label}${unit?` <em>(${unit})</em>`:""}</span>
        <input type="number" inputmode="decimal" step="any" min="0"
               value="${val===0||val?val:""}" data-so-line-field="${key}" data-so-line="${idx}" placeholder="0">
      </label>`;

    return `<div class="bill-line" data-so-line-row="${idx}">
      <div class="bill-line-head">
        <div class="bill-line-name">${escapeHtml(c.name)}</div>
        <div class="line-actions">
          <a href="#" data-so-dup="${idx}">Duplicate</a>
          <a href="#" data-so-remove="${idx}" class="btn-danger-link">Remove</a>
        </div>
      </div>

      <div class="mode-row">
        ${Pricing.MODE_KEYS.map(k=>`
          <button class="chip sm ${k===m.key?'selected':''}" data-so-line-mode="${k}" data-so-line="${idx}"
                  title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>
        `).join("")}
      </div>

      <div class="dim-grid">
        ${m.needsThickness ? dim("Thickness", m.thicknessUnit, "thicknessIn", c.thicknessIn) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", c.lengthFt) : ""}
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", c.widthVal) : ""}
        ${dim("Qty", "pcs", "pieces", c.pieces)}
        ${dim("Rate", "₹/"+m.unit, "rate", c.rate)}
      </div>

      <div class="chip-row" style="margin-top:8px;">
        <button class="chip sm ${c.discountType==="pct"?'selected':''}" data-so-line-disc-type="pct" data-so-line="${idx}">Discount %</button>
        <button class="chip sm ${c.discountType==="flat"?'selected':''}" data-so-line-disc-type="flat" data-so-line="${idx}">Discount ₹</button>
      </div>
      <div class="dim-grid">
        ${dim("Discount", c.discountType==="flat"?"₹":"%", "discountValue", c.discountValue)}
        <label class="dim"><span>GST <em>(%)</em></span><input type="number" value="${c.gstRate}" disabled style="opacity:0.6;"></label>
      </div>

      <div class="line-calc">
        <div class="line-calc-formula">
          ${r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : ""}
          ${m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : ""}
          <strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>
          × ${Pricing.formatRate(r.rate, r.mode)}
          ${r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : ""}
          + ${fmtPaise(r.gstAmt)} GST
        </div>
        <div class="line-calc-amount">${fmtPaise(r.finalAmt)}</div>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-so-line-mode]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.so.cart[b.dataset.soLine];
    const next = b.dataset.soLineMode;
    if(c.mode === next) return;
    c.rate = Pricing.isRateConvertible(c.mode, next)
      ? Pricing.convertLineRate({mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
                                 thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate}, next)
      : "";
    c.mode = next;
    renderSoCart(); renderSoTotals();
  }));

  wrap.querySelectorAll("[data-so-line-disc-type]").forEach(b=>b.addEventListener("click", ()=>{
    const c = state.so.cart[b.dataset.soLine];
    c.discountType = b.dataset.soLineDiscType;
    renderSoCart(); renderSoTotals();
  }));

  wrap.querySelectorAll("[data-so-line-field]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const c = state.so.cart[inp.dataset.soLine];
      const v = inp.value === "" ? "" : Math.max(0, parseFloat(inp.value)||0);
      c[inp.dataset.soLineField] = v;
      renderSoLineCalc(inp.dataset.soLine);
      renderSoTotals();
    });
    inp.addEventListener("blur", ()=>{ renderSoCart(); renderSoTotals(); });
  });

  wrap.querySelectorAll("[data-so-dup]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault();
    const i = Number(a.dataset.soDup);
    state.so.cart.splice(i+1, 0, Object.assign({}, state.so.cart[i]));
    renderSoCart(); renderSoTotals();
  }));

  wrap.querySelectorAll("[data-so-remove]").forEach(a=>a.addEventListener("click", (e)=>{
    e.preventDefault(); state.so.cart.splice(a.dataset.soRemove,1); renderSoCart(); renderSoTotals();
  }));
}
function renderSoLineCalc(idx){
  const row = document.querySelector(`[data-so-line-row="${idx}"]`);
  if(!row) return;
  const c = state.so.cart[idx];
  const m = Pricing.MODES[Pricing.normaliseMode(c.mode)];
  const r = soLineCalc(c);
  const f = row.querySelector(".line-calc-formula");
  const a = row.querySelector(".line-calc-amount");
  if(f) f.innerHTML =
    (r.sizeLabel ? `<strong>${escapeHtml(r.sizeLabel)}</strong> · ` : "") +
    (m.key!=="UNIT" ? `${Pricing.formatQty(r.perPiece, r.mode)}/pc × ${r.pieces} pcs = ` : "") +
    `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong>` +
    ` × ${Pricing.formatRate(r.rate, r.mode)}` +
    (r.discountAmount>0 ? ` − ${fmtPaise(r.discountAmount)} disc.` : "") +
    ` + ${fmtPaise(r.gstAmt)} GST`;
  if(a) a.textContent = fmtPaise(r.finalAmt);
}
function computeSoTotals(){
  const lines = state.so.cart.map(soLineCalc);
  const subtotal = round2(lines.reduce((s,r)=>s+r.amount,0));
  let discountAmount = 0;
  if(state.so.discountType === "flat") discountAmount = Number(state.so.discountValue)||0;
  else discountAmount = subtotal * (Math.min(100, Math.max(0, Number(state.so.discountValue)||0))/100);
  discountAmount = round2(Math.min(Math.max(0, discountAmount), subtotal));

  let goodsTax = 0;
  lines.forEach(r=>{
    const share = subtotal>0 ? (r.amount/subtotal)*discountAmount : 0;
    const taxable = Math.max(0, r.amount - share);
    goodsTax += taxable * ((r.gstRate||18)/100);
  });
  goodsTax = round2(goodsTax);

  const transport = round2(Math.max(0, state.so.transport||0));
  const loading = round2(Math.max(0, state.so.loading||0));
  const taxableGoods = round2(subtotal - discountAmount);
  const effectiveRate = taxableGoods>0 ? goodsTax/taxableGoods : 0;
  const ancillaryTax = state.so.gstOnCharges ? round2((transport+loading)*effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst=0, sgst=0, igst=0;
  if(state.so.saleType==="Interstate") igst = totalTax;
  else { cgst = round2(totalTax/2); sgst = round2(totalTax-cgst); }

  const preRound = subtotal - discountAmount + transport + loading + cgst + sgst + igst;
  const total = round2(state.so.roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  return {subtotal, discountAmount, cgst, sgst, igst, transport, loading, roundOffAmount, total};
}
function renderSoTotals(){
  const t = computeSoTotals();
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("so-totals-card").innerHTML = `
    ${row("Subtotal", fmtPaise(t.subtotal))}
    ${t.discountAmount>0 ? row("Total Discount", "-"+fmtPaise(t.discountAmount), "color:var(--danger);") : ""}
    ${t.transport>0 ? row("Transport", fmtPaise(t.transport)) : ""}
    ${t.loading>0 ? row("Loading", fmtPaise(t.loading)) : ""}
    ${state.so.saleType==="Interstate"
      ? row("IGST", fmtPaise(t.igst))
      : row("CGST", fmtPaise(t.cgst)) + row("SGST", fmtPaise(t.sgst))}
    ${t.roundOffAmount!==0 ? row("Round off", (t.roundOffAmount>0?"+":"")+fmtPaise(t.roundOffAmount)) : ""}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Grand Total</span><span>${fmtPaise(t.total)}</span></div>
    <div class="amount-words">${Pricing.amountInWords(t.total)}</div>
  `;
}
function soPayload(){
  return {
    customerId: state.so.customerId,
    date: document.getElementById("so-date").value || state.so.date,
    deliveryAddress: state.so.deliveryAddress, expectedDeliveryDate: state.so.expectedDeliveryDate,
    saleType: state.so.saleType,
    discountType: state.so.discountType, discountValue: state.so.discountValue,
    transport: state.so.transport, loading: state.so.loading,
    gstOnCharges: state.so.gstOnCharges, roundOff: state.so.roundOff,
    remarks: state.so.remarks,
    items: state.so.cart.map(c=>({
      productId:c.productId, sizeId:c.sizeId, name:c.name, mode:c.mode,
      lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
      pieces:c.pieces, rate:c.rate, gstRate:c.gstRate,
      discountType:c.discountType, discountValue:c.discountValue
    }))
  };
}
async function saveSo(asDraft){
  if(!state.so.cart.length){ toast("Add at least one product to the sales order."); return; }
  for(const c of state.so.cart){
    const bad = Pricing.validateLine({
      mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
      thicknessIn:c.thicknessIn, pieces:c.pieces, rate: c.rate
    }, c.name);
    if(bad){ toast(bad); return; }
  }
  const saveBtn = document.getElementById("so-save-btn");
  const draftBtn = document.getElementById("so-save-draft-btn");
  saveBtn.disabled = true; draftBtn.disabled = true;
  try{
    const payload = { ...soPayload(), saveAsDraft: !!asDraft };
    const editingId = state.so.editingSoId;
    const saved = editingId
      ? await api("PUT", `/sales-orders/${editingId}`, payload)
      : await api("POST", "/sales-orders", payload);
    resetSoState();
    renderSoEditBanner();
    await loadCustomers();
    toast(`Sales Order ${saved.so_no} ${editingId?"updated":"saved"} (${saved.status})`, "ok");
    switchTab("home");
  }catch(e){
    toast(e.message);
  }finally{
    saveBtn.disabled = false; draftBtn.disabled = false;
  }
}

/* ============================================================
   SHEET: Sales Order Detail (view + status-driven actions)
   ============================================================ */
const SO_STATUS_PILL = { Draft: "", Confirmed: "warn", Converted: "ok", Cancelled: "danger" };
async function openSoDetail(soId){
  const so = await api("GET", `/sales-orders/${soId}`);
  const sheet = document.getElementById("sheet-so-detail");
  const lineTotal = it => {
    const taxable = round2(it.qty*it.rate - it.discount_amount);
    return round2(taxable + taxable*(it.gst_rate/100));
  };
  const canEdit = so.status === "Draft";
  const canConfirm = so.status === "Draft";
  const canConvert = so.status === "Confirmed";
  const canCancel = !["Converted","Cancelled"].includes(so.status);
  const canDelete = so.status === "Draft";
  const cust = state.customers.find(c=>c.id===so.customer_id);
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(so.so_no)} <span class="pill ${SO_STATUS_PILL[so.status]||''}">${escapeHtml(so.status)}</span></div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${so.date}${so.expected_delivery_date?" · Expected "+so.expected_delivery_date:""}${cust?"<br>"+escapeHtml(cust.name):""}${so.delivery_address?"<br>"+escapeHtml(so.delivery_address):""}</div>
    <div class="card">${so.items.map(it=>`
      <div class="list-row">
        <div><div class="row-title">${escapeHtml(it.name)}</div><div class="row-sub">${escapeHtml(it.size_label||"")} · ${it.pieces} ${escapeHtml(it.unit_label||"")} × ${fmt(it.rate)}${it.discount_amount>0?" · disc. "+fmt(it.discount_amount):""}</div></div>
        <div class="row-right row-title">${fmt(lineTotal(it))}</div>
      </div>`).join("")}
    </div>
    <div class="card" style="margin-top:8px;">
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(so.subtotal)}</span></div>
      ${so.discount_amount>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Discount</span><span>-${fmt(so.discount_amount)}</span></div>`:""}
      ${so.transport>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Transport</span><span>${fmt(so.transport)}</span></div>`:""}
      ${so.loading>0?`<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Loading</span><span>${fmt(so.loading)}</span></div>`:""}
      ${so.tax_type==="IGST"
        ? `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">IGST</span><span>${fmt(so.igst)}</span></div>`
        : `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">CGST</span><span>${fmt(so.cgst)}</span></div><div class="inv-flex" style="margin-bottom:4px;"><span class="muted">SGST</span><span>${fmt(so.sgst)}</span></div>`}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(so.total)}</span></div>
    </div>
    ${so.remarks ? `<div class="card" style="margin-top:8px;font-size:12px;"><span class="muted">Remarks:</span> ${escapeHtml(so.remarks)}</div>` : ""}
    ${so.converted_invoice_id ? `<div class="muted" style="font-size:11.5px;margin-top:8px;">Converted to Tax Invoice.</div>` : ""}
    ${canConvert ? `
    <label class="field-label" style="margin-top:14px;">Sell from</label>
    <div class="chip-row" id="so-convert-location-chips">
      ${state.locations.map(l=>`<button class="chip ${l.code==='shop'?'selected':''}" data-so-convert-loc="${l.id}">${escapeHtml(l.name)}</button>`).join("")}
    </div>` : ""}
    <div class="action-row" style="margin-top:14px;">
      ${canEdit ? `<button class="btn btn-outline" id="edit-so-btn">✎ Edit</button>` : ""}
      ${canConfirm ? `<button class="btn btn-outline" id="confirm-so-btn">Confirm</button>` : ""}
      ${canConvert ? `<button class="btn btn-gold" id="convert-so-btn">Convert to Invoice</button>` : ""}
      <button class="btn btn-outline" id="print-so-btn">Print</button>
      <button class="btn btn-outline" id="share-so-btn">Share (WhatsApp)</button>
    </div>
    ${canCancel ? `<div style="margin-top:12px;text-align:center;"><a href="#" id="cancel-so-link" class="btn-danger-link">Cancel this order</a></div>` : ""}
    ${canDelete ? `<div style="margin-top:8px;text-align:center;"><a href="#" id="delete-so-link" class="btn-danger-link">Delete this draft</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  const editBtn = sheet.querySelector("#edit-so-btn");
  if(editBtn) editBtn.addEventListener("click", ()=>{ closeAllSheets(); editExistingSo(so); });
  const confirmBtn = sheet.querySelector("#confirm-so-btn");
  if(confirmBtn) confirmBtn.addEventListener("click", async ()=>{
    try{
      await api("POST", `/sales-orders/${so.id}/confirm`);
      closeAllSheets();
      toast("Sales Order confirmed.", "ok");
    }catch(err){ toast(err.message); }
  });
  sheet.querySelectorAll("[data-so-convert-loc]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-so-convert-loc]").forEach(x=>x.classList.remove("selected"));
    b.classList.add("selected");
  }));
  const convertBtn = sheet.querySelector("#convert-so-btn");
  if(convertBtn) convertBtn.addEventListener("click", async ()=>{
    const selectedLoc = sheet.querySelector("[data-so-convert-loc].selected");
    const locName = selectedLoc ? selectedLoc.textContent : "Shop";
    if(!confirm(`Convert ${so.so_no} to a real Tax Invoice? This will deduct ${locName} stock and raise the customer's due.`)) return;
    try{
      const result = await api("POST", `/sales-orders/${so.id}/convert`, {
        paymentMethod: "Cash", advance: 0,
        locationId: selectedLoc ? selectedLoc.dataset.soConvertLoc : undefined
      });
      await Promise.all([loadProducts(), loadCustomers()]);
      closeAllSheets();
      toast(`Converted to ${result.invoice.challan_no}.`, "ok");
    }catch(err){ toast(err.message); }
  });
  sheet.querySelector("#print-so-btn").addEventListener("click", ()=>printSalesOrder(so));
  sheet.querySelector("#share-so-btn").addEventListener("click", ()=>shareSoWhatsApp(so));
  const cancelLink = sheet.querySelector("#cancel-so-link");
  if(cancelLink) cancelLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm(`Cancel ${so.so_no}? This can't be undone.`)){
      try{
        await api("POST", `/sales-orders/${so.id}/cancel`);
        closeAllSheets();
        toast("Sales Order cancelled.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  const deleteLink = sheet.querySelector("#delete-so-link");
  if(deleteLink) deleteLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm(`Delete this draft permanently? This can't be undone.`)){
      try{
        await api("DELETE", `/sales-orders/${so.id}`);
        closeAllSheets();
        toast("Draft deleted.", "ok");
      }catch(err){ toast(err.message); }
    }
  });
  showSheet("sheet-so-detail");
}
function editExistingSo(so){
  state.so.cart = so.items.map(it=>{
    const product = state.products.find(x=>x.id===it.product_id);
    const sizeIdx = product ? product.sizes.findIndex(s=>s.id===it.size_id) : -1;
    return {
      productId: it.product_id, sizeId: it.size_id, sizeIdx: sizeIdx>=0 ? sizeIdx : 0,
      name: it.name, mode: it.mode, lengthFt: it.length_ft||"", widthVal: it.width_val||"",
      thicknessIn: it.thickness_in||"", pieces: it.pieces, rate: it.rate, gstRate: it.gst_rate,
      discountType: it.discount_amount>0 ? "flat" : "pct", discountValue: it.discount_amount>0 ? it.discount_amount : 0
    };
  });
  state.so.customerId = so.customer_id;
  state.so.saleType = so.sale_type;
  state.so.date = so.date;
  state.so.deliveryAddress = so.delivery_address || "";
  state.so.expectedDeliveryDate = so.expected_delivery_date || "";
  state.so.remarks = so.remarks || "";
  state.so.discountType = so.discount_type;
  state.so.discountValue = so.discount_value;
  state.so.transport = so.transport || 0;
  state.so.loading = so.loading || 0;
  state.so.gstOnCharges = !!so.gst_on_charges;
  state.so.roundOff = true;
  state.so.editingSoId = so.id;

  switchTab("so");
  renderSoScreen().then(()=>{
    const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
    set("so-date", state.so.date);
    set("so-expected-date", state.so.expectedDeliveryDate);
    set("so-delivery-address", state.so.deliveryAddress);
    set("so-remarks", state.so.remarks);
    set("so-disc-value", state.so.discountValue);
    set("so-transport-input", state.so.transport);
    set("so-loading-input", state.so.loading);
    document.querySelectorAll('[data-so-type]').forEach(x=>x.classList.toggle("selected", x.dataset.soType===state.so.saleType));
    document.querySelectorAll('[data-so-disc-type]').forEach(x=>x.classList.toggle("selected", x.dataset.soDiscType===state.so.discountType));
    document.getElementById("so-gst-on-charges-toggle").checked = state.so.gstOnCharges;
    renderSoEditBanner();
    toast(`Editing ${so.so_no} — make your changes, then save.`, "ok");
  });
}
function printSalesOrder(so){
  const cust = state.customers.find(c=>c.id===so.customer_id);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(so.so_no)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
      .totals{margin-top:10px;font-size:12px;text-align:right;}
      ${SHOP_HEADER_CSS}
    </style></head><body>
    ${printShopHeaderHtml()}
    <h1>Sales Order — ${escapeHtml(so.so_no)}</h1>
    <div class="sub">${so.date} · Status: ${escapeHtml(so.status)}${so.expected_delivery_date?" · Expected delivery "+so.expected_delivery_date:""}</div>
    <div class="sub">${cust?"To: "+escapeHtml(cust.name):""}${so.delivery_address?" · Deliver to: "+escapeHtml(so.delivery_address):""}</div>
    <table><thead><tr><th>#</th><th>Product</th><th>Size</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc.</th><th class="num">GST%</th><th class="num">Amount</th></tr></thead>
    <tbody>${so.items.map((it,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.size_label||"")}</td>
      <td class="num">${it.pieces}</td><td class="num">${fmt(it.rate)}</td><td class="num">${fmt(it.discount_amount)}</td>
      <td class="num">${it.gst_rate}%</td><td class="num">${fmt(round2(it.qty*it.rate-it.discount_amount))}</td></tr>`).join("")}</tbody></table>
    <div class="totals">
      Subtotal: ${fmt(so.subtotal)}<br>
      ${so.discount_amount>0?`Discount: -${fmt(so.discount_amount)}<br>`:""}
      ${so.transport>0?`Transport: ${fmt(so.transport)}<br>`:""}
      ${so.loading>0?`Loading: ${fmt(so.loading)}<br>`:""}
      ${so.tax_type==="IGST"?`IGST: ${fmt(so.igst)}<br>`:`CGST: ${fmt(so.cgst)}<br>SGST: ${fmt(so.sgst)}<br>`}
      <strong>Grand Total: ${fmt(so.total)}</strong>
    </div>
    ${so.remarks?`<div class="sub" style="margin-top:10px;">Remarks: ${escapeHtml(so.remarks)}</div>`:""}
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}
function shareSoWhatsApp(so){
  const cust = state.customers.find(c=>c.id===so.customer_id);
  const lines = [
    `Sales Order ${so.so_no}`,
    `Date: ${so.date}`,
    cust ? `To: ${cust.name}` : "",
    ...so.items.map(it=>`${it.name} (${it.size_label||""}) x${it.pieces} @ ${fmt(it.rate)}`),
    `Grand Total: ${fmt(so.total)}`
  ].filter(Boolean);
  openWhatsApp(cust && cust.phone, lines.join("\n"));
}

/* ============================================================
   SHEET: Sales Return — pick items/quantities off a past Tax Invoice.
   Unlike Quotation/SO/PO, this has no cart-building step of its own: every
   returnable line and its rate/GST come straight from the invoice, so the
   only inputs are "how many of each" and how the refund is settled.
   ============================================================ */
async function openSalesReturn(invoice){
  if(invoice.doc_type !== "invoice"){ toast("Returns can only be made against a Tax Invoice, not a Delivery Challan."); return; }
  const sheet = document.getElementById("sheet-sales-return");
  const cust = state.customers.find(c=>c.id===invoice.customer_id);

  // Sum pieces already returned per invoice_item, across every non-voided
  // return against this invoice — the server enforces this too, but showing
  // it up front (and capping the input) avoids a wasted round-trip.
  const priorReturns = await api("GET", `/sales-returns?invoiceId=${invoice.id}`);
  const returnedById = {};
  await Promise.all(priorReturns.filter(r=>!r.voided).map(async r=>{
    const full = await api("GET", `/sales-returns/${r.id}`);
    full.items.forEach(it=>{ returnedById[it.invoice_item_id] = (returnedById[it.invoice_item_id]||0) + it.pieces; });
  }));
  const returnableRows = invoice.items.map(it=>({
    ...it,
    alreadyReturned: returnedById[it.id] || 0
  }));

  function render(){
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">Sales Return</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">Against ${escapeHtml(invoice.challan_no)}${cust?" · "+escapeHtml(cust.name):""}</div>
      <div class="card">${returnableRows.map((it,idx)=>{
        const remaining = round2(it.pieces - it.alreadyReturned);
        return `
        <div class="list-row" style="align-items:flex-start;">
          <div style="flex:1;">
            <div class="row-title">${escapeHtml(it.name)}</div>
            <div class="row-sub">${escapeHtml(it.size_label||"")} · Sold ${it.pieces} ${escapeHtml(it.unit_label||"")} @ ${fmt(it.rate)}${it.alreadyReturned>0?` · ${it.alreadyReturned} already returned`:""}</div>
          </div>
          <div class="qty-step">
            <input type="number" inputmode="decimal" step="any" min="0" max="${remaining}"
                   value="" placeholder="0" data-sr-qty="${idx}" style="width:70px;" ${remaining<=0?"disabled":""}>
          </div>
        </div>`;
      }).join("")}</div>
      <label class="field-label" style="margin-top:12px;">Reason <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="sr-reason" placeholder="e.g. Damaged, wrong size">
      <label class="field-label" style="margin-top:10px;">Refund Method</label>
      <div class="chip-row" id="sr-refund-chips">
        <button class="chip selected" data-sr-refund="AdjustDue">Adjust Against Due</button>
        <button class="chip" data-sr-refund="Cash">Cash</button>
        <button class="chip" data-sr-refund="Bank">Bank</button>
      </div>
      <div class="card" id="sr-preview-card" style="margin-top:12px;"></div>
      <button class="btn btn-primary" id="sr-save-btn" style="margin-top:14px;width:100%;">Save Return</button>
    `;
    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-sr-qty]").forEach(inp=>inp.addEventListener("input", renderPreview));
    sheet.querySelectorAll("[data-sr-refund]").forEach(b=>b.addEventListener("click", ()=>{
      sheet.querySelectorAll("[data-sr-refund]").forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
    }));
    sheet.querySelector("#sr-save-btn").addEventListener("click", save);
    renderPreview();
  }

  function collectItems(){
    const items = [];
    sheet.querySelectorAll("[data-sr-qty]").forEach(inp=>{
      const pieces = parseFloat(inp.value) || 0;
      if(pieces > 0){
        const it = returnableRows[inp.dataset.srQty];
        // qty scales down proportionally with pieces for a partial return —
        // same per-piece rate the item actually sold at (mirrors the server's
        // computation) so an area/length-billed item's preview isn't just
        // pieces*rate (which would badly understate a Sq.ft/Rft item).
        const perPieceQty = it.pieces > 0 ? it.qty / it.pieces : 0;
        items.push({ invoiceItemId: it.id, pieces, qty: round2(perPieceQty * pieces), rate: it.rate, gstRate: it.gst_rate });
      }
    });
    return items;
  }

  function renderPreview(){
    const items = collectItems();
    const subtotal = round2(items.reduce((s,it)=>s+it.qty*it.rate,0));
    const gst = round2(items.reduce((s,it)=>s+round2(it.qty*it.rate)*(it.gstRate/100),0));
    const total = round2(subtotal + gst);
    document.getElementById("sr-preview-card").innerHTML = `
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(subtotal)}</span></div>
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">GST</span><span>${fmt(gst)}</span></div>
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Credit Total</span><span>${fmt(total)}</span></div>
    `;
  }

  async function save(){
    const items = collectItems();
    if(!items.length){ toast("Enter a quantity to return for at least one item."); return; }
    const refundMethod = sheet.querySelector("[data-sr-refund].selected").dataset.srRefund;
    const btn = sheet.querySelector("#sr-save-btn");
    btn.disabled = true;
    try{
      const saved = await api("POST", "/sales-returns", {
        invoiceId: invoice.id, reason: document.getElementById("sr-reason").value.trim(),
        refundMethod, items: items.map(it=>({ invoiceItemId: it.invoiceItemId, pieces: it.pieces }))
      });
      await Promise.all([loadProducts(), loadCustomers()]);
      closeAllSheets();
      toast(`Return ${saved.return_no} saved (${fmt(saved.total)}).`, "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  }

  render();
  showSheet("sheet-sales-return");
}
async function openSalesReturnDetail(returnId){
  const sr = await api("GET", `/sales-returns/${returnId}`);
  const sheet = document.getElementById("sheet-sales-return-detail");
  const cust = state.customers.find(c=>c.id===sr.customer_id);
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(sr.return_no)} ${sr.voided?'<span class="pill danger">Voided</span>':''}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${sr.date}${cust?" · "+escapeHtml(cust.name):""}${sr.reason?"<br>Reason: "+escapeHtml(sr.reason):""}</div>
    <div class="card">${sr.items.map(it=>`
      <div class="list-row">
        <div><div class="row-title">${escapeHtml(it.name)}</div><div class="row-sub">${escapeHtml(it.size_label||"")} · ${it.pieces} ${escapeHtml(it.unit_label||"")} @ ${fmt(it.rate)}</div></div>
        <div class="row-right row-title">${fmt(round2(it.qty*it.rate*(1+it.gst_rate/100)))}</div>
      </div>`).join("")}
    </div>
    <div class="card" style="margin-top:8px;">
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(sr.subtotal)}</span></div>
      ${sr.igst>0
        ? `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">IGST</span><span>${fmt(sr.igst)}</span></div>`
        : `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">CGST</span><span>${fmt(sr.cgst)}</span></div><div class="inv-flex" style="margin-bottom:4px;"><span class="muted">SGST</span><span>${fmt(sr.sgst)}</span></div>`}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(sr.total)}</span></div>
      <div class="muted" style="font-size:11.5px;margin-top:6px;">Refund: ${escapeHtml(sr.refund_method)}</div>
    </div>
    <button class="btn btn-outline" id="print-sales-return-btn" style="margin-top:14px;width:100%;">Print</button>
    ${!sr.voided && isOwner() ? `<div style="margin-top:14px;text-align:center;"><a href="#" id="void-sales-return-link" class="btn-danger-link">Void this return</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#print-sales-return-btn").addEventListener("click", ()=>printSalesReturn(sr));
  const voidLink = sheet.querySelector("#void-sales-return-link");
  if(voidLink) voidLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(!confirm(`Void ${sr.return_no}? Stock and the customer's due will be reversed back.`)) return;
    try{
      await api("POST", `/sales-returns/${sr.id}/void`);
      await Promise.all([loadProducts(), loadCustomers()]);
      closeAllSheets();
      toast("Return voided.", "ok");
    }catch(err){ toast(err.message); }
  });
  showSheet("sheet-sales-return-detail");
}

function printSalesReturn(sr){
  const cust = state.customers.find(c=>c.id===sr.customer_id);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sr.return_no)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
      .totals{margin-top:10px;font-size:12px;text-align:right;}
      ${SHOP_HEADER_CSS}
    </style></head><body>
    ${printShopHeaderHtml()}
    <h1>Sales Return — ${escapeHtml(sr.return_no)}</h1>
    <div class="sub">${sr.date}${sr.voided?" · VOIDED":""}${sr.invoice_challan_no?" · Against "+escapeHtml(sr.invoice_challan_no):""}</div>
    <div class="sub">${cust?"Customer: "+escapeHtml(cust.name):""}${sr.reason?" · Reason: "+escapeHtml(sr.reason):""}</div>
    <table><thead><tr><th>#</th><th>Product</th><th>Size</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST%</th><th class="num">Amount</th></tr></thead>
    <tbody>${sr.items.map((it,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.size_label||"")}</td>
      <td class="num">${it.pieces}</td><td class="num">${fmt(it.rate)}</td>
      <td class="num">${it.gst_rate}%</td><td class="num">${fmt(round2(it.qty*it.rate*(1+it.gst_rate/100)))}</td></tr>`).join("")}</tbody></table>
    <div class="totals">
      Subtotal: ${fmt(sr.subtotal)}<br>
      ${sr.igst>0?`IGST: ${fmt(sr.igst)}<br>`:`CGST: ${fmt(sr.cgst)}<br>SGST: ${fmt(sr.sgst)}<br>`}
      <strong>Credit Total: ${fmt(sr.total)}</strong><br>
      Refund Method: ${escapeHtml(sr.refund_method)}
    </div>
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}

/* ============================================================
   SHEET: Purchase Return — pick items/quantities off a past Purchase.
   Mirrors Sales Return exactly, just against a Purchase/Supplier instead
   of an Invoice/Customer, and stock/due move in the opposite direction
   (goods leave, what's owed to the supplier goes down).
   ============================================================ */
async function openPurchaseReturn(purchase){
  const sheet = document.getElementById("sheet-purchase-return");
  const supplier = state.suppliers.find(s=>s.id===purchase.supplier_id);

  const priorReturns = await api("GET", `/purchase-returns?purchaseId=${purchase.id}`);
  const returnedById = {};
  await Promise.all(priorReturns.filter(r=>!r.voided).map(async r=>{
    const full = await api("GET", `/purchase-returns/${r.id}`);
    full.items.forEach(it=>{ returnedById[it.purchase_item_id] = (returnedById[it.purchase_item_id]||0) + it.pieces; });
  }));
  const returnableRows = purchase.items.map(it=>({
    ...it,
    alreadyReturned: returnedById[it.id] || 0
  }));

  function render(){
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">Purchase Return</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">Against ${escapeHtml(purchase.purchase_no)}${supplier?" · "+escapeHtml(supplier.name):""}</div>
      <div class="card">${returnableRows.map((it,idx)=>{
        const remaining = round2(it.pieces - it.alreadyReturned);
        return `
        <div class="list-row" style="align-items:flex-start;">
          <div style="flex:1;">
            <div class="row-title">${escapeHtml(it.name)}</div>
            <div class="row-sub">${escapeHtml(it.size_label||"")} · Bought ${it.pieces} ${escapeHtml(it.unit_label||"")} @ ${fmt(it.rate)}${it.alreadyReturned>0?` · ${it.alreadyReturned} already returned`:""}</div>
          </div>
          <div class="qty-step">
            <input type="number" inputmode="decimal" step="any" min="0" max="${remaining}"
                   value="" placeholder="0" data-pr-qty="${idx}" style="width:70px;" ${remaining<=0?"disabled":""}>
          </div>
        </div>`;
      }).join("")}</div>
      <label class="field-label" style="margin-top:12px;">Reason <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="pr-reason" placeholder="e.g. Damaged, wrong size">
      <label class="field-label" style="margin-top:10px;">Refund Method</label>
      <div class="chip-row" id="pr-refund-chips">
        <button class="chip selected" data-pr-refund="AdjustDue">Adjust Against Due</button>
        <button class="chip" data-pr-refund="Cash">Cash</button>
        <button class="chip" data-pr-refund="Bank">Bank</button>
      </div>
      <div class="card" id="pr-preview-card" style="margin-top:12px;"></div>
      <button class="btn btn-primary" id="pr-save-btn" style="margin-top:14px;width:100%;">Save Return</button>
    `;
    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-pr-qty]").forEach(inp=>inp.addEventListener("input", renderPreview));
    sheet.querySelectorAll("[data-pr-refund]").forEach(b=>b.addEventListener("click", ()=>{
      sheet.querySelectorAll("[data-pr-refund]").forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
    }));
    sheet.querySelector("#pr-save-btn").addEventListener("click", save);
    renderPreview();
  }

  function collectItems(){
    const items = [];
    sheet.querySelectorAll("[data-pr-qty]").forEach(inp=>{
      const pieces = parseFloat(inp.value) || 0;
      if(pieces > 0){
        const it = returnableRows[inp.dataset.prQty];
        // qty scales down proportionally with pieces for a partial return —
        // same per-piece rate the item actually cost (mirrors the server's
        // computation) so an area/length-billed item's preview isn't just
        // pieces*rate (which would badly understate a Sq.ft/Rft item).
        const perPieceQty = it.pieces > 0 ? it.qty / it.pieces : 0;
        items.push({ purchaseItemId: it.id, pieces, qty: round2(perPieceQty * pieces), rate: it.rate, gstRate: it.gst_rate });
      }
    });
    return items;
  }

  function renderPreview(){
    const items = collectItems();
    const subtotal = round2(items.reduce((s,it)=>s+it.qty*it.rate,0));
    const gst = round2(items.reduce((s,it)=>s+round2(it.qty*it.rate)*(it.gstRate/100),0));
    const total = round2(subtotal + gst);
    document.getElementById("pr-preview-card").innerHTML = `
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(subtotal)}</span></div>
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">GST</span><span>${fmt(gst)}</span></div>
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Debit Total</span><span>${fmt(total)}</span></div>
    `;
  }

  async function save(){
    const items = collectItems();
    if(!items.length){ toast("Enter a quantity to return for at least one item."); return; }
    const refundMethod = sheet.querySelector("[data-pr-refund].selected").dataset.prRefund;
    const btn = sheet.querySelector("#pr-save-btn");
    btn.disabled = true;
    try{
      const saved = await api("POST", "/purchase-returns", {
        purchaseId: purchase.id, reason: document.getElementById("pr-reason").value.trim(),
        refundMethod, items: items.map(it=>({ purchaseItemId: it.purchaseItemId, pieces: it.pieces }))
      });
      await Promise.all([loadProducts(), loadSuppliers()]);
      closeAllSheets();
      toast(`Return ${saved.return_no} saved (${fmt(saved.total)}).`, "ok");
    }catch(err){ toast(err.message); }
    finally{ btn.disabled = false; }
  }

  render();
  showSheet("sheet-purchase-return");
}
async function openPurchaseReturnDetail(returnId){
  const pr = await api("GET", `/purchase-returns/${returnId}`);
  const sheet = document.getElementById("sheet-purchase-return-detail");
  const supplier = state.suppliers.find(s=>s.id===pr.supplier_id);
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(pr.return_no)} ${pr.voided?'<span class="pill danger">Voided</span>':''}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${pr.date}${supplier?" · "+escapeHtml(supplier.name):""}${pr.reason?"<br>Reason: "+escapeHtml(pr.reason):""}</div>
    <div class="card">${pr.items.map(it=>`
      <div class="list-row">
        <div><div class="row-title">${escapeHtml(it.name)}</div><div class="row-sub">${escapeHtml(it.size_label||"")} · ${it.pieces} ${escapeHtml(it.unit_label||"")} @ ${fmt(it.rate)}</div></div>
        <div class="row-right row-title">${fmt(round2(it.qty*it.rate*(1+it.gst_rate/100)))}</div>
      </div>`).join("")}
    </div>
    <div class="card" style="margin-top:8px;">
      <div class="inv-flex" style="margin-bottom:4px;"><span class="muted">Subtotal</span><span>${fmt(pr.subtotal)}</span></div>
      ${pr.igst>0
        ? `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">IGST</span><span>${fmt(pr.igst)}</span></div>`
        : `<div class="inv-flex" style="margin-bottom:4px;"><span class="muted">CGST</span><span>${fmt(pr.cgst)}</span></div><div class="inv-flex" style="margin-bottom:4px;"><span class="muted">SGST</span><span>${fmt(pr.sgst)}</span></div>`}
      <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;"><span>Total</span><span>${fmt(pr.total)}</span></div>
      <div class="muted" style="font-size:11.5px;margin-top:6px;">Refund: ${escapeHtml(pr.refund_method)}</div>
    </div>
    <button class="btn btn-outline" id="print-purchase-return-btn" style="margin-top:14px;width:100%;">Print</button>
    ${!pr.voided && isOwner() ? `<div style="margin-top:14px;text-align:center;"><a href="#" id="void-purchase-return-link" class="btn-danger-link">Void this return</a></div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#print-purchase-return-btn").addEventListener("click", ()=>printPurchaseReturn(pr));
  const voidLink = sheet.querySelector("#void-purchase-return-link");
  if(voidLink) voidLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(!confirm(`Void ${pr.return_no}? Stock and the supplier's due will be reversed back.`)) return;
    try{
      await api("POST", `/purchase-returns/${pr.id}/void`);
      await Promise.all([loadProducts(), loadSuppliers()]);
      closeAllSheets();
      toast("Return voided.", "ok");
    }catch(err){ toast(err.message); }
  });
  showSheet("sheet-purchase-return-detail");
}

function printPurchaseReturn(pr){
  const supplier = state.suppliers.find(s=>s.id===pr.supplier_id);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(pr.return_no)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#000;}
      h1{font-size:16px;margin:0 0 2px;} .sub{font-size:11px;color:#555;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}
      th,td{border:1px solid #000;padding:4px 6px;text-align:left;}
      th{background:#eee;} .num{text-align:right;}
      .totals{margin-top:10px;font-size:12px;text-align:right;}
      ${SHOP_HEADER_CSS}
    </style></head><body>
    ${printShopHeaderHtml()}
    <h1>Purchase Return — ${escapeHtml(pr.return_no)}</h1>
    <div class="sub">${pr.date}${pr.voided?" · VOIDED":""}${pr.purchase_no?" · Against "+escapeHtml(pr.purchase_no):""}</div>
    <div class="sub">${supplier?"Supplier: "+escapeHtml(supplier.name):""}${pr.reason?" · Reason: "+escapeHtml(pr.reason):""}</div>
    <table><thead><tr><th>#</th><th>Product</th><th>Size</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST%</th><th class="num">Amount</th></tr></thead>
    <tbody>${pr.items.map((it,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.size_label||"")}</td>
      <td class="num">${it.pieces}</td><td class="num">${fmt(it.rate)}</td>
      <td class="num">${it.gst_rate}%</td><td class="num">${fmt(round2(it.qty*it.rate*(1+it.gst_rate/100)))}</td></tr>`).join("")}</tbody></table>
    <div class="totals">
      Subtotal: ${fmt(pr.subtotal)}<br>
      ${pr.igst>0?`IGST: ${fmt(pr.igst)}<br>`:`CGST: ${fmt(pr.cgst)}<br>SGST: ${fmt(pr.sgst)}<br>`}
      <strong>Debit Total: ${fmt(pr.total)}</strong><br>
      Refund Method: ${escapeHtml(pr.refund_method)}
    </div>
    <script>window.onload=()=>window.print();</script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}

/* ============================================================
   SHEET: Transfer Stock — moves quantity for one size between two
   locations in a single server-side transaction (server/routes/transfers.js).
   ============================================================ */
function openTransferStock(p){
  const sheet = document.getElementById("sheet-transfer-stock");
  const shop = state.locations.find(l=>l.code==="shop");
  const warehouse = state.locations.find(l=>l.code==="warehouse");
  const ctx = {
    sizeId: p.sizes.length===1 ? p.sizes[0].id : null,
    fromLocationId: warehouse ? warehouse.id : (state.locations[0] && state.locations[0].id),
    toLocationId: shop ? shop.id : (state.locations[1] && state.locations[1].id),
    quantity: 1, reason: ""
  };

  function currentSize(){ return p.sizes.find(s=>s.id===ctx.sizeId); }
  function stockAt(locationId){
    const size = currentSize();
    if(!size) return 0;
    const row = (size.byLocation||[]).find(l=>l.location_id===locationId);
    return row ? row.quantity : 0;
  }

  function render(){
    const size = currentSize();
    const fromStock = stockAt(ctx.fromLocationId);
    const toStock = stockAt(ctx.toLocationId);
    const qty = Math.max(0, parseFloat(ctx.quantity)||0);

    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <button class="sheet-close" data-sheetclose>✕</button>
      <div class="sheet-title">Transfer Stock</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(p.name)}</div>

      <label class="field-label">Which size?</label>
      <div class="chip-row" id="xfr-size-chips">
        ${p.sizes.map(s=>`<button class="chip ${s.id===ctx.sizeId?'selected':''}" data-xfr-size="${s.id}">${escapeHtml(s.label)}</button>`).join("") || `<span class="muted" style="font-size:12px;">No sizes on this product.</span>`}
      </div>

      <label class="field-label">From</label>
      <div class="chip-row" id="xfr-from-chips">
        ${state.locations.map(l=>`<button class="chip ${l.id===ctx.fromLocationId?'selected':''}" data-xfr-from="${l.id}">${escapeHtml(l.name)} · ${stockAt(l.id)}${size?" "+escapeHtml(p.unit||""):""}</button>`).join("")}
      </div>

      <label class="field-label">To</label>
      <div class="chip-row" id="xfr-to-chips">
        ${state.locations.map(l=>`<button class="chip ${l.id===ctx.toLocationId?'selected':''}" data-xfr-to="${l.id}" ${l.id===ctx.fromLocationId?'disabled':''}>${escapeHtml(l.name)} · ${stockAt(l.id)}${size?" "+escapeHtml(p.unit||""):""}</button>`).join("")}
      </div>

      <label class="field-label">Quantity</label>
      <input type="number" inputmode="decimal" step="any" min="0" id="xfr-qty" value="${ctx.quantity}">

      <label class="field-label">Reason <span class="muted" style="font-weight:400;">— optional</span></label>
      <input type="text" id="xfr-reason" value="${escapeHtml(ctx.reason)}" placeholder="e.g. Restocking counter">

      ${size ? `
      <div class="line-calc" style="margin-top:10px;">
        <div class="line-calc-formula">${fromStock} &rarr; ${round2(fromStock-qty)}</div>
        <div class="line-calc-amount" style="font-size:13px;">${escapeHtml((state.locations.find(l=>l.id===ctx.fromLocationId)||{}).name||"")}</div>
      </div>
      <div class="line-calc" style="margin-top:6px;">
        <div class="line-calc-formula">${toStock} &rarr; ${round2(toStock+qty)}</div>
        <div class="line-calc-amount" style="font-size:13px;">${escapeHtml((state.locations.find(l=>l.id===ctx.toLocationId)||{}).name||"")}</div>
      </div>
      ${qty>fromStock ? `<div class="line-warn">Only ${fromStock} available at the source location.</div>` : ""}
      ` : ""}

      <button class="btn btn-primary" id="xfr-save" style="margin-top:16px;">Transfer</button>
    `;

    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-xfr-size]").forEach(b=>b.addEventListener("click", ()=>{ ctx.sizeId = Number(b.dataset.xfrSize); render(); }));
    sheet.querySelectorAll("[data-xfr-from]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.fromLocationId = b.dataset.xfrFrom;
      if(ctx.toLocationId===ctx.fromLocationId){
        const other = state.locations.find(l=>l.id!==ctx.fromLocationId);
        ctx.toLocationId = other ? other.id : ctx.toLocationId;
      }
      render();
    }));
    sheet.querySelectorAll("[data-xfr-to]").forEach(b=>{
      if(!b.disabled) b.addEventListener("click", ()=>{ ctx.toLocationId = b.dataset.xfrTo; render(); });
    });
    sheet.querySelector("#xfr-qty").addEventListener("input", (e)=>{ ctx.quantity = e.target.value; render(); });
    sheet.querySelector("#xfr-reason").addEventListener("input", (e)=>{ ctx.reason = e.target.value; });
    sheet.querySelector("#xfr-save").addEventListener("click", async ()=>{
      if(ctx.sizeId == null){ toast("Choose which size to transfer."); return; }
      if(!(qty>0)){ toast("Enter a quantity greater than zero."); return; }
      if(ctx.fromLocationId===ctx.toLocationId){ toast("Source and destination must be different."); return; }
      const btn = document.getElementById("xfr-save");
      btn.disabled = true;
      try{
        const result = await api("POST", "/transfers", {
          sizeId: ctx.sizeId, fromLocationId: ctx.fromLocationId, toLocationId: ctx.toLocationId,
          quantity: qty, reason: ctx.reason.trim()
        });
        await loadProducts();
        const refreshed = state.products.find(x=>x.id===p.id);
        if(refreshed) Object.assign(p, refreshed);
        closeAllSheets();
        openProductDetail(p.id, "inventory");
        renderInventoryList();
        const fromName = (state.locations.find(l=>l.id===ctx.fromLocationId)||{}).name || "";
        const toName = (state.locations.find(l=>l.id===ctx.toLocationId)||{}).name || "";
        toast(`Transferred ${qty} — ${fromName} → ${toName}`, "ok");
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; }
    });
  }

  render();
  showSheet("sheet-transfer-stock");
}

})();
