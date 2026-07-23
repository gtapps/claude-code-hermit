#!/usr/bin/env bash
# Run every plugin's test suite in parallel and report a per-plugin summary.
# Wall time is bounded by the slowest suite instead of the sum of all suites.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

BUN_TEST_SLUGS=(claude-code-hermit claude-code-homeassistant-hermit feed-hermit)
RUN_ALL_SLUGS=(claude-code-dev-hermit claude-code-fitness-hermit hermit-scribe laravel-forge-hermit)

declare -A PIDS

now() { date +%s; }

# Each job records its own wall time to <slug>.secs so the reported duration is
# the suite's real runtime, not the moment the fixed-order wait loop reaps it.
for slug in "${BUN_TEST_SLUGS[@]}"; do
  ( s=$(now); cd "$ROOT/plugins/$slug" && bun test; rc=$?; echo $(( $(now) - s )) >"$LOGDIR/$slug.secs"; exit "$rc" ) >"$LOGDIR/$slug.log" 2>&1 &
  PIDS[$slug]=$!
done

for slug in "${RUN_ALL_SLUGS[@]}"; do
  ( s=$(now); bash "$ROOT/plugins/$slug/tests/run-all.sh"; rc=$?; echo $(( $(now) - s )) >"$LOGDIR/$slug.secs"; exit "$rc" ) >"$LOGDIR/$slug.log" 2>&1 &
  PIDS[$slug]=$!
done

overall_rc=0
printf "%-32s %-6s %6s\n" "PLUGIN" "RESULT" "SECS"
for slug in "${BUN_TEST_SLUGS[@]}" "${RUN_ALL_SLUGS[@]}"; do
  wait "${PIDS[$slug]}"
  rc=$?
  elapsed=$(cat "$LOGDIR/$slug.secs" 2>/dev/null || echo '?')
  if [ "$rc" -eq 0 ]; then
    printf "%-32s %-6s %5ss\n" "$slug" "PASS" "$elapsed"
  else
    printf "%-32s %-6s %5ss\n" "$slug" "FAIL" "$elapsed"
    overall_rc=1
    echo "--- $slug (last 20 lines) ---"
    tail -20 "$LOGDIR/$slug.log"
    echo "---"
  fi
done

exit "$overall_rc"
