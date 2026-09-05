#!/bin/bash
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-web}"
DSH="${DSH:-npx --yes @deepseek-ai/dsh}"
for p in dshb-auth dshb-core dshb-router dshb-exec-ssh dshb-exec-docker dshb-ui; do
  echo "=== installing $p ==="
  $DSH plugin --profile "$PROFILE" add "$REPO/packages/$p"
done
echo ""
echo "Done. Restart: dsh --profile $PROFILE"
