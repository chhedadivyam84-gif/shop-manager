/* ============================================================
   ADMIN CONTROL CENTRE — the shell's behaviour

   A classic script, in its own file, with every handler attached by
   addEventListener. That is not a style preference: the server sends
   Content-Security-Policy with script-src 'self' and NO 'unsafe-inline',
   so an inline <script> or an onclick= attribute on this page would be
   blocked by the browser and the panel simply would not work.

   THIS FILE HOLDS NO PERMISSION RULES. The sidebar is built from the
   sections GET /api/admin/me returns, so a section can never be drawn
   that the server would then refuse to serve, and there is no second
   list in the browser to drift out of step with adminAccess.js.

   Hiding a link is tidiness, not security. Every admin request is
   authorised again on the server — see the /api/admin mount in
   server/index.js and the gates in server/adminAccess.js.

   It deliberately does NOT reuse app.js's isOwner(): that reads
   state.me.role and is not preview-aware. The preview-aware answer is
   the one the server sends.
   ============================================================ */
(function () {
  "use strict";

  /* ------------------------------------------------------------------
     API — the same shape as app.js's helper, kept separate because this
     page has no app.js and no showLogin() to fall back to. A 401 here
     means the session went away, and the login screen lives at /.
     ------------------------------------------------------------------ */
  async function api(method, path, body) {
    const opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch("/api" + path, opts);
    if (res.status === 401) {
      location.href = "/";
      throw new Error("Session expired. Please log in again.");
    }
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || "Request failed.");
    return data;
  }

  function toast(msg, kind) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = kind === "ok" ? "ok" : "";
    el.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.style.display = "none"; }, 3200);
  }

  /* ------------------------------------------------------------------
     ICONS

     One drawn mark per section, all on the same 20-unit grid, all
     stroked in currentColor at the same weight, so the sidebar reads as
     one set. No emoji: this is a paid product, and a row of coloured
     pictograms is the first thing that makes an admin panel look like a
     toy. An unknown key falls back to a plain dot rather than nothing,
     so a section added on the server still gets a mark.
     ------------------------------------------------------------------ */
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="6.4" height="6.4" rx="1.2"/><rect x="10.6" y="3" width="6.4" height="6.4" rx="1.2"/><rect x="3" y="10.6" width="6.4" height="6.4" rx="1.2"/><rect x="10.6" y="10.6" width="6.4" height="6.4" rx="1.2"/>',
    customers: '<circle cx="8" cy="7.2" r="2.8"/><path d="M2.8 17c0-2.7 2.3-4.6 5.2-4.6s5.2 1.9 5.2 4.6"/><path d="M14 4.8a2.6 2.6 0 0 1 0 5"/><path d="M15.4 12.8c1.2.6 1.9 1.7 1.9 3.1"/>',
    products:  '<path d="M10 2.6 17 6.3v7.4L10 17.4 3 13.7V6.3Z"/><path d="M3 6.3 10 10l7-3.7"/><path d="M10 10v7.4"/>',
    inventory: '<path d="M2.8 6.6h14.4v9.8H2.8Z"/><path d="M2.8 6.6 5 3.6h10l2.2 3"/><path d="M8 10h4"/>',
    sales:     '<path d="M3 15.2 7.4 10l3.3 3 5.3-6.6"/><path d="M12.4 6.4H16v3.6"/>',
    invoices:  '<path d="M4.8 2.8h8.1l3.3 3.3v11.1H4.8Z"/><path d="M12.6 2.8v3.6h3.6"/><path d="M7.4 9.8h5.6"/><path d="M7.4 13h4"/>',
    payments:  '<rect x="2.6" y="5.2" width="14.8" height="9.6" rx="1.6"/><path d="M2.6 8.6h14.8"/><path d="M5.6 12.2h2.6"/>',
    ai:        '<path d="M10 2.8 11.7 7l4.3 1.5L11.7 10 10 14.2 8.3 10 4 8.5 8.3 7Z"/><path d="M15.2 13.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z"/>',
    employees: '<circle cx="10" cy="5.6" r="2.4"/><path d="M5.4 17v-1.6a4.6 4.6 0 0 1 9.2 0V17"/><path d="M7 10.6 10 12l3-1.4"/>',
    activity:  '<path d="M2.6 10.6h3.1l1.9-4.4 2.6 8.2 2.2-5.3 1.3 1.5h3.7"/>',
    plans:     '<path d="M10 2.8 17 6v4.4c0 3.3-2.8 5.9-7 6.8-4.2-.9-7-3.5-7-6.8V6Z"/><path d="M7.4 9.8l2 2 3.2-3.4"/>',
    roles:     '<path d="M10 2.8 16.4 5.6v4.9c0 3.4-2.6 6-6.4 6.7-3.8-.7-6.4-3.3-6.4-6.7V5.6Z"/><path d="M7.6 9.6h4.8"/><path d="M7.6 12.4h3"/>',
    users:     '<circle cx="7.4" cy="7" r="2.6"/><path d="M2.8 16.6c0-2.5 2.1-4.3 4.6-4.3s4.6 1.8 4.6 4.3"/><path d="M14 7.4v4.8"/><path d="M11.6 9.8h4.8"/>',
    settings:  '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.8v2.1M10 15.1v2.1M3.9 10H2M18 10h-1.9M5.7 5.7 4.3 4.3M15.7 15.7l1.4 1.4M14.3 5.7l1.4-1.4M5.7 14.3l-1.4 1.4"/>',
    security:  '<path d="M10 2.8 16.4 5.6v4.9c0 3.4-2.6 6-6.4 6.7-3.8-.7-6.4-3.3-6.4-6.7V5.6Z"/><path d="M10 8v3.4"/><circle cx="10" cy="13.4" r=".55" fill="currentColor" stroke="none"/>',
    audit:     '<path d="M5 2.8h10v14.4H5Z"/><path d="M7.8 6.6h4.4M7.8 9.8h4.4M7.8 13h2.8"/>',
    health:    '<rect x="2.8" y="4" width="14.4" height="9.6" rx="1.6"/><path d="M7.4 17h5.2"/><path d="M10 13.6V17"/><path d="M5.8 8.8h2l1.1-1.9 1.4 3 .9-1.6h2.9"/>',
  };
  const ICON_FALLBACK = '<circle cx="10" cy="10" r="3"/>';

  /* ------------------------------------------------------------------
     ELEMENTS
     ------------------------------------------------------------------ */
  const el = {
    shell:      document.getElementById("adm-shell"),
    sidebar:    document.getElementById("adm-sidebar"),
    scrim:      document.getElementById("adm-scrim"),
    nav:        document.getElementById("adm-nav"),
    brandName:  document.getElementById("adm-brand-name"),
    crumbHere:  document.getElementById("adm-crumb-here"),
    page:       document.getElementById("adm-page"),
    main:       document.getElementById("adm-main"),
    drawerOpen: document.getElementById("adm-drawer-open"),
    collapse:   document.getElementById("adm-collapse"),
    bell:       document.getElementById("adm-bell"),
    profileBtn: document.getElementById("adm-profile-btn"),
    profileMenu:document.getElementById("adm-profile-menu"),
    avatar:     document.getElementById("adm-avatar"),
    profName:   document.getElementById("adm-profile-name"),
    profRole:   document.getElementById("adm-profile-role"),
    logout:     document.getElementById("adm-logout"),
    search:     document.getElementById("adm-search-input"),
  };

  /* Everything the page knows, and all of it came from the server. */
  let me = { role: null, caps: [], sections: [], groups: [], businessName: "", staffName: "" };

  /* ------------------------------------------------------------------
     SMALL HELPERS
     ------------------------------------------------------------------ */
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "—";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* ------------------------------------------------------------------
     THE DRAWER  (tablet and phone)

     The sidebar is part of the grid from 1024 up, where there is no
     scrim and nothing to open, so the open class is cleared on a resize
     past that line — otherwise a phone rotated to landscape comes back
     with a stale state class on the shell.
     ------------------------------------------------------------------ */
  function openDrawer() {
    el.shell.classList.add("is-drawer-open");
    el.scrim.classList.add("show");
    el.drawerOpen.setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    el.shell.classList.remove("is-drawer-open");
    el.scrim.classList.remove("show");
    el.drawerOpen.setAttribute("aria-expanded", "false");
  }
  function isWide() {
    return window.matchMedia("(min-width: 1024px)").matches;
  }

  /* ------------------------------------------------------------------
     COLLAPSED ICON MODE  (laptop and desktop)

     Remembered per browser in localStorage, wrapped because a private
     window or blocked site data makes the accessor throw, and the panel
     must still open in that case.
     ------------------------------------------------------------------ */
  const COLLAPSE_KEY = "sm.admin.sidebarCollapsed";

  function readCollapsed() {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch (e) { return false; }
  }
  function writeCollapsed(on) {
    try { localStorage.setItem(COLLAPSE_KEY, on ? "1" : "0"); } catch (e) { /* no storage */ }
  }
  function applyCollapsed(on) {
    el.shell.classList.toggle("is-collapsed", !!on);
    el.collapse.setAttribute("aria-expanded", on ? "false" : "true");
    el.collapse.title = on ? "Expand the menu" : "Collapse the menu";
    const label = el.collapse.querySelector(".adm-collapse-label");
    if (label) label.textContent = on ? "Expand" : "Collapse";
  }

  /* ------------------------------------------------------------------
     THE SIDEBAR

     Built from me.groups and me.sections, both of which the server
     decided. Nothing is filtered here.
     ------------------------------------------------------------------ */
  function buildNav() {
    el.nav.textContent = "";

    if (!me.sections.length) {
      const p = document.createElement("p");
      p.className = "adm-section-label";
      p.textContent = "No sections available";
      el.nav.appendChild(p);
      return;
    }

    me.groups.forEach(function (group) {
      const rows = me.sections.filter(function (s) { return s.group === group; });
      if (!rows.length) return;

      const wrap = document.createElement("div");
      wrap.className = "adm-nav-group";

      const label = document.createElement("div");
      label.className = "adm-section-label";
      label.textContent = group;
      wrap.appendChild(label);

      rows.forEach(function (s) {
        const a = document.createElement("a");
        a.className = "adm-nav-item";
        a.href = s.href;
        a.dataset.key = s.key;
        /* data-tip drives the collapsed tooltip; title and aria-label
           keep the name available when the icon is all that shows. */
        a.dataset.tip = s.label;
        a.title = s.label;
        a.setAttribute("aria-label", s.label);

        const ic = document.createElement("span");
        ic.className = "adm-nav-ic";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.innerHTML = ICONS[s.key] || ICON_FALLBACK;
        ic.appendChild(svg);

        const txt = document.createElement("span");
        txt.className = "adm-nav-label";
        txt.textContent = s.label;

        a.appendChild(ic);
        a.appendChild(txt);

        a.addEventListener("mouseenter", function () { showTip(a); });
        a.addEventListener("mouseleave", hideTip);
        a.addEventListener("focus", function () { showTip(a); });
        a.addEventListener("blur", hideTip);

        wrap.appendChild(a);
      });

      el.nav.appendChild(wrap);
    });
  }

  /* ------------------------------------------------------------------
     THE COLLAPSED-MODE TOOLTIP

     One element, on <body>, position:fixed. It cannot live inside the
     sidebar: the nav scrolls, and a scroll container clips an
     absolutely positioned child, which is exactly how the first version
     of this ended up with the label sliced off at the sidebar edge.

     Mouse affordance only. The name a keyboard or screen-reader user
     gets comes from the nav item's own title and aria-label.
     ------------------------------------------------------------------ */
  let tipEl = null;

  function tip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "adm-tip";
      tipEl.hidden = true;
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function showTip(item) {
    if (!el.shell.classList.contains("is-collapsed") || !isWide()) return;
    const t = tip();
    t.textContent = item.dataset.tip || "";
    t.hidden = false;
    const r = item.getBoundingClientRect();
    t.style.left = Math.round(r.right + 8) + "px";
    t.style.top = Math.round(r.top + r.height / 2 - t.offsetHeight / 2) + "px";
    t.classList.add("show");
  }

  function hideTip() {
    if (!tipEl) return;
    tipEl.classList.remove("show");
    tipEl.hidden = true;
  }

  function markActive(key) {
    const items = el.nav.querySelectorAll(".adm-nav-item");
    for (let i = 0; i < items.length; i++) {
      const on = items[i].dataset.key === key;
      items[i].classList.toggle("is-active", on);
      if (on) items[i].setAttribute("aria-current", "page");
      else items[i].removeAttribute("aria-current");
    }
  }

  /* ------------------------------------------------------------------
     ROUTING

     location.hash, which is safe to claim: nothing else in this app
     uses hash, pushState or popstate, and /admin is a full page load
     that shares no state with the shop app.
     ------------------------------------------------------------------ */
  /* "#/customers/C0a1b2" -> { key: "customers", sub: "C0a1b2" }.
     A section never has to know the hash format, and an unknown section
     falls back to the first one the SERVER said this login may see. */
  function currentRoute() {
    const raw = String(location.hash || "").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    const found = me.sections.filter(function (s) { return s.key === parts[0]; })[0];
    if (found) return { key: found.key, sub: parts[1] ? decodeURIComponent(parts[1]) : null };
    return { key: me.sections.length ? me.sections[0].key : null, sub: null };
  }

  function currentKey() { return currentRoute().key; }

  function render() {
    /* A periodic refresh belongs to the screen that started it. Without
       this, navigating away from System Health leaves its timer running
       for the rest of the session, polling a page nobody is looking at. */
    stopHealthTimer();
    const key = currentKey();
    if (!key) {
      el.page.innerHTML = placeholderUnavailable();
      return;
    }
    const section = me.sections.filter(function (s) { return s.key === key; })[0];

    markActive(key);
    el.crumbHere.textContent = section.label;
    document.title = section.label + " — Admin Control Centre";

    /* PART 2 built the Dashboard, PART 3 Customers. Every other section
       is still the placeholder PART 1 put there, deliberately. */
    if (key === "dashboard") renderDashboard();
    else if (key === "customers") renderCustomers(currentRoute().sub);
    else if (key === "products") renderProducts(currentRoute().sub);
    else if (key === "inventory") renderInventory();
    else if (key === "invoices") renderInvoices(currentRoute().sub);
    else if (key === "sales") renderSales();
    else if (key === "users") renderUsers(currentRoute().sub);
    else if (key === "roles") renderRoles();
    else if (key === "audit") renderAudit(currentRoute().sub);
    else if (key === "health") renderHealth(currentRoute().sub);
    else el.page.innerHTML = placeholderPage(section);
    el.main.scrollTop = 0;
    window.scrollTo(0, 0);
    if (!isWide()) closeDrawer();
  }

  /* ------------------------------------------------------------------
     THE PLACEHOLDER PAGES

     PART 1 is the foundation, so every section lands here. Nothing on
     this page reads or writes a single row of the shop's data, and
     there is no invented sample data standing in for it — a figure
     that looks like a real takings total and is not would be worse
     than an empty frame.
     ------------------------------------------------------------------ */
  function placeholderPage(section) {
    return '' +
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">' + esc(section.label) + '</h1>' +
          '<p class="adm-page-sub">' + esc(section.group) +
            ' &middot; this section is part of the admin panel foundation and has no' +
            ' functionality yet.</p>' +
        '</div>' +
      '</div>' +
      '<div class="adm-card">' +
        '<div class="adm-placeholder">' +
          '<div class="adm-placeholder-row">' +
            '<span class="adm-dot" aria-hidden="true"></span>' +
            '<span>Not built yet &mdash; the shell, navigation and access' +
            ' control are in place.</span>' +
          '</div>' +
          '<div class="adm-placeholder-row">' +
            '<span>Nothing here reads or changes the shop&rsquo;s data.</span>' +
          '</div>' +
        '</div>' +
        '<div class="adm-meta">' +
          '<span>Section <b>' + esc(section.key) + '</b></span>' +
          '<span>Group <b>' + esc(section.group) + '</b></span>' +
          '<span>Signed in as <b>' + esc(me.role || "—") + '</b></span>' +
        '</div>' +
      '</div>';
  }

  function placeholderUnavailable() {
    return '' +
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Admin Control Centre</h1>' +
          '<p class="adm-page-sub">There are no sections available for this' +
          ' login.</p>' +
        '</div>' +
      '</div>';
  }

  /* ==================================================================
     THE DASHBOARD

     Draws whatever the server sent and nothing else. Every figure
     arrives as {available, value} or {available:false, reason}, so this
     file never has to decide whether a zero means "none" or "could not
     tell" — and never has a number of its own to fall back on.

     ONE REQUEST paints all eight panels. A panel that failed carries a
     Retry that refetches only itself.
     ================================================================== */

  const PANELS = [
    { key: "overview",  title: "Overview" },
    { key: "sales",     title: "Sales" },
    { key: "customers", title: "Customers" },
    { key: "inventory", title: "Inventory" },
    { key: "payments",  title: "Payments & revenue" },
    { key: "alerts",    title: "Alerts & issues" },
    { key: "activity",  title: "Recent activity" },
    { key: "system",    title: "System status" },
  ];

  /* ---- formatting -------------------------------------------------- */

  /* The app's own money format: whole rupees, Indian grouping. No
     paise — a dashboard is read at a glance, and 2 decimal places on
     seven tiles is noise. */
  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return "₹" + Math.round(v).toLocaleString("en-IN");
  }

  function num(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString("en-IN") : "—";
  }

  /* A stored YYYY-MM-DD, shown the way the rest of the app shows one:
     "7 Oct 2026". The explicit T00:00:00 is not decoration — a bare
     "2026-10-07" is parsed as UTC, which in this timezone renders as
     the 6th, and a dashboard disagreeing with the bill beside it about
     what day something happened is worse than no dashboard. */
  function showDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
    return new Date(iso + "T00:00:00")
      .toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  /** An epoch-ms stamp as date and time, same convention. */
  function showStamp(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) +
      " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }

  /** A {available,value} figure as money, or the dash that means "not known". */
  function fMoney(f) { return f && f.available ? money(f.value) : "—"; }
  function fNum(f)   { return f && f.available ? num(f.value) : "—"; }

  /* A period-on-period change. Null is not 0% — it means the previous
     period was empty, and "up 100%" from nothing is a lie a dashboard
     tells very easily. */
  function deltaHtml(pct) {
    if (pct === null || pct === undefined) {
      return '<span class="adm-delta is-flat">no earlier figure</span>';
    }
    const up = pct >= 0;
    const cls = pct === 0 ? "is-flat" : (up ? "is-up" : "is-down");
    const sign = pct > 0 ? "+" : "";
    return '<span class="adm-delta ' + cls + '">' + sign + pct.toFixed(1) + "%</span>";
  }

  /** The reason a figure is missing, as a short line under its label. */
  function whyHtml(f) {
    if (!f || f.available) return "";
    return '<span class="adm-why">' + esc(f.reason) +
      (f.needs ? " Needs " + esc(f.needs) + "." : "") + "</span>";
  }

  /* `text` marks a value that is words rather than a figure — a date,
     mostly. At the figure size "23 Sept 2026" wraps to three lines in a
     narrow tile and gets clipped; at the smaller size it fits and still
     reads as the tile's answer. */
  function tile(label, body, sub, opts) {
    const text = opts && opts.text;
    return '<div class="adm-tile">' +
      '<span class="adm-tile-label">' + esc(label) + "</span>" +
      '<span class="adm-tile-value' + (text ? " is-text" : "") + '">' + body + "</span>" +
      (sub ? '<span class="adm-tile-sub">' + sub + "</span>" : "") +
      "</div>";
  }

  function emptyLine(text) {
    return '<p class="adm-empty">' + esc(text) + "</p>";
  }

  /* ---- the chart ---------------------------------------------------
     Inline SVG, no library. Fourteen real daily totals; a day with no
     trade is a real zero, not a gap. Today's bar carries the accent so
     the eye lands on it; every other bar is the app's own navy, because
     fourteen orange bars would be the "overly orange" the brief warns
     about. ------------------------------------------------------- */
  /* Today, as the stored date columns spell it. */
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function chartHtml(series) {
    if (!series || !series.length) return "";
    const TODAY = todayIso();
    const max = Math.max.apply(null, series.map(d => d.total));
    const W = 100, H = 34, gap = 1.1;
    const bw = (W - gap * (series.length - 1)) / series.length;

    const bars = series.map((d, i) => {
      /* A trading day with a tiny total still gets a visible sliver, so
         "small" never reads as "none". */
      const h = max > 0 && d.total > 0 ? Math.max(0.8, (d.total / max) * H) : 0;
      const x = i * (bw + gap);
      /* The accent means TODAY, not "the last column". A Sales window
         that ends in the past has no today in it, and highlighting its
         final bar would invent one. */
      const isToday = d.date === TODAY;
      const title = d.date + " · " + money(d.total) +
        " · " + d.bills + (d.bills === 1 ? " bill" : " bills");
      return '<rect class="adm-bar' + (isToday ? " is-today" : "") + '"' +
        ' x="' + x.toFixed(2) + '" y="' + (H - h).toFixed(2) + '"' +
        ' width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '"' +
        '><title>' + esc(title) + "</title></rect>";
    }).join("");

    /* Every third day, plus the last — but only if the last is far
        enough from the one before it to not collide. At fourteen points
        the forced last tick landed one slot after index 12 and the two
        labels overlapped. */
    const last = series.length - 1;
    const shown = new Set();
    for (let i = 0; i < series.length; i += 3) shown.add(i);
    /* The last day is today, the bar the eye goes to, so it always keeps
       its label — and the grid tick beside it gives way rather than the
       other way round, which is what left "Tue Wed" overlapping. */
    shown.delete(last - 1);
    shown.delete(last - 2);
    shown.add(last);

    const ticks = series.map((d, i) => {
      if (!shown.has(i)) return "";
      return '<span class="adm-tick" style="left:' +
        (((i * (bw + gap)) + bw / 2) / W * 100).toFixed(2) + '%">' + esc(d.label) + "</span>";
    }).join("");

    return '<div class="adm-chart">' +
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" ' +
      'role="img" aria-label="Daily sales for the last fourteen days">' + bars + "</svg>" +
      '<div class="adm-ticks">' + ticks + "</div>" +
      "</div>";
  }

  /* ---- the panels --------------------------------------------------
     Each takes the section's data and returns the inside of its card.
     None of them fetch; none of them hold a figure of their own. ---- */
  const PAINT = {

    overview(d) {
      return '<div class="adm-tiles">' +
        tile("Today's sales", fMoney(d.todaysSales)) +
        tile("This month", fMoney(d.monthSales)) +
        tile("Outstanding", fMoney(d.outstanding)) +
        tile("Customers", fNum(d.customers)) +
        tile("Products", fNum(d.products)) +
        tile("Invoices", fNum(d.invoices)) +
        tile("Staff who can log in", fNum(d.activeUsers)) +
        "</div>" +
        '<p class="adm-foot">Figures as at ' + esc(showDate(d.asOf)) +
        ". Sales count priced tax invoices only — a delivery challan carries no money.</p>";
    },

    sales(d) {
      if (!d.hasAnySales) {
        return emptyLine("No sales have been recorded yet. This will fill in once the first bill is raised.");
      }
      return '<div class="adm-tiles">' +
        tile("Today", fMoney(d.today), deltaHtml(d.vsYesterday) + " on yesterday") +
        tile("Last 7 days", fMoney(d.week), deltaHtml(d.vsPrevWeek) + " on the 7 before") +
        tile("This month", fMoney(d.month), deltaHtml(d.vsPrevMonth) + " on last month") +
        tile("Bills this month", fNum(d.billsMonth),
             fNum(d.billsToday) + " today") +
        "</div>" +
        chartHtml(d.series) +
        '<p class="adm-foot">Last 14 days. ' +
        (d.openChallans && d.openChallans.available && d.openChallans.value
          ? num(d.openChallans.value) + " challan(s) delivered but not yet billed — not counted above. "
          : "") +
        "Month: " + esc(showDate(d.periodLabels.monthFrom)) + " to " +
        esc(showDate(d.periodLabels.monthTo)) + ".</p>";
    },

    customers(d) {
      const rows = (d.recent || []).map(c =>
        '<li class="adm-row">' +
          '<span class="adm-row-main">' + esc(c.name) + "</span>" +
          '<span class="adm-row-sub">' + esc(c.type || "—") + " · added " + esc(showDate(c.added)) + "</span>" +
          '<span class="adm-row-fig">' + (c.due > 0 ? money(c.due) + " due" : "") + "</span>" +
        "</li>").join("");

      return '<div class="adm-tiles">' +
        tile("Total", fNum(d.total)) +
        tile("On the books", fNum(d.onBooks)) +
        tile("Bought in " + d.buyingWindowDays + " days", fNum(d.buying)) +
        tile("New this month", fNum(d.newThisMonth)) +
        tile("Owing money", fNum(d.owing), fMoney(d.owedTotal) + " in total") +
        tile("Over credit limit", fNum(d.overLimit), "only where a limit is set") +
        "</div>" +
        (rows
          ? '<h3 class="adm-sub">Recently added</h3><ul class="adm-list">' + rows + "</ul>"
          : emptyLine("No customers on the books yet."));
    },

    inventory(d) {
      const rows = (d.recent || []).map(r =>
        '<li class="adm-row">' +
          '<span class="adm-row-main">' + esc(r.movement || "movement") + " · " + num(r.qty) + "</span>" +
          '<span class="adm-row-sub">' + esc(r.ref || "—") + " · " + esc(showDate(r.when)) +
            (r.staff ? " · " + esc(r.staff) : "") + "</span>" +
        "</li>").join("");

      return '<div class="adm-tiles">' +
        tile("Products", fNum(d.products)) +
        tile("Sizes tracked", fNum(d.sizes)) +
        tile("Out of stock", fNum(d.outOfStock), "sizes showing nothing on the racks") +
        tile("Low stock", fNum(d.lowStock), whyHtml(d.lowStock) ||
             ("against " + fNum(d.thresholdsSet) + " configured level(s)")) +
        "</div>" +
        '<p class="adm-foot">' + esc(d.stockValue.reason) + "</p>" +
        (rows
          ? '<h3 class="adm-sub">Recent stock movements</h3><ul class="adm-list">' + rows + "</ul>"
          : emptyLine("No stock movements recorded yet."));
    },

    payments(d) {
      const methods = (d.byMethod || []).map(m =>
        '<li class="adm-row">' +
          '<span class="adm-row-main">' + esc(m.method) + "</span>" +
          '<span class="adm-row-sub">' + num(m.n) + (m.n === 1 ? " payment" : " payments") + "</span>" +
          '<span class="adm-row-fig">' + money(m.total) + "</span>" +
        "</li>").join("");

      return '<div class="adm-tiles">' +
        tile("Recorded today", fMoney(d.takenToday)) +
        tile("Recorded this month", fMoney(d.takenMonth), fNum(d.countMonth) + " payment(s)") +
        tile("Owed to the shop", fMoney(d.outstanding)) +
        tile("Owed by the shop", fMoney(d.payable)) +
        tile("Reversed this month", fNum(d.reversedMonth), "payments voided after entry") +
        tile("Failed payments", "—", whyHtml(d.failed)) +
        "</div>" +
        (methods
          ? '<h3 class="adm-sub">By method, this month</h3><ul class="adm-list">' + methods + "</ul>"
          : emptyLine("No payments recorded this month."));
    },

    alerts(d) {
      if (!d.available) return emptyLine(d.reason || "Reminders are not available.");
      if (!d.total) return emptyLine("Nothing needs attention right now.");
      const rows = d.groups.map(g =>
        '<li class="adm-row adm-alert">' +
          '<span class="adm-pip is-' + esc(g.tone) + '" aria-hidden="true"></span>' +
          '<span class="adm-row-main">' + esc(g.title) + "</span>" +
          '<span class="adm-row-fig">' + num(g.count) + "</span>" +
        "</li>").join("");
      return '<ul class="adm-list">' + rows + "</ul>" +
        '<p class="adm-foot">' + num(d.total) +
        " item(s) across " + num(d.groups.length) +
        " group(s). The full list, with the detail, is on the Reminders screen in Shop Manager.</p>";
    },

    activity(d) {
      if (!d.available) return emptyLine(d.reason || "No activity log on this copy.");
      if (!d.entries.length) return emptyLine("Nothing has been recorded in the audit log yet.");
      const rows = d.entries.map(e =>
        '<li class="adm-row">' +
          '<span class="adm-row-main">' + esc(e.action) + "</span>" +
          '<span class="adm-row-sub">' + esc(e.who) +
            (e.role ? " (" + esc(e.role) + ")" : "") +
            " · " + esc(showDate(e.when)) + " " + esc(e.time) +
            (e.details ? " · " + esc(e.details) : "") + "</span>" +
        "</li>").join("");
      return '<ul class="adm-list">' + rows + "</ul>" +
        '<p class="adm-foot">The ' + num(d.entries.length) + " most recent of " +
        num(d.total) + ". The full trail is under Audit Logs.</p>";
    },

    system(d) {
      const dot = (ok) => '<span class="adm-pip is-' + (ok ? "ok" : "bad") + '" aria-hidden="true"></span>';
      const hrs = Math.floor(d.uptimeSeconds / 3600);
      const mins = Math.floor((d.uptimeSeconds % 3600) / 60);
      const up = hrs ? hrs + "h " + mins + "m" : mins + "m";

      return '<ul class="adm-list">' +
        '<li class="adm-row">' + dot(d.app.ok) +
          '<span class="adm-row-main">Application</span>' +
          '<span class="adm-row-sub">' + esc(d.app.detail) + " · up " + esc(up) + "</span></li>" +
        '<li class="adm-row">' + dot(d.database.ok) +
          '<span class="adm-row-main">Database</span>' +
          '<span class="adm-row-sub">' + esc(d.database.detail) + "</span></li>" +
        '<li class="adm-row">' + dot(!!d.lastBackupAt) +
          '<span class="adm-row-main">Backup</span>' +
          '<span class="adm-row-sub">' +
            (d.lastBackupAt ? "last recorded " + esc(showStamp(d.lastBackupAt))
                            : "no backup recorded in the audit log") + "</span></li>" +
        '<li class="adm-row">' + dot(d.sync.configured ? d.sync.lastOk : true) +
          '<span class="adm-row-main">Cloud sync</span>' +
          '<span class="adm-row-sub">' +
            (d.sync.configured
              ? (d.sync.lastAt
                  ? (d.sync.lastOk ? "last push succeeded " : "last push failed ") +
                    esc(showStamp(d.sync.lastAt))
                  : "set up, never pushed")
              : "not set up") + "</span></li>" +
        "</ul>";
    },
  };

  /* ---- the frame ---------------------------------------------------- */

  function panelShell(p, inner, state) {
    return '<section class="adm-panel' + (state ? " " + state : "") + '" data-panel="' + p.key + '">' +
      '<header class="adm-panel-head">' +
        '<h2 class="adm-panel-title">' + esc(p.title) + "</h2>" +
      "</header>" +
      '<div class="adm-panel-body">' + inner + "</div>" +
      "</section>";
  }

  /* A real loading state, not zeros. Showing 0 while the figure is still
     in flight is the specific thing the brief rules out, because a zero
     that later becomes 4,80,000 was a lie for as long as it was shown. */
  function skeleton() {
    return '<div class="adm-skel" aria-hidden="true">' +
      '<span></span><span></span><span></span>' + "</div>" +
      '<span class="adm-sr">Loading…</span>';
  }

  function failure(key, message) {
    return '<p class="adm-fail">' + esc(message) + "</p>" +
      '<button type="button" class="adm-retry" data-retry="' + esc(key) + '">Try again</button>';
  }

  function renderDashboard() {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Dashboard</h1>' +
          '<p class="adm-page-sub">The state of the shop and of this installation, ' +
          'read from the books. Every figure here is live; where a figure cannot be ' +
          'worked out, the panel says so rather than showing a zero.</p>' +
        "</div>" +
        '<button type="button" class="adm-primary" id="adm-refresh">Refresh</button>' +
      "</div>" +
      '<div class="adm-grid">' +
        PANELS.map(p => panelShell(p, skeleton(), "is-loading")).join("") +
      "</div>";

    const refresh = document.getElementById("adm-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadDashboard(); });

    /* One listener on the grid rather than one per Retry button, since
       the buttons come and go with every repaint. */
    const grid = el.page.querySelector(".adm-grid");
    if (grid) {
      grid.addEventListener("click", function (e) {
        const btn = e.target.closest("[data-retry]");
        if (btn) loadDashboard(btn.dataset.retry);
      });
    }

    loadDashboard();
  }

  function paintPanel(p, section) {
    const host = el.page.querySelector('[data-panel="' + p.key + '"]');
    if (!host) return;
    const body = host.querySelector(".adm-panel-body");
    host.classList.remove("is-loading", "is-failed");

    if (!section) {
      host.classList.add("is-failed");
      body.innerHTML = failure(p.key, "This section did not arrive.");
      return;
    }
    if (!section.ok) {
      host.classList.add("is-failed");
      body.innerHTML = section.refused
        ? '<p class="adm-fail">' + esc(section.error) + "</p>"   /* no retry: it will refuse again */
        : failure(p.key, section.error || "This section could not be loaded.");
      return;
    }
    try {
      body.innerHTML = PAINT[p.key](section.data);
    } catch (err) {
      /* A panel that cannot draw what it was sent must not take the
         other seven down with it. */
      host.classList.add("is-failed");
      body.innerHTML = failure(p.key, "This section could not be displayed.");
    }
  }

  /** Load everything, or re-load one panel after a failure. */
  async function loadDashboard(only) {
    const wanted = only ? PANELS.filter(p => p.key === only) : PANELS;

    wanted.forEach(p => {
      const host = el.page.querySelector('[data-panel="' + p.key + '"]');
      if (!host) return;
      host.classList.remove("is-failed");
      host.classList.add("is-loading");
      host.querySelector(".adm-panel-body").innerHTML = skeleton();
    });

    let payload;
    try {
      payload = await api("GET", "/admin/dashboard" + (only ? "?only=" + encodeURIComponent(only) : ""));
    } catch (err) {
      /* The whole request failed — the network, or the session. Every
         panel asked for says so, and each can be retried on its own.

         The browser's own message is NOT passed through: a dropped
         connection throws "Failed to fetch", which tells a shop owner
         nothing and reads like a bug in the app. A message the server
         wrote is meant for a person and is kept; anything else becomes
         a sentence somebody can act on. */
      wanted.forEach(p => paintPanel(p, { ok: false, error: humanError(err) }));
      return;
    }

    const sections = (payload && payload.sections) || {};
    wanted.forEach(p => paintPanel(p, sections[p.key]));
  }

  /* ==================================================================
     CUSTOMERS

     A list and a profile over the shop's own customer book. Nothing is
     held here: the browser keeps the page it is looking at and the
     search box it typed, and asks the server for everything else.

     THE SERVER DOES THE SEARCHING. The whole book is never pulled down
     to be filtered in the browser — that is the shop app's approach on
     its own customers screen and it is the thing section 11 of the
     brief rules out for this one.
     ================================================================== */

  /* Only what the reader chose. Deliberately not a cache of rows: a
     cached customer list is a second copy of the customer book, and the
     first time it disagrees with the shop it is worse than no list. */
  let custView = { q: "", filter: "all", sort: "name", page: 1 };
  let custOptions = null;
  let custSeq = 0;             /* so a slow reply cannot overwrite a fast one */

  const STATUS = {
    on:  { label: "Active", cls: "is-ok" },
    off: { label: "Switched off", cls: "is-info" },
  };

  function custHref(id) { return id ? "#/customers/" + encodeURIComponent(id) : "#/customers"; }

  /* ---- the list ---------------------------------------------------- */

  function renderCustomers(id) {
    if (id) return renderCustomerProfile(id);

    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Customers</h1>' +
          '<p class="adm-page-sub">The shop&rsquo;s own customer book. Searching and ' +
          'filtering happen on the server, so this stays quick as the book grows.</p>' +
        "</div>" +
      "</div>" +
      '<div class="adm-toolbar">' +
        '<div class="adm-field adm-field-grow">' +
          '<label class="adm-sr" for="cust-q">Search customers</label>' +
          '<input type="search" id="cust-q" class="adm-input" autocomplete="off" ' +
          'placeholder="Name, phone, GSTIN or customer ID">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="cust-filter">Show</label>' +
          '<select id="cust-filter" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="cust-sort">Sort by</label>' +
          '<select id="cust-sort" class="adm-input"></select>' +
        "</div>" +
      "</div>" +
      '<div class="adm-panel"><div class="adm-panel-body" id="cust-body">' +
        skeleton() + "</div></div>";

    const q = document.getElementById("cust-q");
    q.value = custView.q;

    /* Debounced, so typing a name is one request rather than one per
       keystroke — and the sequence guard below means an early reply
       that arrives late cannot paint over a later one. */
    let timer = null;
    q.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        custView.q = q.value.trim();
        custView.page = 1;
        loadCustomers();
      }, 250);
    });
    q.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(timer);
      custView.q = q.value.trim();
      custView.page = 1;
      loadCustomers();
    });

    document.getElementById("cust-filter").addEventListener("change", function (e) {
      custView.filter = e.target.value; custView.page = 1; loadCustomers();
    });
    document.getElementById("cust-sort").addEventListener("change", function (e) {
      custView.sort = e.target.value; custView.page = 1; loadCustomers();
    });

    /* One listener for the whole body: rows, paging and retry all come
       and go with every repaint. */
    document.getElementById("cust-body").addEventListener("click", function (e) {
      const page = e.target.closest("[data-page]");
      if (page) { custView.page = Number(page.dataset.page); loadCustomers(); return; }
      if (e.target.closest("[data-retry-customers]")) { loadCustomers(); return; }
      const clear = e.target.closest("[data-clear-search]");
      if (clear) {
        custView = { q: "", filter: "all", sort: custView.sort, page: 1 };
        renderCustomers(null);
        loadCustomers();
      }
    });

    loadCustomers();
  }

  function fillSelect(el2, options, chosen) {
    if (!el2 || !options) return;
    el2.innerHTML = options.map(o =>
      '<option value="' + esc(o.key) + '"' + (o.key === chosen ? " selected" : "") + ">" +
      esc(o.label) + "</option>").join("");
  }

  async function loadCustomers() {
    const body = document.getElementById("cust-body");
    if (!body) return;
    body.innerHTML = skeleton();

    const mine = ++custSeq;
    let data;
    try {
      const qs = "?q=" + encodeURIComponent(custView.q) +
        "&filter=" + encodeURIComponent(custView.filter) +
        "&sort=" + encodeURIComponent(custView.sort) +
        "&page=" + encodeURIComponent(custView.page);
      data = await api("GET", "/admin/customers" + qs);
    } catch (err) {
      if (mine !== custSeq) return;
      body.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-customers="1">Try again</button>';
      return;
    }
    if (mine !== custSeq) return;          /* a newer search already won */

    custOptions = data.options;
    custView.page = data.page;
    fillSelect(document.getElementById("cust-filter"), data.options.filters, data.filter);
    fillSelect(document.getElementById("cust-sort"), data.options.sorts, data.sort);

    body.innerHTML = customerListHtml(data);
  }

  function customerListHtml(d) {
    if (!d.total) {
      /* Two different nothings, and telling them apart is the whole
         point: a shop with no customers needs different words from a
         search that found none. */
      return d.q || d.filter !== "all"
        ? emptyLine("No customer matches that search.") +
          '<button type="button" class="adm-retry" data-clear-search="1">Clear search and filters</button>'
        : emptyLine("No customers on the books yet. They are added from Shop Manager.");
    }

    const from = (d.page - 1) * d.pageSize + 1;
    const to = from + d.rows.length - 1;

    const head =
      '<div class="adm-tbl-head" aria-hidden="true">' +
        '<span>Customer</span><span>Phone</span><span>Status</span>' +
        '<span class="adm-num">Bills</span><span class="adm-num">Purchases</span>' +
        '<span class="adm-num">Outstanding</span><span>Last sale</span>' +
      "</div>";

    const rows = d.rows.map(c => {
      const st = c.active ? STATUS.on : STATUS.off;
      return '<a class="adm-tbl-row" href="' + custHref(c.id) + '">' +
        '<span class="adm-cell adm-cell-name">' +
          '<span class="adm-strong">' + esc(c.name) + "</span>" +
          (c.type ? '<span class="adm-row-sub">' + esc(c.type) +
            (c.gst ? " · " + esc(c.gst) : "") + "</span>" : "") +
        "</span>" +
        '<span class="adm-cell" data-h="Phone">' + (c.phone ? esc(c.phone) : "—") + "</span>" +
        '<span class="adm-cell" data-h="Status">' +
          '<span class="adm-pip ' + st.cls + '" aria-hidden="true"></span>' + esc(st.label) +
        "</span>" +
        '<span class="adm-cell adm-num" data-h="Bills">' + num(c.bills) + "</span>" +
        '<span class="adm-cell adm-num" data-h="Purchases">' + money(c.sales) + "</span>" +
        '<span class="adm-cell adm-num" data-h="Outstanding">' +
          (c.due > 0 ? '<span class="' + (c.overLimit ? "adm-over" : "") + '">' + money(c.due) + "</span>"
                     : '<span class="adm-muted">—</span>') +
        "</span>" +
        '<span class="adm-cell" data-h="Last sale">' +
          (c.lastSale ? esc(showDate(c.lastSale)) : '<span class="adm-muted">never</span>') +
        "</span>" +
      "</a>";
    }).join("");

    const pager = d.pages > 1
      ? '<div class="adm-pager">' +
          '<button type="button" class="adm-retry" data-page="' + (d.page - 1) + '"' +
            (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
          '<span class="adm-pager-at">' + num(from) + "–" + num(to) +
            " of " + num(d.total) + "</span>" +
          '<button type="button" class="adm-retry" data-page="' + (d.page + 1) + '"' +
            (d.page >= d.pages ? " disabled" : "") + ">Next</button>" +
        "</div>"
      : '<p class="adm-foot">' + num(d.total) +
        (d.total === 1 ? " customer." : " customers.") + "</p>";

    return '<div class="adm-tbl">' + head + rows + "</div>" + pager;
  }

  /* ---- the profile ------------------------------------------------- */

  async function renderCustomerProfile(id) {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<a class="adm-back" href="#/customers">&larr; All customers</a>' +
          '<h1 class="adm-page-title" id="cust-title">Customer</h1>' +
        "</div>" +
      "</div>" +
      '<div id="cust-profile"><div class="adm-panel"><div class="adm-panel-body">' +
        skeleton() + "</div></div></div>";

    const host = document.getElementById("cust-profile");
    let d;
    try {
      d = await api("GET", "/admin/customers/" + encodeURIComponent(id));
    } catch (err) {
      /* A 404 here is the ordinary case of a stale link or a mistyped
         id — and it is also what another shop's customer looks like,
         because that record is not in this shop's database at all. */
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<a class="adm-retry" href="#/customers">Back to all customers</a>' +
        "</div></div>";
      return;
    }

    paintCustomerProfile(host, d);
  }

  function paintCustomerProfile(host, d) {
    const c = d.customer, s = d.summary;
    const st = c.active ? STATUS.on : STATUS.off;

    const title = document.getElementById("cust-title");
    if (title) title.textContent = c.name;
    el.crumbHere.textContent = c.name;

    /* Only the fields this shop actually stores. There is no email
       column anywhere in the schema, so there is no email row — an
       always-blank field reads as broken rather than absent. */
    const info = [
      ["Name", esc(c.name)],
      ["Type", c.type ? esc(c.type) : "—"],
      ["Phone", c.phone ? esc(c.phone) : "—"],
      ["WhatsApp", c.whatsapp ? esc(c.whatsapp) : '<span class="adm-muted">same as phone</span>'],
      ["Address", c.address ? esc(c.address) : "—"],
      ["State", c.state ? esc(c.state) : "—"],
      ["PIN code", c.pinCode ? esc(c.pinCode) : "—"],
      ["GSTIN", c.gst ? esc(c.gst) : "—"],
      ["Tax", c.gstType === "IGST" ? "IGST" : "CGST + SGST"],
      ["Credit limit", c.creditLimit > 0 ? money(c.creditLimit)
        : '<span class="adm-muted">none agreed</span>'],
      ["Customer ID", '<code class="adm-code">' + esc(c.id) + "</code>"],
      ["Added", esc(showDate(c.created))],
    ].map(r => '<div class="adm-kv"><span class="adm-kv-k">' + r[0] +
      '</span><span class="adm-kv-v">' + r[1] + "</span></div>").join("");

    const docs = d.recentInvoices.map(i =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(i.no) +
          (i.docType === "challan" ? ' <span class="adm-muted">(challan)</span>' : "") + "</span>" +
        '<span class="adm-row-sub">' + esc(showDate(i.date)) + "</span>" +
        '<span class="adm-row-fig">' +
          (i.docType === "challan" ? '<span class="adm-muted">no charge</span>' : money(i.total)) +
        "</span>" +
      "</li>").join("");

    const pays = d.recentPayments.map(p =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(p.method || "Payment") + "</span>" +
        '<span class="adm-row-sub">' + esc(showDate(p.date)) +
          (p.reference ? " · " + esc(p.reference) : "") + "</span>" +
        '<span class="adm-row-fig">' + money(p.amount) + "</span>" +
      "</li>").join("");

    const events = d.activity.events.map(e =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(e.label) + "</span>" +
        '<span class="adm-row-sub">' + esc(showDate(e.date)) +
          (e.detail ? " · " + esc(e.detail) : "") + "</span>" +
        (e.amount !== null && e.amount !== undefined
          ? '<span class="adm-row-fig">' + money(e.amount) + "</span>" : "") +
      "</li>").join("");

    host.innerHTML =
      '<div class="adm-profile-head">' +
        '<span class="adm-status"><span class="adm-pip ' + st.cls +
          '" aria-hidden="true"></span>' + esc(st.label) + "</span>" +
        '<div class="adm-profile-actions">' +
          '<button type="button" class="adm-retry" data-edit="1">Edit details</button>' +
          '<button type="button" class="adm-retry" data-active="' +
            (c.active ? "0" : "1") + '">' +
            (c.active ? "Switch off" : "Switch back on") + "</button>" +
        "</div>" +
      "</div>" +

      '<div class="adm-grid">' +

        '<section class="adm-panel" data-panel="info"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Customer information</h2></header>' +
          '<div class="adm-panel-body" id="cust-info">' + info + "</div></section>" +

        '<section class="adm-panel" data-panel="summary"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Business summary</h2></header>' +
          '<div class="adm-panel-body">' +
            '<div class="adm-tiles">' +
              tile("Purchases", money(s.sales), num(s.bills) + " bill(s)") +
              tile("Outstanding", s.outstanding > 0 ? money(s.outstanding) : "—",
                   s.overLimit ? '<span class="adm-over">over the agreed limit</span>' : "") +
              tile("Paid", money(s.paid), num(s.payments) + " payment(s)") +
              tile("Average bill", s.averageBill === null ? "—" : money(s.averageBill)) +
              tile("First sale", s.firstSale ? esc(showDate(s.firstSale)) : "—", "", { text: true }) +
              tile("Last sale", s.lastSale ? esc(showDate(s.lastSale)) : "—", "", { text: true }) +
            "</div>" +
            (s.openingBalance
              ? '<p class="adm-foot">Includes an opening balance of ' +
                money(s.openingBalance) + ".</p>" : "") +
            (s.challans
              ? '<p class="adm-foot">' + num(s.challans) +
                " delivery challan(s), which carry goods but no money and are not counted above.</p>" : "") +
          "</div></section>" +

        '<section class="adm-panel" data-panel="docs"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Recent invoices</h2></header>' +
          '<div class="adm-panel-body">' +
            (docs ? '<ul class="adm-list">' + docs + "</ul>" +
              '<p class="adm-foot">The complete ledger is on this customer&rsquo;s page in Shop Manager.</p>'
                  : emptyLine("No invoices for this customer yet.")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="pays"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Recent payments</h2></header>' +
          '<div class="adm-panel-body">' +
            (pays ? '<ul class="adm-list">' + pays + "</ul>"
                  : emptyLine("No payments recorded for this customer yet.")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="activity"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Activity</h2></header>' +
          '<div class="adm-panel-body">' +
            (events ? '<ul class="adm-list">' + events + "</ul>" : emptyLine("Nothing recorded yet.")) +
            '<p class="adm-foot">Built from this customer&rsquo;s own records — every line ' +
            'above is linked to them by the record itself. Edits to a customer&rsquo;s ' +
            'details are not shown here: the audit log stores them against a name rather ' +
            'than an id, and matching on a name would attribute one customer&rsquo;s ' +
            'changes to another. That needs a per-customer event log.</p>' +
          "</div></section>" +

      "</div>";

    host.addEventListener("click", function (e) {
      if (e.target.closest("[data-edit]")) { openCustomerEdit(host, d); return; }
      const act = e.target.closest("[data-active]");
      if (act) setCustomerActive(host, d, act.dataset.active === "1");
    });
  }

  /* ---- editing ------------------------------------------------------
     Writes through the shop's own handler on the server, so an admin
     edit is the same edit the counter makes. Only fields that exist. */
  const EDIT_FIELDS = [
    { key: "name", label: "Name", required: true },
    { key: "type", label: "Type" },
    { key: "phone", label: "Phone", required: true },
    { key: "whatsapp", label: "WhatsApp", hint: "Leave blank to use the phone number" },
    { key: "address", label: "Address" },
    { key: "state", label: "State" },
    { key: "pinCode", label: "PIN code" },
    { key: "gst", label: "GSTIN" },
    { key: "creditLimit", label: "Credit limit", type: "number" },
  ];

  function openCustomerEdit(host, d) {
    const c = d.customer;
    const fields = EDIT_FIELDS.map(f =>
      '<div class="adm-field adm-field-block">' +
        '<label class="adm-field-label" for="ce-' + f.key + '">' + esc(f.label) +
          (f.required ? " *" : "") + "</label>" +
        '<input class="adm-input" id="ce-' + f.key + '" type="' + (f.type || "text") +
          '" value="' + esc(c[f.key] === null || c[f.key] === undefined ? "" : c[f.key]) + '">' +
        (f.hint ? '<span class="adm-why">' + esc(f.hint) + "</span>" : "") +
      "</div>").join("");

    const info = document.getElementById("cust-info");
    info.innerHTML =
      '<form class="adm-form" id="cust-edit">' + fields +
        '<div class="adm-form-actions">' +
          '<button type="submit" class="adm-primary">Save changes</button>' +
          '<button type="button" class="adm-retry" data-cancel="1">Cancel</button>' +
        "</div>" +
        '<p class="adm-why" id="cust-edit-msg"></p>' +
      "</form>";

    info.querySelector("[data-cancel]").addEventListener("click", function () {
      renderCustomerProfile(c.id);
    });

    document.getElementById("cust-edit").addEventListener("submit", async function (e) {
      e.preventDefault();
      const msg = document.getElementById("cust-edit-msg");
      const body = {};
      EDIT_FIELDS.forEach(f => {
        const v = document.getElementById("ce-" + f.key).value;
        body[f.key] = f.type === "number" ? Number(v || 0) : v.trim();
      });
      if (!body.name || !body.phone) {
        msg.textContent = "A name and a phone number are both required.";
        return;
      }
      msg.textContent = "Saving…";
      try {
        await api("PUT", "/admin/customers/" + encodeURIComponent(c.id), body);
      } catch (err) {
        msg.textContent = humanError(err);
        return;
      }
      toast("Customer updated.", "ok");
      renderCustomerProfile(c.id);
    });
  }

  async function setCustomerActive(host, d, active) {
    const c = d.customer;
    /* Reversible either way, so this asks rather than warns — and says
       plainly that nothing financial moves, because "switch off" on a
       customer with money owing is exactly where somebody would worry. */
    const ask = active
      ? "Switch " + c.name + " back on?"
      : "Switch " + c.name + " off? They stay on the books and every invoice, " +
        "payment and balance is untouched — this only takes them out of " +
        "everyday use, and it can be undone.";
    if (!window.confirm(ask)) return;

    try {
      await api("PATCH", "/admin/customers/" + encodeURIComponent(c.id) + "/active", { active });
    } catch (err) {
      toast(humanError(err));
      return;
    }
    toast(active ? "Customer switched back on." : "Customer switched off.", "ok");
    renderCustomerProfile(c.id);
  }

  /* A message a shop owner can act on. The browser's own "Failed to
     fetch" is not one; a message the server wrote is. */
  function humanError(err) {
    const m = err && err.message;
    if (!m || /^(Failed to fetch|NetworkError|Load failed)/i.test(m)) {
      return "Could not reach the server. Check the connection and try again.";
    }
    return m;
  }

  /* ==================================================================
     PRODUCTS AND INVENTORY

     Two sidebar sections over one service: the catalogue, and the
     shelves. The thing to keep straight throughout is that stock lives
     on a SIZE at a LOCATION, so a count is never shown without saying
     which size it belongs to.
     ================================================================== */

  let prodView = { q: "", category: "", filter: "all", sort: "name", page: 1 };
  let prodSeq = 0;

  /* How a stock state is drawn. "unset" is not a warning — most shops
     never set a minimum for most lines, and colouring it amber would
     turn an un-configured feature into a fault. */
  const STOCK_STATE = {
    out:   { label: "Out of stock",   cls: "is-bad" },
    low:   { label: "Low stock",      cls: "is-warn" },
    in:    { label: "In stock",       cls: "is-ok" },
    unset: { label: "No minimum set", cls: "is-info" },
  };

  function stateHtml(key) {
    const s = STOCK_STATE[key] || STOCK_STATE.unset;
    return '<span class="adm-pip ' + s.cls + '" aria-hidden="true"></span>' + esc(s.label);
  }

  /* A quantity always carries its unit: 43 means nothing across a
     catalogue that mixes square feet and pieces. */
  function qtyHtml(qty, unit) {
    return '<span class="adm-num">' + num(qty) + "</span>" +
      (unit ? ' <span class="adm-muted">' + esc(unit) + "</span>" : "");
  }

  function prodHref(id) { return id ? "#/products/" + encodeURIComponent(id) : "#/products"; }

  /* ---- the product list -------------------------------------------- */

  function renderProducts(id) {
    if (id) return renderProductProfile(id);

    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Products</h1>' +
          '<p class="adm-page-sub">The shop&rsquo;s catalogue. Stock is counted per size ' +
          'and per location, so a product&rsquo;s figure here is the sum of its sizes.</p>' +
        "</div>" +
      "</div>" +
      '<div class="adm-toolbar">' +
        '<div class="adm-field adm-field-grow">' +
          '<label class="adm-sr" for="prod-q">Search products</label>' +
          '<input type="search" id="prod-q" class="adm-input" autocomplete="off" ' +
          'placeholder="Name, SKU, code, brand or barcode">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="prod-cat">Category</label>' +
          '<select id="prod-cat" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="prod-filter">Show</label>' +
          '<select id="prod-filter" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="prod-sort">Sort by</label>' +
          '<select id="prod-sort" class="adm-input"></select>' +
        "</div>" +
      "</div>" +
      '<div class="adm-panel"><div class="adm-panel-body" id="prod-body">' +
        skeleton() + "</div></div>";

    const q = document.getElementById("prod-q");
    q.value = prodView.q;

    let timer = null;
    q.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        prodView.q = q.value.trim(); prodView.page = 1; loadProducts();
      }, 250);
    });
    q.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(timer);
      prodView.q = q.value.trim(); prodView.page = 1; loadProducts();
    });

    document.getElementById("prod-cat").addEventListener("change", function (e) {
      prodView.category = e.target.value; prodView.page = 1; loadProducts();
    });
    document.getElementById("prod-filter").addEventListener("change", function (e) {
      prodView.filter = e.target.value; prodView.page = 1; loadProducts();
    });
    document.getElementById("prod-sort").addEventListener("change", function (e) {
      prodView.sort = e.target.value; prodView.page = 1; loadProducts();
    });

    document.getElementById("prod-body").addEventListener("click", function (e) {
      const page = e.target.closest("[data-page]");
      if (page) { prodView.page = Number(page.dataset.page); loadProducts(); return; }
      if (e.target.closest("[data-retry-products]")) { loadProducts(); return; }
      if (e.target.closest("[data-clear-products]")) {
        prodView = { q: "", category: "", filter: "all", sort: prodView.sort, page: 1 };
        renderProducts(null);
      }
    });

    loadProducts();
  }

  async function loadProducts() {
    const body = document.getElementById("prod-body");
    if (!body) return;
    body.innerHTML = skeleton();

    const mine = ++prodSeq;
    let data;
    try {
      const qs = "?q=" + encodeURIComponent(prodView.q) +
        "&category=" + encodeURIComponent(prodView.category) +
        "&filter=" + encodeURIComponent(prodView.filter) +
        "&sort=" + encodeURIComponent(prodView.sort) +
        "&page=" + encodeURIComponent(prodView.page);
      data = await api("GET", "/admin/products" + qs);
    } catch (err) {
      if (mine !== prodSeq) return;
      body.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-products="1">Try again</button>';
      return;
    }
    if (mine !== prodSeq) return;

    prodView.page = data.page;
    fillSelect(document.getElementById("prod-filter"), data.options.filters, data.filter);
    fillSelect(document.getElementById("prod-sort"), data.options.sorts, data.sort);
    fillSelect(document.getElementById("prod-cat"),
      [{ key: "", label: "All categories" }].concat(
        data.options.categories.map(c => ({ key: c.name, label: c.name + " (" + c.n + ")" }))),
      data.category);

    body.innerHTML = productListHtml(data);
  }

  function productListHtml(d) {
    if (!d.total) {
      return d.q || d.filter !== "all" || d.category
        ? emptyLine("No product matches that search.") +
          '<button type="button" class="adm-retry" data-clear-products="1">Clear search and filters</button>'
        : emptyLine("No products in the catalogue yet. They are added from Shop Manager.");
    }

    const from = (d.page - 1) * d.pageSize + 1;
    const to = from + d.rows.length - 1;

    const head =
      '<div class="adm-tbl-head adm-tbl-prod" aria-hidden="true">' +
        '<span>Product</span><span>Category</span><span>Status</span>' +
        '<span class="adm-num">Stock</span><span class="adm-num">Sizes</span>' +
        '<span class="adm-num">Price</span><span>Last moved</span>' +
      "</div>";

    const rows = d.rows.map(p => {
      const price = p.priceFrom === null ? "—"
        : (p.priceFrom === p.priceTo ? money(p.priceFrom)
                                     : money(p.priceFrom) + "–" + money(p.priceTo));
      return '<a class="adm-tbl-row adm-tbl-prod" href="' + prodHref(p.id) + '">' +
        '<span class="adm-cell adm-cell-name">' +
          '<span class="adm-strong">' + esc(p.name) + "</span>" +
          '<span class="adm-row-sub">' +
            [p.brand, p.sku || p.code].filter(Boolean).map(esc).join(" · ") +
            (p.active ? "" : ' · <span class="adm-muted">switched off</span>') +
          "</span>" +
        "</span>" +
        '<span class="adm-cell" data-h="Category">' +
          (p.category ? esc(p.category) : '<span class="adm-muted">—</span>') + "</span>" +
        '<span class="adm-cell" data-h="Status">' + stateHtml(p.status) + "</span>" +
        '<span class="adm-cell adm-num" data-h="Stock">' + qtyHtml(p.qty, p.unitLabel) + "</span>" +
        '<span class="adm-cell adm-num" data-h="Sizes">' + num(p.sizes) +
          /* Which of them need attention, named rather than folded into
             the product's single status word. */
          (p.outSizes ? '<span class="adm-flag adm-down">' + num(p.outSizes) + " out</span>" : "") +
          (p.lowSizes ? '<span class="adm-flag adm-over">' + num(p.lowSizes) + " low</span>" : "") +
        "</span>" +
        '<span class="adm-cell adm-num" data-h="Price">' + price + "</span>" +
        '<span class="adm-cell" data-h="Last moved">' +
          (p.lastMoved ? esc(showDate(p.lastMoved)) : '<span class="adm-muted">never</span>') +
        "</span>" +
      "</a>";
    }).join("");

    const pager = d.pages > 1
      ? '<div class="adm-pager">' +
          '<button type="button" class="adm-retry" data-page="' + (d.page - 1) + '"' +
            (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
          '<span class="adm-pager-at">' + num(from) + "–" + num(to) +
            " of " + num(d.total) + "</span>" +
          '<button type="button" class="adm-retry" data-page="' + (d.page + 1) + '"' +
            (d.page >= d.pages ? " disabled" : "") + ">Next</button>" +
        "</div>"
      : '<p class="adm-foot">' + num(d.total) +
        (d.total === 1 ? " product." : " products.") + "</p>";

    return '<div class="adm-tbl">' + head + rows + "</div>" + pager;
  }

  /* ---- one product -------------------------------------------------- */

  async function renderProductProfile(id) {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<a class="adm-back" href="#/products">&larr; All products</a>' +
          '<h1 class="adm-page-title" id="prod-title">Product</h1>' +
        "</div>" +
      "</div>" +
      '<div id="prod-profile"><div class="adm-panel"><div class="adm-panel-body">' +
        skeleton() + "</div></div></div>";

    const host = document.getElementById("prod-profile");
    let d;
    try {
      /* Labels first when they are not loaded yet, so a movement reads
         "Stock Adjustment" rather than "adjustment". A product page can
         be opened without visiting Inventory first. */
      if (!Object.keys(MOVEMENT_LABELS).length) await loadMovements();
      d = await api("GET", "/admin/products/" + encodeURIComponent(id));
    } catch (err) {
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<a class="adm-retry" href="#/products">Back to all products</a>' +
        "</div></div>";
      return;
    }
    paintProductProfile(host, d);
  }

  function paintProductProfile(host, d) {
    const p = d.product, s = d.summary;

    const title = document.getElementById("prod-title");
    if (title) title.textContent = p.name;
    el.crumbHere.textContent = p.name;

    /* Only fields this shop stores. Nothing invented to fill a row —
       there is no description column on products, so there is no
       Description row. */
    const info = [
      ["Name", esc(p.name)],
      ["Brand", p.brand ? esc(p.brand) : "—"],
      ["Category", p.category ? esc(p.category) +
        (p.subCategory ? " · " + esc(p.subCategory) : "") : "—"],
      ["SKU", p.sku ? '<code class="adm-code">' + esc(p.sku) + "</code>" : "—"],
      ["Code", p.code ? esc(p.code) : "—"],
      ["Barcode", p.barcode ? esc(p.barcode) : "—"],
      ["Unit", p.unit ? esc(p.unit) : "—"],
      ["HSN", p.hsnCode ? esc(p.hsnCode) : "—"],
      ["GST", p.gstRate + "%"],
      ["Kept at", [p.godown, p.rack].filter(Boolean).map(esc).join(" · ") || "—"],
      ["Status", p.active ? "Active" : "Switched off"],
      ["Product ID", '<code class="adm-code">' + esc(p.id) + "</code>"],
      ["Added", esc(showDate(p.created))],
    ].map(r => '<div class="adm-kv"><span class="adm-kv-k">' + r[0] +
      '</span><span class="adm-kv-v">' + r[1] + "</span></div>").join("");

    const sizeRows = d.sizes.map(z => {
      const locs = z.locations.map(l =>
        '<span class="adm-chip">' + esc(l.location) + " " + num(l.quantity) +
        (l.minStock > 0 ? ' <span class="adm-muted">min ' + num(l.minStock) + "</span>" : "") +
        "</span>").join(" ");
      return '<div class="adm-size" data-size="' + z.id + '">' +
        '<div class="adm-size-head">' +
          '<span class="adm-size-label">' + esc(z.label) + "</span>" +
          '<span class="adm-size-state">' + stateHtml(z.status) + "</span>" +
          '<span class="adm-size-qty">' + qtyHtml(z.qty, p.unit) + "</span>" +
        "</div>" +
        '<div class="adm-size-meta">' +
          '<span>Price ' + money(z.price) + "</span>" +
          (z.cost !== null && z.cost > 0 ? "<span>Cost " + money(z.cost) + "</span>" : "") +
          (z.minStock > 0 ? "<span>Minimum " + num(z.minStock) + "</span>"
                          : '<span class="adm-muted">no minimum set</span>') +
          (z.lastMoved ? "<span>Last moved " + esc(showDate(z.lastMoved)) + "</span>" : "") +
        "</div>" +
        (locs ? '<div class="adm-chips">' + locs + "</div>" : "") +
        '<div class="adm-size-actions" data-adjust-host="' + z.id + '"></div>' +
      "</div>";
    }).join("");

    const hist = (d.history || []).map(h => historyRowHtml(h, { hideProduct: true })).join("");

    host.innerHTML =
      '<div class="adm-profile-head">' +
        '<span class="adm-status">' + stateHtml(
          s.out ? "out" : (s.low ? "low" : (s.minimumsSet ? "in" : "unset"))) + "</span>" +
        '<div class="adm-profile-actions">' +
          (d.abilities && d.abilities.mayEdit
            ? '<button type="button" class="adm-retry" data-edit-product="1">Edit details</button>'
            : "") +
        "</div>" +
      "</div>" +

      '<div class="adm-grid">' +
        '<section class="adm-panel" data-panel="info"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Product information</h2></header>' +
          '<div class="adm-panel-body" id="prod-info">' + info + "</div></section>" +

        '<section class="adm-panel" data-panel="summary"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Inventory</h2></header>' +
          '<div class="adm-panel-body">' +
            '<div class="adm-tiles">' +
              tile("In stock", qtyHtml(s.qty, s.unit), num(s.sizes) + " size(s)") +
              tile("Out of stock", num(s.out), "size(s) with nothing left") +
              tile("Low", num(s.low), s.minimumsSet
                ? "against " + num(s.minimumsSet) + " minimum(s)"
                : '<span class="adm-why">No minimum set for any size, so none can be called low.</span>') +
              tile("Costed", num(s.costed), "size(s) with a cost recorded") +
            "</div>" +
            (p.denormalisedStock !== s.qty
              ? '<p class="adm-foot adm-over">The product total (' + num(p.denormalisedStock) +
                ") does not match the sum of its sizes (" + num(s.qty) +
                "). That is a drift worth looking at in Shop Manager.</p>"
              : "") +
          "</div></section>" +

        '<section class="adm-panel" data-panel="sizes"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Sizes and stock</h2></header>' +
          '<div class="adm-panel-body" id="prod-sizes">' +
            (sizeRows || emptyLine("This product has no sizes, so nothing can be stocked against it.")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="history"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Stock movements</h2></header>' +
          '<div class="adm-panel-body">' +
            (hist ? '<ul class="adm-list">' + hist + "</ul>" +
              '<p class="adm-foot">The most recent movements for this product. ' +
              'Every line records the count before and after.</p>'
                  : emptyLine("No stock movements recorded for this product yet.")) +
          "</div></section>" +
      "</div>";

    host.addEventListener("click", function (e) {
      if (e.target.closest("[data-edit-product]")) { openProductEdit(host, d); return; }
      const adj = e.target.closest("[data-adjust]");
      if (adj) { openAdjust(d, Number(adj.dataset.adjust)); return; }
      const cancel = e.target.closest("[data-adjust-cancel]");
      if (cancel) { closeAdjust(Number(cancel.dataset.adjustCancel)); }
    });

    /* Only an owner sees the correction control; the server refuses it
       for anybody else regardless, which is where the actual rule is. */
    if (d.abilities && d.abilities.mayAdjust) {
      d.sizes.forEach(z => {
        const slot = host.querySelector('[data-adjust-host="' + z.id + '"]');
        if (slot) slot.innerHTML =
          '<button type="button" class="adm-retry" data-adjust="' + z.id + '">Correct stock</button>';
      });
    }
  }

  function historyRowHtml(h, opts) {
    const up = h.qty > 0;
    return '<li class="adm-row adm-hist">' +
      '<span class="adm-pip ' + (up ? "is-ok" : "is-bad") + '" aria-hidden="true"></span>' +
      '<span class="adm-row-main">' +
        esc(movementLabel(h.movement)) +
        ((opts && opts.hideProduct) ? "" : " · " + esc(h.product || "—")) +
        (h.size ? ' <span class="adm-muted">' + esc(h.size) + "</span>" : "") +
      "</span>" +
      '<span class="adm-row-sub">' +
        esc(showDate(h.date)) + (h.time ? " " + esc(h.time) : "") +
        (h.location ? " · " + esc(h.location) : "") +
        (h.ref ? " · " + esc(h.ref) : "") +
        (h.staff ? " · " + esc(h.staff) : "") +
        (h.remarks ? " · " + esc(h.remarks) : "") +
      "</span>" +
      '<span class="adm-row-fig">' +
        '<span class="' + (up ? "adm-up" : "adm-down") + '">' +
          (up ? "+" : "") + num(h.qty) + "</span>" +
        '<span class="adm-hist-ba">' + num(h.before) + " → " + num(h.after) + "</span>" +
      "</span>" +
    "</li>";
  }

  let MOVEMENT_LABELS = {};
  function movementLabel(key) { return MOVEMENT_LABELS[key] || key || "Movement"; }

  /* ---- correcting a count ------------------------------------------- */

  function closeAdjust(sizeId) {
    const slot = document.querySelector('[data-adjust-host="' + sizeId + '"]');
    if (slot) slot.innerHTML =
      '<button type="button" class="adm-retry" data-adjust="' + sizeId + '">Correct stock</button>';
  }

  function openAdjust(d, sizeId) {
    const z = d.sizes.filter(x => x.id === sizeId)[0];
    const slot = document.querySelector('[data-adjust-host="' + sizeId + '"]');
    if (!z || !slot) return;

    const locs = z.locations.length ? z.locations : [{ locationId: "", location: "Shop", quantity: z.qty }];

    slot.innerHTML =
      '<form class="adm-adjust" id="adj-' + sizeId + '">' +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="adj-loc-' + sizeId + '">Location</label>' +
          '<select class="adm-input" id="adj-loc-' + sizeId + '">' +
            locs.map(l => '<option value="' + esc(l.locationId) + '">' + esc(l.location) +
              " — now " + num(l.quantity) + "</option>").join("") +
          "</select>" +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="adj-count-' + sizeId + '">New count</label>' +
          '<input class="adm-input" id="adj-count-' + sizeId + '" type="number" step="any" min="0">' +
        "</div>" +
        '<div class="adm-field adm-field-grow">' +
          '<label class="adm-field-label" for="adj-reason-' + sizeId + '">Reason</label>' +
          '<input class="adm-input" id="adj-reason-' + sizeId + '" type="text" maxlength="200" ' +
          'placeholder="Stock count, damage, correction…">' +
        "</div>" +
        '<div class="adm-form-actions">' +
          '<button type="submit" class="adm-primary">Save correction</button>' +
          '<button type="button" class="adm-retry" data-adjust-cancel="' + sizeId + '">Cancel</button>' +
        "</div>" +
        '<p class="adm-why" id="adj-msg-' + sizeId + '">The count before and after, your name, ' +
        'the time and this reason are all written to the stock ledger.</p>' +
      "</form>";

    document.getElementById("adj-" + sizeId).addEventListener("submit", async function (e) {
      e.preventDefault();
      const msg = document.getElementById("adj-msg-" + sizeId);
      const locationId = document.getElementById("adj-loc-" + sizeId).value;
      const raw = document.getElementById("adj-count-" + sizeId).value;
      const reason = document.getElementById("adj-reason-" + sizeId).value.trim();

      if (raw === "") { msg.textContent = "Enter the new count."; return; }
      const count = Number(raw);
      if (!Number.isFinite(count) || count < 0) {
        msg.textContent = "A stock count cannot be negative.";
        return;
      }
      if (!reason) { msg.textContent = "Give a reason for the correction."; return; }

      msg.textContent = "Saving…";
      try {
        await api("PATCH", "/admin/products/" + encodeURIComponent(d.product.id) +
          "/sizes/" + encodeURIComponent(sizeId) + "/stock",
          { stock: count, locationId: locationId || undefined, reason });
      } catch (err) {
        msg.textContent = humanError(err);
        return;
      }
      toast("Stock corrected.", "ok");
      renderProductProfile(d.product.id);
    });
  }

  /* ---- editing a product -------------------------------------------- */

  const PRODUCT_FIELDS = [
    { key: "name", label: "Name", required: true },
    { key: "brand", label: "Brand" },
    { key: "category", label: "Category" },
    { key: "subCategory", label: "Sub-category" },
    { key: "unit", label: "Unit" },
    { key: "hsnCode", label: "HSN code" },
    { key: "gstRate", label: "GST %", type: "number", send: "gst" },
    { key: "code", label: "Code" },
    { key: "barcode", label: "Barcode" },
    { key: "godown", label: "Godown" },
    { key: "rack", label: "Rack" },
  ];

  function openProductEdit(host, d) {
    const p = d.product;
    const fields = PRODUCT_FIELDS.map(f =>
      '<div class="adm-field adm-field-block">' +
        '<label class="adm-field-label" for="pe-' + f.key + '">' + esc(f.label) +
          (f.required ? " *" : "") + "</label>" +
        '<input class="adm-input" id="pe-' + f.key + '" type="' + (f.type || "text") +
          '" value="' + esc(p[f.key] === null || p[f.key] === undefined ? "" : p[f.key]) + '">' +
      "</div>").join("");

    const info = document.getElementById("prod-info");
    info.innerHTML =
      '<form class="adm-form" id="prod-edit">' + fields +
        '<div class="adm-form-actions">' +
          '<button type="submit" class="adm-primary">Save changes</button>' +
          '<button type="button" class="adm-retry" data-cancel-product="1">Cancel</button>' +
        "</div>" +
        '<p class="adm-why" id="prod-edit-msg">Sizes, prices and stock are not changed here ' +
        '— a price belongs to a size, and a count is corrected under Sizes and stock.</p>' +
      "</form>";

    info.querySelector("[data-cancel-product]").addEventListener("click", function () {
      renderProductProfile(p.id);
    });

    document.getElementById("prod-edit").addEventListener("submit", async function (e) {
      e.preventDefault();
      const msg = document.getElementById("prod-edit-msg");
      const body = {};
      PRODUCT_FIELDS.forEach(f => {
        const v = document.getElementById("pe-" + f.key).value;
        body[f.send || f.key] = f.type === "number" ? Number(v || 0) : v.trim();
      });
      if (!body.name) { msg.textContent = "A name is required."; return; }
      /* `sizes` is deliberately NOT sent: the shop's handler only touches
         sizes when it is given an array, and this form does not edit them. */
      msg.textContent = "Saving…";
      try {
        await api("PUT", "/admin/products/" + encodeURIComponent(p.id), body);
      } catch (err) {
        msg.textContent = humanError(err);
        return;
      }
      toast("Product updated.", "ok");
      renderProductProfile(p.id);
    });
  }

  /* ==================================================================
     INVENTORY
     ================================================================== */

  let invView = { movement: "", page: 1 };

  function renderInventory() {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Inventory</h1>' +
          '<p class="adm-page-sub">What is on the shelves, and everything that has moved ' +
          'it. Counts are shown per unit — board is measured in square feet and ' +
          'hardware in pieces, so there is no single total.</p>' +
        "</div>" +
        '<button type="button" class="adm-primary" id="inv-refresh">Refresh</button>' +
      "</div>" +
      '<div class="adm-grid">' +
        '<section class="adm-panel" data-panel="overview"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Overview</h2></header>' +
          '<div class="adm-panel-body" id="inv-overview">' + skeleton() + "</div></section>" +
        '<section class="adm-panel" data-panel="history"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Stock movements</h2></header>' +
          '<div class="adm-panel-body">' +
            '<div class="adm-toolbar">' +
              '<div class="adm-field">' +
                '<label class="adm-field-label" for="inv-move">Movement</label>' +
                '<select id="inv-move" class="adm-input"></select>' +
              "</div>" +
            "</div>" +
            '<div id="inv-history">' + skeleton() + "</div>" +
          "</div></section>" +
      "</div>";

    document.getElementById("inv-refresh").addEventListener("click", function () {
      loadInventory(); loadHistory();
    });
    document.getElementById("inv-move").addEventListener("change", function (e) {
      invView.movement = e.target.value; invView.page = 1; loadHistory();
    });
    document.getElementById("inv-history").addEventListener("click", function (e) {
      const page = e.target.closest("[data-page]");
      if (page) { invView.page = Number(page.dataset.page); loadHistory(); return; }
      if (e.target.closest("[data-retry-history]")) loadHistory();
    });
    document.getElementById("inv-overview").addEventListener("click", function (e) {
      if (e.target.closest("[data-retry-overview]")) loadInventory();
    });

    loadInventory();
    loadMovements().then(loadHistory);
  }

  async function loadMovements() {
    try {
      const d = await api("GET", "/admin/inventory/movements");
      MOVEMENT_LABELS = {};
      (d.movements || []).forEach(m => { MOVEMENT_LABELS[m.key] = m.label; });
      fillSelect(document.getElementById("inv-move"),
        [{ key: "", label: "All movements" }].concat(
          (d.movements || []).map(m => ({ key: m.key, label: m.label }))),
        invView.movement);
    } catch (err) { /* the list still draws; only the filter is missing */ }
  }

  async function loadInventory() {
    const host = document.getElementById("inv-overview");
    if (!host) return;
    host.innerHTML = skeleton();
    let d;
    try {
      d = await api("GET", "/admin/inventory");
    } catch (err) {
      host.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-overview="1">Try again</button>';
      return;
    }

    const units = (d.byUnit || []).map(u =>
      '<li class="adm-row"><span class="adm-row-main">' + esc(u.unit) + "</span>" +
      '<span class="adm-row-sub">' + num(u.products) + " product(s)</span>" +
      '<span class="adm-row-fig">' + num(u.qty) + "</span></li>").join("");

    /* Counts of sizes, not a quantity: a location holds square feet AND
       pieces, and one figure for both would be the cross-unit total the
       footer below explicitly rules out. */
    const locs = (d.byLocation || []).map(l =>
      '<li class="adm-row"><span class="adm-row-main">' + esc(l.name) + "</span>" +
      '<span class="adm-row-sub">' + num(l.sizes) + " size(s) tracked here</span>" +
      '<span class="adm-row-fig">' + num(l.stocked) + " in stock</span></li>").join("");

    host.innerHTML =
      '<div class="adm-tiles">' +
        tile("Products", num(d.products)) +
        tile("Sizes tracked", num(d.sizes)) +
        tile("Out of stock", num(d.outSizes), "size(s) with nothing left") +
        tile("Low stock", d.lowAvailable ? num(d.lowSizes) : "—",
             d.lowAvailable
               ? "against " + num(d.minimumsSet) + " minimum(s) set"
               : '<span class="adm-why">No minimum stock level has been set on any size yet, ' +
                 'so nothing can be called low. Set one under Inventory in Shop Manager.</span>') +
        tile("Moved recently", num(d.movedRecently),
             "movement(s) in the last " + num(d.recentDays) + " days") +
        tile("Categories", num(d.categories)) +
      "</div>" +
      (units ? '<h3 class="adm-sub">Quantity by unit</h3><ul class="adm-list">' + units + "</ul>" : "") +
      (locs ? '<h3 class="adm-sub">By location</h3><ul class="adm-list">' + locs + "</ul>" : "") +
      '<p class="adm-foot">Quantities are never added across units — square feet and ' +
      "pieces do not sum to anything meaningful.</p>";
  }

  async function loadHistory() {
    const host = document.getElementById("inv-history");
    if (!host) return;
    host.innerHTML = skeleton();
    let d;
    try {
      d = await api("GET", "/admin/inventory/history?page=" + encodeURIComponent(invView.page) +
        (invView.movement ? "&movement=" + encodeURIComponent(invView.movement) : ""));
    } catch (err) {
      host.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-history="1">Try again</button>';
      return;
    }

    if (!d.available) { host.innerHTML = emptyLine(d.reason || "No movement log on this copy."); return; }
    if (!d.total) {
      host.innerHTML = emptyLine(invView.movement
        ? "No movements of that kind yet."
        : "No stock movements recorded yet.");
      return;
    }

    const from = (d.page - 1) * d.pageSize + 1;
    const to = from + d.rows.length - 1;

    host.innerHTML =
      '<ul class="adm-list">' + d.rows.map(h => historyRowHtml(h, {})).join("") + "</ul>" +
      (d.pages > 1
        ? '<div class="adm-pager">' +
            '<button type="button" class="adm-retry" data-page="' + (d.page - 1) + '"' +
              (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
            '<span class="adm-pager-at">' + num(from) + "–" + num(to) +
              " of " + num(d.total) + "</span>" +
            '<button type="button" class="adm-retry" data-page="' + (d.page + 1) + '"' +
              (d.page >= d.pages ? " disabled" : "") + ">Next</button>" +
          "</div>"
        : '<p class="adm-foot">' + num(d.total) + " movement(s).</p>");
  }

  /* ==================================================================
     SALES AND INVOICES

     Read-only. There is no edit control anywhere below and no API
     behind one: changing an invoice is a financial act and belongs
     behind the financial-year lock in Shop Manager.

     THE ONE THING TO KEEP STRAIGHT is that a delivery challan carries
     goods but no money. Its total arrives as null rather than 0, and
     this file prints what the goods were worth instead — a confident
     "₹0" against five sheets of ply that really did leave the shop is
     the kind of wrong number an owner stops trusting the screen for.
     ================================================================== */

  let docView = { q: "", type: "all", status: "all", sort: "recent",
                  customerId: "", from: "", to: "", page: 1 };
  let docSeq = 0;
  let salesWindow = { from: "", to: "" };

  function docHref(id) { return id ? "#/invoices/" + encodeURIComponent(id) : "#/invoices"; }

  /* How each of the shop's five document states is drawn. The words are
     the app's, not this file's — see deriveDocStatus in
     server/routes/invoices.js. Anything unrecognised falls back to the
     neutral tone rather than being hidden. */
  const DOC_STATE_TONE = {
    "Completed": "is-ok",
    "Billed": "is-ok",
    "Partially Completed": "is-warn",
    "Pending": "is-warn",
    "Cancelled": "is-info",
  };

  /* ---- the document list -------------------------------------------- */

  function renderInvoices(id) {
    if (id) return renderDocument(id);

    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Invoices</h1>' +
          '<p class="adm-page-sub">Every tax invoice and delivery challan the shop has ' +
          'raised. Read-only here &mdash; a bill is changed in Shop Manager, where the ' +
          'financial-year lock and the stock that moves with it apply.</p>' +
        "</div>" +
      "</div>" +
      '<div class="adm-toolbar">' +
        '<div class="adm-field adm-field-grow">' +
          '<label class="adm-sr" for="doc-q">Search documents</label>' +
          '<input type="search" id="doc-q" class="adm-input" autocomplete="off" ' +
          'placeholder="Document number, customer or amount">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-type">Type</label>' +
          '<select id="doc-type" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-status">Status</label>' +
          '<select id="doc-status" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-customer">Customer</label>' +
          '<select id="doc-customer" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-from">From</label>' +
          '<input type="date" id="doc-from" class="adm-input">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-to">To</label>' +
          '<input type="date" id="doc-to" class="adm-input">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-sort">Sort by</label>' +
          '<select id="doc-sort" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="doc-clear">&nbsp;</label>' +
          '<button type="button" class="adm-retry" id="doc-clear">Clear filters</button>' +
        "</div>" +
      "</div>" +
      '<div class="adm-panel"><div class="adm-panel-body" id="doc-list">' +
        skeleton() + "</div></div>";

    const q = document.getElementById("doc-q");
    q.value = docView.q;
    let timer = null;
    q.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        docView.q = q.value.trim(); docView.page = 1; loadDocuments();
      }, 250);
    });
    q.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault(); clearTimeout(timer);
      docView.q = q.value.trim(); docView.page = 1; loadDocuments();
    });

    [["doc-type", "type"], ["doc-status", "status"], ["doc-sort", "sort"],
     ["doc-customer", "customerId"], ["doc-from", "from"], ["doc-to", "to"]].forEach(pair => {
      document.getElementById(pair[0]).addEventListener("change", function (e) {
        docView[pair[1]] = e.target.value; docView.page = 1; loadDocuments();
      });
    });

    document.getElementById("doc-clear").addEventListener("click", function () {
      docView = { q: "", type: "all", status: "all", sort: "recent",
                  customerId: "", from: "", to: "", page: 1 };
      renderInvoices(null);
    });

    document.getElementById("doc-list").addEventListener("click", function (e) {
      const page = e.target.closest("[data-page]");
      if (page) { docView.page = Number(page.dataset.page); loadDocuments(); return; }
      if (e.target.closest("[data-retry-documents]")) { loadDocuments(); return; }
      if (e.target.closest("[data-clear-documents]")) {
        docView = { q: "", type: "all", status: "all", sort: docView.sort,
                    customerId: "", from: "", to: "", page: 1 };
        renderInvoices(null);
      }
    });

    loadDocuments();
  }

  async function loadDocuments() {
    const body = document.getElementById("doc-list");
    if (!body) return;
    body.innerHTML = skeleton();

    const mine = ++docSeq;
    let d;
    try {
      const qs = "?q=" + encodeURIComponent(docView.q) +
        "&type=" + encodeURIComponent(docView.type) +
        "&status=" + encodeURIComponent(docView.status) +
        "&sort=" + encodeURIComponent(docView.sort) +
        "&customerId=" + encodeURIComponent(docView.customerId) +
        (docView.from ? "&from=" + encodeURIComponent(docView.from) : "") +
        (docView.to ? "&to=" + encodeURIComponent(docView.to) : "") +
        "&page=" + encodeURIComponent(docView.page);
      d = await api("GET", "/admin/invoices" + qs);
    } catch (err) {
      if (mine !== docSeq) return;
      body.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-documents="1">Try again</button>';
      return;
    }
    if (mine !== docSeq) return;

    docView.page = d.page;
    fillSelect(document.getElementById("doc-type"), d.options.types, d.type);
    fillSelect(document.getElementById("doc-status"), d.options.statuses, d.status);
    fillSelect(document.getElementById("doc-sort"), d.options.sorts, d.sort);
    fillSelect(document.getElementById("doc-customer"),
      [{ key: "", label: "All customers" }].concat(
        (d.options.customers || []).map(c => ({ key: c.id, label: c.name + " (" + c.n + ")" }))),
      d.customerId);
    const dFrom = document.getElementById("doc-from"), dTo = document.getElementById("doc-to");
    if (dFrom) dFrom.value = d.from || "";
    if (dTo) dTo.value = d.to || "";

    body.innerHTML = invoiceListHtml(d);
  }

  function invoiceListHtml(d) {
    if (!d.total) {
      const filtered = d.q || d.type !== "all" || d.status !== "all" ||
                       d.customerId || d.from || d.to;
      return filtered
        ? emptyLine("No document matches those filters.") +
          '<button type="button" class="adm-retry" data-clear-documents="1">Clear search and filters</button>'
        : emptyLine("No invoices or challans have been raised yet.");
    }

    const from = (d.page - 1) * d.pageSize + 1;
    const to = from + d.rows.length - 1;

    const head =
      '<div class="adm-tbl-head adm-tbl-doc" aria-hidden="true">' +
        '<span>Document</span><span>Customer</span><span>Date</span><span>Due</span>' +
        '<span class="adm-num">Amount</span><span class="adm-num">Outstanding</span>' +
        '<span>Status</span>' +
      "</div>";

    const rows = d.rows.map(r => {
      /* A challan has no money on it, so it gets its goods value and a
         label saying which it is, never a rupee total. */
      const amount = r.isChallan
        ? '<span class="adm-muted">' + money(r.goodsValue) + " goods</span>"
        : money(r.total);

      /* THE SHOP'S OWN WORD for the state, sent by the server from the
         same deriveDocStatus() the billing screen uses. This used to be
         five labels invented here — "Settled", "Outstanding", "Not yet
         billed" — which meant one bill could be described two different
         ways depending on which screen you were looking at.
         Overdue is not a status in that vocabulary; it is a fact about a
         Pending one, so it is shown beside the status rather than
         replacing it. */
      const state = r.status || "";
      const cls = DOC_STATE_TONE[state] || "is-info";

      return '<a class="adm-tbl-row adm-tbl-doc' + (r.voided ? " is-voided" : "") +
             '" href="' + docHref(r.id) + '">' +
        '<span class="adm-cell adm-cell-name">' +
          '<span class="adm-strong">' + esc(r.no) + "</span>" +
          '<span class="adm-row-sub">' +
            (r.isChallan ? "Delivery challan" : "Tax invoice") +
            " · " + num(r.lines) + " line(s)</span>" +
        "</span>" +
        '<span class="adm-cell" data-h="Customer">' +
          (r.customer ? esc(r.customer) : '<span class="adm-muted">—</span>') + "</span>" +
        '<span class="adm-cell" data-h="Date">' + esc(showDate(r.date)) + "</span>" +
        '<span class="adm-cell" data-h="Due">' +
          (r.dueDate
            ? (r.overdue ? '<span class="adm-over">' + esc(showDate(r.dueDate)) + "</span>"
                         : esc(showDate(r.dueDate)))
            : '<span class="adm-muted">—</span>') + "</span>" +
        '<span class="adm-cell adm-num" data-h="Amount">' + amount +
          /* Subtotal, discount and tax under the total rather than as
             three more columns. Eleven columns is not a table anybody
             reads; this is the same information where the eye already
             is, and it folds away on a phone with everything else. */
          /* Only when it says something the total does not. With no
             discount and no tax the breakdown is the total written
             twice, which reads as a mistake rather than as detail. */
          (r.subtotal !== null && r.subtotal !== undefined && (r.discount || r.tax)
            ? '<span class="adm-breakdown">' + money(r.subtotal) +
              (r.discount ? " − " + money(r.discount) : "") +
              (r.tax ? " + " + money(r.tax) + " tax" : "") + "</span>"
            : "") +
        "</span>" +
        '<span class="adm-cell adm-num" data-h="Outstanding">' +
          (r.balanceDue > 0 ? '<span class="adm-over">' + money(r.balanceDue) + "</span>"
                            : '<span class="adm-muted">—</span>') + "</span>" +
        '<span class="adm-cell" data-h="Status">' +
          '<span class="adm-pip ' + cls + '" aria-hidden="true"></span>' + esc(state) +
          (r.overdue ? ' <span class="adm-over">overdue</span>' : "") + "</span>" +
      "</a>";
    }).join("");

    const pager = d.pages > 1
      ? '<div class="adm-pager">' +
          '<button type="button" class="adm-retry" data-page="' + (d.page - 1) + '"' +
            (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
          '<span class="adm-pager-at">' + num(from) + "–" + num(to) +
            " of " + num(d.total) + "</span>" +
          '<button type="button" class="adm-retry" data-page="' + (d.page + 1) + '"' +
            (d.page >= d.pages ? " disabled" : "") + ">Next</button>" +
        "</div>"
      : "";

    /* The totals for everything the filter matched, not just this page. */
    const totals = '<p class="adm-foot">' + num(d.total) + " document(s) matched · " +
      money(d.matched.money) + " billed" +
      (d.matched.due > 0 ? " · " + money(d.matched.due) + " still outstanding" : "") +
      ". Cancelled documents are shown but never counted.</p>";

    return '<div class="adm-tbl">' + head + rows + "</div>" + pager + totals;
  }

  /* ---- one document -------------------------------------------------- */

  async function renderDocument(id) {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<a class="adm-back" href="#/invoices">&larr; All invoices</a>' +
          '<h1 class="adm-page-title" id="doc-title">Document</h1>' +
        "</div>" +
      "</div>" +
      '<div id="doc-body"><div class="adm-panel"><div class="adm-panel-body">' +
        skeleton() + "</div></div></div>";

    const host = document.getElementById("doc-body");
    let d;
    try {
      d = await api("GET", "/admin/invoices/" + encodeURIComponent(id));
    } catch (err) {
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<a class="adm-retry" href="#/invoices">Back to all invoices</a>' +
        "</div></div>";
      return;
    }
    paintDocument(host, d);
  }

  function paintDocument(host, d) {
    const doc = d.document, m = d.money;

    const title = document.getElementById("doc-title");
    if (title) title.textContent = doc.no;
    el.crumbHere.textContent = doc.no;

    const lines = d.items.map(it =>
      '<li class="adm-row adm-line">' +
        '<span class="adm-row-main">' + esc(it.name) +
          (it.size ? ' <span class="adm-muted">' + esc(it.size) + "</span>" : "") + "</span>" +
        '<span class="adm-row-sub">' +
          num(it.qty) + (it.unit ? " " + esc(it.unit) : "") +
          " × " + money(it.rate) +
          (it.discountPct ? " · less " + num(it.discountPct) + "%" : "") +
          (it.pieces ? " · " + num(it.pieces) + " piece(s)" : "") +
          (it.hsn ? " · HSN " + esc(it.hsn) : "") +
        "</span>" +
        '<span class="adm-row-fig">' + money(it.value) + "</span>" +
      "</li>").join("");

    const pays = d.payments.map(p =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(p.method || "Payment") + "</span>" +
        '<span class="adm-row-sub">' + esc(showDate(p.date)) +
          (p.reference ? " · " + esc(p.reference) : "") + "</span>" +
        '<span class="adm-row-fig">' + money(p.amount) + "</span>" +
      "</li>").join("");

    const rets = d.returns.map(r =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(r.no) + "</span>" +
        '<span class="adm-row-sub">' + esc(showDate(r.date)) +
          (r.reason ? " · " + esc(r.reason) : "") + "</span>" +
        '<span class="adm-row-fig">' + money(r.total) + "</span>" +
      "</li>").join("");

    /* The money block, straight off the document. Nothing is re-derived
       here: a panel that recomputes a total will eventually disagree
       with the paper the customer is holding. */
    const totals = m ? [
      ["Subtotal", money(m.subtotal)],
      m.discount ? ["Discount", "− " + money(m.discount)] : null,
      m.cgst ? ["CGST", money(m.cgst)] : null,
      m.sgst ? ["SGST", money(m.sgst)] : null,
      m.igst ? ["IGST", money(m.igst)] : null,
      m.transport ? ["Transport", money(m.transport)] : null,
      m.loading ? ["Loading", money(m.loading)] : null,
      m.roundOff ? ["Rounding", money(m.roundOff)] : null,
      ["Total", '<strong>' + money(m.total) + "</strong>"],
      m.advance ? ["Advance paid", money(m.advance)] : null,
      ["Outstanding", m.balanceDue > 0
        ? '<span class="adm-over">' + money(m.balanceDue) + "</span>"
        : '<span class="adm-muted">nothing due</span>'],
    ].filter(Boolean).map(r =>
      '<div class="adm-kv"><span class="adm-kv-k">' + r[0] +
      '</span><span class="adm-kv-v adm-num">' + r[1] + "</span></div>").join("") : "";

    host.innerHTML =
      '<div class="adm-profile-head">' +
        '<span class="adm-status">' +
          '<span class="adm-pip ' + (doc.voided ? "is-info" : (doc.isChallan ? "is-warn" : "is-ok")) +
          '" aria-hidden="true"></span>' +
          (doc.voided ? "Cancelled" : (doc.isChallan ? "Delivery challan" : "Tax invoice")) +
        "</span>" +
        '<span class="adm-doc-date">' + esc(showDate(doc.date)) + "</span>" +
      "</div>" +

      (doc.voided
        ? '<p class="adm-notice">This document was cancelled. It is kept because the number ' +
          'was issued, and it is never counted in any figure.</p>' : "") +

      '<div class="adm-grid">' +
        '<section class="adm-panel" data-panel="info"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Document</h2></header>' +
          '<div class="adm-panel-body">' +
            [["Number", '<code class="adm-code">' + esc(doc.no) + "</code>"],
             ["Date", esc(showDate(doc.date))],
             doc.dueDate ? ["Due", esc(showDate(doc.dueDate))] : null,
             ["Customer", d.customer.name
               ? '<a href="' + custHref(d.customer.id) + '">' + esc(d.customer.name) + "</a>"
               : "—"],
             d.customer.phone ? ["Phone", esc(d.customer.phone)] : null,
             d.customer.gst ? ["GSTIN", esc(d.customer.gst)] : null,
             doc.paymentMethod ? ["Payment", esc(doc.paymentMethod)] : null,
             /* Only where it says something the Totals panel does not —
                on a challan, which has no subtotal at all. Two names for
                one number invites "why do these not match?" when they do. */
             (!m || Math.abs(d.goodsValue - m.subtotal) > 0.5)
               ? ["Goods value", money(d.goodsValue)] : null,
            ].filter(Boolean).map(r =>
              '<div class="adm-kv"><span class="adm-kv-k">' + r[0] +
              '</span><span class="adm-kv-v">' + r[1] + "</span></div>").join("") +
          "</div></section>" +

        '<section class="adm-panel" data-panel="summary"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">' + (m ? "Totals" : "No money on this document") +
          "</h2></header>" +
          '<div class="adm-panel-body">' +
            (m ? totals
               : emptyLine("A delivery challan carries goods out of the shop but no rates, " +
                           "GST or total. The goods on this one are worth " +
                           money(d.goodsValue) + ".")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="sizes"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Items</h2></header>' +
          '<div class="adm-panel-body">' +
            (lines ? '<ul class="adm-list">' + lines + "</ul>"
                   : emptyLine("This document has no lines.")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="pays"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Payments against this document</h2></header>' +
          '<div class="adm-panel-body">' +
            (pays ? '<ul class="adm-list">' + pays + "</ul>"
                  : emptyLine("No payment is recorded against this document.")) +
            '<p class="adm-foot">A customer can also pay on account rather than against a ' +
            'bill, so this is not necessarily everything they have paid. Their full ledger ' +
            'is on the customer page.</p>' +
          "</div></section>" +

        (rets
          ? '<section class="adm-panel" data-panel="history"><header class="adm-panel-head">' +
            '<h2 class="adm-panel-title">Returns against this document</h2></header>' +
            '<div class="adm-panel-body"><ul class="adm-list">' + rets + "</ul></div></section>"
          : "") +
      "</div>";
  }

  /* ==================================================================
     SALES
     ================================================================== */

  function renderSales() {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Sales</h1>' +
          '<p class="adm-page-sub">What the shop sold over a period. Priced tax invoices ' +
          'only &mdash; a delivery challan carries goods but no money, and is reported ' +
          'separately rather than counted.</p>' +
        "</div>" +
      "</div>" +
      '<div class="adm-toolbar">' +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="sales-from">From</label>' +
          '<input type="date" id="sales-from" class="adm-input">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="sales-to">To</label>' +
          '<input type="date" id="sales-to" class="adm-input">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="sales-apply">&nbsp;</label>' +
          '<button type="button" class="adm-primary" id="sales-apply">Show</button>' +
        "</div>" +
      "</div>" +
      '<div id="sales-body">' + skeleton() + "</div>";

    document.getElementById("sales-apply").addEventListener("click", function () {
      salesWindow.from = document.getElementById("sales-from").value;
      salesWindow.to = document.getElementById("sales-to").value;
      loadSales();
    });
    document.getElementById("sales-body").addEventListener("click", function (e) {
      if (e.target.closest("[data-retry-sales]")) loadSales();
    });

    loadSales();
  }

  async function loadSales() {
    const host = document.getElementById("sales-body");
    if (!host) return;
    host.innerHTML = skeleton();

    let d;
    try {
      const qs = [];
      if (salesWindow.from) qs.push("from=" + encodeURIComponent(salesWindow.from));
      if (salesWindow.to) qs.push("to=" + encodeURIComponent(salesWindow.to));
      d = await api("GET", "/admin/sales" + (qs.length ? "?" + qs.join("&") : ""));
    } catch (err) {
      host.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-sales="1">Try again</button>';
      return;
    }

    /* The window the server actually used, echoed back into the pickers
       so they never disagree with the figures beneath them. */
    const f = document.getElementById("sales-from"), t = document.getElementById("sales-to");
    if (f && !f.value) f.value = d.window.from;
    if (t && !t.value) t.value = d.window.to;

    if (!d.hasAnySales) {
      host.innerHTML = '<div class="adm-panel"><div class="adm-panel-body">' +
        emptyLine("No sales have been recorded yet. This fills in once the first bill is raised.") +
        "</div></div>";
      return;
    }

    const products = d.topProducts.map(p =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(p.name) + "</span>" +
        '<span class="adm-row-sub">' + num(p.units) + " piece(s)</span>" +
        '<span class="adm-row-fig">' + money(p.value) + "</span>" +
      "</li>").join("");

    const customers = d.topCustomers.map(c =>
      '<li class="adm-row">' +
        '<span class="adm-row-main"><a href="' + custHref(c.id) + '">' + esc(c.name) + "</a></span>" +
        '<span class="adm-row-sub">' + num(c.bills) + " bill(s)</span>" +
        '<span class="adm-row-fig">' + money(c.value) + "</span>" +
      "</li>").join("");

    const methods = d.byMethod.map(x =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(x.method) + "</span>" +
        '<span class="adm-row-sub">' + num(x.bills) + " bill(s)</span>" +
        '<span class="adm-row-fig">' + money(x.value) + "</span>" +
      "</li>").join("");

    /* The daily series, reusing the dashboard's chart. */
    const series = d.byDay.map(x => ({
      date: x.date, total: x.total, bills: x.bills,
      label: new Date(x.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short" }),
    }));

    host.innerHTML =
      '<div class="adm-grid">' +
        '<section class="adm-panel" data-panel="overview"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">' + esc(showDate(d.window.from)) + " to " +
          esc(showDate(d.window.to)) + "</h2></header>" +
          '<div class="adm-panel-body">' +
            '<div class="adm-tiles">' +
              tile("Sold", money(d.money),
                   d.change === null
                     ? "nothing sold in the " + num(d.window.days) +
                       " days before, so there is nothing to compare"
                     : deltaHtml(d.change) + " on the " + num(d.window.days) + " days before") +
              tile("Bills", num(d.bills), num(d.customersBilled) + " customer(s)") +
              tile("Average bill", d.averageBill === null ? "—" : money(d.averageBill)) +
              tile("GST charged", money(d.tax.total),
                   d.tax.igst ? "including IGST" : "CGST + SGST") +
              tile("Discount given", money(d.tax.discount)) +
              tile("Cancelled", num(d.voidedBills), "bill(s), not counted above") +
            "</div>" +
            (series.length ? chartHtml(series) : "") +
            (d.unbilledChallans.count
              ? '<p class="adm-foot adm-over">' + num(d.unbilledChallans.count) +
                " delivery challan(s) worth " + money(d.unbilledChallans.worth) +
                " went out in this period and have not been billed. Not counted above.</p>"
              : "") +
            (d.returns && d.returns.n
              ? '<p class="adm-foot">' + num(d.returns.n) + " sales return(s) worth " +
                money(d.returns.value) + " in this period.</p>"
              : "") +
          "</div></section>" +

        '<section class="adm-panel" data-panel="docs"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Best sellers</h2></header>' +
          '<div class="adm-panel-body">' +
            (products ? '<ul class="adm-list">' + products + "</ul>"
                      : emptyLine("Nothing sold in this period.")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="pays"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Biggest customers</h2></header>' +
          '<div class="adm-panel-body">' +
            (customers ? '<ul class="adm-list">' + customers + "</ul>"
                       : emptyLine("No customer was billed in this period.")) +
          "</div></section>" +

        '<section class="adm-panel" data-panel="activity"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">How they paid</h2></header>' +
          '<div class="adm-panel-body">' +
            (methods ? '<ul class="adm-list">' + methods + "</ul>"
                     : emptyLine("No bills in this period.")) +
            '<p class="adm-foot">The method recorded on the bill, which is not the same as ' +
            'money actually received — a credit sale records its terms here.</p>' +
          "</div></section>" +
      "</div>";
  }

  /* ==================================================================
     USERS, ROLES & PERMISSIONS

     A user here is a staff row — the same row the till signs in
     against. Nothing on this screen is a second account system.

     Everything it can change is owner-only on the server. The buttons
     below are hidden from anyone who may not use them, but that is
     tidiness: the server refuses regardless, and the tests say so.
     ================================================================== */

  let userView = { q: "", filter: "all", sort: "name", page: 1 };
  let userSeq = 0;

  const ROLE_TONE = { OWNER: "is-ok", ADMIN: "is-warn", SUPPORT: "is-info" };

  function roleBadge(role) {
    if (!role) return '<span class="adm-muted">No admin access</span>';
    return '<span class="adm-badge ' + (ROLE_TONE[role] || "is-info") + '">' +
      esc(role) + "</span>";
  }

  function userHref(id) { return id ? "#/users/" + encodeURIComponent(id) : "#/users"; }

  /* ---- the user list ------------------------------------------------ */

  function renderUsers(id) {
    if (id) return renderUserProfile(id);

    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Users</h1>' +
          '<p class="adm-page-sub">Everyone who can sign in to Shop Manager, and who among ' +
          'them may open this panel. Accounts are created in Shop Manager under Staff ' +
          '&mdash; this is where admin access is given and taken away.</p>' +
        "</div>" +
      "</div>" +
      '<div class="adm-toolbar">' +
        '<div class="adm-field adm-field-grow">' +
          '<label class="adm-sr" for="usr-q">Search users</label>' +
          '<input type="search" id="usr-q" class="adm-input" autocomplete="off" ' +
          'placeholder="Name, login id or job title">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="usr-filter">Show</label>' +
          '<select id="usr-filter" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="usr-sort">Sort by</label>' +
          '<select id="usr-sort" class="adm-input"></select>' +
        "</div>" +
      "</div>" +
      '<div class="adm-panel"><div class="adm-panel-body" id="usr-body">' +
        skeleton() + "</div></div>";

    const q = document.getElementById("usr-q");
    q.value = userView.q;
    let timer = null;
    q.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        userView.q = q.value.trim(); userView.page = 1; loadUsers();
      }, 250);
    });

    [["usr-filter", "filter"], ["usr-sort", "sort"]].forEach(pair => {
      document.getElementById(pair[0]).addEventListener("change", function (e) {
        userView[pair[1]] = e.target.value; userView.page = 1; loadUsers();
      });
    });

    document.getElementById("usr-body").addEventListener("click", function (e) {
      const page = e.target.closest("[data-page]");
      if (page) { userView.page = Number(page.dataset.page); loadUsers(); return; }
      if (e.target.closest("[data-retry-users]")) loadUsers();
    });

    loadUsers();
  }

  async function loadUsers() {
    const body = document.getElementById("usr-body");
    if (!body) return;
    body.innerHTML = skeleton();

    const mine = ++userSeq;
    let d;
    try {
      d = await api("GET", "/admin/users?q=" + encodeURIComponent(userView.q) +
        "&filter=" + encodeURIComponent(userView.filter) +
        "&sort=" + encodeURIComponent(userView.sort) +
        "&page=" + encodeURIComponent(userView.page));
    } catch (err) {
      if (mine !== userSeq) return;
      body.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-users="1">Try again</button>';
      return;
    }
    if (mine !== userSeq) return;

    userView.page = d.page;
    fillSelect(document.getElementById("usr-filter"), d.options.filters, d.filter);
    fillSelect(document.getElementById("usr-sort"), d.options.sorts, d.sort);

    if (!d.total) {
      body.innerHTML = emptyLine(userView.q || userView.filter !== "all"
        ? "No user matches that search."
        : "No staff accounts yet.");
      return;
    }

    const head =
      '<div class="adm-tbl-head adm-tbl-user" aria-hidden="true">' +
        '<span>Name</span><span>Admin role</span><span>Status</span>' +
        '<span>Added</span><span>Last active</span>' +
      "</div>";

    const rows = d.rows.map(u =>
      '<a class="adm-tbl-row adm-tbl-user" href="' + userHref(u.id) + '">' +
        '<span class="adm-cell adm-cell-name">' +
          '<span class="adm-strong">' + esc(u.name) + "</span>" +
          '<span class="adm-row-sub">' +
            [u.jobRole, u.loginId].filter(Boolean).map(esc).join(" · ") +
            (u.isOwner ? (u.jobRole || u.loginId ? " · " : "") + "shop owner" : "") +
          "</span>" +
        "</span>" +
        '<span class="adm-cell" data-h="Admin role">' + roleBadge(u.adminRole) + "</span>" +
        '<span class="adm-cell" data-h="Status">' +
          '<span class="adm-pip ' + (u.active ? "is-ok" : "is-bad") + '" aria-hidden="true"></span>' +
          (u.active ? "Active" : "Disabled") + "</span>" +
        '<span class="adm-cell" data-h="Added">' + esc(showDate(u.created)) + "</span>" +
        '<span class="adm-cell" data-h="Last active">' +
          (u.lastActive ? esc(showDate(u.lastActive))
                        : '<span class="adm-muted">never</span>') + "</span>" +
      "</a>").join("");

    const from = (d.page - 1) * d.pageSize + 1;
    const pager = d.pages > 1
      ? '<div class="adm-pager">' +
          '<button type="button" class="adm-retry" data-page="' + (d.page - 1) + '"' +
            (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
          '<span class="adm-pager-at">' + num(from) + "–" +
            num(from + d.rows.length - 1) + " of " + num(d.total) + "</span>" +
          '<button type="button" class="adm-retry" data-page="' + (d.page + 1) + '"' +
            (d.page >= d.pages ? " disabled" : "") + ">Next</button>" +
        "</div>"
      : '<p class="adm-foot">' + num(d.total) +
        (d.total === 1 ? " user." : " users.") + "</p>";

    body.innerHTML = '<div class="adm-tbl">' + head + rows + "</div>" + pager;
  }

  /* ---- one user ----------------------------------------------------- */

  async function renderUserProfile(id) {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<a class="adm-back" href="#/users">&larr; All users</a>' +
          '<h1 class="adm-page-title" id="usr-title">User</h1>' +
        "</div>" +
      "</div>" +
      '<div id="usr-profile"><div class="adm-panel"><div class="adm-panel-body">' +
        skeleton() + "</div></div></div>";

    const host = document.getElementById("usr-profile");
    let d;
    try {
      d = await api("GET", "/admin/users/" + encodeURIComponent(id));
    } catch (err) {
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<a class="adm-retry" href="#/users">Back to all users</a>' + "</div></div>";
      return;
    }
    paintUserProfile(host, d);
  }

  function paintUserProfile(host, d) {
    const u = d.user;
    const title = document.getElementById("usr-title");
    if (title) title.textContent = u.name;
    el.crumbHere.textContent = u.name;

    /* Nothing about a password or a PIN appears anywhere on this page —
       there is no field for it and the server does not send one. */
    const info = [
      ["Name", esc(u.name)],
      u.loginId ? ["Login id", esc(u.loginId)] : null,
      u.jobRole ? ["Job title", esc(u.jobRole)] : null,
      ["Shop role", u.isOwner ? "Owner" : "Staff"],
      ["Admin role", roleBadge(u.adminRole)],
      ["Status", u.active ? "Active" : "Disabled"],
      u.dataScope ? ["Data they can see", esc(u.dataScope)] : null,
      ["User ID", '<code class="adm-code">' + esc(u.id) + "</code>"],
      ["Added", esc(showDate(u.created))],
      ["Last active", d.activity.lastActive ? esc(showDate(d.activity.lastActive)) : "never"],
    ].filter(Boolean).map(r =>
      '<div class="adm-kv"><span class="adm-kv-k">' + r[0] +
      '</span><span class="adm-kv-v">' + r[1] + "</span></div>").join("");

    /* What their role actually grants, grouped by resource. Worked out
       by the server the same way a request is judged, so this cannot
       describe access the server would refuse. */
    const byResource = {};
    (d.permissions || []).forEach(cap => {
      const res = cap.split(".")[0];
      if (!byResource[res]) byResource[res] = [];
      byResource[res].push(cap.split(".").slice(1).join("."));
    });
    const perms = Object.keys(byResource).sort().map(res =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(res) + "</span>" +
        '<span class="adm-row-sub">' + byResource[res].map(esc).join(", ") + "</span>" +
      "</li>").join("");

    const recent = d.activity.recent.map(a =>
      '<li class="adm-row">' +
        '<span class="adm-row-main">' + esc(a.action) + "</span>" +
        '<span class="adm-row-sub">' + esc(showDate(a.when)) +
          (a.details ? " · " + esc(a.details) : "") + "</span>" +
      "</li>").join("");

    /* The owner's row is read-only here, and says why rather than
       simply having nothing on it. */
    const actions = u.isOwner
      ? '<p class="adm-notice">This is the shop owner. Their role and their account ' +
        'cannot be changed from the admin panel &mdash; ownership is held in Shop Manager, ' +
        'and the column that carries admin roles cannot hold it.</p>'
      : (d.canManage === false
          ? ""
          : '<div class="adm-profile-actions">' +
              '<button type="button" class="adm-retry" data-set-role="ADMIN">Make ADMIN</button>' +
              '<button type="button" class="adm-retry" data-set-role="SUPPORT">Make SUPPORT</button>' +
              '<button type="button" class="adm-retry" data-set-role="">Remove admin access</button>' +
              '<button type="button" class="adm-retry" data-set-active="' +
                (u.active ? "0" : "1") + '">' +
                (u.active ? "Disable account" : "Enable account") + "</button>" +
            "</div>");

    host.innerHTML =
      '<div class="adm-profile-head">' +
        '<span class="adm-status">' +
          '<span class="adm-pip ' + (u.active ? "is-ok" : "is-bad") + '" aria-hidden="true"></span>' +
          (u.active ? "Active" : "Disabled") + "</span>" +
        "</div>" +
      actions +
      '<div class="adm-grid">' +
        '<section class="adm-panel" data-panel="info"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">User</h2></header>' +
          '<div class="adm-panel-body">' + info + "</div></section>" +

        '<section class="adm-panel" data-panel="summary"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">What this role grants</h2></header>' +
          '<div class="adm-panel-body">' +
            (perms ? '<ul class="adm-list">' + perms + "</ul>" +
              '<p class="adm-foot">Inherited from the ' + esc(d.role) + ' role. Change it ' +
              'for everyone under Roles &amp; Permissions.</p>'
                   : emptyLine("No admin panel access, so no permissions.")) +
            (d.shopPermissionModules
              ? '<p class="adm-foot">Separately, this person has shop-floor permissions on ' +
                num(d.shopPermissionModules) + ' module(s) &mdash; billing, cash book and the ' +
                'rest. Those are set in Shop Manager under Staff Access, not here.</p>'
              : "") +
          "</div></section>" +

        '<section class="adm-panel" data-panel="activity"><header class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Recent activity</h2></header>' +
          '<div class="adm-panel-body">' +
            (recent ? '<ul class="adm-list">' + recent + "</ul>" +
              '<p class="adm-foot">The last ' + num(d.activity.recent.length) + ' of ' +
              num(d.activity.actions) + ' recorded action(s).</p>'
                    : emptyLine("Nothing recorded for this person yet.")) +
          "</div></section>" +
      "</div>";

    host.addEventListener("click", async function (e) {
      const roleBtn = e.target.closest("[data-set-role]");
      if (roleBtn) return changeUserRole(u, roleBtn.dataset.setRole || null);
      const activeBtn = e.target.closest("[data-set-active]");
      if (activeBtn) return changeUserActive(u, activeBtn.dataset.setActive === "1");
    });
  }

  async function changeUserRole(u, role) {
    const what = role ? "give " + u.name + " " + role + " access to the admin panel"
                      : "remove " + u.name + "'s admin panel access";
    if (!window.confirm("Are you sure you want to " + what + "?\n\n" +
        "It takes effect immediately, including for anyone already signed in.")) return;
    try {
      await api("PATCH", "/admin/users/" + encodeURIComponent(u.id) + "/role",
                { adminRole: role });
    } catch (err) { toast(humanError(err)); return; }
    toast(role ? "Role updated." : "Admin access removed.", "ok");
    renderUserProfile(u.id);
  }

  async function changeUserActive(u, active) {
    const ask = active
      ? "Enable " + u.name + "'s account?"
      : "Disable " + u.name + "'s account? They will not be able to sign in. " +
        "Nothing they have already done is removed — their name stays on every " +
        "invoice, cash entry and audit line, and this can be undone.";
    if (!window.confirm(ask)) return;
    try {
      await api("PATCH", "/admin/users/" + encodeURIComponent(u.id) + "/active", { active });
    } catch (err) { toast(humanError(err)); return; }
    toast(active ? "Account enabled." : "Account disabled.", "ok");
    renderUserProfile(u.id);
  }

  /* ==================================================================
     ROLES & PERMISSIONS
     ================================================================== */

  let roleDraft = null;

  async function renderRoles() {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Roles &amp; Permissions</h1>' +
          '<p class="adm-page-sub">What each role may do in this panel. Every permission ' +
          'here is checked on the server for every request &mdash; unticking a box does not ' +
          'merely hide a button.</p>' +
        "</div>" +
      "</div>" +
      '<div id="roles-body">' + skeleton() + "</div>";

    const host = document.getElementById("roles-body");
    let d;
    try {
      d = await api("GET", "/admin/users/roles");
    } catch (err) {
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-roles="1">Try again</button>' +
        "</div></div>";
      host.addEventListener("click", function (e) {
        if (e.target.closest("[data-retry-roles]")) renderRoles();
      });
      return;
    }
    paintRoles(host, d);
  }

  function paintRoles(host, d) {
    const held = {};
    d.roles.forEach(r => { held[r.key] = new Set(r.caps); });
    roleDraft = { ADMIN: new Set(held.ADMIN || []), SUPPORT: new Set(held.SUPPORT || []) };

    const changedBy = {};
    (d.changed || []).forEach(c => { changedBy[c.role + "|" + c.cap] = c; });

    const groups = d.catalogue.map(g => {
      const rows = g.caps.map(c => {
        const cell = role => {
          const on = held[role] && held[role].has(c.cap);
          const editable = role !== "OWNER";
          const altered = !!changedBy[role + "|" + c.cap];
          if (!editable) {
            return '<span class="adm-perm' + (on ? " is-on" : "") + '" aria-hidden="true">' +
              "</span>";
          }
          return '<label class="adm-perm-box' + (altered ? " is-altered" : "") + '">' +
            '<input type="checkbox" data-role="' + role + '" data-cap="' + esc(c.cap) + '"' +
            (on ? " checked" : "") + '>' +
            '<span class="adm-sr">' + esc(role) + " " + esc(c.cap) + "</span></label>";
        };
        return '<div class="adm-perm-row">' +
          '<span class="adm-perm-name">' + esc(c.action) +
            '<span class="adm-perm-cap">' + esc(c.cap) + "</span></span>" +
          '<span class="adm-perm-cell">' + cell("OWNER") + "</span>" +
          '<span class="adm-perm-cell">' + cell("ADMIN") + "</span>" +
          '<span class="adm-perm-cell">' + cell("SUPPORT") + "</span>" +
        "</div>";
      }).join("");

      return '<section class="adm-panel" data-panel="perm"><header class="adm-panel-head">' +
        '<h2 class="adm-panel-title">' + esc(g.resource) + "</h2></header>" +
        '<div class="adm-panel-body">' +
          '<div class="adm-perm-head" aria-hidden="true">' +
            "<span></span><span>Owner</span><span>Admin</span><span>Support</span>" +
          "</div>" + rows +
        "</div></section>";
    }).join("");

    host.innerHTML =
      '<div class="adm-roles-head">' +
        d.roles.map(r =>
          '<div class="adm-role-card">' +
            roleBadge(r.key) +
            '<span class="adm-role-count">' + num(r.caps.length) + " permission(s)</span>" +
            (r.editable ? "" : '<span class="adm-why">Holds everything, always.</span>') +
          "</div>").join("") +
      "</div>" +
      '<div class="adm-grid">' + groups + "</div>" +
      '<div class="adm-save-bar">' +
        '<button type="button" class="adm-primary" id="roles-save">Save permissions</button>' +
        '<button type="button" class="adm-retry" id="roles-reset">Discard changes</button>' +
        '<span class="adm-why" id="roles-msg">The owner’s column cannot be changed: ' +
        'a permission the owner could lose is one that could lock the shop out of its own panel.</span>' +
      "</div>";

    host.addEventListener("change", function (e) {
      const box = e.target.closest("input[type=checkbox][data-role]");
      if (!box) return;
      const set = roleDraft[box.dataset.role];
      if (!set) return;
      if (box.checked) set.add(box.dataset.cap); else set.delete(box.dataset.cap);
    });

    document.getElementById("roles-reset").addEventListener("click", renderRoles);
    document.getElementById("roles-save").addEventListener("click", async function () {
      const msg = document.getElementById("roles-msg");
      msg.textContent = "Saving…";
      try {
        /* Every known capability is sent with its intended state, so the
           server can clear an override that is back to the default
           rather than only ever adding them. */
        for (const role of ["ADMIN", "SUPPORT"]) {
          const caps = {};
          d.catalogue.forEach(g => g.caps.forEach(c => {
            caps[c.cap] = roleDraft[role].has(c.cap);
          }));
          await api("PUT", "/admin/users/roles/" + role, { caps });
        }
      } catch (err) { msg.textContent = humanError(err); return; }
      toast("Permissions saved.", "ok");
      renderRoles();
    });
  }

  /* ==================================================================
     AUDIT LOGS — PART 10

     The one screen in this panel that can only read. There is no edit
     control, no delete control and no bulk action, because an audit log
     that this page could change would not be evidence of anything —
     and the server would refuse anyway: the routes are GET only and a
     database trigger makes an UPDATE impossible.

     WHAT IS FILTERED WHERE. Everything, on the server. Nine filters, a
     search, a sort and the paging all go into the query string and come
     back as a page of 25. Nothing is narrowed in the browser, because a
     page filtered here would disagree with its own count and quietly
     hide the matches that were never fetched.

     THE DROPDOWNS ARE FETCHED ONCE, when the screen opens, and kept —
     building them costs a GROUP BY over the whole log, which is about
     240ms per list at a million events. Paying that on every keystroke
     is the difference between a screen that responds and one that
     thinks.
     ================================================================== */
  const SEV_TONE = {
    critical: "is-bad",
    warning:  "is-warn",
    notice:   "is-info",
    info:     "is-info",
  };

  const RESULT_TONE = { SUCCESS: "is-ok", FAILURE: "is-bad", DENIED: "is-warn" };

  const BLANK_AUDIT = {
    q: "", sort: "recent", from: "", to: "", actor: "", actorType: "",
    action: "", resource: "", resourceId: "", result: "", severity: "", page: 1,
  };

  let audView = Object.assign({}, BLANK_AUDIT);
  let audSeq = 0;
  /* Fetched once per screen open; null until then. */
  let audOptions = null;

  function audHref(id) {
    return id ? "#/audit/" + encodeURIComponent(id) : "#/audit";
  }

  function renderAudit(id) {
    if (id) return renderAuditEvent(id);

    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">Audit Logs</h1>' +
          '<p class="adm-page-sub">Every recorded action, by whom and when. ' +
          'Read-only and append-only &mdash; an event cannot be edited or ' +
          'deleted here, and the shop app records them whether or not this ' +
          'screen is open.</p>' +
        "</div>" +
      "</div>" +
      '<div class="adm-toolbar">' +
        '<div class="adm-field adm-field-grow">' +
          '<label class="adm-sr" for="aud-q">Search the audit log</label>' +
          '<input type="search" id="aud-q" class="adm-input" autocomplete="off" ' +
          'placeholder="Person, action, record, or event id">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-from">From</label>' +
          '<input type="date" id="aud-from" class="adm-input">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-to">To</label>' +
          '<input type="date" id="aud-to" class="adm-input">' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-actor">Person</label>' +
          '<select id="aud-actor" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-actorType">Kind of actor</label>' +
          '<select id="aud-actorType" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-action">Action</label>' +
          '<select id="aud-action" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-resource">Record type</label>' +
          '<select id="aud-resource" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-severity">Importance</label>' +
          '<select id="aud-severity" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-result">Outcome</label>' +
          '<select id="aud-result" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-sort">Sort by</label>' +
          '<select id="aud-sort" class="adm-input"></select>' +
        "</div>" +
        '<div class="adm-field">' +
          '<label class="adm-field-label" for="aud-clear">&nbsp;</label>' +
          '<button type="button" class="adm-retry" id="aud-clear">Clear filters</button>' +
        "</div>" +
      "</div>" +
      '<div class="adm-panel"><div class="adm-panel-body" id="aud-list">' +
        skeleton() + "</div></div>";

    const q = document.getElementById("aud-q");
    q.value = audView.q;
    let timer = null;
    q.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        audView.q = q.value.trim(); audView.page = 1; loadAudit();
      }, 250);
    });
    q.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault(); clearTimeout(timer);
      audView.q = q.value.trim(); audView.page = 1; loadAudit();
    });

    [["aud-from", "from"], ["aud-to", "to"], ["aud-actor", "actor"],
     ["aud-actorType", "actorType"], ["aud-action", "action"],
     ["aud-resource", "resource"], ["aud-severity", "severity"],
     ["aud-result", "result"], ["aud-sort", "sort"]].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener("change", function (e) {
        audView[pair[1]] = e.target.value; audView.page = 1; loadAudit();
      });
    });

    document.getElementById("aud-clear").addEventListener("click", function () {
      audView = Object.assign({}, BLANK_AUDIT);
      renderAudit(null);
    });

    document.getElementById("aud-list").addEventListener("click", function (e) {
      const page = e.target.closest("[data-page]");
      if (page) { audView.page = Number(page.dataset.page); loadAudit(); return; }
      if (e.target.closest("[data-retry-audit]")) { loadAudit(); return; }
      if (e.target.closest("[data-clear-audit]")) {
        audView = Object.assign({}, BLANK_AUDIT);
        renderAudit(null);
      }
    });

    loadAudit();
  }

  async function loadAudit() {
    const body = document.getElementById("aud-list");
    if (!body) return;
    body.innerHTML = skeleton();

    const mine = ++audSeq;

    /* Once per screen, not once per page. A failure here leaves the
       dropdowns empty but must not stop the list loading — the filters
       are a convenience and the events are the point. */
    if (!audOptions) {
      try { audOptions = await api("GET", "/admin/audit/options"); }
      catch (err) { audOptions = null; }
      if (mine !== audSeq) return;
    }

    let d;
    try {
      const qs = "?q=" + encodeURIComponent(audView.q) +
        "&sort=" + encodeURIComponent(audView.sort) +
        "&page=" + encodeURIComponent(audView.page) +
        (audView.from ? "&from=" + encodeURIComponent(audView.from) : "") +
        (audView.to ? "&to=" + encodeURIComponent(audView.to) : "") +
        (audView.actor ? "&actor=" + encodeURIComponent(audView.actor) : "") +
        (audView.actorType ? "&actorType=" + encodeURIComponent(audView.actorType) : "") +
        (audView.action ? "&action=" + encodeURIComponent(audView.action) : "") +
        (audView.resource ? "&resource=" + encodeURIComponent(audView.resource) : "") +
        (audView.resourceId ? "&resourceId=" + encodeURIComponent(audView.resourceId) : "") +
        (audView.severity ? "&severity=" + encodeURIComponent(audView.severity) : "") +
        (audView.result ? "&result=" + encodeURIComponent(audView.result) : "");
      d = await api("GET", "/admin/audit" + qs);
    } catch (err) {
      if (mine !== audSeq) return;
      body.innerHTML = '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<button type="button" class="adm-retry" data-retry-audit="1">Try again</button>';
      return;
    }
    if (mine !== audSeq) return;

    if (!d.available) {
      body.innerHTML = emptyLine(d.reason || "No audit log is available in this copy.");
      return;
    }

    audView.page = d.page;

    if (audOptions) {
      const all = function (label, list) {
        return [{ key: "", label: label }].concat(list || []);
      };
      fillSelect(document.getElementById("aud-actor"),
        all("Everyone", (audOptions.actors || []).map(function (a) {
          return { key: a.key, label: a.label + " (" + num(a.n) + ")" };
        })), d.actor);
      fillSelect(document.getElementById("aud-actorType"),
        all("Any kind", audOptions.actorTypes), d.actorType);
      fillSelect(document.getElementById("aud-action"),
        all("Any action", (audOptions.actions || []).map(function (a) {
          return { key: a.key, label: a.label + " (" + num(a.n) + ")" };
        })), d.action);
      fillSelect(document.getElementById("aud-resource"),
        all("Any record type", audOptions.resources), d.resource);
      fillSelect(document.getElementById("aud-severity"),
        all("Any importance", audOptions.severities), d.severity);
      fillSelect(document.getElementById("aud-result"),
        all("Any outcome", audOptions.results), d.result);
      fillSelect(document.getElementById("aud-sort"), audOptions.sorts, d.sort);
    }

    const dFrom = document.getElementById("aud-from");
    const dTo = document.getElementById("aud-to");
    if (dFrom) dFrom.value = d.from || "";
    if (dTo) dTo.value = d.to || "";

    body.innerHTML = auditListHtml(d);
  }

  function auditFiltered(d) {
    return !!(d.q || d.from || d.to || d.actor || d.actorType || d.action ||
              d.resource || d.resourceId || d.result || d.severity);
  }

  function auditListHtml(d) {
    if (!d.total) {
      return auditFiltered(d)
        ? emptyLine("No recorded action matches those filters.") +
          '<button type="button" class="adm-retry" data-clear-audit="1">' +
          "Clear search and filters</button>"
        : emptyLine("Nothing has been recorded in the audit log yet.");
    }

    const from = (d.page - 1) * d.pageSize + 1;
    const to = from + d.rows.length - 1;

    const head =
      '<div class="adm-tbl-head adm-tbl-audit" aria-hidden="true">' +
        "<span>When</span><span>Person</span><span>Kind</span><span>Action</span>" +
        "<span>Record</span><span>Outcome</span><span>Event</span>" +
      "</div>";

    const rows = d.rows.map(function (r) {
      const sev = SEV_TONE[r.severity] || "is-info";

      /* The description under the action, where the eye already is,
         rather than as an eighth column nobody could read. */
      const detail = r.details
        ? '<span class="adm-row-sub">' + esc(r.details) + "</span>"
        : "";

      const record = r.resourceType
        ? '<span class="adm-strong">' + esc(r.resourceType) + "</span>" +
          (r.resourceId
            ? '<span class="adm-row-sub"><span class="adm-code">' +
              esc(r.resourceId) + "</span></span>"
            : "")
        : '<span class="adm-muted">&mdash;</span>';

      return '<a class="adm-tbl-row adm-tbl-audit" href="' + audHref(r.id) + '">' +
        '<span class="adm-cell adm-cell-name">' +
          '<span class="adm-strong">' + esc(r.when) + "</span>" +
          '<span class="adm-row-sub">' + esc(r.time) + "</span>" +
        "</span>" +
        '<span class="adm-cell" data-h="Person">' + esc(r.who) +
          (r.whoId ? "" : "") + "</span>" +
        '<span class="adm-cell" data-h="Kind">' +
          /* An automated actor is marked, because telling it apart from
             a person at a glance is the whole reason the column exists. */
          /* A derived type gets a dotted underline and an explanation
             on hover. It used to get a literal "~" after the name,
             which on the page read as debris rather than as a mark that
             meant anything. */
          (r.actorDerived
            ? '<span class="adm-derived" title="Derived from the role recorded at the ' +
              'time &mdash; this event predates the actor-type column">' +
              esc(r.actorLabel) + "</span>"
            : (r.automated ? '<span class="adm-badge">' + esc(r.actorLabel) + "</span>"
                           : esc(r.actorLabel))) +
        "</span>" +
        /* adm-cell-act, not a plain cell: the action and its
           description are two lines. As a plain block the muted
           description ran straight on from the action name with nothing
           between them. */
        '<span class="adm-cell adm-cell-act" data-h="Action">' +
          '<span><span class="adm-pip adm-pip-i ' + sev + '" aria-hidden="true"></span>' +
          '<span class="adm-strong">' + esc(r.action) + "</span></span>" +
          detail +
        "</span>" +
        '<span class="adm-cell" data-h="Record">' + record + "</span>" +
        '<span class="adm-cell" data-h="Outcome">' +
          (r.result
            ? '<span class="adm-pip adm-pip-i ' + (RESULT_TONE[r.result] || "is-info") +
              '" aria-hidden="true"></span>' + esc(r.resultLabel)
            : '<span class="adm-muted">&mdash;</span>') +
          (r.hasChange ? ' <span class="adm-flag">changed</span>' : "") +
        "</span>" +
        '<span class="adm-cell" data-h="Event"><span class="adm-code">' +
          esc(r.ref) + "</span></span>" +
      "</a>";
    }).join("");

    const pager = d.pages > 1
      ? '<div class="adm-pager">' +
          '<button type="button" class="adm-retry" data-page="' + (d.page - 1) + '"' +
            (d.page <= 1 ? " disabled" : "") + ">Previous</button>" +
          '<span class="adm-pager-at">' + num(from) + "&ndash;" + num(to) +
            " of " + num(d.total) + "</span>" +
          '<button type="button" class="adm-retry" data-page="' + (d.page + 1) + '"' +
            (d.page >= d.pages ? " disabled" : "") + ">Next</button>" +
        "</div>"
      : "";

    /* SAID OUT LOUD. When the log is too large to scan the descriptions
       for a search term, the reader is told which fields WERE searched
       and how to make the rest of it run. A search that silently leaves
       matches out is worse than one that refuses. */
    const scope = d.search && !d.search.descriptionsSearched
      ? '<p class="adm-scope"><strong>Descriptions were not searched.</strong> ' +
        num(d.search.candidates) + " events are in range, which is above the " +
        num(d.search.ceiling) + " this can read line by line. " +
        "Person, action, record and event id were searched. " +
        "Narrow the date range to search the descriptions too.</p>"
      : "";

    const totals = '<p class="adm-foot">' + num(d.total) + " recorded action(s) matched." +
      " Events are append-only: nothing here can be edited or removed.</p>";

    return '<div class="adm-tbl">' + head + rows + "</div>" + pager + scope + totals;
  }

  /* ---- one event ----------------------------------------------------- */

  async function renderAuditEvent(id) {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<a class="adm-back" href="#/audit">&larr; All audit logs</a>' +
          '<h1 class="adm-page-title" id="aud-title">Audit event</h1>' +
        "</div>" +
      "</div>" +
      '<div id="aud-body"><div class="adm-panel"><div class="adm-panel-body">' +
        skeleton() + "</div></div></div>";

    const host = document.getElementById("aud-body");
    let d;
    try {
      d = await api("GET", "/admin/audit/" + encodeURIComponent(id));
    } catch (err) {
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<a class="adm-retry" href="#/audit">Back to all audit logs</a>' +
        "</div></div>";
      return;
    }
    paintAuditEvent(host, d);
  }

  function paintAuditEvent(host, d) {
    const title = document.getElementById("aud-title");
    if (title) title.textContent = d.action || "Audit event";
    document.title = d.ref + " — Admin Control Centre";

    const sev = SEV_TONE[d.severity] || "is-info";

    const kv = function (k, v) {
      return '<div class="adm-kv-k">' + esc(k) + "</div>" +
             '<div class="adm-kv-v">' + v + "</div>";
    };

    const facts =
      '<div class="adm-kv">' +
        kv("Event", '<span class="adm-code">' + esc(d.ref) + "</span>") +
        kv("When", esc(showStamp(d.at))) +
        kv("Person", esc(d.who) +
          (d.whoId ? ' <span class="adm-code">' + esc(d.whoId) + "</span>" : "")) +
        kv("Kind of actor",
          (d.automated ? '<span class="adm-badge">' + esc(d.actorLabel) + "</span>"
                       : esc(d.actorLabel))) +
        kv("Action", '<span class="adm-pip adm-pip-i ' + sev + '" aria-hidden="true"></span>' +
          esc(d.action) + ' <span class="adm-muted">(' + esc(d.severityLabel) + ")</span>") +
        kv("Record", d.resourceType
          ? esc(d.resourceType) +
            (d.resourceId ? ' <span class="adm-code">' + esc(d.resourceId) + "</span>" : "")
          : '<span class="adm-muted">&mdash;</span>') +
        kv("Outcome", d.result
          ? '<span class="adm-pip adm-pip-i ' + (RESULT_TONE[d.result] || "is-info") +
            '" aria-hidden="true"></span>' + esc(d.resultLabel)
          : '<span class="adm-muted">not recorded</span>') +
        kv("Description", d.details
          ? esc(d.details) : '<span class="adm-muted">&mdash;</span>') +
        /* Only when there is one. A blank row for an address the app
           could not resolve says nothing and invites the reader to
           think something was withheld. */
        (d.ip ? kv("Address", '<span class="adm-code">' + esc(d.ip) + "</span>") : "") +
        (d.userAgent ? kv("Device", '<span class="adm-row-sub">' +
          esc(d.userAgent) + "</span>") : "") +
      "</div>" +
      (d.actorNote ? '<p class="adm-foot">' + esc(d.actorNote) + "</p>" : "");

    /* ---- what changed ---- */
    const change = (d.change && d.change.length)
      ? '<div class="adm-panel"><div class="adm-panel-head">' +
          '<h2 class="adm-panel-title">What changed</h2></div>' +
          '<div class="adm-panel-body">' +
          '<div class="adm-tbl">' +
            '<div class="adm-tbl-head adm-tbl-chg" aria-hidden="true">' +
              "<span>Field</span><span>Before</span><span>After</span></div>" +
            d.change.map(function (c) {
              return '<div class="adm-tbl-row adm-tbl-chg">' +
                '<span class="adm-cell adm-cell-name"><span class="adm-strong">' +
                  esc(c.field) + "</span></span>" +
                '<span class="adm-cell" data-h="Before">' + auditValue(c.before) + "</span>" +
                '<span class="adm-cell" data-h="After">' + auditValue(c.after) + "</span>" +
              "</div>";
            }).join("") +
          "</div>" +
          '<p class="adm-foot">Only the fields that actually moved are recorded, and ' +
          "never a credential &mdash; anything whose name looks like a password, PIN, " +
          "token or key is replaced before the event is written.</p>" +
          "</div></div>"
      : "";

    /* ---- anything else recorded ---- */
    const extra = d.extra
      ? '<div class="adm-panel"><div class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Also recorded</h2></div>' +
          '<div class="adm-panel-body"><div class="adm-kv">' +
          Object.keys(d.extra).map(function (k) {
            return kv(k, auditValue(d.extra[k]));
          }).join("") +
          "</div></div></div>"
      : "";

    /* ---- the rest of this record's history ---- */
    const history = (d.history && d.history.length)
      ? '<div class="adm-panel"><div class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Everything else on this record</h2></div>' +
          '<div class="adm-panel-body"><div class="adm-list">' +
          d.history.map(function (h) {
            return '<a class="adm-row" href="' + audHref(h.id) + '">' +
              '<span class="adm-pip adm-pip-i ' + (SEV_TONE[h.severity] || "is-info") +
                '" aria-hidden="true"></span>' +
              /* Siblings, not nested. .adm-row-sub is placed by the
                 .adm-row grid, so inside .adm-row-main it is a plain
                 inline span and the two lines run together \u2014 which is
                 exactly how it rendered until the page was opened. */
              '<span class="adm-row-main adm-strong">' + esc(h.action) + "</span>" +
              '<span class="adm-row-sub">' + esc(h.who) + " \u00b7 " +
                esc(h.when) + " " + esc(h.time) +
                (h.details ? " \u00b7 " + esc(h.details) : "") + "</span>" +
            "</a>";
          }).join("") +
          "</div></div></div>"
      : "";

    host.innerHTML =
      '<div class="adm-panel"><div class="adm-panel-head">' +
        '<h2 class="adm-panel-title">The event</h2></div>' +
        '<div class="adm-panel-body">' + facts + "</div></div>" +
      change + extra + history;
  }

  /* A recorded value, rendered. Objects and arrays are shown as JSON
     rather than as "[object Object]" — meta can hold a list of granted
     capabilities, and that is worth reading. */
  function auditValue(v) {
    if (v === null || v === undefined || v === "") {
      return '<span class="adm-muted">&mdash; blank</span>';
    }
    if (typeof v === "object") {
      return '<span class="adm-code">' + esc(JSON.stringify(v)) + "</span>";
    }
    return '<span class="adm-code">' + esc(String(v)) + "</span>";
  }

  /* ==================================================================
     SYSTEM HEALTH — PART 11

     WHAT THIS SCREEN WILL NOT DO. It will not show a percentage, it
     will not show a green tick for a service it has not checked, and it
     will not draw a graph of a number nobody measured. Every card below
     is a real check with a real duration beside it, and a service that
     is merely SET UP rather than verified says so in those words.

     "Not set up" is its own state and is never coloured as a fault. A
     shop with no cloud bucket has not broken anything — showing that in
     red teaches people to ignore the page, which is how the one real
     fault goes unnoticed.

     THE REFRESH IS OPT-IN and runs once a minute, not once a second.
     It stops when you leave the page, and it stops when the tab is
     hidden — a screen left open on a counter PC overnight should not
     spend the night asking.
     ================================================================== */
  const HEALTH_TONE = {
    ok:             "is-ok",
    warn:           "is-warn",
    critical:       "is-bad",
    not_configured: "is-info",
  };

  /* Once a minute. Short enough that somebody watching a problem sees it
     clear, long enough that it is not a load. */
  const HEALTH_REFRESH_MS = 60000;
  const HEALTH_AUTO_KEY = "sm.admin.healthAuto";

  let healthTimer = null;
  let healthSeq = 0;
  let healthBusy = false;

  function stopHealthTimer() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  function healthAutoOn() {
    try { return localStorage.getItem(HEALTH_AUTO_KEY) === "1"; }
    catch (e) { return false; }
  }
  function setHealthAuto(on) {
    try { localStorage.setItem(HEALTH_AUTO_KEY, on ? "1" : "0"); } catch (e) { /* private window */ }
  }

  function healthHref(key) {
    return key ? "#/health/" + encodeURIComponent(key) : "#/health";
  }

  function renderHealth(sub) {
    if (sub) return renderHealthService(sub);

    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<h1 class="adm-page-title">System Health</h1>' +
          '<p class="adm-page-sub">Whether this copy of Shop Manager is working. ' +
          'Every figure here is checked when the page loads &mdash; nothing outside ' +
          'is contacted, so services that live elsewhere report when they last ' +
          'actually worked rather than being pinged.</p>' +
        "</div>" +
      "</div>" +
      '<div id="hl-body">' + skeleton() + "</div>";

    const body = document.getElementById("hl-body");

    body.addEventListener("click", function (e) {
      if (e.target.closest("[data-hl-run]")) { runHealthCheck(); return; }
      if (e.target.closest("[data-hl-retry]")) { loadHealth(); return; }
    });
    body.addEventListener("change", function (e) {
      const t = e.target.closest("[data-hl-auto]");
      if (!t) return;
      setHealthAuto(t.checked);
      armHealthTimer();
    });

    loadHealth();
    armHealthTimer();
  }

  function armHealthTimer() {
    stopHealthTimer();
    if (!healthAutoOn()) return;
    healthTimer = setInterval(function () {
      /* Nothing while the tab is in the background, and nothing while a
         check is already in flight. */
      if (document.hidden) return;
      if (healthBusy) return;
      if (currentKey() !== "health" || currentRoute().sub) { stopHealthTimer(); return; }
      loadHealth(true);
    }, HEALTH_REFRESH_MS);
  }

  async function loadHealth(quiet) {
    const body = document.getElementById("hl-body");
    if (!body) return;
    if (!quiet) body.innerHTML = skeleton();

    const mine = ++healthSeq;
    healthBusy = true;
    let d;
    try {
      d = await api("GET", "/admin/health");
    } catch (err) {
      healthBusy = false;
      if (mine !== healthSeq) return;
      /* NEVER A FAKE HEALTHY STATE. If the check itself could not run,
         the page says that and offers to try again — it does not fall
         back to the last reading and present it as current. */
      body.innerHTML =
        '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
          '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
          '<p class="adm-foot">The health check could not be run, so nothing on this ' +
          "page can be trusted as current.</p>" +
          '<button type="button" class="adm-retry" data-hl-retry="1">Try again</button>' +
        "</div></div>";
      return;
    }
    healthBusy = false;
    if (mine !== healthSeq) return;
    body.innerHTML = healthHtml(d);
  }

  async function runHealthCheck() {
    const btn = document.querySelector("[data-hl-run]");
    if (btn) { btn.disabled = true; btn.textContent = "Checking\u2026"; }
    healthBusy = true;
    let d;
    try {
      d = await api("POST", "/admin/health/check", {});
    } catch (err) {
      healthBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = "Run health check"; }
      toast(humanError(err), "");
      return;
    }
    healthBusy = false;
    const body = document.getElementById("hl-body");
    if (body) body.innerHTML = healthHtml(d);
    toast("Health check complete \u2014 " + d.overallLabel, d.overall === "ok" ? "ok" : "");
  }

  function healthHtml(d) {
    const tone = HEALTH_TONE[d.overall] || "is-info";

    /* ---- the headline ---- */
    const head =
      '<div class="adm-panel adm-hl-head"><div class="adm-panel-body">' +
        '<div class="adm-hl-top">' +
          '<div class="adm-hl-state">' +
            '<span class="adm-hl-dot ' + tone + '" aria-hidden="true"></span>' +
            "<div>" +
              '<div class="adm-hl-label">' + esc(d.overallLabel) + "</div>" +
              '<div class="adm-hl-sub">' +
                (d.problems.length
                  ? num(d.problems.length) + " thing(s) need attention"
                  : "Every check passed") +
                " \u00b7 checked " + esc(d.ago || "just now") +
                " \u00b7 took " + esc(String(d.tookMs)) + "ms" +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div class="adm-hl-actions">' +
            '<label class="adm-hl-auto"><input type="checkbox" data-hl-auto="1"' +
              (healthAutoOn() ? " checked" : "") + "> Refresh every minute</label>" +
            '<button type="button" class="adm-primary" data-hl-run="1">Run health check</button>' +
          "</div>" +
        "</div>" +
      "</div></div>";

    /* ---- what is wrong, if anything ---- */
    const alerts = d.problems.length
      ? '<div class="adm-panel"><div class="adm-panel-head">' +
          '<h2 class="adm-panel-title">Needs attention</h2></div>' +
          '<div class="adm-panel-body"><ul class="adm-list">' +
          d.problems.map(function (p) {
            return '<li class="adm-row">' +
              '<span class="adm-pip adm-pip-i ' + (HEALTH_TONE[p.state] || "is-info") +
                '" aria-hidden="true"></span>' +
              '<span class="adm-row-main adm-strong">' + esc(p.name) + "</span>" +
              '<span class="adm-row-sub">' + esc(p.detail) + "</span>" +
            "</li>";
          }).join("") +
          "</ul></div></div>"
      : "";

    /* ---- the services, by group ---- */
    const groups = d.groups.map(function (g) {
      const keys = Object.keys(d.checks).filter(function (k) {
        return d.checks[k].group === g;
      });
      if (!keys.length) return "";

      return '<div class="adm-panel"><div class="adm-panel-head">' +
        '<h2 class="adm-panel-title">' + esc(g) + "</h2></div>" +
        '<div class="adm-panel-body"><div class="adm-svcs">' +
        keys.map(function (k) { return serviceCard(d.checks[k]); }).join("") +
        "</div></div></div>";
    }).join("");

    /* ---- version, last of all ---- */
    const v = d.version || {};
    const foot =
      '<div class="adm-panel"><div class="adm-panel-head">' +
        '<h2 class="adm-panel-title">This copy</h2></div>' +
        '<div class="adm-panel-body"><div class="adm-kv">' +
          '<div class="adm-kv-k">Version</div><div class="adm-kv-v">' +
            '<span class="adm-code">' + esc(v.app || "unknown") + "</span></div>" +
          (v.commit
            ? '<div class="adm-kv-k">Build</div><div class="adm-kv-v">' +
              '<span class="adm-code">' + esc(v.commit) + "</span></div>"
            : "") +
          '<div class="adm-kv-k">Node</div><div class="adm-kv-v">' +
            '<span class="adm-code">' + esc(v.node || "") + "</span></div>" +
          '<div class="adm-kv-k">Started</div><div class="adm-kv-v">' +
            esc(showStamp(v.startedAt)) +
            ' <span class="adm-muted">(' + esc(v.startedAgo || "") + ")</span></div>" +
        "</div></div></div>";

    return head + alerts + groups + foot;
  }

  function serviceCard(c) {
    const tone = HEALTH_TONE[c.state] || "is-info";
    return '<a class="adm-svc" href="' + healthHref(c.key) + '">' +
      '<span class="adm-svc-head">' +
        '<span class="adm-pip adm-pip-i ' + tone + '" aria-hidden="true"></span>' +
        '<span class="adm-svc-name">' + esc(c.name) + "</span>" +
        /* The duration of THIS check, measured. Not an average, not a
           rolling figure — the milliseconds this one took just now. */
        '<span class="adm-svc-ms">' + esc(String(c.ms)) + "ms</span>" +
      "</span>" +
      '<span class="adm-svc-state ' + tone + '">' + esc(c.label) + "</span>" +
      '<span class="adm-svc-detail">' + esc(c.detail || "") + "</span>" +
    "</a>";
  }

  /* ---- one service --------------------------------------------------- */

  async function renderHealthService(key) {
    el.page.innerHTML =
      '<div class="adm-page-head">' +
        '<div class="adm-page-head-text">' +
          '<a class="adm-back" href="#/health">&larr; System Health</a>' +
          '<h1 class="adm-page-title" id="hl-title">Service</h1>' +
        "</div>" +
      "</div>" +
      '<div id="hl-one">' + skeleton() + "</div>";

    const host = document.getElementById("hl-one");
    host.addEventListener("click", function (e) {
      if (e.target.closest("[data-hl-recheck]")) renderHealthService(key);
    });

    let d;
    try {
      d = await api("GET", "/admin/health/" + encodeURIComponent(key));
    } catch (err) {
      host.innerHTML = '<div class="adm-panel is-failed"><div class="adm-panel-body">' +
        '<p class="adm-fail">' + esc(humanError(err)) + "</p>" +
        '<a class="adm-retry" href="#/health">Back to System Health</a>' +
        "</div></div>";
      return;
    }

    const title = document.getElementById("hl-title");
    if (title) title.textContent = d.name;
    document.title = d.name + " — Admin Control Centre";

    const tone = HEALTH_TONE[d.state] || "is-info";

    const kv = function (k, v) {
      return '<div class="adm-kv-k">' + esc(k) + "</div>" +
             '<div class="adm-kv-v">' + v + "</div>";
    };

    /* Everything the check returned that is worth a line, named in
       words. Deliberately a hand-written list rather than a dump of the
       object: a dump is how a path or a bucket name reaches a screen. */
    const extras = [];
    if (d.journalMode) extras.push(kv("Journal mode", '<span class="adm-code">' + esc(d.journalMode) + "</span>"));
    if (d.foreignKeys !== undefined) extras.push(kv("Foreign keys", d.foreignKeys ? "On" : "Off"));
    if (d.live !== undefined && d.live !== null) extras.push(kv("Signed in now", num(d.live)));
    if (d.awaitingCleanup !== undefined && d.awaitingCleanup !== null) {
      extras.push(kv("Waiting to be cleared", num(d.awaitingCleanup)));
    }
    if (d.backups !== undefined) extras.push(kv("Local backups", num(d.backups)));
    if (d.newestBackupAgo) extras.push(kv("Newest backup", esc(d.newestBackupAgo)));
    if (d.provider) extras.push(kv("Provider", esc(d.provider)));
    if (d.lastAgo) extras.push(kv("Last upload", esc(d.lastAgo)));
    if (d.events !== undefined) extras.push(kv("Events recorded", num(d.events)));
    if (d.newestAgo) extras.push(kv("Newest event", esc(d.newestAgo)));
    if (d.appendOnlyEnforced !== undefined) {
      extras.push(kv("Append-only enforced", d.appendOnlyEnforced
        ? "Yes, by the database"
        : '<span class="adm-over">Not enforced by the database</span>'));
    }
    if (d.uptime) extras.push(kv("Uptime", esc(d.uptime)));

    /* A group check carries its own rows. */
    const children = (d.jobs || d.rows || []);
    const childList = children.length
      ? '<div class="adm-panel"><div class="adm-panel-head">' +
          '<h2 class="adm-panel-title">' + (d.jobs ? "Jobs" : "Services") + "</h2></div>" +
          '<div class="adm-panel-body"><ul class="adm-list">' +
          children.map(function (c) {
            return '<li class="adm-row">' +
              '<span class="adm-pip adm-pip-i ' + (HEALTH_TONE[c.state] || "is-info") +
                '" aria-hidden="true"></span>' +
              '<span class="adm-row-main adm-strong">' + esc(c.name) + "</span>" +
              '<span class="adm-row-sub">' + esc(c.detail) + "</span>" +
            "</li>";
          }).join("") +
          "</ul></div></div>"
      : "";

    host.innerHTML =
      '<div class="adm-panel"><div class="adm-panel-body">' +
        '<div class="adm-kv">' +
          kv("Status", '<span class="adm-pip adm-pip-i ' + tone +
            '" aria-hidden="true"></span>' + esc(d.label)) +
          kv("Detail", esc(d.detail || "\u2014")) +
          kv("Response", esc(String(d.ms)) + "ms") +
          kv("Checked", esc(showStamp(d.at))) +
          extras.join("") +
        "</div>" +
        '<p class="adm-foot">Checked just now, when this page was opened. ' +
        (d.critical
          ? "A failure here makes the whole system Critical."
          : "A failure here raises a warning, not an outage.") + "</p>" +
        '<button type="button" class="adm-retry" data-hl-recheck="1">Check again</button>' +
      "</div></div>" + childList;
  }

  /* ------------------------------------------------------------------
     THE PROFILE MENU
     ------------------------------------------------------------------ */
  function closeProfile() {
    el.profileMenu.hidden = true;
    el.profileBtn.setAttribute("aria-expanded", "false");
  }
  function toggleProfile() {
    const open = el.profileMenu.hidden;
    el.profileMenu.hidden = !open;
    el.profileBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* ------------------------------------------------------------------
     WIRING — all of it addEventListener, none of it inline
     ------------------------------------------------------------------ */
  function wire() {
    el.drawerOpen.addEventListener("click", openDrawer);
    el.scrim.addEventListener("click", closeDrawer);

    el.collapse.addEventListener("click", function () {
      const next = !el.shell.classList.contains("is-collapsed");
      applyCollapsed(next);
      writeCollapsed(next);
      hideTip();
    });

    /* A tooltip is anchored to where the item was, so it has to go when
       the list moves under it. */
    el.nav.addEventListener("scroll", hideTip);

    el.profileBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleProfile();
    });
    document.addEventListener("click", function (e) {
      if (!el.profileMenu.hidden && !el.profileMenu.contains(e.target)) closeProfile();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!el.profileMenu.hidden) { closeProfile(); return; }
      if (el.shell.classList.contains("is-drawer-open")) closeDrawer();
    });

    el.logout.addEventListener("click", async function () {
      try {
        await api("POST", "/auth/logout");
      } catch (err) {
        /* Either way the session is over as far as this page is
           concerned, so it goes back to the login screen. */
      }
      location.href = "/";
    });

    /* The notifications icon and the search field are placeholders in
       PART 1. They say so rather than doing nothing silently, which
       reads as a bug. */
    el.bell.addEventListener("click", function () {
      toast("Notifications are not set up yet.");
    });
    el.search.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      toast("Admin search is not set up yet.");
    });

    window.addEventListener("hashchange", render);

    /* A phone rotated into landscape past 1024px would otherwise keep a
       stale drawer-open class and a visible scrim. */
    window.addEventListener("resize", function () {
      if (isWide()) closeDrawer();
      hideTip();
    });
  }

  /* ------------------------------------------------------------------
     START
     ------------------------------------------------------------------ */
  async function start() {
    wire();
    applyCollapsed(readCollapsed());

    try {
      me = await api("GET", "/admin/me");
    } catch (err) {
      /* A 403 here means this login may not open the panel. The page
         route already redirects such a login away, so this is the
         belt-and-braces case — a session that lapsed between the page
         loading and this call. */
      el.page.innerHTML = placeholderUnavailable();
      toast(err.message || "Could not load the admin panel.");
      return;
    }

    me.sections = me.sections || [];
    me.groups = me.groups || [];

    if (me.businessName) el.brandName.textContent = me.businessName;
    el.profName.textContent = me.staffName || "Owner";
    el.profRole.textContent = me.role || "";
    el.avatar.textContent = initials(me.staffName || me.role || "");
    el.profileBtn.title = (me.staffName || "Owner") + " — " + (me.role || "");

    buildNav();
    render();
  }

  start();
})();
