#!/usr/bin/env bash
# Microsoft Rewards Terminal TUI Dashboard
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# 1. Resize Terminal window to 106x36
printf '\e[8;36;106t' 2>/dev/null
if [ "$(uname)" = "Darwin" ]; then
    osascript -e 'tell application "Terminal" to set {number of columns, number of rows} of front window to {106, 36}' 2>/dev/null || true
fi

# 2. Run with macOS caffeinate to prevent system, power, and disk sleep
if command -v caffeinate >/dev/null 2>&1; then
    exec caffeinate -i -s -m node tui.mjs
else
    exec node tui.mjs
fi
