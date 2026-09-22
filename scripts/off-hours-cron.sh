#!/bin/bash
# Cron entry point for the off-hours logger (Phase 2 addendum #5).
#
# Self-disabling: checks today's date against the submission deadline
# (2026-10-11, the actual lock date) before doing anything else. Once past
# it, this script removes its own crontab line and exits - so there's
# nothing to remember to clean up by hand. Set up via `crontab -e` with:
#   */15 * * * * /Users/pradyum/Projects/Covenant/scripts/off-hours-cron.sh >> /Users/pradyum/Projects/Covenant/data/off-hours-cron.log 2>&1

set -euo pipefail

EXPIRY_DATE="2026-10-11"
REPO_DIR="/Users/pradyum/Projects/Covenant"
NODE_BIN_DIR="/Users/pradyum/.local/share/fnm/node-versions/v22.23.2/installation/bin"

today=$(date +%Y-%m-%d)
if [[ "$today" > "$EXPIRY_DATE" || "$today" == "$EXPIRY_DATE" ]]; then
  echo "[$today] past expiry ($EXPIRY_DATE) - removing this cron entry and stopping."
  crontab -l 2>/dev/null | grep -v "off-hours-cron.sh" | crontab - || true
  exit 0
fi

export PATH="$NODE_BIN_DIR:$PATH"
cd "$REPO_DIR"
"$NODE_BIN_DIR/npx" tsx scripts/off-hours-logger.ts
