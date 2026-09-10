/* ============================================================
   ONE SHOP = ONE DURABLE OBJECT

   The app already decided this shape. Today each company gets its own
   physical SQLite file, and server/db.js says why in as many words:
   isolation is physical, not a `WHERE company_id = ?` filter, because
   one forgotten filter on one of 1,313 statements is a cross-tenant
   leak. A Durable Object with SQLite storage is that same decision
   expressed in Cloudflare's vocabulary — the storage lives inside the
   object, so there is no query that could reach another shop's rows
   even if someone wrote one.

   What this buys beyond parity:

   - A DO serialises its own requests, so each shop gets a single
     writer for free. The bill-numbering and stock-deduction races that
     any multi-process deployment has to think about cannot occur.
   - Alarms replace the setInterval loops in backup.js, licenseCheckin.js
     and sessionStore.js, which have no home on a stateless Worker.
   - The object hibernates when the shop is closed and costs nothing.

   WHAT IS NOT DONE HERE YET

   The 58 route files are not mounted. That is Phase 3. This is the
   database layer the routes will sit on, which is what has to be
   proven correct first.
   ============================================================ */
import { DurableObject } from "cloudflare:workers";
import { createDb } from "./sqlite-shim.js";
import { SCHEMA } from "./schema.js";
import { snapshot, signature, gzip, gunzip, stamp, listBackups, prune } from "./backup.js";

/* Bumped whenever SCHEMA changes. The statements are all IF NOT EXISTS
   and therefore safe to replay, but replaying 183 of them on every cold
   start would add latency to the first bill of the morning for no gain,
   so a stamp records that this object is already current. Idempotency is
   preserved: if the stamp is missing or stale the whole schema runs. */
const SCHEMA_VERSION = `v1:${SCHEMA.length}`;

/* Thirty days, matching the express-session cookie the shop runs on today.
   That number was never why staff got thrown back to the PIN screen — the
   in-memory store was — so it is carried over unchanged. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* Fifteen minutes, matching CLOUD_INTERVAL_MS in server/backup.js. The shop
   is used to losing at most a quarter of an hour; changing that cadence
   silently changes what "recent" means to them. */
const BACKUP_EVERY_MS = 15 * 60 * 1000;

export class ShopTenant extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;

    /* Every route file expects `db.prepare(...)`. Handing them this is
       what lets 17,200 lines of route SQL port without being rewritten. */
    this.db = createDb(ctx);

    /* Schema setup is the one thing that legitimately blocks concurrency:
       no request may see a half-built database. */
    ctx.blockConcurrencyWhile(async () => {
      const built = await ctx.storage.get("schemaVersion");
      if (built === SCHEMA_VERSION) return;

      ctx.storage.transactionSync(() => {
        for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
      });
      await ctx.storage.put("schemaVersion", SCHEMA_VERSION);
    });

    /* NO ALARM IS ARMED HERE, deliberately.

       Arming one on every wake looked harmless and was not: setAlarm is a
       WRITE, and on the free plan Durable Objects allow 100,000 row-writes
       a day across the account. Every probe, every test tenant and every
       mistyped shop name created an object that then woke itself every
       fifteen minutes forever, writing each time — for a shop with no data
       in it at all.

       So the alarm is armed only once a shop has something worth backing
       up, which backupNow() decides. An empty object now costs nothing and
       goes back to sleep for good. */
  }

  /* ================= THE APP =================

     Runs the real route files. They are copied verbatim from ../server by
     tools/build-server.js and mounted by src/app.cjs at exactly the paths
     server/index.js uses, with the same guards.

     Everything runs INSIDE the Durable Object rather than in the Worker,
     because `db.prepare(...)` is synchronous and only exists here. That
     also means each shop's requests are serialised, which is the property
     that makes bill numbering and stock deduction safe without locks.

     The runtime (database, this object, its bindings, the shop's name)
     travels with the request through AsyncLocalStorage — the same
     mechanism server/db.js uses, for the same reason: several Durable
     Objects can share an isolate, so a module-level value would be shared
     between different businesses. */
  #app = null;

  async apiRequest(call) {
    /* Everything comes from app.cjs, and that is deliberate. Reaching
       _runtime or the shim through a separate ESM import() produces a
       SECOND module instance with its own AsyncLocalStorage — a store set
       on one is invisible to the other, and every route then fails with
       "used outside a request" while looking perfectly wired. One import,
       one module graph, one store. */
    const mod = await import("./app.cjs");
    const { buildApp, runtime, Res } = mod.default || mod;

    const res = new Res();

    const req = {
      method: call.method,
      path: call.path,
      originalUrl: call.path,
      params: {},
      query: call.query || {},
      body: call.body === undefined ? {} : call.body,
      headers: call.headers || {},
      ip: call.ip || "unknown",
      /* The same nine fields express-session put here, so all 135
         `req.session` reads inside the route files behave unchanged. */
      session: call.session || {},
      get(name) { return (call.headers || {})[String(name).toLowerCase()]; },
    };

    const ctx = { db: this.db, self: this, env: this.env, tenant: call.tenant };

    let handled = false;
    try {
      handled = await runtime.run(ctx, () => {
        /* buildApp() require()s all 57 route files, and at least one of
           them touches `db` at module scope — a prepared statement built
           once at load. On Render that is fine because db is a file that
           already exists. Here it needs a request context, so the app is
           built INSIDE runtime.run rather than before it.

           It is still built only once: the require cache keeps the route
           modules, and #app holds the mounted router. */
        if (!this.#app) this.#app = buildApp();
        return this.#app.handle(req, res, call.path);
      });
    } catch (err) {
      /* A route that throws is a 500 with its message, which is what
         Express's default error handler does and what the frontend's
         api() helper already knows how to display. */
      /* The message goes to the user because the frontend's api() helper
         displays it and a shopkeeper needs to know what failed. The stack
         does not: it names internal paths and is only useful while
         developing, so it is withheld in production. */
      const payload = { error: String((err && err.message) || err) };
      if (this.env.ENVIRONMENT !== "production") {
        payload.stack = String((err && err.stack) || "").split(/\r?\n/).slice(0, 6);
      }
      return { status: 500, headers: { "content-type": "application/json" },
               body: JSON.stringify(payload) };
    }

    if (!handled || !res.finished) {
      return { status: 404, headers: { "content-type": "application/json" },
               body: JSON.stringify({ error: "Not found" }) };
    }

    return { status: res.statusCode, headers: res.headers, body: res.body };
  }

  /* ---------- health, used by the Worker and by migration checks ---------- */
  async health() {
    const tables = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .toArray()[0].n;

    return {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      tables,
      /* databaseSize is bytes on disk for THIS shop alone. The live shop
         is about 1.2 MB, so there is a great deal of headroom. */
      databaseSize: this.ctx.storage.sql.databaseSize ?? null,
    };
  }

  /* Row counts per non-empty table. This is the shape the migration
     verifier compares old against new — if a table's count differs after
     an import, the import is wrong and must not be cut over to. */
  async rowCounts() {
    const names = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .toArray();

    const counts = {};
    for (const { name } of names) {
      try {
        counts[name] = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM "${name}"`).toArray()[0].n;
      } catch {
        counts[name] = null;
      }
    }
    return counts;
  }

  /* ================= AUTH =================

     Sessions live in this object's KEY-VALUE storage, not its SQL tables.
     express-session kept them in a separate SQLite file on purpose —
     "a session is not shop data and has no business in the backup" — and
     that reasoning survives the move. Same object, separate store, so an
     export of the shop's books carries no sessions.

     The scrypt verification runs here rather than in the Worker, which
     costs this shop about 35ms of serialised time per login attempt. That
     is acceptable because logins are rare and the lockout below caps how
     many can be forced; keeping the PIN hash inside the object is worth
     more than the milliseconds.
     ================================================================= */

  /* Who can sign in. Deliberately returns no pin_hash — this feeds the
     login screen, which is drawn before anyone has authenticated.

     The ORDER BY is copied exactly from server/routes/auth.js: role DESC
     then name, which is what puts the owner at the top of the staff picker.
     Reordering it would silently rearrange the screen the shop uses every
     morning. */
  async listStaff() {
    return this.ctx.storage.sql
      .exec("SELECT id, name, role FROM staff WHERE active = 1 ORDER BY role DESC, name ASC")
      .toArray();
  }

  /* The name and logo the login screen draws before anyone has signed in.
     server/routes/auth.js sends both for the same stated reason: neither is
     private, since both are printed on every bill that leaves the shop. */
  async shopInfo() {
    const s = this.ctx.storage.sql
      .exec("SELECT business_name, logo_data FROM settings WHERE id = 1")
      .toArray()[0];
    return { businessName: s?.business_name || "", logo: s?.logo_data || "" };
  }

  /* Mirrors server/routes/auth.js: five wrong PINs locks the source for
     fifteen minutes. Unlike today's in-memory Map this survives a restart,
     because a Durable Object's storage does — an attacker can no longer
     clear their own lockout by waiting for a deploy. */
  async #lockStatus(ip) {
    const rec = (await this.ctx.storage.get(`lock:${ip}`)) || null;
    if (!rec || !rec.lockedUntil) return { locked: false };
    if (Date.now() >= rec.lockedUntil) {
      await this.ctx.storage.delete(`lock:${ip}`);
      return { locked: false };
    }
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }

  async login(staffId, pin, ip = "unknown") {
    const lock = await this.#lockStatus(ip);
    if (lock.locked) {
      return { ok: false, status: 429,
               error: `Too many wrong PINs. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).` };
    }

    const rows = staffId
      ? this.ctx.storage.sql.exec("SELECT * FROM staff WHERE id = ? AND active = 1", staffId).toArray()
      : [];
    const staff = rows[0];

    const { verifyPin } = await import("./pin.js");
    if (!staff || !pin || !(await verifyPin(String(pin), staff.pin_hash))) {
      const rec = (await this.ctx.storage.get(`lock:${ip}`)) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      if (rec.count >= 5) { rec.lockedUntil = Date.now() + 15 * 60 * 1000; rec.count = 0; }
      await this.ctx.storage.put(`lock:${ip}`, rec);
      return { ok: false, status: 401, error: "Incorrect PIN." };
    }

    await this.ctx.storage.delete(`lock:${ip}`);

    /* The same nine fields express-session carried, so `req.session` reads
       identically inside every route. */
    const sid = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const data = {
      loggedIn: true,
      staffId: staff.id,
      staffName: staff.name,
      role: staff.role,
      tenant: null,
      businessId: null,
      previewStaffId: null,
      previewStaffName: null,
    };
    await this.ctx.storage.put(`sess:${sid}`, { data, expiresAt: Date.now() + SESSION_TTL_MS });
    await this.#armSweep();

    const settings = this.ctx.storage.sql
      .exec("SELECT business_name FROM settings WHERE id = 1").toArray()[0];

    return { ok: true, sid, businessName: settings?.business_name || "", staffName: staff.name, role: staff.role };
  }

  /* Rolling expiry, as today: every request pushes the thirty days back so
     somebody billing all day is never signed out mid-bill. The write only
     happens once an hour of drift has accumulated, so a busy till is not
     writing storage on every keystroke. */
  async getSession(sid) {
    const rec = await this.ctx.storage.get(`sess:${sid}`);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      await this.ctx.storage.delete(`sess:${sid}`);
      return null;
    }
    const fresh = Date.now() + SESSION_TTL_MS;
    if (fresh - rec.expiresAt > 60 * 60 * 1000) {
      await this.ctx.storage.put(`sess:${sid}`, { data: rec.data, expiresAt: fresh });
    }
    return rec.data;
  }

  async saveSession(sid, data) {
    const rec = await this.ctx.storage.get(`sess:${sid}`);
    if (!rec) return false;
    await this.ctx.storage.put(`sess:${sid}`, { data, expiresAt: rec.expiresAt });
    return true;
  }

  async destroySession(sid) {
    await this.ctx.storage.delete(`sess:${sid}`);
    return { ok: true };
  }

  /* ONE ALARM, TWO JOBS.

     A Durable Object gets a single alarm, and setAlarm replaces whatever
     was pending — so the two recurring jobs the Express app runs on
     separate setIntervals (backup.js every 15 minutes, sessionStore.js
     hourly) have to share it. The alarm fires on the shorter cadence and
     each job decides for itself whether it is due.

     Getting this wrong is quiet: arming a second alarm silently cancels
     the first, and the symptom is backups that stop happening. */
  /* Arms the next wake, at `ms` from now, only if nothing is already
     pending — setAlarm replaces a pending alarm, and replacing it with the
     same time is a write for no gain. */
  async #armSweep(ms = BACKUP_EVERY_MS) {
    if (await this.ctx.storage.getAlarm()) return;
    /* Never schedule a shop that has nothing in it. This is the guard that
       stops a probe or a mistyped tenant name becoming a permanent
       fifteen-minute write. */
    if (!this.#hasSomethingToProtect()) return;
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }

  /* Is there anything here worth waking up for? A shop with no staff row
     has never been set up — a probe, a typo, or one of the throwaway
     tenants a test created. Those must not schedule themselves forever. */
  #hasSomethingToProtect() {
    try {
      return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM staff").toArray()[0].n > 0;
    } catch {
      return false;
    }
  }

  async alarm() {
    const now = Date.now();

    /* An empty shop retires itself. No reschedule, so the object sleeps
       for good until somebody actually uses it. */
    if (!this.#hasSomethingToProtect()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    /* --- job 1: back up, if anything changed --- */
    let skipped = false;
    try {
      const out = await this.backupNow("scheduled");
      skipped = !!(out && out.skipped);
    } catch { /* never let a failed backup stop the sweep */ }

    /* --- job 2: expired sessions, hourly --- */
    const lastSweep = (await this.ctx.storage.get("lastSweep")) || 0;
    if (now - lastSweep > 60 * 60 * 1000) {
      const all = await this.ctx.storage.list({ prefix: "sess:" });
      let removed = 0;
      for (const [key, rec] of all) {
        if (!rec || now > rec.expiresAt) { await this.ctx.storage.delete(key); removed++; }
      }
      /* Only record a sweep that had something to sweep, so a quiet shop is
         not writing a timestamp every hour to say nothing happened. */
      if (removed) await this.ctx.storage.put("lastSweep", now);
    }

    /* BACK OFF WHEN THE SHOP IS QUIET.

       A closed shop does not need checking every fifteen minutes. Each
       unchanged wake doubles the interval up to six hours; the first wake
       that finds a change drops straight back to fifteen minutes, so an
       open till is still never more than a quarter hour from safe.

       This is the difference between a tenant costing ~96 wakes a day and
       ~8, which on a 100,000-writes-a-day budget decides how many shops
       can share one account. */
    let next = BACKUP_EVERY_MS;
    if (skipped) {
      const last = (await this.ctx.storage.get("backoffMs")) || BACKUP_EVERY_MS;
      next = Math.min(last * 2, 6 * 60 * 60 * 1000);
    }
    if (next !== BACKUP_EVERY_MS) await this.ctx.storage.put("backoffMs", next);
    else await this.ctx.storage.delete("backoffMs");

    await this.ctx.storage.setAlarm(Date.now() + next);
  }

  /* ================= BACKUPS TO R2 =================
     The Supabase replacement. See src/backup.js for why a snapshot here is
     the rows rather than a .db file. */

  async backupNow(reason = "manual", tenant) {
    if (!this.env.BACKUPS) return { ok: false, reason: "no R2 bucket bound" };

    if (tenant) await this.ctx.storage.put("tenantName", tenant);
    const name = tenant || (await this.ctx.storage.get("tenantName"));
    if (!name) return { ok: false, reason: "tenant name unknown" };

    const sig = signature(this.ctx.storage.sql);
    const last = await this.ctx.storage.get("lastBackupSig");

    /* A shop that has sold nothing since the last snapshot does not need
       another identical one. Skipping is reported rather than silent, so
       "no backups today" can be told apart from "backups are broken". */
    if (reason === "scheduled" && sig === last) {
      await this.#armSweep();
      return { ok: true, skipped: "unchanged", signature: sig };
    }

    const snap = snapshot(this.ctx.storage.sql);
    const body = await gzip(JSON.stringify({
      tenant: name, takenAt: new Date().toISOString(), reason,
      tables: snap.tables, rows: snap.rows, data: snap.data,
    }));

    const key = `${name}/shop-${stamp()}.json.gz`;
    await this.env.BACKUPS.put(key, body, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { tenant: name, rows: String(snap.rows), tables: String(snap.tables), reason },
    });

    await this.ctx.storage.put("lastBackupSig", sig);
    await this.ctx.storage.put("lastBackupAt", Date.now());
    const pruned = await prune(this.env.BACKUPS, name);
    await this.#armSweep();

    return { ok: true, key, rows: snap.rows, tables: snap.tables,
             bytes: body.byteLength, pruned: pruned.deleted };
  }

  async backupStatus(tenant) {
    if (!this.env.BACKUPS) return { ok: false, reason: "no R2 bucket bound" };
    const name = tenant || (await this.ctx.storage.get("tenantName"));
    if (!name) return { ok: false, reason: "tenant name unknown" };
    const list = await listBackups(this.env.BACKUPS, name);
    return {
      ok: true,
      count: list.length,
      lastBackupAt: (await this.ctx.storage.get("lastBackupAt")) || null,
      nextAlarmAt: await this.ctx.storage.getAlarm(),
      backups: list.slice(-10).reverse(),
    };
  }

  /* Puts a snapshot back. Everything is emptied first, in reverse
     dependency order, because a restore that merges into what is already
     there is not a restore — it is two shops in one ledger. Sessions are
     untouched, so restoring does not sign anybody back in. */
  async restoreFromBackup(key, orderedTables) {
    if (!this.env.BACKUPS) throw new Error("no R2 bucket bound");
    const obj = await this.env.BACKUPS.get(key);
    if (!obj) throw new Error(`no such backup: ${key}`);

    const parsed = JSON.parse(await gunzip(await obj.arrayBuffer()));
    const data = parsed.data || {};

    const order = Array.isArray(orderedTables) && orderedTables.length
      ? orderedTables
      : Object.keys(data);

    this.ctx.storage.transactionSync(() => {
      for (const t of [...order].reverse()) {
        try { this.ctx.storage.sql.exec(`DELETE FROM "${t}"`); } catch {}
      }
    });

    let restored = 0;
    for (const t of order) {
      const rows = data[t];
      if (!rows || !rows.length) continue;
      const cols = Object.keys(rows[0]);
      const sql = `INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(", ")}) ` +
                  `VALUES (${cols.map(() => "?").join(", ")})`;
      this.ctx.storage.transactionSync(() => {
        for (const row of rows) {
          this.ctx.storage.sql.exec(sql, ...cols.map((c) => {
            const v = row[c];
            if (v === undefined || v === null) return null;
            if (typeof v === "boolean") return v ? 1 : 0;
            return v;
          }));
          restored++;
        }
      });
    }

    await this.ctx.storage.delete("lastBackupSig");
    return { ok: true, key, restored, takenAt: parsed.takenAt };
  }

  /* Test scaffolding. The Worker only exposes this outside production, and
     it exists so the login path can be exercised against a PIN that is
     known — real PINs belong to real people and are not mine to guess. */
  async devSeedStaff(name = "Test Owner", pin = "1234", role = "owner") {
    const { hashPin } = await import("./pin.js");
    const id = "STAFF_test_" + crypto.randomUUID().slice(0, 8);
    this.ctx.storage.sql.exec(
      "INSERT INTO staff (id, name, pin_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      id, name, await hashPin(pin), role, Date.now()
    );
    /* settings row must exist — login reads business_name from it.
       settings.pin_hash is NOT NULL with no default (it is the legacy
       single-owner PIN from before the staff table existed), so it has to
       be supplied even though nothing here reads it. */
    const s = this.ctx.storage.sql.exec("SELECT id FROM settings WHERE id = 1").toArray();
    if (!s.length) {
      this.ctx.storage.sql.exec(
        "INSERT INTO settings (id, business_name, pin_hash) VALUES (1, ?, ?)",
        "Test Shop", await hashPin(pin)
      );
    }
    return { id, name, role };
  }

  /* Reads back the first rows of a table so the migration verifier can
     compare actual field values, not just counts. Two databases can agree
     on how many rows they hold and still disagree about what is in them —
     a NULL that became an empty string, a number that became text — and
     for a ledger that difference is the whole game. */
  async selectRows(table, limit = 3) {
    const exists = this.ctx.storage.sql
      .exec("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", table)
      .toArray();
    if (!exists.length) throw new Error(`unknown table: ${table}`);

    return this.ctx.storage.sql
      .exec(`SELECT * FROM "${table}" ORDER BY rowid LIMIT ?`, Math.min(Number(limit) || 3, 50))
      .toArray();
  }

  /* Empties every table, leaving the schema intact, so a migration lands on
     a clean slate.

     WHY THIS EXISTS. The first migration loaded a stale local copy of the
     shop. Importing the real books on top with INSERT OR REPLACE would not
     replace those rows — it would sit beside them wherever an id differed,
     leaving a database that is a blend of two shops and looks fine until an
     accountant asks why a total is wrong. Replacing must therefore be
     explicit and total.

     Deletion order is the reverse of the foreign-key dependency order the
     migrator computes, so children go before parents. Sessions are
     untouched: they live in key-value storage, not in these tables. */
  async clearAllRows(orderedTables) {
    if (!Array.isArray(orderedTables) || !orderedTables.length) {
      throw new Error("clearAllRows needs the dependency-ordered table list");
    }
    let cleared = 0;
    this.ctx.storage.transactionSync(() => {
      for (const t of [...orderedTables].reverse()) {
        try { this.ctx.storage.sql.exec(`DELETE FROM "${t}"`); cleared++; } catch { /* skip */ }
      }
    });
    return { cleared };
  }

  /* ---------- migration intake ----------
     Takes rows for one table and writes them in a single transaction, so
     a table either arrives whole or not at all. Columns are read from the
     first row and quoted, so a column named `date` or `total` cannot
     collide with a keyword.

     This is deliberately dumb: no transformation, no defaulting, no
     "helpful" coercion. The whole point of the migration is that what
     comes out of the old database is what goes into the new one. */
  async importTable(table, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { table, inserted: 0 };

    const exists = this.ctx.storage.sql
      .exec("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", table)
      .toArray();
    if (!exists.length) throw new Error(`unknown table: ${table}`);

    const cols = Object.keys(rows[0]);
    const quoted = cols.map((c) => `"${c}"`).join(", ");
    const marks = cols.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO "${table}" (${quoted}) VALUES (${marks})`;

    let inserted = 0;
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        this.ctx.storage.sql.exec(sql, ...cols.map((c) => {
          const v = row[c];
          if (v === undefined || v === null) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          return v;
        }));
        inserted++;
      }
    });

    /* A migrated shop must be protected even if nobody signs in for a week.
       The constructor no longer arms an alarm, so this is where a shop that
       arrives by migration rather than by login starts being backed up. */
    await this.#armSweep();

    return { table, inserted };
  }
}
