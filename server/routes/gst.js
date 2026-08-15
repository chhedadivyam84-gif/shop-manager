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
const { requireRole } = require("../auth");
const { logAction } = require("../util");

const router = express.Router();

/** Which environment variables a given provider needs. Mock needs none —
 *  that is what makes it usable before anyone has signed anything. */
const REQUIRED_ENV = {
  mock: []
  // A real provider adds its own list here at the same time as its adapter,
  // so the screen can say precisely what is missing rather than "not working".
};

router.get("/status", requireRole("owner"), (req, res) => {
  let adapter, error = null;
  try { adapter = currentAdapter(); }
  catch (e) { error = e.message; }

  const provider = (process.env.EWB_PROVIDER || "mock").toLowerCase();
  const needed = REQUIRED_ENV[provider] || [];
  const missing = needed.filter(k => !process.env[k]);

  res.json({
    provider,
    providerLabel: adapter ? adapter.label : provider,
    knownProviders: Object.keys(ADAPTERS),
    environment: (process.env.GST_ENV || "sandbox").toLowerCase(),
    // Set or not set — never the value.
    credentials: needed.map(k => ({ name: k, set: !!process.env[k] })),
    missing,
    // "Connected" means a real provider with everything it asked for. The
    // mock is deliberately never connected, however well it works.
    connected: !error && provider !== "mock" && missing.length === 0,
    isMock: provider === "mock",
    error
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
