const express = require("express");
const db = require("../db");
const { verifyPin, loginLockStatus, recordLoginFailure, clearLoginFailures } = require("../auth");
const { logAction, todayStr } = require("../util");
const tenants = require("../tenants");
const checkin = require("../licenseCheckin");

const router = express.Router();

/* ============================================================
   SIGNING IN, IN TWO STAGES

   1. THE SHOP signs in — the user id or email and password the supplier
      issued. This decides WHICH BOOKS open, and nothing else. One address
      can serve a hundred shops and each one lands in its own database.

   2. THE PERSON signs in — the staff member's own PIN, inside that shop,
      exactly as it has always worked.

   Two stages rather than one because they answer different questions and
   are held by different people. The shop's login is a commercial fact the
   supplier issued once; the PIN is who is standing at the till this
   afternoon. Rolling them together would mean every staff member knowing
   the credential that identifies the business.

   ON A SINGLE-SHOP INSTALLATION STAGE 1 DOES NOT APPEAR. A desktop buyer
   has one shop, knows which one it is, and an extra page between them and
   their till is a page they resent every morning. GET /mode says which
   kind of installation this is and the screen follows it.
   ============================================================ */

/** Which login the screen should show. Public — it reveals only whether
 *  this installation serves more than one shop, which anybody who can see
 *  the sign-in page can work out by looking at it. */
/* The ONE sentence used for every refused sign-in.

   It has to be identical whether the login is unknown here, unknown to
   the vendor, or known with the wrong password. Two different sentences
   is a way to ask this installation which of a hundred shop logins are
   real — and it had two, because one came from here and one was passed
   through from the panel. */
const WRONG_LOGIN = "That user ID or password is not right.";

router.get("/mode", (req, res) => {
  res.json({
    multiTenant: tenants.multiTenant(),
    /* Once a shop has signed in, the screen goes straight to its staff. */
    shop: req.session && req.session.tenant
      ? { name: req.session.tenant.shopName, plan: req.session.tenant.plan, expiresOn: req.session.tenant.expiresOn }
      : null
  });
});

/**
 * Stage 1 — the shop.
 *
 * Answered LOCALLY whenever we already know this shop, so a bad line or a
 * sleeping licence server never stops a shop opening its own books. The
 * vendor's panel is asked only when the login is one we have not seen,
 * which is the first sign-in and no other.
 */
/**
 * Ask the vendor about this login.
 *
 * Returns their answer, or null if the vendor could not be reached — the
 * caller decides what to do with silence, because the right answer
 * differs: for a login we have never seen there is nothing to fall back
 * on, and for one whose subscription looks finished the cached date is
 * the safe reading.
 */
async function askVendor(username, password) {
  const server = checkin.serverUrl();
  if (!server) return null;
  try {
    const r = await fetch(server.replace(/\/+$/, "") + "/api/tenant-login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(20000)
    });
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch (e) { return null; }
}

/**
 * Which company already holds this activation code?
 *
 * Asked before ever creating one. The tenant map normally answers this,
 * but the map is a single file: lose it, or restore it a run out of step,
 * and a shopkeeper whose books are sitting right there would be given a
 * fresh empty company instead — with the real ones orphaned and no way
 * back that does not involve me.
 *
 * So the code is also written inside each shop's own settings, which are
 * backed up with the books themselves, and this reads it back. Slow — it
 * opens every company — but it runs once, on a sign-in that was about to
 * create a company anyway.
 */
function companyHoldingCode(code) {
  const want = String(code || "").trim().toUpperCase();
  if (!want) return null;
  for (const c of db.companies.list()) {
    try {
      const found = db.companies.runAs(c.id, () => {
        const row = db.prepare("SELECT tenant_code FROM settings WHERE id = 1").get();
        return row && String(row.tenant_code || "").trim().toUpperCase() === want;
      });
      if (found) return c.id;
    } catch (e) { /* a company that will not open is not the one */ }
  }
  return null;
}

router.post("/shop-login", async (req, res) => {
  const username = tenants.norm(req.body && req.body.username);
  const password = String((req.body && req.body.password) || "");
  if (!username || !password) {
    return res.status(400).json({ error: "Enter the user ID and password your supplier gave you." });
  }

  const lock = loginLockStatus(req.ip);
  if (lock.locked) {
    return res.status(429).json({ error: `Too many wrong attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).` });
  }

  let row = tenants.get(username);

  /* Known here: decided here, offline, every time. */
  if (row && !row.blocked && tenants.verify(password, row.password_hash)) {
    /* The date is checked HERE, not only when the panel is asked — without
       it an expired demo would sign in for ever, because after the first
       sign-in the panel is never consulted again. */
    const ended = row.expires_on && row.expires_on < todayStr();
    if (!ended) return finish(req, res, row);

    /* BUT A CACHED DATE IS NOT A VERDICT.

       A demo converted to a paid subscription is converted in the panel,
       and this copy still holds the old thirty-day date. Refusing on it
       would lock out a customer on the very day they started paying —
       and they would have no way to tell us apart from a shop whose demo
       really did end. So the vendor is asked once more before anybody is
       turned away. */
    const fresh = await askVendor(username, password);
    if (fresh && fresh.ok && fresh.body) {
      row = tenants.upsert({
        username, companyId: row.company_id,
        shopName: fresh.body.shop || row.shop_name,
        code: fresh.body.code || row.code,
        plan: fresh.body.plan || "paid",
        expiresOn: fresh.body.expiresOn || "",
        password
      });
      if (!(row.expires_on && row.expires_on < todayStr())) return finish(req, res, row);
    }
    if (fresh && !fresh.ok && fresh.body && fresh.body.error) {
      /* The vendor has something specific to say — expired, cancelled —
         and those are the words the shopkeeper was promised. */
      return res.status(403).json({ error: fresh.body.error });
    }

    /* Either the vendor agrees it has ended, or could not be reached. The
       cached date stands. */
    return res.status(403).json({
      error: row.plan === "demo"
        ? "Demo License Expired – Please Contact Admin"
        : "This subscription has ended. Please contact your supplier.",
      expiredOn: row.expires_on, plan: row.plan
    });
  }

  /* Known here but the password did not match — do NOT fall through to the
     panel. A wrong password must not become a second chance at a different
     door, and the panel would answer the same anyway. */
  if (row && !row.blocked) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: WRONG_LOGIN });
  }

  /* Not known here. Ask the vendor, and remember the answer so this is the
     only time it has to be asked. */
  const server = checkin.serverUrl();
  if (!server) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: WRONG_LOGIN });
  }

  let answer = null;
  try {
    const r = await fetch(server.replace(/\/+$/, "") + "/api/tenant-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(20000)
    });
    answer = await r.json().catch(() => null);
    if (!r.ok) {
      recordLoginFailure(req.ip);
      /* The panel's wording is passed through unchanged when it has
         something specific to say — "Demo License Expired – Please Contact
         Admin" is the sentence the shopkeeper was promised. */
      /* 403 means the vendor has something specific to say — expired,
         cancelled — and those words are the ones the shopkeeper was
         promised, so they are passed through. Anything else is a
         refusal, and every refusal says the same thing. */
      if (r.status === 403) {
        return res.status(403).json({ error: (answer && answer.error) || WRONG_LOGIN });
      }
      return res.status(401).json({ error: WRONG_LOGIN });
    }
  } catch (e) {
    /* The vendor is unreachable and we have never seen this login, so there
       is nothing to fall back on. Said plainly rather than as "wrong
       password", which would send them hunting for a password that is fine. */
    return res.status(503).json({
      error: "Could not reach your supplier to check this login, and this is the first time it has been used here. "
           + "Try again when there is internet."
    });
  }

  /* Three places to look before making anything new, because creating a
     company for a shop that already has one is the one mistake here that
     loses a customer's books. */
  let companyId = null;

  /* 1. the tenant map, when it is intact */
  const known = tenants.list().find(t => t.code && answer.code && t.code === answer.code);
  if (known) companyId = known.company_id;

  /* 2. the books themselves, when the map is not */
  if (!companyId) companyId = companyHoldingCode(answer.code);

  /* 3. and only then, a genuinely new shop */
  if (!companyId) {
    const created = db.companies.create({ name: answer.shop || "Shop" });
    companyId = created.id;
  }

  /* Stamped into their own books, so step 2 can find them next time even
     if the map is gone. */
  try {
    db.companies.runAs(companyId, () => {
      db.prepare("UPDATE settings SET tenant_code = ? WHERE id = 1").run(String(answer.code || ""));
    });
  } catch (e) { /* the sign-in still stands; the map covers the usual case */ }

  row = tenants.upsert({
    username, companyId,
    shopName: answer.shop || "",
    code: answer.code || "",
    plan: answer.plan || "paid",
    expiresOn: answer.expiresOn || "",
    /* Hashed here from what they just typed. The panel never sends a hash
       and never sends the password back — this is the only moment the
       plaintext exists on this machine, and it is not kept. */
    password
  });

  return finish(req, res, row);
});

function finish(req, res, row) {
  clearLoginFailures(req.ip);
  tenants.touch(row.username);

  /* Everything downstream reads the company from the session, so this is
     the line that decides whose books the rest of the request sees. */
  req.session.businessId = row.company_id;
  req.session.tenant = {
    username: row.username, companyId: row.company_id,
    shopName: row.shop_name, plan: row.plan, expiresOn: row.expires_on
  };
  /* Stage 1 is not stage 2. Signing the shop in must never leave anybody
     signed in as a person — the staff PIN is still to come. */
  req.session.loggedIn = false;
  req.session.staffId = null;
  req.session.role = null;

  res.json({
    ok: true,
    shop: row.shop_name,
    plan: row.plan,
    expiresOn: row.expires_on,
    /* So the screen can go straight on to the staff list. */
    next: "staff"
  });
}

/** Step back out to the shop sign-in, without ending the whole session. */
router.post("/shop-logout", (req, res) => {
  if (req.session) {
    req.session.tenant = null;
    req.session.businessId = null;
    req.session.loggedIn = false;
    req.session.staffId = null;
    req.session.role = null;
  }
  res.json({ ok: true });
});

// Names only, no PIN hashes — lets the login screen show "who are you"
// before asking for a PIN, without requiring a session yet.
router.get("/staff-list", (req, res) => {
  const staff = db.prepare("SELECT id, name, role FROM staff WHERE active = 1 ORDER BY role DESC, name ASC").all();
  res.json(staff);
});

router.post("/login", (req, res) => {
  const ip = req.ip;
  const lock = loginLockStatus(ip);
  if (lock.locked) {
    return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).` });
  }

  const { staffId, pin } = req.body;
  const staff = staffId && db.prepare("SELECT * FROM staff WHERE id = ? AND active = 1").get(staffId);
  if (!staff || !pin || !verifyPin(String(pin), staff.pin_hash)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  clearLoginFailures(ip);
  req.session.loggedIn = true;
  req.session.staffId = staff.id;
  req.session.staffName = staff.name;
  req.session.role = staff.role;

  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  logAction(req, "login", "");
  res.json({ ok: true, businessName: settings.business_name, staffName: staff.name, role: staff.role });
});

router.post("/logout", (req, res) => {
  logAction(req, "logout", "");
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/session", (req, res) => {
  const settings = db.prepare("SELECT business_name FROM settings WHERE id = 1").get();
  const loggedIn = !!(req.session && req.session.loggedIn);
  res.json({
    loggedIn, businessName: settings.business_name,
    staffName: loggedIn ? req.session.staffName : null,
    role: loggedIn ? req.session.role : null
  });
});

module.exports = router;
