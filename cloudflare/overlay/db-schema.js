/* The Durable Object builds its own schema in its constructor from
   src/schema.js, so nothing here opens a database file. This exists only
   because db.js and tenants.js import it. */
const DATA_DIR = "/durable-object";

function openCompanyDb() {
  throw new Error(
    "openCompanyDb() has no meaning on Workers: a shop's database is its " +
    "Durable Object's storage, not a file that can be opened."
  );
}

module.exports = { openCompanyDb, DATA_DIR };
