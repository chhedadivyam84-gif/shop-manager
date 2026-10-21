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
| Employees and pay | name, mobile, job role, joining date, attendance, salary, advances | payroll | `shop.db` | **owner only** | while in use | hosting, backups |
| Payment attachments | photos, documents | proof of payment | `data/uploads/payments/` | per permission | until removed; **the off-site copy is never removed automatically** | hosting, **backup store** |
| Supplier bill photos | the photo | purchase entry | sent, not kept | the user scanning | not kept by the app | **Google** |
| Printed copies | PDFs | reprinting | `data/print-archive/` | operator | on hosted copies, cleared each deploy | hosting |
| Activity record | who did what, names | accountability | `audit_log` | owner | **permanent — append-only by trigger** | hosting, backups |
| Sessions | random id cookie | staying signed in | `sessions.db` | — | 30 days | hosting |
| IP addresses | request IP | rate limit, PIN lockout | memory | — | not persisted | hosting logs |
| Licence check-in | activation code, install id, version, IP | subscription | **licence panel** | operator | 90 days | the operator's panel |
| Hosted shop sign-in | user ID, password (hashed at the panel) | multi-shop sign-in | panel `customers`; shop `tenants.db` | operator | until account removed | the operator's panel, **backup store** |
| Business account | shop name, contact name, phone, email, city, GSTIN, plan and dates | subscription, support | licence panel `customers` | operator | until removed by the operator | the panel's backup store |
| Email alerts | the alert text | owner notifications | not stored | the owner | not kept | **Resend**, only if `EMAIL_API_KEY` is set; only to the business's own address |
| Backups | complete database copies | recovery | R2 / Supabase | operator | **96 runs + newest per day for 30 days + newest per month for 12 months** (since 18 Oct 2026) | backup store |
| Assistant | question, up to 25 matching records | answers | **not stored** | per permission | not kept | **Google** |
| Voice | audio → text | spoken questions | **never recorded** | — | not kept | **the browser's speech service** (Chrome: Google) |
| E-way bill | invoice details | GST e-way bill | — | per permission | — | **GSP**, only if configured |
| WhatsApp | a message the user chooses to send | sharing bills | — | the user | — | **WhatsApp**, only on a tap |

**Not present, confirmed:** analytics, advertising, trackers, any third-party
script (the Content-Security-Policy allows `script-src 'self'` only), server-
sent WhatsApp, selling or sharing of data. Email sending exists but is **off**
until the operator sets a provider key, and only ever mails the business's own address.

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

## 3. Indian law — the position as of 18 October 2026

Re-checked on 18 Oct 2026 against the **official texts**, not commentary:

- DPDP Rules, 2025 — Gazette of India, G.S.R. 846(E), 13 Nov 2025:
  https://egazette.gov.in/WriteReadData/2025/267650.pdf (rule 1, commencement;
  rule 6, security safeguards; rule 7, breach intimation; rule 14, rights and
  grievances — read from the PDF itself)
- CERT-In Directions under s.70B(6), 28 Apr 2022, with FAQs (May 2022) and the
  MSME extension (27 Jun 2022): https://www.cert-in.org.in/Directions70B.jsp
  (the directions were read from the PDF itself)

MeitY's site (meity.gov.in) refused automated reading (HTTP 403), so it was
not read. **No amendment changing the commencement dates was found.** A
proposal to bring the main duties forward to 13 Nov 2026 is reported in
commentary but was **not found notified**. Check the eGazette again before
13 Nov 2026.

### Digital Personal Data Protection Act, 2023 and Rules, 2025

The Rules were notified on **13 November 2025** (G.S.R. 846(E)). Rule 1 reads:
rules 1, 2 and 17–21 on publication; rule 4 one year after; rules 3, 5–16, 22
and 23 eighteen months after. That gives three stages:

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

Read from the directions themselves:

- **(ii)** report the incidents in Annexure I to CERT-In **within 6 hours** of
  noticing them: incident@cert-in.org.in, phone 1800-11-4949, fax 1800-11-6969
- **(iii)** designate a **Point of Contact** and send CERT-In its details (Annexure II)
- **(iv)** keep logs of all ICT systems for a rolling **180 days, within Indian
  jurisdiction**
- **(i)** synchronise clocks to NIC/NPL NTP, or to a source that does not deviate
  from them

They apply to "service providers, intermediaries, data centres, body corporate
and Government organisations". The operator, as a business providing an online
service, is likely to be covered, but that needs confirming. Enforcement for
MSMEs was extended on 27 Jun 2022, and the extension's terms were not read.
**Render runs these services in Singapore, so its logs are outside India**, and
how long it keeps them was not verified. (iv) is therefore **not met** today.

### DPDP Rules — what applies to this app from 13 May 2027

- **Rule 6(1)(e):** keep logs and personal data needed to detect and
  investigate unauthorised access for **one year**. Render's logs do not; the
  app's `audit_log` covers application actions, not access to the server.
- **Rule 7:** tell affected people **without delay**; tell the Board without
  delay **and in full within 72 hours**.
- **Rule 14(3):** publish how to exercise rights, and answer grievances within a
  period that is **at most 90 days**.

---

## 4. Owed by the operator

### Details to supply (placeholders on the pages)

One name per detail, used the same way on every page (renamed 21 Oct 2026):

| Placeholder | What to put |
|---|---|
| `[BUSINESS NAME]` | the legal name of the business selling Shop Manager |
| `[BUSINESS ADDRESS]` | its registered address |
| `[CITY]` | the city whose courts hear disputes |
| `[SUPPORT EMAIL]` · `[SUPPORT PHONE]` | support contacts |
| `[GRIEVANCE OFFICER NAME]` · `[GRIEVANCE OFFICER EMAIL]` | the named grievance officer (SPDI Rules now; DPDP from May 2027) |
| `[RESPONSE DAYS]` | days to answer a request or complaint; at most 90 (DPDP Rules, rule 14(3)) |
| `[EFFECTIVE DATE]` | the date the policies take effect |
| `[PRICE]` · `[BILLING PERIOD]` · `[PAYMENT METHODS]` · `[RENEWAL TERMS]` | the subscription |
| `[TRIAL DAYS]` · `[GRACE DAYS]` | free-trial length; days of late payment before read-only |
| `[REFUND POLICY]` · `[REFUND DAYS]` | when a refund is given; days to pay it |
| `[NOTICE DAYS]` | notice before a price change, a removed feature, ending the service, or a policy change |
| `[HOW WE NOTIFY]` | e.g. email and a notice in the app |
| `[EXPORT DAYS]` · `[DELETION DAYS]` | after a subscription ends: days to export; then days to delete |
| `[LIABILITY CAP]` | the most you are liable for; a lawyer should set this |
| `[BACKUP STORAGE REGION]` | the Supabase project's region, and R2's |

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

## 6. Handling a privacy request

Two kinds of request, with different owners. Answer within the time the
Contact page promises, and **never later than 90 days** (rule 14(3), from 13 May
2027; the SPDI Rules apply now). Keep a record of every request: date, who,
what was asked, what was done, and when it was answered.

**A person in a shop's records** (a customer, supplier or employee of a shop):
the shop decides. Point them to the shop. Where the shop asks for help, these
are the tools that exist today:

| They ask to | How, in the app | Limit |
|---|---|---|
| see their data | the customer record (`GET /api/customers/:id`) and the ledger export (`/api/customers/:id/ledger/export`) | owner or permitted staff |
| correct it | edit the customer (`PUT /api/customers/:id`) | — |
| delete it | delete (`DELETE /api/customers/:id`) **only if no transactions**; otherwise mark inactive (`PATCH /:id/active`) | GST records stay 72 months; the name stays in `audit_log` and in backups until they expire (up to 12 months) |

**A business or shop user** (the operator holds their data): verify who is
asking from the email or phone number on the panel record, never from what
the request says. Then:

1. **See:** send them what the panel holds about them (the customer row,
   without the password hash) and, if asked, an owner backup of their books.
2. **Correct:** edit it in the panel.
3. **Delete, after they leave:** export their books for them first. Then cancel
   the customer in the panel (the row is kept for billing history, which is a
   question for the lawyer) and remove their company from the hosted copy.
   Backups expire within 12 months. Payment attachments copied off-site are
   **not** removed automatically and must be removed by hand.

## 7. If personal data is exposed — breach response

Run this whenever data may have been seen, changed or lost by someone who
should not have it: a leaked key, a stolen phone with a shop signed in, a
wrong-permission bug, a public bucket, a lost backup.

1. **Contain (first hour).** Rotate whatever leaked:
   - on Render: `SESSION_SECRET` (signs everyone out), the storage keys,
     `ASSISTANT_API_KEY`/the AI key, and `ADMIN_PASSWORD` for the panel
   - change the affected staff PINs
   - check that buckets are still **private**
2. **Report to CERT-In within 6 hours of noticing**, if the incident is of an
   Annexure I type (for example a data breach, data leak, or unauthorised
   access): incident@cert-in.org.in, 1800-11-4949. Ask a lawyer whether it
   applies if unsure, but do not let the 6 hours pass while asking.
3. **Keep the evidence.** Do not redeploy or wipe until the Render logs, the
   app's `audit_log` and the relevant backups have been saved. A redeploy
   destroys the container's own logs.
4. **Tell the shops affected**, plainly: what happened, what data, when, what
   was done, and what they should do. From 13 May 2027: tell affected people
   without delay, and the Data Protection Board without delay and in full
   within 72 hours (rule 7). Where the operator is a processor for a shop's
   data, tell the shop at once so it can meet its own duty.
5. **Write it up:** timeline, cause, data involved, people told and when, and
   the fix. Keep it.

**Contacts to fill in before launch:** CERT-In Point of Contact
`[GRIEVANCE OFFICER NAME]` (or another named person), the operator's phone,
and the lawyer to call.

## 8. Found in production on 18 Oct 2026

- **Permissions were not enforced on the server on the live copies.** On the
  code running on Swagat Ply and on the sold copy, a staff login with **every
  permission removed** could read all customers (with phone numbers),
  invoices, suppliers, bank accounts and the dashboard cash balance. Probed
  with dummy accounts on a throwaway copy. The fix, `server/permissionGate.js`,
  is on `cashbook-explore` (the security audit commits) and refuses all of
  those (403). The privacy page's claim "checked on the server" is **false in
  production until that is deployed**, and `test/privacy.test.js` now fails
  on any build without the gate.
- **Saved credentials died with Render's disk.** Fixed by `CREDENTIAL_KEY`
  (deployed); it still has to be set on each Render service.
- **The sold copy's backup bucket did not exist.** Fixed and deployed.

## 9. Keeping the pages honest

`test/privacy.test.js` reads the code and the pages together, and fails if
they disagree on the numbers that can be checked: backup counts, session
length, the AI row limit, the Assistant rate limit, the services contacted,
the absence of trackers. Change one without the other and it fails. It runs
as part of `tools/release-check.js`.
