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
  function currentKey() {
    const raw = String(location.hash || "").replace(/^#\/?/, "");
    const found = me.sections.filter(function (s) { return s.key === raw; })[0];
    if (found) return found.key;
    return me.sections.length ? me.sections[0].key : null;
  }

  function render() {
    const key = currentKey();
    if (!key) {
      el.page.innerHTML = placeholderUnavailable();
      return;
    }
    const section = me.sections.filter(function (s) { return s.key === key; })[0];

    markActive(key);
    el.crumbHere.textContent = section.label;
    document.title = section.label + " — Admin Control Centre";

    /* PART 2 built the Dashboard. Every other section is still the
       placeholder PART 1 put there, deliberately. */
    if (key === "dashboard") renderDashboard();
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

  function tile(label, body, sub) {
    return '<div class="adm-tile">' +
      '<span class="adm-tile-label">' + esc(label) + "</span>" +
      '<span class="adm-tile-value">' + body + "</span>" +
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
  function chartHtml(series) {
    if (!series || !series.length) return "";
    const max = Math.max.apply(null, series.map(d => d.total));
    const W = 100, H = 34, gap = 1.1;
    const bw = (W - gap * (series.length - 1)) / series.length;

    const bars = series.map((d, i) => {
      /* A trading day with a tiny total still gets a visible sliver, so
         "small" never reads as "none". */
      const h = max > 0 && d.total > 0 ? Math.max(0.8, (d.total / max) * H) : 0;
      const x = i * (bw + gap);
      const last = i === series.length - 1;
      const title = d.date + " · " + money(d.total) +
        " · " + d.bills + (d.bills === 1 ? " bill" : " bills");
      return '<rect class="adm-bar' + (last ? " is-today" : "") + '"' +
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
      const fromServer = err && err.message && !/^(Failed to fetch|NetworkError|Load failed)/i.test(err.message);
      const message = fromServer
        ? err.message
        : "Could not reach the server. Check the connection and try again.";
      wanted.forEach(p => paintPanel(p, { ok: false, error: message }));
      return;
    }

    const sections = (payload && payload.sections) || {};
    wanted.forEach(p => paintPanel(p, sections[p.key]));
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
