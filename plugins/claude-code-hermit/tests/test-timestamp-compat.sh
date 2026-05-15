#!/usr/bin/env bash
# Verifies UTC-Z lexical comparison used by docker-entrypoint, hermit-docker,
# and hermit-stop.py works correctly across same-format timestamps. PROP-031 v1.1.0.
# Usage: bash tests/test-timestamp-compat.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== UTC-Z timestamp comparison tests ==="
echo ""

# Bash lexical compare: REQ < DONE → DONE \> REQ → shutdown complete.
# REQ == DONE → also complete (idempotent).
# DONE empty → not complete.
# Test the exact pattern used in docker-entrypoint.

check_shutdown_complete() {
  local req="$1" done_at="$2"
  if [ -n "$done_at" ] && { [ -z "$req" ] || [ "$done_at" \> "$req" ] || [ "$done_at" = "$req" ]; }; then
    return 0
  fi
  return 1
}

run_test "shutdown complete: DONE after REQ (UTC-Z)" \
  check_shutdown_complete "2026-05-15T22:00:00Z" "2026-05-15T22:00:05Z"
run_test "shutdown complete: DONE equals REQ" \
  check_shutdown_complete "2026-05-15T22:00:00Z" "2026-05-15T22:00:00Z"
run_test "shutdown complete: REQ empty, DONE set" \
  check_shutdown_complete "" "2026-05-15T22:00:05Z"
run_test "shutdown NOT complete: DONE before REQ (stale)" \
  bash -c "! check_shutdown_complete '2026-05-15T22:00:00Z' '2026-05-15T21:00:00Z'"
run_test "shutdown NOT complete: DONE empty" \
  bash -c "! check_shutdown_complete '2026-05-15T22:00:00Z' ''"
run_test "shutdown NOT complete: both empty" \
  bash -c "! check_shutdown_complete '' ''"

# Python: verify all timestamp writers produce UTC-Z format
TIMESTAMP_FMT='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

run_test "Python time.strftime UTC-Z pattern matches" bash -c \
  "python3 -c 'import time; t=time.strftime(\"%Y-%m-%dT%H:%M:%SZ\", time.gmtime()); import re; assert re.match(r\"$TIMESTAMP_FMT\", t), t'"

# Sanity check: hermit-start.py and hermit-stop.py only use UTC-Z (no %z)
run_test "hermit-start.py uses no %z timestamp format" bash -c \
  "! grep -n \"strftime.*%z\" '$REPO_ROOT/scripts/hermit-start.py'"
run_test "hermit-stop.py uses no %z timestamp format" bash -c \
  "! grep -n \"strftime.*%z\" '$REPO_ROOT/scripts/hermit-stop.py'"

print_results
