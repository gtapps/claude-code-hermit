#!/usr/bin/env bash
# Plugin-side dispatcher for hermit lifecycle scripts.
# Usage: hermitd-exec.sh <name> [args...]    e.g. hermitd-exec.sh hermitd-start --no-tmux
#
# Maps a logical script name to its implementation file and runtime. This lives
# in the plugin (auto-refreshed by /plugin update) so the operator-resident
# bin/ shims never embed the language a script happens to be written in —
# future runtime changes need no wrapper refresh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:?Usage: hermitd-exec.sh <script-name> [args...]}"
shift
# Tolerate legacy callers that pass filenames instead of logical names.
NAME="${NAME%.ts}"

# NAME must be a bare script basename — reject path separators and traversal so a
# permission glob that spans '/' can't drive this into an arbitrary .ts outside scripts/.
case "$NAME" in
  ""|*/*|*..*)
    echo "[hermit] Invalid script name: '$NAME'" >&2
    exit 1
    ;;
esac

# Resolve bun explicitly rather than trusting PATH. Generated watchdog units
# (systemd user service, launchd agent, cron) run with an environment that need
# not carry bun's install dir, and a bare `exec bun` there exits 127 on every
# tick with nothing to distinguish it from any other failure. This file ships via
# /plugin update, so the probe repairs installs whose unit was baked before the
# PATH fix landed — the case that needs it most is a dead hermit whose watchdog is
# also dead, where there is no live session to run a repair in.
resolve_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/bun" ]; then
    echo "$BUN_INSTALL/bin/bun"
    return 0
  fi
  for candidate in "${HOME:-}/.bun/bin/bun" /usr/local/bin/bun /opt/homebrew/bin/bun; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

if [ -f "$SCRIPT_DIR/$NAME.ts" ]; then
  BUN_BIN="$(resolve_bun)" || {
    echo "[hermit] bun not found on PATH or in the usual install locations." >&2
    echo "[hermit] Install: curl -fsSL https://bun.sh/install | bash" >&2
    exit 127
  }
  exec "$BUN_BIN" "$SCRIPT_DIR/$NAME.ts" "$@"
elif [ -f "$SCRIPT_DIR/$NAME.sh" ]; then
  exec bash "$SCRIPT_DIR/$NAME.sh" "$@"
fi

# A missing script is far more often a stale plugin clone (this dispatcher predates
# the requested command) than actual corruption — so report the resolved version and
# point at an update, not a reinstall (a reinstall of the same stale clone wouldn't help).
VER="$(grep -o '"version"[^,]*' "$SCRIPT_DIR/../.claude-plugin/plugin.json" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
echo "[hermit] $NAME not found in $SCRIPT_DIR (.ts or .sh)" >&2
echo "[hermit] Plugin v${VER:-unknown} may predate this command. Update it:" >&2
echo "[hermit]   hermitd update" >&2
exit 1
