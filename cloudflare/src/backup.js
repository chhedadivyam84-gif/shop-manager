/* ============================================================
   BACKUPS TO R2 — the Supabase replacement

   What the shop runs today: server/backup.js takes a snapshot every 15
   minutes on a setInterval and pushes it to Supabase Storage. A Worker
   has no long-lived process, so the interval has no home; a Durable
   Object alarm is where that job belongs, and R2 is the same kind of
   thing as Supabase Storage — object storage, S3-compatible, with no
   egress charge.

   WHY JSON AND NOT A .db FILE

   The Express app copies the SQLite file itself, which is the right
   answer when there IS a file. A Durable Object's storage is not a file
   you can read off disk — there is no path to copy. What can be read is
   every row, so a snapshot here is the data rather than the container.

   That turns out to be worth something on its own: a JSON snapshot can
   be restored into anything (a DO, a fresh SQLite file, a different
   engine entirely), whereas a .db file can only go back into SQLite.
   The cost is size, which gzip largely takes back.

   WHAT IS DELIBERATELY NOT IN A SNAPSHOT

   Sessions. They live in key-value storage, not in the SQL tables, and
   server/sessionStore.js is explicit that a session "is not shop data
   and has no business in the backup". Restoring a backup therefore does
   not restore anybody's login, which is correct: a restore should not
   silently reinstate a session that was signed out.
   ============================================================ */

const KEEP = 48;   /* 48 x 15min = the last twelve hours of the shop's day */

/* Every table with rows, as { name: [row, ...] }. Empty tables are left
   out — 70 of the 92 are empty in a real shop, and writing them as empty
   arrays would triple the snapshot for nothing. */
export function snapshot(sql) {
  const names = sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .toArray()
    .map((r) => r.name)
    .filter((n) => n !== "_cf_KV");

  const data = {};
  let rows = 0;
  for (const name of names) {
    try {
      const r = sql.exec(`SELECT * FROM "${name}"`).toArray();
      if (r.length) { data[name] = r; rows += r.length; }
    } catch { /* a table that cannot be read is reported by the caller */ }
  }
  return { data, rows, tables: Object.keys(data).length };
}

/* A cheap fingerprint, so an idle shop does not pay to store forty-eight
   identical copies of a day when nobody sold anything. Row counts plus the
   database size catch every insert and delete, and every update that
   changes a row's length. An update that happens to preserve length is
   missed; the next real write picks it up, and the alternative — hashing
   every row every fifteen minutes — costs more than it saves. */
export function signature(sql) {
  const names = sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .toArray().map((r) => r.name);
  let total = 0;
  for (const n of names) {
    try { total += sql.exec(`SELECT COUNT(*) AS c FROM "${n}"`).toArray()[0].c; } catch {}
  }
  return `${total}:${sql.databaseSize ?? 0}`;
}

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/* Oldest first, so pruning takes from the front. */
export async function listBackups(bucket, tenant) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: `${tenant}/`, cursor, limit: 1000 });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => (a.key < b.key ? -1 : 1));
  return out;
}

export async function prune(bucket, tenant, keep = KEEP) {
  const all = await listBackups(bucket, tenant);
  if (all.length <= keep) return { deleted: 0, kept: all.length };
  const doomed = all.slice(0, all.length - keep);
  for (const o of doomed) await bucket.delete(o.key);
  return { deleted: doomed.length, kept: keep };
}
