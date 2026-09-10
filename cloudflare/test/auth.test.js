/* ============================================================
   END-TO-END AUTH, against a running `wrangler dev`.

   Runs the happy path, but the point is the rest: a tampered cookie, a
   cookie minted for one shop replayed against another, an owner-only
   route reached by a staff account, and the brute-force lockout. An auth
   test that only proves the right PIN works has tested nothing.

   Each run uses a fresh random tenant so no state carries between runs
   and nothing touches the migrated `swagat` data.

   Usage: node test/auth.test.js [baseUrl]
   ============================================================ */
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const SHOP = "authtest-" + Math.random().toString(36).slice(2, 8);
const PIN = "4821";

let pass = 0, fail = 0;
const ok = (l, c, x) => {
  if (c) { pass++; console.log(`  ok    ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${x !== undefined ? "   -> " + x : ""}`); }
};

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  return raw.split(";")[0];
}

async function call(path, { method = "GET", body, cookie, shop = SHOP } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}shop=${shop}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual",
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json, cookie: cookieFrom(res) };
}

console.log(`\nbase: ${BASE}\nshop: ${SHOP}\n`);

/* ---------- 1. before anyone signs in ---------- */
console.log("UNAUTHENTICATED");
{
  const s = await call("/api/auth/session");
  ok("session says not logged in", s.body?.loggedIn === false, JSON.stringify(s.body));

  const h = await call("/api/health");
  ok("protected route refuses with 401", h.status === 401, h.status);
  ok("refusal wording matches the Express app", h.body?.error === "Not logged in", h.body?.error);
}

/* ---------- 2. seed a staff member with a PIN we know ---------- */
const owner = (await call("/api/dev/seed-staff", { method: "POST", body: { name: "Test Owner", pin: PIN, role: "owner" } })).body;
const clerk = (await call("/api/dev/seed-staff", { method: "POST", body: { name: "Test Clerk", pin: PIN, role: "staff" } })).body;

console.log("\nLOGIN SCREEN DATA");
{
  const list = await call("/api/auth/staff-list");
  ok("staff list is public (login screen needs it)", list.status === 200, list.status);
  ok("both seeded staff appear", (list.body || []).length >= 2, (list.body || []).length);
  const leaked = JSON.stringify(list.body).includes("pin_hash") || JSON.stringify(list.body).includes(":");
  ok("no pin_hash is exposed", !JSON.stringify(list.body).includes("pin_hash"));
}

/* ---------- 3. wrong PIN ---------- */
console.log("\nWRONG PIN");
{
  const bad = await call("/api/auth/login", { method: "POST", body: { staffId: owner.id, pin: "0000" } });
  ok("rejected with 401", bad.status === 401, bad.status);
  ok("wording matches the Express app", bad.body?.error === "Incorrect PIN.", bad.body?.error);
  ok("no cookie is issued", !bad.cookie);

  const unknown = await call("/api/auth/login", { method: "POST", body: { staffId: "STAFF_nope", pin: PIN } });
  ok("unknown staff gives the SAME error (no enumeration)",
     unknown.body?.error === "Incorrect PIN.", unknown.body?.error);
}

/* ---------- 4. correct PIN ---------- */
console.log("\nCORRECT PIN");
let ownerCookie = null;
{
  const good = await call("/api/auth/login", { method: "POST", body: { staffId: owner.id, pin: PIN } });
  ok("login succeeds", good.status === 200, JSON.stringify(good.body));
  ok("a cookie is issued", !!good.cookie);
  ok("returns staffName and role", good.body?.staffName === "Test Owner" && good.body?.role === "owner",
     JSON.stringify(good.body));
  ownerCookie = good.cookie;

  const s = await call("/api/auth/session", { cookie: ownerCookie });
  ok("session now resolves", s.body?.loggedIn === true, JSON.stringify(s.body));
  /* /session deliberately returns staffName and role but NOT staffId —
     that is what server/routes/auth.js sends, and the frontend reads those
     two. Asserting a field the real app never returned was this test being
     wrong, not the Worker. */
  ok("carries the right staffName", s.body?.staffName === "Test Owner", s.body?.staffName);
  ok("carries the right role", s.body?.role === "owner", s.body?.role);
  ok("carries businessName for the header", typeof s.body?.businessName === "string", s.body?.businessName);

  const h = await call("/api/health", { cookie: ownerCookie });
  ok("protected route now allows through", h.status === 200, h.status);
}

/* ---------- 5. the attacks ---------- */
console.log("\nATTACKS");
{
  /* Flip a character in the signature. */
  const tampered = ownerCookie.slice(0, -3) + (ownerCookie.slice(-3) === "aaa" ? "bbb" : "aaa");
  const t = await call("/api/health", { cookie: tampered });
  ok("tampered signature is refused", t.status === 401, t.status);

  /* Swap the payload for one naming a different shop, keeping the old sig. */
  const value = ownerCookie.split("=")[1];
  const forgedPayload = Buffer.from(JSON.stringify({ t: "someone-elses-shop", s: "x" }))
    .toString("base64url");
  const forged = `sm_sid=${forgedPayload}.${value.split(".")[1]}`;
  const f = await call("/api/health", { cookie: forged });
  ok("re-signed payload is refused", f.status === 401, f.status);

  /* A VALID cookie, replayed against a different tenant. */
  const cross = await call("/api/health", { cookie: ownerCookie, shop: SHOP + "-other" });
  ok("valid cookie does not work on another shop", cross.status === 401, cross.status);

  /* Garbage. */
  const junk = await call("/api/health", { cookie: "sm_sid=notacookie" });
  ok("malformed cookie is refused", junk.status === 401, junk.status);
}

/* ---------- 6. roles ---------- */
console.log("\nROLES");
{
  const r = await call("/api/rows", { cookie: ownerCookie });
  ok("owner reaches an owner-only route", r.status === 200, r.status);

  const login = await call("/api/auth/login", { method: "POST", body: { staffId: clerk.id, pin: PIN } });
  const clerkCookie = login.cookie;
  ok("clerk can log in", login.status === 200, login.status);

  const cr = await call("/api/rows", { cookie: clerkCookie });
  ok("clerk is refused the owner-only route", cr.status === 403, cr.status);
  ok("owner-only wording is preserved",
     cr.body?.error === "Only the shop owner can do this.", cr.body?.error);

  const ch = await call("/api/health", { cookie: clerkCookie });
  ok("clerk still reaches ordinary routes", ch.status === 200, ch.status);
}

/* ---------- 7. logout ---------- */
console.log("\nLOGOUT");
{
  const out = await call("/api/auth/logout", { method: "POST", cookie: ownerCookie });
  ok("logout succeeds", out.status === 200, out.status);
  ok("cookie is cleared", (out.cookie || "").startsWith("sm_sid="), out.cookie);

  const after = await call("/api/health", { cookie: ownerCookie });
  ok("the OLD cookie is now dead server-side", after.status === 401, after.status);
}

/* ---------- 8. brute force ---------- */
console.log("\nBRUTE FORCE (5 wrong PINs locks for 15 minutes)");
{
  const victim = (await call("/api/dev/seed-staff", { method: "POST", body: { name: "Lock Target", pin: PIN, role: "staff" } })).body;
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call("/api/auth/login", { method: "POST", body: { staffId: victim.id, pin: "9999" } });
    statuses.push(r.status);
  }
  ok("first attempts are 401", statuses.slice(0, 4).every((s) => s === 401), statuses.join(","));
  ok("lockout kicks in with 429", statuses.includes(429), statuses.join(","));

  /* And the lockout holds even for the CORRECT pin. */
  const locked = await call("/api/auth/login", { method: "POST", body: { staffId: victim.id, pin: PIN } });
  ok("correct PIN is also locked out", locked.status === 429, locked.status);
}

console.log(`\n${fail ? fail + " CHECK(S) FAILED" : "ALL " + pass + " CHECKS PASSED"}\n`);
process.exitCode = fail ? 1 : 0;
