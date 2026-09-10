/* A stand-in for a Durable Object's ctx.storage, backed by node:sqlite.

   The DO SQL API is small — exec(sql, ...bindings) returning a cursor
   with toArray() and rowsWritten, plus transactionSync. Emulating it
   lets the shim be exercised against the real schema in milliseconds
   instead of minutes of Workers-runtime install. */
import { DatabaseSync } from "node:sqlite";

export function makeCtx(file = ":memory:") {
  const nodeDb = new DatabaseSync(file);
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
    _raw: nodeDb,
    storage: {
      sql,
      transactionSync(fn) {
        nodeDb.exec("BEGIN");
        try { const r = fn(); nodeDb.exec("COMMIT"); return r; }
        catch (e) { nodeDb.exec("ROLLBACK"); throw e; }
      },
    },
  };
}
