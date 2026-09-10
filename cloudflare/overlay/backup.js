/* Backups, backed by R2 instead of a local folder plus Supabase.

   The real work lives in the Durable Object (backupNow / backupStatus /
   restoreFromBackup) because that is where both the data and the R2
   binding are. This module exists so the modules that already import
   `../backup` keep working: routes/alerts.js and routes/financialYears.js
   read cloudConfig/cloudUsage, and attachments.js references uploadToCloud.

   The 15-minute schedule is a Durable Object alarm now, so startSchedule()
   is a no-op rather than a setInterval with nowhere to live. */
const runtime = require("./_runtime");

const BACKUP_DIR = "/r2/backups";

async function runBackup(reason = "manual") {
  const out = await runtime.self().backupNow(reason, runtime.tenant());
  /* Callers expect the Express shape { local, cloud }. */
  return { local: { ok: !!out.ok, file: out.key || null }, cloud: { ok: !!out.ok, key: out.key || null }, ...out };
}

async function status() {
  const s = await runtime.self().backupStatus(runtime.tenant());
  return {
    ok: !!s.ok,
    cloud: { configured: true, provider: "Cloudflare R2", count: s.count || 0 },
    lastRun: s.lastBackupAt || null,
    nextRun: s.nextAlarmAt || null,
    local: { count: 0, dir: BACKUP_DIR },
  };
}

async function listCloud() {
  const s = await runtime.self().backupStatus(runtime.tenant());
  return (s.backups || []).map((b) => ({ name: b.key, size: b.size, at: b.uploaded }));
}

/* R2 is configured whenever the binding exists, which it does or the
   Worker would not have deployed. Saying "configured" truthfully matters:
   the Settings screen hides the whole panel when it is false. */
const cloudConfig = () => ({ configured: true, provider: "Cloudflare R2", bucket: "shop-manager-backups" });
const cloudUsage = async () => {
  const s = await runtime.self().backupStatus(runtime.tenant());
  return { count: s.count || 0, bytes: (s.backups || []).reduce((a, b) => a + (b.size || 0), 0) };
};

module.exports = {
  runBackup, status, listCloud, cloudConfig, cloudUsage,
  rotateCloud: async () => ({ deleted: 0 }),
  deleteCloudRuns: async () => { throw new Error("Deleting individual backups is not wired on this deployment yet."); },
  uploadToCloud: async () => { throw new Error("uploadToCloud: attachments are not wired to R2 yet."); },
  snapshotForDownload: () => { throw new Error("Downloading a .db file is not possible here — a Durable Object has no file. Use the JSON backups in R2."); },
  startSchedule: () => {},        /* a Durable Object alarm does this now */
  error: null,
  BACKUP_DIR,
};
