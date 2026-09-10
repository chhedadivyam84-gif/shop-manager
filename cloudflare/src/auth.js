/* ============================================================
   AUTH WITHOUT express-session

   The app reads `req.session` in 108 places across 58 route files, so
   the goal here is not to design a new authentication model — it is to
   put the SAME nine fields back on `req.session` without a stateful
   Express process underneath.

   Those fields, by how often they are read:
     staffName(39) role(23) staffId(13) tenant(11) loggedIn(10)
     previewStaffId(6) businessId(6) previewStaffName(4) destroy(1)

   WHAT CHANGES AND WHAT DOES NOT

   PIN hashing does not change at all. server/auth.js uses
   scryptSync(pin, salt, 64) and workerd produces byte-identical output,
   verified against Node. Every PIN already in every shop keeps working —
   nobody has to re-enter anything on migration. This was worth proving
   before writing a line of it.

   The store does change. express-session kept sessions in their own
   SQLite file, deliberately, because "a session is not shop data and
   has no business in the backup". That reasoning still holds, so
   sessions live in the Durable Object's KEY-VALUE storage rather than
   its SQL tables — same object, separate store, so a SQL-level export
   of the shop's books contains no sessions.

   WHY THE COOKIE IS SIGNED AND NOT JUST A RANDOM ID

   The cookie has to name the tenant as well as the session, because the
   Worker must know which Durable Object to ask before it can look
   anything up. An unsigned tenant field would let a caller point their
   session id at somebody else's shop. Signing means the pair cannot be
   edited. The session id inside is still the real authority.
   ============================================================ */

const COOKIE = "sm_sid";
const enc = new TextEncoder();

/* base64url, because a cookie value may not contain +, / or = padding. */
function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export async function signSession(tenant, sid, secret) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ t: tenant, s: sid })));
  const key = await hmacKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return `${payload}.${b64urlEncode(mac)}`;
}

/* Returns { tenant, sid } or null. crypto.subtle.verify is constant-time,
   which is why the comparison is not done by hand. */
export async function readSession(cookieValue, secret) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 1) return null;

  const payload = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);

  let ok = false;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(mac), enc.encode(payload));
  } catch { return null; }
  if (!ok) return null;

  try {
    const { t, s } = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!t || !s) return null;
    return { tenant: String(t), sid: String(s) };
  } catch { return null; }
}

export function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, maxAgeSec) {
  /* HttpOnly so page scripts cannot read it; SameSite=Lax so a link from
     WhatsApp still arrives logged in while a cross-site POST does not;
     Secure because workers.dev is always HTTPS. */
  const bits = [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  return bits.join("; ");
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export const COOKIE_NAME = COOKIE;

/* ------------------------------------------------------------------
   The guards the routes already use.

   requireAuth and requireRole are copied in behaviour from
   server/auth.js, including the two distinct refusal messages — the
   owner-only wording is what staff actually see in the shop, so it is
   not something to reword in passing.
   ------------------------------------------------------------------ */
export function isLoggedIn(session) {
  return !!(session && session.loggedIn);
}

export function hasRole(session, ...roles) {
  return !!(session && session.loggedIn && roles.includes(session.role));
}

export function refusalFor(roles) {
  return roles.length === 1 && roles[0] === "owner"
    ? "Only the shop owner can do this."
    : "You don't have permission to do this.";
}
