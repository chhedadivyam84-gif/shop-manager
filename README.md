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

Open that address in a browser on the same computer. The default PIN is
**1234** — change it immediately from the profile icon (top right) →
Settings, and fill in the shop's name, address, GSTIN and state there too
(the state is what decides CGST/SGST vs IGST on invoices).

## Using it from phones in the shop

1. Find the shop PC's local network IP address (Windows: `ipconfig`,
   look for "IPv4 Address"; Mac/Linux: `ifconfig` or `ip addr`). It looks
   like `192.168.1.23`.
2. Make sure the PC and the phone are on the same WiFi.
3. On the phone's browser, go to `http://192.168.1.23:3000` (use the PC's
   actual IP). Enter the shop PIN.
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
   Log in with PIN **1234**, then change it from Settings right away.
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

Everything lives in one file: `data/shop.db`. Copy that file somewhere
safe (a USB drive, email it to yourself, etc.) regularly — that's your
entire shop's records. There's nothing else to back up.

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
day — no internet dependency, nothing to pay for. If you also want to
check sales/dues from home or another location, you can deploy the exact
same app to [Fly.io](https://fly.io), which supports a real persistent
disk (needed so `shop.db` survives restarts — many free hosts wipe their
filesystem on every deploy, which would silently lose invoices).

1. Create a free Fly.io account and install `flyctl`:
   `curl -L https://fly.io/install.sh | sh` (or see fly.io/docs for
   Windows/Mac).
2. From this project folder, run `fly auth login`, then
   `fly launch --no-deploy` — it'll detect the `Dockerfile` and ask for an
   app name and region (pick one close to the shop, e.g. Mumbai/`bom`).
3. Open the `fly.toml` it generated and make sure it has this volume
   mount and service block (the repo's `fly.toml` already has them —
   just copy the `app` name fly assigned into it, or use the repo's file
   directly):
   ```
   [[mounts]]
     source = "shop_data"
     destination = "/app/data"

   [http_service]
     internal_port = 3000
     force_https = true
   ```
4. Create the volume once: `fly volumes create shop_data --size 1 --region bom`
   (1GB is enormous for this app's data — invoices are tiny).
5. Deploy: `fly deploy`
6. Visit the `https://<your-app>.fly.dev` URL it gives you, log in with
   the shop PIN, and set it up exactly like the local version (Settings →
   business name, GSTIN, state, and change the PIN).

Costs roughly $2-5/month for the smallest always-on machine + volume.
Redeploy any future code changes with `fly deploy` from this folder.

**Security note:** the app is protected only by the shared 4-6 digit PIN.
That's fine on a private shop WiFi, but once it's on the public internet
anyone who finds the URL can try to guess it. Use a 6-digit PIN (Settings)
and don't share the `.fly.dev` URL publicly.

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
