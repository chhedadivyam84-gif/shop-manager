/* ============================================================
   E-WAY BILL PROVIDER ADAPTERS

   The ONLY place a provider's URLs, field names and auth flow may live.
   Everything above this file speaks the app's own vocabulary, so adding a
   GSP is one new object here and a config value — not a rewrite.

   No real provider is implemented yet, and none will be written from
   memory. NIC's API is not callable directly by arbitrary software: access
   needs either direct enrolment with whitelisted IPs or an authorised GSP,
   and whichever GSP is chosen, THEIR documented contract is what gets coded
   — not a guess at NIC's raw one. A fabricated endpoint produces software
   that looks finished and fails at the counter.

   So the mock below is not a placeholder to be embarrassed about: it is how
   the entire workflow, including every failure path, gets built and tested
   before credentials exist.
   ============================================================ */

/** Shape every adapter returns, so callers never branch on provider. */
function ok(data, raw) { return { ok: true, data, raw }; }
function fail(code, message, field, raw) {
  return { ok: false, error: { code, message, field: field || null }, raw };
}

/* ------------------------------------------------------------------
   MOCK — deterministic, offline, and deliberately capable of failing.

   Real integrations are mostly error handling, so a mock that only ever
   succeeds would hide the half of the code that matters. This one fails on
   recognisable inputs so those paths can be exercised on demand.
   ------------------------------------------------------------------ */
const mock = {
  id: "mock",
  label: "Mock (no provider connected)",
  needsCredentials: false,

  async authenticate() { return ok({ token: "mock-token", expiresIn: 360 }); },

  async generate(payload) {
    // Deliberate failure triggers, so the UI's error handling is testable.
    if (String(payload.toGstin || "").toUpperCase() === "00INVALID0000000") {
      return fail("3028", "GSTIN of the recipient is not registered.", "toGstin",
                  { status: 400 });
    }
    if (Number(payload.distanceKm) > 4000) {
      return fail("4004", "Distance cannot be more than 4000 km.", "distanceKm",
                  { status: 400 });
    }
    if (String(payload.docNo || "").startsWith("DUP")) {
      return fail("604", "An e-way bill already exists for this document.", "docNo",
                  { status: 400 });
    }
    if (String(payload.vehicleNo || "").toUpperCase() === "FAILNOW") {
      return fail("TIMEOUT", "The e-way bill service did not respond.", null,
                  { status: 504 });
    }

    /* A believable number and validity so the UI can be judged honestly.
       Validity here is a plain +1 day: the real rule is distance-based and
       belongs to the provider's response, never to our arithmetic. */
    const n = "3" + String(Date.now()).slice(-11);
    const today = new Date();
    const valid = new Date(today.getTime() + 86400000);
    return ok({
      ewbNo: n,
      ewbDate: today.toISOString().slice(0, 10),
      validUntil: valid.toISOString().slice(0, 10),
      status: "Generated"
    }, { status: 200, mock: true });
  },

  async cancel({ ewbNo, reason }) {
    if (!ewbNo) return fail("400", "No e-way bill number to cancel.", "ewbNo");
    if (!reason) return fail("400", "A cancellation reason is required.", "reason");
    return ok({ ewbNo, status: "Cancelled" }, { status: 200, mock: true });
  },

  async updatePartB({ ewbNo, vehicleNo }) {
    if (!vehicleNo) return fail("400", "Enter the vehicle number.", "vehicleNo");
    return ok({ ewbNo, status: "Generated" }, { status: 200, mock: true });
  }
};

/* ------------------------------------------------------------------
   Registry. A real provider is added as another object with the same four
   methods; nothing else in the app changes.
   ------------------------------------------------------------------ */
const ADAPTERS = { mock };

/**
 * The configured adapter. Credentials and provider choice come from the
 * environment, never from the settings table — settings are readable by the
 * browser, and an API secret must never be.
 */
function currentAdapter() {
  const want = (process.env.EWB_PROVIDER || "mock").toLowerCase();
  const a = ADAPTERS[want];
  if (!a) {
    // Falling back silently to mock would let a misconfigured production
    // box quietly issue fake numbers. Refuse instead.
    throw new Error(
      `EWB_PROVIDER is "${want}", which is not a known provider. ` +
      `Known: ${Object.keys(ADAPTERS).join(", ")}.`
    );
  }
  return a;
}

module.exports = { currentAdapter, ADAPTERS, ok, fail };
