@echo off
REM Tally Bridge - keep this window open while the shop is billing.
REM Settings live in tally-bridge.json beside this file.
title Tally Bridge
cd /d "%~dp0"
:run
node tally-bridge.js
echo.
echo The bridge stopped. Restarting in 10 seconds - close this window to stop for good.
timeout /t 10 >nul
goto run
