#!/bin/bash
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-web}"
DSH="${DSH:-npx --yes @deepseek-ai/dsh}"
echo "=== installing @artenx/dshb ==="
$DSH plugin --profile "$PROFILE" add "$REPO/packages/dshb"
echo ""
echo "Done. Restart: dsh --profile $PROFILE"
