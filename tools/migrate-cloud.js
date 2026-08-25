#!/usr/bin/env node
/* ============================================================
   MOVE BACKUPS FROM ONE STORE TO THE OTHER

     node tools/migrate-cloud.js               copy Supabase -> R2
     node tools/migrate-cloud.js --dry-run     say what it would do
     node tools/migrate-cloud.js --newest 200  only the newest 200 files
     node tools/migrate-cloud.js --delete-source   remove from Supabase after

   Both sets of credentials must be in the environment at once:

     SUPABASE_URL, SUPABASE_KEY
     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

   COPIES, never moves, unless --delete-source is given. A migration that
   deletes as it goes has no second attempt: if it fails a third of the way
   through, what is left behind is neither one thing nor the other.
   ============================================================ */
const cloudStore = require("../server/cloudStore");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const deleteSource = args.includes("--delete-source");
const newestArg = args.indexOf("--newest");
const limit = newestArg >= 0 ? Number(args[newestArg + 1]) : 0;

const mb = b => (b / 1048576).toFixed(1) + " MB";

(async () => {
  let from, to;
  try {
    from = cloudStore.forProvider("supabase");
    to = cloudStore.forProvider("r2");
  } catch (e) {
    console.error("\n  " + e.message);
    console.error("\n  Both stores must be configured at once. In this window:\n");
    console.error('    export SUPABASE_URL="https://xxxx.supabase.co"');
    console.error('    export SUPABASE_KEY="..."');
    console.error('    export R2_ACCOUNT_ID="..."');
    console.error('    export R2_ACCESS_KEY_ID="..."');
    console.error('    export R2_SECRET_ACCESS_KEY="..."');
    console.error('    export R2_BUCKET="shop-backups"');
    console.error("    node tools/migrate-cloud.js --dry-run\n");
    process.exit(1);
  }

  console.log(`\n  From: ${from.label} (${from.bucket})`);
  console.log(`  To:   ${to.label} (${to.bucket})\n`);

  console.log("  Reading both sides…");
  let source, target;
  try { source = await from.list(); }
  catch (e) { console.error("  Could not read Supabase: " + e.message + "\n"); process.exit(1); }
  try { target = await to.list(); }
  catch (e) { console.error("  Could not read R2: " + e.message + "\n"); process.exit(1); }

  const already = new Set(target.map(f => f.name));

  // Newest first, so a run that is cut short has still moved what matters most.
  source.sort((a, b) => b.name.localeCompare(a.name));
  let todo = source.filter(f => !already.has(f.name));
  if (limit > 0) todo = todo.slice(0, limit);

  const totalBytes = todo.reduce((t, f) => t + (f.size || 0), 0);
  console.log(`  Supabase holds ${source.length} file(s), ${mb(source.reduce((t, f) => t + (f.size || 0), 0))}`);
  console.log(`  R2 already has ${target.length}`);
  console.log(`  To copy: ${todo.length} file(s), ${mb(totalBytes)}\n`);

  if (!todo.length) { console.log("  Nothing to do.\n"); return; }
  if (dryRun) {
    todo.slice(0, 10).forEach(f => console.log("    " + f.name));
    if (todo.length > 10) console.log(`    … and ${todo.length - 10} more`);
    console.log("\n  Dry run — nothing was copied.\n");
    return;
  }

  let copied = 0, failed = 0, bytes = 0;
  const failures = [];

  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    try {
      const buf = await from.download(f.name);
      const up = await to.upload(f.name, buf);
      if (!up.ok) throw new Error(up.error || "upload refused");
      copied++; bytes += buf.length;
    } catch (e) {
      failed++;
      failures.push(`${f.name}: ${e.message}`);
    }
    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      process.stdout.write(`\r  copied ${copied}/${todo.length}  (${mb(bytes)})${failed ? `  ${failed} failed` : ""}   `);
    }
  }
  console.log("\n");

  if (failures.length) {
    console.log(`  ${failures.length} file(s) did not copy:`);
    failures.slice(0, 5).forEach(f => console.log("    " + f));
    if (failures.length > 5) console.log(`    … and ${failures.length - 5} more`);
    console.log("\n  Run it again — anything already copied is skipped.\n");
  }

  /* Only ever after a clean run. Deleting the source when part of it failed
     to arrive is how a migration turns into a loss. */
  if (deleteSource) {
    if (failed) {
      console.log("  NOT deleting from Supabase: some files did not copy.\n");
    } else {
      const names = todo.map(f => f.name);
      const gone = await from.remove(names);
      console.log(`  Deleted ${gone} file(s) from Supabase.\n`);
    }
  } else if (!failed) {
    console.log("  Everything copied. Supabase still has its copies —");
    console.log("  re-run with --delete-source once you are satisfied.\n");
  }
})().catch(e => { console.error("\n  Failed: " + e.message + "\n"); process.exit(1); });
