#!/usr/bin/env node
/* ============================================================
   RESTORE A BACKUP INTO THIS PC

     node tools/restore-from-file.js "C:/path/to/shop-20260820-143022.db"

   For a backup downloaded out of the Supabase bucket by hand, or copied off
   another machine. Puts it where the app expects it and keeps what was there
   before, because a restore that turns out to be the wrong file must be
   undoable.

   Stop the app first. Writing over a database that is open corrupts it.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const LIVE = path.join(DATA_DIR, "shop.db");

const src = process.argv[2];
if (!src) {
  console.error('Usage: node tools/restore-from-file.js "<path to a .db backup>"');
  process.exit(1);
}
if (!fs.existsSync(src)) { console.error("No such file: " + src); process.exit(1); }

/* Read it before trusting it. A truncated download and a real backup look
   identical in a folder listing, and the difference only shows up later. */
function inspect(file) {
  const db = new DatabaseSync(file);
  const count = t => {
    try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; }
  };
  const out = {
    products: count("products"), customers: count("customers"),
    invoices: count("invoices"), items: count("invoice_items"),
    purchases: count("purchases"), suppliers: count("suppliers")
  };
  try {
    const s = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
    out.shop = s && s.business_name;
  } catch { out.shop = null; }
  db.close();
  return out;
}

let incoming;
try { incoming = inspect(src); }
catch (e) { console.error("\nThat file is not a readable database: " + e.message); process.exit(1); }

if (incoming.products === null) {
  console.error("\nThat file has no products table — it is not a Shop Manager backup.");
  process.exit(1);
}

const current = fs.existsSync(LIVE) ? inspect(LIVE) : null;

const row = (label, a, b) =>
  `  ${label.padEnd(11)} ${String(a === null ? "-" : a).padStart(7)}   ${String(b === null ? "-" : b).padStart(7)}`;

console.log(`\n  Restoring: ${path.basename(src)}\n`);
console.log("                 ON THIS PC   IN THE BACKUP");
["products", "customers", "invoices", "items", "purchases", "suppliers"].forEach(k =>
  console.log(row(k, current ? current[k] : null, incoming[k])));
console.log(`\n  shop name: ${incoming.shop || "(not set)"}\n`);

/* Refuse quietly-destructive restores. Replacing a database that holds more
   than the backup does is how a week's billing disappears — it may still be
   what the shop wants, but not without saying so. */
const losing = current && (current.invoices || 0) > (incoming.invoices || 0);
if (losing && process.argv[3] !== "--yes-i-mean-it") {
  console.error(`  REFUSED: this PC has ${current.invoices} invoice(s), the backup has ${incoming.invoices}.`);
  console.error("  Restoring would lose the difference.\n");
  console.error("  If that is genuinely what you want, run it again with --yes-i-mean-it\n");
  process.exit(1);
}

// Keep what is there now, named so it is obvious what it was.
if (fs.existsSync(LIVE)) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const kept = path.join(DATA_DIR, "backups", `before-restore-${stamp}.db`);
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.copyFileSync(LIVE, kept);
  console.log(`  kept what was here: ${path.relative(DATA_DIR, kept)}`);
}

// WAL and SHM belong to the old database; leaving them behind corrupts the new one.
for (const ext of ["-wal", "-shm"]) {
  const f = LIVE + ext;
  if (fs.existsSync(f)) fs.rmSync(f);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.copyFileSync(src, LIVE);

const check = inspect(LIVE);
console.log(`  restored: ${check.invoices} invoice(s), ${check.customers} customer(s), ${check.products} product(s)`);
console.log("\n  Start the app again:  pm2 start server/index.js --name shop-manager\n");
