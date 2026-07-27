/* ============================================================
   RESTORE ON BOOT
   ------------------------------------------------------------
   Counterpart to backup.js's cloud upload. On a host with an
   ephemeral disk (e.g. Render's free tier resets the filesystem
   on every redeploy/restart), a fresh container has no shop.db
   at all. If that's the case AND cloud backup is configured, pull
   the most recent Supabase snapshot down before anything opens
   the database.

   A shop.db already on disk (normal restart, or a PC that never
   loses its filesystem) is left untouched — this only fires on a
   truly empty data dir.
   ============================================================ */
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "shop.db");

function cloudConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_KEY || "";
  const bucket = process.env.SUPABASE_BUCKET || "shop-backups";
  return { enabled: !!(url && key), url, key, bucket };
}

async function restoreIfNeeded() {
  if (fs.existsSync(DB_PATH)) return { restored: false, reason: "shop.db already present" };

  const cfg = cloudConfig();
  if (!cfg.enabled) return { restored: false, reason: "cloud backup not configured" };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const listRes = await fetch(`${cfg.url}/storage/v1/object/list/${cfg.bucket}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, apikey: cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "desc" } })
  });
  if (!listRes.ok) return { restored: false, reason: `could not list backups: ${listRes.status}` };

  const files = (await listRes.json())
    .filter(f => f.name.startsWith("shop-") && f.name.endsWith(".db"))
    .sort((a, b) => b.name.localeCompare(a.name)); // filenames are timestamp-sortable
  if (!files.length) return { restored: false, reason: "no backups found in bucket yet" };

  const latest = files[0].name;
  const dlRes = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${latest}`, {
    headers: { Authorization: `Bearer ${cfg.key}`, apikey: cfg.key }
  });
  if (!dlRes.ok) return { restored: false, reason: `download failed: ${dlRes.status}` };

  const buf = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(DB_PATH, buf);
  return { restored: true, file: latest, size: buf.length };
}

module.exports = { restoreIfNeeded };
