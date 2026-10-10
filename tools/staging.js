#!/usr/bin/env node
/* ============================================================
   STAGING: THE NEW RELEASE, ON A COPY OF THE SHOP'S REAL BOOKS

   Every other check boots the app on an EMPTY database or on a few rows
   invented by a test. That catches a migration that reads a column before
   creating it. It cannot catch a migration that chokes on a REAL row — an
   old invoice with a blank field, a product whose size label predates a
   rule — because the test data was written by somebody who already knew
   the rules.

   So this takes the newest backup the shop has actually made, copies it
   into a temporary directory, boots the release being checked against
   that copy, and asks two things:

     - does it come up healthy on real books?
     - after its migrations have run, is every row still there?

       node tools/staging.js

   THE LIVE DATA IS NEVER OPENED FOR WRITING. The backup file is copied,
   and only the copy is booted. The cloud is deliberately unset, so the
   copy can never be backed up anywhere. And the copy is DELETED at the
   end: it is the shop's customer list, and a temp folder is not where
   that should be left lying around.
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const { placeFor } = require(path.join(ROOT, "server/catchup.js"));

/* The tables a shop's money and stock live in. Every row in each must
   survive the release's migrations, exactly. */
const KEPT = ["products", "product_sizes", "customers", "suppliers", "invoices",
              "invoice_items", "purchases", "cash_entries", "payments"];

function newestRun(backupDir) {
  if (!fs.existsSync(backupDir)) return null;
  const primaries = fs.readdirSync(backupDir)
    .filter(n => /^shop-\d{8}-\d{6}\.db$/.test(n)).sort();
  if (!primaries.length) return null;
  const stamp = /^shop-(.+)\.db$/.exec(primaries[primaries.length - 1])[1];
  return { stamp, parts: fs.readdirSync(backupDir).filter(n => n.startsWith("shop-" + stamp)) };
}

function counts(dataDir) {
  const out = {};
  const files = [path.join(dataDir, "shop.db")];
  const cdir = path.join(dataDir, "companies");
  if (fs.existsSync(cdir)) for (const id of fs.readdirSync(cdir)) files.push(path.join(cdir, id, "shop.db"));

  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const d = new DatabaseSync(f, { readOnly: true });
    try {
      const have = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      for (const t of KEPT) {
        if (!have.has(t)) continue;
        const key = path.relative(dataDir, f).replace(/\\/g, "/") + ":" + t;
        out[key] = d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      }
    } finally { d.close(); }
  }
  return out;
}

function integrity(dataDir) {
  const d = new DatabaseSync(path.join(dataDir, "shop.db"), { readOnly: true });
  try { return String(Object.values(d.prepare("PRAGMA integrity_check").get())[0]); }
  finally { d.close(); }
}

function boot(root, dataDir, port) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ["--no-warnings", "server/index.js"], {
      cwd: root,
      env: {
        ...process.env, DATA_DIR: dataDir, PORT: String(port),
        /* Never let a copy of real books reach a backup store. */
        SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "",
        R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "",
        R2_ENDPOINT_OVERRIDE: "", ASSISTANT_API_KEY: "",
      },
    });
    let out = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => out += d);
    const finish = async up => {
      clearInterval(t); clearTimeout(limit);
      let health = null;
      if (up) {
        try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); health = { status: r.status, body: await r.json() }; }
        catch (e) { health = { status: 0 }; }
      }
      p.kill();
      setTimeout(() => resolve({ up, out, health }), 600);
    };
    const t = setInterval(() => {
      if (/Fatal startup error/i.test(out)) finish(false);
      else if (new RegExp("running on port " + port).test(out)) finish(true);
    }, 250);
    const limit = setTimeout(() => finish(false), 90000);
  });
}

/**
 * The staging check. Returns { status, detail } like the other checks:
 * PASS, FAIL, or LOCAL when there is no real backup here to stage on.
 */
async function stage(root, opts) {
  const backupDir = (opts && opts.backupDir) || path.join(root, "data", "backups");
  const run = newestRun(backupDir);
  if (!run) {
    return { status: "LOCAL", detail: "no real backup on this machine to stage on — run where the shop's backups are" };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-"));
  try {
    for (const name of run.parts) {
      const rel = placeFor(name, run.stamp);
      if (!rel) continue;
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(backupDir, name), dest);
    }

    const before = counts(dir);
    const total = Object.values(before).reduce((a, b) => a + b, 0);

    const b = await boot(root, dir, (opts && opts.port) || 4870);
    if (!b.up) {
      const why = b.out.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 300);
      return { status: "FAIL", detail: `the release does NOT start on a copy of the real books (${run.stamp}): ${why}` };
    }
    if (!b.health || b.health.status !== 200 || !b.health.body || b.health.body.db !== "ok") {
      return { status: "FAIL", detail: "it starts on the real books but /api/health is not healthy: " + JSON.stringify(b.health) };
    }

    const after = counts(dir);
    const changed = Object.keys(before).filter(k => after[k] !== before[k]).map(k => `${k} ${before[k]}→${after[k]}`);
    if (changed.length) {
      return { status: "FAIL", detail: "its migrations CHANGED the number of rows in the real books: " + changed.join(", ") };
    }

    const ok = integrity(dir);
    if (ok.toLowerCase() !== "ok") return { status: "FAIL", detail: "the books fail SQLite's integrity check after the release ran: " + ok.slice(0, 120) };

    return { status: "PASS", detail: `starts healthy on a copy of the real books from ${run.stamp} and keeps all ${total} rows` };
  } finally {
    /* It is the shop's customer list. Not left in a temp folder. */
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (e) { await new Promise(r => setTimeout(r, 500)); }
    }
  }
}

if (require.main === module) {
  stage(ROOT).then(r => {
    console.log("\n  " + r.status + "  " + r.detail + "\n");
    process.exitCode = r.status === "PASS" ? 0 : 1;
  }).catch(e => { console.error("staging failed: " + e.message); process.exitCode = 1; });
}

module.exports = { stage, newestRun, counts, KEPT };
