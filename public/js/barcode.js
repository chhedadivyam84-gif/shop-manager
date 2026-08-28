/* ============================================================
   CODE 128 — drawing a barcode the shop can print

   Written here rather than pulled in as a library. The whole of Code 128 is
   a lookup table and a checksum, and a barcode that a scanner refuses to
   read is a barcode nobody can debug through somebody else's minified file.

   CODE SET B, which covers every printable ASCII character from space to
   "~". The codes this app generates are of the form SKU-FK2EZB-2 — capital
   letters, digits and a hyphen — so B carries them with room to spare.
   Code C would pack pairs of digits more tightly, but only digits, and
   splitting a code between sets to save a few millimetres is how an encoder
   grows the bug that only shows up on one product in a hundred.

   Every symbol is 11 modules wide, written below as the widths of its six
   alternating bars and spaces (bar first). The stop symbol is the exception
   at 13 modules across seven elements.
   ============================================================ */
(function (global) {
  "use strict";

  var PATTERNS = [
    "212222","222122","222221","121223","121322","131222","122213","122312",
    "132212","221213","221312","231212","112232","122132","122231","113222",
    "123122","123221","223211","221132","221231","213212","223112","312131",
    "311222","321122","321221","312212","322112","322211","212123","212321",
    "232121","111323","131123","131321","112313","132113","132311","211313",
    "231113","231311","112133","112331","132131","113123","113321","133121",
    "313121","211331","231131","213113","213311","213131","311123","311321",
    "331121","312113","312311","332111","314111","221411","431111","111224",
    "111422","121124","121421","141122","141221","112214","112412","122114",
    "122411","142112","142211","241211","221114","413111","241112","134111",
    "111242","121142","121241","114212","124112","124211","411212","421112",
    "421211","212141","214121","412121","111143","111341","131141","114113",
    "114311","411113","411311","113141","114131","311141","411131","211412",
    "211214","211232","2331112"
  ];

  var START_B = 104, STOP = 106;

  /** Which characters Code B can carry. Anything else has to be refused
   *  rather than silently dropped — a label missing a character is a label
   *  that scans as a different product. */
  function encodable(text) {
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 32 || c > 126) return false;
    }
    return true;
  }

  /**
   * The symbol values for a string, checksum and stop included.
   *
   * The checksum is the start value plus each data value multiplied by its
   * position (counting from one), modulo 103. Getting the weighting off by
   * one is the classic way to produce a barcode that looks perfect and
   * scans as nothing at all.
   */
  function values(text) {
    var out = [START_B];
    var sum = START_B;
    for (var i = 0; i < text.length; i++) {
      var v = text.charCodeAt(i) - 32;
      out.push(v);
      sum += v * (i + 1);
    }
    out.push(sum % 103);
    out.push(STOP);
    return out;
  }

  /** The bar/space widths for a string, as one flat list starting on a bar. */
  function widths(text) {
    var vals = values(text);
    var runs = [];
    for (var i = 0; i < vals.length; i++) {
      var pat = PATTERNS[vals[i]];
      for (var j = 0; j < pat.length; j++) runs.push(Number(pat[j]));
    }
    return runs;
  }

  /**
   * An SVG barcode, sized in millimetres so it prints at a known size
   * whatever the screen.
   *
   * `module` is the width of the narrowest bar. 0.33mm is the usual floor
   * for an ordinary laser printer and a cheap scanner; going below it is
   * where labels start failing to read on some machines and not others,
   * which is the worst kind of fault to chase.
   *
   * QUIET ZONE is not decoration. Code 128 needs ten clear modules either
   * side, and a barcode butted against a border or another label is one a
   * scanner will not see at all.
   */
  function svg(text, opts) {
    opts = opts || {};
    var module = opts.module || 0.33;      // mm
    var height = opts.height || 12;        // mm, bars only
    var quiet = 10 * module;
    var showText = opts.text !== false;
    var fontSize = opts.fontSize || 2.6;   // mm
    var textGap = showText ? fontSize + 0.6 : 0;

    if (!encodable(text)) return "";

    var runs = widths(text);
    var totalModules = runs.reduce(function (a, b) { return a + b; }, 0);
    var w = totalModules * module + quiet * 2;
    var h = height + textGap;

    var rects = "";
    var x = quiet;
    var isBar = true;
    for (var i = 0; i < runs.length; i++) {
      var runW = runs[i] * module;
      if (isBar) {
        rects += '<rect x="' + round(x) + '" y="0" width="' + round(runW) +
                 '" height="' + round(height) + '"/>';
      }
      x += runW;
      isBar = !isBar;
    }

    var label = "";
    if (showText) {
      /* Human-readable, because the day the scanner has a flat battery
         somebody still has to be able to type the code in. */
      label = '<text x="' + round(w / 2) + '" y="' + round(h - 0.2) +
              '" text-anchor="middle" font-family="monospace" font-size="' + fontSize +
              '" fill="#000">' + esc(text) + '</text>';
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + round(w) + 'mm" height="' + round(h) +
           'mm" viewBox="0 0 ' + round(w) + ' ' + round(h) + '" shape-rendering="crispEdges">' +
           '<rect x="0" y="0" width="' + round(w) + '" height="' + round(h) + '" fill="#fff"/>' +
           '<g fill="#000">' + rects + '</g>' + label + '</svg>';
  }

  /**
   * How many modules wide this code is, quiet zones included.
   *
   * Needed before anything is drawn, because a barcode does not wrap: a
   * twelve-character code at a readable bar width is about 62mm across,
   * which does not fit a 38mm address label at any sensible size. The label
   * layout uses this to work out the widest bar that WILL fit, and to say so
   * plainly when nothing sensible does, rather than printing a sheet of
   * stickers too fine for the shop's scanner to read.
   */
  function modulesFor(text) {
    if (!encodable(text)) return 0;
    return widths(text).reduce(function (a, b) { return a + b; }, 0) + 20;
  }

  /**
   * The widest bar that fits `mm` of label, capped so it never looks silly
   * on a big label, and never claims to fit when it cannot.
   *
   * Returns 0 when even the narrowest sensible bar is too wide. 0.25mm is
   * the floor: below it, labels start reading on one scanner and not
   * another, which is the worst kind of fault to be chasing at a counter.
   */
  function fitModule(text, mm, opts) {
    opts = opts || {};
    var floor = opts.min || 0.25;
    var cap = opts.max || 0.42;
    var m = modulesFor(text);
    if (!m) return 0;
    var fits = mm / m;
    if (fits < floor) return 0;
    return Math.min(cap, fits);
  }

  /* ============================================================
     READING ONE BACK

     The browser has a barcode reader of its own, and where it exists it is
     better than this — it is written in C++ and knows a dozen symbologies.
     But it does not exist on an iPhone at all, and not on a desktop
     browser either, and a shop holding a phone that cannot scan does not
     care whose fault that is.

     This only has to read the labels this app prints, which are Code 128
     and nothing else, so it can be small: measure the bars, turn the
     widths into symbols, check the checksum. It is used when the browser
     has nothing of its own, and as a second opinion when it does.
     ============================================================ */

  /** The pattern table, keyed by its six digits, so a lookup is one step. */
  var BY_PATTERN = null;
  function patternIndex() {
    if (BY_PATTERN) return BY_PATTERN;
    BY_PATTERN = {};
    for (var i = 0; i < PATTERNS.length; i++) BY_PATTERN[PATTERNS[i]] = i;
    return BY_PATTERN;
  }

  /**
   * Decode a run-length list — the widths of alternating dark and light
   * bars, starting with dark — into the text it spells.
   *
   * Returns null for anything at all wrong. A barcode read wrongly is far
   * worse than one not read: it puts a different product on the bill.
   */
  function decodeRuns(runs, startsDark) {
    if (!startsDark || runs.length < 6 * 3 + 7) return null;
    var table = patternIndex();

    /* The start symbol is eleven modules across six bars, so those six give
       the module width to measure the rest against. Re-estimated as it goes,
       because a label photographed at an angle is wider at one end. */
    var unit = 0;
    for (var i = 0; i < 6; i++) unit += runs[i];
    unit /= 11;
    if (unit <= 0) return null;

    var symbols = [];
    var at = 0;
    while (at + 6 <= runs.length) {
      /* The stop symbol is seven bars, not six. */
      var isStop = false;
      if (at + 7 <= runs.length) {
        var stopKey = quantise(runs, at, 7, unit);
        if (stopKey && table[stopKey] === STOP) { symbols.push(STOP); isStop = true; at += 7; }
      }
      if (isStop) break;

      var key = quantise(runs, at, 6, unit);
      if (!key) return null;
      var v = table[key];
      if (v === undefined || v === STOP) return null;
      symbols.push(v);

      /* Follow the drift: this symbol was eleven modules wide, whatever it
         measured, so the next one is measured against that. */
      var span = 0;
      for (var j = 0; j < 6; j++) span += runs[at + j];
      unit = (unit * 3 + span / 11) / 4;
      at += 6;
    }

    if (symbols.length < 4) return null;
    if (symbols[symbols.length - 1] !== STOP) return null;
    if (symbols[0] !== START_B) return null;          /* only what we print */

    var data = symbols.slice(1, -2);
    var claimed = symbols[symbols.length - 2];
    var sum = START_B;
    for (var k = 0; k < data.length; k++) sum += data[k] * (k + 1);
    if (sum % 103 !== claimed) return null;           /* THE guard */

    var text = "";
    for (var n = 0; n < data.length; n++) {
      if (data[n] > 94) return null;                  /* a shift or a set change */
      text += String.fromCharCode(data[n] + 32);
    }
    return text;
  }

  /** `count` runs from `at`, as a pattern key, or null if they do not round
   *  cleanly to whole modules. */
  function quantise(runs, at, count, unit) {
    var key = "", total = 0;
    for (var i = 0; i < count; i++) {
      var n = Math.round(runs[at + i] / unit);
      if (n < 1 || n > 4) return null;
      /* A bar more than a third off a whole number of modules is not a bar
         that was read properly. */
      if (Math.abs(runs[at + i] / unit - n) > 0.35) return null;
      key += n; total += n;
    }
    if (total !== (count === 7 ? 13 : 11)) return null;
    return key;
  }

  /**
   * Find a barcode anywhere in an image.
   *
   * Reads several horizontal lines rather than one: a label is rarely
   * straight on and one line through it may cross a finger, a crease or the
   * printed text. Each line is thresholded on its own, because one side of
   * a photograph is usually brighter than the other.
   */
  function decodeImageData(px, width, height, opts) {
    opts = opts || {};
    var lines = opts.lines || 15;
    var tryBoth = opts.reversed !== false;

    for (var n = 0; n < lines; n++) {
      /* Spread over the middle half, where a held label sits. */
      var y = Math.floor(height * (0.25 + 0.5 * (n / Math.max(1, lines - 1))));
      if (y < 0 || y >= height) continue;

      var row = new Array(width);
      var min = 255, max = 0;
      var base = y * width * 4;
      for (var x = 0; x < width; x++) {
        var o = base + x * 4;
        /* Green alone is a good enough stand-in for brightness and a third
           of the work of a proper luminance. */
        var lum = px[o + 1];
        row[x] = lum;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      if (max - min < 40) continue;            /* flat: no barcode on this line */
      var mid = (min + max) / 2;

      var runs = [], cur = row[0] < mid, len = 0;
      for (var x2 = 0; x2 < width; x2++) {
        var dark = row[x2] < mid;
        if (dark === cur) { len++; }
        else { runs.push(len); cur = dark; len = 1; }
      }
      runs.push(len);

      var startsDark = row[0] < mid;
      var got = scanFrom(runs, startsDark);
      if (got) return got;
      if (tryBoth) {
        /* Photographed upside down, which happens constantly. */
        var rev = runs.slice().reverse();
        var revStartsDark = (runs.length % 2 === 1) ? startsDark : !startsDark;
        got = scanFrom(rev, revStartsDark);
        if (got) return got;
      }
    }
    return null;
  }

  /** Try every plausible starting bar on one line. */
  function scanFrom(runs, startsDark) {
    for (var i = 0; i + 40 <= runs.length + 6; i++) {
      var thisIsDark = startsDark ? (i % 2 === 0) : (i % 2 === 1);
      if (!thisIsDark) continue;
      var got = decodeRuns(runs.slice(i), true);
      if (got) return got;
    }
    return null;
  }

  function round(n) { return Math.round(n * 1000) / 1000; }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  global.Barcode = { svg: svg, widths: widths, values: values, encodable: encodable,
                     modulesFor: modulesFor, fitModule: fitModule,
                     decodeRuns: decodeRuns, decodeImageData: decodeImageData };

  if (typeof module !== "undefined" && module.exports) module.exports = global.Barcode;

})(typeof window !== "undefined" ? window : globalThis);
