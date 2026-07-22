#!/usr/bin/env bash
# Plugin-side dispatcher for hermit lifecycle scripts.
# Usage: hermit-exec.sh <name> [args...]    e.g. hermit-exec.sh hermit-start --no-tmux
#
# Maps a logical script name to its implementation file and runtime. This lives
# in the plugin (auto-refreshed by /plugin update) so the operator-resident
# bin/ shims never embed the language a script happens to be written in —
# future runtime changes need no wrapper refresh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:?Usage: hermit-exec.sh <script-name> [args...]}"
shift
# Tolerate legacy callers that pass filenames instead of logical names.
NAME="${NAME%.ts}"

if [ -f "$SCRIPT_DIR/$NAME.ts" ]; then
  exec bun "$SCRIPT_DIR/$NAME.ts" "$@"
fi

# A missing script is far more often a stale plugin clone (this dispatcher predates
# the requested command) than actual corruption — so report the resolved version and
# point at an update, not a reinstall (a reinstall of the same stale clone wouldn't help).
VER="$(grep -o '"version"[^,]*' "$SCRIPT_DIR/../.claude-plugin/plugin.json" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
echo "[hermit] $NAME not found in $SCRIPT_DIR (.ts)" >&2
echo "[hermit] Plugin v${VER:-unknown} may predate this command. Update it:" >&2
echo "[hermit]   Docker: .claude-code-hermit/bin/hermit-docker update" >&2
echo "[hermit]   Host:   claude plugin update claude-code-hermit" >&2
exit 1
