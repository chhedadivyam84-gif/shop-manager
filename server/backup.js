/* ============================================================
   BACKUPS
   ------------------------------------------------------------
   Goal: never lose the shop's records. Two layers:

     1. Local rotating snapshots in data/backups/, taken on a
        schedule and on demand. Protects against DB corruption
        and accidental deletion.
     2. An optional copy pushed to the shop's own free Supabase
        Storage bucket, so a dead/stolen/burnt PC doesn't take
        the records with it. Off unless SUPABASE_* env vars are
        set — the app stays fully local-first either way.

   Snapshots are made with `VACUUM INTO`, not a file copy. The
   live database runs in WAL mode, so copying shop.db while the
   app is writing can capture a torn, unusable file. VACUUM INTO
   asks SQLite itself for a transactionally consistent single-
   file snapshot — the correct way to back up a hot database.
   ============================================================ */
const path = require("path");
const fs = require("fs");
const db = require("./db");

/* Captured here, at import, while the default company's connection is the
   active one. Reading db.companies later from inside runAs() would resolve
   against a different connection. */
const C = db.companies;

/* One run writes one file per business, plus the registry naming them, all
   sharing a timestamp:

     shop-<stamp>.db                 the first business (this name predates
                                     multi-business and is kept, so older
                                     backups still restore)
     shop-<stamp>--<id>.db           every other business
     shop-<stamp>--registry.json     which businesses exist

   Sharing the stamp is what makes a run restorable as a set: a registry
   naming a business whose file came from a different run would restore a
   business pointing at the wrong books. */
const REGISTRY_SUFFIX = "--registry.json";
function partName(stamp, companyId) {
  return companyId === C.defaultId()
    ? `shop-${stamp}.db`
    : `shop-${stamp}--${companyId}.db`;
}
function stampOf(fileName) {
  const m = /^shop-(.+?)(?:--.*)?\.(?:db|json)$/.exec(fileName);
  return m ? m[1] : null;
}

const BACKUP_DIR = path.join(db.dataDir, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Keep a month of daily local snapshots. Each is a few KB for this shop, so
// this is generous; the rotation exists to stop unbounded growth, not to save
// meaningful space.
const KEEP_LOCAL = 30;

// In-memory record of the last run, surfaced to the owner in Settings. Not
// persisted — a restart simply shows "no backup yet this session" until the
// next scheduled run, and the files on disk are the real source of truth.
let lastRun = null;

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Write a consistent snapshot to `destPath`. VACUUM INTO takes the target as a
 * string LITERAL (it cannot be a bound parameter), so the path is quote-escaped
 * by hand. Forward slashes work on every OS SQLite runs on, Windows included.
 */
function snapshotTo(destPath, companyId) {
  if (fs.existsSync(destPath)) {
    // VACUUM INTO refuses to overwrite; never reuse a name.
    throw new Error("Backup target already exists: " + destPath);
  }
  const sqlPath = destPath.replace(/\\/g, "/").replace(/'/g, "''");
  // Bound to one business, or the handle would snapshot whichever database
  // happened to be active — which is how every business but the first went
  // unbacked-up.
  const take = () => db.exec(`VACUUM INTO '${sqlPath}'`);
  if (companyId) C.runAs(companyId, take); else take();
  return destPath;
}

/** Newest-first list of local snapshot files with size and time. */
function listLocal() {
  // The first business's file stands for its run, so the Settings screen shows
  // one row per backup rather than one per business.
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("shop-") && f.endsWith(".db") && !f.includes("--"))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      return { file: f, path: full, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

/** Every file belonging to one run, the other businesses and registry included. */
function partsOfRun(stamp) {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("shop-") && stampOf(f) === stamp)
    .map(f => path.join(BACKUP_DIR, f));
}

/* Rotation counts RUNS, not files. Counting files would silently keep fewer
   and fewer days of history as businesses are added. */
function rotateLocal(keep = KEEP_LOCAL) {
  const staleStamps = listLocal().slice(keep).map(b => stampOf(b.file)).filter(Boolean);
  let removed = 0;
  for (const stamp of staleStamps) {
    for (const p of partsOfRun(stamp)) {
      try { fs.unlinkSync(p); removed++; } catch (_) { /* best effort */ }
    }
  }
  return removed;
}

/* ------------------------------------------------------------
   SUPABASE STORAGE (optional)
   Uploads over the plain Storage REST API with fetch — no SDK,
   so nothing new to npm-install and the zero-build design holds.
   Credentials live only in the server's environment; the browser
   never sees them.
   ------------------------------------------------------------ */
function cloudConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_KEY || "";
  const bucket = process.env.SUPABASE_BUCKET || "shop-backups";
  return { enabled: !!(url && key), url, key, bucket };
}

async function uploadToCloud(filePath, objectName) {
  const cfg = cloudConfig();
  if (!cfg.enabled) return { attempted: false };

  const body = fs.readFileSync(filePath);
  const endpoint = `${cfg.url}/storage/v1/object/${cfg.bucket}/${objectName}`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        apikey: cfg.key,
        "Content-Type": "application/octet-stream",
        // Overwrite yesterday-with-same-name rather than erroring on a re-run.
        "x-upsert": "true"
      },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { attempted: true, ok: false, error: `Supabase ${res.status}: ${text.slice(0, 200)}` };
    }
    return { attempted: true, ok: true, object: objectName };
  } catch (err) {
    // No internet is the expected failure here — a local-first shop is often
    // offline. Report it, never throw: the local backup already succeeded.
    return { attempted: true, ok: false, error: String(err.message || err) };
  }
}

/**
 * Take a backup now: local snapshot (+ rotation), then cloud copy if
 * configured. `trigger` is recorded for the audit trail ("scheduled" | "manual").
 * A local-snapshot failure throws (something is genuinely wrong); a cloud
 * failure is captured in the result, not thrown.
 */
async function runBackup(trigger = "manual") {
  const s = stamp();
  const companies = C.list();
  const written = [];

  /* Every business, and the registry that names them. A backup missing one
     business is a business that cannot be brought back. */
  for (const company of companies) {
    const name = partName(s, company.id);
    const dest = path.join(BACKUP_DIR, name);
    snapshotTo(dest, company.id);
    written.push({ name, path: dest, size: fs.statSync(dest).size });
  }

  const regName = `shop-${s}${REGISTRY_SUFFIX}`;
  const regPath = path.join(BACKUP_DIR, regName);
  fs.writeFileSync(regPath, JSON.stringify({
    companies, defaultId: C.defaultId()
  }, null, 2));
  written.push({ name: regName, path: regPath, size: fs.statSync(regPath).size });

  const removed = rotateLocal();

  /* Uploaded after all of them exist locally, so a run that fails part-way
     never puts a half-set in the bucket for restore to find. */
  let cloud = { attempted: false };
  for (const part of written) {
    const r = await uploadToCloud(part.path, part.name);
    if (!r.attempted) { cloud = r; break; }
    // One failure fails the run's cloud copy: a partial set is not a backup.
    if (!r.ok) { cloud = r; break; }
    cloud = r;
  }

  const primary = written[0];
  lastRun = {
    at: Date.now(),
    trigger,
    file: primary.name,
    size: written.reduce((t, p) => t + p.size, 0),
    businesses: companies.length,
    rotatedAway: removed,
    cloud
  };
  return lastRun;
}

/** Status for the Settings screen: last run + what's on disk + cloud on/off. */
function status() {
  const local = listLocal();
  return {
    lastRun,
    localCount: local.length,
    localBackups: local.slice(0, 10),
    cloudEnabled: cloudConfig().enabled,
    keepLocal: KEEP_LOCAL,
    dir: BACKUP_DIR
  };
}

/**
 * A fresh snapshot written to a throwaway path, for the "Download Backup"
 * button. Kept separate from the rotating set so a download never disturbs the
 * scheduled history. Caller is responsible for deleting it after streaming.
 */
function snapshotForDownload() {
  const dest = path.join(BACKUP_DIR, `download-${stamp()}-${process.pid}.tmp.db`);
  return snapshotTo(dest);
}

/* ------------------------------------------------------------
   SCHEDULE
   One backup shortly after startup (so a freshly-booted shop PC
   is covered without waiting a day), then a recurring one. setInterval
   is enough — this app is a single long-lived process, and a
   missed tick during a reboot is caught by the next startup run.

   The recurring interval is short (15 min) ONLY when cloud backup is
   configured — that's the ephemeral-disk (Render) case, where the gap
   between "last cloud backup" and "next redeploy" is exactly the window
   in which anything the shop entered live can be silently lost forever
   (see the SIGTERM handler in index.js for the other half of this fix).
   A local-only PC's disk is never wiped out from under it, so it stays
   on the calmer daily cadence — no reason to spam data/backups/ with a
   snapshot every 15 minutes when nothing is actually at risk there.
   ------------------------------------------------------------ */
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOUD_INTERVAL_MS = 15 * 60 * 1000;

function startSchedule() {
  const kick = async (trigger) => {
    try {
      const r = await runBackup(trigger);
      const where = r.cloud.ok ? " + cloud" : (r.cloud.attempted ? " (cloud failed: " + r.cloud.error + ")" : "");
      console.log(`[backup] ${trigger} snapshot ${r.file} (${r.size} bytes)${where}`);
    } catch (err) {
      console.error("[backup] FAILED:", err.message);
    }
  };
  const intervalMs = cloudConfig().enabled ? CLOUD_INTERVAL_MS : DAY_MS;
  // Delay the first run a little so it doesn't compete with startup work.
  setTimeout(() => kick("startup"), 10_000).unref?.();
  setInterval(() => kick("scheduled"), intervalMs).unref?.();
}

module.exports = {
  runBackup, status, snapshotForDownload, startSchedule,
  cloudConfig, uploadToCloud, listLocal, BACKUP_DIR
};
