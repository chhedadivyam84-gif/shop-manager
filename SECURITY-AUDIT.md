# Security & compliance readiness audit — 10 October 2026

Scope:
- the shop app (`shop-manager`; Node/Express 5 + `node:sqlite`, Render, Cloudflare R2 backups)
- its resale copy (`shop-manager1`; same code, multi-tenant)
- the licence panel (`shop-manager-licence`; Express 4, Render, R2/Supabase)

Every finding below was reproduced, not assumed. Every fix has a test, and each test was proven to fail without its fix.

## Findings

| # | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| 1 | **High** | Staff permissions were enforced only by hiding screens. A staff login with **no permissions** could read every customer and supplier (phones, dues), every invoice and purchase, the Outstanding report, the bank book, the dashboard's cash and bank balances, and could **create** customers and suppliers. | Probe against a throwaway copy: 200 on `/api/customers`, `/suppliers`, `/invoices`, `/purchases`, `/accounting/outstanding-details`, `/bankbook`, `/bank-accounts`, `/reports/dashboard`; 201 on POST `/customers`, `/suppliers` | **Fixed** — `server/permissionGate.js` |
| 2 | **High** | The licence panel's shop sign-in (`POST /api/tenant-login`) had **no brute-force limit**: unlimited password guesses from the internet. | Code review; there was no counter on the route | **Fixed** — 5 wrong per login per address, then 15 min; 30 wrong per login from anywhere in an hour, then 15 min, plus a vendor alert |
| 3 | Medium | Attachments (receipt and cheque photos) were served to **any signed-in user of any shop** who had the file name. On a shared installation, one shop could open another's receipts. Names are random (64-bit), so it was not guessable — but a seen name was enough. | `routes/attachments.js` served any file in the shared folder | **Fixed** — served only if a payment or bank entry in the requester's own business names it |
| 4 | Medium | An upload's type was taken from its own label, so a web page labelled `image/png` was stored and served from the app's address. | `attachments.js` checked only the declared MIME type | **Fixed** — the first bytes are checked (JPEG/PNG/WEBP/PDF signatures) |
| 5 | Medium | Sync address could point the **shared server** at internal addresses (loopback, private, cloud-metadata `169.254.169.254`). Partial replies came back in the error text. https was already required, which limited this. | `sync.js` accepted any https host | **Fixed** — private, loopback, link-local and unqualified hosts are refused, both when saved and when used |
| 6 | Medium | Licence panel sent **no security headers**: no frame protection (clickjacking of Approve/Cancel), no content policy, no HSTS. | `server.js` set none | **Fixed** — CSP, `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS on Render |
| 7 | Medium | Panel session cookie was not marked `Secure` on Render: it keyed on `NODE_ENV=production`, which is not set on that service. | `secure: process.env.NODE_ENV === "production"` | **Fixed** — `Secure` whenever `RENDER` is set |
| 8 | Medium | Panel had **no lockfile**. Render installed whatever versions matched `^4`, while this PC had **Express 5**, so every panel test ran on a different Express from production. | No `package-lock.json`; `node_modules/express` 5.2.1 vs `^4.21.2` | **Fixed** — lockfile added (Express 4.22.3); all panel suites re-run on Express 4 |
| 9 | Low (not exploitable here) | `proxy-addr` 2.0.7 (critical advisory GHSA-jqcg-44mw-7w3h, IP spoofing via an IPv4-mapped trust subnet). The panel trusts one proxy hop, not a subnet. | `npm audit` once a lockfile existed | **Fixed** — 2.0.8 in the lockfile; `npm audit`: 0 |

### Second pass — same day

| # | Severity | Finding | Status |
|---|---|---|---|
| 10 | **High** | WRITES the gate did not yet cover were open to any staff login with any permission: creating and editing products, correcting stock by hand, stock-in, opening stock, stock transfers, sales and purchase returns, cheques, e-way-bill and e-invoice filing (which uses the shop's GST portal credentials), Bill Scanner (paid per scan), and exports. | **Fixed** — 15 more areas in `permissionGate.js`, each needing its own module (e.g. hand stock corrections need Stock with Edit). Test: a salesman's stock correction is refused and the stock does not move; stock staff can still do it |
| 11 | Low | The sync address check did not resolve names, so a public name pointing at a private address got through. | **Fixed** — every address the name resolves to must be public, checked before connecting |
| — | (verified) | Owner actions are refused to staff, **even a staff login given every permission**: adding logins, promoting itself, changing the owner's PIN, editing permissions, preview, colour, backups, data reset, new business, staff pay, activity log, delete, shop-wide notices, licence activation. | `test/admin-actions.test.js` against the real server: 22/22 |

## Checked and found sound

- **Shop isolation:** one SQLite file per business, bound from the session. A shared-installation shop is pinned to its own business twice, staff cannot switch business, and an invoice id from another business gives 404 (tested).
- **Sign-in and sessions:**
  - PINs and passwords are hashed.
  - Lockout: 5 tries per account per address.
  - A fresh session ID is issued at sign-in (stops session fixation).
  - Cookies are httpOnly, SameSite=Lax and Secure in production.
  - There is no CORS middleware.
- **Owner-only actions:** delete is owner-only for the whole API, ahead of every route. Void, reset, staff, backups, employees and settings writes are owner-only.
- **SQL:** user values are parameterised throughout. No string-built SQL from request input was found.
- **Content Security Policy:** `script-src 'self'`. Front-end output goes through `escapeHtml`.
- **AI Assistant:** read-only. It has no write statements; every lookup is re-checked against the person's permissions on the server; phone numbers are not sent to Google; 20 questions a minute.
- **Errors and logs:** errors do not leak stack traces, request bodies or PINs into logs (fixed 9 Oct).
- **Dependencies:** shop app 3 production dependencies, `npm audit` 0. Panel 0 after the lockfile.
- **Secrets:** no committed secrets (pattern scan of all three repos). The vendor signing key is in the environment only.
- **Backups:**
  - Every 15 minutes plus at shutdown, to R2.
  - Restore is verified on every deploy: the Render logs show the restore line each time.
  - `tools/verify-backup.js`, `test/restore.test.js` and the handover test exist; staging boots the release on a copy of real books.

## Not fixed — needs your decision or more work

1. **"Own data only" scopes are not enforced anywhere — on screen OR on the server.** A salesman set to "Own Only" sees every salesman's bills. This needs **your decision, not just a fix**: a staff member with no scope set counts as "Own Only", so turning it on would immediately hide colleagues' bills from everyone at the counter who looks them up or reprints them. Once you decide what each login should see, it's a filter on the invoice, quotation and order lists.
2. **Sync names are checked once, before connecting.** A name that changes its address between the check and the connection is not covered. Low risk: https is required and only the owner sets it.
3. **Backups are not encrypted by the app.** Cloudflare R2 encrypts at rest, and the bucket is private. Anyone holding the R2 keys can read every shop's books.
4. **No restore drill against the live bucket from here.** This PC has no cloud credentials. Restores are proven on every deploy, in the Render logs, and in tests against a stand-in.
5. **The deploy catch-up** keeps reporting "work already entered" after deploys (a separate investigation is running).
6. **Log retention on Render** (free tier: short) is below CERT-In's 180 days, if those directions apply to you.
7. **Activity log is append-only.** Names stay after a customer's deletion. This is a deliberate security trade-off, flagged for legal review in `PRIVACY-COMPLIANCE.md`.

## India — legal readiness (technical summary, not legal advice)

| Requirement | Status for this app | In force |
|---|---|---|
| IT Act s.43A + SPDI Rules 2011: reasonable security practices; a published privacy policy for sensitive data (passwords, financial info); a grievance officer | Draft policy pages at `/legal/`. **Grievance officer and your details still to be filled in.** | **Now**, until the DPDP Act's operative provisions replace them |
| DPDP Rules 2025 — Board and definitions (Rules 1, 2, 17–21) | Nothing for you to file | 13 Nov 2025 |
| DPDP — Consent Managers (Rule 4) | Not applicable unless you act as one | 13 Nov 2026 |
| DPDP — notice, consent, security safeguards, breach notification (Board and each person), rights (access, correction, erasure), grievance handling, retention and erasure | Partly ready: policies drafted; erasure limited by GST record-keeping; no breach-notification procedure; no rights-request workflow in the app | 13/14 May 2027 — **but MeitY proposed (Jan 2026) shortening this to 12 months (13 Nov 2026). Not notified as of Sept 2026; check the Gazette.** |
| CGST s.35/36, Rule 56: keep accounts 72 months | Retention page states it; customers on bills cannot be deleted | Now |
| CERT-In Directions (28 Apr 2022): report specified incidents within 6 hours; keep logs 180 days; name a point of contact | Not ready: no incident-reporting procedure, no point of contact, log retention short on Render free tier | In force (MSME deferral ended 25 Sep 2022). **Whether it applies to you needs a lawyer.** |

**For a lawyer:**
- Your role for each shop's data: data fiduciary, or processor for the shops.
- Whether CERT-In applies to you.
- Cross-border storage (R2 and Google Gemini).
- Whether shops must tell their customers about the AI.
- The append-only activity log versus erasure rights.
- Breach-notice wording.
- Liability in the terms of use.

These are technical findings and recommendations. They are not a legal opinion or a certification.
