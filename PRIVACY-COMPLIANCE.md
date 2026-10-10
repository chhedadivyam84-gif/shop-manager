# Privacy and compliance readiness

For the operator. Not legal advice, and not a certificate of compliance —
a map of what the software actually does with personal data, what has been
built to protect it, and what still needs a decision, a detail, or a lawyer.

The public pages are in `public/legal/` and are served at `/legal/`.
**They are drafts** and say so on screen until the placeholders are filled
and the flagged clauses reviewed.

Three kinds of statement in this file, kept apart on purpose:

- **Implemented** — in the code, and covered by `test/privacy.test.js`
- **Policy** — what the published pages say; tested against the code where
  the code can confirm it
- **Owed** — a detail to supply, a dashboard setting, or a legal question

---

## 1. Data inventory

Every category below was confirmed in the code, not assumed.

| Category | Examples | Purpose | Stored | Who can see it | Retention | Leaves the app to |
|---|---|---|---|---|---|---|
| Business profile | name, GSTIN, address, bank details, logo | invoices, GST documents | company `shop.db` | owner; staff per permission | while in use | hosting, backups |
| Staff sign-in | name, role, permissions, **PIN as scrypt hash** | access control | `shop.db` (`staff`) | owner | until removed | hosting, backups |
| Customers | name, phone, address, GSTIN, state, PIN code, credit limit, amount owed, WhatsApp group links | billing, delivery, credit | `shop.db` | staff with `customer` permission | until deleted; **not deletable with transactions** | hosting, backups, AI (names and amounts only — never phone) |
| Suppliers | as customers | purchasing | `shop.db` | staff with `supplier` permission | as customers | hosting, backups |
| Products and stock | names, sizes, prices, quantities | selling, stock | `shop.db` | staff with `product`/`stock` | until deleted (force-delete keeps invoice line names) | hosting, backups, AI |
| Sales, purchases, money | invoices, payments, cash, bank, cheques | accounts, GST | `shop.db` | per permission | **≥ 72 months (GST)** | hosting, backups, AI (totals), GSP (e-way bill) |
| Employees and pay | attendance, salary, advances | payroll | `shop.db` | **owner only** | while in use | hosting, backups |
| Payment attachments | photos, documents | proof of payment | `data/uploads/payments/` | per permission | until removed | hosting, **backup store** |
| Supplier bill photos | the photo | purchase entry | sent, not kept | the user scanning | not kept by the app | **Google** |
| Printed copies | PDFs | reprinting | `data/print-archive/` | operator | on hosted copies, cleared each deploy | hosting |
| Activity record | who did what, names | accountability | `audit_log` | owner | **permanent — append-only by trigger** | hosting, backups |
| Sessions | random id cookie | staying signed in | `sessions.db` | — | 30 days | hosting |
| IP addresses | request IP | rate limit, PIN lockout | memory | — | not persisted | hosting logs |
| Licence check-in | activation code, install id, version, IP | subscription | **licence panel** | operator | 90 days | the operator's panel |
| Hosted shop sign-in | user ID, password (hashed at the panel) | multi-shop sign-in | panel `customers` | operator | until account removed | the operator's panel |
| Assistant | question, up to 25 matching records | answers | **not stored** | per permission | not kept | **Google** |
| Voice | audio → text | spoken questions | **never recorded** | — | not kept | **the browser's speech service** (Chrome: Google) |
| E-way bill | invoice details | GST e-way bill | — | per permission | — | **GSP**, only if configured |
| WhatsApp | a message the user chooses to send | sharing bills | — | the user | — | **WhatsApp**, only on a tap |

**Not present, confirmed:** analytics, advertising, trackers, any third-party
script (the Content-Security-Policy allows `script-src 'self'` only), server-
sent WhatsApp, email sending, selling or sharing of data.

---

## 2. Privacy controls

### Implemented in this change

| Control | What it fixes | Test |
|---|---|---|
| **Error log no longer prints request bodies** | `console.error(err)` printed `err.body` — the raw body Express attaches when JSON fails to parse. A garbled sign-in wrote the **PIN** into Render's logs. Confirmed by sending one. Now `server/logSafe.js` logs type, route and code location only; quoted text and long digit runs are scrubbed from messages | yes |
| Malformed requests get **400**, not 500 | they are the caller's error, and say so | yes |
| Data-wipe log names the **staff ID**, not the name | the name is already in the audit log; the host's logs don't need it | yes |
| **Assistant sends no phone numbers to Google** | search and "who owes" returned phones to the model; no answer needs them | yes |
| **Assistant says what it sends**, under the box where questions are typed | transparency at the moment it matters | yes |
| **AI key box warns about Google's free tier** | free-tier requests may be read by Google and used for training; the Assistant sends customer names and amounts | yes |
| Policy pages, linked from the **sign-in screen** and the Assistant | reachable before anyone signs in | yes |

### Already in place, verified

- one database per business; the session decides which, never the request
- permissions checked on the server for every route and every AI lookup
- PINs and passwords stored only as scrypt hashes; AI keys sealed
- export and backup download are **owner-only**
- customers and suppliers **with transactions cannot be deleted**
- HTTPS-only in production (HSTS), CSP, frame protection, rate limits
- append-only activity log

### Deliberately not built

- **Erasing a customer who has transactions.** Their invoices must be kept
  for GST, and a tax invoice must show the recipient. Anonymising the
  customer would change what past invoices print. Deactivation is offered
  instead, and the policy says so rather than promising erasure.
- **A consent banner.** The only cookie is the essential session cookie;
  there is no analytics or advertising to consent to. A banner would ask
  people to agree to nothing.
- **Account self-deletion for a business.** It would remove GST records the
  business is obliged to keep. Handled by request instead.

---

## 3. Indian law — the position as of 9 October 2026

Verified by search on that date. Check again before relying on it.

### Digital Personal Data Protection Act, 2023 and Rules, 2025

The Rules were notified on **13 November 2025** (G.S.R. 846(E)) and commence
in three stages:

| From | What |
|---|---|
| 13 Nov 2025 | Data Protection Board provisions |
| 13 Nov 2026 | Consent Manager registration |
| **13 May 2027** | **the operative obligations** — notice, consent, security safeguards, breach notification, data principals' rights |

**So the main DPDP obligations are not in force yet — and are about seven
months away.** They should be built toward now.

### Information Technology Act, 2000 — section 43A and the SPDI Rules, 2011

**Still in force** until section 44(2) of the DPDP Act omits section 43A —
in the same May 2027 tranche. They apply now. Relevant because this app holds
**passwords** and **bank account details**, both "sensitive personal data or
information" under those Rules, which require a published privacy policy, a
named grievance officer, and reasonable security practices.

### CGST Act, 2017 — section 36 and Rule 56

Books, invoices, credit and debit notes and delivery challans must be kept
for **72 months from the due date of the annual return** for the year — longer
while proceedings are open. This is why sold-on customers cannot be deleted.

### CERT-In Directions, 28 April 2022

Report certain cyber incidents within **6 hours**; keep logs for **180 days,
in India**. Applies to body corporates among others. Render's log retention
and location have **not** been checked against this.

---

## 4. Owed by the operator

### Details to supply (placeholders on the pages)

`[OPERATOR LEGAL NAME]` · `[REGISTERED ADDRESS]` · `[PRIVACY EMAIL]` ·
`[SUPPORT EMAIL]` · `[SUPPORT PHONE]` · `[GRIEVANCE OFFICER NAME]` ·
`[GRIEVANCE OFFICER EMAIL]` · `[ACKNOWLEDGEMENT TIME]` · `[RESOLUTION TIME]` ·
`[EFFECTIVE DATE]` · `[HOSTING REGION]` · `[CITY]` · `[NOTICE PERIOD]` ·
`[FEES, BILLING CYCLE AND RENEWAL TERMS]` · `[GRACE DAYS]` ·
`[WITHIN HOW MANY DAYS]` · `[HOW CHANGES ARE NOTIFIED]` ·
`[WARRANTY DISCLAIMER AND LIMITATION OF LIABILITY]`

Then remove the "Draft — not yet in force" banner from each page.

### Things only the operator can do

1. **Use a billed Google Cloud project** for the AI key — not the free tier.
2. **Find the hosting region** in Render (Service → Settings) and put it in
   `[HOSTING REGION]`.
3. **Check Render's log retention** against CERT-In's 180 days.
4. **Consider a Data Processing Addendum** with Google, Cloudflare,
   Supabase and Render — they are sub-processors of every shop's data.

---

## 5. For a qualified lawyer

Marked on the pages as **"For legal review"**:

1. **Fiduciary or processor?** For shop records the operator is probably a
   processor; for business accounts possibly a fiduciary. Needs confirming,
   and a data-processing agreement in the Terms.
2. **SPDI consent** for collecting passwords and bank details.
3. **Reasonable security practices** — do the implemented measures meet the
   standard?
4. **Cross-border transfers** — hosting, backups and AI are outside India.
5. **AI disclosure** — must a shop tell its customers their names and
   amounts owed go to an AI provider?
6. **The append-only activity log** keeps names after deletion — reconcile
   with the right to erasure.
7. **Retention after a business leaves** — who keeps the GST records.
8. **Warranty and liability** — left blank on purpose.
9. **Governing law and disputes.**
10. **CERT-In** — whether it applies, and the log requirements.
11. **Grievance timelines** under SPDI now and DPDP from May 2027.

---

## 6. Keeping the pages honest

`test/privacy.test.js` reads the code and the pages together, and fails if
they disagree on the numbers that can be checked: backup counts, session
length, the AI row limit, the Assistant rate limit, the services contacted,
the absence of trackers. Change one without the other and it fails. It runs
as part of `tools/release-check.js`.
