#!/usr/bin/env node
/* ============================================================
   A THROWAWAY COPY OF THE APP, FOR LOOKING AT

   Starts Shop Manager on its own port against its own scratch database,
   seeded with a few products across several companies. Nothing here touches
   the shop's real data or the pm2 instance on port 3000 — DATA_DIR is
   redirected before the app is loaded, so it opens a database that did not
   exist a moment ago.

       node tools/dev-preview.js

   Safe to delete the folder it prints; safe to run twice.
   ============================================================ */
const os = require("os");
const fs = require("fs");
const path = require("path");

process.chdir(path.join(__dirname, ".."));   // the app reads a few paths from cwd

const DIR = path.join(os.tmpdir(), "shop-manager-preview");
fs.mkdirSync(DIR, { recursive: true });

process.env.DATA_DIR = DIR;
process.env.PORT = process.env.PORT || "3399";
// Never let a preview reach the real backup bucket.
delete process.env.R2_ACCOUNT_ID;
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_KEY;

console.log("[preview] scratch data dir: " + DIR);

const db = require("../server/db");

/* Seed once. A second run reuses whatever the first left behind, so the
   preview keeps its state while a change is being looked at. */
const seeded = db.prepare("SELECT COUNT(*) n FROM products").get().n;
if (!seeded) {
  const now = Date.now();
  db.prepare("INSERT INTO suppliers (id, name, phone, created_at) VALUES (?,?,?,?)")
    .run("SUP-PREVIEW", "Rajesh Timber", "9820011223", now);

  const rows = [
    ["PV1", "18mm Plywood", "Swagat", 1250],
    ["PV2", "12mm Plywood", "Swagat", 950],
    ["PV3", "6mm Plywood", "Swagat", 540],
    ["PV4", "18mm Plywood", "Maharashtra", 1180],
    ["PV5", "12mm Plywood", "Maharashtra", 890],
    ["PV6", "18mm Plywood", "Ganga", 1300],
    ["PV7", "6mm Plywood", "Ganga", 520],
    ["PV8", "19mm Block Board", "Century", 1650]
  ];
  for (const [id, name, brand, price] of rows) {
    db.prepare(`INSERT INTO products (id, name, brand, category, sku, unit, gst_rate, stock, created_at, default_mode)
                VALUES (?,?,?,'Plywood',?,'Sheet',18,100,?,'UNIT')`).run(id, name, brand, "SKU-" + id, now);
    db.prepare("INSERT INTO product_sizes (product_id, label, price, stock, sort_order) VALUES (?,?,?,100,0)")
      .run(id, "8x4", price);
  }

  /* Parties and a sales order, so the against-customer side of a purchase
     order has something real to point at. */
  for (const [id, name] of [["CUST-A","ABC Traders"],["CUST-B","XYZ Traders"],["CUST-C","Royal Traders"]]) {
    db.prepare("INSERT INTO customers (id,name,phone,created_at) VALUES (?,?,?,?)")
      .run(id, name, "98200" + id.slice(-1).charCodeAt(0) + "1122", now);
  }
  db.prepare(`INSERT INTO sales_orders (id,so_no,date,created_at,customer_id,sale_type,tax_type,total,status)
              VALUES ('SO-PREVIEW','SO0000542',date('now'),?,'CUST-A','Local','CGST_SGST',25000,'Confirmed')`).run(now);
  db.prepare(`INSERT INTO sales_order_items (so_id,product_id,size_id,name,brand,mode,size_label,pieces,per_piece,unit_label,qty,rate)
              VALUES ('SO-PREVIEW','PV1',(SELECT id FROM product_sizes WHERE product_id='PV1'),
                      '18mm Plywood','Swagat','UNIT','8x4',20,1,'Sheet',20,1250)`).run();
  console.log("[preview] seeded 3 parties and sales order SO0000542");
  console.log(`[preview] seeded ${rows.length} products across 4 companies`);
}

require("../server/index.js");
