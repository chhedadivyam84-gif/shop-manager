#!/usr/bin/env node
/* ============================================================
   ARE THE BACKUP CREDENTIALS WORKING?

   Run this after rotating a key, BEFORE deleting the old one. It does the
   three things a backup actually needs — list, upload, download — and says
   plainly whether each worked.

   Rotating a credential is one of the few operations where "it looked
   fine" is not good enough: the failure is silent, it happens at 2am when
   the scheduled backup runs, and nobody finds out until the day they need
   the backup.

       node tools/check-backup-creds.js

   Reads the same environment variables the app does, so run it in a shell
   with the NEW values exported — or on the host itself.

   It writes one small test object and deletes it again. It never touches a
   real backup, and it never deletes anything it did not just create.
   ============================================================ */
const path = require("path");

/* Loaded after the environment is read, the way the app loads it. */
const cloudStore = require(path.join(__dirname, "..", "server", "cloudStore.js"));

const ok = m => console.log("  ✓ " + m);
const bad = m => { console.log("  ✗ " + m); failed = true; };
let failed = false;

(async () => {
  console.log("");

  if (!cloudStore.configured()) {
    console.log("  Nothing is configured. Set either:");
    console.log("    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET");
    console.log("  or SUPABASE_URL, SUPABASE_KEY, SUPABASE_BUCKET\n");
    process.exit(1);
  }

  const d = cloudStore.describe();
  console.log(`  Using ${d.label}, bucket "${d.bucket}"`);
  if (process.env.R2_ACCOUNT_ID && process.env.SUPABASE_URL) {
    console.log("  (both are configured — R2 wins, Supabase is ignored)");
  }
  console.log("");

  /* 1. LIST — proves the credential is accepted and can see the bucket. */
  let existing = [];
  try {
    existing = await cloudStore.list();
    ok(`listed the bucket — ${existing.length} file(s) there`);
  } catch (e) {
    bad(`could NOT list the bucket: ${e.message}`);
    console.log("\n  The credential is wrong, expired, or has no read access.");
    console.log("  Do NOT delete the old one.\n");
    process.exit(1);
  }

  /* 2. UPLOAD — read access alone is not enough; a backup has to write. */
  const name = `credcheck-${Date.now()}.txt`;
  const body = Buffer.from("credential check, safe to delete\n");
  try {
    const r = await cloudStore.upload(null, name, body);
    if (r && r.ok === false) throw new Error(r.error || "refused");
    ok(`uploaded a test file (${name})`);
  } catch (e) {
    bad(`could NOT upload: ${e.message}`);
    console.log("\n  The credential can read but not write. A backup would fail silently.");
    console.log("  Check the token has Object Read AND Write.\n");
    process.exit(1);
  }

  /* 3. DOWNLOAD — and that what comes back is what went up. A restore that
        returns a truncated or empty file is worse than one that fails. */
  try {
    const got = await cloudStore.download(name);
    if (!got || !got.length) throw new Error("came back empty");
    if (Buffer.compare(Buffer.from(got), body) !== 0) throw new Error("came back different from what was sent");
    ok("downloaded it again, byte for byte");
  } catch (e) {
    bad(`could NOT download it back: ${e.message}`);
  }

  /* 4. Tidy up after ourselves. */
  try {
    await cloudStore.remove([name]);
    ok("removed the test file");
  } catch (e) {
    console.log(`  ! could not remove ${name} — delete it by hand, it is harmless`);
  }

  /* 5. And confirm the real backups are still there and readable. A
        credential that works on a NEW file but cannot reach the existing
        ones would pass every check above and still lose the history. */
  const real = existing.filter(f => String(f.name).startsWith("shop-"));
  if (real.length) {
    const newest = real.map(f => f.name).sort().reverse()[0];
    try {
      const buf = await cloudStore.download(newest);
      const isSqlite = buf.slice(0, 15).toString() === "SQLite format 3";
      if (isSqlite) ok(`read the newest real backup (${newest}, ${(buf.length / 1048576).toFixed(1)} MB) — a valid database`);
      else bad(`${newest} downloaded but is not a SQLite file`);
    } catch (e) {
      bad(`could NOT read the newest real backup: ${e.message}`);
    }
  } else {
    console.log("  ! no shop-*.db backups in this bucket yet");
  }

  console.log("");
  if (failed) {
    console.log("  SOMETHING FAILED. Keep the old credential until this passes.\n");
    process.exit(1);
  }
  console.log("  All good. This credential can list, write, read and reach the");
  console.log("  existing backups — it is safe to retire the old one.\n");
})().catch(e => {
  console.error("\n  Unexpected failure: " + e.message + "\n");
  process.exit(1);
});
