@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  START SHOP MANAGER IF IT IS NOT ALREADY RUNNING
REM
REM  Windows Task Scheduler runs this at 7.30 every morning and again at
REM  logon. pm2 had dropped several times with nothing to bring it back, so
REM  the shop opened to a dead app.
REM
REM  IT ASKS THE PORT, NOT PM2.
REM
REM  "Is the shop's app up?" is answered by whether something is serving on
REM  3000 — not by what pm2 believes. There are two pm2 installations on this
REM  machine (see tools/README-autostart.txt); they happen to share a home and
REM  therefore a daemon, but that is a coincidence of configuration and not
REM  something this script should bet the shop's morning on. The port is the
REM  thing that actually matters and the one answer that cannot be stale.
REM
REM  A healthy app is never restarted. This fires more than once a day, and
REM  a blind restart would cut the counter off mid-bill for no reason.
REM ============================================================

set "NODE=C:\node.js\node.exe"
set "PM2=C:\Users\prafu\shop-manager-runtime\node_modules\pm2\bin\pm2"
set "APP=%~dp0..\server\index.js"
set "LOG=%USERPROFILE%\.pm2\autostart.log"

if not exist "%USERPROFILE%\.pm2" mkdir "%USERPROFILE%\.pm2" >nul 2>&1
echo. >> "%LOG%"
echo === %DATE% %TIME% === >> "%LOG%"

REM ---- is anything already serving on 3000? --------------------------------
set "UP="
for /f "delims=" %%L in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":3000 "') do set "UP=%%L"

if defined UP (
  echo    port 3000 is already being served - left alone >> "%LOG%"
  exit /b 0
)

echo    nothing on port 3000 - starting the app >> "%LOG%"

if not exist "%NODE%" (
  echo    GIVING UP - node not found at %NODE% >> "%LOG%"
  exit /b 1
)
if not exist "%PM2%" (
  echo    GIVING UP - pm2 not found at %PM2% >> "%LOG%"
  echo    reinstall it with:  npm install pm2 --prefix C:\Users\prafu\shop-manager-runtime >> "%LOG%"
  exit /b 1
)

REM ---- start it under pm2, which then restarts it if it crashes -----------
"%NODE%" "%PM2%" start "%APP%" --name shop-manager --time >> "%LOG%" 2>&1
"%NODE%" "%PM2%" save >> "%LOG%" 2>&1

REM Give it a moment to bind before deciding whether it worked.
ping -n 6 127.0.0.1 >nul 2>&1

set "UP="
for /f "delims=" %%L in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":3000 "') do set "UP=%%L"

if defined UP (
  echo    started - port 3000 is serving >> "%LOG%"
  exit /b 0
)

echo    FAILED - the app did not come up. pm2 log: >> "%LOG%"
"%NODE%" "%PM2%" logs shop-manager --lines 20 --nostream >> "%LOG%" 2>&1
exit /b 1
