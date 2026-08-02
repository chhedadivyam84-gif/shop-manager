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
function snapshotTo(destPath) {
  if (fs.existsSync(destPath)) {
    // VACUUM INTO refuses to overwrite; never reuse a name.
    throw new Error("Backup target already exists: " + destPath);
  }
  const sqlPath = destPath.replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  return destPath;
}

/** Newest-first list of local snapshot files with size and time. */
function listLocal() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("shop-") && f.endsWith(".db"))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      return { file: f, path: full, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

function rotateLocal(keep = KEEP_LOCAL) {
  const extra = listLocal().slice(keep);
  for (const b of extra) {
    try { fs.unlinkSync(b.path); } catch (_) { /* best effort */ }
  }
  return extra.length;
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
  const name = `shop-${stamp()}.db`;
  const dest = path.join(BACKUP_DIR, name);
  snapshotTo(dest);
  const size = fs.statSync(dest).size;
  const removed = rotateLocal();
  const cloud = await uploadToCloud(dest, name);

  lastRun = {
    at: Date.now(),
    trigger,
    file: name,
    size,
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
