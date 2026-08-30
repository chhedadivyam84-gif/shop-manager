/* ============================================================
   E-WAY BILL AUTHENTICATION — the NIC handshake

   WHAT THIS IS, AND WHAT IT IS NOT.

   This implements the AUTHENTICATION step of the National Informatics
   Centre e-Way Bill API, which is a published contract every GSP resells
   the same way. Nothing here is invented: the handshake below is the one
   NIC documents.

   It does NOT generate, cancel or update an e-way bill. Those carry a
   payload whose exact shape, encryption and error mapping differ between
   GSPs, and writing them from memory would produce software that looks
   finished and fails at a counter with a lorry waiting. They return a plain
   refusal until the shop's own GSP documentation is in hand.

   So what a shop gets today is the thing that was actually asked for: they
   put their e-way bill credentials into the app, press a button, and are
   told — truthfully — whether the GST portal accepted them.

   NOTHING IS HARDCODED TO ONE PROVIDER. Every value that differs between
   GSPs is a credential the shop enters: the base URL, the client id and
   secret, and the public key their GSP issues. Where a GSP's request
   differs from the standard anyway, the failure returns that provider's own
   HTTP status and response body rather than a generic "could not connect",
   so the difference is visible instead of mysterious.

   THE HANDSHAKE, in the order it happens:

     1. Make a random 256-bit AES key — the "app key". It exists for this
        one login and is never stored.
     2. Encrypt it with the public key the GSP issued, and base64 it.
     3. Base64 the portal password. This is encoding, not encryption; the
        transport security is TLS, exactly as NIC specifies.
     4. POST action=ACCESSTOKEN with username, password and app_key.
     5. A success carries `authtoken` and `sek` — the session key, itself
        AES-encrypted with the app key from step 1.
     6. Decrypt `sek` with the app key. That is the key every later payload
        would be encrypted with, which is why the handshake has to happen
        before anything else can.
   ============================================================ */
const crypto = require("crypto");
const config = require("./config");
const { ok, fail } = require("./adapters-shared");

/* Every value that varies between GSPs, as something the shop types in.
   `secret: false` marks the ones that are not passwords — a base URL behind
   a password box is just an invitation to typos nobody can proofread. */
const FIELDS = [
  { name: "EWB_BASE_URL", label: "GSP API address", secret: false,
    hint: "Given by your GSP, e.g. https://api.yourgsp.com/ewaybillapi/v1.03" },
  { name: "EWB_GSTIN", label: "Your GSTIN", secret: false,
    hint: "The GSTIN the e-way bill account is registered under" },
  { name: "EWB_USERNAME", label: "E-Way Bill username", secret: false,
    hint: "The username you use on the government e-way bill portal" },
  { name: "EWB_PASSWORD", label: "E-Way Bill password", secret: true,
    hint: "Your password on the government e-way bill portal" },
  { name: "EWB_CLIENT_ID", label: "GSP Client ID", secret: true,
    hint: "Issued by your GSP when you signed up" },
  { name: "EWB_CLIENT_SECRET", label: "GSP Client Secret", secret: true,
    hint: "Issued by your GSP" },
  { name: "EWB_PUBLIC_KEY", label: "GSP public key", secret: true,
    hint: "The PEM public key your GSP issues, beginning -----BEGIN PUBLIC KEY-----" }
];

/* A token is good for a few hours. Cached per GSTIN so a shop that prints
   twenty challans does not log in twenty times — and NIC rate-limits
   repeated logins, so this is politeness as much as speed.

   Held in memory only: a token is a live credential and has no business in
   a database that gets backed up to the cloud every fifteen minutes. */
const tokens = new Map();
const SAFETY_MS = 5 * 60 * 1000;   // renew five minutes early

function cached(gstin) {
  const t = tokens.get(gstin);
  if (t && t.expiresAt - SAFETY_MS > Date.now()) return t;
  return null;
}

/** The PEM as the GSP gave it, tolerating a key pasted as one line with
 *  \n escapes — which is how it usually arrives out of a dashboard. */
function publicKeyPem() {
  const raw = String(config.credential("EWB_PUBLIC_KEY") || "").trim();
  if (!raw) return "";
  const pem = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  if (pem.includes("BEGIN")) return pem;
  /* A bare base64 body with no armour is common enough to be worth
     accepting rather than refusing with "invalid key". */
  return "-----BEGIN PUBLIC KEY-----\n" +
         pem.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n").trim() +
         "\n-----END PUBLIC KEY-----";
}

function missingFields() {
  return FIELDS.filter(f => !config.isSet(f.name)).map(f => f.label);
}

const nic = {
  id: "nic",
  label: "NIC e-Way Bill (through your GSP)",
  needsCredentials: true,
  fields: FIELDS,

  /**
   * Log in to the e-way bill system with the shop's own credentials.
   *
   * Returns the app's usual shape. A failure carries the provider's real
   * words wherever it gave any — a shopkeeper can act on "invalid username
   * or password", and cannot act on "authentication failed".
   */
  async authenticate() {
    const gaps = missingFields();
    if (gaps.length) {
      return fail("SETUP", "Still to fill in: " + gaps.join(", ") + ".", null, null);
    }

    const gstin = config.credential("EWB_GSTIN").trim().toUpperCase();
    const hit = cached(gstin);
    if (hit) return ok({ token: hit.token, expiresIn: Math.round((hit.expiresAt - Date.now()) / 1000), cached: true });

    let encAppKey, appKey;
    try {
      appKey = crypto.randomBytes(32);
      encAppKey = crypto.publicEncrypt(
        { key: publicKeyPem(), padding: crypto.constants.RSA_PKCS1_PADDING },
        appKey
      ).toString("base64");
    } catch (e) {
      /* Almost always a mangled paste of the key, and saying so saves an
         afternoon of looking at the network instead. */
      return fail("BADKEY",
        "The GSP public key could not be read — check it was pasted whole, " +
        "including the BEGIN and END lines. (" + e.message + ")", "EWB_PUBLIC_KEY");
    }

    const base = config.credential("EWB_BASE_URL").trim().replace(/\/+$/, "");
    const url = base + "/authenticate";
    const body = JSON.stringify({
      action: "ACCESSTOKEN",
      username: config.credential("EWB_USERNAME").trim(),
      /* Base64, per NIC. Encoding, not encryption — TLS is the transport
         security, and pretending otherwise would be security theatre. */
      password: Buffer.from(config.credential("EWB_PASSWORD"), "utf8").toString("base64"),
      app_key: encAppKey
    });

    let res, text;
    try {
      const ctl = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          /* The header names most GSPs use, being NIC's own. A GSP that
             differs will reject the call, and the body it rejects with is
             returned below so the difference is visible rather than
             guessed at. */
          "client-id": config.credential("EWB_CLIENT_ID"),
          "client-secret": config.credential("EWB_CLIENT_SECRET"),
          "gstin": gstin
        },
        body,
        signal: ctl
      });
      text = await res.text();
    } catch (e) {
      return fail("NETWORK",
        "Could not reach " + base + " — check the GSP API address and that this " +
        "server can reach the internet. (" + e.message + ")", "EWB_BASE_URL");
    }

    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* handled below */ }

    if (!data) {
      return fail("BADRESPONSE",
        "The GSP answered with something that is not JSON (HTTP " + res.status + "). " +
        "This usually means the API address points at the wrong path.",
        "EWB_BASE_URL", { status: res.status, body: text.slice(0, 400) });
    }

    /* NIC answers status "1" for success and "0" for failure, and puts the
       reason in `error` — sometimes as a string of JSON, sometimes as an
       object. Both are unwrapped so the shop reads a sentence. */
    const status = String(data.status ?? "");
    if (status !== "1") {
      let msg = "";
      const err = data.error ?? data.message ?? data.errorMessage;
      if (typeof err === "string") {
        try { const inner = JSON.parse(err); msg = inner.message || inner.errorCodes || err; }
        catch (e2) { msg = err; }
      } else if (err && typeof err === "object") {
        msg = err.message || err.errorCodes || JSON.stringify(err);
      }
      return fail(String(data.errorCode || res.status),
        msg || "The e-way bill service refused the login.", null,
        { status: res.status, body: text.slice(0, 400) });
    }

    const authtoken = data.authtoken || data.authToken || (data.data && data.data.authtoken);
    const sek = data.sek || (data.data && data.data.sek);
    if (!authtoken) {
      return fail("NOTOKEN", "The login succeeded but no token came back.", null,
                  { status: res.status, body: text.slice(0, 400) });
    }

    /* The session key, needed by every later call. Decrypting it here is
       also the last proof that the handshake really worked end to end: a
       wrong app key fails at exactly this step. */
    let sessionKey = null;
    if (sek) {
      try {
        const d = crypto.createDecipheriv("aes-256-ecb", appKey, null);
        d.setAutoPadding(true);
        sessionKey = Buffer.concat([d.update(Buffer.from(sek, "base64")), d.final()]);
      } catch (e) {
        return fail("BADSEK",
          "Logged in, but the session key could not be decoded. The GSP may " +
          "wrap this differently — send me their documentation. (" + e.message + ")");
      }
    }

    /* Six hours is NIC's stated life. Taken from the response where the GSP
       supplies one rather than assumed. */
    const ttlMs = (Number(data.expiresIn) > 0 ? Number(data.expiresIn) * 1000 : 6 * 3600 * 1000);
    tokens.set(gstin, { token: authtoken, sessionKey, expiresAt: Date.now() + ttlMs });

    return ok({ token: authtoken, expiresIn: Math.round(ttlMs / 1000), gstin });
  },

  /* ----------------------------------------------------------------
     Not written from memory. Each of these carries a payload whose shape,
     encryption and error codes differ between GSPs, and a guess here is a
     lorry stopped at a checkpoint with a number that was never real.
     ---------------------------------------------------------------- */
  async generate() {
    return fail("NOTREADY",
      "Login works, but generating an e-way bill needs your GSP's payload " +
      "documentation before it can be switched on. Send it and this is a " +
      "short job.");
  },
  async cancel() {
    return fail("NOTREADY", "Cancelling needs your GSP's documentation first.");
  },
  async updatePartB() {
    return fail("NOTREADY", "Updating Part B needs your GSP's documentation first.");
  }
};

module.exports = nic;
