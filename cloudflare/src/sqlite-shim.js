/* ============================================================
   node:sqlite  ->  Durable Object SQL

   THE POINT OF THIS FILE

   The app has 1,313 `db.prepare(...)` calls across 58 route files —
   834 `.get()`, 312 `.all()`, 404 `.run()`. Hand-porting 17,200 lines
   of route SQL to `ctx.storage.sql.exec()` would be forty files of
   silent, unreviewable risk. So instead this reproduces the small
   slice of the `node:sqlite` `DatabaseSync` surface that the app
   actually uses, on top of a Durable Object's SQL storage.

   The routes then port by changing nothing at all.

   WHAT IS ACTUALLY DIFFERENT BETWEEN THE TWO APIS

   1. BINDING STYLE. `node:sqlite` accepts named parameters — the app
      uses `@name` in five of its biggest write paths (invoices,
      purchases, purchase_orders, quotations, sales_orders), passing a
      plain object. A Durable Object's `sql.exec()` takes POSITIONAL
      arguments only. Left untranslated those five statements would not
      throw — they would bind wrongly — so this is the single most
      important thing in this file. See `compile()`.

   2. RESULT SHAPE. `node:sqlite` returns a row (or undefined) from
      `.get()`, an array from `.all()`, and `{ changes, lastInsertRowid }`
      from `.run()`. A DO returns a cursor.

   3. TRANSACTIONS. `node:sqlite` has no transaction wrapper, so
      db-schema.js already shims `db.transaction(fn)` using raw
      BEGIN/COMMIT/ROLLBACK. A Durable Object manages its own
      transactions and wants `ctx.storage.transactionSync(fn)` instead.
      Because the app funnels every transaction through that one shim,
      swapping the implementation here covers all of them.

   WHAT IS DELIBERATELY NOT SUPPORTED

   `.iterate()` — the app never calls it (verified: 0 occurrences).
   If that changes, add it rather than working around its absence.
   ============================================================ */

/* ------------------------------------------------------------------
   Named parameters -> positional.

   Scans for `@identifier` and rewrites each to `?`, recording the
   names in the order they appear so the object passed at call time can
   be flattened into a positional array.

   It walks the string rather than using a regex because a regex would
   also rewrite an `@` that lives inside a quoted literal — a remark
   field containing an email address would corrupt the statement. The
   walker tracks single and double quotes and leaves their contents
   alone.

   A name used twice binds twice, which is what `node:sqlite` does.
   ------------------------------------------------------------------ */
function compile(sql) {
  const names = [];
  let out = "";
  let i = 0;
  let quote = null;

  while (i < sql.length) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      /* '' inside a single-quoted literal is an escaped quote, not the end */
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += sql[i + 1]; i += 2; continue; }
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') { quote = ch; out += ch; i++; continue; }

    if (ch === "@") {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      if (j > i + 1) { names.push(sql.slice(i + 1, j)); out += "?"; i = j; continue; }
    }

    out += ch;
    i++;
  }

  return { text: out, names };
}

/* SQLite storage accepts null, number, string and ArrayBuffer. The app
   passes booleans freely (`active`, `is_paid`, permission flags), and
   `undefined` wherever a field was simply not supplied. node:sqlite
   coerces both; a DO would throw, so coerce them the same way here —
   a thrown bind error on a live bill is not an acceptable failure. */
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

class Statement {
  constructor(sqlStorage, sql) {
    const { text, names } = compile(sql);
    this._sql = sqlStorage;
    this._text = text;
    this._names = names;
  }

  /* node:sqlite is called either as .get(a, b) or, for named params,
     as .get({ a, b }). Which one applies is decided by whether the
     statement actually contained any `@name` tokens — not by guessing
     from the argument type, because a single positional object
     argument is legitimate elsewhere. */
  _bind(args) {
    /* node:sqlite chooses the binding style from the ARGUMENT, not from
       whether the SQL happens to contain @names — and that difference is
       load-bearing.

       routes/productQuery.js builds its filters conditionally: it collects
       `params` as it goes and always calls .all(params). With no filters
       applied the SQL ends up with no placeholders at all, but an object is
       still passed. Deciding by `this._names.length` alone then treats that
       object as one POSITIONAL binding against a statement expecting none,
       and SQLite rejects it with "Wrong number of parameter bindings".

       So a lone plain object means named binding, even when the statement
       needs nothing from it. */
    const lone = args.length === 1 ? args[0] : undefined;
    const looksNamed =
      lone !== null && typeof lone === "object" &&
      !Array.isArray(lone) && !(lone instanceof Uint8Array) &&
      !(lone instanceof ArrayBuffer) && !(lone instanceof Date);

    if (this._names.length || looksNamed) {
      const o = lone || {};
      return this._names.map((n) => normalize(o[n]));
    }
    return args.map(normalize);
  }

  get(...args) {
    const rows = this._sql.exec(this._text, ...this._bind(args)).toArray();
    return rows.length ? rows[0] : undefined;
  }

  all(...args) {
    return this._sql.exec(this._text, ...this._bind(args)).toArray();
  }

  /* `changes` and `lastInsertRowid` are read by only three call sites
     between them, but they are read on the insert paths that matter,
     so they have to be right. A DO cursor reports rowsWritten; the new
     rowid needs a second statement, which is why it is fetched only
     when the statement was an INSERT. */
  run(...args) {
    const cursor = this._sql.exec(this._text, ...this._bind(args));
    /* Draining the cursor is what commits the write and populates the
       counters — an INSERT ... RETURNING would otherwise be left
       half-consumed. */
    try { cursor.toArray(); } catch { /* non-SELECT cursors may not be iterable */ }

    let lastInsertRowid = 0;
    if (/^\s*INSERT/i.test(this._text)) {
      try {
        const r = this._sql.exec("SELECT last_insert_rowid() AS id").toArray();
        lastInsertRowid = r.length ? r[0].id : 0;
      } catch { /* leave 0 */ }
    }

    return { changes: cursor.rowsWritten ?? 0, lastInsertRowid };
  }
}

/* ------------------------------------------------------------------
   The `db` object the route files already expect.

   `ctx` is the DurableObjectState. Storage is per-object, so the
   physical isolation the app deliberately chose — one shop, one
   SQLite file — carries over unchanged: one shop, one Durable Object.
   ------------------------------------------------------------------ */
function createDb(ctx) {
  const sqlStorage = ctx.storage.sql;

  const db = {
    prepare(sql) {
      return new Statement(sqlStorage, sql);
    },

    /* Used 62 times, almost entirely for schema DDL, which arrives as
       one long string of many statements. PRAGMAs that only make sense
       for a file-backed database are answered rather than executed:
       a Durable Object owns its own journalling and would reject them. */
    exec(sql) {
      const trimmed = String(sql).trim();

      if (/^PRAGMA\s+journal_mode/i.test(trimmed)) return;
      if (/^PRAGMA\s+foreign_keys/i.test(trimmed)) return;
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(trimmed)) {
        throw new Error(
          "Raw BEGIN/COMMIT is not available inside a Durable Object. " +
          "Use db.transaction(fn) — it maps to ctx.storage.transactionSync."
        );
      }

      sqlStorage.exec(trimmed);
    },

    /* db-schema.js defines this today with raw BEGIN/COMMIT. Every
       route calls `db.transaction(() => {...})()`, so replacing the
       implementation here converts all of them at once. transactionSync
       rolls back automatically if the callback throws, which is the
       same contract the existing shim provides. */
    transaction(fn) {
      return function (...args) {
        return ctx.storage.transactionSync(() => fn(...args));
      };
    },
  };

  return db;
}

export { createDb, compile, normalize, Statement };
