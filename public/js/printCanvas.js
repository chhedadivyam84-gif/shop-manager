/* ============================================================
   THE PRINT CANVAS — one sheet, one renderer, every device.

   WHAT WAS WRONG.

   Printing was done six different ways. The one that mattered most, the
   bill, printed the LIVE APPLICATION DOM: the preview was the app, and a
   stylesheet hid the app around it at print time and undid its effects one
   by one — the fit-to-screen transform, the width, the max-width, the
   mobile A5 cap. Every undo was a place the preview and the paper could
   part company, and a device with a different screen found a different one.

   The other documents built standalone HTML in a new window, which is
   closer to right, but each carried its own margins. Measured: DocPrint
   laid its sheet out at 210mm with 8mm of padding on screen (194mm of
   content) and then printed it at width:auto inside an @page margin of 6mm
   (198mm of content). Four millimetres wider on paper than in the preview,
   so every column reflowed between the two.

   HOW THIS FIXES IT.

   A document is rendered ONCE, into an iframe sized in real millimetres,
   carrying document.css and nothing else. Preview and print are then not
   two renderings that have to be kept in agreement — they are the SAME
   rendering:

     - the preview shows that iframe, scaled down with a CSS transform on
       the iframe ELEMENT. A transform scales rendered pixels; it does not
       reach inside, so the document's own layout is untouched by it.
     - printing calls print() on that same iframe's window, so the printer
       gets the layout the preview is showing a smaller picture of.

   Nothing about the device is in scope inside the canvas. There is no app
   stylesheet, no breakpoint, no viewport unit and no theme variable — so an
   iPhone, an iPad and a desktop cannot produce different paper, because the
   document is never told which of them it is on.

   WHAT THIS DELIBERATELY DOES NOT DO.

   It does not choose a printer or a number of copies. No web page may: the
   operating system's print dialog owns both, and a browser exposes neither.
   The engine remembers the shop's choice, shows it, and hands it to the
   server-side silent-print path where it CAN be honoured — but it will not
   pretend to drive the browser dialog. A setting that quietly does nothing
   is worse than one that says so.
   ============================================================ */
(function (global) {
  "use strict";

  var MM_PER_IN = 25.4, CSS_DPI = 96;
  var mmToPx = function (mm) { return mm * CSS_DPI / MM_PER_IN; };

  /* ------------------------------------------------------------------ */
  /* paper                                                               */
  /* ------------------------------------------------------------------ */

  var SHEETS = {
    A4: { w: 210, h: 297 },
    A5: { w: 148, h: 210 }
  };

  /**
   * The sheet a document is going onto, in millimetres, orientation applied.
   *
   * Landscape SWAPS the two rather than setting a flag, because everything
   * downstream — the page box, the canvas, the fit maths — wants a width and
   * a height, and a flag is one more thing each of them could forget to read.
   */
  function sheet(prefs) {
    prefs = prefs || {};
    var base = SHEETS[prefs.paper] || null;
    var w, h;
    if (!base) {
      w = num(prefs.paperW) > 0 ? num(prefs.paperW) : SHEETS.A4.w;
      h = num(prefs.paperH) > 0 ? num(prefs.paperH) : SHEETS.A4.h;
    } else { w = base.w; h = base.h; }
    var land = prefs.orientation === "landscape";
    return {
      w: land ? h : w,
      h: land ? w : h,
      named: SHEETS[prefs.paper] ? prefs.paper : null,
      orientation: land ? "landscape" : "portrait"
    };
  }

  /** The margin, in mm, clamped to something a printer can actually do. */
  function margin(prefs, sh) {
    var m = prefs && prefs.margin;
    if (m === undefined || m === null || m === "") {
      /* The shop has not chosen, so follow the sheet: the old bill used 6mm
         on A4 and 3mm on the smaller A5, and that is the look being kept. */
      return sh.h > 250 ? 6 : 3;
    }
    return Math.max(0, Math.min(25, num(m)));
  }

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  /* ------------------------------------------------------------------ */
  /* settings                                                            */
  /* ------------------------------------------------------------------ */

  var DEFAULTS = {
    paper: "A4",
    orientation: "portrait",
    margin: null,          /* null = follow the sheet */
    scaling: "actual",     /* "actual" | "fit" */
    mode: "preview",       /* "preview" | "direct" */
    copies: 1,
    printerName: ""        /* remembered for the server-side path only */
  };

  /* Read and written by the app, which owns the settings record. Kept as
     two hooks rather than a direct fetch so this file has no opinion about
     where a shop's preferences are stored. */
  function stored() {
    if (typeof global.__printCanvasLoad !== "function") return {};
    try { return global.__printCanvasLoad() || {}; } catch (e) { return {}; }
  }

  function prefs() {
    var s = stored(), out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = (s[k] === undefined || s[k] === null || s[k] === "") && k !== "margin"
        ? DEFAULTS[k] : s[k];
    });
    if (s.paperW) out.paperW = s.paperW;
    if (s.paperH) out.paperH = s.paperH;
    if (out.margin === undefined) out.margin = DEFAULTS.margin;
    return out;
  }

  function savePrefs(patch) {
    if (typeof global.__printCanvasSave !== "function") return prefs();
    var next = Object.assign({}, prefs(), patch || {});
    try { global.__printCanvasSave(next); } catch (e) { /* never fatal */ }
    return next;
  }

  /* ------------------------------------------------------------------ */
  /* the canvas                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Build the document that goes inside the canvas.
   *
   * One stylesheet, linked rather than inlined so the browser caches it and
   * every document in the app is provably reading the same bytes.
   *
   * The sheet's size reaches CSS as custom properties on :root, which the
   * @page rule in document.css reads. Writing them here means the page box
   * and the visible sheet are set from ONE number each — the old code had
   * "is it A4?" in three separate places, and a landscape template was
   * measured against A4 portrait because one of them had not been told.
   */
  function documentHtml(body, opt) {
    var sh = opt.sheet, m = opt.margin;
    var size = sh.named ? sh.named + " " + sh.orientation : sh.w + "mm " + sh.h + "mm";
    return "<!doctype html><html><head><meta charset=\"utf-8\">" +
      "<title>" + esc(opt.title || "Document") + "</title>" +
      "<link rel=\"stylesheet\" href=\"/css/document.css\">" +
      "<style>" +
      ":root{--sheet-w:" + sh.w + "mm;--sheet-h:" + sh.h + "mm;--sheet-margin:" + m + "mm;}" +
      /* A named size where there is one, so the browser's own paper picker
         agrees with us instead of quietly offering Letter. */
      "@page{size:" + size + ";margin:" + m + "mm;}" +
      /* The sheet on screen. In print the page box already IS this size, so
         the wrapper drops its own dimensions rather than nesting a second
         sheet inside the first. */
      /* A COLUMN, so the document can fill the sheet.
      
         The bill's ruled box is meant to grow to the height of the page,
         with the items at the top of it and the totals down at the foot —
         that is what makes it look like a printed bill rather than a
         receipt floating on a mostly empty sheet. That growth needs
         something to grow INSIDE, and on screen the app gave .invoice-page
         a min-height in JS. No JS of ours runs in here, so the sheet
         provides it instead. */
      ".pc-sheet{width:" + (sh.w - m * 2) + "mm;min-height:" + (sh.h - m * 2) + "mm;" +
      "margin:" + m + "mm auto;box-sizing:border-box;display:flex;flex-direction:column;}" +
      /* Whatever the document's own root is — the bill's .invoice-page or a
         templated document's .dp-page — it fills the sheet. Both are flex
         columns whose table wrapper grows, and both need something to grow
         inside. */
      ".pc-sheet > *{flex:1 1 auto;min-height:0;}" +
      /* min-height STAYS in print. Dropping it to 0 was letting the sheet
         collapse to its content on paper while filling the page on screen —
         the preview and the print would have disagreed about the one thing
         this canvas exists to keep identical. The page box is already the
         sheet, so only the width and the centring margin come off. */
      "@media print{.pc-sheet{width:auto;margin:0;}}" +
      (opt.css || "") +
      "</style></head><body><div class=\"pc-sheet\">" + body + "</div></body></html>";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * Put a document on screen, at its true size, scaled to fit the space.
   *
   * The iframe is given the sheet's real pixel dimensions and then scaled
   * with a transform. That ordering matters and is the reason preview and
   * print agree: the iframe LAYS OUT at 210mm regardless, and the transform
   * only decides how large that layout is drawn. Sizing the iframe to the
   * host instead would reflow the document to the screen, which is exactly
   * the bug this replaces.
   *
   * @returns a handle with print(), validate() and destroy().
   */
  function mount(host, body, opt) {
    opt = opt || {};
    var p = opt.prefs || prefs();
    var sh = opt.sheet || sheet(p);
    var m = opt.margin === undefined ? margin(p, sh) : opt.margin;

    while (host.firstChild) host.removeChild(host.firstChild);

    var stage = document.createElement("div");
    stage.className = "pc-stage";
    /* flex:none matters. The host is a centring flex container, and a flex
        item shrinks below its own width by default — so the stage was set to
        383px and then squeezed to 359px, clipping 24px off the right of the
        sheet. Measured on a phone: the Amount column and the grand total
        were cut off the edge of the preview. */
    stage.style.cssText = "position:relative;overflow:hidden;flex:none;";

    var frame = document.createElement("iframe");
    frame.className = "pc-frame";
    frame.setAttribute("title", opt.title || "Print preview");
    frame.style.cssText =
      "width:" + mmToPx(sh.w) + "px;height:" + mmToPx(sh.h) + "px;" +
      "border:0;background:#fff;display:block;transform-origin:top left;" +
      "box-shadow:0 1px 8px rgba(0,0,0,.22);";
    stage.appendChild(frame);
    host.appendChild(stage);

    frame.srcdoc = documentHtml(body, { sheet: sh, margin: m, title: opt.title, css: opt.css });

    var handle = {
      frame: frame, sheet: sh, margin: m, prefs: p,

      /** Scale the drawn size to the room available. Layout is untouched. */
      fit: function () {
        /* clientWidth INCLUDES padding, and this host carries 16px each
           side. Using it raw claimed 32px of room that was not there, and
           the sheet was drawn wider than the box holding it. */
        var cs = getComputedStyle(host);
        var avail = host.clientWidth
          - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
        if (!(avail > 0)) return;
        var scale = Math.min(1, avail / mmToPx(sh.w));
        frame.style.transform = "scale(" + scale.toFixed(4) + ")";
        /* A transform does not change the box the element reserves, so the
           stage is told what the scaled sheet actually occupies. Without
           this the preview leaves a tall empty gap underneath it. */
        stage.style.width = (mmToPx(sh.w) * scale) + "px";
        stage.style.height = (mmToPx(sh.h) * scale) + "px";
        stage.style.margin = "0 auto";
      },

      /**
       * Is anything going to be clipped?
       *
       * Measured inside the canvas, against the real printable box, so the
       * answer is about the paper rather than about the screen. Reported
       * rather than silently corrected: a bill quietly shrunk to 55% to
       * force one page is how a print nobody could read got out of here.
       */
      validate: function () {
        var d = frame.contentDocument;
        if (!d || !d.body) return { ok: true, issues: [] };
        var el = d.querySelector(".pc-sheet");
        if (!el) return { ok: true, issues: [] };
        var issues = [];
        var boxW = mmToPx(sh.w - m * 2), boxH = mmToPx(sh.h - m * 2);
        var overW = el.scrollWidth - Math.ceil(boxW);
        if (overW > 1) {
          issues.push({
            kind: "wide",
            text: "The document is " + Math.round(overW / mmToPx(1)) +
                  "mm wider than the printable area. The right-hand columns would be cut off."
          });
        }
        var pages = Math.ceil(el.scrollHeight / boxH);
        if (pages > 1) {
          issues.push({
            kind: "pages",
            text: "This will print on " + pages + " sheets.",
            info: true
          });
        }
        return { ok: !issues.some(function (i) { return !i.info; }), issues: issues, pages: pages };
      },

      /**
       * NO HEADING IS EVER CLIPPED.
       *
       * A template can be given column widths by hand, and a hand-set width
       * knows nothing about the heading that has to sit in it. Measured on
       * a real quotation: "Sr. No." had 26px and needed 53, so it ran under
       * the next column and printed as "SR. NPRODUCT"; "Quantity" had 49px
       * and needed 69, and spilled over "Rate". Both are single words or
       * nearly so — there is no wrap that would have saved them, and the
       * cells are nowrap by design because a rate split over two lines is
       * not a rate.
       *
       * So the shortfall is measured here, where the document actually
       * exists, and taken from the widest column — which is the description,
       * the one column with room to give. Nothing is estimated: the browser
       * is asked how wide the heading is and how wide its cell is.
       *
       * Runs once per mount, before the sheet is shown.
       */
      fixClippedHeadings: function () {
        var d = frame.contentDocument;
        if (!d) return [];
        var fixed = [];
        Array.prototype.forEach.call(d.querySelectorAll("table"), function (table) {
          var head = table.querySelector("thead tr");
          if (!head) return;
          var cells = Array.prototype.slice.call(head.children);
          var short = cells.map(function (c) {
            return Math.max(0, c.scrollWidth - c.clientWidth);
          });
          var total = short.reduce(function (a, b) { return a + b; }, 0);
          if (!total) return;

          /* The widest column is the description. It is the only one that
             can lose a few millimetres without losing meaning — a number
             column cannot. */
          var widest = 0;
          cells.forEach(function (c, i) {
            if (c.getBoundingClientRect().width > cells[widest].getBoundingClientRect().width) widest = i;
          });
          var give = cells[widest].getBoundingClientRect().width - total;
          /* Never below something a description can still be read in. If
             the headings genuinely cannot fit, they are left as they are
             and validate() reports it, rather than crushing the one column
             that carries the product name. */
          if (give < 90) return;

          cells.forEach(function (c, i) {
            if (i === widest) { c.style.width = give + "px"; return; }
            if (short[i] > 0) {
              c.style.width = (c.getBoundingClientRect().width + short[i]) + "px";
              fixed.push(c.textContent.trim());
            }
          });
        });
        return fixed;
      },

      /** Send THIS document — the one on screen — to the printer. */
      print: function () {
        var w = frame.contentWindow;
        if (!w) return false;
        try { w.focus(); w.print(); return true; }
        catch (e) { return false; }
      },

      destroy: function () {
        if (stage.parentNode) stage.parentNode.removeChild(stage);
      }
    };

    frame.addEventListener("load", function () {
      /* Before anything measures or shows the sheet: a clipped heading
         changes nothing about the page's height, but it is the difference
         between a document and a defect. */
      handle.fixClippedHeadings();
      handle.fit();
      if (typeof opt.onReady === "function") opt.onReady(handle);
    });

    /* Watch the HOST, not the window.
    
       The room beside the sheet changes for reasons a resize event never
       reports: the print panel sliding in, an overlay opening, a phone
       turning on its side, a font arriving late. Measured on a 390px
       viewport the sheet was still drawn at scale(1) — laid out correctly
       at 794px, but hanging off the side of the screen — because the fit
       had been worked out while the host was still desktop-width and
       nothing had told it otherwise.
    
       A ResizeObserver asks the one question that matters, which is how
       much room this element has right now. */
    var stop = [];
    if (typeof ResizeObserver === "function") {
      handle.observer = new ResizeObserver(function () { handle.fit(); });
      handle.observer.observe(host);
      stop.push(function () { try { handle.observer.disconnect(); } catch (e) {} });
    }
    /* AND the window, because the observer cannot be relied on alone.
    
       Measured: a fresh ResizeObserver on this very host fired ZERO times
       across two deliberate width changes, so the sheet stayed at scale(1)
       inside a 360px column — laid out correctly at 794px and hanging off
       the side of it. The observer is the better signal when it works, and
       a window resize is the one that always arrives: a phone turning over,
       a window dragged narrower. Both are cheap, and fit() only writes a
       transform. */
    var onResize = function () { handle.fit(); };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    stop.push(function () {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    });

    var destroy = handle.destroy;
    handle.destroy = function () {
      stop.forEach(function (f) { f(); });
      destroy();
    };

    return handle;
  }

  /* ------------------------------------------------------------------ */

  global.PrintCanvas = {
    SHEETS: SHEETS,
    DEFAULTS: DEFAULTS,
    mmToPx: mmToPx,
    sheet: sheet,
    margin: margin,
    prefs: prefs,
    savePrefs: savePrefs,
    documentHtml: documentHtml,
    mount: mount
  };
})(window);
