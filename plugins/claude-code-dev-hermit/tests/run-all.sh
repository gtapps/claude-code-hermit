#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

rc=0

node "$SCRIPT_DIR/skill-structure.test.js" || rc=$?
node "$SCRIPT_DIR/hatch-mode.test.js" || rc=$?
node "$SCRIPT_DIR/forge-awareness.test.js" || rc=$?

while IFS= read -r f; do
  node "$f" || rc=$?
done < <(find "$PLUGIN_ROOT/scripts" -name '*.test.js' | sort)

exit $rc
