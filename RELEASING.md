# Releasing, and rolling back

How a change gets from this folder to a live shop, how to tell whether it
arrived whole, and how to undo it. Written against what is actually
configured — Render, two repositories, no CI — not against a template.

Anything marked **you have to do this** is not automated and will not
happen by itself.

---

## What is where

| | Live shop | Selling copy |
|---|---|---|
| URL | `shop-manager-izfy.onrender.com` | `shop-manager1.onrender.com` |
| Render service | `shop-manager` (Docker) | `shop-manager1` |
| GitHub repo | `chhedadivyam84-gif/shop-manager` | `chhedadivyam84-gif/shop-manager1` |
| Deploys on | push to `master` | push to `master` |
| Holds real data | **yes** — staff bill on it | no, by design |

Work happens on the `cashbook-explore` branch in `~/shop-manager`.
`master` is checked out in a separate worktree, `~/sm-deploy`, which is
why `git checkout master` in the main folder refuses.

**CI**: `.github/workflows/release-check.yml` runs the release check on
every push to `master` and `cashbook-explore`, on GitHub's free minutes.
It needs no secrets and gets read-only access.

**It is only a gate once Render waits for it.** Until each service's
*Settings → Auto-Deploy* is set to **After CI Checks Pass**, Render deploys
on push whatever CI says. That is a dashboard setting — see below.

---

## The deploy handover, and the one rule left

Render starts the new container *before* it stops the old one. The new
one restores from the newest cloud backup, and only then does the old one
take its final backup. So a bill entered in the last moments reaches the
cloud **after** the new container restored without it.

That is now handled — `server/release.js` and `server/catchup.js`:

- **No collision.** After a restore, the new container takes no startup
  snapshot. It used to be written in the same second, under the same
  name, as the old container's final backup, and could overwrite it.
- **The gap is closed.** 90 seconds after a restore it looks in the
  cloud. If the old container saved later, and **nothing has been written
  on the new one yet**, it downloads that backup, checks it with SQLite's
  own integrity check, restarts, and puts it in place before any database
  opens. The late bills are in the running shop. What it replaced is kept
  in `DATA_DIR/superseded-<time>/`, never deleted.
- **If work has already started on the new container**, the two copies
  have diverged. It does not guess which wins: it logs
  `[release] A BACKUP NEWER THAN THE ONE THIS RELEASE RESTORED EXISTS`,
  shows the stamp in `/api/health`, and leaves it to a person.
- **A damaged newer backup is never applied.**
- `DEPLOY_CATCHUP=off` on the host turns the automatic part off and keeps
  only the warning.

`test/handover.test.js` plays all of that out with the real app against a
stand-in cloud that speaks S3 and refuses unsigned requests.

**What is left: deploy the live shop when nobody is billing.** The one
case still not closed automatically is somebody billing on the NEW
container inside those first 90 seconds *and* on the old one just before
it — then there are two different sets of new bills, and only a person
can merge those.

**And one thing about Render this was not able to verify:** the catch-up
restarts the process with `process.exit(0)` and relies on Render starting
it again, as it does for any web service whose process ends. That was
tested with a real restart on this machine, not on Render. The first
deploy after this ships is the time to watch the logs for
`[release] took in the newer backup`.

---

## Before every release

```bash
node tools/release-check.js
```

Exit 0 means READY. It checks, and **fails** on:

| | why it is there |
|---|---|
| working tree clean | what is tested must be what ships |
| lockfile matches `package.json` | Render builds with `npm ci`, which refuses a mismatch |
| three production packages | a new dependency is a decision, not a deploy |
| every file parses | one bad route file takes the whole app down |
| no `DROP` / `TRUNCATE` / `DELETE FROM` in boot-time migrations | every restart runs them |
| starts on an **empty** data directory | the only place a migration that reads a column before creating it fails — nine deploys in a row failed that way on 1 Sep 2026 |
| starts a **second** time on the same data | every restart re-runs the migrations |
| `/api/health` reports the database | the release is actually usable |
| the critical test suites | money, identity, backups, the assistant |

| **staging: the release on a copy of the real books** | the only check that uses rows nobody wrote for a test — it must start healthy and keep every row |

A check that could not run is reported as SKIPPED, and **a skipped
critical check is NOT READY**. `--quick` skips the test suites and is
therefore never READY.

**Staging** (`tools/staging.js`) copies the newest backup in
`data/backups/`, boots the release on the copy with the cloud unset, and
checks it comes up healthy and that every row in the money and stock
tables is still there afterwards. The live data is never opened for
writing, and the copy is deleted when it is done — it is the shop's
customer list. It can be run on its own: `node tools/staging.js`.

**In CI**, two checks are reported `LOCAL` instead of run: the identity
test needs the vendor's private signing key, and staging needs the real
books. Neither is ever given to a CI provider. CI says which are still
owed, and they still have to pass on the release machine.

Things it cannot check from a laptop are marked `CHECK` — the backup
credentials on the host above all. It names them; it never reads them.

**For a risky change** — anything touching `server/db-schema.js` or data
— also run:

```bash
node tools/verify-backup.js --cloud
```

and do not deploy unless it passes. You want to know the way back works
*before* you need it.

---

## Releasing the live shop

```bash
# in ~/shop-manager, on cashbook-explore, everything committed
node tools/release-check.js

cd ~/sm-deploy
git merge --no-ff cashbook-explore -m "Merge branch 'cashbook-explore'"
git diff --quiet HEAD cashbook-explore && echo "identical to what was tested"
git push origin master
```

Then **check it arrived** — by what it serves, never by "it restarted":

```bash
curl -s https://shop-manager-izfy.onrender.com/api/health
```

- `version` is the first 7 characters of the commit you pushed
- `db` is `ok`
- after about two minutes, `gapChecked` is `true` and
  `newerBackupThanRunning` is `null`

If `newerBackupThanRunning` is a stamp, something was billed during the
handover — go to **Recovering bills from a handover** below.

## Releasing the selling copy

There is no local checkout of it. The route is the buyer build:

```bash
cd ~/shop-manager
node tools/build-buyer-copy.js --stock 1
node tools/build-buyer-copy.js --verify ~/shop-manager-builds/stock-1
# boot the build against an EMPTY data directory — see the vendor notes
cp -r ~/shop-manager-builds/stock-1/server/. ~/sm1-deploy/server/
cp -r ~/shop-manager-builds/stock-1/public/. ~/sm1-deploy/public/
cd ~/sm1-deploy && git add server public && git commit && git push
```

Only `server/` and `public/` are copied. The rest of that repository —
its Dockerfile, README, scripts — is the deployment's own.

---

## You have to do this — once, in the Render dashboard

On **both** services:

1. *Settings → Health Checks → Health Check Path* = `/api/health`

   Until it is set, Render decides a release is healthy as soon as the
   port opens — even if the database never came up. With it set, a
   release whose `/api/health` answers 503 is not cut over to.

2. *Settings → Auto-Deploy* = **After CI Checks Pass**

   This is what turns CI from a report into a gate. Without it, Render
   deploys on every push to `master` whether CI passed or not.

Both are dashboard settings. **Nothing in this repository configures
them**, and nothing here can tell whether they are set.

---

## Something is wrong after a release

**How you know**

- Render → Events says **Deploy failed** — the new release never started;
  the old one is still serving. Nothing to roll back; fix and push again.
- `/api/health` is not 200, or `db` is not `ok`
- `/api/health` shows a `version` that is not what you pushed
- Render → Logs shows `Fatal startup error`
- staff report something broken that worked before

**Where to look**

Render → the service → **Logs**. Search `restore`, `backup`, `release`,
`Fatal`. These lines carry no secrets by design.

## Rolling back

**A rollback is also a deploy.** It wipes the disk and restores from the
newest backup exactly like any other, so the one rule applies: do it when
nobody is billing.

**Fast — Render's button.** *Deploys* → the last good one → **Rollback**.
The old code comes back in a minute or two. Check `/api/health` shows the
old `version`.

**Durable — git.** The button does not change `master`, so the next push
redeploys the bad code. Undo it in the history too:

```bash
cd ~/sm-deploy
git log --oneline -5              # find the merge that broke it
git revert -m 1 <merge-commit>
git push origin master
```

### The database does not roll back with the code

Reverting code reverses **nothing** in the database.

What protects you is that migrations here only ever **add** — a column,
a table, an index — and are guarded, so they run safely on every boot.
Older code reading a newer database simply ignores the columns it does
not know about. `tools/release-check.js` fails any release that adds a
`DROP`, `TRUNCATE` or `DELETE FROM` to the boot-time migrations, to keep
that true.

So for almost every bad release, **rolling back the code is enough**.

The exception is a release that *changed existing rows* — rewrote values,
merged records — rather than adding structure. Code cannot undo that. The
only way back is a database restore.

### Restoring the database

Only when the data itself is wrong, never because a deploy failed.

**It needs the owner's approval, every time.** It can replace newer bills
with older ones, so it is never automatic and nothing in this repository
does it on its own.

1. Copy what is there now first, including whatever is damaged.
2. Choose a backup and prove it: `node tools/verify-backup.js --cloud --stamp <stamp>`
3. Restore into a scratch copy and look at it — see `DISASTER-RECOVERY.md`.
4. Only then restore the live shop, through *Settings → Restore*. It keeps
   what it replaced, so it can be undone.

### Recovering bills from a handover

If `/api/health` or the logs report a backup newer than the one restored:

1. Note the stamp. Do **not** deploy again until this is settled — a
   later backup would push it further down the list.
2. `node tools/verify-backup.js --cloud --stamp <stamp>` — confirm it is
   sound.
3. Ask the counter what was billed around the deploy time. If it was
   one or two bills, re-entering them is safer than a restore.
4. If it was more, a restore of that stamp brings them back — and loses
   anything billed *since* the deploy. That trade is the owner's to make.

---

## Known limits

- **CI is a gate only once Render waits for it** — the Auto-Deploy
  setting above. And two checks can never run in CI by design; they are
  owed on the release machine.
- **Two sets of new bills cannot be merged automatically.** If staff bill
  on both containers during the handover, the catch-up stands back and
  says so.
- **Render restarting after the catch-up exits** is how Render treats any
  web service; it was verified with a real restart on this machine, not
  on Render itself.
- **Staging uses the local backups.** On a machine without them it cannot
  run, and the release check says NOT READY rather than pretending.
- **There is no hosted staging server.** Staging runs here, on a copy.
  A hosted one would be a separate free Render service; that has not been
  created, because it is a new piece of infrastructure in the account.
- **The licence panel releases separately** — `shop-manager-licence`,
  branch `main`, its own tests.
