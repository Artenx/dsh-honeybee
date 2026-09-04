#!/usr/bin/env bash
#
# DSH-HoneyBee (DSHB) one-shot bootstrap.
#
# Installs standard DSH if it is not already on PATH, then fetches this repo,
# builds the DSHB packages, and installs them into the DSH web profile.
# Detect an existing `dsh` binary and skip the DSH install step entirely.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
#
# Env overrides:
#   DSH_HOME   dsh home (default: "$HOME/.dsh")
#   PROFILE    profile name (default: web)
#   DSHB_SRC   where to clone this repo (default: "$HOME/.dshb/dsh-honeybee")
#   DSH        exact command used to drive dsh; overrides auto-detection
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-web}"
REPO_URL="${REPO_URL:-https://github.com/Artenx/dsh-honeybee.git}"
SRC="${DSHB_SRC:-$HOME/.dshb/dsh-honeybee}"
PLUGINS="dshb-auth dshb-core dshb-router dshb-exec-ssh dshb-exec-docker dshb-ui"

say() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node.js is required (>= 22.13); install it first."
command -v git >/dev/null 2>&1 || die "git is required; install it first."
command -v pnpm >/dev/null 2>&1 || {
  command -v npm >/dev/null 2>&1 || die "neither pnpm nor npm is available; install pnpm >= 11."
  say "pnpm not found - installing via npm..."
  npm install -g pnpm
}

# ---- 1. standard DSH -----------------------------------------------------
run_dsh() {
  if [ -n "${DSH:-}" ]; then
    eval "$DSH \"\$@\""
  elif [ "${SYSTEM_DSH:-0}" = "1" ]; then
    dsh "$@"
  else
    npx --yes "@deepseek-ai/dsh@${DSH_VERSION}" "$@"
  fi
}

if command -v dsh >/dev/null 2>&1; then
  SYSTEM_DSH=1
  say "Detected existing dsh at $(command -v dsh) - skipping DSH install."
else
  SYSTEM_DSH=0
  say "dsh not found - will use @deepseek-ai/dsh@${DSH_VERSION} via npx (pinned to the version DSHB is built against)."
  say "To make dsh permanent on PATH, later run: npm install -g @deepseek-ai/dsh@${DSH_VERSION}"
fi

# ---- 2. fetch DSHB source -------------------------------------------------
if [ -d "$SRC" ]; then
  say "DSHB source already present at $SRC - reusing (set DSHB_SRC to clone elsewhere)."
else
  say "Cloning DSH-HoneyBee into $SRC ..."
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO_URL" "$SRC"
fi

# ---- 3. build DSHB --------------------------------------------------------
say "Building DSHB packages (pnpm install + build)..."
(
  cd "$SRC"
  pnpm install --frozen-lockfile=false
  pnpm build
)

# ---- 4. install into DSH profile -----------------------------------------
say "Installing DSHB plugins into profile '$PROFILE' (DSH_HOME=$DSH_HOME) ..."
for p in $PLUGINS; do
  say "== installing $p =="
  DSH_HOME="$DSH_HOME" run_dsh plugin --profile "$PROFILE" add "$SRC/packages/$p"
done
say "== installing dsh-web-mobile =="
DSH_HOME="$DSH_HOME" run_dsh plugin --profile "$PROFILE" add dsh-web-mobile

say ""
say "All done. Start the management web:"
say "  DSH_HOME=\"$DSH_HOME\" dsh web"
warn "If dsh was pulled via npx (no global binary), run:"
warn "  DSH_HOME=\"$DSH_HOME\" npx --yes @deepseek-ai/dsh@${DSH_VERSION} web"
