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

There is **no CI**. Nothing runs the checks for you on push. That is what
`tools/release-check.js` is for, and it only helps if somebody runs it.

---

## The one rule

**Deploy the live shop only when nobody is billing.**

Render starts the new container *before* it stops the old one. The new
one restores from the newest cloud backup, and only then does the old one
take its final backup. Anything billed between the last scheduled backup
(every 15 minutes) and the deploy reaches the cloud **after** the new
container has already restored without it.

Two things now limit the damage — see `server/release.js`:

- after a restore, the new container no longer takes a startup snapshot.
  That snapshot used to be written in the same second, under the same
  name, as the old container's final backup, and could overwrite it.
- 90 seconds after a restore, it looks in the cloud. If a newer backup is
  there, it logs `[release] A BACKUP NEWER THAN THE ONE THIS RELEASE
  RESTORED EXISTS` and shows the stamp in `/api/health`.

Neither of those puts the missing bills back in the running shop. They
make sure the bills are **not destroyed** and that **somebody is told**.
Restoring them is a person's decision.

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

A check that could not run is reported as SKIPPED, and **a skipped
critical check is NOT READY**. `--quick` skips the test suites and is
therefore never READY.

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

**Set the health check path** on both services:
*Service → Settings → Health Checks → Health Check Path* = `/api/health`

Until it is set, Render decides a release is healthy as soon as the port
opens — even if the database never came up. With it set, a release whose
`/api/health` answers 503 is not cut over to. This is a dashboard setting;
it is **not configured by anything in this repository**, and nothing
here can tell whether it is set.

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

- **No CI.** The release check is a habit, not a gate. Nothing stops a push
  that skipped it.
- **The handover gap is detected, not closed.** Closing it needs the new
  container to wait for the old one's final save, which Render does not
  offer on the free plan.
- **The health check path is not set by this repository** — see above.
- **No staging environment.** The empty-directory boot and the test
  suites stand in for one.
- **The licence panel releases separately** — `shop-manager-licence`,
  branch `main`, its own tests.
