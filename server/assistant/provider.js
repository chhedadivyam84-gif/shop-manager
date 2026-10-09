/* ============================================================
   THE MODEL, KEPT AT ARM'S LENGTH

   One place where an AI provider is spoken to, so the assistant above it
   never knows which one it is. Swapping provider means rewriting this
   file and nothing else.

   THE KEY IS THE ONE THE SHOP ALREADY HAS. Bill scanning asks for a
   Google key and stores it sealed in settings; a shop that switched that
   on has already done this work, and asking them to find a second key for
   a second feature from the same provider is a setup step with nothing
   behind it. ASSISTANT_API_KEY overrides, for a host that wants the two
   features on separate keys or separate billing.

   NO NEW DEPENDENCY. This app ships three production packages and a test
   asserts it; fetch is in the runtime.
   ============================================================ */
const billScan = require("../billScan");

/* Same endpoint shape bill scanning uses, which was read from Google's
   current documentation rather than recalled — the older
   generateContent/`contents` form is a different API. */
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/* Flash, for the same reason the bill reader uses it: these are short
   turns over small amounts of retrieved data, and the shop is paying. */
const MODEL = String(process.env.ASSISTANT_MODEL || "gemini-3.8-flash").trim();

/* A shopkeeper waiting at a chat box gives up long before a photo upload
   would, so this is far shorter than the bill reader's. */
const TIMEOUT_MS = 30000;

function apiKey() {
  const own = String(process.env.ASSISTANT_API_KEY || "").trim();
  if (own) return own;
  try { return billScan.apiKey ? String(billScan.apiKey() || "").trim() : ""; }
  catch (e) { return ""; }
}

/** Can the assistant answer at all? Every screen asks before offering it. */
function configured() {
  return apiKey().length > 0;
}

/** Which key it would use, for the setup screen — never the key itself. */
function describe() {
  if (String(process.env.ASSISTANT_API_KEY || "").trim()) {
    return "its own key, from ASSISTANT_API_KEY";
  }
  if (configured()) return "the same key as bill scanning";
  return "nothing — no key is set";
}

/**
 * One turn. `schema` asks the API to enforce a JSON shape rather than
 * hoping prose can be parsed — the same mechanism the bill reader relies
 * on, and the reason its output can be trusted by code.
 *
 * Throws an Error carrying .status. Never returns a partial answer.
 */
async function ask({ system, prompt, schema }) {
  const key = apiKey();
  if (!key) {
    const e = new Error("The assistant is not set up on this server yet.");
    e.status = 503;
    throw e;
  }

  const body = {
    model: MODEL,
    system_instruction: system,
    input: [{ type: "text", text: prompt }],
  };
  if (schema) {
    body.response_format = { type: "text", mime_type: "application/json", schema };
  }

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(err && err.name === "TimeoutError"
      ? "The assistant took too long to answer. Try asking again."
      : "Could not reach the assistant service. Check the internet connection.");
    e.status = 504;
    throw e;
  }

  if (!response.ok) {
    /* The body can be an ARRAY here — [{"error":{...}}] — which is how a
       rejected key once reported itself as something else entirely in the
       bill reader. Same handling, for the same reason. */
    let detail = "", reason = "";
    try {
      const raw = await response.json();
      const j = Array.isArray(raw) ? (raw[0] || {}) : raw;
      detail = (j.error && j.error.message) || "";
      reason = (((j.error || {}).details || []).find(d => d && d.reason) || {}).reason || "";
    } catch (_) { /* a non-JSON error body is still an error */ }

    const badKey = reason === "API_KEY_INVALID" || /API key/i.test(detail)
      || response.status === 401 || response.status === 403;
    const noCredit = response.status === 429 || /quota|billing|exceeded/i.test(detail);

    /* DELIBERATELY NOT the provider's own words, except where they help.
       Their message is written for a developer and can carry request
       details; a shopkeeper needs to know whether to call their supplier
       or try again in a minute. */
    const e = new Error(
      badKey ? "The assistant's API key was not accepted. Check it in Settings."
      : noCredit ? "The assistant is out of quota right now. Try again shortly."
      : "The assistant could not answer (" + response.status + ").");
    e.status = noCredit ? 429 : badKey ? 400 : 502;
    throw e;
  }

  const body2 = await response.json().catch(() => null);

  /* The text sits in steps[].content[].text. A refusal or a safety stop
     arrives as a completed interaction with NO text rather than as an
     HTTP error, so an empty answer is treated as "could not answer"
     instead of being allowed to become a crash two lines later. */
  let out = "";
  try {
    for (const step of (body2 && body2.steps) || []) {
      for (const c of (step && step.content) || []) {
        if (c && typeof c.text === "string") out += c.text;
      }
    }
  } catch (_) { out = ""; }

  out = out.trim();
  if (!out) {
    const e = new Error("The assistant did not answer that one. Try rephrasing it.");
    e.status = 502;
    throw e;
  }
  return out;
}

/** ask(), but the answer must parse as JSON. Returns null if it does not. */
async function askJson(opts) {
  const raw = await ask(opts);
  try {
    /* Fenced code blocks happen even with an enforced schema. */
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

module.exports = { configured, describe, ask, askJson, MODEL, TIMEOUT_MS };
