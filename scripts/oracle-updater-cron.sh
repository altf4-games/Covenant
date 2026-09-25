#!/bin/bash
# Cron entry point for the oracle updater - red-team finding H8
# (docs/research/opus-2026-09-24/a-redteam.md): "no scheduler exists for it
# ... in practice the guard is either down or depends on a laptop cron."
# This is that scheduler. Same self-disabling pattern as
# scripts/off-hours-cron.sh: checks today's date against the submission
# deadline before doing anything, and removes its own crontab line once past
# it, so there's nothing to remember to clean up by hand.
#
# Every run posts one real, gas-costing transaction to mainnet
# (updateOracle). With stalenessBound=900s (deploy.ts's default), run this
# at least every 10 minutes so a trade attempt never has to wait more than a
# few minutes past the bound for fresh data. At current gas prices this is
# roughly $0.00002-0.0001 per run (see docs/research/verified-facts.md's gas
# math) - real but small against the $2 budget; still, this is opt-in, not
# installed automatically, because it's the one piece of this project that
# spends real money on a timer rather than per deliberate action. Set up
# with `crontab -e`:
#   */10 * * * * /Users/pradyum/Projects/Covenant/scripts/oracle-updater-cron.sh >> /Users/pradyum/Projects/Covenant/data/oracle-updater-cron.log 2>&1

set -euo pipefail

EXPIRY_DATE="2026-10-11"
REPO_DIR="/Users/pradyum/Projects/Covenant"
NODE_BIN_DIR="/Users/pradyum/.local/share/fnm/node-versions/v22.23.2/installation/bin"

today=$(date +%Y-%m-%d)
if [[ "$today" > "$EXPIRY_DATE" || "$today" == "$EXPIRY_DATE" ]]; then
  echo "[$today] past expiry ($EXPIRY_DATE) - removing this cron entry and stopping."
  crontab -l 2>/dev/null | grep -v "oracle-updater-cron.sh" | crontab - || true
  exit 0
fi

export PATH="$NODE_BIN_DIR:$PATH"
cd "$REPO_DIR"
"$NODE_BIN_DIR/npx" tsx scripts/oracle-updater.ts
