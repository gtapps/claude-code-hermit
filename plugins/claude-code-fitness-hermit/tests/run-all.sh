#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

rc=0

bun "$SCRIPT_DIR/skill-structure.test.js" || rc=$?

if [ -d "$PLUGIN_ROOT/scripts" ]; then
  while IFS= read -r f; do
    bun "$f" || rc=$?
  done < <(find "$PLUGIN_ROOT/scripts" -name '*.test.js' | sort)
fi

exit $rc
