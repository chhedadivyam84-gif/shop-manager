/* ============================================================
   E-WAY BILL PROVIDER ADAPTERS

   The ONLY place a provider's URLs, field names and auth flow may live.
   Everything above this file speaks the app's own vocabulary, so adding a
   GSP is one new object here and a config value — not a rewrite.

   TWO ADAPTERS NOW.

   `mock` is offline and deterministic, and is how the whole workflow —
   including every failure path — gets built and tested before any shop has
   credentials. It is deliberately never reported as "connected".

   `nic` (see nic.js) does the real e-way bill LOGIN. Authentication is a
   published NIC contract that every GSP resells the same way, so it can be
   written honestly, and every value that differs between GSPs is a
   credential the shop types in rather than something guessed at here.

   What nic.js deliberately does NOT do is generate, cancel or update. Those
   carry payloads whose shape, encryption and error codes genuinely differ
   between GSPs; writing them from memory would produce software that looks
   finished and fails at a checkpoint with a lorry waiting. They refuse
   plainly until the shop's own GSP documentation is in hand.
   ============================================================ */

/* The shape every adapter returns, so callers never branch on provider.
   Moved to its own file: each adapter needs it, and an adapter requiring it
   back from here would be a cycle. Re-exported below, so nothing that
   already imports { ok, fail } from this file has to change. */
const { ok, fail } = require("./adapters-shared");

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
const ADAPTERS = { mock, nic: require("./nic") };

/**
 * The configured adapter. Credentials and provider choice come from the
 * environment, never from the settings table — settings are readable by the
 * browser, and an API secret must never be.
 */
function currentAdapter() {
  /* The provider may now be chosen on the Settings screen as well as from
     the environment, and the environment still wins — see ewb/config.js.
     The rule that a SECRET must never be readable by the browser has not
     been relaxed at all: credentials are write-only, stripped from the
     settings the browser is handed, and reported only as set or not set. */
  const want = require("./config").provider();
  const a = ADAPTERS[want];
  if (!a) {
    // Falling back silently to mock would let a misconfigured production
    // box quietly issue fake numbers. Refuse instead.
    throw new Error(
      `The GST provider is set to "${want}", which this copy does not know. ` +
      `Known: ${Object.keys(ADAPTERS).join(", ")}.`
    );
  }
  return a;
}

module.exports = { currentAdapter, ADAPTERS, ok, fail };
