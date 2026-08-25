#!/usr/bin/env node
/* ============================================================
   PULL THE NEWEST BACKUP OUT OF SUPABASE, ONTO THIS PC

     set SUPABASE_URL=https://xxxx.supabase.co
     set SUPABASE_KEY=<your service_role key>
     node tools/pull-from-supabase.js

   The key is read from the environment and never written anywhere — not to a
   file, not to the console, not into this repository.

   Stop the app before running this. Writing over a database that is open
   corrupts it.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_KEY || "";
const bucket = process.env.SUPABASE_BUCKET || "shop-backups";

if (!url || !key) {
  console.error("\n  Set SUPABASE_URL and SUPABASE_KEY first.\n");
  console.error("  In this window:");
  console.error('    export SUPABASE_URL="https://xxxx.supabase.co"');
  console.error('    export SUPABASE_KEY="your service_role key"');
  console.error("    node tools/pull-from-supabase.js\n");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE = path.join(DATA_DIR, "shop.db");
const t = ms => ({ signal: AbortSignal.timeout(ms) });

(async () => {
  console.log("\n  Asking Supabase what backups it has…");
  const list = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 5000, sortBy: { column: "name", order: "desc" } }),
    ...t(30000)
  });
  if (!list.ok) {
    console.error(`\n  Supabase said ${list.status}. Check the URL and the key.\n`);
    process.exit(1);
  }

  const all = (await list.json()).map(f => f.name).filter(n => n && n.startsWith("shop-"));
  const primaries = all.filter(n => n.endsWith(".db") && !n.includes("--")).sort().reverse();
  if (!primaries.length) { console.error("\n  No backups in that bucket.\n"); process.exit(1); }

  const newest = primaries[0];
  console.log(`  ${all.length} file(s) there. Newest: ${newest}`);

  const res = await fetch(`${url}/storage/v1/object/${bucket}/${newest}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key }, ...t(120000)
  });
  if (!res.ok) { console.error(`\n  Download failed: ${res.status}\n`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  downloaded ${(buf.length / 1048576).toFixed(2)} MB`);

  const staging = path.join(DATA_DIR, "backups", newest);
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.writeFileSync(staging, buf);

  // Read it before trusting it — a truncated download looks like a file too.
  const db = new DatabaseSync(staging);
  const n = tbl => { try { return db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n; } catch { return null; } };
  const found = { products: n("products"), customers: n("customers"), invoices: n("invoices"),
                  items: n("invoice_items"), purchases: n("purchases") };
  let shop = null;
  try { shop = db.prepare("SELECT business_name FROM settings WHERE id=1").get().business_name; } catch {}
  db.close();

  console.log(`\n  What is inside it${shop ? ` (${shop})` : ""}:`);
  Object.entries(found).forEach(([k, v]) => console.log(`    ${k.padEnd(10)} ${v === null ? "-" : v}`));
  console.log(`\n  Saved to: data/backups/${newest}`);
  console.log(`\n  To make it the live database:`);
  console.log(`    node tools/restore-from-file.js "data/backups/${newest}"\n`);
})().catch(e => { console.error("\n  Failed: " + e.message + "\n"); process.exit(1); });
