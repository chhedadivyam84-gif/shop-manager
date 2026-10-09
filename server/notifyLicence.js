/* ============================================================
   LICENCE NOTICES — telling the owner before the app goes read-only

   The subscription state already exists, worked out three ways depending
   on how this copy was sold (see index.js's subscription gate):

     - a shop signed in by user id on a shared installation: its row in the
       tenant map, which the vendor's panel keeps up to date;
     - a copy holding an activation code: the signed verdict from the
       licence server (licenseCheckin.js);
     - an older copy with a signed key: the key itself (license.js).

   This file reads that state and turns the moments that matter into
   notifications for the owner. It decides nothing about access — the gate
   does that — and invents no state of its own beyond "the expiry date I
   last saw", which is how a renewal is told apart from a first sighting.

   Each moment has a key, so the hourly sweep can run for ever and the
   owner is told once: seven days out, the last day, the day it ends.

   DORMANT in the shop's own copy, exactly as the licence code is: nothing
   is enforced there, so there is nothing to warn about.
   ============================================================ */
const db = require("./db");
const notify = require("./notify");
const { todayStr } = require("./util");

const daysUntil = iso =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))
    ? Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(todayStr() + "T00:00:00Z")) / 86400000)
    : null;

const plural = n => `${n} day${n === 1 ? "" : "s"}`;

/**
 * One business's subscription, in one common shape, judged in the company
 * the caller is running as.
 *
 *   kind: active | expired | cancelled | not-covered | unrecognised | lapsed | other
 */
function judge({ kind, expiresOn, plan }) {
  const what = plan === "demo" ? "demo" : "subscription";
  const What = plan === "demo" ? "Demo" : "Subscription";
  const readOnly = "The app is read-only until it is sorted out — you can still view, print and back up your records.";

  if (kind === "cancelled") {
    notify.create({ category: "licence", severity: "critical", audience: "owner",
      key: `licence:cancelled:${expiresOn || "-"}`, link: "settings",
      title: `Your ${what} has been cancelled`,
      body: `${readOnly} Contact your supplier.` });
    return;
  }
  if (kind === "expired") {
    notify.create({ category: "licence", severity: "critical", audience: "owner",
      key: `licence:expired:${expiresOn || "-"}`, link: "settings",
      title: `Your ${what} has ended`,
      body: `${expiresOn ? `It ended on ${expiresOn}. ` : ""}${readOnly} Contact your supplier to renew.` });
    return;
  }
  if (kind === "not-covered") {
    notify.create({ category: "licence", severity: "critical", audience: "owner",
      key: "licence:not-covered", repeatAfterMs: 7 * 86400000, link: "settings",
      title: "This installation is not covered by your subscription",
      body: `Your supplier's licence server says the subscription is already in use elsewhere. ${readOnly}` });
    return;
  }
  if (kind === "lapsed") {
    /* NOT an expiry and not worded as one: nothing says the subscription
       ended, only that this copy could not confirm it. */
    notify.create({ category: "licence", severity: "critical", audience: "owner",
      key: "licence:lapsed", repeatAfterMs: 3 * 86400000, link: "settings",
      title: "Could not confirm the subscription",
      body: "This copy has not reached your supplier's licence server for longer than its grace period. " +
            "Check the internet connection, then use Check again in Settings." });
    return;
  }
  if (kind === "unrecognised") {
    /* A warning, and said to be one: the copy keeps working on its last
       good answer. It may be the supplier's server that has lost track. */
    notify.create({ category: "licence", severity: "warning", audience: "owner",
      key: "licence:unrecognised", repeatAfterMs: 3 * 86400000, link: "settings",
      title: "Your supplier's licence server did not recognise this copy",
      body: "The app is still working on its last confirmed answer. Please tell your supplier so they can check." });
    return;
  }
  if (kind !== "active") return;

  /* RENEWED: the date moved later than the one last seen here. The first
     sighting only records the date — it is not news. */
  const lastSeen = notify.getState("licence:expires");
  if (expiresOn && lastSeen && expiresOn > lastSeen) {
    notify.create({ category: "licence", severity: "info", audience: "owner",
      key: `licence:renewed:${expiresOn}`, link: "settings",
      title: `${What} renewed until ${expiresOn}`, body: "" });
  }
  if (expiresOn && expiresOn !== lastSeen) notify.setState("licence:expires", expiresOn);

  const left = daysUntil(expiresOn);
  if (left === null || left < 0 || left > 7) return;
  const bucket = left <= 1 ? 1 : 7;
  notify.create({ category: "licence", severity: "warning", audience: "owner",
    key: `licence:expiring:${expiresOn}:${bucket}`, link: "settings",
    title: left === 0 ? `Your ${what} ends today`
         : left === 1 ? `Your ${what} ends tomorrow`
         : `Your ${what} ends in ${plural(left)}`,
    body: `It runs until ${expiresOn}. After that the app becomes read-only until it is renewed — contact your supplier.` });
}

/** The activation-code verdict's state, in judge()'s shape. */
function fromCheckin(st) {
  const map = {
    "active": "active", "active-cached": "active",
    "expired": "expired", "cancelled": "cancelled",
    "too-many-installs": "not-covered", "lapsed": "lapsed",
    "vendor-unreachable": "unrecognised"
  };
  return { kind: map[st.status] || "other", expiresOn: st.expiresOn || "", plan: st.plan || "" };
}

/** One shop on a shared installation, from its tenant row. */
function fromTenant(row) {
  const left = daysUntil(row.expires_on);
  return {
    kind: row.blocked ? "cancelled" : (left !== null && left < 0 ? "expired" : "active"),
    expiresOn: row.expires_on || "", plan: row.plan || ""
  };
}

/** Judge one tenant now — called at sign-in, so a shop hears of it at once. */
function forTenant(row) {
  try { db.companies.runAs(row.company_id, () => judge(fromTenant(row))); }
  catch (e) { console.error("[notify] licence check for a shop failed:", e.message); }
}

/**
 * Every business this installation holds, judged by whichever scheme it
 * was sold under. Safe to call as often as liked: everything it says is
 * keyed, so the second call says nothing new.
 */
function sweep() {
  try {
    const tenants = require("./tenants");
    const checkin = require("./licenseCheckin");
    const license = require("./license");

    if (tenants.multiTenant()) {
      for (const row of tenants.list()) forTenant(row);
      return;
    }
    if (checkin.enabled()) {
      const st = fromCheckin(checkin.state());
      for (const c of db.companies.list()) {
        if (c.active === false) continue;
        db.companies.runAs(c.id, () => judge(st));
      }
      return;
    }
    if (license.enabled()) {
      for (const c of db.companies.list()) {
        if (c.active === false) continue;
        db.companies.runAs(c.id, () => {
          const row = db.prepare("SELECT license_key FROM settings WHERE id = 1").get();
          const st = license.state(license.resolveKey(row && row.license_key));
          if (!st.enforced || st.status === "invalid" || st.status === "missing") return;
          judge({ kind: st.expired ? "expired" : "active", expiresOn: st.expiresOn || "", plan: "" });
        });
      }
    }
  } catch (e) {
    console.error("[notify] licence sweep failed:", e.message);
  }
}

/** Hourly. Often enough that "ends today" arrives on the day; cheap, because
 *  every notice is keyed and nothing here touches the network. */
function start() {
  setTimeout(sweep, 20_000).unref?.();
  setInterval(sweep, 3600 * 1000).unref?.();
}

module.exports = { judge, fromCheckin, fromTenant, forTenant, sweep, start };
