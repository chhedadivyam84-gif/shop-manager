# Disaster recovery

What to do when the books are gone, damaged, or a deploy has broken
something. Read the first section before you need it; the rest is for the
morning you do.

Everything described as **automated** is in the code and tested.
Everything under **you have to do this** is not, and will not happen by
itself.

---

## The rule that matters most

**Do not delete anything until you have a verified copy of what you are
replacing it with.**

On 14 September 2026 the vendor's licence panel lost sixteen customers.
Not to a disk failure — the object store was *accepting writes while
failing reads*, so "the backup is healthy" and "the data is gone" were
both true at the same moment, and an empty database was saved over the
only good copy within a second of boot.

Two things came out of that and both are in the code now: a save of an
empty database is refused, and **a backup is not believed until something
has opened it.** That second one is `tools/verify-backup.js`.

---

## What exists

### Where the data is

| | |
|---|---|
| Database | **SQLite**, one file per company: `<DATA_DIR>/companies/<id>/shop.db` |
| First company | `<DATA_DIR>/shop.db` — adopted in place on upgrade, never moved |
| Which companies exist | `<DATA_DIR>/companies.json` |
| Which shop owns which books | `<DATA_DIR>/tenants.db` |
| Sessions | `<DATA_DIR>/` — not backed up, and should not be |
| Local backups | `<DATA_DIR>/backups/` |
| Off-site copies | Cloudflare R2 or Supabase Storage, whichever is configured |

A backup **run** is several files sharing one timestamp:

```
shop-<stamp>.db                 the first company
shop-<stamp>--<companyId>.db    each further company
shop-<stamp>--registry.json     which companies exist
shop-<stamp>--tenants.db        which login owns which books
```

**All four matter.** A run restored without its tenant map brings every
shop's books back and loses the record of whose they are — and the app,
finding no owner for a login it is told is valid, creates a fresh empty
company and leaves the real books orphaned.

### What is NOT in a backup

- **Environment variables and secrets.** Keep them somewhere else. There
  is no copy of them in here and there must not be.
- **Uploaded files/attachments**, if stored outside the database.
- **The licence panel's own database.** Different application, different
  host, its own backups. See `shop-manager-licence`.

### Automated

- A backup runs on a schedule and on demand (`server/backup.js`).
- **An empty database is never saved over a good one.** The guard checks
  the rows, not a flag — a flag can be stale, rows cannot.
- Local runs rotate, keeping the most recent 30; cloud runs keep 96.
- **The newest cloud run can never be deleted**, whatever is asked for.
- A restore is **staged, not live**: the swap happens at the next start,
  because replacing a file under a running process leaves the old
  write-ahead log pointing into a file that is gone.
- **A restore keeps what it replaced**, so a restore is itself undoable.
- The old `-wal` and `-shm` are removed, so they cannot replay over the
  new database — the quiet way a restore half-works.

### You have to do this

- **Set the backup credentials.** No credentials, no off-site copy. Names
  only — never put values in this file or in the repository:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET` — or `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_BUCKET`.
- **Run the verification** (below). Nothing runs it for you yet.
- **Keep a copy of the environment variables** somewhere that is not this
  server and not this repository.
- **Decide who holds the backup credentials.** Ideally not the same
  person or token as the application's own.

---

## Check the backups are real — do this monthly

```bash
node tools/check-backup-creds.js      # can we list, upload, download?
node tools/verify-backup.js           # open the newest LOCAL run
node tools/verify-backup.js --cloud   # download and open the newest CLOUD run
```

`verify-backup.js` opens every part of a run **read-only**, and for each:

- it is a real SQLite file, not an error page saved with HTTP 200
- it passes **SQLite's own `PRAGMA integrity_check`**
- the tables a shop cannot work without are present
- **the records still point at each other** — bills to customers, lines
  to bills and products, sizes to products
- the registry parses, and every shop login names a company that is
  actually in the run

That last pair is the point. **A row count proves a row exists, not that
it still points at anything.** A backup where the relationships have come
apart restores into an application that opens and then shows a bill
belonging to nobody.

It exits non-zero when anything is wrong, so it can be run from a
scheduler. It never writes anywhere but its own temporary directory, and
it never deletes, uploads, or runs a backup.

---

## Recovering

### 1. Stop making it worse

Stop writes if you can. Do not redeploy. Do not delete anything.

### 2. Preserve the present state first

Copy the whole `DATA_DIR` somewhere safe — *including* whatever is
damaged. You cannot compare against it later if you have overwritten it,
and a corrupt file sometimes still holds rows nothing else has.

### 3. Pick a recovery point

```bash
node tools/verify-backup.js --cloud --stamp <stamp>
```

Work backwards until one verifies. Do not restore an unverified run just
because it is newest.

### 4. Restore into an isolated copy FIRST

Never test a restore on the live install.

```bash
# a scratch DATA_DIR, nothing to do with production
DATA_DIR=/tmp/recovery-test node tools/verify-backup.js
DATA_DIR=/tmp/recovery-test PORT=4899 node server/index.js
```

Sign in. Open the customer list, a bill, the stock. Check that the shop
that should own those books is the one that can see them.

### 5. Only then, the real one

Restore through **Settings → Restore** in the app, which stages the file
and swaps it at the next start, keeping what it replaced. Restart. Check
the same things again.

### 6. Afterwards

Run `node tools/verify-backup.js` on the next backup to confirm the
recovered state is itself backing up correctly.

---

## A deploy has broken it

**Reverting the code does not reverse a database migration.** Schema
changes in `server/db-schema.js` run on boot and are additive — columns
and tables are added, never dropped — so an older build usually still
opens a newer file. That is a property worth keeping: prefer adding a
column to changing one.

1. Revert the code to the previous commit and restart.
2. Check the app starts and the data is there.
3. Only if the data itself is wrong, go to **Recovering** above.
4. Take a backup *before* any migration you are unsure of.

---

## Known limitations

- **Verification is manual.** Nothing runs `verify-backup.js` on a
  schedule yet. Until it does, a backup store that silently stops
  working will not announce itself.
- **No point-in-time recovery.** Recovery points are the backup runs and
  nothing between them. The gap is the schedule interval.
- **No off-site copy of the environment variables.** Losing them means
  losing access to the backups themselves.
- **The restore path is tested; a full cloud round trip on this
  installation has not been verified by me.** `tools/verify-backup.js
  --cloud` is how you do that, and it needs credentials.
- **Attachments outside the database are not covered** by these backups.
- **This covers the shop app only.** The licence panel is separate.

---

## Tests

```bash
node test/restore.test.js          # what a restore refuses, and what it keeps
node test/backup-verify.test.js    # does the checker catch a broken backup?
```

The second one breaks a real backup in each of the ways a backup actually
breaks — truncated, corrupt past the header, a dropped table, a bill
whose customer is gone, a login whose company is missing — and insists
the checker says so. A verifier that passes everything is worse than no
verifier, because somebody then believes it.
