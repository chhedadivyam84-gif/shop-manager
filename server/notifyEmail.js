/* ============================================================
   EMAILING A NOTIFICATION — OFF UNTIL SOMEBODY SETS IT UP

   No email provider is configured for this app, and none is bought or
   switched on by this file. It is the one place that would send, so that
   turning email on is a matter of setting three values on the host:

     EMAIL_API_KEY   the provider's API key            (secret — host only)
     EMAIL_FROM      e.g. "Shop Manager <alerts@yourdomain.in>"
     EMAIL_API_URL   optional; defaults to Resend's send endpoint

   The request is Resend's documented shape ({from, to, subject, text} with
   a Bearer key). Another provider with an HTTP API needs only this file
   changed. Native fetch, so the app's three dependencies stay three.

   WHAT IS SENT, AND TO WHOM

   - Only to the shop's own email address (Settings → business email), and
     only if the OWNER has ticked "email me" for that kind of notice.
     Nothing is ever emailed to a customer of the shop, and announcements
     are never emailed: this is for the owner's alerts, not for marketing.
   - The same words the bell shows, which already carry no PINs, phone
     numbers, keys or amounts beyond what the notice is about.
   - Once per notification. The row is claimed (emailed_at) before the
     request goes out, so two copies of the app, or a retried call, cannot
     both send it. A send that fails releases the claim and is logged; it
     is not retried on a loop, because a provider that is refusing will
     keep refusing and a retry loop is how an inbox gets fifty copies.

   The key is read here, on the server, and goes nowhere else — not to the
   browser, not into a log line, not into an error message.
   ============================================================ */
const db = require("./db");
const { describeError } = require("./logSafe");

const DEFAULT_URL = "https://api.resend.com/emails";

function configured() {
  return !!(String(process.env.EMAIL_API_KEY || "").trim() && String(process.env.EMAIL_FROM || "").trim());
}

function looksLikeEmail(s) {
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[A-Za-z]{2,}$/.test(String(s || "").trim());
}

/**
 * Email one notification if the owner asked for its kind. Resolves to a
 * short word saying what happened — for the tests and the log, never shown
 * to a customer.
 */
async function deliver(companyId, notificationId) {
  if (!configured()) return "not-configured";
  return db.companies.runAs(companyId, async () => {
    const notify = require("./notify");
    const n = db.prepare("SELECT * FROM notifications WHERE id = ?").get(notificationId);
    if (!n || n.hidden_at || n.emailed_at) return "skipped";
    if (!notify.EMAILABLE.includes(n.category)) return "not-emailable";

    const wanted = db.prepare(`SELECT 1 FROM notification_prefs p JOIN staff s ON s.id = p.staff_id
       WHERE p.category = ? AND p.email = 1 AND s.role = 'owner' AND s.active = 1 LIMIT 1`).get(n.category);
    if (!wanted) return "not-wanted";

    const settings = db.prepare("SELECT email, business_name FROM settings WHERE id = 1").get() || {};
    const to = String(settings.email || "").trim();
    if (!looksLikeEmail(to)) {
      console.warn("[email] the owner asked for email but the business has no valid email address in Settings");
      return "no-address";
    }

    /* Claimed first. Whoever gets changes === 1 is the only one who sends. */
    const claim = db.prepare("UPDATE notifications SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL")
      .run(Date.now(), n.id);
    if (!Number(claim.changes)) return "already-sent";

    const shop = String(settings.business_name || "Shop Manager").slice(0, 80);
    const subject = `${shop}: ${n.title}`.slice(0, 180);
    const text = `${n.title}\n\n${n.body || ""}\n\n— Open Shop Manager to see this notice.\n` +
      `You are getting this because email is switched on for this kind of notice in ` +
      `Shop Manager → Notifications → Settings. Switch it off there to stop.`;

    try {
      const res = await fetch(String(process.env.EMAIL_API_URL || DEFAULT_URL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + String(process.env.EMAIL_API_KEY).trim()
        },
        body: JSON.stringify({ from: String(process.env.EMAIL_FROM).trim(), to: [to], subject, text }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw Object.assign(new Error("email provider answered " + res.status), { status: res.status });
      console.log(`[email] sent notice ${n.id} (${n.category})`);
      return "sent";
    } catch (e) {
      db.prepare("UPDATE notifications SET emailed_at = NULL WHERE id = ?").run(n.id);
      console.error("[email] could not send a notice", JSON.stringify(describeError(e)));
      return "failed";
    }
  });
}

module.exports = { configured, deliver, looksLikeEmail };
