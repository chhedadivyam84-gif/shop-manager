#!/data/data/com.termux/files/usr/bin/bash
# One-command setup for running Shop Manager on an Android phone via Termux.
# Usage (paste into Termux):
#   curl -sL https://raw.githubusercontent.com/chhedadivyam84-gif/divyam/claude/shop-management-app-1v3h7x/termux-setup.sh | bash
set -e

REPO_DIR="$HOME/divyam"

echo "== Updating Termux packages (this can take a few minutes the first time) =="
pkg update -y
pkg upgrade -y

echo "== Installing Node.js and git =="
pkg install -y nodejs git

if [ -d "$REPO_DIR/.git" ]; then
  echo "== Shop Manager already downloaded — updating it =="
  cd "$REPO_DIR"
  git checkout claude/shop-management-app-1v3h7x
  git pull origin claude/shop-management-app-1v3h7x
else
  echo "== Downloading Shop Manager =="
  git clone https://github.com/chhedadivyam84-gif/divyam.git "$REPO_DIR"
  cd "$REPO_DIR"
  git checkout claude/shop-management-app-1v3h7x
fi

echo "== Installing dependencies =="
npm install

echo ""
echo "=========================================================="
echo " Setup complete. Starting Shop Manager now..."
echo " Open this phone's browser to: http://localhost:3000"
echo " Default PIN is 1234 — change it from Settings right away."
echo ""
echo " To start it again later (after closing Termux), run:"
echo "   cd ~/divyam && npm start"
echo "=========================================================="
echo ""

npm start
