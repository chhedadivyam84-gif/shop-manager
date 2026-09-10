/* ============================================================
   Proves the node:sqlite -> Durable Object SQL shim is faithful.

   WHY IT DOES NOT USE THE WORKERS RUNTIME

   Installing @cloudflare/vitest-pool-workers to assert that binding
   order is preserved would cost minutes of install on a two-core
   machine and prove the same thing. The Durable Object SQL API is
   small — exec(sql, ...bindings) returning a cursor — so this
   emulates it on node:sqlite and runs the shim against it. What is
   under test is the shim's own logic: named-parameter translation,
   result shapes, quote safety, transaction rollback. None of that
   depends on which SQLite is underneath.

   The real runtime still has to be exercised before cutover. This
   catches the errors that would otherwise be found there.
   ============================================================ */
import { DatabaseSync } from "node:sqlite";
import { createDb, compile } from "../src/sqlite-shim.js";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? "   -> " + extra : ""}`); }
};

/* ---------- emulate a Durable Object's ctx.storage ---------- */
function makeCtx() {
  const nodeDb = new DatabaseSync(":memory:");
  const sql = {
    exec(text, ...bindings) {
      const isRead = /^\s*(SELECT|PRAGMA|WITH)/i.test(text);
      const isBatch = bindings.length === 0 && /;\s*\S/.test(text);

      if (isBatch) { nodeDb.exec(text); return { toArray: () => [], rowsWritten: 0 }; }

      const stmt = nodeDb.prepare(text);
      if (isRead) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = stmt.run(...bindings);
      return { toArray: () => [], rowsWritten: Number(info.changes || 0) };
    },
  };
  return {
    storage: {
      sql,
      /* transactionSync rolls back if the callback throws — the same
         contract the app's existing db.transaction shim provides. */
      transactionSync(fn) {
        nodeDb.exec("BEGIN");
        try { const r = fn(); nodeDb.exec("COMMIT"); return r; }
        catch (e) { nodeDb.exec("ROLLBACK"); throw e; }
      },
    },
  };
}

const ctx = makeCtx();
const db = createDb(ctx);

/* ================= 1. the translator in isolation ================= */
console.log("\nNAMED PARAMETER TRANSLATION");
{
  const c = compile("UPDATE t SET a=@alpha, b=@beta WHERE id=@id");
  ok("rewrites every @name to ?", c.text === "UPDATE t SET a=?, b=? WHERE id=?", c.text);
  ok("records names in order", c.names.join(",") === "alpha,beta,id", c.names.join(","));
}
{
  /* A remark containing an email address must not be rewritten. This is
     the bug a regex-based translator would ship. */
  const c = compile("INSERT INTO notes (body, who) VALUES ('mail me at a@b.com', @who)");
  ok("leaves @ inside a string literal alone", c.names.length === 1 && c.names[0] === "who",
     JSON.stringify(c.names));
  ok("only one ? produced", (c.text.match(/\?/g) || []).length === 1, c.text);
}
{
  const c = compile("SELECT * FROM t WHERE a=@x OR b=@x");
  ok("a repeated name binds twice", c.names.length === 2, c.names.join(","));
}

/* ================= 2. positional path (the other 1,308 calls) ================= */
console.log("\nPOSITIONAL BINDING");
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, active INTEGER);`);
{
  const r = db.prepare("INSERT INTO customers (name, active) VALUES (?, ?)").run("Swagat Ply", true);
  ok("run() reports changes", r.changes === 1, r.changes);
  ok("run() reports lastInsertRowid", r.lastInsertRowid === 1, r.lastInsertRowid);
  ok("boolean coerced to 1", db.prepare("SELECT active FROM customers WHERE id=?").get(1).active === 1);

  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(1);
  ok("get() returns the row", row && row.name === "Swagat Ply", row && row.name);
  ok("get() on no match is undefined",
     db.prepare("SELECT * FROM customers WHERE id = ?").get(999) === undefined);
  ok("all() returns an array", Array.isArray(db.prepare("SELECT * FROM customers").all()));

  db.prepare("INSERT INTO customers (name, active) VALUES (?, ?)").run("Second", undefined);
  ok("undefined coerced to NULL",
     db.prepare("SELECT active FROM customers WHERE id=?").get(2).active === null);
}

/* ================= 2b. THE CONDITIONAL-FILTER CASE ================= */
console.log("\nA STATEMENT WITH NO PLACEHOLDERS, CALLED WITH AN OBJECT");
{
  /* routes/productQuery.js collects filters into `params` as it goes and
     always calls .all(params). With no filters the SQL has no placeholders
     at all — but an object is still passed. Binding it positionally gives
     "Wrong number of parameter bindings", which is how this reached
     production before being caught. */
  let threw = null;
  let rows = null;
  try { rows = db.prepare("SELECT * FROM customers").all({}); }
  catch (e) { threw = e.message; }
  ok("empty object against a no-placeholder statement", threw === null, threw);
  ok("and it still returns rows", Array.isArray(rows), rows && rows.length);

  /* The same statement with a populated object it does not need. */
  let threw2 = null;
  try { db.prepare("SELECT COUNT(*) AS n FROM customers").get({ unused: "x", other: 1 }); }
  catch (e) { threw2 = e.message; }
  ok("populated object with nothing to bind", threw2 === null, threw2);

  /* And a partially-used object still binds only what the SQL names. */
  const one = db.prepare("SELECT * FROM customers WHERE name = @name")
    .all({ name: "Swagat Ply", spare: "ignored" });
  ok("extra keys are ignored, named key binds", one.length === 1, one.length);
}

/* ================= 3. THE REAL STATEMENT ================= */
console.log("\nREAL invoices UPDATE (33 named parameters, verbatim from routes/invoices.js)");
db.exec(`CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, subtotal REAL, discount_type TEXT,
  discount_value REAL, discount_amount REAL, tax_type TEXT, cgst REAL, sgst REAL, igst REAL,
  transport REAL, loading REAL, gst_on_charges INTEGER, gst_enabled INTEGER, einvoice_wanted INTEGER,
  ewb_wanted INTEGER, round_off REAL, total REAL, advance REAL, balance_due REAL,
  payment_method TEXT, paper_size TEXT, delivery_man TEXT, vehicle_number TEXT, delivery_address TEXT,
  due_date TEXT, transport_mode TEXT, remarks TEXT, location_id INTEGER, area_id INTEGER,
  date TEXT, updated_by TEXT, updated_at TEXT
);`);
db.prepare("INSERT INTO invoices (id, total) VALUES (?, ?)").run(1, 0);

const REAL_UPDATE = `
      UPDATE invoices SET customer_id=@customerId, subtotal=@subtotal, discount_type=@discountType,
        discount_value=@discountValue, discount_amount=@discountAmount, tax_type=@taxType,
        cgst=@cgst, sgst=@sgst, igst=@igst, transport=@transport, loading=@loading,
        gst_on_charges=@gstOnCharges, gst_enabled=@gstEnabled, einvoice_wanted=@einvoiceWanted, ewb_wanted=@ewbWanted,
        round_off=@roundOffAmount, total=@total, advance=@advance,
        balance_due=@balanceDue, payment_method=@paymentMethod, paper_size=@paperSize,
        delivery_man=@deliveryMan, vehicle_number=@vehicleNumber, delivery_address=@deliveryAddress,
        due_date=@dueDate, transport_mode=@transportMode,
        remarks=@remarks, location_id=@locationId, area_id=@areaId, date=@date,
        updated_by=@updatedBy, updated_at=@updatedAt
      WHERE id=@id`;

{
  const c = compile(REAL_UPDATE);
  ok("all 33 parameters found", c.names.length === 33, c.names.length);
  ok("no @ left in the rewritten SQL", !c.text.includes("@"));
  ok("id is bound LAST (the WHERE clause)", c.names[c.names.length - 1] === "id", c.names.at(-1));
}

/* Distinct values per field, so a one-position shift cannot pass. */
const params = {
  customerId: 7, subtotal: 1000.5, discountType: "percent", discountValue: 5, discountAmount: 50.03,
  taxType: "gst", cgst: 45.01, sgst: 45.02, igst: 0, transport: 120.04, loading: 60.05,
  gstOnCharges: 1, gstEnabled: 1, einvoiceWanted: 0, ewbWanted: 1, roundOffAmount: 0.4,
  total: 1221.06, advance: 200.07, balanceDue: 1021.08, paymentMethod: "cash", paperSize: "A4",
  deliveryMan: "Ramesh", vehicleNumber: "MH-02-AB-1234", deliveryAddress: "Malad West",
  dueDate: "2026-10-01", transportMode: "road", remarks: "ping me at ops@swagat.example",
  locationId: 3, areaId: 9, date: "2026-09-10", updatedBy: "Owner", updatedAt: "2026-09-10T12:00:00Z",
  id: 1,
};

{
  const r = db.prepare(REAL_UPDATE).run(params);
  ok("the UPDATE applied to exactly one row", r.changes === 1, r.changes);

  const row = db.prepare("SELECT * FROM invoices WHERE id=?").get(1);
  const checks = [
    ["customer_id", 7], ["subtotal", 1000.5], ["discount_type", "percent"],
    ["discount_amount", 50.03], ["cgst", 45.01], ["sgst", 45.02],
    ["transport", 120.04], ["loading", 60.05], ["total", 1221.06],
    ["advance", 200.07], ["balance_due", 1021.08], ["payment_method", "cash"],
    ["delivery_man", "Ramesh"], ["vehicle_number", "MH-02-AB-1234"],
    ["location_id", 3], ["area_id", 9], ["updated_by", "Owner"],
  ];
  let bad = [];
  for (const [col, want] of checks) if (row[col] !== want) bad.push(`${col}=${row[col]} want ${want}`);
  ok("every column received its OWN value (no shift)", bad.length === 0, bad.join(" | "));

  /* The value itself contains an @ — the exact case the walker exists for. */
  ok("an @ inside a bound VALUE survives",
     row.remarks === "ping me at ops@swagat.example", row.remarks);
}

/* ================= 4. transactions ================= */
console.log("\nTRANSACTIONS");
{
  const addTwo = db.transaction(() => {
    db.prepare("INSERT INTO customers (name) VALUES (?)").run("T1");
    db.prepare("INSERT INTO customers (name) VALUES (?)").run("T2");
  });
  addTwo();
  ok("commits both rows", db.prepare("SELECT COUNT(*) n FROM customers").get().n === 4);

  const before = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  const boom = db.transaction(() => {
    db.prepare("INSERT INTO customers (name) VALUES (?)").run("T3");
    throw new Error("bill cancelled halfway");
  });
  let threw = false;
  try { boom(); } catch { threw = true; }
  ok("rethrows the error", threw);
  ok("rolls the partial write back",
     db.prepare("SELECT COUNT(*) n FROM customers").get().n === before);
}

/* ================= 5. guardrails ================= */
console.log("\nGUARDRAILS");
{
  let threw = false;
  try { db.exec("BEGIN"); } catch { threw = true; }
  ok("raw BEGIN is refused with guidance", threw);
  let fine = true;
  try { db.exec("PRAGMA journal_mode = WAL"); } catch { fine = false; }
  ok("file-only PRAGMA is absorbed, not thrown", fine);
}

console.log(`\n${fail ? fail + " CHECK(S) FAILED" : "ALL " + pass + " CHECKS PASSED"}\n`);
process.exitCode = fail ? 1 : 0;
