#!/bin/bash
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OLD=$(node -p "require('./package.json').devDependencies['@deepseek-ai/dsh']")
NEW="${1:-}"

if [ -z "$NEW" ]; then
  NEW=$(npm view @deepseek-ai/dsh dist-tags.latest 2>/dev/null || echo "$OLD")
fi

if [ "$OLD" = "$NEW" ]; then
  echo "Already at $NEW, nothing to do."
  exit 0
fi

echo "=== Upgrading @deepseek-ai/dsh: $OLD -> $NEW ==="

node -e "
const fs = require('fs');
const path = require('path');
function bump(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!p[section]) continue;
    for (const dep of Object.keys(p[section])) {
      if (dep.startsWith('@deepseek-ai/dsh-') || dep === '@deepseek-ai/dsh') {
        if (!p[section][dep].includes('workspace') && !p[section][dep].startsWith('link')) {
          p[section][dep] = '$NEW';
          changed = true;
        }
      }
    }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
}
bump('package.json');
for (const dir of fs.readdirSync('packages')) {
  const pkg = path.join('packages', dir, 'package.json');
  if (fs.existsSync(pkg)) bump(pkg);
}
"

echo "=== pnpm install ==="
pnpm install

echo "=== build ==="
pnpm -r run build

echo "=== typecheck ==="
pnpm -r --if-present run typecheck

echo "=== test ==="
npx vitest run

echo ""
echo "=== Upgrade complete: $OLD -> $NEW ==="
echo "If all green, update README verified version and commit."
