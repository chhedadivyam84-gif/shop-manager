/* ============================================================
   WHERE THE GST PROVIDER'S SETTINGS COME FROM

   Two sources, and the order between them is the whole point:

     1. THE ENVIRONMENT, if it is set. A hosted copy that already carries
        EWB_PROVIDER and its keys keeps behaving exactly as it did, and a
        secret held by the host never reaches this app's database — so it
        never reaches the nightly backup either, which is a real difference
        and the reason the environment stays first.

     2. THE SETTINGS ROW, written from the Settings screen. For a shop
        running its own copy, being told to "set an environment variable"
        is being told the feature is not for them.

   THE CREDENTIAL IS WRITE-ONLY. It goes in from the screen and never comes
   back out: publicSettings() strips the column, and the status endpoint
   answers "set" or "not set". Nothing in this file has a function that
   returns a secret to a caller outside the server.
   ============================================================ */
const db = require("../db");

/** The settings row, or an empty object if the table is not ready yet. */
function row() {
  try { return db.prepare("SELECT gst_provider, gst_env, gst_credentials FROM settings WHERE id = 1").get() || {}; }
  catch (e) { return {}; }
}

/** Which provider this copy is pointed at. */
function provider() {
  const fromEnv = String(process.env.EWB_PROVIDER || "").trim();
  if (fromEnv) return fromEnv.toLowerCase();
  return String(row().gst_provider || "mock").trim().toLowerCase() || "mock";
}

/** sandbox or production. Anything unrecognised is sandbox, because the
 *  safe answer to "I am not sure" is the one that sends nothing real. */
function environment() {
  const fromEnv = String(process.env.GST_ENV || "").trim().toLowerCase();
  const stored = String(row().gst_env || "").trim().toLowerCase();
  const v = fromEnv || stored || "sandbox";
  return v === "production" ? "production" : "sandbox";
}

/** True when the environment, not the database, decides the provider —
 *  worth telling the owner, or they will edit a screen that cannot win. */
/** Same question for the environment: a host that pins GST_ENV overrules
 *  the screen, and the screen has to be able to say so. */
function environmentFromEnv() {
  return !!String(process.env.GST_ENV || "").trim();
}

function providerFromEnv() {
  return !!String(process.env.EWB_PROVIDER || "").trim();
}

/** Everything stored under the current provider, as an object. Server-side
 *  callers only: an adapter needs the values to sign a request. */
function credentials() {
  let all = {};
  try { all = JSON.parse(row().gst_credentials || "{}") || {}; } catch (e) { all = {}; }
  const mine = all[provider()] || {};
  const out = {};
  /* The environment wins per KEY, not per provider, so one secret can be
     moved to the host without moving all of them. */
  for (const [k, v] of Object.entries(mine)) out[k] = v;
  return out;
}

/** One credential, environment first. */
function credential(name) {
  const fromEnv = String(process.env[name] || "").trim();
  if (fromEnv) return fromEnv;
  return String(credentials()[name] || "");
}

/** Whether a credential has a value, without ever saying what it is. */
function isSet(name) { return credential(name).length > 0; }

/** Where a credential came from, for a screen that has to explain itself. */
function sourceOf(name) {
  if (String(process.env[name] || "").trim()) return "environment";
  if (String(credentials()[name] || "")) return "app";
  return null;
}

/**
 * Store credentials for a provider.
 *
 * A blank value LEAVES what is already there — a form that posts empty
 * boxes must not wipe a working key. Removing one is deliberate, through
 * `remove`.
 */
function saveCredentials(providerId, values, remove) {
  const key = String(providerId || "").trim().toLowerCase();
  if (!key) throw new Error("No provider named.");
  let all = {};
  try { all = JSON.parse(row().gst_credentials || "{}") || {}; } catch (e) { all = {}; }
  const mine = { ...(all[key] || {}) };

  for (const [k, v] of Object.entries(values || {})) {
    const val = String(v == null ? "" : v).trim();
    if (val) mine[k] = val;                 // blank leaves the old value alone
  }
  for (const k of (remove || [])) delete mine[k];

  all[key] = mine;
  db.prepare("UPDATE settings SET gst_credentials = ? WHERE id = 1").run(JSON.stringify(all));
}

function saveProvider(providerId, env) {
  db.prepare("UPDATE settings SET gst_provider = ?, gst_env = ? WHERE id = 1")
    .run(String(providerId || "").trim().toLowerCase(),
         String(env || "").trim().toLowerCase() === "production" ? "production" : "sandbox");
}

module.exports = {
  provider, environment, providerFromEnv, environmentFromEnv,
  credentials, credential, isSet, sourceOf,
  saveCredentials, saveProvider
};
