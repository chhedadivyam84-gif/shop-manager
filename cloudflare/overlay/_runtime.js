/* ============================================================
   THE REQUEST'S RUNTIME, carried the way server/db.js carries a company.

   Overlay modules need more than the database: backup needs the R2
   bucket, and anything tenant-aware needs to know which shop. Putting
   those in a module-level variable would be wrong for exactly the reason
   server/db.js gives about companies — several Durable Objects can share
   one isolate, so a module-level value is shared between businesses.

   So the whole runtime travels with the request instead.
   ============================================================ */
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

function get() {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "Runtime used outside a request. Route code must run inside " +
      "runtime.run(), which the Durable Object sets up per request."
    );
  }
  return ctx;
}

/* ctx is { db, self, env, tenant } — the shim database, the Durable
   Object instance, its bindings, and the shop's name. */
module.exports = {
  storage,
  run: (ctx, fn) => storage.run(ctx, fn),
  get,
  db: () => get().db,
  self: () => get().self,
  env: () => get().env,
  tenant: () => get().tenant,
};
