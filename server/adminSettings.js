/* ============================================================
   ADMIN SETTINGS — the shop's own settings, not a second set

   PART 12. This app has had a Settings system since before it had
   staff accounts: routes/settings.js, 300 lines, eight endpoints, and
   validation that has been corrected in place over a long time — the
   theme whitelist that stops a bill printing unstyled, the http-only
   check on the portal address that stops a "javascript:" link reaching
   an href, the clamp that stops a letterhead three feet tall, the
   six-digit PIN code the GST portals demand.

   So this module does NOT save anything itself. Every write goes
   through those same handlers, which routes/settings.js now exports for
   the purpose, exactly as routes/customers.js exports updateCustomer so
   that an admin edit IS the shop's edit rather than a second copy of
   the rules that will drift from it.

   WHAT THIS MODULE IS, then: a CATALOGUE. One table that says what a
   setting is called, what it means in words, what shape a valid value
   has, and which section it belongs to — and that table drives the API
   and the screen together, so a field cannot appear on one and not the
   other.

   WHAT IS DELIBERATELY NOT HERE
   -----------------------------
   A currency picker. Every amount in this app is a rupee, in 99 places
   across the server and the browser, and there is no currency column
   anywhere. A dropdown offering dollars would change nothing except
   what the screen claims — and section 7 of the brief warns precisely
   about a currency change silently reinterpreting historical amounts.
   The currency is reported as a fact instead.

   A date-format or language picker, for the same reason: both are
   fixed (en-IN) and nothing reads a preference.

   A timezone picker. The timezone IS configurable — through the TZ
   environment variable, read once at boot — but Node caches it, and
   index.js carries a long note on why re-assigning it at runtime can
   silently resolve to the wrong zone. A database setting that only took
   effect after a restart, and might not then, is worse than no setting.
   Reported as a fact, with where it comes from.

   A Notifications section. This app has no notification system — no
   mail transport, no address column on a staff row, nothing to
   configure — and section 11 says not to build one here.

   A Security section. Session length (30 days) and the login lockout
   (5 attempts) are constants in the source, not preferences. They are
   reported as facts; inventing switches for them would mean building
   the behaviour too, which is not this module's job.

   An "empty" category for any of the above. Section 6 says not to
   create pages to make the menu look larger, so there are five editable
   sections and one read-only one, and every field in them is real.
   ============================================================ */
const db = require("./db");
const shopSettings = require("./routes/settings");
const { STATE_CODES, looksLikeGstin } = require("./einvoice/gstCodes");

/* ------------------------------------------------------------------
   VALIDATION

   Server-side, and the only validation that counts — the screen checks
   the same rules so a person is told early, but nothing here trusts it.
   Each returns null when the value is acceptable, or the sentence the
   person should read when it is not.
   ------------------------------------------------------------------ */
const v = {
  required: (label) => (val) =>
    String(val === undefined || val === null ? "" : val).trim()
      ? null : label + " cannot be blank.",

  max: (n, label) => (val) =>
    String(val === undefined || val === null ? "" : val).length <= n
      ? null : label + " is too long — keep it to " + n + " characters.",

  /* Deliberately permissive about what an address looks like and strict
     about what it must not contain. A pattern tight enough to reject
     every invalid address rejects valid ones too, and a shopkeeper
     locked out of saving their own address by a regular expression has
     been failed by the software. */
  email: (val) => {
    const s = String(val || "").trim();
    if (!s) return null;                       // blank is allowed
    if (s.length > 120) return "Email address is too long.";
    if (/\s/.test(s)) return "An email address cannot contain spaces.";
    if (!/^[^@]+@[^@.]+\.[^@]+$/.test(s)) return "That does not look like an email address.";
    return null;
  },

  /* http and https ONLY — for a value that ends up in an href, where a
     "javascript:" or "data:" address is a link that runs code when
     somebody clicks it. The same rule the shop's own handler applies to
     portal_url; stated here too so the screen can refuse it before the
     round trip. */
  url: (label) => (val) => {
    const s = String(val || "").trim();
    if (!s) return null;
    if (s.length > 300) return label + " is too long.";
    if (!/^https?:\/\/[^\s]+$/i.test(s)) {
      return label + " must start with http:// or https://";
    }
    return null;
  },

  /* A WEB ADDRESS AS A SHOPKEEPER WRITES IT, which is the looser rule
     and the correct one for `website`.
     ------------------------------------------------------------
     This shop has "www.swagatply.com" stored — no scheme — and the
     strict rule above was applied to it at first. The effect was that
     the owner could not save the Business section at all until they
     edited a field they had not touched, because a value already in
     their database failed validation. Found by loading their real
     settings, not by a test.
     The distinction is real and the existing code already makes it:
     website is PRINTED as text on a document, portal_url goes into an
     href. So this refuses a dangerous scheme and otherwise accepts what
     a person would write on a letterhead. */
  webAddress: (label) => (val) => {
    const s = String(val || "").trim();
    if (!s) return null;
    if (s.length > 300) return label + " is too long.";
    if (/\s/.test(s)) return label + " cannot contain spaces.";
    /* Any scheme at all other than http/https is refused outright. */
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) {
      return label + " must be a plain web address, or start with http:// or https://";
    }
    if (!/\.[a-z]{2,}/i.test(s)) return "That does not look like a web address.";
    return null;
  },

  /* Indian numbers, usually several of them, often written with spaces
     and slashes and the word "or". Only the characters are checked. */
  phones: (val) => {
    const s = String(val || "").trim();
    if (!s) return null;
    if (s.length > 120) return "Phone numbers are too long for one line.";
    if (!/^[0-9+()\-,/\s]+$/.test(s)) {
      return "Phone numbers may contain digits, spaces, + ( ) - , and / only.";
    }
    if (!/\d/.test(s)) return "That does not contain a phone number.";
    return null;
  },

  gstin: (val) => {
    const s = String(val || "").trim().toUpperCase();
    if (!s) return null;                       // a shop may be unregistered
    if (s.length !== 15) return "A GSTIN is exactly 15 characters.";
    if (!looksLikeGstin(s)) return "That is not a valid GSTIN.";
    return null;
  },

  pinCode: (val) => {
    const s = String(val || "").trim();
    if (!s) return null;
    if (!/^\d{6}$/.test(s)) return "A PIN code is exactly 6 digits.";
    return null;
  },

  state: (val) => {
    const s = String(val || "").trim();
    if (!s) return null;
    return Object.prototype.hasOwnProperty.call(STATE_CODES, s.toLowerCase())
      ? null : "That is not a state this app knows.";
  },

  oneOf: (list, label) => (val) => {
    const s = String(val === undefined || val === null ? "" : val);
    if (!s) return null;
    return list.includes(s) ? null : "That is not a " + label + " this app knows.";
  },

  /* A positive whole number, for the document counters. */
  counter: (label) => (val) => {
    if (val === undefined || val === null || String(val).trim() === "") return null;
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1) return label + " must be a whole number of 1 or more.";
    if (n > 9999999) return label + " is larger than the seven digits a document number has.";
    return null;
  },
};

/* Run a field's rules in order and return the first complaint. */
function checkField(field, value) {
  for (const rule of field.rules || []) {
    const problem = rule(value);
    if (problem) return problem;
  }
  return null;
}

/* ------------------------------------------------------------------
   THE CATALOGUE

   `column` is where the value lives in the settings row; `send` is the
   key the shop's own handler expects in its body. Both are named
   because they differ — the table is snake_case and the handler has
   always taken camelCase, and inventing a third convention here would
   mean a mapping somebody has to keep in their head.
   ------------------------------------------------------------------ */
const STATE_NAMES = Object.keys(STATE_CODES)
  .map(k => k.replace(/\b\w/g, c => c.toUpperCase()))
  .sort();

const SECTIONS = [
  {
    key: "business",
    label: "Business",
    blurb: "Who the shop is. These details print on every invoice, challan and "
         + "purchase order, and the GST fields are what the e-invoice and e-way "
         + "bill portals check.",
    via: "settings",
    fields: [
      { key: "businessName", column: "business_name", label: "Business name",
        type: "text", required: true,
        help: "The name printed at the top of every document.",
        rules: [v.required("Business name"), v.max(120, "Business name")] },

      /* A real gap rather than a new idea: the column exists and
         ewb/service.js reads it for the e-way bill's From name, but no
         screen in this app ever offered a field, so it was always
         blank and every e-way bill went out under the trading name. */
      { key: "legalName", column: "legal_name", label: "Legal name",
        type: "text",
        help: "The registered name, if it differs from the trading name. Used on "
            + "e-way bills. Leave blank to use the business name.",
        rules: [v.max(120, "Legal name")] },

      { key: "tagline", column: "tagline", label: "Tagline",
        type: "text", help: "A short line under the business name on printed documents.",
        rules: [v.max(120, "Tagline")] },

      { key: "address", column: "address", label: "Address",
        type: "textarea", help: "The shop's address, as it should print.",
        rules: [v.max(300, "Address")] },

      { key: "pinCode", column: "pin_code", label: "PIN code",
        type: "text", placeholder: "400001",
        help: "Six digits. Both GST portals refuse a document without one.",
        rules: [v.pinCode] },

      { key: "state", column: "state", label: "State",
        type: "select", options: STATE_NAMES,
        help: "Decides whether a bill carries CGST + SGST or IGST.",
        rules: [v.state] },

      { key: "phones", column: "phones", label: "Phone",
        type: "text", placeholder: "98765 43210, 98765 43211",
        help: "One or more numbers, separated however you like.",
        rules: [v.phones] },

      { key: "email", column: "email", label: "Email",
        type: "email", rules: [v.email] },

      { key: "website", column: "website", label: "Website",
        type: "text", placeholder: "www.example.com",
        help: "Printed on documents as text. A plain address is fine.",
        rules: [v.webAddress("Website")] },

      { key: "gstin", column: "gstin", label: "GSTIN",
        type: "text", placeholder: "27AAAAA0000A1Z5",
        help: "Fifteen characters. Leave blank if the shop is not registered.",
        rules: [v.gstin] },

      { key: "upiId", column: "upi_id", label: "UPI ID",
        type: "text", placeholder: "shop@okhdfcbank",
        help: "Printed on bills so a customer can pay by UPI.",
        rules: [v.max(100, "UPI ID")] },
    ],
  },

  {
    key: "documents",
    label: "Invoices & documents",
    blurb: "How printed documents look and what they say. Changing anything here "
         + "affects documents printed from now on; nothing already issued is "
         + "altered.",
    via: "settings",
    fields: [
      { key: "invoiceTitle", column: "invoice_title", label: "Invoice heading",
        type: "text", required: true,
        help: "The banner across the top of a tax invoice.",
        rules: [v.required("Invoice heading"), v.max(60, "Invoice heading")] },

      { key: "challanTitle", column: "challan_title", label: "Challan heading",
        type: "text", required: true,
        rules: [v.required("Challan heading"), v.max(60, "Challan heading")] },

      { key: "footerMessage", column: "footer_message", label: "Footer message",
        type: "textarea",
        help: "The closing line on a printed document. May be left blank.",
        rules: [v.max(300, "Footer message")] },

      { key: "showCopyLabel", column: "show_copy_label", label: "Print the copy label",
        type: "toggle",
        help: 'Prints "Original for Recipient", "Duplicate for Transporter" and so on.' },

      { key: "invoiceTheme", column: "invoice_theme", label: "Invoice layout",
        type: "select", optionsFrom: "printThemes",
        rules: [v.oneOf(shopSettings.PRINT_THEMES, "layout")] },

      { key: "challanTheme", column: "challan_theme", label: "Challan layout",
        type: "select", optionsFrom: "printThemes",
        rules: [v.oneOf(shopSettings.PRINT_THEMES, "layout")] },

      { key: "bankName", column: "bank_name", label: "Bank name",
        type: "text",
        help: "The shop's own bank, printed in the Bank Details box so a customer "
            + "knows where to pay. Nothing here touches the Bank Book.",
        rules: [v.max(80, "Bank name")] },
      { key: "bankAccountNo", column: "bank_account_no", label: "Account number",
        type: "text", rules: [v.max(40, "Account number")] },
      { key: "bankIfsc", column: "bank_ifsc", label: "IFSC",
        type: "text", rules: [v.max(20, "IFSC")] },
      { key: "bankBranch", column: "bank_branch", label: "Branch",
        type: "text", rules: [v.max(80, "Branch")] },

      { key: "portalUrl", column: "portal_url", label: "Customer portal address",
        type: "url", placeholder: "https://…",
        help: "Printed on documents so a customer can look up their account. "
            + "Must start with http:// or https://",
        rules: [v.url("Customer portal address")] },
    ],
  },

  {
    key: "operations",
    label: "Sales & stock",
    blurb: "How the billing screen behaves.",
    via: "settings",
    fields: [
      /* A real business-impact switch, so it is marked sensitive and the
         screen asks before saving it. */
      { key: "allowNegativeStock", column: "allow_negative_stock",
        label: "Allow billing below zero stock",
        type: "toggle", sensitive: true,
        help: "When off, the billing screen refuses to sell more than the racks "
            + "say are there. Turning it on lets a sale go through and leaves the "
            + "count negative until somebody corrects it.",
        impact: "This changes what the billing screen will accept, for everyone, "
              + "from the next bill onwards." },
    ],
  },

  {
    key: "numbering",
    label: "Document numbering",
    blurb: "Where the Estimate and Delivery Challan series stand. Set these when "
         + "moving over from a paper book, so the next digital number continues "
         + "from the last paper one.",
    via: "numbering",
    sensitive: true,
    fields: [
      { key: "nextEstimateNumber", label: "Next Estimate number",
        type: "number", sensitive: true,
        help: "The number the next Estimate will be given.",
        impact: "Setting this below a number already issued would produce a second "
              + "document with the same number. Document numbers must stay unique.",
        rules: [v.counter("Next Estimate number")] },
      { key: "nextChallanNumber", label: "Next Challan number",
        type: "number", sensitive: true,
        help: "The number the next Delivery Challan will be given.",
        impact: "Setting this below a number already issued would produce a second "
              + "document with the same number. Document numbers must stay unique.",
        rules: [v.counter("Next Challan number")] },
    ],
  },

  {
    key: "appearance",
    label: "Appearance",
    blurb: "The colour scheme of the shop app. Affects the screen only — printed "
         + "documents use the layouts set under Invoices & documents.",
    via: "appTheme",
    fields: [
      { key: "theme", column: "app_theme", label: "Colour scheme",
        type: "select", optionsFrom: "appThemes",
        rules: [v.oneOf(shopSettings.APP_THEMES, "colour scheme")] },
    ],
  },
];

/* The read-only one. Not a settings category pretending to be empty —
   it answers the question a settings page otherwise leaves hanging:
   why is there no currency field, and what IS the timezone? */
const SYSTEM_SECTION = {
  key: "system",
  label: "System",
  readOnly: true,
  blurb: "Fixed in this build. Shown so the answers are in one place rather than "
       + "guessed at.",
};

function systemFacts() {
  return [
    { label: "Currency", value: "Indian rupee (₹)",
      note: "Fixed. Every amount in this app is a rupee and there is no currency "
          + "column — a currency setting would change what this page claims and "
          + "nothing else." },
    { label: "Timezone", value: process.env.TZ || "Asia/Kolkata",
      note: "Read from the TZ environment variable when the app starts. Every "
          + "stored date is the shop's calendar date, so this decides which day a "
          + "late-night bill belongs to." },
    { label: "Date format", value: "Stored as YYYY-MM-DD, shown as DD/MM/YYYY",
      note: "Fixed." },
    { label: "Language", value: "English (India)", note: "Fixed." },
    { label: "Financial year starts", value: monthName(fyStartMonth()),
      note: "Changing this would move documents already issued into different "
          + "financial years, so it is not edited here. Financial years are "
          + "opened and closed on the shop app's own Financial Years screen." },
    { label: "Staff stay signed in for", value: "30 days",
      note: "Fixed in this build. A session survives a restart." },
    { label: "Wrong PIN attempts allowed", value: "5, then a 15 minute wait",
      note: "Fixed in this build. Counted per account and address together." },
    { label: "Where settings are stored", value: "This shop's own database",
      note: "Never in the browser. Each business has its own file, and which one "
          + "is written is decided by who is signed in." },
  ];
}

function fyStartMonth() {
  try {
    const s = db.prepare("SELECT fy_start_month FROM settings WHERE id = 1").get();
    return (s && s.fy_start_month) || 4;
  } catch (e) { return 4; }
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
function monthName(n) {
  return MONTHS[(Number(n) || 4) - 1] || "April";
}

/* ------------------------------------------------------------------
   READING

   Through the shop's own publicSettings(), which is the single place
   that decides what a settings row may leave the server as — including
   the credentials it strips. The admin panel does not get an opinion of
   its own about that.
   ------------------------------------------------------------------ */
function currentValues() {
  const s = shopSettings.publicSettings();
  const out = {};

  for (const section of SECTIONS) {
    out[section.key] = {};
    for (const f of section.fields) {
      if (!f.column) continue;
      let val = s[f.column];
      if (f.type === "toggle") val = !!val;
      else val = val === null || val === undefined ? "" : String(val);
      out[section.key][f.key] = val;
    }
  }

  /* The counters are not columns on the settings row. */
  out.numbering = {
    nextEstimateNumber: shopSettings.readCounter("estimate-no") + 1,
    nextChallanNumber: shopSettings.readCounter("challan-no") + 1,
  };

  return out;
}

/** Everything the screen needs, in one call. */
function describe() {
  const values = currentValues();
  const optionLists = {
    printThemes: shopSettings.PRINT_THEMES.slice(),
    appThemes: shopSettings.APP_THEMES.slice(),
  };

  return {
    sections: SECTIONS.map(sec => ({
      key: sec.key,
      label: sec.label,
      blurb: sec.blurb,
      sensitive: !!sec.sensitive,
      fields: sec.fields.map(f => ({
        key: f.key,
        label: f.label,
        type: f.type,
        help: f.help || "",
        placeholder: f.placeholder || "",
        required: !!f.required,
        sensitive: !!f.sensitive,
        impact: f.impact || "",
        options: f.options || (f.optionsFrom ? optionLists[f.optionsFrom] : null),
      })),
      values: values[sec.key] || {},
    })).concat([{
      key: SYSTEM_SECTION.key,
      label: SYSTEM_SECTION.label,
      blurb: SYSTEM_SECTION.blurb,
      readOnly: true,
      sensitive: false,
      fields: [],
      values: {},
      facts: systemFacts(),
    }]),
  };
}

/* ------------------------------------------------------------------
   WRITING

   validate() is the whole of this module's contribution to a save: it
   checks the submitted values against the catalogue and hands back
   either the complaints or a body shaped the way the shop's own handler
   expects. The handler does the writing.

   A FIELD THE SECTION DOES NOT OWN IS IGNORED, not rejected and
   certainly not written. The shop's handler keeps any column its body
   does not mention, so quietly passing an unexpected key through would
   be the one way this screen could change something it does not show.
   ------------------------------------------------------------------ */
function sectionByKey(key) {
  return SECTIONS.filter(s => s.key === String(key)) [0] || null;
}

function validate(sectionKey, body) {
  const section = sectionByKey(sectionKey);
  if (!section) return { ok: false, status: 404, error: "No such settings section." };

  const given = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!given) return { ok: false, status: 400, error: "Send the settings as an object." };

  const errors = {};
  const payload = {};

  for (const f of section.fields) {
    if (!Object.prototype.hasOwnProperty.call(given, f.key)) continue;

    let val = given[f.key];
    if (f.type === "toggle") val = !!val;
    else if (f.type === "number") val = val === "" || val === null ? "" : Number(val);
    else val = val === null || val === undefined ? "" : String(val).trim();

    const problem = checkField(f, val);
    if (problem) { errors[f.key] = problem; continue; }

    payload[f.key] = val;
  }

  if (Object.keys(errors).length) {
    return { ok: false, status: 400, error: "Some values need correcting.", fields: errors };
  }
  if (!Object.keys(payload).length) {
    return { ok: false, status: 400, error: "Nothing to save." };
  }

  return { ok: true, section, payload };
}

module.exports = {
  describe, validate, currentValues, sectionByKey, systemFacts,
  SECTIONS, SYSTEM_SECTION, STATE_NAMES,
  /* Exported so the test suite can exercise a rule directly rather than
     only through a route. */
  rules: v, checkField,
};
