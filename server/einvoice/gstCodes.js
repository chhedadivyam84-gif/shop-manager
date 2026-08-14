/* ============================================================
   GST CODE TABLES

   The IRP will not accept a state name or a shop's own unit wording. It
   wants the numeric state code and a UQC (Unit Quantity Code) from a fixed
   list. Both are kept here as data, and the mapping is deliberately
   conservative: anything it cannot map with confidence is reported as
   unmapped rather than guessed, because a wrong UQC is accepted by the
   portal and produces a legally wrong invoice — far worse than a rejection.
   ============================================================ */

/** State name -> GST state code. The code is also the first two digits of
 *  every GSTIN registered in that state, which is how the validator can
 *  cross-check a GSTIN against the address without a lookup service. */
const STATE_CODES = {
  "jammu and kashmir": "01", "himachal pradesh": "02", "punjab": "03",
  "chandigarh": "04", "uttarakhand": "05", "haryana": "06", "delhi": "07",
  "rajasthan": "08", "uttar pradesh": "09", "bihar": "10", "sikkim": "11",
  "arunachal pradesh": "12", "nagaland": "13", "manipur": "14",
  "mizoram": "15", "tripura": "16", "meghalaya": "17", "assam": "18",
  "west bengal": "19", "jharkhand": "20", "odisha": "21", "orissa": "21",
  "chhattisgarh": "22", "madhya pradesh": "23", "gujarat": "24",
  "daman and diu": "25", "dadra and nagar haveli and daman and diu": "26",
  "maharashtra": "27", "karnataka": "29", "goa": "30", "lakshadweep": "31",
  "kerala": "32", "tamil nadu": "33", "puducherry": "34", "pondicherry": "34",
  "andaman and nicobar islands": "35", "telangana": "36",
  "andhra pradesh": "37", "ladakh": "38", "other territory": "97"
};

function stateCode(name) {
  if (!name) return null;
  return STATE_CODES[String(name).trim().toLowerCase()] || null;
}

/** The UQC list the portal accepts, with the wordings a shop actually types
 *  mapped onto it. Only unambiguous mappings appear here on purpose. */
const UQC = {
  BAG: ["bag", "bags"],
  BOX: ["box", "boxes"],
  BDL: ["bundle", "bundles", "bdl"],
  BTL: ["bottle", "bottles"],
  CAN: ["can", "cans"],
  CBM: ["cubic meter", "cubic metre", "cbm"],
  CMS: ["centimeter", "centimetre", "cm"],
  DOZ: ["dozen", "doz"],
  DRM: ["drum", "drums"],
  GMS: ["gram", "grams", "gm", "gms", "g"],
  KGS: ["kilogram", "kilograms", "kg", "kgs"],
  KLR: ["kilolitre", "kiloliter"],
  KME: ["kilometre", "kilometer", "km"],
  LTR: ["litre", "liter", "ltr", "l"],
  MTR: ["meter", "metre", "mtr", "m", "running feet", "rft", "rft."],
  MLT: ["millilitre", "milliliter", "ml"],
  MTS: ["metric ton", "metric tonne", "mt"],
  NOS: ["number", "numbers", "nos", "no", "unit", "units"],
  PAC: ["pack", "packs", "packet", "packets", "pouch"],
  PCS: ["piece", "pieces", "pc", "pcs"],
  PRS: ["pair", "pairs"],
  QTL: ["quintal", "quintals"],
  ROL: ["roll", "rolls"],
  SET: ["set", "sets"],
  SQF: ["square feet", "square foot", "sq.ft", "sq ft", "sqft", "sft"],
  SQM: ["square meter", "square metre", "sq.m", "sqm"],
  SQY: ["square yard", "sq.yd", "sqyd"],
  TBS: ["tablet", "tablets"],
  TGM: ["ten gross"],
  THD: ["thousand"],
  TON: ["ton", "tons", "tonne", "tonnes"],
  TUB: ["tube", "tubes"],
  UGS: ["us gallon"],
  UNT: ["unit"],
  YDS: ["yard", "yards", "yd"]
};

const UQC_LOOKUP = (() => {
  const m = new Map();
  for (const [code, words] of Object.entries(UQC)) {
    m.set(code.toLowerCase(), code);
    for (const w of words) m.set(w, code);
  }
  return m;
})();

/**
 * A shop's unit wording -> UQC, or null when it cannot be mapped safely.
 * Null is a result, not a failure: the caller reports it so the owner can
 * set the right code, rather than the portal silently accepting a wrong one.
 */
function uqc(unitLabel) {
  if (!unitLabel) return null;
  const k = String(unitLabel).trim().toLowerCase().replace(/\s+/g, " ");
  return UQC_LOOKUP.get(k) || UQC_LOOKUP.get(k.replace(/\./g, "")) || null;
}

/** Every UQC the portal accepts, for a settings dropdown. */
function allUqcCodes() { return Object.keys(UQC).sort(); }

/** The first two digits of a GSTIN are its state code — used to catch an
 *  address and a GSTIN that disagree before the portal does. */
function stateCodeFromGstin(gstin) {
  const g = String(gstin || "").trim();
  return /^\d{2}/.test(g) ? g.slice(0, 2) : null;
}

/** Structural check only. It cannot prove a GSTIN is registered — only the
 *  portal knows that — but it catches typos without a network call. */
function looksLikeGstin(gstin) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
    String(gstin || "").trim().toUpperCase()
  );
}

module.exports = {
  STATE_CODES, stateCode, stateCodeFromGstin,
  UQC, uqc, allUqcCodes, looksLikeGstin
};
