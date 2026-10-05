#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LOG="$HOME/Library/Logs/debate-uploader.log"
DEST="$HOME/Library/LaunchAgents/com.debate-uploader.plist"
SESSION="$HOME/Library/Application Support/cardmirror-bridge/debate-uploader.session.json"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE|" -e "s|__HELPER__|$DIR/helper.mjs|" -e "s|__LOG__|$LOG|g" \
  "$DIR/com.debate-uploader.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl bootout "gui/$(id -u)/debate-uploader" 2>/dev/null && sleep 1 || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

for _ in 1 2 3 4 5; do [ -f "$SESSION" ] && break; sleep 1; done
if [ -f "$SESSION" ]; then
  echo "Debate Uploader helper is running. Log: $LOG"
else
  echo "Helper did not start. Check $LOG" >&2
  exit 1
fi
