/* ============================================================
   ADMIN PANEL — the API behind the panel

   PART 1 is the shell, so this router exposes exactly ONE thing:
   /me, which tells the page who it is talking to and what sections it
   may draw. That is the same role GET /permissions/me plays for the
   shop app, and it is deliberately the ONLY contract the page reads:
   the sidebar is built from the server's answer, so a section can never
   appear on screen that the server would then refuse.

   No business data is read or written here. Nothing in this file
   touches an invoice, a product, a cash entry or a customer.

   Mounted in index.js as:
     app.use("/api/admin", requireAuth, adminAccess.gate(), router)
   which puts it below the company binder, the licence gate, the
   financial-year lock, the owner-only DELETE gate and the feature gate
   — all five for free, and all five lost if it were ever moved out of
   /api. See the note on the mount.
   ============================================================ */
const express = require("express");
const adminAccess = require("../adminAccess");

const router = express.Router();

/* Hoisted to module scope, as routes/cashbook.js does, so the gate a
   route uses is visible on the route's own line. */
const mayManage = adminAccess.require("admin.manage");

/* ------------------------------------------------------------------
   WHO AM I

   Literal route, declared above anything with a parameter.
   ------------------------------------------------------------------ */
router.get("/me", (req, res) => {
  const me = adminAccess.describe(req);
  res.json({
    role: me.role,
    caps: me.caps,
    sections: me.sections,
    groups: me.groups,
    previewing: me.previewing,
    /* The shop's own name, for the sidebar lockup. Safe to read here —
       this router is inside /api, so the company binder applies. */
    businessName: businessName(),
    staffName: (req.session && req.session.staffName) || "",
  });
});

/* The roles the panel is structured for, and which capabilities each
   holds. Read-only, and owner-only: it describes the shape of the
   permission system, which is not something a support login needs. */
router.get("/roles", mayManage, (req, res) => {
  res.json({
    roles: adminAccess.ADMIN_ROLES,
    caps: adminAccess.CAPS,
    /* Which of them can actually be held today. See adminAccess.js for
       why the other two have no carrier yet. */
    active: ["OWNER"],
  });
});

function businessName() {
  try {
    const db = require("../db");
    const s = db.prepare("SELECT business_name FROM settings WHERE id = 1").get() || {};
    return s.business_name || "";
  } catch (e) {
    return "";
  }
}

module.exports = router;
