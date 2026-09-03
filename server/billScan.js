/* ============================================================
   BILL SCANNER — a photo of a supplier's bill, read into a draft

   WHAT THIS IS, AND WHAT IT IS NOT.

   This reads a picture and proposes a purchase. It does not save one.
   Nothing here writes to purchases, purchase_items or stock; the route
   hands the shop a draft and the shop presses Save on the ordinary
   purchase screen, having looked at it. That is not caution for its own
   sake — a photograph of a handwritten plywood bill is not a reliable
   document, and an entry posted from one without a human reading it would
   put wrong stock and wrong money into the books, silently.

   IT IS OPTIONAL, ALWAYS.

   No key configured means the feature is simply absent — every existing
   way of entering a purchase works exactly as before. This must never
   become a step a shop has to pass through to record a bill: the app's
   standing rule is that a shop cut off from the internet keeps billing,
   and a scanner that needs a network is on the wrong side of that rule.

   WHY THE MATCHING IS SEPARATE.

   Reading "19mm Ply 8x4 — 20 pcs @ 1450" off a photo is the easy half.
   The hard half is deciding WHICH product and WHICH size that is, because
   purchase_items needs product_id and size_id or the stock never moves.
   Four suppliers write the same board four ways. So the reading is done
   here and the matching in matchToCatalogue(), which proposes and never
   decides — an unmatched line arrives at the screen marked unmatched
   rather than quietly attached to whatever scored highest.
   ============================================================ */
const db = require("./db");
const secretBox = require("./secretBox");

/* Pure JS, no native build — the app has to keep running under Termux on
   a phone, which is why the dependency list is short and deliberate. */
const AnthropicSDK = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = "claude-opus-5";

/* A phone photo of a bill. The route caps the upload well below the
   12MB JSON body limit, and this is the same ceiling attachments use. */
const MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_TYPES = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true
};

/* ------------------------------------------------------------------ */
/* THE KEY                                                             */
/* ------------------------------------------------------------------ */

function settingsRow() {
  try {
    return db.prepare("SELECT scan_credentials FROM settings WHERE id = 1").get() || {};
  } catch (e) { return {}; }
}

/**
 * The API key, or "".
 *
 * The environment wins over the database, the same way it does for the
 * e-way bill credentials: a host that pins the key should not be
 * overridable from a screen. Anything stored is sealed; anything written
 * before sealing existed comes back unchanged rather than locking a shop
 * out of a feature it had yesterday.
 */
function apiKey() {
  const fromEnv = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  let stored = {};
  try { stored = JSON.parse(settingsRow().scan_credentials || "{}") || {}; }
  catch (e) { stored = {}; }
  return String(secretBox.open(stored.apiKey || "") || "").trim();
}

function keyFromEnv() {
  return !!String(process.env.ANTHROPIC_API_KEY || "").trim();
}

/** Is scanning available at all? Every screen asks this before offering it. */
function configured() {
  return apiKey().length > 0;
}

/** Store a key. Blank leaves the existing one alone rather than clearing it,
 *  so a form submitted with an empty box does not switch the feature off. */
function saveKey(raw) {
  const key = String(raw || "").trim();
  if (!key) return;
  let stored = {};
  try { stored = JSON.parse(settingsRow().scan_credentials || "{}") || {}; }
  catch (e) { stored = {}; }
  stored.apiKey = secretBox.seal(key);
  db.prepare("UPDATE settings SET scan_credentials = ? WHERE id = 1")
    .run(JSON.stringify(stored));
}

/** Forget the stored key. The environment one, if any, is untouched. */
function clearKey() {
  db.prepare("UPDATE settings SET scan_credentials = '' WHERE id = 1").run();
}

/* ------------------------------------------------------------------ */
/* READING THE PICTURE                                                 */
/* ------------------------------------------------------------------ */

/* The shape the answer must take. Given as a schema rather than asked for
   in prose, so the reply is a document this code can rely on instead of
   text somebody has to parse hopefully. A missing figure comes back null,
   which is honest — zero would be a number the shop might believe. */
const SCHEMA = {
  type: "object",
  properties: {
    docType: {
      type: ["string", "null"],
      enum: ["invoice", "challan", null],
      description: "invoice if it is a tax invoice or bill; challan if it is a delivery challan with no prices demanded"
    },
    supplierName: { type: ["string", "null"] },
    supplierGstin: { type: ["string", "null"] },
    invoiceNo: { type: ["string", "null"] },
    invoiceDate: {
      type: ["string", "null"],
      description: "YYYY-MM-DD. Indian bills are usually DD/MM/YYYY — convert. Null if unreadable."
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "exactly as written on the bill" },
          qty: { type: ["number", "null"] },
          unit: { type: ["string", "null"], description: "pcs, sheets, sqft, nos — as written" },
          rate: { type: ["number", "null"] },
          discountPct: { type: ["number", "null"] },
          amount: { type: ["number", "null"] }
        },
        required: ["name", "qty", "unit", "rate", "discountPct", "amount"],
        additionalProperties: false
      }
    },
    cgst: { type: ["number", "null"] },
    sgst: { type: ["number", "null"] },
    igst: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    unreadable: {
      type: "array",
      items: { type: "string" },
      description: "field names that could not be read with confidence"
    }
  },
  required: ["docType", "supplierName", "supplierGstin", "invoiceNo", "invoiceDate",
             "items", "cgst", "sgst", "igst", "total", "unreadable"],
  additionalProperties: false
};

const SYSTEM = [
  "You read photographs of Indian supplier bills for a plywood and laminate shop",
  "and return what is written on them.",
  "",
  "Rules:",
  "- Report only what you can actually see. If a figure is smudged, cut off or",
  "  ambiguous, return null for it and name it in `unreadable`. A guess that",
  "  looks like a reading is worse than an admitted gap, because the shopkeeper",
  "  cannot tell the two apart.",
  "- Copy item names EXACTLY as written, including the supplier's own",
  "  abbreviations. Do not tidy, expand or translate them — the shop matches",
  "  them against its own catalogue afterwards and needs the original wording.",
  "- Indian bills write dates as DD/MM/YYYY. Convert to YYYY-MM-DD.",
  "- A delivery challan lists goods without demanding payment; a tax invoice",
  "  demands payment. Say which this is.",
  "- Amounts are rupees. Strip commas and any currency symbol.",
  "- If the picture is not a bill at all, return empty items and say so in",
  "  `unreadable`."
].join("\n");

/**
 * Read one image.
 *
 * @param dataBase64  the image, base64, no data: prefix
 * @param mimeType    image/jpeg | image/png | image/webp | image/gif
 * @returns the schema above, plus `usage`
 */
async function readBill(dataBase64, mimeType) {
  const key = apiKey();
  if (!key) {
    const e = new Error("Bill scanning is not set up yet. Add a key in Settings.");
    e.status = 400;
    throw e;
  }
  if (!ALLOWED_TYPES[mimeType]) {
    const e = new Error("The photo must be a JPEG, PNG, WEBP or GIF.");
    e.status = 400;
    throw e;
  }
  const bytes = Buffer.from(String(dataBase64 || ""), "base64");
  if (!bytes.length) {
    const e = new Error("The photo is empty."); e.status = 400; throw e;
  }
  if (bytes.length > MAX_BYTES) {
    const e = new Error("The photo is too large (max 8MB). Take it again at a lower size.");
    e.status = 400; throw e;
  }

  const client = new Anthropic({ apiKey: key });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    /* A creased photograph of a handwritten bill is exactly the kind of
       reading that repays thinking about. Left adaptive rather than
       disabled — a wrong quantity here becomes wrong stock. */
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCHEMA }
    },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: dataBase64 } },
        { type: "text", text: "Read this bill." }
      ]
    }]
  });

  /* A safety decline is an answer, not a crash — say so plainly rather
     than letting an empty content array become a confusing parse error. */
  if (response.stop_reason === "refusal") {
    const e = new Error("The picture could not be read. Try a clearer photo of the bill.");
    e.status = 422;
    throw e;
  }

  const text = (response.content || [])
    .filter(b => b.type === "text").map(b => b.text).join("");
  let out;
  try { out = JSON.parse(text); }
  catch (err) {
    const e = new Error("The bill could not be read into a form this app understands.");
    e.status = 502;
    throw e;
  }

  out.usage = {
    inputTokens: response.usage ? response.usage.input_tokens : null,
    outputTokens: response.usage ? response.usage.output_tokens : null
  };
  return out;
}

/* ------------------------------------------------------------------ */
/* MATCHING A LINE TO THE SHOP'S OWN CATALOGUE                          */
/* ------------------------------------------------------------------ */

/* Everything that makes two ways of writing the same board look different:
   case, punctuation, the spaces around a size, and the difference between
   "8x4", "8 X 4" and "8*4". Numbers are kept — they are the size. */
function normalise(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[*×]/g, "x")
    .replace(/[^a-z0-9]+/g, " ")
    /* "8 x 4" and "8x4" are the same board. Collapsed BEFORE tokenising,
       because otherwise one bill spells the size as three words and the
       other as one, they share almost nothing, and a board the shop
       stocks reads as a product it has never bought. Measured: this took
       that spelling from 50% to 100%. */
    .replace(/(\d)\s*x\s*(\d)/g, "$1x$2")
    /* "19 mm" and "19mm" likewise — a unit written apart from its number
       is the same measurement, and plywood bills write it both ways. */
    .replace(/(\d)\s+(mm|cm|ft|in|inch|kg|sqft)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return normalise(s).split(" ").filter(Boolean);
}

/**
 * How alike are two descriptions, 0 to 1.
 *
 * Deliberately simple: shared words over the words the bill used. Not a
 * clever string distance, because the failure mode of clever here is a
 * confident wrong match, and a confident wrong match posts stock against
 * the wrong product. Anything below the threshold is reported as no match
 * and the shop picks from a list.
 */
function similarity(a, b) {
  const A = tokens(a), B = new Set(tokens(b));
  if (!A.length || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / A.length;
}

const MATCH_FLOOR = 0.5;

/**
 * Propose a product and size for each read line.
 *
 * Proposes. Never decides — every line comes back with its candidates and
 * a `matched` flag, and the screen makes the shop confirm. A line with no
 * confident match is not an error: it is a product this shop has not
 * bought before, or a supplier writing it a new way.
 */
function matchToCatalogue(items) {
  const sizes = db.prepare(`
    SELECT ps.id AS size_id, ps.label AS size_label, ps.product_id,
           p.name AS product_name, p.brand, p.category
      FROM product_sizes ps
      JOIN products p ON p.id = ps.product_id
     WHERE p.active = 1
  `).all();

  return (items || []).map(line => {
    const scored = sizes.map(s => ({
      sizeId: s.size_id,
      productId: s.product_id,
      label: [s.brand, s.product_name, s.size_label].filter(Boolean).join(" "),
      score: similarity(line.name, [s.brand, s.product_name, s.size_label].join(" "))
    })).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const matched = !!(best && best.score >= MATCH_FLOOR);
    return {
      ...line,
      matched,
      /* The top few, so the screen can offer them without a second round
         trip. Everything else is reachable through the normal picker. */
      candidates: scored.slice(0, 5).filter(c => c.score > 0),
      productId: matched ? best.productId : null,
      sizeId: matched ? best.sizeId : null,
      matchedAs: matched ? best.label : null,
      confidence: best ? Math.round(best.score * 100) : 0
    };
  });
}

/** A supplier the shop already has, by name, or null. Same rule, same floor. */
function matchSupplier(name) {
  if (!name) return null;
  const rows = db.prepare("SELECT id, name FROM suppliers").all();
  let best = null;
  for (const r of rows) {
    const score = similarity(name, r.name);
    if (!best || score > best.score) best = { id: r.id, name: r.name, score };
  }
  return best && best.score >= MATCH_FLOOR
    ? { id: best.id, name: best.name, confidence: Math.round(best.score * 100) }
    : null;
}

module.exports = {
  configured, apiKey, keyFromEnv, saveKey, clearKey,
  readBill, matchToCatalogue, matchSupplier,
  MODEL, MAX_BYTES
};
