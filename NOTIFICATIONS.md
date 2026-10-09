# Notifications

The bell in the header now holds two things:

- **Notifications**: things that happened. They are stored, read state is kept per person, and you can page back through older ones.
- **Reminders**: work still to do, worked out from the books each time, exactly as before.

The bell's number is unread notifications plus reminders that are due.

## What raises a notification

| Kind | When | Who sees it | Can be turned off |
|---|---|---|---|
| Subscription | ends in ≤7 days, ends tomorrow/today, ended, cancelled, renewed, activated; installation not covered; licence server could not confirm (critical) or did not recognise the copy (warning) | owner | no |
| Security | 5 wrong PINs for an account (paused 15 min); your PIN was changed; new owner/staff login; someone made an owner; login switched off; all bills cleared / data wiped | owner, or the person it is about | no |
| System | 2 automatic backups in a row failed; backups working again; backup storage ≥90% full | owner (single-shop installs only) | no |
| Stock | a size falls below the minimum set for a location; a size runs out across all locations | owner + staff with Stock → View | yes |
| Notice | posted by the owner to all staff, or published by the supplier in the licence panel | everyone in that business | yes |

The same incident is one notification:
- Each event carries a key. A repeat inside its window is ignored.
- Stock: a size that keeps crossing its line repeats at most every 12 hours.
- Wrong PINs: at most once every 6 hours per account.

Setting a minimum stock level: Inventory → product → **Warn me below**, under each location. 0 means never warn. This needs Stock → Edit permission; owners always have it.

## Delivery

- **In the app.** The bell asks the server every 2 minutes, only while the screen is open and visible. The app has no push channel (no websocket, deliberately), so a notice can take up to 2 minutes to appear.
- **From the supplier.** Your licence panel's **Notices** reach a shop inside the signed check-in answer (every 6 hours) or at its next sign-in, whichever comes first.

## Email (off — needs setup)

No email provider is configured, and nothing has been bought. To turn email on, set these on the host only, never in code:

```
EMAIL_API_KEY   provider API key (secret)
EMAIL_FROM      e.g. Shop Manager <alerts@yourdomain.in>
EMAIL_API_URL   optional, defaults to https://api.resend.com/emails
```

The request uses Resend's API shape. Then the owner ticks **Also email it** in Notifications → Settings for the kinds they want.

- Mail goes only to the business email in Settings.
- Each notice is sent once.
- Announcements are never emailed.
- A failed send is logged and not retried.

Delivery has been tested only against a local stand-in for the provider, never a real one. Real delivery is unverified until it is set up and tried.
