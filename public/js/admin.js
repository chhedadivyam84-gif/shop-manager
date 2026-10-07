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
    el.page.innerHTML = placeholderPage(section);
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
