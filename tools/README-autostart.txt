SHOP MANAGER — AUTOMATIC START
==============================

WHAT IS SET UP
--------------
A Windows scheduled task called "Shop Manager autostart" runs
tools/start-shop-manager.cmd

  - every morning at 7:30
  - and again whenever prafu logs on

The logon trigger matters as much as the clock one: a 7:30 task does nothing
if the PC was switched on at 8, and the shop would still open to a dead app.

The script checks whether anything is serving on port 3000. If something is,
it writes a line to the log and stops — a healthy app is never restarted,
because the task fires more than once a day and a blind restart would cut
the counter off in the middle of a bill. Only if port 3000 is silent does it
start the app under pm2, which then keeps restarting it if it crashes.

Log:  C:\Users\prafu\.pm2\autostart.log


WHY PM2 KEPT DYING — AND WHY IT WAS NOT VISIBLE
-----------------------------------------------
pm2 was installed from inside the Claude desktop app. That app is packaged
(MSIX), which means its view of AppData\Roaming is virtualised: what looks
like

    C:\Users\prafu\AppData\Roaming\npm

is really

    C:\Users\prafu\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm

Anything running outside that app — Task Scheduler included — cannot see it.
The first version of this task failed for exactly that reason: it found pm2
when run by hand from inside the app and could not find it at all when
Windows ran it, which is the worst kind of failure because it only shows up
on the morning it is needed.

That location is also a poor home for a service. It is an application cache
belonging to a program that gets updated, reinstalled and cleaned up, which
is a plausible explanation for pm2 having dropped repeatedly.

So a second, real pm2 was installed where Windows can see it:

    C:\Users\prafu\shop-manager-runtime\node_modules\pm2

The scheduled task uses that one, through the real node at C:\node.js.


THE TWO PM2 INSTALLATIONS
-------------------------
Both use the same PM2_HOME (C:\Users\prafu\.pm2), so both talk to the same
daemon and both see the same process list. Either can be used.

The app currently running was started by the old one and has not been
touched. Nothing needs to be done about it: when it next stops — or the next
time the PC is restarted — the task starts it again with the real pm2, and
from then on only the real one is involved.

If you would rather move it over deliberately, at a quiet moment:

    C:\node.js\node.exe C:\Users\prafu\shop-manager-runtime\node_modules\pm2\bin\pm2 delete shop-manager
    C:\Users\prafu\shop-manager\tools\start-shop-manager.cmd

That stops the shop's app for a few seconds, so do not do it mid-morning.


HOUSEKEEPING
------------
See the task:
    Get-ScheduledTask -TaskName "Shop Manager autostart"

Run it now, to test:
    Start-ScheduledTask -TaskName "Shop Manager autostart"
    Get-Content $env:USERPROFILE\.pm2\autostart.log -Tail 5

Change the time:
    Task Scheduler -> Task Scheduler Library -> "Shop Manager autostart"
    -> Triggers -> Daily

Remove it:
    Unregister-ScheduledTask -TaskName "Shop Manager autostart" -Confirm:$false

If pm2 ever goes missing again, reinstall the real copy with:
    C:\node.js\npm.cmd install pm2 --prefix C:\Users\prafu\shop-manager-runtime
