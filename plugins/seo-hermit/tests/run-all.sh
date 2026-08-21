#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_DIR"

echo "=== seo-hermit test suite ==="

EXIT=0

echo ""
echo "--- bun tests (site-api + ledger) ---"
if ! bun test tests/site-api.test.ts tests/ledger.test.ts; then
  EXIT=1
fi

echo ""
echo "--- bun tests (skill-structure) ---"
if ! bun test tests/skill-structure.test.ts; then
  EXIT=1
fi

echo ""
if [ "$EXIT" -eq 0 ]; then
  echo "All tests passed."
else
  echo "Some tests failed." >&2
fi

exit "$EXIT"
