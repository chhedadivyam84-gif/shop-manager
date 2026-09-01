/* ============================================================
   SESSIONS THAT SURVIVE A RESTART

   THE BUG THIS FIXES. The session cookie was already set to thirty days,
   so staff being thrown back to the PIN screen was never a timeout. It was
   the STORE: express-session with no `store` falls back to an in-memory
   one, and memory does not survive the process. Every pm2 restart, every
   deploy, every time a hosted instance spun down and came back — every
   session in the shop was gone, mid-bill, with no warning.

   That is also why raising the timeout would have changed nothing at all.

   Sessions live in their own SQLite file rather than the shop's database,
   for two reasons. A session is not shop data and has no business in the
   backup that gets uploaded every fifteen minutes. And on a multi-company
   copy the shop database changes underneath you when the company is
   switched, which is the last thing a login should depend on.

   Expired rows are cleared on open and hourly after, so the file cannot
   grow forever on a counter PC nobody ever restarts.
   ============================================================ */
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const session = require("express-session");

const Store = session.Store;

class SqliteSessionStore extends Store {
  constructor(opts) {
    super(opts || {});
    const dir = (opts && opts.dir) || ".";
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "sessions.db"));

    /* WAL so a read while the shop is billing cannot block the write that
       is renewing somebody's session. */
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid        TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)");

    this.sweep();
    /* unref so this timer can never hold the process open on shutdown. */
    const t = setInterval(() => this.sweep(), 60 * 60 * 1000);
    if (typeof t.unref === "function") t.unref();
  }

  /** How long this session has left, in ms since the epoch. */
  expiryOf(sess) {
    const ms = (sess && sess.cookie && sess.cookie.maxAge) || null;
    if (ms) return Date.now() + ms;
    const at = sess && sess.cookie && sess.cookie.expires;
    return at ? new Date(at).getTime() : Date.now() + 1000 * 60 * 60 * 24;
  }

  sweep() {
    try { this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()); }
    catch (e) { /* a sweep that fails must never take the app down */ }
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare(
        "SELECT data, expires_at FROM sessions WHERE sid = ?"
      ).get(sid);
      if (!row) return cb(null, null);
      /* An expired row is treated as absent AND removed, rather than
         returned for express-session to reject — otherwise a stale row
         lingers until the next sweep and is read on every request. */
      if (row.expires_at < Date.now()) {
        this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (e) { return cb(e); }
  }

  set(sid, sess, cb) {
    try {
      this.db.prepare(
        "INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at"
      ).run(sid, JSON.stringify(sess), this.expiryOf(sess));
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }

  /** Called on every request for a rolling session — only the expiry moves. */
  touch(sid, sess, cb) {
    try {
      this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?")
        .run(this.expiryOf(sess), sid);
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }

  length(cb) {
    try { cb(null, this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n); }
    catch (e) { cb(e); }
  }

  clear(cb) {
    try { this.db.exec("DELETE FROM sessions"); return cb && cb(null); }
    catch (e) { return cb && cb(e); }
  }
}

module.exports = { SqliteSessionStore };
