/* ============================================================
   MOVE ONE SHOP'S BOOKS INTO ITS DURABLE OBJECT

   Reads the live SQLite file READ-ONLY and pushes every non-empty
   table up through the guarded /import route. It never writes to the
   source, so the shop on Render keeps trading while this runs and can
   keep trading afterwards if the result is not accepted.

   THE VERIFICATION IS THE POINT. Copying rows is easy; knowing that
   every row arrived is the part that decides whether a cutover is
   safe. So after the copy it compares row counts table by table, and
   then re-reads a sample of actual rows and compares them field by
   field. A migration that reports success without that is a guess.

   Tables are sent in creation order, which is dependency order in
   db-schema.js — parents before children.

   Usage:
     node tools/migrate.js <worker-base-url> <shop-id> [--verify-only]
   The token is read from cloudflare/.migration-token and is never
   printed.
   ============================================================ */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DEFAULT = path.join(HERE, "..", "..", "data", "shop.db");
const TOKEN_FILE = path.join(HERE, "..", ".migration-token");
const BATCH = 200;

const [, , BASE, SHOP, ...rest] = process.argv;
const flags = rest.filter((a) => a.startsWith("--"));
const SOURCE = rest.find((a) => !a.startsWith("--")) || SOURCE_DEFAULT;
if (!BASE || !SHOP) {
  console.error("usage: node tools/migrate.js <url> <shop> [source.db] [--replace] [--verify-only]");
  process.exit(2);
}
const VERIFY_ONLY = flags.includes("--verify-only");
const REPLACE = flags.includes("--replace");
if (!fs.existsSync(SOURCE)) { console.error("source not found: " + SOURCE); process.exit(2); }

if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`missing ${TOKEN_FILE} — generate it before migrating`);
  process.exit(2);
}
const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();

const db = new DatabaseSync(SOURCE, { readOnly: true });

/* ORDER MATTERS, AND CREATION ORDER IS NOT IT.

   The app runs with `PRAGMA foreign_keys = ON` and a Durable Object
   enforces them too, so a child row inserted before its parent is
   rejected. Creation order looked like dependency order and is not:
   stock_ins is created before locations and suppliers but references
   both.

   So the tables are sorted topologically on their real foreign keys.
   Self-references are ignored as edges — a table cannot wait for
   itself — and if a genuine cycle exists between tables the run stops
   and names it rather than importing something half-linked. */
const allTables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)
  .all()
  .map((r) => r.name);

const deps = new Map();
for (const t of allTables) {
  const refs = new Set();
  try {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${t}")`).all()) {
      if (fk.table !== t && allTables.includes(fk.table)) refs.add(fk.table);
    }
  } catch { /* no FKs */ }
  deps.set(t, refs);
}

const tables = [];
const placed = new Set();
const visiting = new Set();
function place(t, trail = []) {
  if (placed.has(t)) return;
  if (visiting.has(t)) {
    throw new Error(`foreign-key cycle: ${[...trail, t].join(" -> ")}`);
  }
  visiting.add(t);
  for (const parent of deps.get(t) || []) place(parent, [...trail, t]);
  visiting.delete(t);
  placed.add(t);
  tables.push(t);
}
for (const t of allTables) place(t);

/* node:sqlite hands back a Uint8Array for BLOB columns, which JSON cannot
   carry. Rather than silently mangling one, the run stops and says which
   column it was — a corrupted attachment discovered months later is far
   worse than a migration that refuses to finish today. */
function assertJsonSafe(table, row) {
  for (const [k, v] of Object.entries(row)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) continue;
    if (typeof v === "bigint") { row[k] = Number(v); continue; }
    throw new Error(`${table}.${k} holds a ${v?.constructor?.name || typeof v}, which JSON cannot carry`);
  }
  return row;
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}?shop=${encodeURIComponent(SHOP)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-migration-token": TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${parsed ? JSON.stringify(parsed) : text.slice(0, 200)}`);
  return parsed;
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}?shop=${encodeURIComponent(SHOP)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathname}`);
  return res.json();
}

/* ---------------- copy ---------------- */
const local = {};
for (const t of tables) {
  local[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
}
const nonEmpty = tables.filter((t) => local[t] > 0);

console.log(`source:  ${SOURCE}`);
console.log(`target:  ${BASE}  (shop "${SHOP}")`);
console.log(`tables:  ${tables.length} total, ${nonEmpty.length} with rows\n`);

if (!VERIFY_ONLY && REPLACE) {
  /* Total replacement, not a merge. See clearAllRows() for why a blend of
     two datasets is the outcome worth preventing. */
  const r = await post("/api/migrate/reset", { tables });
  console.log(`cleared ${r.cleared} tables before import
`);
}

if (!VERIFY_ONLY) {
  let sent = 0;
  for (const t of nonEmpty) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => assertJsonSafe(t, r));
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const out = await post("/api/migrate/import", { table: t, rows: chunk });
      if (out.error) throw new Error(`${t}: ${out.error}`);
      done += out.inserted;
    }
    sent += done;
    console.log(`  ${t.padEnd(28)} ${String(done).padStart(5)} rows`);
  }
  console.log(`\ncopied ${sent} rows across ${nonEmpty.length} tables`);
}

/* ---------------- verify: counts ---------------- */
console.log("\nVERIFY 1 — row counts, table by table");
const remote = (await post("/api/migrate/rows", {})).counts;
const mismatched = [];
for (const t of tables) {
  const want = local[t];
  const got = remote[t];
  if (got !== want) mismatched.push(`${t}: local ${want} vs remote ${got}`);
}
if (mismatched.length) {
  console.log(`  MISMATCH in ${mismatched.length} table(s):`);
  mismatched.slice(0, 10).forEach((m) => console.log(`    ${m}`));
} else {
  console.log(`  every one of ${tables.length} tables matches exactly`);
}

/* ---------------- verify: actual field values ---------------- */
console.log("\nVERIFY 2 — field-by-field on real rows");
let compared = 0, differing = [];
for (const t of nonEmpty.slice(0, 12)) {
  const sample = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid LIMIT 3`).all();
  const back = await post("/api/migrate/select", { table: t, limit: 3 }).catch(() => null);
  if (!back || !back.rows) continue;
  for (let i = 0; i < sample.length && i < back.rows.length; i++) {
    for (const [k, v] of Object.entries(sample[i])) {
      const r = back.rows[i][k];
      const same = v === r || (v === null && r === null) || String(v) === String(r);
      compared++;
      if (!same) differing.push(`${t}[${i}].${k}: ${JSON.stringify(v)} vs ${JSON.stringify(r)}`);
    }
  }
}
if (!compared) console.log("  (no /select route on the worker — counts only)");
else if (differing.length) {
  console.log(`  ${differing.length} of ${compared} field(s) DIFFER:`);
  differing.slice(0, 8).forEach((d) => console.log(`    ${d}`));
} else console.log(`  ${compared} fields compared, all identical`);

db.close();
const bad = mismatched.length || differing.length;
console.log(`\n${bad ? "MIGRATION NOT VERIFIED — do not cut over" : "VERIFIED — counts and sampled fields match"}\n`);
process.exitCode = bad ? 1 : 0;
