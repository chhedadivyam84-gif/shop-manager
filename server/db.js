/* ============================================================
   MULTI-COMPANY DATABASE

   One SQLite file per company, under data/companies/<id>/shop.db.

   Isolation is PHYSICAL, not a filter. Company B's rows are not in Company A's
   file, so no query can return them — there is no `WHERE company_id = ?` to
   forget on one of 863 statements. That was the deciding argument for this
   design over a company_id column.

   Every route still does `db.prepare(...)` exactly as before. `db` is a proxy
   that forwards to whichever company's connection belongs to the request in
   flight, so none of the 40 route files changed.

   WHY AsyncLocalStorage and not a module-level "current company":
   a plain variable would be read AFTER an await, by which time another
   request could have changed it — two staff on two companies, and one of them
   silently reads the other's data. That is precisely the leak this design
   exists to prevent, so the company travels with the request instead.
   ============================================================ */
const path = require("path");
const fs = require("fs");
const { AsyncLocalStorage } = require("node:async_hooks");
const { openCompanyDb, DATA_DIR } = require("./db-schema");

const COMPANIES_DIR = path.join(DATA_DIR, "companies");
const REGISTRY = path.join(DATA_DIR, "companies.json");

/* The registry lives OUTSIDE every company file: it is the one thing shared,
   and keeping it out means no company's database knows the others exist. */
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, "utf8")); }
  catch { return { companies: [], defaultId: null }; }
}
function writeRegistry(reg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

/* The FIRST business keeps the file it has always had, exactly where it is:
   data/shop.db. It is not moved, copied or migrated — going multi-business
   does not touch a single byte of an existing shop's data, so there is no
   migration that can half-succeed and no window where billing is at risk.
   Only NEW businesses get a folder of their own. */
const LEGACY_ID = "company-1";
function companyFile(id) {
  return id === LEGACY_ID
    ? path.join(DATA_DIR, "shop.db")
    : path.join(COMPANIES_DIR, id, "shop.db");
}

/* Connections are cached: opening SQLite per request would be wasteful, and
   node:sqlite handles are safe to keep. */
const pool = new Map();
function connectionFor(id) {
  if (!pool.has(id)) {
    const file = companyFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    pool.set(id, openCompanyDb(file));   // builds the schema if the file is new
  }
  return pool.get(id);
}

/* ---------------------------------------------------------- first run

   An install that has never seen this code has data/shop.db sitting where it
   always did. That file IS the existing business, so it is adopted in place —
   no move, no copy, no row migration, so there is nothing that can half-
   succeed and no window in which billing is at risk. */
function ensureFirstCompany() {
  const reg = readRegistry();
  if (reg.companies.length) return reg;

  /* Adopt whatever is already on disk. No file operations at all: the
     existing database simply becomes business 1 where it lies. */
  let name = "My Shop";
  try {
    const conn = connectionFor(LEGACY_ID);
    const s = conn.prepare("SELECT business_name FROM settings WHERE id = 1").get();
    if (s && s.business_name) name = s.business_name;
  } catch { /* a brand-new install names itself below */ }

  reg.companies = [{ id: LEGACY_ID, name, active: 1, createdAt: Date.now() }];
  reg.defaultId = LEGACY_ID;
  writeRegistry(reg);
  return reg;
}
const registry = ensureFirstCompany();

/* ---------------------------------------------------------- request scope */
const scope = new AsyncLocalStorage();

/** Runs `fn` with every db call inside it bound to this company. */
function runAsCompany(companyId, fn) {
  return scope.run({ companyId }, fn);
}
function currentCompanyId() {
  const store = scope.getStore();
  return (store && store.companyId) || readRegistry().defaultId || "company-1";
}
function activeConnection() {
  return connectionFor(currentCompanyId());
}

/* ---------------------------------------------------------- the proxy

   Forwards the whole handle — prepare, exec, transaction, dataDir, file — to
   the connection for the request in flight. Methods are bound so `this` stays
   the real connection. */
const db = new Proxy({}, {
  get(_t, prop) {
    const conn = activeConnection();
    const value = conn[prop];
    return typeof value === "function" ? value.bind(conn) : value;
  },
  set(_t, prop, value) { activeConnection()[prop] = value; return true; }
});

/* ---------------------------------------------------------- companies API */
function listCompanies() {
  return readRegistry().companies.slice();
}
function getCompany(id) {
  return readRegistry().companies.find(c => c.id === id) || null;
}
function defaultCompanyId() {
  return readRegistry().defaultId;
}

/** A new company is an empty file with the schema applied — nothing copied. */
function createCompany({ name }) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("Give the company a name.");
  const reg = readRegistry();
  if (reg.companies.some(c => c.name.toLowerCase() === clean.toLowerCase()))
    throw new Error(`There is already a company called "${clean}".`);

  const id = "company-" + (Date.now().toString(36));
  connectionFor(id);                       // creates the file and its schema
  const conn = connectionFor(id);
  conn.prepare("UPDATE settings SET business_name = ? WHERE id = 1").run(clean);

  reg.companies.push({ id, name: clean, active: 1, createdAt: Date.now() });
  if (!reg.defaultId) reg.defaultId = id;
  writeRegistry(reg);
  return { id, name: clean, active: 1 };
}

function updateCompany(id, { name, active }) {
  const reg = readRegistry();
  const c = reg.companies.find(x => x.id === id);
  if (!c) throw new Error("No such company.");
  if (name != null && String(name).trim()) {
    c.name = String(name).trim();
    connectionFor(id).prepare("UPDATE settings SET business_name = ? WHERE id = 1").run(c.name);
  }
  if (active != null) {
    // The last active company may not be switched off — there would be
    // nowhere to log in to.
    const others = reg.companies.filter(x => x.id !== id && x.active);
    if (!active && !others.length) throw new Error("This is the only active company.");
    c.active = active ? 1 : 0;
  }
  writeRegistry(reg);
  return c;
}

module.exports = db;
module.exports.companies = {
  list: listCompanies, get: getCompany, create: createCompany,
  update: updateCompany, defaultId: defaultCompanyId,
  runAs: runAsCompany, currentId: currentCompanyId, file: companyFile
};
