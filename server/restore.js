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
const cloudStore = require("./cloudStore");

// Same folder the rest of the app uses — see db-schema.js.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "shop.db");

function cloudConfig() {
  return { enabled: cloudStore.configured() };
}

/* Nothing here may hang.
 *
 * start() waits for this before the server listens, so a fetch with no
 * timeout is not a slow restore — it is a shop that never comes back. The
 * host accepts the connection, nothing behind it ever answers, and the only
 * symptom is a page that spins.
 *
 * A single request gets PER_REQUEST_MS; the whole restore gets OVERALL_MS.
 * Past either, the app starts anyway. An empty database the shopkeeper can
 * see is recoverable; an app that never starts is not. */
const PER_REQUEST_MS = 20000;
const OVERALL_MS = 90000;

const fetchWithTimeout = (url, opts) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(PER_REQUEST_MS) });

async function restoreIfNeeded() {
  try {
    return await Promise.race([
      doRestore(),
      new Promise(resolve => setTimeout(
        () => resolve({ restored: false, reason: `gave up after ${OVERALL_MS / 1000}s — starting without it` }),
        OVERALL_MS))
    ]);
  } catch (e) {
    // Unreachable, wrong key, bad URL — all the same answer: start anyway.
    return { restored: false, reason: `could not reach the backup store: ${e.message}` };
  }
}

async function doRestore() {
  if (fs.existsSync(DB_PATH)) return { restored: false, reason: "shop.db already present" };
  if (!cloudStore.configured()) return { restored: false, reason: "cloud backup not configured" };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const all = (await cloudStore.list()).map(f => f.name).filter(n => n.startsWith("shop-"));

  /* The first business's file identifies a run; "--" marks the other parts. */
  const primaries = all
    .filter(n => n.endsWith(".db") && !n.includes("--"))
    .sort((a, b) => b.localeCompare(a));   // filenames are timestamp-sortable
  if (!primaries.length) return { restored: false, reason: "no backups found in bucket yet" };

  const latest = primaries[0];
  const stamp = /^shop-(.+).db$/.exec(latest)[1];

  let buf;
  try { buf = await cloudStore.download(latest); }
  catch (e) { return { restored: false, reason: e.message }; }
  fs.writeFileSync(DB_PATH, buf);

  /* Everything else from the SAME run: the other businesses, then the registry
     that names them. The registry is written last so it never lists a business
     whose file has not landed. */
  const others = all.filter(n => n.startsWith(`shop-${stamp}--`) && n.endsWith(".db"));
  const restoredCompanies = [];
  for (const name of others) {
    const id = /--(.+).db$/.exec(name)[1];
    const dir = path.join(DATA_DIR, "companies", id);
    try {
      const b = await cloudStore.download(name);
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
    try { fs.writeFileSync(path.join(DATA_DIR, "companies.json"), await cloudStore.download(regName)); }
    catch (e) {
      return { restored: true, file: latest, size: buf.length,
        partial: `the business list could not be restored: ${e.message}` };
    }
  }

  return { restored: true, file: latest, size: buf.length, businesses: 1 + restoredCompanies.length };
}

module.exports = { restoreIfNeeded };
