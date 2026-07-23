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
  products: [], customers: [], invoices: [], settings: null, dashboard: null,
  cart: [], selectedCustomerId: null,
  discountType: "pct", discountValue: 0, advance: 0, paymentMethod: "Cash",
  transport: 0, loading: 0, roundOff: true,
  invBrandFilter: "All", reportType: "Sales",
  paperSize: "A5",
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

  document.querySelectorAll("[data-close-fs]").forEach(b=>{
    b.addEventListener("click", ()=>closeFullscreen(b.dataset.closeFs));
  });

  document.getElementById("billing-search").addEventListener("input", renderBillingProducts);
  document.querySelectorAll('[data-disc]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.discountType = b.dataset.disc;
      document.querySelectorAll('[data-disc]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
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
  document.querySelectorAll('[data-pay]').forEach(b=>{
    b.addEventListener("click", ()=>{
      state.paymentMethod = b.dataset.pay;
      document.querySelectorAll('[data-pay]').forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
    });
  });
  document.getElementById("complete-sale-btn").addEventListener("click", completeSale);
  document.getElementById("preview-invoice-btn").addEventListener("click", ()=>openInvoicePreview(null));

  document.getElementById("inv-search").addEventListener("input", renderInventoryList);
  document.getElementById("inv-add-btn").addEventListener("click", ()=>openAddProduct("inventory"));

  document.getElementById("cust-search").addEventListener("input", renderCustomersList);
  document.getElementById("cust-add-btn").addEventListener("click", openAddCustomer);

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

  document.getElementById("scrim").addEventListener("click", closeAllSheets);

  document.getElementById("paper-a5").addEventListener("click", ()=>setPaper("A5"));
  document.getElementById("paper-a4").addEventListener("click", ()=>setPaper("A4"));
  document.getElementById("inv-download").addEventListener("click", downloadInvoicePdf);
  document.getElementById("inv-print").addEventListener("click", ()=>window.print());
  document.getElementById("inv-whatsapp").addEventListener("click", shareWhatsApp);

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
  const subMap = {home:(isOwner()?"Owner Dashboard":"Staff Dashboard"),billing:"Create Invoice",inventory:"Inventory",customers:"Customers",reports:"Reports"};
  document.getElementById("hdr-sub").textContent = subMap[tab];
  document.getElementById("hdr-main").textContent = tab==="home" ? greeting() : subMap[tab];
  if(tab==="billing") await renderBilling();
  if(tab==="inventory") await renderInventoryList();
  if(tab==="customers") await renderCustomersList();
  if(tab==="reports") await renderReport();
}

async function renderAll(){
  await Promise.all([loadProducts(), loadCustomers()]);
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
    const status = inv.balance_due<=0 ? "Paid" : (inv.advance>0 ? "Partial":"Due");
    const cls = status==="Paid"?"ok":status==="Partial"?"warn":"danger";
    return `<div class="list-row" data-open-invoice="${inv.id}" style="cursor:pointer;"><div><div class="row-title">${inv.challan_no}</div><div class="row-sub">${escapeHtml(inv.customer_name||"Walk-in")} · ${inv.date}</div></div>
    <div class="row-right"><div class="row-title">${fmt(inv.total)}</div><span class="pill ${cls}">${status}</span></div></div>`;
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
  renderCart();
  renderTotals();
}
function renderBillingCustomers(){
  const wrap = document.getElementById("billing-customers");
  wrap.innerHTML = `<button class="chip ${!state.selectedCustomerId?'selected':''}" data-cust="">Walk-in</button>` + state.customers.map(c=>`
    <button class="chip ${state.selectedCustomerId===c.id?'selected':''}" data-cust="${c.id}">${escapeHtml(c.name)}</button>
  `).join("");
  wrap.querySelectorAll("[data-cust]").forEach(b=>{
    b.addEventListener("click", ()=>{ state.selectedCustomerId=b.dataset.cust||null; renderBillingCustomers(); renderTotals(); });
  });
}
function renderBillingProducts(){
  const q = (document.getElementById("billing-search").value||"").toLowerCase();
  const list = state.products.filter(p=>
    !q || p.name.toLowerCase().includes(q) || (p.brand||"").toLowerCase().includes(q) || (p.sku||"").toLowerCase().includes(q)
  );
  const wrap = document.getElementById("billing-product-list");
  wrap.innerHTML = list.map(p=>{
    const priceLabel = p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price);
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
  const size = p.sizes[sizeIdx];
  const existing = state.cart.find(c=>c.productId===productId && c.sizeIdx===sizeIdx);
  const piecesForProduct = state.cart.filter(c=>c.productId===productId).reduce((s,c)=>s+(c.pieces||0),0);
  if(piecesForProduct >= p.stock){ return false; }
  if(existing){ existing.pieces += 1; }
  else{
    state.cart.push({
      productId, sizeIdx,
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
    c.gstRate = p.gst;
    return true;
  });
  if(state.cart.length !== before){
    toast("Removed "+(before-state.cart.length)+" bill line(s) — that product was deleted.");
  }
  renderCart(); renderTotals();
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
    const stock = (state.products.find(p=>p.id===c.productId)||{}).stock;

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
        ${m.needsWidth ? dim("Width", m.widthUnit, "widthVal", c.widthVal) : ""}
        ${m.needsLength ? dim("Length", m.lengthUnit, "lengthFt", c.lengthFt) : ""}
        ${dim("Qty", "pcs", "pieces", c.pieces)}
        ${dim("Rate", "₹/"+m.unit, "rate", c.rate)}
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
    `<strong>${Pricing.formatQty(r.billedQty, r.mode)}</strong> × ${Pricing.formatRate(r.rate, r.mode)}`;
  if(a) a.textContent = fmtPaise(r.amount);
}
function currentTaxType(){
  const cust = state.customers.find(c=>c.id===state.selectedCustomerId);
  const shopState = (state.settings.state||"").trim().toLowerCase();
  const custState = (cust && cust.state || "").trim().toLowerCase();
  if(custState && shopState && custState !== shopState) return "IGST";
  return "CGST_SGST";
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
  let totalTax = 0;
  lines.forEach((r,i)=>{
    const share = subtotal>0 ? (r.amount/subtotal)*discount : 0;
    const taxable = Math.max(0, r.amount-share);
    totalTax += taxable * ((state.cart[i].gstRate||18)/100);
  });
  totalTax = round2(totalTax);

  let cgst=0, sgst=0, igst=0;
  if(taxType==="IGST") igst = totalTax; else { cgst = round2(totalTax/2); sgst = round2(totalTax-cgst); }

  // Freight and labour sit outside the taxable value — added after GST.
  const transport = round2(Math.max(0, state.transport||0));
  const loading = round2(Math.max(0, state.loading||0));

  const preRound = subtotal - discount + cgst + sgst + igst + transport + loading;
  const total = round2(state.roundOff ? Math.round(preRound) : preRound);
  const roundOffAmount = round2(total - preRound);

  const advance = round2(Math.min(Math.max(0,state.advance||0), total));
  const balanceDue = round2(total - advance);

  return {subtotal, discount, taxType, cgst, sgst, igst, transport, loading,
          roundOffAmount, total, advance, balanceDue};
}
function renderTotals(){
  const t = computeTotals();
  const row = (label, value, cls) =>
    `<div class="inv-flex" style="margin-bottom:4px;${cls||""}"><span class="muted">${label}</span><span>${value}</span></div>`;
  document.getElementById("totals-card").innerHTML = `
    ${row("Subtotal", fmtPaise(t.subtotal))}
    ${t.discount>0 ? row("Discount", "-"+fmtPaise(t.discount), "color:var(--danger);") : ""}
    ${t.taxType==="IGST"
      ? row("IGST", fmtPaise(t.igst))
      : row("CGST", fmtPaise(t.cgst)) + row("SGST", fmtPaise(t.sgst))}
    ${t.transport>0 ? row("Transport", fmtPaise(t.transport)) : ""}
    ${t.loading>0 ? row("Loading", fmtPaise(t.loading)) : ""}
    ${t.roundOffAmount!==0 ? row("Round off", (t.roundOffAmount>0?"+":"")+fmtPaise(t.roundOffAmount)) : ""}
    <div class="inv-flex" style="font-weight:800;border-top:1px solid var(--border);padding-top:6px;font-size:15px;"><span>Grand Total</span><span>${fmtPaise(t.total)}</span></div>
    <div class="amount-words">${Pricing.amountInWords(t.total)}</div>
    ${t.advance>0?`<div class="inv-flex" style="margin-top:4px;color:var(--ok);"><span>Advance paid</span><span>-${fmtPaise(t.advance)}</span></div>
    <div class="inv-flex" style="font-weight:800;color:var(--danger);"><span>Balance due</span><span>${fmtPaise(t.balanceDue)}</span></div>`:""}
  `;
}
async function completeSale(){
  if(!state.cart.length){ toast("Add at least one item to the invoice first."); return; }
  // Catch bad lines here so the user gets the message next to the field rather
  // than as a server rejection after the fact.
  for(const c of state.cart){
    const bad = Pricing.validateLine({
      mode:c.mode, lengthFt:c.lengthFt, widthVal:c.widthVal,
      thicknessIn:c.thicknessIn, pieces:c.pieces, rate:c.rate
    }, c.name);
    if(bad){ toast(bad); return; }
  }
  const btn = document.getElementById("complete-sale-btn");
  btn.disabled = true;
  try{
    const invoice = await api("POST","/invoices", {
      customerId: state.selectedCustomerId,
      // Only the raw inputs are sent — the server recomputes every derived
      // figure itself, so a tampered client cannot invent a billed quantity.
      items: state.cart.map(c=>({
        productId:c.productId, name:c.name, mode:c.mode,
        lengthFt:c.lengthFt, widthVal:c.widthVal, thicknessIn:c.thicknessIn,
        pieces:c.pieces, rate:c.rate
      })),
      discountType: state.discountType, discountValue: state.discountValue,
      advance: state.advance, paymentMethod: state.paymentMethod, paperSize: state.paperSize,
      transport: state.transport, loading: state.loading, roundOff: state.roundOff
    });
    state.cart = []; state.advance = 0; state.discountValue = 0;
    state.transport = 0; state.loading = 0;
    document.getElementById("advance-input").value = 0;
    document.getElementById("discount-value").value = 0;
    const tIn = document.getElementById("transport-input"); if(tIn) tIn.value = 0;
    const lIn = document.getElementById("loading-input"); if(lIn) lIn.value = 0;
    await Promise.all([loadProducts(), loadCustomers()]);
    await renderBilling(); await renderHome();
    toast("Sale completed! Challan "+invoice.challan_no, "ok");
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
    const priceLabel = p.sizes.length>1 ? "From "+fmt(Math.min(...p.sizes.map(s=>s.price))) : fmt(p.sizes[0].price);
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
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">${escapeHtml(p.name)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px;">${escapeHtml(p.brand||"")} · ${escapeHtml(p.category||"")}</div>
    <span class="pill ${stockLevel(p.stock)}">${stockLabel(p.stock)}</span>

    <div class="chip-row" style="margin:12px 0;">
      ${p.sizes.map((s,i)=>`<button class="chip ${i===state.ctx.selectedSizeIdx?'selected':''}" data-size="${i}">${escapeHtml(s.label)} · ${fmt(s.price)}</button>`).join("")}
    </div>

    <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11.5px;">
      <div><span class="muted">SKU</span><br>${escapeHtml(p.sku||"")}</div>
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

    ${context==="billing" ? `<button class="btn btn-gold" id="add-to-invoice-btn" style="margin-top:14px;" ${p.stock<=0?"disabled":""}>${p.stock<=0?"Out of stock":"Add to Invoice"}</button>` : ""}

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
    stockArea.innerHTML = `
      <label class="field-label">Stock on hand (${escapeHtml(p.unit||"")})</label>
      <div class="qty-step">
        <button id="stock-dec">−</button>
        <input type="number" id="stock-input" value="${p.stock}" style="width:70px;">
        <button id="stock-inc">+</button>
      </div>`;
    stockArea.querySelector("#stock-dec").addEventListener("click", async ()=>{
      const updated = await api("PATCH", `/products/${p.id}/stock`, {delta:-1});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    });
    stockArea.querySelector("#stock-inc").addEventListener("click", async ()=>{
      const updated = await api("PATCH", `/products/${p.id}/stock`, {delta:1});
      Object.assign(p, updated); renderProductDetailSheet(context); renderInventoryList();
    });
    stockArea.querySelector("#stock-input").addEventListener("change", async (e)=>{
      const updated = await api("PATCH", `/products/${p.id}/stock`, {stock: parseInt(e.target.value)||0});
      Object.assign(p, updated); renderInventoryList();
    });
    sheet.querySelector("#stock-in-btn").addEventListener("click", ()=>openStockIn(p));
    loadStockInHistory(p.id);
  } else {
    stockArea.innerHTML = `<div class="muted" style="font-size:11.5px;">${p.stock} ${escapeHtml(p.unit||"")} available · edit stock levels from Inventory</div>`;
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
      else toast("Can't add more — that's all the stock we have.");
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
    // state the actual consequence instead of a generic warning.
    let warn = "";
    try{
      const u = await api("GET", `/products/${p.id}/usage`);
      const bits = [];
      if(u.invoiceCount) bits.push(`${u.invoiceCount} invoice${u.invoiceCount>1?"s":""}`);
      if(u.stockInCount) bits.push(`${u.stockInCount} purchase record${u.stockInCount>1?"s":""}`);
      if(u.stock > 0) bits.push(`${u.stock} still in stock`);
      if(bits.length) warn = "\n\nThis product appears on " + bits.join(", ") +
        ".\nPast invoices keep their own copy of the name and price, so they will still print correctly.";
    }catch(_){ /* fall back to the plain confirmation */ }

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
      return `<div class="list-row"><div><div class="row-title">+${r.qty} received${r.supplier?" from "+escapeHtml(r.supplier):""}</div><div class="row-sub">${dt.toLocaleDateString("en-IN")}${r.cost_price?" · Cost "+fmt(r.cost_price)+" each":""}${r.note?" · "+escapeHtml(r.note):""}</div></div></div>`;
    }).join("") : `<div class="empty-hint">No purchases recorded yet.</div>`;
  }catch(e){ if(area.isConnected) area.innerHTML = `<div class="empty-hint">Couldn't load purchase history.</div>`; }
}
function openStockIn(p){
  const sheet = document.getElementById("sheet-stock-in");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">Record Stock In</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(p.name)} · Current stock: ${p.stock} ${escapeHtml(p.unit||"")}</div>
    <label class="field-label">Quantity received</label>
    <input type="number" id="si-qty" min="0" value="1">
    <label class="field-label">Cost price per unit (₹, optional)</label>
    <input type="number" id="si-cost" min="0" value="0">
    <label class="field-label">Supplier (optional)</label>
    <input type="text" id="si-supplier" placeholder="e.g. Century Ply Distributor">
    <label class="field-label">Note (optional)</label>
    <input type="text" id="si-note" placeholder="e.g. Invoice / LR number">
    <button class="btn btn-primary" id="si-save" style="margin-top:16px;">Save</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelector("#si-save").addEventListener("click", async ()=>{
    const qty = parseFloat(document.getElementById("si-qty").value);
    if(!qty || qty<=0){ toast("Enter a valid quantity."); return; }
    try{
      const updated = await api("POST", `/products/${p.id}/stock-in`, {
        qty, costPrice: parseFloat(document.getElementById("si-cost").value)||0,
        supplier: document.getElementById("si-supplier").value.trim(),
        note: document.getElementById("si-note").value.trim()
      });
      Object.assign(p, updated);
      await loadProducts();
      closeAllSheets();
      openProductDetail(p.id, "inventory");
      renderInventoryList();
      toast("Stock updated.", "ok");
    }catch(err){ toast(err.message); }
  });
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
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(detail.type||"")} · ${escapeHtml(detail.phone||"")}${detail.gst?" · GST "+escapeHtml(detail.gst):""}${detail.state?" · "+escapeHtml(detail.state):""}</div>
    <div class="stat-grid">
      <div class="stat-card plain"><div class="label">Credit Limit</div><div class="value">${fmt(detail.credit_limit)}</div></div>
      <div class="stat-card plain"><div class="label">Outstanding Due</div><div class="value red">${fmt(detail.due)}</div></div>
    </div>
    ${detail.due>0 ? `<button class="btn btn-gold" id="record-payment-btn" style="margin-top:10px;">Record Payment</button>` : ""}
    <div class="section-title">Ledger</div>
    <div class="card">${detail.ledger.length ? detail.ledger.map(l=>{
      if(l.type==="invoice"){
        return `<div class="list-row" data-open-invoice="${l.id}" style="cursor:pointer;"><div><div class="row-title">${escapeHtml(l.label)}</div><div class="row-sub">${l.date} · Invoice</div></div><div class="row-right row-title" style="color:var(--danger);">+${fmt(l.amount)}</div></div>`;
      }
      return `<div class="list-row"><div><div class="row-title">Payment received${l.note?" — "+escapeHtml(l.note):""}</div><div class="row-sub">${l.date} · ${escapeHtml(l.label)}</div></div>
        <div class="row-right" style="display:flex;align-items:center;gap:8px;">
          <span class="row-title" style="color:var(--ok);">${fmt(l.amount)}</span>
          ${isOwner() ? `<a href="#" data-void-payment="${l.id}" class="btn-danger-link" style="font-size:11px;">Void</a>` : ""}
        </div></div>`;
    }).join("") : `<div class="empty-hint">No activity yet.</div>`}</div>
    ${isOwner() ? `<div style="margin-top:16px;text-align:center;">
      <a href="#" id="delete-cust-link" class="btn-danger-link">Delete this customer</a>
    </div>` : ""}
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-open-invoice]").forEach(el=>{
    el.addEventListener("click", ()=>{ closeAllSheets(); openExistingInvoice(el.dataset.openInvoice); });
  });
  const recordPaymentBtn = sheet.querySelector("#record-payment-btn");
  if(recordPaymentBtn) recordPaymentBtn.addEventListener("click", ()=>openRecordPayment(detail));
  sheet.querySelectorAll("[data-void-payment]").forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      if(confirm("Void this payment? The customer's due will go back up.")){
        try{
          await api("POST", `/customers/${detail.id}/payments/${a.dataset.voidPayment}/void`);
          await loadCustomers();
          await openCustomerDetail(detail.id);
          toast("Payment voided.", "ok");
        }catch(err){ toast(err.message); }
      }
    });
  });
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
   SHEET: Record Payment (against customer due)
   ============================================================ */
function openRecordPayment(customer){
  const sheet = document.getElementById("sheet-record-payment");
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">Record Payment</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px;">${escapeHtml(customer.name)} · Due: ${fmt(customer.due)}</div>
    <label class="field-label">Amount received (₹)</label>
    <input type="number" id="rp-amount" min="0" value="${customer.due}">
    <label class="field-label">Method</label>
    <div class="chip-row" id="rp-method-chips">
      <button class="chip selected" data-method="Cash">Cash</button>
      <button class="chip" data-method="UPI">UPI</button>
      <button class="chip" data-method="Card">Card</button>
      <button class="chip" data-method="Bank Transfer">Bank Transfer</button>
    </div>
    <label class="field-label">Note (optional)</label>
    <input type="text" id="rp-note" placeholder="e.g. Cheque no., reference">
    <button class="btn btn-primary" id="rp-save" style="margin-top:16px;">Save Payment</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-method]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-method]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#rp-save").addEventListener("click", async ()=>{
    const amount = parseFloat(document.getElementById("rp-amount").value);
    if(!amount || amount<=0){ toast("Enter a valid amount."); return; }
    try{
      await api("POST", `/customers/${customer.id}/payments`, {
        amount, method: sheet.querySelector("[data-method].selected").dataset.method,
        note: document.getElementById("rp-note").value.trim()
      });
      await loadCustomers();
      closeAllSheets();
      await openCustomerDetail(customer.id);
      toast("Payment recorded.", "ok");
    }catch(err){ toast(err.message); }
  });
  showSheet("sheet-record-payment");
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
  state.ctx.addProductSizes = product && product.sizes.length
    ? product.sizes.map(s=>({label:s.label, price:s.price}))
    : [{label:"", price:""}];
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
    <label class="field-label">Brand</label><input type="text" id="np-brand" value="${v("brand")}">
    <label class="field-label">Category</label><input type="text" id="np-category" value="${v("category")}">
    <label class="field-label">Unit of measure</label>
    <div class="chip-row" id="np-unit-chips">
      ${UNIT_OPTIONS.map(u=>`<button class="chip ${u===curUnit?'selected':''}" data-unit="${u}">${u}</button>`).join("")}
    </div>
    <label class="field-label">GST %</label><input type="number" id="np-gst" value="${editing ? editing.gst : 18}">

    <label class="field-label">Default billing mode</label>
    <div class="chip-row" id="np-mode-chips">
      ${Pricing.MODE_KEYS.map(k=>`<button class="chip ${k===curMode?'selected':''}" data-mode="${k}" title="${Pricing.MODES[k].formula}">${Pricing.MODES[k].unit}</button>`).join("")}
    </div>
    <label class="field-label">Standard size <span class="muted" style="font-weight:400;">— pre-filled on every bill, still editable there</span></label>
    <div class="charge-grid" id="np-dims"></div>
    <label class="field-label">Size / variant + price</label>
    <div id="np-sizes"></div>
    <a href="#" id="np-add-size" style="font-size:12px;font-weight:700;">+ Add another size</a>
    ${editing
      ? `<label class="field-label">Stock on hand</label>
         <input type="number" id="np-stock" value="${editing.stock}">
         <div class="muted" style="font-size:11px;margin-top:4px;">Correcting a miscount is fine here. For goods actually received, use “Record Stock In” so the purchase is kept in the history.</div>`
      : `<label class="field-label">Opening stock</label><input type="number" id="np-stock" value="0">`}
    <label class="field-label">Godown / Rack</label><input type="text" id="np-godown" placeholder="e.g. Godown A / R3" value="${v("godown")}">
    <button class="btn btn-primary" id="np-save" style="margin-top:16px;">${editing ? "Update Product" : "Save Product"}</button>
  `;
  function renderSizes(){
    document.getElementById("np-sizes").innerHTML = sizes.map((s,i)=>`
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
        <input type="text" placeholder="Label (e.g. 8x4 ft)" value="${escapeHtml(s.label)}" data-size-label="${i}" style="flex:1;">
        <input type="number" placeholder="Price" value="${s.price}" data-size-price="${i}" style="width:90px;">
        ${sizes.length>1?`<a href="#" data-size-remove="${i}" class="btn-danger-link">✕</a>`:""}
      </div>`).join("");
    document.querySelectorAll("[data-size-label]").forEach(inp=>inp.addEventListener("input", e=>sizes[e.target.dataset.sizeLabel].label=e.target.value));
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
      (m.needsWidth ? box("Width", m.widthUnit, "np-wid", prev.wid ?? (editing && editing.width_val) ?? "") : "") +
      (m.needsLength ? box("Length", m.lengthUnit, "np-len", prev.len ?? (editing && editing.length_ft) ?? "") : "");
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
  sheet.querySelector("#np-add-size").addEventListener("click", (e)=>{ e.preventDefault(); sizes.push({label:"",price:""}); renderSizes(); });
  sheet.querySelector("#np-save").addEventListener("click", async ()=>{
    const name = document.getElementById("np-name").value.trim();
    if(!name){ toast("Enter a product name."); return; }
    const unit = sheet.querySelector("[data-unit].selected").dataset.unit;
    const payload = {
      name, brand: document.getElementById("np-brand").value.trim(),
      category: document.getElementById("np-category").value.trim(),
      unit, gst: parseFloat(document.getElementById("np-gst").value)||18,
      godown: document.getElementById("np-godown").value.trim(),
      defaultMode: sheet.querySelector("[data-mode].selected").dataset.mode,
      lengthFt: val("np-len"), widthVal: val("np-wid"), thicknessIn: val("np-thk"),
      sizes
    };
    const saveBtn = document.getElementById("np-save");
    saveBtn.disabled = true;
    try{
      if(editing){
        await api("PUT", `/products/${editing.id}`, payload);
        // Stock is not part of PUT — it has its own audited endpoint — so an
        // edited count is pushed separately and only when it actually changed.
        const newStock = parseFloat(document.getElementById("np-stock").value);
        if(Number.isFinite(newStock) && newStock !== editing.stock){
          await api("PATCH", `/products/${editing.id}/stock`, {stock: newStock});
        }
      } else {
        payload.stock = parseInt(document.getElementById("np-stock").value)||0;
        await api("POST","/products", payload);
      }
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
function openAddCustomer(){
  const sheet = document.getElementById("sheet-add-customer");
  const types = ["Retail Customer","Contractor","Architect","Interior Designer","Builder","Wholesaler","Dealer"];
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" data-sheetclose>✕</button>
    <div class="sheet-title">New Customer</div>
    <label class="field-label">Name</label><input type="text" id="nc-name">
    <label class="field-label">Party type</label>
    <div class="chip-row" id="nc-type-chips">${types.map((t,i)=>`<button class="chip ${i===0?'selected':''}" data-type="${t}">${t}</button>`).join("")}</div>
    <label class="field-label">Phone / WhatsApp</label><input type="tel" id="nc-phone">
    <label class="field-label">State (for GST)</label>
    <select id="nc-state"><option value="">${state.settings.state ? "Same as shop ("+escapeHtml(state.settings.state)+")" : "Select state"}</option>${INDIAN_STATES.map(s=>`<option value="${s}">${s}</option>`).join("")}</select>
    <label class="field-label">GSTIN (optional)</label><input type="text" id="nc-gst">
    <label class="field-label">Credit limit</label><input type="number" id="nc-credit" value="0">
    <button class="btn btn-primary" id="nc-save" style="margin-top:16px;">Save Customer</button>
  `;
  sheet.querySelector("[data-sheetclose]").addEventListener("click", closeAllSheets);
  sheet.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click", ()=>{
    sheet.querySelectorAll("[data-type]").forEach(x=>x.classList.remove("selected")); b.classList.add("selected");
  }));
  sheet.querySelector("#nc-save").addEventListener("click", async ()=>{
    const name = document.getElementById("nc-name").value.trim();
    const phone = document.getElementById("nc-phone").value.trim();
    if(!name || !phone){ toast("Name and phone are required."); return; }
    try{
      await api("POST","/customers", {
        name, type: sheet.querySelector("[data-type].selected").dataset.type, phone,
        gst: document.getElementById("nc-gst").value.trim(),
        state: document.getElementById("nc-state").value || state.settings.state,
        creditLimit: parseFloat(document.getElementById("nc-credit").value)||0
      });
      await loadCustomers();
      closeAllSheets(); renderCustomersList(); renderBillingCustomers();
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
  sheet.querySelector("#st-logout").addEventListener("click", async ()=>{
    await api("POST","/auth/logout");
    closeAllSheets();
    await showLogin();
  });
  showSheet("sheet-settings");
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
function setPaper(size){
  state.paperSize = size;
  document.getElementById("paper-a5").classList.toggle("selected", size==="A5");
  document.getElementById("paper-a4").classList.toggle("selected", size==="A4");
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
      customer_id: state.selectedCustomerId,
      // Shape matches a row from the API so one template renders both an
      // unsaved preview and a saved invoice re-opened from history.
      items: state.cart.map(c=>{
        const r = lineCalc(c);
        return {
          name:c.name, mode:r.mode, size_label:r.sizeLabel,
          length_ft:r.lengthFt, width_val:r.widthVal, thickness_in:r.thicknessIn,
          pieces:r.pieces, per_piece:r.perPiece, unit_label:r.unit,
          qty:r.billedQty, rate:r.rate
        };
      }),
      tax_type: t.taxType, discount_amount:t.discount, subtotal:t.subtotal,
      cgst:t.cgst, sgst:t.sgst, igst:t.igst,
      transport:t.transport, loading:t.loading, round_off:t.roundOffAmount,
      total:t.total, advance:t.advance, balance_due:t.balanceDue
    };
  }
  const voidBtn = document.getElementById("inv-void");
  if(existingInvoice && existingInvoice.id && isOwner()){
    if(!voidBtn){
      const b = document.createElement("button");
      b.id = "inv-void"; b.textContent = "Void Invoice";
      b.addEventListener("click", async ()=>{
        if(!confirm("Void this invoice? Stock and customer dues will be reversed.")) return;
        try{
          await api("POST", `/invoices/${lastPreviewInvoice.id}/void`);
          toast("Invoice voided.", "ok");
          closeFullscreen("fs-invoice");
          await Promise.all([loadProducts(), loadCustomers()]);
          await renderHome();
        }catch(err){ toast(err.message); }
      });
      document.querySelector(".inv-actions").appendChild(b);
    }
  } else if(voidBtn){ voidBtn.remove(); }
  setPaper(state.paperSize);
  document.getElementById("fs-invoice").classList.add("show");
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
  document.getElementById("invoice-page-content").classList.toggle("size-a5", !isA4);
  const taxRows = inv.tax_type==="IGST"
    ? `<div class="tr"><span>IGST</span><span>${fmtPaise(inv.igst)}</span></div>`
    : `<div class="tr"><span>CGST</span><span>${fmtPaise(inv.cgst)}</span></div><div class="tr"><span>SGST</span><span>${fmtPaise(inv.sgst)}</span></div>`;
  document.getElementById("invoice-page-content").innerHTML = `
    <h2>${escapeHtml(cfg.business_name)}</h2>
    <div class="addr">${escapeHtml(cfg.tagline||"")}<br>${escapeHtml(cfg.address||"")}<br>Ph: ${escapeHtml(cfg.phones||"")} · GSTIN: ${escapeHtml(cfg.gstin||"")}</div>
    <hr class="inv-rule">
    <div class="inv-flex">
      <div><strong>Bill To:</strong><br>${cust?escapeHtml(cust.name):"Walk-in Customer"}${cust?"<br>"+escapeHtml(cust.type||"")+" · "+escapeHtml(cust.phone||""):""}</div>
      <div style="text-align:right;"><strong>Challan No:</strong> ${inv.challan_no}<br><strong>Date:</strong> ${inv.date}</div>
    </div>
    <table class="inv-table">
      <thead>
        <tr>
          <th class="c-sn">#</th>
          <th>Particulars</th>
          <th class="c-size">Size</th>
          <th class="c-num">Qty</th>
          <th class="c-num">Total</th>
          <th class="c-num">Rate</th>
          <th class="c-num c-amt">Amount</th>
        </tr>
      </thead>
      <tbody>${inv.items.map((it,i)=>{
        const mode = it.mode || "UNIT";
        return `<tr>
          <td class="c-sn">${i+1}</td>
          <td>${escapeHtml(it.name)}</td>
          <td class="c-size">${escapeHtml(it.size_label||"—")}</td>
          <td class="c-num">${it.pieces||it.qty}</td>
          <td class="c-num">${Pricing.formatQty(it.qty, mode)}</td>
          <td class="c-num">${Pricing.formatRate(it.rate, mode)}</td>
          <td class="c-num c-amt">${fmtPaise(it.qty*it.rate)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
    <div class="inv-totals">
      <div class="tr"><span>Subtotal</span><span>${fmtPaise(inv.subtotal)}</span></div>
      ${inv.discount_amount>0?`<div class="tr" style="color:var(--danger);"><span>Discount</span><span>-${fmtPaise(inv.discount_amount)}</span></div>`:""}
      ${taxRows}
      ${inv.transport>0?`<div class="tr"><span>Transport</span><span>${fmtPaise(inv.transport)}</span></div>`:""}
      ${inv.loading>0?`<div class="tr"><span>Loading / Labour</span><span>${fmtPaise(inv.loading)}</span></div>`:""}
      ${inv.round_off?`<div class="tr"><span>Round Off</span><span>${inv.round_off>0?"+":""}${fmtPaise(inv.round_off)}</span></div>`:""}
      <div class="tr grand"><span>Grand Total</span><span>${fmtPaise(inv.total)}</span></div>
      ${inv.advance>0?`<div class="tr" style="color:var(--ok);"><span>Advance Paid</span><span>-${fmtPaise(inv.advance)}</span></div>
      <div class="tr" style="font-weight:800;color:var(--danger);"><span>Balance Due</span><span>${fmtPaise(inv.balance_due)}</span></div>`:""}
    </div>
    <div class="inv-words"><span>Amount in words:</span> ${Pricing.amountInWords(inv.total)}</div>
    <hr class="inv-rule">
    <div style="font-size:9px;color:#666;">Goods once sold will not be taken back. Warranty as per manufacturer's terms only.</div>
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
    const canvas = await html2canvas(node, {scale:2, backgroundColor:"#ffffff", useCORS:true});
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const isA4 = state.paperSize==="A4";
    const pdf = new jsPDF({unit:"mm", format: isA4 ? "a4" : "a5"});
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = Math.min(pageHeight, canvas.height * imgWidth / canvas.width);
    pdf.addImage(imgData, "PNG", 0, 0, imgWidth, imgHeight);
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
function shareWhatsApp(){
  const inv = lastPreviewInvoice; if(!inv) return;
  const cust = state.customers.find(c=>c.id===inv.customer_id);
  const text = `Invoice ${inv.challan_no}\nDate: ${inv.date}\nCustomer: ${cust?cust.name:"Walk-in"}\nTotal: ${fmt(inv.total)}${inv.balance_due>0?`\nBalance Due: ${fmt(inv.balance_due)}`:""}`;
  const phone = cust && cust.phone ? cust.phone.replace(/\D/g,"") : "";
  const url = "https://wa.me/" + (phone?("91"+phone):"") + "?text=" + encodeURIComponent(text);
  window.open(url, "_blank");
}

/* ============================================================
   REPORTS
   ============================================================ */
async function renderReport(){
  const body = document.getElementById("report-body");
  let title="", subtitle="", rows=[];
  try{
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
    } else {
      title="Customer Outstanding"; subtitle="Dues by customer";
      rows = await api("GET","/reports/customer-dues");
    }
  }catch(e){ toast(e.message); return; }
  const max = Math.max(1, ...rows.map(r=>r.value));
  body.innerHTML = `<div style="font-weight:800;font-size:14px;">${title}</div><div class="muted" style="font-size:11.5px;margin-bottom:10px;">${subtitle}</div>` +
    (rows.length ? rows.map(r=>`
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:4px;"><span>${escapeHtml(r.label)}</span><span>${state.reportType==="Stock"?r.value+" units":fmt(r.value)}</span></div>
        <div style="height:8px;background:var(--bg-outer);border-radius:100px;"><div style="height:100%;width:${(r.value/max)*100}%;background:var(--navy);border-radius:100px;"></div></div>
      </div>`).join("") : `<div class="empty-hint">No data yet for this report.</div>`);
}

})();
