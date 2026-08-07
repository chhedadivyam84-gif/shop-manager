#!/data/data/com.termux/files/usr/bin/bash
# One-command setup for running Shop Manager on an Android phone via Termux.
#
# Usage:
#   1. Copy this whole folder onto the phone (e.g. into Termux's storage).
#   2. In Termux:  cd <this-folder> && bash termux-setup.sh
#
# The app is installed from THIS folder — nothing is downloaded from any
# repository, so it works fully offline once the packages below are in place.
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== Updating Termux packages (this can take a few minutes the first time) =="
pkg update -y
pkg upgrade -y

echo "== Installing Node.js =="
pkg install -y nodejs

cd "$APP_DIR"

echo "== Installing dependencies =="
npm install

echo ""
echo "=========================================================="
echo " Setup complete. Starting Shop Manager now..."
echo " Open this phone's browser to: http://localhost:3000"
echo ""
echo " First run creates an Owner login with PIN 1234 —"
echo " change it from Settings -> Staff straight away."
echo ""
echo " To start it again later (after closing Termux), run:"
echo "   cd \"$APP_DIR\" && npm start"
echo "=========================================================="
echo ""

npm start
