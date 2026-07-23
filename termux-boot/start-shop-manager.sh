#!/data/data/com.termux/files/usr/bin/bash
# Auto-start Shop Manager when the phone boots, via the Termux:Boot app.
#
# One-time install:
#   1. Install "Termux:Boot" from F-Droid (same source as Termux itself).
#   2. Open Termux:Boot once so Android grants it boot permission.
#   3. In Termux, run:
#        mkdir -p ~/.termux/boot
#        cp ~/divyam/termux-boot/start-shop-manager.sh ~/.termux/boot/
#        chmod +x ~/.termux/boot/start-shop-manager.sh
#
# After that, Shop Manager starts automatically whenever the phone restarts —
# no need to reopen Termux and type npm start by hand.

termux-wake-lock 2>/dev/null || true
cd "$HOME/divyam" && npm start
