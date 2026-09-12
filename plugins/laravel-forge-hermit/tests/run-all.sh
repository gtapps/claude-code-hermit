#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_DIR"

echo "=== laravel-forge-hermit test suite ==="

EXIT=0

composer install --no-dev --no-interaction --quiet --working-dir=php

echo ""
echo "--- PHP tests (php/tests/run.php) ---"
if ! php php/tests/run.php; then
  EXIT=1
fi

echo ""
# The structural lints call process.exit(), which tears down a shared `bun test`
# runner before the remaining files load. Run each of those directly and keep
# `bun test` for the bun:test-based permission suite.
echo "--- bun tests (permissions) ---"
if ! bun test scripts/native-permissions.test.ts tests/cli.test.ts; then
  EXIT=1
fi

echo ""
echo "--- structural lints (skill-structure) ---"
if ! bun tests/skill-structure.test.ts; then
  EXIT=1
fi

echo ""
if [ "$EXIT" -eq 0 ]; then
  echo "All tests passed."
else
  echo "Some tests failed." >&2
fi

exit "$EXIT"
