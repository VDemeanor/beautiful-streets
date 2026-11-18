#!/usr/bin/env bash
# Rebuild and restart the app in place (used in the Codespace after `git pull`).
set -euo pipefail
npm ci
npm run build
pkill -f "next start" || true
pkill -f next-server || true
(setsid nohup npm start > /tmp/beautiful-streets.log 2>&1 &)
sleep 3
echo "Beautiful Streets restarted."
