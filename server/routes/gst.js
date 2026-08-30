/* ============================================================
   GST PROVIDER STATUS

   Reports whether a GST provider is connected and what is still missing.

   It never returns a credential, not even masked beyond a length. The
   browser has no business holding an API secret, and a screen that shows
   "sk_live_abc…" teaches people it is normal to have one on screen. What it
   returns is whether each variable is SET, so the owner can see what is
   missing without ever seeing what is set.
   ============================================================ */
const express = require("express");
const { currentAdapter, ADAPTERS } = require("../ewb/adapters");
const gstConfig = require("../ewb/config");
const { requireRole } = require("../auth");
const { logAction } = require("../util");

const router = express.Router();

/**
 * What a provider needs, asked of the provider.
 *
 * This used to be a table here that had to be kept in step with the
 * adapters by hand — two places to edit, and the one that gets forgotten is
 * the one that makes the screen lie about what is missing. An adapter now
 * declares its own `fields`, and this reads them.
 *
 * A field is { name, label, secret, hint }. The label is what a shopkeeper
 * reads; the name is the variable it is stored under, which they never need
 * to see. `secret: false` marks the ones that are not passwords — a base
 * URL behind a password box is an invitation to typos nobody can proofread.
 */
function fieldsFor(adapter) {
  if (adapter && Array.isArray(adapter.fields)) return adapter.fields;
  return [];
}

router.get("/status", requireRole("owner"), (req, res) => {
  let adapter, error = null;
  try { adapter = currentAdapter(); }
  catch (e) { error = e.message; }

  const provider = gstConfig.provider();
  const needed = fieldsFor(adapter);
  /* Missing means missing from BOTH places — a key set on the host counts
     exactly as much as one typed into the app. */
  const missing = needed.filter(f => !gstConfig.isSet(f.name)).map(f => f.label);

  res.json({
    provider,
    providerLabel: adapter ? adapter.label : provider,
    knownProviders: Object.keys(ADAPTERS),
    environment: gstConfig.environment(),
    /* Whether the HOST is deciding, for each of the two. Without this the
       owner can change a screen that an environment variable is quietly
       overruling, which is the most confusing kind of settings screen
       there is. */
    lockedByHost: gstConfig.providerFromEnv(),
    environmentLockedByHost: gstConfig.environmentFromEnv(),
    // Set or not set, and WHERE from — never the value.
    credentials: needed.map(f => ({
      name: f.name, label: f.label || f.name, hint: f.hint || "",
      secret: f.secret !== false,
      set: gstConfig.isSet(f.name), source: gstConfig.sourceOf(f.name)
    })),
    missing,
    // "Connected" means a real provider with everything it asked for. The
    // mock is deliberately never connected, however well it works.
    connected: !error && provider !== "mock" && missing.length === 0,
    isMock: provider === "mock",
    error
  });
});

/**
 * Set the provider, the environment and its credentials — from the app.
 *
 * OWNER ONLY, and write-only. Nothing here echoes a credential back, not
 * even the one just sent: the response says what is SET, which is what the
 * screen needs and the most a screen should ever know.
 *
 * A blank credential leaves the stored one alone. A form posts every box it
 * has, and most of the time the boxes are empty because the key is already
 * saved — treating that as "clear it" would wipe a working connection every
 * time somebody changed the environment from sandbox to production.
 */
router.put("/provider", requireRole("owner"), (req, res) => {
  const b = req.body || {};
  const want = String(b.provider || "").trim().toLowerCase();

  if (want && !ADAPTERS[want]) {
    return res.status(400).json({
      error: `"${want}" is not a provider this copy knows. Known: ${Object.keys(ADAPTERS).join(", ")}.`
    });
  }

  /* Refusing rather than silently ignoring. If the host sets EWB_PROVIDER,
     it wins — and an owner who changes this screen and sees no effect will
     reasonably decide the screen is broken. */
  if (gstConfig.providerFromEnv() && want && want !== gstConfig.provider()) {
    return res.status(409).json({
      error: "This copy's provider is fixed by its host (EWB_PROVIDER). "
           + "Change it there, or remove that setting to control it from here."
    });
  }

  if (want) gstConfig.saveProvider(want, b.environment);
  else if (b.environment) gstConfig.saveProvider(gstConfig.provider(), b.environment);

  if (b.credentials && typeof b.credentials === "object") {
    gstConfig.saveCredentials(want || gstConfig.provider(), b.credentials,
      Array.isArray(b.remove) ? b.remove : []);
  }

  /* The values never appear in the log either. */
  logAction(req, "gst.provider",
    `${gstConfig.provider()} / ${gstConfig.environment()}`);

  /* Asked of the adapter, like /status does. This line still read from the
     old REQUIRED_ENV table after that table was removed, so every save threw
     — the credentials were written, then the response blew up on the way
     out and the screen reported a failure. */
  const needed = fieldsFor(ADAPTERS[gstConfig.provider()]);
  res.json({
    ok: true,
    provider: gstConfig.provider(),
    environment: gstConfig.environment(),
    credentials: needed.map(f => ({
      name: f.name, label: f.label || f.name, hint: f.hint || "",
      secret: f.secret !== false,
      set: gstConfig.isSet(f.name), source: gstConfig.sourceOf(f.name)
    }))
  });
});

/**
 * Asks the provider to authenticate. This is the only honest test of a
 * connection: env vars being present proves nothing about whether they work.
 */
router.post("/test", requireRole("owner"), async (req, res) => {
  let adapter;
  try { adapter = currentAdapter(); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

  try {
    const r = await adapter.authenticate();
    logAction(req, "gst.test", `${adapter.id}: ${r.ok ? "ok" : "failed"}`);
    if (!r.ok) return res.status(502).json({ ok: false, error: r.error.message, code: r.error.code });
    res.json({
      ok: true,
      provider: adapter.id,
      isMock: adapter.id === "mock",
      message: adapter.id === "mock"
        ? "The mock provider answered. Nothing is being sent to the GST portal."
        : "Authenticated successfully."
    });
  } catch (e) {
    logAction(req, "gst.test", `${adapter.id}: exception`);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
