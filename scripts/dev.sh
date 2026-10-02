#!/usr/bin/env bash
# Launch Claude Code against a target project with this checkout's plugins.
set -euo pipefail

if [ $# -lt 1 ]; then
  printf 'Usage: bun run dev <target> [claude args...]\n' >&2
  exit 1
fi

TARGET=$1
shift

ROOT="$(git rev-parse --show-toplevel)"
export HERMIT_PLUGIN_ROOT="$ROOT/plugins/hermitd"

cd "$TARGET"
exec claude --plugin-dir "$ROOT/plugins" "$@"
