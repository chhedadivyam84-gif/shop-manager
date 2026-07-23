/* ============================================================
   PLYWOOD / TIMBER PRICING — SHARED MATH
   ------------------------------------------------------------
   Loaded BOTH by the browser (plain <script>, exposes window.Pricing)
   and by the server (require()). One copy is deliberate: the invoice
   the customer sees and the invoice the server stores must never
   disagree by a paisa, and one source of truth is the only way.

   Two quantities per line, and they are not the same number:

     pieces    — physical sheets/planks leaving the godown.
                 Inventory is decremented by THIS.
     billedQty — area / length / volume the customer pays for.
                 The rate is multiplied by THIS.

   UNITS FOLLOW TRADE CONVENTION, which is not internally consistent
   and must not be "tidied up":
     Sq.ft / Sq.m / Rft -> length and width in FEET
     CFT (gun feet)     -> thickness and width in INCHES, length in FEET
   The ÷144 in the CFT formula is precisely what reconciles those
   inches to feet (12 in × 12 in = 144 sq.in = 1 sq.ft).
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Pricing = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 1 sq.m = 10.7639 sq.ft. Held at 4 dp because that is the figure printed on
  // trade rate cards; the exact 1/0.3048² = 10.76391041... would make our
  // invoices disagree with a customer's own hand calculation.
  const SQFT_PER_SQM = 10.7639;

  const MODES = {
    SQFT: {
      key: "SQFT", label: "Square Feet", unit: "Sq.ft", decimals: 2,
      needsLength: true, needsWidth: true, needsThickness: false,
      lengthUnit: "ft", widthUnit: "ft", thicknessUnit: "",
      formula: "Width × Length × Qty"
    },
    SQM: {
      key: "SQM", label: "Square Meter", unit: "Sq.m", decimals: 2,
      needsLength: true, needsWidth: true, needsThickness: false,
      lengthUnit: "ft", widthUnit: "ft", thicknessUnit: "",
      formula: "Sq.ft ÷ 10.7639"
    },
    RFT: {
      key: "RFT", label: "Running Feet", unit: "Rft", decimals: 2,
      needsLength: true, needsWidth: false, needsThickness: false,
      lengthUnit: "ft", widthUnit: "", thicknessUnit: "",
      formula: "Length × Qty"
    },
    CFT: {
      key: "CFT", label: "Gun Feet (CFT)", unit: "CFT", decimals: 3,
      needsLength: true, needsWidth: true, needsThickness: true,
      lengthUnit: "ft", widthUnit: "in", thicknessUnit: "in",
      formula: "(Thk″ × Width″ × Length′ ÷ 144) × Qty"
    },
    UNIT: {
      key: "UNIT", label: "Per Piece", unit: "Pc", decimals: 2,
      needsLength: false, needsWidth: false, needsThickness: false,
      lengthUnit: "", widthUnit: "", thicknessUnit: "",
      formula: "Qty"
    }
  };

  // Order shown in the UI — the two most-used plywood modes first.
  const MODE_KEYS = ["SQFT", "SQM", "RFT", "CFT", "UNIT"];

  function normaliseMode(mode) {
    const key = String(mode || "").toUpperCase();
    return MODES[key] ? key : "SQFT";
  }

  function num(v) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function roundTo(n, decimals) {
    const f = Math.pow(10, decimals);
    // +EPSILON nudges float-boundary values (e.g. 1.005) up to the decimal a
    // human expects rather than down.
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  function round2(n) { return roundTo(n, 2); }

  /** 8 -> "8", 8.5 -> "8.5" (no trailing ".00" on whole numbers). */
  function trimNum(n) {
    return String(Math.round(num(n) * 1000) / 1000);
  }

  /**
   * Quantity contributed by ONE piece, in the units of `mode`.
   * Returns 0 when the geometry that mode needs is missing.
   */
  function perPieceQty(mode, lengthFt, widthVal, thicknessIn) {
    const key = normaliseMode(mode);
    const L = num(lengthFt), W = num(widthVal), T = num(thicknessIn);

    if (key === "UNIT") return 1;
    if (L <= 0) return 0;
    if (key === "RFT") return L;
    if (W <= 0) return 0;
    if (key === "SQFT") return L * W;                 // both feet
    if (key === "SQM") return (L * W) / SQFT_PER_SQM; // sq.ft -> sq.m
    if (key === "CFT") {                              // T″ × W″ × L′ ÷ 144
      if (T <= 0) return 0;
      return (T * W * L) / 144;
    }
    return 0;
  }

  /**
   * Whole line: geometry + pieces + rate -> billed quantity and amount.
   *
   * Rounding order is deliberate: round the TOTAL quantity first, then
   * multiply by the rate. The printed amount is then exactly
   * (printed qty × printed rate), so a customer checking on a calculator
   * gets our number. Rounding the other way is marginally more accurate
   * but yields invoices that look wrong by a rupee.
   */
  function computeLine(input) {
    const mode = normaliseMode(input.mode);
    const m = MODES[mode];
    const lengthFt = num(input.lengthFt);
    const widthVal = num(input.widthVal);
    const thicknessIn = num(input.thicknessIn);
    const pieces = num(input.pieces);
    const rate = num(input.rate);

    const per = perPieceQty(mode, lengthFt, widthVal, thicknessIn);
    const billedQty = roundTo(per * pieces, m.decimals);
    const amount = round2(billedQty * rate);

    return {
      mode, unit: m.unit, decimals: m.decimals,
      lengthFt, widthVal, thicknessIn, pieces, rate,
      perPiece: roundTo(per, m.decimals),
      billedQty, amount,
      sizeLabel: sizeLabel(mode, lengthFt, widthVal, thicknessIn)
    };
  }

  /**
   * "8 × 4", "10 ft", "2 × 4 × 8" — the size as it appears on the invoice.
   * Width/thickness are inches in CFT and feet elsewhere; the column header
   * carries the units so the cell itself stays short.
   */
  function sizeLabel(mode, lengthFt, widthVal, thicknessIn) {
    const key = normaliseMode(mode);
    const m = MODES[key];
    const L = num(lengthFt), W = num(widthVal), T = num(thicknessIn);
    if (key === "UNIT") return "";
    if (!L) return "";
    if (key === "RFT") return trimNum(L) + " ft";
    if (!W) return "";
    if (key === "CFT") {
      if (!T) return "";
      return trimNum(T) + "″ × " + trimNum(W) + "″ × " + trimNum(L) + "′";
    }
    // Length first: the trade writes an 8ft × 4ft sheet as "8 × 4", never "4 × 8".
    return trimNum(L) + " × " + trimNum(W);
  }

  /**
   * Rate that preserves the line AMOUNT when the display unit changes.
   *
   * Sq.ft and Sq.m describe the same piece of board, so toggling between them
   * must not change what the customer pays: ₹30/Sq.ft over 320 Sq.ft is the
   * same ₹9,600 as ₹322.9062/Sq.m over 29.73 Sq.m.
   *
   * Naively scaling the rate by 10.7639 does NOT hold the amount, because the
   * area and the rate each get rounded and the two errors compound (that route
   * lands on ₹9,600.41). So we derive the new rate from the amount we must
   * hit and the ALREADY-ROUNDED target quantity: rate = amount / billedQty.
   *
   * RATE_DP is 4 rather than 2 for the same reason — at 2 dp the residue is
   * still ~₹0.11 on a ₹9,600 line. Four decimals brings it inside a paisa,
   * which rounds away cleanly. Screens and the printed invoice still SHOW the
   * rate at 2 dp; the extra digits exist only to keep the total honest.
   *
   * Only the Sq.ft <-> Sq.m pair converts. Rft and CFT measure different
   * things (length, volume) with no meaningful rate to carry across, so
   * switching to them keeps the rate and lets the user retype it.
   */
  const RATE_DP = 4;

  /**
   * Can a rate meaningfully cross from one mode to the other?
   * Only Sq.ft <-> Sq.m, because they measure the same thing in different
   * units. ₹322/Sq.m is NOT ₹322/CFT — those measure area and volume — so
   * callers must make the user re-enter the rate instead of carrying it.
   */
  function isRateConvertible(fromMode, toMode) {
    const from = normaliseMode(fromMode), to = normaliseMode(toMode);
    return (from === "SQFT" && to === "SQM") || (from === "SQM" && to === "SQFT");
  }

  function convertLineRate(line, toMode) {
    const from = normaliseMode(line.mode);
    const to = normaliseMode(toMode);
    const rate = num(line.rate);
    if (from === to) return rate;
    if (!isRateConvertible(from, to)) return rate;

    const amount = computeLine(line).amount;
    const target = computeLine(Object.assign({}, line, { mode: to })).billedQty;
    if (!target) return rate;
    return roundTo(amount / target, RATE_DP);
  }

  /**
   * Scalar rate conversion, for when there is no line context (e.g. converting
   * a product's stored list price). Amount preservation is not possible here —
   * use convertLineRate on a real line whenever you can.
   */
  function convertRate(rate, fromMode, toMode) {
    const from = normaliseMode(fromMode), to = normaliseMode(toMode);
    const r = num(rate);
    if (from === "SQFT" && to === "SQM") return roundTo(r * SQFT_PER_SQM, RATE_DP);
    if (from === "SQM" && to === "SQFT") return roundTo(r / SQFT_PER_SQM, RATE_DP);
    return r;
  }

  /**
   * Validation shared by the billing screen and the API, so the message shown
   * while typing is the same one the server would reject with.
   * Returns null when the line is good, else a human-readable string.
   */
  function validateLine(input, name) {
    const mode = normaliseMode(input.mode);
    const m = MODES[mode];
    const label = name || "this item";
    if (num(input.pieces) <= 0) return `Enter the quantity for ${label}.`;
    if (m.needsLength && num(input.lengthFt) <= 0) return `Enter the length (${m.lengthUnit}) for ${label}.`;
    if (m.needsWidth && num(input.widthVal) <= 0) return `Enter the width (${m.widthUnit}) for ${label}.`;
    if (m.needsThickness && num(input.thicknessIn) <= 0) return `Enter the thickness (${m.thicknessUnit}) for ${label} — CFT needs it.`;
    if (!(num(input.rate) >= 0)) return `Enter a valid rate for ${label}.`;
    if (computeLine(input).billedQty <= 0) return `The size and quantity for ${label} work out to zero.`;
    return null;
  }

  /** "320 Sq.ft", "29.73 Sq.m", "0.667 CFT" */
  function formatQty(qty, mode) {
    const m = MODES[normaliseMode(mode)];
    const v = roundTo(num(qty), m.decimals);
    // Whole numbers read better bare: "320 Sq.ft", not "320.00 Sq.ft".
    return (Number.isInteger(v) ? String(v) : v.toFixed(m.decimals)) + " " + m.unit;
  }

  /** "₹30/Sq.ft" */
  function formatRate(rate, mode) {
    const m = MODES[normaliseMode(mode)];
    const v = num(rate);
    return "₹" + (Number.isInteger(v) ? String(v) : String(roundTo(v, 2))) + "/" + m.unit;
  }

  /* ------------------------------------------------------------
     AMOUNT IN WORDS (Indian numbering: lakh / crore)
     Printed on the invoice because GST rules expect the total to be
     unambiguous, and because a written total is much harder to alter
     on a paper copy than a numeral.
     ------------------------------------------------------------ */
  const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function twoDigits(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  }

  function threeDigits(n) {
    const h = Math.floor(n / 100), rest = n % 100;
    let out = "";
    if (h) out += ONES[h] + " Hundred";
    if (rest) out += (out ? " " : "") + twoDigits(rest);
    return out;
  }

  function wholeToWords(n) {
    if (n === 0) return "Zero";
    let out = "";
    // Indian grouping: crore, lakh, thousand, then the last three digits.
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) out += threeDigits(crore) + " Crore ";
    if (lakh) out += threeDigits(lakh) + " Lakh ";
    if (thousand) out += threeDigits(thousand) + " Thousand ";
    if (n) out += threeDigits(n);
    return out.trim();
  }

  /** 9600.5 -> "Rupees Nine Thousand Six Hundred and Fifty Paise Only" */
  function amountInWords(amount) {
    const value = Math.max(0, round2(num(amount)));
    const rupees = Math.floor(value);
    const paise = Math.round((value - rupees) * 100);
    let out = "Rupees " + wholeToWords(rupees);
    if (paise > 0) out += " and " + twoDigits(paise) + " Paise";
    return out + " Only";
  }

  return {
    MODES, MODE_KEYS, SQFT_PER_SQM,
    normaliseMode, perPieceQty, computeLine, validateLine,
    convertRate, convertLineRate, isRateConvertible,
    sizeLabel, formatQty, formatRate, amountInWords,
    roundTo, round2, trimNum
  };
});
