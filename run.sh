#!/bin/bash
# Microsoft Rewards Daily Automation Runner for macOS
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "=========================================="
echo " Starting Microsoft Rewards Script..."
echo " Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# Run with caffeinate (-i -s -m: prevent system, AC power, and disk sleep)
if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -i -s -m npm start
else
    npm start
fi

EXIT_CODE=$?
echo "=========================================="
echo " Finished with exit code: $EXIT_CODE"
echo " Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
exit $EXIT_CODE
