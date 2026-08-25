/* ============================================================
   OFF-SITE STORAGE

   One place that knows how to list, upload, download and delete a file
   somewhere that is not this machine. Everything else — backup.js,
   restore.js, the Cloud Backups screen — talks to this and never to a
   provider directly.

   Two providers are supported, chosen by which environment variables are
   set. Nothing else in the app changes when you switch, and switching back
   is the same move in reverse.

     SUPABASE_URL + SUPABASE_KEY            Supabase Storage  (1 GB free)
     R2_ACCOUNT_ID + R2_ACCESS_KEY_ID
       + R2_SECRET_ACCESS_KEY + R2_BUCKET   Cloudflare R2    (10 GB free)

   R2 wins if both are configured, because someone who has set up R2 has
   done so deliberately.
   ============================================================ */
const crypto = require("crypto");

const TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 120000;

/* ---------------------------------------------------------- which one */

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_KEY || "";
  const bucket = process.env.SUPABASE_BUCKET || "shop-backups";
  return { ok: !!(url && key), url, key, bucket };
}

function r2Config() {
  const account = process.env.R2_ACCOUNT_ID || "";
  const accessKey = process.env.R2_ACCESS_KEY_ID || "";
  const secret = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "shop-backups";
  return {
    ok: !!(account && accessKey && secret),
    account, accessKey, secret, bucket,
    host: `${account}.r2.cloudflarestorage.com`
  };
}

/* Set only while a forProvider() handle is in use — see the bottom of this file. */
let pinned = null;

function provider() {
  if (pinned) return pinned;
  if (r2Config().ok) return "r2";
  if (supabaseConfig().ok) return "supabase";
  return null;
}

function describe() {
  const p = provider();
  if (p === "r2") return { provider: "r2", label: "Cloudflare R2", bucket: r2Config().bucket };
  if (p === "supabase") return { provider: "supabase", label: "Supabase Storage", bucket: supabaseConfig().bucket };
  return { provider: null, label: "not set up", bucket: null };
}

/* ---------------------------------------------------------- signing R2

   R2 speaks S3, which means AWS Signature Version 4 rather than a bearer
   token. It is fiddly but entirely mechanical: hash the request, build a
   string describing it, and sign that with a key derived from the date and
   region. Getting any byte of the description wrong gives a 403 with no clue
   which byte, so each step below mirrors the AWS spec exactly.

   Region is "auto" for R2, and the payload hash must be the real SHA-256 —
   R2 rejects UNSIGNED-PAYLOAD on uploads.
*/
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/** Percent-encoding per AWS: everything except unreserved characters. */
function uriEncode(str, encodeSlash = true) {
  return String(str).replace(/[^A-Za-z0-9_.~-]/g, c =>
    (c === "/" && !encodeSlash) ? "/" : "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

function signedFetch({ method, path, query = {}, body = null, extraHeaders = {} }) {
  const cfg = r2Config();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // 20260825T110000Z
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto", service = "s3";

  const payload = body || Buffer.alloc(0);
  const payloadHash = sha256(payload);

  const headers = {
    host: cfg.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders
  };

  const signedHeaderNames = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h)]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");

  const canonicalRequest = [
    method,
    uriEncode(path, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac("AWS4" + cfg.secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? "?" + canonicalQuery : "";
  return fetch(`https://${cfg.host}${path}${qs}`, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(method === "PUT" ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS)
  });
}

/* ---------------------------------------------------------- the four verbs

   Each returns the same shape whichever provider is behind it, so callers
   never branch on which one is in use.
*/

/** Every object in the bucket, as [{ name, size }]. */
async function list() {
  const p = provider();
  if (!p) return [];

  if (p === "supabase") {
    const cfg = supabaseConfig();
    const res = await fetch(`${cfg.url}/storage/v1/object/list/${cfg.bucket}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, apikey: cfg.key, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 5000, sortBy: { column: "name", order: "desc" } }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Supabase said ${res.status}`);
    return (await res.json())
      .filter(f => f && f.name)
      .map(f => ({ name: f.name, size: (f.metadata && f.metadata.size) || 0 }));
  }

  /* R2 returns XML, and pages at 1000 keys. Followed to the end rather than
     taking the first page: a bucket with a month of backups has thousands,
     and a partial list would make rotation delete the wrong things. */
  const out = [];
  let token = null;
  do {
    const query = { "list-type": "2", "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const res = await signedFetch({ method: "GET", path: `/${r2Config().bucket}`, query });
    if (!res.ok) throw new Error(`R2 said ${res.status}`);
    const xml = await res.text();

    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const name = (/<Key>([\s\S]*?)<\/Key>/.exec(m[1]) || [])[1];
      const size = Number((/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1] || 0);
      if (name) out.push({ name: decodeXml(name), size });
    }
    token = (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml) || [])[1] || null;
  } while (token);
  return out;
}

function decodeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function upload(name, buffer) {
  const p = provider();
  if (!p) return { attempted: false };

  try {
    if (p === "supabase") {
      const cfg = supabaseConfig();
      const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${name}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.key}`, apikey: cfg.key,
          "Content-Type": "application/octet-stream",
          "x-upsert": "true"
        },
        body: buffer,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { attempted: true, ok: false, error: `Supabase ${res.status}: ${text.slice(0, 200)}` };
      }
      return { attempted: true, ok: true, object: name };
    }

    const res = await signedFetch({
      method: "PUT",
      path: `/${r2Config().bucket}/${name}`,
      body: buffer,
      extraHeaders: { "content-type": "application/octet-stream" }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { attempted: true, ok: false, error: `R2 ${res.status}: ${text.slice(0, 200)}` };
    }
    return { attempted: true, ok: true, object: name };
  } catch (err) {
    // No internet is the expected failure for a shop. Report, never throw —
    // the local snapshot has already succeeded by this point.
    return { attempted: true, ok: false, error: String(err.message || err) };
  }
}

async function download(name) {
  const p = provider();
  if (!p) throw new Error("Off-site storage is not set up.");

  if (p === "supabase") {
    const cfg = supabaseConfig();
    const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${name}`, {
      headers: { Authorization: `Bearer ${cfg.key}`, apikey: cfg.key },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`download failed for ${name}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const res = await signedFetch({ method: "GET", path: `/${r2Config().bucket}/${name}` });
  if (!res.ok) throw new Error(`download failed for ${name}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Deletes many objects. Returns how many were actually removed. */
async function remove(names) {
  const p = provider();
  if (!p || !names.length) return 0;

  if (p === "supabase") {
    const cfg = supabaseConfig();
    const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.key}`, apikey: cfg.key, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: names }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`Supabase said ${res.status}`);
    return names.length;
  }

  /* R2's batch delete needs a signed XML body with a Content-MD5; one request
     per object is slower but has no such trap, and deleting is rare. Done a
     few at a time so a thousand old backups do not open a thousand sockets. */
  let done = 0;
  const batch = 8;
  for (let i = 0; i < names.length; i += batch) {
    const slice = names.slice(i, i + batch);
    const results = await Promise.all(slice.map(async n => {
      try {
        const res = await signedFetch({ method: "DELETE", path: `/${r2Config().bucket}/${n}` });
        return res.ok || res.status === 404;   // already gone counts as done
      } catch { return false; }
    }));
    done += results.filter(Boolean).length;
  }
  return done;
}


/* ---------------------------------------------------------- one specific one

   The four verbs above act on whichever provider is configured. Moving
   backups from one to the other needs both at once, so this returns a handle
   bound to a named provider regardless of which would otherwise win.

   Only migration uses it. Everything else should stay provider-blind. */
function forProvider(name) {
  if (name !== "supabase" && name !== "r2") throw new Error("Unknown provider: " + name);
  const cfg = name === "r2" ? r2Config() : supabaseConfig();
  if (!cfg.ok) throw new Error(name + " is not configured");

  /* Held across the whole call, not just until the promise is handed back.
     Each verb happens to read the provider on its first synchronous line, so
     releasing early would work today and break the first time one of them
     grows an await above that read. */
  const only = fn => async (...args) => {
    const saved = pinned;
    pinned = name;
    try { return await fn(...args); } finally { pinned = saved; }
  };
  return {
    name,
    label: name === "r2" ? "Cloudflare R2" : "Supabase Storage",
    bucket: cfg.bucket,
    list: only(list),
    upload: only(upload),
    download: only(download),
    remove: only(remove)
  };
}

module.exports = { provider, describe, list, upload, download, remove, forProvider, configured: () => !!provider() };
