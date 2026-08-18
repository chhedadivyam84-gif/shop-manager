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

// Same folder the rest of the app uses — see db-schema.js.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
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

  const all = (await listRes.json()).map(f => f.name).filter(n => n.startsWith("shop-"));

  /* The first business's file identifies a run; "--" marks the other parts. */
  const primaries = all
    .filter(n => n.endsWith(".db") && !n.includes("--"))
    .sort((a, b) => b.localeCompare(a)); // filenames are timestamp-sortable
  if (!primaries.length) return { restored: false, reason: "no backups found in bucket yet" };

  const latest = primaries[0];
  const stamp = /^shop-(.+)\.db$/.exec(latest)[1];

  const download = async name => {
    const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${name}`, {
      headers: { Authorization: `Bearer ${cfg.key}`, apikey: cfg.key }
    });
    if (!res.ok) throw new Error(`download failed for ${name}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  let buf;
  try { buf = await download(latest); }
  catch (e) { return { restored: false, reason: e.message }; }
  fs.writeFileSync(DB_PATH, buf);

  /* Everything else from the SAME run: the other businesses, then the registry
     that names them. The registry is written last so it never lists a business
     whose file has not landed — a registry entry with no database behind it
     would fail at the first query rather than at start-up. */
  const others = all.filter(n => n.startsWith(`shop-${stamp}--`) && n.endsWith(".db"));
  const restoredCompanies = [];
  for (const name of others) {
    const id = /--(.+)\.db$/.exec(name)[1];
    const dir = path.join(DATA_DIR, "companies", id);
    try {
      const b = await download(name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "shop.db"), b);
      restoredCompanies.push(id);
    } catch (e) {
      return { restored: true, file: latest, size: buf.length,
        partial: `business ${id} could not be restored: ${e.message}` };
    }
  }

  const regName = `shop-${stamp}--registry.json`;
  if (all.includes(regName)) {
    try { fs.writeFileSync(path.join(DATA_DIR, "companies.json"), await download(regName)); }
    catch (e) {
      return { restored: true, file: latest, size: buf.length,
        partial: `the business list could not be restored: ${e.message}` };
    }
  }

  return {
    restored: true, file: latest, size: buf.length,
    businesses: 1 + restoredCompanies.length
  };
}

module.exports = { restoreIfNeeded };
