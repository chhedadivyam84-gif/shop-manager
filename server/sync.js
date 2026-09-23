/* ============================================================
   SYNC — sending this shop up to the cloud copy

   ONE DIRECTION. The shop PC holds the books; the hosted copy is a place
   to reach them from. See the note in db-schema.js for why two-way record
   sync is not on the table: both copies allocate document numbers from
   their own counter into a UNIQUE column, so two different bills can both
   be SP0000001, and neither can be renumbered — one is in a customer's
   hand, the other is in a GST return.

   NOTHING HAPPENS ON ITS OWN. There is no timer in this file and no hook
   on startup. A push occurs when somebody presses the button, which is
   what makes it safe to point at a live shop.

   WHAT IS SENT is a VACUUM INTO snapshot — one clean file with the -wal
   already folded in, the same thing the Download Backup button produces.
   The receiving copy puts it through exactly the path an uploaded backup
   takes (restoreFile.js): it is checked, the books it replaces are kept,
   and the swap waits for a restart.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const backup = require("./backup");
const { uid } = require("./util");

/* Long enough that guessing is not a strategy, and printed as hex so it
   survives being read down a phone or typed by hand. */
const KEY_BYTES = 32;

function hashKey(key) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(String(key), salt, 64).toString("hex");
}

function keyMatches(key, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash || !key) return false;
  const check = crypto.scryptSync(String(key), salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex"), b = Buffer.from(check, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function settings() {
  try {
    return db.prepare(`SELECT sync_cloud_url, sync_cloud_key, sync_accept_hash,
                              sync_last_at, sync_last_ok, business_name
                         FROM settings WHERE id = 1`).get() || {};
  } catch (e) { return {}; }
}

/* ------------------------------------------------------------------
   THE RECEIVING SIDE
   ------------------------------------------------------------------ */

/** Issue a key. Returned ONCE; only its hash is kept. */
function issueAcceptKey() {
  const key = crypto.randomBytes(KEY_BYTES).toString("hex");
  db.prepare("UPDATE settings SET sync_accept_hash = ? WHERE id = 1").run(hashKey(key));
  return key;
}

function revokeAcceptKey() {
  db.prepare("UPDATE settings SET sync_accept_hash = '' WHERE id = 1").run();
}

/** Does this copy accept pushes at all, and is this the right key? */
function accepts(key) {
  const s = settings();
  if (!s.sync_accept_hash) return { ok: false, reason: "This copy is not set up to receive a sync." };
  if (!keyMatches(key, s.sync_accept_hash)) return { ok: false, reason: "That sync key is not recognised." };
  return { ok: true };
}

/* ------------------------------------------------------------------
   THE SENDING SIDE
   ------------------------------------------------------------------ */

function setTarget(url, key) {
  const clean = String(url || "").trim().replace(/\/+$/, "");
  if (clean && !/^https:\/\//i.test(clean)) {
    /* http would put the whole shop, and the key with it, across the wire
       in the clear. */
    throw new Error("The cloud address must start with https://");
  }
  db.prepare("UPDATE settings SET sync_cloud_url = ?, sync_cloud_key = ? WHERE id = 1")
    .run(clean, String(key || "").trim());
  return { url: clean, hasKey: !!String(key || "").trim() };
}

function log(row) {
  db.prepare(`INSERT INTO sync_log (id, at, direction, staff, target, ok, bytes, summary, error)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid("SYNC"), Date.now(), row.direction, row.staff || "", row.target || "",
         row.ok ? 1 : 0, row.bytes || 0, row.summary || "", row.error || "");
}

function history(limit) {
  try {
    return db.prepare("SELECT * FROM sync_log ORDER BY at DESC LIMIT ?").all(Math.min(Number(limit) || 30, 200));
  } catch (e) { return []; }
}

/** What this shop holds — shown beside the cloud's figures before a push. */
function localSummary() {
  const n = sql => { try { return db.prepare(sql).get().n; } catch (e) { return null; } };
  return {
    invoices:  n("SELECT COUNT(*) n FROM invoices WHERE doc_type='invoice'"),
    challans:  n("SELECT COUNT(*) n FROM invoices WHERE doc_type='challan'"),
    purchases: n("SELECT COUNT(*) n FROM purchases"),
    customers: n("SELECT COUNT(*) n FROM customers"),
    suppliers: n("SELECT COUNT(*) n FROM suppliers"),
    products:  n("SELECT COUNT(*) n FROM products"),
    cash:      n("SELECT COUNT(*) n FROM cash_entries WHERE voided = 0"),
    staff:     n("SELECT COUNT(*) n FROM staff"),
  };
}

function status() {
  const s = settings();
  return {
    configured: !!(s.sync_cloud_url && s.sync_cloud_key),
    url: s.sync_cloud_url || "",
    acceptsPushes: !!s.sync_accept_hash,
    lastAt: s.sync_last_at || 0,
    lastOk: !!s.sync_last_ok,
    local: localSummary(),
  };
}

/** Ask the cloud copy what it currently holds. Never throws. */
async function askCloud(pathname) {
  const s = settings();
  if (!s.sync_cloud_url || !s.sync_cloud_key) {
    return { ok: false, error: "No cloud address has been set." };
  }
  try {
    const r = await fetch(s.sync_cloud_url + pathname, {
      headers: { "x-sync-key": s.sync_cloud_key },
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: body.error || `The cloud copy answered ${r.status}.` };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: describeNetworkError(err) };
  }
}

function describeNetworkError(err) {
  const m = String((err && err.message) || err);
  if (/timeout|aborted/i.test(m)) return "The cloud copy did not answer in time. It may be waking up — try again in a minute.";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "Could not reach the internet, or that address does not exist.";
  if (/ECONNREFUSED|fetch failed/i.test(m)) return "Could not connect to the cloud copy. Check it is running.";
  return m;
}

/**
 * Send this shop up.
 *
 * Takes a clean snapshot, posts it, and records the attempt either way.
 * A failure leaves this shop completely untouched — nothing here is
 * deleted, moved or marked as sent on the strength of a push.
 */
async function push(opts) {
  const s = settings();
  const staff = (opts && opts.staff) || "";
  const target = s.sync_cloud_url || "";

  if (!target || !s.sync_cloud_key) {
    const error = "No cloud address has been set. Add one under Data & Sync first.";
    log({ direction: "push", staff, target, ok: false, error });
    return { ok: false, error };
  }

  let snap;
  try {
    snap = backup.snapshotForDownload();
  } catch (err) {
    const error = "Could not prepare the data to send: " + err.message;
    log({ direction: "push", staff, target, ok: false, error });
    return { ok: false, error };
  }

  try {
    const buf = fs.readFileSync(snap);
    const r = await fetch(target + "/api/sync/receive", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-key": s.sync_cloud_key },
      body: JSON.stringify({
        file: buf.toString("base64"),
        filename: path.basename(snap),
        from: s.business_name || "",
      }),
      /* A shop's database over a shop's broadband; generous, but bounded. */
      signal: AbortSignal.timeout(180000),
    });
    const body = await r.json().catch(() => ({}));

    if (!r.ok) {
      const error = body.error || `The cloud copy refused it (${r.status}).`;
      log({ direction: "push", staff, target, ok: false, bytes: buf.length, error });
      db.prepare("UPDATE settings SET sync_last_at = ?, sync_last_ok = 0 WHERE id = 1").run(Date.now());
      return { ok: false, error };
    }

    const c = (body.received && body.received.counts) || {};
    const summary = `${c.invoices ?? "?"} invoices, ${c.challans ?? "?"} challans, ` +
                    `${c.customers ?? "?"} customers, ${c.cash ?? "?"} cash entries`;
    log({ direction: "push", staff, target, ok: true, bytes: buf.length, summary });
    db.prepare("UPDATE settings SET sync_last_at = ?, sync_last_ok = 1 WHERE id = 1").run(Date.now());
    return { ok: true, bytes: buf.length, summary, received: body.received, replaced: body.replaced };
  } catch (err) {
    const error = describeNetworkError(err);
    log({ direction: "push", staff, target, ok: false, error });
    db.prepare("UPDATE settings SET sync_last_at = ?, sync_last_ok = 0 WHERE id = 1").run(Date.now());
    return { ok: false, error };
  } finally {
    try { fs.unlinkSync(snap); } catch (e) { /* temp snapshot */ }
  }
}

module.exports = {
  issueAcceptKey, revokeAcceptKey, accepts,
  setTarget, status, push, history, log, localSummary, askCloud,
};
