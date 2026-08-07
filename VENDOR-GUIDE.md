# Vendor Guide — running and selling Shop Manager

**This file is for you, not for customers.** It is excluded when you build a
copy to sell (see Part B). It documents three separate things that are easy
to mix up:

- **Part A** — hosting *your own* shop online (GitHub → Render → Supabase)
- **Part B** — building a copy to sell
- **Part C** — issuing and renewing customer licences

---

## How the hosting pieces fit together

Worth understanding once, because the design is unusual and this is the bit
that's easy to forget:

| Piece | Job |
|---|---|
| **GitHub** | Holds the code. Render watches it and redeploys on every push to `master`. |
| **Render** | Runs the app. On the free tier **the filesystem is wiped on every deploy and restart**. |
| **Supabase** | Where the data actually survives. **Not optional on Render.** |

The mechanism lives in `server/restore.js` and `server/backup.js`:

- On boot, if `data/shop.db` is missing **and** Supabase is configured, the
  newest snapshot is downloaded *before* the database is opened.
- While running, a snapshot uploads **every 15 minutes** (a local PC does it
  once a day — the fast cadence exists only because Render's disk is
  disposable), plus one on shutdown.

Without Supabase configured, every Render deploy would silently lose all
invoices entered since the last deploy.

---

## Part A — host your own shop online

### A1. GitHub

1. Create a **private** repo. Your database never goes in, but the code is
   still your business asset.
2. From the project folder:

   ```
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<you>/<repo>.git
   git branch -M master
   git push -u origin master
   ```

`.gitignore` already excludes `data/*.db`, `data/session-secret.txt` and
`data/.env`, so no shop data or secrets are pushed.

### A2. Supabase — do this before Render

1. Sign up at supabase.com and create a project (region near the shop —
   Mumbai or Singapore for India).
2. **Storage → New bucket**, name it exactly `shop-backups`, leave it
   **Private**. A public bucket means anyone with the URL can download your
   entire database.
3. **Project Settings → API**, copy two values:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** key → `SUPABASE_KEY`
     (the `anon` key will **not** work — it cannot write)

### A3. Render

1. render.com → **New → Web Service** → connect the GitHub repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm ci --omit=dev`
   - **Start Command:** `node --no-warnings server/index.js`
3. **Environment** → add four variables:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_KEY` | your service_role key |
   | `SUPABASE_BUCKET` | `shop-backups` |
   | `NODE_VERSION` | `24` |

   `NODE_VERSION` is **not optional**. The app uses Node's built-in
   `node:sqlite`, which only works without an extra flag from Node 23.4
   onward. On Node 22 the app fails to start. (The bundled `Dockerfile` says
   `node:22-slim` and would hit exactly that — the Node runtime path above
   avoids it.)

4. Deploy, open the URL, log in as **Owner / PIN 1234**, and change the PIN
   immediately in Settings → Manage Staff. Once it is on the public internet
   that PIN is the only thing protecting the data — use 6 digits.

### A4. Check it actually worked

In the deploy log, look for a `[restore]` line, then about ten seconds later
a `[backup] startup snapshot … + cloud` line. Then confirm the file appears
in Supabase → Storage → `shop-backups`. If the cloud upload is failing, that
log line says so explicitly rather than failing silently.

### A5. Two things that will bite you

**A redeploy can roll back recent data.** Anything entered since the last
15-minute snapshot is lost when Render rebuilds. This has happened in
practice — ten products vanished after a routine deploy. Habit: after
entering an important batch, go to Settings → Backup → *Run backup now*, and
only then push code.

**Don't deploy while staff are billing.** Same reason.

---

## Part B — build a copy to sell

1. Copy the project folder somewhere else. **Never build from your live
   folder**, so a mistake can't touch your own shop.
2. Delete from the copy:
   - `.git/`
   - `node_modules/`
   - everything in `data/` **except** `.env.example`
   - `tools/` (your key generator — see the warning in Part C)
   - `VENDOR-GUIDE.md` (this file)
3. **Switch licensing on.** Open `server/license.js` and paste the contents
   of `tools/vendor-public-key.pem` between the backticks:

   ```js
   const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
   ...your public key...
   -----END PUBLIC KEY-----`;
   ```

   Empty = licensing dormant (how your own copy runs). Filled = enforced.
   The public key can only *verify* keys, never mint them, so it is safe to
   ship.

4. Zip the folder and check before sending:
   - no `.db` files, no `session-secret.txt`, no `.env`
   - no `PRIVATE KEY` anywhere
   - no `tools/` folder
   - your shop's name, GSTIN, phone or email nowhere in it

### What the buyer does

Unzip → `npm install` → `npm start` → open `http://localhost:3000` → log in
as **Owner / PIN 1234** → change the PIN → Settings → fill in their own
business name, GSTIN, address, phone, email and website (all of which print
on their documents) → paste their licence key.

---

## Part C — licences

> **Never send `private-key.pem` or `tools/make-license.js` to anyone.**
> Whoever holds the private key can issue themselves an unlimited licence.
> Keep a backup of the private key somewhere safe — if you lose it you
> cannot renew any existing customer, and every one of them stops billing
> when their current term ends.

### Issue a key

```
node tools/make-license.js <path-to-private-key.pem> "Shop Name" 2027-08-07
```

It prints a key. Send that to the customer; they paste it into
**Settings → Subscription**. The key stores the shop name and expiry date,
signed — they cannot edit the date without invalidating it.

### Renewing

Generate a new key with a later date and send it. They paste it in; billing
resumes immediately. No reinstall, no data loss.

### What the customer sees

| When | What happens |
|---|---|
| No key yet | Cannot create invoices. Banner prompts for a key. |
| Active | Normal. No banner. |
| 14 days left | Gold banner: "Subscription active until … Tap to renew." |
| Expired | Red banner. **Read-only**: they can still log in, view and print old invoices, and download a full backup — but cannot create new records. |

Read-only rather than a full lockout is deliberate. Their invoices are
records they are legally required to keep under GST rules, and a shop that
cannot reach its own books becomes a refund and a bad reference rather than
a renewal. Blocking new billing is enough to make renewing the obvious move.

### Be realistic about what this protects

The app ships as readable JavaScript. Someone technical can delete the
licence check. This stops the ordinary case — a shopkeeper whose year is up
— and gives a clean renewal prompt. It is not real copy protection. An
online activation server would be stronger, at the cost of taking every
customer's shop offline whenever your server or their internet is down.

---

## Support notes

- **"It says my licence is invalid."** Almost always a partial copy-paste.
  The key is one long line with a single `.` in the middle.
- **"I can't create invoices."** Check Settings → Subscription for the
  expiry date.
- **They want their data out.** Settings → Backup → Download. This works
  even while expired, by design.
- **Lost PIN.** There is no recovery by design; the database has to be
  edited directly on their machine.
