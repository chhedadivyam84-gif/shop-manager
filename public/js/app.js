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
  transport: 0, loading: 0, roundOff: true, docType: "invoice", challanShowRate: false, gstOnCharges: true, deliveryMan: "",
  vehicleNumber: "", deliveryAddress: "", remarks: "",
  invBrandFilter: "All", reportType: "Sales", partyMode: "customer",
  paperSize: "A5", editingInvoiceId: null,
  cbFrom: "", cbTo: "", cbEntries: [],
  // Purchase Entry (Phase 1) — a standalone cart, separate from state.cart
  // (Billing's sales cart), since a purchase invoice's line shape (per-line
  // discount, GST computed forward not backed-out, no stock cap) differs from
  // a sales line.
  pur: {
    supplierId: null, purchaseType: "Local", paymentMethod: "Credit",
    date: "", invoiceNo: "", dueDate: "", vehicleNumber: "", transportName: "", lrNumber: "", remarks: "",
    transport: 0, loading: 0, otherCharges: 0, roundOff: true, cart: []
  },
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
      <span class="ic avatar" style="width:28px;height:28px;font-size:11px;display:inline-flex;">${initials(s.name)}</span>
      ${escapeHtml(s.name)}${s.role==="owner" ? " (Owner)" : ""}
    </button>`).join("") : `<div class="empty-hint">Couldn't reach the server. Check the app is running.</div>`;
  wrap.querySelectorAll("[data-staff]").forEach(b=>{
    b.addEventListener("click", ()=>selectStaff(b.dataset.staff));
  });

  const pad = document.getElementById("pinpad");
  pad.innerHTML = "";
  ["1","2","3","4","5","6","7","8","9","","0","⌫"].forEach(k=>{
    const b = document.createElement("button");
    b.textContent = k;
    if(k===""){ b.style.visibility="hidden"; }
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
  document.getElementById("qa-payment").addEventListener("click", openQuickPayment);

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

  document.getElementById("pur-back-link").addEventListener("click", (e)=>{ e.preventDefault(); switchTab("home"); });
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

  document.getElementById("scrim").addEventListener("click", closeAllSheets);

  document.getElementById("paper-a5").addEventListener("click", ()=>setPaper("A5"));
  document.getElementById("paper-a4").addEventListener("click", ()=>setPaper("A4"));
  document.getElementById("inv-download").addEventListener("click", downloadInvoicePdf);
  document.getElementById("inv-print").addEventListener("click", ()=>window.print());
  document.getElementById("inv-whatsapp").addEventListener("click", shareWhatsApp);
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
  const subMap = {home:(isOwner()?"Owner Dashboard":"Staff Dashboard"),billing:"Create Invoice",inventory:"Inventory",customers:"Customers",reports:"Reports",cashbook:"Cash Book",purchase:"New Purchase"};
  document.getElementById("hdr-sub").textContent = subMap[tab];
  document.getElementById("hdr-main").textContent = tab==="home" ? greeting() : subMap[tab];
  if(tab==="billing") await renderBilling();
  if(tab==="inventory") await renderInventoryList();
  if(tab==="customers") await renderCustomersList();
  if(tab==="reports") await renderReport();
  if(tab==="cashbook") await renderCashBook();
  if(tab==="purchase") await renderPurchaseScreen();
}

async function renderAll(){
  await Promise.all([loadProducts(), loadCustomers(), loadSuppliers()]);
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
function renderBillingProducts(){
  const q = (document.getElementById("billing-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("billing-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    const out = p.stock<=0;
    return `<div class="list-row" data-open-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div></div>
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
  if(piecesForSize >= size.stock){ return false; }
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
  if(gstChargesRow) gstChargesRow.style.display = challan ? "none" : "flex";
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
    state.cart = []; state.selectedCustomerId = null; state.taxTypeOverride = null; state.advance = 0; state.discountValue = 0;
    state.transport = 0; state.loading = 0; state.deliveryMan = "";
    state.vehicleNumber = ""; state.deliveryAddress = ""; state.remarks = "";
    const set = (id, val) => { const inp=document.getElementById(id); if(inp) inp.value = val; };
    set("advance-input", 0); set("discount-value", 0); set("transport-input", 0); set("loading-input", 0);
    set("delivery-man-input", ""); set("vehicle-number-input", ""); set("delivery-address-input", ""); set("remarks-input", "");
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
  state.discountType = inv.discount_type || "pct";
  state.discountValue = inv.discount_value || 0;
  state.advance = 0; // the original advance was already applied at creation time
  state.paymentMethod = inv.payment_method || "Cash";
  state.paperSize = inv.paper_size || "A5";
  state.transport = inv.transport || 0;
  state.loading = inv.loading || 0;
  state.gstOnCharges = inv.gst_on_charges !== 0;
  state.deliveryMan = inv.delivery_man || "";
  state.vehicleNumber = inv.vehicle_number || "";
  state.deliveryAddress = inv.delivery_address || "";
  state.remarks = inv.remarks || "";
  state.editingInvoiceId = inv.id;

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
  let goodsTax = 0;
  lines.forEach((r,i)=>{
    const share = subtotal>0 ? (r.amount/subtotal)*discount : 0;
    const taxable = Math.max(0, r.amount-share);
    goodsTax += taxable * ((state.cart[i].gstRate||18)/100);
  });
  goodsTax = round2(goodsTax);

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
  const ancillaryTax = state.gstOnCharges ? round2((transport+loading) * effectiveRate) : 0;
  const totalTax = round2(goodsTax + ancillaryTax);

  let cgst=0, sgst=0, igst=0;
  if(taxType==="IGST") igst = totalTax; else { cgst = round2(totalTax/2); sgst = round2(totalTax-cgst); }

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
    ${row("Taxable Amount", fmtPaise(t.taxableGoods))}
    ${t.taxType==="IGST"
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
      gstOnCharges: state.gstOnCharges, deliveryMan: state.deliveryMan,
      vehicleNumber: state.vehicleNumber, deliveryAddress: state.deliveryAddress, remarks: state.remarks,
      // Only sent when staff explicitly picked a GST Type for this invoice —
      // omitted (undefined) falls back to the customer's Customer Master
      // default server-side, same as before this override existed.
      taxType: state.taxTypeOverride || undefined
    };
    const invoice = editingId
      ? await api("PUT", `/invoices/${editingId}`, payload)
      : await api("POST", "/invoices", payload);
    state.cart = []; state.advance = 0; state.discountValue = 0; state.taxTypeOverride = null;
    state.transport = 0; state.loading = 0; state.deliveryMan = "";
    state.vehicleNumber = ""; state.deliveryAddress = ""; state.remarks = "";
    state.editingInvoiceId = null;
    document.getElementById("advance-input").value = 0;
    document.getElementById("discount-value").value = 0;
    const tIn = document.getElementById("transport-input"); if(tIn) tIn.value = 0;
    const lIn = document.getElementById("loading-input"); if(lIn) lIn.value = 0;
    const dmIn = document.getElementById("delivery-man-input"); if(dmIn) dmIn.value = "";
    const vnIn = document.getElementById("vehicle-number-input"); if(vnIn) vnIn.value = "";
    const daIn = document.getElementById("delivery-address-input"); if(daIn) daIn.value = "";
    const rmIn = document.getElementById("remarks-input"); if(rmIn) rmIn.value = "";
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
async function renderInventoryList(){
  renderBrandFilter();
  const q = (document.getElementById("inv-search").value||"").toLowerCase();
  let list = state.products;
  if(state.invBrandFilter!=="All") list = list.filter(p=>p.brand===state.invBrandFilter);
  if(q) list = list.filter(p=>p.name.toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q));
  document.getElementById("product-count").textContent = list.length + " product" + (list.length!==1?"s":"");
  document.getElementById("inventory-list").innerHTML = `<div class="card">` + (list.length ? list.map(p=>{
    const priceLabel = !p.sizes.length ? "⚠ No price — tap Edit" : (p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price));
    return `<div class="list-row" data-open-inv-product="${p.id}" style="cursor:pointer;">
      <div class="swatch"></div>
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.brand||"")} · ${priceLabel}</div></div>
      <div class="row-right"><span class="pill ${stockLevel(p.stock)}">${stockLabel(p.stock)}</span></div>
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
    return `<div class="list-row" data-open-cust="${c.id}" style="cursor:pointer;">
      <div class="avatar" style="width:34px;height:34px;font-size:12px;">${initials(c.name)}</div>
      <div><div class="row-title">${escapeHtml(c.name)}</div><div class="row-sub">${escapeHtml(c.type||"")} · ${escapeHtml(c.phone||"")}</div></div>
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
    return `<div class="list-row" data-open-supplier="${s.id}" style="cursor:pointer;">
      <div class="avatar" style="width:34px;height:34px;font-size:12px;">${initials(s.name)}</div>
      <div><div class="row-title">${escapeHtml(s.name)}</div><div class="row-sub">${escapeHtml(s.phone||"")}</div></div>
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
      ${p.sizes.map((s,i)=>`<button class="chip ${i===state.ctx.selectedSizeIdx?'selected':''}" data-size="${i}">${escapeHtml(s.label)} · ${fmt(s.price)} · ${s.stock} in stock</button>`).join("")}
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
      <button class="btn btn-outline" id="stock-in-btn" style="margin-top:10px;">+ Record Stock In (Purchase)</button>
      <div class="section-title">Recent Purchases</div>
      <div class="card" id="stock-in-history"><div class="empty-hint">Loading…</div></div>
    ` : ""}

    ${context==="billing" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-invoice-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-invoice-btn" style="margin-top:14px;" ${selectedSize.stock<=0?"disabled":""}>${selectedSize.stock<=0?"Out of stock":"Add to Invoice"}</button>`
    ) : ""}
    ${context==="purchase" ? (
      !p.sizes.length
        ? `<button class="btn btn-gold" id="add-to-purchase-btn" style="margin-top:14px;" disabled>No price set — tap Edit below</button>`
        : `<button class="btn btn-gold" id="add-to-purchase-btn" style="margin-top:14px;">Add to Purchase</button>`
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
    // Every size gets its own row and its own +/- — there is no single
    // "total stock" to correct anymore, only each size's own count.
    stockArea.innerHTML = `
      <label class="field-label">Stock on hand, per size</label>
      ${p.sizes.map(s=>`
        <div class="list-row" style="padding:6px 0;">
          <div style="flex:1;font-size:12.5px;font-weight:700;">${escapeHtml(s.label)}</div>
          <div class="qty-step">
            <button data-size-dec="${s.id}">−</button>
            <input type="number" value="${s.stock}" data-size-stock-input="${s.id}" style="width:60px;">
            <button data-size-inc="${s.id}">+</button>
          </div>
        </div>`).join("") || `<div class="empty-hint">No sizes on this product.</div>`}
    `;
    stockArea.querySelectorAll("[data-size-dec]").forEach(b=>b.addEventListener("click", async ()=>{
      const updated = await api("PATCH", `/products/${p.id}/sizes/${b.dataset.sizeDec}/stock`, {delta:-1});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    }));
    stockArea.querySelectorAll("[data-size-inc]").forEach(b=>b.addEventListener("click", async ()=>{
      const updated = await api("PATCH", `/products/${p.id}/sizes/${b.dataset.sizeInc}/stock`, {delta:1});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    }));
    stockArea.querySelectorAll("[data-size-stock-input]").forEach(inp=>inp.addEventListener("change", async (e)=>{
      const updated = await api("PATCH", `/products/${p.id}/sizes/${inp.dataset.sizeStockInput}/stock`, {stock: parseInt(e.target.value)||0});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    }));
    sheet.querySelector("#stock-in-btn").addEventListener("click", ()=>openStockIn(p));
    loadStockInHistory(p.id);
  } else {
    stockArea.innerHTML = `<div class="muted" style="font-size:11.5px;">${selectedSize ? selectedSize.stock+" "+escapeHtml(p.unit||"")+" available in "+escapeHtml(selectedSize.label) : ""} · edit stock levels from Inventory</div>`;
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
      else toast("Can't add more — that's all the stock we have for this size.");
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
    let warn = "";
    try{
      const u = await api("GET", `/products/${p.id}/usage`);
      if(u.invoiceCount > 0){
        toast(`"${p.name}" can't be deleted — it's used in ${u.invoiceCount} sale line${u.invoiceCount>1?"s":""}. Products already sold are kept for record-keeping.`);
        return;
      }
      const bits = [];
      if(u.stockInCount) bits.push(`${u.stockInCount} purchase record${u.stockInCount>1?"s":""}`);
      if(u.stock > 0) bits.push(`${u.stock} still in stock`);
      if(bits.length) warn = "\n\nThis product has " + bits.join(", ") + ".";
    }catch(_){ /* fall back to the plain confirmation; server still enforces the rule */ }

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
 */
function openStockIn(p){
  const sheet = document.getElementById("sheet-stock-in");
  const ctx = {
    // Stock lands on one specific size — auto-picked when there's only one,
    // otherwise the counter staff must say which so it can't land nowhere.
    sizeId: p.sizes.length===1 ? p.sizes[0].id : null,
    mode: Pricing.normaliseMode(p.default_mode),
    lengthFt: p.length_ft || "", widthVal: p.width_val || "", thicknessIn: p.thickness_in || "",
    pieces: 1, rate: 0, gst: p.gst, transport: 0
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
      <div class="sheet-title">Record Purchase</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(p.name)} · Current stock: ${p.stock} ${escapeHtml(p.unit||"")}</div>

      <div class="charge-grid">
        <label class="dim"><span>Purchase Date</span><input type="date" id="si-date" value="${todayISO()}"></label>
        <label class="dim"><span>Invoice No.</span><input type="text" id="si-invoice" placeholder="Supplier's invoice #"></label>
      </div>
      <label class="field-label">Supplier</label>
      <input type="text" id="si-supplier" list="si-supplier-datalist" placeholder="e.g. Century Ply Distributor">
      <datalist id="si-supplier-datalist">${state.suppliers.map(s=>`<option value="${escapeHtml(s.name)}">`).join("")}</datalist>

      <label class="field-label">Which size received this stock?</label>
      <div class="chip-row" id="si-size-chips">
        ${p.sizes.map(s=>`<button class="chip ${s.id===ctx.sizeId?'selected':''}" data-si-size="${s.id}">${escapeHtml(s.label)} · ${s.stock} in stock</button>`).join("") || `<span class="muted" style="font-size:12px;">No sizes on this product yet — add one via Edit first.</span>`}
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
      <input type="text" id="si-note" placeholder="e.g. LR number, remarks">
      <button class="btn btn-primary" id="si-save" style="margin-top:16px;">Save Purchase</button>
    `;

    sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
    sheet.querySelectorAll("[data-si-size]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.sizeId = Number(b.dataset.siSize); render();
    }));
    sheet.querySelectorAll("[data-si-mode]").forEach(b=>b.addEventListener("click", ()=>{
      ctx.mode = b.dataset.siMode; render();
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
        const result = await api("POST", `/products/${p.id}/stock-in`, {
          sizeId: ctx.sizeId,
          purchaseDate: document.getElementById("si-date").value,
          invoiceNo: document.getElementById("si-invoice").value.trim(),
          supplier: document.getElementById("si-supplier").value.trim(),
          note: document.getElementById("si-note").value.trim(),
          mode: ctx.mode, lengthFt: ctx.lengthFt, widthVal: ctx.widthVal, thicknessIn: ctx.thicknessIn,
          pieces: ctx.pieces, rate: ctx.rate, gst: ctx.gst, transport: ctx.transport
        });
        Object.assign(p, result.product);
        await Promise.all([loadProducts(), loadSuppliers()]);
        closeAllSheets();
        openProductDetail(p.id, "inventory");
        renderInventoryList();
        toast(`Purchase recorded — Grand Total ${fmt(result.purchase.grand_total)}`, "ok");
      }catch(err){ toast(err.message); }
      finally{ btn.disabled = false; }
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

/* ============================================================
   SHEETS: Customer Detail
   ============================================================ */
async function openCustomerDetail(customerId){
  const detail = await api("GET", `/customers/${customerId}`);
  const sheet = document.getElementById("sheet-customer-detail");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(detail.name)}</div>
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
      <button class="btn btn-outline" id="print-ledger-btn">Print Ledger</button>
      <button class="btn btn-outline" id="export-ledger-btn">Export Excel</button>
    </div>
    <div class="section-title">Ledger</div>
    <div class="card">${detail.ledger.length ? detail.ledger.map(l=>renderPartyLedgerRow(l,"customer",detail.id)).join("") : `<div class="empty-hint">No activity yet.</div>`}</div>
    ${isOwner() ? `<div style="margin-top:16px;text-align:center;">
      <a href="#" id="delete-cust-link" class="btn-danger-link">Delete this customer</a>
    </div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#edit-cust-btn").addEventListener("click", ()=>{ closeAllSheets(); openAddCustomer(detail); });
  sheet.querySelectorAll("[data-open-invoice]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openExistingInvoice(el.dataset.openInvoice); });
  });
  const recordPaymentBtn = sheet.querySelector("#record-payment-btn");
  if(recordPaymentBtn) recordPaymentBtn.addEventListener("click", ()=>openRecordPayment(detail));
  sheet.querySelector("#print-ledger-btn").addEventListener("click", ()=>printPartyLedger(detail,"Customer"));
  sheet.querySelector("#export-ledger-btn").addEventListener("click", ()=>{
    window.open(`/api/customers/${detail.id}/ledger/export`, "_blank");
  });
  wirePartyLedgerActions(sheet, detail, "customer");
  const deleteCustLink = sheet.querySelector("#delete-cust-link");
  if(deleteCustLink) deleteCustLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm("Delete "+detail.name+"? Past invoices will show as Walk-in.")){
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
    const openAttr = isReceivable ? `data-open-invoice="${l.id}"` : "";
    return `<div class="list-row" ${openAttr} style="${isReceivable?'cursor:pointer;':''}">
      <div><div class="row-title">${escapeHtml(l.label)}</div><div class="row-sub">${l.date} · ${isReceivable?"Invoice":"Purchase"}</div></div>
      <div class="row-right"><div class="row-title" style="color:var(--danger);">+${fmt(l.amount)}</div><div class="muted" style="font-size:10.5px;">Bal ${fmt(l.runningBalance)}</div></div>
    </div>`;
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
  sheet.querySelectorAll("[data-edit-payment]").forEach(a=>{
    a.addEventListener("click", (e)=>{
      e.preventDefault();
      const entry = detail.ledger.find(l=>l.type==="payment" && String(l.id)===a.dataset.editPayment);
      if(!entry) return;
      if(partyType==="customer") openRecordPayment(detail, entry);
      else openRecordPurchasePayment(detail, entry);
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
    </style></head><body>
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
  }));
  sheet.querySelector("#rp-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("rp-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
    const btn = document.getElementById("rp-save");
    btn.disabled = true;
    try{
      const attachment = await readAttachmentInput(document.getElementById("rp-attachment"));
      const body = {
        amount, method: sheet.querySelector("[data-method].selected").dataset.method,
        date: document.getElementById("rp-date").value,
        referenceNo: document.getElementById("rp-reference").value.trim(),
        bankName: document.getElementById("rp-bank").value.trim(),
        upiId: document.getElementById("rp-upi").value.trim(),
        note: document.getElementById("rp-note").value.trim(),
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
   SHEET: Supplier Detail (ledger + Purchase Payment)
   ============================================================ */
async function openSupplierDetail(supplierId){
  const detail = await api("GET", `/suppliers/${supplierId}`);
  const sheet = document.getElementById("sheet-supplier-detail");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(detail.name)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(detail.phone||"")}${detail.gst?" · GST "+escapeHtml(detail.gst):""}${detail.state?" · "+escapeHtml(detail.state):""}${detail.address?"<br>"+escapeHtml(detail.address):""}</div>
    <div class="stat-grid">
      <div class="stat-card plain"><div class="label">Total Purchases</div><div class="value">${fmt(detail.totalPurchases)}</div></div>
      <div class="stat-card plain"><div class="label">Total Paid</div><div class="value">${fmt(detail.totalPaymentPaid)}</div></div>
      <div class="stat-card plain"><div class="label">Outstanding Due</div><div class="value red">${fmt(detail.outstandingPayable)}</div></div>
    </div>
    <div class="action-row" style="margin-top:10px;">
      <button class="btn btn-outline" id="edit-supplier-btn">✎ Edit</button>
      ${detail.due>0 ? `<button class="btn btn-gold" id="record-purchase-payment-btn">Purchase Payment</button>` : ""}
      <button class="btn btn-outline" id="print-ledger-btn">Print Ledger</button>
      <button class="btn btn-outline" id="export-ledger-btn">Export Excel</button>
    </div>
    <div class="section-title">Ledger</div>
    <div class="card">${detail.ledger.length ? detail.ledger.map(l=>renderPartyLedgerRow(l,"supplier",detail.id)).join("") : `<div class="empty-hint">No activity yet.</div>`}</div>
    ${isOwner() ? `<div style="margin-top:16px;text-align:center;">
      <a href="#" id="delete-supplier-link" class="btn-danger-link">Delete this supplier</a>
    </div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#edit-supplier-btn").addEventListener("click", ()=>{ closeAllSheets(); openAddSupplier(detail); });
  const recordPaymentBtn = sheet.querySelector("#record-purchase-payment-btn");
  if(recordPaymentBtn) recordPaymentBtn.addEventListener("click", ()=>openRecordPurchasePayment(detail));
  sheet.querySelector("#print-ledger-btn").addEventListener("click", ()=>printPartyLedger(detail,"Supplier"));
  sheet.querySelector("#export-ledger-btn").addEventListener("click", ()=>{
    window.open(`/api/suppliers/${detail.id}/ledger/export`, "_blank");
  });
  wirePartyLedgerActions(sheet, detail, "supplier");
  const deleteSupplierLink = sheet.querySelector("#delete-supplier-link");
  if(deleteSupplierLink) deleteSupplierLink.addEventListener("click", async (e)=>{
    e.preventDefault();
    if(confirm("Delete "+detail.name+"? Past purchases will keep the supplier's name as text only.")){
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
  }));
  sheet.querySelector("#pp-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("pp-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
    const btn = document.getElementById("pp-save");
    btn.disabled = true;
    try{
      const attachment = await readAttachmentInput(document.getElementById("pp-attachment"));
      const body = {
        amount, method: sheet.querySelector("[data-method].selected").dataset.method,
        date: document.getElementById("pp-date").value,
        referenceNo: document.getElementById("pp-reference").value.trim(),
        bankName: document.getElementById("pp-bank").value.trim(),
        upiId: document.getElementById("pp-upi").value.trim(),
        note: document.getElementById("pp-note").value.trim(),
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
    <button class="btn btn-primary" id="ns-save" style="margin-top:16px;">${editing?"Update Supplier":"Save Supplier"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-gsttype]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-gsttype]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#ns-save").addEventListener("click", async ()=>{
    const name = document.getElementById("ns-name").value.trim();
    if(!name){ toast("Supplier name is required."); return; }
    const payload = {
      name, phone: document.getElementById("ns-phone").value.trim(),
      address: document.getElementById("ns-address").value.trim(),
      gst: document.getElementById("ns-gst").value.trim(),
      state: document.getElementById("ns-state").value || state.settings.state,
      gstType: sheet.querySelector("[data-gsttype].selected").dataset.gsttype
    };
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
    <button class="btn btn-primary" id="nc-save" style="margin-top:16px;">${editing?"Update Customer":"Save Customer"}</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-type]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelectorAll("[data-gsttype]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-gsttype]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#nc-save").addEventListener("click", async ()=>{
    const name = document.getElementById("nc-name").value.trim();
    const phone = document.getElementById("nc-phone").value.trim();
    if(!name || !phone){ toast("Name and phone are required."); return; }
    const payload = {
      name, type: sheet.querySelector("[data-type].selected").dataset.type, phone,
      address: document.getElementById("nc-address").value.trim(),
      gst: document.getElementById("nc-gst").value.trim(),
      state: document.getElementById("nc-state").value || state.settings.state,
      gstType: sheet.querySelector("[data-gsttype].selected").dataset.gsttype,
      creditLimit: parseFloat(document.getElementById("nc-credit").value)||0
    };
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
  const toggle = document.getElementById("challan-rate-toggle");
  if(toggleRow) toggleRow.style.display = challan ? "flex" : "none";
  if(toggle){
    toggle.checked = false;
    state.challanShowRate = false;
    toggle.onchange = () => { state.challanShowRate = toggle.checked; renderInvoicePageContent(); };
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
["inv-edit", "inv-void", "inv-delete"].forEach(id => { const el = document.getElementById(id); if(el) el.remove(); });
  if(existingInvoice && existingInvoice.id && !existingInvoice.voided){
    const actionsBar = document.querySelector(".inv-actions");
    const editBtn = document.createElement("button");
    editBtn.id = "inv-edit"; editBtn.textContent = "✎ Edit";
    editBtn.onclick = ()=>{ closeFullscreen("fs-invoice"); editExistingInvoice(existingInvoice); };
    actionsBar.appendChild(editBtn);
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

  // A challan hides Rate/GST%/Amount by default (it carries no GST invoice
  // meaning) but can show them on this printout via the "Show Rate" toggle —
  // "Delivery Challan (With Rate)" vs "(Without Rate)" from the same entry.
  const showRate = !challan || state.challanShowRate;
  const head = `<th class="c-sn">Sr No.</th><th>Product Description</th><th class="c-size">Size</th><th class="c-unit">Unit</th><th class="c-num">Qty</th>${showRate ? `<th class="c-num">Rate</th><th class="c-num c-amt">Amount</th>` : ""}`;
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
    return `<tr>${base}${showRate ? `<td class="c-num">${fmtPaise(it.rate).replace("Rs. ","")}</td><td class="c-num c-amt">${fmtPaise(it.qty*it.rate)}</td>` : ""}</tr>`;
  }).join("");
  // Total Quantity is the physical piece count across all items, not the
  // billed area/length sum — matching what gets counted at load/unload,
  // and staying meaningful even when items mix billing units (Sq.ft +
  // Rft + Unit can't be summed together, but pieces always can).
  const totalQtyForFoot = round2(inv.items.reduce((s,it)=>s+(Number(it.pieces)||0),0));
  const tfoot = `<tfoot><tr>
    <td colspan="4" style="text-align:right;">Total Quantity</td>
    <td class="c-num">${totalQtyForFoot}</td>
    <td colspan="${showRate?3:1}"></td>
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
  const cgst = challan ? 0 : (inv.cgst || 0), sgst = challan ? 0 : (inv.sgst || 0), igst = challan ? 0 : (inv.igst || 0);
  const isIGST = !challan && inv.tax_type === "IGST";
  // Effective rate shown next to the CGST/SGST/IGST label — derived from the
  // actual stored tax and taxable value (works for a mixed-rate bill too,
  // since it's a weighted average, not any single item's GST%), not hardcoded.
  const taxableGoods = Math.max(0, (inv.subtotal||0) - (inv.discount_amount||0));
  const effectiveRatePct = taxableGoods > 0 ? Math.round(((cgst+sgst+igst) / taxableGoods) * 100) : 0;
  const halfRatePct = Math.round(effectiveRatePct / 2);

  const totalsBox = `<div class="erp-totals-box">
    <div class="erp-tb-row"><span>Subtotal</span><span>${fmtPaise(challan?challanSubtotal:inv.subtotal)}</span></div>
    <div class="erp-tb-row"><span>Discount</span><span>${discountAmt>0?"-":""}${fmtPaise(discountAmt)}</span></div>
    <div class="erp-tb-row"><span>Transport</span><span>${fmtPaise(inv.transport)}</span></div>
    ${inv.loading ? `<div class="erp-tb-row"><span>Additional Charges</span><span>${fmtPaise(inv.loading)}</span></div>` : ""}
    ${!challan ? `<div class="erp-tb-row"><span>Taxable Amount</span><span>${fmtPaise(taxableGoods)}</span></div>` : ""}
    ${isIGST
      ? `<div class="erp-tb-row"><span>IGST ${effectiveRatePct}%</span><span>${fmtPaise(igst)}</span></div>`
      : `<div class="erp-tb-row"><span>CGST ${halfRatePct}%</span><span>${fmtPaise(cgst)}</span></div><div class="erp-tb-row"><span>SGST ${halfRatePct}%</span><span>${fmtPaise(sgst)}</span></div>`}
    ${!challan && inv.round_off ? `<div class="erp-tb-row"><span>Round Off</span><span>${inv.round_off>0?"+":""}${fmtPaise(inv.round_off)}</span></div>` : ""}
    <div class="erp-tb-row erp-tb-grand"><span>Grand Total</span><span>${fmtPaise(displayTotal)}</span></div>
    ${!challan && inv.advance>0 ? `<div class="erp-tb-row"><span>Advance Paid</span><span>-${fmtPaise(inv.advance)}</span></div>
    <div class="erp-tb-row" style="font-weight:800;"><span>Balance Due</span><span>${fmtPaise(inv.balance_due)}</span></div>` : ""}
  </div>`;

  const deliveryAddr = inv.delivery_address || (cust && cust.address) || "";
  const bottomLeft = `<div class="erp-bottom-left">
    ${deliveryAddr ? `<div><b>Delivery Address:</b> ${escapeHtml(deliveryAddr)}</div>` : ""}
    ${inv.remarks ? `<div><b>Remarks:</b> ${escapeHtml(inv.remarks)}</div>` : ""}
    <div><b>Amount in Words:</b> ${Pricing.amountInWords(displayTotal)}</div>
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

    <div class="erp-sign-row">
      <span>Receiver Signature</span>
      <span class="erp-stamp-box">Company Stamp</span>
      <span>For ${escapeHtml(cfg.business_name)}<br>Authorised Signatory</span>
    </div>

    <div class="erp-terms">${challan
      ? `<strong>PLYWOOD, BLACKBOARD, ARE MANUFACTURED FROM NATURAL WOOD WHICH IS BELOW BIO DEGRADEBLE, WE DONOT GUARANTEE AGAINST ANY NATURAL DECAY DEFICIENTY, DETORATION AND LIKE INCLUDING MANUFACTURING DEFACT AND/OR IMPERFACT QUALITY</strong>`
      : `<strong>NO GURANTEE AND WARRANTY FOR DECORATIVE PRODUCTS AND AIR BUBBLES IN LAMMINATES, ACRYLIC AND PVC LAMINATES OR ANY SHADE VARIATION AFTER INSTALLATION. NO EXCHANGE. NO RETURN IN ANY CONDITION. PLEASE CHECK THE MATERIAL ON DELIVERY.</strong>`}</div>
  `;
}
async function downloadInvoicePdf(){
  const btn = document.getElementById("inv-download");
  const originalText = btn.textContent;
  btn.textContent = "⏳ Preparing...";
  btn.disabled = true;
  try{
    if(typeof html2canvas === "undefined" || typeof window.jspdf === "undefined"){
      throw new Error("PDF libraries not loaded");
    }
    const node = document.getElementById("invoice-page-content");
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
        #invoice-page-content{border-radius:0 !important;box-shadow:none !important;border:1.5px solid #333 !important;}`;
        clonedDoc.head.appendChild(style);
      }
    });
    const { jsPDF } = window.jspdf;
    const isA4 = state.paperSize==="A4";
    const pdf = new jsPDF({unit:"mm", format: isA4 ? "a4" : "a5"});
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
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

function shareWhatsApp(){
  const inv = lastPreviewInvoice; if(!inv) return;
  const cust = state.customers.find(c=>c.id===inv.customer_id);
  const challan = inv.doc_type === "challan";
  const totalPieces = inv.items.reduce((s,it)=>s+(Number(it.pieces)||0),0);
  const text = challan
    ? `Delivery Challan ${inv.challan_no}\nDate: ${inv.date}\nTo: ${cust?cust.name:"Walk-in"}\nItems: ${inv.items.length} · ${totalPieces} pcs`
    : `Invoice ${inv.challan_no}\nDate: ${inv.date}\nCustomer: ${cust?cust.name:"Walk-in"}\nTotal: ${fmt(inv.total)}${inv.balance_due>0?`\nBalance Due: ${fmt(inv.balance_due)}`:""}`;
  const phone = cust && cust.phone ? cust.phone.replace(/\D/g,"") : "";
  const url = "https://wa.me/" + (phone?("91"+phone):"") + "?text=" + encodeURIComponent(text);
  window.open(url, "_blank");
}

/* ============================================================
   REPORTS
   ============================================================ */
async function renderReport(){
  const body = document.getElementById("report-body");
  try{
    if(state.reportType==="Purchase") return renderPurchaseReport(body);
    if(state.reportType==="Party") return renderPartyReport(body);
    if(state.reportType==="Profit") return renderProfitReport(body);
    if(state.reportType==="Supplier") return renderSupplierReport(body);
    if(state.reportType==="SalePayments") return renderSalePaymentsReport(body);
    if(state.reportType==="PurchasePayments") return renderPurchasePaymentsReport(body);

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
      </div><div class="row-right row-title" style="color:var(--ok);">${fmt(r.amount)}</div></div>
    `).join("") : `<div class="empty-hint">No payments recorded yet.</div>`);
}

async function renderPurchasePaymentsReport(body){
  const rows = await api("GET","/reports/purchase-payments");
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">Purchase Payments</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">Payments made to suppliers, newest first</div>` +
    (rows.length ? rows.map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.supplier_name)}</div>
        <div class="row-sub">${escapeHtml(r.payment_date||"")} · ${escapeHtml(r.method)}${r.reference_no?" · Ref# "+escapeHtml(r.reference_no):""}${r.note?" · "+escapeHtml(r.note):""}</div>
      </div><div class="row-right row-title" style="color:var(--danger);">${fmt(r.amount)}</div></div>
    `).join("") : `<div class="empty-hint">No payments recorded yet.</div>`);
}

async function renderProfitReport(body){
  const d = await api("GET","/reports/profit");
  const missingCost = d.rows.some(r=>!r.hasCost && r.pieces>0);
  body.innerHTML = `
    <div style="font-weight:800;font-size:14px;">Profit Report</div>
    <div class="muted" style="font-size:11.5px;margin-bottom:10px;">Revenue minus each product's latest recorded purchase cost</div>
    <div class="stat-grid" style="margin-bottom:12px;">
      <div class="stat-card plain"><div class="label">Revenue</div><div class="value">${fmt(d.totalRevenue)}</div></div>
      <div class="stat-card plain"><div class="label">Cost</div><div class="value">${fmt(d.totalCost)}</div></div>
      <div class="stat-card navy"><div class="label">Profit</div><div class="value">${fmt(d.totalProfit)}</div></div>
    </div>
    ${missingCost ? `<div class="muted" style="font-size:11px;margin-bottom:8px;">⚠ Some items sold have no purchase on file, so their cost is counted as ₹0 — record a Purchase entry for accurate profit.</div>` : ""}
    ${d.rows.length ? d.rows.slice(0,50).map(r=>`
      <div class="list-row"><div>
        <div class="row-title">${escapeHtml(r.name)}${!r.hasCost&&r.pieces>0?' <span class="pill warn">no cost on file</span>':""}</div>
        <div class="row-sub">${r.date} · ${escapeHtml(r.challan_no)} · Revenue ${fmt(r.revenue)} − Cost ${fmt(r.cost)}</div>
      </div><div class="row-right row-title" style="color:${r.profit>=0?'var(--ok)':'var(--danger)'};">${fmt(r.profit)}</div></div>
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
   PURCHASE ENTRY (Phase 1 — core multi-line invoice)
   ============================================================ */
async function renderPurchaseScreen(){
  if(!state.pur.date) state.pur.date = todayISO();
  const dateEl = document.getElementById("pur-date");
  if(dateEl && !dateEl.value) dateEl.value = state.pur.date;
  renderPurchaseSuppliers();
  renderPurchaseSupplierInfo();
  renderPurchaseProducts();
  renderPurchaseCart();
  renderPurchaseDueDateVisibility();
  renderPurchaseTotals();
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
  if(row) row.style.display = state.pur.paymentMethod === "Credit" ? "block" : "none";
}
/* Mirrors computeTotals() in server/routes/purchases.js exactly, including
   the order of rounding — the preview must match what the server will store. */
function computePurchaseTotals(){
  const lines = state.pur.cart.map(purchaseLineCalc);
  const subtotal = round2(lines.reduce((s,r)=>s+r.amount,0));
  const discountAmount = round2(lines.reduce((s,r)=>s+r.discountAmount,0));
  const goodsTax = round2(lines.reduce((s,r)=>s+r.gstAmt,0));

  const transport = round2(Math.max(0, state.pur.transport||0));
  const loading = round2(Math.max(0, state.pur.loading||0));
  const otherCharges = round2(Math.max(0, state.pur.otherCharges||0));

  let cgst=0, sgst=0, igst=0;
  if(state.pur.purchaseType==="Interstate") igst = goodsTax;
  else { cgst = round2(goodsTax/2); sgst = round2(goodsTax-cgst); }

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
    ${state.pur.purchaseType==="Interstate"
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
      // Only the raw inputs are sent — the server recomputes every derived
      // figure itself, same principle as completeSale() on the Billing side.
      items: state.pur.cart.map(c=>({
        productId:c.productId, sizeId:c.sizeId, name:c.name, mode:c.mode,
        lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
        pieces:c.pieces, rate:c.rate, gstRate:c.gstRate,
        discountType:c.discountType, discountValue:c.discountValue
      }))
    };
    const saved = await api("POST", "/purchases", payload);
    state.pur = {
      supplierId: null, purchaseType: "Local", paymentMethod: "Credit",
      date: "", invoiceNo: "", dueDate: "", vehicleNumber: "", transportName: "", lrNumber: "", remarks: "",
      transport: 0, loading: 0, otherCharges: 0, roundOff: true, cart: []
    };
    const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
    set("pur-invoice-no", ""); set("pur-due-date", ""); set("pur-vehicle", "");
    set("pur-transport-name", ""); set("pur-lr", ""); set("pur-remarks", "");
    set("pur-transport-input", 0); set("pur-loading-input", 0); set("pur-other-input", 0);
    document.querySelectorAll('[data-pur-type]').forEach(x=>x.classList.toggle("selected", x.dataset.purType==="Local"));
    document.querySelectorAll('[data-pur-pay]').forEach(x=>x.classList.toggle("selected", x.dataset.purPay==="Credit"));
    await Promise.all([loadProducts(), loadSuppliers()]);
    await renderHome();
    toast(`Purchase ${saved.purchase_no} saved — Grand Total ${fmt(saved.total)}`, "ok");
    switchTab("home");
  }catch(e){
    toast(e.message);
  }finally{
    btn.disabled = false;
  }
}

})();
