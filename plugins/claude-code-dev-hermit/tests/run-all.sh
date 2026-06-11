#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

rc=0

bun "$SCRIPT_DIR/skill-structure.test.js" || rc=$?
bun "$SCRIPT_DIR/hatch-mode.test.js" || rc=$?
bun "$SCRIPT_DIR/forge-awareness.test.js" || rc=$?

while IFS= read -r f; do
  bun "$f" || rc=$?
done < <(find "$PLUGIN_ROOT/scripts" -name '*.test.js' | sort)

exit $rc
