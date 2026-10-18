/* ============================================================
   CREDENTIALS AT REST

   GSP and e-way bill credentials were stored as plain JSON in
   settings.gst_credentials — and that database is copied to cloud storage
   every fifteen minutes. Anyone holding a backup file held the shop's GST
   portal password and its GSP client secret in readable text.

   They are encrypted here with AES-256-GCM, under a key kept in its own
   file beside the database. That separation is the whole point: the backup
   uploads shop-*.db and nothing else (see backup.js), so a backup on its
   own decrypts to nothing. Recovering credentials needs the machine as
   well, which is the property that was missing.

   The key file follows the same pattern as data/session-secret.txt —
   generated on first use, 0600 where the platform honours it, and listed in
   .gitignore so it cannot reach a repository.

   GCM rather than CBC because it authenticates as well as encrypts: a
   corrupted or tampered value fails loudly instead of decrypting to
   plausible rubbish that is then sent to a government portal.

   PLAINTEXT IS STILL READ. A shop upgrading has credentials already stored
   in the clear; refusing them would lock it out of e-invoicing until every
   value was retyped. Anything that is not a recognised envelope is returned
   as-is and re-saved encrypted the next time the screen writes.
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PREFIX = "enc:v1:";

function keyPath() {
  const dir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, "..", "data");
  return path.join(dir, "credential-key.txt");
}

let cachedKey = null;

/* ON A HOST WITH NO DISK THE KEY FILE DOES NOT SURVIVE.

   Render's free plan starts every container on a fresh disk, so a new
   key file was made at every restart and everything sealed under the old
   one — the AI key, GST and e-way bill credentials — opened to nothing.
   The shop saw them "forgotten" and typed them again, every time.

   CREDENTIAL_KEY, when set on the host, is the key instead (any long
   random text; it is hashed to the 32 bytes AES needs). It lives in the
   host's settings, not in the database or its backups, so the separation
   above still holds. The key file is still tried when opening, so values
   sealed before the variable was set are not lost. */
function envKey() {
  const raw = String(process.env.CREDENTIAL_KEY || "").trim();
  return raw.length >= 16 ? crypto.createHash("sha256").update(raw).digest() : null;
}

function key() {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  if (cachedKey) return cachedKey;
  const p = keyPath();
  try {
    if (fs.existsSync(p)) {
      cachedKey = Buffer.from(fs.readFileSync(p, "utf8").trim(), "hex");
      if (cachedKey.length === 32) return cachedKey;
    }
  } catch (e) { /* fall through and make a new one */ }

  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fresh.toString("hex"), { mode: 0o600 });
  } catch (e) {
    /* Read-only disk: encryption still works for this run, but a restart
       would produce a different key and the stored values would no longer
       decrypt. Louder than a silent failure, quieter than a crash. */
    console.log("[secretBox] could not write the credential key: " + e.message);
  }
  cachedKey = fresh;
  return cachedKey;
}

/** Encrypt one value. Empty stays empty — an absent credential is not a secret. */
function seal(plain) {
  const s = plain == null ? "" : String(plain);
  if (!s) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const out = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return PREFIX + iv.toString("base64") + ":" + c.getAuthTag().toString("base64") +
         ":" + out.toString("base64");
}

/** Decrypt, or hand back anything that was never sealed. */
function open(stored) {
  const s = stored == null ? "" : String(stored);
  if (!s.startsWith(PREFIX)) return s;          /* pre-encryption value */
  const [ivB, tagB, dataB] = s.slice(PREFIX.length).split(":");
  const tryKey = k => {
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
  };
  try {
    return tryKey(key());
  } catch (e) {
    /* Sealed under the key file before CREDENTIAL_KEY was set. */
    if (envKey()) {
      try {
        const p = keyPath();
        const fileKey = fs.existsSync(p) ? Buffer.from(fs.readFileSync(p, "utf8").trim(), "hex") : null;
        if (fileKey && fileKey.length === 32) return tryKey(fileKey);
      } catch (x) { /* fall through */ }
    }
    /* Wrong key, or tampering. Returning "" means the app reports the
       credential as missing and asks for it again — which is recoverable.
       Returning the ciphertext would send gibberish to a portal. */
    return "";
  }
}

function isSealed(stored) { return String(stored || "").startsWith(PREFIX); }

module.exports = { seal, open, isSealed, keyPath };
