/* Which shop is signing in.

   On Render one installation serves many shops from one process, so this
   module maps a login to a database file. Here the shop is decided before
   any code runs — it is which Durable Object the request reached — so the
   map has nothing to map.

   multiTenant() returning false is what makes the login screen go straight
   to the staff picker instead of asking which shop first. */
const noTenant = () => null;

module.exports = {
  open: () => {},
  get: noTenant,
  list: () => [],
  count: () => 0,
  upsert: () => { throw new Error("tenants.upsert: shops are provisioned per Durable Object"); },
  touch: () => {},
  block: () => {},
  verify: () => false,
  hash: (s) => String(s),
  multiTenant: () => false,
  norm: (s) => String(s || "").trim().toLowerCase(),
  file: noTenant,
  snapshotTo: () => { throw new Error("tenants.snapshotTo: no filesystem"); },
  restoreFrom: () => { throw new Error("tenants.restoreFrom: no filesystem"); },
  declared: () => false,
};
