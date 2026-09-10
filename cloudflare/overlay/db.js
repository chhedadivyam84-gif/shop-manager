/* ============================================================
   db, for Workers — the same object 76 modules already import

   Every route does `const db = require("../db")` at load time and then
   `db.prepare(...)` at request time. On Render that resolves to a
   SQLite file. Here it has to resolve to the Durable Object handling
   the request in flight.

   WHY AsyncLocalStorage, AGAIN

   The original server/db.js uses AsyncLocalStorage and explains why: a
   module-level "current company" would be read AFTER an await, by which
   time another request could have changed it — two shops, and one of
   them silently reads the other's data.

   That argument gets STRONGER on Workers, not weaker. Several Durable
   Objects can share one isolate, so a module-level variable here is
   shared between tenants of different businesses. The same mechanism
   solves it, so the same mechanism is used.

   The proxy is what lets 1,313 call sites stay untouched.
   ============================================================ */
const runtime = require("./_runtime");

function current() {
  return runtime.db();
}

/* Forwards everything to whichever tenant's database belongs to the
   request in flight. Methods are bound so `this` stays correct. */
const db = new Proxy(Object.create(null), {
  get(_target, prop) {
    if (prop === "__runtime") return runtime;

    /* One installation now serves one shop per Durable Object, so the
       multi-company switch that server/db.js provides is structural
       rather than a runtime lookup. Anything still calling it should say
       so plainly instead of quietly operating on the wrong shop. */
    if (prop === "companies") {
      /* One shop is one Durable Object, so there is exactly one company and
         it is already selected. Presenting that coherently — rather than
         throwing — is what lets routes/businesses.js run: it does
         C.runAs(C.defaultId(), ...) and expects a real id back. Switching
         to any OTHER company still refuses, because that genuinely cannot
         be honoured from inside this object. */
      const id = () => runtime.tenant();
      return {
        defaultId: id,
        currentId: id,
        current: () => ({ id: id(), name: id() }),
        list: () => [{ id: id(), name: id() }],
        runAs(which, fn) {
          if (which && which !== id()) {
            throw new Error(
              `Cannot switch to company "${which}": one shop is one Durable ` +
              "Object, chosen by the request's tenant."
            );
          }
          return fn();
        },
      };
    }

    const value = current()[prop];
    return typeof value === "function" ? value.bind(current()) : value;
  },

  has(_t, prop) { return prop in current(); },
  ownKeys() { return Reflect.ownKeys(current()); },
  getOwnPropertyDescriptor(_t, prop) {
    return { value: current()[prop], enumerable: true, configurable: true };
  },
});

module.exports = db;
