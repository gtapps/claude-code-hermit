#!/usr/bin/env bash
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_DIR"

echo "=== claude-code-error-hermit test suite ==="

EXIT=0

echo ""
echo "--- skill structure (bun tests/skill-structure.test.ts) ---"
if ! bun tests/skill-structure.test.ts; then
  EXIT=1
fi

echo ""
echo "--- bun tests (hook + api client + precheck) ---"
if ! bun test tests/hook.test.ts tests/error-api.test.ts tests/precheck.test.ts; then
  EXIT=1
fi

echo ""
if [ "$EXIT" -eq 0 ]; then
  echo "All tests passed."
else
  echo "Some tests failed." >&2
fi

exit "$EXIT"
