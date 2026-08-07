# Shop Manager

A real, self-hosted stock and invoicing app for a single shop. No cloud account,
no third-party dependency at runtime — everything (products, customers,
invoices, stock) lives in one local database file on the shop's computer.

## What it does

- **Inventory** — products with brand/category/SKU, multiple size/price
  variants, per-product GST rate, stock on hand with low-stock warnings.
- **Billing** — build an invoice from stock, apply a discount, pick a
  payment method, record an advance, and complete the sale. Stock is
  deducted automatically and can't go negative.
- **GST done properly** — CGST+SGST for customers in the same state as the
  shop, IGST automatically for customers in a different state, computed
  per line item from each product's own GST rate.
- **Customers** — credit limit and running "due" balance per customer,
  purchase history, WhatsApp share of an invoice.
- **Invoices** — printable A5/A4 preview, downloadable PDF, and a Void
  option that reverses stock and dues if a sale needs to be undone.
- **Reports** — sales by payment method, GST collected, stock by brand,
  customer dues, all exportable as CSV.
- Works on **any phone, tablet, or computer** with a browser, as long as
  it's on the same WiFi as the shop's PC — no app-store install needed
  (there's an "Add to Home Screen" manifest for a native-app feel).

## Requirements

- [Node.js](https://nodejs.org) 22.5 or newer, installed once on the
  device that runs it (a PC, or an Android phone — see below). Storage
  is SQLite built directly into Node itself (`node:sqlite`), so there's
  no separate database to install and nothing native to compile — this
  is what makes the Android/Termux setup below possible without a
  build toolchain.

## First-time setup

```
npm install
npm start
```

You'll see:

```
Shop Manager running on port 3000
Open http://localhost:3000
```

Open that address in a browser on the same computer. There's one built-in
account, **Owner**, with the default PIN **1234** — log in as Owner, then
from the profile icon (top right) → Settings → **Manage Staff & PINs**,
change that PIN immediately and add an account for each staff member who
needs access (each gets their own name + PIN). Also fill in the shop's name,
address, GSTIN and state in Settings (the state is what decides CGST/SGST
vs IGST on invoices).

Every login is tied to a staff account: the login screen lists staff by
name, then asks for that person's PIN. Only Owner accounts can edit shop
settings, manage other staff, void invoices, or delete products/customers —
regular Staff accounts can bill, manage stock, and add customers. Every
sensitive action is recorded in Settings → **Activity Log** (who did what,
and when). Five wrong PINs in a row locks that device out of logging in
for 15 minutes.

## Using it from phones in the shop

1. Find the shop PC's local network IP address (Windows: `ipconfig`,
   look for "IPv4 Address"; Mac/Linux: `ifconfig` or `ip addr`). It looks
   like `192.168.1.23`.
2. Make sure the PC and the phone are on the same WiFi.
3. On the phone's browser, go to `http://192.168.1.23:3000` (use the PC's
   actual IP). Pick your name and enter your PIN.
4. Optional: use the browser's "Add to Home Screen" to get an app icon.

The app keeps running only while `npm start` is running on the PC. Leave
that PC on (or set it to auto-start the app on boot) during shop hours.

## Running it entirely on an Android phone (no PC at all)

If there's no computer in the shop, an Android phone can run the whole
thing by itself using [Termux](https://termux.com) — a terminal app that
runs real Linux command-line programs, including Node.js. The phone
becomes both the server and the device you use it on.

1. Install Termux from **F-Droid** (f-droid.org/packages/com.termux) —
   not the Play Store version, which is outdated and no longer updated.
2. Open Termux and paste this one line:
   ```
   curl -sL https://raw.githubusercontent.com/chhedadivyam84-gif/divyam/claude/shop-management-app-1v3h7x/termux-setup.sh | bash
   ```
   This installs Node.js and git, downloads Shop Manager, installs its
   dependencies, and starts it — all in one step. The first run takes a
   few minutes (mostly the `pkg update`/`upgrade` step).
3. On that same phone, open a browser and go to `http://localhost:3000`.
   Log in as **Owner** with PIN **1234**, then change it from Settings →
   Manage Staff right away.
4. For other phones/tablets in the shop to reach it, they need the
   Termux phone's WiFi IP address (inside Termux: `ip addr` or install
   `pkg install net-tools` then `ifconfig`), and all devices must be on
   the same WiFi.

Next time you need to start it (after closing Termux or restarting the
phone), you don't need the one-liner again — just open Termux and run:
```
cd ~/divyam && npm start
```

Notes specific to running on a phone:
- **Keep Termux running.** Closing the Termux app (not just switching
  away from it) stops the server. In Termux's notification, tap
  "Acquire wakelock" so Android doesn't kill it in the background, and
  turn off battery optimization for Termux in the phone's Settings →
  Apps.
- The phone must stay on and connected to WiFi during shop hours. If it
  restarts, reopen Termux and run `cd ~/divyam && npm start` again —
  unless you set up auto-start below, which removes even that step.
- This is genuinely more fragile than a PC (phones sleep, restart, run
  out of storage more easily) — if a spare PC or an old laptop is ever
  available, that's the sturdier long-term home for this.

**Optional — auto-start after a phone restart:** install the
"Termux:Boot" app (same F-Droid source), open it once, then in Termux run:
```
mkdir -p ~/.termux/boot
cp ~/divyam/termux-boot/start-shop-manager.sh ~/.termux/boot/
chmod +x ~/.termux/boot/start-shop-manager.sh
```
Now Shop Manager starts by itself whenever the phone reboots — nobody
has to remember to reopen Termux.

## Backing up your data

Everything lives in one file: `data/shop.db` — that's your entire shop's
records. The app now protects it for you on two levels:

**Automatic local snapshots.** A consistent copy is saved to
`data/backups/` shortly after the app starts and then once a day, keeping
the last 30. These use SQLite's own `VACUUM INTO`, so they're safe to take
while the app is running (a plain file copy of a live database can be
corrupt). This guards against accidental deletion and database corruption.

**One-tap off-site copy.** Open **Settings → Backup & Restore → Download
Backup Now** (owner only) to save a fresh snapshot straight to whatever
device you're on — your phone, a USB drive, or email it to yourself. Do
this every so often: local snapshots don't help if the PC itself is lost,
stolen, or damaged.

### Optional: automatic cloud backup (free Supabase)

If you want off-site copies pushed automatically instead of downloading by
hand, the app can upload each snapshot to your own free
[Supabase](https://supabase.com) Storage bucket. It stays **fully optional**
— with nothing configured, the app is 100% local and needs no internet.

1. Copy `data/.env.example` to `data/.env`.
2. Follow the setup steps written inside that file (create a free Supabase
   project, a private `shop-backups` bucket, and paste in your Project URL
   and `service_role` key).
3. Restart the app (`pm2 restart shop-manager`). Settings → Backup should
   now show **"Cloud backup on"**.

The `service_role` key stays on the shop PC in `data/.env` (which is
git-ignored) and is never sent to any browser. If the internet is down when
a backup runs, the local snapshot still succeeds and the cloud upload is
simply retried on the next run.

## Running it in the background permanently

So you don't have to keep a terminal window open:

```
npm install -g pm2
pm2 start server/index.js --name shop-manager
pm2 save
pm2 startup
```

This keeps the app running and restarts it automatically if the PC
reboots.

## Hosting online (access from outside the shop's WiFi)

Running it only on the shop PC (above) is the most reliable option day to
day — no internet dependency, nothing to pay for. If you also want to check
sales and dues from home, deploy the same app to [Render](https://render.com)
with [Supabase](https://supabase.com) holding the backups.

**Supabase is not optional here.** Render's free tier wipes its filesystem on
every deploy and restart, so `data/shop.db` would not survive. The app
handles this: it uploads a snapshot every 15 minutes while running, and on
boot — if the database file is missing and Supabase is configured — it
downloads the newest snapshot before opening the database.

1. Push this project to a **private** GitHub repo. (`.gitignore` already
   keeps `data/*.db`, `data/session-secret.txt` and `data/.env` out.)
2. In Supabase: create a project, then **Storage → New bucket** named
   `shop-backups`, left **Private**. From **Project Settings → API** copy the
   *Project URL* and the *service_role* key (the `anon` key cannot write).
3. In Render: **New → Web Service**, connect the repo, then set
   - Runtime **Node**
   - Build Command `npm ci --omit=dev`
   - Start Command `node --no-warnings server/index.js`
4. Add these environment variables:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_KEY` | your service_role key |
   | `SUPABASE_BUCKET` | `shop-backups` |
   | `NODE_VERSION` | `24` |

   `NODE_VERSION` matters: the app uses Node's built-in `node:sqlite`, which
   needs Node 23.4 or newer to run without an extra flag.
5. Deploy, open the URL, log in as **Owner / PIN 1234**, and change the PIN
   straight away.
6. Confirm it worked: the deploy log should show a `[backup] startup
   snapshot … + cloud` line, and the file should appear in the Supabase
   bucket.

**Careful:** a redeploy restores from the last snapshot, so anything entered
in the previous 15 minutes can be lost. Before pushing code, run
Settings → Backup → *Run backup now*, and avoid deploying while staff are
billing.

**Security note:** the app is protected only by each staff member's 4-6 digit
PIN (5 wrong attempts locks that IP out for 15 minutes). That's fine on a
private shop WiFi, but once it's on the public internet anyone who finds the
URL can try to guess it. Use 6-digit PINs (Settings → Manage Staff) and don't
share the URL publicly.

## Subscription

*Applies only if your copy was supplied with a subscription — if there is no
Subscription section in Settings, this doesn't apply to you.*

Paste the licence key you were given into **Settings → Subscription** and
press Activate. A gold banner appears 14 days before the term ends.

If it expires the app becomes **read-only**: you can still log in, look up
and print past invoices, and download a full backup from Settings → Backup —
but new invoices, purchases and payments are blocked until a renewal key is
entered. Your records are never deleted or held back.

## Project layout

```
server/          Express API (auth, products, customers, invoices, reports)
public/          Frontend (HTML/CSS/JS), served as static files
data/shop.db     SQLite database — all shop data lives here
Dockerfile       Container build used for Fly.io (or any Docker host)
fly.toml         Fly.io app config (volume mount + http service)
termux-setup.sh  One-command installer for running on Android via Termux
termux-boot/     Optional auto-start script for Termux:Boot
```
