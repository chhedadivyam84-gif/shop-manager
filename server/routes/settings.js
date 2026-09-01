const express = require("express");
const db = require("../db");
const { logAction } = require("../util");
const { requireRole } = require("../auth");

const router = express.Router();

/**
 * The settings row as the BROWSER may see it.
 *
 * Everything this returns is handed to any signed-in person, staff
 * included — so anything secret has to be removed here, by name, and this
 * is the only place that decision is made.
 *
 * gst_credentials holds a GSP's API secret. It is written from the Settings
 * screen and never read back: the screen asks the status endpoint whether a
 * credential is SET, which is all anybody needs to see. A screen that
 * displays "sk_live_abc…" also teaches people it is normal for a key to be
 * on screen, which is how keys end up in screenshots and WhatsApp messages.
 */
function publicSettings() {
  const s = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  const { pin_hash, gst_credentials, ...rest } = s;
  return rest;
}

router.get("/", (req, res) => {
  res.json(publicSettings());
});

// Printed-document themes. Validated against this list rather than stored as
// free text: an unrecognised value would reach the print CSS as a class that
// matches nothing, silently printing an unstyled document.
const PRINT_THEMES = ["classic", "tally", "navy", "minimal", "tallyfull"];
const cleanTheme = (v, fallback) => (PRINT_THEMES.includes(v) ? v : fallback);

router.put("/", requireRole("owner"), (req, res) => {
  const { businessName, tagline, address, phones, gstin, state, upiId, email, website,
          invoiceTheme, challanTheme, allowNegativeStock,
          bankName, bankAccountNo, bankIfsc, bankBranch,
          invoiceTitle, challanTitle, footerMessage, showCopyLabel, pinCode,
          headerScales } = req.body;
  const current = db.prepare("SELECT * FROM settings WHERE id = 1").get();

  db.prepare(`
    UPDATE settings SET business_name=?, tagline=?, address=?, phones=?, gstin=?, state=?, upi_id=?, email=?, website=?,
      invoice_theme=?, challan_theme=?, allow_negative_stock=?,
      bank_name=?, bank_account_no=?, bank_ifsc=?, bank_branch=?,
      invoice_title=?, challan_title=?, footer_message=?, show_copy_label=?, pin_code=?,
      header_scales=? WHERE id=1
  `).run(
    (businessName || current.business_name).trim(), (tagline ?? current.tagline),
    (address ?? current.address), (phones ?? current.phones), (gstin ?? current.gstin),
    (state ?? current.state), (upiId ?? current.upi_id),
    (email ?? current.email), (website ?? current.website),
    invoiceTheme === undefined ? (current.invoice_theme || "classic") : cleanTheme(invoiceTheme, current.invoice_theme || "classic"),
    challanTheme === undefined ? (current.challan_theme || "classic") : cleanTheme(challanTheme, current.challan_theme || "classic"),
    allowNegativeStock === undefined ? current.allow_negative_stock : (allowNegativeStock ? 1 : 0),
    // The shop's OWN bank, printed in the Bank Details box so a customer knows
    // where to pay. Nothing here touches the Bank Book's accounts — those
    // record money moving, these are just four lines of text on paper.
    (bankName ?? current.bank_name), (bankAccountNo ?? current.bank_account_no),
    (bankIfsc ?? current.bank_ifsc), (bankBranch ?? current.bank_branch),
    // A blank title would print a bill with no heading at all, so an empty
    // string keeps what is already stored rather than saving nothing.
    ((invoiceTitle ?? "").trim() || current.invoice_title),
    ((challanTitle ?? "").trim() || current.challan_title),
    // The footer, by contrast, is allowed to be blank — some shops want no
    // closing line at all.
    (footerMessage ?? current.footer_message),
    showCopyLabel === undefined ? current.show_copy_label : (showCopyLabel ? 1 : 0),
    /* The shop's postal PIN code. The e-invoice and e-way bill portals both
       require it, and both validators here refuse a bill without one — but
       there was nowhere to enter it. The column existed, this route ignored
       it, and no screen offered a field, so the app told shops to fix
       something in "Settings → PIN code" that did not exist. Digits only,
       six of them, so a typed space or a dash cannot reach the portal. */
    ((pinCode ?? "").toString().replace(/\D/g, "").slice(0, 6) || current.pin_code || ""),
    /* Clamped 0.5-2.0 on the way in, so a value posted by hand cannot
       produce a letterhead three feet tall or one too small to read.
       Anything unparseable leaves what is already stored alone. */
    (() => {
      if (headerScales === undefined) return current.header_scales || "";
      let obj = headerScales;
      if (typeof obj === "string") {
        try { obj = JSON.parse(obj); } catch (e) { return current.header_scales || ""; }
      }
      if (!obj || typeof obj !== "object") return "";
      const out = {};
      ["name", "tag", "addr", "gst", "phone", "email", "web"].forEach(k => {
        const n = Number(obj[k]);
        if (Number.isFinite(n)) out[k] = Math.max(0.5, Math.min(2, n));
      });
      return JSON.stringify(out);
    })()
  );

  logAction(req, "settings.update", "");
  res.json(publicSettings());
});

/**
 * Numbering: read/set where the Estimate and Delivery Challan series
 * currently stand, so an owner switching from paper records can make the
 * NEXT digital number continue on from their last paper one instead of
 * restarting at 1. Both series print as "SP" + 7 digits (SP0000001…) on
 * their OWN independent counters — the same literal number can come up on
 * both an Estimate and a Challan at once; the document banner (ESTIMATE
 * CHALLAN vs DELIVERY CHALLAN) is what tells them apart, not the number.
 *
 * The stored counter is always "the last number ISSUED", not "the next
 * one" — nextDocNo() in routes/invoices.js reads it and adds 1. Setting a
 * new starting point of N therefore writes N-1 here, so the very next
 * document created is exactly N.
 */
function readCounter(name) {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(name);
  return row ? row.value : 0;
}
function writeCounter(name, value) {
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(name, value);
}
function formatDocNo(n) {
  return "SP" + String(n).padStart(7, "0");
}

router.get("/numbering", requireRole("owner"), (req, res) => {
  res.json({
    nextEstimateNo: formatDocNo(readCounter("estimate-no") + 1),
    nextChallanNo: formatDocNo(readCounter("challan-no") + 1)
  });
});

router.put("/numbering", requireRole("owner"), (req, res) => {
  const { nextEstimateNumber, nextChallanNumber } = req.body;
  const result = {};

  if (nextEstimateNumber !== undefined && nextEstimateNumber !== "") {
    const n = parseInt(nextEstimateNumber, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "Next Estimate No. must be a positive whole number." });
    writeCounter("estimate-no", n - 1);
    result.nextEstimateNo = formatDocNo(n);
  }
  if (nextChallanNumber !== undefined && nextChallanNumber !== "") {
    const n = parseInt(nextChallanNumber, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "Next Challan No. must be a positive whole number." });
    writeCounter("challan-no", n - 1);
    result.nextChallanNo = formatDocNo(n);
  }

  logAction(req, "settings.numbering",
    `Next Estimate: ${result.nextEstimateNo || "(unchanged)"}, Next Challan: ${result.nextChallanNo || "(unchanged)"}`);
  res.json(result);
});

/**
 * Bill Print Settings — paper, which columns print, whether rates show.
 *
 * Shop-wide rather than per device, because "Save as Default" on a bill means
 * "this is how our bills look", not "how this one PC prints". Report print
 * settings stay per device for the opposite reason: those genuinely differ
 * between the counter PC and the warehouse phone.
 *
 * Stored as opaque JSON. The client owns the shape and validates it on read
 * (see billPrefs in app.js) — the important thing here is that nothing but
 * presentation can get in, so this can never affect a figure on a bill.
 */
router.put("/print-prefs", requireRole("owner"), (req, res) => {
  const { printPrefs } = req.body;
  let parsed;
  try {
    parsed = JSON.parse(printPrefs);
  } catch (e) {
    return res.status(400).json({ error: "Print settings could not be read." });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return res.status(400).json({ error: "Print settings could not be read." });
  }
  // Re-serialised from the parsed object rather than storing the raw string,
  // so whatever lands in the column is always valid JSON this app wrote.
  db.prepare("UPDATE settings SET print_prefs = ? WHERE id = 1").run(JSON.stringify(parsed));
  logAction(req, "settings.printPrefs", "");
  res.json({ ok: true, printPrefs: JSON.stringify(parsed) });
});

/**
 * The shop's logo, as a data URI, printed at the top-left of every bill.
 *
 * Stored in the database rather than as a file on disk on purpose: the whole
 * app backs up and restores by copying one .db file, so a logo kept beside it
 * as a loose file would quietly vanish on the first restore — and nobody
 * notices a missing logo until a customer is holding the bill.
 *
 * Kept small deliberately. A 2 MB photograph would be read out of the database
 * and pushed into the page on every single print; a logo has no need to be
 * more than a few tens of kilobytes at the size it prints.
 */
const LOGO_MAX_BYTES = 400 * 1024;

/* The covering note that goes above a purchase order on WhatsApp.

   Capped rather than unlimited: this is a greeting, and a message long
   enough to push the order itself off a phone screen defeats the point
   of sending it. Blank restores the built-in wording. */
router.put("/po-wa-template", requireRole("owner"), (req, res) => {
  const t = String(req.body.template == null ? "" : req.body.template);
  if (t.length > 1000) {
    return res.status(400).json({ error: "That message is too long — keep it under 1000 characters." });
  }
  db.prepare("UPDATE settings SET po_wa_template = ? WHERE id = 1").run(t.trim());
  logAction(req, "settings.poWaTemplate", t.trim() ? "set" : "cleared");
  res.json({ ok: true, template: t.trim() });
});

/* The app's colour scheme.

   Its own route rather than another field on PUT /settings, matching
   /numbering, /print-prefs and /logo below: that handler rewrites twenty
   columns in one statement, and threading a twenty-first through it to
   change a colour risks the other nineteen.

   Validated against the list rather than stored as free text. An
   unrecognised value would reach the page as a class that matches
   nothing, and the app would come up unstyled. */
const APP_THEMES = ["navy-gold", "forest-brass", "maroon-gold", "teal-copper",
                    "indigo-amber", "charcoal-gold", "plum-rose"];

router.put("/app-theme", requireRole("owner"), (req, res) => {
  const t = String(req.body.theme || "").trim();
  if (t && !APP_THEMES.includes(t)) {
    return res.status(400).json({ error: "That colour scheme is not one this app knows." });
  }
  db.prepare("UPDATE settings SET app_theme = ? WHERE id = 1").run(t);
  logAction(req, "settings.appTheme", t || "default");
  res.json({ ok: true, theme: t, themes: APP_THEMES });
});

/**
 * Which Home tiles this shop has put away.
 *
 * Owner only: it is the whole shop's front screen, not one person's, and a
 * counter hand rearranging it for everybody is a support call.
 *
 * Stored as the HIDDEN list. Nothing is validated against a fixed set of
 * keys on purpose — the tiles are the app's own markup and a version that
 * adds one should not need this route changed too. A key that no longer
 * matches a tile simply hides nothing, which is the harmless outcome.
 */
router.put("/home-tiles", requireRole("owner"), (req, res) => {
  const keys = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim())
    .filter(k => /^[a-z0-9-]{1,32}$/.test(k)))].sort();
  const hidden = keys(req.body.hidden);
  const added  = keys(req.body.added);
  db.prepare("UPDATE settings SET home_tiles_hidden = ?, home_tiles_added = ? WHERE id = 1")
    .run(hidden.join(","), added.join(","));
  logAction(req, "settings.homeTiles",
    `${hidden.length} put away, ${added.length} added`);
  res.json({ ok: true, hidden, added });
});

router.put("/logo", requireRole("owner"), (req, res) => {
  const { logo } = req.body;

  // An explicit null is "remove the logo" — a real instruction, not a mistake,
  // and the only way back to a plain header once one has been set.
  if (logo === null || logo === "") {
    db.prepare("UPDATE settings SET logo_data = '' WHERE id = 1").run();
    logAction(req, "settings.logo", "Logo removed");
    return res.json({ ok: true, hasLogo: false });
  }

  if (typeof logo !== "string" || !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(logo)) {
    return res.status(400).json({ error: "That does not look like an image. Choose a PNG, JPG or SVG file." });
  }
  // Rough decoded size — base64 carries 3 bytes in every 4 characters.
  const approxBytes = Math.floor((logo.length - logo.indexOf(",") - 1) * 0.75);
  if (approxBytes > LOGO_MAX_BYTES) {
    return res.status(400).json({
      error: `That image is about ${Math.round(approxBytes / 1024)} KB. Please use one under ${LOGO_MAX_BYTES / 1024} KB — a logo prints at around 2 cm, so a small file is plenty.`
    });
  }

  db.prepare("UPDATE settings SET logo_data = ? WHERE id = 1").run(logo);
  logAction(req, "settings.logo", `Logo set (${Math.round(approxBytes / 1024)} KB)`);
  res.json({ ok: true, hasLogo: true });
});

module.exports = router;
