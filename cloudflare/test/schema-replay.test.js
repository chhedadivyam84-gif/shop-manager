/* ============================================================
   Replays the REAL production schema through the shim.

   The previous test proves the shim's semantics on hand-written SQL.
   This one proves it against the thing that actually matters: all 93
   tables, their indexes and triggers, exactly as they exist in the
   live shop database — pushed through db.exec() the same way
   db-schema.js pushes them at boot.

   It reads data/shop.db READ-ONLY and never writes to it.
   ============================================================ */
import { DatabaseSync } from "node:sqlite";
import { createDb } from "../src/sqlite-shim.js";
import { makeCtx } from "./fake-do.js";

const LIVE = "C:/Users/prafu/shop-manager/data/shop.db";

let pass = 0, fail = 0;
const ok = (l, c, x) => {
  if (c) { pass++; console.log(`  ok    ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${x !== undefined ? "   -> " + x : ""}`); }
};

/* ---------- read the real schema, without touching the file ---------- */
const live = new DatabaseSync(LIVE, { readOnly: true });
const objects = live
  .prepare(`SELECT type, name, sql FROM sqlite_master
            WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
            ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`)
  .all();

const liveTables = objects.filter((o) => o.type === "table").length;
const liveIndexes = objects.filter((o) => o.type === "index").length;
const liveTriggers = objects.filter((o) => o.type === "trigger").length;

console.log(`\nLIVE SCHEMA: ${liveTables} tables, ${liveIndexes} indexes, ${liveTriggers} triggers`);

/* ---------- replay every one of them through the shim ---------- */
console.log("\nREPLAY THROUGH THE SHIM");
const ctx = makeCtx();
const db = createDb(ctx);

const failures = [];
for (const o of objects) {
  try { db.exec(o.sql + ";"); }
  catch (e) { failures.push(`${o.type} ${o.name}: ${e.message}`); }
}
ok(`every object created (${objects.length} total)`, failures.length === 0,
   failures.slice(0, 3).join(" | "));

const got = ctx._raw
  .prepare("SELECT type, COUNT(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type")
  .all();
const gotTables = (got.find((g) => g.type === "table") || {}).n || 0;
const gotIndexes = (got.find((g) => g.type === "index") || {}).n || 0;

ok(`all ${liveTables} tables landed`, gotTables === liveTables, gotTables);
ok(`all ${liveIndexes} indexes landed`, gotIndexes === liveIndexes, gotIndexes);

/* ---------- now run REAL queries the routes actually issue ---------- */
console.log("\nREAL QUERIES AGAINST THE REPLAYED SCHEMA");
{
  /* Straight from routes/customers.js */
  const r1 = db.prepare("SELECT * FROM customers ORDER BY name ASC").all();
  ok("customers list query runs", Array.isArray(r1));

  /* A join across the invoice path — the shape reports.js leans on */
  const r2 = db.prepare(`
    SELECT i.id, i.total, c.name AS customer
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.date BETWEEN ? AND ?
    ORDER BY i.id DESC`).all("2026-04-01", "2027-03-31");
  ok("invoice/customer join runs", Array.isArray(r2));

  /* Aggregation, the kind reports.js is full of */
  const r3 = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS sales, COUNT(*) AS bills
    FROM invoices WHERE date >= ?`).get("2026-04-01");
  ok("aggregate returns a row with defaults", r3 && r3.sales === 0 && r3.bills === 0,
     JSON.stringify(r3));

  /* The permissions table the whole product depends on */
  const r4 = db.prepare(
    "SELECT * FROM staff_permissions WHERE staff_id = ? AND module = ?").get("STAFF_owner", "employee");
  ok("permission lookup runs (row may be absent)", r4 === undefined || typeof r4 === "object");

  /* PRAGMA table_info is used by the addColumn migration helper */
  const cols = db.prepare("PRAGMA table_info(invoices)").all();
  ok("PRAGMA table_info works (migrations depend on it)", cols.length > 0, cols.length);
}

/* ---------- writes into the replayed schema, inside a transaction ---------- */
console.log("\nWRITE PATH ON THE REAL SCHEMA");
{
  /* created_at is NOT NULL with no default — the real table demands it.
     Supplying it is the point: the shim must carry every bound field of a
     real insert, not a convenient subset. */
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO customers (name, phone, created_at)
                VALUES (@name, @phone, @createdAt)`)
      .run({ name: "Test Traders", phone: "9999999999", createdAt: Date.now() });
  });
  let threw = null;
  try { insert(); } catch (e) { threw = e.message; }
  ok("named-param INSERT into the real customers table", threw === null, threw);

  const back = db.prepare("SELECT name, phone FROM customers WHERE name = ?").get("Test Traders");
  ok("row reads back with both fields correct",
     back && back.name === "Test Traders" && back.phone === "9999999999", JSON.stringify(back));
}

live.close();
console.log(`\n${fail ? fail + " CHECK(S) FAILED" : "ALL " + pass + " CHECKS PASSED"}\n`);
process.exitCode = fail ? 1 : 0;
