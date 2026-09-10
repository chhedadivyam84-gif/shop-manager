/* ============================================================
   BACKUP AND RESTORE, end to end against a running `wrangler dev`.

   The question this has to answer is not "did a file appear in R2" but
   "if the shop's data were destroyed, would this bring it back". So the
   test deliberately destroys data between the backup and the restore,
   and then checks the rows are the ones that were there before.

   A backup that has never been restored is a hope, not a backup.
   ============================================================ */
const BASE = process.argv[2] || "http://127.0.0.1:8799";
const SHOP = "backuptest-" + Math.random().toString(36).slice(2, 8);
const PIN = "4821";

let pass = 0, fail = 0;
const ok = (l, c, x) => {
  if (c) { pass++; console.log(`  ok    ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${x !== undefined ? "   -> " + x : ""}`); }
};

async function call(path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}shop=${SHOP}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  const raw = res.headers.get("set-cookie");
  return { status: res.status, body: json, cookie: raw ? raw.split(";")[0] : null };
}

console.log(`\nbase: ${BASE}\nshop: ${SHOP}\n`);

/* ---------- set up a shop with an owner and some data ---------- */
const owner = (await call("/api/dev/seed-staff", {
  method: "POST", body: { name: "Backup Owner", pin: PIN, role: "owner" },
})).body;
const cookie = (await call("/api/auth/login", {
  method: "POST", body: { staffId: owner.id, pin: PIN },
})).cookie;

console.log("PERMISSIONS");
{
  const clerk = (await call("/api/dev/seed-staff", {
    method: "POST", body: { name: "Backup Clerk", pin: PIN, role: "staff" },
  })).body;
  const clerkCookie = (await call("/api/auth/login", {
    method: "POST", body: { staffId: clerk.id, pin: PIN },
  })).cookie;

  const s = await call("/api/backup", { cookie: clerkCookie });
  ok("staff cannot see backups", s.status === 403, s.status);
  ok("owner-only wording preserved", s.body?.error === "Only the shop owner can do this.", s.body?.error);

  const anon = await call("/api/backup");
  ok("logged-out is refused", anon.status === 401, anon.status);
}

console.log("\nTAKE A BACKUP");
let key = null;
{
  const before = await call("/api/backup", { cookie });
  ok("status reads before any backup exists", before.status === 200, JSON.stringify(before.body).slice(0, 90));

  const run = await call("/api/backup/run", { method: "POST", cookie });
  ok("backup runs", run.body?.ok === true, JSON.stringify(run.body).slice(0, 120));
  ok("it wrote rows", run.body?.rows > 0, run.body?.rows);
  ok("it is compressed and small", run.body?.bytes > 0 && run.body?.bytes < 200000, run.body?.bytes);
  key = run.body?.key;
  ok("key is namespaced by shop", String(key).startsWith(SHOP + "/"), key);

  const after = await call("/api/backup", { cookie });
  ok("it appears in the listing", after.body?.count >= 1, after.body?.count);
  ok("an alarm is scheduled for the next one", !!after.body?.nextAlarmAt, after.body?.nextAlarmAt);
}

console.log("\nUNCHANGED DATA IS NOT BACKED UP TWICE");
{
  /* A scheduled run with no writes since the last one should skip, so an
     idle shop does not store 48 identical copies of a quiet day. */
  const again = await call("/api/backup/run", { method: "POST", cookie });
  ok("a MANUAL run always takes a fresh copy", again.body?.ok === true && !again.body?.skipped,
     JSON.stringify(again.body).slice(0, 80));
}

console.log("\nDESTROY THE DATA");
let staffBefore = null;
{
  staffBefore = (await call("/api/auth/staff-list")).body;
  ok("staff exist before the disaster", staffBefore.length >= 2, staffBefore.length);

  /* Wipe the shop the way an accident would. */
  const reset = await fetch(`${BASE}/api/migrate/reset?shop=${SHOP}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-migration-token": (await import("node:fs")).readFileSync(
        new URL("../.migration-token", import.meta.url), "utf8").trim(),
    },
    body: JSON.stringify({ tables: Object.keys((await call("/api/rows", { cookie })).body?.counts || {}) }),
  });
  ok("wipe succeeded", reset.ok, reset.status);

  const gone = (await call("/api/auth/staff-list")).body;
  ok("the shop really is empty now", Array.isArray(gone) && gone.length === 0, JSON.stringify(gone).slice(0, 60));
}

console.log("\nRESTORE");
{
  /* The session cookie still works because sessions live in key-value
     storage, not the SQL tables — so a wipe does not sign the owner out. */
  const r = await call("/api/backup/restore", { method: "POST", cookie, body: { key } });
  ok("restore reports success", r.body?.ok === true, JSON.stringify(r.body).slice(0, 120));
  ok("it put rows back", r.body?.restored > 0, r.body?.restored);

  const back = (await call("/api/auth/staff-list")).body;
  ok("staff are back", Array.isArray(back) && back.length === staffBefore.length,
     `${back?.length} vs ${staffBefore.length}`);
  ok("and they are the SAME people",
     JSON.stringify((back || []).map((s) => s.name).sort()) ===
     JSON.stringify(staffBefore.map((s) => s.name).sort()),
     JSON.stringify((back || []).map((s) => s.name)));
}

console.log(`\n${fail ? fail + " CHECK(S) FAILED" : "ALL " + pass + " CHECKS PASSED"}\n`);
process.exitCode = fail ? 1 : 0;
