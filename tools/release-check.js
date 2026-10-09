#!/usr/bin/env node
/* ============================================================
   IS THIS COMMIT READY TO GO TO A LIVE SHOP?

   Run before every deploy:

       node tools/release-check.js          everything (several minutes)
       node tools/release-check.js --quick  skips the test suites, and
                                            says NOT READY because of it

   Exit 0 means READY. Anything else means do not push.

   NOTHING HERE PASSES BY DEFAULT. A check that cannot be run is reported
   as SKIPPED, and a release with a skipped critical check is NOT READY —
   because "I did not look" and "I looked and it was fine" are different
   things, and a checklist that conflates them is worse than no checklist.

   Each check below is here because its absence has already cost
   something, or nearly did:

     clean tree       what is tested must be what is shipped
     lockfile         Render builds with `npm ci`, which refuses a lockfile
                      that disagrees with package.json — a failed deploy
     dependencies     the app ships three packages and a test says so
     syntax           a typo in one route file takes the whole app down
     migrations       no destructive SQL in the code that runs on boot
     empty boot       a fresh tenant is the ONLY place a migration that
                      reads a column before creating it fails — nine
                      deploys in a row failed that way on 1 Sep 2026
     second boot      migrations must be safe to run twice, because every
                      restart runs them again
     health           the release answers /api/health with its database
     tests            the suites that guard money, identity and backups

   It never touches a live shop, a backup or the cloud. Every boot is
   against a fresh temporary directory with the cloud deliberately unset.
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const QUICK = process.argv.includes("--quick");

/* Progress is drawn over itself with \r, which only means anything on a
   terminal. Piped into a log it would pile every step onto one line. */
const progress = t => { if (process.stdout.isTTY) process.stdout.write("  …     " + t + "\r"); };

/* The suites that must pass before money, identity or backups change. */
const CRITICAL_SUITES = [
  "security", "restore", "backup-verify", "tenant-identity", "assistant", "voice", "release", "handover",
];

/* IN CI THESE CANNOT RUN, BY DESIGN, and that is not the same as skipped.

   tenant-identity boots the licence panel beside the shop and signs
   verdicts with the vendor's PRIVATE key — which must never be handed to
   a CI provider. Staging boots the release on a copy of the shop's REAL
   books — which must never be uploaded to one either.

   So in CI they are reported as LOCAL: not passed, not blocking CI, and
   named in the summary as still owed. Outside CI they are ordinary
   critical checks, and a release that has not passed them is NOT READY. */
const IN_CI = process.argv.includes("--ci") || String(process.env.CI || "").toLowerCase() === "true";
const LOCAL_ONLY = new Set(["tests: tenant-identity", "staging on a copy of the real books"]);

/* What production needs, by NAME. Never read, never printed: this tool
   runs on a laptop, not on the host, so it cannot honestly say whether
   they are set there. It says so instead of pretending. */
const PRODUCTION_ENV = {
  "backups (one of these sets)": [
    ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
    ["SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_BUCKET"],
  ],
};

const results = [];
const record = (name, status, detail, critical = true) =>
  results.push({ name, status, detail: detail || "", critical });

/* ------------------------------------------------------------------ */
/* The checks. Each is exported so the test can prove it can FAIL.     */
/* ------------------------------------------------------------------ */

function checkCleanTree(root) {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) return { status: "SKIP", detail: "git is not available here" };
  const dirty = r.stdout.split("\n").filter(Boolean);
  return dirty.length
    ? { status: "FAIL", detail: dirty.length + " uncommitted change(s) — what is tested would not be what ships" }
    : { status: "PASS", detail: "nothing uncommitted" };
}

function checkLockfile(root) {
  let pkg, lock;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
  catch (e) { return { status: "FAIL", detail: "package.json is not readable" }; }
  try { lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")); }
  catch (e) { return { status: "FAIL", detail: "package-lock.json is missing or not JSON — `npm ci` would refuse" }; }

  const want = pkg.dependencies || {};
  const locked = (lock.packages && lock.packages[""] && lock.packages[""].dependencies) || {};
  const wrong = [];
  for (const [name, range] of Object.entries(want)) {
    if (locked[name] !== range) wrong.push(`${name}: package.json ${range}, lockfile ${locked[name] || "absent"}`);
    else if (!lock.packages["node_modules/" + name]) wrong.push(`${name}: not resolved in the lockfile`);
  }
  for (const name of Object.keys(locked)) if (!(name in want)) wrong.push(`${name}: in the lockfile, not in package.json`);
  return wrong.length
    ? { status: "FAIL", detail: "lockfile disagrees with package.json — `npm ci` on Render would fail: " + wrong.join("; ") }
    : { status: "PASS", detail: Object.keys(want).length + " dependencies, lockfile agrees" };
}

function checkDependencyCount(root, expected = 3) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const n = Object.keys(pkg.dependencies || {}).length;
  return n === expected
    ? { status: "PASS", detail: n + " production packages" }
    : { status: "FAIL", detail: `${n} production packages, expected ${expected} — a new dependency needs a decision, not a deploy` };
}

function allJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "vendor") out.push(...allJs(p)); }
    else if (/\.(js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function checkSyntax(root) {
  const files = [...allJs(path.join(root, "server")), ...allJs(path.join(root, "public", "js"))];
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) bad.push(path.relative(root, f));
  }
  return bad.length
    ? { status: "FAIL", detail: "will not parse: " + bad.join(", ") }
    : { status: "PASS", detail: files.length + " files parse" };
}

/** SQL that destroys data, in the code that runs on every boot. */
function findDestructive(source) {
  const hits = [];
  let inBlock = false;
  source.split("\n").forEach((line, i) => {
    let t = line;
    if (inBlock) {
      if (!t.includes("*/")) return;
      inBlock = false;
      t = t.split("*/").slice(1).join("*/");
    }
    t = t.replace(/\/\*.*?\*\//g, "");
    if (t.includes("/*")) { inBlock = true; t = t.split("/*")[0]; }
    t = t.replace(/\/\/.*$/, "").replace(/--.*$/, "");
    if (/\b(DROP\s+(TABLE|COLUMN|INDEX|TRIGGER|VIEW)|TRUNCATE|DELETE\s+FROM)\b/i.test(t)) {
      hits.push((i + 1) + ": " + t.trim().slice(0, 100));
    }
  });
  return hits;
}

function checkMigrations(root) {
  const files = ["server/db-schema.js", "server/db.js"].filter(f => fs.existsSync(path.join(root, f)));
  const hits = [];
  for (const f of files) {
    for (const h of findDestructive(fs.readFileSync(path.join(root, f), "utf8"))) hits.push(f + ":" + h);
  }
  return hits.length
    ? { status: "FAIL", detail: "destructive SQL in boot-time migrations — every restart would run it: " + hits.join(" | ") }
    : { status: "PASS", detail: "no DROP, TRUNCATE or DELETE in " + files.join(", ") };
}

/* Boots the app against a directory and waits for it to say it is up —
   or to say "Fatal startup error", which is what a failed deploy looks
   like from the inside. Cloud deliberately unset: this must never read
   or write a real backup. */
function boot(root, dataDir, port) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ["--no-warnings", "server/index.js"], {
      cwd: root,
      env: {
        ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: "production",
        SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "",
        R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "",
        ASSISTANT_API_KEY: "",
      },
    });
    let out = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => out += d);
    const finish = async (up) => {
      clearInterval(timer); clearTimeout(limit);
      let health = null;
      if (up) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`);
          health = { status: r.status, body: await r.json() };
        } catch (e) { health = { status: 0, body: null }; }
      }
      p.kill();
      setTimeout(() => resolve({ up, out, health }), 400);
    };
    const timer = setInterval(() => {
      if (/Fatal startup error/i.test(out)) finish(false);
      else if (new RegExp("running on port " + port).test(out)) finish(true);
    }, 250);
    const limit = setTimeout(() => finish(false), 60000);
  });
}

/* The last lines of a failed boot, with anything that looks like a
   credential masked before it is printed. */
function tail(out) {
  return out.split("\n").filter(Boolean).slice(-4).join(" / ")
    .replace(/(key|secret|token|password)[=:]\s*\S+/gi, "$1=***")
    .slice(0, 400);
}

async function checkBoots(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-boot-"));
  const out = {};

  const first = await boot(root, dir, 4850);
  out.empty = first.up
    ? { status: "PASS", detail: "starts on an empty data directory" }
    : { status: "FAIL", detail: "does NOT start on an empty data directory — this is a failed deploy: " + tail(first.out) };

  out.health = !first.up
    ? { status: "SKIP", detail: "the app did not start" }
    : (first.health && first.health.status === 200 && first.health.body && first.health.body.db === "ok")
      ? { status: "PASS", detail: "/api/health answers 200 with its database" }
      : { status: "FAIL", detail: "/api/health did not report a healthy database: " + JSON.stringify(first.health) };

  if (first.up) {
    const second = await boot(root, dir, 4851);
    out.second = second.up
      ? { status: "PASS", detail: "migrations run a second time without error" }
      : { status: "FAIL", detail: "a SECOND boot fails — migrations are not safe to repeat: " + tail(second.out) };
  } else {
    out.second = { status: "SKIP", detail: "the first boot failed" };
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows holds the file a moment longer */ }
  return out;
}

function checkSuite(root, name) {
  const file = path.join(root, "test", name + ".test.js");
  if (!fs.existsSync(file)) return { status: "FAIL", detail: "test/" + name + ".test.js is missing" };
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8", timeout: 15 * 60 * 1000 });
  const text = (r.stdout || "") + (r.stderr || "");
  const m = /(\d+) passed, (\d+) failed/.exec(text);
  if (r.status === 0) return { status: "PASS", detail: m ? m[1] + " passed" : "passed" };
  return { status: "FAIL", detail: m ? `${m[2]} failed of ${Number(m[1]) + Number(m[2])}` : "exited " + r.status };
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log("\nRELEASE CHECK — is this commit ready for a live shop?\n");

  const head = spawnSync("git", ["log", "--oneline", "-1"], { cwd: ROOT, encoding: "utf8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  console.log("  commit  " + (head.stdout || "unknown").trim());
  console.log("  branch  " + (branch.stdout || "unknown").trim() + "\n");

  const run = (name, fn, critical = true) => {
    progress(name);
    const r = fn();
    record(name, r.status, r.detail, critical);
  };

  run("working tree is clean", () => checkCleanTree(ROOT));
  run("lockfile matches package.json", () => checkLockfile(ROOT));
  run("production dependencies", () => checkDependencyCount(ROOT));
  run("every file parses", () => checkSyntax(ROOT));
  run("migrations are non-destructive", () => checkMigrations(ROOT));

  progress("booting against an empty data directory");
  const b = await checkBoots(ROOT);
  record("starts on an empty data directory", b.empty.status, b.empty.detail);
  record("health endpoint reports the database", b.health.status, b.health.detail);
  record("migrations are safe to run twice", b.second.status, b.second.detail);

  for (const s of CRITICAL_SUITES) {
    const name = "tests: " + s;
    if (IN_CI && LOCAL_ONLY.has(name)) {
      record(name, "LOCAL", "needs the licence panel and the vendor's private key, which never go to CI — run it locally before release");
      continue;
    }
    if (QUICK) { record(name, "SKIP", "--quick"); continue; }
    run(name, () => checkSuite(ROOT, s));
  }

  {
    const name = "staging on a copy of the real books";
    if (IN_CI) {
      record(name, "LOCAL", "the shop's real books never go to CI — run it on the machine that holds the backups");
    } else {
      progress(name);
      const r = await require("./staging").stage(ROOT);
      /* No real backup here is not a pass. It is a check nobody could run. */
      record(name, r.status === "LOCAL" ? "SKIP" : r.status, r.detail);
    }
  }

  /* Reported, never passed: this machine is not the host. */
  for (const [what, sets] of Object.entries(PRODUCTION_ENV)) {
    record("production env — " + what, "MANUAL",
      sets.map(s => s.join(" + ")).join("  OR  ") + "  — confirm on the host's Environment page", false);
  }

  const mark = { PASS: "PASS  ", FAIL: "FAIL  ", SKIP: "SKIP  ", MANUAL: "CHECK ", LOCAL: "LOCAL " };
  if (process.stdout.isTTY) console.log(" ".repeat(70) + "\r");
  for (const r of results) {
    console.log("  " + mark[r.status] + r.name + (r.detail ? "\n          " + r.detail : ""));
  }

  const failed = results.filter(r => r.critical && r.status === "FAIL");
  const skipped = results.filter(r => r.critical && r.status === "SKIP");
  const owed = results.filter(r => r.status === "LOCAL");

  console.log("\n" + "=".repeat(62));
  if (failed.length) {
    console.log("  NOT READY — " + failed.length + " critical check(s) failed. Do not push.");
  } else if (skipped.length) {
    console.log("  NOT READY — " + skipped.length + " critical check(s) were not run.");
    console.log("  A check nobody ran is not a check that passed.");
  } else if (IN_CI) {
    console.log("  CI PASSED — every check CI can run passed.");
    console.log("  Still owed before release, on the release machine: " + owed.length);
    for (const r of owed) console.log("    · " + r.name);
  } else {
    console.log("  READY on the checks that can be run from here.");
    console.log("  Still yours to do: the items marked CHECK, and deploying only");
    console.log("  while nobody is billing — see RELEASING.md.");
  }
  console.log("=".repeat(62) + "\n");

  process.exitCode = failed.length || skipped.length ? 1 : 0;
}

if (require.main === module) {
  main().catch(e => { console.error("\nthe check itself failed: " + e.message + "\n"); process.exitCode = 1; });
}

module.exports = {
  checkCleanTree, checkLockfile, checkDependencyCount, checkSyntax,
  checkMigrations, findDestructive, checkBoots, CRITICAL_SUITES,
};
