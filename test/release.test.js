/* ============================================================
   RELEASES — can the checks fail, and does the deploy fix hold?

   A release check that only ever says READY is worse than no release
   check, because somebody then believes it. So the main business of this
   file is not proving the checks pass on this repo — that is one line
   each — but proving every one of them FAILS when what it guards is
   broken: a destructive migration, a lockfile npm ci would refuse, a
   fourth dependency, a file that will not parse, an app that will not
   start, a health check whose database is down.

   And the deploy-handover fix, tested against the exact sequence read out
   of Render's logs on 9 Oct 2026.

   Every boot here is against a fresh temp directory with the cloud unset.

   Run:  node test/release.test.js
   ============================================================ */
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const check = require(path.join(ROOT, "tools/release-check.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 300) : "")); }
};
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* A release module with a clean environment each time it is asked for. */
function freshRelease(env) {
  const saved = { ...process.env };
  delete process.env.RENDER_GIT_COMMIT; delete process.env.SOURCE_VERSION;
  Object.assign(process.env, env || {});
  const key = require.resolve(path.join(ROOT, "server/release.js"));
  delete require.cache[key];
  const r = require(key);
  process.env = saved;
  return r;
}

(async () => {
  /* ---------------------------------------------------------------- */
  console.log("\n--- which release is this ---\n");
  {
    const r = freshRelease({ RENDER_GIT_COMMIT: "492b988f00c0ffee" });
    ok("on Render it reports the commit it was built from", r.BOOT.version === "492b988", r.BOOT.version);
    const local = freshRelease({});
    ok("anywhere else it says local, not a guess", local.BOOT.version === "local", local.BOOT.version);
    ok("it records when it started", !Number.isNaN(Date.parse(local.BOOT.startedAt)));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- THE DEPLOY HANDOVER, as Render actually does it ---\n");
  {
    const r = freshRelease({});
    ok("stamps are read out of backup names",
       r.stampOf("shop-20261009-191130--company-2.db") === "20261009-191130");

    const restored = r.startupPlan({ restored: true, file: "shop-20261009-190315.db" });
    ok("AFTER A RESTORE, NO STARTUP SNAPSHOT — the write that collided", restored.startupSnapshot === false);
    ok("...and the gap is checked once the old container has had time to save",
       restored.checkGapAfterMs >= 60000, restored.checkGapAfterMs);

    const plain = r.startupPlan({ restored: false, reason: "shop.db already present" });
    ok("a boot that restored nothing still takes its startup snapshot", plain.startupSnapshot === true);
    ok("...and has no gap to look for", plain.checkGapAfterMs === 0);

    /* The 9 Oct sequence, file for file. */
    const cloud = [
      "shop-20261009-183737.db", "shop-20261009-184825.db",
      "shop-20261009-190315.db", "shop-20261009-190315--registry.json",
      "shop-20261009-191130.db",        // the OLD container's final backup
    ];
    ok("THE OLD CONTAINER'S LATER SAVE IS FOUND",
       r.newerThanRestored("shop-20261009-190315.db", cloud) === "20261009-191130",
       r.newerThanRestored("shop-20261009-190315.db", cloud));
    ok("nothing newer means nothing reported",
       r.newerThanRestored("shop-20261009-191130.db", cloud) === null);
    ok("an older backup is never mistaken for a newer one",
       r.newerThanRestored("shop-20261009-191130.db", ["shop-20261009-183737.db"]) === null);
    ok("names that are not backups are ignored",
       r.newerThanRestored("shop-20261009-190315.db", ["latest.json", "notes.txt", null]) === null);
    ok("listing objects ({name}) work as well as strings",
       r.newerThanRestored("shop-20261009-190315.db", [{ name: "shop-20261009-191130.db" }]) === "20261009-191130");
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the startup snapshot really is skipped ---\n");
  {
    /* The real backup module, with the real flag, in a throwaway data
       directory. Timers are unref'd, so nothing outlives the test. */
    const dir = tmp("release-sched-");
    const lines = [];
    const orig = console.log;
    const env = { ...process.env };
    process.env.DATA_DIR = dir;
    for (const k of ["SUPABASE_URL", "SUPABASE_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) process.env[k] = "";
    console.log = (...a) => lines.push(a.join(" "));
    try {
      const backup = require(path.join(ROOT, "server/backup.js"));
      backup.startSchedule({ skipStartup: true });
    } finally { console.log = orig; process.env = env; }
    ok("told to skip, it says so in the log", lines.some(l => /startup snapshot skipped/.test(l)), lines);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the health answer ---\n");
  {
    const r = freshRelease({ RENDER_GIT_COMMIT: "abc1234def" });
    const good = r.healthReport(() => ({ ok: 1 }));
    ok("a working database is a 200", good.status === 200 && good.body.ok === true, good);
    ok("...and names the release", good.body.version === "abc1234");

    const down = r.healthReport(() => { throw new Error("SQLITE_CANTOPEN /var/data/secret/path.db"); });
    ok("A DATABASE THAT WILL NOT ANSWER IS A 503", down.status === 503, down.status);
    ok("...reported as 'error' only", down.body.db === "error");
    ok("...without the error text, which carried a path",
       !/secret|SQLITE|\/var/.test(JSON.stringify(down.body)), down.body);

    const text = JSON.stringify(good.body);
    ok("it names no bucket, provider, key or variable",
       !/bucket|provider|supabase|r2_|api_key|secret|token|password/i.test(text), text);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the real app's /api/health ---\n");
  {
    const dir = tmp("release-health-");
    const res = await check.checkBoots(ROOT).catch(e => ({ error: e.message }));
    ok("the real app starts on an empty data directory", res.empty && res.empty.status === "PASS", res.empty);
    ok("its health endpoint reports the database", res.health && res.health.status === "PASS", res.health);
    ok("and it starts a SECOND time on the same data — migrations repeat safely",
       res.second && res.second.status === "PASS", res.second);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- every check can FAIL ---\n");

  /* migrations */
  ok("this repo's migrations are non-destructive", check.checkMigrations(ROOT).status === "PASS",
     check.checkMigrations(ROOT));
  ok("DROP TABLE is caught", check.findDestructive('db.exec("DROP TABLE invoices");').length === 1);
  ok("DELETE FROM is caught", check.findDestructive("db.exec(`DELETE FROM customers`);").length === 1);
  ok("TRUNCATE is caught", check.findDestructive("TRUNCATE products").length === 1);
  ok("ALTER ... DROP COLUMN is caught", check.findDestructive("ALTER TABLE x DROP COLUMN y").length === 1);
  ok("the words in a comment are NOT a migration",
     check.findDestructive("/* never DROP TABLE here */\n// DELETE FROM is forbidden").length === 0);
  ok("...nor across a multi-line comment",
     check.findDestructive("/*\n DROP TABLE invoices\n*/\nconst a = 1;").length === 0);
  {
    const fake = tmp("release-mig-");
    fs.mkdirSync(path.join(fake, "server"));
    fs.writeFileSync(path.join(fake, "server/db-schema.js"),
      'addColumn("x","y","TEXT");\ndb.exec("DROP TABLE invoices");\n');
    const r = check.checkMigrations(fake);
    ok("A PLANTED DROP TABLE FAILS THE RELEASE", r.status === "FAIL", r);
    ok("...naming the file and line", /db-schema\.js:2/.test(r.detail), r.detail);
  }

  /* lockfile */
  ok("this repo's lockfile agrees", check.checkLockfile(ROOT).status === "PASS", check.checkLockfile(ROOT));
  {
    const fake = tmp("release-lock-");
    fs.writeFileSync(path.join(fake, "package.json"),
      JSON.stringify({ dependencies: { express: "^5.2.1", leftpad: "^1.0.0" } }));
    fs.writeFileSync(path.join(fake, "package-lock.json"), JSON.stringify({
      packages: { "": { dependencies: { express: "^5.2.1" } }, "node_modules/express": {} },
    }));
    const r = check.checkLockfile(fake);
    ok("a dependency the lockfile does not know FAILS — npm ci would refuse", r.status === "FAIL", r);

    fs.rmSync(path.join(fake, "package-lock.json"));
    ok("a missing lockfile FAILS", check.checkLockfile(fake).status === "FAIL");
  }

  /* dependency count */
  ok("this repo ships three packages", check.checkDependencyCount(ROOT).status === "PASS");
  {
    const fake = tmp("release-deps-");
    fs.writeFileSync(path.join(fake, "package.json"),
      JSON.stringify({ dependencies: { a: "1", b: "1", c: "1", d: "1" } }));
    ok("a fourth package FAILS", check.checkDependencyCount(fake).status === "FAIL");
  }

  /* syntax */
  {
    const fake = tmp("release-syn-");
    fs.mkdirSync(path.join(fake, "server"));
    fs.writeFileSync(path.join(fake, "server/ok.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(fake, "server/broken.js"), "function ( {\n");
    const r = check.checkSyntax(fake);
    ok("a file that will not parse FAILS", r.status === "FAIL", r);
    ok("...and is named", /broken\.js/.test(r.detail), r.detail);
  }

  /* boots — an app that dies, and one whose database is down */
  {
    const fake = tmp("release-dead-");
    fs.mkdirSync(path.join(fake, "server"));
    fs.writeFileSync(path.join(fake, "server/index.js"),
      'console.error("Fatal startup error: no such column: invoice_title"); process.exit(1);\n');
    const r = await check.checkBoots(fake);
    ok("AN APP THAT DIES ON BOOT FAILS THE RELEASE", r.empty.status === "FAIL", r.empty);
    ok("...with the reason, which is what a failed deploy looks like",
       /invoice_title/.test(r.empty.detail), r.empty.detail);
    ok("...and the checks that needed it running are skipped, not passed",
       r.health.status === "SKIP" && r.second.status === "SKIP", [r.health.status, r.second.status]);
  }
  {
    const fake = tmp("release-sick-");
    fs.mkdirSync(path.join(fake, "server"));
    fs.writeFileSync(path.join(fake, "server/index.js"), `
      const http = require("http");
      http.createServer((q, s) => { s.writeHead(503, {"content-type":"application/json"});
        s.end(JSON.stringify({ ok:false, db:"error" })); })
        .listen(process.env.PORT, () => console.log("running on port " + process.env.PORT));
    `);
    const r = await check.checkBoots(fake);
    ok("an app that starts but cannot reach its database FAILS the health check",
       r.empty.status === "PASS" && r.health.status === "FAIL", [r.empty.status, r.health.status]);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the runbook matches what is actually here ---\n");
  {
    const doc = fs.readFileSync(path.join(ROOT, "RELEASING.md"), "utf8");
    const idx = fs.readFileSync(path.join(ROOT, "server/index.js"), "utf8");
    ok("it names the release check, which exists",
       /tools\/release-check\.js/.test(doc) && fs.existsSync(path.join(ROOT, "tools/release-check.js")));
    ok("it names the backup checker, which exists",
       /tools\/verify-backup\.js/.test(doc) && fs.existsSync(path.join(ROOT, "tools/verify-backup.js")));
    ok("it names /api/health, which is mounted", /\/api\/health/.test(doc) && /app\.get\("\/api\/health"/.test(idx));
    ok("it says how to roll back durably", /git revert/.test(doc));
    ok("it says a rollback is ALSO a deploy", /rollback is also a deploy/i.test(doc));
    ok("it says when not to deploy", /nobody is billing/i.test(doc));
    ok("it says database restores need a person's approval", /approv/i.test(doc));
  }

  console.log(`\n==============================================`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`==============================================\n`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error("\nTEST ERROR: " + e.stack); process.exitCode = 1; });
