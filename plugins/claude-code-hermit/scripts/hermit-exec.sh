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

echo "[hermit] $NAME not found in $SCRIPT_DIR (.ts)" >&2
echo "[hermit] Plugin may be corrupted. Reinstall with: claude plugin install claude-code-hermit@claude-code-hermit --scope local" >&2
exit 1
