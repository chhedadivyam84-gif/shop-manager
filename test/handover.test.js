/* ============================================================
   THE DEPLOY HANDOVER, PLAYED OUT FOR REAL

   The real app, booted as real processes, against a stand-in cloud that
   speaks S3 and refuses anything unsigned — the same signed requests that
   go to Cloudflare R2 in production, sent to 127.0.0.1 instead.

   It replays what Render does on every deploy:

     1. the OLD container has the shop's books and has backed them up
     2. the NEW container starts with an empty disk and restores
     3. a bill is entered on the OLD one, which then saves on its way out
        — AFTER the new one restored, exactly as the logs showed on 9 Oct
     4. the new container must notice, and

          if nothing has been written on it yet  → take the newer backup
                                                   in, and the bill is in
                                                   the running shop
          if work has started on it              → leave everything alone
                                                   and say so
          if the newer backup is damaged          → never apply it

   No production data, no real cloud, nothing outside temp directories.

   Run:  node test/handover.test.js
   ============================================================ */
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (x !== undefined ? "   " + JSON.stringify(x).slice(0, 400) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* ------------------------------------------------------------------ */
/* A stand-in for R2. Signed requests only.                            */
/* ------------------------------------------------------------------ */
const store = new Map();
let unsigned = 0;
const xe = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cloud = http.createServer((req, res) => {
  if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization || "")) {
    unsigned++; res.writeHead(403); res.end("<Error><Code>AccessDenied</Code></Error>"); return;
  }
  const url = new URL(req.url, "http://x");
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/").slice(1).join("/"));
  if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
    const names = [...store.keys()].sort();
    res.writeHead(200, { "content-type": "application/xml" });
    res.end("<?xml version=\"1.0\"?><ListBucketResult>" +
      names.map(n => `<Contents><Key>${xe(n)}</Key><Size>${store.get(n).length}</Size></Contents>`).join("") +
      "</ListBucketResult>");
    return;
  }
  if (req.method === "PUT") {
    const c = []; req.on("data", d => c.push(d));
    req.on("end", () => { store.set(key, Buffer.concat(c)); res.writeHead(200); res.end(); });
    return;
  }
  if (req.method === "GET") {
    const b = store.get(key);
    if (!b) { res.writeHead(404); res.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    res.writeHead(200); res.end(b); return;
  }
  if (req.method === "DELETE") { store.delete(key); res.writeHead(204); res.end(); return; }
  if (req.method === "POST") {
    const c = []; req.on("data", d => c.push(d));
    req.on("end", () => {
      for (const m of Buffer.concat(c).toString().matchAll(/<Key>([\s\S]*?)<\/Key>/g)) store.delete(m[1]);
      res.writeHead(200); res.end("<DeleteResult/>");
    });
    return;
  }
  res.writeHead(405); res.end();
});

let CLOUD_PORT;
const cloudEnv = () => ({
  R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "ak", R2_SECRET_ACCESS_KEY: "sk",
  R2_BUCKET: "handover-test", R2_ENDPOINT_OVERRIDE: `http://127.0.0.1:${CLOUD_PORT}`,
  SUPABASE_URL: "", SUPABASE_KEY: "", SUPABASE_BUCKET: "",
  DEPLOY_CHECK_AFTER_MS: "4000", ASSISTANT_API_KEY: "", DEPLOY_CATCHUP: "",
});

/* ------------------------------------------------------------------ */
/* The OLD container's books — written and backed up by a short script */
/* run in its data directory, exactly the code that runs in production. */
/* ------------------------------------------------------------------ */
/* ASYNC, NOT execFileSync. The stand-in cloud lives in THIS process, and a
   synchronous child blocks this event loop — so the cloud could not answer
   the very upload the child was making, and the new container's listing
   timed out behind it. That is what the first run of this file showed. */
function inOld(dir, script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["-e", `
      const db = require(${JSON.stringify(path.join(ROOT, "server/db.js"))});
      const backup = require(${JSON.stringify(path.join(ROOT, "server/backup.js"))});
      const { hashPin } = require(${JSON.stringify(path.join(ROOT, "server/auth.js"))});
      const c = db.companies.list()[0];
      (async () => { ${script} })()
        .then(() => { console.log("OLD-CONTAINER-DONE"); process.exitCode = 0; })
        .catch(e => { console.error(e.message); process.exitCode = 1; });
    `], { env: { ...process.env, ...cloudEnv(), DATA_DIR: dir } });
    /* Judged by what it SAID it finished, not by its exit code: on Windows
       a Node process that made an HTTP request can abort on the way out
       (libuv's UV_HANDLE_CLOSING assertion) after its work is complete. */
    let out = "", err = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("exit", () => /OLD-CONTAINER-DONE/.test(out)
      ? resolve()
      : reject(new Error("old container script failed: " + err.slice(-300))));
  });
}

const SEED = `
  db.companies.runAs(c.id, () => {
    db.prepare("UPDATE staff SET pin_hash = ? WHERE id = ?").run(hashPin("4821"), "STAFF_owner");
    db.prepare("INSERT INTO products (id,name,sku,unit,gst_rate,stock,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("P1","Green Gold Ply","GG1","Sheet",18,10,Date.now());
    db.prepare("INSERT INTO customers (id,name,phone,due,created_at,active) VALUES (?,?,?,?,?,1)")
      .run("C1","Ramesh Traders","98200",0,Date.now());
    db.prepare("INSERT INTO invoices (id,challan_no,doc_type,date,created_at,customer_id,subtotal,total,balance_due) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("INV-1","B-1","invoice","2026-10-09",Date.now(),"C1",1000,1000,0);
  });
  await backup.runBackup("scheduled");
`;

/* The bill entered on the OLD container in the last moments, and the
   final save it makes as Render shuts it down. */
const LATE_BILL = `
  db.companies.runAs(c.id, () => {
    db.prepare("INSERT INTO invoices (id,challan_no,doc_type,date,created_at,customer_id,subtotal,total,balance_due) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("INV-2","B-2","invoice","2026-10-09",Date.now(),"C1",2500,2500,0);
  });
  await backup.runBackup("pre-shutdown");
`;

/* ------------------------------------------------------------------ */
/* The NEW container — the real server                                 */
/* ------------------------------------------------------------------ */
function startNew(dir, port, extraEnv) {
  const p = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "server/index.js")], {
    cwd: ROOT, env: { ...process.env, ...cloudEnv(), ...(extraEnv || {}), DATA_DIR: dir, PORT: String(port) },
  });
  const proc = { p, out: "", exited: null };
  p.stdout.on("data", d => proc.out += d);
  p.stderr.on("data", d => proc.out += d);
  p.on("exit", code => { proc.exited = code; });
  return proc;
}
async function waitFor(proc, re, ms) {
  for (let t = 0; t < ms; t += 200) {
    if (re.test(proc.out)) return true;
    if (proc.exited !== null) return re.test(proc.out);
    await sleep(200);
  }
  return false;
}
async function waitExit(proc, ms) {
  for (let t = 0; t < ms; t += 200) { if (proc.exited !== null) return proc.exited; await sleep(200); }
  return null;
}
const stop = proc => new Promise(r => {
  if (proc.exited !== null) return r();
  proc.p.once("exit", () => r()); proc.p.kill(); setTimeout(r, 4000);
});
const health = async port => {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); return { status: r.status, body: await r.json() }; }
  catch (e) { return { status: 0, body: null }; }
};
function invoicesIn(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare("SELECT id FROM invoices ORDER BY id").all().map(r => r.id); }
  finally { d.close(); }
}

/* ================================================================== */
(async () => {
  await new Promise(r => cloud.listen(0, "127.0.0.1", r));
  CLOUD_PORT = cloud.address().port;

  /* ---------------------------------------------------------------- */
  console.log("\n--- the handover, with nothing entered on the new container ---\n");
  {
    store.clear();
    const OLD = tmp("ho-old-"), NEW = tmp("ho-new-");

    await inOld(OLD, SEED);
    ok("the old container's books are in the cloud",
       [...store.keys()].some(k => /^shop-\d{8}-\d{6}\.db$/.test(k)), [...store.keys()]);

    const n1 = startNew(NEW, 4861);
    ok("the new container starts", await waitFor(n1, /running on port 4861/, 30000), n1.out.slice(-400));
    ok("...by restoring from the cloud", /Restored database from cloud backup/.test(n1.out));
    ok("...and does NOT take a startup snapshot that could collide",
       /startup snapshot skipped/.test(n1.out), n1.out.slice(-400));

    /* Stamps are to the second, so the old container's save must land in
       a later second than the restore — which is exactly what happens. */
    await sleep(1300);
    await inOld(OLD, LATE_BILL);
    ok("the old container's final save, with the late bill, reaches the cloud AFTER the restore",
       [...store.keys()].filter(k => /^shop-\d{8}-\d{6}\.db$/.test(k)).length >= 2);

    const code = await waitExit(n1, 30000);
    ok("THE NEW CONTAINER NOTICES AND TAKES IT IN", /taking in the newer backup/.test(n1.out), n1.out.slice(-600));
    ok("...restarting cleanly so it applies before any database opens", code === 0, code);
    ok("...with a verified staging ready for the next boot",
       fs.existsSync(path.join(NEW, "catchup", "READY")));

    /* The host starts the process again, on the same disk. */
    const n2 = startNew(NEW, 4862);
    ok("restarted, it starts", await waitFor(n2, /running on port 4862/, 30000), n2.out.slice(-400));
    ok("...and says it took in the newer backup", /took in the newer backup/.test(n2.out), n2.out.slice(-400));
    const h = await health(4862);
    ok("...and is healthy", h.status === 200 && h.body && h.body.db === "ok", h);
    await stop(n2);

    const live = invoicesIn(path.join(NEW, "shop.db"));
    ok("THE LATE BILL IS IN THE RUNNING SHOP — the gap is closed",
       live.includes("INV-1") && live.includes("INV-2"), live);

    const aside = fs.readdirSync(NEW).filter(n => n.startsWith("superseded-"));
    ok("what it replaced was kept, not deleted", aside.length === 1, fs.readdirSync(NEW));
    if (aside.length) {
      const kept = invoicesIn(path.join(NEW, aside[0], "shop.db"));
      ok("...and is the older copy, without the late bill",
         kept.includes("INV-1") && !kept.includes("INV-2"), kept);
    }
    ok("nothing is left waiting to be applied again", !fs.existsSync(path.join(NEW, "catchup", "READY")));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the handover, with work ALREADY entered on the new container ---\n");
  {
    store.clear();
    const OLD = tmp("ho-old2-"), NEW = tmp("ho-new2-");
    await inOld(OLD, SEED);

    const n = startNew(NEW, 4863);
    ok("the new container starts", await waitFor(n, /running on port 4863/, 30000), n.out.slice(-300));

    /* Somebody signs in and records a customer on the NEW container,
       through the app, before the check runs. */
    const base = "http://127.0.0.1:4863";
    const login = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "STAFF_owner", pin: "4821" }),
    });
    const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
      .map(c => c.split(";")[0]).join("; ");
    const made = await fetch(base + "/api/customers", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Walk-in after deploy", phone: "9820099999" }),
    });
    ok("work is entered on the new container", made.status === 200 || made.status === 201, made.status);

    await sleep(1300);
    await inOld(OLD, LATE_BILL);

    ok("the check runs", await waitFor(n, /NEWER THAN THE ONE THIS RELEASE RESTORED/, 30000), n.out.slice(-500));
    ok("IT IS LEFT ALONE, because the two copies have diverged",
       /NOT taken in, because work has already been entered/.test(n.out), n.out.slice(-500));
    await sleep(800);
    ok("...the container keeps running", n.exited === null, n.exited);
    const h = await health(4863);
    ok("...and /api/health says which backup is newer, and why it was not taken",
       h.body && /^\d{8}-\d{6}$/.test(h.body.newerBackupThanRunning || "") && /diverged/.test(h.body.gapOutcome || ""),
       h.body);
    ok("...nothing is staged to be applied", !fs.existsSync(path.join(NEW, "catchup", "READY")));
    await stop(n);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- a newer backup that is damaged is never applied ---\n");
  {
    store.clear();
    const OLD = tmp("ho-old3-"), NEW = tmp("ho-new3-");
    await inOld(OLD, SEED);

    const n = startNew(NEW, 4864);
    ok("the new container starts", await waitFor(n, /running on port 4864/, 30000), n.out.slice(-300));

    /* A "newer" backup that is an error page saved with HTTP 200. */
    await sleep(1300);
    const s = new Date(Date.now() + 2000);
    const pad = x => String(x).padStart(2, "0");
    const stamp = `${s.getFullYear()}${pad(s.getMonth() + 1)}${pad(s.getDate())}-${pad(s.getHours())}${pad(s.getMinutes())}${pad(s.getSeconds())}`;
    store.set(`shop-${stamp}.db`, Buffer.from("<html>502 Bad Gateway</html>"));

    ok("the check runs", await waitFor(n, /NEWER THAN THE ONE THIS RELEASE RESTORED/, 30000), n.out.slice(-500));
    ok("IT IS REFUSED, because it did not verify", /it did not verify/.test(n.out), n.out.slice(-500));
    await sleep(800);
    ok("...the container keeps running on the good data", n.exited === null);
    ok("...nothing is staged to be applied", !fs.existsSync(path.join(NEW, "catchup", "READY")));
    await stop(n);
    ok("...and the running shop still has its bills",
       invoicesIn(path.join(NEW, "shop.db")).includes("INV-1"));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- switched off ---\n");
  {
    store.clear();
    const OLD = tmp("ho-old4-"), NEW = tmp("ho-new4-");
    await inOld(OLD, SEED);
    const n = startNew(NEW, 4865, { DEPLOY_CATCHUP: "off" });
    await waitFor(n, /running on port 4865/, 30000);
    await sleep(1300);
    await inOld(OLD, LATE_BILL);
    ok("with DEPLOY_CATCHUP=off it only warns",
       await waitFor(n, /switched off/, 30000), n.out.slice(-400));
    await sleep(800);
    ok("...and does not restart", n.exited === null);
    await stop(n);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n--- the cloud path was real ---\n");
  ok("every request to the stand-in cloud was signed", unsigned === 0, unsigned);

  cloud.close();
  console.log(`\n==============================================`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`==============================================\n`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error("\nTEST ERROR: " + e.stack); process.exitCode = 1; });
